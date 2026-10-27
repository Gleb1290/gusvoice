# gusvoice-bot — GusVoice Bot API for Python

A thin client of the [GusVoice](../../README.md) Bot API on the **standard library only** (Python 3.9+, no
dependencies): every API method, long polling, webhook deliveries with signature check, inline buttons, retry on 429.
The full API reference is [`docs/bots.md`](../../docs/bots.md); the machine-readable schema is
[`docs/bot-api/openapi.json`](../../docs/bot-api/openapi.json) — the method wrappers here are generated from it.

Install: `pip install gusvoice-bot` (or from the source tree: `pip install ./packages/bot-sdk-py`, or copy the
`gusvoice_bot/` folder next to your bot — it has no dependencies).

## Quick start

```python
import os
from gusvoice_bot import Client

bot = Client(os.environ["BOT_TOKEN"], os.environ.get("GUSVOICE_URL", "https://voice.example.com"))

def on_update(update):
    msg = update.get("message")
    if msg and msg.get("text"):
        bot.send_message(msg["chat"]["id"], "You said: " + msg["text"])

bot.run_polling(on_update)
```

`base_url` is the instance site: the API address is read from `<site>/config.json` (`apiUrl`), like the web client
does (`discover=False` uses `base_url` as is). The token is the `gvb_…` string from the bot settings — keep it in the
environment, never in the code.

## What is inside

| | |
|---|---|
| `Client(token, base_url)` | One method per API call, generated: `send_message(chat_id, text, reply_markup=…, files=[…])`, `get_updates(…)`, `answer_callback_query(…)`, … `None` arguments are not sent; `**extra` passes parameters newer than the SDK. Any method by name: `call("sendMessage", {...})`. |
| 429 | Retried after `retry_after` up to `max_retries` (3) times if the wait is ≤ `max_retry_after` (60 s). Other errors raise `GusVoiceApiError(code, description, retry_after)`; network errors raise as they are. |
| `run_polling(handler)` | Long polling loop. The offset moves past an update only after `handler(update)` returned; 401/403/404/409 are fatal, everything else is retried (1 → 30 s). Stop with a `threading.Event` (`stop_event=`) or Ctrl+C. |
| `verify_signature(secret, header, raw_body)` | Webhook signature check: HMAC-SHA256, 5-minute window, constant-time comparison. `webhook_handler(secret, on_update)` is a ready request handler for `http.server`. |
| `InlineKeyboard` | Button builder with the server limits (`callback_data` ≤ 64 **bytes**, ≤ 8 per row, ≤ 100 total, http(s) links only). |
| `InputFile` | Attachment for `send_message(files=[…])`: a path, bytes or a binary file object (sent as `multipart/form-data`). |
| `AsyncClient` | `await`-able wrapper: each call runs in a worker thread (`asyncio.to_thread`). It is threads, not native async I/O. |
| `METHODS`, `UPDATE_TYPES`, `API_VERSION` | Method names → API level they appeared in; update kinds; API level of this SDK. |

Not included: WebSocket updates and voice — they need third-party packages; use polling or a webhook, or the
TypeScript SDK `@gusvoice/bot`.

## Webhook

```python
from http.server import ThreadingHTTPServer
from gusvoice_bot import webhook_handler

server = ThreadingHTTPServer(("127.0.0.1", 8081), webhook_handler(os.environ["WEBHOOK_SECRET"], on_update, path="/hook"))
server.serve_forever()
```

Register the address once with `bot.set_webhook(url, secret_token)`; put the server behind an HTTPS reverse proxy.
The handler answers 200 right away and then calls `on_update` — the server waits for the answer, keep it fast.

## Security

Check `update["message"]["from"]["id"]` (or `callback_query.from.id`) before doing anything privileged: anyone who can
write to the bot can send it a command. `callback_data` is visible to the person who presses the button — no secrets.

## Development

`_generated.py` is produced by `node scripts/gen-bot-api.mjs` from the OpenAPI document; CI fails if it is out of date.
Tests: `python -m unittest discover -s packages/bot-sdk-py/tests`.

License: MIT (see `LICENSE`).
