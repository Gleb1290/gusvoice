#!/usr/bin/env python3
"""Мини-панель сервера на Python SDK: /status — загрузка, память, диск; кнопка «Обновить» правит то же сообщение.

  GUSVOICE_URL=https://voice.example.com GUSVOICE_BOT_TOKEN=gvb_… OWNER_IDS=<ваш id> python3 panel.py

Безопасность: отвечает ТОЛЬКО id из OWNER_IDS (через запятую; свой id покажет /whoami в echo.py) — бота находят по нику,
и без проверки `from.id` состояние сервера увидит кто угодно. Проверка стоит и на сообщениях, и на нажатиях кнопок.
Ничего не выполняет — только читает; полная панель с перезапуском служб — vps-panel.ts.
"""
import os
import platform
import shutil
import sys
import time

try:
    from gusvoice_bot import Client, InlineKeyboard
except ImportError:  # запуск из репозитория без установки пакета
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "packages", "bot-sdk-py"))
    from gusvoice_bot import Client, InlineKeyboard

bot = Client(os.environ["GUSVOICE_BOT_TOKEN"], os.environ.get("GUSVOICE_URL", "https://voice.example.com"))
OWNERS = {s.strip() for s in os.environ.get("OWNER_IDS", "").split(",") if s.strip()}
REFRESH = "status:refresh"


def status_text() -> str:
    lines = [f"🖥 {platform.node()} — {time.strftime('%Y-%m-%d %H:%M:%S')}"]
    if hasattr(os, "getloadavg"):
        lines.append("Загрузка: " + " / ".join(f"{x:.2f}" for x in os.getloadavg()))
    try:
        with open("/proc/uptime") as f:
            up = int(float(f.read().split()[0]))
        lines.append(f"Работает: {up // 86400} д {up % 86400 // 3600} ч {up % 3600 // 60} мин")
        with open("/proc/meminfo") as f:
            mem = {k: int(v.split()[0]) for k, v in (line.split(":", 1) for line in f)}
        used = (mem["MemTotal"] - mem.get("MemAvailable", mem["MemFree"])) / 1024 / 1024
        lines.append(f"Память: {used:.1f} из {mem['MemTotal'] / 1024 / 1024:.1f} ГБ")
    except OSError:
        pass  # не Linux
    disk = shutil.disk_usage("/")
    lines.append(f"Диск /: занято {disk.used / disk.total:.0%}, свободно {disk.free / 1024 ** 3:.1f} ГБ")
    return "\n".join(lines)


def keyboard() -> InlineKeyboard:
    return InlineKeyboard().text("🔄 Обновить", REFRESH)


def on_update(update: dict) -> None:
    msg = update.get("message")
    if msg and msg.get("text"):
        if msg.get("from", {}).get("id") not in OWNERS:
            return  # чужим не отвечаем вовсе
        if msg["text"].startswith("/status"):
            bot.send_message(msg["chat"]["id"], status_text(), reply_markup=keyboard())
        return
    cq = update.get("callback_query")
    if cq:
        if cq.get("from", {}).get("id") not in OWNERS:
            bot.answer_callback_query(cq["id"], "Нет доступа")
            return
        if cq.get("data") == REFRESH and cq.get("message"):
            m = cq["message"]
            bot.edit_message_text(m["chat"]["id"], m["message_id"], status_text(), reply_markup=keyboard())
        bot.answer_callback_query(cq["id"], "Обновлено")


if __name__ == "__main__":
    if not OWNERS:
        sys.exit("Задайте OWNER_IDS (свой id покажет /whoami в echo.py)")
    bot.set_my_commands([{"command": "status", "description": "Состояние сервера"}])
    try:
        bot.run_polling(on_update, allowed_updates=["message", "callback_query"])
    except KeyboardInterrupt:
        pass
