import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const HELP_TEXT = `ftpDroid — quick-mount Android FTP into Nautilus

ON YOUR PHONE (CX File Explorer)
  Network → Access from network
  Turn OFF "random" → set a fixed port,
  username and password → Start service
  Give each device its own unique port.

IN THE EXTENSION
  Settings → add a device:
  name, port, username, password
  (the port is the device's identity)

USAGE
  Click the tile → ftpDroid scans the network,
  finds which devices are online, and mounts
  the selected one in Nautilus with one click.

NOTE
  Works with any Android FTP server that allows
  a fixed port (CX File Explorer, WiFi FTP
  Server, ...). Apps that rotate the port on
  each start are not supported.

CREDITS
  Depends on CX File Explorer and its
  "Access from network" feature.`;

const FtpWindow = GObject.registerClass(
class FtpWindow extends St.BoxLayout {
    _init(settings, onOpenChange, onStateChange) {
        super._init({
            vertical: true,
            reactive: true,
            can_focus: true,
            track_hover: true,
            style_class: 'ftpdroid-window',
            style: 'background-color: rgba(30,30,30,0.98); ' +
                   'border: 1px solid rgba(255,255,255,0.15); ' +
                   'border-radius: 12px; padding: 12px; min-width: 380px; max-width: 440px;'
        });

        this._settings = settings;
        this._onOpenChange = onOpenChange;
        this._onStateChange = onStateChange;

        this._scanning = false;
        this._helpVisible = false;
        this._subnet = null;
        this._myIP = null;
        this._checkStates = {};
        this._pendingTimeouts = [];
        this._cancellable = new Gio.Cancellable();

        this._buildUI();

        Main.layoutManager.uiGroup.add_child(this);
        this.hide();

        this._detectSubnet();

        this._volMonitor = Gio.VolumeMonitor.get();
        this._mountAddedId = this._volMonitor.connect('mount-added',
            () => this._updateMountCount());
        this._mountRemovedId = this._volMonitor.connect('mount-removed',
            () => this._updateMountCount());
        this._updateMountCount();
    }

    _isOurMount(mount) {
        try {
            let uri = mount.get_root().get_uri();
            if (!uri || !uri.startsWith('ftp://'))
                return false;
            return this._getDevices().some(d => uri.includes(`:${d.port}/`));
        } catch (e) {
            return false;
        }
    }

    _updateMountCount() {
        let n = 0;
        try {
            n = this._volMonitor.get_mounts().filter(m => this._isOurMount(m)).length;
        } catch (e) {
            n = 0;
        }
        if (this._onStateChange)
            this._onStateChange(String(n));
    }

    _isMounted(uri) {
        try {
            return this._volMonitor.get_mounts().some(m => {
                try {
                    return m.get_root().get_uri() === uri;
                } catch (e) {
                    return false;
                }
            });
        } catch (e) {
            return false;
        }
    }

    _buildUI() {
        let titleBar = new St.BoxLayout({style: 'spacing: 8px; padding-bottom: 8px;'});

        this._titleLabel = new St.Label({
            text: '📱  ftpDroid',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            reactive: true,
            style: 'font-weight: bold; font-size: 1.15em;'
        });
        this._titleLabel.connect('button-press-event', (a, ev) => this._onDragStart(ev));

        let closeButton = new St.Button({
            label: '✕',
            style_class: 'button',
            style: 'padding: 2px 10px; border-radius: 4px;'
        });
        closeButton.connect('clicked', () => this.close());

        titleBar.add_child(this._titleLabel);
        titleBar.add_child(closeButton);
        this.add_child(titleBar);

        let scroll = new St.ScrollView({
            style: 'max-height: 420px;',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            y_expand: true
        });
        this._listBox = new St.BoxLayout({vertical: true, style: 'spacing: 6px;'});
        scroll.set_child(this._listBox);
        this.add_child(scroll);

        let buttonBox = new St.BoxLayout({style: 'spacing: 5px; padding-top: 8px;'});

        this._scanButton = new St.Button({label: 'Scan', style_class: 'button'});
        this._scanButton.connect('clicked', () => this._startScan());

        this._prefsButton = new St.Button({label: 'Settings', style_class: 'button'});
        this._prefsButton.connect('clicked', () => {
            if (this._onOpenPrefs)
                this._onOpenPrefs();
        });

        this._helpButton = new St.Button({label: 'Help ▼', style_class: 'button'});
        this._helpButton.connect('clicked', () => this._toggleHelp());

        buttonBox.add_child(this._scanButton);
        buttonBox.add_child(this._prefsButton);
        buttonBox.add_child(this._helpButton);
        this.add_child(buttonBox);

        this._statusLabel = new St.Label({
            text: 'Click "Scan" to find devices',
            style: 'padding-top: 8px; color: #aaa; font-size: 0.9em;'
        });
        this.add_child(this._statusLabel);

        this._helpBox = new St.BoxLayout({
            vertical: true,
            visible: false,
            style: 'margin-top: 10px; padding: 10px; ' +
                   'background-color: rgba(0,0,0,0.2); border-radius: 6px;'
        });
        this._helpBox.add_child(new St.Label({
            text: HELP_TEXT,
            style: 'font-family: monospace; font-size: 11px;'
        }));
        this.add_child(this._helpBox);
    }

    _toggleHelp() {
        this._helpVisible = !this._helpVisible;
        this._helpBox.visible = this._helpVisible;
        this._helpButton.label = this._helpVisible ? 'Help ▲' : 'Help ▼';
    }

    _onDragStart(ev) {
        this._stopDrag();
        let [sx, sy] = ev.get_coords();
        let [wx, wy] = this.get_position();
        this._dragOffset = [sx - wx, sy - wy];

        this._dragMotionId = global.stage.connect('motion-event', (s, mev) => {
            if (!(mev.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
                this._stopDrag();
                return Clutter.EVENT_PROPAGATE;
            }
            let [mx, my] = mev.get_coords();
            this.set_position(
                Math.round(mx - this._dragOffset[0]),
                Math.round(my - this._dragOffset[1])
            );
            return Clutter.EVENT_STOP;
        });
        this._dragReleaseId = global.stage.connect('button-release-event', () => {
            this._stopDrag();
            return Clutter.EVENT_STOP;
        });
        return Clutter.EVENT_STOP;
    }

    _stopDrag() {
        if (this._dragMotionId) {
            global.stage.disconnect(this._dragMotionId);
            this._dragMotionId = null;
        }
        if (this._dragReleaseId) {
            global.stage.disconnect(this._dragReleaseId);
            this._dragReleaseId = null;
        }
    }

    // Subnet detection, reused from LAN Scanner.
    _detectSubnet() {
        try {
            let proc = Gio.Subprocess.new(
                ['ip', '-4', 'addr', 'show'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
                try {
                    let [, stdout] = p.communicate_utf8_finish(res);
                    if (stdout) {
                        for (let line of stdout.split('\n')) {
                            let m = line.match(/inet ([\d.]+)\/(\d+)/);
                            if (m && !m[1].startsWith('127.')) {
                                this._myIP = m[1];
                                let parts = m[1].split('.');
                                this._subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
                                return;
                            }
                        }
                    }
                } catch (e) {
                    // fall through to default
                }
                if (!this._subnet)
                    this._subnet = '192.168.1';
            });
        } catch (e) {
            this._subnet = '192.168.1';
        }
    }

    _getDevices() {
        try {
            let arr = JSON.parse(this._settings.get_string('devices'));
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    _getPairs() {
        try {
            let arr = JSON.parse(this._settings.get_string('sync-pairs'));
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    _pairsFor(port) {
        return this._getPairs().filter(p => parseInt(p.port) === parseInt(port));
    }

    _getIpCache() {
        try {
            return JSON.parse(this._settings.get_string('ip-cache')) || {};
        } catch (e) {
            return {};
        }
    }

    _setIpCache(cache) {
        try {
            this._settings.set_string('ip-cache', JSON.stringify(cache));
        } catch (e) {
            // ignore
        }
    }

    _startScan() {
        if (this._scanning)
            return;

        let devices = this._getDevices();
        if (devices.length === 0) {
            this._status('No devices configured — open Settings to add one.');
            return;
        }
        if (!this._subnet) {
            this._status('Could not detect subnet.');
            return;
        }

        this._scanning = true;
        this._scanButton.set_label('Scanning...');
        this._listBox.destroy_all_children();
        this._status('Scanning network...');
        if (this._onStateChange)
            this._onStateChange('…');

        let cache = this._getIpCache();
        let found = [];
        let remaining = devices.length;

        let deviceDone = (device, ip) => {
            if (ip) {
                found.push({device, ip});
                cache[String(device.port)] = ip;
            }
            remaining--;
            this._status(`Scanning... (${found.length} online)`);
            if (remaining <= 0) {
                this._setIpCache(cache);
                this._scanning = false;
                this._scanButton.set_label('Scan');
                this._finishScan(found);
            }
        };

        for (let device of devices) {
            let port = parseInt(device.port);
            if (!port) {
                deviceDone(device, null);
                continue;
            }
            let cached = cache[String(port)];
            if (cached) {
                this._probe(cached, port, (ok) => {
                    if (ok)
                        deviceDone(device, cached);
                    else
                        this._sweepSubnet(port, (ip) => deviceDone(device, ip));
                });
            } else {
                this._sweepSubnet(port, (ip) => deviceDone(device, ip));
            }
        }
    }

    _sweepSubnet(port, callback) {
        let base = this._subnet;
        let total = 254;
        let done = 0;
        let hit = null;

        for (let i = 1; i <= 254; i++) {
            let ip = `${base}.${i}`;
            this._probe(ip, port, (ok) => {
                done++;
                if (ok && !hit)
                    hit = ip;
                if (done >= total)
                    callback(hit);
            });
        }
    }

    _probe(ip, port, callback) {
        let timeout = this._settings.get_int('probe-timeout') || 400;
        let finished = false;
        let client = new Gio.SocketClient();
        let addr = Gio.InetSocketAddress.new_from_string(ip, port);
        if (!addr) {
            callback(false);
            return;
        }

        let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
            this._pendingTimeouts = this._pendingTimeouts.filter(t => t !== timeoutId);
            if (!finished) {
                finished = true;
                try {
                    client.set_timeout(1);
                } catch (e) {
                    // ignore
                }
                callback(false);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._pendingTimeouts.push(timeoutId);

        client.connect_async(addr, this._cancellable, (c, res) => {
            if (finished) {
                try {
                    let conn = c.connect_finish(res);
                    if (conn)
                        conn.close(null);
                } catch (e) {
                    // ignore
                }
                return;
            }
            finished = true;
            GLib.source_remove(timeoutId);
            this._pendingTimeouts = this._pendingTimeouts.filter(t => t !== timeoutId);
            try {
                let conn = c.connect_finish(res);
                if (conn) {
                    try {
                        conn.close(null);
                    } catch (e) {
                        // ignore
                    }
                    callback(true);
                } else {
                    callback(false);
                }
            } catch (e) {
                callback(false);
            }
        });
    }

    _finishScan(found) {
        this._listBox.destroy_all_children();
        this._updateMountCount();

        if (found.length === 0) {
            this._status('No devices online. Start "Access from network" on the phone.');
            this._listBox.add_child(new St.Label({
                text: 'Nothing found.\nIs the FTP server running on the phone?',
                style: 'padding: 10px; color: #aaa;'
            }));
            return;
        }

        found.sort((a, b) => a.device.port - b.device.port);
        this._checkStates = {};

        for (let f of found)
            this._listBox.add_child(this._createDeviceSection(f.device, f.ip));

        this._status(`${found.length} device(s) online`);

        if (found.length === 1 && this._pairsFor(found[0].device.port).length === 0)
            this._mount(found[0].device, found[0].ip);
    }

    _createDeviceSection(device, ip) {
        let section = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'spacing: 4px; padding: 8px; border-radius: 8px; ' +
                   'background-color: rgba(0,150,255,0.06); ' +
                   'border: 1px solid rgba(0,150,255,0.20);'
        });

        let row = new St.Button({
            style_class: 'button',
            x_expand: true,
            style: 'padding: 8px; border-radius: 6px;'
        });
        let box = new St.BoxLayout({vertical: false, style: 'spacing: 10px;', x_expand: true});
        box.add_child(new St.Label({
            text: '📱',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 1.2em;'
        }));
        let textBox = new St.BoxLayout({vertical: true, x_expand: true, style: 'spacing: 2px;'});
        textBox.add_child(new St.Label({
            text: device.name || `Port ${device.port}`,
            style: 'font-weight: bold;'
        }));
        textBox.add_child(new St.Label({
            text: `${ip}:${device.port}`,
            style: 'font-size: 0.8em; color: #888;'
        }));
        box.add_child(textBox);
        row.set_child(box);
        row.connect('clicked', () => this._mount(device, ip));
        section.add_child(row);

        let pairs = this._pairsFor(device.port);
        if (pairs.length > 0) {
            pairs.sort((a, b) => a.name.localeCompare(b.name));
            for (let p of pairs)
                section.add_child(this._createPairRow(p));
        }

        let btnBox = new St.BoxLayout({style: 'spacing: 5px; padding-top: 4px;'});

        let fmBtn = new St.Button({
            label: 'File Manager',
            style_class: 'button',
            style: 'padding: 4px 12px;'
        });
        fmBtn.connect('clicked', () => this._mount(device, ip));
        btnBox.add_child(fmBtn);

        if (pairs.length > 0) {
            let syncBtn = new St.Button({
                label: 'Sync',
                style_class: 'button',
                style: 'padding: 4px 12px;'
            });
            syncBtn.connect('clicked', () => this._syncChecked(device, ip, pairs, false));

            let checkBtn = new St.Button({
                label: 'Check',
                style_class: 'button',
                style: 'padding: 4px 12px;'
            });
            checkBtn.connect('clicked', () => this._syncChecked(device, ip, pairs, true));

            btnBox.add_child(syncBtn);
            btnBox.add_child(checkBtn);
        }

        section.add_child(btnBox);
        return section;
    }

    _createPairRow(pair) {
        let btn = new St.Button({
            x_expand: true,
            style: 'padding: 5px 8px; border-radius: 4px;'
        });
        let lbl = new St.Label({style: 'font-size: 0.9em;'});
        let render = () => {
            let on = !!this._checkStates[pair.id];
            lbl.set_text(`${on ? '☑' : '☐'}  ${pair.name}   ` +
                         `(${pair.remote || 'root'} → ${pair.local})`);
        };
        render();
        btn.set_child(lbl);
        btn.connect('clicked', () => {
            this._checkStates[pair.id] = !this._checkStates[pair.id];
            render();
        });
        return btn;
    }

    _ftpUri(device, ip) {
        let port = parseInt(device.port);
        let user = device.user || 'anonymous';
        return `ftp://${encodeURIComponent(user)}@${ip}:${port}/`;
    }

    _ensureMounted(device, ip, cb) {
        let uri = this._ftpUri(device, ip);
        if (this._isMounted(uri)) {
            cb(true, uri);
            return;
        }

        let file = Gio.File.new_for_uri(uri);
        let mountOp = new Gio.MountOperation();
        let askId = mountOp.connect('ask-password',
            (op, message, defaultUser, defaultDomain, flags) => {
                if (flags & Gio.AskPasswordFlags.NEED_USERNAME)
                    op.set_username(device.user || 'anonymous');
                if (flags & Gio.AskPasswordFlags.NEED_PASSWORD)
                    op.set_password(device.pass || '');
                op.set_password_save(Gio.PasswordSave.NEVER);
                op.reply(Gio.MountOperationResult.HANDLED);
            });

        this._status(`Mounting ${device.name || ip}...`);
        try {
            file.mount_enclosing_volume(Gio.MountMountFlags.NONE, mountOp, this._cancellable,
                (f, res) => {
                    mountOp.disconnect(askId);
                    let ok = false;
                    try {
                        ok = f.mount_enclosing_volume_finish(res);
                    } catch (e) {
                        if (e.matches && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.ALREADY_MOUNTED))
                            ok = true;
                        else
                            this._status(`Mount failed: ${e.message}`);
                    }
                    cb(ok, ok ? uri : null);
                });
        } catch (e) {
            mountOp.disconnect(askId);
            this._status(`Mount failed: ${e.message}`);
            cb(false, null);
        }
    }

    _fusePath(uri) {
        try {
            return Gio.File.new_for_uri(uri).get_path();
        } catch (e) {
            return null;
        }
    }

    _mount(device, ip) {
        this._ensureMounted(device, ip, (ok, uri) => {
            if (ok) {
                this._openInNautilus(uri);
                this._status(`Mounted ${device.name || ip}`);
            }
        });
    }

    _syncChecked(device, ip, pairs, dryRun) {
        let selected = pairs.filter(p => this._checkStates[p.id]);
        if (selected.length === 0) {
            this._status('No pairs checked.');
            return;
        }
        if (!GLib.find_program_in_path('rsync')) {
            this._status('rsync not installed.');
            return;
        }

        this._ensureMounted(device, ip, (ok, uri) => {
            if (!ok) {
                this._status('Cannot sync — mount failed.');
                return;
            }
            let fuse = this._fusePath(uri);
            if (!fuse) {
                this._status('Cannot resolve local path (is gvfs-fuse installed?).');
                return;
            }
            this._runPairs(device, fuse, selected, 0,
                {ok: 0, failed: 0, files: 0, total: 0, details: [], lastErr: ''}, dryRun);
        });
    }

    _runPairs(device, fuse, pairs, i, acc, dryRun) {
        if (i >= pairs.length) {
            let name = device.name || '';
            if (acc.failed === 0) {
                let head = dryRun ? `✓ Check — ${name}` : `✓ Synced — ${name}`;
                this._status(acc.details.length
                    ? head + '\n' + acc.details.join('\n')
                    : head);
            } else {
                this._status(`✗ ${acc.failed} failed, ${acc.ok} ok — ${acc.lastErr || name}`);
            }
            this._updateMountCount();
            return;
        }

        let p = pairs[i];
        let remote = (p.remote || '').trim();
        if (/^ftps?:\/\//i.test(remote))
            remote = remote.replace(/^ftps?:\/\/[^/]*/i, '');
        remote = remote.replace(/^\/+/, '');

        let src = `${fuse}/${remote}`.replace(/\/+$/, '') + '/';
        let dst = `${p.local}`.replace(/\/+$/, '') + '/';

        let srcExists = false;
        try {
            srcExists = Gio.File.new_for_path(src).query_exists(null);
        } catch (e) {
            srcExists = false;
        }
        if (!srcExists) {
            acc.failed++;
            acc.lastErr = `phone path not found: ${remote || '(root)'}`;
            this._runPairs(device, fuse, pairs, i + 1, acc, dryRun);
            return;
        }

        if (!dryRun) {
            try {
                GLib.mkdir_with_parents(p.local, 0o755);
            } catch (e) {
                // ignore
            }
        }

        this._status(`${dryRun ? 'Checking' : 'Copying'} ${p.name}...`);

        let argv = ['rsync', '-rt', '--ignore-existing', '--stats'];
        if (dryRun)
            argv.push('--dry-run');
        argv.push(src, dst);

        try {
            let proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, this._cancellable, (pr, res) => {
                let good = false;
                let stderr = '';
                let stdout = '';
                try {
                    let [, so, se] = pr.communicate_utf8_finish(res);
                    stdout = so || '';
                    stderr = se || '';
                    good = pr.get_successful();
                } catch (e) {
                    good = false;
                    stderr = e.message || '';
                }
                if (good) {
                    acc.ok++;
                    let transferred = 0;
                    let regTotal = 0;
                    let mt = stdout.match(/Number of regular files transferred:\s*([\d,]+)/);
                    let mr = stdout.match(/Number of files:[^(\n]*\(reg:\s*([\d,]+)/);
                    let mo = stdout.match(/Number of files:\s*([\d,]+)/);
                    if (mt)
                        transferred = parseInt(mt[1].replace(/,/g, ''), 10);
                    if (mr)
                        regTotal = parseInt(mr[1].replace(/,/g, ''), 10);
                    else if (mo)
                        regTotal = parseInt(mo[1].replace(/,/g, ''), 10);
                    acc.files += transferred;
                    acc.total += regTotal;
                    let already = Math.max(0, regTotal - transferred);
                    acc.details.push(dryRun
                        ? `${p.name}: phone ${regTotal} · here ${already} · new ${transferred}`
                        : `${p.name}: copied ${transferred} of ${regTotal}`);
                } else {
                    acc.failed++;
                    let line = stderr.trim().split('\n').filter(Boolean).pop();
                    if (line)
                        acc.lastErr = line;
                }
                this._runPairs(device, fuse, pairs, i + 1, acc, dryRun);
            });
        } catch (e) {
            acc.failed++;
            acc.lastErr = `cannot run rsync: ${e.message}`;
            this._runPairs(device, fuse, pairs, i + 1, acc, dryRun);
        }
    }

    _openInNautilus(uri) {
        try {
            Gio.DBus.session.call(
                'org.freedesktop.FileManager1',
                '/org/freedesktop/FileManager1',
                'org.freedesktop.FileManager1',
                'ShowFolders',
                new GLib.Variant('(ass)', [[uri], '']),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (conn, res) => {
                    try {
                        conn.call_finish(res);
                    } catch (e) {
                        this._launchDefault(uri);
                    }
                });
        } catch (e) {
            this._launchDefault(uri);
        }
    }

    _launchDefault(uri) {
        try {
            let ctx = global.create_app_launch_context(0, -1);
            Gio.AppInfo.launch_default_for_uri(uri, ctx);
        } catch (e) {
            // nothing else to try
        }
    }

    _status(text) {
        if (this._statusLabel)
            this._statusLabel.set_text(text);
    }

    open() {
        let monitor = Main.layoutManager.primaryMonitor;
        this.show();
        let w = this.width;
        let topGap = Main.panel.height + 12;
        this.set_position(
            Math.round(monitor.x + (monitor.width - w) / 2),
            Math.round(monitor.y + topGap)
        );
        this._isOpen = true;
        if (this._onOpenChange)
            this._onOpenChange(true);
        this._startScan();
    }

    close() {
        this._stopDrag();
        this.hide();
        this._isOpen = false;
        if (this._onOpenChange)
            this._onOpenChange(false);
    }

    toggle() {
        if (this._isOpen)
            this.close();
        else
            this.open();
    }

    destroy() {
        this._stopDrag();
        if (this._volMonitor) {
            if (this._mountAddedId)
                this._volMonitor.disconnect(this._mountAddedId);
            if (this._mountRemovedId)
                this._volMonitor.disconnect(this._mountRemovedId);
            this._mountAddedId = null;
            this._mountRemovedId = null;
            this._volMonitor = null;
        }
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        this._pendingTimeouts.forEach(id => GLib.source_remove(id));
        this._pendingTimeouts = [];
        super.destroy();
    }
});

const FtpDroidToggle = GObject.registerClass(
class FtpDroidToggle extends QuickSettings.QuickToggle {
    _init(settings, openPrefs) {
        super._init({
            title: 'ftpDroid',
            subtitle: '0',
            iconName: 'phone-symbolic',
            toggleMode: false,
        });

        this._window = new FtpWindow(
            settings,
            (isOpen) => {
                this.checked = isOpen;
            },
            (subtitle) => {
                this.subtitle = subtitle;
            }
        );
        this._window._onOpenPrefs = openPrefs;

        this.connect('clicked', () => this._window.toggle());
    }

    destroy() {
        if (this._window) {
            this._window.destroy();
            this._window = null;
        }
        super.destroy();
    }
});

const FtpDroidIndicator = GObject.registerClass(
class FtpDroidIndicator extends QuickSettings.SystemIndicator {
    _init(settings, openPrefs) {
        super._init();
        this._toggle = new FtpDroidToggle(settings, openPrefs);
        this.quickSettingsItems.push(this._toggle);
    }

    destroy() {
        this._toggle.destroy();
        super.destroy();
    }
});

export default class FtpDroidExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new FtpDroidIndicator(
            this._settings,
            () => this.openPreferences()
        );
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
    }
}
