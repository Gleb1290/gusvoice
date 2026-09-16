import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ROLE_BADGES_MAX, topRoles, type RoleForBadge } from './memberRoles.js';

/**
 * Отбор ролей для значков.
 *
 * Правило общее для шторки профиля и карточки наведения, поэтому ошибка тут показывает одному
 * человеку РАЗНЫЕ роли в двух местах одного экрана.
 */

const роль = (id: string, position: number, over: Partial<RoleForBadge> = {}): RoleForBadge => ({
  id,
  name: id,
  color: 0,
  position,
  isEveryone: false,
  ...over,
});

describe('topRoles', () => {
  it('отдаёт от старшей к младшей, а не в порядке сервера', () => {
    const все = [роль('младшая', 1), роль('старшая', 9), роль('средняя', 5)];
    const ids = ['младшая', 'старшая', 'средняя'];
    assert.deepEqual(
      topRoles(все, ids).map((r) => r.id),
      ['старшая', 'средняя', 'младшая'],
    );
  });

  it('выбрасывает @everyone — она есть у всех и потому ничего не сообщает', () => {
    const все = [роль('everyone', 0, { isEveryone: true }), роль('модератор', 3)];
    assert.deepEqual(
      topRoles(все, ['everyone', 'модератор']).map((r) => r.id),
      ['модератор'],
    );
  });

  it('берёт только роли этого человека, чужие не подмешивает', () => {
    const все = [роль('своя', 4), роль('чужая', 8)];
    assert.deepEqual(
      topRoles(все, ['своя']).map((r) => r.id),
      ['своя'],
    );
  });

  it('обрезает по пределу, оставляя СТАРШИЕ', () => {
    const все = Array.from({ length: 10 }, (_, i) => роль(`r${i}`, i));
    const ids = все.map((r) => r.id);
    const got = topRoles(все, ids);
    assert.equal(got.length, ROLE_BADGES_MAX);
    assert.equal(got[0].id, 'r9', 'первой обязана идти самая старшая');
    assert.equal(got[got.length - 1].id, 'r4', 'обрезаться обязаны младшие');
  });

  it('незнакомый id молча пропускается — состав ролей мог смениться при открытой карточке', () => {
    assert.deepEqual(
      topRoles([роль('живая', 1)], ['живая', 'удалённая-пока-смотрели']).map((r) => r.id),
      ['живая'],
    );
  });

  it('нет ролей — пустой список, а не падение', () => {
    assert.deepEqual(topRoles([роль('a', 1)], []), []);
    assert.deepEqual(topRoles([], ['a']), []);
  });

  it('исходный массив ролей не переупорядочивается', () => {
    // Он приходит из bootstrap и живёт в сторе: сортировка на месте перетасовала бы роли всему
    // приложению — например, в настройках сервера.
    const все = [роль('a', 1), роль('b', 9)];
    topRoles(все, ['a', 'b']);
    assert.deepEqual(
      все.map((r) => r.id),
      ['a', 'b'],
    );
  });
});
