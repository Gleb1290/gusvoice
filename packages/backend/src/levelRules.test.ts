import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LEVEL_TITLES, levelFor, levelOf, levelStages, pointsForLevel, titleFor } from './levelRules.js';

/**
 * Уровни считаются от ЗАРАБОТАННЫХ МОНЕТ, одной шкалой без коэффициентов (решение 03.09).
 *
 * ⚠️ Прежняя версия складывала «очки участия» из трёх источников со своими весами. Тесты на веса
 * удалены вместе с ними: проверять исчезнувшую механику — держать в наборе ложное обещание.
 */
describe('pointsForLevel', () => {
  it('этапы — круглые числа, их и показывают человеку', () => {
    assert.equal(pointsForLevel(3), 360);
    assert.equal(pointsForLevel(6), 1_440);
    assert.equal(pointsForLevel(10), 4_000);
    assert.equal(pointsForLevel(26), 27_040);
  });

  it('нулевой и отрицательный уровень стоят ноль', () => {
    assert.equal(pointsForLevel(0), 0);
    assert.equal(pointsForLevel(-5), 0);
  });

  it('кривая НЕЛИНЕЙНА: каждый следующий шаг дороже предыдущего', () => {
    // Ровный шаг пустил бы старожила в бесконечный отрыв — квадрат его сдерживает.
    const step = (l: number) => pointsForLevel(l + 1) - pointsForLevel(l);
    for (let l = 1; l < 30; l++) assert.ok(step(l + 1) > step(l), `шаг ${l + 1} не больше шага ${l}`);
  });
});

describe('levelFor', () => {
  it('ровно на пороге уровень уже взят', () => {
    assert.equal(levelFor(4_000).level, 10);
    assert.equal(levelFor(3_999).level, 9);
  });

  it('ноль заработанного — нулевой уровень и первое звание', () => {
    const l = levelFor(0);
    assert.equal(l.level, 0);
    assert.equal(l.title, LEVEL_TITLES[0].title);
    assert.equal(l.progress, 0);
  });

  it('доля пути считается между СОСЕДНИМИ порогами, а не от нуля', () => {
    // Иначе полоска у высоких уровней почти не двигалась бы.
    const at = pointsForLevel(5);
    const next = pointsForLevel(6);
    const mid = Math.floor((at + next) / 2);
    const l = levelFor(mid);
    assert.equal(l.level, 5);
    assert.ok(Math.abs(l.progress - 0.5) < 0.02);
  });

  it('мусор прижимается к нулю: данные приходят из базы', () => {
    assert.equal(levelFor(Number.NaN).level, 0);
    assert.equal(levelFor(-100).level, 0);
    assert.equal(levelFor(Number.POSITIVE_INFINITY).level, 0);
  });

  it('уровень не мигает на границах — обратная кривая подстрахована циклами', () => {
    for (let l = 0; l <= 40; l++) {
      assert.equal(levelFor(pointsForLevel(l)).level, l, `порог уровня ${l}`);
      if (l > 0) assert.equal(levelFor(pointsForLevel(l) - 1).level, l - 1, `на единицу ниже ${l}`);
    }
  });
});

describe('levelOf', () => {
  it('берёт ТОЛЬКО заработанное, баланс и типы не участвуют', () => {
    // Полученный тип кладёт монеты на баланс, но не в `earnedTotal`, — иначе уровень дарился бы
    // с альта. Здесь это закреплено формой аргумента: ничего, кроме заработанного, не принимаем.
    assert.equal(levelOf({ earnedTotal: 4_000 }).level, 10);
    assert.equal(levelOf({ earnedTotal: 0 }).level, 0);
  });
});

describe('titleFor', () => {
  it('звание меняется ровно на своём уровне', () => {
    assert.equal(titleFor(2), 'Птенец');
    assert.equal(titleFor(3), 'Гусёнок');
    assert.equal(titleFor(9), 'Свой в стае');
    assert.equal(titleFor(10), 'Матёрый гусь');
  });

  it('выше последнего порога звание не сбрасывается', () => {
    const last = LEVEL_TITLES[LEVEL_TITLES.length - 1];
    assert.equal(titleFor(last.from + 50), last.title);
  });
});

describe('levelStages — лестница званий в числах (решение 03.09)', () => {
  it('ступеней столько же, сколько званий, и первая — с нуля', () => {
    const stages = levelStages();
    assert.equal(stages.length, LEVEL_TITLES.length);
    assert.deepEqual(stages[0], { title: 'Птенец', at: 0 });
  });

  it('пороги строго растут и совпадают с кривой уровней', () => {
    const stages = levelStages();
    for (let i = 1; i < stages.length; i++) assert.ok(stages[i].at > stages[i - 1].at, stages[i].title);
    // Круглое число из документации: «Матёрый гусь — 4000 монет» (множитель 40, правка 04.09).
    assert.deepEqual(stages.find((s) => s.title === 'Матёрый гусь'), { title: 'Матёрый гусь', at: 4_000 });
    // Порог ступени — ровно тот, на котором `levelFor` выдаёт это звание.
    for (const s of stages) assert.equal(levelFor(s.at).title, s.title, s.title);
  });
});
