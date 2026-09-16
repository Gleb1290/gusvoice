import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { finiteDeep } from './diagRules.js';

describe('очистка нечисловых метрик диагностики', () => {
  it('заменяет NaN и бесконечности на любой глубине, включая массивы', () => {
    // Один NaN в глубоко вложенной метрике становится null при JSON.stringify и раньше отбрасывал
    // целый отчёт. Проверяем весь путь, а не только плоский объект кодировщика.
    const input = {
      fps: Number.NaN,
      capture: { avg: Infinity, recent: -Infinity },
      layers: [30, { encodeMs: Number.NaN }, [Infinity]],
    };

    assert.deepEqual(finiteDeep(input), {
      fps: 0,
      capture: { avg: 0, recent: 0 },
      layers: [30, { encodeMs: 0 }, [0]],
    });
  });

  it('сохраняет конечные числа, нули и нечисловые данные без подмены', () => {
    // Ноль означает «измерение не удалось»; чистка не должна путать его с плохим числом или
    // придумывать значения для строк, null и флагов.
    const input = {
      zero: 0,
      negative: -12.5,
      max: Number.MAX_VALUE,
      ready: false,
      adapter: 'NVIDIA',
      optional: null,
      values: [1, null, 'n/a', true],
    };

    assert.deepEqual(finiteDeep(input), {
      zero: 0,
      negative: -12.5,
      max: Number.MAX_VALUE,
      ready: false,
      adapter: 'NVIDIA',
      optional: null,
      values: [1, null, 'n/a', true],
    });
  });
});
