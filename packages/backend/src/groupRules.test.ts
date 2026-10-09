import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as rules from './groupRules.js';

function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./groupRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from));
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, require: () => shared });
  return module.exports as typeof rules;
}
it('создатель входит в предел пяти, повторы не тратят места, сам себе не участник', () => {
  // Ловит шестого участника и ложный отказ ровно на допустимом пределе.
  const check = (api: typeof rules) => {
    assert.equal(api.groupCreateCheck('me', ['a', 'b', 'c', 'd']), 'ok');
    assert.equal(api.groupCreateCheck('me', ['a', 'b', 'c', 'd', 'e']), 'too-many');
    assert.equal(api.groupCreateCheck('me', ['a', 'a']), 'ok');
    assert.equal(api.groupCreateCheck('me', []), 'empty');
    assert.equal(api.groupCreateCheck('me', ['me', 'a']), 'self');
  }; check(rules);
  assert.throws(() => check(mutant('set.size + 1 > limit', 'set.size + 1 >= limit')), assert.AssertionError);
  assert.throws(() => check(mutant('set.size + 1 > limit', 'set.size > limit')), assert.AssertionError);
});
it('добавление ровно до пяти принимается, пустое и шестое отклоняются', () => {
  // Ловит расхождение ограничений создания и приглашения.
  assert.equal(rules.groupAddCheck(4, 1), 'ok');
  assert.equal(rules.groupAddCheck(4, 2), 'too-many');
  assert.equal(rules.groupAddCheck(1, 4), 'ok');
  assert.equal(rules.groupAddCheck(4, 0), 'empty');
  assert.equal(rules.groupAddCheck(4, -1), 'empty');
});
it('исключить другого может только владелец, уход передаёт владение самому раннему', () => {
  // Ловит повышение обычного участника до модератора и потерю владельца при уходе.
  const check = (api: typeof rules) => {
    assert.equal(api.canRemoveMember('owner', 'a', 'b'), true);
    for (const role of ['owner', 'member', null] as const) assert.equal(api.canRemoveMember(role, 'a', 'a'), false);
    for (const role of ['member', null] as const) assert.equal(api.canRemoveMember(role, 'a', 'b'), false);
    assert.equal(api.nextOwner([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'a'), 'b');
    assert.equal(api.nextOwner([{ id: 'a' }], 'a'), null);
    assert.equal(api.nextOwner([], 'a'), null);
  }; check(rules);
  assert.throws(() => check(mutant("actorRole === 'owner' &&", 'true &&')), assert.AssertionError);
});
it('название считает Unicode-символы и схлопывает пробелы, оба края лимита проверены', () => {
  // Ловит отказ законного названия с эмодзи и пустую группу без имени.
  assert.equal(rules.normalizeGroupTitle('  Наш\n\t чат  '), 'Наш чат');
  assert.equal(rules.normalizeGroupTitle('🪿'.repeat(rules.GROUP_TITLE_MAX)), '🪿'.repeat(rules.GROUP_TITLE_MAX));
  assert.equal(rules.normalizeGroupTitle('🪿'.repeat(rules.GROUP_TITLE_MAX + 1)), null);
  for (const raw of ['', ' \n', null, 5, {}]) assert.equal(rules.normalizeGroupTitle(raw), null);
});
it('все служебные действия имеют запасной текст и пуш называет группу', () => {
  // Ловит пустой текст действия на старом клиенте.
  const users = [{ id: 'u', displayName: 'Б' }];
  for (const [type, text] of [['create', 'А создал(а) группу «Чат»'], ['add', 'А добавил(а) Б'], ['remove', 'А удалил(а) Б'], ['leave', 'А покинул(а) группу'], ['title', 'А изменил(а) название группы на «Чат»'], ['photo', 'А изменил(а) фото группы']] as const)
    assert.equal(rules.serviceText('А', { kind: 'group', type, title: 'Чат', users }), text);
  assert.equal(rules.groupPushTitle('А', 'Чат'), 'А в «Чат»');
});
