import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, it } from 'node:test';
import Fastify, { type InjectOptions } from 'fastify';
import { z } from 'zod';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as dmRules from '../src/dmRules.js';
import * as blockRules from '../src/blockRules.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as linkService from '../src/federation/linkService.js';
import * as directoryRules from '../src/federation/directoryRules.js';
import * as syncCore from '../src/federation/directorySyncCore.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
type Via = typeof import('../src/federation/convVia.js');
type Conv = typeof import('../src/conversations.js');
const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32), cid = 'via-conv';
// Привязка к часам самого Postgres: received_at при настоящем заборе имеет DEFAULT now(), не фиктивную дату теста.
const now = Date.now(), hour = 3_600_000;
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t.close(); });
const raw = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const forbidden = (name: string) => () => { throw new Error(`неописанная IO-граница ${name}`); };

/** Целые модули; SQL, правила, сериализация и журнал не заменяются «удобными» ответами. */
function moduleOf<T>(name: string, explicit: Record<string, unknown>, mutation?: Mutation): T {
  let source = raw(name);
  if (mutation) {
    assert.equal(source.split(mutation[0]).length - 1, 1, `единственный якорь мутанта ${name}`);
    source = source.replace(...mutation);
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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, crypto,
    console: { warn: () => {} }, setTimeout: forbidden('таймер'), setInterval: forbidden('фоновый worker'),
    require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `явный импорт ${name}:${id}`); return dependencies[id]; },
  });
  return module.exports as T;
}

async function seed(db: TestDb, self = A, peer = B, local = 'local', shadow = 'shadow', remoteUser = 'peer-user') {
  await truncateAll(db.raw);
  await db.db.insert(schema.users).values([
    { id: local, username: `${local}_via`, displayName: 'Местный', passwordHash: 'fixture', verified: true, approvedAt: new Date(now) },
    { id: shadow, username: `${shadow}_via`, displayName: 'Тень', passwordHash: 'fixture', verified: true,
      homeInstanceId: peer, homeUserId: remoteUser, homeUsername: 'remote' },
    { id: 'alien', username: 'alien_via', displayName: 'Третий дом', passwordHash: 'fixture', homeInstanceId: C, homeUserId: 'third-user' },
    { id: 'neighbor', username: 'neighbor_via', displayName: 'Свой сосед', passwordHash: 'fixture' },
    { id: 'outsider', username: 'outsider_via', displayName: 'Посторонний', passwordHash: 'fixture' },
  ]);
  await db.db.insert(schema.conversations).values([
    { id: cid, kind: 'direct', directKey: shared.fedDirectKey({ instanceId: self, userId: local }, { instanceId: peer, userId: remoteUser }), createdBy: local },
    { id: 'via-group', kind: 'group', createdBy: local },
    { id: 'via-saved', kind: 'direct', directKey: `${local}:${local}`, createdBy: local },
    { id: 'via-shadow-saved', kind: 'direct', directKey: `${shadow}:${shadow}`, createdBy: shadow },
    { id: 'via-local', kind: 'direct', directKey: `${local}:neighbor`, createdBy: local },
  ]);
  await db.db.insert(schema.conversationMembers).values([
    { conversationId: cid, userId: local }, { conversationId: cid, userId: shadow },
    { conversationId: 'via-group', userId: local }, { conversationId: 'via-group', userId: shadow },
    { conversationId: 'via-saved', userId: local }, { conversationId: 'via-shadow-saved', userId: shadow },
    { conversationId: 'via-local', userId: local }, { conversationId: 'via-local', userId: 'neighbor' },
  ]);
  await db.db.insert(schema.federationLinks).values({
    instanceId: peer, domain: 'peer.invalid', apiBase: 'https://peer.invalid', clientOrigin: 'https://peer.invalid',
    rootKey: 'fixture-public-key', state: 'active', features: [shared.FED_FEATURES.guests, shared.FED_FEATURES.dm4],
  });
}

async function modules(db: TestDb, self = A, mutation?: { via?: Mutation; route?: Mutation }) {
  const events: Array<{ userId: string; event: shared.GatewayServerMessage }> = [];
  const audits: Array<{ action: string; details: Record<string, unknown> }> = [];
  const sent: Array<{ peer: string; kind: string; payload: unknown }> = [];
  const cache = new Map<string, string>(), cacheWrites: Array<{ key: string; ttl: number }> = [];
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const readPushes: unknown[][] = [];
  const fetches: Array<{ path: string; query?: Record<string, unknown> }> = [];
  const keys = crypto.generateKeyPairSync('ed25519');
  const privateKeyDer = keys.privateKey.export({ format: 'der', type: 'pkcs8' });
  const publicKeyDer = keys.publicKey.export({ format: 'der', type: 'spki' });
  const federation = { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'fixture-kid', privateKeyDer }) };
  const meta = { readInstanceMeta: async () => ({ paused: false, name: 'Фикстура' }) };
  const common = { '@gusvoice/shared': shared, 'drizzle-orm': orm };
  const backend = { ...common, './db/index.js': { db: db.db }, './db/schema.js': schema };
  const federated = { ...common, '../db/index.js': { db: db.db }, '../db/schema.js': schema };
  const identity = moduleOf<typeof import('../src/federation/identityToken.js')>('federation/identityToken', { ...common, 'node:crypto': crypto });
  const links = moduleOf<typeof import('../src/federation/links.js')>('federation/links', {
    ...federated, 'node:crypto': crypto, './linkService.js': linkService, './instance.js': { federation },
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
  const changes = moduleOf<typeof import('../src/federation/convChanges.js')>('federation/convChanges', federated);
  const c = moduleOf<Conv>('conversations', {
    ...backend, './convRules.js': rules, './serialize.js': serializer,
    './dmWriteBarrier.js': { dmWriteBarrier: {} }, './util.js': { uuidv7: crypto.randomUUID },
    './realtime.js': { publishToUser: async (userId: string, event: shared.GatewayServerMessage) => { events.push({ userId, event }); } },
    './attachments.js': { privateAttachmentsReady: () => true, attachmentLink: (id: string) => `/fixture-att/${id}`, purgeDeleted: async () => {} },
    './env.js': { env: { publicApiUrl: 'https://self.invalid' } },
  });
  c.configureFederatedConv({ selfInstanceId: () => self, record: (tx, items) => changes.recordFedConvChanges(tx, items) });
  const guestHome = moduleOf<typeof import('../src/federation/guestHome.js')>('federation/guestHome', {
    ...federated, './instance.js': { federation }, './links.js': links, './linkRules.js': linkRules,
    './instanceMeta.js': meta, './directoryRules.js': directoryRules, './identityToken.js': identity,
  });
  const membership = moduleOf<typeof import('../src/federation/guestMembership.js')>('federation/guestMembership', federated);
  const io = {
    pending: async (): Promise<Record<string, unknown>> => shared.serializeViaPage([]),
    verdict: async (_peer: string, _kind: string, _payload: unknown) => {},
    session: async (_request: { method: string; url: string; body?: string }) => ({
      status: 200, body: JSON.stringify(shared.serializeGuestSession({ userId: 'host-shadow', token: `fixture-session-${requests.length}`, expiresAt: now + 8 * 24 * hour })),
    }),
  };
  const directory = moduleOf<typeof import('../src/federation/directorySync.js')>('federation/directorySync', {
    ...federated, './instance.js': { federation }, './instanceMeta.js': meta, './links.js': links,
    './directorySyncCore.js': syncCore,
    './peerClient.js': { fetchPeerDocument: async () => ({ ok: false, problem: 'unreachable' }) },
  });
  const via = moduleOf<Via>('federation/convVia', {
    ...federated, '../conversations.js': c, '../convRules.js': rules,
    './auditLog.js': { fedAudit: (action: string, details: Record<string, unknown>) => { audits.push({ action, details }); } },
    './convChanges.js': changes, './guestHome.js': guestHome, './instance.js': { federation }, './instanceMeta.js': meta,
    './linkRules.js': linkRules, './links.js': links, './directorySync.js': directory,
    '../realtime.js': { redisPub: {
      get: async (key: string) => cache.get(key) ?? null,
      set: async (key: string, value: string, ex: string, ttl: number) => { assert.equal(ex, 'EX'); cache.set(key, value); cacheWrites.push({ key, ttl }); },
    } },
    '../safeFetch.js': { safePeerRequest: async (request: { method: string; url: string; body?: string }) => { requests.push(request); return io.session(request); } },
    './peerClient.js': { getSignedFromPeer: async (request: { path: string; query?: Record<string, unknown> }) => {
      fetches.push(request); return { ok: true, value: { status: 200, body: JSON.stringify(await io.pending()) } };
    } },
    './eventStream.js': { sendEventTo: async (peer: string, kind: string, payload: unknown) => { sent.push({ peer, kind, payload }); await io.verdict(peer, kind, payload); } },
  }, mutation?.via);
  const att = moduleOf<typeof import('../src/routes/att.js')>('routes/att', { ...common, zod: { z } });
  const catalog = moduleOf<typeof import('../src/stickerCatalog.js')>('stickerCatalog', backend);
  const blocks = moduleOf<typeof import('../src/blocks.js')>('blocks', backend);
  const pushRules = await import('../src/pushRules.js');
  const fanout = moduleOf<typeof import('../src/convSendFanout.js')>('convSendFanout', {
    ...backend, './conversations.js': c, './authGuard.js': { pushBurst: async () => 'drop' },
    './push.js': pushRules,
  });
  const route = moduleOf<typeof import('../src/routes/conv.js')>('routes/conv', {
    ...federated, zod: { z }, '../conversations.js': c, '../convRules.js': rules, '../dmRules.js': dmRules, '../blockRules.js': blockRules,
    '../auth.js': { requireAuth: async (req: { headers: Record<string, unknown>; user?: { sub: string } }) => { req.user = { sub: String(req.headers['x-fixture-user'] ?? 'local') }; } },
    '../authGuard.js': { messageSendBlock: async () => 0, rateHit: async () => 0 },
    '../blocks.js': blocks,
    '../stickerCatalog.js': catalog, './att.js': att, '../convSendFanout.js': fanout,
    '../push.js': { ...pushRules, sendReadSyncPush: async (...args: unknown[]) => { readPushes.push(args); } },
  }, mutation?.route);
  route.configureFedVia({ gate: via.viaGate, isShadow: via.isShadowUser,
    fallback: (me, conversationId, purpose) => via.fallbackFor(me, conversationId, undefined, purpose), claims: via.acceptClaims });
  route.configureFedFilesGuard(async () => true);
  return { c, changes, via, route, events, audits, sent, membership, identity, publicKeyDer, cache, cacheWrites, requests, fetches, readPushes, io,
    row: async (id: string) => (await db.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, id)))[0],
  };
}

async function fixture(mutation?: { via?: Mutation; route?: Mutation }) { await seed(t); return modules(t, A, mutation); }
async function appFor(f: Awaited<ReturnType<typeof modules>>) { const app = Fastify(); await app.register(f.route.convRoutes); await app.ready(); return app; }
async function access(f: Awaited<ReturnType<typeof modules>>, me = 'local', conversationId = cid) {
  const a = await f.c.loadAccess(conversationId, me); assert.ok(a); return a;
}
async function message(f: Awaited<ReturnType<typeof modules>>, me = 'shadow', id = 'via-message', state: 'pending' | 'confirmed' = 'pending', conversationId = cid) {
  const res = await f.c.sendMessage(me, await access(f, me, conversationId), {
    clientId: crypto.randomUUID(), content: 'Исходный текст', attachments: [], replyToId: null, withheld: false,
    id, createdAt: new Date(now - 3 * hour), via: { instanceId: B, state },
  });
  assert.equal(res.kind, 'created'); return res;
}
const bodyVerdict = (id: string, verdict: shared.FedViaVerdict, conversationId = cid) => shared.serializeViaVerdict({ conversationId, messageId: id, verdict });
const verdicts = (f: Awaited<ReturnType<typeof modules>>) => f.sent.map(e => { const v = shared.parseViaVerdict(e.payload); assert.ok(v); return v; });
function assertion(label: string) { return (err: unknown) => err instanceof assert.AssertionError && err.message.includes(label); }

it('R198 местный пишет обычным путём, тень — только через рабочий dm4 своему собеседнику', async () => {
  // Смешение обычного и обходного пути ставило бы «не подтверждено» собственным сообщениям дома.
  const f = await fixture();
  assert.equal(await f.via.viaGate('local', await access(f)), null);
  assert.equal(await f.via.isShadowUser('local'), false); assert.equal(await f.via.isShadowUser('shadow'), true);
  const gate = await f.via.viaGate('shadow', await access(f, 'shadow'));
  assert.ok(gate && gate !== 'refused'); assert.equal(gate.instanceId, B);
  await t.db.update(schema.users).set({ deletedAt: new Date(now) }).where(orm.eq(schema.users.id, 'shadow'));
  assert.equal(await f.via.viaGate('shadow', await access(f, 'shadow')), 'refused');
  await t.db.update(schema.users).set({ deletedAt: null }).where(orm.eq(schema.users.id, 'shadow'));
  await t.db.update(schema.federationLinks).set({ state: 'paused' });
  assert.equal(await f.via.viaGate('shadow', await access(f, 'shadow')), 'refused');
  assert.equal(await f.via.viaGate('local', await access(f)), null, 'пауза соседа не переводит своего автора в обход');
});
it('R198 тень не пишет в группу, Избранное, третьему дому и без dm4; местная отправка не зависит от dm4', async () => {
  const f = await fixture();
  for (const conversationId of ['via-group', 'via-shadow-saved']) assert.equal(await f.via.viaGate('shadow', await access(f, 'shadow', conversationId)), 'refused');
  await t.db.update(schema.users).set({ homeInstanceId: C, homeUserId: 'local-elsewhere' }).where(orm.eq(schema.users.id, 'local'));
  assert.equal(await f.via.viaGate('shadow', await access(f, 'shadow')), 'refused', 'тень не пересылает личность третьему дому');
  await t.db.update(schema.users).set({ homeInstanceId: null, homeUserId: null }).where(orm.eq(schema.users.id, 'local'));
  await t.db.update(schema.federationLinks).set({ features: [shared.FED_FEATURES.guests] });
  assert.equal(await f.via.viaGate('shadow', await access(f, 'shadow')), 'refused');
  assert.equal(await f.via.viaGate('local', await access(f)), null);
  const app = await appFor(f);
  try {
    for (const conversationId of [cid, 'via-group', 'via-shadow-saved']) {
      const res = await app.inject({ method: 'POST', url: `/conv/${conversationId}/messages`, headers: { 'x-fixture-user': 'shadow' },
        payload: { content: 'Запрещённый обход', clientId: crypto.randomUUID() } });
      assert.equal(res.statusCode, 403); assert.equal(res.json().error, shared.FED_ERRORS.dmViaLimited);
    }
    assert.equal((await t.db.select().from(schema.conversationMessages)).length, 0);
    const local = await app.inject({ method: 'POST', url: `/conv/${cid}/messages`, payload: { content: 'Обычный путь', clientId: crypto.randomUUID() } });
    assert.equal(local.statusCode, 201); assert.equal(Object.hasOwn(local.json(), 'via'), false);
    assert.deepEqual(f.readPushes, [['local', cid, local.json().sortKey]]);
  } finally { await app.close(); }
});
it('R198 текст и ответ без фрагмента проходят по теневой сессии и сохраняют pending в реальной строке и DTO', async () => {
  const f = await fixture(); await message(f, 'local', 'parent'); const app = await appFor(f);
  try {
    const expectedReadPushes: unknown[][] = [];
    for (const replyToId of [null, 'parent']) {
      const res = await app.inject({ method: 'POST', url: `/conv/${cid}/messages`, headers: { 'x-fixture-user': 'shadow' },
        payload: { clientId: crypto.randomUUID(), content: 'Свой текст', replyToId } });
      assert.equal(res.statusCode, 201); assert.equal(res.json().via.confirmed, false); assert.equal(res.json().via.instance, B);
      const row = await f.row(res.json().id); assert.equal(row.authorId, 'shadow'); assert.equal(row.viaState, 'pending'); assert.equal(row.replyToId, replyToId);
      expectedReadPushes.push(['shadow', cid, res.json().sortKey]); assert.deepEqual(f.readPushes, expectedReadPushes);
    }
  } finally { await app.close(); }
});
for (const kind of ['вложение', 'стикер', 'фрагмент цитаты'] as const) it(`R198 ${kind} в обходе даёт точный 403, тот же местный ввод принимается`, async () => {
  // Проверяется парное принятие: ошибку каталога или цитаты нельзя выдавать за работу via guard.
  const f = await fixture(); await message(f, 'local', 'parent');
  const attachmentId = crypto.randomUUID();
  await t.db.insert(schema.attachments).values({ id: attachmentId, ownerId: 'local', conversationId: cid, storageKey: 'fixture-key', name: 'a.txt', contentType: 'text/plain', size: 2, state: 'pending' });
  await t.db.insert(schema.stickerPacks).values({ id: 'fixture-pack', name: 'FixtureVia', title: 'Тест', createdBy: 'local' });
  await t.db.insert(schema.stickers).values({ id: 'fixture-sticker', packId: 'fixture-pack', emoji: '🪿', url: '/fixture.webp', format: 'webp', position: 0 });
  const payload = kind === 'вложение' ? { content: 'Файл', attachments: [{ id: attachmentId }] }
    : kind === 'стикер' ? { content: '', stickerId: 'fixture-sticker' }
      : { content: 'Ответ', replyToId: 'parent', replyQuote: { text: 'Исходный', offset: 0 } };
  const app = await appFor(f);
  try {
    const before = (await t.db.select().from(schema.conversationMessages)).length;
    const refused = await app.inject({ method: 'POST', url: `/conv/${cid}/messages`, headers: { 'x-fixture-user': 'shadow' }, payload: { ...payload, clientId: crypto.randomUUID() } });
    assert.equal(refused.statusCode, 403); assert.equal(refused.json().error, shared.FED_ERRORS.dmViaLimited);
    assert.equal((await t.db.select().from(schema.conversationMessages)).length, before, 'отказ не пишет сообщение');
    const accepted = await app.inject({ method: 'POST', url: `/conv/${cid}/messages`, payload: { ...payload, clientId: crypto.randomUUID() } });
    assert.equal(accepted.statusCode, 201); assert.equal(Object.hasOwn(accepted.json(), 'via'), false);
    assert.deepEqual(f.readPushes, [['local', cid, accepted.json().sortKey]]);
    const row = await f.row(accepted.json().id);
    assert.equal(kind === 'вложение' ? row.attachments.length : kind === 'стикер' ? row.sticker?.id : row.replyQuote?.text,
      kind === 'вложение' ? 1 : kind === 'стикер' ? 'fixture-sticker' : 'Исходный');
  } finally { await app.close(); }
});

function writeRequest(kind: 'правка' | 'удаление' | 'реакция' | 'закреп', me: string): InjectOptions {
  const common = { headers: { 'x-fixture-user': me } };
  const url = `/conv/${cid}/messages/${me}-message`;
  if (kind === 'правка') return { ...common, method: 'PATCH', url, payload: { content: 'Правка' } };
  if (kind === 'удаление') return { ...common, method: 'DELETE', url: `${url}?for=both` };
  if (kind === 'реакция') return { ...common, method: 'POST', url: `${url}/reactions`, payload: { emoji: '👍', op: 'add' } };
  return { ...common, method: 'PUT', url: `${url}/pin`, payload: { for: 'both' } };
}
async function guardedWrite(kind: Parameters<typeof writeRequest>[0], mutation?: Mutation) {
  const f = await fixture({ route: mutation }); await message(f, 'shadow', 'shadow-message'); await message(f, 'local', 'local-message');
  const app = await appFor(f);
  try {
    const before = JSON.stringify(await f.row('shadow-message'));
    const refused = await app.inject(writeRequest(kind, 'shadow'));
    assert.equal(refused.statusCode, 403, 'теневая запись закрыта до изменения SQL'); assert.equal(refused.json().error, shared.FED_ERRORS.dmViaLimited);
    assert.equal(JSON.stringify(await f.row('shadow-message')), before); assert.equal(f.events.length, 0);
    const accepted = await app.inject(writeRequest(kind, 'local'));
    assert.equal(accepted.statusCode, kind === 'удаление' || kind === 'реакция' ? 204 : 200);
    assert.ok(f.events.length > 0, 'местное парное действие публикует conv.change');
  } finally { await app.close(); }
}
for (const kind of ['правка', 'удаление', 'реакция', 'закреп'] as const) it(`R198 ${kind} у обоих теневой сессии закрыта, местному доступна`, async () => { await guardedWrite(kind); });
it('R198 удаление isShadow из fedLinkRefused обнаруживается успешной теневой правкой, а не loader', async () => {
  await guardedWrite('правка');
  await assert.rejects(guardedWrite('правка', [
    'if (fedVia && me && !opts.viaOk && (await fedVia.isShadow(me))) {', 'if (false) {',
  ]), assertion('теневая запись закрыта до изменения SQL'));
});

it('R198 confirmed снимает непроверенную пометку и публикует conv.change обоим, повтор не пишет журнал', async () => {
  const f = await fixture(); await message(f);
  assert.equal((await f.c.messageFor('via-message', 'local') as shared.ConvMessage).via?.confirmed, false);
  await f.via.applyVerdict(B, bodyVerdict('via-message', 'confirmed'));
  assert.equal((await f.row('via-message')).viaState, 'confirmed');
  assert.deepEqual(f.events.map(e => e.userId).sort(), ['local', 'shadow']);
  for (const e of f.events) { assert.equal(e.event.t, 'conv.change'); assert.equal('message' in e.event && e.event.message && 'via' in e.event.message && e.event.message.via?.confirmed, true); }
  const journal = (await t.db.select().from(schema.userChanges)).length;
  await f.via.applyVerdict(B, bodyVerdict('via-message', 'confirmed'));
  assert.equal(f.events.length, 2); assert.equal((await t.db.select().from(schema.userChanges)).length, journal); assert.equal(f.audits.length, 0);
});
it('R198 rejected делает надгробие у обоих и точный аудит подделки, duplicate — надгробие без тревоги', async () => {
  const f = await fixture(); await message(f, 'shadow', 'forged'); await message(f, 'shadow', 'duplicate');
  await f.via.applyVerdict(B, bodyVerdict('forged', 'rejected'));
  const row = await f.row('forged'); assert.ok(row.deletedAt); assert.equal(row.content, ''); assert.equal(row.attachments.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(f.audits)), [{ action: 'federation.dm_via_forged', details: { instanceId: B, messageId: 'forged', conversationId: cid, authorId: 'shadow' } }]);
  assert.equal(f.events.length, 2); for (const e of f.events) {
    assert.equal(e.event.t, 'conv.change');
    const gone = 'message' in e.event ? e.event.message : null;
    assert.ok(gone && typeof gone === 'object' && 'gone' in gone);
    assert.equal(gone.gone, true); assert.equal(gone.id, 'forged'); assert.equal(gone.conversationId, cid);
  }
  await f.via.applyVerdict(B, bodyVerdict('duplicate', 'duplicate')); assert.ok((await f.row('duplicate')).deletedAt);
  assert.equal(f.audits.length, 1); assert.equal(f.events.length, 4);
});
async function foreignVerdict(mutation?: Mutation) {
  const f = await fixture({ via: mutation }); await message(f);
  await f.via.applyVerdict(C, bodyVerdict('via-message', 'confirmed'));
  assert.equal((await f.row('via-message')).viaState, 'pending');
  // Повреждённая пометка не может дать третьему дому право решать за настоящего автора.
  await t.db.update(schema.conversationMessages).set({ viaInstanceId: C }).where(orm.eq(schema.conversationMessages.id, 'via-message'));
  await f.via.applyVerdict(C, bodyVerdict('via-message', 'confirmed'));
  assert.equal((await f.row('via-message')).viaState, 'pending', 'решает только фактический дом автора');
  assert.equal(f.events.length, 0); assert.equal(f.audits.length, 0);
}
it('R198 чужой дом не решает даже при повреждённом via_instance_id; снятая проверка дома автора краснеет', async () => {
  await foreignVerdict();
  await assert.rejects(foreignVerdict(['if (author?.home !== instanceId) return; // решает только дом автора', '// проверка дома автора удалена']), assertion('решает только фактический дом автора'));
});
it('R198 unverified сохраняет вид неподтверждённого и не публикует изменений, чужая беседа и незнакомое решение игнорируются', async () => {
  const f = await fixture(); await message(f);
  const before = JSON.stringify(await f.c.messageFor('via-message', 'local'));
  await f.via.applyVerdict(B, bodyVerdict('via-message', 'confirmed', 'via-local'));
  await f.via.applyVerdict(B, { ...bodyVerdict('via-message', 'confirmed'), verdict: 'future' });
  assert.equal((await f.row('via-message')).viaState, 'pending');
  await f.via.applyVerdict(B, bodyVerdict('via-message', 'unverified'));
  assert.equal((await f.row('via-message')).viaState, 'unverified');
  assert.equal(JSON.stringify(await f.c.messageFor('via-message', 'local')), before);
  assert.equal(f.events.length, 0); assert.equal(f.audits.length, 0);
});

async function pendingScope(mutation?: Mutation) {
  const f = await fixture({ via: mutation });
  await t.db.insert(schema.conversationMessages).values([
    { id: 'pending-first', conversationId: cid, authorId: 'shadow', sortKey: 1, content: 'Первое', viaInstanceId: B, viaState: 'pending' },
    { id: 'pending-second', conversationId: cid, authorId: 'shadow', sortKey: 2, content: 'Второе', viaInstanceId: B, viaState: 'pending' },
    { id: 'already-confirmed', conversationId: cid, authorId: 'shadow', sortKey: 3, content: 'Да', viaInstanceId: B, viaState: 'confirmed' },
    { id: 'unverified', conversationId: cid, authorId: 'shadow', sortKey: 4, content: 'Нет отчёта', viaInstanceId: B, viaState: 'unverified' },
    { id: 'deleted', conversationId: cid, authorId: 'shadow', sortKey: 5, content: '', deletedAt: new Date(now), viaInstanceId: B, viaState: 'pending' },
    { id: 'foreign-author', conversationId: cid, authorId: 'alien', sortKey: 6, content: 'Чужое', viaInstanceId: B, viaState: 'pending' },
    { id: 'local-author', conversationId: cid, authorId: 'local', sortKey: 7, content: 'Наше', viaInstanceId: B, viaState: 'pending' },
    { id: 'another-via', conversationId: cid, authorId: 'shadow', sortKey: 8, content: 'Иная пометка', viaInstanceId: C, viaState: 'pending' },
  ]);
  const page = shared.parseViaPage(await f.via.pendingFor(B, A)); assert.ok(page);
  assert.deepEqual(page.map(w => w.id), ['pending-first', 'pending-second'], 'спрашивающий видит только pending своих авторов');
  assert.deepEqual(page.map(w => `${w.author.instanceId}:${w.author.userId}`), [`${B}:peer-user`, `${B}:peer-user`]);
  assert.equal((shared.parseViaPage(await f.via.pendingFor(C, A)) ?? []).length, 0);
}
it('R198 pendingFor выбирает живые pending по порядку и фактическому дому автора, удаление фильтра раскрывает чужое', async () => {
  await pendingScope();
  await assert.rejects(pendingScope(['.filter((m) => people.get(m.authorId)?.homeInstanceId === instanceId)', '.filter(() => true)']), assertion('спрашивающий видит только pending своих авторов'));
});

function wire(id = 'own-via', clientId: string | null = crypto.randomUUID(), overrides: Partial<shared.FedConvMessageWire> = {}): shared.FedConvMessageWire {
  return { id, conversationId: cid, author: { instanceId: A, userId: 'local' }, clientId,
    payloadHash: null, createdAt: now - 3 * hour, originSortKey: 10, content: 'Отправлено мной', replyToId: null,
    forwardedFrom: null, silent: true, noPreview: true, captionAbove: false, replyQuote: null, sticker: null, service: null,
    attachments: [], editVersion: 0, editedAt: null, deleted: false, ...overrides };
}
function claimHash(w: shared.FedConvMessageWire) { return rules.payloadHash({ conversationId: w.conversationId, content: w.content, attachmentRefs: [], replyToId: w.replyToId }); }
async function queue(w: shared.FedConvMessageWire, hash: string | null = claimHash(w), claimConversation = w.conversationId) {
  await t.db.insert(schema.fedViaPending).values({ messageId: w.id, instanceId: B, conversationId: w.conversationId, authorId: 'local', clientId: w.clientId,
    entity: shared.serializeConvMessageWire(w), receivedAt: new Date(now) });
  if (hash !== null && w.clientId) await t.db.insert(schema.fedViaClaims).values({ userId: 'local', clientId: w.clientId, conversationId: claimConversation, payloadHash: hash });
}
it('R198 decidePending принимает своим с той же id, clientId и временем, пишет настоящий журнал и повторяет без дубля', async () => {
  const f = await fixture(), w = wire(); await queue(w); await f.via.reconcileVia(B, now);
  const row = await f.row(w.id); assert.ok(row); assert.equal(row.authorId, 'local'); assert.equal(row.clientId, w.clientId);
  assert.equal(row.createdAt.getTime(), w.createdAt); assert.equal(row.content, w.content); assert.equal(row.silent, true); assert.equal(row.noPreview, true);
  assert.equal(row.viaState, 'confirmed'); assert.equal(row.viaInstanceId, B);
  assert.deepEqual(verdicts(f), [{ conversationId: cid, messageId: w.id, verdict: 'confirmed' }]);
  assert.equal(f.events.length, 2); assert.equal((await t.db.select().from(schema.fedViaPending)).length, 0); assert.equal((await t.db.select().from(schema.fedViaClaims)).length, 0);
  assert.ok((await t.db.select().from(schema.fedConvChanges)).some(r => r.entityId === w.id), 'принятое своим уходит обычным журналом');
  await queue(w); await f.via.reconcileVia(B, now); assert.equal((await t.db.select().from(schema.conversationMessages)).length, 1); assert.equal(f.events.length, 2);
  assert.equal(verdicts(f)[1].verdict, 'confirmed', 'та же id своего автора — подтверждённый no-op');
});
it('R198 повтор client_id уже отправленного домой даёт duplicate, не создаёт второе сообщение и не тревожит аудит', async () => {
  const f = await fixture(), w = wire();
  const sent = await f.c.sendMessage('local', await access(f), { clientId: w.clientId, content: w.content, attachments: [], replyToId: null, withheld: false });
  assert.equal(sent.kind, 'created'); await queue(w); await f.via.reconcileVia(B, now);
  assert.equal(verdicts(f)[0].verdict, 'duplicate'); assert.equal((await t.db.select().from(schema.conversationMessages)).length, 1);
  assert.equal(await f.row(w.id), undefined); assert.equal(f.events.length, 0); assert.equal(f.audits.length, 0);
});
async function existingIdConversation(mutation?: Mutation) {
  const f = await fixture({ via: mutation }); const existingId = 'existing-own-id', otherConv = 'via-second-peer';
  await t.db.insert(schema.users).values({ id: 'second-shadow', username: 'second_shadow_via', displayName: 'Второй собеседник',
    passwordHash: 'fixture', homeInstanceId: B, homeUserId: 'second-peer', homeUsername: 'second_remote' });
  await t.db.insert(schema.conversations).values({ id: otherConv, kind: 'direct', createdBy: 'local',
    directKey: shared.fedDirectKey({ instanceId: A, userId: 'local' }, { instanceId: B, userId: 'second-peer' }) });
  await t.db.insert(schema.conversationMembers).values([{ conversationId: otherConv, userId: 'local' }, { conversationId: otherConv, userId: 'second-shadow' }]);
  const accessible = await access(f, 'local', otherConv);
  assert.equal(accessible.kind, 'direct'); assert.equal(accessible.peerId, 'second-shadow', 'вторая беседа действительно доступна автору с человеком того же дома');
  await message(f, 'local', existingId); const before = JSON.stringify(await f.row(existingId));
  const journalSize = (await t.db.select().from(schema.userChanges)).length;
  await queue(wire(existingId)); await f.via.reconcileVia(B, now);
  assert.equal(verdicts(f)[0].verdict, 'confirmed', 'существующая id того же автора в той же беседе подтверждается без дубля');
  assert.equal(f.events.length, 0); assert.equal(JSON.stringify(await f.row(existingId)), before);
  // Совпадает автор и валидный claim, но новая беседа не вправе присвоить старую id.
  const collision = wire(existingId, crypto.randomUUID(), { conversationId: otherConv });
  await queue(collision); await f.via.reconcileVia(B, now);
  assert.equal(verdicts(f)[1].verdict, 'rejected', 'совпавшая id из другой доступной беседы не подтверждается');
  assert.equal(verdicts(f)[1].conversationId, otherConv);
  assert.equal(JSON.stringify(await f.row(existingId)), before, 'коллизия не переносит и не переписывает существующее сообщение');
  assert.equal((await t.db.select().from(schema.conversationMessages)).length, 1);
  assert.equal((await t.db.select().from(schema.userChanges)).length, journalSize);
  assert.equal((await t.db.select().from(schema.fedViaPending)).length, 0);
  assert.equal((await t.db.select().from(schema.fedViaClaims)).length, 0);
  assert.equal(f.events.length, 0);
}
it('R202 существующая id принимается в своей беседе, но отклоняется в другой доступной беседе того же автора', async () => {
  await existingIdConversation();
});
it('R202 мутант подтверждения id только по автору ловится коллизией между двумя доступными личками', async () => {
  await existingIdConversation();
  await assert.rejects(existingIdConversation([
    'exists.authorId === authorId && exists.conversationId === w.conversationId', 'exists.authorId === authorId',
  ]), assertion('совпавшая id из другой доступной беседы не подтверждается'));
});
it('R198 чужая беседа, id чужого автора и claim из другой беседы отклоняются, парное своё принято', async () => {
  const f = await fixture(); await message(f, 'shadow', 'occupied-id');
  const wrongConv = wire('wrong-conv', crypto.randomUUID(), { conversationId: 'missing-conv' });
  const occupied = wire('occupied-id'); const wrongClaim = wire('wrong-claim'); const good = wire('good');
  await queue(wrongConv); await queue(occupied); await queue(wrongClaim, claimHash(wrongClaim), 'via-local'); await queue(good);
  await f.via.reconcileVia(B, now);
  assert.deepEqual(verdicts(f).map(v => `${v.messageId}:${v.verdict}`).sort(), ['good:confirmed', 'occupied-id:rejected', 'wrong-claim:rejected', 'wrong-conv:rejected']);
  assert.equal((await f.row('occupied-id')).authorId, 'shadow'); assert.equal(await f.row('wrong-conv'), undefined); assert.equal(await f.row('wrong-claim'), undefined);
  assert.equal((await f.row('good')).authorId, 'local');
});
async function recalculate(mutation?: Mutation) {
  const f = await fixture({ via: mutation }); const genuine = wire('genuine'), forgery = wire('forgery');
  const hash = claimHash(forgery); forgery.payloadHash = hash; forgery.content = 'Текст, которого автор не отправлял';
  genuine.payloadHash = claimHash(genuine); await queue(genuine); await queue(forgery, hash); await f.via.reconcileVia(B, now);
  assert.equal(verdicts(f).find(v => v.messageId === 'genuine')?.verdict, 'confirmed');
  assert.equal(verdicts(f).find(v => v.messageId === 'forgery')?.verdict, 'rejected', 'поддельный текст не подтверждается хешем соседа');
  assert.equal(await f.row('forgery'), undefined); assert.ok(await f.row('genuine'));
}
it('R198 дом пересчитывает отпечаток по тексту; доверие payload_hash соседа подтверждало бы подделку', async () => {
  await recalculate();
  await assert.rejects(recalculate([
    'const wireHash = payloadHash({ conversationId: row.conversationId, content: w.content, attachmentRefs: [], replyToId: w.replyToId });',
    "const wireHash = w.payloadHash ?? '';",
  ]), assertion('поддельный текст не подтверждается хешем соседа'));
});

it('R198 fallback доступен только своему участнику прямой беседы с тенью и dm4, отказ не выпускает гостевую сессию', async () => {
  const f = await fixture();
  for (const [me, conversationId] of [['outsider', cid], ['shadow', cid], ['local', 'via-group'], ['local', 'via-saved'], ['local', 'via-local']]) {
    const res = await f.via.fallbackFor(me, conversationId, now); assert.equal(res.status, 404); assert.equal(res.body.error, 'not found');
  }
  assert.equal(f.requests.length, 0); assert.equal((await t.db.select().from(schema.federationGuestGrants)).length, 0);
  await t.db.update(schema.federationLinks).set({ features: [shared.FED_FEATURES.guests] });
  const unsupported = await f.via.fallbackFor('local', cid, now); assert.equal(unsupported.status, 409); assert.equal(unsupported.body.error, shared.FED_ERRORS.unsupported);
  assert.equal(f.requests.length, 0);
  await t.db.update(schema.federationLinks).set({ features: [shared.FED_FEATURES.guests, shared.FED_FEATURES.dm4] });
  const ok = await f.via.fallbackFor('local', cid, now); assert.equal(ok.status, 200); assert.equal(ok.body.instanceId, B); assert.equal(ok.body.userId, 'host-shadow');
  assert.deepEqual([...(await f.membership.grantHostsOf('local'))], [B], 'поручительство попадает в адресатов отзыва');
  assert.equal(f.requests[0].method, 'POST'); assert.equal(f.requests[0].url, 'https://peer.invalid/api/fed/v1/session');
  const identity = f.identity.verifyIdentityToken({ token: JSON.parse(f.requests[0].body!).token, findKey: kid => kid === 'fixture-kid' ? f.publicKeyDer : null, now });
  assert.ok(identity.ok); assert.equal(identity.claims.iss, A); assert.equal(identity.claims.sub, 'local'); assert.equal(identity.claims.aud, B);
});
async function fallbackGeneration(mutation?: Mutation) {
  const f = await fixture({ via: mutation }); const first = await f.via.fallbackFor('local', cid, now), cached = await f.via.fallbackFor('local', cid, now + 1_000);
  assert.equal(first.status, 200); assert.equal(cached.status, 200); assert.equal(cached.body.token, first.body.token); assert.equal(f.requests.length, 1);
  await t.db.update(schema.users).set({ tokenGeneration: 1 }).where(orm.eq(schema.users.id, 'local'));
  const fresh = await f.via.fallbackFor('local', cid, now + 2_000);
  assert.equal(fresh.status, 200); assert.notEqual(fresh.body.token, first.body.token, 'новое поколение не получает мёртвую сессию из кеша');
  assert.equal(f.requests.length, 2); assert.deepEqual(f.cacheWrites.map(w => w.key), [`fed:fallback:local:${B}:0`, `fed:fallback:local:${B}:1`]);
  assert.ok(f.cacheWrites.every(w => w.ttl === 24 * 3600));
  assert.deepEqual([...(await f.membership.grantHostsOf('local'))], [B]); assert.equal((await t.db.select().from(schema.federationGuestGrants)).length, 1);
  const proof = f.identity.verifyIdentityToken({ token: JSON.parse(f.requests[1].body!).token, findKey: () => f.publicKeyDer, now: now + 2_000 });
  assert.ok(proof.ok); assert.equal(proof.claims.gen, 1);
}
it('R198 fallback кеширует внутри поколения, выход везде обновляет сессию; удалённое поколение в ключе краснеет', async () => {
  await fallbackGeneration();
  await assert.rejects(fallbackGeneration([
    'const cacheKey = `fed:fallback:${me}:${link.instanceId}:${u?.gen ?? 0}`;', 'const cacheKey = `fed:fallback:${me}:${link.instanceId}`;',
  ]), assertion('новое поколение не получает мёртвую сессию из кеша'));
});

it('R200 fallback разделяет назначение via/call: dm4 и dmcall1 не подменяют друг друга, без обоих отказ', async () => {
  for (const features of [[], [shared.FED_FEATURES.dm4], [shared.FED_FEATURES.dmcall1], [shared.FED_FEATURES.dm4, shared.FED_FEATURES.dmcall1]]) {
    const f = await fixture();
    await t.db.update(schema.federationLinks).set({ features: [shared.FED_FEATURES.guests, ...features] });
    for (const purpose of ['via', 'call'] as const) {
      const allowed = features.includes(purpose === 'via' ? shared.FED_FEATURES.dm4 : shared.FED_FEATURES.dmcall1);
      const before = f.requests.length, response = await f.via.fallbackFor('local', cid, now, purpose);
      assert.equal(response.status, allowed ? 200 : 409, `назначение ${purpose} требует собственный признак`);
      if (!allowed) { assert.equal(response.body.error, shared.FED_ERRORS.unsupported); assert.equal(f.requests.length, before); }
      else assert.equal(response.body.instanceId, B);
    }
  }
});
it('R200 возврат требования dm4 для fallback звонка обнаруживается при call-only соседе', async () => {
  async function scenario(mutation?: Mutation) {
    const f = await fixture({ via: mutation });
    await t.db.update(schema.federationLinks).set({ features: [shared.FED_FEATURES.guests, shared.FED_FEATURES.dmcall1] });
    const response = await f.via.fallbackFor('local', cid, now, 'call');
    assert.equal(response.status, 200, 'звонок не требует dm4 при наличии dmcall1');
    assert.deepEqual([...(await f.membership.grantHostsOf('local'))], [B]);
  }
  await scenario();
  await assert.rejects(scenario([
    "const able = purpose === 'call' ? await hasFeature(link, FED_FEATURES.dmcall1, now) : await hasDm4(link, now);",
    'const able = await hasDm4(link, now);',
  ]), assertion('звонок не требует dm4 при наличии dmcall1'));
});

it('R198 две базы: после восстановления отчёт подтверждает настоящее, находит лишнее и оставляет единственную копию', async () => {
  // Чужой хост хранит оба текста; только поздний отчёт автора отделяет реальную отправку от «ещё одного» сообщения.
  await seed(t, A, B, 'local', 'shadow', 'peer-user'); const home = await modules(t, A);
  const remote = await createTestDb();
  try {
    await seed(remote, B, A, 'peer-user', 'author-shadow', 'local'); const host = await modules(remote, B);
    for (const id of ['real', 'extra']) {
      const res = await host.c.sendMessage('author-shadow', await access(host, 'author-shadow'), {
        clientId: crypto.randomUUID(), content: id === 'real' ? 'Это я отправил' : 'Лишнее от моего имени', attachments: [], replyToId: null, withheld: false,
        id, createdAt: new Date(now - 3 * hour), via: { instanceId: A, state: 'pending' },
      });
      assert.equal(res.kind, 'created');
    }
    home.io.pending = () => host.via.pendingFor(A, B);
    home.io.verdict = async (peer, kind, payload) => { assert.equal(peer, B); assert.equal(kind, shared.FED_VIA_VERDICT_EVENT); await host.via.applyVerdict(A, payload); };
    await home.via.reconcileVia(B, now);
    assert.equal((await t.db.select().from(schema.fedViaPending)).length, 2); assert.equal((await t.db.select().from(schema.conversationMessages)).length, 0);
    assert.equal(home.sent.length, 0); assert.equal((await host.row('real')).viaState, 'pending'); assert.equal((await host.row('extra')).viaState, 'pending');
    const genuine = (shared.parseViaPage(await host.via.pendingFor(A, B))!).find(w => w.id === 'real')!;
    // Эти строки — уже принятый отчёт устройства; фон acceptClaims здесь не запускается, чтобы не подменять/вырезать его worker.
    await t.db.insert(schema.fedViaClaims).values({ userId: 'local', clientId: genuine.clientId!, conversationId: cid, payloadHash: claimHash(genuine) });
    await t.db.insert(schema.fedViaReports).values({ userId: 'local', reportedAt: new Date(now - 2 * hour) });
    await home.via.reconcileVia(B, now);
    assert.equal((await home.row('real')).authorId, 'local'); assert.equal((await home.row('real')).id, (await host.row('real')).id);
    assert.equal((await home.row('real')).viaState, 'confirmed'); assert.equal((await host.row('real')).viaState, 'confirmed');
    assert.equal(await home.row('extra'), undefined); assert.ok((await host.row('extra')).deletedAt); assert.equal((await host.row('extra')).content, '');
    assert.deepEqual(verdicts(home).map(v => `${v.messageId}:${v.verdict}`).sort(), ['extra:rejected', 'real:confirmed']);
    assert.deepEqual(home.audits.map(a => a.action), ['federation.dm_via_rejected']); assert.deepEqual(host.audits.map(a => a.action), ['federation.dm_via_forged']);
    assert.equal((await t.db.select().from(schema.fedViaPending)).length, 0); assert.equal((await t.db.select().from(schema.fedViaClaims)).length, 0);
    const exported = await home.changes.changesForPeer(B, 0, 100, A); assert.ok('items' in exported);
    const copied = exported.items.find(i => i.kind === shared.FED_CONV_CHANGE.msg && i.entityId === 'real'); assert.ok(copied?.entity);
    const receiver = moduleOf<typeof import('../src/federation/convAccept.js')>('federation/convAccept', {
      '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: remote.db }, '../db/schema.js': schema, '../conversations.js': host.c, '../convRules.js': rules,
    });
    const eventsBefore = host.events.length;
    await receiver.applyChange(A, B, copied.kind, cid, copied.entity);
    assert.equal((await remote.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, 'real'))).length, 1);
    assert.equal(host.events.length, eventsBefore, 'обычная доставка принятой той же id не создаёт повторный conv.change');
    await home.via.reconcileVia(B, now); assert.equal(home.sent.length, 2); assert.equal(host.audits.length, 1);
  } finally { await remote.close(); }
});
