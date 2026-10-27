# @gusvoice/bot-voice

Voice add-on for [`@gusvoice/bot`](../bot-sdk/README.md) (Bot API 4): the bot joins a GusVoice voice channel and plays audio.
Optional: the core package has no dependencies and loads this one on the first `bot.voice.join()`.

```ts
import { Bot } from '@gusvoice/bot';

const bot = new Bot(process.env.GUSVOICE_BOT_TOKEN!, { baseUrl: 'https://voice.example.com' });
const vc = await bot.voice.join(channelId, { normalize: true });
vc.play('https://example.com/track.mp3', { title: 'Track' });
vc.on('idle', () => console.log('queue is empty'));
```

## What it needs

- Node.js 18+. `@livekit/rtc-node` 1.1.0 brings a prebuilt native module for linux x64/arm64 (**glibc only, no Alpine**),
  macOS x64/arm64 and Windows x64. A Docker image for a bot: `node:24-bookworm-slim` + `apt install ffmpeg`.
- `ffmpeg` in `PATH`, or `FFMPEG_PATH`, or `join(id, { ffmpegPath })`. Missing ffmpeg: `FfmpegNotFound` on `join`.
- The bot needs "Connect" and "Speak" in the channel; up to 3 bots per voice channel, one voice channel per server.

## Versioning and compatibility

`@gusvoice/bot-voice` and `@gusvoice/bot` are released together and pinned to each other (exact peer dependency: install the
same `0.x.y` of both). Voice needs the server's Bot API **4** (`getMe().features` contains `'voice'`); an older server answers
`bot.voice.join()` with an error. Newer servers keep working: the wire format only grows by additions.

| `@gusvoice/bot-voice` | needs `@gusvoice/bot` | Server `api_version` | `@livekit/rtc-node` |
|---|---|---|---|
| 0.1.x | 0.1.x | 4+ | 1.1.0 (exact) |

The `@livekit/rtc-node` version is pinned because the native module and the server's LiveKit must agree; it moves together
with the GusVoice server release, not by itself.

## API (`VoiceConnection`)

`play(source, { title?, volume? })` → `Track` (`source`: file path, `http(s)` URL, `Readable` in any ffmpeg format, or `{ pcm }` —
s16le 48 kHz stereo); `skip()`, `stop()` (clears the queue), `pause()`, `resume()`, `volume` (0..2), `queue` (waiting tracks),
`current`, `members`, `rejoin()`, `leave()`. Events: `trackStart`, `trackEnd(track, reason)`, `idle`, `error(err, track)`
(`err.stderr` — last 2 KB of ffmpeg output), `muted`, `unmuted`, `memberJoin`, `memberLeave`, `reconnecting`, `reconnected`,
`disconnected({ kicked, reason })`, `moved(channelId, fromChannelId)`. `track.finished` resolves with the end reason.

Join options: `bitrate` (24000–128000, default 64000), `normalize` (loudnorm to -18 LUFS, default on), `followMoves`
(default on), `ffmpegPath`.

## Behaviour worth knowing

- The bot **cannot hear people**: the server hands out the voice token without the right to subscribe.
- A moderator server-mute pauses playback (`muted`); un-mute resumes it (`unmuted`) — the SDK probes the right to publish
  every few seconds, so it can take up to ~5 s.
- Removed from the room (moderator disconnect, removed from the server, alone for 5 minutes, bots disabled) is normal:
  no reconnect, `disconnected({ kicked: true })`, queue kept. A network drop is retried 6 times (1-2-4-8-16-30 s).
- `bot.stop()` leaves all channels and disposes the native runtime; voice cannot be restarted in the same process.
- ffmpeg is spawned with an argument array (no shell) and a protocol whitelist `file,http,https,tcp,tls,pipe`. It does not
  protect your machine's local network: validate links that people send.
- Copyright of the music is the responsibility of the bot owner.

## License

MIT. `@livekit/rtc-node` is Apache-2.0.
