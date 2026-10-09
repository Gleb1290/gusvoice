import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { normalizeUserQuery, reachableUser, rankUserHits, USER_SEARCH_LIMIT, USER_SEARCH_RATE } from './userSearchRules.js';

it('откаты границ, локальности и побайтной сортировки отвергаются исполняемым контрактом', () => {
  // Проверяем, что тесты правил реально обнаруживают изменения, а не просто совпадают с текущими фикстурами.
  const source = readFileSync(new URL('./userSearchRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const contract = (r: typeof import('./userSearchRules.js')) => {
    assert.equal(r.normalizeUserQuery('aa'), null);
    assert.equal(r.reachableUser({ deletedAt: null, homeInstanceId: 'other', verified: true, approvedAt: new Date() }), false);
    assert.equal(r.rankUserHits(['abc_', 'abc.', 'abc-'].map(username => ({ username })), 'abc').map(x => x.username).join(','), 'abc-,abc.,abc_');
    assert.equal(r.rankUserHits([{ username: 'zabc' }], 'abc').length, 0);
  };
  const load = (raw: string) => {
    const box = { exports: {} };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, box);
    return box.exports as typeof import('./userSearchRules.js');
  };
  contract(load(source));
  for (const [from, to] of [
    ['{3,32}', '{2,32}'], ['u.homeInstanceId === null', 'true'],
    ['key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0', 'key(b) < key(a) ? -1 : key(b) > key(a) ? 1 : 0'],
    ['key(r).startsWith(needle)', 'key(r).includes(needle)'],
  ]) {
    assert.ok(source.includes(from), 'найден якорь отката');
    assert.throws(() => contract(load(source.replace(from, to))), assert.AssertionError);
  }
});

it('поиск срезает пробелы и один @, но не два, и приводит регистр', () => {
  // Двойное упоминание не должно превращаться в другой допустимый логин.
  assert.equal(normalizeUserQuery(' @AbC._- '), 'abc._-');
  assert.equal(normalizeUserQuery('ABC'), 'abc');
  for (const raw of ['@@abc', '@ abc', 'абв', 'a bc', '', null, 123, {}]) assert.equal(normalizeUserQuery(raw), null);
});

it('ровно 3 и 32 знака принимаются, 2 и 33 отвергаются', () => {
  // Два конца диапазона должны совпадать с маской регистрации.
  for (const n of [3, 32]) assert.equal(normalizeUserQuery('a'.repeat(n)), 'a'.repeat(n));
  for (const n of [2, 33]) assert.equal(normalizeUserQuery('a'.repeat(n)), null);
});

it('доступен только свой подтверждённый одобренный живой человек', () => {
  // Любое из независимых ограничений не должно обходиться остальными положительными флагами.
  const live = { deletedAt: null, homeInstanceId: null, verified: true, approvedAt: new Date(0) };
  assert.equal(reachableUser(live), true);
  for (const patch of [{ deletedAt: new Date(0) }, { homeInstanceId: 'foreign' }, { verified: false }, { approvedAt: null }]) {
    assert.equal(reachableUser({ ...live, ...patch }), false);
  }
});

it('точный логин первый, затем короткие префиксы; подстрока вне начала не выдаётся', () => {
  // Сортировка до лимита должна сохранять точное совпадение, даже если оно было последним.
  const names = ['abc-long', 'zabc', 'abcd', 'ABC', 'abcde'];
  const rows = names.map(username => ({ username }));
  assert.deepEqual(rankUserHits(rows, 'AbC').map(r => r.username), ['ABC', 'abcd', 'abcde', 'abc-long']);
  assert.deepEqual(rows.map(r => r.username), names, 'входная выдача не мутируется');
});

it('равная длина сортируется побайтно: дефис, точка, подчёркивание', () => {
  // localeCompare меняет порядок пунктуации относительно PostgreSQL COLLATE C.
  assert.deepEqual(rankUserHits(['abc_', 'abc.', 'abc-'].map(username => ({ username })), 'abc').map(r => r.username), ['abc-', 'abc.', 'abc_']);
});

it('предел выдачи равен восьми, нулевой и отрицательный дают пустой список', () => {
  // Девятый результат не должен раскрыться из-за off-by-one, а точный остаётся в восьмёрке.
  assert.equal(USER_SEARCH_LIMIT, 8);
  assert.deepEqual(USER_SEARCH_RATE, { max: 30, windowS: 60 });
  const rows = [...Array.from({ length: 9 }, (_, i) => ({ username: `abc${i}` })), { username: 'abc' }];
  assert.equal(rankUserHits(rows, 'abc').length, 8);
  assert.equal(rankUserHits(rows, 'abc')[0].username, 'abc');
  for (const limit of [0, -1]) assert.deepEqual(rankUserHits(rows, 'abc', limit), []);
  assert.equal(rankUserHits(rows, 'abc', 1).length, 1);
  assert.deepEqual(rankUserHits([], 'abc'), []);
});
