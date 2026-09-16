import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  centerOffset,
  clampOffset,
  coverScale,
  MAX_ZOOM,
  OUT,
  sourceRect,
  VIEW,
  zoomFraction,
  zoomTo,
} from './avatarCropRules.js';

describe('геометрия кадрирования аватара', () => {
  it('размеры окна, экспорта и предел зума остаются согласованными с UI', () => {
    // Ловит незаметное расхождение canvas-экспорта и геометрии модального окна.
    assert.deepEqual({ VIEW, OUT, MAX_ZOOM }, { VIEW: 280, OUT: 256, MAX_ZOOM: 4 });
  });

  it('широкая и высокая картинки масштабируются по более узкой стороне', () => {
    // Ловит замену max на min, оставляющую пустые поля в квадратной рамке.
    assert.equal(coverScale({ w: 1_000, h: 500 }), 0.56);
    assert.equal(coverScale({ w: 500, h: 1_000 }), 0.56);
  });

  it('центрирование оставляет короткую сторону ровно по рамке', () => {
    // Ловит смещение видимого кадра относительно того, что затем уйдёт в canvas.
    assert.deepEqual(centerOffset({ w: 1_000, h: 500 }, 0.56), { x: -140, y: 0 });
  });

  it('положительное смещение прижимается к верхней и левой кромке', () => {
    // Ловит появление пустого поля перед изображением при перетаскивании наружу.
    assert.deepEqual(clampOffset({ x: 20, y: 30 }, 1, { w: 1_000, h: 1_000 }), { x: 0, y: 0 });
  });

  it('слишком отрицательное смещение прижимается к нижней и правой кромке', () => {
    // Ловит пустое поле после изображения на противоположных сторонах рамки.
    assert.deepEqual(clampOffset({ x: -900, y: -800 }, 1, { w: 1_000, h: 1_000 }), { x: -720, y: -720 });
  });

  it('допустимое внутреннее смещение не меняется', () => {
    // Ловит дрожание кадра из-за лишнего прижатия уже валидной позиции.
    assert.deepEqual(clampOffset({ x: -300, y: -400 }, 1, { w: 1_000, h: 1_000 }), { x: -300, y: -400 });
  });

  it('отдаление упирается в минимальный масштаб и повторно прижимает кадр', () => {
    // Ловит выход ниже cover-scale и пустые поля после уменьшения изображения.
    assert.deepEqual(
      zoomTo({ scale: 2, off: { x: -300, y: -100 } }, 0.5, 1, { w: 1_000, h: 1_000 }),
      { scale: 1, off: { x: -80, y: 0 } },
    );
  });

  it('приближение упирается в MAX_ZOOM и сохраняет точку под центром', () => {
    // Ловит скачок выбранного объекта при изменении масштаба вокруг неверной опорной точки.
    const before = { scale: 1, off: { x: -100, y: -100 } };
    const after = zoomTo(before, 10, 1, { w: 1_000, h: 1_000 });
    assert.deepEqual(after, { scale: 4, off: { x: -820, y: -820 } });
    assert.equal((VIEW / 2 - before.off.x) / before.scale, (VIEW / 2 - after.off.x) / after.scale);
  });

  it('sourceRect на минимуме даёт короткую сторону исходника', () => {
    // Ловит несовпадение предпросмотра и реально вырезаемой области оригинала.
    const nat = { w: 1_000, h: 500 };
    const scale = coverScale(nat);
    const rect = sourceRect(centerOffset(nat, scale), scale);
    assert.ok(Math.abs(rect.sx - 250) < 1e-9);
    assert.ok(Math.abs(rect.sy) < 1e-9);
    assert.ok(Math.abs(rect.size - 500) < 1e-9);
  });

  it('ползунок зума даёт 0, середину и 1 без деления на ноль', () => {
    // Ловит неверную заливку ползунка и NaN при ещё не загруженном изображении.
    assert.equal(zoomFraction(1, 1), 0);
    assert.equal(zoomFraction(2.5, 1), 0.5);
    assert.equal(zoomFraction(4, 1), 1);
    assert.equal(zoomFraction(0, 0), 0);
  });
});
