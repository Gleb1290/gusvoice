import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nameFromRoster, resolveName } from './memberNameRules.js';

/**
 * Ник в пределах сервера.
 *
 * Повод: ник сохранялся в базу и приезжал в ростер, но НИГДЕ не подставлялся при отрисовке —
 * ни в чате, ни в голосе. Человек менял ник и не видел ровно никакой разницы.
 *
 * Поэтому здесь на каждое «ник виден» есть парное «остаётся обычное имя»: молчаливый откат к
 * обычному имени и был багом, а он выглядит точно как штатное поведение.
 */
describe('ник перекрывает имя', () => {
  it('ник вместо обычного имени', () => {
    assert.equal(resolveName('Гусь', 'SuperGoose'), 'Гусь');
  });

  it('ника нет — обычное имя', () => {
    assert.equal(resolveName(null, 'SuperGoose'), 'SuperGoose');
  });

  it('поля вообще нет — обычное имя', () => {
    assert.equal(resolveName(undefined, 'SuperGoose'), 'SuperGoose');
  });

  it('пустая строка — обычное имя, а не пустота', () => {
    assert.equal(resolveName('', 'SuperGoose'), 'SuperGoose');
  });

  it('одни пробелы — обычное имя, а не пустая строка', () => {
    assert.equal(resolveName('   ', 'SuperGoose'), 'SuperGoose');
  });

  it('ник с пробелами по краям обрезается', () => {
    assert.equal(resolveName('  Гусь  ', 'SuperGoose'), 'Гусь');
  });
});

describe('поиск по ростеру', () => {
  const roster = new Map<string, string | null>([
    ['u1', 'Гусь'],
    ['u2', null],
  ]);

  it('есть в ростере с ником — ник', () => {
    assert.equal(nameFromRoster(roster, 'u1', 'SuperGoose'), 'Гусь');
  });

  it('есть в ростере без ника — обычное имя', () => {
    assert.equal(nameFromRoster(roster, 'u2', 'Петя'), 'Петя');
  });

  it('НЕТ в ростере — обычное имя, без падения', () => {
    assert.equal(nameFromRoster(roster, 'u404', 'Маша'), 'Маша');
  });

  it('пустой ростер — всем обычные имена', () => {
    assert.equal(nameFromRoster(new Map(), 'u1', 'SuperGoose'), 'SuperGoose');
  });
});
