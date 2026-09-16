import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STREAK_MAX_DAYS, streakReward, streakStep, streakView } from './streakRules.js';

const st = (streakDay: string, streakDays: number) => ({ streakDay, streakDays });

describe('шаг стрика', () => {
  it('первый в жизни приход даёт стрик в один день', () => {
    const r = streakStep(st('', 0), '2026-09-01');
    assert.equal(r.rewardDays, 1);
    assert.deepEqual(r.next, st('2026-09-01', 1));
  });

  it('приход на следующий день продолжает стрик', () => {
    const r = streakStep(st('2026-09-01', 3), '2026-09-02');
    assert.equal(r.rewardDays, 4);
    assert.equal(r.next.streakDays, 4);
  });

  /**
   * 🔴 Награда РОВНО ОДИН раз за сутки. Начисление за голос идёт каждые несколько минут, и без этой
   * отсечки бонус капал бы весь вечер — «раз в день» превратилось бы в «сколько досидишь».
   * ⚠️ Состояние при этом обязано остаться прежним: подмени мы его, второй заход за вечер сдвинул
   * бы день и завтрашний приход посчитался бы пропуском.
   */
  it('повторный заход в те же сутки не награждает и не меняет состояние', () => {
    const before = st('2026-09-01', 3);
    const r = streakStep(before, '2026-09-01');
    assert.equal(r.rewardDays, 0);
    assert.deepEqual(r.next, before);
  });

  /**
   * ⚠️ Пропуск обнуляет до ЕДИНИЦЫ, а не до нуля: человек всё равно сегодня пришёл, и оставить его
   * совсем без бонуса значило бы наказать за вчерашнее отсутствие дважды.
   */
  it('пропущенный день сбрасывает стрик до единицы, а не до нуля', () => {
    const r = streakStep(st('2026-09-01', 6), '2026-09-03');
    assert.equal(r.rewardDays, 1);
    assert.equal(r.next.streakDays, 1);
  });

  it('стрик упирается в потолок и дальше не растёт', () => {
    let s = st('2026-09-01', STREAK_MAX_DAYS);
    s = streakStep(s, '2026-09-02').next;
    assert.equal(s.streakDays, STREAK_MAX_DAYS);
    s = streakStep(s, '2026-09-03').next;
    assert.equal(s.streakDays, STREAK_MAX_DAYS);
  });

  /** Границы месяца и года — обычный случай для «вчера», и ломаться на них нельзя. */
  it('переход через месяц и через год считается продолжением', () => {
    assert.equal(streakStep(st('2026-08-31', 2), '2026-09-01').rewardDays, 3);
    assert.equal(streakStep(st('2026-12-31', 4), '2027-01-01').rewardDays, 5);
  });

  /**
   * ⚠️ Високосный день — единственная дата, на которой наивное «минус 86400000 миллисекунд» от
   * местной полуночи уезжает не туда. Проверяем оба края.
   */
  it('високосный день не рвёт стрик', () => {
    assert.equal(streakStep(st('2028-02-28', 1), '2028-02-29').rewardDays, 2);
    assert.equal(streakStep(st('2028-02-29', 2), '2028-03-01').rewardDays, 3);
  });

  /** Приход «вчерашним» днём (часы разъехались) не должен считаться продолжением наперёд. */
  it('день из прошлого не продолжает стрик, а начинает новый', () => {
    const r = streakStep(st('2026-09-05', 4), '2026-09-01');
    assert.equal(r.rewardDays, 1);
  });
});

describe('размер награды', () => {
  it('растёт кратно дням', () => {
    assert.equal(streakReward(1, 10), 10);
    assert.equal(streakReward(4, 10), 40);
  });

  it('упирается в тот же потолок, что и сам стрик', () => {
    assert.equal(streakReward(STREAK_MAX_DAYS + 5, 10), STREAK_MAX_DAYS * 10);
  });

  /** Нулевая или отрицательная настройка выключает стрик, а не выдаёт мусор. */
  it('без настройки награды нет', () => {
    assert.equal(streakReward(3, 0), 0);
    assert.equal(streakReward(3, -5), 0);
    assert.equal(streakReward(0, 10), 0);
  });
});

describe('streakView — серия глазами человека (правка 03.09)', () => {
  it('сегодня засчитан: цепочка с сегодняшним днём, награда уже выдана', () => {
    const v = streakView({ streakDay: '2026-09-03', streakDays: 4 }, '2026-09-03', 15);
    assert.equal(v.todayCounted, true);
    assert.equal(v.days, 4);
    assert.equal(v.todayReward, 60, 'то же, что начислил streakReward(4, 15)');
    assert.equal(v.nextReward, 75);
  });

  it('цепочка жива, сегодня ещё не заходил: дни вчерашние, «зайди — получишь»', () => {
    const v = streakView({ streakDay: '2026-09-02', streakDays: 3 }, '2026-09-03', 15);
    assert.equal(v.todayCounted, false);
    assert.equal(v.days, 3);
    assert.equal(v.todayReward, 60, 'заход сегодня сделает четвёртый день');
    assert.equal(v.nextReward, 75);
  });

  it('пропустил день: цепочка оборвана, первый заход даёт единичный бонус', () => {
    const v = streakView({ streakDay: '2026-09-01', streakDays: 6 }, '2026-09-03', 15);
    assert.equal(v.days, 0);
    assert.equal(v.todayReward, 15);
    assert.equal(v.nextReward, 30);
  });

  it('неделя — потолок и для показа: следующий день не обещает больше семикратного', () => {
    const v = streakView({ streakDay: '2026-09-03', streakDays: 7 }, '2026-09-03', 15);
    assert.equal(v.todayReward, 105);
    assert.equal(v.nextReward, 105);
    assert.equal(v.maxDays, 7);
  });

  it('bonus = 0 — серии на сервере нет', () => {
    assert.equal(streakView({ streakDay: '', streakDays: 0 }, '2026-09-03', 0).enabled, false);
  });
});
