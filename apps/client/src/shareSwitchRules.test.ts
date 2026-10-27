import assert from 'node:assert/strict';
import { it } from 'node:test';
import { shareSwitchErrorText } from './shareErrorText';
import { captureOptions, webCaptureOptions, STREAM_DEFAULTS } from './streamSettings';

const tail = ' Показ продолжается прежним источником.';
for (const [reason, expected] of [
  ['показ не идёт', 'Показ уже не идёт — начните его заново.'],
  ['источник не открылся: dxgi', `Источник не открылся: возможно, окно закрыли.${tail}`],
  ['источник не найден', `Источник не открылся: возможно, окно закрыли.${tail}`],
  ['исчез', `Источник не открылся: возможно, окно закрыли.${tail}`],
  ['таймаут', `Источник не ответил за 3 секунды.${tail}`],
  ['timeout', `Источник не ответил за 3 секунды.${tail}`],
  ['signal timed out', `Источник не ответил за 3 секунды.${tail}`],
  ['неизвестный отказ', `Не удалось сменить источник: неизвестный отказ.${tail}`],
] as const) it(`R304 смена источника объясняет строку и Error: ${reason}`, () => {
  assert.equal(shareSwitchErrorText(reason), expected); assert.equal(shareSwitchErrorText(new Error(reason)), expected);
});
it('R304 пустая причина смены не печатает undefined и двоеточие', () => {
  for (const value of [null, undefined, '', {}, new Error('')])
    assert.equal(shareSwitchErrorText(value), `Не удалось сменить источник.${tail}`);
});
for (const audio of [false, true]) it(`R304 браузер добавляет surfaceSwitching, нативный путь его не получает (звук ${audio})`, () => {
  const s = { ...STREAM_DEFAULTS, audio };
  const native = captureOptions(s), web = webCaptureOptions(s);
  assert.equal(Object.hasOwn(native, 'surfaceSwitching'), false);
  assert.deepEqual(web, { ...native, surfaceSwitching: 'include' });
  assert.equal(Object.hasOwn(captureOptions(s), 'surfaceSwitching'), false, 'веб не мутирует общий шаблон');
});
