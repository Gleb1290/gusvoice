import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldPulseWallet } from './coinsCue.js';

/**
 * Отклик кошелька на начислении (#117). Выплата ТИХАЯ — только анимация, без звука (решение 03.09).
 *
 * ⚠️ Здесь проверяется только РЕШЕНИЕ «дёргать или нет» по паре чисел. То, что в это решение
 * подаётся именно `earnedTotal`, а не баланс, живёт в `sockets.ts` и чистым тестом не ловится —
 * подмена поля пройдёт мимо этих проверок. Обоснование выбора поля записано в `coinsCue.ts`.
 */
describe('shouldPulseWallet', () => {
  it('дёргается, когда заработано стало больше', () => {
    assert.equal(shouldPulseWallet(10, 13), true);
  });

  it('стоит, когда число не изменилось', () => {
    // Срез без целой монеты доезжает до кошелька, но человеку в этот момент ничего не начислили.
    assert.equal(shouldPulseWallet(10, 10), false);
  });

  it('стоит на трате', () => {
    // Баланс на покупке падает, а `earnedTotal` не должен — но если он всё же поехал вниз,
    // дёргать тем более нельзя: отклик говорит «пришло».
    assert.equal(shouldPulseWallet(10, 4), false);
  });

  it('стоит на первом кошельке — это открытие сервера, а не выплата', () => {
    // Самая дорогая ошибка из возможных: без этого кошелёк прыгал бы при каждом входе в приложение.
    assert.equal(shouldPulseWallet(undefined, 250), false);
  });

  it('стоит на нуле, пришедшем первым', () => {
    // Ноль — полноправное прошлое значение, но его ещё не было: «не знали» и «было ноль» — разное.
    assert.equal(shouldPulseWallet(undefined, 0), false);
  });

  it('дёргается на первой в жизни монете, когда прошлое значение — ноль', () => {
    assert.equal(shouldPulseWallet(0, 1), true);
  });

  it('стоит на мусорных числах', () => {
    assert.equal(shouldPulseWallet(Number.NaN, 5), false);
    assert.equal(shouldPulseWallet(5, Number.NaN), false);
    assert.equal(shouldPulseWallet(5, Number.POSITIVE_INFINITY), false);
  });
});
