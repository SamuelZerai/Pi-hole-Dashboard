# Pi-hole Desktop

A lightweight Windows desktop client for managing your [Pi-hole](https://pi-hole.net/) DNS sinkhole, built with Electron and vanilla HTML/CSS/JavaScript.

## What it does

Pi-hole Desktop gives you a native Windows interface to monitor and control your Pi-hole instance without opening a browser:

- **Dashboard** — live query stats (total, blocked, blocked %), top blocked domains, top clients, gravity list size, with configurable auto-refresh
- **Domain Management** — add domains to the blocklist or allowlist, search existing entries, and remove them
- **Windows Notifications** — native alerts when a domain is queried unusually often (e.g. 50 times in 5 minutes) or when a new unknown device appears on your network
- **Settings** — configure your Pi-hole's IP/hostname, connection protocol, password, notification thresholds, and refresh interval

## Install and run

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- A running Pi-hole v6 instance on your local network

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/your-username/pihole-desktop.git
cd pihole-desktop

# 2. Install dependencies
npm install

# 3. Start the app
npm start
```

On first launch, the app will open on the **Settings** tab. Enter your Pi-hole IP address (or hostname), select the protocol (HTTP or HTTPS), and enter your password. Click **Save & Connect**.

### Build a Windows installer (optional)

```bash
npm run build
```

The installer will be generated in the `release/` folder.

## How to find your Pi-hole password

Pi-hole v6 uses a single admin password (the same one you set during installation or changed via `pihole setpassword`).

If you have forgotten it, SSH into your Pi-hole and run:

```bash
pihole setpassword
```

This lets you set a new password. The app uses that password to authenticate via the Pi-hole v6 API (`POST /api/auth`).

## Security notes

- The password is encrypted at rest using **Windows Credential Store** via Electron's `safeStorage` API — it is never stored in plaintext on disk.
- Session tokens are kept in memory only and are never written to disk or logged.
- All Pi-hole API calls are made from the Electron **main process** — the renderer (UI) never has direct network access.
- The renderer runs with `contextIsolation: true` and `nodeIntegration: false`.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Desktop runtime | [Electron](https://www.electronjs.org/) v29 |
| UI | HTML5, CSS3, JavaScript (ES2022, no frameworks) |
| API | Pi-hole v6 REST API (`/api`) |
| Password storage | Electron `safeStorage` (Windows Credential Store) |
| Packaging | electron-builder (NSIS Windows installer) |

## Portfolio description

Pi-hole Desktop is a cross-cutting systems project demonstrating proficiency in:

- **Electron architecture** — secure main/renderer split with IPC, `contextIsolation`, and a typed `contextBridge` preload layer
- **API integration** — stateful session management with automatic re-authentication against a REST API
- **Native platform features** — Windows Credential Store encryption and native OS notifications
- **Vanilla frontend** — component-style JavaScript organisation, XSS-safe DOM rendering, and tab-based SPA routing without any framework
- **Security-first design** — secrets never touch the renderer process, tokens never touch disk, all inputs validated before network access
