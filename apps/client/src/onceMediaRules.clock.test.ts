import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as rules from './onceMediaRules';

const source = readFileSync(new URL('./onceMediaRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const photo = { contentType: 'image/jpeg', onceTtl: 10 };
const received = 1_000_000;

// Загружается целый модуль с настоящими shared-правилами, не вырезанная и переизобретённая формула.
function load(raw: string): typeof rules {
  const file = ts.createSourceFile('onceMediaRules.ts', raw, ts.ScriptTarget.Latest, true);
  assert.equal((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0);
  const module = { exports: {} };
  const compiled = ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  runInNewContext(compiled, { module, exports: module.exports, require: (id: string) => {
    assert.equal(id, '@gusvoice/shared', 'единственная граница чистого модуля'); return shared;
  } }, { timeout: 2000 });
  return module.exports as typeof rules;
}

function skew(r = rules) {
  // Часы устройства не обязаны совпадать с серверными: ни +6, ни -6 с не меняют десятисекундный срок.
  for (const offset of [-6000, 6000])
    assert.equal(r.onceDeadlineLocal(photo, received + offset, received + offset, received), received + 10_000,
      'R269:полный-срок-от-локального-получения');
}
it('R269 сервер впереди и позади на шесть секунд даёт одинаковые десять секунд просмотра', () => skew());

it('R269 время получения ответа задаёт локальный отсчёт, абсолютный год серверных часов не влияет', () => {
  // Сравнение абсолютных дат вместо разности ломает просмотр на неверно выставленных часах.
  for (const server of [0, 50_000, 9_000_000_000_000]) {
    assert.equal(rules.onceDeadlineLocal(photo, server, server + 4000, received), received + 6000);
    assert.equal(rules.onceDeadlineLocal(photo, server, server + 4000, received + 321), received + 6321);
  }
});

it('R269 повторное открытие спустя четыре серверных секунды сохраняет шесть, а не перезапускает десять', () => {
  // Повтор запроса не должен продлевать срок первого открытия.
  assert.equal(rules.onceDeadlineLocal(photo, 900_000, 904_000, received), received + 6000);
});

it('R269 за миллисекунду до истечения остаётся миллисекунда, на границе и после неё ноль', () => {
  // Ошибка на единицу или отрицательный остаток закрывают просмотр раньше либо уводят дедлайн в прошлое.
  for (const [elapsed, remaining] of [[9999, 1], [10_000, 0], [10_001, 0], [999_999, 0]] as const)
    assert.equal(rules.onceDeadlineLocal(photo, 10_000, 10_000 + elapsed, received), received + remaining);
});

function backwards(r = rules) {
  // Отрицательная разность из-за коррекции серверных часов не дарит дополнительные четыре секунды.
  assert.equal(r.onceDeadlineLocal(photo, 50_000, 46_000, received), received + 10_000,
    'R269:отрицательное-прошедшее-не-продлевает');
}
it('R269 серверное время раньше первого открытия не удлиняет полный срок', () => backwards());

it('R269 старый сервер без serverNow даёт полный срок от получения даже при старом openedAt', () => {
  // Date.parse отсутствующего/невалидного ISO возвращает NaN; fallback сохраняет просмотр, а не NaN-дедлайн.
  for (const invalid of [Date.parse(''), Number.NaN, Infinity, -Infinity])
    assert.equal(rules.onceDeadlineLocal(photo, 123, invalid, received), received + 10_000);
});

it('R269 неразобранный openedAt тоже оставляет полный срок вместо исчезнувшего просмотра', () => {
  // Невалидная одна дата не должна отравлять арифметику даже при валидной второй.
  for (const invalid of [Number.NaN, Infinity, -Infinity])
    assert.equal(rules.onceDeadlineLocal(photo, invalid, 123, received), received + 10_000);
});

it('R269 видео сохраняет больший из таймера и длины ролика с вычетом уже просмотренного', () => {
  // Короткий таймер не должен обрывать ролик; длинный не должен сокращаться до длины ролика.
  assert.equal(rules.onceDeadlineLocal({ contentType: 'video/mp4', onceTtl: 3, durationMs: 12_000 }, 100, 4100, received), received + 8000);
  assert.equal(rules.onceDeadlineLocal({ contentType: 'video/mp4', onceTtl: 30, durationMs: 12_000 }, 100, 4100, received), received + 26_000);
  assert.equal(rules.onceDeadlineLocal({ contentType: 'video/webm', onceTtl: 3, durationMs: 3000 }, 100, 3100, received), received);
  assert.equal(rules.onceDeadlineLocal({ contentType: 'video/mp4', onceTtl: 3, durationMs: null }, 100, 1100, received), received + 2000);
});

it('R269 длительность из метаданных фото не удлиняет таймер, у видео без serverNow остаётся полный ролик', () => {
  // Ошибочный duration у фото и fallback старого сервера должны оставаться разными ветками.
  assert.equal(rules.onceDeadlineLocal({ ...photo, durationMs: 90_000 }, 100, 4100, received), received + 6000);
  assert.equal(rules.onceDeadlineLocal({ contentType: 'video/mp4', onceTtl: 3, durationMs: 12_000 }, 100, NaN, received), received + 12_000);
});

it('R269 отсутствие таймера и просмотр один раз не получают дедлайна даже у длинного видео', () => {
  // Ноль означает сгорание при закрытии, не немедленное автоматическое сгорание.
  for (const contentType of ['image/jpeg', 'video/mp4']) for (const onceTtl of [undefined, 0])
    assert.equal(rules.onceDeadlineLocal({ contentType, onceTtl, durationMs: 90_000 }, 100, 4100, received), null);
});

it('R269 крайние разрешённые таймеры одна и шестьдесят секунд сохраняют миллисекундную точность', () => {
  // Преждевременное округление целыми секундами отнимает почти секунду либо продлевает доступ.
  for (const onceTtl of [1, 60]) {
    assert.equal(rules.onceDeadlineLocal({ ...photo, onceTtl }, 100, 100, received), received + onceTtl * 1000);
    assert.equal(rules.onceDeadlineLocal({ ...photo, onceTtl }, 100, 101, received), received + onceTtl * 1000 - 1);
  }
});

for (const [label, from, to, scenario, marker] of [
  ['дедлайн опять привязан к openedAt', 'return receivedAtMs + Math.max(0, span - elapsed);',
    'return openedAtMs + Math.max(0, span - elapsed);', skew, 'R269:полный-срок-от-локального-получения'],
  ['отрицательное прошедшее увеличивает остаток', 'Math.max(0, serverNowMs - openedAtMs)',
    '(serverNowMs - openedAtMs)', backwards, 'R269:отрицательное-прошедшее-не-продлевает'],
] as const) it(`R269 контрфакт: ${label} обнаруживается адресным результатом, не ошибкой импорта`, () => {
  scenario();
  assert.equal(source.split(from).length - 1, 1, 'единственная точка мутации');
  assert.throws(() => scenario(load(source.replace(from, to))), error => error instanceof assert.AssertionError
    && error.message.includes(marker));
});
