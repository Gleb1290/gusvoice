# @gusvoice/bot

Official SDK for the GusVoice Bot API v1. TypeScript, zero dependencies: built-in `fetch`, `WebSocket` and Web Crypto (voice is the optional add-on `@gusvoice/bot-voice`).
Runs on Node.js 22+, Bun and Deno; on Node.js 18–21 use long polling or pass the `ws` package (see below).

## Quick start

```ts
import { Bot } from '@gusvoice/bot';

const bot = new Bot(process.env.GUSVOICE_BOT_TOKEN!, { baseUrl: 'https://voice.example.com' });

bot.command('status', (ctx) => ctx.reply(`args: ${ctx.args.join(' ')}`));
bot.on('message', (ctx) => ctx.reply(`echo: ${ctx.text}`));

await bot.start(); // WebSocket; bot.start({ mode: 'polling' }) for long polling
```

`baseUrl` is your instance address. The SDK reads `<baseUrl>/config.json` to find the API address (`apiUrl`); pass
`discover: false` if `baseUrl` already is the API. Keep the token in an environment variable, never in code.

## API

- `new Bot(token, { baseUrl, discover?, maxRetries? = 3, maxRetryAfter? = 60, timeoutMs? = 30000, fetch?, WebSocket?, log? })`
- Methods (`bot.api.*`): `getMe()`, `getUpdates({ offset, limit, timeout, allowed_updates })`, `setWebhook(url, secret, { drop_pending_updates })`,
  `deleteWebhook()`, `getWebhookInfo()`, `sendMessage(chatId, text, { reply_to_message_id, embeds, files, disable_notification, disable_link_preview })`,
  `editMessageText(chatId, messageId, text, { reply_markup })`, `editMessageReplyMarkup(chatId, messageId, markup?)`,
  `answerCallbackQuery(id, { text, show_alert })`, `setMyCommands(commands, { scope })`, `getMyCommands()`, `deleteMyCommands()`,
  `deleteMessage(chatId, messageId)`, `sendChatAction(chatId)`, `getChat(chatId)`,
  `call(method, params)` for anything else. `files`: `Blob`, `Uint8Array`/`Buffer`, a file path, or `{ data, name, type }`.
- Errors: `GusVoiceApiError { code, description, retryAfter }`. HTTP 429 is retried after `retry_after` (up to `maxRetries`).
- Updates: `bot.on('message' | 'edited_message' | 'message_deleted' | 'my_chat_member' | 'voice_state' …, ctx => …)`.
  `ctx.chat`, `ctx.from`, `ctx.text`, `ctx.payload`, `ctx.reply(text, opts)`, `ctx.replyTo(text)`, `ctx.typing()`.
- Commands: `bot.command('restart', ctx => …)` — `/restart nginx` gives `ctx.args = ['nginx']`, `ctx.argsText`. `/cmd@other_bot` is ignored.
  A message handled by a command does not reach `on('message')`.
- `bot.start({ mode?, timeout?, allowedUpdates?, onStart? })` resolves after `bot.stop()` and rejects on a fatal error:
  401 (token revoked / bot disabled), 403 (bots disabled on the instance), 409 (a webhook is set).
  WebSocket reconnects with a growing pause (1 s → 30 s) and resumes from the last `update_id`.
- `bot.catch((err, ctx) => …)` — handler errors (default: `console.error`); the bot keeps running.
- Buttons: `new InlineKeyboard().text('Status', 'st').row().url('Site', 'https://…')` — pass it as `reply_markup` (limits are
  checked when adding: `callback_data` ≤ 64 bytes, ≤ 8 per row, ≤ 100 total, `url` http(s) only).
  `bot.callbackQuery('st' | /^rs:(.+)$/, ctx => …)` — the first match takes the press (`ctx.match` for a RegExp), otherwise
  `on('callback_query')`. In such a handler `ctx.callbackData`, `ctx.callbackQuery`, `ctx.from`, `ctx.chat`, `ctx.message`
  (the message with the buttons), `ctx.answerCallbackQuery('text' | { text, show_alert })`, `ctx.editMessageText(text, { reply_markup })`
  (🔴 without `reply_markup` the buttons are removed, as in Telegram), `ctx.editMessageReplyMarkup(markup?)`, `ctx.deleteMessage()`.
  A press the handler did not answer is answered empty after it (`autoAnswerCallbackQuery: false` turns that off).
  `callback_data` comes from the person's client: check `ctx.from.id` and re-check values against an allow-list.
- Command menu: `bot.command('status', handler, { description: 'Server state' })` + `await bot.setCommands()` (e.g. in
  `onStart`) publishes commands that have a description.

## Voice (API 4, optional add-on)

The bot can join a voice channel and play audio. The core package stays dependency-free: sound lives in the optional
package `@gusvoice/bot-voice` (native `@livekit/rtc-node` + `ffmpeg`). Without it `bot.voice.join()` throws `VoiceAddonMissing`.

```ts
const vc = await bot.voice.join(channelId); // needs "Connect" and "Speak" in that channel
const track = vc.play('https://example.com/radio.mp3'); // path | http(s) URL | Readable | { pcm: Readable }
vc.on('trackEnd', (t, reason) => console.log(t.title, reason)); // finished | skipped | stopped | error
vc.skip(); vc.pause(); vc.resume(); vc.stop(); vc.volume = 0.5; await vc.leave();
```

- Network methods in the core: `bot.api.joinVoice(chatId, { bitrate? })`, `leaveVoice(chatId?)`, `getVoiceChatMembers(chatId)`;
  event `voice_state` (`chat.type === 'voice'`, `action: 'joined' | 'left'`, `move_to` when a moderator moved the bot).
- The bot **does not hear people**: the server issues the voice token without the right to listen.
- Being removed from the room (disconnected by a moderator, removed from the server, alone for 5 minutes) is normal: the
  SDK does not reconnect, emits `disconnected({ kicked: true })` and keeps the queue; `vc.rejoin()` goes back.
  A moderator moving the bot is followed automatically (`followMoves`, default on). A network drop is retried 6 times.
- Requirements: Node.js 18+, linux x64/arm64 (glibc only; **not Alpine**), macOS or Windows x64, `ffmpeg` in PATH or `FFMPEG_PATH`.
  URLs are fetched by ffmpeg on the bot's machine: validating links that people send is the bot author's job.
- Example: `examples/bots/music.ts`.

## Webhook delivery

```ts
import http from 'node:http';
import { toNodeHandler } from '@gusvoice/bot';

await bot.api.setWebhook('https://bot.example.com/hook', process.env.HOOK_SECRET!);
const handler = bot.webhookHandler({ secret: process.env.HOOK_SECRET! }); // (Request) => Promise<Response>
http.createServer(toNodeHandler(handler)).listen(8080);                   // Bun/Deno: Bun.serve({ fetch: handler })
```

The handler checks `X-GusVoice-Signature` (`t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`) with a 5-minute window
and a constant-time comparison; a bad signature gets 401. `verifyWebhookSignature(secret, header, rawBody)` is exported too.

## Node.js 18–21

There is no global `WebSocket` before Node.js 22. Either use `bot.start({ mode: 'polling' })` or pass the `ws` package:
`new Bot(token, { baseUrl, WebSocket })` with `import WebSocket from 'ws'`.

## Versioning and compatibility

The SDK version (`0.x`, semver, pre-1.0: minor versions may change the API) is independent from the server's Bot API version
(`getMe().api_version`, also in `getMe().features`). The wire format only grows by additions, so an older SDK keeps working
against a newer server; it just does not know the new methods and fields.

| `@gusvoice/bot` | `SDK_API_VERSION` | Server `api_version` it knows | Notes |
|---|---|---|---|
| 0.1.x | 4 | 1 – 4 | buttons and commands (2), servers, reactions, `parse_mode`, webhook batches (3), voice (4) |

- `SDK_API_VERSION` is exported. If the server reports a newer `api_version`, `bot.start()` writes **one** line to the log
  ("server speaks Bot API N, this SDK knows M") and carries on — it is a hint to update, not an error.
- Check abilities by `getMe().features` (e.g. `'voice'`), not by guessing from the version.
- Machine-readable reference: `GET <api>/api/bot/v1/openapi.json` (OpenAPI 3.1) and `GET <api>/api/bot/v1/llms.txt`,
  no token needed; the file is also in the repository: [`docs/bot-api/openapi.json`](../../docs/bot-api/openapi.json).

### Typed from the schema?

The types in `src/wire.ts` are written by hand, to keep the package dependency-free and its `.d.ts` readable. They are checked
against the server's schemas in CI (a type-level guard in the backend fails if a field exists on one side only, and if
`SDK_API_VERSION` differs from the server's version), and the OpenAPI document is generated from the same schemas.
The webhook signature has shared test vectors (`test-vectors/webhook-signature.json`, used by the TypeScript and Python SDKs).

### Types and Node.js

The published `.d.ts` files use Node's `Readable` (voice and file uploads), so TypeScript projects need `@types/node` (any Node project has it).

## Install

`npm i @gusvoice/bot` (voice: also `npm i @gusvoice/bot-voice`). From the repository instead: `cd packages/bot-sdk && corepack pnpm pack` (builds `dist/`) → `npm i ./gusvoice-bot-0.1.0.tgz`.

## License

MIT — see [LICENSE](LICENSE). The GusVoice server itself is AGPL-3.0-only; bots built with this SDK are not affected by it.
