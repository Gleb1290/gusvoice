# Incoming webhooks

> Русская версия: [webhooks.ru.md](webhooks.ru.md)

An incoming webhook is a secret URL that lets an external program — a CI pipeline, a monitoring system,
your own script — post messages into a GusVoice **text channel** without logging in. The request format
follows Discord's "Execute Webhook", so most existing Discord integrations work after you swap the URL
(see [Differences from Discord](#differences-from-discord) for what does not carry over).

Messages from a webhook show the webhook's name and avatar and carry a **WEBHOOK** tag (`ВЕБХУК`) next to the name.

The GusVoice interface is in Russian; interface labels below are given in English with the original
in brackets.
A webhook has no profile and cannot be messaged directly.

---

## Creating a webhook

**Who can:** anyone with the **Manage webhooks** («Управление вебхуками») permission on that channel (server owner, administrators,
or a role that has it; channel permission overrides apply). The permission is not granted to `@everyone`
by default.

**Where:**

- **Channel settings → Webhooks** («Вебхуки»; the pencil next to a text channel; members who have Manage webhooks but
  not Manage channels get a "Channel webhooks" («Вебхуки канала») item in the channel's context menu instead).
- **Server settings → Integrations** («Интеграции») — all webhooks of the server in channels where you have both
  *View channel* and *Manage webhooks*, plus "New webhook" («Новый вебхук») with a channel picker.

Webhooks exist only for **text** channels. A channel can have at most **15** webhooks.

**The URL is shown once.** Right after you click "New webhook" the editor shows the full URL with a
"Copy" («Скопировать») button. The server stores only a SHA-256 hash of the token, so the URL cannot be shown again later.
If you lost it, press **New URL** («Новый адрес»): a new token is issued and the old URL stops working immediately.

In the editor you can also:

- rename the webhook (1–80 characters) — this is the default author name of its messages;
- upload an avatar (PNG, JPEG, WEBP or GIF, up to 512 KB) or remove it;
- move it to another text channel of the same server (you need Manage webhooks on both channels);
  the URL stays the same;
- **Delete webhook** («Удалить вебхук») — the URL dies at once; messages it already posted stay in the channel.

Renaming or changing the avatar does not rewrite history: each message keeps the name and avatar it was
posted with. Creating, editing, re-issuing the URL and deleting are recorded in the server audit log.

---

## Request

```
POST https://api.example.com/api/webhooks/<id>/<token>
```

- `api.example.com` is your instance's **API** host (not the web client host). Just copy the URL from the
  webhook editor — it is already complete.
- `<id>` — webhook id (UUID), `<token>` — 43-character secret (`A–Z a–z 0–9 _ -`).
- No `Authorization` header is needed: the token in the path *is* the credential.
- Body: `application/json` (up to **64 KB**) or `multipart/form-data` (to attach files).
- Query parameter `wait`:
  - absent or `wait=false` → **204 No Content**;
  - `wait=true` → **200 OK** with the created message as JSON (see [Response](#responses-and-errors)).
  - Only the literal strings `true` and `false` are accepted; `wait=1` is a 400.

### JSON body

All fields are optional, but the message must end up with at least one of: non-blank `content`, a
non-empty embed, or a file. Unknown fields (`tts`, `flags`, `components`, `thread_name`, `poll`, …) are
silently ignored, so programs written for Discord do not fail on them.

| Field | Type | Limits and behaviour |
|---|---|---|
| `content` | string | Up to **4096** characters (UTF-16 code units). Leading/trailing whitespace is trimmed. Rendered with GusVoice's own Markdown subset, the same as a message typed by a person. |
| `username` | string | Overrides the author name for this one message. After trimming it must be 1–80 characters; otherwise it is **silently ignored** and the webhook's name is used (strings over 320 characters are a 400). |
| `avatar_url` | string | Overrides the avatar for this one message, **only** if the URL points to this instance's own media storage (for example an avatar or attachment already uploaded here). Any other URL is silently ignored — external images are never loaded into the feed (they would act as tracking pixels). Max 2048 characters. |
| `embeds` | array | Up to **10** cards, see [Embeds](#embeds). |
| `allowed_mentions` | object | Narrows who the message may notify, see [Mentions](#mentions). |

### Embeds

The embed object follows Discord's Embed Object. Accepted fields and limits:

| Field | Limit | Notes |
|---|---|---|
| `title` | 256 | Collapsed to one line. |
| `url` | 2048 | Makes the title a link. Only `http://` / `https://`; anything else is dropped. |
| `description` | 4096 | Our Markdown, like a normal message. |
| `color` | integer | `0x000000`–`0xFFFFFF` (decimal in JSON, e.g. `3066993`). Out of range → no colour stripe. A string such as `"#2ecc71"` is a **400**. |
| `timestamp` | 64 | Any date string `Date.parse` understands (ISO 8601 recommended); normalised to ISO. Unparseable → dropped. |
| `fields[]` | up to 25 | Each `{ "name": ≤256, "value": ≤1024, "inline": bool }`. `name` and `value` are required keys; a field where both are empty is dropped. |
| `author` | | `{ "name": ≤256 (required), "url": ≤2048, "icon_url": ≤2048 }` |
| `footer` | | `{ "text": ≤2048 (required), "icon_url": ≤2048 }` |
| `image` | | `{ "url": ≤2048 }` |
| `thumbnail` | | `{ "url": ≤2048 }` |

- The **combined text** of all embeds in one message (`title` + `description` + field names and values +
  `footer.text` + `author.name`) must not exceed **6000** characters — otherwise 400.
- Other Discord embed keys (`video`, `provider`, `type`) are ignored. Empty embeds are dropped.
- The colour of the stripe, title link, fields (inline fields sit side by side), footer and time are shown
  as a card under the message. A click on a linked title or author name opens an "Open link?" («Открыть ссылку?») prompt that
  shows the full address, because the label may not match the URL.

**Images in embeds.** GusVoice never makes a reader's client fetch a third-party image.

| URL in `image.url` / `thumbnail.url` | Result |
|---|---|
| `attachment://<filename>` | The file with that name from the same multipart request — shown as an image. |
| A URL in this instance's media storage | Shown as an image. |
| Any other `https://` URL | **Not loaded.** Shown as a plain clickable link under the card. |
| `http://`, `data:`, anything else | Dropped. |

`author.icon_url` and `footer.icon_url` are shown only for `attachment://` and own-storage URLs; other
values are dropped (no link fallback).

**Older clients.** If a message has embeds but no `content`, the server also stores a plain-text version of
the cards (a quote block) in `content` so that older GusVoice clients still show something. Current clients
draw the cards and hide that text. In the `wait=true` response such a message has `"embedsFallback": true`.

### Files (multipart/form-data)

Send `multipart/form-data` with:

- **`payload_json`** — the same JSON body as above, as a string (embeds and `allowed_mentions` are only
  possible this way). If `payload_json` is present, other text parts are ignored.
- *or*, without `payload_json`, the plain text parts **`content`**, **`username`**, **`avatar_url`**.
- **files** in parts named `files[0]` … `files[9]` (Discord style); the legacy names `file`, `file1`, `file2`, …
  are accepted too. A file in a part with any other name → **400**.

Limits:

| | |
|---|---|
| Files per message | **10** (11th → 413 `reach files limit`) |
| Size per file | **25 MB** (larger → 413) |
| Text parts | 8 parts, each up to 64 KB |
| Blocked types | **SVG and HTML** (`image/svg+xml`, `text/html`, `application/xhtml+xml`, or extensions `.svg`, `.html`, `.htm`, `.xhtml`) → **415** |
| Upload rate | 15 files per minute per webhook (shared with the message limit below) |

Files become ordinary message attachments. The original filename and the part's `Content-Type` are
kept, so set a correct type (`curl -F "files[0]=@chart.png;type=image/png"`); images are previewed
inline as with any attachment. To show an uploaded image inside a card, reference it as
`attachment://<filename>` — the name must match the uploaded filename exactly (case-sensitive).

Note: the 64 KB body limit applies to JSON requests only; for multipart the per-file and per-part limits
above apply. A reverse proxy in front of the instance may impose its own upload limit.

### Mentions

Mentions in GusVoice are plain text: a person by their **username** (`@alice`), a role by its **name**
(`@Moderators`), plus `@everyone` and `@here`. Discord's id syntax (`<@123>`, `<@&456>`, `<#789>`) is not
parsed and appears as literal text.

**Default — like Discord:** without `allowed_mentions`, a webhook message notifies everyone it mentions:
`@everyone`, `@here`, any role (even roles not marked "mentionable") and people. The webhook is not limited
by the *Mention @everyone, @here and all roles* («Упоминать @everyone, @here и все роли») permission of the person who created it — whoever has the
URL can ping the whole channel. For automated messages it is good practice to send
`"allowed_mentions": { "parse": [] }`.

`allowed_mentions` narrows the default:

| Key | Meaning |
|---|---|
| `parse` | Array of kinds to take from the text: `"everyone"` (covers `@everyone` and `@here`), `"roles"`, `"users"`. Up to 8 items. |
| `roles` | Array of role **ids** that may be notified (used when `"roles"` is not in `parse`). Up to 100. |
| `users` | Array of user **ids** that may be notified (used when `"users"` is not in `parse`). Up to 100. |

Examples:

- `{ "parse": [] }` — nobody is notified.
- `{ "parse": ["users"] }` — people only; `@everyone`, `@here` and roles stay silent.
- `{ "parse": [], "roles": ["<role id>"] }` — only that role.

A suppressed mention still looks the same to readers (`@everyone`), but the server inserts a zero-width
space after `@`, so it does not highlight, ring or push. Mentions inside **embeds never notify** anyone.
Notified members receive the usual mention push notification.

---

## Responses and errors

**Success**

- `204 No Content` — posted (default).
- `200 OK` with `?wait=true` — the GusVoice message object, for example:

```json
{
  "id": "7d1e2c4a-…",
  "channelId": "2b9f0e61-…",
  "content": "Build #42 passed",
  "createdAt": "2026-10-26T07:05:57.583Z",
  "webhookId": "9a4c7b13-…",
  "attachments": [{ "url": "https://…", "name": "chart.png", "contentType": "image/png", "size": 110 }],
  "embeds": [{ "title": "Chart", "image": { "url": "https://…" } }],
  "author": { "id": "…", "username": "webhook:9a4c7b13-…", "displayName": "CI bot", "avatarUrl": null }
}
```

This is GusVoice's message format (camelCase), **not** Discord's message object. `attachments`, `embeds`,
`embedsFallback` appear only when present.

**Errors** — the body is always JSON `{ "error": "<text>" }`; validation errors also carry `details`
(the list of problems with `path`). The text is meant for humans (often in Russian) and may change —
branch on the **status code**, not the text.

| Status | When |
|---|---|
| 400 | Invalid JSON; a field over its limit or of the wrong type (`details[].path` says which, e.g. `content` too long: `"Слишком длинное сообщение: не больше 4096 знаков"`); embeds text over 6000; empty message (`"пустое сообщение: нужен content, embeds или файл"`); `wait` not `true`/`false`; `payload_json` is not JSON; a file in a part not named `files[n]`/`file`. |
| 404 | `{"error":"unknown webhook"}` — wrong id, wrong token, malformed token, deleted webhook, or the channel no longer exists / is no longer a text channel. All of these look the same on purpose. |
| 413 | JSON body over 64 KB (`Request body is too large`); file over 25 MB; more than 10 files (`reach files limit`); too many multipart parts. |
| 415 | Content type other than `application/json` / `multipart/form-data` (`application/x-www-form-urlencoded` is not supported); a blocked file type (SVG/HTML). |
| 429 | Rate limit, see below. Body `{"error":"…","retry_after":<seconds>}`, header `Retry-After: <seconds>`. |
| 503 | Files were sent but the instance has no media storage configured. |

Some checks run before the token is verified (body size, JSON syntax, unsupported content type), so a
request with a bad token can still get 400/413/415 instead of 404.

**Rate limits** (fixed one-minute windows):

- **30 requests per minute per webhook.** Every request with a valid URL counts, including ones rejected
  with 400.
- **120 requests per minute per client IP** across all webhook URLs, counted before anything else.
- **15 uploaded files per minute per webhook.** If this runs out in the middle of a multi-file request, the
  request fails with 429 and the message is not posted.

On 429 wait `retry_after` seconds (an integer, unlike Discord's float) and retry. There are no
`X-RateLimit-*` headers. Browsers on other sites cannot call the webhook at all (CORS), and the
`Retry-After` header is not exposed to browser code — webhooks are meant for servers and scripts.

---

## Examples

Keep the URL in a secret (environment variable, CI secret), never in the repository. Below it is
`$WEBHOOK_URL` = `https://api.example.com/api/webhooks/<id>/<token>`.

### curl — text

```sh
curl -sS -X POST "$WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -d '{"content": "Deploy finished", "allowed_mentions": {"parse": []}}'
```

### curl — embed (and get the message back)

```sh
curl -sS -X POST "$WEBHOOK_URL?wait=true" \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "CI",
    "embeds": [{
      "title": "Build #42 passed",
      "url": "https://ci.example.com/builds/42",
      "description": "All **12** checks are green",
      "color": 3066993,
      "fields": [
        { "name": "Branch", "value": "main", "inline": true },
        { "name": "Duration", "value": "4m 12s", "inline": true }
      ],
      "footer": { "text": "example-ci" },
      "timestamp": "2026-10-26T07:00:00Z"
    }],
    "allowed_mentions": { "parse": [] }
  }'
```

### curl — file (multipart)

```sh
curl -sS -X POST "$WEBHOOK_URL" \
  -F 'payload_json={"content": "Nightly report", "embeds": [{"title": "Load chart", "image": {"url": "attachment://chart.png"}}]}' \
  -F 'files[0]=@chart.png;type=image/png' \
  -F 'files[1]=@build.log;type=text/plain'
```

Without embeds the text can go in a plain part: `-F 'content=Nightly report' -F 'files[0]=@build.log'`.

### Python (requests)

```python
import json
import os

import requests

url = os.environ["WEBHOOK_URL"]

# Text + embed
r = requests.post(url, json={
    "content": "Backup finished",
    "embeds": [{"title": "db-backup", "description": "Size: 1.2 GB", "color": 0x2ECC71}],
    "allowed_mentions": {"parse": []},
}, timeout=10)
r.raise_for_status()  # 204

# File
with open("report.pdf", "rb") as f:
    r = requests.post(
        url,
        data={"payload_json": json.dumps({"content": "Weekly report"})},
        files={"files[0]": ("report.pdf", f, "application/pdf")},
        timeout=60,
    )
if r.status_code == 429:
    print("rate limited, retry in", r.json()["retry_after"], "s")
r.raise_for_status()
```

### Node.js (18+, built-in fetch)

```js
import { readFile } from 'node:fs/promises';

const url = process.env.WEBHOOK_URL;

// Text
let res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: 'Service is back up', allowed_mentions: { parse: [] } }),
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

// File + embed that shows it
const form = new FormData();
form.append('payload_json', JSON.stringify({
  embeds: [{ title: 'CPU, last 24 h', image: { url: 'attachment://cpu.png' } }],
}));
form.append('files[0]', new Blob([await readFile('cpu.png')], { type: 'image/png' }), 'cpu.png');
res = await fetch(`${url}?wait=true`, { method: 'POST', body: form });
console.log(res.status, await res.json());
```

### GitHub Actions

Store the URL as a repository secret `GUSVOICE_WEBHOOK_URL`, then add a step:

```yaml
- name: Notify GusVoice
  if: always()
  env:
    WEBHOOK_URL: ${{ secrets.GUSVOICE_WEBHOOK_URL }}
    STATUS: ${{ job.status }}
  run: |
    color=15158332; [ "$STATUS" = "success" ] && color=3066993
    jq -n \
      --arg title "$GITHUB_REPOSITORY: $GITHUB_WORKFLOW — $STATUS" \
      --arg url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
      --arg ref "$GITHUB_REF_NAME" --arg sha "${GITHUB_SHA::7}" --arg actor "$GITHUB_ACTOR" \
      --argjson color "$color" \
      '{embeds: [{title: $title, url: $url, color: $color,
                  fields: [{name: "Branch", value: $ref, inline: true},
                           {name: "Commit", value: $sha, inline: true},
                           {name: "By", value: $actor, inline: true}]}],
        allowed_mentions: {parse: []}}' \
    | curl -sS --fail-with-body -X POST "$WEBHOOK_URL" -H 'Content-Type: application/json' --data-binary @-
```

Building the JSON with `jq` keeps quotes and newlines in branch names or commit messages from breaking it.

GitHub's own repository webhooks (Settings → Webhooks) send GitHub's event format, which GusVoice does not
understand — use an Actions step like the one above instead.

---

## Differences from Discord

Works the same:

- `POST /api/webhooks/{id}/{token}`, `?wait=true` (200 + message) / 204 without it.
- `content`, `username`, `embeds` (Discord Embed Object, the same length limits, 10 per message,
  6000 total), `allowed_mentions` (`parse`, `roles`, `users`) with Discord's default (everything mentioned
  is notified).
- `multipart/form-data` with `payload_json` + `files[n]` (also legacy `file`/`fileN`), `attachment://name`
  in embeds.
- 15 webhooks per channel, about 30 messages per minute per webhook, unknown fields are ignored.

Different or missing:

| Discord | GusVoice |
|---|---|
| `avatar_url` with any image | Only an image from this instance's storage; others are ignored. |
| External images in embeds are proxied and shown | Not loaded; `image`/`thumbnail` become a link, external `icon_url` is dropped. |
| `username` longer than 80 → 400 | Ignored, the webhook's name is used. |
| Mentions `<@id>`, `<@&id>`, channel `<#id>`, `<t:…>` timestamps, custom emoji | Plain text; mentions are `@username` / `@RoleName`. |
| Masked links `[text](url)` in text | Not supported (a link that lies about its address is a phishing tool); write the URL itself. Use the embed `url` for a clickable title. |
| `wait=1`, `wait=True` | Only `true` / `false`. |
| `application/x-www-form-urlencoded` | 415. |
| `X-RateLimit-*` headers, fractional `retry_after` | Only `Retry-After` and integer `retry_after`. |
| Error body `{ "code", "message", "errors" }` | `{ "error", "details" }`. |
| Message object in snake_case | GusVoice message object (camelCase). |
| `GET /webhooks/{id}/{token}`; edit/delete messages via `/messages/{message_id}`; `thread_id` / `thread_name`; `tts`, `components`, `flags`, `poll` | Not supported (`tts`, `components`, … are ignored, the other routes return 404). |
| `/slack` and `/github` compatible endpoints | Not available. |
| Managing webhooks with a bot token | Only from the app (see below). |

If an existing integration only sends `content`/`embeds` as JSON or `payload_json` + `files[n]`, replacing the
URL is enough.

---

## Managing webhooks over the API

The app uses these endpoints; they require a logged-in user session (`Authorization: Bearer <session>`) and
the Manage webhooks permission on the channel. They are listed for completeness — normally use the UI.

| Method and path | What |
|---|---|
| `GET /api/channels/{channelId}/webhooks` | Webhooks of a channel. |
| `GET /api/servers/{serverId}/webhooks` | Webhooks of a server (channels where you can view and manage). |
| `POST /api/channels/{channelId}/webhooks` `{ "name": "…" }` | Create; the response (201) contains `token` — the only time it is returned. |
| `PATCH /api/webhooks/{id}` `{ "name"?, "channelId"?, "avatarUrl"?: null }` | Rename, move to another text channel, remove the avatar. |
| `POST /api/webhooks/{id}/avatar` (multipart `file`) | Set the avatar (PNG/JPEG/WEBP/GIF, ≤ 512 KB). |
| `POST /api/webhooks/{id}/token` | Issue a new token (returned once); the old URL stops working. |
| `DELETE /api/webhooks/{id}` | Delete (204); posted messages remain. |

---

## Security

- **The URL is a password.** Anyone who has it can post in the channel under the webhook's name and — by
  default — ping `@everyone`. Keep it in a secret store (CI secrets, environment variables, a vault); do not
  commit it, paste it in chats or put it in web pages or mobile apps.
- The server keeps only a SHA-256 hash of the token and compares it in constant time; a wrong id and a wrong
  token give the same 404, so the response does not reveal which webhooks exist.
- Send `"allowed_mentions": { "parse": [] }` unless the message really has to notify people.
- **If the URL leaks:** open the webhook (channel settings → Webhooks, or server settings → Integrations)
  and press **New URL** — the old one stops working immediately; put the new URL into your integration. If the
  webhook is no longer needed, delete it. Messages already posted can be removed by moderators like any
  other message, and the audit log shows who created the webhook and re-issued its URL.
- Messages from webhooks are always marked **WEBHOOK**, so a webhook cannot pass itself off as a member even
  with `username` set to someone's name.
