# SPDX-License-Identifier: MIT
"""HTTP client of the GusVoice Bot API on the standard library only (`urllib`).

Every method is `POST <api>/api/bot/v1/<method>` with `Authorization: Bot <token>`; the answer is
`{"ok": true, "result": ...}` or `{"ok": false, "error_code", "description", "retry_after"?}`. A 429 is retried after
`retry_after` (up to `max_retries` times); other errors raise `GusVoiceApiError`, network errors raise as they are
(`urllib.error.URLError`, `TimeoutError`). The same behaviour as the TypeScript SDK (`packages/bot-sdk/src/apiClient.ts`).
"""
from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import socket
import threading
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, BinaryIO, Callable, Dict, List, Optional, Sequence, Tuple, Union
from urllib.parse import urljoin

from ._generated import GeneratedMethods
from .errors import GusVoiceApiError

__all__ = ["Client", "AsyncClient", "InputFile", "normalize_base"]

DEFAULT_TIMEOUT_S = 30.0
"""Time limit of one request, seconds (long polling adds its own `timeout` on top)."""
DISCOVERY_TIMEOUT_S = 10.0


def normalize_base(url: str) -> str:
    """Without trailing `/` and without a trailing `/api`: the client adds the method path itself."""
    u = str(url).strip().rstrip("/")
    if u.endswith("/api"):
        u = u[:-4]
    if not (u.lower().startswith("http://") or u.lower().startswith("https://")):
        raise ValueError(f'base_url must start with http:// or https:// (got "{url}")')
    return u


class InputFile:
    """A file for `send_message(..., files=[...])`: a path, bytes or a binary file object."""

    def __init__(self, source: Union[str, "os.PathLike[str]", bytes, bytearray, BinaryIO], filename: Optional[str] = None,
                 content_type: Optional[str] = None) -> None:
        self.source = source
        self.filename = filename
        self.content_type = content_type

    def read(self) -> Tuple[bytes, str, str]:
        """`(data, file name, content type)`."""
        src = self.source
        name = self.filename
        if isinstance(src, (bytes, bytearray)):
            data = bytes(src)
            name = name or "file"
        elif isinstance(src, (str, os.PathLike)):
            path = os.fspath(src)
            with open(path, "rb") as f:
                data = f.read()
            name = name or os.path.basename(path) or "file"
        else:
            data = src.read()
            name = name or os.path.basename(str(getattr(src, "name", "") or "")) or "file"
        ctype = self.content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
        return data, name, ctype


def _json_default(o: Any) -> Any:
    to_dict = getattr(o, "to_dict", None)  # InlineKeyboard and similar builders
    if callable(to_dict):
        return to_dict()
    raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")


def _dumps(value: Any) -> str:
    return json.dumps(value, default=_json_default, ensure_ascii=False, separators=(",", ":"))


def _multipart(params: Dict[str, Any], files: Sequence[Any]) -> Tuple[bytes, str]:
    """`multipart/form-data`: parameters as fields (objects and arrays as JSON strings), files as `files[0]`, `files[1]` ..."""
    boundary = f"gusvoice-{uuid.uuid4().hex}"
    out: List[bytes] = []

    def quote(s: str) -> str:
        return s.replace("\\", "\\\\").replace('"', '\\"').replace("\r", " ").replace("\n", " ")

    for k, v in params.items():
        if v is None:
            continue
        if isinstance(v, bool):
            text = "true" if v else "false"
        elif isinstance(v, (dict, list, tuple)) or callable(getattr(v, "to_dict", None)):
            text = _dumps(v)
        else:
            text = str(v)
        out.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{quote(k)}"\r\n\r\n'.encode("utf-8"))
        out.append(text.encode("utf-8") + b"\r\n")
    for i, f in enumerate(files):
        data, name, ctype = (f if isinstance(f, InputFile) else InputFile(f)).read()
        out.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="files[{i}]"; filename="{quote(name)}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n".encode("utf-8")
        )
        out.append(data + b"\r\n")
    out.append(f"--{boundary}--\r\n".encode("ascii"))
    return b"".join(out), f"multipart/form-data; boundary={boundary}"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect would carry the bot token to another address: answer it as an error instead."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


class Client(GeneratedMethods):
    """Bot API client. `base_url` is the instance site (`https://voice.example.com`) or its API address.

    The API address is found once through `<base_url>/config.json` (`apiUrl`), as the web client does; pass
    `discover=False` to use `base_url` as is. All methods are generated from the OpenAPI document (`_generated.py`):
    `send_message(chat_id, "text", reply_markup=...)`, `get_updates(offset=..., timeout=...)`, ...; any method by name —
    `call("sendMessage", {...})`. Thread-safe: one client can be used from several threads.
    """

    def __init__(
        self,
        token: str,
        base_url: str,
        *,
        discover: bool = True,
        max_retries: int = 3,
        max_retry_after: float = 60,
        timeout: float = DEFAULT_TIMEOUT_S,
        opener: Optional[urllib.request.OpenerDirector] = None,
        sleep: Callable[[float], Any] = time.sleep,
    ) -> None:
        if not token or not isinstance(token, str):
            raise ValueError("token is required (BotFather-style `gvb_...` from the GusVoice bot settings)")
        self.token = token
        self.base_url = normalize_base(base_url)
        self.discover = discover
        self.max_retries = max(0, int(max_retries))
        self.max_retry_after = max_retry_after
        self.timeout = timeout
        self._opener = opener or urllib.request.build_opener(_NoRedirect)
        self._sleep = sleep
        self._api: Optional[str] = None
        self._api_lock = threading.Lock()

    # ── address ───────────────────────────────────────────────────────────────────────────────────────────────────
    def api_url(self) -> str:
        """API address (`https://api.example.com`) after reading `config.json`; a network failure is not remembered."""
        with self._api_lock:
            if self._api is None:
                self._api = self._discover_api()
            return self._api

    def _discover_api(self) -> str:
        if not self.discover:
            return self.base_url
        req = urllib.request.Request(f"{self.base_url}/config.json", headers={"Accept": "application/json"})
        try:
            with self._opener.open(req, timeout=DISCOVERY_TIMEOUT_S) as r:
                raw = r.read()
        except urllib.error.HTTPError:
            return self.base_url  # no config.json here: base_url already is the API
        except (TimeoutError, socket.timeout):
            return self.base_url
        except urllib.error.URLError as e:
            if isinstance(e.reason, (TimeoutError, socket.timeout)):
                return self.base_url
            raise
        try:
            cfg = json.loads(raw.decode("utf-8"))
        except ValueError:
            return self.base_url
        api = cfg.get("apiUrl") if isinstance(cfg, dict) else None
        if not isinstance(api, str) or not api.strip():
            return self.base_url
        found = normalize_base(urljoin(f"{self.base_url}/", api.strip()))
        # The site is https, but config.json points to plain http (spoofing or a misconfiguration): keep the token off it.
        if self.base_url.lower().startswith("https:") and not found.lower().startswith("https:"):
            raise ValueError(
                f"config.json of {self.base_url} points apiUrl to non-HTTPS {found}; refusing to send the bot token over plain HTTP"
            )
        return found

    def auth_header(self) -> str:
        return f"Bot {self.token}"

    # ── methods ───────────────────────────────────────────────────────────────────────────────────────────────────
    def call(self, method: str, params: Optional[Dict[str, Any]] = None, *, files: Optional[Sequence[Any]] = None,
             request_timeout: Optional[float] = None) -> Any:
        """Any Bot API method by name. `params` go as JSON; with `files` — as `multipart/form-data`."""
        params = {k: v for k, v in (params or {}).items() if v is not None}
        url = f"{self.api_url()}/api/bot/v1/{method}"
        limit = request_timeout
        if limit is None:
            limit = self.timeout
            if method.lower() == "getupdates":  # long polling: the server holds the request up to `timeout` seconds
                try:
                    limit += float(params.get("timeout") or 0)
                except (TypeError, ValueError):
                    pass
        attempt = 0
        while True:
            if files:
                body, ctype = _multipart(params, files)
            else:
                body, ctype = _dumps(params).encode("utf-8"), "application/json"
            req = urllib.request.Request(
                url, data=body, method="POST",
                headers={"Authorization": self.auth_header(), "Content-Type": ctype, "Accept": "application/json"},
            )
            retry_header: Optional[str] = None
            try:
                with self._opener.open(req, timeout=limit) as r:
                    status = r.status
                    raw = r.read()
            except urllib.error.HTTPError as e:
                status = e.code
                retry_header = e.headers.get("Retry-After") if e.headers else None
                raw = e.read() or b""
            try:
                res = json.loads(raw.decode("utf-8"))
            except ValueError:
                res = None
            if isinstance(res, dict) and res.get("ok") is True:
                return res.get("result")
            err = res if isinstance(res, dict) and res.get("ok") is False else {}
            code = err.get("error_code") if isinstance(err.get("error_code"), int) else status
            description = err.get("description") if isinstance(err.get("description"), str) else f"HTTP {status}"
            retry_after = err.get("retry_after")
            if not isinstance(retry_after, int) or isinstance(retry_after, bool):
                retry_after = int(retry_header) if retry_header and retry_header.strip().isdigit() else None
            if code == 429 and retry_after is not None and attempt < self.max_retries and retry_after <= self.max_retry_after:
                attempt += 1
                self._sleep(retry_after)
                continue
            raise GusVoiceApiError(code, description, retry_after, method)

    # ── receiving updates ─────────────────────────────────────────────────────────────────────────────────────────
    def run_polling(self, handler: Callable[[Dict[str, Any]], Any], **options: Any) -> None:
        """Long polling loop (`getUpdates`) — see `gusvoice_bot.polling.run_polling` for the options."""
        from .polling import run_polling

        run_polling(self, handler, **options)


class AsyncClient:
    """`asyncio` wrapper over `Client`: every method runs in a worker thread (`asyncio.to_thread`).

    It is threads, not native async I/O — fine for a bot, no extra dependencies. `await bot.send_message(chat, "hi")`.
    """

    def __init__(self, token: str, base_url: str, **options: Any) -> None:
        self.sync = Client(token, base_url, **options)

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self.sync, name)
        if not callable(attr):
            return attr

        async def run(*args: Any, **kwargs: Any) -> Any:
            return await asyncio.to_thread(attr, *args, **kwargs)

        run.__name__ = name
        run.__doc__ = getattr(attr, "__doc__", None)
        return run
