import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatLayerTargets } from './streamDebugRules.js';

describe('цели слоёв в отладке показа', () => {
  it('нулевой или единственный слой не создаёт отдельную строку панели', () => {
    // Ловит шумную строку, которая не несёт сравнения между слоями.
    assert.equal(formatLayerTargets([]), '');
    assert.equal(formatLayerTargets([{ rid: 'f', active: true, bps: 3_500_000 }]), '');
  });

  it('несколько слоёв показывают Мбит/с, паузу и безопасное имя пустого rid', () => {
    // Ловит сокрытие dynacast-паузы под нулевым битрейтом и нечитаемую пустую подпись слоя.
    assert.equal(
      formatLayerTargets([
        { rid: 'f', active: true, bps: 3_500_000 },
        { rid: 'h', active: false, bps: 2_500_000 },
        { rid: '', active: true, bps: 150_000 },
      ]),
      'f 3.50 · h пауза · ? 0.15',
    );
  });
});
