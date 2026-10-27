import json
import unittest
from unittest.mock import patch

from _support import ROOT, contract_equal, reject_mutant
from gusvoice_bot import webhook


VECTORS = json.loads((ROOT / "packages/bot-sdk/test-vectors/webhook-signature.json").read_text(encoding="utf-8"))
CASES = {case["name"]: case for case in VECTORS["cases"]}


def verify(module, vector, body=None):
    options = {"now": vector["now_s"]}
    if vector["tolerance_s"] is not None:
        options["tolerance"] = vector["tolerance_s"]
    return module.verify_signature(vector["secret"], vector["header"], vector["body"] if body is None else body, **options)


def digest_contract(module):
    original = webhook.hmac.compare_digest
    with patch.object(module.hmac, "compare_digest", wraps=original) as compare:
        contract_equal(verify(module, CASES["valid"]), True, "R307_DIGEST_RESULT")
        contract_equal(compare.call_count, 1, "R307_COMPARE_DIGEST")
        expected, actual = compare.call_args.args
        contract_equal((len(expected), len(actual)), (64, 64), "R307_COMPARE_DIGEST")


class WebhookTests(unittest.TestCase):
    def test_общие_29_векторов_совпадают_для_строк_и_сырых_байтов(self):
        self.assertEqual(len(CASES), len(VECTORS["cases"]), "имена векторов уникальны")
        self.assertEqual(len(CASES), 29)
        self.assertEqual(webhook.DEFAULT_TOLERANCE_S, VECTORS["default_tolerance_s"])
        for vector in VECTORS["cases"]:
            for body in [vector["body"], vector["body"].encode("utf-8")]:
                with self.subTest(vector=vector["name"], body_type=type(body).__name__):
                    self.assertIs(verify(webhook, vector, body), vector["expect"])

    def test_подпись_считается_по_исходному_utf8_а_не_повторному_json(self):
        for name in ["valid", "valid-utf8-body", "valid-empty-body"]:
            vector = CASES[name]
            with self.subTest(vector=name):
                self.assertEqual(webhook.sign(vector["secret"], vector["body"], vector["now_s"]), vector["header"])
                self.assertEqual(webhook.sign(vector["secret"], vector["body"].encode("utf-8"), vector["now_s"]), vector["header"])

    def test_сравнение_настоящей_подписи_идёт_через_compare_digest(self):
        digest_contract(webhook)

    def test_несколько_подписей_проверяются_даже_после_первого_совпадения(self):
        vector = CASES["valid"]
        header = vector["header"] + ",v1=" + "0" * 64
        original = webhook.hmac.compare_digest
        with patch.object(webhook.hmac, "compare_digest", wraps=original) as compare:
            self.assertTrue(webhook.verify_signature(vector["secret"], header, vector["body"], now=vector["now_s"]))
            self.assertEqual(compare.call_count, 2)

    def test_контрфакт_обычного_равенства_вместо_compare_digest_обнаруживается(self):
        reject_mutant(self, webhook, [("hmac.compare_digest(expected, v)", "(expected == v)")],
                      digest_contract, "R307_COMPARE_DIGEST")

    def test_контрфакт_окна_3000_секунд_принимающего_просроченную_подпись_обнаруживается(self):
        def probe(module):
            contract_equal(verify(module, CASES["too-old"]), False, "R307_WINDOW")
        reject_mutant(self, webhook, [("DEFAULT_TOLERANCE_S = 300", "DEFAULT_TOLERANCE_S = 3000")], probe, "R307_WINDOW")

    def test_контрфакт_подставленного_времени_при_отсутствии_t_обнаруживается(self):
        def probe(module):
            contract_equal(verify(module, CASES["no-t"]), False, "R307_MISSING_T")
        reject_mutant(self, webhook, [("t: Optional[int] = None", "t: Optional[int] = 1790000000")], probe, "R307_MISSING_T")
