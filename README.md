# IP Flag

A GNOME Shell extension that shows the flag of your public IP's country on the right side of the top bar. Hover over it to see details, click it for actions. The data comes from [ipleak.net](https://ipleak.net/json/).

- Targets GNOME Shell 50 (Ubuntu 26.04).
- The flag refreshes on startup, every 5 minutes, and 3 s after a network change. A network change includes Wi-Fi switches and VPNs connecting or disconnecting.
- The hover tooltip shows your public IP, its location (city and region) and its country. For ISP, reverse DNS and more, use **Open ipleak.net**.
- The click menu has **Copy IP**, **Refresh now** and **Open ipleak.net**.
- 🏳️ means loading. ❌ means an error; hover to see what went wrong.

> Privacy: the extension sends a request to ipleak.net on every refresh, so ipleak.net sees your public IP.

## Install

```sh
make install          # = gnome-extensions pack + gnome-extensions install --force
```

Or by hand:

```sh
gnome-extensions pack --extra-source=LICENSE --extra-source=README.md .
gnome-extensions install --force ipflag@cdrcqnts.github.io.shell-extension.zip
```

On Wayland, log out and back in so the Shell picks up the new extension. Then run:

```sh
gnome-extensions enable ipflag@cdrcqnts.github.io
```

Uninstall it with `make uninstall`.

## Development

You can test the extension in a nested Shell without touching your session. This needs the `mutter-dev-bin` package, which provides `mutter-devkit`.

```sh
make install
dbus-run-session gnome-shell --devkit --wayland
```

`dbus-run-session` starts a private session bus. The nested Shell still uses the **system** bus, so it reaches NetworkManager, and VPN toggles on the host are seen. Inside the nested Shell, enable the extension from a terminal running in it:

```sh
gnome-extensions enable ipflag@cdrcqnts.github.io
```

Logs:

```sh
journalctl -f -o cat /usr/bin/gnome-shell   # for your real session
# or just watch the terminal that runs the nested shell
```

`make pack` builds `ipflag@cdrcqnts.github.io.shell-extension.zip`, which you can upload to extensions.gnome.org.

## License

MIT
