import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as rules from './popover';

const source = readFileSync(new URL('./popover.ts', import.meta.url), 'utf8');
const rect = (top: number, height = 20) => ({ left: 80, right: 120, top, bottom: top + height }) as DOMRect;
function load(text: string): typeof rules {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports });
  return module.exports as typeof rules;
}
function reject(old: string, replacement: string, check: (r: typeof rules) => void) {
  assert.ok(source.includes(old), 'контрфакт применён к настоящему модулю');
  assert.throws(() => check(load(source.replace(old, replacement))), assert.AssertionError);
}

it('R117 верхняя и нижняя вставки ограничивают портрет и ландшафт, пустая область не отрицательна', () => {
  for (const [vw, vh] of [[384, 854], [740, 360]]) {
    assert.deepEqual(rules.safeArea({ vw, vh }, 32, 48), { vw, vh: vh - 48, top: 32 });
    assert.deepEqual(rules.safeArea({ vw, vh }, 0, 48), { vw, vh: vh - 48 });
    assert.deepEqual(rules.safeArea({ vw, vh }, 900, 1000), { vw, vh: 900, top: 900 });
  }
});

it('R117 место под закрепами и потолок карточки вычитают реальные отступы и полосу', () => {
  const check = (r: typeof rules) => {
    assert.equal(r.stackCardMaxHeight({ vw: 740, vh: 312, top: 32 }, 52), 212);
    assert.equal(r.stackCardMaxHeight({ vw: 740, vh: 312, top: 32 }, 52, 10), 208);
    assert.equal(r.stackCardMaxHeight({ vw: 740, vh: 50, top: 32 }, 52), 0);
    assert.equal(r.roomBelow(52, { vw: 740, vh: 312, top: 32 }), 252);
    assert.equal(r.roomBelow(400, { vw: 740, vh: 312 }), 0);
  };
  check(rules);
  reject(' - 2 * pad - cardTop', ' - cardTop', check);
  reject(' - 2 * pad - cardTop', ' - 2 * pad', check);
});

it('R117 все меню остаются между вставками, в том числе при якоре выше экрана', () => {
  const check = (r: typeof rules) => {
    const vp = { vw: 384, vh: 312, top: 32 };
    for (const y of [-100, 0, 32, 45, 140, 300, 500]) {
      for (const [p, height] of [[r.placeByHalf(rect(y), 100, 80, 'start', 8, 8, vp), 80],
        [r.placeByPoint(80, y, 100, 80, 8, vp), 80], [r.placeByAnchor(rect(y), 100, 80, 8, vp), 80],
        [r.placeStackByPoint(80, y, 120, 120, { left: 10, top: 40, w: 100, h: 80 }, 8, vp), 120]] as const) {
        assert.ok(p.top >= 40, `верх ${p.top} не под строкой состояния`);
        assert.ok(p.top + height <= 304, 'карточка не под навигационной панелью');
      }
    }
    // Над кнопкой есть место только без верхней вставки: fits обязан отвергнуть y=22.
    assert.equal(r.placeByAnchor(rect(90), 100, 60, 8, vp).top, 118);
    assert.equal(r.clampAxis(-50, 80, 312, 8, 32), 40);
  };
  check(rules);
  reject('fits(c.top, h, vh, pad, top0)', 'fits(c.top, h, vh, pad)', check);
  reject('top: clampAxis(best.top, h, vh, pad, top0)', 'top: clampAxis(best.top, h, vh, pad)', check);
  reject('Math.max(min + pad, Math.min(start, extent - size - pad))', 'Math.max(pad, Math.min(start, extent - size - pad))', check);
});

it('R117 половины считаются между вставками, ровно середина ещё раскрывается вниз', () => {
  const check = (r: typeof rules) => {
    const vp = { vw: 384, vh: 312, top: 32 };
    assert.equal(r.placeByHalf(rect(162), 100, 40, 'start', 8, 8, vp).top, 190);
    assert.equal(r.placeByHalf(rect(161), 100, 40, 'start', 8, 8, vp).top, 189);
    assert.equal(r.placeByHalf(rect(163), 100, 40, 'start', 8, 8, vp).top, 115);
    assert.equal(r.placeByHalf(rect(146), 100, 40, 'start', 8, 8, { vw: 384, vh: 312 }).top, 174);
  };
  check(rules);
  reject('(top0 + vh) / 2', 'vh / 2', check);
});
