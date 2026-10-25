import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, beforeEach, afterEach, after, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as zod from 'zod';
import * as schema from '../src/db/schema.js';
import * as audience from '../src/audienceRules.js';
import * as convRules from '../src/convRules.js';
import { contentPreview } from '../src/pushRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Push = typeof import('../src/push.js');
type Permissions = typeof import('../src/permissions.js');
type Unread = typeof import('../src/unread.js');
type Servers = typeof import('../src/routes/servers.js');
type Change = readonly [string, string];
const P = shared.Permission;
const plain = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
let t: TestDb, permissions: Permissions, push: Push, unread: Unread, servers: Servers;

function blocked(name: string) {
  return new Proxy({}, { get: (_target, key) => {
    if (key === '__esModule') return true;
    return () => assert.fail(`неожиданная внешняя граница ${name}.${String(key)}`);
  } });
}
function moduleFrom<T>(relative: string, deps: Record<string, unknown>, changes: readonly Change[] = []): T {
  const url = new URL(relative, import.meta.url);
  let raw = readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
  for (const [from, to] of changes) {
    assert.equal(raw.split(from).length - 1, 1, `якорь мутации уникален: ${from}`);
    const modified = raw.replace(from, to); assert.notEqual(modified, raw); raw = modified;
  }
  const file = ts.createSourceFile(url.pathname, raw, ts.ScriptTarget.Latest, true);
  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
    const runtime = !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)
      || node.importClause.namedBindings.elements.some(n => !n.isTypeOnly);
    if (runtime) assert.ok(Object.hasOwn(deps, (node.moduleSpecifier as ts.StringLiteral).text),
      `перечислена граница ${(node.moduleSpecifier as ts.StringLiteral).text}`);
  }
  const module = { exports: {} as T };
  // Только целые модули, настоящий Drizzle и PGlite. Неописанный import/внешний эффект запрещены.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, Date, Map, Set, Promise,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `описана граница ${id}`); return deps[id]; },
  }, { filename: url.pathname });
  return module.exports;
}
const auth = { isSuperAdmin: () => false, superAdminId: () => null };
const superRules = { asUserId: (id: unknown) => id };
function pushModule(changes: readonly Change[] = []) {
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './permissions.js': permissions, './env.js': { env: { ntfy: { baseUrl: '', token: '' } } },
  };
  for (const id of ['./federation/instanceLabels.js', './pushCrypto.js', './pushDefer.js', './pushRules.js', './util.js']) deps[id] = blocked(id);
  return moduleFrom<Push>('../src/push.ts', deps, changes);
}
function unreadModule(changes: readonly Change[] = [], sharedApi: typeof shared = shared) {
  return moduleFrom<Unread>('../src/unread.ts', {
    '@gusvoice/shared': sharedApi, 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './permissions.js': permissions, './convRules.js': convRules,
    './conversations.js': { myConversationIds: async () => [], unreadCounts: async () => new Map() },
    './federation/instanceLabels.js': blocked('instanceLabels'),
  }, changes);
}
function serverModule(changes: readonly Change[] = [], sharedApi: typeof shared = shared) {
  const serialDeps: Record<string, unknown> = {
    '@gusvoice/shared': shared, './auth.js': auth, './superAdminRules.js': superRules, './env.js': { env: {} },
  };
  for (const id of ['./federation/instanceLabels.js', './statusRules.js', './shopRules.js', './callRules.js', './lastSeenRules.js', './linkThreats.js']) serialDeps[id] = blocked(id);
  const serialize = moduleFrom<typeof import('../src/serialize.js')>('../src/serialize.ts', serialDeps);
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': sharedApi, 'drizzle-orm': orm, zod,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema, '../permissions.js': permissions,
    '../auth.js': auth, '../superAdminRules.js': superRules, '../serialize.js': serialize,
    '../unread.js': unread, '../telegram.js': { telegramConfigured: () => false },
  };
  for (const id of ['../audit.js', '../federation/directoryEvents.js', '../federation/guestAccess.js', '../federation/guestMembership.js',
    '../federation/instanceLabels.js', '../federation/instanceBan.js', '../federation/links.js', '../federation/guestRules.js',
    '../authGuard.js', '../realtime.js', '../statusRules.js', '../shopRules.js', '../storage.js', '../stickerCatalog.js', '../util.js']) deps[id] = blocked(id);
  return moduleFrom<Servers>('../src/routes/servers.ts', deps, changes);
}
before(async () => {
  t = await createTestDb();
  permissions = moduleFrom<Permissions>('../src/permissions.ts', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './auth.js': auth, './superAdminRules.js': superRules, './audienceRules.js': audience,
  });
  push = pushModule(); unread = unreadModule(); servers = serverModule();
});
beforeEach(async () => {
  await truncateAll(t.raw);
  await t.raw.exec(`BEGIN;
    INSERT INTO users(id,username,display_name,password_hash) VALUES
      ('owner','owner','Владелец','hash'),('author','author','Автор','hash'),('reader','reader','Читатель','hash'),
      ('outsider','outsider','Без роли','hash'),('hidden','hidden','Закрыт канал','hash');
    INSERT INTO servers(id,name,owner_id) VALUES ('s','Сервер','owner'),('other','Другой','owner');
    INSERT INTO server_members(server_id,user_id) SELECT 's',id FROM users;
    INSERT INTO server_members(server_id,user_id) VALUES ('other','owner'),('other','outsider');
    INSERT INTO roles(id,server_id,name,permissions,is_everyone,mentionable) VALUES
      ('everyone','s','@everyone','${(P.VIEW_CHANNEL | P.READ_HISTORY).toString()}',true,true),
      ('public','s','Ночная смена','0',false,true),('second','s','Вторая роль','0',false,true),
      ('private','s','Закрытая роль','0',false,false),
      ('foreign','other','Чужая роль','0',false,true);
    INSERT INTO member_roles(server_id,user_id,role_id) VALUES
      ('s','reader','public'),('s','reader','second'),('s','reader','private'),
      ('s','hidden','public'),('s','author','public'),('other','outsider','foreign');
    INSERT INTO channels(id,server_id,name,type) VALUES ('visible','s','Видимый','text'),('secret','s','Секретный','text'),('foreign-channel','other','Другой','text');
    INSERT INTO channel_overwrites(channel_id,target_id,target_type,allow,deny) VALUES
      ('visible','hidden','member','0','${P.VIEW_CHANNEL.toString()}'),
      ('secret','everyone','role','0','${P.VIEW_CHANNEL.toString()}');`);
});
afterEach(async () => { await t.raw.exec('ROLLBACK'); });
after(async () => { await t.close(); });

async function recipients(mod = push) {
  const roles = await mod.resolveRoleMentions('@Ночная смена @Вторая роль @reader @author', 's', 0n);
  assert.deepEqual([...roles].sort(), ['public', 'second']);
  const ids = await mod.resolveMentionedMembers('@reader @author', 's', 'author', 'visible', roles);
  assert.deepEqual([...ids].sort(), ['reader'], 'R266 аудитория: участник двух ролей и личный адресат один, скрытый и автор исключены');
}
// Класс ошибки: роль обходит VIEW_CHANNEL или человек получает три пуша за одно сообщение.
test('R266 реальные push и permissions пересекают роли с аудиторией, объединяют личное упоминание и исключают автора', async () => {
  const a = await permissions.getChannelAudience('visible');
  assert.ok(a?.userIds.includes('reader')); assert.equal(a?.userIds.includes('hidden'), false);
  await recipients();
  assert.deepEqual([...(await push.resolveMentionedMembers('', 's', 'author', 'visible', ['foreign']))], []);
  assert.deepEqual([...(await push.resolveMentionedMembers('', 's', 'author', 'foreign-channel', ['public']))], []);
  assert.deepEqual([...(await push.resolveMentionedMembers('', 's', 'author', undefined, ['public']))], []);
});
async function permissionGate(mod = push) {
  const denied = await mod.resolveRoleMentions('@Закрытая роль', 's', 0n);
  assert.deepEqual([...denied], [],
    'R266 право: закрытая роль без MENTION_EVERYONE не пингует');
  assert.deepEqual([...(await mod.resolveMentionedMembers('@Закрытая роль', 's', 'author', 'visible', denied))], []);
  assert.deepEqual([...(await mod.resolveRoleMentions('@Закрытая роль', 's', P.MANAGE_ROLES))], [],
    'R279 право: управление ролями само по себе не разрешает пинг закрытой роли');
  for (const permission of [P.MENTION_EVERYONE, P.ADMINISTRATOR]) {
    const allowed = await mod.resolveRoleMentions('@Закрытая роль', 's', permission);
    assert.deepEqual([...allowed], ['private']);
    assert.deepEqual([...(await mod.resolveMentionedMembers('@Закрытая роль', 's', 'author', 'visible', allowed))], ['reader']);
  }
}
// Класс ошибки: разрешение определяется клиентским текстом или старым MANAGE_ROLES вместо отдельного права.
test('R279 флаг mentionable разрешает без права, закрытая роль требует MENTION_EVERYONE либо администратора', async () => {
  await permissionGate();
  assert.deepEqual([...(await push.resolveRoleMentions('@Ночная смена', 's', 0n))], ['public']);
  assert.deepEqual([...(await push.resolveRoleMentions('@Чужая роль', 's', P.ADMINISTRATOR))], []);
  assert.deepEqual([...(await push.resolveRoleMentions('@everyone', 's', P.ADMINISTRATOR))], [], '@everyone остаётся отдельным broadcast, а не id роли');
  assert.deepEqual([...(await push.resolveRoleMentions('обычный текст', 's', P.ADMINISTRATOR))], []);
  const ids = await push.resolveRoleMentions('@Закрытая роль', 's', P.MENTION_EVERYONE);
  assert.deepEqual([...(await push.resolveMentionedMembers('', 's', 'author', 'visible', ids))], ['reader']);
});

async function message(id: string, content: string, roleIds: string[] = [], author = 'author', channel = 'visible') {
  await t.raw.query(`INSERT INTO messages(id,channel_id,author_id,content,mention_roles) VALUES ($1,$2,$3,$4,$5::text[])`,
    [id, channel, author, content, roleIds]);
}
async function history() {
  await message('plain', 'без обращения');
  await message('role', '@Ночная смена', ['public']);
  await message('mixed', '@reader @Ночная смена', ['public']);
  await message('own', '@reader @Ночная смена', ['public'], 'reader');
  await message('secret-ping', '@reader @Ночная смена', ['public'], 'author', 'secret');
}
async function counts(mod = unread) {
  const reader = await mod.unreadSummary('reader');
  assert.deepEqual(plain(reader.servers.s), { unread: 3, mentions: 2 },
    'R266 SQL роли: роль считается, личное плюс роль считается один раз, своё и скрытый канал исключены');
  const outsider = await mod.unreadSummary('outsider');
  assert.deepEqual(plain(outsider.servers.s), { unread: 4, mentions: 0 }, 'чужая роль не создаёт бейдж постороннему');
  const hidden = await mod.unreadSummary('hidden');
  assert.equal(hidden.servers.s, undefined, 'скрытые каналы не дают даже строку сводки');
}
// Класс ошибки: SQL считает текст вместо сохранённого id, удваивает OR или считает своё сообщение.
test('R266 unreadSummary выполняет настоящий countUnreadByChannel для участника, постороннего и скрытых каналов', async () => {
  await history(); await counts();
});
async function bootstrapCounts(mod = servers) {
  for (const [user, expected] of [['reader', { unread: 3, mentions: 2 }], ['outsider', { unread: 4, mentions: 0 }]] as const) {
    const bootstrap = await mod.buildBootstrap('s', user); assert.ok(bootstrap);
    assert.deepEqual(plain(bootstrap.reads.visible), expected, 'R266 bootstrap: тот же ролевой SQL, что у unreadSummary');
    assert.equal(bootstrap.reads.secret, undefined);
    assert.deepEqual([...bootstrap.channels.map(c => c.id)], ['visible']);
  }
  const hidden = await mod.buildBootstrap('s', 'hidden'); assert.ok(hidden);
  assert.deepEqual(Object.keys(hidden.reads), []);
}
// Класс ошибки: счётчик открытого сервера расходится с бейджем рейла после перезагрузки.
test('R266 настоящий buildBootstrap считает роли так же, как unreadSummary, и не включает закрытые каналы', async () => {
  await history(); await counts(); await bootstrapCounts();
});
// Класс ошибки: переименование роли или снятие флага переписывает уже отправленные упоминания.
test('R266 сохранённый mention_roles переживает переименование и потерю флага, снятие роли оставляет личное обращение', async () => {
  await history(); await counts();
  const stored = (await t.db.select().from(schema.messages).where(orm.eq(schema.messages.id, 'role')))[0];
  assert.deepEqual(stored.mentionRoles, ['public']);
  await t.raw.exec(`UPDATE roles SET name='Дневная смена',mentionable=false WHERE id='public'`);
  assert.deepEqual([...(await push.resolveRoleMentions(stored.content, 's', 0n))], [], 'новый текст со старым именем больше не пингует');
  assert.deepEqual([...(await push.resolveMentionedMembers(stored.content, 's', 'author', 'visible', stored.mentionRoles))], ['reader'],
    'хранится id: старое сообщение по-прежнему адресует участника');
  await counts(); await bootstrapCounts();
  await t.raw.exec(`DELETE FROM member_roles WHERE user_id='reader' AND role_id='public'`);
  assert.deepEqual([...(await push.resolveMentionedMembers(stored.content, 's', 'author', 'visible', stored.mentionRoles))], []);
  assert.deepEqual([...(await push.resolveMentionedMembers('@reader', 's', 'author', 'visible', stored.mentionRoles))], ['reader']);
  assert.deepEqual(plain((await unread.unreadSummary('reader')).servers.s), { unread: 3, mentions: 1 },
    'снятие роли убирает только role-only, mixed остаётся личным');
  assert.deepEqual(plain((await servers.buildBootstrap('s', 'reader'))?.reads.visible), { unread: 3, mentions: 1 });
});

const assertion = (marker: string) => (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(marker);
// Класс ошибки: тесты не чувствительны к удалению реального фильтра аудитории.
test('R266 мутант без пересечения роли с аудиторией пойман адресным AssertionError после original-first', async () => {
  await recipients();
  const mutant = pushModule([['inArray(memberRoles.userId, audience.userIds),', '']]);
  await assert.rejects(() => recipients(mutant), assertion('R266 аудитория:'));
});
test('R266 мутант без canMentionRole пойман на закрытой роли после original-first', async () => {
  await permissionGate();
  const mutant = pushModule([['mentionedRoleIds(content, rows).filter((rid) => canMentionRole(byId.get(rid)!, authorPerms))', 'mentionedRoleIds(content, rows)']]);
  await assert.rejects(() => permissionGate(mutant), assertion('R266 право:'));
});
const sqlRoles = 'OR m.mention_roles && ARRAY(SELECT mr.role_id FROM member_roles mr WHERE mr.user_id = ${userId})';
test('R266 мутант unread без ролевой ветки SQL пойман счётчиком, а не ошибкой синтаксиса', async () => {
  await history(); await counts();
  const mutant = unreadModule([[sqlRoles, 'OR FALSE']]);
  await assert.rejects(() => counts(mutant), assertion('R266 SQL роли:'));
});
test('R266 парный мутант bootstrap без ролевой ветки SQL пойман настоящим reads после original-first', async () => {
  await history(); await bootstrapCounts();
  const mutant = serverModule([[sqlRoles, 'OR FALSE']]);
  await assert.rejects(() => bootstrapCounts(mutant), assertion('R266 bootstrap:'));
});

const exactAssertion = (message: string) => (error: unknown) => error instanceof assert.AssertionError && error.message === message;

// Класс ошибки: запрет broadcast гасит личные/ролевые обращения или undefined ломает старые сообщения/вебхуки.
test('R279 push уважает false, сохраняет старое умолчание и не будит телефоны через here', async () => {
  assert.deepEqual([...(await push.resolveMentionedMembers('@everyone', 's', 'author', 'visible', [], false))], []);
  for (const allow of [undefined, true]) {
    const ids = await push.resolveMentionedMembers('@everyone', 's', 'author', 'visible', [], allow);
    assert.deepEqual([...ids].sort(), ['outsider', 'owner', 'reader']);
  }
  assert.deepEqual([...(await push.resolveMentionedMembers('@here', 's', 'author', 'visible', [], true))], []);
  assert.deepEqual([...(await push.resolveMentionedMembers('@everyone @reader', 's', 'author', 'visible', [], false))], ['reader']);
  assert.deepEqual([...(await push.resolveMentionedMembers('@everyone @Ночная смена', 's', 'author', 'visible', ['public'], false))], ['reader']);
});

// Класс ошибки: администратор/владелец теряет исключение или канальное переопределение не влияет на право.
test('R279 право владельца, администратора и обычного участника вычисляется настоящими канальными permissions', async () => {
  for (const [user, expected] of [['owner', true], ['author', false]] as const) {
    const perms = await permissions.getChannelPermissions('visible', user); assert.ok(perms);
    assert.equal(shared.canMentionEveryone(perms.permissions), expected);
  }
  await t.raw.exec(`UPDATE roles SET permissions='${P.ADMINISTRATOR}' WHERE id='private'`);
  assert.equal(shared.canMentionEveryone((await permissions.getChannelPermissions('visible', 'reader'))!.permissions), true);
  await t.raw.exec(`INSERT INTO channel_overwrites(channel_id,target_id,target_type,allow,deny)
    VALUES ('visible','author','member','${P.MENTION_EVERYONE}','0')`);
  assert.equal(shared.canMentionEveryone((await permissions.getChannelPermissions('visible', 'author'))!.permissions), true);
  await t.raw.exec(`UPDATE channel_overwrites SET allow='0',deny='${P.MENTION_EVERYONE}' WHERE target_id='author'`);
  assert.equal(shared.canMentionEveryone((await permissions.getChannelPermissions('visible', 'author'))!.permissions), false);
});

async function broadcastHistory() {
  for (const [id, content, broadcast, roles] of [
    ['denied-e', '@everyone', false, []], ['allowed-e', '@everyone', true, []], ['legacy-e', '@everyone', null, []],
    ['denied-h', '@here', false, []], ['allowed-h', '@here', true, []], ['legacy-h', '@here', null, []],
    ['personal-denied', '@reader @everyone', false, []], ['role-denied', '@Ночная смена @everyone', false, ['public']],
    ['mail', 'a@everyone', true, []], ['suffix', '@everyone-x', true, []],
  ] as const) {
    await t.db.insert(schema.messages).values({ id, channelId: 'visible', authorId: 'author', content,
      mentionEveryone: broadcast, mentionRoles: [...roles] });
  }
}
async function broadcastCounts(u = unread, s = servers) {
  for (const [user, mentions] of [['reader', 6], ['outsider', 4]] as const) {
    const summary = (await u.unreadSummary(user)).servers.s;
    assert.ok(summary?.unread === 10 && summary.mentions === mentions,
      'R279:unread-отсекает-false-но-считает-true-null-и-личное');
    const read = (await s.buildBootstrap('s', user))?.reads.visible;
    assert.ok(read?.unread === 10 && read.mentions === mentions,
      'R279:bootstrap-отсекает-false-но-считает-true-null-и-личное');
  }
}
// Класс ошибки: SQL принимает false за legacy NULL, либо исключает личное/ролевое обращение вместе с broadcast.
test('R279 unread и bootstrap считают true и NULL, но не false; почта и суффикс не создают бейдж', async () => {
  await broadcastHistory(); await broadcastCounts();
});

// Класс ошибки: JS-границы проходят, а Postgres понимает SQL-шаблон иначе и звонит на почту/префикс.
test('R279 настоящий Postgres принимает everyone и here с пунктуацией и отклоняет почту и продолжения', async () => {
  for (const [content, expected] of [['@everyone!', true], ['Привет @HERE.', true], ['a@everyone', false],
    ['@everyone-x', false], ['@here_suffix', false], ['@here.x', false]] as const) {
    const result = await t.raw.query<{ hit: boolean }>('SELECT $1 ~* $2 AS hit', [content, shared.broadcastSqlPattern()]);
    assert.equal(result.rows[0].hit, expected, content);
  }
});

// Класс ошибки: Postgres видит доменный хвост иначе, чем JS, и после перезагрузки зовёт весь канал вместо одного гостя.
test('R280 настоящий Postgres и JS одинаково отсекают доменный everyone и here, сохраняя точку и перенос', async () => {
  for (const word of ['everyone', 'here']) {
    for (const [content, expected] of [
      [`@${word}@x.example`, false], [`\n@${word.toUpperCase()}@x.example!`, false],
      [`a@${word}`, false], [`@${word}-x`, false],
      [`@${word}`, true], [`@${word}.`, true], [`\n@${word.toUpperCase()}!`, true],
    ] as const) {
      const result = await t.raw.query<{ hit: boolean }>('SELECT $1 ~* $2 AS hit', [content, shared.broadcastSqlPattern()]);
      assert.equal(result.rows[0].hit, expected, content);
      assert.equal(shared.hasBroadcastMention(content), expected, `разбор JS: ${content}`);
      assert.equal(shared.mentionsMe(content, 'reader'), expected, `посторонний читатель: ${content}`);
      assert.equal(new RegExp(shared.broadcastSqlPattern(), 'i').test(content), expected, `SQL-шаблон в JS: ${content}`);
    }
  }
});

async function domainBroadcastBadges(u = unread, s = servers) {
  await t.raw.exec('DELETE FROM messages');
  for (const word of ['everyone', 'here']) {
    await message(`domain-${word}`, `@${word}@x.example`);
  }
  const verify = async (expected: { unread: number; mentions: number }) => {
    // NULL — прежние сообщения/вебхуки: исправление не должно держаться только на новом сохранённом false.
    for (const user of ['reader', 'outsider']) {
      const summary = (await u.unreadSummary(user)).servers.s;
      assert.ok(summary?.unread === expected.unread && summary.mentions === expected.mentions, 'R280:unread-домен-не-наращивает-бейдж');
      const read = (await s.buildBootstrap('s', user))?.reads.visible;
      assert.ok(read?.unread === expected.unread && read.mentions === expected.mentions, 'R280:bootstrap-домен-не-наращивает-бейдж');
    }
  };
  await verify({ unread: 2, mentions: 0 });
  for (const word of ['everyone', 'here']) {
    await message(`bare-${word}`, `@${word}`);
    await message(`punctuation-${word}`, `\n@${word.toUpperCase()}.`);
    await message(`mail-${word}`, `a@${word}`);
    await message(`suffix-${word}`, `@${word}-x`);
  }
  await verify({ unread: 10, mentions: 4 });
  const rows = await t.db.select({ broadcast: schema.messages.mentionEveryone }).from(schema.messages);
  assert.ok(rows.every(row => row.broadcast === null), 'все свидетели действительно используют legacy NULL');
}

// Класс ошибки: исправленный шаблон обойдён композицией личной и массовой SQL-веток либо отключён вместе с настоящим пингом.
test('R280 старые доменные сообщения остаются непрочитанными без бейджа в unread и bootstrap, настоящие обращения считаются', async () => {
  await domainBroadcastBadges();
});

// Класс ошибки: тест регулярки зелёный, но возврат старого SQL-хвоста не замечен реальными счётчиками истории.
test('R280 возврат собаки в доменный SQL-пинг пойман обоими настоящими бейджами после original-first', async () => {
  const anchor = "const tail = '(?![A-Za-z0-9_@]|[.-]+[A-Za-z0-9_])';";
  const load = (changes: readonly Change[] = []): typeof shared => ({
    ...shared,
    ...moduleFrom<typeof import('../../shared/src/mentions.js')>('../../shared/src/mentions.ts', {
      './permissions': shared,
    }, changes),
  });
  const original = load();
  await domainBroadcastBadges(unreadModule([], original), serverModule([], original));
  const mutant = load([[anchor, anchor.replace('0-9_@', '0-9_')]]);
  await assert.rejects(() => domainBroadcastBadges(unreadModule([], mutant)),
    exactAssertion('R280:unread-домен-не-наращивает-бейдж'));
  await domainBroadcastBadges(unreadModule([], original), serverModule([], original));
  await assert.rejects(() => domainBroadcastBadges(unread, serverModule([], mutant)),
    exactAssertion('R280:bootstrap-домен-не-наращивает-бейдж'));
});

// Класс ошибки: удалённая проверка сохранённого false снова раздувает бейдж после перезагрузки.
test('R279 мутанты unread и bootstrap без IS DISTINCT FROM false пойманы счётчиком после original-first', async () => {
  await broadcastHistory(); await broadcastCounts();
  const anchor = 'm.mention_everyone IS DISTINCT FROM false AND ';
  await assert.rejects(() => broadcastCounts(unreadModule([[anchor, '']])),
    exactAssertion('R279:unread-отсекает-false-но-считает-true-null-и-личное'));
  await broadcastCounts();
  await assert.rejects(() => broadcastCounts(unread, serverModule([[anchor, '']])),
    exactAssertion('R279:bootstrap-отсекает-false-но-считает-true-null-и-личное'));
});

async function messageApp(changes: readonly Change[] = []) {
  const app = Fastify();
  const pushes: string[][] = [], events: shared.GatewayServerMessage[] = [];
  const resolutions: Promise<string[]>[] = [];
  let next = 0;
  const serialDeps: Record<string, unknown> = {
    '@gusvoice/shared': shared, './auth.js': auth, './superAdminRules.js': superRules, './env.js': { env: {} },
    './linkThreats.js': { dangerousLinksOf: () => [] },
  };
  for (const id of ['./federation/instanceLabels.js', './statusRules.js', './shopRules.js', './callRules.js', './lastSeenRules.js']) serialDeps[id] = blocked(id);
  const serialize = moduleFrom<typeof import('../src/serialize.js')>('../src/serialize.ts', serialDeps);
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, zod,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema, '../permissions.js': permissions,
    '../convRules.js': convRules, '../serialize.js': serialize,
    '../auth.js': { requireAuth: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.headers['x-fixture-user']) return reply.code(401).send();
      req.user = { sub: String(req.headers['x-fixture-user']) } as FastifyRequest['user'];
    } },
    '../authGuard.js': { messageSendBlock: async () => null, pushDebounced: async () => false },
    '../util.js': { id: () => `post-${++next}` },
    '../realtime.js': { publishToChannel: async (_server: string, _channel: string, event: shared.GatewayServerMessage) => { events.push(event); } },
    '../push.js': { resolveRoleMentions: push.resolveRoleMentions, contentPreview,
      resolveMentionedMembers: (...args: Parameters<Push['resolveMentionedMembers']>) => {
        const pending = push.resolveMentionedMembers(...args); resolutions.push(pending); return pending;
      },
      sendPushToUsers: async (ids: string[]) => { pushes.push([...ids].sort()); },
    },
  };
  for (const id of ['../polls.js', '../storage.js', '../serverSearch.js', '../federation/guestQuota.js']) deps[id] = blocked(id);
  const routes = moduleFrom<typeof import('../src/routes/messages.js')>('../src/routes/messages.ts', deps, changes);
  await app.register(routes.messageRoutes); await app.ready();
  return { app, pushes, events, async send(content: string, user = 'author') {
    const response = await app.inject({ method: 'POST', url: '/channels/visible/messages',
      headers: { 'x-fixture-user': user }, payload: { content } });
    assert.equal(response.statusCode, 201, response.body);
    await Promise.all(resolutions); await setImmediate();
    return response.json<shared.Message>();
  } };
}
async function postBroadcast(changes: readonly Change[] = []) {
  await t.raw.exec(`DELETE FROM messages; DELETE FROM channel_overwrites WHERE target_id='author';
    UPDATE roles SET permissions='${P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_HISTORY}' WHERE id='everyone'`);
  const f = await messageApp(changes);
  try {
    const denied = await f.send('@everyone');
    assert.equal(denied.content, '@everyone'); assert.equal(denied.mentionEveryone, false);
    assert.equal((await t.db.select().from(schema.messages).where(orm.eq(schema.messages.id, denied.id)))[0].mentionEveryone, false);
    assert.ok(f.pushes.length === 0, 'R279:POST-без-права-не-будит-пуш');
    assert.deepEqual(plain((await unread.unreadSummary('reader')).servers.s), { unread: 1, mentions: 0 });
    assert.deepEqual(plain((await servers.buildBootstrap('s', 'reader'))?.reads.visible), { unread: 1, mentions: 0 });
    await t.raw.exec(`INSERT INTO channel_overwrites(channel_id,target_id,target_type,allow,deny)
      VALUES ('visible','author','member','${P.MENTION_EVERYONE}','0')`);
    const allowed = await f.send('@everyone');
    assert.equal(allowed.mentionEveryone, true);
    assert.equal((await t.db.select().from(schema.messages).where(orm.eq(schema.messages.id, allowed.id)))[0].mentionEveryone, true);
    assert.deepEqual(f.pushes, [['outsider', 'owner', 'reader']]);
    const here = await f.send('@here'); assert.equal(here.mentionEveryone, true);
    assert.equal(f.pushes.length, 1, 'here не будит спящий телефон даже с правом');
    const ordinary = await f.send('обычный текст'); assert.equal(Object.hasOwn(ordinary, 'mentionEveryone'), false);
    assert.equal((await t.db.select().from(schema.messages).where(orm.eq(schema.messages.id, ordinary.id)))[0].mentionEveryone, null);
    assert.deepEqual(plain((await unread.unreadSummary('reader')).servers.s), { unread: 4, mentions: 2 });
    assert.deepEqual(plain((await servers.buildBootstrap('s', 'reader'))?.reads.visible), { unread: 4, mentions: 2 });
    assert.equal(f.events.length, 4, 'запрет пинга не запрещает саму отправку и событие');
  } finally { await f.app.close(); }
}

// Класс ошибки: маршрут считает право, но теряет его в INSERT/DTO/шестом аргументе push и расходится с SQL.
test('R279 настоящий POST сохраняет false/true/null, текст и DTO, передаёт запрет пушу и обоим бейджам', async () => {
  await postBroadcast();
});

// Класс ошибки: даже правильный push по умолчанию разбудит всех, если POST не передаст allowBroadcast.
test('R279 мутант POST без allowBroadcast пойман реальной отправкой после original-first', async () => {
  await postBroadcast();
  await assert.rejects(() => postBroadcast([[
    'channelId, mentionRoleIds, mentionEveryone !== false)', 'channelId, mentionRoleIds)',
  ]]), exactAssertion('R279:POST-без-права-не-будит-пуш'));
});

const migration0152 = readFileSync(new URL('../drizzle/0152_mention_everyone.sql', import.meta.url), 'utf8');
async function migrateBroadcast(raw = migration0152) {
  await t.raw.exec(`DELETE FROM member_roles; DELETE FROM roles;
    INSERT INTO roles(id,server_id,name,permissions,is_everyone,is_guests) VALUES
      ('everyone','s','Все','${P.VIEW_CHANNEL}',true,false),
      ('guests','s','Гости','${P.SEND_MESSAGES}',false,true),
      ('manager','s','Управление','${P.MANAGE_ROLES}',false,false),
      ('admin','s','Админ','${P.ADMINISTRATOR}',false,false),
      ('ordinary','s','Обычная','${P.VIEW_CHANNEL | P.SEND_MESSAGES}',false,false),
      ('existing','s','Уже есть','${P.MENTION_EVERYONE | P.READ_HISTORY}',false,false)`);
  await t.raw.exec(raw);
  const read = async () => Object.fromEntries((await t.db.select().from(schema.roles)).map(r => [r.id, BigInt(r.permissions)]));
  const actual = await read();
  assert.ok(actual.everyone === (P.VIEW_CHANNEL | P.MENTION_EVERYONE), 'R279:миграция-выдаёт-бит-everyone');
  assert.equal(actual.guests, P.SEND_MESSAGES | P.MENTION_EVERYONE);
  assert.equal(actual.manager, P.MANAGE_ROLES | P.MENTION_EVERYONE);
  assert.equal(actual.admin, P.ADMINISTRATOR | P.MENTION_EVERYONE);
  assert.equal(actual.ordinary, P.VIEW_CHANNEL | P.SEND_MESSAGES);
  assert.equal(actual.existing, P.MENTION_EVERYONE | P.READ_HISTORY);
  await t.raw.exec(raw); assert.deepEqual(await read(), actual, 'повтор миграции не меняет права');
}

// Класс ошибки: миграция ломает старые права или молча лишает привычного пинга everyone/гостей/модераторов.
test('R279 миграция 0152 выдаёт бит everyone, гостям, управлению и админу, сохраняя остальные роли и биты', async () => {
  await migrateBroadcast();
});

// Класс ошибки: без is_everyone миграция зелёная на модераторе, но обычные пользователи теряют привычный пинг.
test('R279 мутант миграции без is_everyone пойман настоящим SQL после original-first', async () => {
  await migrateBroadcast();
  const anchor = 'is_everyone OR ';
  assert.equal(migration0152.split(anchor).length - 1, 1);
  await assert.rejects(() => migrateBroadcast(migration0152.replace(anchor, '')),
    exactAssertion('R279:миграция-выдаёт-бит-everyone'));
});
