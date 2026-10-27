# SPDX-License-Identifier: MIT
"""Receiving updates on your own address (`setWebhook`).

Every delivery carries `X-GusVoice-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>`
(the server side is `webhookSignature` in `packages/backend/src/bots/botRules.ts`). Check it on the RAW body, before
parsing JSON: a re-serialized body does not keep the signature.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from http.server import BaseHTTPRequestHandler
from typing import Any, Callable, Dict, List, Optional, Tuple, Type, Union

SIGNATURE_HEADER = "X-GusVoice-Signature"
"""Header with the signature (header names are case-insensitive)."""
DEFAULT_TOLERANCE_S = 300
"""Signature time window, seconds: an older (or far future) delivery is a replay and is refused."""
MAX_BODY_BYTES = 8 << 20
"""Largest delivery body `webhook_handler` accepts."""


def parse_signature_header(header: Optional[str]) -> Optional[Tuple[int, List[str]]]:
    """`(t, [v1, ...])` from the header, or `None` if it is missing or malformed (several `v1` are allowed)."""
    if not header or not isinstance(header, str):
        return None
    t: Optional[int] = None
    v1: List[str] = []
    for part in header.split(","):
        k, sep, v = part.partition("=")
        if not sep:
            continue
        k, v = k.strip(), v.strip()
        if k == "t" and v.isascii() and v.isdigit() and 1 <= len(v) <= 12:
            t = int(v)
        elif k == "v1" and len(v) == 64 and all(c in "0123456789abcdefABCDEF" for c in v):
            v1.append(v.lower())
    return (t, v1) if t is not None and v1 else None


def sign(secret: str, raw_body: Union[bytes, str], now: int) -> str:
    """Header value the server would send for this body at `now` (for your tests)."""
    body = raw_body.encode("utf-8") if isinstance(raw_body, str) else bytes(raw_body)
    mac = hmac.new(secret.encode("utf-8"), str(now).encode("ascii") + b"." + body, hashlib.sha256).hexdigest()
    return f"t={now},v1={mac}"


def verify_signature(
    secret: str,
    header: Optional[str],
    raw_body: Union[bytes, str],
    tolerance: int = DEFAULT_TOLERANCE_S,
    now: Optional[float] = None,
) -> bool:
    """`True` if the delivery is signed with `secret` and fresh (|now - t| <= `tolerance` seconds).

    Comparison runs in constant time (`hmac.compare_digest`). Never raises on bad input: it just returns `False`.
    """
    if not secret or not isinstance(secret, str):
        return False
    sig = parse_signature_header(header)
    if sig is None:
        return False
    t, candidates = sig
    current = time.time() if now is None else now
    if abs(current - t) > tolerance:
        return False
    body = raw_body.encode("utf-8") if isinstance(raw_body, str) else bytes(raw_body)
    expected = hmac.new(secret.encode("utf-8"), str(t).encode("ascii") + b"." + body, hashlib.sha256).hexdigest()
    ok = False
    for v in candidates:
        ok = hmac.compare_digest(expected, v) or ok
    return ok


def webhook_handler(
    secret: str,
    on_update: Callable[[Dict[str, Any]], Any],
    path: str = "/",
    tolerance: int = DEFAULT_TOLERANCE_S,
) -> Type[BaseHTTPRequestHandler]:
    """Request handler class for `http.server` (use `ThreadingHTTPServer`).

    `POST <path>`: wrong signature -> 401, body larger than `MAX_BODY_BYTES` -> 413, not JSON -> 400; otherwise it
    answers 200 right away and then calls `on_update(update)` for the update (or each one of a batch; keep the server fast: it waits for the answer).
    Exceptions of `on_update` are printed and do not reach the server (the delivery is already acknowledged).
    """

    class _Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 (http.server naming)
            if self.path.split("?", 1)[0] != path:
                self._reply(404, b"not found")
                return
            try:
                length = int(self.headers.get("Content-Length") or "0")
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY_BYTES:
                self._reply(413, b"too large")
                return
            raw = self.rfile.read(length)
            if not verify_signature(secret, self.headers.get(SIGNATURE_HEADER), raw, tolerance):
                self._reply(401, b"bad signature")
                return
            try:
                update = json.loads(raw.decode("utf-8"))
            except ValueError:
                self._reply(400, b"bad json")
                return
            self._reply(200, b"ok")
            # `setWebhook(batch=True)` delivers an array of updates in one request.
            for u in update if isinstance(update, list) else [update]:
                if not isinstance(u, dict):
                    continue
                try:
                    on_update(u)
                except Exception as e:  # the delivery is acknowledged; report and go on
                    self.log_error("update handler failed: %r", e)

        def do_GET(self) -> None:  # noqa: N802
            self._reply(405, b"POST only")

        def _reply(self, status: int, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()

    return _Handler
