import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { photoCompressible } from './attachRules';
import * as rules from './photoEditRules';

function mutated(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./photoEditRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'точка мутации осталась в исходнике');
  const module = { exports: {} as Record<string, unknown> };
  const js = ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, { module, exports: module.exports, require: (id: string) => {
    assert.equal(id, './attachRules');
    return { photoCompressible };
  } });
  return module.exports as typeof rules;
}

it('поворот против часовой учитывает отражение и четыре четверти возвращают исходный кадр', () => {
  const crop = { x: 0.13, y: 0.22, w: 0.41, h: 0.37 };
  const plain = { angle: 0 as const, flipped: false, crop, aspect: 'free' as const };
  const flipped = rules.flipEdit(plain);
  const twiceFlipped = rules.flipCrop(rules.flipCrop(crop));
  for (const key of ['x', 'y', 'w', 'h'] as const) assert.ok(Math.abs(twiceFlipped[key] - crop[key]) < 1e-12);
  let rotated = crop;
  for (let i = 0; i < 4; i++) rotated = rules.rotateCropLeft(rotated);
  for (const key of ['x', 'y', 'w', 'h'] as const) assert.ok(Math.abs(rotated[key] - crop[key]) < 1e-12);
  const checkRotation = (api: typeof rules) => {
    assert.equal(api.rotateLeft(plain).angle, 90);
    assert.equal(api.rotateLeft(flipped).angle, 270);
  };
  checkRotation(rules);
  checkRotation(mutated('const step = e.flipped ? 270 : 90;', 'const step = e.flipped ? 270 : 90;'));
  assert.throws(() => checkRotation(mutated('const step = e.flipped ? 270 : 90;', 'const step = 90;')), assert.AssertionError,
    'мутант всегда вращает модель в неверную сторону после отражения');
});

it('пропорциональный угловой crop держит квадрат в снимке, не двигает края и округляется квадратом', () => {
  const c = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  const dragged = rules.dragCrop(c, 'se', 90, 10, 100, 100, 1, 1);
  assert.ok(Math.abs(dragged.w - dragged.h) < 1e-12);
  assert.ok(dragged.x >= 0 && dragged.y >= 0 && dragged.x + dragged.w <= 1 && dragged.y + dragged.h <= 1);
  assert.deepEqual(rules.dragCrop(c, 'e', 20, 0, 100, 100, 1, 1), c, 'при пропорции края не тянутся');
  const checkRatio = (api: typeof rules) => {
    const pixels = api.cropPixels({ x: 0, y: 0, w: 0.337, h: 0.6 }, 101, 80, 1);
    assert.equal(pixels.w, pixels.h);
  };
  checkRatio(rules);
  checkRatio(mutated('Math.round(ratio ? w / ratio : c.h * vh)', 'Math.round(ratio ? w / ratio : c.h * vh)'));
  assert.throws(() => assert.equal(rules.cropPixels({ x: 0, y: 0, w: 0.337, h: 0.6 }, 101, 80, null).w,
    rules.cropPixels({ x: 0, y: 0, w: 0.337, h: 0.6 }, 101, 80, null).h), assert.AssertionError,
  'контроль: свободная рамка не обязана быть квадратной');
  assert.throws(() => checkRatio(mutated('Math.round(ratio ? w / ratio : c.h * vh)', 'Math.round(c.h * vh)')), assert.AssertionError,
    'мутант теряет заданную пропорцию после округления');
  const checkEdge = (api: typeof rules) => {
    const edge = api.dragCrop({ x: 0.8, y: 0.2, w: 0.15, h: 0.15 }, 'se', 60, 60, 100, 200, 1, 1);
    assert.ok(edge.x + edge.w <= 1 && edge.y + edge.h <= 1, 'пропорциональная рамка остаётся внутри обоих краёв');
  };
  checkEdge(rules);
  checkEdge(mutated('nw = Math.min(nw, roomW, roomH * ratio);', 'nw = Math.min(nw, roomW, roomH * ratio);'));
  const noEdgeClamp = mutated('nw = Math.min(nw, roomW, roomH * ratio);', 'nw = Math.min(nw, roomH * ratio);');
  assert.throws(() => checkEdge(noEdgeClamp), assert.AssertionError,
    'мутант выпускает квадратную рамку за правый край снимка');
});

it('имя при переименовании сохраняет расширение, чистит запрещённые знаки и не меняет пустой ввод', () => {
  assert.equal(rules.renameTarget('photo.png', '  новый снимок  '), 'новый снимок.png');
  assert.equal(rules.renameTarget('photo.png', 'новый.jpg'), 'новый.jpg');
  assert.equal(rules.renameTarget('photo.png', 'photo'), null);
  for (const input of ['', '   ', '...']) assert.equal(rules.renameTarget('a.txt', input), null);
  assert.equal(rules.renameTarget('a.txt', 'bad:name'), 'bad_name.txt');
  assert.equal(rules.editedName('x.jpeg', 'image/jpeg'), 'x.jpeg');
  assert.equal(rules.editedName('x.png', 'image/jpeg'), 'x.jpg');
  assert.equal(rules.editOutputType('image/webp'), 'image/webp');
  assert.equal(rules.editOutputType('image/gif'), 'image/jpeg');
  assert.equal(rules.editIsPristine(rules.PRISTINE_EDIT), true);
  assert.equal(rules.editIsPristine({ ...rules.PRISTINE_EDIT, angle: 90 }), false);
});
