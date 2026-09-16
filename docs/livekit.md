# LiveKit — reference for GusVoice

How GusVoice uses self-hosted **LiveKit** (SFU) for voice, video and screen-share, plus the
config, the deployment, and the troubleshooting playbook — written against what actually runs in
production (server **v1.13.1**, browser SDK `livekit-client` 2.20.0 / `@livekit/components-react`
2.9.21).

> Installing a server: [SELF-HOSTING.md](SELF-HOSTING.md).

## 1. Architecture

LiveKit is an **SFU** (Selective Forwarding Unit): every participant sends their media **to the
server**, and the server forwards it to the others. There is **no P2P** — so our "server-relayed
only, no peer-to-peer" requirement is satisfied by the architecture itself; nothing to disable.

- **Room** — one per voice channel, named `channel_<channelId>`. Created on demand when the first
  participant joins; auto-closed `empty_timeout` (120 s) after the last leaves.
- **Participant** — a connected client (identity = our user id). Has **grants** (see Auth).
- **Track** — an audio/video/screen-share stream a participant publishes. Others **subscribe**.
- Each participant holds **two PeerConnections**: a **publisher** PC (its outgoing tracks) and a
  **subscriber** PC (incoming tracks). Newer clients can collapse these into a single PC
  (`UseSinglePeerConnection`, seen in v1.13.1 logs).
- Media is Opus audio + VP8/VP9/H264/AV1 video; simulcast/dynacast are available but we keep
  `adaptiveStream`/`dynacast` off for simplicity.

## 2. Deployment

Single host, one `docker-compose.yml`. TLS and public hostnames are terminated either by the **bundled
Caddy** (`--profile caddy`, automatic Let's Encrypt) or by **your own reverse proxy** (Nginx Proxy Manager,
nginx, Traefik — possibly on another machine). LiveKit runs in a Docker **bridge** network; media ports
are published straight to the host. Example addresses below: public IP `203.0.113.10`, LAN `192.168.1.10`.

```
                    (TLS terminated by Caddy or your reverse proxy)
  browser ──wss── lk.example.com:443 ──► proxy ──► livekit :7880   (signalling)
  browser ──────── 203.0.113.10:7882/udp ────────► host ─► livekit :7882  (media, UDP mux)
  browser ──────── 203.0.113.10:7881/tcp ────────► host ─► livekit :7881  (media, ICE/TCP)
  livekit ──webhook──► presence :4001  (participant_joined/left, track_*, room_*)
  backend/presence ──http──► livekit :7880  (RoomService API; mints tokens)
```

- Signalling (`:7880`) is proxied as `wss://lk.<domain>`.
- **Media must reach the node directly** — the proxy does NOT carry 7881/7882; they are published on the
  host (`0.0.0.0`). Behind a home router, forward both ports to the host (`192.168.1.10`); on a cloud VM,
  open them in the provider's firewall / security group.
- The public IP is discovered via STUN (`use_external_ip: true`).

## 3. Version compatibility — keep server ↔ client SDK in lockstep ⚠️

**This is the single most important operational rule for LiveKit here.** The browser SDK and the
server speak a versioned signalling protocol. A server that is **too old for the client** breaks
every connection (see §8). Symptoms in the browser console:

```
Initial connection failed: v1 RTC path not found. Consider upgrading your LiveKit server version
GET https://lk.example.com/rtc/v1/validate ... 404 (Not Found)
NegotiationError: negotiation timed out
```

Rules:
- `docker-compose.yml` pins an **exact** server image tag (`livekit/livekit-server:v1.13.1`) — never
  `latest`.
- `apps/client/package.json` pins **exact** SDK versions (`livekit-client`, `@livekit/components-react`,
  `@livekit/components-styles`); `packages/backend` pins `livekit-server-sdk`. No `^` ranges — a caret
  range is exactly how the client silently drifted to 2.20.0 while the server stayed at 1.8.4.
- When bumping either side, bump **both** deliberately and read the changelog for breaking changes
  (config keys removed/renamed, protocol bumps). The `/rtc/v1` path landed in server **v1.9.10**;
  protocol 17 clients need ≥ that.

## 4. `livekit.yaml` config reference

`config/livekit.yaml` is mounted into the container (`:/etc/livekit.yaml:ro`) — it is a **volume
mount, not baked into the image**, so a config change is an edit + `docker compose restart livekit`,
no rebuild. It contains **no secrets** (the API key/secret come from `LIVEKIT_KEYS` env).

| Key | Ours | Meaning |
|---|---|---|
| `port` | `7880` | HTTP API + WS signalling (the reverse proxy serves this as wss). |
| `rtc.tcp_port` | `7881` | ICE/TCP — media fallback when a client's network blocks UDP. |
| `rtc.udp_port` | `7882` | Single-port UDP **mux** for all media (no 50000-60000 range needed). |
| `rtc.port_range_start/end` | (unset) | UDP range; LiveKit defaults to **50000-60000** if `udp_port` is 0 — so you cannot "disable UDP" by zeroing it. |
| `rtc.use_external_ip` | `true` | Discover & advertise the host's public IP via STUN. |
| `rtc.node_ip` | (commented) | Set explicitly if STUN guesses wrong (1:1 NAT). Ignored when `use_external_ip: true`. |
| `rtc.allow_tcp_fallback` | `true` | Let clients fall back to ICE/TCP when UDP won't establish. |
| `rtc.allow_udp_unstable_fallback` | (optional, v1.9+) | Migrate an established-but-lossy UDP session to ICE/TCP instead of dropping. |
| `webhook.api_key` | `gusvoice` | Names one of `LIVEKIT_KEYS`; signs webhooks. The **name** isn't a secret. |
| `webhook.urls` | `http://presence:4001/livekit/webhook` | Presence service consumes these over the docker network (never via the reverse proxy). |
| `room.empty_timeout` | `120` | Close an empty room this many seconds after the last leave. |
| `room.max_participants` | `0` | 0 = unlimited. |
| `redis` | (off) | A single node doesn't need it; add to scale horizontally. |

> **LiveKit cannot advertise both an internal and an external IP at once** (long-standing limitation,
> livekit/livekit #1898). Usually not a problem — clients on the same LAN as the host reach the public
> IP fine if the router supports hairpin NAT, and direct LAN ICE candidates are negotiated anyway (a LAN
> candidate pair shows up as selected in the server logs).

## 5. Ports & firewall

| Port | Proto | Exposure | Purpose |
|---|---|---|---|
| 7880 | TCP | via the reverse proxy (wss) | signalling |
| 7881 | TCP | host + router forward / firewall rule | ICE/TCP media fallback (must NOT sit behind a TLS/L7 proxy) |
| 7882 | UDP | host + router forward / firewall rule | primary media (UDP mux) |

The reverse proxy may proxy **only** signalling. Media (7881/7882) must hit the node directly; ICE
breaks if media is L7-proxied or TLS-terminated.

## 6. NAT / external IP

`use_external_ip: true` makes LiveKit STUN out to learn its public IP and advertise that as its host
candidate (1:1 NAT mapping). Inbound media to `203.0.113.10:7882` is DNAT'd by the router to the
host and (Docker bridge) to the container with the **real client source IP preserved** (verified via
tcpdump). Outbound media leaves as `192.168.1.10:7882` and the router SNATs it back to
`203.0.113.10:7882`. This works for both LAN and remote clients — in the reconnect-loop incident below
**media was never the problem** (see §8). Clients whose own network carries only TCP (many VPNs and
proxies) end up on the 7881/tcp fallback automatically.

## 7. Auth, grants & webhooks

- **Tokens** — the backend mints a LiveKit **JWT** (`livekit-server-sdk`) per join, signed with the
  API secret. The `VideoGrant` gates what the participant may do:
  - `roomJoin: true`, `room: channel_<id>`
  - `canPublish`, `canSubscribe`, `canPublishData`
  - `canPublishSources: [microphone, camera, screen_share, screen_share_audio]` — we gate these by our
    own permission bitfield (SPEAK → microphone; STREAM → camera + screen_share).
- **Server API** — backend/presence call `RoomService` (e.g. `ListParticipants`) over the docker
  network at `http://livekit:7880`.
- **Webhooks** — LiveKit POSTs `participant_joined` / `participant_left` / `track_published` /
  `track_unpublished` / `room_started` / `room_finished` to the **presence** service, signed with
  `webhook.api_key`. Presence reconciles against `ListParticipants` → Redis → its own WS to clients.

## 8. ICE, reconnection & the reconnect-loop saga

**The bug:** an endless **~15 s reconnect loop** — every client (LAN *and* remote) joined, went
`participant active` with `connectionType: udp`, then ~15 s later sent `CLIENT_REQUEST_LEAVE`
(`Reconnect: false`, full reconnect), forever. Voice was unusable.

**Root cause:** a **client/server version mismatch**, NOT a network/NAT/firewall/TURN issue. Server
was **v1.8.4 (protocol 15)**; the client had drifted to **livekit-client 2.20.0 (protocol 17)** via a
caret range. The modern client hits the new `/rtc/v1` signalling path → the old server **404**s it →
the client falls back to `/rtc`, but the subsequent **negotiation times out** → full reconnect →
repeat. Media (UDP) flowed fine the whole time (tcpdump showed RTP both directions).

**Fix:** upgrade the server image to **v1.13.1** + pin both sides (§3). Loop gone instantly; both
participants then held for minutes with zero `participant closing`.

**Debug lesson:** for a uniform reconnect loop, **get the browser console FIRST** — the SDK named the
cause in one line. We spent hours on NAT-hairpin / Docker / IP theories that the console would have
ruled out immediately. Server-side, enable `log_level: debug` to see ICE candidate pairs and consent.

Other reconnect facts worth knowing:
- The SDK distinguishes a **resume** (fast, keeps the session, `Reconnect: true`) from a **full
  reconnect** (`Reconnect: false`, new session, server logs `migration complete`).
- `CLIENT_REQUEST_LEAVE` = the **client** asked to leave (or its SDK did during a full reconnect),
  not a server eviction.
- Chrome drops a PeerConnection to `failed` after ~15 s of failed ICE consent — so a genuine media
  failure also looks like a ~15 s loop. Distinguish with tcpdump (is RTP flowing?) and the console.

## 9. Client SDK notes

- `apps/client/src/components/VoiceConnection.tsx` owns **one** `Room`, created via `useMemo` keyed
  by `channelId` and connected in a `useEffect`, exposed through `RoomContext.Provider`. This is
  deliberate: **recreating the `Room` on every React render causes constant reconnects** — a classic
  pitfall. Re-renders must not tear down the media session.
- `RoomOptions` we set: `disconnectOnPageLeave: false`, `adaptiveStream: false`, `dynacast: false`,
  `audioCaptureDefaults: { autoGainControl, echoCancellation, noiseSuppression }` (free, browser-native
  — no Krisp).
- We only call `leaveVoice()` (drop the UI) on **terminal** disconnect reasons
  (`CLIENT_INITIATED`/`DUPLICATE_IDENTITY`/`SERVER_SHUTDOWN`/`ROOM_DELETED`); transient ones are left
  to the SDK to recover. Disconnect reason is logged as `[voice] disconnected; reason=`.
- Controls: `VoiceControls` (mic/deafen/screenshare via `useLocalParticipant`), `VoiceParticipants`
  (`useIsSpeaking` ring, per-user volume via `RemoteParticipant.setVolume`).

## 10. Troubleshooting checklist

| Symptom | Likely cause | Fix |
|---|---|---|
| Uniform ~15 s reconnect loop for **everyone** | server too old for the client SDK | check console for `/rtc/v1 404`; bump & pin server (§3) |
| `~15 s` loop for **some** clients only | genuine media/ICE failure on their network | tcpdump RTP; `allow_tcp_fallback`; consider TURN |
| Connects then silent, no media | media port not reachable | verify 7881/7882 forwarded; not behind L7/TLS proxy |
| 404 on `/rtc/v1` | version mismatch | upgrade server |
| Signalling won't connect (wss) | proxy / cert / websockets off | check the proxy host has websockets enabled + a valid certificate |
| Idle WS dropped ~90 s | proxy idle timeout | app-level keepalive ping (the client pings gateway/presence every 30 s) |
| Config change not applied | container still runs the old file | edit `config/livekit.yaml` on the server, then `docker compose restart livekit` |

## 11. References

- LiveKit docs: <https://docs.livekit.io/>
- Self-hosting / ports & firewall: <https://docs.livekit.io/home/self-hosting/ports-firewall/>
- Deploying LiveKit: <https://docs.livekit.io/transport/self-hosting/deployment/>
- Server releases: <https://github.com/livekit/livekit/releases>
- Dual internal/external IP limitation: <https://github.com/livekit/livekit/issues/1898>
- JS client SDK: <https://github.com/livekit/client-sdk-js>
