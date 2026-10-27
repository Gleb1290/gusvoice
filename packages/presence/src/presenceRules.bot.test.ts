import assert from 'node:assert/strict';
import { it } from 'node:test';
import { TrackSource } from 'livekit-server-sdk';
import { buildParticipantList, mapParticipant, type PresenceParticipant } from './presenceRules.js';

// R306: отдельный файл разрешён R307; прежний presenceRules.test.ts остаётся нетронутым.
const participant = (identity: string, patch: Partial<PresenceParticipant> = {}): PresenceParticipant =>
  ({ identity, name: identity, tracks: [], ...patch });

it('R307 строгое bot true сохраняет пользовательский identity и аватар', () => {
  // Префикс bot: вместо users.id сломал бы поиск участника и административный мут.
  const p = mapParticipant(participant('music-user', {
    metadata: '{"bot":true,"avatarUrl":"/bot.png"}',
  }), new Set());
  assert.equal(p.userId, 'music-user');
  assert.equal(p.bot, true);
  assert.equal(p.avatarUrl, '/bot.png');
});

it('R307 пустой, битый и нестрогий JSON не добавляет bot в прежний DTO человека', () => {
  // Отсутствие поля, а не bot:false, сохраняет прежнюю форму presence для людей.
  for (const metadata of [undefined, '', '{', 'null', 'true', '[]', '{}',
    '{"bot":"true"}', '{"bot":false}', '{"bot":1}']) {
    const p = mapParticipant(participant('person', { metadata }), new Set());
    assert.equal(Object.hasOwn(p, 'bot'), false, `metadata ${metadata}`);
    assert.equal(p.avatarUrl, null);
  }
});

it('R307 простой бота зависит от mic-track независимо от административного мута', () => {
  // «Ничего не играет» и запрет модератора — разные флаги, метка бота не должна теряться.
  for (const muted of [false, true]) for (const serverMuted of [false, true]) {
    const p = mapParticipant(participant('music-user', { metadata: '{"bot":true}',
      tracks: [{ source: TrackSource.MICROPHONE, muted }],
    }), new Set(serverMuted ? ['music-user'] : []));
    assert.equal(p.bot, true);
    assert.equal(p.muted, muted);
    assert.equal(p.serverMuted, serverMuted);
  }
  assert.equal(mapParticipant(participant('music-user', { metadata: '{"bot":true}' }), new Set()).muted, true);
});

it('R307 итоговый ростер сохраняет bot и прежнюю алфавитную сортировку presence', () => {
  // «Боты после людей» — клиентское правило; серверный срез остаётся детерминированным.
  const { list } = buildParticipantList([
    participant('person', { name: 'Я человек' }),
    participant('music-user', { name: 'А бот', metadata: '{"bot":true}' }),
  ], new Set());
  assert.deepEqual(list.map(p => p.userId), ['music-user', 'person']);
  assert.equal(list[0].bot, true);
  assert.equal(Object.hasOwn(list[1], 'bot'), false);
});
