import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';
import { cubicBezierAt, predictiveBackOriginX, predictiveBackScale } from './swipeBack';

const source = readFileSync(new URL('./swipeBack.ts', import.meta.url), 'utf8');

function parsed(text: string): ts.SourceFile {
  return ts.createSourceFile('swipeBack.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function guardScale(text: string): void {
  const file = parsed(text);
  const declaration = file.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(node => ts.isIdentifier(node.name) && node.name.text === 'PREDICTIVE_BACK_SCALE');
  assert.ok(declaration?.initializer && ts.isNumericLiteral(declaration.initializer), 'предел сжатия задан числом');
  assert.equal(Number(declaration.initializer.text), 0.9, 'полный жест оставляет 90% размера экрана');
}

function guardOrigin(text: string): void {
  const file = parsed(text);
  const fn = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'predictiveBackOriginX');
  assert.ok(fn && ts.isFunctionDeclaration(fn) && fn.body, 'правило опоры найдено');
  const result = fn.body.statements.find(ts.isReturnStatement)?.expression;
  assert.ok(result && ts.isConditionalExpression(result), 'опора выбирается по краю жеста');
  const compact = (node: ts.Node) => node.getText(file).replace(/\s+/g, '');
  assert.equal(compact(result.condition), 'edge===1');
  assert.equal(compact(result.whenTrue), 'PREDICTIVE_BACK_PIVOT_PX');
  assert.equal(compact(result.whenFalse), 'Math.max(width-PREDICTIVE_BACK_PIVOT_PX,0)');
}

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} должно быть близко к ${expected}`);
}

// Ловит чрезмерное сжатие и выход за концы жеста; контрфакт проверяется AST, без исполнения исходника.
it('R121 предиктивный жест начинает с полного размера и заканчивает на 90%, включая ход вне диапазона', () => {
  for (const progress of [-1, 0]) near(predictiveBackScale(progress), 1);
  for (const progress of [1, 2]) near(predictiveBackScale(progress), 0.9);
  guardScale(source);
  const mutant = source.replace('PREDICTIVE_BACK_SCALE = 0.9', 'PREDICTIVE_BACK_SCALE = 0.85');
  assert.notEqual(mutant, source, 'контрфакт меняет предел сжатия');
  assert.throws(() => guardScale(mutant), assert.AssertionError);
});

// Ловит обратный ход/рывки и подмену нелинейной Telegram-кривой линейным сжатием.
it('R121 сжатие монотонно следует StandardDecelerate по всему ходу жеста', () => {
  let previous = 1;
  for (let i = 0; i <= 100; i++) {
    const progress = i / 100;
    const scale = predictiveBackScale(progress);
    assert.ok(scale <= previous + 1e-9, 'при движении вперёд экран не увеличивается');
    assert.ok(scale >= 0.9 - 1e-9 && scale <= 1 + 1e-9);
    // Для x(t)=t³ и y(t)=3t²−2t³ параметр t получается независимо от бинарного поиска в приложении.
    const t = Math.cbrt(progress);
    near(scale, 1 - 0.1 * (3 * t * t - 2 * t * t * t));
    previous = scale;
  }
});

// Ловит ненормализованные края интерполятора, в том числе вылет progress за 0..1.
it('R121 Безье сохраняет крайние точки и зажимает вход вне диапазона', () => {
  for (const curve of [[0, 0, 0, 1], [0.23, 1, 0.32, 1], [0.42, 0, 0.58, 1]]) {
    const [x1, y1, x2, y2] = curve;
    for (const x of [-2, 0]) near(cubicBezierAt(x1, y1, x2, y2, x), 0);
    for (const x of [1, 3]) near(cubicBezierAt(x1, y1, x2, y2, x), 1);
  }
});

// Ловит ошибку поиска параметра: при совпадении x/y-кривых выход должен совпасть со входом, не с t.
it('R121 диагональная Безье даёт сам ход жеста между концами', () => {
  for (const x of [0.001, 0.1, 0.25, 0.5, 0.75, 0.99]) {
    near(cubicBezierAt(0.23, 0.23, 0.32, 0.32, x), x);
  }
});

// Ловит зеркально перепутанную опору; узкая ширина не должна увести левую опору в отрицательные координаты.
it('R121 опора находится у дальнего края: слева width−82, справа 82', () => {
  for (const width of [82, 384, 740]) {
    assert.equal(predictiveBackOriginX(0, width), width - 82);
    assert.equal(predictiveBackOriginX(1, width), 82);
  }
  assert.equal(predictiveBackOriginX(0, 81), 0);
  assert.equal(predictiveBackOriginX(0, 0), 0);
  guardOrigin(source);
  const mutant = source.replace('return edge === 1 ?', 'return edge === 0 ?');
  assert.notEqual(mutant, source, 'контрфакт действительно меняет стороны');
  assert.throws(() => guardOrigin(mutant), assert.AssertionError);
});
