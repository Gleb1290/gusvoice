import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import { z } from 'zod';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as attachmentRules from '../src/attachmentRules.js';
import * as dmRules from '../src/dmRules.js';
import * as scheduleRules from '../src/scheduleRules.js';
import * as strangerRules from '../src/strangerRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { try { await t?.close(); } finally { await (await import('../src/db/index.js')).pool.end(); } });
const peer = 'b'.repeat(32), self = 'a'.repeat(32), cid = 'fed-album';
const ids = ['20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003'];
const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function moduleOf<T>(name: string, deps: Record<string, unknown>, mutation?: Mutation): T {
  let raw = source(name);
  if (mutation) { assert.equal(raw.split(mutation[0]).length - 1, 1, 'единственный якорь G56'); raw = raw.replace(...mutation); }
  const imports: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly) continue;
    const id = (n.moduleSpecifier as ts.StringLiteral).text;
    imports[id] = new Proxy({}, { get: (_t, key) => key === '__esModule' ? true : () => { throw new Error(`запрещённый IO ${id}.${String(key)}`); } });
  }
  Object.assign(imports, deps);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, console, Error,
      require: (id: string) => { assert.equal(Object.hasOwn(imports, id), true, `явный импорт ${id}`); return imports[id]; } });
  return module.exports as T;
}
const att = (id: string) => ({ id, url: '', name: 'fixture.jpg', contentType: 'image/jpeg', size: 10, width: 12, height: 14 });
const fileWire = (id: string): shared.FedConvAttachmentWire => ({ id, name: 'fixture.jpg', contentType: 'image/jpeg', size: 10,
  width: 12, height: 14, durationMs: null, waveform: null, asFile: false, spoiler: false, sha256: null });
const wire = (overrides: Partial<shared.FedConvMessageWire> = {}) => shared.serializeConvMessageWire({ id: 'incoming', conversationId: cid,
  author: { instanceId: peer, userId: 'remote' }, clientId: null, payloadHash: null, createdAt: 1, originSortKey: 1,
  content: 'Подпись', replyToId: null, forwardedFrom: null, silent: false, noPreview: false, captionAbove: false,
  replyQuote: null, sticker: null, service: null, attachments: ids.map(fileWire), editVersion: 0, editedAt: null, deleted: false, ...overrides });
type Incoming = { attachments: { id: string }[]; edited_at: string | null; edit_version: number; content: string };
async function fixture(mutation?: Mutation) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'album_local', displayName: 'Местный', passwordHash: 'fixture' },
    { id: 'other', username: 'album_other', displayName: 'Другой', passwordHash: 'fixture' },
    { id: 'outsider', username: 'album_outsider', displayName: 'Посторонний', passwordHash: 'fixture' },
    { id: 'shadow', username: 'album_shadow', displayName: 'Сосед', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'remote', homeUsername: 'remote' },
  ]);
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: 'peer.invalid', apiBase: 'https://peer.invalid/api',
    clientOrigin: 'https://peer.invalid', rootKey: 'fixture-root', state: 'active', features: ['dm1', 'dm2'] });
  const serialize = moduleOf<typeof import('../src/serialize.js')>('serialize', {
    '@gusvoice/shared': shared, './env.js': { env: {} }, './linkThreats.js': { dangerousLinksOf: () => [] },
    './federation/instanceLabels.js': { instanceLabel: (id: string) => ({ instanceId: id, name: 'Сосед', domain: 'peer.invalid', reports: false }) },
  });
  const purged: string[] = [], refreshes: string[] = [], kicks: string[] = [], deliveries: unknown[] = [], trace: string[] = [];
  const events: Array<{ user: string; body: shared.GatewayServerMessage }> = [];
  const db = new Proxy(t.db, { get: (obj, key, receiver) => key === 'transaction'
    ? async (...args: Parameters<typeof t.db.transaction>) => { const out = await obj.transaction(...args); trace.push('commit'); return out; }
    : Reflect.get(obj, key, receiver) });
  const c = moduleOf<typeof import('../src/conversations.js')>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './convRules.js': rules, './db/index.js': { db }, './db/schema.js': schema,
    './serialize.js': serialize, './util.js': { uuidv7: randomUUID }, './env.js': { env: {} }, './dmWriteBarrier.js': { dmWriteBarrier: {} },
    './attachments.js': { attachmentLink: (id: string, viewer: string) => `/fixture/${id}?viewer=${viewer}`, purgeDeleted: async () => {} },
    './realtime.js': { publishToUser: async (user: string, body: shared.GatewayServerMessage) => { events.push({ user, body }); } },
  });
  c.configureFederatedConv({ selfInstanceId: () => self, record: null });
  await c.createDirect('local', 'shadow', { id: cid, originInstanceId: self });
  await c.createDirect('local', 'other', { id: 'local-album', originInstanceId: self });
  await t.raw.exec('UPDATE conversation_members SET pending=false');
  const attM = moduleOf<typeof import('../src/federation/convAtt.js')>('federation/convAtt', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db }, '../db/schema.js': schema, '../convRules.js': rules,
    '../conversations.js': c, '../attachmentRules.js': attachmentRules, '../safeFetch.js': { PEER_MAX_ATT_BYTES: 25 * 1024 * 1024 },
    './directorySync.js': { refreshCapabilities: async (link: { instanceId: string; features: string[] }) => { refreshes.push(link.instanceId); return link.features; } },
  });
  const accept = moduleOf<typeof import('../src/federation/convAccept.js')>('federation/convAccept', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db }, '../db/schema.js': schema, '../convRules.js': rules,
    '../conversations.js': { ...c, deliver: async (d: unknown) => { if (d) deliveries.push(d); } }, '../convSendFanout.js': { fanOutSend: async () => {} },
  }, mutation);
  accept.configureFedConvAttachments({ remoteFor: attM.remoteAttachmentsFor, kick: origin => { kicks.push(origin); }, purge: keys => { trace.push('purge'); purged.push(...keys); } });
  const row = async () => (await t.raw.query<Incoming>("SELECT attachments,edited_at,edit_version,content FROM conversation_messages WHERE id='incoming'")).rows[0];
  const state = async (id: string) => (await t.raw.query<{ state: string }>('SELECT state FROM attachments WHERE id=$1', [id])).rows[0]?.state;
  const journal = async () => (await t.raw.query<{ user_id: string; pts: number; kind: string }>('SELECT user_id,pts,kind FROM user_changes ORDER BY user_id,pts')).rows;
  trace.length = 0;
  return { c, attM, accept, row, state, journal, purged, refreshes, kicks, deliveries, events, trace };
}
async function incoming(f: Awaited<ReturnType<typeof fixture>>, copied = true) {
  await f.accept.applyChange(peer, self, 'msg', cid, wire());
  assert.equal((await f.row()).attachments.length, 3, 'настоящий приём создал три файла копии');
  if (copied) await t.raw.exec("UPDATE attachments SET state='attached'");
  f.deliveries.length = 0; f.trace.length = 0;
}
async function shrinkScenario(mutation?: Mutation, copied = true) {
  const f = await fixture(mutation); await incoming(f, copied);
  await f.accept.applyChange(peer, self, 'msg', cid, wire({ editVersion: 1, attachments: [fileWire(ids[0]), fileWire(ids[2])] }));
  const row = await f.row();
  assert.deepEqual(row.attachments.map(a => a.id), [ids[0], ids[2]], 'приём убирает отсутствующий элемент копии');
  assert.equal(row.edited_at, null, 'убранное фото не ставит изм. на копии'); assert.equal(row.edit_version, 1); assert.equal(row.content, 'Подпись');
  assert.equal(await f.state(ids[1]), 'deleted'); assert.equal(await f.state(ids[0]), copied ? 'attached' : 'remote');
  assert.deepEqual(f.purged, [`dm/${ids[1]}`]); assert.deepEqual(f.trace, ['commit', 'purge'], 'копия стирается только после фиксации');
  assert.equal(f.deliveries.length, 1); return f;
}
for (const copied of [false, true]) test(`G56 приём меньшего альбома стирает ${copied ? 'скопированный' : 'ещё remote'} файл и не ставит изм.`, async () => {
  // Догоняющая фоновая копия не должна прикрепить уже убранный автором элемент обратно.
  await shrinkScenario(undefined, copied);
});
test('G56 старая и равная версии правки не возвращают файл, не пишут журнал и не повторяют уборку', async () => {
  const f = await shrinkScenario(), row = await f.row(), j = await f.journal();
  for (const editVersion of [0, 1]) await f.accept.applyChange(peer, self, 'msg', cid, wire({ editVersion, content: 'Старая подпись' }));
  assert.deepEqual(await f.row(), row); assert.deepEqual(await f.journal(), j); assert.equal(f.purged.length, 1); assert.equal(f.deliveries.length, 1);
});
test('G56 пустой провод сохраняет список файлов, обычная правка текста сохраняет явный editedAt', async () => {
  const f = await shrinkScenario();
  await f.accept.applyChange(peer, self, 'msg', cid, wire({ editVersion: 2, content: 'Новая подпись', editedAt: 5000, attachments: [fileWire(ids[0]), fileWire(ids[2])] }));
  let row = await f.row(); assert.equal(row.content, 'Новая подпись'); assert.equal(new Date(row.edited_at!).getTime(), 5000);
  await f.accept.applyChange(peer, self, 'msg', cid, wire({ editVersion: 3, content: 'Текст старого дома', editedAt: 6000, attachments: [] }));
  row = await f.row(); assert.deepEqual(row.attachments.map(a => a.id), [ids[0], ids[2]]);
  assert.equal(row.edit_version, 3); assert.equal(new Date(row.edited_at!).getTime(), 6000);
  assert.equal(await f.state(ids[0]), 'attached'); assert.equal(await f.state(ids[2]), 'attached'); assert.equal(f.purged.length, 1);
});
test('G56 контрфакт потери removedByEdit ловится несуженной реальной копией в jsonb', async () => {
  await shrinkScenario();
  await assert.rejects(shrinkScenario(['const dropped = removedByEdit(row.attachments, w.attachments);', 'const dropped: typeof row.attachments = [];']),
    e => e instanceof assert.AssertionError && e.message.startsWith('приём убирает отсутствующий элемент копии') && e.operator === 'deepStrictEqual'
      && JSON.stringify(e.actual) === JSON.stringify(ids) && JSON.stringify(e.expected) === JSON.stringify([ids[0], ids[2]]));
});
async function album(authorId = 'local', conversationId = cid) {
  await t.db.insert(schema.conversationMessages).values({ id: 'album', conversationId, authorId, sortKey: 1, content: 'Подпись', attachments: ids.map(att) });
  for (const id of ids) await t.db.insert(schema.attachments).values({ id, conversationId, ownerId: authorId, messageId: 'album',
    storageKey: `dm/${id}`, name: 'fixture.jpg', contentType: 'image/jpeg', size: 10, state: 'attached' });
}
async function http(f: Awaited<ReturnType<typeof fixture>>, viewer = 'local', withGuard = true) {
  const guardCalls: string[][] = [];
  const routes = moduleOf<typeof import('../src/routes/conv.js')>('routes/conv', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: { z }, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../conversations.js': f.c, '../convRules.js': rules, '../dmRules.js': dmRules, '../scheduleRules.js': scheduleRules, '../strangerRules.js': strangerRules,
    '../auth.js': { requireAuth: async () => {}, isSuperAdmin: () => false }, '../authGuard.js': { rateHit: async () => 0 },
    './att.js': { convAttachmentRefsSchema: z.array(z.object({ id: z.string() })) },
  });
  routes.configureFedAlbumGuard(withGuard ? async memberIds => { guardCalls.push([...memberIds]); return f.attM.fedAlbumAllowedFor(memberIds); } : null);
  const app = Fastify(); app.addHook('preHandler', async req => { req.user = { sub: viewer } as typeof req.user; });
  try { await app.register(routes.convRoutes); await app.ready(); return { app, guardCalls }; } catch (e) { await app.close(); throw e; }
}
const url = (scope = 'both', conv = cid, mid = 'album') => `/conv/${conv}/messages/${mid}/attachments/${ids[0]}?for=${scope}`;
test('G56 HTTP у обоих возвращает 409 старому дому и 200 после объявления dmalbum1 реальной связкой', async () => {
  const f = await fixture(); await album(); const { app, guardCalls } = await http(f), j = await f.journal();
  try {
    const refused = await app.inject({ method: 'DELETE', url: url() });
    assert.equal(refused.statusCode, 409); assert.equal(refused.json().error, 'album_item_peer_old');
    assert.equal(await f.state(ids[0]), 'attached'); assert.deepEqual(await f.journal(), j); assert.equal(f.events.length, 0);
    assert.deepEqual(guardCalls, [['shadow']]); assert.deepEqual(f.refreshes, [peer]);
    await t.raw.query('UPDATE federation_links SET features=$1::jsonb WHERE instance_id=$2', [JSON.stringify(['dm1', 'dm2', 'dmalbum1']), peer]);
    const allowed = await app.inject({ method: 'DELETE', url: url() });
    assert.equal(allowed.statusCode, 200); assert.deepEqual(allowed.json(), { removed: 'item' }); assert.equal(await f.state(ids[0]), 'deleted');
    assert.deepEqual(f.events.map(e => e.user), ['local', 'shadow']);
  } finally { await app.close(); }
});
test('G56 HTTP у меня обходит проверку старого дома и не меняет файлы собеседника', async () => {
  const f = await fixture(); await album(); const { app, guardCalls } = await http(f);
  try {
    const r = await app.inject({ method: 'DELETE', url: url('me') });
    assert.equal(r.statusCode, 200); assert.deepEqual(r.json(), { removed: 'item' }); assert.deepEqual(guardCalls, []); assert.deepEqual(f.refreshes, []);
    assert.equal(await f.state(ids[0]), 'attached'); assert.deepEqual(f.events.map(e => e.user), ['local']);
    const shadow = await f.c.messageFor('album', 'shadow') as shared.ConvMessage; assert.equal(shadow.attachments?.length, 3);
  } finally { await app.close(); }
});
test('G56 HTTP отсутствующая беседа или посторонний участник возвращают 404 до проверки дома', async () => {
  const f = await fixture(); await album();
  for (const viewer of ['local', 'outsider']) {
    const { app, guardCalls } = await http(f, viewer);
    try {
      const r = await app.inject({ method: 'DELETE', url: viewer === 'local' ? url('both', 'missing') : url() });
      assert.equal(r.statusCode, 404); assert.equal(r.json().error, 'not found'); assert.deepEqual(guardCalls, []);
    } finally { await app.close(); }
  }
  assert.equal(await f.state(ids[0]), 'attached');
});
test('G56 HTTP неизвестное сообщение даёт 404, чужой альбом у обоих даёт 403 при совместимом доме', async () => {
  const f = await fixture(); await album('shadow');
  await t.raw.query('UPDATE federation_links SET features=$1::jsonb WHERE instance_id=$2', [JSON.stringify(['dm1', 'dm2', 'dmalbum1']), peer]);
  const { app } = await http(f), j = await f.journal();
  try {
    const missing = await app.inject({ method: 'DELETE', url: url('both', cid, 'missing') }); assert.equal(missing.statusCode, 404);
    const forbidden = await app.inject({ method: 'DELETE', url: url() }); assert.equal(forbidden.statusCode, 403); assert.equal(forbidden.json().error, 'forbidden');
    assert.equal(await f.state(ids[0]), 'attached'); assert.deepEqual(await f.journal(), j); assert.equal(f.events.length, 0);
    const mine = await app.inject({ method: 'DELETE', url: url('me') }); assert.equal(mine.statusCode, 200);
  } finally { await app.close(); }
});
test('G56 HTTP местная беседа без dmalbum1 и отключённый крючок сохраняют разрешённое удаление', async () => {
  for (const mode of ['local', 'no-hook']) {
    const f = await fixture(), conv = mode === 'local' ? 'local-album' : cid; await album('local', conv);
    const { app } = await http(f, 'local', mode !== 'no-hook');
    try { assert.equal((await app.inject({ method: 'DELETE', url: url('both', conv) })).statusCode, 200); assert.equal(await f.state(ids[0]), 'deleted'); }
    finally { await app.close(); }
  }
});
