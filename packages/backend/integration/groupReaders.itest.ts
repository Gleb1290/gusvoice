import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, afterEach, before, test } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import { z } from 'zod';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as convRules from '../src/convRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = { file: string; from: string; to: string };
const NOW = Date.UTC(2026, 9, 15, 12), DAY = 86_400_000, KEY = 20;
class Clock extends Date { static now() { return NOW; } }
const ioFailures: string[] = [];
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t.close(); });
afterEach(() => { try { assertIo(); } finally { ioFailures.length = 0; } });
function assertIo() { assert.deepEqual(ioFailures, [], 'R239-IO: приложение не проглотило выход за закрытую границу'); }
function forbidden(label: string): never { ioFailures.push(label); throw new Error(`неописанная IO-граница ${label}`); }
const dormant = (label: string) => new Proxy({}, { get: (_target, key) => key === '__esModule' ? true : forbidden(`${label}.${String(key)}`) });

// Список фиксирован вручную: новый статический импорт не становится разрешённым от одного появления в исходнике.
const knownImports: Record<string, readonly string[]> = {
  conversations: ['@gusvoice/shared', 'drizzle-orm', './convRules.js', './db/index.js', './db/schema.js', './dmWriteBarrier.js', './attachments.js', './env.js', './serialize.js', './util.js'],
  'db/peerQueries': ['drizzle-orm', './index.js'],
  lastSeenRules: [],
  lastSeen: ['drizzle-orm', './conversations.js', './blocks.js', './db/index.js', './db/peerQueries.js', './db/schema.js', './gateway.js', './lastSeenRules.js'],
  'routes/conv': ['@gusvoice/shared', 'drizzle-orm', 'zod', '../auth.js', '../authGuard.js', '../guestGuard.js', './att.js', '../stickerCatalog.js', '../blockRules.js', '../blocks.js', '../conversations.js', '../convSendFanout.js', '../dmReports.js', '../strangerRules.js', '../scheduled.js', '../scheduleRules.js', '../convRules.js', '../contacts.js', '../contactRules.js', '../db/index.js', '../realtime.js', './dmFolders.js', '../db/peerQueries.js', '../lastSeen.js', '../db/schema.js', '../dmRules.js', '../instanceSetup.js', '../userSearchRules.js', '../push.js', '../superAdminRules.js'],
};
function load<T>(file: string, explicit: Record<string, unknown>, mutation?: Mutation): T {
  let source = readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation?.file === file) {
    assert.equal(source.split(mutation.from).length - 1, 1, `R239-anchor: единственный якорь ${file}`);
    source = source.replace(mutation.from, mutation.to);
  }
  const deps: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly) continue;
    const id = (n.moduleSpecifier as ts.StringLiteral).text;
    if (!knownImports[file]?.includes(id)) forbidden(`статический импорт ${file}:${id}`);
    deps[id] = dormant(`${file}:${id}`);
  }
  Object.assign(deps, explicit);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Date: Clock, Map, Set, Promise, Buffer, URL, Error,
    fetch: () => forbidden('fetch'), setTimeout: () => forbidden('таймер'), setInterval: () => forbidden('worker'),
    console: { warn: () => forbidden('console.warn'), error: () => forbidden('console.error'), log: () => forbidden('console.log') },
    require: (id: string) => { if (!Object.hasOwn(deps, id)) forbidden(`динамический импорт ${file}:${id}`); return deps[id]; },
  });
  return module.exports as T;
}

async function fixture(mutation?: Mutation) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['a', 'b', 'c', 'd', 'former', 'outsider'].map(id => ({
    id, username: `readers_${id}`, displayName: `Имя ${id}`, avatarUrl: id === 'b' ? '/fixture-b.webp' : null,
    passwordHash: 'fixture', lastSeenPrivacy: 'everyone', hideReadTime: false,
  })));
  await t.db.insert(schema.conversations).values([
    { id: 'group', kind: 'group', title: 'Группа', createdBy: 'a', lastSortKey: 30 },
    { id: 'other', kind: 'group', title: 'Другая', createdBy: 'a', lastSortKey: KEY },
    { id: 'direct', kind: 'direct', directKey: 'a:b', createdBy: 'a', lastSortKey: KEY },
    { id: 'saved', kind: 'direct', directKey: 'a:a', createdBy: 'a', lastSortKey: KEY },
  ]);
  await t.db.insert(schema.conversationMembers).values([
    { conversationId: 'group', userId: 'a', role: 'owner', lastReadKey: 30 },
    { conversationId: 'group', userId: 'b', lastReadKey: KEY },
    { conversationId: 'group', userId: 'c', lastReadKey: KEY + 1 },
    { conversationId: 'group', userId: 'd', lastReadKey: KEY - 1 },
    // Вышедший остаётся строкой БД с прежним прочтением, но не действующим членом access.
    { conversationId: 'group', userId: 'former', lastReadKey: KEY, leftAt: new Date(NOW - 1000) },
    ...['other', 'direct'].flatMap(conversationId => ['a', 'b'].map(userId => ({ conversationId, userId, lastReadKey: KEY }))),
    { conversationId: 'saved', userId: 'a', lastReadKey: KEY },
  ]);
  await t.db.insert(schema.conversationMessages).values([
    { id: 'before-message', conversationId: 'group', authorId: 'a', sortKey: 19, content: 'Предыдущий ключ' },
    { id: 'message', conversationId: 'group', authorId: 'a', sortKey: KEY, content: 'Своё сообщение' },
    { id: 'by-b', conversationId: 'group', authorId: 'b', sortKey: 21, content: 'Чужое сообщение' },
    { id: 'former-message', conversationId: 'group', authorId: 'former', sortKey: 18, content: 'До выхода' },
    { id: 'deleted-message', conversationId: 'group', authorId: 'a', sortKey: 22, deletedAt: new Date(NOW), content: '' },
    { id: 'later-message', conversationId: 'group', authorId: 'a', sortKey: 30, content: 'Последний ключ автора' },
    ...['other', 'direct', 'saved'].map(conversationId => ({ id: `${conversationId}-message`, conversationId, authorId: 'a', sortKey: KEY, content: 'Другой вид беседы' })),
  ].map(row => ({ ...row, createdAt: new Date(NOW - DAY) })));
  const db = { './db/index.js': { db: t.db }, './db/schema.js': schema };
  const common = { '@gusvoice/shared': shared, 'drizzle-orm': orm };
  const c = load<typeof import('../src/conversations.js')>('conversations', { ...common, ...db, './convRules.js': convRules }, mutation);
  const peers = load<typeof import('../src/db/peerQueries.js')>('db/peerQueries', { 'drizzle-orm': orm, './index.js': { db: t.db } }, mutation);
  const rules = load<typeof import('../src/lastSeenRules.js')>('lastSeenRules', {}, mutation);
  const seen = load<typeof import('../src/lastSeen.js')>('lastSeen', { ...common, ...db, './conversations.js': c, './db/peerQueries.js': peers, './lastSeenRules.js': rules }, mutation);
  const route = load<typeof import('../src/routes/conv.js')>('routes/conv', {
    ...common, zod: { z }, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../conversations.js': c, '../convRules.js': convRules, '../lastSeen.js': seen,
    '../auth.js': { requireAuth: async (req: { headers: Record<string, unknown>; user?: { sub: string } }) => { req.user = { sub: String(req.headers['x-fixture-user'] ?? 'a') }; } },
    '../guestGuard.js': { requireLocalUser: () => forbidden('requireLocalUser у readers') },
  }, mutation);
  const app = Fastify(); await app.register(route.convRoutes); await app.ready(); assertIo();
  const get = async (me = 'a', cid = 'group', mid = 'message') => {
    const res = await app.inject({ method: 'GET', url: `/conv/${cid}/messages/${mid}/readers`, headers: { 'x-fixture-user': me } });
    assertIo(); // Сначала IO-журнал, потом assertions по HTTP: catch/500 не выдаются за успешный kill.
    return res;
  };
  return { app, c, get };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function withFixture(run: (f: Fixture) => Promise<void>, mutation?: Mutation) {
  const f = await fixture(mutation);
  try { await run(f); } finally { await f.app.close(); assertIo(); }
}
function ids(body: shared.ConvReaders) { return body.items.map(r => r.userId).sort().join(','); }
async function list(f: Fixture) {
  const res = await f.get(); assert.equal(res.statusCode, 200, res.body); return res.json() as shared.ConvReaders;
}
async function age(ms: number) { await t.db.update(schema.conversationMessages).set({ createdAt: new Date(NOW - ms) }).where(orm.eq(schema.conversationMessages.id, 'message')); }

async function inclusive(mutation?: Mutation) {
  await withFixture(async f => {
    const body = await list(f);
    assert.equal(ids(body), 'b,c', 'R239-key: равный ключ тоже означает прочтение');
    assert.deepEqual(body, { items: [
      { userId: 'b', username: 'readers_b', displayName: 'Имя b', avatarUrl: '/fixture-b.webp' },
      { userId: 'c', username: 'readers_c', displayName: 'Имя c', avatarUrl: null },
    ] });
    assert.equal(body.items.some(r => r.userId === 'a'), false, 'автор не читатель самого себя');
    const journal = await t.db.select().from(schema.userChanges);
    assert.deepEqual(journal, [], 'чтение списка не пишет пользовательский журнал');
  }, mutation);
}
test('R239 настоящий GET отдаёт DTO прочитавших на равном и большем ключе, без автора и непрочитавшего', async () => { await inclusive(); });

async function authorOnly(mutation?: Mutation) {
  await withFixture(async f => {
    const res = await f.get('b');
    assert.equal(res.statusCode, 404, 'R239-author: список доступен только автору сообщения');
    assert.deepEqual(res.json(), { error: 'not found' });
    assert.equal((await f.get()).statusCode, 200, 'автор того же сообщения получает список');
  }, mutation);
}
test('R239 чужое сообщение скрывает список читателей, своё в той же группе принимается', async () => { await authorOnly(); });
test('R239 404 для неучастника, вышедшего автора, чужой беседы, отсутствующего и удалённого сообщения', async () => {
  await withFixture(async f => {
    const cases = [
      ['outsider', 'group', 'message'], ['former', 'group', 'former-message'],
      ['a', 'group', 'other-message'], ['a', 'other', 'message'], ['a', 'missing-group', 'message'],
      ['a', 'group', 'missing-message'], ['a', 'group', 'deleted-message'], ['a', 'group', 'by-b'],
    ];
    for (const [me, cid, mid] of cases) {
      const res = await f.get(me, cid, mid); assert.equal(res.statusCode, 404, `${me}/${cid}/${mid}`); assert.deepEqual(res.json(), { error: 'not found' });
    }
    assert.equal(ids(await list(f)), 'b,c');
  });
});
async function directRefused(mutation?: Mutation) {
  await withFixture(async f => {
    const res = await f.get('a', 'direct', 'direct-message');
    assert.equal(res.statusCode, 404, 'R239-kind: 1:1 не выдаёт групповой список');
    assert.deepEqual(res.json(), { error: 'not found' });
    const saved = await f.get('a', 'saved', 'saved-message'); assert.equal(saved.statusCode, 404); assert.deepEqual(saved.json(), { error: 'not found' });
    assert.equal(ids(await list(f)), 'b,c');
  }, mutation);
}
test('R239 1:1 и Избранное отвергаются, действующая группа того же автора принимается', async () => { await directRefused(); });

async function expires(mutation?: Mutation) {
  await withFixture(async f => {
    await age(7 * DAY - 1); assert.equal(ids(await list(f)), 'b,c', 'за миллисекунду до срока список доступен');
    for (const ms of [7 * DAY, 7 * DAY + 1, 8 * DAY]) {
      await age(ms); const body = await list(f);
      assert.equal(body.expired, true, 'R239-expire: на семи сутках список уже истёк');
      assert.deepEqual(body, { items: [], expired: true });
    }
  }, mutation);
}
test('R239 срок семь суток проверяется с обеих сторон, старое сообщение возвращает expired без людей', async () => { await expires(); });

async function soloExpiry(mutation?: Mutation) {
  await withFixture(async f => {
    await t.db.update(schema.conversationMembers).set({ leftAt: new Date(NOW) }).where(
      orm.and(orm.eq(schema.conversationMembers.conversationId, 'group'), orm.ne(schema.conversationMembers.userId, 'a')),
    );
    const access = await f.c.loadAccess('group', 'a'); assert.ok(access);
    assert.deepEqual(Array.from(access.memberIds), ['a'], 'штатная solo-группа получена выходом остальных участников');
    assert.equal((await f.get('b')).statusCode, 404, 'вышедший не получает список прежней группы');
    assert.deepEqual(await list(f), { items: [] }, 'свежая solo-группа даёт пустой список, не expired');
    await age(7 * DAY - 1);
    assert.deepEqual(await list(f), { items: [] }, 'за миллисекунду до семи суток срок ещё не истёк');
    for (const ms of [7 * DAY, 7 * DAY + 1, 8 * DAY]) {
      await age(ms);
      const body = await list(f);
      assert.equal(body.expired, true, 'R239-solo-expire: пустой состав не отменяет срок сообщения');
      assert.deepEqual(body, { items: [], expired: true });
    }
    // Исходный дефект менял expired только от возвращения участника, не от возраста сообщения.
    await t.db.update(schema.conversationMembers).set({ leftAt: null }).where(
      orm.and(orm.eq(schema.conversationMembers.conversationId, 'group'), orm.eq(schema.conversationMembers.userId, 'b')),
    );
    assert.deepEqual(await list(f), { items: [], expired: true }, 'возвращение участника не меняет уже истёкший срок');
    await age(DAY);
    assert.equal(ids(await list(f)), 'b', 'на свежем сообщении вернувшийся участник с тем же ключом снова виден');
  }, mutation);
}

test('R239 solo-группа сохраняет семисуточный срок с обеих сторон границы и после возвращения участника', async () => {
  await soloExpiry();
});

test('R239 возврат прежнего раннего solo-выхода ловится настоящим HTTP без expired', async () => {
  await soloExpiry();
  const from = 'const others = access.memberIds.filter((id) => id !== me);';
  await assert.rejects(soloExpiry({ file: 'lastSeen', from,
    to: `${from}\n  if (others.length === 0) return { items: [] };` }), killed('R239-solo-expire:', undefined, true));
});

async function readerPrivacy(mutation?: Mutation) {
  await withFixture(async f => {
    assert.equal(ids(await list(f)), 'b,c');
    await t.db.update(schema.users).set({ lastSeenPrivacy: 'nobody', hideReadTime: true }).where(orm.eq(schema.users.id, 'b'));
    let body = await list(f);
    assert.equal(body.items.some(r => r.userId === 'b'), false, 'R239-privacy: скрывший время читатель не раскрывается');
    assert.equal(ids(body), 'c');
    await t.db.insert(schema.lastSeenExceptions).values({ ownerId: 'b', targetId: 'a', kind: 'always' });
    assert.equal(ids(await list(f)), 'b,c', 'исключение читателя «всегда» реально загружается из SQL');
    await t.db.delete(schema.lastSeenExceptions);
    await t.db.update(schema.users).set({ hideReadTime: false }).where(orm.eq(schema.users.id, 'b'));
    assert.equal(ids(await list(f)), 'b,c', '«Никто» без скрытия времени прочтения не убирает читателя');
    await t.db.update(schema.users).set({ lastSeenPrivacy: 'peers', hideReadTime: true }).where(orm.eq(schema.users.id, 'b'));
    assert.equal(ids(await list(f)), 'b,c', 'соседство для peers считается настоящим loadPeers SQL');
  }, mutation);
}
test('R239 время читателя скрывается и открывается настройкой и его исключением всегда', async () => { await readerPrivacy(); });
test('R239 скрытое время автора действует взаимно, его всегда возвращает только выбранного читателя', async () => {
  await withFixture(async f => {
    await t.db.update(schema.users).set({ lastSeenPrivacy: 'nobody', hideReadTime: true }).where(orm.eq(schema.users.id, 'a'));
    assert.deepEqual(await list(f), { items: [] });
    await t.db.insert(schema.lastSeenExceptions).values({ ownerId: 'a', targetId: 'b', kind: 'always' });
    assert.equal(ids(await list(f)), 'b');
    await t.db.update(schema.users).set({ lastSeenPrivacy: 'nobody', hideReadTime: true }).where(orm.eq(schema.users.id, 'b'));
    assert.deepEqual(await list(f), { items: [] }, 'исключение автора не отменяет скрытие читателя');
    await t.db.insert(schema.lastSeenExceptions).values({ ownerId: 'b', targetId: 'a', kind: 'always' });
    assert.equal(ids(await list(f)), 'b', 'оба встречных исключения восстанавливают взаимную видимость');
  });
});

async function blocks(mutation?: Mutation) {
  await withFixture(async f => {
    assert.equal(ids(await list(f)), 'b,c', 'без блокировок оба читателя видны');
    await t.db.insert(schema.userBlocks).values([{ blockerId: 'a', blockedId: 'b' }, { blockerId: 'c', blockedId: 'a' }]);
    assert.equal((await list(f)).items.length, 0, 'R239-blocks: обе стороны блокировки исключают читателя');
    await t.db.delete(schema.userBlocks);
    assert.equal(ids(await list(f)), 'b,c', 'снятие блокировок восстанавливает список без нового прочтения');
  }, mutation);
}
test('R239 блокировка автором и блокировка автора читателем одинаково прячут прочитавших', async () => { await blocks(); });

async function activeOnly(mutation?: Mutation) {
  await withFixture(async f => {
    const access = await f.c.loadAccess('group', 'a'); assert.ok(access);
    assert.equal(access.memberIds.includes('former'), false, 'реальный loadAccess исключает вышедшего');
    assert.equal((await list(f)).items.some(r => r.userId === 'former'), false, 'R239-members: читатели берутся из действующего access');
    await t.db.update(schema.conversationMembers).set({ leftAt: null }).where(orm.and(orm.eq(schema.conversationMembers.conversationId, 'group'), orm.eq(schema.conversationMembers.userId, 'former')));
    assert.equal((await list(f)).items.some(r => r.userId === 'former'), true, 'тот же ключ после возвращения участника принимается');
  }, mutation);
}
test('R239 вышедший с сохранённым ключом не читатель, после возвращения он снова в списке', async () => { await activeOnly(); });
test('R239 удалённый аккаунт не раскрывается даже при сохранённом действующем членстве и ключе', async () => {
  await withFixture(async f => {
    assert.equal((await list(f)).items.some(r => r.userId === 'b'), true);
    // Обезличивание сохраняет conversation_members (accountRows.ts): это штатная строка, не испорченный access.
    await t.db.update(schema.users).set({ deletedAt: new Date(NOW), displayName: 'Удалённый пользователь', avatarUrl: null }).where(orm.eq(schema.users.id, 'b'));
    assert.equal((await list(f)).items.some(r => r.userId === 'b'), false);
    assert.equal(ids(await list(f)), 'c');
  });
});

function killed(prefix: string, actual: unknown, expected: unknown) {
  return (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && Object.is(e.actual, actual) && Object.is(e.expected, expected);
}
test('R239 мутант без проверки автора убит реальным HTTP 200 вместо требуемого 404', async () => {
  await authorOnly();
  await assert.rejects(authorOnly({ file: 'lastSeen', from: 'if (!msg || msg.authorId !== me || msg.deletedAt) return null;', to: 'if (!msg || msg.deletedAt) return null;' }), killed('R239-author:', 200, 404));
});
test('R239 мутант строгого больше убит читателем ровно на ключе сообщения', async () => {
  await inclusive();
  await assert.rejects(inclusive({ file: 'lastSeenRules', from: 'm.lastReadKey >= sortKey', to: 'm.lastReadKey > sortKey' }), killed('R239-key:', 'c', 'b,c'));
});
test('R239 мутант снятой приватности убит появлением скрывшего время читателя', async () => {
  await readerPrivacy();
  await assert.rejects(readerPrivacy({ file: 'lastSeenRules', from: ' && !readTimeHidden(me, m, m.isPeer)', to: '' }), killed('R239-privacy:', true, false));
});
test('R239 оба односторонних мутанта блока убиты утечкой ровно одного прочитавшего', async () => {
  const both = 'or(\n          and(eq(userBlocks.blockerId, me), inArray(userBlocks.blockedId, others)),\n          and(inArray(userBlocks.blockerId, others), eq(userBlocks.blockedId, me)),\n        )';
  for (const one of [
    'and(eq(userBlocks.blockerId, me), inArray(userBlocks.blockedId, others))',
    'and(inArray(userBlocks.blockerId, others), eq(userBlocks.blockedId, me))',
  ]) {
    await blocks();
    await assert.rejects(blocks({ file: 'lastSeen', from: both, to: one }), killed('R239-blocks:', 1, 0));
  }
});
test('R239 мутант снятого срока убит отсутствующим expired у сообщения семи суток', async () => {
  await expires();
  await assert.rejects(expires({ file: 'lastSeenRules', from: 'if (now - createdAt.getTime() >= READ_DATE_EXPIRE_MS) return { ids: [], expired: true };', to: '// срок списка отключён' }), killed('R239-expire:', undefined, true));
});
test('R239 мутант допуска 1:1 убит HTTP 200 вместо группового 404', async () => {
  await directRefused();
  await assert.rejects(directRefused({ file: 'lastSeen', from: "if (access.kind !== 'group' || access.saved || access.peerId) return null;", to: 'if (access.saved) return null;' }), killed('R239-kind:', 200, 404));
});
test('R239 мутант всех строк членов вместо access убит появлением реально вышедшего участника', async () => {
  await activeOnly();
  await assert.rejects(activeOnly({ file: 'lastSeen', from: 'const others = access.memberIds.filter((id) => id !== me);',
    to: 'const others = (await db.select({ id: conversationMembers.userId }).from(conversationMembers).where(eq(conversationMembers.conversationId, access.conversationId))).map((r) => r.id).filter((id) => id !== me);' }), killed('R239-members:', true, false));
});
