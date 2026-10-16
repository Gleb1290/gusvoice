import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { fitStageGrid, stageAvatarSize, STAGE_GRID_HYSTERESIS_PX, STAGE_SCROLLBAR_PX, type StageGridInput } from './stageGridRules';

type Fit = typeof fitStageGrid;
const input = (overrides: Partial<StageGridInput> = {}): StageGridInput => ({ width: 748, height: 719, count: 11, gap: 12, ...overrides });
it('R163 пустая сцена и неизмеренный контейнер не задают размер плитки', () => {
  for (const overrides of [{ count: 0 }, { count: -1 }, { width: 0 }, { width: -1 }, { height: 0 }, { height: -1 }]) {
    const result = fitStageGrid(input(overrides));
    assert.equal(result.tileW, 0);
    assert.equal(result.tileH, 0);
    assert.equal(result.cols, 1);
  }
});
it('R163 одиночная плитка ограничена обеими сторонами контейнера', () => {
  assert.deepEqual(fitStageGrid(input({ count: 1, width: 400, height: 900 })), { cols: 1, rows: 1, tileW: 400, tileH: 225 });
  assert.deepEqual(fitStageGrid(input({ count: 1, width: 900, height: 225 })), { cols: 1, rows: 1, tileW: 400, tileH: 225 });
});
it('R163 две, шесть и одиннадцать плиток помещаются в области окон 1280 и 1920', () => {
  // Передаём область сцены, не всё окно с боковыми панелями и шапкой.
  for (const [width, height, sizes] of [
    [708, 719, [[1, 2, 628, 353], [2, 3, 348, 195], [3, 4, 228, 128]]],
    [1348, 999, [[1, 2, 877, 493], [2, 3, 577, 324], [3, 4, 428, 240]]],
  ] as const) {
    for (const [index, count] of [2, 6, 11].entries()) {
      const [cols, rows, tileW, tileH] = sizes[index];
      assert.deepEqual(fitStageGrid(input({ width, height, count })), { cols, rows, tileW, tileH });
    }
  }
  assert.deepEqual(fitStageGrid(input()), { cols: 3, rows: 4, tileW: 241, tileH: 135 });
});
it('R163 сетка входов соблюдает ширину, высоту и вместимость, когда минимум помещается', () => {
  for (const width of [224, 360, 708, 748, 1348]) for (const height of [200, 719, 999]) for (const count of [1, 2, 6, 8, 11, 24]) {
    const result = fitStageGrid(input({ width, height, count }));
    assert.ok(result.cols * result.tileW + (result.cols - 1) * 12 <= width);
    assert.ok(result.cols * result.rows >= count);
    assert.equal(result.rows, Math.ceil(count / result.cols));
    const minimumFits = Array.from({ length: count }, (_, i) => i + 1).some(cols => {
      const rows = Math.ceil(count / cols);
      return cols * 112 + (cols - 1) * 12 <= width && rows * (112 * 9 / 16) + (rows - 1) * 12 <= height;
    });
    if (minimumFits) assert.ok(result.rows * result.tileH + (result.rows - 1) * 12 <= height);
    assert.equal(result.tileH, Math.floor(result.tileW * 9 / 16));
  }
});
function tie(fit: Fit) {
  assert.equal(fit(input({ width: 100, height: 100, count: 2, gap: 0, aspect: 1, minTileW: 1 })).cols, 1);
}
function rounding(fit: Fit) {
  assert.equal(fit(input({ width: 401.9, height: 900, count: 1 })).tileW, 401);
}
function heightLimit(fit: Fit) {
  assert.equal(fit(input({ count: 1, width: 900, height: 225 })).tileW, 400);
}
function minimum(fit: Fit) {
  assert.deepEqual({ ...fit(input({ width: 236, height: 100, count: 8 })) }, { cols: 2, rows: 4, tileW: 112, tileH: 63 });
}
it('R163 при равной площади остаётся меньше колонок', () => tie(fitStageGrid));
it('R163 дробная ширина округляется вниз и не переполняет ряд', () => rounding(fitStageGrid));
it('R163 ограничение высоты не позволяет одиночной плитке уйти под прокрутку', () => heightLimit(fitStageGrid));
it('R163 ниже минимума плитки остаются читаемыми, лишние строки прокручиваются', () => minimum(fitStageGrid));
it('R163 ровно минимум помещается, пиксель нехватки ширины сжимает одиночную плитку', () => {
  assert.deepEqual(fitStageGrid(input({ count: 1, width: 112, height: 63 })), { cols: 1, rows: 1, tileW: 112, tileH: 63 });
  assert.deepEqual(fitStageGrid(input({ count: 1, width: 111, height: 63 })), { cols: 1, rows: 1, tileW: 111, tileH: 62 });
  assert.equal(fitStageGrid(input({ width: 235, height: 100, count: 8 })).cols, 1);
});
it('R163 размер аватара растёт по высоте между 40 и 96, до измерения остаётся 92', () => {
  for (const height of [0, -1, NaN]) assert.equal(stageAvatarSize(height), 92);
  for (const [height, expected] of [[1, 40], [72, 40], [74, 41], [132, 73], [174, 96], [1000, 96]]) assert.equal(stageAvatarSize(height), expected);
});
function hysteresis(fit: Fit) {
  const base = input({ height: 100, count: 2, gap: 0, aspect: 1, minTileW: 1 });
  assert.equal(fit({ ...base, width: 116, prevCols: 1 }).cols, 1);
  assert.equal(fit({ ...base, width: 85, prevCols: 2 }).cols, 2);
  assert.equal(fit({ ...base, width: 117, prevCols: 1 }).cols, 2);
  assert.equal(fit({ ...base, width: 84, prevCols: 2 }).cols, 1);
}
it('R164 мёртвая зона 16px сохраняет колонки до выхода за границу в обе стороны', () => {
  assert.equal(STAGE_GRID_HYSTERESIS_PX, STAGE_SCROLLBAR_PX + 4);
  hysteresis(fitStageGrid);
});
it('R164 появление полосы 12px не меняет колонки рядом с границей минимальной плитки', () => {
  for (const prevCols of [1, 2]) for (const width of [236, 224]) {
    const result = fitStageGrid(input({ width, height: 200, count: 8, prevCols }));
    assert.equal(result.cols, prevCols);
    assert.ok(result.cols * result.tileW + (result.cols - 1) * 12 <= width);
  }
  assert.deepEqual(fitStageGrid(input({ width: 224, height: 200, count: 8, prevCols: 2 })), { cols: 2, rows: 4, tileW: 106, tileH: 59 });
});
it('R164 большой прирост ширины переключает колонки, нулевой порог отключает удержание', () => {
  assert.equal(fitStageGrid(input({ width: 300, height: 200, count: 8, prevCols: 1 })).cols, 2);
  assert.equal(fitStageGrid(input({ width: 236, height: 200, count: 8, prevCols: 1, hysteresisPx: 0 })).cols, 2);
});
it('R164 отсутствующие и недопустимые прошлые колонки не влияют на обычный расчёт', () => {
  const expected = fitStageGrid(input());
  for (const prevCols of [undefined, 0, -1, 1.5, 12, NaN]) assert.deepEqual(fitStageGrid(input({ prevCols })), expected);
});

const source = readFileSync(new URL('./stageGridRules.ts', import.meta.url), 'utf8');
function mutant(before: string, after: string): Fit {
  assert.equal(source.split(before).length - 1, 1, 'один точный якорь мутации');
  const module = { exports: {} as { fitStageGrid: Fit } };
  // Исполняется весь настоящий модуль, не копия или вырезанное тело solver.
  runInNewContext(ts.transpileModule(source.replace(before, after), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
  return module.exports.fitStageGrid;
}
for (const [name, before, after, check] of [
  ['равенство выбирает лишнюю колонку', 'w > best.w', 'w >= best.w', tie],
  ['округление вверх переполняет ряд', 'Math.floor(chosen.w)', 'Math.round(chosen.w)', rounding],
  ['игнорируется доступная высота', 'const w = Math.min(byWidth, byHeight);', 'const w = byWidth;', heightLimit],
  ['удалена нижняя граница читаемости', 'if (chosen.w < minW)', 'if (false)', minimum],
  ['удалено удержание колонок', 'if (narrow.cols !== prev && wide.cols !== prev) return next;', 'return next;', hysteresis],
  ['порог удержания обнулён', 'input.hysteresisPx ?? STAGE_GRID_HYSTERESIS_PX', 'input.hysteresisPx ?? 0', hysteresis],
] as const) it(`R163/R164 мутант: ${name}`, () => {
  check(fitStageGrid);
  assert.throws(() => check(mutant(before, after)), assert.AssertionError);
});
