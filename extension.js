// SPDX-License-Identifier: MIT
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import NM from 'gi://NM';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const API_URL = 'https://ipleak.net/json/';
const SITE_URL = 'https://ipleak.net/';
const REFRESH_INTERVAL_S = 5 * 60;
const DEBOUNCE_S = 3;
const HTTP_TIMEOUT_S = 10;

const FLAG_LOADING = '🏳️';
const FLAG_ERROR = '❌';

function flagFromCountryCode(code) {
    if (typeof code !== 'string' || !/^[A-Za-z]{2}$/.test(code))
        return FLAG_ERROR;
    const base = 0x1F1E6;
    const up = code.toUpperCase();
    return String.fromCodePoint(
        base + up.charCodeAt(0) - 65,
        base + up.charCodeAt(1) - 65);
}

function present(v) {
    return v !== null && v !== undefined && v !== '';
}

// Region is dropped when it just repeats the city ("Brussels, Brussels Capital").
function formatLocation(d) {
    const city = present(d.city_name) ? d.city_name : null;
    let region = present(d.region_name) ? d.region_name : null;
    if (city && region && region.toLowerCase().startsWith(city.toLowerCase()))
        region = null;
    const parts = [city, region].filter(Boolean);
    return parts.length ? parts.join(', ') : '—';
}

function detailRows(d) {
    const country = present(d.country_name) ? d.country_name : d.country_code;
    return [
        ['IP', present(d.ip) ? String(d.ip) : '—'],
        ['Location', formatLocation(d)],
        ['Country', `${flagFromCountryCode(d.country_code)} ${country}`],
    ];
}

const IpFlagButton = GObject.registerClass(
class IpFlagButton extends PanelMenu.Button {
    _init(uuid, version) {
        super._init(0.5, 'IP Flag', false);

        this._data = null;
        this._cancellable = null;
        this._refreshId = 0;
        this._debounceId = 0;
        this._nmClient = null;
        this._nmCancellable = new Gio.Cancellable();
        this._nmSignals = [];

        this._label = new St.Label({
            text: FLAG_LOADING,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ipflag-label',
        });
        this.add_child(this._label);

        this._tooltip = new St.BoxLayout({
            style_class: 'ipflag-tooltip',
            visible: false,
        });
        this._tooltipKeys = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'ipflag-tooltip-keys',
        });
        this._tooltipValues = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'ipflag-tooltip-values',
        });
        this._tooltip.add_child(this._tooltipKeys);
        this._tooltip.add_child(this._tooltipValues);
        Main.uiGroup.add_child(this._tooltip);
        this._setTooltipRows([['', 'Looking up public IP…']]);

        this._session = new Soup.Session({
            timeout: HTTP_TIMEOUT_S,
            user_agent: `ipflag-gnome-extension/${version} (+https://github.com/cdrcqnts/ipflag)`,
        });

        this._buildMenu();

        // Button signals are disconnected automatically when it is destroyed.
        this.connect('enter-event', () => this._showTooltip());
        this.connect('leave-event', () => this._hideTooltip());
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._hideTooltip();
        });

        this._initNetworkMonitor();

        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            REFRESH_INTERVAL_S, () => {
                this._fetch();
                return GLib.SOURCE_CONTINUE;
            });

        this._fetch();
    }

    _buildMenu() {
        this._copyItem = new PopupMenu.PopupMenuItem('Copy IP');
        this._copyItem.connect('activate', () => {
            if (this._data?.ip) {
                St.Clipboard.get_default().set_text(
                    St.ClipboardType.CLIPBOARD, String(this._data.ip));
            }
        });
        this.menu.addMenuItem(this._copyItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._fetch());
        this.menu.addMenuItem(refreshItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const openItem = new PopupMenu.PopupMenuItem('Open ipleak.net');
        openItem.connect('activate', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(SITE_URL,
                    global.create_app_launch_context(0, -1));
            } catch (e) {
                logError(e, 'ipflag: failed to open browser');
            }
        });
        this.menu.addMenuItem(openItem);

        this._copyItem.setSensitive(false);
    }

    _initNetworkMonitor() {
        NM.Client.new_async(this._nmCancellable, (_obj, res) => {
            let client;
            try {
                client = NM.Client.new_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    logError(e, 'ipflag: NetworkManager unavailable');
                return;
            }
            this._nmClient = client;
            // primary-connection/connectivity cover normal network switches;
            // active-connection-added/removed catch VPNs (e.g. WireGuard with
            // policy routing) that don't change the primary connection.
            for (const sig of ['notify::primary-connection',
                'notify::connectivity',
                'active-connection-added',
                'active-connection-removed']) {
                this._nmSignals.push(
                    client.connect(sig, () => this._scheduleFetch()));
            }
        });
    }

    _scheduleFetch() {
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._debounceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            DEBOUNCE_S, () => {
                this._debounceId = 0;
                this._fetch();
                return GLib.SOURCE_REMOVE;
            });
    }

    _fetch() {
        // A newer request supersedes any in-flight one (it may be using a stale route).
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        const msg = Soup.Message.new('GET', API_URL);
        msg.request_headers.append('Accept', 'application/json');

        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT,
            cancellable, (session, res) => {
                let bytes;
                try {
                    bytes = session.send_and_read_finish(res);
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    this._finish(cancellable, null, e.message);
                    return;
                }

                if (msg.get_status() !== Soup.Status.OK) {
                    this._finish(cancellable, null,
                        `HTTP ${msg.get_status()} ${msg.get_reason_phrase() ?? ''}`.trim());
                    return;
                }

                try {
                    const text = new TextDecoder().decode(bytes.get_data());
                    const data = JSON.parse(text);
                    if (!data || typeof data !== 'object' || !data.country_code)
                        throw new Error('Unexpected response');
                    this._finish(cancellable, data, null);
                } catch (e) {
                    this._finish(cancellable, null, `Bad response: ${e.message}`);
                }
            });
    }

    _finish(cancellable, data, error) {
        if (cancellable !== this._cancellable)
            return;
        this._cancellable = null;

        if (data) {
            this._data = data;
            this._label.text = flagFromCountryCode(data.country_code);
            this._setTooltipRows(detailRows(data));
            this._copyItem.setSensitive(present(data.ip));
        } else {
            this._data = null;
            this._label.text = FLAG_ERROR;
            this._setTooltipRows([['Error', error]]);
            this._copyItem.setSensitive(false);
        }

        if (this._tooltip.visible)
            this._positionTooltip();
    }

    _showTooltip() {
        if (this.menu.isOpen)
            return;
        this._tooltip.show();
        this._positionTooltip();
    }

    _setTooltipRows(rows) {
        this._tooltipKeys.destroy_all_children();
        this._tooltipValues.destroy_all_children();
        for (const [key, value] of rows) {
            this._tooltipKeys.add_child(new St.Label({
                text: key, style_class: 'ipflag-tooltip-key',
            }));
            this._tooltipValues.add_child(new St.Label({
                text: value, style_class: 'ipflag-tooltip-value',
            }));
        }
    }

    _positionTooltip() {
        const [bx, by] = this.get_transformed_position();
        const [bw, bh] = this.get_transformed_size();
        const [, tw] = this._tooltip.get_preferred_width(-1);
        const monitor = Main.layoutManager.findMonitorForActor(this);

        let x = Math.floor(bx + bw / 2 - tw / 2);
        if (monitor)
            x = Math.max(monitor.x + 4, Math.min(x, monitor.x + monitor.width - tw - 4));
        this._tooltip.set_position(x, Math.floor(by + bh + 4));
    }

    _hideTooltip() {
        this._tooltip.hide();
    }

    destroy() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }

        this._nmCancellable.cancel();
        if (this._nmClient) {
            for (const id of this._nmSignals)
                this._nmClient.disconnect(id);
        }
        this._nmSignals = [];
        this._nmClient = null;

        this._cancellable?.cancel();
        this._cancellable = null;
        this._session.abort();
        this._session = null;

        this._tooltip.destroy();
        this._tooltip = null;

        super.destroy();
    }
});

export default class IpFlagExtension extends Extension {
    enable() {
        this._button = new IpFlagButton(this.uuid,
            this.metadata['version-name'] ?? String(this.metadata.version ?? ''));
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');
    }

    disable() {
        this._button?.destroy();
        this._button = null;
    }
}
