import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, beforeEach, after, test } from 'node:test';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Conv = typeof import('../src/conversations.js');
type Changes = typeof import('../src/federation/convChanges.js');
type Accept = typeof import('../src/federation/convAccept.js');
const self = 'a'.repeat(32), peer = 'b'.repeat(32), third = 'c'.repeat(32);
const cid = randomUUID(), mine = randomUUID(), remote = randomUUID(), alien = randomUUID(), hidden = randomUUID();
const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let t: TestDb;
before(async () => { t = await createTestDb(); });
beforeEach(async () => { await seed(); });
after(async () => { await t.close(); });
async function seed() {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'sync_local', displayName: 'Наш', passwordHash: 'fixture' },
    { id: 'shadow', username: 'sync_shadow', displayName: 'Сосед', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'peer-user' },
    { id: 'alien', username: 'sync_alien', displayName: 'Третий дом', passwordHash: 'fixture', homeInstanceId: third, homeUserId: 'third-user' },
  ]);
  await t.raw.query(`INSERT INTO federation_links(instance_id,domain,api_base,client_origin,root_key,state,features)
    VALUES ($1,'peer.invalid','https://peer.invalid/api','https://peer.invalid','fixture','active',$2::jsonb)`, [peer, JSON.stringify([shared.FED_FEATURES.dm1])]);
  await t.db.insert(schema.conversations).values({ id: cid, kind: 'direct', directKey: `${self}:local|${peer}:peer-user`, createdBy: 'local' });
  await t.db.insert(schema.conversationMembers).values([
    { conversationId: cid, userId: 'local', lastReadKey: 40 },
    { conversationId: cid, userId: 'shadow', lastReadKey: 40 },
  ]);
  await t.db.insert(schema.conversationMessages).values([
    { id: mine, conversationId: cid, authorId: 'local', sortKey: 10, content: 'Своё' },
    { id: remote, conversationId: cid, authorId: 'shadow', sortKey: 20, content: 'Копия соседа' },
    { id: alien, conversationId: cid, authorId: 'alien', sortKey: 30, content: 'Неизвестно соседу' },
    { id: hidden, conversationId: cid, authorId: 'local', sortKey: 40, content: 'Придержано', withheld: true },
  ]);
}
function mutate(raw: string, anchor: string, replacement: string) {
  assert.equal(raw.split(anchor).length - 1, 1, 'единственный якорь целого модуля');
  return raw.replace(anchor, replacement);
}
function forbidden(name: string) { return () => { throw new Error(`запрещённый IO ${name}`); }; }
function load<T>(name: string, deps: Record<string, unknown>, raw = source(name), globals: Record<string, unknown> = {}): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, URL, Buffer, console: { warn: forbidden('console.warn') },
      setTimeout: forbidden('реальный таймер'), setInterval: forbidden('worker'), ...globals,
      require: (id: string) => { if (!Object.hasOwn(deps, id)) throw new Error(`неописанный импорт ${id}`); return deps[id]; } });
  return module.exports as T;
}
function conv(raw = source('conversations')) {
  return load<Conv>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './convRules.js': rules,
    './db/index.js': { db: t.db }, './db/schema.js': schema,
    './dmWriteBarrier.js': { dmWriteBarrier: forbidden('dmWriteBarrier') },
    './attachments.js': Object.fromEntries(['attachmentLink', 'attachmentStore', 'copyForForward', 'DailyQuotaError', 'discardForwardCopies', 'privateAttachmentsReady', 'purgeDeleted'].map(k => [k, forbidden(k)])),
    './env.js': { env: {} }, './serialize.js': { homeInstanceOf: forbidden('homeInstanceOf'), serializeMessage: forbidden('serializeMessage') },
    './util.js': { uuidv7: randomUUID },
  }, raw);
}
function changes(raw = source('federation/convChanges')) {
  return load<Changes>('federation/convChanges', { '@gusvoice/shared': shared, 'drizzle-orm': orm,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema }, raw);
}
const msg = (id: string) => ({ conversationId: cid, kind: shared.FED_CONV_CHANGE.msg, entityId: id });
async function journalOracle(raw = source('conversations')) {
  await seed(); const c = conv(raw), ch = changes(); let calls = 0;
  c.configureFederatedConv({ selfInstanceId: () => self, record: async (tx, items) => { calls++; await ch.recordFedConvChanges(tx, items); } });
  const entries = [{ userId: 'local', conversationId: cid, kind: 'msg' as const, messageId: mine }];
  await t.db.transaction(tx => c.journal(tx as unknown as Parameters<Conv['journal']>[0], entries, { fed: false }));
  assert.equal(calls, 0, 'приём копии не вызывает fed hook');
  assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 0, 'приём копии не пишет fed journal');
  assert.equal((await t.db.select().from(schema.userChanges)).length, 1, 'местная догонка копии сохраняется');
  await t.db.transaction(tx => c.journal(tx as unknown as Parameters<Conv['journal']>[0], entries));
  assert.equal(calls, 1); assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 1);
}
test('R190 приём копии пишет местную догонку без эха, обычная запись вызывает федерацию', async () => {
  // Класс ошибки: журнал приёма отсылается владельцу обратно.
  await journalOracle();
});
test('R190 контрфакт без fed=false ловится вызовом hook, а не ошибкой загрузки', async () => {
  // Класс ошибки: снятый запрет эха.
  await journalOracle();
  await assert.rejects(journalOracle(mutate(source('conversations'), 'fedHooks?.record && opts.fed !== false', 'fedHooks?.record')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('приём копии не вызывает fed hook'));
});
async function foreignOracle(raw = source('federation/convChanges')) {
  await seed(); const ch = changes(raw);
  await t.db.transaction(tx => ch.recordFedConvChanges(tx as unknown as Parameters<Changes['recordFedConvChanges']>[0], [msg(mine), msg(remote)]));
  const rows = await t.db.select().from(schema.fedConvChanges);
  assert.equal(rows.some(r => r.entityId === remote), false, 'живая чужая копия не попадает в журнал');
  assert.equal(rows.some(r => r.entityId === mine), true, 'своё сообщение отдаётся');
  await t.db.update(schema.conversationMessages).set({ deletedAt: new Date(), content: '' }).where(orm.eq(schema.conversationMessages.id, remote));
  await t.db.transaction(tx => ch.recordFedConvChanges(tx as unknown as Parameters<Changes['recordFedConvChanges']>[0], [msg(remote)]));
  const page = await ch.changesForPeer(peer, 0, 100, self);
  assert.ok('items' in page, 'не reset');
  const tombstone = page.items.find(r => r.entityId === remote);
  assert.equal(!!tombstone, true, 'чужое надгробие отдаётся');
  assert.equal(tombstone?.entity?.deleted, true); assert.equal(tombstone?.entity?.content, '');
}
test('R190 своё сообщение отдаётся, чужая живая копия скрыта, чужое надгробие проходит', async () => {
  // Класс ошибки: чужая копия уходит эхом или удаление у обоих теряется.
  await foreignOracle();
});
test('R190 контрфакт снятого foreign-фильтра ловится чужим id в реальном журнале', async () => {
  // Класс ошибки: журнал размножает чужие сообщения.
  await foreignOracle();
  await assert.rejects(foreignOracle(mutate(source('federation/convChanges'), 'if (foreign.size > 0) {', 'if (false) {')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('живая чужая копия не попадает в журнал'));
});
async function e2(kind: string, entityId: string | null) {
  const ch = changes();
  await t.db.transaction(tx => ch.recordFedConvChanges(tx as unknown as Parameters<Changes['recordFedConvChanges']>[0], [{ conversationId: cid, kind: kind as typeof shared.FED_CONV_CHANGE.read, entityId }]));
  const page = await ch.changesForPeer(peer, 0, 100, self);
  assert.ok('items' in page, 'не reset');
  return page.items.find(r => r.kind === kind)?.entity;
}
test('R190 реакции содержат только наших людей, чужие реакции не выдаются за наши', async () => {
  // Класс ошибки: владелец чужой реакции подменён нашим инстансом.
  await t.db.insert(schema.conversationMessageReactions).values(['local', 'shadow', 'alien'].map(userId => ({ messageId: mine, userId, emoji: '👍' })));
  const parsed = shared.parseConvReactionsWire(await e2(shared.FED_CONV_CHANGE_E2.react, mine));
  assert.equal(parsed?.reactions.length, 1); assert.equal(parsed?.reactions[0].user.userId, 'local');
  assert.equal(parsed?.reactions[0].user.instanceId, self);
});
test('R190 прочитано указывает на последнюю известную соседу копию, не чужой дом и не withheld', async () => {
  // Класс ошибки: квитанция ссылается на неизвестный соседу id или чужого читателя.
  const parsed = shared.parseConvReadsWire(await e2(shared.FED_CONV_CHANGE.read, null));
  assert.equal(parsed?.reads.length, 1); assert.equal(parsed?.reads[0].user.userId, 'local');
  assert.equal(parsed?.reads[0].user.instanceId, self); assert.equal(parsed?.reads[0].messageId, remote);
});
test('R190 без известного сообщения и при блокировке соседа квитанция не раскрывается', async () => {
  // Класс ошибки: пустой read или блок обходится синхронизацией.
  await t.db.update(schema.conversationMembers).set({ lastReadKey: 0 }).where(orm.eq(schema.conversationMembers.userId, 'local'));
  assert.equal(shared.parseConvReadsWire(await e2(shared.FED_CONV_CHANGE.read, null))?.reads.length, 0);
  await t.db.update(schema.conversationMembers).set({ lastReadKey: 40 }).where(orm.eq(schema.conversationMembers.userId, 'local'));
  await t.db.insert(schema.userBlocks).values({ blockerId: 'local', blockedId: 'shadow' });
  assert.equal(shared.parseConvReadsWire(await e2(shared.FED_CONV_CHANGE.read, null))?.reads.length, 0);
});
test('R190 личный закреп не становится общим, закреп у обоих отдаёт настоящего местного владельца', async () => {
  // Класс ошибки: приватный закреп раскрывается соседу или pinnedBy получает чужой дом.
  await t.db.insert(schema.conversationPins).values([
    { conversationId: cid, userId: 'local', messageId: mine, pinnedBy: 'local', forBoth: true },
    { conversationId: cid, userId: 'shadow', messageId: mine, pinnedBy: 'local', forBoth: false },
  ]);
  assert.equal(shared.parseConvPinWire(await e2(shared.FED_CONV_CHANGE.pin, mine))?.pinned, false);
  await t.db.update(schema.conversationPins).set({ forBoth: true }).where(orm.eq(schema.conversationPins.userId, 'shadow'));
  const parsed = shared.parseConvPinWire(await e2(shared.FED_CONV_CHANGE.pin, mine));
  assert.equal(parsed?.pinned, true); assert.equal(parsed?.by?.instanceId, self); assert.equal(parsed?.by?.userId, 'local');
});
type Request = Parameters<typeof import('../src/federation/peerClient.js').getSignedFromPeer>[0];
type Answer = Awaited<ReturnType<typeof import('../src/federation/peerClient.js').getSignedFromPeer>>;
const answer = (seq: number, more = false): Answer => ({ ok: true, value: { status: 200, contentType: 'application/json', body: JSON.stringify({ instance_id: peer, seq, more, items: [] }) } });
function receiver(get: (r: Request) => Promise<Answer>) {
  const timers: { callback: () => void; ms: number }[] = [], rings: { id: string; seq: number }[] = [];
  const c = conv();
  const a = load<Accept>('federation/convAccept', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../convRules.js': rules,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema, '../conversations.js': c,
    '../convSendFanout.js': { fanOutSend: forbidden('push без сообщений') },
    './convLink.js': { notePeerAnswer: () => {}, onLinkRestored: forbidden('регистрация worker') },
    './eventStream.js': { onFedEvent: forbidden('регистрация worker'), sendEventTo: async (id: string, _kind: string, payload: { seq: number }) => { rings.push({ id, seq: payload.seq }); return 'sent'; } },
    './instance.js': { federation: { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'fixture', privateKeyDer: new Uint8Array() }) } },
    './peerClient.js': { getSignedFromPeer: get },
  }, undefined, { setTimeout: (callback: () => void, ms: number) => { timers.push({ callback, ms }); return timers.length; } });
  return { a, timers, rings };
}
async function cursor() { return Number((await t.db.select().from(schema.fedConvCursor))[0]?.since ?? 0); }
test('R190 звонки объединяются за 300мс по максимуму, соседние связки независимы', async () => {
  // Класс ошибки: потерян высокий seq или звонок до фиксации журнала.
  const f = receiver(async () => answer(0));
  f.a.ringDoorbell(peer, 5); f.a.ringDoorbell(peer, 2); f.a.ringDoorbell(third, 3);
  assert.equal(f.rings.length, 0); assert.equal(f.timers.length, 1); assert.equal(f.timers[0].ms, 300);
  f.timers.shift()!.callback();
  assert.equal(f.rings.length, 2); assert.equal(f.rings.find(r => r.id === peer)?.seq, 5);
  assert.equal(f.rings.find(r => r.id === third)?.seq, 3);
  f.a.ringDoorbell(peer, 6); assert.equal(f.timers.length, 1); f.timers.shift()!.callback();
  assert.equal(f.rings[2].seq, 6);
});
test('R190 забор двигает SQL-курсор по страницам и начинает повтор с сохранённого номера', async () => {
  // Класс ошибки: курсор теряется между страницами или повторяет всю историю.
  const since: number[] = [];
  const f = receiver(async r => { since.push(Number(r.query?.since)); return answer(since.length === 1 ? 2 : 5, since.length === 1); });
  assert.equal(await f.a.pullConvChanges(peer), 5); assert.equal(await cursor(), 5);
  assert.equal(since.join(','), '0,2');
  assert.equal(await f.a.pullConvChanges(peer), 5); assert.equal(since.join(','), '0,2,5');
});
test('R190 отказ соседа и неактивная связка не двигают курсор, активная страница принимается', async () => {
  // Класс ошибки: неуспешный забор подтверждает неполученные строки.
  await t.db.insert(schema.fedConvCursor).values({ instanceId: peer, since: 4 }); let requests = 0;
  const f = receiver(async () => { requests++; return { ok: true, value: { status: 503, contentType: 'application/json', body: '{}' } }; });
  assert.equal(await f.a.pullConvChanges(peer), null); assert.equal(await cursor(), 4);
  await t.db.update(schema.federationLinks).set({ state: 'paused' });
  assert.equal(await f.a.pullConvChanges(peer), null); assert.equal(requests, 1);
  await t.db.update(schema.federationLinks).set({ state: 'active' });
  assert.equal(await receiver(async () => answer(6)).a.pullConvChanges(peer), 6); assert.equal(await cursor(), 6);
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function until(predicate: () => Promise<boolean>) {
  // Только очереди задач, не часы/сеть. Ограничение превращает поломку барьера в AssertionError, не вечное зависание.
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise<void>(r => setImmediate(r)); }
  assert.fail('планировщик не достиг ожидаемого барьера');
}
test('R190 повторный звонок во время забора повышает цель без параллельных запросов и повторяет проход', async () => {
  // Класс ошибки: два одновременных забора перетирают курсор или теряют повторный звонок.
  const gates = [deferred<Answer>(), deferred<Answer>()]; let calls = 0, active = 0, maxActive = 0;
  const since: number[] = [];
  const f = receiver(async r => {
    const index = calls++; since.push(Number(r.query?.since)); active++; maxActive = Math.max(maxActive, active);
    assert.ok(index <= gates.length, 'нет лишнего забора');
    try { return index === gates.length ? answer(5) : await gates[index].promise; } finally { active--; }
  });
  try {
    f.a.schedulePull(peer, 2); await until(async () => calls === 1);
    f.a.schedulePull(peer, 5); f.a.schedulePull(peer, 3);
    assert.equal(calls, 1, 'повтор не запускает параллельный запрос');
    gates[0].resolve(answer(2));
    await until(async () => f.timers.length === 1);
    assert.equal(f.timers[0].ms, 1000); assert.equal(await cursor(), 2);
    f.timers.shift()!.callback(); await until(async () => calls === 2);
    assert.equal(since.join(','), '0,2'); assert.equal(maxActive, 1);
    gates[1].resolve(answer(5));
    // Первый pullLoop делает 0→2, паузу и 2→5; again затем запускает проход с since=5.
    await until(async () => calls === 3 && active === 0 && await cursor() === 5);
    assert.equal(since.join(','), '0,2,5'); assert.equal(maxActive, 1); assert.equal(f.timers.length, 0);
  } finally {
    // Даже красный assertion освобождает соседские барьеры и таймеры, а SQL-барьер дожидается очереди PGlite.
    for (const gate of gates) gate.resolve(answer(5));
    let quiet = 0;
    for (let i = 0; i < 100 && quiet < 10; i++) {
      for (const timer of f.timers.splice(0)) timer.callback();
      await new Promise<void>(r => setImmediate(r)); await cursor();
      quiet = active === 0 && f.timers.length === 0 ? quiet + 1 : 0;
    }
  }
});
