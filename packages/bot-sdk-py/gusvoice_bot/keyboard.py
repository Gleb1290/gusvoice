# SPDX-License-Identifier: MIT
"""Buttons under a message: `InlineKeyboard().text("Status", "st").row().url("Site", "https://example.com")`.

Pass the keyboard as `reply_markup` as is. The server limits are checked when a button is added (the same as the
TypeScript SDK `packages/bot-sdk/src/keyboard.ts`): `callback_data` is 1-64 BYTES of UTF-8 (not characters), at most
8 buttons in a row and 100 in total, button text 1-64 characters, `url` only http(s) without credentials.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import urlsplit

CALLBACK_DATA_MAX_BYTES = 64
KEYBOARD_ROW_BUTTONS_MAX = 8
KEYBOARD_BUTTONS_MAX = 100
KEYBOARD_BUTTON_TEXT_MAX = 64


def _is_http_url(url: str) -> bool:
    try:
        u = urlsplit(url)
        return u.scheme in ("http", "https") and bool(u.hostname) and u.username is None and u.password is None
    except ValueError:
        return False


class InlineKeyboard:
    """Builder of `InlineKeyboardMarkup`. Empty rows are dropped when the markup is sent."""

    def __init__(self, rows: Optional[Iterable[Iterable[Dict[str, Any]]]] = None) -> None:
        self.inline_keyboard: List[List[Dict[str, Any]]] = [[]]
        if rows is not None:
            self.inline_keyboard = []
            for r in rows:
                self.row()
                for b in r:
                    self._add(dict(b))

    def text(self, label: str, data: str) -> "InlineKeyboard":
        """A button that sends the bot a `callback_query` with `data` (the person who presses it sees it: no secrets)."""
        if not isinstance(data, str) or not data or len(data.encode("utf-8")) > CALLBACK_DATA_MAX_BYTES:
            raise ValueError(f"InlineKeyboard: callback_data {data!r} must be 1-{CALLBACK_DATA_MAX_BYTES} bytes of UTF-8")
        return self._add({"text": label, "callback_data": data})

    def url(self, label: str, url: str) -> "InlineKeyboard":
        """A link button (http/https only, no login in the address; the client asks "Open the link?")."""
        if not isinstance(url, str) or not _is_http_url(url):
            raise ValueError(f"InlineKeyboard: url {url!r} must be http(s) without credentials")
        return self._add({"text": label, "url": url})

    def row(self) -> "InlineKeyboard":
        """Next buttons go to a new row."""
        if not self.inline_keyboard or self.inline_keyboard[-1]:
            self.inline_keyboard.append([])
        return self

    def to_dict(self) -> Dict[str, Any]:
        """The markup without empty rows (this is what goes to the server)."""
        return {"inline_keyboard": [[dict(b) for b in r] for r in self.inline_keyboard if r]}

    def _add(self, b: Dict[str, Any]) -> "InlineKeyboard":
        label = b.get("text")
        if not isinstance(label, str) or not label.strip() or len(label.strip()) > KEYBOARD_BUTTON_TEXT_MAX:
            raise ValueError(f"InlineKeyboard: button text must be 1-{KEYBOARD_BUTTON_TEXT_MAX} characters")
        if ("callback_data" in b) == ("url" in b):
            raise ValueError("InlineKeyboard: a button needs exactly one of callback_data and url")
        if "callback_data" in b:
            d = b["callback_data"]
            if not isinstance(d, str) or not d or len(d.encode("utf-8")) > CALLBACK_DATA_MAX_BYTES:
                raise ValueError(f"InlineKeyboard: callback_data {d!r} must be 1-{CALLBACK_DATA_MAX_BYTES} bytes of UTF-8")
        elif not isinstance(b["url"], str) or not _is_http_url(b["url"]):
            raise ValueError(f"InlineKeyboard: url {b['url']!r} must be http(s) without credentials")
        if sum(len(r) for r in self.inline_keyboard) >= KEYBOARD_BUTTONS_MAX:
            raise ValueError(f"InlineKeyboard: at most {KEYBOARD_BUTTONS_MAX} buttons")
        if not self.inline_keyboard:
            self.inline_keyboard.append([])
        last = self.inline_keyboard[-1]
        if len(last) >= KEYBOARD_ROW_BUTTONS_MAX:
            raise ValueError(f"InlineKeyboard: at most {KEYBOARD_ROW_BUTTONS_MAX} buttons in a row - call row()")
        last.append(b)
        return self
