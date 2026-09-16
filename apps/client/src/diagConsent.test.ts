import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diagDecision } from './diagConsent.js';

/**
 * Кого и когда спрашивать про сбор диагностики (#113).
 *
 * Правило маленькое, но ошибка в любую сторону дорогая: лишний «да» — это сбор данных о чужой
 * машине без спроса, лишний «спросить» — это окно про слежку у человека, чей сервер вообще ничего
 * не собирает.
 */

describe('инстанс не собирает', () => {
  it('молчим при любом ответе человека', () => {
    // ⚠️ Включая «не спрашивали»: вопрос «можно ли собирать» там, где собирать некуда, пугает без
    // повода и приучает отмахиваться от таких окон.
    assert.equal(diagDecision(false, 'unknown'), 'off');
    assert.equal(diagDecision(false, 'yes'), 'off', 'прошлое согласие на ДРУГОМ инстансе тут не действует');
    assert.equal(diagDecision(false, 'no'), 'off');
  });
});

describe('инстанс собирает', () => {
  it('человека ещё не спрашивали — спрашиваем', () => {
    assert.equal(diagDecision(true, 'unknown'), 'ask');
  });

  it('согласился — собираем', () => {
    assert.equal(diagDecision(true, 'yes'), 'collect');
  });

  it('отказался — не собираем и больше не спрашиваем', () => {
    // Повторный вопрос после отказа — это выпрашивание, а не согласие.
    assert.equal(diagDecision(true, 'no'), 'off');
  });
});

describe('умолчание', () => {
  it('без ответа человека сбор НЕ идёт', () => {
    // Направление ошибки: польза от диагностики наша, рискует человек. Значит по умолчанию — нет.
    assert.notEqual(diagDecision(true, 'unknown'), 'collect');
    assert.notEqual(diagDecision(false, 'unknown'), 'collect');
  });
});
