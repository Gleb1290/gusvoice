import inspect
import json
import re
import unittest

from _support import ROOT, contract_equal, reject_mutant
from gusvoice_bot import _generated
from gusvoice_bot import keyboard


def byte_contract(module):
    # Конструктор — второй вход помимо .text(), он обязан проверять те же байты.
    data = "я" * 32 + "a"
    try:
        module.InlineKeyboard([[{"text": "Ответить", "callback_data": data}]])
    except ValueError:
        return
    raise AssertionError("R307_CALLBACK_BYTES: 65 байт не должны пройти как 33 символа")


class KeyboardTests(unittest.TestCase):
    def test_callback_data_ровно_64_utf8_байта_принимается_65_отклоняется(self):
        for accepted, rejected in [("a" * 64, "a" * 65), ("я" * 32, "я" * 32 + "a")]:
            with self.subTest(kind="ascii" if accepted.isascii() else "cyrillic"):
                self.assertEqual(len(accepted.encode("utf-8")), 64)
                self.assertEqual(len(rejected.encode("utf-8")), 65)
                markup = keyboard.InlineKeyboard().text("Ответить", accepted)
                self.assertEqual(markup.to_dict(), {"inline_keyboard": [[{"text": "Ответить", "callback_data": accepted}]]})
                with self.assertRaisesRegex(ValueError, "bytes of UTF-8"):
                    keyboard.InlineKeyboard().text("Ответить", rejected)

    def test_конструктор_клавиатуры_не_обходит_проверку_65_байтов(self):
        byte_contract(keyboard)
        accepted = {"text": "Ответить", "callback_data": "я" * 32}
        self.assertEqual(keyboard.InlineKeyboard([[accepted]]).to_dict(), {"inline_keyboard": [[accepted]]})

    def test_пустые_и_нестроковые_callback_data_отклоняются_один_байт_принимается(self):
        for value in ["", None, 1, b"x"]:
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "callback_data"):
                    keyboard.InlineKeyboard().text("Кнопка", value)
        self.assertEqual(keyboard.InlineKeyboard().text("Кнопка", "x").to_dict()["inline_keyboard"][0][0]["callback_data"], "x")

    def test_восемь_кнопок_в_ряду_проходят_девятая_нет_но_в_новом_ряду_можно(self):
        markup = keyboard.InlineKeyboard()
        for i in range(8):
            self.assertIs(markup.text(str(i), str(i)), markup)
        self.assertEqual(len(markup.to_dict()["inline_keyboard"][0]), 8)
        with self.assertRaisesRegex(ValueError, "buttons in a row"):
            markup.text("Девятая", "9")
        self.assertEqual(len(markup.to_dict()["inline_keyboard"][0]), 8)
        self.assertIs(markup.row().text("Девятая", "9"), markup)
        self.assertEqual([len(row) for row in markup.to_dict()["inline_keyboard"]], [8, 1])

    def test_сто_кнопок_проходят_сто_первая_нет_даже_в_новом_ряду(self):
        rows = [[{"text": str(i), "callback_data": str(i)} for i in range(start, min(start + 8, 100))]
                for start in range(0, 100, 8)]
        markup = keyboard.InlineKeyboard(rows)
        self.assertEqual(sum(map(len, markup.to_dict()["inline_keyboard"])), 100)
        with self.assertRaisesRegex(ValueError, "at most 100 buttons"):
            markup.row().text("Лишняя", "101")
        self.assertEqual(sum(map(len, markup.to_dict()["inline_keyboard"])), 100)

    def test_http_и_https_ссылки_без_логина_проходят(self):
        for url in ["http://example.invalid/path?q=1", "https://example.invalid/a#b"]:
            with self.subTest(url=url):
                self.assertEqual(keyboard.InlineKeyboard().url("Сайт", url).to_dict(),
                                 {"inline_keyboard": [[{"text": "Сайт", "url": url}]]})

    def test_не_http_ссылки_относительные_адреса_и_логин_отклоняются(self):
        for url in ["ftp://example.invalid", "javascript:alert(1)", "file:///tmp/example", "/relative", "https://",
                    "https://user@example.invalid", "https://user:pass@example.invalid", "https://:pass@example.invalid"]:
            with self.subTest(url=url):
                with self.assertRaisesRegex(ValueError, "http.s. without credentials"):
                    keyboard.InlineKeyboard().url("Сайт", url)
                with self.assertRaises(ValueError):
                    keyboard.InlineKeyboard([[{"text": "Сайт", "url": url}]])

    def test_подпись_кнопки_64_символа_проходит_65_или_пробелы_нет(self):
        self.assertEqual(keyboard.InlineKeyboard().text("я" * 64, "x").to_dict()["inline_keyboard"][0][0]["text"], "я" * 64)
        for label in ["я" * 65, "", "  ", None]:
            with self.subTest(label=label):
                with self.assertRaisesRegex(ValueError, "button text"):
                    keyboard.InlineKeyboard().text(label, "x")

    def test_кнопке_нужно_ровно_одно_действие_а_не_оба_и_не_ни_одного(self):
        for button in [{"text": "Нет действия"}, {"text": "Два", "callback_data": "x", "url": "https://example.invalid"}]:
            with self.subTest(button=button):
                with self.assertRaisesRegex(ValueError, "exactly one"):
                    keyboard.InlineKeyboard([[button]])

    def test_пустые_ряды_исчезают_а_to_dict_не_отдаёт_внутренние_словари(self):
        original = {"text": "Ответить", "callback_data": "ok"}
        markup = keyboard.InlineKeyboard([[], [original], []])
        original["text"] = "Изменено снаружи"
        first = markup.to_dict()
        self.assertEqual(first, {"inline_keyboard": [[{"text": "Ответить", "callback_data": "ok"}]]})
        first["inline_keyboard"][0][0]["text"] = "Изменено после отправки"
        self.assertEqual(markup.to_dict()["inline_keyboard"][0][0]["text"], "Ответить")

    def test_контрфакт_числа_символов_вместо_utf8_байтов_обнаруживается(self):
        reject_mutant(self, keyboard, [('len(d.encode("utf-8"))', 'len(d)')], byte_contract, "R307_CALLBACK_BYTES")


class GeneratedTests(unittest.TestCase):
    def test_METHODS_в_обе_стороны_совпадает_с_operationId_и_since_из_OpenAPI(self):
        document = json.loads((ROOT / "docs/bot-api/openapi.json").read_text(encoding="utf-8"))
        operations = [operation for path in document["paths"].values() for verb, operation in path.items()
                      if verb in {"post", "get", "put", "delete", "patch", "head", "options"}]
        expected = {operation["operationId"]: operation["x-since-api"] for operation in operations}
        self.assertEqual(len(expected), len(operations), "operationId должны быть уникальны")
        self.assertEqual(_generated.METHODS, expected)
        self.assertEqual(_generated.API_VERSION, document["x-api-version"])
        self.assertEqual(_generated.SCHEMA_VERSION, document["info"]["version"])

    def test_каждая_сгенерированная_обёртка_вызывает_свой_метод_и_передаёт_параметры(self):
        class Recorder(_generated.GeneratedMethods):
            def __init__(self):
                self.calls = []
                self.result = object()

            def call(self, method, params=None, *, files=None):
                self.calls.append((method, params, files))
                return self.result

        for operation in _generated.METHODS:
            with self.subTest(operation=operation):
                recorder = Recorder()
                name = re.sub(r"(?<!^)(?=[A-Z])", "_", operation).lower()
                method = getattr(recorder, name)
                required = {name: "synthetic-" + name for name, parameter in inspect.signature(method).parameters.items()
                            if parameter.default is inspect.Parameter.empty and parameter.kind in
                            {inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY}}
                result = method(**required, future_option="forward-compatible")
                self.assertIs(result, recorder.result)
                self.assertEqual(recorder.calls, [(operation, {**required, "future_option": "forward-compatible"}, None)])

    def test_send_message_передаёт_файлы_в_transport_а_не_в_json_параметры(self):
        class Recorder(_generated.GeneratedMethods):
            def call(self, method, params=None, *, files=None):
                return method, params, files

        files = [object()]
        self.assertEqual(Recorder().send_message("chat", "text", files=files, disable_notification=False),
                         ("sendMessage", {"chat_id": "chat", "text": "text", "disable_notification": False}, files))
