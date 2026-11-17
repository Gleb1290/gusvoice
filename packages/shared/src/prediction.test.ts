import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { counterfact } from '../test/counterfacts.js';

type Rules = typeof import('./prediction.js');
type Edit = { from: string; to: string };
const source = readFileSync(new URL('./prediction.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(edit?: Edit): Rules {
  let text = source;
  if (edit) {
    assert.equal(text.split(edit.from).length, 2, 'R335 setup: уникальный якорь целого prediction.ts');
    text = text.replace(edit.from, edit.to);
  }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { throw new Error(`R335 setup: неожиданный импорт ${id}`); } });
  return module.exports as Rules;
}
function proof(prefix: string, run: (r: Rules) => void, edit: Edit) {
  run(load());
  counterfact(() => {
    assert.throws(() => run(load(edit)), e => e instanceof assert.AssertionError && e.message.startsWith(prefix));
  });
  run(load());
}
const stakes = (win: number, lose: number) => [{ key: 'w', amount: win, winner: true }, { key: 'l', amount: lose, winner: false }];
test('перекос 950/50: угадавший получает 995, комиссия только 5', () => proof('R335 перекос:', r => {
  const result = r.splitParimutuel(stakes(950, 50), 10);
  assert.equal(result.payouts.get('w'), 995, 'R335 перекос: ставка плюс прибыль');
  assert.equal(result.payouts.get('l'), 0); assert.equal(result.fee, 5); assert.equal(result.refundAll, false);
}, { from: 'amount + Math.floor((distributable * amount) / winStake)', to: 'Math.floor(((winStake + losePool) * (100 - pct) / 100) * amount / winStake)' }));
test('нет угаданных и нет проигравших: возврат всей ставки без комиссии', () => proof('R335 возврат:', r => {
  for (const winner of [true, false]) {
    const result = r.splitParimutuel([{ key: 'x', amount: 7, winner }], 10);
    assert.equal(result.refundAll, true, 'R335 возврат: пустая сторона банка');
    assert.equal(result.payouts.get('x'), 7); assert.equal(result.fee, 0);
  }
  assert.equal(r.splitParimutuel([], 10).refundAll, true);
}, { from: 'winStake <= 0 || losePool <= 0', to: 'winStake < 0 || losePool < 0' }));
test('дроби округляются вниз, неразданный остаток сгорает', () => proof('R335 дробь:', r => {
  const result = r.splitParimutuel([{ key: 'a', amount: 2, winner: true }, { key: 'b', amount: 1, winner: true }, { key: 'c', amount: 2, winner: false }], 0);
  assert.equal(result.payouts.get('a'), 3, 'R335 дробь: не округлять вверх');
  assert.equal(result.payouts.get('b'), 1); assert.equal(result.fee, 1);
}, { from: 'Math.floor((distributable * amount) / winStake)', to: 'Math.ceil((distributable * amount) / winStake)' }));
test('на сетке банков выплаты сохраняют деньги и не съедают ставку победителя', () => proof('R335 инварианты:', r => {
  for (const w of [1, 3, 50, 950]) for (const l of [1, 7, 50, 1000]) for (const fee of [0, 10, 100]) {
    const result = r.splitParimutuel(stakes(w, l), fee);
    assert.ok(result.payouts.get('w')! >= w, 'R335 инварианты: победитель не уходит в минус');
    assert.equal([...result.payouts.values()].reduce((a, b) => a + b, 0) + result.fee, w + l);
    assert.ok(result.fee >= 0);
  }
}, { from: 'amount + Math.floor((distributable * amount) / winStake)', to: 'Math.floor((distributable * amount) / winStake)' }));
test('комиссия зажимается в 0..100 и берётся целым процентом', () => proof('R335 комиссия:', r => {
  const payout = (fee: number) => r.splitParimutuel(stakes(100, 100), fee).payouts.get('w');
  assert.equal(payout(101), 100, 'R335 комиссия: потолок процента');
  assert.equal(payout(-1), 200); assert.equal(payout(10.9), 190);
}, { from: 'Math.min(100, Math.max(0, Math.floor(feePercent)))', to: 'Math.max(0, Math.floor(feePercent))' }));
test('прикидка добавляет мою ставку к существующему выигрышному пулу', () => proof('R335 прикидка:', r => {
  assert.equal(r.predictionEstimate([{ id: 'a', pool: 100 }, { id: 'b', pool: 100 }], 'a', 100, 10), 145, 'R335 прикидка: свою долю нельзя считать единственной');
  assert.equal(r.predictionEstimate([{ id: 'a', pool: 0 }, { id: 'b', pool: 100 }], 'a', 100, 10), 190);
  assert.equal(r.predictionEstimate([{ id: 'a', pool: 100 }], 'a', 100, 10), 100);
}, { from: 'amount: Math.max(0, o.pool)', to: 'amount: o.id === optionId ? 0 : Math.max(0, o.pool)' }));
test('прикидка отвергает дробную/нулевую ставку и неизвестный вариант, целую принимает', () => proof('R335 ввод:', r => {
  const options = [{ id: 'a', pool: 10 }, { id: 'b', pool: 100 }];
  assert.equal(r.predictionEstimate(options, 'a', 1.5, 10), 0, 'R335 ввод: монеты целые');
  for (const amount of [0, -1, NaN, Infinity]) assert.equal(r.predictionEstimate(options, 'a', amount, 10), 0);
  assert.equal(r.predictionEstimate(options, 'missing', 1, 10), 0);
  assert.ok(r.predictionEstimate(options, 'a', 1, 10) >= 1);
}, { from: '!Number.isInteger(amount) || ', to: '' }));
