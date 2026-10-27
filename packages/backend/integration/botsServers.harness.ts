import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { runInNewContext } from 'node:vm';
import Fastify, { type InjectOptions, type FastifyRequest } from 'fastify';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as zod from 'zod';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as roleRules from '../src/roleRules.js';
import * as botRules from '../src/bots/botRules.js';
import * as botWire from '../src/bots/botWire.js';
import * as audienceRules from '../src/audienceRules.js';
import * as convRules from '../src/convRules.js';
import * as webhookRules from '../src/webhookRules.js';
import * as superAdminRules from '../src/superAdminRules.js';
import * as statusRules from '../src/statusRules.js';
import * as shopRules from '../src/shopRules.js';
import * as callRules from '../src/callRules.js';
import * as lastSeenRules from '../src/lastSeenRules.js';
import { truncateAll, type TestDb } from './harness.js';

export type Phase3Edit = { file: string; from: string; to: string };
export async function serverFixture(t: TestDb, edit?: Phase3Edit, extra: { real?: string[]; values?: Record<string, unknown> } = {}) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['owner', 'manager', 'person', 'outsider'].map(id => ({ id, username: id, displayName: id, passwordHash: 'synthetic-unused', verified: true })));
  await t.db.insert(schema.servers).values({ id: 'server', name: 'Сервер', ownerId: 'owner' });
  await t.db.insert(schema.serverMembers).values(['owner', 'manager', 'person'].map(userId => ({ serverId: 'server', userId })));
  await t.db.insert(schema.roles).values([
    { id: 'everyone', serverId: 'server', name: '@everyone', isEveryone: true, permissions: '0', position: 0 },
    { id: 'manager-role', serverId: 'server', name: 'Менеджер', permissions: String(shared.Permission.MANAGE_SERVER | shared.Permission.VIEW_CHANNEL | shared.Permission.SEND_MESSAGES), position: 1 },
  ]);
  await t.db.insert(schema.memberRoles).values({ serverId: 'server', userId: 'manager', roleId: 'manager-role' });
  await t.db.insert(schema.channels).values([
    { id: 'channel', serverId: 'server', name: 'общий', type: 'text' },
    { id: 'other-channel', serverId: 'server', name: 'другой', type: 'text' },
    { id: 'voice', serverId: 'server', name: 'голос', type: 'voice' },
  ]);
  await t.db.insert(schema.instanceSettings).values({ key: 'bots', value: { enabled: true, creators: 'all', perUserLimit: 100 } });
  const events: { serverId: string; channelId: string; body: any; audience: string[] }[] = [];
  const wakes: { channel: string; value: string }[] = [], warnings: string[] = [], unexpected: string[] = [];
  const uploads: { body: Buffer; mime: string; name: string }[] = [];
  const changed: import('../src/memberEvents.js').MemberChange[] = [];
  const fail = (name: string) => (..._args: unknown[]): never => { unexpected.push(name); throw new Error(`R303 unexpected IO ${name}`); };
  const noop = async () => {};
  const values: Record<string, unknown> = {
    'db/index': { db: t.db }, 'db/schema': schema, 'bots/botRules': botRules, 'bots/botWire': botWire,
    roleRules, audienceRules, convRules, webhookRules, superAdminRules, statusRules, shopRules, callRules, lastSeenRules,
    auth: { isSuperAdmin: () => false, superAdminId: () => null, requireAuth: async (req: FastifyRequest) => { req.user = { sub: String(req.headers['x-user'] ?? 'owner') } as NonNullable<FastifyRequest['user']>; } },
    guestGuard: { requireLocalUser: async () => {} },
    env: { env: { redisUrl: 'redis://unused.invalid', linkThreats: { enabled: false } } },
    audit: { writeAudit: noop }, util: { id: crypto.randomUUID },
    realtime: { publishToServer: noop, publishToChannel: async (serverId: string, channelId: string, body: unknown, audience: string[]) => {
      events.push({ serverId, channelId, body, audience: [...audience] });
    }, redisPub: { publish: async (channel: string, value: string) => { wakes.push({ channel, value }); return 1; } } },
    authGuard: { rateHit: async () => 0, attachmentUploadBlock: async () => 0, pushDebounced: async () => false },
    // Доставка и адресаты пушей — отдельная граница; тесты ниже проверяют сохранённый mentionEveryone, не доставку пуша.
    push: { resolveRoleMentions: async () => [], resolveMentionedMembers: async () => [], contentPreview: () => '', sendPushToUsers: fail('push') },
    linkThreats: { dangerousLinksOf: () => [] },
    'federation/instanceLabels': { instanceLabel: () => ({ domain: 'neighbor.invalid' }) },
    'federation/guestMembership': { announceMembership: noop },
    storage: { attachmentBlocked: () => false, isOwnMediaUrl: () => false, storageConfigured: () => true,
      putAttachment: async (_id: string, body: Buffer, mime: string, name: string) => { uploads.push({ body, mime, name }); return `https://example.invalid/public/${name}`; } },
    'bots/webhookDelivery': { kickWebhook: () => {} },
  };
  Object.assign(values, extra.values);
  const real = new Set(['routes/serverBots', 'serverMembership', 'memberEvents', 'permissions', 'bots/botStore', 'bots/botChannel', 'channelMessages', 'channelEvents', 'serialize', ...(extra.real ?? [])]);
  const modules = new Map<string, any>();
  const externals: Record<string, unknown> = { '@gusvoice/shared': shared, 'drizzle-orm': orm, 'node:crypto': crypto, zod,
    ioredis: class { constructor() { fail('Redis connection')(); } } };
  function load(name: string): any {
    if (Object.hasOwn(values, name)) return values[name];
    if (modules.has(name)) return modules.get(name);
    assert.ok(real.has(name), `описан целый модуль ${name}`);
    let raw = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
    if (edit?.file === name) { assert.equal(raw.split(edit.from).length - 1, 1, 'R303 единственный якорь'); raw = raw.replace(edit.from, edit.to); }
    const module = { exports: {} }; modules.set(name, module.exports);
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
      { module, exports: module.exports, Buffer, URL, URLSearchParams, AbortController, Date, Map, Set, Promise, Error,
        console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
        setTimeout: fail('timer'), clearTimeout: fail('clear timer'),
        require(id: string) {
          if (id.startsWith('.')) return load(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
          assert.ok(Object.hasOwn(externals, id), `описан импорт ${id}`); return externals[id];
        } });
    modules.set(name, module.exports); return module.exports;
  }
  const store: typeof import('../src/bots/botStore.js') = load('bots/botStore');
  const channel: typeof import('../src/bots/botChannel.js') = load('bots/botChannel');
  const members: typeof import('../src/serverMembership.js') = load('serverMembership');
  const memberEvents: typeof import('../src/memberEvents.js') = load('memberEvents');
  memberEvents.configureMemberBots({ changed: async c => { changed.push(c); } });
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => {
    const e = error as { statusCode?: number; message?: string };
    reply.code(e.statusCode ?? 500).send({ error: e.message ?? String(error) });
  });
  await app.register(load('routes/serverBots').serverBotRoutes); await app.ready();
  async function bot(id = 'bot', options: { ownerId?: string; public?: boolean } = {}) {
    await t.db.insert(schema.users).values({ id, username: `${id}bot`, displayName: id, passwordHash: 'synthetic-unused', bot: true, verified: true });
    await t.db.insert(schema.bots).values({ userId: id, ownerId: options.ownerId ?? 'owner', public: options.public ?? true, tokenHash: crypto.createHash('sha256').update(`synthetic-${id}`).digest('hex') });
    return (await store.botById(id))!;
  }
  const add = (botId: string, permissions = shared.Permission.VIEW_CHANNEL | shared.Permission.SEND_MESSAGES | shared.Permission.READ_HISTORY, actor = 'owner', readAll = false) =>
    app.inject({ method: 'POST', url: '/servers/server/bots', headers: { 'x-user': actor }, payload: { botId, permissions: String(permissions), readAll } });
  const request = (options: InjectOptions, actor = 'owner') => app.inject({ ...options, headers: { ...options.headers, 'x-user': actor } });
  const clean = async () => { await app.close(); assert.deepEqual(unexpected, []); assert.deepEqual(warnings, []); };
  return { t, app, store, channel, members, memberEvents, bot, add, request, clean, events, wakes, uploads, changed, load };
}
