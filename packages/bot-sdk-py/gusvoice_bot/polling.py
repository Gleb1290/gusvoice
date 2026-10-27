# SPDX-License-Identifier: MIT
"""Long polling loop: `getUpdates` with `offset`, one update at a time, in order.

The offset moves past an update only AFTER the handler has returned for it, so an update in flight when the process
dies is delivered again. A handler exception goes to `on_error(update, exc)` (default: print the traceback) and the
update counts as handled — otherwise one bad update would come back forever; make `on_error` re-raise to stop the loop
without confirming that update instead. Fatal answers (401 — token revoked or bot disabled, 403 — bots are off on the
instance, 404, 409 — a webhook is set or another copy of the bot is polling) raise `GusVoiceApiError`; everything else
(network, 5xx, 400) is retried after a pause of 1 s growing to 30 s. Same rules as the TypeScript SDK `runPolling`.
"""
from __future__ import annotations

import random
import sys
import threading
import traceback
from typing import TYPE_CHECKING, Any, Callable, Dict, Iterable, Optional

from .errors import GusVoiceApiError

if TYPE_CHECKING:
    from .client import Client

FATAL_CODES = frozenset({401, 403, 404, 409})
RECONNECT_MIN_S = 1.0
RECONNECT_MAX_S = 30.0


def _default_on_error(update: Dict[str, Any], exc: BaseException) -> None:
    print(f"gusvoice_bot: handler failed on update {update.get('update_id')}:", file=sys.stderr)
    traceback.print_exception(type(exc), exc, exc.__traceback__, file=sys.stderr)


def _log(message: str) -> None:
    print(f"gusvoice_bot: {message}", file=sys.stderr)


def run_polling(
    client: "Client",
    handler: Callable[[Dict[str, Any]], Any],
    *,
    timeout: int = 30,
    limit: int = 100,
    allowed_updates: Optional[Iterable[str]] = None,
    on_error: Optional[Callable[[Dict[str, Any], BaseException], Any]] = None,
    stop_event: Optional[threading.Event] = None,
    log: Callable[[str], Any] = _log,
) -> None:
    """Receive updates until `stop_event` is set (or Ctrl+C) and call `handler(update)` for each.

    `timeout` — seconds the server may hold one request (0-50). `getMe` is called first: a wrong token fails right away.
    A long poll is not interrupted by `stop_event`: the loop stops when the current request returns (≤ `timeout` s).
    On exit the handled updates are confirmed (`offset` without fetching anything new).
    """
    on_error = on_error or _default_on_error
    wait = stop_event.wait if stop_event is not None else client._sleep
    poll_timeout = min(max(int(timeout), 0), 50)
    allowed = list(allowed_updates) if allowed_updates is not None else None
    client.get_me()
    last = 0  # update_id of the last handled update
    backoff = RECONNECT_MIN_S
    try:
        while stop_event is None or not stop_event.is_set():
            try:
                updates = client.get_updates(
                    offset=last + 1 if last > 0 else None, limit=limit, timeout=poll_timeout, allowed_updates=allowed
                )
                backoff = RECONNECT_MIN_S
            except GusVoiceApiError as e:
                if e.code in FATAL_CODES:
                    if e.code == 409:
                        log(f"stopped: {e.description}")
                    raise
                log(f"getUpdates failed ({e}), retry in {round(backoff)} s")
                wait(backoff * (0.8 + random.random() * 0.4))
                backoff = min(backoff * 2, RECONNECT_MAX_S)
                continue
            except Exception as e:  # network, timeout, garbage — try again later
                log(f"getUpdates failed ({e!r}), retry in {round(backoff)} s")
                wait(backoff * (0.8 + random.random() * 0.4))
                backoff = min(backoff * 2, RECONNECT_MAX_S)
                continue
            for update in updates or []:
                if stop_event is not None and stop_event.is_set():
                    break
                uid = update.get("update_id") if isinstance(update, dict) else None
                if not isinstance(uid, (int, float)) or isinstance(uid, bool):
                    continue
                uid = int(uid)
                if uid <= last:
                    continue  # repeat of an already handled update
                try:
                    handler(update)
                except Exception as exc:
                    on_error(update, exc)  # re-raise here to stop without confirming this update
                last = uid
    finally:
        if last > 0:
            try:
                # Confirm what was handled: an empty `allowed_updates` returns nothing but moves the offset.
                client.get_updates(offset=last + 1, timeout=0, limit=1, allowed_updates=[])
            except Exception:
                pass
