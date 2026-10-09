import assert from 'node:assert/strict';
import { it } from 'node:test';
import { maskNotice, normalizeNotifyRepeat, normalizeNotifyView, notifyRepeatAllowed, notifyRepeatInWindow, NOTIFY_REPEAT_GRACE_MS, NOTIFY_REPEAT_MAX, NOTIFY_REPEAT_WINDOW_MIN, notifyRepeatLabel, notifyShowsName, notifyShowsText, notifyViewOf } from './notifyView.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { localHourIn, validTimeZone, notifyRepeatHourOk, notifyRepeatWaitMs } from './notifyView.js';

it('пояс проверяется реальным Intl: Москва отличается от UTC, мусор и неверная дата безопасны', () => {
  const at = Date.parse('2026-10-09T09:00:00Z');
  assert.equal(localHourIn('Europe/Moscow', at), 12);
  assert.equal(localHourIn('UTC', at), 9);
  assert.equal(localHourIn('UTC', Date.parse('2026-10-09T00:00:00Z')), 0);
  for (const tz of ['Europe/Moscow', 'UTC', 'Asia/Kathmandu']) assert.equal(validTimeZone(tz), true);
  for (const tz of [null, undefined, 3, '', 'Not/AZone', 'x'.repeat(65)]) assert.equal(validTimeZone(tz), false);
  for (const at of [NaN, Infinity, -Infinity]) assert.equal(localHourIn('UTC', at), null);
  assert.equal(localHourIn('Not/AZone', at), null);
});

it('окно повторов включает 11 и весь 22-й час, ночью ждёт местных 11:00', () => {
  for (const [hour, ok] of [[10, false], [11, true], [12, true], [22, true], [23, false]] as const) assert.equal(notifyRepeatHourOk(hour), ok);
  const check = (wait: typeof notifyRepeatWaitMs) => {
    for (const [local, expected] of [['09:00', 0], ['19:59', 0], ['20:00', 12 * 3600_000], ['20:30', 11.5 * 3600_000], ['07:59', 60_000], ['08:00', 0]] as const) {
      assert.equal(wait('Europe/Moscow', Date.parse(`2026-10-09T${local}:00Z`)), expected, local);
    }
    assert.equal(wait('Asia/Kathmandu', Date.parse('2026-10-09T05:14:30Z')), 30_000, 'дробный пояс и секунды не округляют ожидание до целого часа');
    for (const tz of [null, undefined, '', 'Not/AZone']) assert.equal(wait(tz, Date.parse('2026-10-09T20:30:00Z')), 0);
  };
  check(notifyRepeatWaitMs);
  const source = readFileSync(new URL('./notifyView.ts', import.meta.url), 'utf8');
  const load = (s: string) => {
    const module = { exports: {} as { notifyRepeatWaitMs: typeof notifyRepeatWaitMs } };
    runInNewContext(ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
    return module.exports.notifyRepeatWaitMs;
  };
  check(load(source));
  for (const [from, to] of [['hour <= NOTIFY_REPEAT_TO_HOUR', 'hour < NOTIFY_REPEAT_TO_HOUR'], ['hour >= NOTIFY_REPEAT_FROM_HOUR', 'hour >= 10'], ['const now = localHourIn(tz, at)', "const now = localHourIn('UTC', at)"]]) {
    assert.ok(source.includes(from));
    assert.throws(() => check(load(source.replace(from, to))), assert.AssertionError);
  }
});

it('галочка текста включает имя, но выключенные обе скрывают всё', () => {
  // Ловит недопустимый режим с текстом сообщения без имени автора.
  for (const [name, text, expected] of [[false, false, 'nothing'], [true, false, 'name'], [false, true, 'all'], [true, true, 'all']] as const) {
    assert.equal(notifyViewOf(name, text), expected);
  }
});

it('маска имени никогда не раскрывает текст, полная маска скрывает и автора', () => {
  // Ловит утечку содержимого в уведомление при выключенном предпросмотре.
  const notice = { title: 'Аня', body: 'Секрет' };
  assert.deepEqual(maskNotice('all', notice), notice);
  assert.deepEqual(maskNotice('name', notice), { title: 'Аня', body: 'Новое сообщение' });
  assert.deepEqual(maskNotice('nothing', notice), { title: 'GusVoice', body: 'Новое сообщение' });
  assert.deepEqual(notice, { title: 'Аня', body: 'Секрет' });
  for (const view of ['all', 'name', 'nothing'] as const) {
    assert.equal(notifyShowsName(view), view !== 'nothing');
    assert.equal(notifyShowsText(view), view === 'all');
  }
});

it('неизвестный режим уведомления совместим со старой настройкой', () => {
  // Ловит исчезновение уведомлений у старого клиента без нового поля.
  for (const value of [undefined, null, '', 'ALL', 0, {}, true]) assert.equal(normalizeNotifyView(value), 'all');
  for (const value of ['all', 'name', 'nothing'] as const) assert.equal(normalizeNotifyView(value), value);
});

it('повтор принимает только разрешённые числовые интервалы, не строки и не соседние минуты', () => {
  // Ловит обход whitelist интервалов через приведение типов или округление.
  for (const value of [0, 5, 10, 30, 60, 120, 240]) assert.equal(normalizeNotifyRepeat(value), value);
  for (const value of [-1, 1, 4, 6, 7, 239, 241, 5.5, NaN, Infinity, '5', null, undefined, true, {}]) assert.equal(normalizeNotifyRepeat(value), 0);
});

it('подписи повторов различают минуты и часы, мусор означает никогда', () => {
  // Ловит неверные единицы времени в выборе повторов.
  for (const [value, label] of [[0, 'Никогда'], [5, '5 минут'], [10, '10 минут'], [30, '30 минут'], [60, '1 час'], [120, '2 часа'], [240, '4 часа'], [7, 'Никогда']] as const) assert.equal(notifyRepeatLabel(value), label);
});

it('повтор ограничен одновременно числом напоминаний и сутками, обе границы включительны', () => {
  // Ловит бесконечное напоминание после удаления одного из двух независимых ограничителей.
  assert.equal(NOTIFY_REPEAT_MAX, 24);
  assert.equal(NOTIFY_REPEAT_WINDOW_MIN, 1440);
  const check = (allowed: typeof notifyRepeatAllowed) => {
    assert.equal(allowed(1, 5), true);
    assert.equal(allowed(24, 60), true);
    assert.equal(allowed(25, 60), false);
    assert.equal(allowed(24, 5), true);
    assert.equal(allowed(25, 5), false, 'короткий интервал не обходит предел числа');
    assert.equal(allowed(6, 240), true);
    assert.equal(allowed(7, 240), false, 'длинный интервал не обходит предел времени');
    for (const [n, minutes] of [[0, 60], [-1, 60], [1, 0], [1, -1], [NaN, 60], [1, Infinity]]) assert.equal(allowed(n, minutes), false);
  };
  check(notifyRepeatAllowed);
  const source = readFileSync(new URL('./notifyView.ts', import.meta.url), 'utf8');
  const load = (s: string) => {
    const module = { exports: {} as { notifyRepeatAllowed: typeof notifyRepeatAllowed } };
    runInNewContext(ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
    return module.exports.notifyRepeatAllowed;
  };
  check(load(source));
  for (const guard of ['n <= NOTIFY_REPEAT_MAX', 'n * minutes <= NOTIFY_REPEAT_WINDOW_MIN']) {
    assert.ok(source.includes(guard));
    assert.throws(() => check(load(source.replace(guard, 'true'))), assert.AssertionError);
  }
});

it('реальное окно повтора включает сутки и минуту задержки, но не лишнюю миллисекунду', () => {
  // Перенос активному ПК не растит номер: именно реальное время закрывает забытые повторы после простоя.
  assert.equal(NOTIFY_REPEAT_GRACE_MS, 60_000);
  const start = Date.parse('2026-10-08T00:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const check = (allowed: typeof notifyRepeatInWindow) => {
    assert.equal(allowed(start, start), true);
    assert.equal(allowed(start, start - 1), true, 'будущая метка соседнего процесса совместима');
    for (const first of [undefined, NaN, Infinity, -Infinity]) assert.equal(allowed(first, start), true);
    assert.equal(allowed(start, start + day), true);
    assert.equal(allowed(start, start + day + 60_000), true);
    assert.equal(allowed(start, start + day + 60_001), false);
    assert.equal(allowed(start, start + 2 * day), false);
    assert.equal(allowed(0, day + 60_000), true, 'нулевой epoch — известная метка, а не отсутствие');
    assert.equal(allowed(0, day + 60_001), false);
  };
  check(notifyRepeatInWindow);
  const source = readFileSync(new URL('./notifyView.ts', import.meta.url), 'utf8');
  const load = (s: string) => {
    const module = { exports: {} as { notifyRepeatInWindow: typeof notifyRepeatInWindow } };
    runInNewContext(ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
    return module.exports.notifyRepeatInWindow;
  };
  check(load(source));
  for (const [from, to] of [
    ['NOTIFY_REPEAT_GRACE_MS = 60_000', 'NOTIFY_REPEAT_GRACE_MS = 0'],
    ['at - firstAt <=', 'at - firstAt <'],
    ['at - firstAt <= NOTIFY_REPEAT_WINDOW_MIN * 60_000 + NOTIFY_REPEAT_GRACE_MS', 'true'],
  ]) {
    assert.ok(source.includes(from), 'якорь мутанта окна найден');
    assert.throws(() => check(load(source.replace(from, to))), assert.AssertionError);
  }
});
