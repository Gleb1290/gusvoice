import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { socketStale, STALE_MS } from './socketHealth.js';

describe('живость веб-сокета', () => {
  it('свежий сокет считается живым в момент открытия', () => {
    // Ловит немедленное переподключение, если lastRecv инициализирован временем открытия.
    assert.equal(socketStale(10_000, 10_000), false);
  });

  it('ровно на границе допустимой тишины сокет ещё жив', () => {
    // Ловит ошибку на единицу, которая рвёт соединение раньше обещанных 70 секунд.
    assert.equal(socketStale(5_000, 5_000 + STALE_MS), false);
  });

  it('через миллисекунду после границы сокет считается протухшим', () => {
    // Ловит зависший OPEN-сокет, который никогда не переподключается после сна.
    assert.equal(socketStale(5_000, 5_000 + STALE_MS + 1), true);
  });
});
