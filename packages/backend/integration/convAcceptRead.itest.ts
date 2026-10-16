import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, afterEach, before, test } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Accept = typeof import('../src/federation/convAccept.js') & { __testRefusedConvs: Set<string> };
type Conv = typeof import('../src/conversations.js');
type Mutation = readonly [string, string];
type Request = Parameters<typeof import('../src/federation/peerClient.js').getSignedFromPeer>[0];
type Answer = Awaited<ReturnType<typeof import('../src/federation/peerClient.js').getSignedFromPeer>>;
const self = 'a'.repeat(32), peer = 'b'.repeat(32), cid = 'r235-direct';
const remote = { instanceId: peer, userId: 'remote' };
const originalReadAt = new Date('2026-10-01T12:00:00Z');
let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db.close(); });
const ioFailures: string[] = [];
afterEach(() => { try { assert.deepEqual(ioFailures, [], 'неожиданный IO не скрыт обработчиком отказа'); } finally { ioFailures.length = 0; } });
const failIO = (name: string) => () => { ioFailures.push(name); throw new Error(`неожиданная граница ${name}`); };
function load<T>(name: string, deps: Record<string, unknown>, mutation?: Mutation, warnings: string[] = []): T {
  let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation) {
    assert.equal(source.split(mutation[0]).length - 1, 1, 'R235-anchor: единственный якорь целого модуля');
    source = source.replace(...mutation);
  }
  // Только ссылка на настоящее закрытое состояние; никаких копий алгоритма/фрагментов.
  if (name === 'federation/convAccept') source += '\nmodule.exports.__testRefusedConvs = refusedConvs;\n';
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    module, exports: module.exports, Date, Buffer, URL,
    console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
    setTimeout: failIO('таймер'), setInterval: failIO('worker'),
    require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `явный импорт ${id}`); return deps[id]; },
  });
  return module.exports as T;
}
function wire(overrides: Partial<shared.FedConvMessageWire> = {}) {
  return shared.serializeConvMessageWire({
    id: 'answer', conversationId: cid, author: remote, clientId: null, payloadHash: null,
    createdAt: Date.now(), originSortKey: 999, content: 'Ответ соседа', replyToId: null,
    forwardedFrom: null, silent: false, noPreview: false, captionAbove: false,
    replyQuote: null, sticker: null, service: null, attachments: [], editVersion: 0, editedAt: null, deleted: false,
    ...overrides,
  });
}
async function createConversation() {
  await db.db.insert(schema.conversations).values({ id: cid, kind: 'direct', directKey: 'r235-pair', createdBy: 'local' });
  await db.db.insert(schema.conversationMembers).values([
    { conversationId: cid, userId: 'local', lastReadKey: 0 },
    { conversationId: cid, userId: 'shadow', lastReadKey: 10 },
  ]);
  await db.db.insert(schema.conversationMessages).values([
    { id: 'older', conversationId: cid, authorId: 'local', sortKey: 5, content: 'Уже прочитано', readAt: originalReadAt },
    { id: 'lower-bound', conversationId: cid, authorId: 'local', sortKey: 10, content: 'Старая граница' },
    { id: 'ours', conversationId: cid, authorId: 'local', sortKey: 20, content: 'Ждёт ответа' },
    { id: 'peer-own', conversationId: cid, authorId: 'shadow', sortKey: 30, content: 'Самому себе не читатель' },
  ]);
  await db.db.update(schema.conversations).set({ lastSortKey: 30 }).where(orm.eq(schema.conversations.id, cid));
}
async function fixture(mutation?: Mutation, present = true) {
  await truncateAll(db.raw);
  await db.db.insert(schema.users).values([
    { id: 'local', username: 'r235_local', displayName: 'Наш', passwordHash: 'fixture' },
    { id: 'shadow', username: 'r235_shadow', displayName: 'Сосед', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'remote' },
  ]);
  await db.raw.query(`INSERT INTO federation_links(instance_id,domain,api_base,client_origin,root_key,state,features)
    VALUES ($1,'peer.invalid','https://peer.invalid/api','https://peer.invalid','fixture','active',$2::jsonb)`,
  [peer, JSON.stringify([shared.FED_FEATURES.dm1])]);
  if (present) await createConversation();
  const deliveries: unknown[] = [], fanouts: Array<{ notifyRecipient: boolean }> = [], warnings: string[] = [];
  const c = load<Conv>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './convRules.js': rules,
    './db/index.js': { db: db.db }, './db/schema.js': schema,
    './dmWriteBarrier.js': { dmWriteBarrier: failIO('dmWriteBarrier') }, './attachments.js': {},
    './env.js': { env: {} }, './serialize.js': { homeInstanceOf: failIO('homeInstanceOf'), serializeMessage: failIO('serializeMessage') },
    './util.js': { uuidv7: randomUUID },
  });
  let get: (r: Request) => Promise<Answer> = async () => { throw new Error('нет ответа страницы'); };
  const accept = load<Accept>('federation/convAccept', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../convRules.js': rules,
    '../db/index.js': { db: db.db }, '../db/schema.js': schema,
    '../conversations.js': { ...c, deliver: async (d: unknown) => { if (d) deliveries.push(d); } },
    '../convSendFanout.js': { fanOutSend: async (p: { notifyRecipient: boolean }) => { fanouts.push(p); } },
    './convLink.js': { notePeerAnswer: () => {}, onLinkRestored: failIO('onLinkRestored') },
    './eventStream.js': { onFedEvent: failIO('onFedEvent'), sendEventTo: failIO('sendEventTo') },
    './instance.js': { federation: { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'fixture', privateKeyDer: Buffer.from([1]) }) } },
    './peerClient.js': { getSignedFromPeer: (r: Request) => get(r) },
  }, mutation, warnings);
  return { accept, deliveries, fanouts, warnings, get: (fn: typeof get) => { get = fn; },
    apply: (entity = wire()) => accept.applyChange(peer, self, 'msg', cid, entity) };
}
const row = async (id: string) => (await db.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, id)))[0];
const reader = async () => (await db.db.select().from(schema.conversationMembers).where(orm.eq(schema.conversationMembers.userId, 'shadow')))[0]?.lastReadKey;
const journal = async () => db.db.select().from(schema.userChanges);

test('R235 ответ соседа читает наши сообщения до копии, не свои, не старую границу и не другую беседу', async () => {
  const f = await fixture();
  await db.db.insert(schema.conversations).values({ id: 'other', kind: 'direct', directKey: 'other-pair', createdBy: 'local' });
  await db.db.insert(schema.conversationMessages).values({ id: 'other-msg', conversationId: 'other', authorId: 'local', sortKey: 20, content: 'Другая беседа' });
  await f.apply();
  assert.equal(await reader(), (await row('answer')).sortKey, 'R235-answer: курсор соседа до ответа');
  assert.equal((await row('ours')).readAt instanceof Date, true);
  assert.equal((await row('peer-own')).readAt, null);
  assert.equal((await row('answer')).readAt, null);
  assert.equal((await row('lower-bound')).readAt, null);
  assert.equal((await row('older')).readAt?.getTime(), originalReadAt.getTime());
  assert.equal((await row('other-msg')).readAt, null);
  assert.equal((await journal()).filter(r => r.userId === 'local' && r.kind === 'msg').length, 1);
  assert.equal((await journal()).filter(r => r.kind === 'read').length, 0, 'сводка прочтения едет с msg, без второй строки read');
  assert.equal(f.fanouts.length, 1); assert.equal(f.fanouts[0].notifyRecipient, true);
});

test('R235 повтор и правка ответа не двигают уже поднятый курсор и не меняют время чтения', async () => {
  const f = await fixture(); await f.apply();
  const key = await reader(), readAt = (await row('ours')).readAt?.getTime(), n = (await journal()).length;
  await f.apply();
  assert.equal((await journal()).length, n); assert.equal(f.fanouts.length, 1);
  await f.apply(wire({ content: 'Исправленный ответ', editVersion: 1, editedAt: Date.now() }));
  assert.equal((await row('answer')).content, 'Исправленный ответ');
  assert.equal(await reader(), key); assert.equal((await row('ours')).readAt?.getTime(), readAt);
  await f.apply(wire({ id: 'another' }));
  assert.equal(await reader(), (await row('another')).sortKey);
  assert.equal(Number(await reader()) > Number(key), true, 'R235-forward: следующий ответ продвигает курсор только вперёд');
  assert.equal((await row('ours')).readAt?.getTime(), readAt);
});

async function blocked(mutation?: Mutation, copied?: (key: number) => void) {
  const f = await fixture(mutation);
  await db.db.insert(schema.userBlocks).values({ blockerId: 'local', blockedId: 'shadow' });
  await f.apply();
  copied?.((await row('answer')).sortKey);
  assert.equal(await reader(), 10, 'R235-blocked: скрытый ответ не означает прочтение');
  assert.equal((await row('ours')).readAt, null); assert.equal((await row('answer')).withheld, true);
  assert.equal((await journal()).filter(r => r.userId === 'local').length, 0);
  assert.equal(f.fanouts[0].notifyRecipient, false);
}
test('R235 заблокированный ответ сохраняется скрытым без квитанции и события местному', async () => { await blocked(); });
test('R235 запрет сообщений также удерживает ответ без прочтения', async () => {
  const f = await fixture(); f.accept.configureFedMessagePrivacy(async () => false); await f.apply();
  assert.equal(await reader(), 10); assert.equal((await row('ours')).readAt, null);
  assert.equal((await row('answer')).withheld, true); assert.equal(f.fanouts[0].notifyRecipient, false);
});
test('R235 служебная запись звонка не выдаётся за прочтение соседом', async () => {
  const f = await fixture(); await f.apply(wire({ service: { kind: 'call', reason: 'missed', duration: 0, video: false } }));
  assert.equal(!!await row('answer'), true); assert.equal(await reader(), 10); assert.equal((await row('ours')).readAt, null);
});
test('R235 ответ в группе не двигает личное прочтение автора', async () => {
  const f = await fixture();
  await db.db.update(schema.conversations).set({ kind: 'group', directKey: null, originInstanceId: peer }).where(orm.eq(schema.conversations.id, cid));
  f.accept.configureFedGroupAccept({ applyConv: async () => {}, verify: () => true });
  await f.apply(); assert.equal(!!await row('answer'), true); assert.equal(await reader(), 10); assert.equal((await row('ours')).readAt, null);
});
test('R235 правка ранее сохранённой копии не объявляет непрочитанное прочитанным', async () => {
  const f = await fixture();
  await db.db.insert(schema.conversationMessages).values({ id: 'answer', conversationId: cid, authorId: 'shadow', sortKey: 40, originSortKey: 999, content: 'Старый ответ' });
  await f.apply(wire({ content: 'Правка', editVersion: 1, editedAt: Date.now() }));
  assert.equal((await row('answer')).content, 'Правка'); assert.equal(await reader(), 10); assert.equal((await row('ours')).readAt, null);
});

function change(seq: number, kind: string, entity: Record<string, unknown>): shared.FedConvChange {
  return { seq, kind, conversationId: cid, entityId: kind === 'msg' ? 'answer' : null, entity };
}
function page(seq: number, items: shared.FedConvChange[]): Answer {
  return { ok: true, value: { status: 200, contentType: 'application/json', body: JSON.stringify(shared.serializeConvChangesPage({ instanceId: peer, seq, more: false, items })) } };
}
const cursor = async () => Number((await db.db.select().from(schema.fedConvCursor))[0]?.since ?? 0);
async function refused(mutation?: Mutation) {
  const f = await fixture(mutation, false); let calls = 0, opens = 0;
  f.accept.configureFedConvRow(async () => { opens++; return false; });
  f.get(async r => { calls++; assert.equal(Number(r.query?.since), 0); return page(1, [change(1, 'conv', { kind: 'direct' })]); });
  assert.equal(await f.accept.pullConvChanges(peer), 1); assert.equal(opens, 1);
  assert.equal(f.accept.__testRefusedConvs.has(cid), true, 'отказ действительно запомнен до восстановления');
  return { ...f, requests: () => calls, next: (fn: (r: Request) => Answer) => f.get(async r => { calls++; return fn(r); }) };
}
for (const kind of ['read', 'msg'] as const) test(`R235 отказанная беседа после местного открытия принимает ${kind === 'read' ? 'прочтение' : 'ответ'} соседа`, async () => {
  const f = await refused(); await createConversation();
  const entity = kind === 'read' ? shared.serializeConvReadsWire({ reads: [{ user: remote, messageId: 'ours' }] }) : wire();
  f.next(r => { assert.equal(Number(r.query?.since), 1); return page(2, [change(2, kind, entity)]); });
  assert.equal(await f.accept.pullConvChanges(peer), 2); assert.equal(await cursor(), 2);
  assert.equal(await reader(), kind === 'read' ? 20 : (await row('answer')).sortKey);
  assert.equal((await row('ours')).readAt instanceof Date, true); assert.equal(f.warnings.length, 0);
});
async function absent(mutation?: Mutation) {
  const f = await refused(mutation);
  const items = [change(2, 'read', shared.serializeConvReadsWire({ reads: [{ user: remote, messageId: 'ours' }] })), change(3, 'msg', wire())];
  f.next(r => Number(r.query?.since) === 1 ? page(3, items) : page(3, []));
  assert.equal(await f.accept.pullConvChanges(peer), 3, 'R235-absent: отказанная без беседы пропускается без повтора');
  assert.equal(await cursor(), 3); assert.equal(await f.accept.pullConvChanges(peer), 3);
  assert.equal(f.requests(), 3); assert.equal(f.warnings.length, 0);
  assert.equal((await journal()).length, 0); assert.equal(await row('answer'), undefined);
}
test('R235 всё ещё отсутствующая отказанная беседа пропускает read и msg без повторов', async () => { await absent(); });
async function forgetRefusal(mutation?: Mutation) {
  const f = await refused(mutation); await createConversation();
  f.next(() => page(2, [change(2, 'read', shared.serializeConvReadsWire({ reads: [{ user: remote, messageId: 'ours' }] }))]));
  assert.equal(await f.accept.pullConvChanges(peer), 2); assert.equal(await reader(), 20);
  assert.equal(f.accept.__testRefusedConvs.has(cid), false, 'R235-forget: восстановленная беседа больше не числится отказанной');
  assert.equal(await cursor(), 2); assert.equal(f.warnings.length, 0);
}
test('R235 успешное восстановление снимает настоящую внутреннюю отметку отказа', async () => { await forgetRefusal(); });

function killed(prefix: string, actual: number | boolean, expected: number | boolean) {
  return (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(prefix) &&
    e.operator === 'strictEqual' && e.actual === actual && e.expected === expected;
}
test('R235 контрфакт без blocked guard раскрывает прочтение настоящей SQL-строкой', async () => {
  await blocked();
  let copiedKey = 0;
  await assert.rejects(blocked(['if (!c.group && !blocked && !service && author.home === peer)', 'if (!c.group && !service && author.home === peer)'], key => { copiedKey = key; }),
    (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith('R235-blocked:') && e.operator === 'strictEqual' && copiedKey > 10 && e.actual === copiedKey && e.expected === 10);
});
test('R235 контрфакт без present guard удерживает курсор отказанной отсутствующей беседы', async () => {
  await absent();
  await assert.rejects(absent(['if (!present.has(item.conversationId)) continue;', '// present guard удалён']), killed('R235-absent:', 1, 3));
});
test('R235 контрфакт без удаления refusedConvs оставляет устаревший отказ после реального приёма read', async () => {
  await forgetRefusal();
  await assert.rejects(forgetRefusal(['refusedConvs.delete(item.conversationId);', '// отказ не забыт']), killed('R235-forget:', true, false));
});
