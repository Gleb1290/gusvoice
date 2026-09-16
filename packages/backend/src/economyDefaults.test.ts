import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { economyDefaults } from './economyDefaults.js';

/**
 * Умолчания панели = умолчания таблицы. Тест сторожит не арифметику, а СВЯЗЬ: если `getTableColumns`
 * однажды перестанет отдавать `default` (смена версии drizzle), панель молча откроется с нулями и
 * владелец сохранит их как настоящие настройки.
 */
describe('economyDefaults', () => {
  it('отдаёт боевые умолчания, а не нули', () => {
    const d = economyDefaults('srv-1');
    assert.equal(d.serverId, 'srv-1');
    assert.equal(d.ratePer5min, 10);
    assert.equal(d.dailyCap, 800);
    assert.equal(d.alonePercent, 25);
    assert.equal(d.companyPercent, 150);
    assert.equal(d.payoutMinutes, 10);
    assert.equal(d.gooseBonus, 15);
    assert.equal(d.gooseMinutes, 10);
    assert.equal(d.streakBonus, 3);
    assert.equal(d.currencyName, 'ГусКоины');
  });

  it('экономика при этом ВЫКЛЮЧЕНА, а отметок действий нет', () => {
    const d = economyDefaults('srv-1');
    assert.equal(d.enabled, false, 'панель обязана открываться выключенной');
    assert.equal(d.retroGrantedAt, null);
    assert.equal(d.accrualSince, null);
    assert.equal(d.iconUrl, null);
  });
});
