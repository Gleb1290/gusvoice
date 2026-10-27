import contextlib
import io
import unittest
import urllib.error
from unittest.mock import patch

from _support import HarnessAbort, contract_equal, reject_mutant
from gusvoice_bot import polling
from gusvoice_bot.errors import GusVoiceApiError


class Stop:
    def __init__(self):
        self.stopped = False
        self.waits = []

    def set(self):
        self.stopped = True

    def is_set(self):
        return self.stopped

    def wait(self, seconds):
        self.waits.append(seconds)
        return self.stopped


class PollClient:
    def __init__(self, *steps, final_error=None, me_error=None):
        self.steps = list(steps)
        self.calls = []
        self.sleeps = []
        self._sleep = self.sleeps.append
        self.me_error = me_error
        self.final_error = final_error

    def get_me(self):
        self.calls.append(("me", {}))
        if self.me_error:
            raise self.me_error
        return {"id": "synthetic-bot"}

    def get_updates(self, **params):
        self.calls.append(("updates", dict(params)))
        if params.get("allowed_updates") == [] and params.get("timeout") == 0 and params.get("limit") == 1:
            if self.final_error:
                raise self.final_error
            return []
        if not self.steps:
            raise HarnessAbort("Неописанный polling-запрос: бесконечные повторы запрещены")
        step = self.steps.pop(0)
        if isinstance(step, BaseException):
            raise step
        return step(params) if callable(step) else step


def updates(client):
    return [params for method, params in client.calls if method == "updates"]


def failure_ack_contract(module):
    client = PollClient([{"update_id": 10}, {"update_id": 11}])
    seen = []
    error = RuntimeError("synthetic handler failure")

    def handler(update):
        seen.append(update["update_id"])
        if update["update_id"] == 11:
            raise error

    def rethrow(_update, exc):
        raise exc

    try:
        module.run_polling(client, handler, on_error=rethrow, log=lambda _msg: None)
    except RuntimeError as caught:
        contract_equal(caught is error, True, "R307_HANDLER_ERROR")
    else:
        raise AssertionError("R307_HANDLER_ERROR: исключение on_error должно остановить цикл")
    contract_equal(seen, [10, 11], "R307_HANDLER_ORDER")
    contract_equal(updates(client)[-1], {"offset": 11, "timeout": 0, "limit": 1, "allowed_updates": []}, "R307_NO_EARLY_ACK")


class PollingTests(unittest.TestCase):
    def test_offset_передвигается_после_возврата_обработчика_а_финал_не_получает_новые_события(self):
        stop = Stop()
        events = []

        def next_batch(params):
            self.assertEqual(events, ["start:5", "done:5"])
            self.assertEqual(params["offset"], 6)
            stop.set()
            return []

        client = PollClient([{"update_id": 5}], next_batch)

        def handler(update):
            events.append(f"start:{update['update_id']}")
            self.assertEqual(updates(client)[-1]["offset"], None)
            events.append(f"done:{update['update_id']}")

        polling.run_polling(client, handler, stop_event=stop, allowed_updates=["message"], log=lambda _msg: None)
        self.assertEqual(client.calls[0], ("me", {}))
        self.assertEqual(updates(client)[-1], {"offset": 6, "timeout": 0, "limit": 1, "allowed_updates": []})
        self.assertEqual(stop.waits, [])

    def test_on_error_с_повторным_выбросом_не_подтверждает_упавшее_событие(self):
        failure_ack_contract(polling)

    def test_первое_упавшее_событие_при_rethrow_вообще_не_отправляет_ack(self):
        error = ValueError("synthetic first failure")
        client = PollClient([{"update_id": 1}])

        def handler(_update):
            raise error

        def rethrow(_update, exc):
            raise exc

        with self.assertRaises(ValueError) as caught:
            polling.run_polling(client, handler, on_error=rethrow, log=lambda _msg: None)
        self.assertIs(caught.exception, error)
        self.assertEqual(len(updates(client)), 1)

    def test_ошибка_обработчика_по_умолчанию_подтверждается_как_в_TS(self):
        stop = Stop()
        client = PollClient([{"update_id": 7}])

        def handler(_update):
            stop.set()
            raise ValueError("synthetic bad update")

        with contextlib.redirect_stderr(io.StringIO()) as output:
            polling.run_polling(client, handler, stop_event=stop, log=lambda _msg: None)
        self.assertIn("handler failed on update 7", output.getvalue())
        self.assertIn("synthetic bad update", output.getvalue())
        self.assertEqual(updates(client)[-1]["offset"], 8)
        self.assertEqual(updates(client)[-1]["allowed_updates"], [])

    def test_пользовательский_on_error_без_rethrow_также_считает_событие_обработанным(self):
        stop = Stop()
        client = PollClient([{"update_id": 8}])
        error = ValueError("synthetic update")
        errors = []

        def handler(_update):
            raise error

        def on_error(update, exc):
            errors.append((update["update_id"], exc))
            stop.set()

        polling.run_polling(client, handler, stop_event=stop, on_error=on_error, log=lambda _msg: None)
        self.assertEqual(errors, [(8, error)])
        self.assertEqual(updates(client)[-1]["offset"], 9)

    def test_401_403_404_409_фатальны_без_паузы_и_повтора(self):
        for code in [401, 403, 404, 409]:
            with self.subTest(code=code):
                error = GusVoiceApiError(code, "synthetic fatal")
                client = PollClient(error)
                logs = []
                with self.assertRaises(GusVoiceApiError) as caught:
                    polling.run_polling(client, lambda _u: self.fail("handler"), log=logs.append)
                self.assertIs(caught.exception, error)
                self.assertEqual(client.sleeps, [])
                self.assertEqual(len(updates(client)), 1)
                self.assertEqual(len(logs), 1 if code == 409 else 0)

    def test_400_5xx_и_сеть_повторяются_после_паузы_с_тем_же_offset(self):
        for error in [GusVoiceApiError(400, "synthetic bad request"), GusVoiceApiError(500, "synthetic upstream"), urllib.error.URLError("synthetic offline")]:
            with self.subTest(error=type(error).__name__, code=getattr(error, "code", None)):
                stop = Stop()

                def finished(_params):
                    stop.set()
                    return []

                client = PollClient(error, finished)
                with patch.object(polling.random, "random", return_value=0.5):
                    polling.run_polling(client, lambda _u: self.fail("handler"), stop_event=stop, log=lambda _msg: None)
                self.assertEqual(stop.waits, [1])
                self.assertEqual(len(updates(client)), 2)
                self.assertEqual(updates(client)[0], updates(client)[1])

    def test_backoff_растёт_до_30_секунд_и_после_успеха_начинается_заново(self):
        stop = Stop()

        def finished(_params):
            stop.set()
            return []

        errors = [GusVoiceApiError(500, "synthetic") for _ in range(7)]
        client = PollClient(*errors, [], GusVoiceApiError(400, "synthetic"), finished)
        with patch.object(polling.random, "random", return_value=0.5):
            polling.run_polling(client, lambda _u: None, stop_event=stop, log=lambda _msg: None)
        self.assertEqual(stop.waits, [1, 2, 4, 8, 16, 30, 30, 1])

    def test_повторные_и_неверные_id_не_попадают_в_обработчик_и_не_уменьшают_offset(self):
        stop = Stop()
        client = PollClient([None, {"update_id": True}, {"update_id": "9"}, {}, {"update_id": 0},
                             {"update_id": 9}, {"update_id": 9}, {"update_id": 8}, {"update_id": 10}])
        seen = []

        def handler(update):
            seen.append(update["update_id"])
            if update["update_id"] == 10:
                stop.set()

        polling.run_polling(client, handler, stop_event=stop, log=lambda _msg: None)
        self.assertEqual(seen, [9, 10])
        self.assertEqual(updates(client)[-1]["offset"], 11)

    def test_timeout_ограничен_а_allowed_updates_генератор_не_теряется_в_финальном_ack(self):
        for requested, expected in [(-1, 0), (51, 50)]:
            with self.subTest(timeout=requested):
                stop = Stop()
                client = PollClient([{"update_id": 3}])
                polling.run_polling(client, lambda _u: stop.set(), stop_event=stop, timeout=requested, limit=9,
                                    allowed_updates=(kind for kind in ["message", "voice_state"]), log=lambda _msg: None)
                first, final = updates(client)
                self.assertEqual((first["timeout"], first["limit"], first["allowed_updates"]), (expected, 9, ["message", "voice_state"]))
                self.assertEqual(final, {"offset": 4, "timeout": 0, "limit": 1, "allowed_updates": []})

    def test_ошибка_финального_ack_не_заменяет_успешную_остановку(self):
        stop = Stop()
        client = PollClient([{"update_id": 1}], final_error=GusVoiceApiError(401, "synthetic revoked"))
        polling.run_polling(client, lambda _u: stop.set(), stop_event=stop, log=lambda _msg: None)
        self.assertEqual(len(updates(client)), 2)

    def test_уже_выставленный_stop_не_начинает_опрос_а_get_me_проверяется(self):
        stop = Stop()
        stop.set()
        client = PollClient()
        polling.run_polling(client, lambda _u: self.fail("handler"), stop_event=stop, log=lambda _msg: None)
        self.assertEqual(client.calls, [("me", {})])

    def test_ошибка_get_me_фатальна_ещё_до_опроса(self):
        error = GusVoiceApiError(401, "synthetic token")
        client = PollClient(me_error=error)
        with self.assertRaises(GusVoiceApiError) as caught:
            polling.run_polling(client, lambda _u: self.fail("handler"), log=lambda _msg: None)
        self.assertIs(caught.exception, error)
        self.assertEqual(client.calls, [("me", {})])

    def test_контрфакт_offset_до_возврата_обработчика_подтверждает_ошибку_и_обнаруживается(self):
        reject_mutant(self, polling, [("                try:\n                    handler(update)",
                                      "                last = uid\n                try:\n                    handler(update)")],
                      failure_ack_contract, "R307_NO_EARLY_ACK")
