import { counterfact as gatedCounterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
type Rules = typeof import('./gamePredictionRules.js');
type Edit = { file?: string; from: string; to: string };
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function load(edit?: Edit): Rules {
  const cache = new Map<string, any>();
  function moduleOf(name: string): any {
    if (cache.has(name)) return cache.get(name);
    assert.ok(['gamePredictionRules', 'gameMoneyRules', 'coinRules'].includes(name), `R335 setup: закрытый импорт ${name}`);
    let source = readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    if ((edit?.file ?? 'gamePredictionRules') === name && edit) {
      assert.equal(source.split(edit.from).length, 2, 'R335 setup: уникальный якорь целого модуля'); source = source.replace(edit.from, edit.to);
    }
    const module = { exports: {} }; cache.set(name, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      module, exports: module.exports, require(id: string) {
        if (id === '@gusvoice/shared') return shared;
        assert.ok(id.startsWith('.'), `R335 setup: внешний импорт ${id}`);
        return moduleOf(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
      },
    }); return module.exports;
  }
  return moduleOf('gamePredictionRules');
}
function proof(prefix: string, run: (r: Rules) => void, edit: Edit) {
  run(load()); gatedCounterfact(() => { assert.throws(() => run(load(edit)), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)); }); run(load());
}
const draft = () => ({ title: 'Событие', lockInSec: null as number | null, questions: [{ question: 'Вопрос', options: ['Да', 'Нет'] }] });
for (const [field, max, target] of [['title', 120, 'title'], ['q0', 200, 'question'], ['q0.o0', 80, 'option']] as const) {
  test(`редактор: ${field} допускает длину ровно ${max}, отклоняет ${max + 1} и пустое поле`, () => proof(`R335 длина ${field}:`, r => {
    for (const [length, accepted] of [[0, false], [1, true], [max, true], [max + 1, false]] as const) {
      const d = draft(); if (target === 'title') d.title = 'x'.repeat(length); else if (target === 'question') d.questions[0].question = 'x'.repeat(length); else d.questions[0].options[0] = 'x'.repeat(length);
      const out = r.validatePredictionDraft(d);
      assert.equal(out.ok, accepted, `R335 длина ${field}: точная граница ${length}`); if (!out.ok) assert.equal(out.field, field);
    }
  }, { from: target === 'title' ? 'title.length > PREDICTION_TITLE_MAX' : target === 'question' ? 'question.length > PREDICTION_QUESTION_MAX' : 'label.length > PREDICTION_OPTION_MAX', to: target === 'title' ? 'title.length >= PREDICTION_TITLE_MAX' : target === 'question' ? 'question.length >= PREDICTION_QUESTION_MAX' : 'label.length >= PREDICTION_OPTION_MAX' }));
}
test('редактор: 1..10 вопросов, 2..10 вариантов, поле ошибки указывает вопрос с нуля', () => proof('R335 количество:', r => {
  for (const n of [0, 1, 10, 11]) { const d = draft(); d.questions = Array.from({ length: n }, () => draft().questions[0]); const out = r.validatePredictionDraft(d); assert.equal(out.ok, n >= 1 && n <= 10, 'R335 количество: предел вопросов'); if (!out.ok) assert.equal(out.field, 'questions'); }
  for (const n of [1, 2, 10, 11]) { const d = draft(); d.questions[0].options = Array.from({ length: n }, (_, i) => `v${i}`); const out = r.validatePredictionDraft(d); assert.equal(out.ok, n >= 2 && n <= 10); if (!out.ok) assert.equal(out.field, 'q0.options'); }
}, { from: 'qs.length > PREDICTION_MAX_QUESTIONS', to: 'qs.length >= PREDICTION_MAX_QUESTIONS' }));
test('редактор: ручное закрытие и таймер 30 с..7 суток, целые границы включены', () => proof('R335 таймер:', r => {
  for (const value of [null, undefined, 30, 604800, 29, 604801, 30.5, '30', NaN]) { const d = { ...draft(), lockInSec: value }; const out = r.validatePredictionDraft(d); const accepted = value == null || value === 30 || value === 604800; assert.equal(out.ok, accepted, 'R335 таймер: обе стороны границы'); if (!out.ok) assert.equal(out.field, 'lock'); }
}, { from: 'v < PREDICTION_LOCK_MIN_SEC', to: 'v <= PREDICTION_LOCK_MIN_SEC' }));
test('редактор: чистит управляющие символы, варианты без повторов регистра, id раздаёт сервер', () => proof('R335 варианты:', r => {
  assert.deepEqual(normal(r.validatePredictionDraft({ title: ' A\n B ', questions: [{ question: '\t Q ', options: [' Да ', 'Нет'] }] })), { ok: true, draft: { title: 'A B', lockInSec: null, questions: [{ question: 'Q', options: [{ id: 'o1', label: 'Да' }, { id: 'o2', label: 'Нет' }] }] } });
  assert.deepEqual(normal(r.validatePredictionDraft({ title: 'x', questions: [{ question: 'q', options: ['Да', 'дА'] }] })), { ok: false, field: 'q0.o1' }, 'R335 варианты: регистр не создаёт второй исход');
}, { from: "label.toLocaleLowerCase('ru')", to: 'label' }));
test('итог: каждый вопрос обязателен, чужие ключи и исходы запрещены, null принимается', () => proof('R335 исходы:', r => {
  const qs = [{ id: 'q1', options: [{ id: 'o1' }] }, { id: 'q2', options: [{ id: 'o2' }] }];
  assert.equal(r.checkPredictionWinners(qs, { q1: 'alien', q2: null }), null, 'R335 исходы: вариант должен принадлежать вопросу');
  for (const winners of [{ q1: 'o1' }, { q1: 'o1', extra: null }, { q1: 'o1', q2: 'o2', extra: null }, { q1: 1, q2: null }]) assert.equal(r.checkPredictionWinners(qs, winners), null);
  assert.deepEqual(normal([...r.checkPredictionWinners(qs, { q1: 'o1', q2: null })!]), [['q1', 'o1'], ['q2', null]]);
  assert.equal(r.checkPredictionWinners(qs, Object.assign(Object.create({ q1: 'o1' }), { q2: null, other: 1 })), null);
}, { from: "typeof w === 'string' && q.options.some((o) => o.id === w)", to: "typeof w === 'string'" }));
test('план выплаты считает только живые ставки; не состоялся и пустая сторона возвращают', () => proof('R335 живые:', r => {
  const stake = (userId: string, pick: string, amount: number, paidAt: Date | null = null, refundedAt: Date | null = null) => ({ userId, pick, amount, payout: null, paidAt, refundedAt });
  const s = [stake('w', 'o1', 950), stake('l', 'o2', 50), stake('gone', 'o2', 900, null, new Date()), stake('paid', 'o2', 800, new Date())];
  const plan = r.predictionSettlePlan(s, 'o1', 10);
  assert.equal(plan.pool, 1000, 'R335 живые: возврат не входит в банк'); assert.equal(plan.fee, 5); assert.deepEqual(normal(plan.payouts), [{ userId: 'w', pick: 'o1', payout: 995 }, { userId: 'l', pick: 'o2', payout: 0 }]);
  for (const winner of [null, 'o9']) assert.equal(r.predictionSettlePlan(s, winner, 10).refund, true);
  assert.equal(r.predictionSettlePlan([s[0]], 'o1', 10).refund, true);
}, { from: 's.paidAt === null && s.refundedAt === null', to: 's.paidAt === null' }));
test('автоотмена через семь суток включительно, но не раньше и не в другом состоянии', () => proof('R335 срок:', r => {
  const lockedAt = new Date(0); const event = { state: 'locked' as const, lockedAt };
  for (const ms of [604799999, 604800000, 604800001]) assert.equal(r.predictionAutoCancelDue(event, new Date(ms)), ms >= 604800000, 'R335 срок: точный край');
  assert.equal(r.predictionAutoCancelDue({ state: 'open', lockedAt }, new Date(700000000)), false);
  assert.equal(r.predictionAutoCancelDue({ state: 'locked', lockedAt: null }, new Date(700000000)), false);
}, { from: '>= PREDICTION_AUTO_CANCEL_MS', to: '> PREDICTION_AUTO_CANCEL_MS' }));
