import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { occupancyText, occupiedNow, type Occupancy } from './occupancy.js';

describe('occupiedNow', () => {
  const at = (ms: number, anchor: number): Occupancy => ({ ms, anchor });

  it('досчитывает от якоря, а не от нуля', () => {
    assert.equal(occupiedNow(at(60_000, 1_000), 4_000), 63_000);
  });

  it('час в фоне засчитывается целиком, сколько бы ни тикнул таймер', () => {
    // Браузер душит `setInterval` в фоновой вкладке. Именно поэтому считаем от монотонного якоря:
    // сумма тиков отстала бы, а разность показаний счётчика — нет.
    assert.equal(occupiedNow(at(0, 0), 3_600_000), 3_600_000);
  });

  it('часы, ушедшие назад, не дают отрицательного', () => {
    assert.equal(occupiedNow(at(5_000, 10_000), 1_000), 0);
  });
});

describe('occupancyText', () => {
  it('до часа — минуты и секунды, без ведущего нуля часа', () => {
    assert.equal(occupancyText(0), '0:00');
    assert.equal(occupancyText(9_000), '0:09');
    assert.equal(occupancyText(72_000), '1:12');
    assert.equal(occupancyText(59 * 60_000 + 59_000), '59:59');
  });

  it('после часа появляются часы, а минуты становятся двузначными', () => {
    // Иначе строка прыгала бы по ширине каждую минуту и дёргала соседний текст.
    assert.equal(occupancyText(3_600_000), '1:00:00');
    assert.equal(occupancyText(3_600_000 + 5 * 60_000 + 9_000), '1:05:09');
    assert.equal(occupancyText(12 * 3_600_000 + 34 * 60_000 + 56_000), '12:34:56');
  });

  it('ровно на границе часа переключается', () => {
    assert.equal(occupancyText(3_599_999), '59:59');
    assert.equal(occupancyText(3_600_000), '1:00:00');
  });

  it('мусор и отрицательное схлопываются в ноль', () => {
    // Расхождение часов или битое число не должны рисовать «-1:59:59».
    assert.equal(occupancyText(-5_000), '0:00');
    assert.equal(occupancyText(Number.NaN), '0:00');
    assert.equal(occupancyText(Number.POSITIVE_INFINITY), '0:00');
  });

  it('секунды не округляются вверх — 999 мс это всё ещё ноль секунд', () => {
    assert.equal(occupancyText(999), '0:00');
    assert.equal(occupancyText(1_000), '0:01');
  });
});
