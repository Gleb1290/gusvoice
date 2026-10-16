import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './photoDrawRules';

type Api = typeof rules;
const source = readFileSync(new URL('./photoDrawRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw = source): Api {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports });
  return module.exports as Api;
}
function mutation(changes: readonly (readonly [string, string])[]) {
  let raw = source;
  for (const [anchor, replacement] of changes) {
    assert.equal(raw.split(anchor).length - 1, 1, 'единственный якорь целого photoDrawRules'); raw = raw.replace(anchor, replacement);
  }
  return raw;
}
function killed(changes: readonly (readonly [string, string])[], scenario: (api: Api) => void, prefix: string, actual: unknown, expected: unknown) {
  scenario(load());
  const mutant = load(mutation(changes));
  assert.throws(() => scenario(mutant), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
}
function close(actual: number, expected: number, label: string) { assert.equal(Math.abs(actual - expected) < 1e-10, true, `${label}: ${actual} ≈ ${expected}`); }
const transforms = [
  [0, false, 10, 20], [0, true, 190, 20],
  [90, false, 20, 190], [90, true, 80, 190],
  [180, false, 190, 80], [180, true, 10, 80],
  [270, false, 80, 10], [270, true, 20, 10],
] as const;
for (const [angle, flipped, x, y] of transforms) it(`R214 координаты ${angle}° ${flipped ? 'с отражением' : 'без отражения'} имеют независимый эталон и обратимы на неквадратном снимке`, () => {
  // Одной обратимости мало: обе функции могут согласованно перепутать направление поворота.
  assert.deepEqual(rules.sourceToVisible(10, 20, 200, 100, angle, flipped), { x, y });
  assert.deepEqual(rules.visibleToSource(x, y, 200, 100, angle, flipped), { x: 10, y: 20 });
  for (const [w, h] of [[200, 100], [73, 211], [187.5, 52.25]]) {
    for (const point of [{ x: 0, y: 0 }, { x: w, y: h }, { x: w / 3, y: h / 7 }, { x: -5, y: h + 3 }]) {
      const visible = rules.sourceToVisible(point.x, point.y, w!, h!, angle, flipped), back = rules.visibleToSource(visible.x, visible.y, w!, h!, angle, flipped);
      close(back.x, point.x, 'обратно в исходник x'); close(back.y, point.y, 'обратно в исходник y');
    }
    const vw = angle === 90 || angle === 270 ? h! : w!, vh = angle === 90 || angle === 270 ? w! : h!;
    for (const point of [{ x: 0, y: 0 }, { x: vw, y: vh }, { x: vw / 5, y: vh / 9 }]) {
      const original = rules.visibleToSource(point.x, point.y, w!, h!, angle, flipped), back = rules.sourceToVisible(original.x, original.y, w!, h!, angle, flipped);
      close(back.x, point.x, 'обратно на экран x'); close(back.y, point.y, 'обратно на экран y');
    }
  }
});
it('R214 штрих ближе 0.002 сохраняет сам массив, ровно порог и порог плюс добавляют точку без мутации', () => {
  const origin = { x: 0, y: 0 }, points = Object.freeze([origin]);
  for (const p of [{ x: 0, y: 0 }, { x: 0.002 - 1e-7, y: 0 }, { x: 0.001, y: 0.001 }]) assert.equal(rules.appendPoint(points, p), points);
  for (const p of [{ x: 0.002, y: 0 }, { x: 0.002 + 1e-7, y: 0 }, { x: 0, y: -0.002 }]) {
    const next = rules.appendPoint(points, p); assert.notEqual(next, points); assert.equal(next.length, 2); assert.equal(next[0], origin); assert.equal(next[1], p);
  }
  assert.deepEqual(points, [origin]);
  const p = { x: 9, y: 10 }; assert.deepEqual(rules.appendPoint([], p), [p]);
  assert.equal(rules.appendPoint(points, { x: 0.49, y: 0 }, 0.5), points);
  assert.equal(rules.appendPoint(points, { x: 0.5, y: 0 }, 0.5).length, 2);
});
const text = (patch: Partial<rules.TextMark> = {}): rules.TextMark => ({ kind: 'text', color: '#ea2739', size: 2, text: 'Гусь', x: 10, y: 20, ...patch });
const stroke = (points: rules.MarkPoint[] = [{ x: 1, y: 2 }]): rules.StrokeMark => ({ kind: 'stroke', color: '#000000', width: 0.012, points });
it('R214 отмена убирает ровно последнюю надпись или штрих и не меняет исходный массив', () => {
  const first = text(), second = stroke(), eraser = { ...stroke(), erase: true };
  for (const last of [second, eraser, text({ text: 'последняя' })]) {
    const marks = Object.freeze([first, last]), next = rules.undoMark(marks);
    assert.notEqual(next, marks); assert.deepEqual(next, [first]); assert.equal(next[0], first); assert.deepEqual(marks, [first, last]);
  }
  const empty: rules.DrawMark[] = []; assert.deepEqual(rules.undoMark(empty), []); assert.notEqual(rules.undoMark(empty), empty);
});
function blankMarks(api: Api) {
  const blank = [text({ text: '' }), text({ text: ' \t\n\u00a0\u2003 ' }), stroke([])];
  assert.equal(api.pruneMarks(blank).length, 0, 'пробельная надпись и пустой штрих не запекаются');
  assert.equal(api.hasMarks(blank), false); assert.equal(api.hasMarks(undefined), false); assert.equal(api.hasMarks([]), false);
}
it('R214 пробельные надписи и пустые штрихи вычищаются, содержательные метки сохраняют текст и идентичность', () => {
  blankMarks(rules);
  const caption = text({ text: '  Гусь  ' }), line = stroke(), eraser = { ...stroke(), erase: true };
  const marks = Object.freeze([text({ text: ' \t ' }), caption, stroke([]), line, eraser]);
  const pruned = rules.pruneMarks(marks);
  assert.deepEqual(pruned, [caption, line, eraser]); assert.equal(pruned[0], caption); assert.equal(pruned[1], line); assert.equal(pruned[2], eraser);
  assert.equal(caption.text, '  Гусь  '); assert.equal(marks.length, 5); assert.equal(rules.hasMarks(marks), true);
});
it('R214 рамка надписи центрирована по независимому замеру, имеет полторы строки и минимальную ширину', () => {
  const calls: [string, number][] = [], measure = (value: string, size: number) => { calls.push([value, size]); return 4; };
  const box = rules.textBox(text(), measure);
  assert.deepEqual(calls, [['Гусь', 2]]); close(box.x, 7.4, 'левый край'); close(box.y, 18.5, 'верхний край'); close(box.w, 5.2, 'ширина'); close(box.h, 3, 'высота');
  const emptyCalls: [string, number][] = [], empty = rules.textBox(text({ text: '', size: 0.5, x: 2, y: 3 }), (value, size) => { emptyCalls.push([value, size]); return 0; });
  assert.deepEqual(emptyCalls, [[' ', 0.5]]); close(empty.w, 0.8, 'минимальная ширина'); close(empty.h, 0.75, 'полторы строки');
  close(empty.x, 1.6, 'центр пустой надписи x'); close(empty.y, 2.625, 'центр пустой надписи y');
});
it('R214 попадание включает края надписи, за каждым краем промах, штрихи не вызывают замер текста', () => {
  const marks = [stroke(), text(), { ...stroke(), erase: true }];
  const measure = (value: string, size: number) => { assert.equal(value, 'Гусь'); assert.equal(size, 2); return 4; };
  for (const p of [{ x: 10, y: 20 }, { x: 7.4, y: 18.5 }, { x: 12.6, y: 21.5 }]) assert.equal(rules.hitText(marks, p, measure), 1);
  for (const p of [{ x: 7.3999, y: 20 }, { x: 12.6001, y: 20 }, { x: 10, y: 18.4999 }, { x: 10, y: 21.5001 }]) assert.equal(rules.hitText(marks, p, measure), -1);
  assert.equal(rules.hitText([stroke()], { x: 1, y: 2 }, () => { throw new Error('штрих не надпись'); }), -1);
  assert.equal(rules.hitText([], { x: 0, y: 0 }, () => { throw new Error('пусто'); }), -1);
});
function overlap(api: Api) {
  const marks = [text({ text: 'низ' }), stroke(), text({ text: 'верх' }), stroke()];
  assert.equal(api.hitText(marks, { x: 10, y: 20 }, () => 4), 2, 'из наложенных надписей выбирается последняя');
}
it('R214 из двух наложенных надписей побеждает последняя, добавленный сверху штрих не перекрывает выбор', () => overlap(rules));
it('R214 изменение надписи копирует только выбранную, штрих и чужие надписи не меняются', () => {
  const line = stroke(), caption = text(), other = text({ text: 'другая' }), marks = Object.freeze([line, caption, other]);
  const snapshot = structuredClone(marks), patch = { text: 'новая', color: '#ffffff', size: 0.07, x: 5, y: 8 };
  const next = rules.updateMark(marks, 1, patch);
  assert.notEqual(next, marks); assert.equal(next[0], line); assert.equal(next[2], other); assert.notEqual(next[1], caption);
  assert.deepEqual(next[1], { ...caption, ...patch }); assert.deepEqual(marks, snapshot);
  const untouched = rules.updateMark(marks, 0, patch); assert.notEqual(untouched, marks); assert.deepEqual(untouched, marks); assert.equal(untouched[0], line);
});
it('R214 удаление выбранной надписи сохраняет остальные метки и вход, невалидные индексы дают копии без изменений', () => {
  const marks = Object.freeze([stroke(), text(), text({ text: 'третья' })]);
  const next = rules.removeMark(marks, 1); assert.deepEqual(next, [marks[0], marks[2]]); assert.equal(marks.length, 3); assert.equal(next[0], marks[0]); assert.equal(next[1], marks[2]);
  for (const i of [-1, 3, 100, 0.5, NaN, Infinity]) for (const result of [rules.removeMark(marks, i), rules.updateMark(marks, i, { text: 'не менять' })]) {
    assert.notEqual(result, marks); assert.deepEqual(result, marks); assert.equal(result[0], marks[0]); assert.equal(result[1], marks[1]);
  }
});
function removeAnyMark(api: Api) {
  const line = stroke(), caption = text(), erased = { ...stroke(), erase: true };
  const marks = Object.freeze([line, caption, erased]);
  const before = structuredClone(marks);
  for (const index of [0, 1, 2]) {
    const next = api.removeMark(marks, index);
    assert.equal(next.length, 2, 'R215-remove-any: удаляется ровно одна метка любого вида');
    assert.notEqual(next, marks);
    assert.deepEqual(next, marks.filter((_, i) => i !== index));
    for (let i = 0; i < next.length; i++) assert.equal(next[i], marks[i < index ? i : i + 1]);
    assert.deepEqual(marks, before, 'удаление не портит исходные точки, надписи или ластик');
  }
}
// removeMark — общая операция над рисунком, даже если UI пока предлагает её только для надписи.
it('R215 удаление по номеру снимает штрих, надпись и ластик, сохраняя остальные объекты и вход', () => removeAnyMark(rules));
it('R215 контрфакт удаления только надписей не оставляет выбранный штрих в рисунке', () => killed([
  ['return marks.filter((_, k) => k !== i);', "return marks.filter((m, k) => k !== i || m.kind !== 'text');"],
], removeAnyMark, 'R215-remove-any:', 3, 2));
it('R214 движок толщины и кегля держит оба края, зажимает конечные значения и переводит NaN в нижнюю', () => {
  assert.equal(rules.SLIDER_STEPS, 100);
  for (const [lo, hi] of [[rules.BRUSH_MIN, rules.BRUSH_MAX], [rules.TEXT_MIN, rules.TEXT_MAX], [-10, 10]]) {
    assert.equal(rules.sliderToValue(0, lo!, hi!), lo); assert.equal(rules.sliderToValue(100, lo!, hi!), hi);
    assert.equal(rules.sliderToValue(-1, lo!, hi!), lo); assert.equal(rules.sliderToValue(101, lo!, hi!), hi);
    close(rules.sliderToValue(50, lo!, hi!), (lo! + hi!) / 2, 'середина движка');
    assert.equal(rules.valueToSlider(lo!, lo!, hi!), 0); assert.equal(rules.valueToSlider(hi!, lo!, hi!), 100);
    assert.equal(rules.valueToSlider(lo! - 1, lo!, hi!), 0); assert.equal(rules.valueToSlider(hi! + 1, lo!, hi!), 100);
    for (const invalid of [NaN, Infinity, -Infinity]) { assert.equal(rules.sliderToValue(invalid, lo!, hi!), lo); assert.equal(rules.valueToSlider(invalid, lo!, hi!), 0); }
    for (let step = 0; step <= 100; step++) assert.equal(rules.valueToSlider(rules.sliderToValue(step, lo!, hi!), lo!, hi!), step);
  }
  assert.equal(rules.valueToSlider(4.9, 0, 10), 49); assert.equal(rules.valueToSlider(4.96, 0, 10), 50);
  assert.equal(rules.valueToSlider(2, 2, 2), 0); assert.equal(rules.valueToSlider(2, 3, 2), 0); assert.equal(rules.sliderToValue(50, 2, 2), 2);
  assert.equal(rules.BRUSH_DEFAULT >= rules.BRUSH_MIN && rules.BRUSH_DEFAULT <= rules.BRUSH_MAX, true);
  assert.equal(rules.TEXT_DEFAULT >= rules.TEXT_MIN && rules.TEXT_DEFAULT <= rules.TEXT_MAX, true);
});
it('R214 обводка белого чёрная, чёрного белая, яркость на границе 0.6 и нераспознанный цвет различаются', () => {
  for (const value of ['#ffffff', '#FFFFFF', '#9a9a9a']) assert.equal(rules.textOutline(value), '#000000');
  for (const value of ['#000000', '#999999', '#ea2739']) assert.equal(rules.textOutline(value), '#ffffff');
  for (const value of ['', 'white', '#fff', '#zz0000', '#ffffffff', ' #ffffff']) assert.equal(rules.textOutline(value), '#000000');
});
it('R214 единица меток — короткая сторона не меньше одного, палитра имеет десять разных RGB-цветов и красный по умолчанию', () => {
  for (const [w, h, unit] of [[200, 100, 100], [100, 200, 100], [1, 20, 1], [0, 20, 1], [-3, 20, 1], [0.5, 0.9, 1], [1.25, 3.5, 1.25]]) assert.equal(rules.markUnit(w!, h!), unit);
  assert.equal(rules.MARK_PALETTE.length, 10); assert.equal(new Set(rules.MARK_PALETTE).size, 10);
  assert.equal(rules.MARK_PALETTE.every(color => /^#[0-9a-f]{6}$/.test(color)), true);
  assert.equal(rules.MARK_PALETTE.includes('#ea2739'), true); assert.equal(rules.DEFAULT_MARK_COLOR, '#ea2739');
});

it('R214 контрфакт путает ширину с высотой при обратном повороте 90 градусов', () => killed([['x: w - qy, y: qx', 'x: h - qy, y: qx']], api => {
  assert.equal(api.visibleToSource(20, 190, 200, 100, 90, false).x, 10, 'обратный поворот использует ширину исходника');
}, 'обратный поворот использует ширину исходника', -90, 10));
it('R214 контрфакт теряет отражение в переводе экрана в исходник', () => killed([['const qx = flipped ? visW - vx : vx;', 'const qx = vx;']], api => {
  assert.equal(api.visibleToSource(80, 190, 200, 100, 90, true).y, 20, 'отражённый экран возвращает правильный исходник');
}, 'отражённый экран возвращает правильный исходник', 80, 20));
it('R214 контрфакт теряет отражение в переводе исходника на экран', () => killed([['x: flipped ? visW - qx : qx, y: qy', 'x: qx, y: qy']], api => {
  assert.equal(api.sourceToVisible(10, 20, 200, 100, 90, true).x, 80, 'исходник отражается на видимой короткой стороне');
}, 'исходник отражается на видимой короткой стороне', 20, 80));
it('R214 контрфакт меняет местами 90 и 270 в обратном переводе', () => killed([
  ['if (angle === 90) return { x: w - qy, y: qx };', 'if (angle === 270) return { x: w - qy, y: qx };'],
  ['if (angle === 270) return { x: qy, y: h - qx };', 'if (angle === 90) return { x: qy, y: h - qx };'],
], api => { assert.equal(api.visibleToSource(20, 190, 200, 100, 90, false).x, 10, '90 градусов не заменяются на 270'); }, '90 градусов не заменяются на 270', 190, 10));
it('R214 контрфакт считает пробельную надпись содержательным рисунком', () => killed([['m.text.trim().length > 0', 'm.text.length > 0']], blankMarks,
  'пробельная надпись и пустой штрих не запекаются', 1, 0));
it('R214 контрфакт отбрасывает точку ровно на минимальном расстоянии', () => killed([['< minDist', '<= minDist']], api => {
  assert.equal(api.appendPoint([{ x: 0, y: 0 }], { x: 0.002, y: 0 }).length, 2, 'точка ровно на пороге добавляется');
}, 'точка ровно на пороге добавляется', 1, 2));
it('R214 контрфакт выбирает нижнюю из перекрывающихся надписей', () => killed([['let i = marks.length - 1; i >= 0; i--', 'let i = 0; i < marks.length; i++']], overlap,
  'из наложенных надписей выбирается последняя', 0, 2));
it('R214 контрфакт редактирует штрих как надпись', () => killed([["if (!cur || cur.kind !== 'text') return marks.slice();", 'if (!cur) return marks.slice();']], api => {
  const line = stroke(); assert.equal(api.updateMark([line], 0, { text: 'лишний текст' })[0] === line, true, 'редактирование надписей не заменяет штрих');
}, 'редактирование надписей не заменяет штрих', false, true));
