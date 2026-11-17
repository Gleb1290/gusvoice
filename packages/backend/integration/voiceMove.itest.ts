import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { Permission as P, roomForChannel } from '@gusvoice/shared';
import { and, eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { ParticipantInfo, ParticipantInfo_State, ParticipantPermission, RoomServiceClient, TokenVerifier, TrackSource } from 'livekit-server-sdk';
import * as schema from '../src/db/schema.js';
import { serverFixture } from './botsServers.harness.js';
import { createTestDb, type TestDb } from './harness.js';

const JOIN = P.VIEW_CHANNEL | P.CONNECT;
const PUBLISH = P.SPEAK | P.VIDEO | P.SHARE_SCREEN;
const TARGET = 'private-voice';
const SOURCE = 'voice';
const PERSON = 'person';
const openEvent = { t: 'voice.move', channelId: TARGET };
type MoveFrame = { t: 'voice.move'; channelId: string; fromChannelId?: string; moveTicket?: string };
type VoiceClaims = {
  sub: string; nbf: number; exp: number; metadata: string;
  video: { room: string; roomJoin: boolean; roomAdmin?: boolean; canSubscribe: boolean;
    canPublish: boolean; canPublishData: boolean; canPublishSources?: string[] };
};

let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });

async function fixture(context: TestContext) {
  const lk = await import('../src/livekit.js');
  const { env } = await import('../src/env.js');
  const events: { userId: string; frame: MoveFrame }[] = [];
  const grants = new Map<string, { value: string; expires: number }>();
  const mutes = new Map<string, Set<string>>();
  const unexpected: string[] = [];
  const errors: string[] = [];
  let clock = 0;
  let source: ParticipantInfo | null = new ParticipantInfo({ identity: PERSON, sid: 'source-sid', state: ParticipantInfo_State.ACTIVE });

  context.mock.method(RoomServiceClient.prototype, 'getParticipant', async (room: string, identity: string) => {
    if (room === roomForChannel(SOURCE) && identity === PERSON && source) return source;
    throw new Error('participant not found');
  });
  let destination: ParticipantInfo | null = null;
  const updatedPermissions: Partial<ParticipantPermission>[] = [];
  context.mock.method(RoomServiceClient.prototype, 'listParticipants', async (room: string) => {
    assert.equal(room, roomForChannel(TARGET));
    return destination ? [destination] : [];
  });
  context.mock.method(RoomServiceClient.prototype, 'updateParticipant', async (
    room: string, identity: string, { permission }: { permission: Partial<ParticipantPermission> },
  ) => {
    assert.equal(room, roomForChannel(TARGET));
    assert.equal(identity, PERSON);
    updatedPermissions.push(permission);
    return destination!;
  });
  const roomCleanup = context.mock.method(RoomServiceClient.prototype, 'listRooms', async () => []);
  context.mock.method(globalThis, 'fetch', async () => {
    unexpected.push('fetch');
    throw new Error('Unexpected network request');
  });

  const f = await serverFixture(t, undefined, {
    real: ['routes/voice', 'voiceRules', 'voicePresence', 'coins', 'coinRules', 'streakRules', 'pokeRules', 'tipRules'],
    values: {
      livekit: lk,
      env: { env },
      realtime: {
        voiceServerMuteKey: (channel: string) => channel,
        redisPub: {
          async set(key: string, value: string, mode: string, seconds: number) {
            assert.equal(mode, 'EX');
            grants.set(key, { value, expires: clock + seconds });
            return 'OK';
          },
          async getdel(key: string) {
            const grant = grants.get(key);
            grants.delete(key);
            return grant && clock < grant.expires ? grant.value : null;
          },
          async sadd(channel: string, user: string) {
            const users = mutes.get(channel) ?? new Set<string>();
            mutes.set(channel, users);
            const added = !users.has(user);
            users.add(user);
            return Number(added);
          },
          async srem(channel: string, user: string) { return Number(mutes.get(channel)?.delete(user) ?? false); },
          async sismember(channel: string, user: string) { return Number(mutes.get(channel)?.has(user) ?? false); },
        },
        async publishToUser(userId: string, frame: MoveFrame) {
          events.push({ userId, frame: { ...frame } });
        },
      },
      transferCoins: {}, purchase: {}, shop: {},
    },
  });
  const app = Fastify();
  context.after(async () => {
    await app.close();
    await f.clean();
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  });
  app.setErrorHandler((error, _req, reply) => { errors.push(String(error)); return reply.code(500).send(); });
  await app.register(f.load('routes/voice').voiceRoutes);
  await app.ready();

  await t.db.update(schema.roles).set({
    permissions: String(JOIN | PUBLISH | P.SEND_MESSAGES | P.MUTE_MEMBERS | P.PRIORITY_SPEAKER),
  }).where(eq(schema.roles.id, 'everyone'));
  await t.db.update(schema.roles).set({ permissions: String(P.MOVE_MEMBERS) }).where(eq(schema.roles.id, 'manager-role'));
  await t.db.insert(schema.servers).values({ id: 'elsewhere', ownerId: 'owner', name: 'Другой сервер' });
  await t.db.insert(schema.channels).values([
    { id: TARGET, serverId: 'server', name: 'Закрытая комната', type: 'voice' },
    { id: 'other-private', serverId: 'server', name: 'Другая закрытая', type: 'voice' },
    { id: 'foreign-voice', serverId: 'elsewhere', name: 'Чужая', type: 'voice' },
  ]);
  const overwrite = (user: string, deny: bigint, channel = TARGET, allow = 0n) => t.db.insert(schema.channelOverwrites)
    .values({ channelId: channel, targetId: user, targetType: 'member', deny: String(deny), allow: String(allow) })
    .onConflictDoUpdate({
      target: [schema.channelOverwrites.channelId, schema.channelOverwrites.targetId],
      set: { deny: String(deny), allow: String(allow) },
    });
  await overwrite(PERSON, P.VIEW_CHANNEL);
  await overwrite(PERSON, JOIN, 'other-private');

  const post = (path: string, user: string, payload?: object) =>
    app.inject({ method: 'POST', url: path, headers: { 'x-user': user }, ...(payload ? { payload } : {}) });
  const move = (actor = 'manager', user = PERSON, target = TARGET, from = SOURCE) =>
    post('/channels/' + from + '/voice/' + user + '/move', actor, { toChannelId: target });
  const token = (ticket?: string, user = PERSON, channel = TARGET) =>
    post('/channels/' + channel + '/voice/token', user, ticket === undefined ? undefined : { moveTicket: ticket });
  async function issue() {
    const res = await move();
    assert.equal(res.statusCode, 204, res.body);
    const pushed = events.at(-1)!;
    assert.deepEqual(pushed, { userId: PERSON, frame: {
      ...openEvent, fromChannelId: SOURCE, moveTicket: pushed.frame.moveTicket,
    } });
    assert.ok(pushed.frame.moveTicket);
    return pushed.frame.moveTicket;
  }
  async function claims(token: string): Promise<VoiceClaims> {
    const verifier = new TokenVerifier(env.livekit.apiKey, env.livekit.apiSecret);
    await verifier.verify(token);
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  }
  return { events, grants, mutes, overwrite, move, token, issue, claims, post, roomCleanup, updatedPermissions,
    connectedToDestination: () => {
      destination = new ParticipantInfo({ identity: PERSON, sid: 'destination-sid', state: ParticipantInfo_State.ACTIVE });
      source = null;
    },
    advance: (seconds: number) => { clock += seconds; },
    source: (sid: string | null, state = ParticipantInfo_State.ACTIVE) => {
      source = sid ? new ParticipantInfo({ identity: PERSON, sid, state }) : null;
    },
  };
}

test('скрытый канал без билета закрыт, а разовый вход даёт говорить и показывает имя только участнику', async ctx => {
  const f = await fixture(ctx);
  f.mutes.set(SOURCE, new Set([PERSON]));
  assert.equal((await f.token()).statusCode, 403); // VIEW запрещён, CONNECT сохранён.
  const ticket = await f.issue();
  assert.equal(f.mutes.get(SOURCE)?.has(PERSON), true, 'само сообщение о переносе не снимает мьют');
  assert.equal((await f.token()).statusCode, 403, 'ожидающий билет не открывает обычный вход');

  const res = await f.token(ticket);
  assert.equal(res.statusCode, 200, res.body);
  const { token, ...response } = res.json();
  assert.deepEqual(response, { url: 'wss://livekit.invalid', room: roomForChannel(TARGET),
    temporary: true, channelName: 'Закрытая комната' });
  const claims = await f.claims(token);
  assert.equal(claims.sub, PERSON);
  assert.equal(claims.video.room, roomForChannel(TARGET));
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.video.canSubscribe, true);
  assert.equal(claims.video.canPublish, true);
  assert.deepEqual(claims.video.canPublishSources, ['microphone', 'camera', 'screen_share', 'screen_share_audio']);
  assert.equal(claims.video.canPublishData, false);
  assert.equal(claims.video.roomAdmin ?? false, false);
  assert.equal(JSON.parse(claims.metadata).priority, false);
  assert.ok(Math.abs(claims.exp - claims.nbf - 30) <= 1, 'начальный JWT живёт 30 секунд');
  assert.equal(f.mutes.get(SOURCE)?.has(PERSON), true);
  assert.equal(f.roomCleanup.mock.callCount(), 0, 'до ответа сервер не отключает старую комнату');
  assert.equal((await f.token(ticket)).statusCode, 403);

  f.source(null);
  assert.equal((await f.token()).statusCode, 403, 'после выхода или полного обрыва API не выдаёт новый JWT');
  const screen = await f.post('/channels/' + TARGET + '/voice/screen-token', PERSON);
  assert.equal(screen.statusCode, 403, 'компаньон не открывает скрытый канал отдельно от голоса');
});

test('другой участник и другой канал не могут потратить билет; из двух одновременных запросов проходит один', async ctx => {
  const f = await fixture(ctx);
  await f.overwrite('manager', P.VIEW_CHANNEL);
  const issuedAsOwner = await f.move('owner');
  assert.equal(issuedAsOwner.statusCode, 204);
  const ticket = f.events[0].frame.moveTicket!;
  assert.equal((await f.token(ticket, 'manager')).statusCode, 403);
  assert.equal((await f.token(ticket, PERSON, 'other-private')).statusCode, 403);
  const results = await Promise.all([f.token(ticket), f.token(ticket)]);
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 403]);
  assert.equal(f.grants.size, 0);
});

test('допуск сохраняет явный запрет микрофона и экрана, а серверный мьют также сильнее билета', async ctx => {
  const f = await fixture(ctx);
  await f.overwrite(PERSON, P.CONNECT | P.SPEAK | P.SHARE_SCREEN);
  const { video } = await f.claims((await f.token(await f.issue())).json().token);
  assert.deepEqual(video.canPublishSources, ['camera']);

  await f.overwrite(PERSON, P.CONNECT | P.VIDEO | P.SHARE_SCREEN);
  f.mutes.set(TARGET, new Set([PERSON]));
  const muted = await f.claims((await f.token(await f.issue())).json().token);
  assert.equal(muted.video.canPublish, false);
  f.mutes.delete(TARGET);
  const unmuted = await f.claims((await f.token(await f.issue())).json().token);
  assert.deepEqual(unmuted.video.canPublishSources, ['microphone']);

  f.connectedToDestination();
  const mute = (muted: boolean) => f.post('/channels/' + TARGET + '/voice/' + PERSON + '/mute', 'manager', { muted });
  assert.equal((await mute(true)).statusCode, 204);
  assert.equal((await mute(false)).statusCode, 204);
  const [disabled, restored] = f.updatedPermissions;
  assert.equal(disabled.canPublish, false);
  assert.deepEqual(restored.canPublishSources, [TrackSource.MICROPHONE]);
  assert.equal(restored.canPublishData, false, 'размьют не выдаёт право отправлять данные');
});

test('допуск живёт 20 секунд; выход или повторный вход в исходную комнату отменяют перенос', async ctx => {
  const f = await fixture(ctx);
  const beforeExpiry = await f.issue();
  f.advance(19);
  assert.equal((await f.token(beforeExpiry)).statusCode, 200);

  const expired = await f.issue();
  f.advance(20);
  assert.equal((await f.token(expired)).statusCode, 403);
  const left = await f.issue();
  f.source(null);
  assert.equal((await f.token(left)).statusCode, 403);
  assert.equal((await f.move()).statusCode, 400);

  f.source('new-source-sid', ParticipantInfo_State.JOINED);
  assert.equal((await f.move()).statusCode, 400, 'незавершённый вход ещё не даёт разового доступа');
  f.source('new-source-sid');
  const stale = await f.issue();
  f.source('rejoined-source-sid');
  assert.equal((await f.token(stale)).statusCode, 403);
});

test('перенос требует MOVE_MEMBERS, соблюдает иерархию и требует VIEW и CONNECT у инициатора', async ctx => {
  const f = await fixture(ctx);
  assert.equal((await f.move(PERSON, 'manager')).statusCode, 403);
  const rank = await f.move('manager', 'owner');
  assert.equal(rank.statusCode, 403);
  assert.match(rank.json().error, /роль выше/);

  for (const denied of [P.VIEW_CHANNEL, P.CONNECT]) {
    await f.overwrite('manager', denied);
    assert.equal((await f.move()).statusCode, 403);
  }
  await f.overwrite('manager', 0n);
  assert.equal((await f.move('manager', PERSON, 'foreign-voice')).statusCode, 400);
  assert.equal((await f.move('manager', PERSON, 'channel')).statusCode, 400);
  assert.equal((await f.move('manager', PERSON, TARGET, 'channel')).statusCode, 400);
  assert.deepEqual(f.events, []);
  await f.issue();
});

test('отсутствие активного членства блокирует и выдачу, и погашение билета', async ctx => {
  const f = await fixture(ctx);
  assert.equal((await f.move('manager', 'outsider')).statusCode, 400);
  const ticket = await f.issue();
  await t.db.update(schema.serverMembers).set({ state: 'closed_by_host' })
    .where(and(eq(schema.serverMembers.serverId, 'server'), eq(schema.serverMembers.userId, PERSON)));
  assert.equal((await f.move()).statusCode, 400);
  assert.equal((await f.token(ticket)).statusCode, 404);
  assert.equal(f.events.length, 1);
});

test('открытый перенос работает со старым клиентом: обычное событие, вход без тела и прежний TTL', async ctx => {
  const f = await fixture(ctx);
  await f.overwrite(PERSON, 0n);
  f.source(null);
  assert.equal((await f.move()).statusCode, 204);
  assert.deepEqual(f.events, [{ userId: PERSON, frame: openEvent }]);
  assert.equal(f.grants.size, 0);
  const res = await f.token();
  assert.equal(res.statusCode, 200, res.body);
  const result = res.json();
  assert.equal(result.temporary, undefined);
  assert.equal(result.channelName, undefined);
  assert.equal(f.roomCleanup.mock.callCount(), 1, 'для обычного входа действует прежняя очистка');
  const claims = await f.claims(result.token);
  assert.ok(Math.abs(claims.exp - claims.nbf - 4 * 3600) <= 1);
  assert.equal(claims.video.canPublishData, true);
});
