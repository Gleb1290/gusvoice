import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import { FEATURE_LASTSEEN3, FEATURE_PRESENCE4 } from '@gusvoice/shared';
import * as rules from './lastSeenExceptionsRules';
import { applyExceptionPick, exceptionCountLabel, exceptionKindsShown, exceptionsBody, serverLastSeenExceptions } from './lastSeenExceptionsRules';

function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./lastSeenExceptionsRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.equal(id, '@gusvoice/shared'); return shared; } });
  return module.exports as typeof rules;
}

const user = (id: string) => ({ id, username: id, displayName: id, avatarUrl: null });

it('исключения показывают только противоположный список для everyone/nobody и оба для peers', () => {
  assert.deepEqual(exceptionKindsShown('everyone'), ['never']);
  assert.deepEqual(exceptionKindsShown('nobody'), ['always']);
  assert.deepEqual(exceptionKindsShown('peers'), ['always', 'never']);
  assert.equal(serverLastSeenExceptions([FEATURE_LASTSEEN3]), true);
  assert.equal(serverLastSeenExceptions(null), false);
});

it('счётчик склоняет 0, 1, 2–4, 5–20, 11–14, 21 и 22', () => {
  for (const [n, label] of [[0, 'Добавить'], [1, '1 человек'], [2, '2 человека'], [4, '4 человека'], [5, '5 человек'],
    [11, '11 человек'], [14, '14 человек'], [21, '21 человек'], [22, '22 человека']] as const) assert.equal(exceptionCountLabel(n), label);
});

it('выбор одного списка удаляет тех же людей из другого и тело API содержит только ids', () => {
  const original = { always: [user('a'), user('b')], never: [user('a'), user('c')] };
  const picked = applyExceptionPick(original, 'always', [user('b'), user('c')]);
  assert.deepEqual(picked.always.map(u => u.id), ['b', 'c']);
  assert.deepEqual(picked.never.map(u => u.id), ['a']);
  assert.deepEqual(exceptionsBody(picked), { always: ['b', 'c'], never: ['a'] });
  assert.deepEqual(original.never.map(u => u.id), ['a', 'c'], 'редактор не портит прежний снимок');
});

it('исключения звонков имеют свои подписи и включаются только presence4', () => {
  // Если подставить lastseen3, старый клиент покажет настройку звонков, хотя сервер её ещё не умеет.
  const check = (api: typeof rules) => {
    assert.equal(api.exceptionTitles('calls').always, 'Всегда разрешать');
    assert.equal(api.exceptionTitles('calls').never, 'Никогда не разрешать');
    assert.equal(api.exceptionTitles('lastSeen').always, 'Всегда показывать');
    assert.equal(api.serverCallPrivacy([FEATURE_PRESENCE4]), true);
    for (const features of [undefined, null, [], [FEATURE_LASTSEEN3]]) assert.equal(api.serverCallPrivacy(features), false);
  };
  check(rules);
  check(mutant('return setting === \'calls\' ? CALL_EXCEPTION_TITLE : EXCEPTION_TITLE;', 'return setting === \'calls\' ? CALL_EXCEPTION_TITLE : EXCEPTION_TITLE;'));
  assert.throws(() => check(mutant('return !!features?.includes(FEATURE_PRESENCE4);', 'return !!features?.includes(FEATURE_LASTSEEN3);')), assert.AssertionError,
    'мутант включает настройки звонков по флагу приватности захода');
});
