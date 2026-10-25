import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as imageAnimation from './imageAnimation';
import * as rules from './animatedAvatar';

const source = readFileSync(new URL('./animatedAvatar.ts', import.meta.url), 'utf8');
const day = 86_400_000;
const now = Date.UTC(2026, 9, 19);
type Rules = typeof rules;

function load(raw: string): Rules {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require(id: string) { assert.equal(id, './imageAnimation'); return imageAnimation; } });
  return module.exports as Rules;
}

function changed(from: string, to: string) {
  assert.equal(source.split(from).length, 2, `единственный якорь мутанта: ${from}`);
  return source.replace(from, to);
}

function clampScenario(r: Rules) {
  for (const junk of [undefined, null, true, false, '90', '', {}, [], NaN, Infinity, -Infinity]) {
    assert.equal(r.clampAvatarRentalMaxDays(junk), 60, 'R279-clamp: мусор не превращается в бесплатную/вечную аренду');
  }
  for (const [input, expected] of [[10, 30], [29, 30], [30, 30], [60, 60], [90.99, 90], [365, 365], [366, 365], [999, 365]]) {
    assert.equal(r.clampAvatarRentalMaxDays(input), expected, 'R279-clamp: настройка ограничена включительным интервалом 30…365');
  }
}

test('R279 мусор даёт 60, границы 30 и 365 включены, дробь округляется вниз', () => {
  // Класс ошибки: повреждённая настройка убивает первую покупку или превращает аренду в бессрочную.
  clampScenario(rules);
});

test('R279 дни склоняются по числу, включая исключения 11 и 112', () => {
  // Класс ошибки: цифровая подсказка сообщает правильный срок неграмотной или неоднозначной формой.
  for (const [n, expected] of [[1, '1 день'], [2, '2 дня'], [5, '5 дней'], [11, '11 дней'], [21, '21 день'], [22, '22 дня'], [112, '112 дней']] as const) {
    assert.equal(rules.pluralDays(n), expected);
  }
});

function textScenario(r: Rules) {
  assert.equal(r.avatarRentalFullText(60), 'Больше чем на 60 дней вперёд не оплатить — продлить можно, когда останется 30 дней или меньше', 'R279-text: текст сообщает потолок и допустимый остаток');
  assert.equal(r.avatarRentalFullText(90), 'Больше чем на 90 дней вперёд не оплатить — продлить можно, когда останется 60 дней или меньше', 'R279-text: текст сообщает потолок и допустимый остаток');
  assert.equal(r.avatarRentalFullText(30), 'Больше чем на 30 дней вперёд не оплатить — продлить можно, когда аренда закончится', 'R279-text: текст сообщает потолок и допустимый остаток');
  assert.equal(r.avatarRentalFullText(), r.avatarRentalFullText(60));
}

test('R279 отказ называет настоящий потолок 60/90, а при 30 ждёт окончания аренды', () => {
  // Класс ошибки: зашитые 60 дней дают ложное обещание после смены настройки инстанса.
  textScenario(rules);
});

function boundaryScenario(r: Rules) {
  for (const max of [30, 60, 90]) {
    const edge = now + (max - 30) * day;
    assert.equal(r.avatarRentalCanExtend(edge, now, undefined, max), true, 'R279-boundary: ровно потолок после покупки разрешён');
    assert.equal(r.avatarRentalExtendFrom(edge, now, undefined, max), null);
    assert.equal(r.avatarRentalCanExtend(edge + 1, now, undefined, max), false, 'R279-boundary: миллисекунда сверх потолка запрещена');
    assert.equal(r.avatarRentalExtendFrom(edge + 1, now, undefined, max), now + 1);
    assert.equal(r.avatarRentalCanExtend(null, now, undefined, max), true);
    assert.equal(r.avatarRentalCanExtend(now - day, now, undefined, max), true);
  }
}

test('R279 потолки 30/60/90 разрешают ровно границу и запрещают следующую миллисекунду', () => {
  // Класс ошибки: строгая граница лишает своевременного продления, округление суток даёт лишний срок.
  boundaryScenario(rules);
});

for (const [label, from, to, scenario, marker] of [
  ['нулевая нижняя граница', 'AVATAR_RENTAL_MAX_DAYS_MIN = AVATAR_RENTAL_DAYS', 'AVATAR_RENTAL_MAX_DAYS_MIN = 0', clampScenario, 'R279-clamp: настройка ограничена включительным интервалом 30…365'],
  ['верхняя граница 366', 'AVATAR_RENTAL_MAX_DAYS_LIMIT = 365', 'AVATAR_RENTAL_MAX_DAYS_LIMIT = 366', clampScenario, 'R279-clamp: настройка ограничена включительным интервалом 30…365'],
  ['строгая граница срока', 'nowMs <= maxDays * DAY_MS', 'nowMs < maxDays * DAY_MS', boundaryScenario, 'R279-boundary: ровно потолок после покупки разрешён'],
  ['зашитый потолок в тексте', 'pluralDays(maxDays)', 'pluralDays(60)', textScenario, 'R279-text: текст сообщает потолок и допустимый остаток'],
] as const) {
  test(`R279 контрфакт «${label}» ломает предметную проверку после зелёного оригинала`, () => {
    // Класс ошибки: мутант обязан упасть на поведении, не на импорте или настройке стенда.
    scenario(load(source));
    const mutant = from === 'pluralDays(maxDays)' ? source.replaceAll(from, to) : changed(from, to);
    if (from === 'pluralDays(maxDays)') assert.equal(source.split(from).length, 3);
    assert.throws(() => scenario(load(mutant)), (error: unknown) => error instanceof assert.AssertionError && error.message.split('\n', 1)[0] === marker);
  });
}
