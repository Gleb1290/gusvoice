import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  exitSelection, holdSelection, selectPress, selectSlopPassed, selectStartIn, selectRowAt, selectRange, selectScrollStep, selectionKey, selectUpTo,
  type SelectionKeyInput,
  SELECT_HOLD_MS, SELECT_SLOP_PX, SELECT_MAX, SELECT_SCROLL_TICK_MS, SELECT_SCROLL_MAX,
} from './dmSelection';
import { MESSAGE_BATCH_MAX } from '../../../packages/backend/src/convRules.js';

function mutatedSelection(from: string, to: string) {
  let source = readFileSync(new URL('./dmSelection.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(source.includes(from), `реальный dmSelection содержит фрагмент мутации: ${from}`);
  source = source.replace(from, to);
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  runInNewContext(output, { module: mod, exports: mod.exports, require: (id: string) => {
    assert.equal(id, 'react', 'модуль выделения использует React только для hook-подписки');
    return { useSyncExternalStore: () => {} };
  } });
  return mod.exports as typeof import('./dmSelection');
}

function mutantMustFail(actual: unknown, expected: unknown, why: string) {
  assert.throws(() => assert.deepEqual(actual, expected, why), assert.AssertionError, why);
}

it('без выделения кнопка назад остаётся обычной, после отпускания выход не вызывается', () => {
  // Ловит залипший режим выделения после ухода из переписки.
  assert.equal(exitSelection(), false);
  let calls = 0;
  const release = holdSelection(() => calls++);
  assert.equal(exitSelection(), true);
  assert.equal(calls, 1);
  release();
  assert.equal(exitSelection(), false);
  assert.equal(calls, 1);
});

it('отпускание старой ленты не сбрасывает выделение новой', () => {
  // Ловит гонку очистки эффекта старой переписки с открытием следующей.
  let oldCalls = 0, nextCalls = 0;
  const oldRelease = holdSelection(() => oldCalls++);
  const nextRelease = holdSelection(() => nextCalls++);
  try {
    oldRelease(); oldRelease();
    assert.equal(exitSelection(), true);
    assert.deepEqual([oldCalls, nextCalls], [0, 1]);
  } finally { nextRelease(); oldRelease(); }
  assert.equal(exitSelection(), false);
});

it('обработчик выхода может синхронно отпустить выделение без второго вызова', () => {
  // Ловит повторное действие мобильного крестика после завершившегося выхода.
  let calls = 0;
  const release = holdSelection(() => { calls++; release(); });
  try {
    assert.equal(exitSelection(), true);
    assert.equal(exitSelection(), false);
    assert.equal(calls, 1);
  } finally { release(); }
});

it('мышью строки выделяются рядом с пузырём, а пузырь и свои элементы сохраняют назначение', () => {
  // Не превращаем выделение текста, касание или команды самой строки в случайное начало пачки.
  const base = { mouse: true, canSelect: true, selecting: false, bubble: false, own: false };
  for (let bits = 0; bits < 32; bits++) {
    const input = { mouse: !!(bits & 1), canSelect: !!(bits & 2), selecting: !!(bits & 4), bubble: !!(bits & 8), own: !!(bits & 16) };
    const expected = !input.mouse || !input.canSelect || input.own ? null : input.selecting ? 'rows' : input.bubble ? null : 'rows';
    assert.equal(selectPress(input), expected, `полная комбинация признаков ${bits.toString(2).padStart(5, '0')}`);
  }
  assert.equal(SELECT_HOLD_MS, 400);
});

it('протяжка начинается строго после пяти пикселей по любой оси', () => {
  // Порог должен отделять дрожь руки от настоящего drag, не отбирая ровно пять px у клика.
  assert.equal(SELECT_SLOP_PX, 5);
  assert.equal(selectSlopPassed(5, 0), false);
  assert.equal(selectSlopPassed(-5, 5), false);
  assert.equal(selectSlopPassed(6, 0), true);
  assert.equal(selectSlopPassed(0, -6), true);
  assert.equal(selectStartIn(3, 3, 5), false);
  assert.equal(selectStartIn(3, 3, 6), true);
  assert.equal(selectStartIn(4, 3, 0), true);
});

it('строка под указателем ищется в ленте с пропусками, границами и зазором в сторону якоря', () => {
  // В промежутке между сообщениями полоса даты не должна расширять диапазон в противоположную сторону от начала.
  const bands = [{ top: 10, bottom: 30 }, { top: 50, bottom: 70 }, { top: 90, bottom: 110 }];
  const band = (i: number) => bands[i]!;
  assert.equal(selectRowAt(0, band, 15, 0), -1);
  assert.equal(selectRowAt(3, band, -100, 0), 0);
  assert.equal(selectRowAt(3, band, 20, 0), 0);
  assert.equal(selectRowAt(3, band, 115, 0), 2);
  assert.equal(selectRowAt(3, band, 40, 0), 0, 'тяга от верхней строки не включает следующую до входа в неё');
  assert.equal(selectRowAt(3, band, 40, 2), 1, 'тяга от нижней строки выбирает ближайшую со своей стороны');
  assert.equal(selectRowAt(3, band, 40, -1), 0, 'без стартовой строки выбирается ближайшая из двух');
});

it('поиск строки использует двоичный поиск, а не обходит все сотни элементов при каждом движении', () => {
  // Pointermove частый: линейный поиск по большой беседе превращал бы протяжку в заметные рывки.
  let reads = 0;
  const index = selectRowAt(1024, (i) => { reads++; return { top: i * 20, bottom: i * 20 + 15 }; }, 10_000, -1);
  assert.equal(index, 500);
  assert.ok(reads < 30, 'даже тысяча строк читается логарифмическим числом раз');
});

it('двоичный поиск совпадает с независимым линейным эталоном на границах и во всех зазорах', () => {
  // Проверяем смысл выбора строки, а не только скорость: бинарная граница часто ошибается ровно на краях полосы.
  const bands = Array.from({ length: 13 }, (_, i) => ({ top: i * 31 + 4, bottom: i * 31 + 22 }));
  const expected = (y: number, start: number) => {
    if (y < bands[0]!.top) return 0;
    if (y >= bands.at(-1)!.bottom) return bands.length - 1;
    for (let i = 0; i < bands.length; i++) {
      if (y >= bands[i]!.top && y < bands[i]!.bottom) return i;
      if (i > 0 && y >= bands[i - 1]!.bottom && y < bands[i]!.top) {
        if (start < 0) return y - bands[i - 1]!.bottom <= bands[i]!.top - y ? i - 1 : i;
        return start < i ? i - 1 : i;
      }
    }
    return -1;
  };
  const points = new Set<number>();
  for (const band of bands) for (const edge of [band.top, band.bottom]) for (const d of [-1, 0, 1]) points.add(edge + d);
  for (let y = 0; y <= bands.at(-1)!.bottom + 5; y++) points.add(y);
  for (const y of points) for (let start = -1; start <= bands.length; start++) {
    assert.equal(selectRowAt(bands.length, (i) => bands[i]!, y, start), expected(y, start), `y=${y}, anchor=${start}`);
  }
});

it('диапазон сжимается назад, сохраняет основу и снимает только строки выбранной полосы', () => {
  // Считать каждый ход от начального выбора предотвращает «липкие» строки при обратном движении мыши.
  const order = ['a', 'b', 'c', 'd', 'e'];
  const base = ['e'];
  assert.equal(selectRange(order, base, 'b', null, true), base, 'пока стартовая строка не вошла, базовый выбор не меняется');
  assert.deepEqual(selectRange(order, base, 'b', 'd', true), ['e', 'b', 'c', 'd']);
  assert.deepEqual(selectRange(order, base, 'b', 'c', true), ['e', 'b', 'c'], 'обратное движение уменьшает диапазон');
  assert.deepEqual(selectRange(order, ['a', 'b', 'e'], 'b', 'd', false), ['a', 'e'], 'режим снятия убирает диапазон');
  assert.deepEqual(selectRange(order, ['a'], 'd', 'b', true), ['a', 'd', 'c', 'b'], 'обратный диапазон упорядочен от точки старта');
  assert.deepEqual(selectRange(order, ['a'], 'missing', 'c', true), ['a']);
  assert.deepEqual(selectRange(order, ['a'], 'b', 'missing', true), ['a']);
});

it('выделение ограничено ровно серверным пределом пачки в 100 сообщений', () => {
  // Клиент не должен собирать пачку, которую сервер гарантированно отвергнет из-за числа строк.
  const order = Array.from({ length: 101 }, (_, i) => `m${i}`);
  assert.equal(SELECT_MAX, MESSAGE_BATCH_MAX);
  assert.equal(SELECT_MAX, 100);
  assert.equal(selectRange(order, [], 'm0', 'm99', true).length, 100, 'ровно сто строк принимаются');
  assert.equal(selectRange(order, [], 'm0', 'm100', true).length, 100, 'сто первая строка не добавляется');
  assert.deepEqual(selectRange(order, ['m0', 'm1'], 'm1', 'm3', true, 2), ['m0', 'm1'], 'пачка у своего лимита не переполняется');
});

it('автопрокрутка начинается за краем, растёт по формуле и упирается в 37 px', () => {
  // При протяжке далеко за видимую ленту шаг не должен становиться нулевым или неограниченным.
  assert.equal(SELECT_SCROLL_TICK_MS, 15);
  assert.equal(SELECT_SCROLL_MAX, 37);
  assert.equal(selectScrollStep(20, 20, 80), 0);
  assert.equal(selectScrollStep(79, 20, 80), 0);
  assert.equal(selectScrollStep(80, 20, 80), 1);
  assert.equal(selectScrollStep(100, 20, 80), 4);
  assert.equal(selectScrollStep(0, 20, 80), -4);
  assert.equal(selectScrollStep(10_000, 20, 80), 37);
  assert.equal(selectScrollStep(-10_000, 20, 80), -37);
});

it('клавиши выделения используют физический KeyC для русской раскладки и отклоняют модификаторы', () => {
  // Буква на клавише меняется с раскладкой, но Ctrl+C должен оставаться копированием.
  assert.equal(selectionKey({ key: 'с', code: 'KeyC', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false }), 'copy');
  assert.equal(selectionKey({ key: 'c', code: 'KeyC', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, repeat: false }), 'copy');
  for (const key of ['Delete', 'Backspace']) assert.equal(selectionKey({ key, code: key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false }), 'delete');
  const baseKey: SelectionKeyInput = { key: 'x', code: 'KeyX', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false };
  const rejected: Partial<SelectionKeyInput>[] = [
    { ctrlKey: true, key: 'Backspace' }, { altKey: true, key: 'Delete' }, { shiftKey: true, key: 'Delete' },
    { repeat: true, key: 'Delete' }, { key: 'Escape' },
  ];
  for (const patch of rejected) assert.equal(selectionKey({ ...baseKey, ...patch }), null);
});

it('выделить до сообщения выбирает ближайшую строку, при равенстве — верхнюю, и соблюдает лимит', () => {
  // Команда доступна только для ближайшей точки продолжения, иначе выбор неожиданно захватывает весь промежуток.
  assert.deepEqual(selectUpTo(['a', 'b', 'c', 'd', 'e'], ['a', 'e'], 'c'), ['a', 'e', 'b', 'c']);
  assert.deepEqual(selectUpTo(['a', 'b', 'c', 'd'], ['a', 'd'], 'b'), ['a', 'd', 'b']);
  assert.equal(selectUpTo(['a', 'b'], ['a'], 'a'), null);
  assert.equal(selectUpTo(['a', 'b'], [], 'b'), null);
  assert.equal(selectUpTo(['a'], ['a'], 'missing'), null);
  assert.equal(selectUpTo(['a', 'b', 'c'], ['a'], 'c', 2), null);
  const firstPicked = mutatedSelection('  let near = -1;\n  for (let d = 1; d < order.length && near < 0; d++) {\n    if (t - d >= 0 && have.has(order[t - d])) near = t - d;\n    else if (t + d < order.length && have.has(order[t + d])) near = t + d;\n  }', '  const near = order.indexOf(picked[0]!);');
  mutantMustFail(firstPicked.selectUpTo(['a', 'b', 'c', 'd', 'e'], ['e', 'a'], 'c'), ['e', 'a', 'b', 'c'], 'мутант берёт первое выбранное, а не ближайшее');
  const noLimit = mutatedSelection('  return out.length <= max ? out : null;', '  return out;');
  mutantMustFail(noLimit.selectUpTo(['a', 'b', 'c'], ['a'], 'c', 2), null, 'мутант без лимита показывает невозможный выбор');
  const byKey = mutatedSelection("e.code === 'KeyC'", "e.key === 'c'");
  mutantMustFail(byKey.selectionKey({ key: 'с', code: 'KeyC', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false }), 'copy', 'мутант по key ломает русскую раскладку');
});
