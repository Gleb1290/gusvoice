<div align="center">

# 🪿 GusVoice

**English** · [Русский](README.ru.md)

**Self-hosted voice, video, screen-share & text chat for you and your friends.**
Think Discord / TeamSpeak — but it runs on *your* server, on *one* `docker compose`, with every secret generated for you.

[![Latest release](https://img.shields.io/github/v/release/Gleb1290/gusvoice?label=release&color=4f46e5)](https://github.com/Gleb1290/gusvoice/releases/latest)
![Platforms](https://img.shields.io/badge/clients-web%20%C2%B7%20windows%20%C2%B7%20android-informational)
![No tracking](https://img.shields.io/badge/telemetry-none-success)
![Self-hosted](https://img.shields.io/badge/self--hosted-one%20compose-blue)
[![Boosty](https://img.shields.io/badge/Boosty-support-F15F2C?logo=boosty&logoColor=white)](https://boosty.to/glebbuster)

</div>

---

GusVoice gives a group of friends their own private place to talk: **servers → categories → text & voice channels**, Discord-style **roles & permissions**, DMs, reactions, custom sounds, in-app **noise suppression**, 2FA, and **background push** on Android with **no Google/FCM** dependency. All audio and video is relayed by a self-hosted **[LiveKit](https://livekit.io) SFU** — there is no peer-to-peer path, so nobody's IP is exposed to the rest of the room.

The whole stack — `postgres · redis · livekit · backend · presence · web client`, plus bundled **Caddy** (auto-HTTPS), **versitygw** (S3 media storage) and **ntfy** (push) — comes up from a single compose file.

## Highlights

- 🎙️ **Voice, video & screen-share** with per-channel quality/FPS controls and a live sidebar of who's talking.
- 💬 **Text chat** — reactions, replies, @mentions, unread/mention badges, file attachments, message search.
- 🛡️ **Roles & permissions** with per-channel and per-category overrides, server-side voice moderation, and an audit log.
- 📱 **One app, your server** — web, auto-updating **Windows** desktop, and **Android**. You type your server's address at login; switch servers anytime.
- 🔔 **Background notifications** for DMs/@mentions on Android via UnifiedPush — no Google Play Services required.
- 🔒 **Secure by default** — every secret is generated at install, fail-closed config, rate-limited auth, optional 2FA, anti-bot signup guards.
- 📦 **Batteries included** — bundled TLS, object storage and push gateway. Nothing external to sign up for.

## Requirements

- A **Linux host** (a small VPS or a home box) with **~2 GB RAM** free.
- A **domain** you control (GusVoice uses six sub-domains: `voice` · `api` · `presence` · `lk` · `media` · `ntfy`).
- The ability to **open a few ports** (`80`, `443`, and LiveKit media `7881/tcp` + `7882/udp`).
- **Docker** — the installer offers to set it up for you if it's missing.

## Install

```bash
# one-liner — fetches everything, asks a few questions, brings the stack up
curl -fsSL https://raw.githubusercontent.com/Gleb1290/gusvoice/main/install.sh | bash
```

or, if you'd rather clone first and read before running:

```bash
git clone https://github.com/Gleb1290/gusvoice.git
cd gusvoice
./install.sh
```

The installer **generates every secret**, writes `.env`, and brings the stack up behind the bundled Caddy with automatic Let's Encrypt HTTPS (or stays behind a reverse proxy you already run — it asks). It finishes by printing the exact **DNS records** and **port forwards** to set up. Full walkthrough — including connecting the desktop & Android clients — in **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)**.

When it's done, open `https://voice.<your-domain>` and enter the **setup code** it printed: a short web wizard creates your admin account and sets the name, e-mail, who may register and a first server with an invite link.

## Update

Grab the newest server images and stack files — one line, from anywhere:

```bash
curl -fsSL https://raw.githubusercontent.com/Gleb1290/gusvoice/main/update.sh | bash
```

or, from inside your install directory:

```bash
cd gusvoice
./update.sh
```

`update.sh` backs up your current `docker-compose.yml` + `config/`, refreshes them to the latest release, pulls the new images, **saves a copy of the database** into `./.gusvoice-backups/`, and recreates only the containers that changed. **Your `.env` and all data are left untouched**, and the backend runs any pending database migrations automatically on boot.

| Flag | Effect |
|------|--------|
| `--images-only` | Only pull images + recreate — don't touch your `docker-compose.yml` / `config/`. |
| `--prune` | Remove old dangling images afterwards to reclaim disk. |
| `--no-db-backup` | Skip the database copy taken before containers are recreated. |
| `--install-updater` | (root, needs systemd) Enable the **Update** button in the admin panel. |
| `-y`, `--yes` | Run non-interactively. |

Or update **without the console**: the admin panel's **Instance** tab shows the installed version next to the newest release and updates the server for you, step by step. The backend never gets access to Docker — it only leaves a request that a small systemd watcher on the host picks up. The installer enables that watcher when it can (root or password-less sudo); otherwise run `sudo ./update.sh --install-updater` once.

> The desktop and Android apps **update themselves** — you only ever update the server.

## Uninstall

```bash
cd gusvoice
./uninstall.sh            # stop & remove the containers — your DATA is kept
```

This stops GusVoice but preserves your database, uploads and secrets, so `./install.sh` (or `./update.sh`) later resumes exactly where you left off.

To wipe **everything** — all accounts, messages, uploads and secrets — permanently:

```bash
./uninstall.sh --purge    # asks you to type "yes"; then deletes data volumes + .env
```

## Clients

Download the desktop or Android app from the **[Releases page](https://github.com/Gleb1290/gusvoice/releases/latest)**, launch it, and enter your server's address (e.g. `voice.example.com`). Change servers anytime from **Settings → Account → Server**. The web client is served at `https://voice.<your-domain>` — no download needed.

## Where things live

| What | Where |
|------|-------|
| Your config & **all secrets** | `.env` (generated by the installer, `chmod 600` — never commit it) |
| Database, media, push & TLS state | Docker **named volumes** (`gusvoice_pgdata`, `gusvoice_s3data`, `gusvoice_ntfydata`, `gusvoice_caddydata`, …) |
| Reverse-proxy / TLS templates | `config/Caddyfile`, `config/livekit.yaml` (driven by `.env`) |
| Update backups | `./.gusvoice-backups/<timestamp>/` |

To reconfigure from scratch, delete `.env` and re-run `./install.sh`. To run behind **your own** reverse proxy (Nginx Proxy Manager / nginx / Traefik) instead of the bundled Caddy, the installer asks — see [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

## Support

GusVoice is free to self-host and built in the open. If it's useful to you, you can support development on **[Boosty](https://boosty.to/glebbuster)** — it helps cover servers and build hardware. Thank you 🪿

## Build from source

Everything above ships as prebuilt images, but nothing stops you from building your own — the compose file
carries a `build:` section for every service:

```bash
git clone https://github.com/Gleb1290/gusvoice.git && cd gusvoice
./install.sh                 # generates .env and starts the stack
docker compose build         # build the images from this source
docker compose up -d
```

For working on the code itself (Node.js 20+, pnpm, typecheck, tests) see **[CONTRIBUTING.md](CONTRIBUTING.md)**; how the
pieces fit together is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Contributing

Bug reports, fixes and translations are welcome, in **English or Russian** — start with
**[CONTRIBUTING.md](CONTRIBUTING.md)**. Before your first pull request is merged you'll be asked to accept the
**[CLA](CLA.md)** ([why](LICENSING.md)). Found a security problem? Report it privately — see
**[SECURITY.md](SECURITY.md)**, never a public issue.

## License

**[AGPL-3.0-only](LICENSE)** — free to use, self-host and modify. If you run a modified GusVoice as a service for other
people, you must offer them your changes under the same licence. Third-party components, the NVIDIA Video Codec SDK
exception and the reasoning behind the CLA are listed in **[LICENSING.md](LICENSING.md)**.
