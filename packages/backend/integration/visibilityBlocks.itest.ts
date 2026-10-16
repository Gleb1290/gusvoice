import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, test } from 'node:test';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as lastSeenRules from '../src/lastSeenRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = { file: string; from: string; to: string };
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { try { await t?.close(); } finally { await (await import('../src/db/index.js')).pool.end(); } });
const self = 'a'.repeat(32), peer = 'b'.repeat(32), third = 'c'.repeat(32);
const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function moduleOf<T>(name: string, deps: Record<string, unknown>, unexpected: string[], mutation?: Mutation): T {
  let raw = source(name);
  if (mutation?.file === name) { assert.equal(raw.split(mutation.from).length - 1, 1, `единственный якорь ${name}`); raw = raw.replace(mutation.from, mutation.to); }
  const imports: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly) continue;
    const id = (n.moduleSpecifier as ts.StringLiteral).text;
    imports[id] = new Proxy({}, { get: (_o, key) => key === '__esModule' ? true : () => {
      const label = `${name}:${id}.${String(key)}`; unexpected.push(label); throw new Error(`неописанная граница ${label}`);
    } });
  }
  Object.assign(imports, deps);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, Error, console, setTimeout, clearTimeout, setInterval, clearInterval,
      require: (id: string) => { assert.ok(Object.hasOwn(imports, id), `явный импорт ${name}:${id}`); return imports[id]; } });
  return module.exports as T;
}
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const killed = (label: string, actual: unknown, expected: unknown) => (e: unknown) => e instanceof assert.AssertionError
  && e.message.startsWith(label) && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected;
async function fixture(options: { mutation?: Mutation; mixed?: boolean; connected?: boolean; hook?: boolean } = {}) {
  await truncateAll(t.raw);
  const at = new Date(Date.now() - 60_000);
  await t.db.insert(schema.users).values([
    ...['viewer', 'subject', 'control'].map(id => ({ id, username: `visibility_${id}`, displayName: id, passwordHash: 'fixture', lastSeenAt: at,
      lastSeenPrivacy: 'everyone', verified: true, approvedAt: new Date() })),
    { id: 'shadow', username: 'visibility_shadow', displayName: 'Заблокированный сосед', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'remote-one' },
    { id: 'shadow2', username: 'visibility_shadow2', displayName: 'Свой собеседник соседа', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'remote-two' },
    { id: 'shadow3', username: 'visibility_shadow3', displayName: 'Третий дом', passwordHash: 'fixture', homeInstanceId: third, homeUserId: 'remote-three' },
  ]);
  await t.db.insert(schema.servers).values({ id: 'common-server', name: 'Общий сервер', ownerId: 'viewer' });
  await t.db.insert(schema.serverMembers).values(['viewer', 'subject', 'control'].map(userId => ({ serverId: 'common-server', userId })));
  const remoteIds = ['shadow', ...(options.mixed ? ['shadow2'] : []), 'shadow3'];
  await t.db.insert(schema.conversations).values([
    { id: 'local-direct', kind: 'direct', directKey: 'subject:viewer', createdBy: 'viewer' },
    ...remoteIds.map(id => ({ id: `with-${id}`, kind: 'direct' as const, directKey: `viewer:${id}`, createdBy: 'viewer' })),
  ]);
  await t.db.insert(schema.conversationMembers).values([
    ...['viewer', 'subject'].map(userId => ({ conversationId: 'local-direct', userId })),
    ...remoteIds.flatMap(id => ['viewer', id].map(userId => ({ conversationId: `with-${id}`, userId }))),
  ]);
  await t.db.insert(schema.federationLinks).values([peer, third].map((instanceId, i) => ({ instanceId, domain: `peer${i}.invalid`,
    apiBase: `https://peer${i}.invalid/api`, clientOrigin: `https://peer${i}.invalid`, rootKey: 'fixture-root', state: 'active', features: ['dm1', 'dm3'] })));
  const unexpected: string[] = [], present = new Set(options.connected === false ? [] : ['viewer', 'subject']), requests: Array<{
    apiBase: string; path: string; payload: { kind: string; online?: boolean; views?: Array<{ user: { instance_id: string; user_id: string }; last_seen: number | null }> };
  }> = [];
  const blocks = moduleOf<typeof import('../src/blocks.js')>('blocks', { 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema }, unexpected);
  const peers = moduleOf<typeof import('../src/db/peerQueries.js')>('db/peerQueries', { 'drizzle-orm': orm, './index.js': { db: t.db } }, unexpected, options.mutation);
  const rules = moduleOf<typeof import('../src/lastSeenRules.js')>('lastSeenRules', { '@gusvoice/shared': shared }, unexpected, options.mutation);
  const gateway = { isUserDmPresent: (id: string) => present.has(id) };
  const lastSeen = moduleOf<typeof import('../src/lastSeen.js')>('lastSeen', { 'drizzle-orm': orm, './blocks.js': blocks,
    './db/index.js': { db: t.db }, './db/schema.js': schema, './db/peerQueries.js': peers, './gateway.js': gateway, './lastSeenRules.js': rules }, unexpected);
  const ephemeral = moduleOf<typeof import('../src/federation/dmEphemeral.js')>('federation/dmEphemeral', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../blocks.js': blocks, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../gateway.js': gateway, '../lastSeenRules.js': lastSeenRules,
    './instance.js': { federation: { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'fixture-key', privateKeyDer: new Uint8Array() }) } },
    './peerClient.js': { postSignedToPeer: async (arg: typeof requests[number]) => { requests.push(arg); return { ok: true, value: { status: 202 } }; } },
  }, unexpected, options.mutation);
  const unsubscribe = options.hook === false ? () => {} : blocks.onBlockChange(ephemeral.fedBlockChanged);
  const drain = async () => { for (let i = 0; i < 16; i++) { await new Promise<void>(resolve => setImmediate(resolve)); await t.raw.query('SELECT 1'); }
    assert.deepEqual(unexpected, [], 'фон не проглотил неописанную зависимость'); };
  return { blocks, peers, lastSeen, ephemeral, present, requests, drain, unsubscribe, at };
}

async function peerScenario(blocker: 'viewer' | 'subject', mutation?: Mutation) {
  const f = await fixture({ mutation, hook: false });
  try {
    assert.equal(await f.peers.shareServer('viewer', 'subject'), true);
    assert.equal(await f.peers.arePeers('viewer', 'subject'), true); assert.equal((await f.peers.loadPeers('viewer')).has('subject'), true);
    await f.blocks.blockUser(blocker, blocker === 'viewer' ? 'subject' : 'viewer');
    assert.equal((await f.peers.loadPeers('viewer')).has('subject'), false, 'блок не обходит общий сервер при loadPeers');
    assert.equal((await f.peers.loadPeers('subject')).has('viewer'), false);
    assert.equal(await f.peers.arePeers('viewer', 'subject'), false); assert.equal(await f.peers.arePeers('subject', 'viewer'), false);
    assert.equal(await f.peers.shareServer('viewer', 'subject'), true, 'физический общий сервер сохранён, скрывается именно видимость');
    assert.equal((await f.peers.loadPeers('viewer')).has('control'), true); assert.equal(await f.peers.arePeers('viewer', 'control'), true);
    await f.blocks.unblockUser(blocker, blocker === 'viewer' ? 'subject' : 'viewer');
    assert.equal((await f.peers.loadPeers('viewer')).has('subject'), true); assert.equal(await f.peers.arePeers('viewer', 'subject'), true);
    await f.drain();
  } finally { f.unsubscribe(); }
}
for (const blocker of ['viewer', 'subject'] as const) test(`R214 F5 блок от ${blocker === 'viewer' ? 'зрителя' : 'субъекта'} разрывает видимость общего сервера и ЛС в обе стороны`, async () => {
  await peerScenario(blocker);
});
test('R214 F5 потеря NOT EXISTS в серверной ветке ловится настоящим SQL с общим сервером', async () => {
  await peerScenario('subject');
  const from = 'AND NOT EXISTS (SELECT 1 FROM user_blocks ub\n          WHERE (ub.blocker_id = a.user_id AND ub.blocked_id = b.user_id)\n             OR (ub.blocker_id = b.user_id AND ub.blocked_id = a.user_id))';
  await assert.rejects(peerScenario('subject', { file: 'db/peerQueries', from, to: '' }), killed('блок не обходит общий сервер при loadPeers', true, false));
});
async function lastSeenScenario(connected = true, mutation?: Mutation) {
  const f = await fixture({ mutation, connected, hook: false });
  try {
    const good = await f.lastSeen.lastSeenFor('viewer', 'subject'); assert.ok(good);
    assert.equal(good.online, connected); assert.equal(good.at, connected ? null : f.at.toISOString()); assert.equal(good.approx, null);
    await f.blocks.blockUser('subject', 'viewer');
    const single = await f.lastSeen.lastSeenFor('viewer', 'subject'); assert.ok(single);
    assert.equal(single.approx, 'long', 'заблокированный зритель видит давно'); assert.equal(single.online, false); assert.equal(single.at, null); assert.equal(single.exact, false);
    const batch = await f.lastSeen.lastSeenForMany('viewer', ['subject', 'control', 'missing', 'subject']);
    assert.deepEqual(plain(batch.find(v => v.userId === 'subject')), plain(single), 'пачка применяет то же правило blockedViewer');
    assert.equal(batch.some(v => v.userId === 'missing'), false); assert.equal(batch.filter(v => v.userId === 'subject').length, 1);
    assert.equal(batch.find(v => v.userId === 'control')?.approx, null); assert.equal(batch.find(v => v.userId === 'control')?.at, f.at.toISOString());
    await f.blocks.unblockUser('subject', 'viewer');
    assert.deepEqual(plain(await f.lastSeen.lastSeenFor('viewer', 'subject')), plain(good)); await f.drain();
  } finally { f.unsubscribe(); }
}
for (const connected of [false, true]) test(`R214 F5 lastSeenFor и пачка скрывают ${connected ? 'онлайн' : 'точное недавнее время'} от заблокированного`, async () => {
  await lastSeenScenario(connected);
});
test('R214 F5 потеря blockedViewer ловится недавно вместо давно при живом шлюзе', async () => {
  await lastSeenScenario(true); await assert.rejects(lastSeenScenario(true, { file: 'lastSeenRules', from: 'if (input.blockedViewer && !self)', to: 'if (false)' }),
    killed('заблокированный зритель видит давно', 'recently', 'long'));
});
async function presenceScenario(mixed = false, mutation?: Mutation) {
  const f = await fixture({ mixed, mutation });
  try {
    await f.blocks.blockUser('viewer', 'shadow'); await f.drain();
    assert.equal(f.requests.length, 1, 'смена блока отправляет ровно одну запись дому заблокированного');
    const r = f.requests[0]; assert.equal(r.apiBase, 'https://peer0.invalid/api'); assert.equal(r.path, '/api/fed/v1/ephemeral');
    assert.equal(r.payload.kind, 'presence'); assert.equal(r.payload.online, mixed);
    assert.deepEqual(plain(r.payload.views?.map(v => v.user.user_id)), mixed ? ['remote-two'] : [], 'заблокированный исключён из видов');
    assert.equal(f.requests.some(r => r.apiBase === 'https://peer1.invalid/api'), false, 'другой дом не затронут');
    if (mixed) assert.ok(typeof r.payload.views?.[0].last_seen === 'number');
    f.requests.length = 0; await f.blocks.unblockUser('viewer', 'shadow'); await f.drain();
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].payload.online, true);
    assert.deepEqual(plain(f.requests[0].payload.views?.map(v => v.user.user_id).sort()), mixed ? ['remote-one', 'remote-two'] : ['remote-one']);
    return f;
  } finally { f.unsubscribe(); }
}
test('R214 F5 fedBlockChanged при одном заблокированном на доме сразу шлёт offline с пустыми views', async () => { await presenceScenario(); });
test('R214 F5 смешанный дом получает обычную запись без заблокированного, разблокировка возвращает его вид', async () => {
  // Общий online-бит смешанного дома остаётся true: это согласованный остаток после тега, старые R197 не меняем.
  await presenceScenario(true);
});
test('R214 F5 без подключения нового крючка прежняя R197 блокировка не делает POST присутствия', async () => {
  const f = await fixture({ hook: false });
  try { await f.blocks.blockUser('viewer', 'shadow'); await f.drain(); assert.deepEqual(f.requests, []);
    await f.blocks.unblockUser('viewer', 'shadow'); await f.drain(); assert.deepEqual(f.requests, []);
  } finally { f.unsubscribe(); }
});
test('R214 F5 блок своего человека не затрагивает соседние дома и не создаёт POST', async () => {
  const f = await fixture(); try { await f.blocks.blockUser('viewer', 'subject'); await f.drain(); assert.deepEqual(f.requests, []); }
  finally { f.unsubscribe(); }
});
test('R214 F5 потеря blockNotice ловится отсутствием обязательного offline для пустого дома', async () => {
  await presenceScenario(); await assert.rejects(presenceScenario(false, { file: 'federation/dmEphemeral',
    from: 'if (opts.blockNotice && opts.onlyHome && blockedHomes.has(opts.onlyHome) && !byHome.has(opts.onlyHome))', to: 'if (false)' }),
    killed('смена блока отправляет ровно одну запись дому заблокированного', 0, 1));
});
