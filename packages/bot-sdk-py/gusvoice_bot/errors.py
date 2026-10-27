# SPDX-License-Identifier: MIT
"""Errors of the GusVoice Bot API client."""
from __future__ import annotations

from typing import Optional


class GusVoiceError(Exception):
    """Base class of every error raised by this package."""


class GusVoiceApiError(GusVoiceError):
    """The server answered `{"ok": false, ...}` (or a non-JSON error page).

    `code` is `error_code` (or the HTTP status), `description` is the server text, `retry_after` (seconds) comes with 429.
    """

    def __init__(self, code: int, description: str, retry_after: Optional[int] = None, method: Optional[str] = None) -> None:
        self.code = code
        self.description = description
        self.retry_after = retry_after
        self.method = method
        where = f"{method}: " if method else ""
        super().__init__(f"{where}{code} {description}")
