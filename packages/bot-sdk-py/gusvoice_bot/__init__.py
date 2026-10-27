# SPDX-License-Identifier: MIT
"""GusVoice Bot API for Python — a thin client on the standard library only.

    from gusvoice_bot import Client
    bot = Client(os.environ["BOT_TOKEN"], "https://voice.example.com")
    bot.send_message(chat_id, "Hello")

Long polling (`run_polling`), webhook deliveries with signature check (`verify_signature`, `webhook_handler`), inline
buttons (`InlineKeyboard`), retry on 429. No WebSocket and no voice: for those use the TypeScript SDK `@gusvoice/bot`.
"""
from ._generated import API_VERSION, METHODS, SCHEMA_VERSION, UPDATE_TYPES
from .client import AsyncClient, Client, InputFile, normalize_base
from .errors import GusVoiceApiError, GusVoiceError
from .keyboard import (
    CALLBACK_DATA_MAX_BYTES,
    KEYBOARD_BUTTON_TEXT_MAX,
    KEYBOARD_BUTTONS_MAX,
    KEYBOARD_ROW_BUTTONS_MAX,
    InlineKeyboard,
)
from .polling import run_polling
from .webhook import DEFAULT_TOLERANCE_S, SIGNATURE_HEADER, parse_signature_header, sign, verify_signature, webhook_handler

__version__ = "0.1.0"

__all__ = [
    "API_VERSION",
    "METHODS",
    "SCHEMA_VERSION",
    "UPDATE_TYPES",
    "AsyncClient",
    "Client",
    "InputFile",
    "normalize_base",
    "GusVoiceApiError",
    "GusVoiceError",
    "CALLBACK_DATA_MAX_BYTES",
    "KEYBOARD_BUTTON_TEXT_MAX",
    "KEYBOARD_BUTTONS_MAX",
    "KEYBOARD_ROW_BUTTONS_MAX",
    "InlineKeyboard",
    "run_polling",
    "DEFAULT_TOLERANCE_S",
    "SIGNATURE_HEADER",
    "parse_signature_header",
    "sign",
    "verify_signature",
    "webhook_handler",
    "__version__",
]
