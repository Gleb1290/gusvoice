import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampAxis, placeByAnchor, placeByPoint, placeStackByPoint, placeByHalf, type Viewport } from './popover.js';

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

describe('меню раунда 12 с полосой реакций', () => {
  it('карточка остаётся в квадранте клика, а отступ полосы берётся из её реального offsetTop', () => {
    // Если зашить высоту полосы в JS, CSS gap сменится отдельно и полоса налезет на карточку.
    assert.deepEqual(placeStackByPoint(120, 80, 120, 100, { left: 10, top: 30, w: 100, h: 70 }, 8, VP), { left: 110, top: 50 });
    assert.deepEqual(placeStackByPoint(120, 80, 120, 100, { left: 10, top: 12, w: 100, h: 70 }, 8, VP), { left: 110, top: 68 });
    assert.deepEqual(placeStackByPoint(120, 80, 120, 100, { left: 10, top: 0, w: 100, h: 70 }, 8, VP), { left: 110, top: 80 });
  });
  it('полоса и карточка вместе клампятся у правого и нижнего края', () => {
    // Кламп только карточки обрежет полосу над ней либо вынесет её за край экрана.
    assert.deepEqual(placeStackByPoint(300, 220, 120, 100, { left: 10, top: 30, w: 100, h: 70 }, 8, VP), { left: 190, top: 120 });
    assert.deepEqual(placeStackByPoint(4, 4, 140, 130, { left: 20, top: 45, w: 100, h: 70 }, 8, VP), { left: 8, top: 8 });
  });
});

describe('меню у строки по половине экрана', () => {
  it('положение якоря ровно на середине и на один пиксель по обе стороны выбирает нужную сторону', () => {
    // Строгий знак сравнения важен на midpoint: ±1 не должны менять сторону раньше пересечения центра.
    assert.deepEqual(placeByHalf(rect(20, 104, 60, 32), 100, 40, 'start', 8, 8, VP), { left: 20, top: 144 });
    assert.deepEqual(placeByHalf(rect(20, 103, 60, 32), 100, 40, 'start', 8, 8, VP), { left: 20, top: 143 });
    assert.deepEqual(placeByHalf(rect(20, 105, 60, 32), 100, 40, 'start', 8, 8, VP), { left: 20, top: 57 });
  });
  it('нижняя половина ставит меню над якорем и align end совмещает правые края', () => {
    // Иначе мобильное меню закрывает сам пузырь либо уходит от края автора.
    assert.deepEqual(placeByHalf(rect(220, 170, 60, 30), 100, 80, 'end', 8, 8, VP), { left: 180, top: 82 });
  });
  it('верхняя половина ставит меню под якорем, нижняя половина — над ним', () => {
    // Обычный выбор стороны не должен инвертироваться только из-за того, что противоположная просторнее.
    assert.deepEqual(placeByHalf(rect(20, 20, 60, 30), 100, 80, 'start', 8, 8, VP), { left: 20, top: 58 });
    assert.deepEqual(placeByHalf(rect(20, 200, 60, 30), 100, 80, 'start', 8, 8, VP), { left: 20, top: 112 });
  });
  it('верхняя половина с длинным меню, не вмещающимся ни с одной стороны, клампит его в окно', () => {
    // Наивное размещение длинной карточки под якорем полностью унесёт её за нижний край.
    assert.deepEqual(placeByHalf(rect(20, 20, 60, 30), 100, 300, 'start', 8, 8, VP), { left: 20, top: 8 });
  });
  it('прижимает меню к верхней/левой кромке и не уводит слишком широкий слой в минус', () => {
    // Позиция якоря — предпочтение, а не разрешение обрезать меню краем окна.
    assert.deepEqual(placeByHalf(rect(0, 20, 20, 20), 100, 80, 'start', 8, 8, VP), { left: 8, top: 48 });
    assert.deepEqual(placeByHalf(rect(10, 100, 20, 20), 400, 300, 'start', 8, 8, VP), { left: 8, top: 8 });
  });
});
