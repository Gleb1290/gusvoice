import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, beforeEach, after, test } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as admission from '../src/routes/fedAdmission.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Conv = typeof import('../src/conversations.js');
type Changes = typeof import('../src/federation/convChanges.js');
type Accept = typeof import('../src/federation/convAccept.js');
const wire = JSON.parse(readFileSync(new URL('../../shared/src/federation/fixtures/v1/conv-export-page.json', import.meta.url), 'utf8'));
const reset = JSON.parse(readFileSync(new URL('../../shared/src/federation/fixtures/v1/conv-changes-reset-head.json', import.meta.url), 'utf8'));
const peer: string = wire.instance_id, self: string = wire.items[2].entity.author.instance_id;
const cid: string = wire.conversation_id, local: string = wire.items[2].entity.author.user_id;
const homeUser: string = wire.items[0].entity.author.user_id;
const restored: string = wire.items[0].entity.id, tombstone: string = wire.items[2].entity.id;
const other = randomUUID(), group = randomUUID(), otherMessage = randomUUID();
let t: TestDb;
before(async () => { t = await createTestDb(); });
beforeEach(async () => { await seed(); });
after(async () => { await t.close(); });
async function seed() {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    { id: local, username: 'export_local', displayName: 'Наш', passwordHash: 'fixture' },
    { id: 'shadow', username: 'export_shadow', displayName: 'Сосед', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: homeUser },
  ]);
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: 'peer.invalid', apiBase: 'https://peer.invalid/api',
    clientOrigin: 'https://peer.invalid', rootKey: 'fixture', state: 'active', features: [shared.FED_FEATURES.dm1] });
  await t.db.insert(schema.conversations).values([
    { id: cid, kind: 'direct', directKey: `${self}:${local}|${peer}:${homeUser}` },
    { id: other, kind: 'direct', directKey: `${local}:${local}` },
    { id: group, kind: 'group', directKey: null },
  ]);
  await t.db.insert(schema.conversationMembers).values([
    { conversationId: cid, userId: local }, { conversationId: cid, userId: 'shadow' },
    { conversationId: other, userId: local }, { conversationId: group, userId: local }, { conversationId: group, userId: 'shadow' },
  ]);
  await t.db.insert(schema.conversationMessages).values({ id: otherMessage, conversationId: other, authorId: local, sortKey: 1, content: 'Чужая беседа' });
}
const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function mutate(raw: string, anchor: string, replacement: string) {
  assert.equal(raw.split(anchor).length - 1, 1, 'единственный якорь целого модуля'); return raw.replace(anchor, replacement);
}
function guard(name: string) { return () => { throw new Error(`запрещённый IO ${name}`); }; }
function load<T>(name: string, deps: Record<string, unknown>, raw = source(name)): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, URL, Buffer, console: { warn: () => {} },
      setTimeout: guard('таймер'), setInterval: guard('worker'),
      require: (id: string) => { if (!Object.hasOwn(deps, id)) throw new Error(`неописанный импорт ${id}`); return deps[id]; } });
  return module.exports as T;
}
function changes(raw = source('federation/convChanges')) {
  return load<Changes>('federation/convChanges', { '@gusvoice/shared': shared, 'drizzle-orm': orm,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema }, raw);
}
function conversations() {
  return load<Conv>('conversations', { '@gusvoice/shared': shared, 'drizzle-orm': orm, './convRules.js': rules,
    './db/index.js': { db: t.db }, './db/schema.js': schema, './dmWriteBarrier.js': { dmWriteBarrier: guard('dmWriteBarrier') },
    './attachments.js': Object.fromEntries(['attachmentLink', 'attachmentStore', 'copyForForward', 'DailyQuotaError', 'discardForwardCopies', 'privateAttachmentsReady', 'purgeDeleted'].map(k => [k, guard(k)])),
    './env.js': { env: {} }, './serialize.js': { homeInstanceOf: guard('serialize'), serializeMessage: guard('serialize') }, './util.js': { uuidv7: randomUUID },
  });
}
// Неисполняемые подсистемы маршрута: экспорт не должен обращаться к каталогу, почте, приглашениям или администрированию.
const routeIo = new Set(['auth', 'alerts', 'httpSignature', 'peerClient', 'links', 'instanceIdentity', 'auditLog', 'linkRules', 'authGuard',
  'guestGuard', 'directoryFeed', 'directoryRules', 'directoryCache', 'avatars', 'guestAccess', 'guestQuota', 'guestHost', 'invitePreview',
  'guestRevocation', 'convOpen', 'guestMembership', 'instanceBan', 'guestHome', 'identityToken', 'directorySync', 'syncSchedule',
  'eventStream', 'instanceMeta', 'contacts', 'keyRevocation', 'revocation']);
async function http(ch: Changes) {
  const raw = source('routes/federation'), deps: Record<string, unknown> = {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../env.js': { env: { federation: { dmEnabled: true } } }, './fedAdmission.js': admission,
    '../federation/instance.js': { federation: { identity: () => ({ instanceId: self }) } },
    '../federation/convChanges.js': ch, '../federation/guardsRuntime.js': { fedRateBlock: async () => 0, seenSignature: guard('seenSignature') },
    // Только admission IO поддельный: маршрут, разбор запроса, сериализация и проверка права беседы настоящие.
    '../federation/peerAuth.js': { authenticateLinkedPeer: async (_req: unknown, instanceId: string) => {
      assert.equal(instanceId, peer); const [link] = await t.db.select().from(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, peer));
      return { ok: true, link };
    }, refusalFor: guard('refusalFor'), targetUriOf: guard('targetUriOf') },
  };
  const ast = ts.createSourceFile('federation.ts', raw, ts.ScriptTarget.Latest, true);
  for (const n of ast.statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly) continue;
    const id = (n.moduleSpecifier as ts.StringLiteral).text;
    if (Object.hasOwn(deps, id)) continue;
    assert.equal(routeIo.has(id.split('/').at(-1)!.replace('.js', '')), true, `разрешённая неисполняемая граница ${id}`);
    const bindings = n.importClause?.namedBindings;
    assert.ok(bindings && ts.isNamedImports(bindings), `явные именованные импорты ${id}`);
    deps[id] = Object.fromEntries(bindings.elements.filter(e => !e.isTypeOnly).map(e => [(e.propertyName ?? e.name).text, guard(`${id}.${e.name.text}`)]));
  }
  const routes = load<typeof import('../src/routes/federation.js')>('routes/federation', deps, raw);
  const app = Fastify();
  try { await app.register(routes.federationRoutes); await app.ready(); return app; } catch (e) { await app.close(); throw e; }
}
async function authorization(raw = source('federation/convChanges')) {
  await seed(); const app = await http(changes(raw));
  try {
    const url = (id: string, after = '') => `/fed/v1/conv/${id}/export?instance_id=${peer}${after ? `&after=${after}` : ''}`;
    assert.equal((await app.inject(url(other))).statusCode, 404, 'чужая беседа не раскрывается');
    assert.equal((await app.inject(url(group))).statusCode, 404, 'группа не экспортируется');
    assert.equal((await app.inject(url(cid, otherMessage))).statusCode, 404, 'курсор из другой беседы не принимается');
    const accepted = await app.inject(url(cid)); assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(shared.parseConvExportPage(accepted.json())?.conversationId, cid);
  } finally { await app.close(); }
}
test('R191 исторические reset и export сохраняют провод туда-обратно без потери сущностей', () => {
  // Класс ошибки: новый полный проход ломает исторический протокол.
  const page = shared.parseConvExportPage(wire), head = shared.parseConvChangesPage(reset);
  assert.ok(!!page); assert.ok(!!head);
  assert.deepEqual(shared.serializeConvExportPage(page!), wire);
  assert.deepEqual(shared.serializeConvChangesPage(head!), reset);
});
test('R191 HTTP скрывает чужую беседу, группу и курсор другой беседы, общая беседа принимается', async () => {
  // Класс ошибки: экспорт становится чтением посторонней переписки.
  await authorization();
});
test('R191 контрфакт без home_instance_id ловится HTTP раскрытием чужой беседы', async () => {
  // Класс ошибки: авторизация общей беседы снята.
  await authorization();
  await assert.rejects(authorization(mutate(source('federation/convChanges'), "AND c.kind = 'direct' AND u.home_instance_id = ${instanceId} LIMIT 1", "AND c.kind = 'direct' LIMIT 1")),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('чужая беседа не раскрывается'));
});
test('R191 ровно сто сообщений завершают экспорт, сто первое переносится после id сотого с read и pin', async () => {
  // Класс ошибки: граница страницы съедает сообщение, квитанции или закрепы.
  for (const count of [100, 101]) {
    await seed(); const ids = Array.from({ length: count }, () => randomUUID());
    await t.db.insert(schema.conversationMessages).values(ids.map((id, i) => ({ id, conversationId: cid, authorId: local, sortKey: i + 1, content: `Строка ${i + 1}` })));
    await t.db.update(schema.conversationMembers).set({ lastReadKey: count }).where(orm.eq(schema.conversationMembers.userId, local));
    await t.db.insert(schema.conversationPins).values({ conversationId: cid, userId: 'shadow', messageId: ids[0], pinnedBy: local, forBoth: true });
    const ch = changes(), first = await ch.exportForPeer(peer, cid, null, self);
    assert.equal(first?.items.filter(i => i.kind === 'msg').length, 100);
    assert.equal(first?.next, count === 101 ? ids[99] : null);
    const last = count === 101 ? await ch.exportForPeer(peer, cid, first!.next, self) : first;
    assert.equal(last?.next, null); assert.equal(last?.items.filter(i => i.kind === 'msg').length, count === 101 ? 1 : 100);
    assert.equal(last?.items.some(i => i.kind === 'read'), true); assert.equal(last?.items.some(i => i.kind === 'pin' && i.entityId === ids[0]), true);
    if (count === 101) { assert.equal(first?.items.some(i => i.kind === 'read' || i.kind === 'pin'), false); assert.equal(last?.items.find(i => i.kind === 'msg')?.entityId, ids[100]); }
  }
});
async function foreign(raw = source('federation/convChanges')) {
  await seed(); const live = randomUUID(), dead = randomUUID(), own = randomUUID();
  await t.db.insert(schema.conversationMessages).values([
    { id: live, conversationId: cid, authorId: 'shadow', sortKey: 1, content: 'Чужая живая копия' },
    { id: dead, conversationId: cid, authorId: 'shadow', sortKey: 2, content: '', deletedAt: new Date() },
    { id: own, conversationId: cid, authorId: local, sortKey: 3, content: 'Наше' },
  ]);
  const page = await changes(raw).exportForPeer(peer, cid, null, self);
  assert.equal(page?.items.some(i => i.kind === 'msg' && i.entityId === live), false, 'живая чужая копия не экспортируется');
  assert.equal(page?.items.some(i => i.kind === 'msg' && i.entityId === own), true);
  const item = page?.items.find(i => i.kind === 'msg' && i.entityId === dead);
  assert.equal(item?.entity?.deleted, true); assert.equal(item?.entity?.content, '');
}
test('R191 экспорт отдаёт своё и чужое надгробие, но не чужую живую копию', async () => {
  // Класс ошибки: экспорт размножает копии или теряет удаление у обоих.
  await foreign();
});
test('R191 контрфакт выдачи живой чужой копии ловится id сообщения в экспортной странице', async () => {
  // Класс ошибки: проверка deletedAt чужого автора снята.
  await foreign();
  await assert.rejects(foreign(mutate(source('federation/convChanges'), 'else if (m.home === instanceId && m.deletedAt)', 'else if (m.home === instanceId)')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('живая чужая копия не экспортируется'));
});
type Request = Parameters<typeof import('../src/federation/peerClient.js').getSignedFromPeer>[0];
type Answer = Awaited<ReturnType<typeof import('../src/federation/peerClient.js').getSignedFromPeer>>;
const response = (body: unknown, status = 200): Answer => ({ ok: true, value: { status, contentType: 'application/json', body: JSON.stringify(body) } });
function receiver(get: (r: Request) => Promise<Answer>, raw = source('federation/convAccept')) {
  const pushes: string[] = [], deliveries: unknown[] = [], c = conversations();
  const a = load<Accept>('federation/convAccept', { '@gusvoice/shared': shared, 'drizzle-orm': orm, '../convRules.js': rules,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../conversations.js': { ...c, deliver: async (d: unknown) => { deliveries.push(d); } },
    '../convSendFanout.js': { fanOutSend: async (input: { peerId: string }) => { pushes.push(input.peerId); } },
    './convLink.js': { notePeerAnswer: () => {}, onLinkRestored: guard('worker') },
    './eventStream.js': { onFedEvent: guard('worker'), sendEventTo: guard('event IO') },
    './instance.js': { federation: { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'fixture', privateKeyDer: new Uint8Array() }) } },
    './peerClient.js': { getSignedFromPeer: get },
  }, raw);
  return { a, pushes, deliveries };
}
async function cursor() { return Number((await t.db.select().from(schema.fedConvCursor))[0]?.since ?? 0); }
test('R191 reset с головой восстанавливает настоящие копии, надгробие, read и pin до SQL-курсора головы', async () => {
  // Класс ошибки: полный проход подтверждает голову без восстановления сообщений.
  await t.db.insert(schema.conversationMessages).values({ id: tombstone, conversationId: cid, authorId: local, sortKey: 1, content: 'Наше удаляется у обоих' });
  await t.db.insert(schema.fedConvCursor).values({ instanceId: peer, since: 7 });
  const paths: string[] = [];
  const f = receiver(async r => {
    paths.push(r.path);
    if (r.path.endsWith('/changes')) return response(Number(r.query?.since) === 7 ? reset : { instance_id: peer, seq: reset.seq, more: false, items: [] });
    assert.equal(r.path, `/api/fed/v1/conv/${cid}/export`); assert.equal(r.query?.after, null); return response(wire);
  });
  assert.equal(await f.a.pullConvChanges(peer), reset.seq); assert.equal(await cursor(), reset.seq);
  assert.equal(paths.join(','), `/api/fed/v1/conv/changes,/api/fed/v1/conv/${cid}/export,/api/fed/v1/conv/changes`);
  const rows = await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.conversationId, cid));
  const copied = rows.find(r => r.id === restored), deleted = rows.find(r => r.id === tombstone);
  assert.equal(copied?.authorId, 'shadow'); assert.equal(copied?.content, wire.items[0].entity.content);
  assert.equal(copied?.originSortKey, wire.items[0].entity.origin_sort_key); assert.equal(!!deleted?.deletedAt, true); assert.equal(deleted?.content, '');
  assert.equal(f.pushes.join(','), local);
  assert.equal((await t.db.select().from(schema.conversationPins).where(orm.eq(schema.conversationPins.messageId, restored))).length, 2);
  const member = (await t.db.select().from(schema.conversationMembers).where(orm.eq(schema.conversationMembers.userId, 'shadow'))).find(r => r.conversationId === cid);
  assert.equal(member?.lastReadKey, copied?.sortKey); assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 0);
});
test('R191 reset старого соседа без головы оставляет курсор и не начинает экспорт', async () => {
  // Класс ошибки: отсутствующая голова превращается в подтверждённый нулевой курсор.
  await t.db.insert(schema.fedConvCursor).values({ instanceId: peer, since: 7 }); let calls = 0;
  const f = receiver(async r => { calls++; assert.equal(r.path.endsWith('/changes'), true); return response({ instance_id: peer, reset: true }); });
  assert.equal(await f.a.pullConvChanges(peer), 7); assert.equal(await cursor(), 7); assert.equal(calls, 1);
});
async function failed(status: number, raw = source('federation/convAccept')) {
  await seed(); await t.db.insert(schema.fedConvCursor).values({ instanceId: peer, since: 7 }); let exports = 0;
  const f = receiver(async r => {
    if (r.path.endsWith('/changes')) return response(reset);
    exports++; return response(status === 200 ? { ...wire, conversation_id: other } : {}, status);
  }, raw);
  assert.equal(await f.a.pullConvChanges(peer), 7, 'неудачный полный проход не подтверждает голову');
  assert.equal(await cursor(), 7, 'SQL-курсор остаётся до неудачного экспорта'); assert.equal(exports, 1);
  assert.equal((await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, restored))).length, 0);
}
for (const [status, name] of [[503, 'недоступный сосед'], [200, 'страница другой беседы']] as const) {
  test(`R191 ${name} при полном проходе не подтверждает голову журнала`, async () => {
    // Класс ошибки: failed export теряет историю сдвигом курсора.
    await failed(status);
  });
}
test('R191 контрфакт подтверждения головы после failed export ловится возвращённым и SQL-курсором', async () => {
  // Класс ошибки: неудача полного прохода игнорируется.
  await failed(503);
  await assert.rejects(failed(503, mutate(source('federation/convAccept'),
    'if (!(await fullPass(instanceId, self.instanceId, link.apiBase, host, key))) return since;',
    'if (!(await fullPass(instanceId, self.instanceId, link.apiBase, host, key))) { await db.insert(fedConvCursor).values({ instanceId, since: head }).onConflictDoUpdate({ target: fedConvCursor.instanceId, set: { since: head } }); return head; }')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('неудачный полный проход не подтверждает голову'));
});
