#!/usr/bin/env python3
"""Эхо-бот на Python SDK (`packages/bot-sdk-py`, только стандартная библиотека): долгий опрос getUpdates.

  GUSVOICE_URL=https://voice.example.com GUSVOICE_BOT_TOKEN=gvb_… python3 echo.py

/start — приветствие, /whoami — ваш id и id беседы (для OWNER_IDS в panel.py и GUSVOICE_CHAT_ID в notify.py),
любой другой текст — повтор. Ctrl+C — выход (обработанное подтверждается).
"""
import os
import sys

try:
    from gusvoice_bot import Client
except ImportError:  # запуск из репозитория без установки пакета
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "packages", "bot-sdk-py"))
    from gusvoice_bot import Client

bot = Client(os.environ["GUSVOICE_BOT_TOKEN"], os.environ.get("GUSVOICE_URL", "https://voice.example.com"))


def on_update(update: dict) -> None:
    msg = update.get("message")
    if not msg or not msg.get("text"):
        return
    chat_id, text = msg["chat"]["id"], msg["text"]
    if text.startswith("/start"):
        bot.send_message(chat_id, "Привет! Я повторяю всё, что вы пишете. /whoami — ваш id.")
    elif text.startswith("/whoami"):
        bot.send_message(chat_id, f"Ваш id: {msg['from']['id']}\nid беседы: {chat_id}")
    else:
        bot.send_message(chat_id, text, reply_to_message_id=msg["message_id"])


if __name__ == "__main__":
    me = bot.get_me()
    print(f"@{me['username']} слушает (Ctrl+C — выход)")
    try:
        bot.run_polling(on_update)
    except KeyboardInterrupt:
        pass
