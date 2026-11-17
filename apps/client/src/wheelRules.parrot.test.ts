import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as actual from './wheelRules.js';

type Rules = Pick<typeof actual, 'parrotMood' | 'WHEEL_MOOD_MS'>;
type Last = NonNullable<Parameters<Rules['parrotMood']>[0]>;
const now = Date.parse('2026-10-29T12:00:00.000Z');
const result = (extra: Partial<Last> = {}): Last => ({
  jackpotHit: false, settledAt: new Date(now).toISOString(), winners: [], ...extra,
});
const winner = (userId: string, payout: number): Last['winners'][number] => ({ userId, pick: 1, payout });
const source = readFileSync(new URL('./wheelRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function changed(before: string, after: string): Rules {
  assert.equal(source.split(before).length - 1, 1, 'R352/parrot/prepare единственный якорь мутанта');
  const module = { exports: {} };
  // Загружается весь самостоятельный модуль с настоящим shared, а не вырезанная функция.
  const output = ts.transpileModule(source.replace(before, after), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  runInNewContext(output, { module, exports: module.exports, require(id: string) {
    assert.equal(id, '@gusvoice/shared', 'R352/parrot/prepare неожиданный импорт');
    return shared;
  } }, { timeout: 1000, filename: 'wheelRules.parrot.r352.cjs' });
  return module.exports as Rules;
}

test('R352 казначей ставит джекпот выше своего выигрыша и любой чужой выплаты', () => {
  // Приоритет срыва одинаков для участника, зрителя и отсутствующего в снимке пользователя.
  for (const me of ['me', null]) for (const iBet of [false, true]) {
    assert.equal(actual.parrotMood(result({ jackpotHit: true, winners: [winner('me', 10), winner('other', 20)] }), me, iBet, now), 'jackpot');
  }
});

test('R352 свой положительный выигрыш радует попугая, нулевая выплата не выдаётся за выигрыш', () => {
  assert.equal(actual.parrotMood(result({ winners: [winner('me', 1)] }), 'me', true, now), 'cheer');
  assert.equal(actual.parrotMood(result({ winners: [winner('me', 1)] }), 'me', false, now), 'cheer');
  for (const payout of [0, -1]) {
    assert.equal(actual.parrotMood(result({ winners: [winner('me', payout)] }), 'me', true, now), 'sad');
  }
});

test('R352 ставивший мимо видит грусть даже при чужом выигрыше, а не чужое ликование', () => {
  for (const winners of [[], [winner('other', 15)], [winner('me', 0)]]) {
    assert.equal(actual.parrotMood(result({ winners }), 'me', true, now), 'sad');
  }
});

function spectatorContract(rules: Rules) {
  for (const me of ['me', null]) {
    assert.equal(rules.parrotMood(result({ winners: [winner('other', 1)] }), me, false, now), 'cheer',
      'R352/parrot/spectator зритель радуется положительному чужому выигрышу');
  }
}

test('R352 не ставивший казначей радуется за победителя — контрфакт потери ветки зрителя', () => {
  spectatorContract(actual);
  counterfact(() => {
  const mutant = changed("return fresh && last.winners.some((w) => w.payout > 0) ? 'cheer' : 'idle';", "return 'idle';");
  assert.throws(() => spectatorContract(mutant), error => error instanceof assert.AssertionError &&
    error.message.includes('R352/parrot/spectator'));
  });
});

test('R352 без положительных выплат зритель остаётся в ожидании независимо от наличия своего id', () => {
  for (const winners of [[], [winner('other', 0)], [winner('other', -1)]]) {
    for (const me of ['me', null]) assert.equal(actual.parrotMood(result({ winners }), me, false, now), 'idle');
  }
});

function windowContract(rules: Rules) {
  assert.equal(rules.WHEEL_MOOD_MS, 8000, 'R352/parrot/window окно эмоции равно восьми секундам');
  // Именно зритель проходит собственную проверку <= в parrotMood, а не только проверку wheelMood.
  const won = result({ winners: [winner('other', 1)] });
  for (const offset of [rules.WHEEL_MOOD_MS - 1, rules.WHEEL_MOOD_MS]) {
    assert.equal(rules.parrotMood(won, 'me', false, now + offset), 'cheer',
      'R352/parrot/window последняя миллисекунда окна ещё показывает радость зрителя');
  }
  for (const [last, iBet] of [[won, false], [won, true], [result({ jackpotHit: true }), false],
    [result({ winners: [winner('me', 1)] }), true]] as const) {
    assert.equal(rules.parrotMood(last, 'me', iBet, now + rules.WHEEL_MOOD_MS + 1), 'idle',
      'R352/parrot/window первая миллисекунда после окна снимает любую эмоцию');
  }
}

test('R352 окно эмоции включает ровно границу и исключает следующую миллисекунду — контрфакт строгого сравнения', () => {
  windowContract(actual);
  counterfact(() => {
  const mutant = changed('serverNowMs - at <= WHEEL_MOOD_MS;', 'serverNowMs - at < WHEEL_MOOD_MS;');
  assert.throws(() => windowContract(mutant), error => error instanceof assert.AssertionError &&
    error.message.includes('R352/parrot/window'));
  });
});

test('R352 отсутствующий итог и непарсибельная дата не создают эмоцию даже со срывом и выплатой', () => {
  for (const me of ['me', null]) for (const iBet of [false, true]) {
    assert.equal(actual.parrotMood(null, me, iBet, now), 'idle');
    for (const settledAt of ['', 'not-a-date', '2026-99-99T00:00:00Z']) {
      assert.equal(actual.parrotMood(result({ settledAt, jackpotHit: true, winners: [winner('me', 10)] }), me, iBet, now), 'idle');
    }
  }
});
