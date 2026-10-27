#!/usr/bin/env python3
"""Уведомление себе от бота GusVoice на Python БЕЗ SDK (только стандартная библиотека): ./notify.py "Бэкап готов"

  GUSVOICE_API       — адрес API инстанса: поле apiUrl в https://<ваш инстанс>/config.json
  GUSVOICE_BOT_TOKEN — токен бота (gvb_…), только из окружения, не в скрипте
  GUSVOICE_CHAT_ID   — id беседы с ботом: напишите боту /whoami (echo.py, vps-panel.ts) или возьмите chat.id из getUpdates

Бот не пишет первым: сначала откройте с ним беседу сами. На 429 скрипт ждёт retry_after и повторяет (до 3 раз).
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request


def send(text: str) -> dict:
    api = os.environ["GUSVOICE_API"].rstrip("/")
    body = json.dumps({"chat_id": os.environ["GUSVOICE_CHAT_ID"], "text": text}).encode("utf-8")
    for _ in range(4):
        req = urllib.request.Request(
            f"{api}/api/bot/v1/sendMessage",
            data=body,
            method="POST",
            headers={"Authorization": f"Bot {os.environ['GUSVOICE_BOT_TOKEN']}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            answer = json.loads(e.read().decode("utf-8") or "{}")
            if e.code == 429 and isinstance(answer.get("retry_after"), int):
                time.sleep(answer["retry_after"])
                continue
            return answer
    return {"ok": False, "description": "too many requests"}


if __name__ == "__main__":
    result = send(" ".join(sys.argv[1:]) or "ping")
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get("ok") else 1)
