import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { explainAccrual } from './economy.js';

describe('объяснение начисления в журнале', () => {
  it('без разбора возвращает null — старые строки журнала прятать нельзя', () => {
    // У строк, записанных до появления разбора, его не будет никогда. Сумма важнее объяснения.
    assert.equal(explainAccrual(undefined), null);
    assert.equal(explainAccrual({}), null);
    assert.equal(explainAccrual({ burned: 3 } as never), null);
  });

  it('ровные множители в причины НЕ попадают', () => {
    // «Затухание: 0» — это шум. Причиной считается только то, что реально сдвинуло сумму.
    const why = explainAccrual({ seconds: 600, baseMilli: 20_000, presenceMilli: 0, companyMilli: 0, decayMilli: 0 });
    assert.deepEqual(why?.parts, []);
    assert.equal(why?.fullCoins, 20);
  });

  it('мелочь меньше 0.05 монеты причиной не считается', () => {
    const why = explainAccrual({ seconds: 600, baseMilli: 20_000, decayMilli: -40 });
    assert.deepEqual(why?.parts, []);
  });

  it('компания приходит НАДБАВКОЙ со знаком плюс', () => {
    // Знак решает формулировку: «вы были в компании +5» против «вы были одни −4».
    const why = explainAccrual({ seconds: 600, baseMilli: 20_000, companyMilli: 5_000 });
    assert.deepEqual(why?.parts, [{ label: 'вы были в компании', coins: 5 }]);
  });

  it('одиночество и выключенный микрофон приходят потерями', () => {
    const why = explainAccrual({ seconds: 600, baseMilli: 20_000, presenceMilli: -2_500, companyMilli: -4_000 });
    assert.deepEqual(why?.parts, [
      { label: 'микрофон был выключен', coins: -2.5 },
      { label: 'вы были одни', coins: -4 },
    ]);
  });

  it('потолок доносится отдельным признаком', () => {
    // Это самая непонятная причина «получил меньше»: человек сидит, а начисление прекратилось.
    const why = explainAccrual({ seconds: 600, baseMilli: 20_000, cappedByDaily: true });
    assert.equal(why?.cappedByDaily, true);
  });

  it('время склоняется по-русски', () => {
    const t = (seconds: number) => explainAccrual({ seconds, baseMilli: 1000 })?.time;
    assert.equal(t(600), '10 минут в голосовом канале');
    assert.equal(t(60), '1 минуту в голосовом канале');
    assert.equal(t(180), '3 минуты в голосовом канале');
    assert.equal(t(660), '11 минут в голосовом канале');
    assert.equal(t(1_320), '22 минуты в голосовом канале');
  });

  it('меньше минуты показываем секундами, а не «0 минут»', () => {
    assert.equal(explainAccrual({ seconds: 20, baseMilli: 500 })?.time, '20 с в голосовом канале');
  });
});
