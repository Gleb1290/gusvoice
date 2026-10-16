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
import * as groupRules from '../src/groupRules.js';
import * as userSearchRules from '../src/userSearchRules.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as linkService from '../src/federation/linkService.js';
import * as directoryRules from '../src/federation/directoryRules.js';
import * as identityRules from '../src/federation/instanceIdentity.js';
import * as signing from '../src/federation/signingKeys.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
type Mutations = { via?: Mutation; changes?: Mutation; accept?: Mutation; route?: Mutation };
type Identity = { instanceId: string; rootPublicKeyDer: Buffer; key: signing.SigningKeyPair };
const cid = 'group-via', F = shared.FED_FEATURES, now = Date.now();
let t: TestDb, H: Identity, M: Identity, E: Identity;
function identity(): Identity {
  const root = crypto.generateKeyPairSync('ed25519'), publicKey = root.publicKey.export({ type: 'spki', format: 'der' });
  return { instanceId: identityRules.instanceIdFrom(publicKey), rootPublicKeyDer: publicKey,
    key: signing.issueSigningKey(root.privateKey.export({ type: 'pkcs8', format: 'der' }), now) };
}
before(async () => { H = identity(); M = identity(); E = identity(); t = await createTestDb(); });
after(async () => {
  try { await t.close(); }
  finally {
    // harness импортирует db/index ради миграций: неиспользуемый PgPool тоже закрываем, даже при ошибке PGlite.
    const { pool } = await import('../src/db/index.js');
    await pool.end();
  }
});
const forbidden = (name: string) => () => { throw new Error(`неописанная IO-граница ${name}`); };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Целые модули, настоящий SQL и подписи Ed25519; IO без сценария немедленно запрещён. */
function moduleOf<T>(name: string, explicit: Record<string, unknown>, mutation?: Mutation): T {
  let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation) {
    assert.equal(source.split(mutation[0]).length - 1, 1, `единственный якорь ${name}`);
    source = source.replace(...mutation);
  }
  const deps: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly) continue;
    const id = (n.moduleSpecifier as ts.StringLiteral).text, out: Record<string, unknown> = {};
    const names = n.importClause?.namedBindings;
    if (names && ts.isNamedImports(names)) for (const item of names.elements) {
      if (!item.isTypeOnly) out[item.propertyName?.text ?? item.name.text] = forbidden(`${id}.${item.name.text}`);
    }
    deps[id] = out;
  }
  Object.assign(deps, explicit);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Date, Buffer, URL, Map, Set, Promise, Error, crypto,
    console: { warn: () => {} }, setTimeout: forbidden('таймер'), setInterval: forbidden('worker'),
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `явный импорт ${name}:${id}`); return deps[id]; },
  });
  return module.exports as T;
}

async function fixture(options: { self?: Identity; origin?: string | null; features?: string[]; mutations?: Mutations } = {}) {
  await truncateAll(t.raw);
  const self = options.self ?? H, origin = options.origin ?? null, mutations = options.mutations ?? {};
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'group_via_local', displayName: 'Местный', passwordHash: 'fixture', verified: true, approvedAt: new Date(now) },
    { id: 'shadow', username: 'group_via_shadow', displayName: 'Автор М', passwordHash: 'fixture', homeInstanceId: M.instanceId, homeUserId: 'm-user' },
    { id: 'e', username: 'group_via_e', displayName: 'Участник Е', passwordHash: 'fixture', homeInstanceId: E.instanceId, homeUserId: 'e-user' },
    { id: 'h', username: 'group_via_h', displayName: 'Хост', passwordHash: 'fixture', homeInstanceId: H.instanceId, homeUserId: 'h-user' },
    { id: 'outsider', username: 'group_via_outsider', displayName: 'Не участник', passwordHash: 'fixture' },
  ]);
  for (const [id, domain] of [[H, 'h.invalid'], [M, 'm.invalid'], [E, 'e.invalid']] as const) {
    if (id.instanceId === self.instanceId) continue;
    await t.db.insert(schema.federationLinks).values({ instanceId: id.instanceId, domain, apiBase: `https://${domain}`, clientOrigin: `https://${domain}`,
      rootKey: id.rootPublicKeyDer.toString('base64url'), state: 'active', features: options.features ?? [F.guests, F.dm1, F.dm3, F.dm4, F.dmgroup1, F.dmgroup2] });
  }
  await t.db.insert(schema.conversations).values([{ id: cid, kind: 'group', title: 'Группа', groupVersion: 1, originInstanceId: origin, createdBy: 'local' },
    { id: 'via-saved', kind: 'direct', directKey: 'local:local', createdBy: 'local' }]);
  await t.db.insert(schema.conversationMembers).values([
    { conversationId: cid, userId: 'local', role: 'owner' }, { conversationId: cid, userId: 'shadow' }, { conversationId: cid, userId: 'e' },
    ...(origin ? [{ conversationId: cid, userId: 'h' }] : []), { conversationId: 'via-saved', userId: 'local' },
  ]);
  const common = { 'drizzle-orm': orm, '@gusvoice/shared': shared };
  const backend = { ...common, './db/index.js': { db: t.db }, './db/schema.js': schema };
  const fed = { ...common, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const federation = { identity: () => self, signingKey: () => self.key };
  let paused = false;
  const meta = { readInstanceMeta: async () => ({ paused, name: 'Тестовый дом' }) };
  const links = moduleOf<typeof import('../src/federation/links.js')>('federation/links', { ...fed, 'node:crypto': crypto,
    './linkService.js': linkService, './instance.js': { federation }, './outbox.js': { queueDepth: async () => 0 }, './instanceMeta.js': meta });
  const labels = moduleOf<typeof import('../src/federation/instanceLabels.js')>('federation/instanceLabels', { ...common,
    './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta });
  await labels.refreshInstanceLabels();
  const threats = moduleOf<typeof import('../src/linkThreats.js')>('linkThreats', { './env.js': { env: { linkThreats: { enabled: false } } } });
  const serializer = moduleOf<typeof import('../src/serialize.js')>('serialize', { ...common, './federation/instanceLabels.js': labels, './linkThreats.js': threats });
  const events: Array<{ userId: string; event: shared.GatewayServerMessage }> = [];
  const changes = moduleOf<typeof import('../src/federation/convChanges.js')>('federation/convChanges', fed, mutations.changes);
  const c = moduleOf<typeof import('../src/conversations.js')>('conversations', { ...backend, './convRules.js': rules, './serialize.js': serializer,
    './dmWriteBarrier.js': { dmWriteBarrier: {} }, './util.js': { uuidv7: crypto.randomUUID }, './env.js': { env: { publicApiUrl: 'https://self.invalid' } },
    './attachments.js': { privateAttachmentsReady: () => true, attachmentLink: (id: string) => `/fixture/${id}`, purgeDeleted: async () => {} },
    './realtime.js': { publishToUser: async (userId: string, event: shared.GatewayServerMessage) => { events.push({ userId, event }); } },
  });
  c.configureFederatedConv({ selfInstanceId: () => self.instanceId, record: changes.recordFedConvChanges });
  const groupFor = (id: Identity) => moduleOf<typeof import('../src/federation/convGroup.js')>('federation/convGroup', { ...fed,
    'node:crypto': crypto, '../conversations.js': c, '../groupRules.js': groupRules, '../userSearchRules.js': userSearchRules,
    './instance.js': { federation: { identity: () => id, signingKey: () => id.key } }, './instanceIdentity.js': identityRules, './signingKeys.js': signing,
    './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta,
  });
  const group = groupFor(self);
  changes.configureFedGroupSigner(group.signOwnMessage);
  const accept = moduleOf<typeof import('../src/federation/convAccept.js')>('federation/convAccept', { ...fed,
    '../conversations.js': c, '../convRules.js': rules, './instance.js': { federation },
  }, mutations.accept);
  accept.configureFedGroupAccept({ applyConv: group.applyGroupConv, verify: group.verifyMessageSig });
  const identityTokens = moduleOf<typeof import('../src/federation/identityToken.js')>('federation/identityToken', { ...common, 'node:crypto': crypto });
  const guestHome = moduleOf<typeof import('../src/federation/guestHome.js')>('federation/guestHome', { ...fed,
    './instance.js': { federation }, './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta,
    './directoryRules.js': directoryRules, './identityToken.js': identityTokens });
  const cache = new Map<string, string>(), sent: Array<{ peer: string; kind: string; payload: unknown }> = [], requests: string[] = [];
  let page = shared.serializeViaPage([]);
  const via = moduleOf<typeof import('../src/federation/convVia.js')>('federation/convVia', { ...fed,
    '../conversations.js': c, '../convRules.js': rules, './convChanges.js': changes, './guestHome.js': guestHome,
    './instance.js': { federation }, './instanceMeta.js': meta, './linkRules.js': linkRules, './links.js': links,
    './auditLog.js': { fedAudit: () => {} }, './directorySync.js': { refreshCapabilities: async (row: { features: string[] }) => row.features },
    '../realtime.js': { redisPub: { get: async (k: string) => cache.get(k) ?? null, set: async (k: string, v: string) => { cache.set(k, v); } } },
    '../safeFetch.js': { safePeerRequest: async (request: { url: string }) => { requests.push(request.url); return { status: 200,
      body: JSON.stringify(shared.serializeGuestSession({ userId: 'host-shadow', token: 'fixture-guest-session', expiresAt: now + 8 * 86400_000 })) }; } },
    './peerClient.js': { getSignedFromPeer: async () => ({ ok: true, value: { status: 200, body: JSON.stringify(page) } }) },
    './eventStream.js': { sendEventTo: async (peer: string, kind: string, payload: unknown) => { sent.push({ peer, kind, payload }); } },
  }, mutations.via);
  const att = moduleOf<typeof import('../src/routes/att.js')>('routes/att', { ...common, zod: { z } });
  const blocks = moduleOf<typeof import('../src/blocks.js')>('blocks', backend);
  const route = moduleOf<typeof import('../src/routes/conv.js')>('routes/conv', { ...fed, zod: { z },
    '../conversations.js': c, '../convRules.js': rules, '../dmRules.js': dmRules, '../blockRules.js': blockRules, '../blocks.js': blocks, './att.js': att,
    '../auth.js': { requireAuth: async (req: { headers: Record<string, unknown>; user?: { sub: string } }) => { req.user = { sub: String(req.headers['x-fixture-user'] ?? 'local') }; } },
    '../authGuard.js': { messageSendBlock: async () => 0, rateHit: async () => 0 },
  }, mutations.route);
  route.configureFedVia({ gate: via.viaGate, isShadow: via.isShadowUser, fallback: (me, id, purpose) => via.fallbackFor(me, id, undefined, purpose), claims: via.acceptClaims });
  const access = async (me = 'local', id = cid) => { const a = await c.loadAccess(id, me); assert.ok(a); return a; };
  const row = async (id = 'via-message') => { const r = (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, id)))[0]; assert.ok(r); return r; };
  return { self, c, changes, group, groupFor, accept, via, route, access, row, events, sent, requests, setPage: (p: typeof page) => { page = p; }, pause: () => { paused = true; } };
}
function messageWire(self: Identity, author = 'local', id = 'via-message'): shared.FedConvMessageWire {
  return { id, conversationId: cid, author: { instanceId: self.instanceId, userId: author }, clientId: crypto.randomUUID(), payloadHash: null,
    createdAt: now - 60_000, originSortKey: 1, content: 'Текст через хост', replyToId: null, forwardedFrom: null, silent: false,
    noPreview: false, captionAbove: false, replyQuote: null, sticker: null, service: null, attachments: [], editVersion: 0, editedAt: null, deleted: false };
}
async function insertPending(f: Awaited<ReturnType<typeof fixture>>, id = 'via-message', author = 'shadow') {
  const r = await f.c.sendMessage(author, await f.access(author), { clientId: crypto.randomUUID(), content: 'Текст через хост', attachments: [], replyToId: null,
    withheld: false, id, createdAt: new Date(now - 60_000), via: { instanceId: M.instanceId, state: 'pending' } });
  assert.equal(r.kind, 'created'); return r;
}
async function record(f: Awaited<ReturnType<typeof fixture>>, id = 'via-message') {
  await t.db.transaction(async tx => f.changes.recordFedConvChanges(tx as never, [{ conversationId: cid, kind: 'msg', entityId: id }]));
}
async function appFor(f: Awaited<ReturnType<typeof fixture>>) { const app = Fastify(); await app.register(f.route.convRoutes); await app.ready(); return app; }
const verdicts = (f: Awaited<ReturnType<typeof fixture>>) => f.sent.map(s => { const v = shared.parseViaVerdict(s.payload); assert.ok(v); return { peer: s.peer, ...v }; });

it('R208 тень пишет через свой дом на хосте группы при dm4 и dmgroup2; местный идёт обычным путём', async () => {
  const f = await fixture();
  const gate = await f.via.viaGate('shadow', await f.access('shadow'));
  assert.equal(typeof gate, 'object'); assert.equal(gate && gate !== 'refused' ? gate.instanceId : null, M.instanceId);
  assert.equal(await f.via.viaGate('local', await f.access()), null);
});
async function gateFeatures(mutation?: Mutation) {
  const f = await fixture({ features: [F.guests, F.dm4, F.dmgroup1], mutations: { via: mutation } });
  assert.equal(await f.via.viaGate('shadow', await f.access('shadow')), 'refused', 'C: группе нужен dmgroup2 для через');
}
it('R208 dmgroup1 не заменяет dmgroup2 при входе тени через хост', async () => { await gateFeatures(); });
async function gateDm4(mutation?: Mutation) {
  const f = await fixture({ features: [F.guests, F.dmgroup2], mutations: { via: mutation } });
  assert.equal(await f.via.viaGate('shadow', await f.access('shadow')), 'refused', 'C: через группы требует dm4');
}
it('R208 группа без dm4, без связки или с закрытой связкой не открывает через', async () => {
  for (const features of [[F.guests, F.dmgroup2], [F.guests, F.dmgroup1]]) {
    const f = await fixture({ features }); assert.equal(await f.via.viaGate('shadow', await f.access('shadow')), 'refused');
  }
  const f = await fixture();
  await t.db.update(schema.federationLinks).set({ state: 'broken' }).where(orm.eq(schema.federationLinks.instanceId, M.instanceId));
  assert.equal(await f.via.viaGate('shadow', await f.access('shadow')), 'refused');
  await t.db.delete(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, M.instanceId));
  assert.equal(await f.via.viaGate('shadow', await f.access('shadow')), 'refused');
});
async function gateForeign(mutation?: Mutation) {
  const f = await fixture({ origin: E.instanceId, mutations: { via: mutation } });
  const gate = await f.via.viaGate('shadow', await f.access('shadow'));
  assert.equal(gate === 'refused', true, 'C: тень не пишет через чужого хоста');
}
it('R208 тень не пишет через группу чужого хоста даже со всеми признаками', async () => { await gateForeign(); });
it('R208 удалённая тень и аварийная пауза не открывают через в группе', async () => {
  const f = await fixture(); await t.db.update(schema.users).set({ deletedAt: new Date() }).where(orm.eq(schema.users.id, 'shadow'));
  assert.equal(await f.via.viaGate('shadow', await f.access('shadow')), 'refused');
  await t.db.update(schema.users).set({ deletedAt: null }).where(orm.eq(schema.users.id, 'shadow')); f.pause();
  assert.equal(await f.via.viaGate('shadow', await f.access('shadow')), 'refused');
});

async function fallback(mutation?: Mutation) {
  const f = await fixture({ self: M, origin: H.instanceId, mutations: { via: mutation } });
  const ok = await f.via.fallbackFor('local', cid, now);
  assert.equal(ok.status, 200, 'C: чужая группа получает сессию только на хосте');
  assert.equal(ok.body.instanceId, H.instanceId); assert.equal(new URL(String(ok.body.apiBase)).hostname, 'h.invalid');
  assert.deepEqual(f.requests, ['https://h.invalid/api/fed/v1/session']);
  const grants = await t.db.select().from(schema.federationGuestGrants);
  assert.equal(grants.length, 1); assert.equal(grants[0]!.instanceId, H.instanceId);
  assert.equal((await f.via.fallbackFor('local', cid, now, 'call')).status, 404, 'C: звонок в группе не получает сессию');
  assert.equal((await f.via.fallbackFor('shadow', cid, now)).status, 404);
  assert.equal((await f.via.fallbackFor('outsider', cid, now)).status, 404);
}
it('R208 fallback чужой группы создаёт сессию и поручительство только хосту, не третьему дому', async () => { await fallback(); });
async function fallbackFeature(mutation?: Mutation) {
  const f = await fixture({ self: M, origin: H.instanceId, features: [F.guests, F.dm4, F.dmgroup1], mutations: { via: mutation } });
  const res = await f.via.fallbackFor('local', cid, now);
  assert.equal(res.status, 409, 'C: fallback требует dmgroup2 хоста'); assert.equal(res.body.error, shared.FED_ERRORS.unsupported);
  assert.equal(f.requests.length, 0);
}
it('R208 fallback отказывает 409 unsupported хосту без dmgroup2 до выпуска сессии', async () => { await fallbackFeature(); });
it('R208 fallback собственной группы и Избранного отвечает 404 без запроса сессии', async () => {
  const f = await fixture();
  assert.equal((await f.via.fallbackFor('local', cid, now)).status, 404);
  assert.equal((await f.via.fallbackFor('local', 'via-saved', now)).status, 404); assert.equal(f.requests.length, 0);
});
async function fallbackOwn(mutation?: Mutation) {
  const f = await fixture({ mutations: { via: mutation } });
  assert.equal((await f.via.fallbackFor('local', cid, now)).status, 404, 'C: собственная группа не имеет fallback');
  assert.equal(f.requests.length, 0);
}

async function fetchHost(mutation?: Mutation) {
  const f = await fixture({ self: M, origin: H.instanceId, mutations: { via: mutation } });
  const w = messageWire(M); f.setPage(shared.serializeViaPage([shared.serializeConvMessageWire(w)]));
  await f.via.reconcileVia(H.instanceId, now);
  const pending = await t.db.select().from(schema.fedViaPending);
  assert.equal(pending.length, 1, 'C: через от хоста группы становится pending');
  assert.equal(pending[0]!.instanceId, H.instanceId); assert.equal(pending[0]!.authorId, 'local');
  assert.equal(pending[0]!.messageId, w.id); assert.deepEqual(verdicts(f), []);
}
it('R208 сверка ставит pending текст нашего автора только от хоста его группы', async () => { await fetchHost(); });
async function fetchWrong(mutation?: Mutation) {
  const f = await fixture({ self: M, origin: E.instanceId, mutations: { via: mutation } });
  const w = messageWire(M); f.setPage(shared.serializeViaPage([shared.serializeConvMessageWire(w)]));
  await f.via.reconcileVia(H.instanceId, now);
  assert.equal((await t.db.select().from(schema.fedViaPending)).length, 0, 'C: чужой источник группы не становится pending');
  assert.deepEqual(verdicts(f), [{ peer: H.instanceId, conversationId: cid, messageId: w.id, verdict: 'rejected' }]);
}
it('R208 сверка отвергает через от не-хоста этой группы и возвращает rejected источнику', async () => { await fetchWrong(); });
it('R208 сверка не ручается за отсутствующую группу или неучастника; третьего автора не решает', async () => {
  const f = await fixture({ self: M, origin: H.instanceId });
  const missing = { ...messageWire(M, 'local', 'missing'), conversationId: 'unknown-group' };
  const outsider = messageWire(M, 'outsider', 'outsider');
  const third = messageWire(E, 'e-user', 'third');
  f.setPage(shared.serializeViaPage([missing, outsider, third].map(shared.serializeConvMessageWire)));
  await f.via.reconcileVia(H.instanceId, now);
  assert.equal((await t.db.select().from(schema.fedViaPending)).length, 0);
  assert.deepEqual(verdicts(f).map(v => v.messageId).sort(), ['missing', 'outsider']);
});

async function pendingRouting(mutation?: Mutation) {
  const f = await fixture({ mutations: { changes: mutation } }); await insertPending(f); await record(f);
  assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 0, 'C: pending не уходит ни одному дому');
  const ours = await f.via.pendingFor(M.instanceId, H.instanceId), others = await f.via.pendingFor(E.instanceId, H.instanceId);
  assert.equal(shared.parseViaPage(ours)?.length, 1); assert.equal(shared.parseViaPage(others)?.length, 0);
}
it('R208 pending не попадает в журнал ни одного дома и доступно только дому автора для сверки', async () => { await pendingRouting(); });
async function confirmed(mutations: Mutations = {}) {
  const f = await fixture({ mutations }); await insertPending(f);
  const w = messageWire(M, 'm-user'), sig = f.groupFor(M).signOwnMessage(w); assert.ok(sig);
  const entity = { ...shared.serializeConvMessageWire(w), sig };
  assert.equal(f.group.verifyMessageSig(w, entity), true);
  await f.accept.applyChange(M.instanceId, H.instanceId, 'msg', cid, entity);
  const row = await f.row();
  assert.equal(row.viaState, 'confirmed', 'C: подписанная копия подтверждает через');
  assert.equal(!!row.originSig, true, 'C: подписанная копия сохраняет подпись автора');
  assert.deepEqual(row.originSig, sig);
  const out = await t.db.select().from(schema.fedConvChanges);
  assert.deepEqual(out.map(r => r.instanceId === E.instanceId ? 'E' : r.instanceId === M.instanceId ? 'M' : '?').sort(), ['E'], 'C: confirmed уходит третьему дому без эха автору');
  const page = await f.changes.changesForPeer(E.instanceId, 0, 100, H.instanceId); assert.ok('items' in page);
  const exported = page.items.find(i => i.entityId === w.id)?.entity;
  assert.equal(!!exported?.sig, true, 'C: третьему дому экспортируется подпись автора');
  assert.deepEqual(clone(exported!.sig), sig);
  const parsed = shared.parseConvMessageWire(exported); assert.ok(parsed, 'экспортированное сообщение разбирается настоящим проводом');
  assert.equal(parsed.author.instanceId, M.instanceId); assert.equal(parsed.author.userId, 'm-user');
  assert.equal(parsed.content, w.content); assert.equal(parsed.editVersion, w.editVersion); assert.equal(parsed.replyToId, w.replyToId);
  assert.equal(parsed.createdAt, w.createdAt);
  // Подпись должна проверяться на фактически отданном сообщении, а не на сохранённом до SQL исходнике.
  assert.equal(f.group.verifyMessageSig(parsed, exported!), true, 'третьему дому отданы именно подписанные поля сообщения');
  const authorPage = await f.changes.changesForPeer(M.instanceId, 0, 100, H.instanceId); assert.ok('items' in authorPage); assert.equal(authorPage.items.length, 0);
  const count = (await t.db.select().from(schema.userChanges)).length;
  await f.accept.applyChange(M.instanceId, H.instanceId, 'msg', cid, entity);
  assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 1);
  assert.equal((await t.db.select().from(schema.userChanges)).length, count);
}
it('R208 подписанная копия ставит origin_sig и confirmed, затем уходит третьему дому с подписью без эха автору', async () => { await confirmed(); });
async function wrongHome(mutation?: Mutation) {
  const f = await fixture({ mutations: { accept: mutation } }); await insertPending(f);
  await t.db.update(schema.conversationMessages).set({ viaInstanceId: E.instanceId }).where(orm.eq(schema.conversationMessages.id, 'via-message'));
  const w = messageWire(M, 'm-user'), sig = f.groupFor(M).signOwnMessage(w); assert.ok(sig);
  await f.accept.applyChange(M.instanceId, H.instanceId, 'msg', cid, { ...shared.serializeConvMessageWire(w), sig });
  const row = await f.row();
  assert.equal(!!row.originSig, false, 'C: другой дом не подменяет подпись через');
  assert.equal(row.viaState, 'pending'); assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 0);
}
it('R208 копия от другого дома не меняет origin_sig и не подтверждает ожидающее через', async () => { await wrongHome(); });
async function signatureOverwrite(mutation?: Mutation) {
  const f = await fixture({ mutations: { accept: mutation } }); await insertPending(f);
  const w = messageWire(M, 'm-user'), sig = f.groupFor(M).signOwnMessage(w); assert.ok(sig);
  await t.db.update(schema.conversationMessages).set({ originSig: sig, viaState: 'confirmed' }).where(orm.eq(schema.conversationMessages.id, w.id));
  const other = { ...w, content: 'Другое содержимое при той же версии' }, otherSig = f.groupFor(M).signOwnMessage(other); assert.ok(otherSig);
  await f.accept.applyChange(M.instanceId, H.instanceId, 'msg', cid, { ...shared.serializeConvMessageWire(other), sig: otherSig });
  assert.equal((await f.row()).originSig?.value === sig.value, true, 'C: равная версия не заменяет уже сохранённую подпись');
  assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 0);
}
it('R208 уже сохранённая подпись не заменяется другой верной подписью сообщения равной версии', async () => { await signatureOverwrite(); });
it('R208 отсутствие подписи и изменение текста после подписания не подтверждают через', async () => {
  const f = await fixture(); await insertPending(f);
  const w = messageWire(M, 'm-user'), sig = f.groupFor(M).signOwnMessage(w); assert.ok(sig);
  await f.accept.applyChange(M.instanceId, H.instanceId, 'msg', cid, shared.serializeConvMessageWire(w));
  await f.accept.applyChange(M.instanceId, H.instanceId, 'msg', cid, { ...shared.serializeConvMessageWire({ ...w, content: 'Подмена' }), sig });
  assert.equal((await f.row()).originSig, null); assert.equal((await f.row()).viaState, 'pending');
  assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 0);
});

type WriteKind = 'правка' | 'удаление' | 'реакция';
function request(kind: WriteKind, me: string): InjectOptions {
  const url = `/conv/${cid}/messages/${me}-message`, headers = { 'x-fixture-user': me };
  if (kind === 'правка') return { method: 'PATCH', url, headers, payload: { content: 'Правка' } };
  if (kind === 'удаление') return { method: 'DELETE', url: `${url}?for=both`, headers };
  return { method: 'POST', url: `${url}/reactions`, headers, payload: { emoji: '👍', op: 'add' } };
}
async function guardedWrite(kind: WriteKind, mutation?: Mutation) {
  const f = await fixture({ mutations: { route: mutation } });
  await insertPending(f, 'shadow-message'); await insertPending(f, 'local-message', 'local');
  const app = await appFor(f);
  try {
    const before = JSON.stringify(await f.row('shadow-message'));
    const denied = await app.inject(request(kind, 'shadow'));
    assert.equal(denied.statusCode, 403, `C: тени закрыта ${kind} в группе`); assert.equal(denied.json().error, shared.FED_ERRORS.dmViaLimited);
    assert.equal(JSON.stringify(await f.row('shadow-message')), before); assert.equal(f.events.length, 0);
    assert.equal((await t.db.select().from(schema.conversationMessageReactions)).length, 0);
    const ok = await app.inject(request(kind, 'local'));
    assert.equal(ok.statusCode, kind === 'правка' ? 200 : 204, 'парное действие местному доступно');
    assert.ok(f.events.length > 0, 'местный результат доходит обычным conv.change');
    const local = await f.row('local-message');
    if (kind === 'правка') {
      assert.equal(local.content, 'Правка', 'местная правка действительно меняет SQL');
      assert.equal(local.editVersion, 1); assert.ok(local.editedAt); assert.equal(local.deletedAt, null);
    } else if (kind === 'удаление') {
      assert.ok(local.deletedAt, 'местное удаление действительно ставит SQL-надгробие');
      assert.equal(local.content, ''); assert.deepEqual(local.attachments, []);
    } else {
      const reactions = await t.db.select().from(schema.conversationMessageReactions);
      assert.deepEqual(reactions.map(r => ({ messageId: r.messageId, userId: r.userId, emoji: r.emoji })),
        [{ messageId: 'local-message', userId: 'local', emoji: '👍' }], 'местная реакция действительно вставляется в SQL');
      assert.equal(local.deletedAt, null); assert.equal(local.content, 'Текст через хост');
    }
    assert.equal(JSON.stringify(await f.row('shadow-message')), before, 'парное местное действие не меняет теневое сообщение');
  } finally { await app.close(); }
}
for (const kind of ['правка', 'удаление', 'реакция'] as const) it(`R208 ${kind} в группе закрыта тени без через, местному доступна`, async () => { await guardedWrite(kind); });

/** Регрессия считается пойманной только ожидаемым host AssertionError с известными actual/expected. */
async function killed(run: (mutation?: Mutation) => Promise<void>, mutation: Mutation, label: string, actual: unknown, expected: unknown) {
  await run();
  await assert.rejects(() => run(mutation), (err: unknown) => err instanceof assert.AssertionError && err.message.startsWith(label)
    && JSON.stringify(err.actual) === JSON.stringify(actual) && JSON.stringify(err.expected) === JSON.stringify(expected));
}
it('R208 контрфакт: через группы не заменяет dmgroup2 старым dmgroup1', async () => {
  await killed(gateFeatures, ['!(await hasFeature(groupLink, FED_FEATURES.dmgroup2, Date.now()))', '!(await hasFeature(groupLink, FED_FEATURES.dmgroup1, Date.now()))'], 'C: группе нужен dmgroup2 для через', { instanceId: M.instanceId }, 'refused');
});
it('R208 контрфакт: наличие dmgroup2 не подменяет необходимый dm4', async () => {
  await killed(gateDm4, ['!groupLink || !(await hasDm4(groupLink, Date.now())) ||', '!groupLink ||'], 'C: через группы требует dm4', { instanceId: M.instanceId }, 'refused');
});
it('R208 контрфакт: через тени требует, чтобы группа размещалась здесь', async () => {
  await killed(gateForeign, ["if ((await groupHostOf(access.conversationId)) !== null) return 'refused';", ''], 'C: тень не пишет через чужого хоста', false, true);
});
it('R208 контрфакт: fallback группы проверяет dmgroup2 до сессии', async () => {
  await killed(fallbackFeature, ['if (found.group && !(await hasFeature(link, FED_FEATURES.dmgroup2, now))) return', 'if (false) return'], 'C: fallback требует dmgroup2 хоста', 200, 409);
});
it('R208 контрфакт: fallback группы не разрешает звонок', async () => {
  await killed(fallback, ["if (found.group && purpose !== 'via') return", 'if (false) return'], 'C: звонок в группе не получает сессию', 409, 404);
});
it('R208 контрфакт: своя группа лежит вместе с домом и не открывает fallback', async () => {
  await killed(fallbackOwn, ["if (!mine || mine.home !== null || !host) return", "if (!mine || mine.home !== null) return"], 'C: собственная группа не имеет fallback', 409, 404);
});
it('R208 контрфакт: сверка не отбрасывает свой текст группы вместо pending', async () => {
  await killed(fetchHost, ["(groupHost !== instanceId && (access.kind !== 'direct' || peerHome !== instanceId))", "(access.kind !== 'direct' || peerHome !== instanceId)"], 'C: через от хоста группы становится pending', 0, 1);
});
it('R208 контрфакт: сверка требует совпадения origin группы с источником', async () => {
  await killed(fetchWrong, ["(groupHost !== instanceId && (access.kind !== 'direct' || peerHome !== instanceId))", "(false && (access.kind !== 'direct' || peerHome !== instanceId))"], 'C: чужой источник группы не становится pending', 1, 0);
});
it('R208 контрфакт: pending не попадает третьему дому до подписанной копии', async () => {
  await killed(pendingRouting, ['&& !pendingVia.has(i.entityId) &&', '&&'], 'C: pending не уходит ни одному дому', 2, 0);
});
it('R208 контрфакт: копия не теряет confirmed при сохранении подписи', async () => {
  await killed(m => confirmed({ accept: m }), ["set({ originSig, viaState: 'confirmed' })", "set({ originSig, viaState: 'pending' })"], 'C: подписанная копия подтверждает через', 'pending', 'confirmed');
});
it('R208 контрфакт: копия не теряет origin_sig при подтверждении', async () => {
  await killed(m => confirmed({ accept: m }), ["set({ originSig, viaState: 'confirmed' })", "set({ viaState: 'confirmed' })"], 'C: подписанная копия сохраняет подпись автора', false, true);
});
it('R208 контрфакт: подтверждение копии обязательно пишет федерационный журнал', async () => {
  await killed(m => confirmed({ accept: m }), ['const viaPts = await journal(tx, msgEntries(viaAudience, conversationId, row.id), { fed: true });', 'const viaPts = await journal(tx, msgEntries(viaAudience, conversationId, row.id), { fed: false });'], 'C: confirmed уходит третьему дому без эха автору', [], ['E']);
});
it('R208 контрфакт: confirmed не возвращает сообщение дому автора', async () => {
  await killed(m => confirmed({ changes: m }), ['(foreignHome.get(i.entityId) !== home || serviceIds.has(i.entityId))', 'true'], 'C: confirmed уходит третьему дому без эха автору', ['E', 'M'], ['E']);
});
it('R208 контрфакт: третьему дому передаётся origin_sig автора, а не пустота', async () => {
  await killed(m => confirmed({ changes: m }), ['people.get(m.authorId)?.homeInstanceId ? m.originSig : (groupSigner?.(w) ?? null)', 'people.get(m.authorId)?.homeInstanceId ? null : (groupSigner?.(w) ?? null)'], 'C: третьему дому экспортируется подпись автора', false, true);
});
it('R208 контрфакт: подпись подтверждения относится к ожидаемому дому через', async () => {
  await killed(wrongHome, ['originSig && row.viaInstanceId === peer && !row.originSig', 'originSig && !row.originSig'], 'C: другой дом не подменяет подпись через', true, false);
});
it('R208 контрфакт: равная версия не заменяет уже сохранённую подпись', async () => {
  await killed(signatureOverwrite, ['originSig && row.viaInstanceId === peer && !row.originSig', 'originSig && row.viaInstanceId === peer'], 'C: равная версия не заменяет уже сохранённую подпись', false, true);
});
for (const kind of ['правка', 'удаление', 'реакция'] as const) it(`R208 контрфакт: удаление групповой защиты открывает тени ${kind}`, async () => {
  await killed(m => guardedWrite(kind, m), ['if (fedVia && groupActor && !opts.viaOk && (await fedVia.isShadow(groupActor))) {', 'if (false) {'], `C: тени закрыта ${kind} в группе`, kind === 'правка' ? 200 : 204, 403);
});
