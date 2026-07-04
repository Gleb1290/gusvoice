# GusVoice

Self-hosted, **Discord/TeamSpeak-style** voice + text + screen-share for you and your
friends. Servers → categories → text & voice channels, roles/permissions, DMs,
reactions, custom sounds, in-app noise suppression, 2FA, and background push
notifications (no Google/FCM). All media is relayed by a self-hosted **LiveKit SFU** —
there is no peer-to-peer path. The whole stack runs on **one host** from a single
`docker compose`.

**Web**, **Windows desktop** (auto-updating), and **Android** clients — one prebuilt app
that connects to *your* server: you enter your server's address at login.

## Quick start

```bash
git clone https://github.com/Gleb1290/gusvoice.git
cd gusvoice
./install.sh
```

The installer asks a few questions, **generates every secret for you**, and brings the
whole stack up behind a bundled Caddy reverse proxy with automatic HTTPS. The only manual
steps are **DNS records** and **port forwarding** — see **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)**
for the full walkthrough, including how to connect the desktop and Android clients.

## What you get

- Voice, video, and **screen-share** with a live sidebar showing who's in every channel.
- Text chat with reactions, replies, mentions, unread/mention badges, and file attachments.
- Discord-style **roles & permissions** with per-channel and per-category overrides.
- **Background notifications** on Android for DMs/@mentions — no Google dependency.
- Bundled **media storage** (MinIO) and **push gateway** (ntfy) — nothing external to set up.

## Clients

Download the desktop/Android app from the **Releases** page, launch it, and enter your
server's address (e.g. `voice.example.com`). Change servers anytime from
**Settings → Account → Server**.

## License

See [LICENSE](LICENSE). GusVoice is free to self-host. (Source is planned to open under
AGPLv3 in a later release.)
