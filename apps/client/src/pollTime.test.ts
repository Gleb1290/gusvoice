import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pollTimeLeft } from './pollTime.js';

const NOW = Date.UTC(2026, 6, 22, 12, 0, 0);
const closesIn = (ms: number) => new Date(NOW + ms).toISOString();

describe('остаток времени опроса', () => {
  it('остаток меньше минуты показывается как одна минута, а не ноль', () => {
    // Иначе открытый ещё 20 секунд опрос выглядит уже закрытым и отговаривает голосовать.
    assert.equal(pollTimeLeft(closesIn(20_000), NOW), 'осталось 1 мин');
  });

  it('ровно 59 минут остаются минутами, а 59:31 округляются вверх до часа', () => {
    assert.equal(pollTimeLeft(closesIn(59 * 60_000), NOW), 'осталось 59 мин');
    assert.equal(pollTimeLeft(closesIn((59 * 60 + 31) * 1000), NOW), 'осталось 1 ч');
  });

  it('ровно час не округляется до двух часов', () => {
    assert.equal(pollTimeLeft(closesIn(60 * 60_000), NOW), 'осталось 1 ч');
  });

  it('граница суток сохраняет 23 часа и переключается на один день ровно вовремя', () => {
    assert.equal(pollTimeLeft(closesIn(23 * 60 * 60_000), NOW), 'осталось 23 ч');
    assert.equal(pollTimeLeft(closesIn(24 * 60 * 60_000), NOW), 'осталось 1 дн');
  });

  it('опрос ровно в момент закрытия и после него уже не показывает остаток', () => {
    assert.equal(pollTimeLeft(new Date(NOW).toISOString(), NOW), null);
    assert.equal(pollTimeLeft(new Date(NOW - 1).toISOString(), NOW), null);
  });

  it('мусор вместо даты даёт null, а не надпись с NaN', () => {
    assert.equal(pollTimeLeft('не дата', NOW), null);
  });
});

/**
 * Скачок единиц, который нашёл Codex: цепочка ceil (минуты → часы → дни) превращала
 * «час и одну миллисекунду» в «2 ч». Единица теперь выбирается по факту.
 */
describe('переход между единицами не перескакивает', () => {
  const NOW2 = Date.parse('2026-07-22T12:00:00.000Z');
  const через = (ms: number) => new Date(NOW2 + ms).toISOString();

  it('час с миллисекундой — это ещё «1 ч», а не «2 ч»', () => {
    assert.equal(pollTimeLeft(через(3_600_000 + 1), NOW2), 'осталось 1 ч');
  });

  it('час пятьдесят девять — всё ещё «1 ч»', () => {
    assert.equal(pollTimeLeft(через(3_600_000 + 59 * 60_000), NOW2), 'осталось 1 ч');
  });

  it('сутки с миллисекундой — «1 дн», а не «2 дн»', () => {
    assert.equal(pollTimeLeft(через(86_400_000 + 1), NOW2), 'осталось 1 дн');
  });

  it('почти двое суток — «1 дн»', () => {
    assert.equal(pollTimeLeft(через(2 * 86_400_000 - 1), NOW2), 'осталось 1 дн');
  });
});
