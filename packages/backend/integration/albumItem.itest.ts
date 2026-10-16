import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import { z } from 'zod';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as dmRules from '../src/dmRules.js';
import * as blockRules from '../src/blockRules.js';
import * as scheduleRules from '../src/scheduleRules.js';
import * as strangerRules from '../src/strangerRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
type Conv = typeof import('../src/conversations.js');
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => {
  try { await t?.close(); } finally { await (await import('../src/db/index.js')).pool.end(); }
});
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
const cid = 'album-source', target = 'album-target';
const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003'];
const attachment = (id: string) => ({ id, url: '', name: `${id.slice(-1)}.jpg`, contentType: 'image/jpeg', size: 10, width: 12, height: 14 });
type AlbumRow = { attachments: { id: string }[]; edit_version: number; edited_at: string | null; deleted_at: string | null; hidden_for: string[]; hidden_attachments: string[] };
async function fixture(mutation?: Mutation) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['local', 'other', 'recipient', 'outsider'].map(id => ({ id, username: `album_${id}`, displayName: id, passwordHash: 'fixture' })));
  const trace: string[] = [], purged: string[] = [], purgeTasks: Promise<void>[] = [], purgeStates: string[][] = [];
  const events: Array<{ user: string; body: shared.GatewayServerMessage }> = [], copied: string[][] = [];
  // Настоящие транзакции и SQL; маркер ставится после разрешения transaction(), не внутри callback перед COMMIT.
  const db = new Proxy(t.db, { get: (obj, key, receiver) => key === 'transaction'
    ? async (...args: Parameters<typeof t.db.transaction>) => { const result = await obj.transaction(...args); trace.push('commit'); return result; }
    : Reflect.get(obj, key, receiver) });
  const serialize = moduleOf<typeof import('../src/serialize.js')>('serialize', {
    '@gusvoice/shared': shared, './env.js': { env: {} }, './linkThreats.js': { dangerousLinksOf: () => [] },
    './federation/instanceLabels.js': { instanceLabel: () => null },
  });
  const c = moduleOf<Conv>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './db/index.js': { db }, './db/schema.js': schema, './convRules.js': rules,
    './serialize.js': serialize, './util.js': { uuidv7: randomUUID }, './env.js': { env: {} }, './dmWriteBarrier.js': { dmWriteBarrier: {} },
    './realtime.js': { publishToUser: async (user: string, body: shared.GatewayServerMessage) => { events.push({ user, body }); } },
    './attachments.js': {
      attachmentLink: (id: string, viewer: string) => `/fixture/${id}?viewer=${viewer}`, privateAttachmentsReady: () => true,
      DailyQuotaError: class extends Error {}, discardForwardCopies: async () => {},
      purgeDeleted: (keys: string[]) => {
        trace.push('purge'); purged.push(...keys);
        const task = t.raw.query<{ state: string }>('SELECT state FROM attachments WHERE storage_key = ANY($1::text[]) ORDER BY id', [keys])
          .then(result => { purgeStates.push(result.rows.map(r => r.state)); });
        purgeTasks.push(task); return task;
      },
      // Копирование байтов — IO-заглушка; attach, владельца и привязку к новому сообщению делает настоящий forwardMessages.
      copyForForward: async (input: { ownerId: string; conversationId: string; sources: (typeof schema.attachments.$inferSelect)[] }) => {
        copied.push(input.sources.map(s => s.id));
        const out = new Map();
        for (const s of input.sources) {
          const id = randomUUID();
          const [row] = await t.db.insert(schema.attachments).values({ id, conversationId: input.conversationId, ownerId: input.ownerId,
            storageKey: `dm/${id}`, name: s.name, contentType: s.contentType, size: s.size, state: 'pending' }).returning();
          out.set(s.id, row);
        }
        return out;
      },
    },
  }, mutation);
  await c.createDirect('local', 'other', { id: cid, originInstanceId: 'a'.repeat(32) });
  await c.createDirect('local', 'recipient', { id: target, originInstanceId: 'a'.repeat(32) });
  await t.raw.exec('UPDATE conversation_members SET pending=false');
  await t.db.insert(schema.conversationMessages).values([
    { id: 'album', conversationId: cid, authorId: 'local', sortKey: 1, content: 'Подпись альбома', captionAbove: true, attachments: ids.map(attachment) },
    { id: 'foreign-file-owner', conversationId: cid, authorId: 'other', sortKey: 2, content: 'Другая строка' },
  ]);
  for (const id of ids) await t.db.insert(schema.attachments).values({ id, conversationId: cid, ownerId: 'local', messageId: 'album',
    storageKey: `dm/${id}`, name: attachment(id).name, contentType: 'image/jpeg', size: 10, state: 'attached' });
  const access = async (me = 'local', conv = cid) => { const a = await c.loadAccess(conv, me); assert.ok(a); return a; };
  const row = async () => (await t.raw.query<AlbumRow>('SELECT attachments,edit_version,edited_at,deleted_at,hidden_for,hidden_attachments FROM conversation_messages WHERE id=$1', ['album'])).rows[0];
  const state = async (id: string) => (await t.raw.query<{ state: string }>('SELECT state FROM attachments WHERE id=$1', [id])).rows[0]?.state;
  const journal = async () => (await t.raw.query<{ user_id: string; kind: string; message_id: string | null }>('SELECT user_id,kind,message_id FROM user_changes ORDER BY user_id,pts')).rows;
  const view = async (me: string) => await c.messageFor('album', me) as shared.ConvMessage;
  trace.length = 0;
  return { c, access, row, state, journal, view, trace, purged, purgeStates, purgeTasks, events, copied };
}
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function failure(label: string, actual: unknown, expected: unknown) {
  return (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(label) && e.operator === 'strictEqual'
    && JSON.stringify(e.actual) === JSON.stringify(actual) && JSON.stringify(e.expected) === JSON.stringify(expected);
}
async function bothScenario(mutation?: Mutation) {
  const f = await fixture(mutation);
  await t.db.insert(schema.conversationPins).values(['local', 'other'].map(userId => ({ conversationId: cid, messageId: 'album', userId, pinnedBy: 'local' })));
  const old = (await f.journal()).length;
  const result = await f.c.deleteAlbumItem('local', await f.access(), 'album', ids[1], 'both');
  assert.ok(result.kind === 'ok' && result.removed === 'item' && result.delivery);
  await Promise.all(f.purgeTasks);
  const row = await f.row();
  assert.deepEqual(row.attachments.map(a => a.id), [ids[0], ids[2]], 'из jsonb убран только выбранный элемент');
  assert.equal(row.edit_version, 1, 'версия альбома растёт на один');
  assert.equal(row.edited_at, null, 'удаление элемента не ставит изм.');
  assert.equal(row.deleted_at, null);
  assert.equal(await f.state(ids[1]), 'deleted'); assert.equal(await f.state(ids[0]), 'attached'); assert.equal(await f.state(ids[2]), 'attached');
  assert.deepEqual(f.purged, [`dm/${ids[1]}`]); assert.deepEqual(f.purgeStates, [['deleted']]);
  assert.deepEqual(f.trace, ['commit', 'purge'], 'уборка запускается после настоящего COMMIT');
  assert.deepEqual(plain([...result.delivery.pts.keys()].sort()), ['local', 'other']);
  assert.deepEqual(plain([...result.delivery.pinPts!.keys()].sort()), ['local', 'other']);
  const changes = (await f.journal()).filter(r => r.message_id === 'album' || r.kind === 'pin');
  assert.equal((await f.journal()).length - old, 4, 'два сообщения и два обновления закрепов');
  assert.deepEqual(changes.map(r => `${r.user_id}:${r.kind}`), ['local:msg', 'local:pin', 'other:msg', 'other:pin']);
  await f.c.deliver(result.delivery);
  assert.deepEqual(f.events.map(e => e.user), ['local', 'other', 'local', 'other']);
  for (const e of f.events.slice(0, 2)) assert.deepEqual(plain((e.body as { message: shared.ConvMessage }).message.attachments?.map(a => a.id)), [ids[0], ids[2]]);
  for (const e of f.events.slice(2)) {
    assert.ok('pins' in e.body && e.body.pins, 'держатель получил обновлённую полосу закрепов');
    assert.equal(e.body.pins.length, 1); assert.equal(e.body.pins[0].message.id, 'album');
    assert.equal(e.body.pins[0].message.attachments, 2, 'закреп показывает уже суженный альбом');
    assert.equal(e.body.pins[0].thumb, `/fixture/${ids[0]}?viewer=${e.user}`);
  }
  return f;
}
test('G56 у обоих сужает jsonb, увеличивает версию, убирает файл после фиксации и обновляет обоих держателей закрепа', async () => {
  // Без версии сосед не примет правку; уборка до COMMIT способна стереть ещё живой файл при откате.
  await bothScenario();
});
test('G56 повтор удаления элемента не пишет журнал, не меняет версию и не повторяет уборку', async () => {
  const f = await fixture(), access = await f.access();
  await f.c.deleteAlbumItem('local', access, 'album', ids[0], 'both'); await Promise.all(f.purgeTasks);
  const beforeRow = await f.row(), beforeJournal = await f.journal();
  for (const id of [ids[0], 'missing']) {
    const r = await f.c.deleteAlbumItem('local', access, 'album', id, 'both');
    assert.ok(r.kind === 'ok' && r.delivery === null && r.removed === 'item');
  }
  assert.deepEqual(await f.row(), beforeRow); assert.deepEqual(await f.journal(), beforeJournal); assert.equal(f.purged.length, 1);
});
test('G56 у меня чужой элемент прячется только мне, событие и журнал не раскрывают действие собеседнику', async () => {
  const f = await fixture(), old = (await f.journal()).length;
  assert.equal((await f.c.deleteAlbumItem('other', await f.access('other'), 'album', ids[0], 'both')).kind, 'forbidden');
  assert.equal((await f.journal()).length, old);
  const r = await f.c.deleteAlbumItem('other', await f.access('other'), 'album', ids[0], 'me');
  assert.ok(r.kind === 'ok' && r.delivery && r.removed === 'item');
  assert.deepEqual((await f.row()).hidden_attachments, [`other:${ids[0]}`]);
  assert.deepEqual(plain((await f.view('other')).attachments?.map(a => a.id)), ids.slice(1));
  assert.equal((await f.view('local')).attachments?.length, 3); assert.equal(await f.state(ids[0]), 'attached');
  await f.c.deliver(r.delivery); assert.deepEqual(f.events.map(e => e.user), ['other']);
  assert.equal((await f.journal()).length - old, 1); assert.equal(f.purged.length, 0); assert.equal((await f.row()).edit_version, 0);
  const j = await f.journal(); const again = await f.c.deleteAlbumItem('other', await f.access('other'), 'album', ids[0], 'me');
  assert.ok(again.kind === 'ok' && again.delivery === null); assert.deepEqual(await f.journal(), j);
});
for (const scope of ['me', 'both'] as const) test(`G56 последний ${scope === 'me' ? 'видимый мне прячет' : 'общий уничтожает'} сообщение через обычное удаление`, async () => {
  const f = await fixture(), actor = scope === 'me' ? 'other' : 'local', access = await f.access(actor);
  for (const id of ids.slice(0, 2)) await f.c.deleteAlbumItem(actor, access, 'album', id, scope);
  const r = await f.c.deleteAlbumItem(actor, access, 'album', ids[2], scope); await Promise.all(f.purgeTasks);
  assert.ok(r.kind === 'ok' && r.removed === 'message' && r.whole?.kind === 'ok' && r.delivery);
  const row = await f.row();
  if (scope === 'me') {
    assert.deepEqual(row.hidden_for, ['other']); assert.equal(row.deleted_at, null);
    assert.equal((await f.view('local')).attachments?.length, 3); assert.equal(await f.state(ids[2]), 'attached'); assert.equal(f.purged.length, 0);
  } else {
    assert.ok(row.deleted_at); assert.deepEqual(row.attachments, []);
    assert.deepEqual([...f.purged].sort(), ids.map(id => `dm/${id}`).sort()); assert.equal(await f.state(ids[2]), 'deleted');
  }
});
test('G56 удаление не существует вне сообщения этой беседы и не видит скрытое сообщение', async () => {
  const f = await fixture(), access = await f.access();
  assert.equal((await f.c.deleteAlbumItem('local', access, 'missing', ids[0], 'both')).kind, 'not-found');
  await t.raw.exec("UPDATE conversation_messages SET hidden_for=ARRAY['local'] WHERE id='album'");
  assert.equal((await f.c.deleteAlbumItem('local', access, 'album', ids[0], 'both')).kind, 'not-found');
  assert.equal(await f.state(ids[0]), 'attached'); assert.equal(f.purged.length, 0);
});
test('G56 контрфакт потери прироста версии ловится реальной строкой PostgreSQL', async () => {
  await bothScenario();
  await assert.rejects(bothScenario(['attachments: m.attachments.filter((a) => a.id !== attachmentId),\n        editVersion: sql`${conversationMessages.editVersion} + 1`,',
    'attachments: m.attachments.filter((a) => a.id !== attachmentId),\n        editVersion: sql`${conversationMessages.editVersion}`,']), failure('версия альбома растёт на один', 0, 1));
});
test('G56 контрфакт отметки изм. ловится сохранённым edited_at, а не ошибкой VM', async () => {
  await bothScenario();
  await assert.rejects(bothScenario(['attachments: m.attachments.filter((a) => a.id !== attachmentId),',
    'attachments: m.attachments.filter((a) => a.id !== attachmentId), editedAt: new Date(),']),
  e => e instanceof assert.AssertionError && e.message.startsWith('удаление элемента не ставит изм.')
    && e.actual instanceof Date && Number.isFinite(e.actual.getTime()) && e.expected === null && e.operator === 'strictEqual');
});
async function scopedFile(mutation?: Mutation) {
  const f = await fixture(mutation);
  // JSON может пережить неверную старую привязку. Знания aid недостаточно, чтобы стереть файл другого сообщения.
  await t.raw.query("UPDATE attachments SET message_id='foreign-file-owner' WHERE id=$1", [ids[0]]);
  assert.equal((await f.c.deleteAlbumItem('local', await f.access(), 'album', ids[0], 'both')).kind, 'ok');
  await Promise.all(f.purgeTasks);
  assert.equal(await f.state(ids[0]), 'attached', 'файл другого сообщения не удаляется');
  assert.equal(f.purged.length, 0); assert.deepEqual((await f.row()).attachments.map(a => a.id), ids.slice(1));
}
test('G56 условие messageId защищает файл чужой строки и его снятие ловится реальным SQL', async () => {
  await scopedFile();
  const anchor = 'eq(attachments.id, attachmentId),\n          eq(attachments.messageId, messageId),';
  await assert.rejects(scopedFile([anchor, 'eq(attachments.id, attachmentId),']), failure('файл другого сообщения не удаляется', 'deleted', 'attached'));
});
test('G56 пересылка выбранного элемента копирует один файл без общей подписи, целиком сохраняет все три и подпись', async () => {
  const f = await fixture(), access = await f.access('local', target);
  const single = await f.c.forwardMessages('local', access, { clientId: randomUUID(), fromConversationId: cid, messageIds: ['album'], attachmentId: ids[1], withheld: false });
  assert.ok(single.kind === 'created'); const row = single.rows[0];
  assert.equal(row.attachments.length, 1); assert.equal(row.content, ''); assert.equal(row.captionAbove, false); assert.notEqual(row.attachments[0].id, ids[1]);
  const file = (await t.db.select().from(schema.attachments).where(orm.eq(schema.attachments.id, row.attachments[0].id!)))[0];
  assert.equal(file.ownerId, 'local'); assert.equal(file.conversationId, target); assert.equal(file.messageId, row.id); assert.equal(file.state, 'attached');
  assert.deepEqual(f.copied, [[ids[1]]]); assert.equal(await f.state(ids[1]), 'attached');
  const all = await f.c.forwardMessages('local', access, { clientId: randomUUID(), fromConversationId: cid, messageIds: ['album'], withheld: false });
  assert.ok(all.kind === 'created'); assert.equal(all.rows[0].attachments.length, 3); assert.equal(all.rows[0].content, 'Подпись альбома'); assert.equal(all.rows[0].captionAbove, true);
});
test('G56 отсутствующий и спрятанный мной элемент не пересылаются, чужая пометка не препятствует автору', async () => {
  const f = await fixture(), access = await f.access();
  await f.c.deleteAlbumItem('other', await f.access('other'), 'album', ids[0], 'me');
  for (const [actor, id] of [['other', ids[0]], ['local', 'missing']]) {
    const r = await f.c.forwardMessages(actor, await f.access(actor), { clientId: randomUUID(), fromConversationId: cid, messageIds: ['album'], attachmentId: id, withheld: false });
    assert.ok(r.kind === 'source-missing'); assert.deepEqual(plain(r.missing), ['album']);
  }
  assert.equal(f.copied.length, 0);
  const allowed = await f.c.forwardMessages('local', access, { clientId: randomUUID(), fromConversationId: cid, messageIds: ['album'], attachmentId: ids[0], withheld: false });
  assert.equal(allowed.kind, 'created');
});
test('G56 отпечатки целого альбома и отдельных элементов различаются, точный повтор не копирует файл снова', async () => {
  const f = await fixture(), access = await f.access('local', target), clientId = randomUUID();
  const input = { clientId, fromConversationId: cid, messageIds: ['album'], attachmentId: ids[0], withheld: false };
  assert.equal((await f.c.forwardMessages('local', access, input)).kind, 'created');
  assert.equal((await f.c.forwardMessages('local', access, input)).kind, 'replay'); assert.equal(f.copied.length, 1);
  assert.equal((await f.c.forwardMessages('local', access, { ...input, attachmentId: undefined })).kind, 'conflict');
  assert.equal((await f.c.forwardMessages('local', access, { ...input, attachmentId: ids[1] })).kind, 'conflict'); assert.equal(f.copied.length, 1);
});

async function forwardHttp(f: Awaited<ReturnType<typeof fixture>>) {
  const routes = moduleOf<typeof import('../src/routes/conv.js')>('routes/conv', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: { z }, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../conversations.js': f.c, '../convRules.js': rules, '../dmRules.js': dmRules, '../blockRules.js': blockRules,
    '../scheduleRules.js': scheduleRules, '../strangerRules.js': strangerRules,
    '../auth.js': { requireAuth: async () => {}, isSuperAdmin: () => false }, '../authGuard.js': { rateHit: async () => 0, messageSendBlock: async () => 0 },
    './att.js': { convAttachmentRefsSchema: z.array(z.object({ id: z.string() })) },
    '../blocks.js': { isBlockedBy: async () => false }, '../push.js': { forwardPreview: () => '', sendPushToUsers: async () => {}, withSilent: (x: unknown) => x, pushThrottleSource: () => '' },
  });
  const app = Fastify();
  app.addHook('preHandler', async req => { req.user = { sub: 'local' } as typeof req.user; });
  try { await app.register(routes.convRoutes); await app.ready(); return app; } catch (e) { await app.close(); throw e; }
}
test('G56 HTTP пересылки отвергает attachmentId с двумя сообщениями до копирования файлов', async () => {
  const f = await fixture(), app = await forwardHttp(f);
  try {
    const r = await app.inject({ method: 'POST', url: `/conv/${target}/forward`, payload: {
      clientId: randomUUID(), fromConversationId: cid, messageIds: ['album', 'foreign-file-owner'], attachmentId: ids[0],
    } });
    assert.equal(r.statusCode, 400); assert.equal(r.json().error, 'attachmentId needs one message'); assert.equal(f.copied.length, 0);
  } finally { await app.close(); }
});
test('G56 HTTP пересылки отличает 201 одного элемента, 200 повтора и 409 целого с тем же clientId', async () => {
  const f = await fixture(), app = await forwardHttp(f), clientId = randomUUID();
  const payload = { clientId, fromConversationId: cid, messageIds: ['album'], attachmentId: ids[0] };
  try {
    const made = await app.inject({ method: 'POST', url: `/conv/${target}/forward`, payload });
    assert.equal(made.statusCode, 201); assert.equal(made.json().messages[0].content, ''); assert.equal(made.json().messages[0].attachments.length, 1);
    assert.equal((await app.inject({ method: 'POST', url: `/conv/${target}/forward`, payload })).statusCode, 200);
    const whole = await app.inject({ method: 'POST', url: `/conv/${target}/forward`, payload: { clientId, fromConversationId: cid, messageIds: ['album'] } });
    assert.equal(whole.statusCode, 409); assert.equal(whole.json().error, 'client_id_conflict'); assert.equal(f.copied.length, 1);
  } finally { await app.close(); }
});
