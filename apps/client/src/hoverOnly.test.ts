import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HOVER_MEDIA, hoverOnly, insideHoverQuery, splitHoverSelectors } from '../hoverOnly.js';

function runRule(selectors: string[], parent?: object) {
  const placed: Array<{ name: string; params: string; children: unknown[] }> = [];
  let removed = false;
  class AtRule {
    name: string;
    params: string;
    children: unknown[] = [];
    constructor(init: { name: string; params: string }) { this.name = init.name; this.params = init.params; }
    append(node: unknown) { this.children.push(node); }
  }
  const rule = {
    type: 'rule', selectors, parent,
    clone(o?: { selectors?: string[] }) { return { type: 'rule', selectors: o?.selectors ?? selectors }; },
    after(node: unknown) { placed.push(node as AtRule); },
    remove() { removed = true; },
  };
  hoverOnly().Rule(rule as never, { AtRule } as never);
  return { rule, placed, removed };
}

describe('CSS наведения на сенсорном экране', () => {
  it('делит смешанное правило по селекторам и сохраняет фокус клавиатуры', () => {
    // Ловит перенос всего правила под hover, из-за которого пропадает focus-visible на телефоне.
    assert.deepEqual(splitHoverSelectors(['.a:hover .b', '.b:focus-visible', '.c:hover']), {
      hover: ['.a:hover .b', '.c:hover'], rest: ['.b:focus-visible'],
    });
    assert.deepEqual(splitHoverSelectors(['.b:focus-visible']), { hover: [], rest: ['.b:focus-visible'] });
  });

  it('распознаёт любой media про hover, но не размер экрана', () => {
    // Ловит двойную обёртку или оставленное без защиты наведение внутри max-width.
    assert.equal(HOVER_MEDIA, '(hover: hover)');
    assert.equal(insideHoverQuery(['(hover: hover)']), true);
    assert.equal(insideHoverQuery(['(any-hover: none)']), true);
    assert.equal(insideHoverQuery(['(max-width: 760px)']), false);
    assert.equal(insideHoverQuery(['(max-width: 760px)', '(hover: hover)']), true);
  });

  it('плагин сохраняет соседнее правило фокуса и ставит hover-копию сразу после него', () => {
    // Ловит перемещение focus-visible внутрь hover и изменение порядка каскада при переносе правила.
    const result = runRule(['.a:hover .b', '.b:focus-visible'], {
      type: 'atrule', name: 'media', params: '(max-width: 760px)',
    });
    assert.deepEqual(result.rule.selectors, ['.b:focus-visible']);
    assert.equal(result.removed, false);
    assert.equal(result.placed.length, 1);
    assert.equal(result.placed[0]?.params, HOVER_MEDIA);
    assert.deepEqual(result.placed[0]?.children, [{ type: 'rule', selectors: ['.a:hover .b'] }]);
  });

  it('плагин не трогает уже защищённое правило и кадры анимации', () => {
    // Ловит повторную обёртку и случайное переписывание keyframes при обходе дерева CSS.
    for (const parent of [
      { type: 'atrule', name: 'media', params: '(hover: hover)' },
      { type: 'atrule', name: 'keyframes', params: 'pulse' },
    ]) {
      const result = runRule(['.a:hover'], parent);
      assert.equal(result.placed.length, 0);
      assert.equal(result.removed, false);
      assert.deepEqual(result.rule.selectors, ['.a:hover']);
    }
  });
});
