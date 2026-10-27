#!/usr/bin/env python3
"""Приём событий на свой адрес (setWebhook) на Python SDK + `http.server`: подпись проверяется, ответ 200 — сразу.

  GUSVOICE_URL=https://voice.example.com GUSVOICE_BOT_TOKEN=gvb_… WEBHOOK_SECRET=<длинная случайная строка> \
  WEBHOOK_URL=https://bot.example.com/hook python3 webhook.py

Слушает 127.0.0.1:8081 (PORT), путь /hook; снаружи — за обратным прокси с HTTPS (nginx/Caddy проксирует
https://bot.example.com/hook → http://127.0.0.1:8081/hook). При старте регистрирует адрес (`set_webhook`), на Ctrl+C —
снимает (`delete_webhook`), чтобы бота можно было снова запускать опросом. Подпись `X-GusVoice-Signature` проверяется
по СЫРОМУ телу (окно 5 минут, сравнение за постоянное время): подделка → 401.
"""
import os
import sys
from http.server import ThreadingHTTPServer

try:
    from gusvoice_bot import Client, webhook_handler
except ImportError:  # запуск из репозитория без установки пакета
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "packages", "bot-sdk-py"))
    from gusvoice_bot import Client, webhook_handler

bot = Client(os.environ["GUSVOICE_BOT_TOKEN"], os.environ.get("GUSVOICE_URL", "https://voice.example.com"))
SECRET = os.environ["WEBHOOK_SECRET"]


def on_update(update: dict) -> None:
    msg = update.get("message")
    if msg and msg.get("text"):
        bot.send_message(msg["chat"]["id"], "Получено по webhook: " + msg["text"])


if __name__ == "__main__":
    bot.set_webhook(os.environ["WEBHOOK_URL"], SECRET)
    port = int(os.environ.get("PORT", "8081"))
    server = ThreadingHTTPServer(("127.0.0.1", port), webhook_handler(SECRET, on_update, path="/hook"))
    print(f"Жду события на 127.0.0.1:{port}/hook (Ctrl+C — выход)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        bot.delete_webhook()
