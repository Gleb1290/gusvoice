import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampAxis, placeByAnchor, placeByPoint, type Viewport } from './popover.js';

const VP: Viewport = { vw: 320, vh: 240 };
const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  x: left,
  y: top,
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  toJSON: () => ({}),
});

describe('прижатие всплывающего слоя к экрану', () => {
  it('слой, который целиком влезает, остаётся на исходной позиции', () => {
    assert.equal(clampAxis(24, 40, 120), 24);
  });

  it('слой у начала экрана отступает на стандартные восемь пикселей', () => {
    assert.equal(clampAxis(-12, 40, 120), 8);
  });

  it('слой у конца экрана целиком возвращается в видимую область', () => {
    assert.equal(clampAxis(100, 40, 120), 72);
  });

  it('слой шире экрана прижимается к началу, а не уезжает в минус', () => {
    // Иначе левый край и элементы управления окажутся вне экрана без способа до них добраться.
    assert.equal(clampAxis(30, 160, 120), 8);
  });

  it('нулевой отступ разрешает поставить слой ровно на кромку', () => {
    assert.equal(clampAxis(-5, 40, 120, 0), 0);
    assert.equal(clampAxis(100, 40, 120, 0), 80);
  });

  it('нестандартный отступ одинаково соблюдается у обеих кромок', () => {
    assert.equal(clampAxis(0, 40, 120, 13), 13);
    assert.equal(clampAxis(100, 40, 120, 13), 67);
  });
});

describe('поповер у кнопки', () => {
  it('при свободном месте с обеих сторон выбирает позицию над кнопкой и по её правому краю', () => {
    assert.deepEqual(placeByAnchor(rect(140, 110, 20, 20), 80, 60, 8, VP), {
      left: 80,
      top: 42,
    });
  });

  it('у верхней кромки переносит поповер под кнопку', () => {
    assert.deepEqual(placeByAnchor(rect(140, 10, 20, 20), 80, 60, 8, VP), {
      left: 80,
      top: 38,
    });
  });

  it('у левой кромки выравнивает поповер по левому краю кнопки', () => {
    assert.deepEqual(placeByAnchor(rect(10, 110, 20, 20), 60, 60, 8, VP), {
      left: 10,
      top: 42,
    });
  });
});

describe('меню в точке курсора', () => {
  it('в свободном центре выбирает первый квадрант — вниз-вправо', () => {
    assert.deepEqual(placeByPoint(120, 80, 80, 60, 8, VP), { left: 120, top: 80 });
  });

  it('у правой кромки выбирает второй квадрант — вниз-влево', () => {
    assert.deepEqual(placeByPoint(300, 80, 80, 60, 8, VP), { left: 220, top: 80 });
  });

  it('у нижней кромки выбирает третий квадрант — вверх-вправо', () => {
    assert.deepEqual(placeByPoint(120, 220, 80, 60, 8, VP), { left: 120, top: 160 });
  });

  it('у правой нижней кромки выбирает четвёртый квадрант — вверх-влево', () => {
    assert.deepEqual(placeByPoint(300, 220, 80, 60, 8, VP), { left: 220, top: 160 });
  });

  it('если ни один вариант не влезает, выбирает наибольшую видимую площадь и затем прижимает', () => {
    // Вниз-влево здесь заметно виднее остальных; простое «взять первый и clamp» дало бы иной top.
    assert.deepEqual(placeByPoint(70, 40, 80, 80, 0, { vw: 100, vh: 100 }), {
      left: 0,
      top: 20,
    });
  });

  it('слой больше вьюпорта остаётся доступным с начальной кромки по обеим осям', () => {
    assert.deepEqual(placeByPoint(50, 40, 140, 120, 8, { vw: 100, vh: 80 }), {
      left: 8,
      top: 8,
    });
  });
});
