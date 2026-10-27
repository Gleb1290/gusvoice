# GusVoice bots (Bot API v1)

> Русская версия: [bots.ru.md](bots.ru.md) · For AI assistants: [bots-llm.md](bots-llm.md) · Build a bot with an AI assistant: [bots-playbook.ru.md](bots-playbook.ru.md) (Russian)

A bot is an account run by a **program**, not a person. It has a username, a name, an avatar and a **BOT** tag, and people
can chat with it in direct messages. Your program signs in with a **token**, receives the messages people send to the
bot and replies — through plain HTTP requests (`curl`, Python, Node, anything).

Typical uses: notifications to yourself (disk is full, build failed), a server control panel (`/status`,
`/restart nginx`), reminders, answers to commands.

The GusVoice interface is in Russian; interface labels below are given in English with the original in brackets.

**What this version covers (API 4).** Bots work in **direct messages** (a 1:1 conversation "person — bot") with a command
menu on `/` and buttons under messages, **on servers** (channels, Telegram-style privacy, reactions, moderation — see "Bots
on servers") and **in voice channels** (the bot plays audio — see "Voice"). There are no group conversations or federation for bots.
See [Differences from Telegram](#differences-from-telegram).

---

## Bots vs. webhooks

| | Incoming webhook ([webhooks.md](webhooks.md)) | Bot |
|---|---|---|
| What it is | A secret URL that can **only post** to a text channel | An account with a token: receives messages **and** replies |
| Where it posts | A server channel | A direct conversation with a person |
| Reads messages | No | Yes — those sent to it in DMs |
| Sign-in | Token in the URL | Header `Authorization: Bot <token>` |
| Profile, username, "message it directly" | No | Yes |
| Who creates it | Anyone with "Manage webhooks" | Any person, if the instance administrator allows it |

If you just need to push a notification into a channel, use a webhook. If you need a dialogue or commands, use a bot.

---

## Enabling bots (instance administrator)

Bots are **off by default**: tokens are rejected and nobody can create a bot. The super-administrator turns them on in the
app; no server files need editing.

**Admin panel → Bots («Боты»):**

- **"Bots on this server"** («Боты на этом сервере») — the master switch. Turning it off stops every bot at once: tokens are
  rejected (`403`), open WebSockets are closed and events are no longer recorded. Settings and the bots themselves are kept.
- **Who can create bots**: "Everyone" («Все»), "Approved only" («Только одобренные», accounts approved by the administrator),
  "Administrator only" («Только администратор»).
- **How many bots one person can have** — 0 to 100, default 10. The administrator is not limited. In addition, one person
  can create at most 10 bots per hour.
- **"Allow delivery to internal addresses"** — off by default (see [SSRF protection](#ssrf-protection)).
- **"All bots"** — a table of all bots with their owners: disable a bot (its token stops working, its WebSocket is closed),
  enable it again, or delete it.

Bots live only on their own instance: they do not appear in the catalogs of neighbouring instances (federation) and cannot
message people on other instances.

---

## Quick start (5 minutes)

You need an instance with bots enabled and `curl`. Below, your instance's API address is `https://chat.example.com`
(substitute your own; this is the API address, the same one used in webhook URLs).

1. **Create a bot.** Settings → **My bots** («Мои боты») → "Create bot" («Создать бота»). The username is Latin letters,
   digits and `_`, 3–32 characters, and **must end with `bot`** (as in Telegram), e.g. `vps_alert_bot`. The name and
   description can be changed later.
2. **Copy the token.** It is shown **once** (the server keeps only a hash). If you lose it, press "Reissue token"
   («Перевыпустить токен»): a new one is issued at once and the old one stops working. A token looks like `gvb_…`
   (4-character prefix + 43 characters).
3. **Open the conversation with the bot** — the "Open conversation" («Открыть беседу») button. A new bot is **private**: only
   its owner can message it. An empty conversation shows a **"Start"** («Старт») button in the middle and the message box
   appears after you press it. "Start" sends the message `/start`.
4. **Check the token and fetch the message:**

```sh
export GV_API=https://chat.example.com/api/bot/v1
export GV_TOKEN=gvb_...                      # the token from step 2

curl -sS "$GV_API/getMe" -H "Authorization: Bot $GV_TOKEN"
# {"ok":true,"result":{"id":"…","username":"vps_alert_bot","display_name":"…","bot":true,"description":"","about":"","public":false}}

curl -sS "$GV_API/getUpdates?timeout=10" -H "Authorization: Bot $GV_TOKEN"
# {"ok":true,"result":[
#   {"update_id":101,"my_chat_member":{"chat":{"id":"<chat_id>","type":"dm"},"from":{…},"date":…,"old_status":"left","new_status":"member"}},
#   {"update_id":102,"message":{"message_id":"…","chat":{"id":"<chat_id>","type":"dm"},"from":{"id":"<your id>",…},"date":…,"text":"/start"}}
# ]}
```

5. **Reply** (use the `chat.id` from the event):

```sh
curl -sS "$GV_API/sendMessage" -H "Authorization: Bot $GV_TOKEN" \
  -d chat_id=<chat_id> -d "text=Hello! Disk / is 91% full"
```

The message appears in the conversation. To stop events from being delivered again, acknowledge them: the next request
`getUpdates?offset=103` (last `update_id` + 1) marks everything lower as received. Details are in the
[reference](#reference).

> A bot **cannot write first**: a person opens the conversation (the "Open conversation" button, search, "Message").
> Until the conversation exists, `sendMessage` answers `400 chat not found`.

---

## Reference

### Calling

```
GET|POST https://chat.example.com/api/bot/v1/<method>
Authorization: Bot <token>
```

- Method names are case-insensitive (`getMe` = `getme`). Every method works with both `GET` and `POST`.
- Parameters can be passed **any** way (as in Telegram): a JSON body (`Content-Type: application/json`), a form
  (`application/x-www-form-urlencoded`, handy for `curl -d`), `multipart/form-data` or the query string. If the same
  parameter is in both the query string and the body, the body wins.
- From a form or the query string numbers and flags may be strings (`limit=50`, `disable_notification=true` or `=1`);
  arrays and objects (`allowed_updates`, `embeds`) are JSON strings.
- **Ids** are strings (UUIDs): `chat_id`, `message_id`, `from.id` are always strings. A number instead of a string is a
  `400`. **Time** is Unix seconds (integer). Fields are `snake_case`.
- Unknown extra parameters are ignored.
- JSON/form bodies are limited to **64 KB**. Files go only in `multipart` and only to `sendMessage`.
- The token goes **only** in `Authorization: Bot <token>`. `Bearer` (people's tokens) and a token in the URL are not accepted.

### Response and errors

Success — HTTP 200:

```json
{ "ok": true, "result": <value> }
```

Error — the HTTP status equals `error_code`:

```json
{ "ok": false, "error_code": 429, "description": "Too Many Requests: retry after 3", "retry_after": 3 }
```

`retry_after` (whole seconds) and the `Retry-After` header exist only on `429`. **Branch on `error_code`**, not on the text
of `description`: the text is for humans, sometimes in Russian, and may change.

| `error_code` | When |
|---|---|
| 400 | A bad parameter (`description` says which: `Bad Request: chat_id: …`); chat not found or not yours (`chat not found`); message not found; empty message; reply to a non-existent message; a bad delivery URL; files not in `files[n]`; files sent to a method other than `sendMessage`; body over 64 KB |
| 401 | `Unauthorized` — no header, scheme is not `Bot`, token does not match (including a reissued one), bot disabled by the administrator |
| 403 | Bots are disabled on the instance; the other person blocked the bot; the other person deleted their account |
| 404 | No such method (checked after the token: without a valid token methods are not revealed) |
| 409 | `getUpdates` while a delivery URL is set; a waiting `getUpdates` that another consumer replaced (`Conflict: terminated by other getUpdates request; make sure that only one bot instance is running`) |
| 415 | Forbidden file type (SVG, HTML) |
| 429 | Rate limit (see [Limits](#limits)) |
| 500 | Internal server error |
| 503 | File storage is not ready (when sending a file) |

<!-- gen:bot-reference begin -->

<!-- Generated from the server code by `node scripts/gen-bot-api.mjs` — do not edit by hand; texts live in `docs/bot-api/text.en.json`. -->

### Objects

Answers may gain new fields in future versions — skip unknown fields quietly. Ids are strings (UUIDs), time is Unix seconds.

#### Attachment

A file attached to a message.

| Field | Type | |
|---|---|---|
| `url` | string | a link made **for your bot**, downloaded with a plain `GET` without headers; do not publish it. It works while the bot has access to the conversation |
| `file_name` | string | file name |
| `mime_type` | string | file type |
| `file_size` | number | size in bytes |

#### BotCommand

A command in the hint list shown when a person types `/`, e.g. `{ "command": "status", "description": "Server state" }`.

| Field | Type | |
|---|---|---|
| `command` | string | name without the slash (pattern `^[a-z0-9_]{1,32}$`) |
| `description` | string | what it does (1–256 chars) |

#### BotCommandScope

Where a command list applies.

| Field | Type | |
|---|---|---|
| `type` | string | `default`, `all_private_chats` (DMs) or `all_group_chats` (servers). Other types → `400`. DMs use `all_private_chats` if set, otherwise `default`; servers use `all_group_chats`, otherwise `default` (≤ 32 chars) |

#### BotUser

The bot itself (the `getMe` result): a [User](#user) plus the bot's profile and what the server can do. Check `features` instead of guessing by version; an older server does not send `api_version`/`features`.

| Field | Type | |
|---|---|---|
| `id` | string | bot id |
| `username` | string | bot username |
| `display_name` | string | name; the username if unset |
| `bot` | boolean | always `true` |
| `instance_domain` | string, optional | present for guests from other instances (federation); usernames may collide with local ones — authorize by `id` |
| `description` | string | description (up to 512 characters) |
| `about` | string | short "about" (up to 120 characters) |
| `public` | boolean | whether everyone may message the bot |
| `api_version` | number, optional | server Bot API version: 2 — buttons and commands, 3 — servers, 4 — voice |
| `features` | array of string, optional | what the server supports: `polling`, `ws`, `webhook`, `keyboards`, `commands`, `client_id`, `servers`, `reactions`, `parse_mode`, `webhook_batch`, `voice`, …; new ones are appended |
| `dropped_update_count` | number, optional | how many events the journal limit dropped (present if any) |

#### CallbackQuery

A button with `callback_data` was pressed. Answer it with `answerCallbackQuery`.

| Field | Type | |
|---|---|---|
| `id` | string | pass it to `answerCallbackQuery` |
| `from` | [User](#user) | who pressed |
| `message` | [Message](#message) | the message with the buttons, whole (including `reply_markup`) |
| `data` | string | `callback_data` of the pressed button |
| `date` | number | press time |

#### Chat

A conversation. 🔴 **Check `type`**: code that assumed `"dm"` will see other values; ignore unknown ones.

| Field | Type | |
|---|---|---|
| `id` | string | conversation id — the value to pass as `chat_id` |
| `type` | `"dm"` \| `"channel"` \| `"server"` \| `"voice"` | `dm` — 1:1 chat, `channel` — text channel of a server, `server` — the server itself (membership events and `getChat` only), `voice` — voice channel (voice methods only) |
| `server_id` | string, optional | for channels: the server |
| `title` | string, optional | for channels and servers: the name |

#### ChatFullInfo

The `getChat` result: a [Chat](#chat) with details.

| Field | Type | |
|---|---|---|
| `id` | string | conversation id |
| `type` | `"dm"` \| `"channel"` \| `"server"` \| `"voice"` | as in [Chat](#chat) |
| `server_id` | string, optional | for channels: the server |
| `title` | string, optional | for channels and servers: the name |
| `user` | [User](#user), optional | in a DM: the other participant |
| `member_count` | number, optional | for a server: number of members |

#### ChatMember

A server member (`getChatMember`, `getChatMembers`). Permissions are not flags as in Telegram: look up the roles with `getServer`.

| Field | Type | |
|---|---|---|
| `user` | [User](#user) | the member |
| `status` | `"creator"` \| `"member"` \| `"left"` \| `"kicked"` | `creator` — owner, `member`, `left`, `kicked` (banned) |
| `nickname` | string, optional | nickname on this server (present if set) |
| `role_ids` | array of string | ids of the member's roles |
| `joined_date` | number, optional | when they joined the server |

#### ChatMemberUpdated

The bot's own membership changed (`my_chat_member`).

| Field | Type | |
|---|---|---|
| `chat` | [Chat](#chat) | the conversation |
| `from` | [User](#user) | who changed it (the person, or a server admin) |
| `date` | number | time of the event |
| `old_status` | `"creator"` \| `"member"` \| `"left"` \| `"kicked"` | status before: in a DM `member` / `left` / `kicked` |
| `new_status` | `"creator"` \| `"member"` \| `"left"` \| `"kicked"` | status after |

#### ChatMembersPage

A page of server members.

| Field | Type | |
|---|---|---|
| `members` | array of [ChatMember](#chatmember) | members of this page |
| `next_offset` | string, optional | pass it as `offset` for the next page; absent on the last page |

#### Error

An error answer; the HTTP status equals `error_code`. Branch on `error_code`, not on the text of `description`.

| Field | Type | |
|---|---|---|
| `ok` | `false` | always `false` |
| `error_code` | number | HTTP status |
| `description` | string | text for humans, may change |
| `retry_after` | number, optional | only on `429`: whole seconds to wait (also the `Retry-After` header) |

#### InlineKeyboardButton

A button under a message: `text` plus **exactly one** of `callback_data` and `url`. Other Telegram button kinds (`web_app`, `switch_inline_query`, `login_url`, …) are ignored.

| Field | Type | |
|---|---|---|
| `text` | string | button label (1–64 chars) |
| `callback_data` | string, optional | up to **64 bytes** UTF-8, not characters (Cyrillic is 2 bytes per letter: 32 letters). Pressing sends the bot a `callback_query` with this string (≥ 1 chars) |
| `url` | string, optional | `http(s)` only, no `user:password@` in the address. The person is asked "Open link?" for foreign addresses (≤ 2048 chars) |

#### InlineKeyboardMarkup

Buttons under a message: rows of buttons, at least one row, 1–8 buttons in a row, at most 100 in total. From a form or the query string — a JSON string.

| Field | Type | |
|---|---|---|
| `inline_keyboard` | array of array of [InlineKeyboardButton](#inlinekeyboardbutton) | rows of buttons (≥ 1 items; each 1–8 items) |

#### InputEmbed

A card for `sendMessage` (`embeds`), the same format as incoming webhooks. Card images only from this instance's storage or an uploaded file (`attachment://<file name>`, servers only); an external image is shown as a link.

| Field | Type | |
|---|---|---|
| `title` | string or null, optional | title (≤ 256 chars) |
| `description` | string or null, optional | text (≤ 4096 chars) |
| `url` | string or null, optional | link of the title (≤ 2048 chars) |
| `color` | integer or null, optional | stripe colour, `0xRRGGBB` as a number |
| `timestamp` | string or null, optional | ISO 8601 time shown at the bottom (≤ 64 chars) |
| `fields` | array of { name: string, value: string, inline?: any } or null, optional | up to 25 fields `{ name, value, inline? }` (≤ 25 items) |
| `author` | { name: string, url?: string or null, icon_url?: string or null } or null, optional | `{ name, url?, icon_url? }` |
| `footer` | { text: string, icon_url?: string or null } or null, optional | `{ text, icon_url? }` |
| `image` | { url: string } or null, optional | `{ url }` — big picture |
| `thumbnail` | { url: string } or null, optional | `{ url }` — small picture |

#### Message

A message.

| Field | Type | |
|---|---|---|
| `message_id` | string | message id |
| `chat` | [Chat](#chat) | where it was sent |
| `from` | [User](#user) | author |
| `date` | number | send time |
| `edit_date` | number, optional | present only if the message was edited |
| `text` | string | text (may be empty if the message has only an attachment or a card) |
| `reply_to_message_id` | string, optional | present if it is a reply |
| `attachments` | array of [Attachment](#attachment), optional | present if there are attachments |
| `embeds` | array of [MessageEmbed](#messageembed), optional | present if there are cards |
| `reply_markup` | [InlineKeyboardMarkup](#inlinekeyboardmarkup), optional | present if the message has buttons |

#### MessageDeleted

A message disappeared for the bot.

| Field | Type | |
|---|---|---|
| `message_id` | string | message id |
| `chat` | [Chat](#chat) | the conversation |
| `date` | number | time of deletion |

#### MessageEmbed

A card as stored by the server (field names as in the message feed: `iconUrl`, `imageLink`).

| Field | Type | |
|---|---|---|
| `title` | string, optional | title |
| `url` | string, optional | link of the title |
| `description` | string, optional | text |
| `color` | number, optional | stripe colour |
| `timestamp` | string, optional | time shown at the bottom |
| `author` | { name: string, url?: string, iconUrl?: string }, optional | author line |
| `footer` | { text: string, iconUrl?: string }, optional | footer line |
| `fields` | array of { name: string, value: string, inline?: boolean }, optional | fields |
| `image` | { url: string }, optional | big picture from this instance's storage |
| `thumbnail` | { url: string }, optional | small picture from this instance's storage |
| `imageLink` | string, optional | an external `image` — shown as a link, not loaded |
| `thumbnailLink` | string, optional | an external `thumbnail` — shown as a link, not loaded |

#### MessageReactionUpdated

A person changed their reactions to a message (`message_reaction`).

| Field | Type | |
|---|---|---|
| `chat` | [Chat](#chat) | the conversation |
| `message_id` | string | message id |
| `user` | [User](#user) | who reacted |
| `date` | number | time of the event |
| `old_reaction` | array of [ReactionType](#reactiontype) | this person's reactions before |
| `new_reaction` | array of [ReactionType](#reactiontype) | this person's reactions now |

#### ReactionType

A reaction.

| Field | Type | |
|---|---|---|
| `type` | `"emoji"` | only `emoji` for now |
| `emoji` | string | the emoji (1–32 chars) |

#### ServerBrief

A server the bot is on (`getMyServers`).

| Field | Type | |
|---|---|---|
| `id` | string | server id (`server_id` for `getServer`) |
| `title` | string | name |

#### ServerInfo

A server as the bot sees it (`getServer`).

| Field | Type | |
|---|---|---|
| `id` | string | server id |
| `title` | string | name |
| `channels` | array of { id: string, title: string, type: `"text"` \| `"voice"`, can_send: boolean } | channels the bot can see; `can_send` — whether the bot may post there |
| `roles` | array of { id: string, name: string, position: number, managed: boolean } | roles; `managed` — a bot role (cannot be given to anyone else) |

#### ServerMemberUpdated

Someone joined, left, was kicked, banned or unbanned on a server (`chat_member`).

| Field | Type | |
|---|---|---|
| `chat` | [Chat](#chat) | the server (`type: "server"`) |
| `from` | [User](#user) | who did it (the member themselves or a moderator) |
| `user` | [User](#user) | whose membership changed |
| `date` | number | time of the event |
| `old_status` | `"creator"` \| `"member"` \| `"left"` \| `"kicked"` | status before |
| `new_status` | `"creator"` \| `"member"` \| `"left"` \| `"kicked"` | status after |

#### Update

An event: `update_id` plus **exactly one** content field (see [Events](#events)). If a field that is not listed arrives (in future versions), skip it quietly.

| Field | Type | |
|---|---|---|
| `update_id` | number | increasing but **not necessarily consecutive** (the counter is shared by the whole instance) |
| `message` | [Message](#message), optional | a new message |
| `edited_message` | [Message](#message), optional | an edited message |
| `message_deleted` | [MessageDeleted](#messagedeleted), optional | a message disappeared |
| `my_chat_member` | [ChatMemberUpdated](#chatmemberupdated), optional | the bot's own membership changed |
| `callback_query` | [CallbackQuery](#callbackquery), optional | a button was pressed |
| `message_reaction` | [MessageReactionUpdated](#messagereactionupdated), optional | reactions changed |
| `chat_member` | [ServerMemberUpdated](#servermemberupdated), optional | server membership changed |
| `voice_state` | [VoiceStateUpdated](#voicestateupdated), optional | someone joined or left a voice channel |

#### User

A person or a bot.

| Field | Type | |
|---|---|---|
| `id` | string | user id (UUID) |
| `username` | string | username |
| `display_name` | string | name; the username if unset |
| `bot` | boolean | `true` for bots |
| `instance_domain` | string, optional | present for guests from other instances (federation); usernames may collide with local ones — authorize by `id` |

#### VoiceChatMember

Who is in a voice channel now (`getVoiceChatMembers`).

| Field | Type | |
|---|---|---|
| `user` | [User](#user) | the participant |
| `muted` | boolean | microphone off |
| `deafened` | boolean | sound off |
| `server_muted` | boolean | a moderator muted it on the server |
| `is_bot` | boolean | a bot |

#### VoiceJoinResult

Where and how to connect to voice (`joinVoice`).

| Field | Type | |
|---|---|---|
| `url` | string | LiveKit address |
| `token` | string | LiveKit token; LiveKit refreshes it while the session is alive, after a full drop call `joinVoice` again |
| `room` | string | room name |
| `chat` | [Chat](#chat) | the voice channel (`type: "voice"`) |
| `server_muted` | boolean | the bot is muted by a moderator |
| `expires_in` | number | token lifetime in seconds |
| `audio` | { sample_rate: number, channels: number, bitrate: number } | what to publish: PCM `sample_rate` 48000, `channels` 2, `bitrate` as requested |

#### VoiceStateUpdated

Someone joined or left a voice channel of the server (`voice_state`).

| Field | Type | |
|---|---|---|
| `chat` | [Chat](#chat) | the voice channel |
| `user` | [User](#user) | who (may be the bot itself) |
| `action` | `"joined"` \| `"left"` | what happened |
| `date` | number | time of the event |
| `move_to` | [Chat](#chat), optional | only to the bot itself, when a moderator moved it: join this channel (the SDK does it on its own) |

#### WebhookInfo

Delivery-to-URL state (`getWebhookInfo`).

| Field | Type | |
|---|---|---|
| `url` | string | the URL; an empty string if none |
| `pending_update_count` | number | how many events are waiting in the journal |
| `failures` | number | consecutive delivery failures |
| `last_error_date` | number, optional | time of the last failure (present if there was one) |
| `last_error_message` | string, optional | the last failure, a short English text, e.g. `Wrong response from the webhook: HTTP 502` |
| `disabled_date` | number, optional | present if the server switched delivery off after a series of failures |
| `batch` | boolean, optional | batched delivery is on |
| `dropped_update_count` | number, optional | how many events the journal limit dropped (present if any) |

### Methods

Required parameters are in bold. Every method returns its value in `result` inside `{"ok":true,…}`. Every method also works with `GET` (parameters in the query string); from a form or the query string numbers and flags may be strings (`limit=50`, `disable_notification=true`), arrays and objects are JSON strings.

#### getMe

_Since API 1._ Who am I. Handy to check that the token works.

No parameters.

Result: [BotUser](#botuser).

#### getUpdates

_Since API 1._ Fetch new events (long polling).

| Parameter | Type | Limits | |
|---|---|---|---|
| `offset` | integer |  | acknowledge all events with `update_id` **lower** than `offset` (they are deleted) and return from `offset` on. Normally the last `update_id` + 1. Unset or ≤ 0 returns everything not yet acknowledged |
| `limit` | integer | 1–100 | default 100 |
| `timeout` | integer | 0–50 | seconds, default 0 (answer at once). Above 0 the server waits up to `timeout` seconds for the first event (long polling) |
| `allowed_updates` | array of string | ≤ 64 items; each ≤ 64 chars | only these kinds, e.g. `["message","callback_query"]`. The rest stay in the journal until acknowledged by `offset`. Unknown kinds are **ignored** (not a `400`): a bot written for a newer server keeps working |

Result: array of [Update](#update).

Events come by ascending `update_id`. Until acknowledged with `offset`, the same events arrive again (this is how bot restarts are survived). If a delivery URL is set — `409`.

**One consumer at a time** (as in Telegram): a new `getUpdates` or WebSocket of the same bot **replaces** the previous one — a waiting `getUpdates` answers `409 Conflict: terminated by other getUpdates request; make sure that only one bot instance is running`, an open WebSocket is closed with `4009`. Two copies of the bot with one token knock each other out — stop one. Reissuing the token, disabling the bot or all bots also ends a waiting `getUpdates` at once (`401`/`403`) instead of handing it a batch.

Do not poll with two processes of the same bot: both will see the same events and answer twice.

#### setWebhook

_Since API 1._ Turn on event delivery to a URL (see [Delivery to a URL](#delivery-to-a-url)).

| Parameter | Type | Limits | |
|---|---|---|---|
| **`url`** | string | 1–2048 chars | `https://…`, no login or password in the URL |
| **`secret_token`** | string | pattern `^[A-Za-z0-9_-]{16,256}$` | **required**: every delivery is signed with it |
| `drop_pending_updates` | boolean |  | discard accumulated events |
| `batch` | boolean |  | batched delivery: the POST body is an array of up to 100 updates, signed as a whole; a `2xx` confirms the whole batch |

Result: `true`.

The URL is checked immediately (see [SSRF protection](#ssrf-protection)); an error is `400 Bad Request: bad webhook: …`. After the call `getUpdates` answers `409` and open WebSockets are closed with code `4009`. Calling `setWebhook` again with a new URL or secret resets the failure counter.

#### deleteWebhook

_Since API 1._ Turn delivery to a URL off; returns the bot to `getUpdates`/WebSocket.

| Parameter | Type | Limits | |
|---|---|---|---|
| `drop_pending_updates` | boolean |  | discard accumulated events |

Result: `true`.

#### getWebhookInfo

_Since API 1._ Delivery-to-URL state.

No parameters.

Result: [WebhookInfo](#webhookinfo).

#### sendMessage

_Since API 1._ Send a message.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | a DM or text channel the bot is in |
| `text` | string | ≤ 4096 chars | the same markup as people's messages |
| `reply_to_message_id` | string | 1–64 chars | reply to a message |
| `embeds` | array of [InputEmbed](#inputembed) or null | ≤ 10 items | cards, [InputEmbed](#inputembed) |
| `disable_notification` | boolean |  | no sound or push |
| `disable_link_preview` | boolean |  | no link preview card |
| `reply_markup` | [InlineKeyboardMarkup](#inlinekeyboardmarkup) |  | buttons under the message |
| `client_id` | string | 1–64 chars | your own id of this send: repeating `sendMessage` with the same `client_id` (a network drop, a restart) returns **the same** message instead of a second one. The same `client_id` with a different chat or content → `400`. Ignored in channels for now |
| `parse_mode` | string | ≤ 16 chars | omitted — our markup; `HTML` — a Telegram subset converted to our markup; `MarkdownV2` → `400` |
| `files[0]` | file (multipart only) |  | files `files[0]`…`files[9]`: up to **10**, each up to **25 MB**. Other fields are strings; `embeds` and `reply_markup` — JSON strings |

Result: [Message](#message).

At least one of `text`, `embeds` or a file is required (buttons alone are not enough). If `text` is empty and there are cards, `Message.text` is an empty string.

Errors: `400` (empty, not your chat, reply target missing), `403` (bot blocked by the person / account deleted / no right to post in the channel), `415` (SVG/HTML), `429`, `503` (no file storage).

```sh
curl -sS "$GV_API/sendMessage" -H "Authorization: Bot $GV_TOKEN" \
  -F chat_id=<chat_id> -F text="Report" -F "files[0]=@report.pdf;type=application/pdf"
```

#### editMessageText

_Since API 1._ Change the text of the bot's own message.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | conversation or channel id |
| **`message_id`** | string | 1–64 chars | message id |
| **`text`** | string | ≤ 4096 chars | new text |
| `reply_markup` | [InlineKeyboardMarkup](#inlinekeyboardmarkup) |  | buttons after the edit. 🔴 **Omitted — the buttons are removed** (as in Telegram) |
| `parse_mode` | string | ≤ 16 chars | omitted — our markup; `HTML` — a Telegram subset converted to our markup; `MarkdownV2` → `400` |

Result: [Message](#message).

The result has `edit_date`. Only the bot's **own** messages can be edited, otherwise `400`. The person sees an ordinary edit.

#### deleteMessage

_Since API 1._ Delete a message.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | conversation or channel id |
| **`message_id`** | string | 1–64 chars | message id |

Result: `true`.

In a 1:1 conversation a bot, like a person, can delete both its own messages and the other person's — **for both**; in a channel — as the bot's role permits. Deleting the same message again also returns `true`.

#### sendChatAction

_Since API 1._ Show "typing…" to the other side. Call it before a long operation.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | conversation or channel id |
| **`action`** | `"typing"` |  | only `typing` for now |

Result: `true`.

#### getChat

_Since API 1._ Details of a conversation, channel or server.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | conversation or channel id |

Result: [ChatFullInfo](#chatfullinfo).

#### editMessageReplyMarkup

_Since API 2._ Change only the buttons of the bot's own message.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | conversation or channel id |
| **`message_id`** | string | 1–64 chars | message id |
| `reply_markup` | [InlineKeyboardMarkup](#inlinekeyboardmarkup) |  | new buttons; **omitted — buttons are removed** |

Result: [Message](#message).

The person does **not** see "(edited)". The same buttons again are not an error (Telegram answers `400 message is not modified`; we just return the message).

#### answerCallbackQuery

_Since API 2._ Answer a button press.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`callback_query_id`** | string | 1–64 chars | `callback_query.id` |
| `text` | string | ≤ 200 chars | a toast for the person; without it the "clock" on the button just goes out |
| `show_alert` | boolean |  | a dialog with an "OK" button instead of a toast |

Result: `true`.

Answer **once** and within **15 seconds**: the person's client waits that long, then shows "the bot did not answer". A press lives **25 seconds**: until then the answer is accepted (a slightly late one too) and the event is delivered; after that it is neither. A second answer, a late one or someone else's id → `400 query is too old and response timeout expired or query id is invalid` (Telegram's text). Telegram's `url` and `cache_time` are not supported yet.

#### setMyCommands

_Since API 2._ Set the command hint list.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`commands`** | array of [BotCommand](#botcommand) | ≤ 100 items | **replaces** the whole list; `[]` — remove. A repeated name → `400` |
| `scope` | [BotCommandScope](#botcommandscope) |  | which list; default `{"type":"default"}` |

Result: `true`.

The list is the hint shown when a person types `/` (and the "/" button next to the message box). Commands still arrive as ordinary `message` with text `/status …` — parse them yourself.

#### getMyCommands

_Since API 2._ The current command list.

| Parameter | Type | Limits | |
|---|---|---|---|
| `scope` | [BotCommandScope](#botcommandscope) |  | which list; default `{"type":"default"}` |

Result: array of [BotCommand](#botcommand).

#### deleteMyCommands

_Since API 2._ Remove the command list (the same as `setMyCommands` with `[]`).

| Parameter | Type | Limits | |
|---|---|---|---|
| `scope` | [BotCommandScope](#botcommandscope) |  | which list; default `{"type":"default"}` |

Result: `true`.

#### setMessageReaction

_Since API 3._ Set the bot's reactions to a message (in DMs too); the set is replaced, `[]` — remove.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | conversation or channel id |
| **`message_id`** | string | 1–64 chars | message id |
| `reaction` | array of [ReactionType](#reactiontype) | ≤ 3 items | the bot's reactions |

Result: `true`.

#### pinChatMessage

_Since API 3._ Pin a message in a channel (needs "Manage messages").

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | conversation or channel id |
| **`message_id`** | string | 1–64 chars | message id |
| `disable_notification` | boolean |  | no sound or push |

Result: `true`.

#### unpinChatMessage

_Since API 3._ Unpin a message in a channel (needs "Manage messages").

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | conversation or channel id |
| **`message_id`** | string | 1–64 chars | message id |

Result: `true`.

#### getChatHistory

_Since API 3._ Earlier messages of a channel: the latest page before `before_message_id` (or the newest), oldest first; polls and stickers are skipped. Only for "Read all messages" bots with "Read history" in the channel.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | conversation or channel id |
| `before_message_id` | string | 1–64 chars | messages older than this one; omitted — from the newest |
| `limit` | integer | 1–100 | default 50 |

Result: array of [Message](#message).

#### getChatMember

_Since API 3._ One server member.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | a server or a channel of it |
| **`user_id`** | string | 1–64 chars | member id |

Result: [ChatMember](#chatmember).

#### getChatMemberCount

_Since API 3._ How many members a server has.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | a server or a channel of it |

Result: integer.

#### getChatMembers

_Since API 3._ Server members page by page.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | a server or a channel of it |
| `offset` | string | ≤ 128 chars | `next_offset` of the previous page; omitted — the first page |
| `limit` | integer | 1–200 | default 100 |

Result: [ChatMembersPage](#chatmemberspage).

#### getMyServers

_Since API 3._ Servers the bot is on.

No parameters.

Result: array of [ServerBrief](#serverbrief).

#### getServer

_Since API 3._ A server: the channels the bot can see (with `can_send`) and roles (with `managed`).

| Parameter | Type | Limits | |
|---|---|---|---|
| **`server_id`** | string | 1–64 chars | server id |

Result: [ServerInfo](#serverinfo).

#### addChatMemberRole

_Since API 3._ Give a role to a member (needs "Manage roles"; the role must be below the bot's).

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | a server or a channel of it |
| **`user_id`** | string | 1–64 chars | member id |
| **`role_id`** | string | 1–64 chars | role id (from `getServer`) |

Result: `true`.

#### removeChatMemberRole

_Since API 3._ Take a role from a member (needs "Manage roles"; the role must be below the bot's).

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | a server or a channel of it |
| **`user_id`** | string | 1–64 chars | member id |
| **`role_id`** | string | 1–64 chars | role id (from `getServer`) |

Result: `true`.

#### banChatMember

_Since API 3._ Ban a member (needs the matching permission; the target must be below the bot).

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | a server or a channel of it |
| **`user_id`** | string | 1–64 chars | member id |
| `reason` | string | ≤ 512 chars | reason of the ban |

Result: `true`.

#### unbanChatMember

_Since API 3._ Lift a ban (needs the matching permission).

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | a server or a channel of it |
| **`user_id`** | string | 1–64 chars | member id |

Result: `true`.

#### kickChatMember

_Since API 3._ Kick a member from the server (needs the matching permission; the target must be below the bot).

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | a server or a channel of it |
| **`user_id`** | string | 1–64 chars | member id |

Result: `true`.

#### leaveChat

_Since API 3._ The bot leaves a server; its role goes with it.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | a server or a channel of it |

Result: `true`.

#### joinVoice

_Since API 4._ Join a voice channel to play audio (see [Voice](#voice-api-4)). The bot never hears people.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | voice channel id |
| `bitrate` | integer | 24000–128000 | bits per second, default 64000 |

Result: [VoiceJoinResult](#voicejoinresult).

Connect to LiveKit at `url` with `token` and publish PCM 48 kHz stereo as a `MICROPHONE` track. One voice channel per server: joining another channel of the same server moves the bot. Errors, in this order: `403 voice is disabled for bots on this server`, `400 chat not found`, `400 chat is a server; use a channel id`, `400 chat is not a voice channel`, `403 not enough rights to connect to the voice chat`, `403 not enough rights to speak in the voice chat`, `429`, `400 too many bots in the voice chat`, `400 too many active voice chats`.

#### leaveVoice

_Since API 4._ Leave a voice channel, or all of them. Idempotent: always `true`.

| Parameter | Type | Limits | |
|---|---|---|---|
| `chat_id` | string | 1–64 chars | voice channel id; omitted — leave all |

Result: `true`.

#### getVoiceChatMembers

_Since API 4._ Who is in a voice channel now.

| Parameter | Type | Limits | |
|---|---|---|---|
| **`chat_id`** | string | 1–64 chars | voice channel id |

Result: array of [VoiceChatMember](#voicechatmember).

### Events

A bot's event journal keeps events for **24 hours**, at most **1000** (a "Read all messages" bot — 10 000; the oldest go first, the count of dropped ones is `dropped_update_count`). Acknowledged events (`offset`, `ack`, a `2xx` answer from your URL) are deleted. Every event is an [Update](#update): `update_id` plus exactly one of these fields.

| Event | Content | API | When |
|---|---|---|---|
| `message` | [Message](#message) | 1 | a person wrote to the bot in a DM, or a message the bot may see arrived in a channel (see [Bots on servers](#bots-on-servers-api-3)) |
| `edited_message` | [Message](#message) | 1 | such a message was edited (in channels filtered by the new text) |
| `message_deleted` | [MessageDeleted](#messagedeleted) | 1 | a message disappeared for the bot (deleted for both in a DM; in channels — to "read all" bots and the author) |
| `my_chat_member` | [ChatMemberUpdated](#chatmemberupdated) | 1 | in a DM: a person opened the conversation (`new_status: "member"`; also when they press "Message" again after deleting the chat), deleted it on their side (`"left"`), blocked the bot (`"kicked"`) or unblocked it; on a server (`chat.type: "server"`): the bot was added, removed or banned |
| `callback_query` | [CallbackQuery](#callbackquery) | 2 | a person pressed a button with `callback_data` under the bot's message. **Not delivered if older than 25 seconds** |
| `message_reaction` | [MessageReactionUpdated](#messagereactionupdated) | 3 | a person changed reactions (to read-all bots and the message author; in DMs — to any message of the chat) |
| `chat_member` | [ServerMemberUpdated](#servermemberupdated) | 3 | someone joined, left, was kicked, banned or unbanned on a server the bot is on |
| `voice_state` | [VoiceStateUpdated](#voicestateupdated) | 4 | someone joined or left a voice channel the bot can see (including the bot itself — so it learns it was disconnected) |

A bot does not see its own actions as events: sending, editing and deleting through the Bot API produce no events for the bot (the exception is `voice_state` — the bot learns about its own joins and leaves). Pins, "typing", read receipts, polls and stickers are not delivered to bots.

<!-- gen:bot-reference end -->

### WebSocket

Instead of polling you can keep a connection open — events arrive immediately.

```
wss://chat.example.com/api/bot/v1/ws?offset=<N>
Authorization: Bot <token>
```

The `Authorization` header is required, so the browser `WebSocket` (which cannot set headers) does not fit — bots use
server-side clients (the `ws` package in Node, `websockets` in Python). `offset` is optional: acknowledge everything before it.

Messages are JSON text:

| From | Message | |
|---|---|---|
| server | `{"op":"hello","bot":<Bot>}` | right after connecting |
| server | `{"op":"update","update":<Update>}` | events in order; first the accumulated ones, then new ones |
| client | `{"op":"ack","offset":N}` | acknowledge all events with `update_id` lower than `N` (like `offset` in `getUpdates`) |
| client | `{"op":"ping"}` → server `{"op":"pong"}` | optional liveness check |

The server sends ping frames every 30 seconds itself; ordinary client libraries answer automatically, and a silent
connection is dropped. Events are **not acknowledged automatically**: after a reconnect unacknowledged ones arrive again, so
send `ack` (or pass `?offset=` when connecting). There is no `allowed_updates` on WebSocket — all kinds arrive.

Close codes:

| Code | Reason |
|---|---|
| 4001 | token does not match, was reissued, or the bot is disabled by the administrator |
| 4003 | bots are disabled on the instance |
| 4009 | a delivery URL is set (`setWebhook`) — WebSocket and URL delivery do not work together; or another connection of this bot replaced this one (reason `terminated by other connection`: a new WebSocket or `getUpdates` — one consumer at a time) |
| 4029 | connecting too often |

On 4001, 4003 and 4009 reconnecting in a loop is pointless — fix the cause first. For other drops, reconnect with a pause.

### Delivery to a URL

The third way to receive events: GusVoice itself sends every event as a `POST` to your program's URL. It fits when the
bot has a public `https` address (a web server, a cloud function).

Delivery is **at least once** — on every path (URL, `getUpdates`, WebSocket): an event can arrive twice (your receiver
answered after the timeout, the URL was changed while a delivery was in flight, the bot restarted before acknowledging).
Deduplicate by `update_id`; the SDK does it for you.

```sh
curl -sS "$GV_API/setWebhook" -H "Authorization: Bot $GV_TOKEN" \
  -d url=https://bot.example.org/gusvoice -d secret_token=a-long-random-string-of-16-characters-or-more
```

The request to your URL:

```
POST /gusvoice HTTP/1.1
Content-Type: application/json
User-Agent: GusVoice-Bot-Webhook/1
X-GusVoice-Signature: t=1761475200,v1=9f2c…(hex)

{"update_id":102,"message":{…}}
```

- The body is one **Update** object. Events go **one at a time, strictly in order**: the next only after a `2xx` for the
  previous one.
- **A `2xx` answer** = "received", the event is deleted. The response body does not matter. Any other status, a connection
  error or silence for more than **10 seconds** is a failure. Redirects are not followed (`3xx` is a failure too).
- **Retries:** after a failure a pause of 5 s, then 10, 20, 40 … but at most 10 minutes between attempts. After **10
  consecutive failures** the server switches delivery off: `getWebhookInfo` shows `disabled_date` and events pile up in the
  journal (24 hours). Delivery is turned on again by a new `setWebhook`. A successful answer resets the counter.
- At most 4 KB of the response is read — answer briefly.

#### The signature is mandatory — verify it

Header `X-GusVoice-Signature: t=<unix time>,v1=<hex>`, where

```
v1 = HEX( HMAC-SHA256( key = secret_token, data = t + "." + request_body ) )
```

`request_body` is the **raw bytes** as received (not re-serialized JSON). What to check:

1. recompute the HMAC and compare it with `v1` using a constant-time function;
2. `|now − t| ≤ 300` seconds — otherwise the request may have been intercepted and replayed later.

**Why the signature is mandatory.** A bot's URL is an ordinary public URL anyone may find. Without a signature anyone can
send it a made-up event "command `/restart` from the owner" — and the bot would run it. The signature proves GusVoice
made the request, not a stranger; the secret is known only to you and the server. That is why `secret_token` is required
here (in Telegram it is optional only because of legacy bots).

Ready-made checks are in the [examples](#python-requests-no-sdk) below.

#### SSRF protection

Delivery is an outgoing request from **our** server to an address you supplied. So that it cannot be used to reach the
instance's internal network, the server:

- accepts only `https://` (`http://` only if the administrator turned on "internal addresses");
- rejects addresses with a login and password;
- checks **every** IP a name resolves to and connects strictly to the checked one;
- forbids private networks, loopback, link-local, CGNAT, special ranges and the cloud metadata address `169.254.169.254` by
  default. "Internal addresses" opens **only the local network** (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`…);
  loopback (`127.0.0.0/8`, `::1`, `::ffff:127.x` — the server itself), `0.0.0.0/8`, `169.254.0.0/16`, multicast and
  reserved ranges stay forbidden always;
- does not follow redirects and limits the response time (10 s) and size (4 KB).

If your bot lives in the same local network as the server, ask the administrator to turn on "Allow delivery to internal
addresses" — or use polling/WebSocket, which do not need it. A bot on the server machine itself (`localhost`) cannot
receive URL delivery at all: use polling or WebSocket.

### "Read" receipts

The person sees ✓✓ under a message sent to the bot **at the moment the bot took the event**: `getUpdates` returned it, or an
`ack` / `?offset=` arrived over WebSocket, or your URL answered `2xx`. Not when the bot replied — as in Telegram. Edits,
deletions and `my_chat_member` do not move the receipt. A message sent by the bot also marks the conversation read up to
that moment.

### Limits

| What | Limit |
|---|---|
| Bot API requests from one IP | 600 per minute (counted before the token check) |
| Requests of one bot | 30 per second |
| Sending and editing in one conversation | 5 per 5 seconds (≈ 1 per second with room for a burst) |
| `getUpdates` and WebSocket connections | 30 per 10 seconds per bot |
| WebSockets per bot | 3 at a time |
| JSON/form body | 64 KB |
| Files per message / file size | 10 / 25 MB |
| Message text | 4096 characters |
| Cards per message | 10 (total card text up to 6000 characters) |
| Event journal | 24 hours, up to 1000 per bot |
| `getUpdates` wait (`timeout`) | up to 50 seconds |
| `getUpdates` `limit` | up to 100 |
| Buttons | 8 in a row, 100 per message; `callback_data` up to 64 bytes; button text up to 64 characters |
| Button presses | a person: 10 per 5 seconds and 3 waiting at a time; a bot: 60 per 10 seconds and 20 unanswered |
| Answer to a press | once, within 15 seconds; `text` up to 200 characters |
| Commands (`setMyCommands`) | 100; name 1–32 `a-z 0-9 _`, description 1–256 |

On `429` wait `retry_after` seconds and retry. Do not hammer: if you need to send many messages, put them in a queue.

### Privacy

- **A new bot is private.** Only its owner can open a conversation with it and write to it. To let others use the bot,
  turn on **"Available to everyone"** («Доступен всем») in My bots. A public bot can be found in people search; a private one
  only by its owner.
- The check is made on **every send**, not only when the conversation is opened: if a bot becomes private again or is
  disabled, people who already have a conversation with it get `403` when sending (text, files, voice, forwarding into the
  conversation, scheduled messages, button presses), and the app shows a notice instead of the message field. The bot gets
  no events from them.
- A bot sees only what is written **to it in DMs**. Nothing else: no servers, no channels, no other conversations.
- A bot **does not write first** (anti-spam, as in Telegram): it has no way to create a conversation, only to reply in an
  already open one.
- Bots are not added to groups and do not federate (stage 1).
- The instance administrator sees all bots and can disable any with one press. If the owner's account is deleted, their bots
  are deleted too; messages the bot already wrote stay in the conversations.

### Security for bot authors

- **Check `from.id`.** A server-control bot without a check will run `/restart` for **anyone** who managed to message it.
  Keep your id (`getUpdates` shows it in an event from you) in an environment variable or a list and ignore everyone
  else. A username can be changed, an id cannot — check the id.
- **Keep the bot private** unless it has to be public: turn on "Available to everyone" only if the `from.id` check exists.
- **The token is a password.** Keep it in an environment variable or a secrets store, not in code, a repository, chats or
  screenshots. The `gvb_` prefix lets secret scanners (including GitHub's) recognise a leak. If it leaks, press "Reissue
  token" in My bots: the old one stops working at once and open WebSockets close.
- **Verify the signature** of URL deliveries and the time window (see above).
- Never run message text as a shell command, and never put it into one without an allow-list:
  `/restart ; rm -rf /` must run into a list of allowed names.
- **Buttons are not a secret channel.** `callback_data` is visible to the person's client and comes from it. The server
  guarantees only that it equals a button of the current message; still check `from.id` on every press and re-check
  values taken from `data` (service names, ids) against your allow-list. Never put tokens or secrets into `callback_data`.

### Buttons and commands (stage 2)

**Buttons.** Pass `reply_markup` to `sendMessage` (or `editMessageText` / `editMessageReplyMarkup`). A press reaches the
bot as a `callback_query` event; answer with `answerCallbackQuery` (even with no text — that switches off the "clock" on
the button). A typical panel edits its own message in place:

```sh
curl -sS "$GV_API/sendMessage" -H "Authorization: Bot $GV_TOKEN" -H 'content-type: application/json' -d '{
  "chat_id": "<chat_id>", "text": "Server panel",
  "reply_markup": {"inline_keyboard": [[{"text":"Status","callback_data":"st"},{"text":"Restart…","callback_data":"rs"}]]}}'
# a press arrives:  {"update_id":…,"callback_query":{"id":"cbq_…","from":{…},"message":{…},"data":"rs","date":…}}
curl -sS "$GV_API/answerCallbackQuery" -H "Authorization: Bot $GV_TOKEN" -d callback_query_id=cbq_… -d text="Restarting…"
```

Rules that differ from what you might expect:

- 🔴 **`editMessageText` without `reply_markup` removes the buttons** — exactly like Telegram. To keep them, pass them again.
- A press is accepted only for a button that is **in the message right now**: the server compares `data` with the current
  buttons. Old buttons (you replaced the keyboard) and made-up `data` are rejected before they reach you.
- A `callback_query` older than **25 seconds** is **not delivered** (not by `getUpdates`, WebSocket or URL delivery): a
  bot that was down for an hour must not run an old "Restart" press when it starts.
- Old GusVoice clients do not show buttons — the message text stays readable. Keep the essentials reachable by commands
  too (`/status`, `/restart nginx`).

**Commands.** `setMyCommands` publishes the list for the `/` hint. Commands are not a separate event: the person's choice
inserts `/status ` into the message box, they send it, you get an ordinary `message`.

---

## Examples

In the examples `GV_API` is the API address, e.g. `https://chat.example.com`; `GV_BOT_TOKEN` is the bot's token;
`GV_OWNER_ID` is your `id` (take it from `from.id` of any event from you).

### curl

```sh
# A notification from cron / a script (take chat_id once from getUpdates)
curl -sS --fail-with-body "$GV_API/api/bot/v1/sendMessage" \
  -H "Authorization: Bot $GV_BOT_TOKEN" \
  -d chat_id="$CHAT_ID" --data-urlencode "text=Backup finished: $(date +%F)"

# JSON with a card
curl -sS "$GV_API/api/bot/v1/sendMessage" -H "Authorization: Bot $GV_BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"'"$CHAT_ID"'","embeds":[{"title":"Disk /","description":"Used: **91%**","color":15158332}]}'

# Edit and delete
curl -sS "$GV_API/api/bot/v1/editMessageText" -H "Authorization: Bot $GV_BOT_TOKEN" -d chat_id="$CHAT_ID" -d message_id="$MSG_ID" -d text="Done"
curl -sS "$GV_API/api/bot/v1/deleteMessage"   -H "Authorization: Bot $GV_BOT_TOKEN" -d chat_id="$CHAT_ID" -d message_id="$MSG_ID"
```

### Python (requests, no SDK)

A long-polling bot that answers only its owner and survives `429` and network failures:

```python
import os
import time

import requests

API = os.environ["GV_API"] + "/api/bot/v1"          # e.g. https://chat.example.com/api/bot/v1
TOKEN = os.environ["GV_BOT_TOKEN"]
OWNER_ID = os.environ["GV_OWNER_ID"]                 # your id: only you may give commands
S = requests.Session()
S.headers["Authorization"] = f"Bot {TOKEN}"


def call(method, **params):
    while True:
        r = S.post(f"{API}/{method}", json=params, timeout=70)
        data = r.json()
        if data.get("ok"):
            return data["result"]
        if data["error_code"] == 429:                # rate limit: wait and retry
            time.sleep(data.get("retry_after", 1))
            continue
        raise RuntimeError(f'{data["error_code"]} {data["description"]}')


def handle(msg):
    if msg["from"]["id"] != OWNER_ID:                # never remove this check
        return
    text = msg.get("text", "")
    if text == "/start":
        call("sendMessage", chat_id=msg["chat"]["id"], text="Ready. Try /ping")
    elif text == "/ping":
        call("sendMessage", chat_id=msg["chat"]["id"], text="pong")


offset = 0
while True:
    try:
        updates = call("getUpdates", offset=offset, timeout=30)
    except (requests.RequestException, RuntimeError) as e:
        print("poll failed:", e)
        time.sleep(5)
        continue
    for u in updates:
        offset = u["update_id"] + 1                  # confirms everything before it
        if "message" in u:
            handle(u["message"])
```

Receiving URL deliveries with signature verification (standard library):

```python
import hashlib
import hmac
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = "the-same-secret_token-as-in-setWebhook"


def verify(secret: str, header: str, body: bytes, tolerance: int = 300) -> bool:
    try:
        parts = dict(p.split("=", 1) for p in header.split(","))
        t, sig = int(parts["t"]), parts["v1"]
    except (KeyError, ValueError):
        return False
    if abs(time.time() - t) > tolerance:             # replay protection
        return False
    mac = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, sig)


class Hook(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if not verify(SECRET, self.headers.get("X-GusVoice-Signature", ""), body):
            self.send_response(401)
            self.end_headers()
            return
        print("update:", body.decode())
        self.send_response(200)                      # 2xx = taken; anything else = retry later
        self.end_headers()


HTTPServer(("0.0.0.0", 8080), Hook).serve_forever()   # behind an https proxy (nginx, Caddy)
```

### Node.js (18+, no dependencies)

```js
// Long polling. Node 18+, built-in fetch.
const API = `${process.env.GV_API}/api/bot/v1`;
const TOKEN = process.env.GV_BOT_TOKEN;
const OWNER_ID = process.env.GV_OWNER_ID; // your id: only you may give commands

async function call(method, params = {}) {
  for (;;) {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (data.ok) return data.result;
    if (data.error_code === 429) { // rate limit: wait and retry
      await new Promise((r) => setTimeout(r, (data.retry_after ?? 1) * 1000));
      continue;
    }
    throw new Error(`${data.error_code} ${data.description}`);
  }
}

let offset = 0;
for (;;) {
  let updates;
  try {
    updates = await call('getUpdates', { offset, timeout: 30 });
  } catch (e) {
    console.error('poll failed:', e.message);
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  for (const u of updates) {
    offset = u.update_id + 1; // confirms everything before it
    const m = u.message;
    if (!m || m.from.id !== OWNER_ID) continue; // never remove this check
    if (m.text === '/start') await call('sendMessage', { chat_id: m.chat.id, text: 'Ready. Try /ping' });
    else if (m.text === '/ping') await call('sendMessage', { chat_id: m.chat.id, text: 'pong' });
  }
}
```

Verifying the signature of URL deliveries:

```js
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.GV_HOOK_SECRET; // the same secret_token as in setWebhook

function verify(secret, header, rawBody, tolerance = 300) {
  const p = Object.fromEntries((header ?? '').split(',').map((kv) => kv.split('=')));
  const t = Number(p.t);
  if (!Number.isInteger(t) || !p.v1 || Math.abs(Date.now() / 1000 - t) > tolerance) return false;
  const mac = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  const got = Buffer.from(p.v1, 'hex');
  return got.length === mac.length && timingSafeEqual(got, mac);
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks); // sign the raw bytes, not re-serialized JSON
  if (!verify(SECRET, req.headers['x-gusvoice-signature'], raw)) {
    res.writeHead(401).end();
    return;
  }
  console.log('update:', JSON.parse(raw.toString('utf8')));
  res.writeHead(200).end(); // 2xx = taken; anything else = retry later
}).listen(8080);
```

WebSocket (Node, the `ws` package):

```js
import WebSocket from 'ws';

let offset = 0;
function connect() {
  const url = `${process.env.GV_API.replace(/^http/, 'ws')}/api/bot/v1/ws?offset=${offset}`;
  const ws = new WebSocket(url, { headers: { Authorization: `Bot ${process.env.GV_BOT_TOKEN}` } });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.op === 'hello') console.log('connected as', msg.bot.username);
    if (msg.op === 'update') {
      console.log('update', JSON.stringify(msg.update));
      offset = msg.update.update_id + 1;
      ws.send(JSON.stringify({ op: 'ack', offset })); // confirms everything before it
    }
  });
  ws.on('close', (code, reason) => {
    console.log('closed', code, reason.toString());
    if (code === 4001 || code === 4003 || code === 4009) return; // fix the cause first
    setTimeout(connect, 3000);
  });
  ws.on('error', () => {});
}
connect();
```

---

## Official SDK

A TypeScript/Node package `@gusvoice/bot` is being prepared: typed methods and events, a long-polling runner with
reconnects and `429` handling, and a URL-delivery handler with signature verification. Sources —
[`packages/bot-sdk`](../packages/bot-sdk); its description will be added here once the first version ships. You do not
need it yet: everything above works over plain HTTP.

---

## Bots on servers (API 3)

Since `api_version` 3 (`getMe.features` contains `servers`) a bot can live on servers: post to text channels, attach buttons, answer commands, moderate.

**Adding a bot.** An admin with "Manage server" opens "Server settings → Integrations → Bots → Add bot" and types the bot's username. A public bot can be added by any such admin, a private one only by its owner. The server gets a **bot role** named after the bot: its permissions never exceed the adding admin's and **never** include Administrator. The role cannot be deleted or given to anyone else; its permissions are edited in "Roles" like any role. At most 20 bots per server. Removal: "Remove from server", kicking or banning the bot, `leaveChat`, or the bot owner via "My bots → Servers → Remove". The role goes with the bot, and the bot's queued events of that server are deleted.

**Chats.** `chat.type`: `dm` — 1:1 chat, `channel` — text channel (`server_id`, `title`), `server` — the server itself (membership events and `getChat` only). 🔴 **Check `chat.type`**: code that assumed `type === 'dm'` will now see other values. Message methods take a DM or channel `chat_id`; a server id → `400 chat is a server; use a channel id`, a voice channel → `400 chat is not a text channel`, foreign or invisible → `400 chat not found`.

**Privacy.** By default a bot receives from a channel only: commands (`/cmd@your_bot` — you; `/cmd@other` — not you; plain `/cmd` — every bot of the channel), a personal `@your_bot` mention (`@everyone`/`@here` do not count), a mention of the bot role, and replies to the bot's messages. The "Read all messages" checkbox lifts the filter. The filter runs on the server BEFORE the event is stored. Edits are filtered by the NEW text. Messages of **other bots** never arrive (loop protection); webhook messages — only to "read all" bots. A bot only sees channels where its role has "View channel".

**Updates**: `message`, `edited_message`, `message_deleted` (read-all bots and the author), `callback_query` (`message.chat.type === 'channel'`), `message_reaction` (`old_reaction`/`new_reaction` of that person; read-all bots and the message author; in DMs — any message of the chat), `chat_member` (someone joined/left/was kicked/banned/unbanned — all bots of the server), `my_chat_member` (the bot itself was added/removed/banned; `chat.type === 'server'`). Statuses: `creator`, `member`, `left`, `kicked`. Pins, polls and stickers produce no updates. Ordering across server processes is not guaranteed.

**Guests from other instances** carry `instance_domain` in `from`/`user`; usernames may collide with local ones — authorize by `from.id`.

**Methods.** The stage 1–2 message methods work in channels (channel files are public, like webhook files; `client_id` is ignored in channels for now). New: `setMessageReaction` (also in DMs; the set is replaced, 0–3 emoji), `pinChatMessage`/`unpinChatMessage` ("Manage messages"), `getChatMember`, `getChatMemberCount`, `getChatMembers` (`offset`, `limit` ≤ 200), `getMyServers`, `getServer` (visible channels with `can_send`, roles with `managed`), `getChatHistory` (read-all bots with "Read history" only), `addChatMemberRole`/`removeChatMemberRole` ("Manage roles", role below the bot's), `banChatMember`/`unbanChatMember`/`kickChatMember` (the matching permission, target below the bot), `leaveChat`.

**Commands**: `scope: {type: 'all_group_chats'}` — the list for servers; servers use it if set, otherwise `default`; DMs use `all_private_chats`, otherwise `default`.

**Text format**: without `parse_mode` — our markers; `parse_mode: 'HTML'` — a Telegram subset converted to our markers; `MarkdownV2` → 400.

**Limits**: 5 messages / 5 s per channel, 30 / min per server; history and roster — 10 / 10 s. A read-all bot's queue holds up to 10 000 updates (otherwise 1000); dropped ones are counted in `dropped_update_count` (`getMe`, `getWebhookInfo`).

**Batched webhook delivery**: `setWebhook(…, batch: true)` — the POST body becomes an array of up to 100 updates, signed as a whole; a 2xx confirms the whole batch, anything else retries it. The SDK accepts both shapes.

## Voice (API 4)

Since `api_version` 4 (`getMe.features` contains `voice`) a bot can **play audio in a voice channel** (music bots, TTS,
timers). It **never hears people**: the server mints its LiveKit token with `canSubscribe: false`, so not a single human
track reaches the bot — not even with a modified SDK. A bot publishes only one microphone track: no camera, no screen, no
data messages, no attributes.

**Enabling.** The instance admin switch "Bots can join voice channels" (`PUT /admin/bots/settings` `{voice}`; no field = on,
the global bots switch is off by default anyway). Turning it off drops every bot from every room. On the server, the bot's
role needs "View channel", **"Connect"** and **"Speak"** in that channel.

**Methods.**
- `joinVoice(chat_id, bitrate?)` — `bitrate` 24000–128000, default 64000 (echoed back in `audio`). Returns
  `{url, token, room, chat, server_muted, expires_in, audio: {sample_rate: 48000, channels: 2, bitrate}}`: connect to LiveKit
  at `url` with `token` (lives 10 minutes; LiveKit refreshes it while the session is alive, after a full drop call
  `joinVoice` again) and publish PCM 48 kHz stereo as a `MICROPHONE` track. `chat.type === 'voice'`. One voice channel per
  server: joining another channel of the same server moves the bot (the old room is closed). Errors, in this order:
  `403 voice is disabled for bots on this server`, `400 chat not found`, `400 chat is a server; use a channel id`,
  `400 chat is not a voice channel`, `403 not enough rights to connect to the voice chat`,
  `403 not enough rights to speak in the voice chat`, `429` (6 joins / min), `400 too many bots in the voice chat`
  (3 bots per channel), `400 too many active voice chats` (10 channels per bot).
- `leaveVoice(chat_id?)` — leave that channel, or all of them without `chat_id`. Idempotent: always `true`.
- `getVoiceChatMembers(chat_id)` — who is in the channel now: `[{user, muted, deafened, server_muted, is_bot}]` (the same
  source the app shows). 30 / min per server.

**Update `voice_state`** — `{chat, user, action: 'joined'|'left', date, move_to?}` goes to every live bot of the server that
can see the channel, including the bot's own joins and leaves (so it learns it was disconnected). `move_to` comes only to the
bot itself when a moderator moved it: the SDK then joins `move_to` on its own. A person on a flaky network may produce
`left` → `joined` within seconds.

**Moderation.** Moderators server-mute (the microphone grant is revoked; unmute restores it), disconnect and move a bot
through the usual voice menu; moving checks the bot's rights in the target channel (`403 the bot can't connect to that
channel`). Pokes and shop rewards are not available for bots (`400 bots don't accept this`). Every listener has their own
volume for the bot and "Mute for me".

**The server drops a bot** from voice when it is disabled, its token is reissued, it is deleted, removed/kicked/banned from
the server, voice for bots is switched off, it lost "Connect"/"Speak" (within a minute), or **it has been alone in the
channel (no people) for 5 minutes**. A dropped bot gets `voice_state left`; the SDK does not reconnect after such a
removal. Come back on a person's `voice_state joined` if you want "radio" behaviour.

**Bots of other instances** cannot join our voice channels (Bot API lives on the bot's home instance only); guests from
other instances in our channel hear our bot like any participant. Copyright of what the bot plays is on the bot's and the
server's owner.

## Differences from Telegram

The idea is the same (`getUpdates`/`setWebhook`, `{ok, result}`, `offset`), so someone who knows Telegram picks it up fast.

| Telegram | GusVoice |
|---|---|
| Token in the URL `/bot<token>/method` | Token in the header `Authorization: Bot <token>`, URL `/api/bot/v1/method` |
| BotFather issues tokens through commands | "My bots" issues tokens with buttons |
| `chat_id`, `message_id`, `user.id` are numbers | Strings (UUIDs) |
| `chat.type` is `private`, `group`, … | `dm`, `channel`, `server`, `voice` |
| `update_id` are consecutive | Increasing with gaps (one counter per instance): acknowledge `last + 1`, do not expect `+1` |
| Webhook `secret_token` is optional and sent as a header | **Required** (≥ 16 characters); it is the key of the HMAC signature `X-GusVoice-Signature` |
| Webhook — `https`, ports 443/80/88/8443 | `https`, any port; `http` and internal addresses only if the administrator allows |
| `parse_mode` (Markdown/HTML) | Without it — GusVoice's own markup; `HTML` — a Telegram subset; `MarkdownV2` → `400` |
| `sendPhoto`, `sendDocument`, … | One `sendMessage` with `files[0]…files[9]` (multipart) |
| `getFile` | A link right in `attachments[].url` |
| `reply_to_message_id` | The same field name |
| `allowed_updates` | Only on `getUpdates` (all kinds arrive over WebSocket) |
| `my_chat_member` | Present: `member`/`left`/`kicked` of a direct conversation |
| — | There is `message_deleted` |
| Command menu (`setMyCommands`) | Present; `scope` — only `default`/`all_private_chats`/`all_group_chats`, no `language_code`. A command arrives as an ordinary message `/status` |
| Buttons under messages (`inline_keyboard`), `callback_query` | Present: `callback_data` and `url` buttons only; no `chat_instance`/`inline_message_id` in `callback_query` |
| `editMessageText` without `reply_markup` removes the buttons | The same |
| `editMessageReplyMarkup` with no changes → `400 message is not modified` | Returns the message, no error |
| `answerCallbackQuery` with `url`, `cache_time` | Not yet: `text` and `show_alert` only |
| An unanswered press — the client waits for the server | 15 seconds, then the person sees "the bot did not answer"; presses older than 25 s are not delivered |
| Any `callback_data` from a modified client reaches the bot | Only the `callback_data` of a button currently under the message; anything else is rejected by the server |
| Bots in groups and channels | On servers (channels); no group conversations for bots |
| Privacy mode in groups | As in Telegram: commands, mentions and replies to the bot; everything — only with "Read all messages" |
| Voice chats | Present: the bot plays audio (`joinVoice`, `@gusvoice/bot-voice`), never hears people |
| Bots talk to anyone who pressed Start | A new bot is private; the owner turns on "Available to everyone" |
| A bot may write if the person once started it | A bot writes only into an already open conversation and cannot create one |

---

## FAQ

**`getMe` answers `401`.** The token is wrong, was reissued, the bot is disabled by the administrator, or the header is
not of the form `Authorization: Bot <token>` (the word `Bot`, not `Bearer`).

**`403 bots are disabled on this instance`.** The administrator switched bots off on the instance (Admin panel → Bots).

**`400 chat not found` on `sendMessage`.** The person has not opened the conversation with the bot, or `chat_id` is not
from this bot. Open the conversation in the app and take `chat.id` from an event.

**`getUpdates` returns `409`.** A delivery URL is set — call `deleteWebhook` if you want polling. Or `terminated by other
getUpdates request`: another copy of the bot with the same token started polling or connected over WebSocket — keep one.

**Events keep arriving again and again.** You are not acknowledging them: pass `offset = last update_id + 1`.

**The bot answers twice.** Delivery is at least once — deduplicate by `update_id`. Two instances with one token no longer
share events: the newer one replaces the older (`409`/`4009`).

**A message arrived but there is no event.** The bot or bots are disabled; the bot is private and the sender is not the owner
(they cannot open the conversation); a delivery URL is set and broken (see `getWebhookInfo`); events older than 24 hours leave the journal.

**URL delivery stopped.** `getWebhookInfo` shows `disabled_date` and `last_error_message`. Fix the receiver and call
`setWebhook` again.

**`setWebhook` answers `bad webhook: адрес внутренний`** ("address is internal"). The name resolves to an internal IP and the
administrator has not allowed internal addresses. Use a public address, polling or WebSocket, or ask for "Allow delivery to
internal addresses" to be turned on.

**How do I find my `id`?** Send the bot any message and look at `from.id` in the `message` event.

**The token leaked.** My bots → your bot → "Reissue token". The old one stops working at once.

**Can I delete a bot?** Yes: My bots → "Delete bot" («Удалить бота»). The token dies, events and the URL are removed,
the bot's messages stay in the conversations.

**What does "v1" mean?** This document describes Bot API v1. It changes only by additions: new fields, methods and event
kinds appear, old ones do not break. Skip unknown fields and events quietly and your bot will survive instance updates.
A breaking change, if ever needed, will ship as `v2` next to `v1`.
