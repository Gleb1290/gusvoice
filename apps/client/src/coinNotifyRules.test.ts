import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COIN_NOTIFY_THROTTLE_MS, shouldNotifyCoin, type CoinNotifyInput } from './coinNotifyRules';

const base: CoinNotifyInput = {
  level: 'all',
  mine: false,
  dnd: false,
  focused: false,
  lastOtherAt: 0,
  now: 1_000_000,
};
const input = (p: Partial<CoinNotifyInput> = {}): CoinNotifyInput => ({ ...base, ...p });

describe('shouldNotifyCoin', () => {
  it('выключено — молчим при любом раскладе', () => {
    assert.equal(shouldNotifyCoin(input({ level: 'off', mine: true })), false);
  });

  it('в фокусе не уведомляем: подсказка и кошелёк уже всё показали', () => {
    assert.equal(shouldNotifyCoin(input({ mine: true, focused: true })), false);
  });

  it('«не беспокоить» сильнее адресности', () => {
    assert.equal(shouldNotifyCoin(input({ mine: true, dnd: true })), false);
  });

  it('в положении «когда меня» чужие события не проходят, а моё проходит', () => {
    assert.equal(shouldNotifyCoin(input({ level: 'mine', mine: false })), false);
    assert.equal(shouldNotifyCoin(input({ level: 'mine', mine: true })), true);
  });

  it('чужое в положении «все» проходит через троттл, но не чаще', () => {
    assert.equal(shouldNotifyCoin(input({ lastOtherAt: base.now - COIN_NOTIFY_THROTTLE_MS })), true);
    assert.equal(shouldNotifyCoin(input({ lastOtherAt: base.now - COIN_NOTIFY_THROTTLE_MS + 1 })), false);
  });

  it('адресное троттл НЕ режет — иначе «тебя ущипнули» потеряется из-за чужого типа', () => {
    assert.equal(shouldNotifyCoin(input({ mine: true, lastOtherAt: base.now })), true);
    assert.equal(shouldNotifyCoin(input({ level: 'mine', mine: true, lastOtherAt: base.now })), true);
  });
});
