<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/banner-dark.svg">
  <img alt="GusVoice" src="docs/readme/banner-light.svg" width="100%">
</picture>

# 🪿 GusVoice

**English** · [Русский](README.ru.md)

**Your own Discord — voice, screen sharing, servers and Telegram-grade direct messages — on your own server.**

[![Latest release](https://img.shields.io/github/v/release/Gleb1290/gusvoice?label=release&color=f2b33d)](https://github.com/Gleb1290/gusvoice/releases/latest)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE)
![Clients](https://img.shields.io/badge/clients-web%20%C2%B7%20windows%20%C2%B7%20android-informational)
![Self-hosted](https://img.shields.io/badge/self--hosted-one%20docker%20compose-2c2a33)
![No telemetry](https://img.shields.io/badge/telemetry-none-success)
[![Boosty](https://img.shields.io/badge/Boosty-support-F15F2C?logo=boosty&logoColor=white)](https://boosty.to/glebbuster)

[Features](#features) · [Quick start](#quick-start) · [Architecture](#architecture) · [Clients](#clients) · [Build from source](#build-from-source) · [Contributing](#contributing)

</div>

<p align="center">
  <img src="docs/readme/desktop-voice.png" alt="A voice channel with a screen share and five participants" width="100%">
</p>

GusVoice gives a group of friends, a community or a small team a private place to talk: **servers → categories → text and
voice channels** with Discord-style roles, plus **direct messages that work like Telegram** — voice notes, round videos,
polls, calls, folders. Every byte of audio and video goes through a self-hosted **[LiveKit](https://livekit.io) SFU**, so there
is no peer-to-peer path and nobody's IP address is shown to the rest of the room. The whole stack comes up from **one
`docker compose`**, the installer generates every secret, and the web, Windows and Android apps all talk to *your* server.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/readme/desktop-server.png" alt="Server with categories, text and voice channels"><br><sub>Servers, channels and a live list of who is in voice</sub></td>
    <td width="50%"><img src="docs/readme/desktop-dm.png" alt="Direct messages: replies, reactions, a voice note, a location"><br><sub>Direct messages: replies, reactions, voice notes, location</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/readme/desktop-group-light.png" alt="A group chat with a poll, light theme"><br><sub>Groups and polls — light theme</sub></td>
    <td width="50%"><img src="docs/readme/desktop-settings.png" alt="Voice settings with noise suppression options"><br><sub>Noise suppression: system, RNNoise or DeepFilter</sub></td>
  </tr>
</table>

<p align="center">
  <img src="docs/readme/phone-dms.png" alt="Android: chat list" width="24%">
  <img src="docs/readme/phone-chat.png" alt="Android: a conversation" width="24%">
  <img src="docs/readme/phone-profile.png" alt="Android: a contact's profile" width="24%">
  <img src="docs/readme/phone-group-light.png" alt="Android: group with a poll, light theme" width="24%">
</p>

## Features

**🎙️ Voice and screen sharing**
- Voice channels with a live sidebar of who is talking; per-person volume, push-to-talk, global mute/deafen hotkeys on desktop.
- Noise suppression — system, **RNNoise** or **DeepFilter** — plus echo cancellation and auto-gain.
- Screen sharing in native resolution up to 4K, 15/30/60 fps, "Sharpness" or "Smoothness"; viewers pick the quality they receive.
- On Windows the share is native and hardware-encoded (NVENC), carries application audio, and the app stops redrawing while a game covers it.
- All media is relayed by the server — no P2P, no exposed IPs.

**🏠 Servers, channels, roles**
- Servers → categories → text and voice channels; invite links with expiry and use limits.
- Discord-style roles and permissions with per-category and per-channel overrides; voice moderation; audit log.
- Replies, reactions, @mentions (including `@everyone`), pins, attachments, search, custom emoji and per-server sounds.
- Optional extras: a per-server coin economy with a shop and soundboard, "Playing …" status.

**💬 Direct messages, the Telegram way**
- Bubbles, albums of up to 10 photos and videos, replies to a fragment, forwarding to several chats, pinned messages and chats.
- Voice notes up to 30 minutes (1× / 1.5× / 2×, "listen once") and round video messages.
- One-to-one calls with voice, video and screen sharing; on Android an incoming call opens full screen even when locked.
- Groups, Saved Messages, polls and quizzes, location and live location, contacts, files up to 512 MB that resume after a drop.
- Folders and archive, drafts on every device, "send later" and "send when online", silent send, mute for any period.
- Instant start from the on-device cache; unsent messages go out by themselves when the network is back.
- Privacy: who sees your last-seen time, who may message and call you, a stranger bar with Report and Block.

**🌐 Federation** *(off by default)*
- Link your server with a friend's: both admins approve, each instance signs its requests with its own key.
- People from the other server join yours with **their own account** via an invite link; all their servers sit in one sidebar.
- Direct messages between servers (`@name@server`), including groups, calls and files; a conversation keeps going if one side is down.

**📱 Clients**
- Web app, auto-updating **Windows** desktop app (tray, global hotkeys, notifications in the style of Telegram Desktop) and **Android**.
- You type your server's address at sign-in and can switch between servers at any time.

**🗺️ Own map** — locations in DMs are drawn from an OpenStreetMap extract on *your* server; clients never call third-party map services. See [docs/maps.md](docs/maps.md).

**🔔 Push without Google** — DMs and mentions wake the Android app through [UnifiedPush](https://unifiedpush.org) and the bundled [ntfy](https://ntfy.sh) gateway — no Firebase, no Google Play Services.

**🔄 One-click updates** — the admin panel tells you when a new version is out; the **Update** button backs up the database and updates the server — no console, no SSH. The Windows and Android apps update themselves.

**🔒 Secure by default** — secrets generated at install, fail-closed config, rate-limited sign-in, optional 2FA, sign-up policy (open, approval or invite-only).

## Quick start

You need:

- a **Linux host** — a small VPS is fine (2 vCPU / 4 GB RAM / 20 GB disk to start);
- a **domain** you control — GusVoice uses six sub-domains: `voice` · `api` · `presence` · `lk` · `media` · `ntfy`;
- open ports **80** and **443**, plus LiveKit media **7881/tcp** and **7882/udp**;
- **Docker** — the installer offers to install it if it's missing.

```bash
curl -fsSL https://raw.githubusercontent.com/Gleb1290/gusvoice/main/install.sh | bash
```

Prefer to read before running?

```bash
git clone https://github.com/Gleb1290/gusvoice.git
cd gusvoice
./install.sh
```

The installer asks a few questions, **generates every secret**, writes `.env` and brings the stack up behind the bundled
Caddy with automatic Let's Encrypt HTTPS — or behind the reverse proxy you already run (Nginx Proxy Manager, nginx, Traefik;
it asks). It finishes by printing the exact **DNS records** and **port forwards** to set up.

Then open `https://voice.<your-domain>` and enter the **setup code** the installer printed: a short web wizard creates your
admin account and sets the server name, e-mail, who may register and a first server with an invite link.

Full walkthrough — DNS, your own proxy, connecting the apps — in **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)**.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/architecture-dark.svg">
  <img alt="GusVoice architecture" src="docs/readme/architecture-light.svg" width="100%">
</picture>

- **backend** (Node.js, Fastify, Drizzle/PostgreSQL) — accounts, servers, channels, roles, messages and DMs, the real-time gateway, and the **LiveKit tokens**: what you may publish is decided by your permissions.
- **livekit-server** — the SFU; voice, video and screen shares all flow through it (`7882/udp`, `7881/tcp` fallback). There is no P2P mode.
- **presence** — receives LiveKit webhooks and tells every client who is in which voice channel.
- **client** — the React web app; the Windows (Tauri) and Android apps wrap the same code.
- **PostgreSQL** + **Redis** for data and fan-out, **versitygw** for uploads (S3 API), **ntfy** for push, **Caddy** for TLS.

How the pieces fit together in detail: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Update

**From the admin panel — the main way.** The **Instance** tab shows the installed and the newest version; the **Update**
button backs up the database and updates the server step by step, with progress right in the panel. The installer enables the
button by itself when it runs as root or with password-less `sudo`; otherwise it prints one command at the end —
`sudo ./update.sh --install-updater`. The backend never gets access to Docker: it leaves a request that a small systemd
watcher on the host picks up. The desktop and Android apps update themselves.

**From the console** — the same thing in one command:

```bash
cd gusvoice
./update.sh
```

`update.sh` backs up your `docker-compose.yml` and `config/`, refreshes them to the latest release, pulls the new images,
**saves a copy of the database** into `./.gusvoice-backups/` and recreates only the containers that changed. Your `.env` and
data are left alone; database migrations run by themselves on start.

| Flag | Effect |
|------|--------|
| `--images-only` | Only pull images and recreate — don't touch `docker-compose.yml` / `config/`. |
| `--prune` | Remove old dangling images afterwards. |
| `--no-db-backup` | Skip the database copy. |
| `--install-updater` | (root, systemd) Enable the **Update** button in the admin panel. |
| `-y`, `--yes` | Non-interactive. |


## Uninstall

```bash
./uninstall.sh            # stop and remove the containers — your data is kept
./uninstall.sh --purge    # asks you to type "yes", then deletes data volumes and .env
```

## Where things live

| What | Where |
|------|-------|
| Config and **all secrets** | `.env` (written by the installer, `chmod 600` — never commit it) |
| Database, uploads, push and TLS state | Docker named volumes (`gusvoice_pgdata`, `gusvoice_s3data`, `gusvoice_ntfydata`, `gusvoice_caddydata`, …) |
| Proxy and SFU config | `config/Caddyfile`, `config/livekit.yaml` (driven by `.env`) |
| Update backups | `./.gusvoice-backups/<timestamp>/` |

## Clients

| Platform | How to get it |
|----------|---------------|
| **Web** | `https://voice.<your-domain>` — nothing to install |
| **Windows** | installer from **[Releases](https://github.com/Gleb1290/gusvoice/releases/latest)**; updates itself |
| **Android** | APK from **[Releases](https://github.com/Gleb1290/gusvoice/releases/latest)**; background voice, full-screen calls, push via UnifiedPush |

Launch the app and type your server's address (for example `voice.example.com`). More servers can be added later in
**Settings → Federation → My instances**. Desktop details: [apps/desktop/README.md](apps/desktop/README.md).

## Build from source

Prebuilt images are the default, but the compose file has a `build:` section for every service:

```bash
git clone https://github.com/Gleb1290/gusvoice.git && cd gusvoice
./install.sh                 # generates .env and starts the stack
docker compose build         # build the images from this source
docker compose up -d
```

Working on the code itself (Node.js, pnpm, typecheck, tests, the desktop app with Rust) — see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

```
packages/shared      permission bitfield, DTO types, WebSocket protocol
packages/backend     REST + gateway + LiveKit tokens (Fastify, Drizzle)
packages/presence    LiveKit webhooks → Redis → presence WebSocket
apps/client          React web app (also inside the desktop and Android apps)
apps/desktop         Tauri v2 shell for Windows and Android
config/              LiveKit and Caddy config (no secrets)
docker-compose.yml   the whole stack
```

## Contributing

Bug reports, fixes and translations are welcome, in **English or Russian** — start with **[CONTRIBUTING.md](CONTRIBUTING.md)**.
Before your first pull request is merged you'll be asked to accept the **[CLA](CLA.md)** ([why](LICENSING.md)). Found a
security problem? Report it privately — see **[SECURITY.md](SECURITY.md)**, never in a public issue.

If GusVoice is useful to you, you can support development on **[Boosty](https://boosty.to/glebbuster)** — it pays for servers
and build hardware. Thank you 🪿

## License

**[AGPL-3.0-only](LICENSE)** — free to use, self-host and modify. If you run a modified GusVoice as a service for other people,
you must offer them your changes under the same licence. Third-party components, the NVIDIA Video Codec SDK exception and the
reasoning behind the CLA are in **[LICENSING.md](LICENSING.md)**.
