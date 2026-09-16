import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { relativeTime } from './relativeTime.js';

const NOW = Date.parse('2026-09-06T20:00:00.000Z');
const ago = (ms: number) => NOW - ms;

describe('сколько времени прошло, словами', () => {
  it('границы минут и часов', () => {
    // Мутация: `< MIN` → `<= MIN` → падает первая же строка.
    assert.equal(relativeTime(ago(59_000), NOW), 'только что');
    assert.equal(relativeTime(ago(60_000), NOW), '1 мин назад');
    assert.equal(relativeTime(ago(3_599_000), NOW), '59 мин назад');
    assert.equal(relativeTime(ago(3_600_000), NOW), '1 ч назад');
    assert.equal(relativeTime(ago(86_399_000), NOW), '23 ч назад');
  });

  it('старше суток — обычная дата, а не «25 ч назад»', () => {
    const s = relativeTime(ago(86_400_000), NOW);
    assert.doesNotMatch(s, /назад/);
    assert.ok(s.length > 0);
  });

  it('🔴 мусор и невалидная дата дают ПУСТО, а не «Invalid Date»', () => {
    // Поймал Codex на старой версии в журнале: там мусор доезжал до человека как «Invalid Date».
    // Подпись тут украшение — сказать бессмыслицу хуже, чем не сказать ничего.
    for (const bad of ['мусор', '', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(relativeTime(bad as never, NOW), '', `«${String(bad)}» дало не пусто`);
    }
  });

  it('🔴 будущее округляется к «только что», а не обещает срок', () => {
    // Часы у людей врут на минуты; «через 3 минуты» из-за расхождения часов глупее округления.
    assert.equal(relativeTime(NOW + 5 * 60_000, NOW), 'только что');
    assert.equal(relativeTime(NOW + 365 * 86_400_000, NOW), 'только что');
  });

  it('строку ISO принимает наравне с числом', () => {
    assert.equal(relativeTime('2026-09-06T19:30:00.000Z', NOW), '30 мин назад');
  });
});
