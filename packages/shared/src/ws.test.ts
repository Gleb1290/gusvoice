import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { channelFromRoom, FEATURE_BIGREACT1, FEATURE_CONTACTS1, isServerMessageType, ROOM_PREFIX, roomForChannel, VOICE_ONCE_SPENT_TEXT, ROUND_ONCE_SPENT_TEXT, type GatewayServerMessage } from './ws.js';
import type { ConvMessage } from './types.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

describe('имена голосовых комнат LiveKit', () => {
  it('идентификатор канала получает ровно один служебный префикс', () => {
    // Ловит несовпадение имени комнаты между выдачей токена и обработкой webhook.
    assert.equal(roomForChannel('8eb8f61e-99ea-4ab3-a0d2-4f17f760bf5c'), `${ROOM_PREFIX}8eb8f61e-99ea-4ab3-a0d2-4f17f760bf5c`);
  });

  it('обратное преобразование сохраняет подчёркивания внутри идентификатора', () => {
    // Ловит разбор через split, который обрезал бы допустимую часть после первого подчёркивания.
    assert.equal(channelFromRoom('channel_team_voice_1'), 'team_voice_1');
  });

  it('чужие и похожие имена комнат не принимаются за каналы GusVoice', () => {
    // Ловит обработку webhook из комнаты без точного namespace-префикса приложения.
    assert.equal(channelFromRoom('other_channel_1'), null);
    assert.equal(channelFromRoom('Channel_1'), null);
    assert.equal(channelFromRoom('xchannel_1'), null);
  });
});

it('смена фазы звонка распознаётся как серверное событие, похожие и прототипные имена — нет', () => {
  // Ловит молчаливую потерю входящего звонка через whitelist шлюза.
  const fixture = { t: 'call.state', call: { id: 'c', conversationId: 'dm', callerId: 'a', calleeId: 'b', phase: 'ringing', createdAt: '2026-10-08T00:00:00Z', callerDevice: 'tab', video: true } } satisfies GatewayServerMessage;
  const parsed = JSON.parse(JSON.stringify(fixture));
  assert.equal(isServerMessageType(parsed.t), true);
  assert.equal(parsed.call.video, true);
  for (const t of ['calls.state', 'call.State', 'constructor', '__proto__', null, {}]) assert.equal(isServerMessageType(t), false);
  const source = readFileSync(new URL('./ws.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("'call.state': true,"), 'точка мутации whitelist существует');
  const module = { exports: {} as { isServerMessageType: typeof isServerMessageType } };
  runInNewContext(ts.transpileModule(source.replace("'call.state': true,", ''), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
  assert.throws(() => assert.equal(module.exports.isServerMessageType(parsed.t), true), assert.AssertionError);
});

it('погашенное одноразовое вложение имеет общий флаг и разные запасные тексты голоса и кружка', () => {
  // Закрепляет wire-фикстуру: старому клиенту остаётся текст без доступа к удалённому файлу.
  assert.equal(VOICE_ONCE_SPENT_TEXT, 'Голосовое сообщение прослушано');
  assert.equal(ROUND_ONCE_SPENT_TEXT, 'Видеосообщение просмотрено');
  for (const content of [VOICE_ONCE_SPENT_TEXT, ROUND_ONCE_SPENT_TEXT]) {
    const fixture = {
      id: 'm', channelId: 'dm', conversationId: 'dm', sortKey: 1, clientId: null,
      author: { id: 'u', username: 'user', displayName: 'Пользователь', avatarUrl: null },
      content, attachments: [], createdAt: '2026-10-08T00:00:00Z', editedAt: null,
      reactions: [], replyTo: null, voiceOnceSpent: true,
    } satisfies ConvMessage;
    const parsed = JSON.parse(JSON.stringify(fixture));
    assert.equal(parsed.voiceOnceSpent, true);
    assert.deepEqual(parsed.attachments, []);
    assert.equal(parsed.content, content);
  }
});

it('присутствие ЛС распознаётся отдельным событием, снимок сохраняет невидимых для серверов', () => {
  // Ловит потерю зелёной точки в ЛС при неизвестном шлюзу типе presence4, не смешивая её с серверным online.
  const fixtures = [
    { t: 'online.dm', userId: 'u', online: true },
    { t: 'online.dm', userId: 'u', online: false },
    { t: 'online.snapshot', users: ['visible'], dmOnly: ['u'] },
    { t: 'online.snapshot', users: [] },
  ] satisfies GatewayServerMessage[];
  for (const fixture of fixtures) assert.equal(isServerMessageType(JSON.parse(JSON.stringify(fixture)).t), true);
  assert.equal(isServerMessageType('online.dmOnly'), false);
  const source = readFileSync(new URL('./ws.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("'online.dm': true,"));
  const load = (s: string) => {
    const module = { exports: {} as { isServerMessageType: typeof isServerMessageType } };
    runInNewContext(ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
    return module.exports.isServerMessageType;
  };
  assert.equal(load(source)('online.dm'), true, 'неизменённый изолированный модуль проходит тот же контракт');
  assert.throws(() => assert.equal(load(source.replace("'online.dm': true,", ''))('online.dm'), true), assert.AssertionError);
});

it('обновление контактов распознаётся шлюзом и несёт личную подпись, пустой список допустим', () => {
  // Ловит потерю обновления личного списка после записи/удаления контакта.
  assert.equal(FEATURE_CONTACTS1, 'contacts1');
  const fixtures = [
    { t: 'contacts.update', contacts: [] },
    { t: 'contacts.update', contacts: [{ id: 'u', username: 'user', displayName: 'Имя', avatarUrl: null, name: 'Моя подпись 🪶', addedAt: '2026-10-08T00:00:00Z' }] },
  ] satisfies GatewayServerMessage[];
  for (const fixture of fixtures) {
    const parsed = JSON.parse(JSON.stringify(fixture));
    assert.equal(isServerMessageType(parsed.t), true);
    assert.deepEqual(parsed.contacts, fixture.contacts);
  }
  assert.equal(isServerMessageType('contact.update'), false);
  const source = readFileSync(new URL('./ws.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("'contacts.update': true,"));
  const module = { exports: {} as { isServerMessageType: typeof isServerMessageType } };
  runInNewContext(ts.transpileModule(source.replace("'contacts.update': true,", ''), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
  assert.throws(() => assert.equal(module.exports.isServerMessageType('contacts.update'), true), assert.AssertionError);
});

it('большая реакция распознаётся отдельным событием с адресом сообщения и автором', () => {
  // Ловит молчаливое отбрасывание эффекта новым клиентом из-за неполного whitelist.
  assert.equal(FEATURE_BIGREACT1, 'bigreact1');
  const fixture = { t: 'reaction.big', conversationId: 'dm', messageId: 'm', emoji: '🔥', userId: 'u' } satisfies GatewayServerMessage;
  assert.equal(isServerMessageType(fixture.t), true);
  assert.equal(isServerMessageType('reaction.Big'), false);
  const source = readFileSync(new URL('./ws.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("'reaction.big': true,"));
  const load = (s: string) => {
    const module = { exports: {} as { isServerMessageType: typeof isServerMessageType } };
    runInNewContext(ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
    return module.exports.isServerMessageType;
  };
  assert.equal(load(source)(fixture.t), true);
  assert.throws(() => assert.equal(load(source.replace("'reaction.big': true,", ''))(fixture.t), true), assert.AssertionError);
});
