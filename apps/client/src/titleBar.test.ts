import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./titleBar.ts', import.meta.url), 'utf8');
type Rules = typeof import('./titleBar');

function load(raw = source, desktop = true) {
  const calls: string[] = [];
  const exports: Record<string, unknown> = {};
  const imports: Record<string, unknown> = { './hotkeys': { isDesktop: () => desktop } };
  const method = (name: string) => () => { calls.push(name); return Promise.resolve(); };
  const code = ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }, fileName: 'titleBar.ts' }).outputText;
  // Исполняется весь модуль, но никакой настоящий hotkeys/React/стор в тест не загружается.
  runInNewContext(code, {
    exports,
    require(name: string) {
      assert.ok(Object.hasOwn(imports, name), `незаявленный импорт titleBar: ${name}`);
      return imports[name];
    },
    window: { __TAURI__: { window: { getCurrentWindow: () => ({
      minimize: method('minimize'), toggleMaximize: method('maximize'), close: method('close'), startDragging: method('drag'),
    }) } } },
  }, { timeout: 1000 });
  return { rules: exports as unknown as Rules, calls };
}

// Объект из VM имеет другой prototype: сравниваем только переносимые данные, не realm.
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
function changed(raw: string, before: string, after: string) {
  assert.equal(raw.split(before).length - 1, 1, `единственная точка мутации: ${before}`);
  return raw.replace(before, after);
}
function rightEdge(raw = source) {
  const { rules } = load(raw);
  assert.deepEqual(plain(rules.maxButtonSpot({ left: 908, top: 0, width: 46, height: 32 }, 1000, 1)),
    { right: 46, top: 0, width: 46, height: 32 }, 'R268:координаты-от-правого-края');
}
function doubleClick(raw = source) {
  const { rules, calls } = load(raw);
  rules.titleBarPointerDown({ button: 0, detail: 1 });
  rules.titleBarPointerDown({ button: 0, detail: 2 });
  assert.deepEqual(calls, ['drag', 'maximize'], 'R268:разворачивает-только-второй-щелчок');
}

it('R268 размер полосы и кнопок совпадает с системными 32 × 46', () => {
  const { rules } = load();
  assert.equal(rules.TITLEBAR_H, 32);
  assert.equal(rules.TITLEBAR_BTN_W, 46);
});

for (const desktop of [false, true]) {
  it(`R268 собственная полоса ${desktop ? 'показывается в десктопе' : 'отсутствует вне десктопа'}`, () => {
    assert.equal(load(source, desktop).rules.hasOwnTitleBar(), desktop);
  });
}

it('R268 место кнопки считается от правого края, а не от левого', () => rightEdge());
it('R268 увеличение ширины окна сохраняет правый отступ при сдвиге кнопки', () => {
  // Координата слева устаревает сразу после растягивания окна: Snap-окно не должно остаться в середине.
  const { rules } = load();
  const before = rules.maxButtonSpot({ left: 908, top: 0, width: 46, height: 32 }, 1000, 1);
  const after = rules.maxButtonSpot({ left: 1108, top: 0, width: 46, height: 32 }, 1200, 1);
  assert.deepEqual(plain(after), plain(before));
});
it('R268 дробный DPI переводит каждую координату в физические пиксели с округлением', () => {
  const { rules } = load();
  assert.deepEqual(plain(rules.maxButtonSpot({ left: 900.2, top: 1.2, width: 46.2, height: 32.2 }, 1000, 1.25)),
    { right: 67, top: 2, width: 58, height: 40 });
});
it('R268 кнопка ровно на верхней и правой границе ещё видима', () => {
  const { rules } = load();
  assert.deepEqual(plain(rules.maxButtonSpot({ left: 954, top: 0, width: 46, height: 32 }, 1000, 2)),
    { right: 0, top: 0, width: 92, height: 64 });
});

const invalidSpots: Array<[string, { left: number; top: number; width: number; height: number } | null, number]> = [
  ['отсутствующая кнопка', null, 1],
  ['нулевая ширина', { left: 908, top: 0, width: 0, height: 32 }, 1],
  ['отрицательная ширина', { left: 908, top: 0, width: -1, height: 32 }, 1],
  ['нулевая высота', { left: 908, top: 0, width: 46, height: 0 }, 1],
  ['отрицательная высота', { left: 908, top: 0, width: 46, height: -1 }, 1],
  ['выход за правый край на пиксель', { left: 955, top: 0, width: 46, height: 32 }, 1],
  ['выход за верхний край на пиксель', { left: 908, top: -1, width: 46, height: 32 }, 1],
  ['нулевой DPI', { left: 908, top: 0, width: 46, height: 32 }, 0],
  ['отрицательный DPI', { left: 908, top: 0, width: 46, height: 32 }, -1],
  ['нечисловой DPI', { left: 908, top: 0, width: 46, height: 32 }, Number.NaN],
];
for (const [label, rect, dpr] of invalidSpots) {
  it(`R268 ${label} прячет нативное окно кнопки`, () => {
    assert.equal(load().rules.maxButtonSpot(rect, 1000, dpr), null);
  });
}

const hoverCases: Array<[string, { hover: boolean; pressed: boolean }, Parameters<Rules['nextMaxHover']>[1], { hover: boolean; pressed: boolean }]> = [
  ['вход подсвечивает и сбрасывает старое нажатие', { hover: false, pressed: true }, 'enter', { hover: true, pressed: false }],
  ['уход снимает подсветку и нажатие', { hover: true, pressed: true }, 'leave', { hover: false, pressed: false }],
  ['нажатие включает подсветку и нажатое состояние', { hover: false, pressed: false }, 'down', { hover: true, pressed: true }],
  ['отпускание над кнопкой сохраняет подсветку', { hover: true, pressed: true }, 'up', { hover: true, pressed: false }],
  ['отпускание вне кнопки не возвращает подсветку', { hover: false, pressed: true }, 'up', { hover: false, pressed: false }],
];
for (const [label, previous, event, expected] of hoverCases) {
  it(`R268 ${label}`, () => {
    const before = { ...previous };
    assert.deepEqual(plain(load().rules.nextMaxHover(previous, event)), expected);
    assert.deepEqual(previous, before, 'состояние React не мутируется на месте');
  });
}

for (const [detail, expected] of [[0, 'drag'], [1, 'drag'], [2, 'maximize'], [3, 'drag']] as const) {
  it(`R268 левый щелчок номер ${detail} ${expected === 'drag' ? 'начинает системное перетаскивание' : 'разворачивает окно'}`, () => {
    const { rules, calls } = load();
    rules.titleBarPointerDown({ button: 0, detail });
    assert.deepEqual(calls, [expected]);
  });
}
for (const button of [1, 2]) {
  it(`R268 кнопка мыши ${button} не разворачивает и не перетаскивает окно даже при втором щелчке`, () => {
    const { rules, calls } = load();
    rules.titleBarPointerDown({ button, detail: 1 });
    rules.titleBarPointerDown({ button, detail: 2 });
    assert.deepEqual(calls, []);
  });
}

it('R268 страж отличает двойной щелчок от первого на original-first мутанте', () => {
  // detail первого щелчка не должен максимизировать окно вместо возможности потянуть его.
  doubleClick();
  const mutant = changed(source, 'e.detail === 2', 'e.detail === 1');
  assert.throws(() => doubleClick(mutant), e => e instanceof assert.AssertionError &&
    e.message.startsWith('R268:разворачивает-только-второй-щелчок'));
});
it('R268 страж ловит левую координату вместо правого отступа на original-first мутанте', () => {
  rightEdge();
  const mutant = changed(source, 'viewportWidth - (rect.left + rect.width)', 'rect.left');
  assert.throws(() => rightEdge(mutant), e => e instanceof assert.AssertionError &&
    e.message.startsWith('R268:координаты-от-правого-края'));
});
