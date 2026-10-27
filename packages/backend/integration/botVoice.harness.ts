import assert from 'node:assert/strict';
import { mock } from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { Permission, type VoiceParticipant } from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import { serverFixture, type Phase3Edit } from './botsServers.harness.js';
import type { TestDb } from './harness.js';

export type VoiceEdit = Phase3Edit;
export const VOICE_PERMS = Permission.VIEW_CHANNEL | Permission.CONNECT | Permission.SPEAK;
export const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
export const participant = (userId: string, bot = false): VoiceParticipant => ({
  userId, displayName: userId, avatarUrl: null, muted: false, deafened: false, serverMuted: false,
  speaking: false, screensharing: false, camera: false,
  ...(bot ? { bot: true as const } : {}),
});

/** Настоящие SQL, права, журнал и whole modules; только Redis/LiveKit/HTTP-auth/доставка — границы IO.
 * Общая Phase3-фикстура не меняется: в голосовых тестах у неё свой закрытый список дополнений.
 * Запрещённый IO записывается ДО throw: production catch не может спрятать ошибку заглушки. */
export async function voiceFixture(t: TestDb, edit?: VoiceEdit) {
  let now = 1_800_000_000_000;
  const unexpected: string[] = [], errors: string[] = [];
  const calls: { kind: string; args: unknown[] }[] = [];
  const kicks: string[] = [], socketCloses: unknown[][] = [];
  const tokens: Parameters<typeof import('../src/livekit.js').createBotVoiceToken>[0][] = [];
  const removed: { room: string; userId: string }[] = [];
  const rates: { key: string; max: number; windowS: number }[] = [];
  const rateBlocks = new Map<string, number>();
  const data = new Map<string, string>(), sets = new Map<string, Set<string>>();
  const sorted = new Map<string, Map<string, number>>(), expires = new Map<string, number>();
  const fail = (name: string) => (..._args: unknown[]): never => { unexpected.push(name); throw new Error(`R306 unexpected IO: ${name}`); };
  const prune = (key: string) => {
    if ((expires.get(key) ?? Infinity) <= now) { data.delete(key); sets.delete(key); sorted.delete(key); expires.delete(key); }
  };
  const get = (key: string) => { prune(key); return data.get(key) ?? null; };
  const operations: Record<string, (...args: any[]) => any> = {
    get,
    set(key: string, value: string, ...opts: (number | string)[]) {
      const prev = get(key);
      if (opts.includes('NX') && prev !== null) return null;
      data.set(key, value);
      const ex = opts.indexOf('EX'), px = opts.indexOf('PX');
      expires.set(key, ex >= 0 ? now + Number(opts[ex + 1]) * 1000 : px >= 0 ? now + Number(opts[px + 1]) : Infinity);
      return opts.includes('GET') ? prev : 'OK';
    },
    getdel(key: string) { const prev = get(key); data.delete(key); expires.delete(key); return prev; },
    del(key: string) { prune(key); const existed = data.has(key) || sets.has(key) || sorted.has(key); data.delete(key); sets.delete(key); sorted.delete(key); expires.delete(key); return Number(existed); },
    exists(key: string) { prune(key); return Number(data.has(key) || sets.has(key) || sorted.has(key)); },
    smembers(key: string) { prune(key); return [...(sets.get(key) ?? [])]; },
    sismember(key: string, value: string) { prune(key); return Number(sets.get(key)?.has(value) ?? false); },
    srem(key: string, value: string) { prune(key); return Number(sets.get(key)?.delete(value) ?? false); },
    zadd(key: string, score: number, value: string) { prune(key); if (!sorted.has(key)) sorted.set(key, new Map()); sorted.get(key)!.set(value, score); calls.push({ kind: 'pending', args: [key, score, value] }); return 1; },
    zrem(key: string, value: string) { prune(key); return Number(sorted.get(key)?.delete(value) ?? false); },
    zremrangebyscore(key: string, min: string | number, max: string | number) {
      prune(key); let n = 0;
      for (const [v, score] of sorted.get(key) ?? []) if (score >= Number(min === '-inf' ? -Infinity : min) && score <= Number(max === '+inf' ? Infinity : max)) { sorted.get(key)!.delete(v); n++; }
      return n;
    },
    zrangebyscore(key: string, min: string | number, max: string | number) {
      prune(key); return [...(sorted.get(key) ?? [])].filter(([, score]) => score >= Number(min === '-inf' ? -Infinity : min) && score <= Number(max === '+inf' ? Infinity : max)).sort((a, b) => a[1] - b[1]).map(([v]) => v);
    },
    expire(key: string, sec: number) { prune(key); expires.set(key, now + sec * 1000); return 1; },
    pexpire(key: string, ms: number) { prune(key); expires.set(key, now + ms); return 1; },
    incr(key: string) { const n = Number(get(key) ?? 0) + 1; data.set(key, String(n)); return n; },
    publish(channel: string, value: string) { calls.push({ kind: 'publish', args: [channel, value] }); return 1; },
  };
  function batch() {
    const queue: { method: string; args: any[] }[] = [];
    const chain: any = new Proxy({}, { get(_o, key) {
      if (key === 'exec') return async () => queue.map(({ method, args }) => [null, operations[method](...args)]);
      if (typeof key === 'string' && Object.hasOwn(operations, key)) return (...args: any[]) => { queue.push({ method: key, args }); return chain; };
      return fail(`redis batch.${String(key)}`);
    } });
    return chain;
  }
  const redis = new Proxy({}, { get(_o, key) {
    if (key === 'multi' || key === 'pipeline') return batch;
    if (typeof key === 'string' && Object.hasOwn(operations, key)) return async (...args: any[]) => operations[key](...args);
    return fail(`redis.${String(key)}`);
  } });
  const auth = async (req: FastifyRequest) => { req.user = { sub: String(req.headers['x-user'] ?? 'owner') } as NonNullable<FastifyRequest['user']>; };
  const f = await serverFixture(t, edit, {
    real: ['bots/botVoice', 'bots/botVoiceEvents', 'routes/voice', 'routes/bots', 'voiceRules', 'voicePresence',
      'coins', 'coinRules', 'streakRules', 'pokeRules', 'tipRules', 'purchase', 'shop', 'instanceSettings'],
    values: {
      auth: { requireAuth: auth, requireSuperAdmin: auth, isSuperAdmin: () => false, superAdminId: () => null, hashPassword: fail('hashPassword') },
      env: { env: { redisUrl: 'redis://unused.invalid', livekit: { urlExternal: 'wss://voice.invalid' }, economyEnabled: true, economyPreviewUsers: [], linkThreats: { enabled: false } } },
      realtime: { redisPub: redis, voiceServerMuteKey: (id: string) => `voice:mute:${id}`, streamPreviewKey: fail('preview'),
        publishToUser: async (...args: unknown[]) => { calls.push({ kind: 'user', args }); },
        publishToServer: async (...args: unknown[]) => { calls.push({ kind: 'server', args }); },
        publishToChannel: async (...args: unknown[]) => { calls.push({ kind: 'channel', args }); } },
      // Входной объект создан в VM; spread переносит его прототип в realm теста, сохраняя bigint прав.
      livekit: { createBotVoiceToken: async (q: typeof tokens[number]) => { tokens.push({ ...q }); calls.push({ kind: 'token', args: [q] }); return 'synthetic-voice-token'; },
        disconnectUser: async (room: string, userId: string) => { removed.push({ room, userId }); calls.push({ kind: 'remove', args: [room, userId] }); },
        createVoiceToken: fail('human token'), createScreenShareToken: fail('screen token'), removeFromOtherRooms: fail('other rooms'), serverMute: fail('server mute') },
      authGuard: { rateHit: async (key: string, max: number, windowS: number) => { rates.push({ key, max, windowS }); return rateBlocks.get(key) ?? 0; }, attachmentUploadBlock: fail('upload rate') },
      'bots/webhookDelivery': { kickWebhook: (id: string) => { kicks.push(id); } },
      'bots/botLifecycle': { deleteBot: fail('delete bot') },
      'routes/botApi': { closeBotSockets: (...args: unknown[]) => { socketCloses.push(args); } },
      gateway: { broadcastUserProfile: fail('profile') },
      transferCoins: { transferCoins: fail('transfer') },
    },
  });
  const clock = mock.method(Date, 'now', () => now);
  const voice: typeof import('../src/bots/botVoice.js') = f.load('bots/botVoice');
  const events: typeof import('../src/bots/botVoiceEvents.js') = f.load('bots/botVoiceEvents');
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => { errors.push(String(error)); reply.code(500).send({ error: String(error) }); });
  await app.register(f.load('routes/voice').voiceRoutes);
  await app.register(f.load('routes/bots').botRoutes);
  await app.ready();
  async function bot(id = 'bot', permissions = VOICE_PERMS, readAll = false) {
    const ctx = await f.bot(id);
    const result = await f.add(id, permissions, 'owner', readAll);
    assert.equal(result.statusCode, 201, result.body);
    await f.store.dropUpdates(id);
    return ctx;
  }
  async function channel(id: string, serverId = 'server') {
    if (serverId !== 'server') {
      await t.db.insert(schema.servers).values({ id: serverId, name: serverId, ownerId: 'owner' }).onConflictDoNothing();
      await t.db.insert(schema.roles).values({ id: `everyone-${serverId}`, serverId, name: '@everyone', isEveryone: true, permissions: '0' }).onConflictDoNothing();
    }
    await t.db.insert(schema.channels).values({ id, serverId, name: id, type: 'voice' });
  }
  async function place(botId: string, serverId: string) {
    await t.db.insert(schema.serverMembers).values({ serverId, userId: botId }).onConflictDoNothing();
    await t.db.insert(schema.serverBots).values({ serverId, botId, addedBy: 'owner' }).onConflictDoNothing();
    const roleId = `${botId}-${serverId}`;
    await t.db.insert(schema.roles).values({ id: roleId, serverId, name: roleId, permissions: String(VOICE_PERMS), managedBotId: botId });
    await t.db.insert(schema.memberRoles).values({ serverId, userId: botId, roleId });
  }
  const roster = (id: string, people: VoiceParticipant[]) => {
    data.set(`presence:ch:${id}`, JSON.stringify(people));
    if (!sets.has('presence:channels')) sets.set('presence:channels', new Set());
    if (people.length) sets.get('presence:channels')!.add(id); else sets.get('presence:channels')!.delete(id);
  };
  const deny = (botId: string, channelId: string, permissions: bigint) => t.db.insert(schema.channelOverwrites)
    .values({ channelId, targetId: botId, targetType: 'member', deny: String(permissions), allow: '0' })
    .onConflictDoUpdate({ target: [schema.channelOverwrites.channelId, schema.channelOverwrites.targetId], set: { deny: String(permissions) } });
  const settings = (value: Record<string, unknown>) => t.db.update(schema.instanceSettings).set({ value: { enabled: true, creators: 'all', perUserLimit: 100, ...value } }).where(eq(schema.instanceSettings.key, 'bots'));
  const journal = () => t.db.select().from(schema.botUpdates).orderBy(schema.botUpdates.updateId);
  async function clean() {
    try { await app.close(); await f.clean(); assert.deepEqual(unexpected, [], 'нет скрытых неожиданных IO'); assert.deepEqual(errors, [], 'маршруты не упали вместо ожидаемого ответа'); }
    finally { clock.mock.restore(); }
  }
  return { t, voice, events, app, bot, channel, place, roster, deny, settings, journal, clean, store: f.store,
    rates, rateBlocks, tokens, removed, calls, kicks, socketCloses, data, sets, sorted, expires, get,
    advance: (ms: number) => { now += ms; }, now: () => now };
}
