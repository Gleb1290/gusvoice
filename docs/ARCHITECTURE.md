# GusVoice architecture

GusVoice is a self-hosted voice, screen-share and text chat in the spirit of Discord and TeamSpeak: servers with
categories, text and voice channels, roles and per-channel permissions, direct messages, and media that always goes
through your own server (no peer-to-peer). This document is the map for people who want to read or change the code.
Installing a server is covered in [SELF-HOSTING.md](SELF-HOSTING.md); LiveKit specifics in [livekit.md](livekit.md).

## The pieces

```
                         ┌──────────────── one host, one docker-compose.yml ────────────────┐
  browser / desktop /    │                                                                   │
  Android client ──https─┼─► Caddy (or your reverse proxy)                                   │
                         │      ├─ voice.<domain>    → client    (static SPA, nginx)          │
                         │      ├─ api.<domain>      → backend   (REST + /gateway WebSocket)  │
                         │      ├─ presence.<domain> → presence  (WebSocket)                  │
                         │      ├─ lk.<domain>       → livekit   (signalling)                 │
                         │      ├─ media.<domain>    → storage   (S3, public-read bucket)     │
                         │      └─ ntfy.<domain>     → ntfy      (push gateway)               │
  media  ──udp 7882 / tcp 7881──► livekit (SFU)  ──webhooks──► presence ──► redis             │
                         │  backend ──► postgres, redis, storage, livekit API, SMTP, ntfy     │
                         └───────────────────────────────────────────────────────────────────┘
```

| Service | Code | What it does |
|---|---|---|
| **client** | `apps/client` | React + Vite single-page app, Zustand store, `@livekit/components-react`. The same build is the web app, the desktop app's UI and the Android app's UI. Runtime config comes from `/config.js`, so one image serves any domain |
| **backend** | `packages/backend` | Fastify + Drizzle ORM on PostgreSQL. REST API under `/api`, a WebSocket gateway at `/gateway` for chat events, LiveKit token minting, media uploads to S3, e-mail, push |
| **presence** | `packages/presence` | Receives LiveKit webhooks, reconciles them against LiveKit's participant list, keeps "who is in which voice channel" in Redis and streams it to clients over its own WebSocket |
| **livekit** | image `livekit/livekit-server` (pinned) | The SFU: every participant sends media to the server, which forwards it to the others |
| **storage** | image `versity/versitygw` (pinned) | S3-compatible object storage for avatars, attachments, emoji, stickers and sounds. Any S3 service works instead |
| **postgres**, **redis** | official images | Data and short-lived state (rate limits, presence, caches) |
| **ntfy** | image `binwiederhier/ntfy` | UnifiedPush gateway: wakes the Android app for messages without Google services |
| **caddy** | optional profile `caddy` | TLS with automatic Let's Encrypt; leave it off if you already run a reverse proxy |

Shared code lives in `packages/shared`: the permission bitfield, DTO types, the WebSocket protocol and small pure rules
used on both sides (mentions, emoji, stickers, polls). It is consumed as TypeScript source — there is no build step for
`shared`, `backend` or `presence` (they run with `tsx` in development and are bundled with esbuild in their images).

## Repository layout

```
apps/client            web client (React + Vite)
apps/desktop           Tauri v2 shell: Windows desktop app and the Android app
  src-tauri/src        Rust: tray, overlay window, global push-to-talk, native screen-share and audio (Windows)
  src-tauri/gen/android  Kotlin side of the Android app (background voice, push)
  vendor/webrtc-sys    fork of LiveKit's webrtc-sys with NVIDIA NVENC on Windows (see its NOTICE.md)
packages/backend       API, gateway, migrations (drizzle/*.sql)
packages/presence      voice presence service
packages/shared        types, permissions, protocol, shared rules
config/                Caddyfile, livekit.yaml, storage-migrate.sh
docker-compose.yml     the whole stack; install.sh / update.sh / uninstall.sh manage it
```

## How things flow

**Signing in.** Accounts register with a username (Latin letters, digits, `_ . -`), e-mail and password. With SMTP
configured a 6-digit code confirms the e-mail; the instance owner decides who may register — anyone, anyone after
approval, or only by invite (`instance_settings.registration`). Sessions are JWTs that renew themselves while in use; every
token carries a generation number, so "log out everywhere" and account deletion revoke all outstanding tokens.

**First run.** A fresh server has no administrator. `install.sh` writes a one-time setup code to `.env`; until an
administrator exists, the web app shows a setup wizard that asks for that code and then creates the super-admin,
instance name and icon, e-mail settings, registration policy and a first server. The super-admin is bound by user id,
not by username.

**Text chat.** Messages are created over REST and fanned out to connected clients through the `/gateway` WebSocket,
filtered by what each member may see. Attachments are uploaded to the backend, which stores them in S3 under a
category prefix and returns a public URL; files a browser could execute are stored as downloads.

**Voice and screen-share.** Each voice channel is a LiveKit room named `channel_<id>`. To join, the client asks the
backend for a token; the token's grants follow the member's permissions (speak → microphone; video → camera; share
screen → screen-share). Media goes client → LiveKit → other clients over UDP 7882, or TCP 7881 when UDP is blocked.
The client keeps exactly one `Room` per channel so React re-renders never reconnect. The Windows desktop app can
publish screen-share natively (LiveKit Rust SDK, hardware H.264/H.265 on NVIDIA GPUs) instead of through the browser
engine.

**Presence.** LiveKit reports joins and leaves to the presence service by webhook; presence double-checks against the
room's participant list and publishes the result, so a lost webhook cannot leave a ghost in a channel.

**Push.** For Android, the backend publishes a small payload to the ntfy topic registered by the device; the app shows
the notification itself. Desktop and web receive events over the gateway while open.

## Permissions

Discord-style: a bitfield of BigInt flags (`packages/shared/src/permissions.ts`) — view, send, manage messages, connect, speak,
video, share screen, move/mute/deafen members, manage channels/roles/server, invites, audit log, sounds, emoji,
stickers and more. Roles grant bits; channels and categories can allow or deny bits per role or member (channels may follow their category); `ADMINISTRATOR` grants
everything within a server. The instance super-admin can see and manage every server.

## Data and migrations

PostgreSQL schema is described in `packages/backend/src/db/schema.ts`. Migrations are hand-written SQL files in
`packages/backend/drizzle/`, applied in order when the backend starts and recorded by file name in `_migrations`.
There is no manual migration step when updating.

## Configuration

Everything instance-specific comes from `.env` (documented in [`.env.example`](../.env.example)): database, JWT
secret, LiveKit keys and public URL, S3, SMTP, public URLs for the client. Optional features are switched by
environment flags and are off unless enabled — for example the server currency ("GusCoins") and client diagnostics.
Settings that the instance owner changes at runtime (e-mail, registration policy, instance name) live in the
`instance_settings` table.

## Clients

- **Web** — served by the `client` container; always matches the server version.
- **Desktop (Windows)** — Tauri v2 wrapping the same UI. Release builds from the project's Releases are "picker"
  builds: on first start they ask for the server address and can hold several servers. The UI is bundled inside the
  app, so it updates with the app (built-in updater), not with the server.
- **Android** — the same Tauri project built for Android: background voice service, UnifiedPush notifications.

Because clients update separately from servers — and servers will talk to each other — changes to the API, the
WebSocket protocol and anything another instance sees must stay backward compatible: additions only, unknown fields
ignored. The rules are in [federation-compat.md](federation-compat.md).

## Working on the code

```
corepack enable
pnpm install
pnpm -r run typecheck
pnpm -r run test          # node:test, each test file listed in its package's "test" script
docker compose up -d --build   # needs a .env — see .env.example
```

Pinned versions are deliberate (LiveKit server and client SDK must move together — see [livekit.md](livekit.md) §3).
Each `*.test.ts` sits next to the module it tests and must be listed in its package's `test` script; CI checks that.
