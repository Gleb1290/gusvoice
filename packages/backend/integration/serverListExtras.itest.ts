import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, beforeEach, afterEach, after, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import Fastify, { type FastifyRequest } from 'fastify';
import ts from 'typescript';
import * as zod from 'zod';
import * as schema from '../src/db/schema.js';
import * as audience from '../src/audienceRules.js';
import * as convRules from '../src/convRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Unread = typeof import('../src/unread.js');
type Permissions = typeof import('../src/permissions.js');
type Mutation = readonly [string, string];
let t: TestDb;
let unread: Unread;
const { Permission: P } = shared;
const normal = P.VIEW_CHANNEL | P.READ_HISTORY;
const dmCounts = new Map<string, number>();

// Целый модуль исполняется над настоящим Drizzle/PGlite; сеть и побочные подсистемы не импортируются.
function blocked(name: string) {
  return new Proxy({}, { get: (_target, key) => {
    if (key === '__esModule') return true;
    return () => { throw new Error(`неожиданная внешняя граница: ${name}.${String(key)}`); };
  } });
}
function moduleFrom<T>(relative: string, deps: Record<string, unknown>, changes: readonly Mutation[] = []): T {
  const url = new URL(relative, import.meta.url);
  let source = readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
  for (const [from, to] of changes) {
    assert.equal(source.split(from).length - 1, 1, `единственный якорь: ${from}`);
    source = source.replace(from, to);
  }
  const parsed = ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true);
  for (const node of parsed.statements) {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const runtime = !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)
        || node.importClause.namedBindings.elements.some(e => !e.isTypeOnly);
      if (runtime) assert.equal(Object.hasOwn(deps, (node.moduleSpecifier as ts.StringLiteral).text), true,
        `явная зависимость ${(node.moduleSpecifier as ts.StringLiteral).text}`);
    }
  }
  const out = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module: out, exports: out.exports, Date, Map, Set, Promise,
    require: (name: string) => {
      assert.equal(Object.hasOwn(deps, name), true, `неизвестный require ${name}`);
      return deps[name];
    },
  }, { filename: url.pathname });
  return out.exports as T;
}
function permissions(changes: readonly Mutation[] = []) {
  return moduleFrom<Permissions>('../src/permissions.ts', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './auth.js': { isSuperAdmin: () => false, superAdminId: () => null },
    './superAdminRules.js': { asUserId: (id: unknown) => id }, './audienceRules.js': audience,
  }, changes);
}
function unreadModule(changes: readonly Mutation[] = [], perms = permissions()) {
  return moduleFrom<Unread>('../src/unread.ts', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './permissions.js': perms, './convRules.js': convRules,
    './conversations.js': { myConversationIds: async () => [...dmCounts.keys()], unreadCounts: async () => dmCounts },
    './federation/instanceLabels.js': blocked('instanceLabels'),
  }, changes);
}
before(async () => { t = await createTestDb(); unread = unreadModule(); });
beforeEach(async () => {
  await truncateAll(t.raw); dmCounts.clear();
  // Транзакция фиксирует now(): микросекунды на границах окна не зависят от скорости машины.
  await t.raw.exec(`BEGIN; INSERT INTO users(id,username,display_name,password_hash) VALUES
    ('owner','owner','Владелец','hash'),('a','alpha','Читатель','hash'),('b','bravo','Автор Б','hash'),
    ('manager','manager','Менеджер','hash'),('admin','admin','Админ','hash'),('allowed','allowed','Разрешённый','hash');`);
});
afterEach(async () => { await t.raw.exec('ROLLBACK'); });
after(async () => { await t.close(); });

async function server(id = 's') {
  await t.raw.query(`INSERT INTO servers(id,name,owner_id) VALUES ($1,$1,'owner')`, [id]);
  await t.raw.query(`INSERT INTO roles(id,server_id,name,permissions,is_everyone) VALUES ($1,$2,'everyone',$3,true)`,
    [`${id}-everyone`, id, normal.toString()]);
  await t.raw.query(`INSERT INTO server_members(server_id,user_id) SELECT $1,id FROM users`, [id]);
}
async function channel(id: string, sid = 's', type = 'text') {
  await t.raw.query(`INSERT INTO channels(id,server_id,name,type) VALUES ($1,$2,$3,$4)`, [id, sid, `канал ${id}`, type]);
}
async function overwrite(cid: string, target: string, deny: bigint, allow = 0n, type = 'role') {
  await t.raw.query(`INSERT INTO channel_overwrites(channel_id,target_id,target_type,allow,deny) VALUES ($1,$2,$3,$4,$5)`,
    [cid, target, type, allow.toString(), deny.toString()]);
}
async function role(user: string, permission: bigint) {
  await t.raw.query(`INSERT INTO roles(id,server_id,name,permissions) VALUES ($1,'s',$1,$2)`, [`r-${user}`, permission.toString()]);
  await t.raw.query(`INSERT INTO member_roles(server_id,user_id,role_id) VALUES ('s',$1,$2)`, [user, `r-${user}`]);
}
async function message(id: string, cid: string, ageSeconds = 0, author = 'b', content = '@alpha привет', attachments: unknown[] = [], sticker: unknown = null) {
  await t.raw.query(`INSERT INTO messages(id,channel_id,author_id,content,attachments,sticker,created_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,now()-$7::float8*interval '1 second')`,
    [id, cid, author, content, JSON.stringify(attachments), JSON.stringify(sticker), ageSeconds]);
}
async function extras(user = 'a', mod = unread, ids = ['s']) {
  const map = await mod.serverListExtras(user, ids);
  assert.equal(map.has(ids[0]), true, 'активный сервер имеет extras');
  return map.get(ids[0])!;
}
async function parity(user = 'a', mod = unread, ids = ['s']) {
  const map = await mod.serverListExtras(user, ids);
  const summary = await mod.unreadSummary(user);
  for (const [sid, item] of map) {
    assert.equal(item.unread, summary.servers[sid]?.unread ?? 0, `unread ${sid}`);
    assert.equal(item.mentions, summary.servers[sid]?.mentions ?? 0, `mentions ${sid}`);
  }
}
async function visibility(mod = unread) {
  const e = await extras('a', mod);
  assert.equal(e.unread, 1, 'скрытый канал не считается');
  assert.equal(e.lastMessage?.id, 'public', 'скрытый текст не попадает в превью');
}
async function visibilityFixture() {
  await server(); await channel('public'); await channel('hidden'); await channel('voice', 's', 'voice');
  await overwrite('hidden', 's-everyone', P.VIEW_CHANNEL);
  await message('public', 'public', 20); await message('secret', 'hidden', 1); await message('voice-text', 'voice', 0);
}
test('скрытый и голосовой каналы не дают рядовому ни счётчик, ни последнее сообщение', async () => {
  // Класс ошибки: утечка превью из скрытого канала либо счётчик, обещающий недоступный текст.
  await visibilityFixture(); await visibility(); await parity();
});
test('владелец и администратор обходят запрет; менеджер считает скрытый канал и читает его после явного allow', async () => {
  // MANAGE_CHANNELS расширяет счётчик, но не отменяет VIEW+READ для содержимого превью.
  await visibilityFixture(); await role('admin', P.ADMINISTRATOR); await role('manager', P.MANAGE_CHANNELS);
  for (const user of ['owner', 'admin']) {
    const e = await extras(user); assert.equal(e.unread, 2); assert.equal(e.lastMessage?.id, 'secret'); await parity(user);
  }
  const manager = await extras('manager'); assert.equal(manager.unread, 2); assert.equal(manager.lastMessage?.id, 'public');
  await overwrite('hidden', 'manager', 0n, P.VIEW_CHANNEL, 'member');
  await overwrite('hidden', 'allowed', 0n, P.VIEW_CHANNEL, 'member');
  for (const user of ['manager', 'allowed']) {
    const e = await extras(user); assert.equal(e.unread, 2); assert.equal(e.lastMessage?.id, 'secret'); await parity(user);
  }
});
async function noHistory(mod = unread) {
  const e = await extras('a', mod); assert.equal(e.lastMessage, null, 'READ_HISTORY защищает превью');
  assert.equal(e.unread, 1, 'счётчик сохраняет прежнее правило bootstrap'); await parity('a', mod);
}
test('без истории превью отсутствует, но счётчики совпадают со сводкой; пустой сервер имеет null и нули', async () => {
  // Класс ошибки: READ_HISTORY случайно убирают только при поиске, оставляя утечку на холодном старте.
  await server(); await channel('history'); await overwrite('history', 's-everyone', P.READ_HISTORY);
  await message('h', 'history'); await noHistory();
  await server('empty'); const e = (await unread.serverListExtras('a', ['empty'])).get('empty')!;
  assert.equal(e.unread, 0); assert.equal(e.mentions, 0); assert.equal(e.lastMessage, null); await parity('a', unread, ['s', 'empty']);
});
test('закрытое и отсутствующее членство отсутствуют в extras и unreadSummary', async () => {
  // Plain DTO /servers сохраняется приложением; здесь проверяется именно отсутствие прав и агрегатов.
  await server(); await channel('c'); await message('m', 'c');
  await t.raw.exec(`UPDATE server_members SET state='closed_by_host' WHERE user_id='a'; DELETE FROM server_members WHERE user_id='allowed'`);
  for (const user of ['a', 'allowed']) {
    assert.equal((await unread.serverListExtras(user, ['s'])).size, 0);
    assert.equal(Object.keys((await unread.unreadSummary(user)).servers).length, 0);
  }
  assert.equal((await extras('owner')).unread, 1);
});
async function timeFixture() {
  await server(); await channel('read'); await channel('window');
  await t.raw.exec(`INSERT INTO channel_reads(user_id,channel_id,last_read_at) VALUES ('a','read',now()-interval '1 hour')`);
  await message('before-read', 'read', 3601); await message('at-read', 'read', 3600); await message('after-read', 'read', 3599);
  await message('self', 'read', 1, 'a');
  await message('before-window', 'window', 14 * 86400 + 1); await message('at-window', 'window', 14 * 86400);
  await message('after-window', 'window', 14 * 86400 - 1);
  // Точная SQL-граница в микросекунду — paired >, а не округлённое «примерно 14 дней».
  await t.raw.exec(`UPDATE messages SET created_at=created_at+interval '1 microsecond' WHERE id IN ('after-read','after-window');
    UPDATE messages SET created_at=now()-interval '1 hour'+interval '1 microsecond' WHERE id='after-read';
    UPDATE messages SET created_at=now()-interval '14 days'+interval '1 microsecond' WHERE id='after-window';`);
}
async function times(mod = unread) {
  const e = await extras('a', mod); assert.equal(e.unread, 2, 'только чужие строго после readAt и окна');
  assert.equal(e.mentions, 2, 'упоминания имеют ту же границу'); await parity('a', mod);
}
test('readAt и окно 14 дней исключают саму границу, принимают микросекунду после и не считают мои сообщения', async () => {
  // Класс ошибки: >=, игнорирование readAt, своё авторство или расхождение badge с unreadSummary.
  await timeFixture(); await times();
});
test('по каждому серверу независимы unread и mentions, а упоминание не подменяется почтовым адресом', async () => {
  // Класс ошибки: агрегация по всему списку вместо server_id или собственная регулярка упоминаний.
  await server(); await server('second'); await channel('one'); await channel('two', 'second');
  await message('one', 'one'); await message('two', 'two', 0, 'b', 'почта x@alpha.example');
  await message('three', 'two', 1, 'b', 'без упоминания');
  const map = await unread.serverListExtras('a', ['s', 'second']);
  assert.equal(map.get('s')?.unread, 1); assert.equal(map.get('s')?.mentions, 1);
  assert.equal(map.get('second')?.unread, 2); assert.equal(map.get('second')?.mentions, 0);
  await parity('a', unread, ['s', 'second']);
});
async function latestFixture() {
  await server(); await channel('one'); await channel('two');
  await message('oldest', 'one', 30); await message('middle', 'two', 20);
  await message('latest', 'one', 10, 'b', 'новое\n сообщение');
}
async function latest(mod = unread) {
  const last = (await extras('a', mod)).lastMessage;
  assert.equal(last?.id, 'latest', 'самое позднее сообщение сервера');
  assert.equal(last?.channelId, 'one'); assert.equal(last?.channelName, 'канал one');
  assert.equal(last?.authorId, 'b'); assert.equal(last?.authorName, 'Автор Б');
  assert.equal(last?.text, 'новое сообщение'); assert.equal(last?.attachments, 0);
  const stamp = (await t.raw.query<{ at: Date }>(`SELECT created_at AS at FROM messages WHERE id='latest'`)).rows[0].at;
  assert.equal(last?.createdAt, new Date(stamp).toISOString());
}
test('последнее выбирается и внутри канала, и между каналами, с display_name и временем настоящей строки', async () => {
  // Два уровня сортировки нужны: неверный LATERAL и неверный DISTINCT ON ломаются независимо.
  await latestFixture(); await latest();
});
test('стикер без текста и все виды вложений проходят настоящее правило превью, обычный текст не получает attachmentKind', async () => {
  // Класс ошибки: JSONB/стикер теряется на границе SQL→DTO или вид вложения угадывается по расширению.
  await server(); await channel('c');
  const cases: Array<{ id: string; attachments: unknown[]; sticker?: unknown; expected: Record<string, unknown> }> = [
    { id: 'sticker', attachments: [], sticker: { url: '/s.webp', emoji: '🪿' }, expected: { text: '🪿', attachmentKind: 'sticker' } },
    { id: 'photo', attachments: [{ contentType: 'image/png' }, { contentType: 'image/jpeg' }], expected: { attachmentKind: 'photo' } },
    { id: 'gif', attachments: [{ contentType: 'image/gif', gif: true }], expected: { attachmentKind: 'photo', attachmentGif: true } },
    { id: 'voice', attachments: [{ contentType: 'audio/ogg', waveform: [1, 2], durationMs: 1234, once: true }], expected: { attachmentKind: 'voice', attachmentDurationMs: 1234, attachmentOnce: true } },
    { id: 'file', attachments: [{ contentType: 'application/pdf', name: 'a\n b.pdf' }], expected: { attachmentKind: 'file', attachmentName: 'a b.pdf' } },
    { id: 'round', attachments: [{ contentType: 'video/mp4', round: true, durationMs: 2345, once: true }], expected: { attachmentKind: 'file', attachmentVideo: true, attachmentRound: true, attachmentDurationMs: 2345, attachmentOnce: true } },
    { id: 'text', attachments: [], expected: {} },
    { id: 'long', attachments: [], expected: { text: `${'я'.repeat(199)}…` } },
  ];
  for (const item of cases) {
    await t.raw.exec('DELETE FROM messages');
    await message(item.id, 'c', 0, 'b', item.id === 'sticker' ? '' : item.id === 'long' ? `${'я'.repeat(210)}\n хвост` : 'текст', item.attachments, item.sticker ?? null);
    const last = (await extras()).lastMessage!;
    assert.equal(last.id, item.id); assert.equal(last.attachments, item.attachments.length);
    for (const key of ['attachmentKind', 'attachmentName', 'attachmentDurationMs', 'attachmentVideo', 'attachmentGif', 'attachmentRound', 'attachmentOnce']) {
      assert.equal((last as unknown as Record<string, unknown>)[key], item.expected[key], `${item.id}: ${key}`);
    }
    assert.equal(last.text, item.expected.text ?? 'текст');
  }
});

async function routeApp(failExtras = false) {
  const auth = { isSuperAdmin: () => false, requireAuth: async (req: FastifyRequest) => {
    req.user = { sub: 'a', username: 'alpha', gen: 0 } as NonNullable<FastifyRequest['user']>;
  } };
  const serialDeps: Record<string, unknown> = { '@gusvoice/shared': shared, './auth.js': auth,
    './superAdminRules.js': { asUserId: (id: unknown) => id }, './env.js': { env: {} } };
  for (const name of ['./federation/instanceLabels.js', './statusRules.js', './shopRules.js', './callRules.js', './lastSeenRules.js', './linkThreats.js']) serialDeps[name] = blocked(name);
  const serialize = moduleFrom<typeof import('../src/serialize.js')>('../src/serialize.ts', serialDeps);
  const deps: Record<string, unknown> = { '@gusvoice/shared': shared, 'drizzle-orm': orm, zod,
    '../auth.js': auth, '../superAdminRules.js': { asUserId: (id: unknown) => id },
    '../db/index.js': { db: t.db }, '../db/schema.js': schema, '../permissions.js': permissions(), '../serialize.js': serialize,
    '../unread.js': failExtras ? { serverListExtras: async () => { throw new Error('тестовый отказ extras'); } } : unread,
  };
  for (const name of ['../audit.js', '../federation/directoryEvents.js', '../federation/guestAccess.js', '../federation/guestMembership.js',
    '../federation/instanceLabels.js', '../federation/instanceBan.js', '../federation/links.js', '../federation/guestRules.js',
    '../authGuard.js', '../realtime.js', '../statusRules.js', '../shopRules.js', '../storage.js', '../telegram.js', '../stickerCatalog.js', '../util.js']) deps[name] = blocked(name);
  const routes = moduleFrom<typeof import('../src/routes/servers.js')>('../src/routes/servers.ts', deps);
  const unreadRoutes = moduleFrom<typeof import('../src/routes/unread.js')>('../src/routes/unread.ts', { '../auth.js': auth, '../unread.js': unread });
  const app = Fastify();
  try { await app.register(routes.serverRoutes); await app.register(unreadRoutes.unreadRoutes); await app.ready(); return app; }
  catch (error) { await app.close(); throw error; }
}
test('GET /servers добавляет extras, отказ агрегата сохраняет прежние DTO; GET /unread сохраняет серверные и личные счётчики', async () => {
  // Класс ошибки: необязательное обогащение делает список недоступным либо меняет старую форму /unread.
  await server(); await channel('c'); await message('m', 'c'); dmCounts.set('one', 3); dmCounts.set('zero', 0); dmCounts.set('two', 2);
  for (const failed of [false, true]) {
    const app = await routeApp(failed);
    try {
      const res = await app.inject({ method: 'GET', url: '/servers' }); assert.equal(res.statusCode, 200);
      const list = res.json(); assert.equal(list.length, 1); assert.equal(list[0].id, 's'); assert.equal(list[0].name, 's'); assert.equal(list[0].ownerId, 'owner');
      for (const key of ['unread', 'mentions', 'lastMessage']) assert.equal(Object.hasOwn(list[0], key), !failed, key);
      if (!failed) { assert.equal(list[0].unread, 1); assert.equal(list[0].mentions, 1); assert.equal(list[0].lastMessage.id, 'm'); }
      const sum = await app.inject({ method: 'GET', url: '/unread' }); assert.equal(sum.statusCode, 200);
      assert.deepEqual(sum.json(), { servers: { s: { unread: 1, mentions: 1 } }, dms: 2, dmUnread: 5 });
    } finally { await app.close(); }
  }
});

function assertionAt(message: string) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.includes(message);
}
async function killed(check: (mod: Unread) => Promise<void>, changes: readonly Mutation[], message: string) {
  await check(unread); // Оригинал проходит тот же сценарий ДО любого мутанта.
  const mutant = unreadModule(changes); // Загрузка/якорь не могут притвориться убитым поведенческим мутантом.
  await assert.rejects(check(mutant), assertionAt(message));
}
test('контрфакт без READ_HISTORY обнаруживается по запретному превью', async () => {
  await server(); await channel('history'); await overwrite('history', 's-everyone', P.READ_HISTORY); await message('h', 'history');
  await killed(noHistory, [['has(p, Permission.VIEW_CHANNEL) && has(p, Permission.READ_HISTORY)', 'has(p, Permission.VIEW_CHANNEL)']], 'READ_HISTORY защищает превью');
});
test('контрфакт без VIEW_CHANNEL обнаруживается по скрытому счётчику и превью', async () => {
  await visibilityFixture();
  await killed(visibility, [['return seesEverything || has(perm, Permission.VIEW_CHANNEL);', 'return true;']], 'скрытый канал не считается');
  await killed(visibility, [['has(p, Permission.VIEW_CHANNEL) && has(p, Permission.READ_HISTORY)', 'has(p, Permission.READ_HISTORY)']], 'скрытый текст не попадает в превью');
});
test('контрфакт без административного обхода обнаруживается у менеджера скрытого канала', async () => {
  await visibilityFixture(); await role('manager', P.MANAGE_CHANNELS);
  const check = async (mod: Unread) => { assert.equal((await extras('manager', mod)).unread, 2, 'менеджер считает скрытый канал'); };
  await killed(check, [['return seesEverything || has(perm, Permission.VIEW_CHANNEL);', 'return has(perm, Permission.VIEW_CHANNEL);']], 'менеджер считает скрытый канал');
});
test('контрфакт без last_read_at обнаруживается по старым непрочитанным', async () => {
  await timeFixture(); await killed(times, [["GREATEST(COALESCE(r.last_read_at, to_timestamp(0)), now() - interval '14 days')", "(now() - interval '14 days')"]], 'только чужие строго после readAt и окна');
});
test('контрфакт подсчёта своих сообщений обнаруживается в серверном unread', async () => {
  await timeFixture(); await killed(times, [['AND m.author_id <> ${userId}', 'AND true']], 'только чужие строго после readAt и окна');
});
test('контрфакты самого раннего вместо последнего сообщения обнаруживаются на обоих уровнях SQL', async () => {
  await latestFixture(); await latest();
  for (const from of ['ORDER BY m.created_at DESC', 'ORDER BY c.server_id, lm.created_at DESC']) {
    const mutant = unreadModule([[from, from.replace('DESC', 'ASC')]]);
    await assert.rejects(latest(mutant), assertionAt('самое позднее сообщение сервера'));
  }
});
