import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHoverHold } from './hoverHold.js';

/**
 * Удержание карточки на пути «строка → карточка».
 *
 * Проверяем обе стороны, потому что ошибка в любую заметна людям: закроем слишком рано — по кадру
 * невозможно кликнуть, до него не доводит мышка; не закроем вовсе — карточка виснет посреди экрана
 * и накрывает список.
 */

/** Стенд с ручными таймерами: время двигаем сами, ждать по-настоящему нечего. */
function стенд(graceMs = 250) {
  let closes = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let next = 1;
  let now = 0;
  const hold = createHoverHold({
    close: () => void closes++,
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => void timers.delete(id),
    graceMs,
  });
  const tick = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  return { hold, tick, живых: () => timers.size, закрытий: () => closes };
}

describe('createHoverHold', () => {
  it('после ухода курсора закрывает не сразу, а по истечении паузы', () => {
    const s = стенд(250);
    s.hold.release();
    s.tick(249);
    assert.equal(s.закрытий(), 0, 'до конца паузы карточка обязана стоять — по ней ещё идёт мышка');
    s.tick(1);
    assert.equal(s.закрытий(), 1);
  });

  it('курсор вернулся на карточку — закрытие отменяется совсем, а не откладывается', () => {
    const s = стенд(250);
    s.hold.release();
    s.tick(100);
    s.hold.hold();
    s.tick(10_000);
    assert.equal(s.закрытий(), 0);
    assert.equal(s.живых(), 0, 'отменённый таймер не должен остаться висеть');
  });

  it('ушёл, вернулся, ушёл снова — пауза отсчитывается заново от последнего ухода', () => {
    const s = стенд(250);
    s.hold.release();
    s.tick(200);
    s.hold.hold();
    s.hold.release();
    s.tick(200);
    assert.equal(s.закрытий(), 0, 'иначе второй уход закрыл бы карточку почти мгновенно');
    s.tick(50);
    assert.equal(s.закрытий(), 1);
  });

  it('перевод на соседа закрывает немедленно, без паузы', () => {
    const s = стенд(250);
    s.hold.closeNow();
    assert.equal(s.закрытий(), 1, 'пауза здесь показывала бы профиль прежнего человека поверх нового');
  });

  it('два ухода подряд дают ровно одно закрытие, а не два', () => {
    const s = стенд(250);
    s.hold.release();
    s.hold.release();
    s.tick(1000);
    assert.equal(s.закрытий(), 1);
    assert.equal(s.живых(), 0);
  });

  it('closeNow снимает и уже назначенное закрытие — оно не выстрелит вторым', () => {
    const s = стенд(250);
    s.hold.release();
    s.hold.closeNow();
    assert.equal(s.закрытий(), 1);
    s.tick(1000);
    assert.equal(s.закрытий(), 1);
  });

  it('dispose снимает отложенное и НЕ закрывает: дерева уже нет, звать некуда', () => {
    const s = стенд(250);
    s.hold.release();
    s.hold.dispose();
    s.tick(1000);
    assert.equal(s.закрытий(), 0);
    assert.equal(s.живых(), 0);
  });

  it('hold без назначенного закрытия ничего не ломает', () => {
    const s = стенд(250);
    s.hold.hold();
    s.hold.hold();
    s.tick(1000);
    assert.equal(s.закрытий(), 0);
  });
});
