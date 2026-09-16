import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { streakCaption, streakDots, streakExplain, type StreakView } from './streakView.js';

const view = (patch: Partial<StreakView> = {}): StreakView => ({
  enabled: true,
  today: '2026-09-03', // четверг
  days: 4,
  todayCounted: true,
  todayReward: 60,
  nextReward: 75,
  bonus: 15,
  maxDays: 7,
  ...patch,
});

describe('streakDots — неделя ПН → ВС', () => {
  it('порядок дней ФИКСИРОВАН и начинается с понедельника', () => {
    assert.deepEqual(
      streakDots(view()).map((d) => d.label),
      ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'],
    );
  });

  it('тот же порядок в любой день недели — двигается только подсветка', () => {
    // 2026-09-07 — понедельник.
    assert.deepEqual(
      streakDots(view({ today: '2026-09-07' })).map((d) => d.label),
      ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'],
    );
  });

  it('засчитанный сегодня (четверг, 4 дня): залиты пн-чт', () => {
    assert.deepEqual(
      streakDots(view({ days: 4, todayCounted: true })).map((d) => d.state),
      ['on', 'on', 'on', 'on', 'off', 'off', 'off'],
    );
  });

  it('цепочка жива, сегодня не заходил: залито по вчера, сегодня — пунктиром', () => {
    assert.deepEqual(
      streakDots(view({ days: 3, todayCounted: false })).map((d) => d.state),
      ['on', 'on', 'on', 'today', 'off', 'off', 'off'],
    );
  });

  it('оборванная цепочка: одна пунктирная точка на сегодня', () => {
    assert.deepEqual(
      streakDots(view({ days: 0, todayCounted: false })).map((d) => d.state),
      ['off', 'off', 'off', 'today', 'off', 'off', 'off'],
    );
  });

  it('🔴 будущие дни недели НЕ заливаются, даже если цепочка длиннее недели', () => {
    // Пятница-воскресенье ещё не наступили — залить их значило бы сказать «ты уже приходил».
    assert.deepEqual(
      streakDots(view({ days: 12, todayCounted: true })).map((d) => d.state),
      ['on', 'on', 'on', 'on', 'off', 'off', 'off'],
    );
  });

  it('понедельник без захода: цепочка вчерашняя, её дни в прошлой неделе — тут не видно', () => {
    assert.deepEqual(
      streakDots(view({ today: '2026-09-07', days: 3, todayCounted: false })).map((d) => d.state),
      ['today', 'off', 'off', 'off', 'off', 'off', 'off'],
    );
  });

});

describe('streakCaption / streakExplain — слова', () => {
  it('склоняет дни и называет монеты за сегодня', () => {
    assert.equal(streakCaption(view(), 'ГусКоины'), '4 дня подряд · сегодня +60 ГусКоины');
    assert.equal(streakCaption(view({ days: 1, todayReward: 15 }), 'ГусКоины'), 'Первый день · сегодня +15 ГусКоины');
    assert.equal(streakCaption(view({ days: 5, todayReward: 75 }), 'ГусКоины'), '5 дней подряд · сегодня +75 ГусКоины');
  });

  it('живая цепочка зовёт зайти, оборванная — начать', () => {
    assert.equal(
      streakCaption(view({ days: 3, todayCounted: false, todayReward: 60 }), 'ГусКоины'),
      '3 дня подряд · зайди в голосовой канал сегодня — +60 ГусКоины',
    );
    assert.equal(
      streakCaption(view({ days: 0, todayCounted: false, todayReward: 15, nextReward: 30 }), 'ГусКоины'),
      'Начни заново: сегодня +15 ГусКоины, завтра +30',
    );
  });

  it('объяснение говорит, на что бонус, и считает крайние числа из ручки', () => {
    const text = streakExplain(view(), 'ГусКоины');
    assert.match(text, /за сам приход в голос/);
    assert.match(text, /сверху к обычному заработку/);
    assert.match(text, /1-й день \+15 ГусКоины/);
    assert.match(text, /с 7-го — \+105/);
  });
});
