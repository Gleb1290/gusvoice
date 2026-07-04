# Self-hosting GusVoice

A complete guide to standing up your own GusVoice server and connecting the desktop
and Android clients to it. The installer generates all secrets for you — the only
manual steps are **DNS records** and **port forwarding**.

---

## 1. What you need

- A Linux server (a small VPS is fine: 2 vCPU / 4 GB RAM / 20 GB disk to start) with a
  **public IP**.
- **Docker** + the **docker compose** v2 plugin, and **openssl**.
- A **domain** you control (e.g. `example.com`) where you can add DNS records.

## 2. Install (one command)

```bash
git clone https://github.com/Gleb1290/gusvoice.git
cd gusvoice
./install.sh
```

The installer asks a few questions (your domain, an admin username, an email for TLS
certificates, optionally SMTP), then **generates every secret itself** and brings the
whole stack up behind a bundled Caddy reverse proxy with automatic HTTPS.

## 3. The two manual steps

### DNS

Point these records at your server. A single wildcard `A` record covers them all:

| Record | Type | Value |
|--------|------|-------|
| `*.example.com` | A | your server's public IP |
| `example.com` | A | your server's public IP |

The subdomains used are `voice`, `api`, `presence`, `lk`, `media`, `ntfy`.

### Ports

Open / forward these to the server:

| Port | Proto | Purpose |
|------|-------|---------|
| 80, 443 | TCP | Web + HTTPS (Caddy — also handles the TLS certificates) |
| 7881 | TCP | LiveKit media (fallback) — **direct, not proxied** |
| 7882 | UDP | LiveKit media (primary) — **direct, not proxied** |

> Voice/video/screen media flows straight to your server's IP on 7881/7882 — a reverse
> proxy cannot carry it. These two ports **must** be reachable from the internet.

## 4. First login

Open **https://voice.example.com** and register the admin account you named during
install (the `SUPERADMIN_USERNAME`). That account gets the admin panel and can create
servers. Create a server, make some channels, and invite people with invite codes.

## 5. Connecting the desktop & Android clients

The clients are **one prebuilt app for everyone** — they aren't tied to any server.

1. Download the client from the project's **Releases** page:
   - **Windows** — `GusVoice-setup.exe` (auto-updating).
   - **Android** — the `.apk` (sideload) or from the project's F-Droid repo.
2. Launch it. On first run it asks **"Server address"** — type your domain, e.g.
   `voice.example.com`, and press Connect.
3. Log in with your account. Done.

To point the app at a different server later: **Settings → Account → Server → Change server**.

### Background notifications on Android

DMs and @mentions wake the Android app even when it's closed — no Google/FCM, no second
app to install. The client runs a small background connection to your server's bundled
ntfy gateway (it shows a quiet persistent "notifications on" entry, which is the price of
push without Google). Nothing to configure: it learns the address from your server.

## 6. Media & email

- **Media** (avatars, attachments, custom sounds, channel icons) is stored in the bundled
  MinIO and served from `media.example.com`. Nothing to set up — the installer does it.
- **Email verification** is optional. If you gave SMTP details, registration emails a code;
  otherwise codes are printed to the backend log (`docker compose logs backend`).

## 7. Maintenance

```bash
docker compose ps                 # service status
docker compose logs -f backend    # backend logs (incl. verification codes if SMTP is off)
docker compose pull && docker compose up -d   # update to the latest images

# Back up the database:
docker compose exec -T postgres pg_dump -U gusvoice gusvoice > gusvoice-$(date +%F).sql
```

Media lives in the `miniodata` volume; back it up alongside the database if you want a
full restore.

## 8. Troubleshooting

| Symptom | Check |
|---------|-------|
| Site won't load | DNS records resolve to your IP; `docker compose ps`; port 80/443 open |
| Voice connects but no sound | 7882/udp + 7881/tcp reachable from outside; `docker compose logs livekit` |
| Screen-share won't start | needs HTTPS (you have it) + the STREAM permission on the channel |
| No verification email | `docker compose logs backend \| grep -i code`; check SMTP settings in `.env` |
| Push not waking the phone | ntfy reachable at `ntfy.example.com`; `NTFY_TOKEN` set in `.env` |

---

Secrets live only in `.env` (never commit it). All internal services bind to the docker
network; only Caddy (80/443) and the LiveKit media ports (7881/7882) face the internet.
