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

The whole stack — `postgres · redis · livekit · backend · presence · web client`, plus bundled **Caddy** (auto-HTTPS), **MinIO** (media) and **ntfy** (push) — comes up from a single compose file.

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

When it's done, open `https://voice.<your-domain>` and log in as the super-admin it created for you.

## Update

Grab the newest server images and stack files. Run it from your install directory:

```bash
cd gusvoice
./update.sh
```

or as a one-liner from anywhere:

```bash
curl -fsSL https://raw.githubusercontent.com/Gleb1290/gusvoice/main/update.sh | bash
```

`update.sh` backs up your current `docker-compose.yml` + `config/`, refreshes them to the latest release, pulls the new images, and recreates only the containers that changed. **Your `.env` and all data are left untouched**, and the backend runs any pending database migrations automatically on boot.

| Flag | Effect |
|------|--------|
| `--images-only` | Only pull images + recreate — don't touch your `docker-compose.yml` / `config/`. |
| `--prune` | Remove old dangling images afterwards to reclaim disk. |
| `-y`, `--yes` | Run non-interactively. |

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
| Database, media, push & TLS state | Docker **named volumes** (`gusvoice_pgdata`, `gusvoice_miniodata`, `gusvoice_ntfydata`, `gusvoice_caddydata`, …) |
| Reverse-proxy / TLS templates | `config/Caddyfile`, `config/livekit.yaml` (driven by `.env`) |
| Update backups | `./.gusvoice-backups/<timestamp>/` |

To reconfigure from scratch, delete `.env` and re-run `./install.sh`. To run behind **your own** reverse proxy (Nginx Proxy Manager / nginx / Traefik) instead of the bundled Caddy, the installer asks — see [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

## Support

GusVoice is free to self-host and built in the open. If it's useful to you, you can support development on **[Boosty](https://boosty.to/glebbuster)** — it helps cover servers, signing certificates and build hardware. Thank you 🪿

## License

See **[LICENSE](LICENSE)**. GusVoice is **free to self-host**. The source is planned to open under **AGPLv3** in a later release.
