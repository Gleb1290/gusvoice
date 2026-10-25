import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
const self = 'a'.repeat(32), peer = 'b'.repeat(32), alien = 'c'.repeat(32), cid = 'once-media-conv';
const aid = '10000000-0000-4000-8000-000000000001';
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t.close(); });
const raw = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load<T>(name: string, deps: Record<string, unknown>, mutation?: Mutation): T {
  let source = raw(name);
  if (mutation) {
    assert.equal(source.split(mutation[0]).length - 1, 1, 'единственный якорь whole-module мутанта');
    source = source.replace(...mutation);
  }
  const imports: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true).statements)
    if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly) {
      const id = (n.moduleSpecifier as ts.StringLiteral).text;
      imports[id] = new Proxy({}, { get: (_obj, key) => key === '__esModule' ? true : () => {
        throw new Error(`неисполняемая граница ${id}.${String(key)}`);
      } });
    }
  Object.assign(imports, deps);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, Date, Buffer, URL, Map, Set, Promise, console,
    require(id: string) { assert.ok(Object.hasOwn(imports, id), `явный импорт ${id}`); return imports[id]; },
  });
  return module.exports as T;
}
type MediaKind = 'photo' | 'video';
function media(kind: MediaKind, once = true, ttl = 60): shared.Attachment {
  return { id: aid, url: '/fixture', name: kind === 'photo' ? 'photo.jpg' : 'video.mp4',
    contentType: kind === 'photo' ? 'image/jpeg' : 'video/mp4', size: 10, width: 800, height: 600,
    ...(kind === 'video' ? { durationMs: 3000 } : {}), ...(once ? { once: true as const, onceTtl: ttl } : {}) };
}
async function fixture(kind: MediaKind = 'photo', options: { once?: boolean; ttl?: number; accept?: Mutation; att?: Mutation } = {}) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'once_local', displayName: 'Автор', passwordHash: 'fixture' },
    { id: 'shadow', username: 'once_shadow', displayName: 'Сосед', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'remote' },
  ]);
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: 'peer.invalid', apiBase: 'https://peer.invalid/api',
    clientOrigin: 'https://peer.invalid', rootKey: 'fixture-root', state: 'active', features: ['dm1', 'dm2', 'dm2once'] });
  await t.db.insert(schema.conversations).values({ id: cid, kind: 'direct', directKey: `${self}:local|${peer}:remote`, createdBy: 'local' });
  await t.db.insert(schema.conversationMembers).values([{ conversationId: cid, userId: 'local' }, { conversationId: cid, userId: 'shadow' }]);
  const att = media(kind, options.once ?? true, options.ttl ?? 60);
  await t.db.insert(schema.conversationMessages).values({ id: 'mine', conversationId: cid, authorId: 'local', sortKey: 1, content: '', attachments: [att] });
  await t.db.update(schema.conversations).set({ lastSortKey: 1 });
  await t.db.insert(schema.attachments).values({ id: aid, conversationId: cid, ownerId: 'local', messageId: 'mine',
    storageKey: 'once-media-key', name: att.name, contentType: att.contentType, size: 10, state: 'attached' });
  const deliveries: unknown[] = [], purges: string[][] = [];
  const c = load<typeof import('../src/conversations.js')>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema, './convRules.js': rules,
    './util.js': { uuidv7: randomUUID }, './env.js': { env: { publicApiUrl: 'https://fixture.invalid' } },
  });
  c.configureFederatedConv({ selfInstanceId: () => self, record: null });
  const deps = { '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../convRules.js': rules, '../conversations.js': { ...c, deliver: async (value: unknown) => { if (value) deliveries.push(value); } } };
  const accept = load<typeof import('../src/federation/convAccept.js')>('federation/convAccept', deps, options.accept);
  accept.configureFedConvAttachments({ remoteFor: async () => { throw new Error('при listen нет копирования'); }, kick: () => {},
    purge: keys => { purges.push([...keys]); } });
  const remote = load<typeof import('../src/federation/convAtt.js')>('federation/convAtt', { ...deps,
    '../safeFetch.js': { PEER_MAX_ATT_BYTES: 25 * 1024 * 1024 },
    './directorySync.js': { refreshCapabilities: async (link: { features: string[] }) => link.features },
  }, options.att);
  const changes = load<typeof import('../src/federation/convChanges.js')>('federation/convChanges', deps);
  return { c, remote, changes, deliveries, purges,
    row: async () => (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, 'mine')))[0],
    attRow: async () => (await t.db.select().from(schema.attachments).where(orm.eq(schema.attachments.id, aid)))[0],
    apply: (spent = true, from = peer, listeners: shared.FedPersonRef[] = [{ instanceId: peer, userId: 'remote' }]) =>
      accept.applyChange(from, self, shared.FED_CONV_CHANGE_E2.listen, cid,
        shared.serializeConvListenWire({ messageId: 'mine', spent, listeners })),
  };
}

async function spentScenario(kind: MediaKind, once = true, spent = true, mutation?: Mutation) {
  const f = await fixture(kind, { once, accept: mutation });
  await f.apply(spent);
  const row = await f.row(), att = await f.attRow(), expected = once && spent;
  assert.equal(row.onceSpentAt !== null, expected, 'R262_FED_SPEND: только spent одноразового медиа гасит оригинал');
  assert.equal(row.content, expected ? (kind === 'photo' ? shared.PHOTO_ONCE_SPENT_TEXT : shared.VIDEO_ONCE_SPENT_TEXT) : '');
  assert.equal(row.attachments.length, expected ? 0 : 1);
  assert.equal(att.state, expected ? 'deleted' : 'attached');
  assert.equal(att.deletedAt !== null, expected);
  assert.deepEqual(f.purges, expected ? [['once-media-key']] : []);
  const before = { spent: row.onceSpentAt?.getTime(), deliveries: f.deliveries.length,
    journal: (await t.db.select().from(schema.userChanges)).length, purges: f.purges.length };
  await f.apply(spent);
  assert.equal((await f.row()).onceSpentAt?.getTime(), before.spent, 'повтор не передвигает время сгорания');
  assert.equal(f.deliveries.length, before.deliveries); assert.equal(f.purges.length, before.purges);
  assert.equal((await t.db.select().from(schema.userChanges)).length, before.journal);
  assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 0, 'принятое spent не создаёт эхо соседу');
}
for (const kind of ['photo', 'video'] as const) {
  for (const [once, spent] of [[true, true], [true, false], [false, true]] as const)
    test(`R262 ${kind}: once=${once}, spent=${spent} — сгорание только при полном разрешении, повтор идемпотентен`, () => spentScenario(kind, once, spent));
}

for (const kind of ['photo', 'video'] as const) test(`R262 ${kind}: чужой дом и пустой слушатель не могут погасить оригинал`, async () => {
  const f = await fixture(kind);
  await f.apply(true, alien, [{ instanceId: alien, userId: 'stranger' }]);
  assert.equal((await f.row()).onceSpentAt, null); assert.deepEqual(f.purges, []);
  await f.apply(true, peer, []);
  assert.equal((await f.row()).onceSpentAt, null); assert.equal((await f.attRow()).state, 'attached');
  await f.apply(); assert.notEqual((await f.row()).onceSpentAt, null);
});

for (const kind of ['photo', 'video'] as const) test(`R262 возврат isListenable вместо поддержки${kind} обнаруживается на оригинале`, async () => {
  await spentScenario(kind);
  await assert.rejects(spentScenario(kind, true, true, [
    'm.attachments.some((a) => (a.once === true && isListenable(a)) || onceMediaHere(a))',
    'm.attachments.some((a) => a.once === true && isListenable(a))',
  ]), error => error instanceof assert.AssertionError && error.message.includes('R262_FED_SPEND'));
});

test('R262 потеря spent не даёт незавершённому просмотру сжечь одноразовое фото', async () => {
  await spentScenario('photo', true, false);
  await assert.rejects(spentScenario('photo', true, false, ['w.spent === true && want.size > 0', 'want.size > 0']),
    error => error instanceof assert.AssertionError && error.message.includes('R262_FED_SPEND'));
});

async function featureScenario(mutation?: Mutation) {
  const f = await fixture('photo', { att: mutation });
  assert.equal(await f.remote.fedOnceAllowedFor('local', true), true, 'местный не зависит от признаков соседа');
  assert.equal(await f.remote.fedOnceAllowedFor('shadow'), true, 'dm2once по-прежнему разрешает голосовое');
  assert.equal(await f.remote.fedOnceAllowedFor('shadow', true), false, 'R262_DM2TTL: dm2once недостаточно для фото/видео');
  await t.db.update(schema.federationLinks).set({ features: ['dm1', 'dm2', 'dm2once', 'dm2ttl'] });
  assert.equal(await f.remote.fedOnceAllowedFor('shadow', true), true, 'dm2ttl разрешает фото/видео');
}
test('R262 сосед с dm2once принимает голосовое, но фото/видео открываются только после dm2ttl', () => featureScenario());
test('R262 потеря различия dm2ttl и dm2once обнаруживается реальными признаками связки', async () => {
  await featureScenario();
  await assert.rejects(featureScenario(['media ? FED_FEATURES.dm2ttl : FED_FEATURES.dm2once', 'FED_FEATURES.dm2once']),
    error => error instanceof assert.AssertionError && error.message.includes('R262_DM2TTL'));
});

for (const kind of ['photo', 'video'] as const) for (const ttl of [1, 60])
  test(`R262 ${kind} таймер${ttl}с проходит БД→провод→разбор→remote-копию`, async () => {
    const f = await fixture(kind, { ttl });
    const people = new Map([['local', { id: 'local', homeInstanceId: null, homeUserId: null }]]);
    const wire = f.changes.toWireMessage(await f.row(), people, self);
    const json = shared.serializeConvMessageWire(wire);
    const parsed = shared.parseConvMessageWire(json);
    assert.ok(parsed); assert.equal(parsed.attachments[0].onceTtl, ttl);
    await t.db.insert(schema.conversationMessages).values({ id: 'copy', conversationId: cid, authorId: 'shadow', sortKey: 2, content: '' });
    const copyId = '10000000-0000-4000-8000-000000000002';
    const copied = await t.db.transaction(tx => f.remote.remoteAttachmentsFor(tx as never, {
      conversationId: cid, ownerId: 'shadow', messageId: 'copy', origin: peer,
      list: [{ ...parsed.attachments[0], id: copyId }],
    }));
    assert.equal(copied.length, 1); assert.equal(copied[0].once, true); assert.equal(copied[0].onceTtl, ttl);
    assert.equal(copied[0].fedState, 'copying');
    const [row] = await t.db.select().from(schema.attachments).where(orm.eq(schema.attachments.id, copyId));
    assert.equal(row.state, 'remote'); assert.equal(row.originInstanceId, peer);
  });
