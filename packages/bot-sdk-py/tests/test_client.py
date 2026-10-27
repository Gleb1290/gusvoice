import io
import json
import unittest
import urllib.error
from email import policy
from email.parser import BytesParser

from _support import FakeOpener, Response, api_failure, contract_equal, http_failure, reject_mutant, success
from gusvoice_bot import client as client_module
from gusvoice_bot.errors import GusVoiceApiError
from gusvoice_bot.keyboard import InlineKeyboard


def client_for(*steps, module=client_module, discover=False, **options):
    opener = FakeOpener(*steps)
    pauses = []
    client = module.Client("synthetic-token-not-valid", "https://site.invalid/", opener=opener,
                           sleep=pauses.append, discover=discover, **options)
    return client, opener, pauses


def retry_contract(module):
    client, opener, pauses = client_for(api_failure(429, retry_after=2), success("delivered"), module=module)
    contract_equal(client.call("sendMessage", {"text": "one"}), "delivered", "R307_RETRY_RESULT")
    contract_equal(pauses, [2], "R307_RETRY_PAUSE")
    contract_equal(len(opener.requests), 2, "R307_RETRY_COUNT")
    contract_equal(opener.requests[0][0].data, opener.requests[1][0].data, "R307_RETRY_BODY")


class ClientTests(unittest.TestCase):
    def test_json_сохраняет_utf8_false_и_клавиатуру_но_не_отправляет_none(self):
        reply = {"message_id": "m1"}
        client, opener, pauses = client_for(success(reply))
        keyboard = InlineKeyboard().text("Ответить", "yes")
        actual = client.call("sendMessage", {"chat_id": "c", "text": "Привет", "flag": False,
                                             "reply_markup": keyboard, "empty": None})
        self.assertEqual(actual, reply)
        req, timeout = opener.requests[0]
        self.assertEqual(req.full_url, "https://site.invalid/api/bot/v1/sendMessage")
        self.assertEqual(req.get_method(), "POST")
        headers = {key.lower(): value for key, value in req.header_items()}
        self.assertEqual(headers["authorization"], "Bot synthetic-token-not-valid")
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(headers["accept"], "application/json")
        self.assertIn("Привет".encode("utf-8"), req.data)
        self.assertEqual(json.loads(req.data), {"chat_id": "c", "text": "Привет", "flag": False,
                                                "reply_markup": keyboard.to_dict()})
        self.assertEqual(timeout, 30)
        self.assertEqual(pauses, [])

    def test_длинный_опрос_добавляет_свой_таймаут_явный_таймаут_имеет_приоритет(self):
        client, opener, _ = client_for(success([]), success([]), timeout=7)
        client.call("getUpdates", {"timeout": 40})
        client.call("getUpdates", {"timeout": 40}, request_timeout=12)
        self.assertEqual([timeout for _, timeout in opener.requests], [47, 12])

    def test_discovery_один_раз_читает_config_без_токена_и_нормализует_api(self):
        client, opener, pauses = client_for(Response({"apiUrl": "https://api.invalid/api/"}), success(1), success(2), discover=True)
        self.assertEqual(client.get_me(), 1)
        self.assertEqual(client.get_me(), 2)
        discovery, timeout = opener.requests[0]
        self.assertEqual(discovery.full_url, "https://site.invalid/config.json")
        self.assertEqual(discovery.get_method(), "GET")
        self.assertNotIn("authorization", {key.lower() for key, _ in discovery.header_items()})
        self.assertEqual(timeout, 10)
        self.assertEqual([req.full_url for req, _ in opener.requests[1:]], ["https://api.invalid/api/bot/v1/getMe"] * 2)
        self.assertEqual(pauses, [])

    def test_discovery_разрешает_относительный_https_и_http_у_http_сайта(self):
        for base, api, expected in [("https://site.invalid", "/api/", "https://site.invalid"),
                                    ("http://site.invalid", "http://api.invalid/api", "http://api.invalid")]:
            with self.subTest(base=base):
                opener = FakeOpener(Response({"apiUrl": api}))
                client = client_module.Client("synthetic", base, opener=opener, sleep=lambda _s: self.fail("sleep"))
                self.assertEqual(client.api_url(), expected)

    def test_https_сайт_не_отправляет_токен_на_http_из_config(self):
        client, opener, pauses = client_for(Response({"apiUrl": "http://unsafe.invalid/api"}), discover=True)
        with self.assertRaisesRegex(ValueError, "non-HTTPS"):
            client.get_me()
        self.assertEqual(len(opener.requests), 1, "остался только запрос config.json без Authorization")
        self.assertEqual(pauses, [])

    def test_отсутствующий_или_битый_config_оставляет_исходный_api(self):
        for step in [http_failure(404), Response(raw=b"not json"), Response([]), Response({"apiUrl": ""}), TimeoutError()]:
            with self.subTest(step=type(step).__name__):
                client, opener, _ = client_for(step, success(True), discover=True)
                self.assertTrue(client.get_me())
                self.assertEqual(opener.requests[-1][0].full_url, "https://site.invalid/api/bot/v1/getMe")

    def test_сетевая_ошибка_discovery_не_кешируется_и_не_маскируется(self):
        error = urllib.error.URLError("synthetic offline")
        client, opener, pauses = client_for(error, Response({"apiUrl": "https://api.invalid"}), success(True), discover=True)
        with self.assertRaises(urllib.error.URLError) as caught:
            client.get_me()
        self.assertIs(caught.exception, error)
        self.assertTrue(client.get_me())
        self.assertEqual([req.get_method() for req, _ in opener.requests], ["GET", "GET", "POST"])
        self.assertEqual(pauses, [])

    def test_multipart_передаёт_json_флаги_два_бинарных_файла_и_не_вставляет_заголовки(self):
        client, opener, _ = client_for(success({"message_id": "file-message"}))
        first = client_module.InputFile(b"\x00\xff\x80data", filename='clip"\r\nX-Fake: injected.bin', content_type="application/octet-stream")
        second = client_module.InputFile(io.BytesIO(b"second\x00"), filename="note.txt", content_type="text/plain")
        keyboard = InlineKeyboard().text("Да", "yes")
        client.send_message("chat", "Текст", disable_notification=False, reply_markup=keyboard, files=[first, second])
        req, _ = opener.requests[0]
        ctype = {key.lower(): value for key, value in req.header_items()}["content-type"]
        message = BytesParser(policy=policy.default).parsebytes(f"Content-Type: {ctype}\r\nMIME-Version: 1.0\r\n\r\n".encode() + req.data)
        self.assertTrue(message.is_multipart())
        parts = {part.get_param("name", header="content-disposition"): part for part in message.iter_parts()}
        self.assertEqual(set(parts), {"chat_id", "text", "disable_notification", "reply_markup", "files[0]", "files[1]"})
        self.assertEqual(parts["text"].get_payload(decode=True).decode("utf-8"), "Текст")
        self.assertEqual(parts["disable_notification"].get_payload(decode=True), b"false")
        self.assertEqual(json.loads(parts["reply_markup"].get_payload(decode=True)), keyboard.to_dict())
        self.assertEqual(parts["files[0]"].get_payload(decode=True), b"\x00\xff\x80data")
        self.assertEqual(parts["files[1]"].get_payload(decode=True), b"second\x00")
        self.assertEqual(parts["files[1]"].get_filename(), "note.txt")
        self.assertTrue(req.data.endswith(("--" + message.get_boundary() + "--\r\n").encode("ascii")))
        for part in parts.values():
            self.assertIsNone(part.get("X-Fake"))

    def test_429_пауза_и_повтор_не_изменяют_тело_запроса(self):
        retry_contract(client_module)

    def test_429_берёт_retry_after_из_http_заголовка_если_тело_не_json(self):
        client, opener, pauses = client_for(http_failure(429, headers={"Retry-After": "3"}), success(True))
        self.assertTrue(client.get_me())
        self.assertEqual(pauses, [3])
        self.assertEqual(len(opener.requests), 2)

    def test_429_останавливается_после_max_retries_а_не_повторяется_бесконечно(self):
        client, opener, pauses = client_for(*[api_failure(429, retry_after=2) for _ in range(3)], max_retries=2)
        with self.assertRaises(GusVoiceApiError) as caught:
            client.get_me()
        self.assertEqual((caught.exception.code, caught.exception.retry_after, caught.exception.method), (429, 2, "getMe"))
        self.assertEqual(pauses, [2, 2])
        self.assertEqual(len(opener.requests), 3)

    def test_нулевой_лимит_повторов_и_429_без_retry_after_не_ждут(self):
        for retries, delay in [(0, 1), (3, None)]:
            with self.subTest(retries=retries, delay=delay):
                client, opener, pauses = client_for(api_failure(429, retry_after=delay), max_retries=retries)
                with self.assertRaises(GusVoiceApiError):
                    client.get_me()
                self.assertEqual((len(opener.requests), pauses), (1, []))

    def test_retry_after_ровно_на_пределе_допустим_на_секунду_выше_отказ(self):
        client, opener, pauses = client_for(api_failure(429, retry_after=5), success(True), max_retry_after=5)
        self.assertTrue(client.get_me())
        self.assertEqual(pauses, [5])
        client, opener, pauses = client_for(api_failure(429, retry_after=6), max_retry_after=5)
        with self.assertRaises(GusVoiceApiError) as caught:
            client.get_me()
        self.assertEqual(caught.exception.retry_after, 6)
        self.assertEqual((len(opener.requests), pauses), (1, []))

    def test_5xx_и_сетевая_ошибка_одного_вызова_не_повторяются(self):
        for error in [api_failure(500), http_failure(503), urllib.error.URLError("synthetic offline"), TimeoutError("synthetic timeout")]:
            with self.subTest(kind=type(error).__name__):
                client, opener, pauses = client_for(error)
                expected = type(error) if isinstance(error, (urllib.error.URLError, TimeoutError)) and not isinstance(error, urllib.error.HTTPError) else GusVoiceApiError
                with self.assertRaises(expected):
                    client.get_me()
                self.assertEqual((len(opener.requests), pauses), (1, []))

    def test_ошибка_сохраняет_код_описание_retry_after_и_имя_метода(self):
        client, _, _ = client_for(api_failure(403, retry_after=7, description="Нет доступа", status=200))
        with self.assertRaises(GusVoiceApiError) as caught:
            client.call("sendMessage")
        error = caught.exception
        self.assertEqual((error.code, error.description, error.retry_after, error.method), (403, "Нет доступа", 7, "sendMessage"))
        self.assertEqual(str(error), "sendMessage: 403 Нет доступа")
        client, _, _ = client_for(Response(status=502, raw=b"bad gateway"))
        with self.assertRaises(GusVoiceApiError) as caught:
            client.get_me()
        self.assertEqual((caught.exception.code, caught.exception.description), (502, "HTTP 502"))

    def test_контрфакт_повтора_429_без_паузы_обнаруживается(self):
        reject_mutant(self, client_module, [("self._sleep(retry_after)", "pass  # retry without waiting")],
                      retry_contract, "R307_RETRY_PAUSE")
