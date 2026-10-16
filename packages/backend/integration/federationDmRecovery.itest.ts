import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, it } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as linkService from '../src/federation/linkService.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as guards from '../src/federation/guards.js';
import * as admission from '../src/routes/fedAdmission.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
const self = 'a'.repeat(32), peer = 'b'.repeat(32), third = 'c'.repeat(32), cid = 'recovery-conv';
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t.close(); });
const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fail = (name: string) => () => { throw new Error(`неописанная IO-граница ${name}`); };
function moduleOf<T>(name: string, explicit: Record<string, unknown>, clock: { now: number }, warns: string[], mutation?: Mutation): T {
  let raw = source(name);
  if (mutation) { assert.equal(raw.split(mutation[0]).length - 1, 1, `единственный якорь ${name}`); raw = raw.replace(...mutation); }
  const deps: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly) continue;
    const id = (n.moduleSpecifier as ts.StringLiteral).text, exports: Record<string, unknown> = {};
    const names = n.importClause?.namedBindings;
    if (names && ts.isNamedImports(names)) for (const item of names.elements) if (!item.isTypeOnly) exports[item.propertyName?.text ?? item.name.text] = fail(`${id}.${item.name.text}`);
    deps[id] = exports;
  }
  Object.assign(deps, explicit);
  class ClockDate extends Date { constructor(value?: number | string) { super(value ?? clock.now); } static now() { return clock.now; } }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Date: ClockDate, Map, Set, Promise, Buffer, URL,
    console: { warn: (value: unknown) => { warns.push(String(value)); } }, setTimeout: fail('таймер'), setInterval: fail('worker'),
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `явный импорт ${name}:${id}`); return deps[id]; },
  });
  return module.exports as T;
}
function inFunction(name: string, functionName: string, anchor: string, replacement: string): Mutation {
  const raw = source(name), ast = ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true);
  const matches = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === functionName);
  assert.equal(matches.length, 1); const body = matches[0].getText(ast);
  assert.equal(body.split(anchor).length - 1, 1); return [body, body.replace(anchor, replacement)];
}
const killed = (message: string) => (error: unknown) => error instanceof assert.AssertionError && error.message.includes(message);

async function fixture(mutation: { accept?: Mutation; open?: Mutation; changes?: Mutation; link?: Mutation; route?: Mutation } = {}, withConv = true) {
  await truncateAll(t.raw);
  const clock = { now: Date.now() }, warns: string[] = [];
  const m = <T>(name: string, deps: Record<string, unknown>, edit?: Mutation) => moduleOf<T>(name, deps, clock, warns, edit);
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'recovery_local', displayName: 'Местный', passwordHash: 'fixture', verified: true, approvedAt: new Date(clock.now) },
    { id: 'shadow', username: 'recovery_shadow', displayName: 'Тень', passwordHash: 'fixture', verified: true, homeInstanceId: peer, homeUserId: 'remote', homeUsername: 'remote' },
  ]);
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: 'peer.invalid', apiBase: 'https://peer.invalid', clientOrigin: 'https://peer.invalid', rootKey: 'fixture-root', state: 'active', features: [shared.FED_FEATURES.dm1] });
  if (withConv) {
    await t.db.insert(schema.conversations).values({ id: cid, kind: 'direct', directKey: shared.fedDirectKey({ instanceId: self, userId: 'local' }, { instanceId: peer, userId: 'remote' }), createdBy: 'shadow', originInstanceId: peer });
    await t.db.insert(schema.conversationMembers).values([{ conversationId: cid, userId: 'local' }, { conversationId: cid, userId: 'shadow' }]);
  }
  const common = { '@gusvoice/shared': shared, 'drizzle-orm': orm };
  const backend = { ...common, './db/index.js': { db: t.db }, './db/schema.js': schema };
  const fed = { ...common, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const federation = { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'fixture', privateKeyDer: Buffer.alloc(0) }) };
  const meta = { readInstanceMeta: async () => ({ paused: false, name: 'Фикстура' }) };
  const links = m<typeof import('../src/federation/links.js')>('federation/links', { ...fed, './linkService.js': linkService, './outbox.js': { queueDepth: async () => 0 }, './instanceMeta.js': meta });
  const labels = m<typeof import('../src/federation/instanceLabels.js')>('federation/instanceLabels', { ...common, './links.js': links, './linkRules.js': linkRules, './instanceMeta.js': meta });
  await labels.refreshInstanceLabels();
  const threat = m<typeof import('../src/linkThreats.js')>('linkThreats', { './env.js': { env: { linkThreats: { enabled: false } } } });
  const serializer = m<typeof import('../src/serialize.js')>('serialize', { ...common, './federation/instanceLabels.js': labels, './linkThreats.js': threat });
  const changes = m<typeof import('../src/federation/convChanges.js')>('federation/convChanges', fed, mutation.changes);
  const events: Array<{ userId: string; event: shared.GatewayServerMessage }> = [];
  const c = m<typeof import('../src/conversations.js')>('conversations', {
    ...backend, './convRules.js': rules, './serialize.js': serializer, './util.js': { uuidv7: randomUUID }, './dmWriteBarrier.js': { dmWriteBarrier: {} },
    './realtime.js': { publishToUser: async (userId: string, event: shared.GatewayServerMessage) => { events.push({ userId, event }); } },
    './attachments.js': { privateAttachmentsReady: () => true, purgeDeleted: async () => {} },
  });
  const deliveries: Promise<void>[] = [];
  const trackedConv = { ...c, deliver: (d: Parameters<typeof c.deliver>[0]) => { const p = c.deliver(d); deliveries.push(p); return p; } };
  const link = m<typeof import('../src/federation/convLink.js')>('federation/convLink', { ...fed, '../conversations.js': c, './instanceMeta.js': meta }, mutation.link);
  c.configureFederatedConv({ selfInstanceId: () => self, record: changes.recordFedConvChanges, linkBroken: link.brokenHomes, linkStale: link.staleHomes });
  const setup = m<typeof import('../src/instanceSetup.js')>('instanceSetup', backend); await setup.setFedDmPolicy('shared');
  const counters = new Map<string, number>(), ttl = new Map<string, number>();
  const auth = m<typeof import('../src/authGuard.js')>('authGuard', {
    ...common, './authRules.js': await import('../src/authRules.js'), './pushRules.js': await import('../src/pushRules.js'),
    './realtime.js': { redisPub: { incr: async (key: string) => { const n = (counters.get(key) ?? 0) + 1; counters.set(key, n); return n; },
      expire: async (key: string, seconds: number) => { ttl.set(key, seconds); return 1; }, ttl: async (key: string) => ttl.get(key) ?? 3600 } },
  });
  const guest = m<typeof import('../src/federation/guestHost.js')>('federation/guestHost', { ...fed, 'node:crypto': { randomUUID }, './links.js': links, './instance.js': { federation } });
  const blocks = m<typeof import('../src/blocks.js')>('blocks', backend);
  const peers = m<typeof import('../src/db/peerQueries.js')>('db/peerQueries', { 'drizzle-orm': orm, './index.js': { db: t.db } });
  const requests: Array<{ path: string; query?: Record<string, unknown> }> = [], posts: Array<{ path: string; payload: Record<string, unknown> }> = [];
  const io = {
    get: async (_request: typeof requests[number]): Promise<{ ok: true; value: { status: number; body: string; retryAfter?: number } } | { ok: false; problem: string }> => ({ ok: true, value: { status: 200, body: JSON.stringify(shared.serializeConvChangesPage({ instanceId: peer, seq: 0, more: false, items: [] })) } }),
    post: async (_request: typeof posts[number]): Promise<{ ok: true; value: { status: number; body: string } } | { ok: false; problem: string }> => ({ ok: false, problem: 'unreachable' }),
  };
  const open = m<typeof import('../src/federation/convOpen.js')>('federation/convOpen', {
    ...fed, '../conversations.js': trackedConv, '../authGuard.js': auth, '../blocks.js': blocks, '../db/peerQueries.js': peers,
    '../instanceSetup.js': setup, '../dmRules.js': await import('../src/dmRules.js'), '../userSearchRules.js': await import('../src/userSearchRules.js'), '../util.js': { uuidv7: randomUUID },
    './guestHost.js': guest, './instance.js': { federation }, './links.js': links,
    './peerClient.js': { postSignedToPeer: async (request: typeof posts[number]) => { posts.push(request); return io.post(request); } },
  }, mutation.open);
  const fanout = m<typeof import('../src/convSendFanout.js')>('convSendFanout', { ...backend, './conversations.js': c, './authGuard.js': { pushBurst: async () => 'drop' }, './push.js': await import('../src/pushRules.js') });
  const accept = m<typeof import('../src/federation/convAccept.js')>('federation/convAccept', {
    ...fed, '../conversations.js': trackedConv, '../convRules.js': rules, '../convSendFanout.js': fanout, './convLink.js': link, './instance.js': { federation },
    './peerClient.js': { getSignedFromPeer: async (request: typeof requests[number]) => { requests.push(request); return io.get(request); } },
  }, mutation.accept);
  accept.configureFedConvRow(open.acceptConvRow);
  accept.configureFedConvAttachments({ remoteFor: fail('скачивание копии при отсутствии dm2'), kick: fail('worker копирования'), purge: fail('удаление объектов') });
  const limits = m<typeof import('../src/federation/guardsRuntime.js')>('federation/guardsRuntime', { '../authGuard.js': auth, './guards.js': guards });
  const seen: Array<number | null> = [];
  const route = m<typeof import('../src/routes/federation.js')>('routes/federation', {
    ...fed, '../env.js': { env: { federation: { enabled: true, dmEnabled: true } } }, '../federation/instance.js': { federation },
    './fedAdmission.js': admission, '../federation/guardsRuntime.js': limits, '../federation/convChanges.js': changes,
    '../federation/peerAuth.js': { authenticateLinkedPeer: async (_request: unknown, instanceId: string) => {
      const found = await links.getLink(instanceId); return found ? { ok: true, link: found } : { ok: false, status: 403, error: shared.FED_ERRORS.noLink };
    } },
  }, mutation.route);
  route.configureFedConvPeerSeen((_link, since) => { seen.push(since); });
  return { c, changes, link, open, accept, route, setup, clock, warns, io, requests, posts, events, counters, ttl, seen,
    settle: () => Promise.all(deliveries),
    cursor: async () => (await t.db.select().from(schema.fedConvCursor).where(orm.eq(schema.fedConvCursor.instanceId, peer)))[0]?.since ?? 0,
  };
}

function wire(id = 'remote-msg', conversationId = cid): shared.FedConvMessageWire {
  return { id, conversationId, author: { instanceId: peer, userId: 'remote' }, clientId: null, payloadHash: null, createdAt: Date.now(), originSortKey: 1,
    content: 'От соседа', replyToId: null, forwardedFrom: null, silent: false, noPreview: false, captionAbove: false, replyQuote: null, sticker: null, service: null,
    attachments: [], editVersion: 0, editedAt: null, deleted: false };
}
const convEntity = (id = cid) => shared.serializeConvWire({ id, kind: 'direct', originInstanceId: peer, createdAt: Date.now(), members: [{ instanceId: self, userId: 'local' }, { instanceId: peer, userId: 'remote' }], title: null });
const answer = (body: Record<string, unknown>, status = 200, retryAfter?: number) => ({ ok: true as const, value: { status, body: JSON.stringify(body), retryAfter } });
const page = (items: shared.FedConvChange[], seq: number) => answer(shared.serializeConvChangesPage({ instanceId: peer, seq, more: false, items }));
const item = (seq: number, kind: string = shared.FED_CONV_CHANGE.msg, conversationId = cid, entity: Record<string, unknown> = shared.serializeConvMessageWire(wire())) => ({ seq, kind, conversationId, entityId: kind === shared.FED_CONV_CHANGE.msg ? 'remote-msg' : null, entity });

async function routeBudget(path: 'changes' | 'export', mutation?: Mutation) {
  const f = await fixture({ route: mutation }); const app = Fastify(); await app.register(f.route.federationRoutes); await app.ready();
  try {
    f.counters.set(`rl:fed:convPull:${peer}`, 1199);
    const url = path === 'changes' ? `/fed/v1/conv/changes?instance_id=${peer}&since=0` : `/fed/v1/conv/${cid}/export?instance_id=${peer}`;
    const allowed = await app.inject({ url }); assert.equal(allowed.statusCode, 200);
    assert.equal(f.counters.get(`rl:fed:convPull:${peer}`), 1200, 'догонка расходует свой convPull, а не directory');
    assert.equal(f.counters.has(`rl:fed:directory:${peer}`), false); assert.equal(f.ttl.get(`rl:fed:convPull:${peer}`), undefined, 'существующий счётчик не обновляет окно');
    const refused = await app.inject({ url }); assert.equal(refused.statusCode, 429); assert.equal(refused.headers['retry-after'], '3600'); assert.equal(refused.json().error, 'rate-limited');
    assert.deepEqual(f.seen, [path === 'changes' ? 0 : null], 'отказанный запрос не подтверждает курсор соседа');
  } finally { await app.close(); }
}
for (const path of ['changes', 'export'] as const) it(`R201 ${path} разрешает 1200-й convPull, 1201-й закрывает; directory-мутант обнаружен`, async () => {
  await routeBudget(path);
  const name = path === 'changes' ? '/fed/v1/conv/changes' : '/fed/v1/conv/:id/export';
  const raw = source('routes/federation'), ast = ts.createSourceFile('routes/federation', raw, ts.ScriptTarget.Latest, true), bodies: ts.Node[] = [];
  function visit(n: ts.Node) { if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'get' && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === name) bodies.push(n.arguments[n.arguments.length - 1]); ts.forEachChild(n, visit); }
  visit(ast); assert.equal(bodies.length, 1); const body = bodies[0].getText(ast), anchor = "admitPeer(req, reply, q.instance_id, 'convPull')"; assert.equal(body.split(anchor).length - 1, 1);
  await assert.rejects(routeBudget(path, [body, body.replace(anchor, "admitPeer(req, reply, q.instance_id, 'directory')")]), killed('догонка расходует свой convPull'));
});

async function rowRetries(mutation?: Mutation) {
  const f = await fixture({ accept: mutation });
  f.io.get = async () => page([item(1, 'unknown', cid, {}), item(2, shared.FED_CONV_CHANGE.msg, 'missing', shared.serializeConvMessageWire(wire('remote-msg', 'missing'))), item(3, 'unknown', cid, {})], 3);
  assert.equal(await f.accept.pullConvChanges(peer), 1, 'курсор останавливается перед неприменённой строкой'); assert.equal(await f.cursor(), 1);
  for (let n = 0; n < 5; n++) { f.clock.now += 1000; assert.equal(await f.accept.pullConvChanges(peer), 1, 'частые звонки не сжигают пять попыток'); }
  for (let attempt = 2; attempt <= 4; attempt++) { f.clock.now += 30_000; assert.equal(await f.accept.pullConvChanges(peer), 1); }
  f.clock.now += 30_000; assert.equal(await f.accept.pullConvChanges(peer), 3); assert.equal(await f.cursor(), 3);
  assert.equal(f.warns.some(s => s.includes('пропущена после 5 попыток')), true); assert.equal((await t.db.select().from(schema.conversationMessages)).length, 0);
}
it('R201 отсутствующая беседа держит курсор seq−1, частые повторы не считаются; на пятой разнесённой попытке пропуск', async () => { await rowRetries(); });
for (const [name, anchor, replacement] of [['ранний курсор', 'stopAt = item.seq - 1;', 'stopAt = parsed.seq;'], ['одна попытка', 'const ROW_TRIES = 5;', 'const ROW_TRIES = 1;']] as const) it(`R201 ${name} не маскирует потерянную строку зелёным курсором`, async () => {
  await rowRetries(); await assert.rejects(rowRetries([anchor, replacement]), killed('курсор останавливается перед неприменённой строкой'));
});
it('R201 ошибка применения dm2-копии держит курсор четыре попытки, на пятой создаётся единственная заглушка', async () => {
  const f = await fixture(), w = wire(); w.content = ''; w.attachments = [{ id: 'file', name: 'a.txt', contentType: 'text/plain', size: 2, width: null, height: null, durationMs: null, waveform: null, asFile: false, spoiler: false, sha256: null }];
  f.io.get = async () => page([item(1, shared.FED_CONV_CHANGE.msg, cid, shared.serializeConvMessageWire(w))], 1);
  for (let attempt = 1; attempt <= 4; attempt++) { assert.equal(await f.accept.pullConvChanges(peer), 0); assert.equal((await t.db.select().from(schema.conversationMessages)).length, 0); f.clock.now += 30_000; }
  assert.equal(await f.accept.pullConvChanges(peer), 1); assert.equal(await f.cursor(), 1);
  const [row] = await t.db.select().from(schema.conversationMessages); assert.equal(row.id, w.id); assert.equal(row.content, f.accept.FED_ATTACHMENTS_LATER_TEXT); assert.equal(row.attachments.length, 0);
  assert.equal(f.events.length, 2); await f.accept.pullConvChanges(peer); assert.equal(f.events.length, 2);
});

async function policy(mutation?: Mutation) {
  const f = await fixture({ open: mutation }, false);
  assert.equal(await f.open.acceptConvRow(peer, self, cid, convEntity()), false, 'политика дома действует на незапрошенную беседу');
  assert.equal((await t.db.select().from(schema.conversations)).length, 0);
  await f.setup.setFedDmPolicy('anyone'); assert.equal(await f.open.acceptConvRow(peer, self, cid, convEntity()), true);
  assert.equal((await t.db.select().from(schema.conversations))[0].id, cid);
}
it('R201 строка conv соблюдает shared/anyone; принудительное anyone вместо политики обнаруживается', async () => {
  await policy(); await assert.rejects(policy(inFunction('federation/convOpen', 'acceptConvRow', "policy: mine ? 'anyone' : await fedDmPolicy(),", "policy: 'anyone',")), killed('политика дома действует на незапрошенную беседу'));
});
it('R201 отказ conv пропускает её сообщения без пяти повторов и не тормозит курсор следующей строки', async () => {
  const f = await fixture({}, false);
  f.io.get = async () => page([item(1, shared.FED_CONV_CHANGE.conv, cid, convEntity()), item(2)], 2);
  assert.equal(await f.accept.pullConvChanges(peer), 2); assert.equal(await f.cursor(), 2); assert.equal((await t.db.select().from(schema.conversations)).length, 0);
  assert.equal(f.warns.some(w => w.includes('повтор позже')), false);
  f.io.get = async () => page([item(3)], 3); assert.equal(await f.accept.pullConvChanges(peer), 3);
});
it('R201 askedIds после потерянного ответа принимает предложенную мной беседу без политики и снимает pending', async () => {
  const f = await fixture({}, false); const refused = await f.open.openFederatedDirect('local', { instanceId: peer, homeUserId: 'remote' }); assert.equal(refused.ok, false);
  const id = String(f.posts[0].payload.conversation_id); assert.ok(id);
  await t.db.update(schema.users).set({ hiddenFromPeers: true }).where(orm.eq(schema.users.id, 'local'));
  assert.equal(await f.open.acceptConvRow(peer, self, id, convEntity(id)), true, 'мой запрос обходит shared и скрытность от соседей');
  const members = await t.db.select().from(schema.conversationMembers).where(orm.eq(schema.conversationMembers.conversationId, id));
  assert.equal(members.find(m => m.userId === 'local')?.pending, false); assert.equal((await t.db.select().from(schema.conversations))[0].id, id);
  await f.settle();
});
it('R201 known от соседа открывается сразу и повторяет conv.open в фоне с той же id, своё происхождение не повторяет', async () => {
  const f = await fixture(); await t.db.update(schema.conversationMembers).set({ pending: true }).where(orm.eq(schema.conversationMembers.userId, 'local'));
  let reached!: () => void; const sent = new Promise<void>(r => { reached = r; });
  f.io.post = async request => { reached(); return answer(shared.serializeConvOpenResponse({ kind: 'exists', conversationId: String(request.payload.conversation_id), to: null })); };
  const opened = await f.open.openFederatedDirect('local', { instanceId: peer, homeUserId: 'remote' }); assert.ok(opened.ok); assert.equal(opened.conversationId, cid); assert.equal(opened.created, false);
  // Потерянный фоновый reask должен дать локальную ошибку, а не зависание всего гейта.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([sent, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new assert.AssertionError({ message: 'фоновый conv.open дошёл до транспортной границы' })), 5000);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].path, '/api/fed/v1/conv/open'); assert.equal(f.posts[0].payload.conversation_id, cid);
  await t.db.update(schema.conversations).set({ originInstanceId: self }); await t.db.update(schema.conversationMembers).set({ pending: true }).where(orm.eq(schema.conversationMembers.userId, 'local'));
  await f.open.openFederatedDirect('local', { instanceId: peer, homeUserId: 'remote' });
  // reaskPeer читает происхождение асинхронно; следующий реальный SELECT стоит после него в очереди PGlite.
  await t.db.select().from(schema.conversations); assert.equal(f.posts.length, 1);
  await f.settle();
});

for (const [retryAfter, wait] of [[undefined, 60], [180, 180], [7200, 3600]] as const) it(`R201 changes 429 retryAfter=${retryAfter ?? 'нет'} закрывает IO до ${wait} с, в точный срок повтор разрешён`, async () => {
  const f = await fixture(); let calls = 0; f.io.get = async () => ++calls === 1 ? answer({}, 429, retryAfter) : page([], 0);
  assert.equal(await f.accept.pullConvChanges(peer), null); f.clock.now += wait * 1000 - 1;
  assert.equal(await f.accept.pullConvChanges(peer), null); assert.equal(calls, 1);
  f.clock.now++; assert.equal(await f.accept.pullConvChanges(peer), 0); assert.equal(calls, 2);
});
async function passResume(mutation?: Mutation) {
  const f = await fixture({ accept: mutation }); let resets = 0, limited = false;
  f.io.get = async request => {
    if (request.path.endsWith('/changes')) return request.query?.since === 10 ? page([], 10) : answer(shared.serializeConvChangesPage({ instanceId: peer, reset: true, seq: ++resets === 1 ? 10 : 99 }));
    const after = request.query?.after ?? null;
    if (after === 'page2' && !limited) { limited = true; return answer({}, 429, 5); }
    return answer(shared.serializeConvExportPage({ instanceId: peer, conversationId: cid, items: [], next: after === null ? 'page2' : null }));
  };
  assert.equal(await f.accept.pullConvChanges(peer), 0); assert.equal(await f.cursor(), 0);
  const count = f.requests.length; f.clock.now += 4999; assert.equal(await f.accept.pullConvChanges(peer), null); assert.equal(f.requests.length, count);
  f.clock.now++; await f.accept.pullConvChanges(peer);
  assert.deepEqual(f.requests.filter(r => r.path.endsWith('/export')).map(r => r.query?.after ?? null), [null, 'page2', 'page2'], 'полный проход продолжает ту же страницу после 429');
  assert.equal(await f.cursor(), 10, 'голова курсора взята в начале прохода, не в ответе после паузы');
}
it('R201 export 429 сохраняет after и начальную голову reset; сброс passProgress при неудаче краснеет', async () => {
  await passResume(); await assert.rejects(passResume([
    'if (!(await fullPass(instanceId, self.instanceId, link.apiBase, host, key))) return since;',
    'if (!(await fullPass(instanceId, self.instanceId, link.apiBase, host, key))) { passProgress.delete(instanceId); return since; }',
  ]), killed('полный проход продолжает ту же страницу после 429'));
});

it('R201 changesForPeer возвращает reset с головой при будущем since; отсутствие sync означает голову 0', async () => {
  const f = await fixture(); const empty = await f.changes.changesForPeer(peer, 0, 100, self); assert.ok('items' in empty); assert.equal(empty.seq, 0);
  const gone = await f.changes.changesForPeer(peer, 1, 100, self); assert.ok('reset' in gone); assert.equal(gone.seq, 0);
  await t.db.insert(schema.fedConvSync).values({ instanceId: peer, seq: 3, minSeq: 0 });
  const exact = await f.changes.changesForPeer(peer, 3, 100, self); assert.ok('items' in exact); assert.equal(exact.seq, 3);
  const future = await f.changes.changesForPeer(peer, 4, 100, self); assert.ok('reset' in future); assert.equal(future.seq, 3);
});
async function reads(mutation?: Mutation) {
  const f = await fixture({ changes: mutation });
  await t.db.insert(schema.conversationMessages).values([{ id: 'their-first', conversationId: cid, authorId: 'shadow', sortKey: 1, content: 'От соседа' }, { id: 'my-last', conversationId: cid, authorId: 'local', sortKey: 2, content: 'Свой ответ' }]);
  await t.db.update(schema.conversationMembers).set({ lastReadKey: 2 }).where(orm.eq(schema.conversationMembers.userId, 'local'));
  await t.db.transaction(tx => f.changes.recordFedConvChanges(tx as never, [{ conversationId: cid, kind: shared.FED_CONV_CHANGE.read, entityId: null }]));
  const out = await f.changes.changesForPeer(peer, 0, 100, self); assert.ok('items' in out);
  const read = shared.parseConvReadsWire(out.items.find(i => i.kind === shared.FED_CONV_CHANGE.read)?.entity); assert.ok(read);
  assert.deepEqual(read.reads.map(r => `${r.user.userId}:${r.messageId}`), ['local:their-first'], 'своё сообщение читателя не уходит квитанцией соседу');
  await t.db.update(schema.conversationMembers).set({ lastReadKey: 0 }).where(orm.eq(schema.conversationMembers.userId, 'local'));
  const noRead = await f.changes.changesForPeer(peer, 0, 100, self); assert.ok('items' in noRead); assert.equal(shared.parseConvReadsWire(noRead.items[0].entity)?.reads.length, 0);
}
it('R201 read ссылается на последнее сообщение именно соседа, возврат своего автора в SQL обнаружен', async () => {
  await reads(); await assert.rejects(reads(['AND a.home_instance_id = ${peerInstanceId}', 'AND (a.home_instance_id IS NULL OR a.home_instance_id = ${peerInstanceId})']), killed('своё сообщение читателя не уходит квитанцией соседу'));
});
async function listens(mutation?: Mutation) {
  const f = await fixture({ changes: mutation });
  await t.db.insert(schema.conversationMessages).values([{ id: 'mine', conversationId: cid, authorId: 'local', sortKey: 1, content: 'Текст' },
    { id: 'voice', conversationId: cid, authorId: 'shadow', sortKey: 2, content: '', attachments: [{ id: 'voice-att', name: 'voice.ogg', contentType: 'audio/ogg', size: 10, url: '/fixture', waveform: [20], durationMs: 1000 }] }]);
  await t.db.insert(schema.conversationVoiceListens).values({ messageId: 'voice', userId: 'local' });
  await t.db.transaction(tx => f.changes.recordFedConvChanges(tx as never, [{ conversationId: cid, kind: shared.FED_CONV_CHANGE.msg, entityId: 'mine' }, { conversationId: cid, kind: shared.FED_CONV_CHANGE_E2.listen, entityId: 'voice' }]));
  for (const allowed of [false, true]) {
    await t.db.update(schema.federationLinks).set({ features: allowed ? [shared.FED_FEATURES.dm1, shared.FED_FEATURES.dm2once] : [shared.FED_FEATURES.dm1] });
    const out = await f.changes.changesForPeer(peer, 0, 100, self), exported = await f.changes.exportForPeer(peer, cid, null, self); assert.ok('items' in out && exported);
    assert.equal(out.items.some(i => i.kind === shared.FED_CONV_CHANGE_E2.listen), allowed, 'listen журнала требует dm2once');
    assert.equal(exported.items.some(i => i.kind === shared.FED_CONV_CHANGE_E2.listen), allowed, 'listen полного прохода требует dm2once');
    assert.equal(out.items.some(i => i.kind === shared.FED_CONV_CHANGE.msg), true);
  }
}
it('R201 listen закрыт без dm2once в журнале и export, разрешён с ним; снятый KIND_FEATURE краснеет', async () => {
  await listens(); await assert.rejects(listens(['[FED_CONV_CHANGE_E2.listen]: FED_FEATURES.dm2once,', '[FED_CONV_CHANGE_E2.listen]: undefined,']), killed('listen журнала требует dm2once'));
});

it('R201 staleHomes проверяет десять минут с обеих сторон, незабранный seq и действительную общую беседу', async () => {
  const f = await fixture(); await t.db.insert(schema.fedConvSync).values({ instanceId: peer, seq: 1, ackedSeq: 0 });
  await t.db.insert(schema.fedConvChanges).values({ instanceId: peer, seq: 1, conversationId: cid, kind: 'msg', entityId: null, at: new Date(f.clock.now - 600_000) });
  assert.deepEqual([...(await f.link.staleHomes([peer]))], []); f.clock.now++;
  assert.deepEqual([...(await f.link.staleHomes([peer, peer]))], [peer]);
  await f.link.notePeerPull(peer, 1); assert.deepEqual([...(await f.link.staleHomes([peer]))], []);
  await t.db.update(schema.fedConvSync).set({ ackedSeq: 0 });
  await t.db.delete(schema.conversationMembers).where(orm.eq(schema.conversationMembers.userId, 'shadow'));
  assert.deepEqual([...(await f.link.staleHomes([peer]))], [], 'журнал без участника этого соседа не означает задержку его ЛС');
});
async function ack(mutation?: Mutation) {
  const f = await fixture({ link: mutation }); await t.db.insert(schema.fedConvSync).values({ instanceId: peer, seq: 10, ackedSeq: 2 });
  await f.link.notePeerPull(peer, 5); f.clock.now += 1000; await f.link.notePeerPull(peer, 3);
  const [row] = await t.db.select().from(schema.fedConvSync); assert.equal(row.ackedSeq, 5, 'подтверждённый курсор не возвращается назад'); assert.equal(row.ackedAt?.getTime(), f.clock.now);
}
it('R201 notePeerPull подтверждает только вперёд; удаление GREATEST обнаруживается реальной строкой sync', async () => {
  await ack(); await assert.rejects(ack(['.set({ ackedSeq: sql`GREATEST(${fedConvSync.ackedSeq}, ${since})`, ackedAt: new Date() })', '.set({ ackedSeq: since, ackedAt: new Date() })']), killed('подтверждённый курсор не возвращается назад'));
});
for (const [status, error] of [[401, 'clock-skew'], [401, 'expired'], [404, 'not-found']] as const) it(`R201 ${status} ${error} становится stale после десяти минут, не broken; успешный забор снимает`, async () => {
  const f = await fixture(); f.link.notePeerAnswer(peer, status, JSON.stringify({ error })); f.clock.now += 600_000;
  assert.deepEqual([...(await f.link.staleHomes([peer]))], []); f.clock.now++;
  assert.deepEqual([...(await f.link.staleHomes([peer]))], [peer]); assert.deepEqual([...(await f.link.brokenHomes([peer]))], []);
  f.link.notePeerAnswer(peer, 200, '{}'); assert.deepEqual([...(await f.link.staleHomes([peer]))], []);
});
async function emptyNotFound(mutation?: Mutation) {
  for (const body of [null, '']) {
    const f = await fixture({ link: mutation });
    assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 0, 'stale не объясняется старым исходящим журналом');
    for (const status of [400, 401, 403, 503]) f.link.notePeerAnswer(peer, status, body);
    f.clock.now += 600_001;
    assert.equal((await f.link.staleHomes([peer])).size, 0, 'обычный отказ без тела не угадывается как clock-skew');
    f.link.notePeerAnswer(peer, 404, body); f.clock.now += 600_000;
    assert.equal((await f.link.staleHomes([peer])).size, 0, 'ровно десять минут ещё не включает stale');
    // Повторный пустой 404 не переносит начало ожидания ещё на десять минут.
    f.link.notePeerAnswer(peer, 404, body); f.clock.now++;
    assert.deepEqual([...(await f.link.staleHomes([peer]))], [peer], '404 без тела включает stale после десяти минут');
    assert.equal((await f.link.brokenHomes([peer])).size, 0, 'отсутствующий маршрут не разрывает связку');
    f.link.notePeerAnswer(peer, 200, null);
    assert.equal((await f.link.staleHomes([peer])).size, 0, 'успешный ответ без тела снимает срок');
  }
}
it('R202 пустой или отсутствующий body у 404 копит срок stale, прочие пустые отказы не включают его', async () => {
  await emptyNotFound();
});
it('R202 мутант раннего отказа при пустом body теряет stale от 404 без исходящих сообщений', async () => {
  await emptyNotFound();
  await assert.rejects(emptyNotFound(['if (status === 404 && !body) {', 'if (false) {']), killed('404 без тела включает stale'));
});
it('R201 сеть и 5xx не ставят stale сами по себе; сводка fedStale есть лишь без fedLink', async () => {
  const f = await fixture(); f.link.notePeerAnswer(peer, null, null); f.link.notePeerAnswer(peer, 503, '{"error":"clock-skew"}'); f.clock.now += 600_001;
  assert.deepEqual([...(await f.link.staleHomes([peer]))], []);
  const a = await f.c.loadAccess(cid, 'local'); assert.ok(a);
  const sent = await f.c.sendMessage('local', a, { clientId: randomUUID(), content: 'Ждёт соседа', attachments: [], replyToId: null, withheld: false }); assert.equal(sent.kind, 'created');
  await t.db.update(schema.fedConvChanges).set({ at: new Date(f.clock.now - 600_001) });
  const active = (await f.c.listConversations('local')).conversations.find(c => c.id === cid); assert.ok(active); assert.equal(active.fedStale, true); assert.equal(active.fedLink, undefined);
  await t.db.update(schema.federationLinks).set({ state: 'paused' });
  const paused = (await f.c.listConversations('local')).conversations.find(c => c.id === cid); assert.ok(paused); assert.equal(paused.fedLink, 'broken'); assert.equal(paused.fedStale, undefined);
});
