# Your own bot with an AI assistant: a step-by-step playbook

> Reference for people: [bots.md](bots.md) · the file to paste into an AI assistant: [bots-llm.md](bots-llm.md) ·
> Russian version: [bots-playbook.ru.md](bots-playbook.ru.md)

Who this is for: you are not a programmer (or have not written code for a long time), but you want a bot — for example, to
manage your VPS from GusVoice or to get notifications. The plan is simple: **create the bot in the app → give an AI
assistant the documentation and your request → run what it wrote → check it**. Below is every step and what to do if it
did not work.

What you need: a GusVoice account on an instance where the administrator has **enabled bots** (see
[Enabling bots](bots.md#enabling-bots-instance-administrator)); any AI assistant that writes code; a machine where the bot
will run around the clock (a VPS, a home server, a Raspberry Pi). For a quick try your own computer will do.

The app interface is in Russian; button names are given in English with the Russian label in «quotes».

---

## Step 1. Create the bot and get its token

1. Settings → **My bots** («Мои боты») → "Create bot" («Создать бота»).
2. Username — Latin letters **ending in `bot`**: `vps_panel_bot`. Name — anything, for example "VPS watchman".
3. **Copy the token right away** (it starts with `gvb_`). It is shown once. Put it in a password manager. Lost it —
   "Reissue token" («Перевыпустить токен»; the old one stops working).
4. Press "Open conversation" («Открыть беседу») → "Start". The bot stays silent for now — that is normal, there is no
   program yet.

The bot is **private**: only you can message it. Do not turn on "Available to everyone" («Доступен всем») until the bot
checks who is writing to it.

## Step 2. Find your id and the API address

- **API address** — the address of your instance, for example `https://chat.example.com` (the same as in webhook
  addresses). Ask the administrator if you do not know it.
- **Your id** — the bot needs it to obey only you. Get it like this (in a terminal on any machine with `curl`):

```sh
export GV_API=https://chat.example.com
export GV_BOT_TOKEN=gvb_...paste_the_token...
curl -sS "$GV_API/api/bot/v1/getUpdates?timeout=5" -H "Authorization: Bot $GV_BOT_TOKEN"
```

In the answer find `"from":{"id":"…"` — this is **your id** (a long string with dashes), and next to it
`"chat":{"id":"…"` — the id of your conversation with the bot (needed for notification scripts). If the answer is an empty
`"result":[]`, write `/start` to the bot and repeat.

> This command deletes nothing: the events stay in the journal until the bot's program acknowledges them (`offset`). But
> your messages to the bot get ✓✓ — "the bot took it".

## Step 3. Give the task to the AI assistant

1. Open a chat with an AI assistant (ChatGPT, Claude, Gemini, a local model — any).
2. **Paste the whole [`bots-llm.md`](bots-llm.md) file** ("Raw" button in the repository → select all → copy). Your
   instance also serves it at `$GV_API/api/bot/v1/llms.txt`. At the end of the file there are three ready-made requests
   (in Russian; the assistant understands them in any language).
3. Right after it paste **your request** — take a ready one from section 11 of the file and edit the bold parts (the list
   of allowed services, thresholds, time zone):

| I want | Template |
|---|---|
| Manage a VPS: `/status`, `/restart nginx`, only me | "Template 1 — VPS panel bot" («Шаблон 1 — бот-панель VPS») |
| Notifications from cron / scripts | "Template 2 — notification bot" («Шаблон 2 — бот-уведомлялка») |
| Reminders in a DM | "Template 3 — reminder bot" («Шаблон 3 — бот-напоминалка») |

"Template 1" already includes a **button** panel (`/panel`: "Status", "Restart… → service → Yes/No") and a command menu on
`/`. A ready example on the SDK — [`examples/bots/vps-panel.ts`](../examples/bots/vps-panel.ts).

4. Answer the assistant's questions (where you run it, which language). If it asks for the token — **paste nothing**, the
   token goes only into the environment file on your machine (step 4).

A good sign: the code reads the token and the address from environment variables, checks `from.id`, does not use
`shell=True`, and the command list contains only what you allowed. If not, tell the assistant: "Add a `from.id` check from
`GV_OWNER_ID`, no `shell=True`, commands only from an allow-list".

## Step 4. Run it on a VPS

Below is a ready skeleton for a Python bot. The assistant may suggest its own variant; the idea is the same.

**Folder and environment**

```sh
sudo useradd --system --home /opt/gvbot --shell /usr/sbin/nologin gvbot
sudo mkdir -p /opt/gvbot /etc/gvbot
sudo cp bot.py requirements.txt /opt/gvbot/          # the files the assistant wrote
cd /opt/gvbot
sudo python3 -m venv venv
sudo venv/bin/pip install -r requirements.txt
sudo chown -R gvbot:gvbot /opt/gvbot
```

**The secrets file `/etc/gvbot/bot.env`** (readable only by the service):

```sh
GV_API=https://chat.example.com
GV_BOT_TOKEN=gvb_...your_token...
GV_OWNER_ID=your-id-from-step-2
```

```sh
sudo chown root:gvbot /etc/gvbot/bot.env && sudo chmod 640 /etc/gvbot/bot.env
```

### Option A. systemd (the simplest)

`/etc/systemd/system/gvbot.service`:

```ini
[Unit]
Description=GusVoice bot
After=network-online.target
Wants=network-online.target

[Service]
User=gvbot
WorkingDirectory=/opt/gvbot
EnvironmentFile=/etc/gvbot/bot.env
ExecStart=/opt/gvbot/venv/bin/python /opt/gvbot/bot.py
Restart=always
RestartSec=5
# Light hardening: the bot does not see other home folders and gets no new privileges
NoNewPrivileges=true
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now gvbot
sudo systemctl status gvbot --no-pager        # should be active (running)
journalctl -u gvbot -f                        # logs; Ctrl+C to quit
```

If the bot manages services (`/restart nginx`), it needs the right to run `systemctl restart`. Do not give the bot `root`:
add a narrow sudo rule, only for the needed commands, in `/etc/sudoers.d/gvbot` (edit it with
`sudo visudo -f /etc/sudoers.d/gvbot`):

```
gvbot ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx, /usr/bin/systemctl restart postgresql
```

and in the bot's code call `["sudo", "-n", "/usr/bin/systemctl", "restart", "nginx"]` (a list of arguments, no shell).
Ask the assistant to do exactly that.

### Option B. Docker Compose

`Dockerfile`:

```dockerfile
FROM python:3.12.7-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY bot.py .
USER nobody
CMD ["python", "bot.py"]
```

`docker-compose.yml`:

```yaml
services:
  gvbot:
    build: .
    restart: unless-stopped
    env_file: /etc/gvbot/bot.env
```

```sh
docker compose up -d --build
docker compose logs -f gvbot
```

Inside a container the bot does not see the host's services (`systemctl`). For a panel that manages the VPS itself take
the systemd option; Docker suits notification bots, reminders and bots that only talk to the network.

## Step 5. Check it

1. In My bots open the conversation, write `/start`, then `/help` or `/status`. The bot should answer within seconds; your
   message gets ✓✓ (the bot took it).
2. **Check the protection.** While the bot is private, another person cannot even open a conversation with it. If you
   ever make the bot "Available to everyone", first check with a second account: someone else's `/restart nginx` must
   cause no reaction at all, neither an answer nor an action.
3. Stop the service (`sudo systemctl stop gvbot`) and write to the bot: the message reaches it on the next start (events
   are kept for 24 hours).
4. Reboot the VPS: the bot should come up by itself.

---

## A bot on a server

- A server admin can add a bot to a server: "Server settings → Integrations → Bots → Add bot" («Настройки сервера →
  Интеграции → Боты → Добавить бота»). A private bot — only you yourself. Give the bot only the permissions it needs: "View
  channel" and "Send messages", for moderation — "Kick/Ban members".
- **"Read all messages" — only when there is no other way** (a logger bot, anti-spam). Without the checkbox the bot gets
  `/…` commands, `@bot_username` mentions and replies to its messages — that is enough for almost every bot, and people
  feel calmer.
- Check **who** is writing by `from.id` and roles (`getChatMember`), not by the username: a guest from another instance
  (`from.instance_domain`) may have the same username as a local person.
- The bot does not see other bots' messages — the assistant does not need to write "protection from itself", but waiting
  for an answer from another bot is pointless.
- The code must check `chat.type`: `dm` (direct messages), `channel` (a server channel), `server` (join/leave events),
  `voice` (voice channel, for bots that play audio).

## Typical errors and what to tell the assistant

Copy the error text from the logs (`journalctl -u gvbot -n 50 --no-pager`) and send it to the assistant together with the
phrase from the table. **Cut the token out of the logs before sending.**

| What you see | Cause | What to tell the assistant / do |
|---|---|---|
| `401 Unauthorized` | The token is wrong, reissued, the bot is disabled by the admin, or the header is not `Authorization: Bot <token>` | Check the token in `bot.env`; "Reissue token" and paste the new one. To the assistant: "The header must be exactly `Authorization: Bot <token>`, not Bearer" |
| `403 bots are disabled on this instance` | The administrator turned bots off | Ask the administrator to turn them on (admin panel → Bots) |
| `400 chat not found` | The bot writes to a chat that does not exist, or the chat_id is made up | "Take chat_id only from the incoming event (`message.chat.id`), as a string. The bot cannot write first" |
| `400 chat_id: Invalid input: expected string` | The id was sent as a number | "All ids are strings, do not convert them to int" |
| `409 Conflict … webhook is active` | The bot has a delivery URL set | "Call `deleteWebhook` or switch to receiving events at a URL" |
| `409 Conflict: terminated by other getUpdates request` or WS closed with `4009 terminated by other connection` | A second copy of the bot runs with the same token: there is one event consumer, a new one knocks out the old one | Stop the extra one (`systemctl status`, `docker ps`, an old terminal); one token — one process. To the assistant: "On 409/4009 do not reconnect, exit with a clear message" |
| `429` | Too often | "Handle 429: wait `retry_after` seconds and repeat" |
| The bot answers twice | Repeated delivery (it is "at least once") | "Drop repeats by `update_id`; set `client_id` when sending — a repeat returns the same message" |
| The bot is silent, the logs are empty | Wrong token/instance, the service is not running, you write to the wrong conversation | `systemctl status gvbot`; in My bots → "Open conversation" of exactly this bot |
| The bot is silent, the logs say `ignored` or nothing | The `from.id` check fired: `GV_OWNER_ID` is not your id | Compare with the id from step 2; to the assistant: "Log (without the token) which `from.id` arrived and that it was rejected" |
| Events arrive again and again | `offset` is not acknowledged | "After handling set `offset = update_id + 1` and pass it to the next `getUpdates`" |
| `ModuleNotFoundError` / `Cannot find module` | Dependencies are not installed | `venv/bin/pip install -r requirements.txt`; to the assistant: "Give exact dependency versions and the install command" |
| `Permission denied` on `/restart` | No right to run `systemctl` | The sudo rule from step 4; to the assistant: "The bot runs as user gvbot, how do I let it restart only these services?" |
| The message is longer than the limit | The command output is over 4096 characters | "Split long output into parts of 4000 characters or cut it to the last 50 lines" |
| `setWebhook … internal address` | The address name leads into an internal network | Use polling (the default), or ask the admin to allow internal addresses. The server itself (`localhost`, `127.0.0.1`, `::1`) is always closed — a bot on the same machine works only with polling or WebSocket |
| A person writes to the bot and sees "The bot is private…" / "bot disabled" instead of the message box | The bot is not "Available to everyone" or is disabled by the admin | Turn on "Available to everyone" (if the bot checks `from.id`) or ask the admin to enable the bot |

If the assistant gets confused, paste [`bots-llm.md`](bots-llm.md) again: long chats forget the beginning. And say in the
request right away: "Do not invent methods that are not in the documentation".

## Security rules (short)

- The token is a **password**: only in `/etc/gvbot/bot.env`, not in code, not in Git, not in screenshots and not in the
  chat with the assistant.
- The bot reacts only to your `from.id`.
- The bot is private. "Available to everyone" — only if a `from.id` (or list) check exists and you have tested it.
- Commands — an allow-list; the message text never reaches a shell.
- Buttons — the same: a press also checks `from.id`, the service name from a button is checked against the list, dangerous
  actions go only through "Yes / No". Do not put secrets into button data (`callback_data`) — the person's client sees it.
- Suspect a leak — "Reissue token" (the old one dies at once), change the value in `bot.env`, `systemctl restart gvbot`.
