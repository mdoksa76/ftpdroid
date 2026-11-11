import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class FtpDroidPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window._settings = this.getSettings();
        this._settings = window._settings;
        window.set_default_size(560, 640);

        const page = new Adw.PreferencesPage({
            title: 'Devices',
            icon_name: 'phone-symbolic',
        });
        window.add(page);

        this._listGroup = new Adw.PreferencesGroup({
            title: 'Configured devices',
            description: 'Each device needs its own unique FTP port. ' +
                         'On the phone: CX File Explorer → Network → Access from network → ' +
                         'turn off "random", set port/user/password, Start.',
        });
        page.add(this._listGroup);

        const addGroup = new Adw.PreferencesGroup({title: 'Add a device'});
        page.add(addGroup);

        this._nameRow = new Adw.EntryRow({title: 'Name (e.g. Redmi)'});
        this._portRow = new Adw.EntryRow({title: 'Port (e.g. 7967)'});
        this._userRow = new Adw.EntryRow({title: 'Username'});
        this._passRow = new Adw.PasswordEntryRow({title: 'Password'});

        addGroup.add(this._nameRow);
        addGroup.add(this._portRow);
        addGroup.add(this._userRow);
        addGroup.add(this._passRow);

        const addBtn = new Gtk.Button({
            label: 'Add device',
            halign: Gtk.Align.END,
            margin_top: 8,
            css_classes: ['suggested-action'],
        });
        addBtn.connect('clicked', () => this._onAdd());
        addGroup.add(addBtn);

        const advGroup = new Adw.PreferencesGroup({title: 'Advanced'});
        page.add(advGroup);

        const timeoutRow = new Adw.SpinRow({
            title: 'Probe timeout (ms)',
            subtitle: 'How long to wait per host when scanning',
            adjustment: new Gtk.Adjustment({
                lower: 100, upper: 3000, step_increment: 50, value: 400,
            }),
        });
        this._settings.bind('probe-timeout', timeoutRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        advGroup.add(timeoutRow);

        this._rebuildList();

        const syncPage = new Adw.PreferencesPage({
            title: 'Sync',
            icon_name: 'folder-download-symbolic',
        });
        window.add(syncPage);

        this._pairsGroup = new Adw.PreferencesGroup({
            title: 'Sync pairs',
            description: 'Each pair copies a folder from a device to a PC folder. ' +
                         'Only new files are copied (existing ones are skipped). ' +
                         'Phone path is relative to the FTP root (e.g. DCIM/Camera); ' +
                         'PC path is absolute (e.g. /home/you/Pictures/Redmi).',
        });
        syncPage.add(this._pairsGroup);

        const addPairGroup = new Adw.PreferencesGroup({title: 'Add a sync pair'});
        syncPage.add(addPairGroup);

        this._pairNameRow = new Adw.EntryRow({title: 'Label (e.g. Photos)'});

        this._deviceCombo = new Adw.ComboRow({title: 'Device'});
        this._deviceModel = new Gtk.StringList();
        this._deviceCombo.set_model(this._deviceModel);
        this._devicePorts = [];

        this._remoteRow = new Adw.EntryRow({title: 'Phone path (e.g. DCIM/Camera)'});
        this._localRow = new Adw.EntryRow({title: 'PC path (e.g. /home/you/Pictures/Redmi)'});

        addPairGroup.add(this._pairNameRow);
        addPairGroup.add(this._deviceCombo);
        addPairGroup.add(this._remoteRow);
        addPairGroup.add(this._localRow);

        const addPairBtn = new Gtk.Button({
            label: 'Add pair',
            halign: Gtk.Align.END,
            margin_top: 8,
            css_classes: ['suggested-action'],
        });
        addPairBtn.connect('clicked', () => this._onAddPair());
        addPairGroup.add(addPairBtn);

        this._rebuildDeviceCombo();
        this._migratePairs();
        this._rebuildPairs();

        window.connect('close-request', () => {
            this._listGroup = null;
            this._nameRow = null;
            this._portRow = null;
            this._userRow = null;
            this._passRow = null;
            this._pairsGroup = null;
            this._pairNameRow = null;
            this._deviceCombo = null;
            this._deviceModel = null;
            this._devicePorts = null;
            this._remoteRow = null;
            this._localRow = null;
            this._rows = null;
            this._pairRows = null;
            this._settings = null;
        });
    }

    _getDevices() {
        try {
            let arr = JSON.parse(this._settings.get_string('devices'));
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    _setDevices(devices) {
        this._settings.set_string('devices', JSON.stringify(devices));
        try {
            let cache = JSON.parse(this._settings.get_string('ip-cache')) || {};
            let ports = new Set(devices.map(d => String(d.port)));
            let pruned = {};
            for (let k of Object.keys(cache))
                if (ports.has(k))
                    pruned[k] = cache[k];
            this._settings.set_string('ip-cache', JSON.stringify(pruned));
        } catch (e) {
            // ignore
        }
    }

    _onAdd() {
        let name = this._nameRow.get_text().trim();
        let portStr = this._portRow.get_text().trim();
        let user = this._userRow.get_text().trim();
        let pass = this._passRow.get_text();

        let port = parseInt(portStr, 10);
        if (!port || port < 1 || port > 65535) {
            this._toast('Enter a valid port (1–65535).');
            return;
        }
        if (!name)
            name = `Port ${port}`;

        let devices = this._getDevices();
        if (devices.some(d => parseInt(d.port) === port)) {
            this._toast(`Port ${port} is already used — each device needs a unique port.`);
            return;
        }

        devices.push({name, port, user, pass});
        this._setDevices(devices);

        this._nameRow.set_text('');
        this._portRow.set_text('');
        this._userRow.set_text('');
        this._passRow.set_text('');

        this._rebuildList();
        this._rebuildDeviceCombo();
    }

    _removeDevice(port) {
        let devices = this._getDevices().filter(d => parseInt(d.port) !== parseInt(port));
        this._setDevices(devices);
        this._rebuildList();
        this._rebuildDeviceCombo();
    }

    _getPairs() {
        try {
            let arr = JSON.parse(this._settings.get_string('sync-pairs'));
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    _setPairs(pairs) {
        this._settings.set_string('sync-pairs', JSON.stringify(pairs));
    }

    // Phone path must be relative; strip any pasted ftp:// host prefix.
    _normalizeRemote(s) {
        let r = (s || '').trim();
        if (/^ftps?:\/\//i.test(r))
            r = r.replace(/^ftps?:\/\/[^/]*/i, '');
        return r.replace(/^\/+/, '').replace(/\/+$/, '');
    }

    _migratePairs() {
        let pairs = this._getPairs();
        let changed = false;
        for (let p of pairs) {
            let norm = this._normalizeRemote(p.remote);
            if (norm !== p.remote) {
                p.remote = norm;
                changed = true;
            }
        }
        if (changed)
            this._setPairs(pairs);
    }

    _rebuildDeviceCombo() {
        if (!this._deviceModel)
            return;
        let n = this._deviceModel.get_n_items();
        for (let i = n - 1; i >= 0; i--)
            this._deviceModel.remove(i);
        this._devicePorts = [];

        let devices = this._getDevices();
        devices.sort((a, b) => a.port - b.port);
        for (let d of devices) {
            this._deviceModel.append(`${d.name || 'Port ' + d.port} (:${d.port})`);
            this._devicePorts.push(parseInt(d.port));
        }
    }

    _onAddPair() {
        let devices = this._getDevices();
        if (devices.length === 0) {
            this._toast('Add a device first, then create sync pairs for it.');
            return;
        }

        let idx = this._deviceCombo.get_selected();
        if (idx < 0 || idx >= this._devicePorts.length) {
            this._toast('Select a device for this pair.');
            return;
        }
        let port = this._devicePorts[idx];

        let name = this._pairNameRow.get_text().trim();
        let remote = this._normalizeRemote(this._remoteRow.get_text());
        let local = this._localRow.get_text().trim();

        if (!local || !local.startsWith('/')) {
            this._toast('PC path must be absolute (start with /).');
            return;
        }
        if (!name)
            name = remote || 'Pair';

        let pairs = this._getPairs();
        pairs.push({
            id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            name, port, remote, local,
        });
        this._setPairs(pairs);

        this._pairNameRow.set_text('');
        this._remoteRow.set_text('');
        this._localRow.set_text('');

        this._rebuildPairs();
    }

    _removePair(id) {
        let pairs = this._getPairs().filter(p => p.id !== id);
        this._setPairs(pairs);
        this._rebuildPairs();
    }

    _deviceName(port) {
        let d = this._getDevices().find(x => parseInt(x.port) === parseInt(port));
        return d ? (d.name || `Port ${port}`) : `Port ${port} (missing)`;
    }

    _rebuildPairs() {
        if (this._pairRows) {
            for (let r of this._pairRows)
                this._pairsGroup.remove(r);
        }
        this._pairRows = [];

        let pairs = this._getPairs();
        if (pairs.length === 0) {
            let empty = new Adw.ActionRow({
                title: 'No sync pairs yet',
                subtitle: 'Add one below.',
            });
            this._pairsGroup.add(empty);
            this._pairRows.push(empty);
            return;
        }

        pairs.sort((a, b) => (a.port - b.port) || a.name.localeCompare(b.name));
        for (let p of pairs) {
            let row = new Adw.ActionRow({
                title: p.name,
                subtitle: `${this._deviceName(p.port)} · ${p.remote || '(root)'} → ${p.local}`,
            });
            let del = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            del.connect('clicked', () => this._removePair(p.id));
            row.add_suffix(del);
            this._pairsGroup.add(row);
            this._pairRows.push(row);
        }
    }

    _rebuildList() {
        if (this._rows) {
            for (let r of this._rows)
                this._listGroup.remove(r);
        }
        this._rows = [];

        let devices = this._getDevices();
        if (devices.length === 0) {
            let empty = new Adw.ActionRow({
                title: 'No devices yet',
                subtitle: 'Add one below.',
            });
            this._listGroup.add(empty);
            this._rows.push(empty);
            return;
        }

        devices.sort((a, b) => a.port - b.port);
        for (let d of devices) {
            let row = new Adw.ActionRow({
                title: d.name || `Port ${d.port}`,
                subtitle: `port ${d.port} · user: ${d.user || '(anonymous)'}`,
            });
            let del = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            del.connect('clicked', () => this._removeDevice(d.port));
            row.add_suffix(del);
            this._listGroup.add(row);
            this._rows.push(row);
        }
    }

    _toast(text) {
        let dialog = new Gtk.AlertDialog({modal: true, message: text});
        try {
            dialog.show(null);
        } catch (e) {
            // no window to anchor to
        }
    }
}
