# GusVoice Bot API v1 — reference for AI assistants

> Paste this whole file into a chat with an AI assistant, then add your request (see "Request templates" at the end).
> Everything here is the complete contract of Bot API v1 (`api_version` 4: direct messages, buttons and commands, servers,
> voice). Do not invent methods or fields that are not listed. Human docs: bots.md / bots.ru.md.
> Machine-readable schema: `GET $GV_API/api/bot/v1/openapi.json` (OpenAPI 3.1). This file: `GET $GV_API/api/bot/v1/llms.txt`.

## 0. What a bot is

A GusVoice bot is an account run by a program. A person opens a 1:1 direct conversation ("dm") with the bot; the bot
receives that person's messages as **updates** and replies with `sendMessage`. Also available: a command menu on `/`
(`setMyCommands`), inline buttons under messages (`reply_markup.inline_keyboard` → `callback_query`), bots on servers
(text channels, reactions, moderation — §8a, `features` contains `servers`) and playing audio in voice channels (§8b,
`features` contains `voice`). A command still arrives as a plain text message such as `/status`.
Bots cannot start a DM: they can only reply in a conversation a person opened. A new bot is private (only its
owner can message it) until the owner enables "Available to everyone"; this is checked on every send (a non-owner gets 403
and the bot gets no update).

The base URL is the instance API address, written below as `$GV_API` (for example `https://chat.example.com`).
Never hardcode a real address or token in code — read them from environment variables.

## 1. Calling convention

```
GET|POST $GV_API/api/bot/v1/<method>
Authorization: Bot <token>          # exactly this scheme; "Bearer" is rejected
```

- Token format: `gvb_` + 43 chars of `[A-Za-z0-9_-]`. Shown once when the bot is created or the token reissued.
- Method names are case-insensitive. Both GET and POST work for every method.
- Params: JSON body, `application/x-www-form-urlencoded`, `multipart/form-data`, or query string; body wins over query.
  From form/query, numbers and booleans may be strings (`limit=50`, `true`/`1`), arrays/objects are JSON strings.
- Ids (`chat_id`, `message_id`, `from.id`, `update_id` excluded) are STRINGS (UUIDs). A number where a string is expected → 400.
- Time = Unix seconds (integer). Fields are snake_case. Unknown request params are ignored.
- JSON/form body ≤ 64 KB. Files only via multipart and only on `sendMessage`.

Success: HTTP 200 `{"ok":true,"result":<value>}`.
Error: HTTP status = `error_code`: `{"ok":false,"error_code":N,"description":"…","retry_after":S?}`.
`retry_after` (integer seconds) + `Retry-After` header only on 429. Branch on `error_code`, never on `description` text.

| code | meaning |
|---|---|
| 400 | bad/missing param (description names it), chat not found / not yours, message not found, empty message, bad reply target, bad webhook URL, files in wrong place, body > 64 KB |
| 401 | no/invalid token, wrong scheme, token reissued, bot disabled by admin |
| 403 | bots disabled on the instance; user blocked the bot; user deleted |
| 404 | unknown method |
| 409 | getUpdates while a webhook URL is set; a waiting getUpdates replaced by another consumer (`Conflict: terminated by other getUpdates request; make sure that only one bot instance is running`) — fatal, do not retry |
| 415 | forbidden file type (SVG/HTML) |
| 429 | rate limit — wait `retry_after` seconds, retry |
| 500 / 503 | server error / file storage not ready |

## 2. Reference: objects, methods, events

Generated from the server code (the same schemas the server validates with). The full machine-readable schema is
`GET $GV_API/api/bot/v1/openapi.json` (OpenAPI 3.1).

<!-- gen:bot-reference begin -->

<!-- Generated from the server code by `node scripts/gen-bot-api.mjs` — do not edit by hand. -->

Notation: `name?` optional · `str ≤4096` / `int 1–100` limits (string limits are characters) · `T|null` may be null ·
`T[]` array. Answers may gain fields: ignore unknown ones.

```
Attachment { url: str, file_name: str, mime_type: str, file_size: num }
BotCommand { command: str /^[a-z0-9_]{1,32}$/, description: str 1–256 }
BotCommandScope { type: str ≤32 }
BotUser { id: str, username: str, display_name: str, bot: bool, instance_domain?: str, description: str, about: str, public: bool, api_version?: num, features?: str[], dropped_update_count?: num }
CallbackQuery { id: str, from: User, message: Message, data: str, date: num }
Chat { id: str, type: "dm"|"channel"|"server"|"voice", server_id?: str, title?: str }
ChatFullInfo { id: str, type: "dm"|"channel"|"server"|"voice", server_id?: str, title?: str, user?: User, member_count?: num }
ChatMember { user: User, status: "creator"|"member"|"left"|"kicked", nickname?: str, role_ids: str[], joined_date?: num }
ChatMemberUpdated { chat: Chat, from: User, date: num, old_status: "creator"|"member"|"left"|"kicked", new_status: "creator"|"member"|"left"|"kicked" }
ChatMembersPage { members: ChatMember[], next_offset?: str }
Error { ok: false, error_code: num, description: str, retry_after?: num }
InlineKeyboardButton { text: str 1–64, callback_data?: str ≥1, url?: str ≤2048 }
InlineKeyboardMarkup { inline_keyboard: (InlineKeyboardButton[] (1–8 items))[] (≥1 items) }
InputEmbed { title?: str ≤256|null, description?: str ≤4096|null, url?: str ≤2048|null, color?: int|null, timestamp?: str ≤64|null, fields?: { name: str ≤256, value: str ≤1024, inline?: any }[] (≤25 items)|null, author?: { name: str ≤256, url?: str ≤2048|null, icon_url?: str ≤2048|null }|null, footer?: { text: str ≤2048, icon_url?: str ≤2048|null }|null, image?: { url: str ≤2048 }|null, thumbnail?: { url: str ≤2048 }|null }
Message { message_id: str, chat: Chat, from: User, date: num, edit_date?: num, text: str, reply_to_message_id?: str, attachments?: Attachment[], embeds?: MessageEmbed[], reply_markup?: InlineKeyboardMarkup }
MessageDeleted { message_id: str, chat: Chat, date: num }
MessageEmbed { title?: str, url?: str, description?: str, color?: num, timestamp?: str, author?: { name: str, url?: str, iconUrl?: str }, footer?: { text: str, iconUrl?: str }, fields?: { name: str, value: str, inline?: bool }[], image?: { url: str }, thumbnail?: { url: str }, imageLink?: str, thumbnailLink?: str }
MessageReactionUpdated { chat: Chat, message_id: str, user: User, date: num, old_reaction: ReactionType[], new_reaction: ReactionType[] }
ReactionType { type: "emoji", emoji: str 1–32 }
ServerBrief { id: str, title: str }
ServerInfo { id: str, title: str, channels: { id: str, title: str, type: "text"|"voice", can_send: bool }[], roles: { id: str, name: str, position: num, managed: bool }[] }
ServerMemberUpdated { chat: Chat, from: User, user: User, date: num, old_status: "creator"|"member"|"left"|"kicked", new_status: "creator"|"member"|"left"|"kicked" }
Update { update_id: num, message?: Message, edited_message?: Message, message_deleted?: MessageDeleted, my_chat_member?: ChatMemberUpdated, callback_query?: CallbackQuery, message_reaction?: MessageReactionUpdated, chat_member?: ServerMemberUpdated, voice_state?: VoiceStateUpdated }
User { id: str, username: str, display_name: str, bot: bool, instance_domain?: str }
VoiceChatMember { user: User, muted: bool, deafened: bool, server_muted: bool, is_bot: bool }
VoiceJoinResult { url: str, token: str, room: str, chat: Chat, server_muted: bool, expires_in: num, audio: { sample_rate: num, channels: num, bitrate: num } }
VoiceStateUpdated { chat: Chat, user: User, action: "joined"|"left", date: num, move_to?: Chat }
WebhookInfo { url: str, pending_update_count: num, failures: num, last_error_date?: num, last_error_message?: str, disabled_date?: num, batch?: bool, dropped_update_count?: num }
```

Methods — `POST /api/bot/v1/<method>` → `{ "ok": true, "result": <after →> }`; `[N]` = since `api_version` N:

```
getMe() → BotUser [1]  // Who am I. Handy to check that the token works.
getUpdates(offset?: int, limit?: int 1–100, timeout?: int 0–50, allowed_updates?: (str ≤64)[] (≤64 items)) → Update[] [1]  // Fetch new events (long polling).
setWebhook(url: str 1–2048, secret_token: str /^[A-Za-z0-9_-]{16,256}$/, drop_pending_updates?: bool, batch?: bool) → true [1]  // Turn on event delivery to a URL (see Delivery to a URL).
deleteWebhook(drop_pending_updates?: bool) → true [1]  // Turn delivery to a URL off; returns the bot to `getUpdates`/WebSocket.
getWebhookInfo() → WebhookInfo [1]  // Delivery-to-URL state.
sendMessage(chat_id: str 1–64, text?: str ≤4096, reply_to_message_id?: str 1–64, embeds?: InputEmbed[] (≤10 items)|null, disable_notification?: bool, disable_link_preview?: bool, reply_markup?: InlineKeyboardMarkup, client_id?: str 1–64, parse_mode?: str ≤16, files[0]?: file (multipart only)) → Message [1]  // Send a message.
editMessageText(chat_id: str 1–64, message_id: str 1–64, text: str ≤4096, reply_markup?: InlineKeyboardMarkup, parse_mode?: str ≤16) → Message [1]  // Change the text of the bot's own message.
deleteMessage(chat_id: str 1–64, message_id: str 1–64) → true [1]  // Delete a message.
sendChatAction(chat_id: str 1–64, action: "typing") → true [1]  // Show "typing…" to the other side. Call it before a long operation.
getChat(chat_id: str 1–64) → ChatFullInfo [1]  // Details of a conversation, channel or server.
editMessageReplyMarkup(chat_id: str 1–64, message_id: str 1–64, reply_markup?: InlineKeyboardMarkup) → Message [2]  // Change only the buttons of the bot's own message.
answerCallbackQuery(callback_query_id: str 1–64, text?: str ≤200, show_alert?: bool) → true [2]  // Answer a button press.
setMyCommands(commands: BotCommand[] (≤100 items), scope?: BotCommandScope) → true [2]  // Set the command hint list.
getMyCommands(scope?: BotCommandScope) → BotCommand[] [2]  // The current command list.
deleteMyCommands(scope?: BotCommandScope) → true [2]  // Remove the command list (the same as `setMyCommands` with `[]`).
setMessageReaction(chat_id: str 1–64, message_id: str 1–64, reaction?: ReactionType[] (≤3 items)) → true [3]  // Set the bot's reactions to a message (in DMs too); the set is replaced, `[]` — remove.
pinChatMessage(chat_id: str 1–64, message_id: str 1–64, disable_notification?: bool) → true [3]  // Pin a message in a channel (needs "Manage messages").
unpinChatMessage(chat_id: str 1–64, message_id: str 1–64) → true [3]  // Unpin a message in a channel (needs "Manage messages").
getChatHistory(chat_id: str 1–64, before_message_id?: str 1–64, limit?: int 1–100) → Message[] [3]  // Earlier messages of a channel: the latest page before `before_message_id` (or the newest), oldest first; polls and stickers are skipped. Only for "Read all messages" bots with "Read history" in the channel.
getChatMember(chat_id: str 1–64, user_id: str 1–64) → ChatMember [3]  // One server member.
getChatMemberCount(chat_id: str 1–64) → int ≥0 [3]  // How many members a server has.
getChatMembers(chat_id: str 1–64, offset?: str ≤128, limit?: int 1–200) → ChatMembersPage [3]  // Server members page by page.
getMyServers() → ServerBrief[] [3]  // Servers the bot is on.
getServer(server_id: str 1–64) → ServerInfo [3]  // A server: the channels the bot can see (with `can_send`) and roles (with `managed`).
addChatMemberRole(chat_id: str 1–64, user_id: str 1–64, role_id: str 1–64) → true [3]  // Give a role to a member (needs "Manage roles"; the role must be below the bot's).
removeChatMemberRole(chat_id: str 1–64, user_id: str 1–64, role_id: str 1–64) → true [3]  // Take a role from a member (needs "Manage roles"; the role must be below the bot's).
banChatMember(chat_id: str 1–64, user_id: str 1–64, reason?: str ≤512) → true [3]  // Ban a member (needs the matching permission; the target must be below the bot).
unbanChatMember(chat_id: str 1–64, user_id: str 1–64) → true [3]  // Lift a ban (needs the matching permission).
kickChatMember(chat_id: str 1–64, user_id: str 1–64) → true [3]  // Kick a member from the server (needs the matching permission; the target must be below the bot).
leaveChat(chat_id: str 1–64) → true [3]  // The bot leaves a server; its role goes with it.
joinVoice(chat_id: str 1–64, bitrate?: int 24000–128000) → VoiceJoinResult [4]  // Join a voice channel to play audio (see Voice). The bot never hears people.
leaveVoice(chat_id?: str 1–64) → true [4]  // Leave a voice channel, or all of them. Idempotent: always `true`.
getVoiceChatMembers(chat_id: str 1–64) → VoiceChatMember[] [4]  // Who is in a voice channel now.
```

Events — `Update { update_id: int, <exactly one of:> }`:

```
message: Message [1]  // a person wrote to the bot in a DM, or a message the bot may see arrived in a channel (see Bots on servers)
edited_message: Message [1]  // such a message was edited (in channels filtered by the new text)
message_deleted: MessageDeleted [1]  // a message disappeared for the bot (deleted for both in a DM; in channels — to "read all" bots and the author)
my_chat_member: ChatMemberUpdated [1]  // in a DM: a person opened the conversation (`new_status: "member"`; also when they press "Message" again after deleting the chat), deleted it on their side (`"left"`), blocked the bot (`"kicked"`) or unblocked it; on a server (`chat.type: "server"`): the bot was added, removed or banned
callback_query: CallbackQuery [2]  // a person pressed a button with `callback_data` under the bot's message. Not delivered if older than 25 seconds
message_reaction: MessageReactionUpdated [3]  // a person changed reactions (to read-all bots and the message author; in DMs — to any message of the chat)
chat_member: ServerMemberUpdated [3]  // someone joined, left, was kicked, banned or unbanned on a server the bot is on
voice_state: VoiceStateUpdated [4]  // someone joined or left a voice channel the bot can see (including the bot itself — so it learns it was disconnected)
```

<!-- gen:bot-reference end -->

## 3. Method rules (read before using a method)

- `getMe` — call on startup to validate the token; branch on `features` (not on `api_version`) before using servers/voice.
- `getUpdates` — `offset` acknowledges every update with `update_id` < offset (they are deleted); unset or ≤0 → all
  unacknowledged. `timeout` > 0 waits for the first update. Unacknowledged updates come again; deduplicate by `update_id`
  (delivery is at-least-once on every path). 409 if a webhook URL is set. ONE consumer per token: a new getUpdates or
  WebSocket replaces the previous one (the waiting getUpdates gets 409 `terminated by other getUpdates request`, an open
  WebSocket closes with 4009) — fatal, do not retry. Token reissue / bot disabled end a waiting getUpdates with 401/403.
  Unknown `allowed_updates` kinds are ignored, not 400.
- `sendMessage` — at least one of text / embeds / file (buttons alone are not a message). `client_id` is an idempotency
  key: a retry with the same `client_id` returns the same message; reused with other content/chat → 400 (ignored in
  channels). Files only via multipart `files[0]`…`files[9]` (≤10 files, ≤25 MB each; SVG/HTML → 415). From a form,
  `reply_markup` and `embeds` are JSON strings. Errors: 400 chat not found / empty / reply target missing, 403 blocked or no
  right to post, 415, 429, 503. Example: `curl -F chat_id=ID -F text=Report -F "files[0]=@report.pdf;type=application/pdf" …`
- `editMessageText` — only the bot's own messages. **Without `reply_markup` the buttons are REMOVED (like Telegram)** — pass
  them again to keep them. `editMessageReplyMarkup` changes only the buttons (no "(edited)"); the same buttons again → OK.
- `answerCallbackQuery` — answer every `callback_query` ONCE within 15 s (even with no text — it stops the spinner); a press
  lives 25 s, after that it is neither answerable nor delivered; later / second / foreign id → 400
  `query is too old and response timeout expired or query id is invalid`. No `url`/`cache_time`.
- `setMyCommands` replaces the whole list (`[]` = clear, duplicate name → 400). `scope.type`: `default`,
  `all_private_chats` (DMs), `all_group_chats` (servers); others → 400. The chosen command still arrives as a normal
  `message` "/status …".
- `deleteMessage` — in a 1:1 chat deletes the bot's and the person's messages, for both. Idempotent.
- `getChat` — DM → `user` (the other participant); server → `member_count`.
- `setWebhook` — **secret_token is REQUIRED** (16–256 chars of `A-Za-z0-9_-`). After it getUpdates → 409 and WebSocket
  closes with 4009. Internal/private/metadata addresses are refused with 400 unless the instance admin allowed internal
  (local-network) addresses (`http://` also only then). Loopback (127.0.0.0/8, ::1 — the server itself) is refused ALWAYS:
  a bot on the server machine must use polling or WebSocket. Redirects are never followed. `batch: true` → the POST body is
  an array of up to 100 updates (see §7).
- `getWebhookInfo` — `disabled_date` set = server switched delivery off after 10 consecutive failures; fix the receiver and
  call setWebhook again.
- Server methods (§8a) take a server id or one of its channels as `chat_id`; message methods take a DM or text channel id
  (a server id → `400 chat is a server; use a channel id`).

## 4. Embeds (cards) for sendMessage

`embeds` is an array of `InputEmbed` (Discord-like, field limits in §2), the same format as GusVoice incoming webhooks.
Total text of all embeds ≤ 6000 chars. `color` is an integer 0–16777215 (e.g. 3066993 green, 15158332 red), NOT a "#hex"
string (→ 400). `url` and links are http(s) only. `image`/`thumbnail`: only images from the instance's own storage are
displayed, other https URLs are shown as a plain link; `attachment://<file name>` works only in server channels.

## 5. Updates and events

- `message` — the person wrote to the bot. `edited_message` — the person edited a message. `message_deleted` — a message
  vanished for the bot. `my_chat_member` — the person opened the conversation (`new_status:"member"`, the first event of a
  chat), deleted it on their side (`"left"`), blocked the bot (`"kicked"`) or unblocked it (`"kicked"`→`"member"`).
- `callback_query` — the person pressed a `callback_data` button under the bot's message. Only buttons currently under the
  message are accepted by the server (old/forged `data` never reaches you). **A `callback_query` older than 25 s is not
  delivered** (so a bot that was down does not execute stale presses). Answer with `answerCallbackQuery` within 15 s.
- The bot never receives updates about its own actions (send/edit/delete through the API).
- Journal: kept 24 h, max 1000 per bot (10 000 for a "Read all messages" bot; dropped ones are counted in
  `dropped_update_count`), acknowledged ones deleted.
- Servers and voice add `message_reaction`, `chat_member`, `voice_state` and `my_chat_member` with `chat.type === 'server'` (§8a, §8b).
- "Read" ✓✓ appears for the person when the bot TAKES the update (getUpdates returned it / ack / webhook 2xx), not when it replies.

## 6. WebSocket (alternative to polling)

`GET $GV_API/api/bot/v1/ws?offset=N` (use `wss://`), header `Authorization: Bot <token>` (browser WebSocket can't — use Node
`ws` / Python `websockets`).
Server → `{"op":"hello","bot":Bot}`, then `{"op":"update","update":Update}` in order. Client → `{"op":"ack","offset":N}`
(acknowledge all `update_id` < N), `{"op":"ping"}` (→ `{"op":"pong"}`). Server pings every 30 s (libraries auto-pong).
Updates are NOT auto-acknowledged: send `ack` after handling (or pass `?offset` on reconnect). All update kinds are sent
(no `allowed_updates`). ONE consumer per bot: a new socket or getUpdates replaces the old socket (4009).
Close codes: 4001 bad/reissued token or bot disabled · 4003 bots disabled on instance · 4009 webhook URL set or replaced by
another connection of this bot (reason `terminated by other connection`) · 4029 too frequent. Do not reconnect-loop on
4001/4003/4009 (on 4009 "terminated" — another copy of the bot runs: stop); reconnect with a pause otherwise.

## 7. Webhook delivery (server POSTs updates to your https URL)

Set with `setWebhook`. For every update GusVoice sends:

```
POST <url>
Content-Type: application/json
User-Agent: GusVoice-Bot-Webhook/1
X-GusVoice-Signature: t=<unix>,v1=<hex>
<body: one Update JSON, or an array of up to 100 Updates with setWebhook batch=true>
```

- One update (or one batch) per request, strictly in order; the next only after a 2xx for the previous. A batch is signed
  and confirmed as a whole.
- 2xx = taken (update deleted, body ignored). Anything else / error / no answer within 10 s = failure; redirects not followed.
- Retry pauses: 5 s, 10, 20, 40 … max 10 min. 10 consecutive failures → delivery switched off (`disabled_date`), updates keep
  piling up 24 h; a new `setWebhook` re-enables. Success resets the counter.
- Signature: `v1 = hex(HMAC_SHA256(key = secret_token, msg = t + "." + RAW_BODY_BYTES))`.
  ALWAYS verify: constant-time compare AND `abs(now - t) <= 300`. Hash the raw bytes (not re-serialized JSON). Reject with 401.
  Without verification anyone can forge "owner" commands, so never skip it.
- Receiver must be reachable over public https (or the admin must allow internal addresses; never localhost/loopback).

Python verify:

```python
import hashlib, hmac, time
def verify(secret: str, header: str, body: bytes, tolerance: int = 300) -> bool:
    try:
        parts = dict(p.split("=", 1) for p in header.split(","))
        t, sig = int(parts["t"]), parts["v1"]
    except (KeyError, ValueError):
        return False
    if abs(time.time() - t) > tolerance:
        return False
    mac = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, sig)
```

Node verify:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret, header, rawBody, tolerance = 300) {
  const p = Object.fromEntries((header ?? '').split(',').map((kv) => kv.split('=')));
  const t = Number(p.t);
  if (!Number.isInteger(t) || !p.v1 || Math.abs(Date.now() / 1000 - t) > tolerance) return false;
  const mac = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  const got = Buffer.from(p.v1, 'hex');
  return got.length === mac.length && timingSafeEqual(got, mac);
}
```

## 8. Limits

| what | limit |
|---|---|
| requests per IP | 600 / min (before token check) |
| requests per bot | 30 / s |
| send+edit per conversation | 5 per 5 s |
| getUpdates + WS connects | 30 per 10 s per bot |
| WS per bot | 3 |
| body JSON/form | 64 KB |
| files per message / size | 10 / 25 MB |
| text | 4096 chars |
| embeds | 10 per message, 6000 chars total text |
| update journal | 24 h, 1000 per bot (10 000 for "Read all messages") |
| per channel / per server | 5 messages per 5 s / 30 per min; getChatHistory, getChatMembers — 10 per 10 s |
| voice | 6 joins / min, 3 bots per channel, 10 channels per bot; getVoiceChatMembers 30 / min per server |
| getUpdates timeout / limit | 50 s / 100 |
| buttons | 8 per row, 100 per message; callback_data ≤64 bytes; button text ≤64 chars |
| button presses | person 10 per 5 s, 3 waiting; bot 60 per 10 s, 20 unanswered |
| answer to a press | once, within 15 s; text ≤200 chars |
| commands | 100; name 1–32 `a-z0-9_`, description 1–256 |

## 8a. Bots on servers (API 3, `features` contains `servers`)
- `chat.type` is `dm` | `channel` | `server` | `voice` (API 4); ALWAYS branch on it. Channel and voice chats carry `server_id` and `title`.
- Without "Read all messages" a channel bot only gets commands (`/cmd`, `/cmd@this_bot`), `@this_bot` mentions, mentions of its role and replies to its messages. Never rely on seeing ordinary chatter.
- Other bots' messages never arrive. Guests from other instances carry `from.instance_domain`; authorize by `from.id` and roles (`getChatMember(server_id, user_id).role_ids` / `status === 'creator'`), never by username.
- New updates: `message_reaction` (`old_reaction`/`new_reaction`), `chat_member` (`from` = actor, `user` = subject), `my_chat_member` with `chat.type === 'server'`. Statuses: `creator|member|left|kicked`.
- Server methods are listed in §2 (`[3]`). Server-scoped methods take the server id (or one of its channels) as `chat_id`; `getChatHistory` — read-all bots only.
- `setMyCommands(..., scope={type:'all_group_chats'})` for servers. `parse_mode: 'HTML'` is supported (Telegram subset); `MarkdownV2` is not.
- Limits: 5 msgs / 5 s per channel, 30 / min per server. Handle 429 with `retry_after`.

## 8b. Voice (API 4, `features` contains `voice`)
- A bot can PLAY audio in a voice channel; it can NEVER hear people (server-side `canSubscribe: false`). Do not promise recording, transcription or "listening" features.
- `joinVoice(chat_id, bitrate?)` → `VoiceJoinResult` (§2). Use the SDK add-on `@gusvoice/bot-voice` (`bot.voice.join(channelId)` → `vc.play(urlOrPath)`) instead of raw LiveKit; it needs ffmpeg and glibc Linux, macOS or Windows x64.
- One voice channel per server (joining another moves the bot), up to 10 channels per bot, 3 bots per channel, 6 joins / min. Needs "View channel" + "Connect" + "Speak". Errors: `403 voice is disabled for bots on this server`, `400 chat is not a voice channel`, `403 not enough rights to connect|speak in the voice chat`, `400 too many bots in the voice chat`, `400 too many active voice chats`.
- `leaveVoice(chat_id?)` (no `chat_id` = all, always `true`). To find the author's channel: `getServer` → for each voice channel `getVoiceChatMembers`.
- Update `voice_state`: `{chat (type 'voice'), user, action: 'joined'|'left', date, move_to?}` — to every bot of the server that sees the channel, also about itself. `move_to` = a moderator moved the bot.
- The server drops the bot when it is alone in the channel for 5 minutes, disabled, removed from the server, or lost Connect/Speak. Never auto-rejoin in a loop after a removal; rejoin on a person's `voice_state joined` if needed.
- Only play audio the user has rights to; validate URLs from chat (ffmpeg fetches them on the bot's machine).

## 9. Rules for generating a bot (follow ALL of them)

1. **Token and addresses come from environment variables** (`GV_API`, `GV_BOT_TOKEN`, and for owner checks `GV_OWNER_ID`,
   for webhooks `GV_HOOK_SECRET`). Never print the token, never put it in code, logs, or git. Fail fast with a clear message if
   a variable is missing.
2. **Check `from.id` on every message** against an allow-list from the environment (`GV_OWNER_ID`, optionally a
   comma-separated `GV_ALLOWED_IDS`). Ignore everyone else silently. Compare ids, never usernames. This is mandatory for any bot
   that does something on a machine (restart, run, deploy).
3. **Never pass message text to a shell.** Commands map to a fixed allow-list (dict of name → fixed argv list). Use
   `subprocess.run([...], shell=False)` / `execFile` with a timeout. Arguments from the user must be validated against a
   whitelist (e.g. `/restart nginx` only if `nginx` is in the list).
4. **Polling loop:** `offset = last_update_id + 1`, `timeout=30`, wrap in try/except, on network error sleep 5 s and continue;
   one process per token.
5. **Handle 429:** sleep `retry_after` seconds, then retry the same call. Don't spam; queue notifications.
6. **Reply with `chat.id` from the update** (a string). Never invent chat ids. The bot cannot message first: for scripts / cron
   notifications get the `chat_id` once (the person writes `/start` to the bot, take `message.chat.id` from getUpdates) and
   keep it in an env variable (`GV_CHAT_ID`).
7. Send `sendChatAction` (`typing`) before slow commands; split texts over 4096 chars; use `disable_notification` for noisy
   output.
8. Ignore unknown update kinds and unknown fields. Handle only `message` (and others if needed); always still advance `offset`.
9. Webhook receivers: verify the signature on the RAW body first, answer 200 fast (do work after answering or in a queue),
   answer 401 on a bad signature.
10. Provide: complete runnable code, dependency list with pinned versions, `.env.example` (placeholders only), a systemd unit
    or Dockerfile/compose, and a 3-step "how to run" text. Use `requests` for Python or built-in `fetch` (Node 18+). No
    invented SDK imports.
11. Use `https://chat.example.com` only as an obvious placeholder in comments; real values come from env.
12. **Buttons:** check `from.id` on EVERY `callback_query` too (the press comes from the person's client); re-validate any
    value parsed from `data` (service names, ids) against the allow-list; never put secrets in `callback_data` (≤64 bytes —
    use short codes like `rs:nginx`). Answer every `callback_query` with `answerCallbackQuery` (once, ≤15 s). A destructive
    action goes through a confirmation step (`[Yes] [No]` buttons). When editing a panel with `editMessageText`, pass
    `reply_markup` again or the buttons disappear. Keep text commands working too (old clients do not show buttons).
13. **Commands:** publish the menu once on start with `setMyCommands` (only commands the bot really handles).

## 10. Minimal complete bot (Python, polling, owner only)

```python
import os, time, requests

API = os.environ["GV_API"].rstrip("/") + "/api/bot/v1"
S = requests.Session()
S.headers["Authorization"] = "Bot " + os.environ["GV_BOT_TOKEN"]
ALLOWED = {x.strip() for x in os.environ["GV_OWNER_ID"].split(",") if x.strip()}


def call(method, **params):
    while True:
        data = S.post(f"{API}/{method}", json=params, timeout=70).json()
        if data.get("ok"):
            return data["result"]
        if data["error_code"] == 429:
            time.sleep(data.get("retry_after", 1))
            continue
        raise RuntimeError(f'{data["error_code"]} {data["description"]}')


def on_message(m):
    if m["from"]["id"] not in ALLOWED:
        return
    if m.get("text") == "/ping":
        call("sendMessage", chat_id=m["chat"]["id"], text="pong")


offset = 0
call("getMe")
while True:
    try:
        for u in call("getUpdates", offset=offset, timeout=30):
            offset = u["update_id"] + 1
            if "message" in u:
                on_message(u["message"])
    except (requests.RequestException, RuntimeError) as e:
        print("error:", e)
        time.sleep(5)
```

Minimal notifier (shell, from cron): `curl -sS --fail-with-body "$GV_API/api/bot/v1/sendMessage" -H "Authorization: Bot $GV_BOT_TOKEN" -d chat_id="$GV_CHAT_ID" --data-urlencode "text=$MSG"`

## 11. Request templates for the user (Russian; copy, edit the bold parts)

Paste this file first, then ONE of the requests below. Answer the assistant's questions (language, where it runs).

**Шаблон 1 — бот-панель VPS («/status, /restart, только для меня»)**

> Напиши бота для GusVoice по приложенной документации. Язык: Python. Бот работает на моём VPS (Ubuntu, systemd) и
> отвечает ТОЛЬКО мне (мой id берётся из переменной окружения GV_OWNER_ID, остальных игнорирует).
> Команды: `/status` — аптайм, загрузка CPU, память, диск `/`, топ-3 процесса по памяти; `/restart <имя>` — перезапуск
> службы через `systemctl restart`, но только из белого списка: **nginx, postgresql, docker** (любое другое имя — отказ);
> `/help` — список команд. Перед долгой командой отправляй «печатает». Токен и адрес — из окружения (GV_BOT_TOKEN, GV_API).
> Плюс `/panel` — то же кнопками под сообщением: «Статус» и «Перезапустить…» → кнопка на каждую службу из списка → «Да / Нет»;
> на каждое нажатие проверяй мой id и отвечай `answerCallbackQuery`, имя службы из `callback_data` сверяй со списком ещё раз.
> При старте опубликуй команды через `setMyCommands`.
> Никакого shell=True. Дай полный код, requirements.txt с точными версиями, файл `.env.example`, systemd-юнит и
> пошаговую инструкцию запуска.

**Шаблон 2 — бот-уведомлялка из cron / скрипта**

> Напиши по приложенной документации GusVoice небольшой скрипт-уведомлялку на **bash + curl** (или Python, если
> удобнее): `notify.sh "текст"` отправляет сообщение боту-собеседнику в мой личный чат. chat_id и токен берутся из
> переменных окружения (GV_CHAT_ID, GV_BOT_TOKEN, GV_API). Объясни, как один раз получить chat_id (я напишу боту
> /start, ты покажешь команду getUpdates). Сделай пример для cron: каждое утро в 08:00 присылать свободное место на диске
> `/` и, если занято больше **85%**, помечать сообщение красной карточкой (embeds). Обработай ошибки (429 — подождать
> retry_after, повторить; другие коды — написать в stderr и выйти с ненулевым кодом).

**Шаблон 3 — бот-напоминалка**

> Напиши по приложенной документации GusVoice бота-напоминалку на **Python** для личного пользования (отвечает только мне,
> мой id в GV_OWNER_ID). Команды: `/remind 10m выпить воды`, `/remind 2h30m созвон`, `/remind 2026-12-31 18:00 ёлка`,
> `/list` — мои напоминания, `/cancel <номер>`. Напоминания хранятся в файле JSON, чтобы переживать перезапуск (путь из
> окружения), время — в часовом поясе **Europe/Moscow**. Когда время пришло — бот пишет мне. Токен — из окружения.
> Дай полный код, точные версии зависимостей, `.env.example`, systemd-юнит и инструкцию.
