# Self-hosting HL Quant

HL Quant has **one self-hosted server** (the brain: trading bot, AI agents, history, Telegram) and any number of
**thin clients** (browser, Windows/Linux/macOS desktop app, Android app, iPhone home-screen app). Every client
connects to that one server with its **URL** and **API token**.

| Way to run the server | Best for |
| --- | --- |
| [Docker](#1-docker) | always-on Linux box, VPS, NAS |
| [systemd](#2-linux-server-with-systemd) | Linux machine without Docker |
| [Desktop host mode](#3-desktop-app-as-the-server-host-mode) | a Windows, Linux or macOS PC you already use |
| [Server bundle](#4-single-file-server-bundle) | any machine with Node.js, no git or npm |

The server listens on port **8787**. Every endpoint except `GET /api/health` needs the API token. If you do not set
`API_TOKEN`, the server generates one on first start, prints it in its log and saves it in `server.json` inside the
data directory.

## 1. Docker

```sh
git clone https://github.com/ilrksy/makanan.git hl-quant && cd hl-quant
cp .env.example .env          # optional: trading mode, keys, API_TOKEN ...
cd deploy
docker compose up -d --build
docker compose logs hl-quant | grep "API token"
```

- Data (database, settings, token) lives in the `hl-quant-data` volume, mounted at `/data`.
- Update: `git pull && docker compose up -d --build`.
- Without Compose: `docker build -f deploy/Dockerfile -t hl-quant .` from the repository root, then
  `docker run -d --name hl-quant --restart unless-stopped -p 8787:8787 -v hl-quant-data:/data hl-quant`.
- Needs BuildKit (default since Docker 23) and Docker Compose v2.24+ (for the optional `env_file`).

## 2. Linux server with systemd

Needs Node.js 24 LTS (at least 22.13, for the built-in `node:sqlite`).

```sh
sudo useradd --system --home-dir /var/lib/hl-quant --shell /usr/sbin/nologin hlquant
sudo git clone https://github.com/ilrksy/makanan.git /opt/hl-quant
cd /opt/hl-quant
sudo npm ci && sudo npx vite build
sudo cp .env.example .env && sudo chown root:hlquant .env && sudo chmod 640 .env
#   set HOST=0.0.0.0 in .env so phones and other PCs on your network can connect
sudo cp deploy/hl-quant.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hl-quant
journalctl -u hl-quant -f     # the first start prints the API token
```

- Data lives in `/var/lib/hl-quant` (token: `/var/lib/hl-quant/server.json`).
- Update: `cd /opt/hl-quant && sudo git pull && sudo npm ci && sudo npx vite build && sudo systemctl restart hl-quant`.

## 3. Desktop app as the server (host mode)

Install `HL-Quant-Setup-<version>-x64.exe` (Windows), the AppImage, `.deb` or `.rpm` (Linux) or the `.dmg` (macOS).

- **Host mode is on by default**: the app runs the server on this computer and opens the dashboard already
  connected to it.
- The tray icon menu (also in the menu bar under **Server**; press `Alt` on Windows/Linux to show it) has:
  - **Host mode**: run the server here, or switch the app to a pure client of another server.
  - **Allow LAN devices**: listen on all network interfaces so phones and other PCs can connect. Windows asks to
    allow HL Quant through the firewall: allow **private networks** only.
  - **Copy connection info**: copies the URL(s) and the API token.
  - **Open data folder**.
- Closing the window keeps the server (and the bot) running in the tray. **Quit** in the tray menu stops it.
  On Linux desktops without a tray, start the app again to bring the window back.
- If port 8787 is busy, host mode uses the next free port (shown in the tray menu).
- Keep the computer awake if it should trade around the clock.
- Data folder: `%APPDATA%\HL Quant` (Windows), `~/.config/HL Quant` (Linux),
  `~/Library/Application Support/HL Quant` (macOS):
  - `server-data/`: database and settings; put an optional `.env` here for process settings such as `TRADING_MODE`
  - `logs/server.log`: server output
  - `host.json`: host mode choices and the API token

## 4. Single-file server bundle

Every GitHub release has `hl-quant-server-<version>.tar.gz` (bundled server plus dashboard). With Node.js 24:

```sh
tar xzf hl-quant-server-<version>.tar.gz && cd hl-quant-server-<version>
HOST=0.0.0.0 node server.mjs    # data goes to ./data; optional settings in ./.env
```

## Connecting your devices

Each device asks for the **server URL** and the **API token** the first time.

- **Same Wi-Fi / LAN**: `http://<server-ip>:8787`. The server must listen on `0.0.0.0` (Docker does; systemd:
  `HOST=0.0.0.0`; desktop: **Allow LAN devices**).
- **Android**: install `HL-Quant-<version>.apk` (allow "install unknown apps"). Plain `http://` LAN addresses work.
- **iPhone / iPad**: open the server URL in Safari, then Share → **Add to Home Screen**.
- **Other PCs**: install the desktop app and turn **Host mode** off, or just open the server URL in a browser.

## Remote access (away from home)

> **Never forward port 8787 to the internet or expose it publicly over plain HTTP.** The token would travel in clear
> text, and whoever has it can control your trading. Use a private network or an HTTPS tunnel, and always keep the
> API token enabled.

- **Tailscale** (simplest): install it on the server and on every phone/PC with the same account, then connect to
  `http://<server-name>:8787`. Traffic is end-to-end encrypted. For an HTTPS URL inside your tailnet:
  `tailscale serve --bg 8787`.
- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:8787` gives a temporary HTTPS URL for testing.
  For permanent use create a named tunnel on your own domain and protect it with Cloudflare Access.

With a tunnel the server can stay on loopback only (Compose: `"127.0.0.1:8787:8787"`; desktop: LAN off).

## Security checklist

- Keep the API token private. To rotate it: delete `server.json` in the data directory (or set `API_TOKEN`) and
  restart; in the desktop app quit, delete `host.json`, and start again (this also resets the host mode choices).
- For live trading use a Hyperliquid API/agent wallet key (it cannot withdraw) and try testnet first.
- Back up the data directory (Docker volume, `/var/lib/hl-quant`, or the desktop data folder).

## Building the apps yourself

From the repository root, after `npm ci && npx vite build`:

| Target | Command | Notes |
| --- | --- | --- |
| Windows installer | `npm --prefix desktop ci && npm --prefix desktop run dist:win` | on Windows; on Linux it needs wine with 32-bit support |
| Linux packages | `npm --prefix desktop run dist:linux` | `.rpm` needs `rpmbuild` |
| macOS dmg | `npm --prefix desktop run dist:mac` | on macOS; unsigned |
| Android apk | `mobile/scripts/setup-android-sdk.sh`, then `npm --prefix mobile ci && npm --prefix mobile run apk` | JDK 21; signed when `ANDROID_KEYSTORE_PATH` is set (see `mobile/scripts/create-keystore.sh`) |

Artifacts land in `release/`. Pushing a `v*` tag builds everything in GitHub Actions and publishes a GitHub release.
