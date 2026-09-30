import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shareStartErrorText } from './shareErrorText.js';

describe('текст отказа старта показа', () => {
  it('сохраняет строку Tauri и message обычной ошибки', () => {
    // Ловит потерю единственной диагностической причины за общей фразой.
    assert.equal(shareStartErrorText('signal connection timed out'), 'Не удалось начать трансляцию: signal connection timed out');
    assert.equal(shareStartErrorText(new Error('permission denied')), 'Не удалось начать трансляцию: permission denied');
  });

  it('не ставит висячее двоеточие без причины', () => {
    // Ловит визуально оборванное сообщение при неизвестном типе отказа.
    assert.equal(shareStartErrorText(null), 'Не удалось начать трансляцию');
    assert.equal(shareStartErrorText({}), 'Не удалось начать трансляцию');
  });
});
