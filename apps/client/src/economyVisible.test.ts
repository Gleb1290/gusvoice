import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { economyVisible } from './economyVisible';

describe('economyVisible', () => {
  it('слово бэкенда сильнее устаревшего флага инстанса', () => {
    // Ровно случай десктопа 04.09: в реестре инстанса лежит `false` с момента добавления сервера,
    // а экономика давно включена. Профиль об этом знает — он и решает.
    assert.equal(economyVisible(true, false), true);
  });

  it('закрытый показ не пускает даже при включённом инстансе', () => {
    assert.equal(economyVisible(false, true), false);
  });

  it('поля нет — верим флагу инстанса', () => {
    assert.equal(economyVisible(undefined, true), true);
    assert.equal(economyVisible(undefined, false), false);
  });
});
