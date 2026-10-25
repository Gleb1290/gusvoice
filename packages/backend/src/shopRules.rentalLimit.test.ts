import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as coinRules from './coinRules.js';
import * as rules from './shopRules.js';

const source = readFileSync(new URL('./shopRules.ts', import.meta.url), 'utf8');
const now = new Date('2026-10-19T00:00:00Z');
const day = 86_400_000;
function scenario(r: typeof rules) {
  for (const max of [30, 60, 90]) {
    const edge = new Date(now.getTime() + (max - 30) * day);
    assert.equal(r.avatarRentalFull(edge, now, max), false, 'R279-full: backend принимает включительный потолок настройки');
    assert.equal(r.avatarRentalFull(new Date(edge.getTime() + 1), now, max), true, 'R279-full: backend не игнорирует изменённый потолок');
    assert.equal(r.avatarRentalFull(null, now, max), false);
  }
}
test('R279 серверное правило уважает потолки 30/60/90 и обе стороны границы', () => {
  // Класс ошибки: HTTP-код может незаметно вернуть фиксированные 60 при верном общем правиле.
  scenario(rules);
});
test('R279 уменьшение потолка не сокращает уже оплаченную аренду', () => {
  // Класс ошибки: новая настройка отбирает оплаченные дни вместо блокировки следующей покупки.
  const paid = new Date(now.getTime() + 85 * day);
  const previous = paid.getTime();
  assert.equal(rules.avatarRentalFull(paid, now, 30), true);
  assert.equal(rules.avatarRentalActive(paid, now), true);
  assert.equal(rules.animatedAvatarFor('/paid.gif', paid, now), '/paid.gif');
  assert.equal(paid.getTime(), previous);
});
test('R279 контрфакт игнорирования maxDays ловится после успешного оригинала', () => {
  // Класс ошибки: доказательство чувствительности правила не должно засчитывать падение загрузчика.
  function load(raw: string): typeof rules {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, Date, require(id: string) {
        if (id === '@gusvoice/shared') return shared;
        assert.equal(id, './coinRules.js'); return coinRules;
      } });
    return module.exports as typeof rules;
  }
  scenario(load(source));
  const from = 'now.getTime(), AVATAR_RENTAL_DAYS, maxDays)';
  assert.equal(source.split(from).length, 2);
  assert.throws(() => scenario(load(source.replace(from, 'now.getTime(), AVATAR_RENTAL_DAYS)'))),
    (error: unknown) => error instanceof assert.AssertionError && error.message.split('\n', 1)[0] === 'R279-full: backend не игнорирует изменённый потолок');
});
