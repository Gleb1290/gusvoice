import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './contactRules';

function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./contactRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), `найдена точка мутации: ${from}`);
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, require: () => ({ FEATURE_CONTACTS1: 'contacts1' }) });
  return module.exports as typeof rules;
}

it('подпись контакта важнее имени профиля, а null-подпись оставляет имя', () => {
  // Иначе человек видит своё собственное имя, а не то, как подписал собеседника.
  assert.equal(rules.contactLabel({ name: 'Коллега', displayName: 'Иван' }), 'Коллега');
  assert.equal(rules.contactLabel({ name: null, displayName: 'Иван' }), 'Иван');
  const check = (api: typeof rules) => assert.equal(api.contactLabel({ name: 'Коллега', displayName: 'Иван' }), 'Коллега');
  check(rules);
  check(mutant('return c.name ?? c.displayName;', 'return c.name ?? c.displayName;'));
  assert.throws(() => check(mutant('return c.name ?? c.displayName;', 'return c.displayName;')), assert.AssertionError,
    'мутант игнорирует пользовательскую подпись контакта');
});

it('поиск контакта учитывает русские регистры, Unicode-ё и логин с начальным @', () => {
  // В адресной книге ищут привычную подпись, имя человека и его @логин одним полем.
  const c = { name: 'Ёжик', displayName: 'Евгений', username: 'uSeR' };
  assert.equal(rules.contactMatches(c, ' ёЖ '), true);
  assert.equal(rules.contactMatches(c, 'ЕВГ'), true);
  assert.equal(rules.contactMatches(c, '@USE'), true);
  assert.equal(rules.contactMatches(c, 'не совпадает'), false);
  assert.equal(rules.contactMatches(c, '  '), true);
  const check = (api: typeof rules) => assert.equal(api.contactMatches(c, '@USE'), true);
  check(rules);
  check(mutant("replace(/^@/, '')", "replace(/^@/, '')"));
  assert.throws(() => check(mutant("replace(/^@/, '')", "replace(/^#/, '')")), assert.AssertionError,
    'мутант оставляет @ в поисковой строке и теряет совпадение с логином');
});

it('сначала идут онлайн-контакты, затем имена сортируются по пользовательской подписи', () => {
  // Без приоритета статуса пропадает смысл режима «в сети», а сортировка по профилю путает личные подписи.
  const contacts = [
    { id: 'offline-z', name: 'Зет', displayName: 'Альфа' },
    { id: 'online-b', name: 'Бета', displayName: 'Борис' },
    { id: 'online-a', name: 'Альфа', displayName: 'Яков' },
  ];
  const online = new Set(['online-a', 'online-b']);
  const check = (api: typeof rules) => assert.equal(api.sortContacts(contacts, online).map((c) => c.id).join(','), 'online-a,online-b,offline-z');
  check(rules);
  check(mutant('Number(onlineSet.has(b.id)) - Number(onlineSet.has(a.id))',
    'Number(onlineSet.has(b.id)) - Number(onlineSet.has(a.id))'));
  check(mutant('return contactLabel(a).localeCompare(contactLabel(b), \'ru\');',
    'return contactLabel(a).localeCompare(contactLabel(b), \'ru\');'));
  assert.throws(() => check(mutant('Number(onlineSet.has(b.id)) - Number(onlineSet.has(a.id))',
    'Number(onlineSet.has(a.id)) - Number(onlineSet.has(b.id))')), assert.AssertionError,
    'мутант отправляет активных контактов вниз');
  assert.throws(() => check(mutant('return contactLabel(a).localeCompare(contactLabel(b), \'ru\');',
    "return a.displayName.localeCompare(b.displayName, 'ru');")), assert.AssertionError,
    'мутант сортирует по имени профиля, а не по пользовательской подписи');
});

it('незагруженный список не объявляет человека контактом', () => {
  // null означает «ещё грузим», но безопаснее не обещать действие для отсутствующей записи.
  assert.equal(rules.isContact(null, 'u'), false);
  assert.equal(rules.isContact([], 'u'), false);
  assert.equal(rules.isContact([{ id: 'u' }], 'u'), true);
});

it('подпись контакта после trim побеждает, а пустая или чужая запись оставляет имя профиля', () => {
  // Пробелы часто появляются при вводе подписи; показывать их вместо реального имени выглядит как пропажа собеседника.
  const contacts = [{ id: 'peer-a', name: '  Сосед по мастерской  ' }, { id: 'peer-b', name: '   ' }];
  assert.equal(rules.personLabel(contacts, 'peer-a', 'Профиль А'), 'Сосед по мастерской');
  assert.equal(rules.personLabel(contacts, 'peer-b', 'Профиль Б'), 'Профиль Б');
  assert.equal(rules.personLabel(contacts, 'peer-c', 'Профиль В'), 'Профиль В');
  assert.equal(rules.personLabel(null, 'peer-a', 'Профиль А'), 'Профиль А');
  const source = readFileSync(new URL('./contactRules.ts', import.meta.url), 'utf8');
  const evaluate = (changed: string) => {
    assert.ok(source.includes(changed));
    const module = { exports: {} as Record<string, unknown> };
    runInNewContext(ts.transpileModule(source.replace(changed, '?.name;'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { module, exports: module.exports, require: () => ({ FEATURE_CONTACTS1: 'contacts1' }) });
    return module.exports as typeof rules;
  };
  assert.throws(() => assert.equal(evaluate("?.name?.trim();")
    .personLabel(contacts, 'peer-a', 'Профиль А'), 'Сосед по мастерской'), assert.AssertionError);
});
