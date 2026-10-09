import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitZoom, ZOOM_CAP, pinchStep, clampPan } from './lightboxZoom';

test('щипок сохраняет точку картинки под пальцами даже при движении середины', () => {
  // Масштаб от центра экрана вместо середины пальцев заставляет увеличиваемый участок убегать.
  const p = { zoom0: 1.5, pan0: { x: 25, y: -15 }, center: { x: 200, y: 150 }, mid0: { x: 310, y: 205 }, mid: { x: 340, y: 170 }, dist0: 100, dist: 160, min: 0.5, max: 3 };
  const result = pinchStep(p);
  assert.ok(Math.abs(result.zoom - 2.4) < 1e-10, 'масштаб равен отношению расстояний без требования точного двоичного представления');
  for (const axis of ['x', 'y'] as const) {
    const original = (p.mid0[axis] - p.center[axis] - p.pan0[axis]) / p.zoom0;
    const moved = (p.mid[axis] - p.center[axis] - result.pan[axis]) / result.zoom;
    assert.ok(Math.abs(original - moved) < 1e-10, `неподвижная точка по ${axis}`);
  }
});

test('щипок принимает ровно 0.5 и 3, ограничивает обе стороны и переживает нулевое расстояние', () => {
  // Потолок и нижний край должны работать и для пальцев, а не только для кнопок масштабирования.
  const p = { zoom0: 1, pan0: { x: 0, y: 0 }, center: { x: 0, y: 0 }, mid0: { x: 0, y: 0 }, mid: { x: 0, y: 0 }, dist0: 100, dist: 100, min: 0.5, max: 3 };
  for (const [dist, expected] of [[49, 0.5], [50, 0.5], [51, 0.51], [299, 2.99], [300, 3], [301, 3], [0, 1], [-1, 1]]) assert.equal(pinchStep({ ...p, dist }).zoom, expected);
  assert.equal(pinchStep({ ...p, dist0: 0, dist: 300 }).zoom, 1);
});

test('сдвиг фото ограничивается выступающими краями, а вмещающаяся ось стоит по центру', () => {
  // Панорамирование не должно открывать пустоту между краем фото и краем сцены.
  const size = { w: 200, h: 100 }, stage = { w: 300, h: 150 };
  assert.deepEqual(clampPan({ x: 30, y: -10 }, 2, size, stage), { x: 30, y: -10 });
  assert.deepEqual(clampPan({ x: 50, y: -25 }, 2, size, stage), { x: 50, y: -25 });
  assert.deepEqual(clampPan({ x: 51, y: -26 }, 2, size, stage), { x: 50, y: -25 });
  assert.deepEqual(clampPan({ x: -500, y: 500 }, 2, size, stage), { x: -50, y: 25 });
  assert.deepEqual(clampPan({ x: 500, y: -500 }, 1, size, stage), { x: 0, y: 0 });
  assert.deepEqual(clampPan({ x: 9, y: -9 }, 1.5, size, stage), { x: 0, y: 0 });
});

test('картинка крупнее сцены остаётся в единице — её вписывает вёрстка', () => {
  assert.equal(fitZoom({ w: 3000, h: 2000 }, { w: 1200, h: 700 }), 1);
});

test('аватар 256×256 подтягивается к сцене, но не дальше потолка', () => {
  assert.equal(fitZoom({ w: 256, h: 256 }, { w: 1200, h: 700 }), ZOOM_CAP);
});

test('подтягивание идёт по узкой стороне, чтобы картинка влезла целиком', () => {
  // По ширине влезло бы 4×, по высоте — только 1.5×: берём меньшее.
  assert.equal(fitZoom({ w: 300, h: 400 }, { w: 1200, h: 600 }), 1.5);
});

test('картинка ровно в размер сцены не увеличивается', () => {
  assert.equal(fitZoom({ w: 800, h: 600 }, { w: 800, h: 600 }), 1);
});

test('нулевые размеры (кадр ещё не загружен) не ломают масштаб', () => {
  assert.equal(fitZoom({ w: 0, h: 0 }, { w: 1200, h: 700 }), 1);
  assert.equal(fitZoom({ w: 256, h: 256 }, { w: 0, h: 0 }), 1);
});

test('потолок можно опустить — увеличение не уходит выше него', () => {
  assert.equal(fitZoom({ w: 100, h: 100 }, { w: 1200, h: 700 }, 1.5), 1.5);
});
