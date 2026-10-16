import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Fastify, { type InjectOptions } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as authRules from '../src/authRules.js';
import * as superAdminRules from '../src/superAdminRules.js';
import * as convRules from '../src/convRules.js';
import * as groupRules from '../src/groupRules.js';
import * as dmRules from '../src/dmRules.js';
import * as setupRules from '../src/setupRules.js';
import * as userSearchRules from '../src/userSearchRules.js';
import * as guestGuardCore from '../src/guestGuardCore.js';
import * as attachmentRules from '../src/attachmentRules.js';
import * as storageRules from '../src/storageRules.js';
import * as pushRules from '../src/pushRules.js';
import * as guestRules from '../src/federation/guestRules.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as linkService from '../src/federation/linkService.js';
import * as syncCore from '../src/federation/directorySyncCore.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
type Mutations = { fed?: readonly Mutation[]; route?: readonly Mutation[]; group?: readonly Mutation[] };
const self = 'a'.repeat(32), peer = 'b'.repeat(32), third = 'c'.repeat(32), unsupported = 'd'.repeat(32);
const own = 'group-owned', foreign = 'group-foreign', now = Date.now();
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t.close(); });
const raw = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const forbidden = (name: string) => () => { throw new Error(`неописанная граница ${name}`); };

/** VM грузит целый production module. Настоящие Drizzle/SQL, правила и криптография остаются внутри. */
function moduleOf<T>(name: string, explicit: Record<string, unknown>, mutations: readonly Mutation[] = []): T {
  let source = raw(name);
  for (const [from, to] of mutations) {
    assert.equal(source.split(from).length - 1, 1, `единственный якорь ${name}: ${from}`);
    source = source.replace(from, to);
  }
  const dependencies: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly) continue;
    const id = (n.moduleSpecifier as ts.StringLiteral).text;
    const exports: Record<string, unknown> = {};
    const names = n.importClause?.namedBindings;
    if (names && ts.isNamedImports(names)) for (const item of names.elements) {
      if (!item.isTypeOnly) exports[item.propertyName?.text ?? item.name.text] = forbidden(`${id}.${item.name.text}`);
    }
    dependencies[id] = exports;
  }
  Object.assign(dependencies, explicit);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, crypto,
    console: { warn: () => {} }, setTimeout: forbidden('таймер'), setInterval: forbidden('worker'),
    require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `явный импорт ${name}:${id}`); return dependencies[id]; },
  });
  return module.exports as T;
}

async function fixture(mutations: Mutations = {}) {
  await truncateAll(t.raw);
  const localPeople = ['local', 'member', 'candidate', 'fourth', 'fifth', 'unreachable'];
  await t.db.insert(schema.users).values([
    ...localPeople.map(id => ({ id, username: `groups_${id}`, displayName: id, passwordHash: 'fixture',
      verified: id !== 'unreachable', approvedAt: new Date(now) })),
    ...[
      ['shadow', peer, 'actor'], ['shadow2', peer, 'second'], ['outsider', peer, 'outsider'],
      ['third-shadow', third, 'third-person'], ['unsupported-shadow', unsupported, 'unsupported-person'],
    ].map(([id, homeInstanceId, homeUserId]) => ({ id, username: `groups_${id}`, displayName: id, passwordHash: 'fixture', verified: true,
      approvedAt: new Date(now), homeInstanceId, homeUserId, homeUsername: `remote_${homeUserId}` })),
  ]);
  await t.db.insert(schema.federationLinks).values([peer, third, unsupported].map(instanceId => ({ instanceId,
    domain: `${instanceId[0]}-groups.invalid`, apiBase: `https://${instanceId[0]}-groups.invalid`, clientOrigin: `https://${instanceId[0]}-groups.invalid`,
    rootKey: 'fixture-public-key', state: 'active', features: [shared.FED_FEATURES.guests,
      ...(instanceId === unsupported ? [] : [shared.FED_FEATURES.dmgroup1])] })));
  await t.db.insert(schema.conversations).values([
    { id: own, kind: 'group', title: 'Наша', createdBy: 'local', groupVersion: 7 },
    { id: foreign, kind: 'group', title: 'Чужая', createdBy: 'local', originInstanceId: peer, groupVersion: 7 },
  ]);
  await t.db.insert(schema.conversationMembers).values([own, foreign].flatMap(conversationId => [
    { conversationId, userId: 'local', role: 'owner' as const },
    { conversationId, userId: 'member', role: 'member' as const },
    { conversationId, userId: 'shadow', role: 'member' as const },
  ]));
  const events: Array<{ userId: string; event: shared.GatewayServerMessage; cap: string }> = [];
  const requests: Array<Parameters<typeof import('../src/federation/peerClient.js').postSignedToPeer>[0]> = [];
  const ops: Array<{ me: string; conversationId: string; host: string; op: shared.FedGroupOp; args: Record<string, unknown> }> = [];
  const media: Array<{ prefix: string; id: string; body: Buffer; mime: string }> = [];
  const pushes: Array<{ ids: string[]; payload: unknown }> = [];
  const io = { paused: false, response: { status: 200, body: JSON.stringify({ ok: true, hostMarker: 'accepted' }) } };
  const common = { '@gusvoice/shared': shared, 'drizzle-orm': orm };
  const backend = { ...common, './db/index.js': { db: t.db }, './db/schema.js': schema };
  const fed = { ...common, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const env = { jwtSecret: 'not-a-secret-group-routes-fixture', publicApiUrl: 'https://self.invalid' };
  const auth = moduleOf<typeof import('../src/auth.js')>('auth', {
    ...backend, bcryptjs: bcrypt, jsonwebtoken: jwt, './authRules.js': authRules, './superAdminRules.js': superAdminRules, './env.js': { env },
  });
  const key = crypto.generateKeyPairSync('ed25519');
  const federation = { identity: () => ({ instanceId: self }),
    signingKey: () => ({ kid: 'groups-fixture-kid', privateKeyDer: key.privateKey.export({ format: 'der', type: 'pkcs8' }) }) };
  const meta = { readInstanceMeta: async () => ({ paused: io.paused, name: 'Группы фикстуры' }) };
  const links = moduleOf<typeof import('../src/federation/links.js')>('federation/links', {
    ...fed, 'node:crypto': crypto, './linkService.js': linkService, './instance.js': { federation },
    './outbox.js': { queueDepth: async () => 0 }, './instanceMeta.js': meta,
  });
  const labels = moduleOf<typeof import('../src/federation/instanceLabels.js')>('federation/instanceLabels', {
    ...common, './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta,
  });
  await labels.refreshInstanceLabels();
  const threats = moduleOf<typeof import('../src/linkThreats.js')>('linkThreats', { './env.js': { env: { linkThreats: { enabled: false } } } });
  const serializer = moduleOf<typeof import('../src/serialize.js')>('serialize', {
    ...common, './federation/instanceLabels.js': labels, './linkThreats.js': threats,
  });
  const changes = moduleOf<typeof import('../src/federation/convChanges.js')>('federation/convChanges', fed);
  const c = moduleOf<typeof import('../src/conversations.js')>('conversations', {
    ...backend, './convRules.js': convRules, './serialize.js': serializer, './dmWriteBarrier.js': { dmWriteBarrier: {} },
    './util.js': { uuidv7: crypto.randomUUID }, './env.js': { env },
    './attachments.js': { privateAttachmentsReady: () => true, attachmentLink: forbidden('ссылка файла'), purgeDeleted: forbidden('удаление файла') },
    './realtime.js': { publishToUser: async (userId: string, event: shared.GatewayServerMessage, options: { cap: string }) => {
      events.push({ userId, event, cap: options.cap });
    } },
  });
  c.configureFederatedConv({ selfInstanceId: () => self, record: (tx, items) => changes.recordFedConvChanges(tx, items) });
  const uploads = moduleOf<typeof import('../src/bigUploads.js')>('bigUploads', {
    ...backend, './attachmentRules.js': attachmentRules, './util.js': { uuidv7: crypto.randomUUID },
  });
  const localGroups = moduleOf<typeof import('../src/convGroups.js')>('convGroups', {
    ...backend, './conversations.js': c, './bigUploads.js': uploads, './groupRules.js': groupRules, './util.js': { uuidv7: crypto.randomUUID },
  }, mutations.group);
  const guests = moduleOf<typeof import('../src/federation/guestHost.js')>('federation/guestHost', {
    ...fed, 'node:crypto': crypto, '../auth.js': auth, '../authRules.js': authRules, './guestRules.js': guestRules,
    './instance.js': { federation }, './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta,
    './avatars.js': { refreshGuestAvatar: async () => {} },
  });
  // Никакого fake refreshCapabilities: только транспорт визитки недоступен, настоящий модуль решает fallback по признакам.
  const directory = moduleOf<typeof import('../src/federation/directorySync.js')>('federation/directorySync', {
    ...fed, './instance.js': { federation }, './instanceMeta.js': meta, './links.js': links, './directorySyncCore.js': syncCore,
    './peerClient.js': { fetchPeerDocument: async () => ({ ok: false, problem: 'unreachable' }) },
  });
  const groups = moduleOf<typeof import('../src/federation/convGroup.js')>('federation/convGroup', {
    ...fed, 'node:crypto': crypto, '../conversations.js': c, '../convGroups.js': localGroups,
    '../groupRules.js': groupRules, '../userSearchRules.js': userSearchRules, './guestHost.js': guests,
    './instance.js': { federation }, './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta, './directorySync.js': directory,
    './peerClient.js': { postSignedToPeer: async (input: typeof requests[number]) => { requests.push(input); return { ok: true, value: io.response }; } },
  }, mutations.fed);
  const settings = moduleOf<typeof import('../src/instanceSetup.js')>('instanceSetup', {
    ...backend, './auth.js': auth, './dmRules.js': dmRules, './setupRules.js': setupRules, './env.js': { env },
  });
  await settings.setDmPolicy('anyone');
  const blocks = moduleOf<typeof import('../src/blocks.js')>('blocks', backend);
  const queries = moduleOf<typeof import('../src/db/peerQueries.js')>('db/peerQueries', { ...common, './index.js': { db: t.db } });
  const guard = moduleOf<typeof import('../src/guestGuard.js')>('guestGuard', { ...backend, './guestGuardCore.js': guestGuardCore });
  const redisCounts = new Map<string, number>();
  const authGuard = moduleOf<typeof import('../src/authGuard.js')>('authGuard', {
    ...common, './authRules.js': authRules, './pushRules.js': pushRules,
    './realtime.js': { redisPub: { incr: async (k: string) => { const n = (redisCounts.get(k) ?? 0) + 1; redisCounts.set(k, n); return n; },
      expire: async () => 1, ttl: async () => 10 } },
  });
  const route = moduleOf<typeof import('../src/routes/convGroups.js')>('routes/convGroups', {
    ...fed, zod: { z }, '../auth.js': auth, '../authGuard.js': authGuard, '../blocks.js': blocks,
    '../convGroups.js': localGroups, '../conversations.js': c, '../db/peerQueries.js': queries,
    '../dmRules.js': dmRules, '../groupRules.js': groupRules, '../guestGuard.js': guard, '../instanceSetup.js': settings,
    '../superAdminRules.js': superAdminRules, '../userSearchRules.js': userSearchRules,
    '../push.js': { sendPushToUsers: async (ids: string[], payload: unknown) => { pushes.push({ ids, payload }); } },
    '../storage.js': { isSupportedImage: storageRules.isSupportedImage, putMedia: async (prefix: string, id: string, body: Buffer, mime: string) => {
      media.push({ prefix, id, body, mime }); return `https://self.invalid/groups/${id}.png`;
    } },
  }, mutations.route);
  const hooks: import('../src/routes/convGroups.js').FedGroupHooks = { invitable: groups.groupInvitableHome,
    op: async (me, conversationId, host, op, args) => {
      ops.push({ me, conversationId, host, op, args }); return groups.groupOpRemote(me, conversationId, host, op, args);
    } };
  route.configureFedGroups(hooks);
  return { groups, route, auth, localGroups, hooks, events, requests, ops, media, pushes, io };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function appFor(f: Fixture) { const app = Fastify(); await app.register(multipart); await app.register(f.route.convGroupRoutes); await app.ready(); return app; }
function headers(f: Fixture, me = 'local') { return { authorization: `Bearer ${f.auth.signToken({ sub: me, username: `groups_${me}`, gen: 0 })}` }; }
async function conv(id = own) { return (await t.db.select().from(schema.conversations).where(orm.eq(schema.conversations.id, id)))[0]; }
async function members(id = own) { return t.db.select().from(schema.conversationMembers).where(orm.eq(schema.conversationMembers.conversationId, id)).orderBy(orm.asc(schema.conversationMembers.userId)); }
async function messages(id = own) { return t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.conversationId, id)).orderBy(orm.asc(schema.conversationMessages.sortKey)); }
function serviceType(row: typeof schema.conversationMessages.$inferSelect) { assert.equal(row.service?.kind, 'group'); assert.ok(row.service?.kind === 'group'); return row.service.type; }
async function snapshot(id = own) {
  return JSON.stringify({ conv: await conv(id), members: await members(id), messages: await messages(id),
    journal: await t.db.select().from(schema.userChanges), fed: await t.db.select().from(schema.fedConvChanges) });
}
function assertion(label: string) { return (err: unknown) => err instanceof assert.AssertionError && err.message.includes(label); }
function opBody(op: shared.FedGroupOp, options: { id?: string; actor?: string; target?: shared.FedPersonRef; people?: shared.FedGroupProfile[]; title?: string } = {}) {
  return shared.serializeGroupOp({ instanceId: peer, conversationId: options.id ?? own, actorUserId: options.actor ?? 'actor', op,
    target: options.target ?? null, users: options.people ?? [], title: options.title ?? null });
}
function profile(instanceId: string, userId: string): shared.FedGroupProfile { return { ref: { instanceId, userId }, username: `invite_${userId}`, displayName: userId, avatarHash: null }; }
const requestsOf = [
  { name: 'выход POST', op: 'leave', request: (id: string): InjectOptions => ({ method: 'POST', url: `/conv/${id}/leave` }), args: {}, people: [] },
  { name: 'выход DELETE себя', op: 'leave', request: (id: string): InjectOptions => ({ method: 'DELETE', url: `/conv/${id}/members/local` }), args: { targetId: 'local' }, people: [] },
  { name: 'удаление', op: 'remove', request: (id: string): InjectOptions => ({ method: 'DELETE', url: `/conv/${id}/members/shadow` }), args: { targetId: 'shadow' }, people: [] },
  { name: 'добавление', op: 'add', request: (id: string): InjectOptions => ({ method: 'POST', url: `/conv/${id}/members`, payload: { userIds: ['candidate', 'candidate', 'local'] } }), args: { userIds: ['candidate'] }, people: [profile(self, 'candidate')] },
  { name: 'название', op: 'title', request: (id: string): InjectOptions => ({ method: 'PATCH', url: `/conv/${id}/group`, payload: { title: '  Новое   название ' } }), args: { title: 'Новое название' }, people: [] },
] as const;

for (const scene of requestsOf) it(`R203 ${scene.name} чужой группы идёт хосту, без hooks — down; у своего хоста меняет SQL`, async () => {
  const f = await fixture(); const app = await appFor(f);
  try {
    const before = await snapshot(foreign);
    f.route.configureFedGroups(null);
    const down = await app.inject({ ...scene.request(foreign), headers: headers(f) });
    assert.equal(down.statusCode, 403); assert.deepEqual(down.json(), { error: shared.FED_ERRORS.dmGroupHostDown });
    assert.equal(await snapshot(foreign), before); assert.equal(f.requests.length, 0);
    f.route.configureFedGroups(f.hooks);
    const accepted = await app.inject({ ...scene.request(foreign), headers: headers(f) });
    assert.equal(accepted.statusCode, 200); assert.deepEqual(accepted.json(), { ok: true, pending: true }, 'чужая операция ожидает снимок хоста');
    assert.equal(await snapshot(foreign), before); assert.equal(f.events.length, 0); assert.equal(f.requests.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.ops)), [{ me: 'local', conversationId: foreign, host: peer, op: scene.op, args: scene.args }]);
    const request = f.requests[0]; assert.equal(request.apiBase, 'https://b-groups.invalid'); assert.equal(request.path, `/api${shared.FED_GROUP_OP_PATH}`);
    assert.equal(request.keyid, 'groups-fixture-kid'); assert.deepEqual([...request.allowHosts], ['b-groups.invalid']);
    const parsed = shared.parseGroupOp(request.payload); assert.ok(parsed); assert.equal(parsed.instanceId, self); assert.equal(parsed.actorUserId, 'local');
    assert.equal(parsed.conversationId, foreign); assert.equal(parsed.op, scene.op);
    assert.deepEqual(parsed.target, scene.op === 'remove' ? { instanceId: peer, userId: 'actor' } : null);
    assert.deepEqual(parsed.users.map(p => p.ref), scene.op === 'add' ? [{ instanceId: self, userId: 'candidate' }] : []);
    assert.equal(parsed.title, scene.op === 'title' ? 'Новое название' : null);
    const localRes = await app.inject({ ...scene.request(own), headers: headers(f) });
    assert.equal(localRes.statusCode, 200); assert.equal(Object.hasOwn(localRes.json(), 'pending'), false);
    assert.equal(f.requests.length, 1); assert.equal((await conv()).groupVersion, 8);
    const m = (await messages())[0]; assert.equal(m.authorId, 'local'); assert.equal(serviceType(m), scene.op);
    if (scene.op === 'leave' || scene.op === 'remove') assert.ok((await members()).find(p => p.userId === (scene.op === 'leave' ? 'local' : 'shadow'))?.leftAt);
    else if (scene.op === 'add') assert.equal((await members()).find(p => p.userId === 'candidate')?.leftAt, null);
    else assert.equal((await conv()).title, 'Новое название');
    assert.equal(f.events.length, 3 + (scene.op === 'add' ? 1 : 0));
  } finally { await app.close(); }
});

async function routing(mutations: Mutations = {}) {
  const f = await fixture(mutations), app = await appFor(f);
  try {
    const res = await app.inject({ method: 'PATCH', url: `/conv/${foreign}/group`, headers: headers(f), payload: { title: 'Маршрут' } });
    assert.equal(res.statusCode, 200); assert.deepEqual(res.json(), { ok: true, pending: true }, 'чужая операция ожидает снимок хоста');
    assert.equal((await conv(foreign)).title, 'Чужая'); assert.equal(f.requests.length, 1);
  } finally { await app.close(); }
}
it('R203 удаление groupHostOf обнаруживается HTTP-ответом и записью не на том доме', async () => {
  await routing();
  await assert.rejects(routing({ route: [["return c?.kind === 'group' && c.origin ? c.origin : null;", 'return null;']] }),
    assertion('чужая операция ожидает снимок хоста'));
});

function photoPayload() {
  const boundary = 'group-fixture-boundary', png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  return { png, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="group.png"\r\nContent-Type: image/png\r\n\r\n`), png,
      Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}
it('R203 фото чужой группы — host_only до хранения; тот же PNG местной группы сохраняется', async () => {
  const f = await fixture(), app = await appFor(f), file = photoPayload();
  try {
    const before = await snapshot(foreign);
    const refused = await app.inject({ method: 'POST', url: `/conv/${foreign}/group/photo`, headers: { ...headers(f), ...file.headers }, payload: file.payload });
    assert.equal(refused.statusCode, 403); assert.deepEqual(refused.json(), { error: shared.FED_ERRORS.dmGroupHostOnly });
    assert.equal(f.media.length, 0); assert.equal(f.requests.length, 0); assert.equal(await snapshot(foreign), before);
    const accepted = await app.inject({ method: 'POST', url: `/conv/${own}/group/photo`, headers: { ...headers(f), ...file.headers }, payload: file.payload });
    assert.equal(accepted.statusCode, 200); assert.equal(f.media.length, 1); assert.equal(f.media[0].prefix, 'group-avatars');
    assert.equal(f.media[0].id, own); assert.equal(f.media[0].mime, 'image/png'); assert.equal(f.media[0].body.equals(file.png), true);
    assert.equal((await conv()).avatarUrl, `https://self.invalid/groups/${own}.png`); assert.equal(serviceType((await messages())[0]), 'photo');
    assert.equal((await conv()).groupVersion, 8); assert.equal(f.events.length, 3);
  } finally { await app.close(); }
});

async function invitable(mutations: Mutations = {}) {
  const f = await fixture(mutations), app = await appFor(f);
  try {
    for (const hooks of [null, f.hooks]) {
      f.route.configureFedGroups(hooks);
      const before = await snapshot();
      const res = await app.inject({ method: 'POST', url: `/conv/${own}/members`, headers: headers(f), payload: { userIds: ['unsupported-shadow'] } });
      assert.equal(res.statusCode, 403, 'тень без invitable не попадает в местную группу');
      assert.deepEqual(res.json(), { error: 'group_not_invitable', userIds: ['unsupported-shadow'] }); assert.equal(await snapshot(), before);
    }
    f.route.configureFedGroups(f.hooks);
    const accepted = await app.inject({ method: 'POST', url: `/conv/${own}/members`, headers: headers(f), payload: { userIds: ['shadow2'] } });
    assert.equal(accepted.statusCode, 200); assert.equal((await members()).find(p => p.userId === 'shadow2')?.leftAt, null);
    assert.equal(serviceType((await messages())[0]), 'add'); assert.equal((await conv()).groupVersion, 8);
  } finally { await app.close(); }
}
it('R203 тень без invitable не приглашается, с dmgroup1 приглашается; снятый gate краснеет на 403', async () => {
  await invitable();
  await assert.rejects(invitable({ route: [['if (!fedGroups || !(await fedGroups.invitable(u.homeInstanceId))) out.push(id);', 'if (false) out.push(id);']] }),
    assertion('тень без invitable не попадает в местную группу'));
});

it('R203 создание смешанной группы принимает 5 вместе с владельцем, 6 отклоняет до SQL, без invitable — 403', async () => {
  const f = await fixture(), app = await appFor(f);
  try {
    const before = await snapshot();
    const forbiddenInvite = await app.inject({ method: 'POST', url: '/conv/group', headers: headers(f), payload: { title: 'Новая', userIds: ['unsupported-shadow'] } });
    assert.equal(forbiddenInvite.statusCode, 403); assert.deepEqual(forbiddenInvite.json(), { error: 'group_not_invitable', userIds: ['unsupported-shadow'] });
    const over = await app.inject({ method: 'POST', url: '/conv/group', headers: headers(f), payload: { title: 'Новая', userIds: ['member', 'candidate', 'shadow', 'shadow2', 'third-shadow'] } });
    assert.equal(over.statusCode, 409); assert.deepEqual(over.json(), { error: 'group_too_many', limit: 5 }); assert.equal(await snapshot(), before);
    const accepted = await app.inject({ method: 'POST', url: '/conv/group', headers: headers(f), payload: { title: 'Новая', userIds: ['member', 'shadow', 'shadow2', 'third-shadow'] } });
    assert.equal(accepted.statusCode, 201); const id = accepted.json().id;
    assert.deepEqual((await members(id)).map(p => p.userId), ['local', 'member', 'shadow', 'shadow2', 'third-shadow']);
    assert.equal((await members(id)).find(p => p.userId === 'local')?.role, 'owner'); assert.equal((await conv(id)).originInstanceId, null);
    assert.equal((await conv(id)).groupVersion, 1); assert.equal(serviceType((await messages(id))[0]), 'create'); assert.equal(f.events.length, 5);
  } finally { await app.close(); }
});

it('R203 HTTP сохраняет отказ хоста как есть, серверная ошибка становится host_down и ничего не меняет', async () => {
  const f = await fixture(), app = await appFor(f);
  try {
    const before = await snapshot(foreign);
    for (const status of [403, 404, 409]) {
      f.io.response = { status, body: JSON.stringify({ error: `host-${status}`, marker: 9 }) };
      const res = await app.inject({ method: 'POST', url: `/conv/${foreign}/leave`, headers: headers(f) });
      assert.equal(res.statusCode, status); assert.deepEqual(res.json(), { error: `host-${status}`, marker: 9 });
    }
    f.io.response = { status: 503, body: '{}' };
    const down = await app.inject({ method: 'POST', url: `/conv/${foreign}/leave`, headers: headers(f) });
    assert.equal(down.statusCode, 403); assert.deepEqual(down.json(), { error: shared.FED_ERRORS.dmGroupHostDown });
    assert.equal(await snapshot(foreign), before); assert.equal(f.events.length, 0);
    f.io.response = { status: 200, body: '{"ok":true}' };
    assert.deepEqual((await app.inject({ method: 'POST', url: `/conv/${foreign}/leave`, headers: headers(f) })).json(), { ok: true, pending: true });
  } finally { await app.close(); }
});

async function originGuard(mutations: Mutations = {}) {
  const f = await fixture(mutations); const before = await snapshot(foreign);
  const res = await f.groups.acceptGroupOp({ instanceId: peer }, opBody('title', { id: foreign, title: 'Чужой запрос' }));
  assert.equal(res.status, 404, 'операции хоста не изменяют копию чужой группы');
  assert.deepEqual(JSON.parse(JSON.stringify(res.body)), { error: 'not found' }); assert.equal(await snapshot(foreign), before); assert.equal(f.events.length, 0);
  const accepted = await f.groups.acceptGroupOp({ instanceId: peer }, opBody('title', { title: 'Наш запрос' }));
  assert.equal(accepted.status, 200); assert.equal((await conv()).title, 'Наш запрос'); assert.equal((await conv()).groupVersion, 8);
  assert.equal((await messages())[0].authorId, 'shadow'); assert.equal(serviceType((await messages())[0]), 'title'); assert.equal(f.events.length, 3);
}
it('R203 acceptGroupOp отклоняет foreign origin с 404, местную группу меняет; снятый origin gate обнаруживается', async () => {
  await originGuard();
  await assert.rejects(originGuard({ fed: [["if (!c || c.kind !== 'group' || c.origin) return { status: 404, body: { error: 'not found' } };",
    "if (!c || c.kind !== 'group') return { status: 404, body: { error: 'not found' } };"]] }), assertion('операции хоста не изменяют копию чужой группы'));
});

async function memberGuard(mutations: Mutations = {}) {
  const f = await fixture(mutations), before = await snapshot();
  const res = await f.groups.acceptGroupOp({ instanceId: peer }, opBody('title', { actor: 'outsider', title: 'Не участник' }));
  assert.equal(res.status, 404, 'действующий не участник получает 404');
  assert.deepEqual(JSON.parse(JSON.stringify(res.body)), { error: 'not found' }); assert.equal(await snapshot(), before);
  const accepted = await f.groups.acceptGroupOp({ instanceId: peer }, opBody('title', { title: 'Участник' }));
  assert.equal(accepted.status, 200); assert.equal((await conv()).title, 'Участник'); assert.equal((await messages())[0].authorId, 'shadow');
}
it('R203 acceptGroupOp не участнику даёт 404, участнику 200; снятие membership guard меняет чужое название', async () => {
  await memberGuard();
  await assert.rejects(memberGuard({ group: [["if (!active.includes(me)) return { kind: 'not-found' };\n    const [cur] = await tx",
    'const [cur] = await tx']] }), assertion('действующий не участник получает 404'));
});

it('R203 acceptGroupOp не оживляет ушедшего или неизвестного актёра; тот же действующий принимается', async () => {
  const f = await fixture();
  await t.db.update(schema.conversationMembers).set({ leftAt: new Date(now - 1_000) })
    .where(orm.and(orm.eq(schema.conversationMembers.conversationId, own), orm.eq(schema.conversationMembers.userId, 'shadow')));
  const before = await snapshot();
  for (const actor of ['actor', 'missing']) {
    const refused = await f.groups.acceptGroupOp({ instanceId: peer }, opBody('title', { actor, title: 'Поздний запрос' }));
    assert.equal(refused.status, 404); assert.equal(await snapshot(), before);
  }
  await t.db.update(schema.conversationMembers).set({ leftAt: null })
    .where(orm.and(orm.eq(schema.conversationMembers.conversationId, own), orm.eq(schema.conversationMembers.userId, 'shadow')));
  assert.equal((await f.groups.acceptGroupOp({ instanceId: peer }, opBody('title', { title: 'Вернулся' }))).status, 200);
  assert.equal((await conv()).title, 'Вернулся');
});

it('R203 acceptGroupOp add неприглашаемому дому и недоступному своему — 403 без SQL, рабочей тени — 200', async () => {
  const f = await fixture();
  const before = await snapshot();
  for (const person of [profile(unsupported, 'unsupported-person'), profile(self, 'unreachable')]) {
    const res = await f.groups.acceptGroupOp({ instanceId: peer }, opBody('add', { people: [person] }));
    assert.equal(res.status, 403); assert.deepEqual(JSON.parse(JSON.stringify(res.body)), { error: 'group_not_invitable' }); assert.equal(await snapshot(), before);
  }
  const accepted = await f.groups.acceptGroupOp({ instanceId: peer }, opBody('add', { people: [profile(third, 'third-person')] }));
  assert.equal(accepted.status, 200); assert.equal((await members()).find(p => p.userId === 'third-shadow')?.leftAt, null);
  assert.equal((await messages())[0].authorId, 'shadow'); assert.equal(serviceType((await messages())[0]), 'add'); assert.equal(f.events.length, 4);
});

async function limit(mutations: Mutations = {}) {
  const f = await fixture(mutations);
  const accepted = await f.groups.acceptGroupOp({ instanceId: peer }, opBody('add', { people: [profile(peer, 'second'), profile(self, 'candidate')] }));
  assert.equal(accepted.status, 200); assert.deepEqual((await members()).filter(p => !p.leftAt).map(p => p.userId), ['candidate', 'local', 'member', 'shadow', 'shadow2']);
  assert.equal((await messages()).length, 1); assert.equal(f.events.length, 5);
  const before = await snapshot();
  const over = await f.groups.acceptGroupOp({ instanceId: peer }, opBody('add', { people: [profile(third, 'third-person')] }));
  assert.equal(over.status, 409, 'шестой участник отклонён с учётом теневых');
  assert.deepEqual(JSON.parse(JSON.stringify(over.body)), { error: 'group_too_many', limit: 5 }); assert.equal(await snapshot(), before); assert.equal(f.events.length, 5);
}
it('R203 acceptGroupOp предел 5 включает теневые строки: пятый проходит, шестой не пишет служебную запись', async () => { await limit(); });
it('R203 подсчёт только местных вместо всех участников обнаруживается разрешённым шестым, не loader', async () => {
  await limit();
  await assert.rejects(limit({ group: [['const verdict = groupAddCheck(active.length, adding.length);',
    'const localOnly = await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, active), isNull(users.homeInstanceId)));\n    const verdict = groupAddCheck(localOnly.length, adding.length);']] }),
    assertion('шестой участник отклонён с учётом теневых'));
});

it('R203 acceptGroupOp remove чужого участника разрешён владельцу, обычному 403; leave разрешён самому', async () => {
  const f = await fixture();
  const before = await snapshot();
  const request = opBody('remove', { target: { instanceId: self, userId: 'member' } });
  const refused = await f.groups.acceptGroupOp({ instanceId: peer }, request);
  assert.equal(refused.status, 403); assert.deepEqual(JSON.parse(JSON.stringify(refused.body)), { error: 'forbidden' }); assert.equal(await snapshot(), before);
  await t.db.update(schema.conversationMembers).set({ role: 'member' }).where(orm.and(orm.eq(schema.conversationMembers.conversationId, own), orm.eq(schema.conversationMembers.userId, 'local')));
  await t.db.update(schema.conversationMembers).set({ role: 'owner' }).where(orm.and(orm.eq(schema.conversationMembers.conversationId, own), orm.eq(schema.conversationMembers.userId, 'shadow')));
  assert.equal((await f.groups.acceptGroupOp({ instanceId: peer }, request)).status, 200);
  assert.ok((await members()).find(p => p.userId === 'member')?.leftAt); assert.equal(serviceType((await messages())[0]), 'remove');
  assert.equal((await f.groups.acceptGroupOp({ instanceId: peer }, opBody('leave'))).status, 200);
  assert.ok((await members()).find(p => p.userId === 'shadow')?.leftAt); assert.equal((await members()).find(p => p.userId === 'local')?.role, 'owner');
  assert.equal(serviceType((await messages())[1]), 'leave'); assert.equal((await conv()).groupVersion, 9);
});
