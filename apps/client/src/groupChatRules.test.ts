import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import type { ConvSummary } from '@gusvoice/shared';
import * as convSyncRules from './convSyncRules';
import * as rules from './groupChatRules';
import * as pluralRules from './plural';

it('подпись набора различает ноль, одного, двоих и несколько человек', () => {
  // Ловит подпись единственного человека во множественном числе и перечисление всей группы.
  assert.equal(rules.groupTypingLabel([]), '');
  assert.equal(rules.groupTypingLabel(['А']), 'А печатает');
  assert.equal(rules.groupTypingLabel(['А', 'Б']), 'А и Б печатают');
  assert.equal(rules.groupTypingLabel(['А', 'Б', 'В']), '3 человека печатают');
  assert.equal(rules.groupTypingLabel(['А', 'Б', 'В', 'Г', 'Д']), '5 человек печатают');
  assert.deepEqual(rules.typingNames({ members: [{ id: 'a', displayName: 'А' }] } as Parameters<typeof rules.typingNames>[0], ['gone', 'a']), ['А']);
  const member = { members: [{ id: 'peer-a', displayName: 'Профиль А' }, { id: 'peer-b', displayName: 'Профиль Б' }] } as Parameters<typeof rules.typingNames>[0];
  assert.deepEqual(rules.typingNames(member, ['peer-a', 'gone', 'peer-b'], (_id, fallback) => `Подпись ${fallback}`), ['Подпись Профиль А', 'Подпись Профиль Б']);
});
it('превью различает своё, чужое, служебное сообщение и отсутствие автора', () => {
  // Ловит двойное имя перед готовой служебной фразой.
  assert.equal(rules.groupPreviewAuthor({ authorId: 'a', authorName: 'А' }, 'a'), 'Вы');
  assert.equal(rules.groupPreviewAuthor({ authorId: 'a', authorName: 'А' }, 'b'), 'А');
  assert.equal(rules.groupPreviewAuthor({ authorId: 'peer-a', authorName: 'Профиль А' }, 'me', (_id, fallback) => `Подпись ${fallback}`), 'Подпись Профиль А');
  assert.equal(rules.groupPreviewAuthor({ authorId: 'me', authorName: 'Профиль свой' }, 'me', () => 'Чужая подпись'), 'Вы');
  assert.equal(rules.groupPreviewAuthor({ authorId: 'a' }, 'b'), null);
  assert.equal(rules.groupPreviewAuthor(null, 'a'), null);
  assert.equal(rules.groupPreviewAuthor({ authorId: 'a', service: true }, 'a'), null);
});
it('прочитано хотя бы одним берётся из серверного ключа группы, неизвестный вид не служебный', () => {
  // Ловит потерю двойной галочки группы и превращение неизвестного сообщения в пилюлю.
  assert.equal(rules.chatReadKeyOf({ group: {}, peerReadKey: 42 } as ConvSummary), 42);
  assert.equal(rules.chatReadKeyOf({ group: {} } as ConvSummary), null);
  assert.equal(rules.chatReadKeyOf(undefined), null);
  const service = { kind: 'group' as const, type: 'create' as const, title: 'Чат' };
  assert.equal(rules.groupServiceMark({ service }), service);
  for (const service of [undefined, null, { kind: 'pin', messageId: 'm' }, { kind: 'other', type: 'leave' }, { kind: 'group' }])
    assert.equal(rules.groupServiceMark({ service }), null);
});
it('выбор участников включает себя и достигает полного состояния ровно на пяти', () => {
  // Ловит выбор лишнего участника до отправки на сервер.
  assert.deepEqual(rules.groupPickState(3), { total: 4, full: false, label: '4/5' });
  assert.deepEqual(rules.groupPickState(4), { total: 5, full: true, label: '5/5' });
  assert.equal(rules.groupPickState(2, 3).full, true);
  assert.equal(rules.groupMembersLabel(1), '1 участник');
  assert.equal(rules.groupMembersLabel(3), '3 участника');
  assert.equal(rules.groupMembersLabel(5), '5 участников');
});

it('цвет автора стабилен, лежит в семи токенах и не зависит от других участников', () => {
  // Цвет по имени менялся бы после переименования, а неверный индекс обратился бы к отсутствующему CSS-токену.
  const check = (api: typeof rules) => {
    assert.equal(api.PEER_COLOR_COUNT, 7);
    assert.equal(api.peerColorIndex('a'), 5);
    assert.equal(api.peerColorIndex('bob'), 3);
    assert.equal(api.peerColorIndex('a'), api.peerColorIndex('a'));
    for (const id of ['', '0', 'alice', 'гусь']) assert.ok(api.peerColorIndex(id) >= 0 && api.peerColorIndex(id) < 7);
  };
  check(rules);
  const source = readFileSync(new URL('./groupChatRules.ts', import.meta.url), 'utf8');
  const load = (from: string, to: string): typeof rules => {
    assert.ok(source.includes(from), 'точка мутации цвета найдена');
    const module = { exports: {} as Record<string, unknown> };
    runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, require: (id: string) => {
        if (id === '@gusvoice/shared') return shared;
        if (id === './convSyncRules') return convSyncRules;
        if (id === './plural') return pluralRules;
        throw new Error(`неожиданный импорт ${id}`);
      } });
    return module.exports as typeof rules;
  };
  check(load('return h % PEER_COLOR_COUNT;', 'return h % PEER_COLOR_COUNT;'));
  assert.throws(() => check(load('return h % PEER_COLOR_COUNT;', 'return id.length % PEER_COLOR_COUNT;')), assert.AssertionError,
    'мутант заменяет стабильный FNV-1a цвет длиной имени');
});
