import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import type { ConvSummary, User } from '@gusvoice/shared';
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

it('группы соседей требуют fedm6, а свои доступны всегда', () => {
  // Без проверки флага чужой участник выглядит выбираемым, а при ошибочной проверке теряется и свой.
  const check = (api: typeof rules) => {
    assert.equal(api.serverFedGroups(['dm2once', 'fedm6']), true, 'fedm6 включает смешанные группы');
    assert.equal(api.serverFedGroups(['dm2once']), false, 'одной поддержки лички недостаточно');
    assert.equal(api.serverFedGroups([]), false, 'пустой список не включает смешанные группы');
    assert.equal(api.serverFedGroups(null), false, 'неизвестные признаки не включают смешанные группы');
    assert.equal(api.serverFedGroups(undefined), false, 'отсутствие списка фич безопасно');
    assert.equal(api.groupPickable({ homeInstance: null }, false), true, 'свой участник доступен без fedm6');
    assert.equal(api.groupPickable({}, false), true, 'участник без homeInstance считается своим');
    assert.equal(api.groupPickable({ homeInstance: { instanceId: 'home-peer', name: null, domain: 'peer.test' } }, false), false,
      'сосед недоступен без fedm6');
    assert.equal(api.groupPickable({ homeInstance: { instanceId: 'home-peer', name: null, domain: 'peer.test' } }, true), true,
      'сосед доступен с fedm6');
  };
  const source = readFileSync(new URL('./groupChatRules.ts', import.meta.url), 'utf8');
  const load = (from: string, to: string): typeof rules => {
    assert.ok(source.includes(from), 'точка мутации доступности найдена');
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
  check(rules);
  assert.throws(() => check(load('return !u.homeInstance || fedGroups;', 'return !u.homeInstance && fedGroups;')),
    (error) => error instanceof assert.AssertionError && error.message.startsWith('свой участник доступен без fedm6')
      && error.actual === false && error.expected === true,
    'мутант && fedGroups ошибочно скрывает своих');
});

it('подписи дома группы используют имя, домен и источник-хост по приоритету', () => {
  // Участник хоста — главный источник имени; 1:1 только запасной источник, а пробельное имя не должно затмить домен.
  const home = (instanceId: string, name?: string, domain?: string): NonNullable<User['homeInstance']> => ({
    instanceId, name: name ?? null, domain: domain ?? '',
  });
  const check = (api: typeof rules) => {
    assert.equal(api.groupHomeLabel(home('n1', '  Дом соседа  ', 'neighbor.test')), 'Дом соседа');
    assert.equal(api.groupHomeLabel(home('n1', '   ', 'neighbor.test')), 'neighbor.test');
    assert.equal(api.groupHomeLabel(home('n1')), null);
    assert.equal(api.groupHomeLabel(null), null);
    assert.equal(api.groupHomeLabel(undefined), null);
    const memberHome = home('host', 'Участник хоста');
    const dmHome = home('host', 'Собеседник 1:1');
    assert.equal(api.groupHostHome('host', [{ homeInstance: memberHome }], [{ otherUser: { homeInstance: dmHome } }])?.name, 'Участник хоста',
      'дом участника имеет приоритет над собеседником 1:1');
    assert.equal(api.groupHostHome('host', [], [{ otherUser: { homeInstance: dmHome } }])?.name, 'Собеседник 1:1');
    assert.equal(api.groupHostHome('missing', [{ homeInstance: memberHome }]), null);
    assert.equal(api.groupHostHome(null, [{ homeInstance: memberHome }]), null);
    assert.equal(api.groupOpPending({ pending: true }), true, 'только подтверждённый ответ означает ожидание');
    for (const value of [{ pending: false }, { pending: 'true' }, {}, null, 'pending'])
      assert.equal(api.groupOpPending(value), false, 'похожие или отсутствующие флаги не означают ожидание');
    assert.equal(api.fedGroupPendingText('Дом'), 'Запрос отправлен инстансу «Дом»');
    assert.equal(api.fedGroupPendingText(null), 'Запрос отправлен инстансу, где живёт группа');
    assert.equal(api.fedGroupPhotoHint('Дом'), 'Фото меняется на инстансе «Дом»');
    assert.equal(api.fedGroupPhotoHint(null), 'Фото меняется на инстансе, где живёт группа');
    assert.equal(api.fedGroupDownText('Дом'), 'Инстанс «Дом», где живёт группа, недоступен — сообщения доедут, когда он вернётся; состав сейчас не меняется');
    assert.equal(api.fedGroupDownText(null), 'Инстанс, где живёт группа, недоступен — сообщения доедут, когда он вернётся; состав сейчас не меняется');
  };
  const source = readFileSync(new URL('./groupChatRules.ts', import.meta.url), 'utf8');
  const load = (from: string, to: string): typeof rules => {
    assert.ok(source.includes(from), 'точка мутации приоритета дома найдена');
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
  check(rules);
  const memberLoop = '  for (const m of members) if (m.homeInstance?.instanceId === hostId) return m.homeInstance;\n  for (const d of dms) if (d.otherUser.homeInstance?.instanceId === hostId) return d.otherUser.homeInstance;';
  const dmFirst = '  for (const d of dms) if (d.otherUser.homeInstance?.instanceId === hostId) return d.otherUser.homeInstance;\n  for (const m of members) if (m.homeInstance?.instanceId === hostId) return m.homeInstance;';
  assert.throws(() => check(load(memberLoop, dmFirst)),
    (error) => error instanceof assert.AssertionError && error.message.startsWith('дом участника имеет приоритет над собеседником 1:1')
      && error.actual === 'Собеседник 1:1' && error.expected === 'Участник хоста',
    'мутант меняет приоритет источников дома группы');
});

it('отказ приглашения называет только выбранные инстансы, убирает повторы и даёт безопасный fallback', () => {
  // Фильтр по userIds важен при смешанном выборе: общий текст всех чужих инстансов обещает неверную причину.
  const picked = [
    { id: 'own', homeInstance: null },
    { id: 'peer-a', homeInstance: { instanceId: 'a', name: 'Дом А', domain: 'a.test' } },
    { id: 'peer-a-copy', homeInstance: { instanceId: 'a2', name: 'Дом А', domain: 'a2.test' } },
    { id: 'peer-b', homeInstance: { instanceId: 'b', name: null, domain: 'b.test' } },
    { id: 'peer-unknown', homeInstance: { instanceId: 'c', name: null, domain: '' } },
  ];
  const check = (api: typeof rules) => {
    assert.equal(api.groupNotInvitableText(['peer-a', 'peer-a-copy', 'own', 'peer-a'], picked),
      'Нельзя позвать: инстанс «Дом А» не поддерживает группы', 'один дом дедуплицируется по подписи');
    assert.equal(api.groupNotInvitableText(['peer-a', 'peer-b'], picked),
      'Нельзя позвать: инстансы «Дом А», «b.test» не поддерживают группы', 'два выбранных дома перечисляются один раз');
    assert.equal(api.groupNotInvitableText([], picked),
      'Нельзя позвать: инстансы «Дом А», «b.test» не поддерживают группы', 'пустой отказанный список означает все выбранные дома');
    assert.equal(api.groupNotInvitableText(undefined, picked),
      'Нельзя позвать: инстансы «Дом А», «b.test» не поддерживают группы', 'отсутствующий список означает все выбранные дома');
    assert.equal(api.groupNotInvitableText(['peer-unknown', 'own'], picked),
      'Нельзя позвать: инстанс этого человека не поддерживает группы', 'без имени и только свой участник не раскрывают чужой дом');
    assert.equal(api.groupNotInvitableText(['not-picked'], picked),
      'Нельзя позвать: инстанс этого человека не поддерживает группы', 'невыбранный id не подмешивает чужие дома');
    assert.equal(api.groupNotInvitableText(undefined, []),
      'Нельзя позвать: инстанс этого человека не поддерживает группы', 'без выбора остаётся человеческий запасной текст');
  };
  const source = readFileSync(new URL('./groupChatRules.ts', import.meta.url), 'utf8');
  const load = (from: string, to: string): typeof rules => {
    assert.ok(source.includes(from), 'точка мутации фильтра отказанных id найдена');
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
  check(rules);
  assert.throws(() => check(load('(!ids || ids.has(p.id))', 'true')),
    (error) => error instanceof assert.AssertionError && error.message.startsWith('один дом дедуплицируется по подписи')
      && error.expected === 'Нельзя позвать: инстанс «Дом А» не поддерживает группы',
    'мутант без фильтра userIds подмешивает неотказанные дома');
});
