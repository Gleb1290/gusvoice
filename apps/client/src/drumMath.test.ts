import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as drum from './drumMath';

const source = readFileSync(new URL('./drumMath.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Мутируем и исполняем весь настоящий модуль: проверка не повторяет формулы приложения.
function load(raw: string): typeof drum {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports });
  return module.exports as typeof drum;
}

function replaceOnce(from: string, to: string): string {
  assert.equal(source.split(from).length - 1, 1, 'единственная точка мутации');
  return source.replace(from, to);
}

it('R265 окно барабана вмещает пять строк, доводка начинается с 200 мс', () => {
  assert.equal(drum.DRUM_HEIGHT, 200);
  assert.equal(drum.DRUM_ITEM_HEIGHT, 40);
  assert.equal(drum.DRUM_SNAP_MS, 200);
  assert.equal(drum.DRUM_WHEEL_STEP, 100);
  assert.equal(drum.DRUM_FLING_SECONDS, 0.22);
});

it('R265 easing принимает концы интервала и зажимает время за его пределами', () => {
  for (const [t, expected] of [[-1, 0], [0, 0], [0.5, 0.875], [1, 1], [2, 1]] as const)
    assert.equal(drum.easeOutCubic(t), expected);
});

it('R265 центральная строка не сжата и не затухает, соседняя остаётся видимой', () => {
  assert.deepEqual(drum.drumRowLook(5, 5), { offset: 0, scale: 1, opacity: 1 });
  const next = drum.drumRowLook(6, 5);
  assert.equal(next.offset, 40);
  assert.equal(next.opacity, 0.6);
  assert.ok(Math.abs(next.scale - 0.9488) < 1e-12);
});

function edgeScale(rules = drum) {
  // На краю не должно получиться ни отрицательного масштаба, ни полностью несжатой строки.
  assert.equal(rules.drumRowLook(5, 2.5).scale, 0.2, 'R265:краевой-масштаб-0.2');
  assert.equal(rules.drumRowLook(5, 2.5).opacity, 0);
}

it('R265 край и пространство за окном имеют нулевую прозрачность и масштаб 0.2', () => {
  edgeScale();
  for (const index of [-100, 100]) {
    const row = drum.drumRowLook(index, 0);
    assert.equal(row.opacity, 0);
    assert.equal(row.scale, 0.2);
  }
  assert.ok(drum.drumRowLook(0, 2.499).opacity > 0, 'перед самым краем строка ещё видима');
});

it('R265 затухание и сжатие симметричны, дробная позиция и своя геометрия допустимы', () => {
  for (const distance of [0.25, 1, 2.5, 3]) {
    const above = drum.drumRowLook(5 - distance, 5);
    const below = drum.drumRowLook(5 + distance, 5);
    assert.equal(above.offset, -below.offset);
    assert.equal(above.opacity, below.opacity);
    assert.equal(above.scale, below.scale);
  }
  const row = drum.drumRowLook(2, 0, 20, 80);
  assert.equal(row.offset, 40); assert.equal(row.opacity, 0); assert.equal(row.scale, 0.2);
});

function clamped(rules = drum) {
  assert.equal(rules.clampPos(-0.001, 60), 0, 'R265:зажим-снизу');
  assert.equal(rules.clampPos(59.001, 60), 59, 'R265:зажим-сверху');
}

it('R265 позиция принимает обе границы и дробь внутри, но не уходит за список', () => {
  clamped();
  for (const p of [0, 0.001, 12.25, 58.999, 59]) assert.equal(drum.clampPos(p, 60), p);
  assert.equal(drum.clampPos(-Infinity, 60), 0); assert.equal(drum.clampPos(Infinity, 60), 59);
  for (const n of [-1, 0, 1]) for (const p of [-10, 0, 10]) assert.equal(drum.clampPos(p, n), 0);
});

it('R265 центр округляется на половине строки и остаётся в пределах списка', () => {
  for (const [p, expected] of [[-1, 0], [0, 0], [0.499, 0], [0.5, 1], [58.499, 58], [58.5, 59], [60, 59]] as const)
    assert.equal(drum.centerIndex(p, 60), expected);
  assert.equal(drum.centerIndex(10, 0), 0); assert.equal(drum.centerIndex(10, 1), 0);
});

it('R265 ближайшее значение сохраняет меньшее при равном расстоянии', () => {
  const values = [1, 3, 10, 30, 60];
  for (const [p, expected] of [[-100, 0], [1, 0], [2, 0], [2.001, 1], [6.5, 1], [6.501, 2], [60, 4], [100, 4]] as const)
    assert.equal(drum.nearestIndex(values, p), expected);
  assert.equal(drum.nearestIndex([], 10), 0);
  assert.equal(drum.nearestIndex([7], -100), 0);
  assert.equal(drum.nearestIndex([1, 1, 3], 1), 0, 'дубликат не отбирает первый ближайший индекс');
});

function wheelHundred(rules = drum) {
  assert.equal(rules.wheelSteps(50).steps, 0, 'R265:колесо-100-не-50');
  assert.equal(rules.wheelSteps(100).steps, 1);
}

it('R265 колесо накапливает ровно 100, сохраняет остаток и знак в обе стороны', () => {
  wheelHundred();
  for (const [acc, steps, rest] of [[0, 0, 0], [99, 0, 99], [100, 1, 0], [101, 1, 1], [250, 2, 50],
    [-99, -0, -99], [-100, -1, 0], [-101, -1, -1], [-250, -2, -50]] as const) {
    const actual = drum.wheelSteps(acc);
    assert.equal(actual.steps, steps, `шаги ${acc}`); assert.equal(actual.rest, rest, `остаток ${acc}`);
  }
  assert.deepEqual(drum.wheelSteps(35, 10), { steps: 3, rest: 5 });
  const first = drum.wheelSteps(60), second = drum.wheelSteps(first.rest + 60);
  assert.deepEqual(second, { steps: 1, rest: 20 });
});

it('R265 щелчок выше центра выбирает предыдущую строку, ниже — следующую', () => {
  for (const [y, expected] of [[60, 9], [100, 10], [140, 11], [119.999, 10], [120, 11]] as const)
    assert.equal(drum.tapTarget(10, y, 40, 200, 60), expected);
  assert.equal(drum.tapTarget(0, -100, 40, 200, 60), 0);
  assert.equal(drum.tapTarget(59, 1000, 40, 200, 60), 59);
  assert.equal(drum.tapTarget(10, 60, 20, 80, 60), 11, 'центр собственной геометрии не прибит к 100 px');
  assert.equal(drum.tapTarget(10, 100, 40, 200, 0), 0);
});

it('R265 отпускание без скорости округляет позицию, бросок летит в обе стороны и зажимается', () => {
  for (const [pos, velocity, expected] of [[10.49, 0, 10], [10.5, 0, 11], [10, 10, 12], [10, -10, 8],
    [0, -1000, 0], [59, 1000, 59], [0, 0, 0], [59, 0, 59]] as const)
    assert.equal(drum.flingTarget(pos, velocity, 60), expected);
  assert.equal(drum.flingTarget(10, 100, 0), 0);
});

it('R265 доводка симметрична и остаётся в интервале 200–600 мс с обеих сторон насыщения', () => {
  for (const [from, to, expected] of [[0, 0, 200], [0, 1, 240], [1, 0, 240], [0, 9.975, 599],
    [0, 10, 600], [0, 10.025, 600], [100, 0, 600]] as const)
    assert.equal(drum.snapDuration(from, to), expected);
});

for (const [name, anchor, replacement, check, marker] of [
  ['краевого масштаба', 'export const DRUM_MIN_Y_SCALE = 0.2;', 'export const DRUM_MIN_Y_SCALE = 0.8;', edgeScale, 'R265:краевой-масштаб-0.2'],
  ['удаления зажима', 'return Math.min(count - 1, Math.max(0, pos));', 'return pos;', clamped, 'R265:зажим-снизу'],
  ['шага колеса 50 вместо 100', 'export const DRUM_WHEEL_STEP = 100;', 'export const DRUM_WHEEL_STEP = 50;', wheelHundred, 'R265:колесо-100-не-50'],
] as const) {
  it(`R265 настоящий модуль до мутации проходит, контрфакт ${name} падает адресно`, () => {
    check(load(source));
    const mutant = load(replaceOnce(anchor, replacement));
    assert.throws(() => check(mutant), error => error instanceof assert.AssertionError && error.message.includes(marker));
  });
}
