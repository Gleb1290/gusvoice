import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { clampAxis, safeArea, placeByPoint, placeByAnchor, placeByHalf, placeStackByPoint, placeDropdown, type Viewport } from './popover.js';

const source = readFileSync(new URL('./popover.ts', import.meta.url), 'utf8');
const screen = { vw: 740, vh: 360 };
const rect = (left: number): DOMRect => ({
  x: left, y: 150, left, right: left + 20, top: 150, bottom: 170, width: 20, height: 20,
  toJSON: () => ({}),
});

describe('R120 боковые системные вставки', () => {
  it('левая вставка задаёт начальную кромку, но не уменьшает правую', () => {
    // Если вычесть левую вставку из ширины, меню ошибочно потеряет место ещё и справа.
    assert.deepEqual(safeArea(screen, 0, 0, 48, 0), { vw: 740, vh: 360, left: 48 });
  });

  it('правая вставка сдвигает конечную кромку, не добавляя left', () => {
    // vw — координата правого края, а не ширина доступной полосы.
    assert.deepEqual(safeArea(screen, 0, 0, 0, 48), { vw: 692, vh: 360 });
  });

  it('без боковых вставок сохраняется прежний ответ с верхом и низом', () => {
    // Нулевой left не должен неожиданно появиться в старых ответах viewportAboveSafeBottom.
    assert.deepEqual(safeArea(screen, 32, 48), { vw: 740, vh: 312, top: 32 });
    assert.deepEqual(safeArea(screen, 32, 48, 0, 0), safeArea(screen, 32, 48));
    assert.deepEqual(safeArea(screen, 0, 0), screen);
  });

  it('отрицательные вставки игнорируются, перекрывающие окно оставляют пустую полосу', () => {
    // Слишком большие вставки не должны разворачивать кромки и создавать отрицательную область.
    assert.deepEqual(safeArea(screen, 0, 0, -48, -48), screen);
    assert.deepEqual(safeArea(screen, 32, 48, 48, 48), { vw: 692, vh: 312, top: 32, left: 48 });
    assert.deepEqual(safeArea(screen, 0, 0, 48, 900), { vw: 48, vh: 360, left: 48 });
    assert.deepEqual(safeArea(screen, 0, 0, 800, 0), { vw: 800, vh: 360, left: 800 });
  });

  it('кламп соблюдает обе кромки с нулевым и нестандартным отступом и сохраняет доступность широкого слоя', () => {
    // При слишком широком слое важнее доступный левый край, чем попытка уместить правый.
    for (const pad of [0, 8, 13]) {
      assert.equal(clampAxis(-100, 100, 692, pad, 48), 48 + pad);
      assert.equal(clampAxis(900, 100, 692, pad, 48), 692 - 100 - pad);
      assert.equal(clampAxis(48 + pad, 100, 692, pad, 48), 48 + pad);
      assert.equal(clampAxis(200, 900, 692, pad, 48), 48 + pad);
    }
  });

  const placements: Array<[string, (x: number, w: number, pad: number, vp: Viewport) => { left: number }]> = [
    ['меню по точке', (x, w, pad, vp) => placeByPoint(x, 150, w, 80, pad, vp)],
    ['поповер у якоря', (x, w, pad, vp) => placeByAnchor(rect(x), w, 80, pad, vp)],
    ['меню по половине окна', (x, w, pad, vp) => placeByHalf(rect(x), w, 80, 'start', 8, pad, vp)],
    ['карточка с полосой реакций', (x, w, pad, vp) => placeStackByPoint(x, 150, w, 120, { left: 10, top: 40, w: w - 20, h: 80 }, pad, vp)],
    ['выпадающий список', (x, w, pad, vp) => placeDropdown(rect(x), w, 80, pad, vp)],
  ];
  for (const [name, place] of placements) {
    it(`${name} не заходит ни под левую, ни под правую вставку при выборе стороны и запасном прижатии`, () => {
      // Проверяем оба направления: защита выреза слева не разрешает обрезать меню справа.
      for (const [sal, sar] of [[48, 0], [0, 48], [48, 48]]) {
        const vp = safeArea(screen, 0, 0, sal, sar);
        for (const pad of [0, 8, 13]) {
          for (const x of [-100, 0, 55, 56, 57, 200, 600, 740, 900]) {
            const p = place(x, 100, pad, vp);
            assert.ok(p.left >= sal + pad, `${name}: x=${x}, вставки ${sal}/${sar}, pad=${pad}, left=${p.left}`);
            assert.ok(p.left + 100 <= vp.vw - pad, `${name}: правый край остаётся перед вставкой`);
          }
          // При отсутствии вмещающегося кандидата блок не пропадает за левой кромкой.
          assert.equal(place(0, 900, pad, vp).left, sal + pad);
        }
      }
    });
  }

  it('ровно левая безопасная кромка принимается, соседний пиксель под вставкой прижимается', () => {
    // Ловит строгий знак вместо нестрогого и прежнее fits без нижней горизонтальной границы.
    const vp = safeArea(screen, 0, 0, 48, 48);
    assert.deepEqual(placeByPoint(56, 150, 100, 80, 8, vp), { left: 56, top: 150 });
    assert.deepEqual(placeByPoint(55, 150, 100, 80, 8, vp), { left: 56, top: 150 });
    assert.deepEqual(placeByAnchor(rect(56), 100, 80, 8, vp), { left: 56, top: 62 });
  });

  it('страж передачи левой границы и вычитания правой отвергает контрфакты настоящего исходника без eval', () => {
    // Помимо результата защищаем передачу аргумента в fits, оценку площади и запасной clamp.
    const check = (text: string) => {
      const ast = ts.createSourceFile('popover.ts', text, ts.ScriptTarget.Latest, true);
      const body = (name: string) => {
        const fn = ast.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name);
        assert.ok(fn?.body, `настоящая функция ${name} найдена`);
        return fn.body.getText(ast).replace(/\s+/g, ' ');
      };
      assert.match(body('safeArea'), /vp\.vw - Math\.max\(0, sar\)/);
      assert.match(body('safeArea'), /if \(left > 0\) out\.left = left/);
      assert.match(body('clampAxis'), /Math\.max\(min \+ pad,/);
      const pick = body('pick');
      assert.match(pick, /fits\(c\.left, w, vw, pad, left0\)/);
      assert.match(pick, /Math\.max\(c\.left, left0 \+ pad\)/);
      assert.match(pick, /clampAxis\(best\.left, w, vw, pad, left0\)/);
    };
    check(source);
    for (const [old, replacement] of [
      ['vp.vw - Math.max(0, sar)', 'vp.vw'],
      ['if (left > 0) out.left = left;', ''],
      ['Math.max(min + pad,', 'Math.max(pad,'],
      ['fits(c.left, w, vw, pad, left0)', 'fits(c.left, w, vw, pad)'],
      ['Math.max(c.left, left0 + pad)', 'Math.max(c.left, pad)'],
      ['clampAxis(best.left, w, vw, pad, left0)', 'clampAxis(best.left, w, vw, pad)'],
    ]) {
      assert.ok(source.includes(old), `контрфакт применим: ${old}`);
      assert.throws(() => check(source.replace(old, replacement)), assert.AssertionError, `контрфакт должен краснеть: ${old}`);
    }
  });
});
