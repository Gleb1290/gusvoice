"""Изолированные stdlib-границы: никаких сокетов, subprocess или настоящего sleep."""
import io
import json
from pathlib import Path
import sys
import types
import urllib.error


ROOT = Path(__file__).resolve().parents[3]
SDK = Path(__file__).resolve().parents[1]
if str(SDK) not in sys.path:
    sys.path.insert(0, str(SDK))


class HarnessAbort(BaseException):
    """Не ловится reconnect-циклом приложения: лишний запрос немедленно краснит тест."""


class Response:
    def __init__(self, value=None, *, status=200, raw=None):
        self.status = status
        self.raw = json.dumps(value, ensure_ascii=False).encode("utf-8") if raw is None else raw
        self.closed = False

    def read(self):
        return self.raw

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.closed = True


class FakeOpener:
    def __init__(self, *steps):
        self.steps = list(steps)
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append((request, timeout))
        if not self.steps:
            raise HarnessAbort("Неописанный HTTP-запрос: настоящая сеть запрещена")
        step = self.steps.pop(0)
        if isinstance(step, BaseException):
            raise step
        return step


def success(value):
    return Response({"ok": True, "result": value})


def api_failure(code, *, retry_after=None, description="synthetic failure", status=None):
    value = {"ok": False, "error_code": code, "description": description}
    if retry_after is not None:
        value["retry_after"] = retry_after
    return Response(value, status=code if status is None else status)


def http_failure(code, raw=b"upstream failure", headers=None):
    return urllib.error.HTTPError("https://api.invalid/synthetic", code, "synthetic", headers or {}, io.BytesIO(raw))


def contract_equal(actual, expected, marker):
    if actual != expected:
        raise AssertionError(f"{marker}: ожидалось {expected!r}, получено {actual!r}")


def reject_mutant(case, original, edits, probe, marker):
    """Целый Python-модуль в памяти; сначала тот же контракт на оригинале."""
    probe(original)
    path = Path(original.__file__).resolve()
    raw = path.read_text(encoding="utf-8")
    for anchor, replacement in edits:
        case.assertEqual(raw.count(anchor), 1, "якорь мутанта должен быть уникальным")
        raw = raw.replace(anchor, replacement, 1)
    mutant = types.ModuleType(original.__name__ + "_test_mutant")
    mutant.__file__ = str(path)
    mutant.__package__ = original.__package__
    exec(compile(raw, str(path), "exec"), mutant.__dict__)
    with case.assertRaises(AssertionError) as caught:
        probe(mutant)
    case.assertTrue(str(caught.exception).startswith(marker), str(caught.exception))
