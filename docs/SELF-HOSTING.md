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

The installer asks only about the basics (your domain, whether you already run a reverse proxy,
an email for TLS certificates), then **generates every secret itself**, brings the whole stack
up behind a bundled Caddy reverse proxy with automatic HTTPS, and prints a **setup code**.
Everything personal — the admin account, e-mail, who may register — is set in the browser (§4).

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

## 4. First run: the setup wizard

Open **https://voice.example.com**. A fresh server shows the setup wizard instead of the login page:

1. **Setup code** — the one the installer printed at the end (also `SETUP_TOKEN` in `.env`). Without it the
   wizard won't open: otherwise whoever reaches a brand-new server first (bots watch new TLS certificates)
   could claim it.
2. **Your admin account** — username, e-mail, password. You're logged in right away; no e-mail code.
3. **Name and icon** of your server.
4. **E-mail (SMTP)** with a "send test e-mail" button — can be skipped: then you approve each new sign-up
   yourself in the admin panel.
5. **Who may register** — everyone with your approval (default) · only with an invite code · everyone.
6. **First server** and an invite link for friends: `https://voice.example.com/?invite=CODE`.
7. **Done** — a voice check from the browser (it catches closed 7881/7882) and links to the apps.

Every step can be skipped and changed later: the lock icon in the left column → **Admin panel** →
«Инстанс» (name, icon, registration), «Почта» (e-mail), «Пользователи» (approve new accounts).
The setup code stops working once the admin account exists — you may delete `SETUP_TOKEN` from `.env`.

**Unattended installs** (scripts, Ansible): export `SUPERADMIN_USERNAME`, `SUPERADMIN_EMAIL` and
`SUPERADMIN_PASSWORD` (min 8 chars) before running `install.sh` — the backend then seeds that admin on
first boot and the wizard is skipped. Super-admin rights are bound to that account's **id**; changing
`SUPERADMIN_USERNAME` in `.env` later does not move them to another account.

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
  S3 storage ([versitygw](https://github.com/versity/versitygw)) and served from
  `media.example.com`. Nothing to set up — the installer does it. versitygw keeps files as
  plain files with their headers in extended attributes, so the Docker data directory must be
  on a filesystem with xattr support (ext4/xfs/btrfs — the default everywhere; not NFS without xattr).
- **Installed before versitygw?** Older boxes kept media in MinIO. The first update copies it
  into the new storage by itself (service `storage-migrate`), checks every file, and keeps the
  old `gusvoice_miniodata` volume untouched. It needs free disk about the size of your media.
  If the move can't finish, the updater says why; chat and voice keep working, and running
  `./update.sh --images-only` after fixing the cause finishes the move. Once pictures and
  attachments open fine, free the space: `docker volume rm gusvoice_miniodata`.
- **Email verification** is optional. With SMTP set (wizard or admin panel → «Почта»), sign-ups get a code
  by e-mail; without it you approve each new account in the admin panel → «Пользователи».

## 7. Maintenance

```bash
docker compose ps                 # service status
docker compose logs -f backend    # backend logs (incl. verification codes if SMTP is off)

# Back up the database:
docker compose exec -T postgres pg_dump -U gusvoice gusvoice > gusvoice-$(date +%F).sql
```

Media lives in the `s3data` volume (`gusvoice_s3data`); back it up alongside the database if
you want a full restore.

### Updating

**From the admin panel.** ⚙ → «Инстанс» shows the installed version and the newest release; «Обновить»
updates the server and the page follows the steps. The backend never touches Docker itself — it leaves a
request that a small systemd watcher on the host picks up and runs `./update.sh`. The installer enables it
when it runs as root or with password-less sudo; otherwise enable it once:

```bash
sudo ./update.sh --install-updater     # needs systemd; log: journalctl -u gusvoice-update
```

**From the console**, in the GusVoice folder: `./update.sh`. It refreshes the stack files, pulls the images,
**saves a copy of the database** into `.gusvoice-backups/db-<time>.sql.gz` (the 5 newest are kept; skip with
`--no-db-backup`) and recreates the containers. Migrations run by themselves when the new backend starts.

The panel can't update a server whose `.env` pins one release (`TAG=v0.7.0`) — pulling that tag again brings the
same version. Use `TAG=latest`, or change the tag by hand and run `./update.sh`.

**If an update goes wrong**, go back to the version you came from together with the database copy made just before
the update. This REPLACES the current database, so stop the backend first — nothing may write in between:

```bash
docker compose stop backend presence
gunzip -c .gusvoice-backups/db-<time>.sql.gz | docker compose exec -T postgres sh -c \
  'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB" && psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB" >/dev/null'
```

Then set `TAG` in `.env` to that version and start it: `./update.sh --images-only --no-db-backup`.

## 8. Federation (linking with another instance)

Federation lets two independent instances see each other: people from a linked instance can be
invited to your servers as guests, keeping their own name, avatar and account at home. It is **off
by default** — an instance that never links stays exactly as it was.

Turn it on in `.env`:

```bash
FEDERATION_ENABLED=true
FEDERATION_KEY_PASSPHRASE=<a long random passphrase>   # encrypts the instance key at rest
FEDERATION_DATA_DIR=/var/lib/gusvoice/federation       # where that key lives (default)
```

On the first start the instance creates its **identity**: a key pair whose fingerprint is what
neighbours recognise you by. ⚙ → «Федерация» shows it.

### 🔴 Back up the key and the passphrase TOGETHER

The key file and `FEDERATION_KEY_PASSPHRASE` are two halves of one thing. Lose either and the
identity is gone — not «reset», gone: every neighbour sees a different instance at your address and
refuses to talk to it (that is the whole point of the check). Recovering means asking each holder to
re-link by hand, sharing a new code and comparing fingerprints out loud.

```bash
# include BOTH in your backup, and keep the passphrase somewhere other than the server
docker compose exec backend tar -c /var/lib/gusvoice/federation > fed-keys-$(date +%F).tar
```

Restoring onto a new machine: put the directory back, set the same passphrase, start. The fingerprint
in ⚙ → «Федерация» must match the one your neighbours have.

### Linking

One side issues a code (⚙ → «Федерация» → «Создать код связки»), the other pastes it. Both sides then
confirm, and the link becomes `active`. Compare fingerprints over a channel that is not the link
itself — a phone call, a chat — that is what makes the link trustworthy.

Both instances need **public HTTPS addresses**: requests to private networks are refused on purpose
(SSRF protection), so two boxes in the same LAN will not link without real domains.

### Alerts

The instance tells you when something breaks: a link stopped answering, the signing key is about to
expire, a neighbour needs a different protocol version, a burst of bad signatures, trust lost, a
complaint about one of your people. Channels are set in ⚙ → «Федерация» → «Оповещения»: e-mail (to
`ADMIN_EMAIL`, or the super-admin's address) and an [ntfy](https://ntfy.sh) topic. Whatever the
channels, the alerts always show as a banner at the top of that tab.

### Guests and disk space

Files uploaded by guests live in **your** storage and count against a per-link quota (2 GB by
default, changed in the link's row). Storage-wise a guest is an ordinary member; the quota exists so
one neighbour cannot fill your disk.

## 9. Troubleshooting

| Symptom | Check |
|---------|-------|
| Site won't load | DNS records resolve to your IP; `docker compose ps`; port 80/443 open |
| Lost the setup code | it's `SETUP_TOKEN` in `.env` (valid until the admin account is created) |
| Voice connects but no sound | 7882/udp + 7881/tcp reachable from outside; `docker compose logs livekit` |
| Screen-share won't start | needs HTTPS (you have it) + the STREAM permission on the channel |
| No verification email | admin panel → «Почта» → send a test e-mail; `docker compose logs backend \| grep -i mailer` |
| Push not waking the phone | ntfy reachable at `ntfy.example.com`; `NTFY_TOKEN` set in `.env` |

---

Secrets live only in `.env` (never commit it). All internal services bind to the docker
network; only Caddy (80/443) and the LiveKit media ports (7881/7882) face the internet.
