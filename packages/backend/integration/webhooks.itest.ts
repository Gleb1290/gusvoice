import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import ts from 'typescript';
import { z, ZodError } from 'zod';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/webhookRules.js';
import * as pushRules from '../src/pushRules.js';
import * as convRules from '../src/convRules.js';
import * as dmRules from '../src/dmRules.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as superAdminRules from '../src/superAdminRules.js';
import * as storageRules from '../src/storageRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

// Целые исходные модули, реальные Fastify и SQL всех миграций. Нет настоящих Redis,
// JWT, отправки push и S3: их границы закрыты и случайный вызов заглушки падает явно.
type Mutation = { module: string; from: string; to: string };
type Response = { statusCode: number; body: string; headers: Record<string, unknown>; json(): any };
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => {
  try { await t?.close(); } finally { await (await import('../src/db/index.js')).pool.end(); }
});

function source(name: string): string {
  return readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}
function dormant(name: string): object {
  return new Proxy({}, { get: (_o, key) => key === '__esModule' ? true : () => {
    throw new Error(`непредметная граница R274: ${name}.${String(key)}`);
  } });
}
function load<T>(name: string, dependencies: Record<string, unknown>, unused: readonly string[] = [], mutation?: Mutation): T {
  let raw = source(name);
  if (mutation?.module === name) {
    assert.equal(raw.split(mutation.from).length - 1, 1, `единственный якорь R274 ${name}`);
    raw = raw.replace(mutation.from, mutation.to);
  }
  const file = ts.createSourceFile(`${name}.ts`, raw, ts.ScriptTarget.Latest, true);
  assert.equal((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0);
  const imports = { ...dependencies };
  for (const id of unused) imports[id] = dormant(id);
  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
    const id = (node.moduleSpecifier as ts.StringLiteral).text;
    assert.ok(Object.hasOwn(imports, id), `закрытый перечень импортов R274 ${name}: ${id}`);
  }
  const compiled = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const module = { exports: {} };
  runInNewContext(compiled.outputText, { module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, Error,
    require(id: string) { assert.ok(Object.hasOwn(imports, id), `динамический импорт R274 ${name}: ${id}`); return imports[id]; },
  }, { timeout: 2000 });
  return module.exports as T;
}
function status(response: Response, expected: number, marker: string): void {
  assert.ok(response.statusCode < 500, `R274:внутренняя-ошибка: ${response.body}`);
  assert.equal(response.statusCode, expected, marker);
}
const failure = (marker: string) => (error: unknown) => error instanceof assert.AssertionError && error.message.split('\n')[0] === marker;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const TOKEN = 'fixture_webhook_token_12345678901234567890';
const OWN = 'https://media.invalid/gusvoice/';

async function fixture(mutation?: Mutation, extra?: 'admin' | 'conv') {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    { id: 'manager', username: 'webhook_manager', displayName: 'Управляющий', passwordHash: 'fixture' },
    { id: 'reader', username: 'webhook_reader', displayName: 'Читатель', passwordHash: 'fixture' },
    { id: 'human', username: 'webhook_human', displayName: 'Человек', passwordHash: 'fixture' },
    { id: 'bot', username: 'webhook:hook', displayName: 'Первое имя', passwordHash: 'fixture', bot: true, hiddenFromPeers: true, verified: false },
  ]);
  await t.db.insert(schema.servers).values({ id: 'server', name: 'Сервер', ownerId: 'manager' });
  await t.db.insert(schema.channels).values([
    { id: 'text', serverId: 'server', name: 'текст', type: 'text' },
    { id: 'target', serverId: 'server', name: 'другой', type: 'text' },
    { id: 'readable', serverId: 'server', name: 'только чтение', type: 'text' },
    { id: 'voice', serverId: 'server', name: 'голос', type: 'voice' },
  ]);
  await t.db.insert(schema.roles).values([
    { id: 'allowed', serverId: 'server', name: 'Moderators', mentionable: true },
    { id: 'other-role', serverId: 'server', name: 'Testers', mentionable: true },
    { id: 'locked', serverId: 'server', name: 'Secret', mentionable: false },
  ]);
  await t.db.insert(schema.webhooks).values({ id: 'hook', serverId: 'server', channelId: 'text', userId: 'bot', name: 'Первое имя', avatarUrl: `${OWN}avatars/old.png`, tokenHash: rules.hashWebhookToken(TOKEN), createdBy: 'manager' });
  const events: shared.GatewayServerMessage[] = [], rateCalls: { key: string; max: number; seconds: number }[] = [];
  const hits = new Map<string, number>();
  let selects = 0;
  const db = new Proxy(t.db, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (key === 'select') return (...args: unknown[]) => { selects++; return Reflect.apply(value, target, args); };
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.headers['x-fixture-user'];
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    req.user = { sub: String(user) } as FastifyRequest['user'];
  };
  // Фиксированное окно без часов/Redis: проверяются выбранные маршрутом ключ, max и seconds,
  // не конкурентность и истечение настоящего Redis-счётчика.
  const authGuard = {
    clientIp: (req: FastifyRequest) => req.ip,
    rateHit: async (key: string, max: number, seconds: number) => {
      rateCalls.push({ key, max, seconds });
      const n = (hits.get(key) ?? 0) + 1; hits.set(key, n);
      return n > max ? 17 : 0;
    },
    pushDebounced: async () => false,
    attachmentUploadBlock: async () => 0,
  };
  const serialize = load<typeof import('../src/serialize.js')>('serialize', {
    '@gusvoice/shared': shared, './env.js': { env: {} }, './linkThreats.js': { dangerousLinksOf: () => [] },
    './federation/instanceLabels.js': { instanceLabel: () => null },
  }, ['./auth.js', './superAdminRules.js', './statusRules.js', './shopRules.js', './callRules.js', './lastSeenRules.js'], mutation);
  // resolveRoleMentions — настоящий SQL и shared.canMentionRole, не перечень ролей из мока.
  const push = load<typeof import('../src/push.js')>('push', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './db/index.js': { db }, './db/schema.js': schema,
    './pushRules.js': pushRules, './env.js': { env: { ntfy: { baseUrl: '', token: '' } } },
  }, ['./federation/instanceLabels.js', './permissions.js', './pushCrypto.js', './pushDefer.js', './util.js']);
  const routes = load<typeof import('../src/routes/webhooks.js')>('routes/webhooks', {
    '@gusvoice/shared': shared, 'node:crypto': crypto, 'drizzle-orm': orm, zod: { z },
    '../db/index.js': { db }, '../db/schema.js': schema, '../webhookRules.js': rules,
    '../auth.js': { requireAuth, hashPassword: async () => 'fixture-hash' }, '../authGuard.js': authGuard,
    '../permissions.js': { getChannelPermissions: async (channel: string, user: string) => channel === 'missing' ? null : {
      serverId: 'server', permissions: user === 'manager' && channel !== 'target' ? shared.Permission.VIEW_CHANNEL | shared.Permission.MANAGE_WEBHOOKS : 0n,
    }, getServerChannelPermissions: async (server: string, user: string) => server !== 'server' || user === 'outsider' ? null : new Map([
      ['text', user === 'manager' ? shared.Permission.VIEW_CHANNEL | shared.Permission.MANAGE_WEBHOOKS : shared.Permission.VIEW_CHANNEL],
      ['target', user === 'manager' ? shared.Permission.MANAGE_WEBHOOKS : 0n], ['readable', shared.Permission.VIEW_CHANNEL],
    ]) },
    '../push.js': { resolveRoleMentions: push.resolveRoleMentions, resolveMentionedMembers: async () => [], contentPreview: pushRules.contentPreview,
      sendPushToUsers: async () => { throw new Error('push не должен уходить без получателей'); } },
    '../audit.js': { writeAudit: async () => {} }, '../serialize.js': serialize, '../util.js': { id: crypto.randomUUID },
    '../realtime.js': { publishToChannel: async (_server: string, _channel: string, message: shared.GatewayServerMessage) => { events.push(message); } },
    '../storage.js': { isOwnMediaUrl: (url: string) => url.startsWith(OWN), storageConfigured: () => true,
      attachmentBlocked: storageRules.attachmentBlocked,
      putAttachment: async (_id: string, _buffer: Buffer, _mime: string, name: string) => `${OWN}attachments/${name}`,
    },
  }, [], mutation);
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'validation' });
    const code = (error as { statusCode?: number }).statusCode;
    return reply.code(code && code < 500 ? code : 500).send({ error: error instanceof Error ? error.message : String(error) });
  });
  await app.register(multipart);
  await app.register(routes.webhookRoutes);
  if (extra === 'admin') {
    const admin = load<typeof import('../src/routes/admin.js')>('routes/admin', {
      '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: { z }, '../db/index.js': { db }, '../db/schema.js': schema,
      '../auth.js': { requireSuperAdmin: requireAuth }, '../serialize.js': { serializeUser: (row: typeof schema.users.$inferSelect) => ({ id: row.id, username: row.username }) },
      '../federation/links.js': { listLinks: async () => [] }, '../federation/linkRules.js': linkRules,
      '../federation/instanceMeta.js': { readInstanceMeta: async () => ({ name: 'Инстанс' }) },
    }, ['../accountDelete.js', '../economyStats.js', '../instanceSettings.js', '../federation/guestAccess.js', '../federation/directoryEvents.js',
      '../mailer.js', '../settings.js', '../dmRules.js', '../env.js', '../instanceSetup.js', '../instanceUpdate.js', '../dmReports.js',
      '../instanceUpdateRules.js', '../setupRules.js', '../storage.js'], mutation);
    await app.register(admin.adminRoutes);
  }
  if (extra === 'conv') {
    const conv = load<typeof import('../src/routes/conv.js')>('routes/conv', {
      '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: { z }, '../db/index.js': { db }, '../db/schema.js': schema,
      '../auth.js': { requireAuth, isSuperAdmin: () => false }, '../authGuard.js': authGuard,
      '../convRules.js': convRules, '../dmRules.js': dmRules, '../superAdminRules.js': superAdminRules,
      // Дальнейшее открытие беседы не предмет этого теста: парный человек имеет уже существующую беседу.
      '../conversations.js': { findDirect: async () => ({ id: 'existing' }), revealDirect: async () => null,
        listConversations: async () => ({ conversations: [{ id: 'existing' }] }) },
      '../instanceSetup.js': { dmPolicy: () => 'shared' }, '../userSearchRules.js': { reachableUser: () => true },
    }, ['../guestGuard.js', './att.js', '../stickerCatalog.js', '../blockRules.js', '../blocks.js', '../convSendFanout.js', '../dmReports.js',
      '../strangerRules.js', '../scheduled.js', '../scheduleRules.js', '../contacts.js', '../contactRules.js', '../realtime.js', './dmFolders.js',
      '../db/peerQueries.js', '../lastSeen.js', '../push.js'], mutation);
    await app.register(conv.convRoutes);
  }
  await app.ready();
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, user?: string, ip = '127.0.0.1', contentType?: string) =>
    app.inject({ method, url, remoteAddress: ip, headers: { ...(user ? { 'x-fixture-user': user } : {}), ...(contentType ? { 'content-type': contentType } : {}) },
      ...(payload !== undefined ? { payload: payload as string | Record<string, unknown> } : {}) });
  const execute = (body: Record<string, unknown> = { content: 'Привет' }, wait = false, ip = '127.0.0.1') => request('POST', `/webhooks/hook/${TOKEN}${wait ? '?wait=true' : ''}`, body, undefined, ip);
  const rows = () => t.db.select().from(schema.messages).orderBy(schema.messages.createdAt);
  const author = async () => (await t.db.select().from(schema.users).where(orm.eq(schema.users.id, 'bot')))[0];
  return { app, request, execute, rows, author, serialize, events, rateCalls, hits, selects: () => selects };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function withFixture<T>(run: (f: Fixture) => Promise<T>, mutation?: Mutation, extra?: 'admin' | 'conv'): Promise<T> {
  const f = await fixture(mutation, extra);
  try { return await run(f); } finally { await f.app.close(); }
}

async function waitScenario(mutation?: Mutation) {
  await withFixture(async f => {
    status(await f.execute(), 204, 'без wait приём без входа даёт 204');
    const response = await f.execute({ content: 'Второе', username: 'CI' }, true);
    status(response, 200, 'R274:wait-возвращает-сообщение');
    assert.equal(response.json().content, 'Второе'); assert.equal(response.json().author.displayName, 'CI');
    assert.equal(response.json().webhookId, 'hook'); assert.equal((await f.rows()).length, 2); assert.equal(f.events.length, 2);
    const [hook] = await t.db.select().from(schema.webhooks); assert.ok(hook.lastUsedAt);
  }, mutation);
}
test('R274 анонимный приём сохраняет сообщение и событие: 204 обычно, 200 с DTO при wait=true', async () => waitScenario());

async function notFoundScenario(mutation?: Mutation) {
  await withFixture(async f => {
    const replies = [];
    for (const url of [`/webhooks/unknown/${TOKEN}`, `/webhooks/hook/${'x'.repeat(43)}`, '/webhooks/hook/short']) {
      const response = await f.request('POST', url, { content: 'мусор' });
      status(response, 404, 'R274:неверный-id-токен-и-форма-одинаково-404'); replies.push(response.json());
    }
    assert.deepEqual(replies, [{ error: 'unknown webhook' }, { error: 'unknown webhook' }, { error: 'unknown webhook' }]);
    assert.equal(f.selects(), 2, 'неверная форма токена отсекается до SQL');
    assert.equal((await f.rows()).length, 0);
    status(await f.execute(), 204, 'парный верный токен работает');
  }, mutation);
}
test('R274 неверные id, токен и форма токена не раскрывают существование вебхука одинаковым 404', async () => notFoundScenario());

async function malformedIdScenario(mutation?: Mutation) {
  // Проверяем через настоящий маршрут и общий Zod→400 handler: ошибка разбора параметров не должна выйти наружу.
  await withFixture(async f => {
    const malformed = await f.request('POST', `/webhooks/${'x'.repeat(65)}/${TOKEN}`, { content: 'не записывать' });
    status(malformed, 404, 'R275:кривой-id-не-отличается-от-неизвестного');
    assert.equal(f.selects(), 0, 'неверная длина отсекается до SQL');
    const unknown = await f.request('POST', `/webhooks/${'x'.repeat(64)}/${TOKEN}`, { content: 'не записывать' });
    const badToken = await f.request('POST', `/webhooks/hook/${'a'.repeat(43)}`, { content: 'не записывать' });
    for (const response of [unknown, badToken]) {
      status(response, 404, 'парный неизвестный id и неверный токен остаются 404');
      assert.deepEqual(malformed.json(), response.json(), 'форма не раскрывает отдельный ответ');
    }
    assert.deepEqual(malformed.json(), { error: 'unknown webhook' });
    assert.equal((await f.rows()).length, 0);
    // Не только отказ: ровно 64 знака у существующего вебхука ещё принимаются и сохраняют сообщение.
    await t.db.insert(schema.webhooks).values({ id: 'x'.repeat(64), serverId: 'server', channelId: 'text', userId: 'bot',
      name: 'Граница id', tokenHash: rules.hashWebhookToken(TOKEN), createdBy: 'manager' });
    const accepted = await f.request('POST', `/webhooks/${'x'.repeat(64)}/${TOKEN}`, { content: 'граница принята' });
    status(accepted, 204, 'id ровно 64 знака разрешён');
    assert.equal((await f.rows()).length, 1);
  }, mutation);
}

test('R275 id из 65 знаков возвращает общий 404 до SQL, существующий id из 64 знаков принимается', async () => malformedIdScenario());

test('R275 контрфакт возврата parse вместо safeParse пойман по HTTP400, а не ошибке VM или HTTP500', async () => {
  await malformedIdScenario();
  const from = "const parsed = z.object({ id: z.string().min(1).max(64), token: z.string() }).safeParse(req.params);\n        if (!parsed.success) return notFound();\n        const params = parsed.data;";
  const to = "const params = z.object({ id: z.string().min(1).max(64), token: z.string() }).parse(req.params);";
  await assert.rejects(malformedIdScenario({ module: 'routes/webhooks', from, to }), failure('R275:кривой-id-не-отличается-от-неизвестного'));
});

test('R274 120 запросов с IP ещё проходят до проверки токена, 121-й получает 429 до базы', async () => {
  await withFixture(async f => {
    for (let n = 1; n <= 120; n++) status(await f.request('POST', `/webhooks/unknown/${TOKEN}`, { content: 'тест' }), 404, `IP запрос ${n}`);
    assert.equal(f.selects(), 120);
    const denied = await f.execute(); status(denied, 429, 'IP предел+1');
    assert.equal(denied.headers['retry-after'], '17'); assert.equal(denied.json().retry_after, 17); assert.equal(f.selects(), 120, '429 раньше SQL');
    assert.deepEqual(f.rateCalls[0], { key: 'whip:127.0.0.1', max: 120, seconds: 60 });
    status(await f.execute({ content: 'другой адрес' }, false, '127.0.0.2'), 204, 'у другого адреса отдельный бюджет');
  });
});

test('R274 30 сообщений вебхука проходят, 31-е с другого IP ограничивается на hook и возвращает Retry-After', async () => {
  await withFixture(async f => {
    for (let n = 1; n <= 30; n++) status(await f.execute(), 204, `сообщение ${n} включено`);
    const denied = await f.execute({ content: 'лишнее' }, false, '127.0.0.2'); status(denied, 429, 'предел вебхука общий между IP');
    assert.equal(denied.headers['retry-after'], '17'); assert.equal(denied.json().retry_after, 17); assert.equal((await f.rows()).length, 30);
    assert.ok(f.rateCalls.some(call => call.key === 'webhook:hook' && call.max === 30 && call.seconds === 60));
  });
});

async function bodyScenario(mutation?: Mutation) {
  await withFixture(async f => {
    const minimal = JSON.stringify({ content: 'ok', padding: '' });
    const padded = (size: number) => JSON.stringify({ content: 'ok', padding: 'a'.repeat(size - Buffer.byteLength(minimal)) });
    const exact = padded(65_536), over = padded(65_537);
    assert.equal(Buffer.byteLength(exact), 65_536); assert.equal(Buffer.byteLength(over), 65_537);
    status(await f.request('POST', `/webhooks/hook/${TOKEN}`, exact, undefined, undefined, 'application/json'), 204, 'ровно 64KiB ещё допустимы');
    status(await f.request('POST', `/webhooks/hook/${TOKEN}`, over, undefined, undefined, 'application/json'), 413, 'R274:64KiB-плюс-байт-отклонён');
    assert.equal((await f.rows()).length, 1);
  }, mutation);
}
test('R274 предел Fastify измеряется байтами: ровно 64KiB принимается, следующий байт даёт 413', async () => bodyScenario());

test('R274 JSON принимается, text/plain с тем же JSON отклоняется как 415 без записи сообщения', async () => {
  await withFixture(async f => {
    status(await f.request('POST', `/webhooks/hook/${TOKEN}`, '{"content":"текст"}', undefined, undefined, 'text/plain'), 415, 'нужен JSON');
    assert.equal((await f.rows()).length, 0);
    status(await f.execute({ content: 'текст' }), 204, 'парный application/json принимается');
  });
});

async function rolesScenario(mutation?: Mutation) {
  await withFixture(async f => {
    // Класс ошибки R280: MANAGE_ROLES вместо MENTION_EVERYONE молча теряет закрытые роли даже при разрешающей политике.
    // Latin намеренно: общий MENTION_NAME_SRC для обезвреживания не включает кириллицу.
    const content = '@everyone @here @Moderators @Testers @Secret @human';
    const quiet = await f.execute({ content }, true); status(quiet, 200, 'сообщение без allowed_mentions принято');
    assert.equal(quiet.json().content, content);
    assert.deepEqual([...quiet.json().mentionRoles].sort(), ['allowed', 'locked', 'other-role'], 'R280:закрытая-роль-по-умолчанию-позвана');
    const limited = await f.execute({ content, allowed_mentions: { roles: ['allowed'] } }, true);
    status(limited, 200, 'явный список ролей принят');
    assert.deepEqual(limited.json().mentionRoles, ['allowed'], 'R274:роли-ограничены-allowedRoleIds-и-mentionable');
    assert.ok(limited.json().content.includes('@Moderators'), 'R274:разрешённая-роль-осталась-в-тексте');
    assert.ok(limited.json().content.includes('@\u200bTesters'));
    assert.ok(limited.json().content.includes('@\u200bSecret'));
    assert.ok(limited.json().content.includes('@\u200bhuman'));
    const all = await f.execute({ content, allowed_mentions: { parse: ['everyone', 'roles', 'users'] } }, true);
    status(all, 200, 'явное широкое разрешение работает'); assert.equal(all.json().content, content);
    assert.deepEqual([...all.json().mentionRoles].sort(), ['allowed', 'locked', 'other-role']);
    const silent = await f.execute({ content, allowed_mentions: { parse: [] } }, true);
    status(silent, 200, 'явный пустой parse принимает сообщение, не отказывая в отправке');
    assert.equal(silent.json().content, '@\u200beveryone @\u200bhere @\u200bModerators @\u200bTesters @\u200bSecret @\u200bhuman');
    assert.equal(silent.json().mentionRoles, undefined, 'пустой parse никого не зовёт, включая закрытую роль');
    assert.deepEqual((await f.rows()).map(row => [...plain(row.mentionRoles)].sort().join(',')).sort(), ['', 'allowed', 'allowed,locked,other-role', 'allowed,locked,other-role']);
  }, mutation);
}
test('R280 allowed_mentions по умолчанию и с полным parse зовёт закрытую роль, список сужает роли, пустой parse никого не зовёт', async () => rolesScenario());

test('R279 allowed_mentions.users переводит id в ник и не разрешает похожие имена или broadcasts', async () => {
  // Класс ошибки: маршрут передаёт id вместо ника и либо гасит разрешённого человека, либо расширяет список получателей.
  await withFixture(async f => {
    const response = await f.execute({ content: '@webhook_human @webhook_reader @human @everyone', allowed_mentions: { users: ['human'] } }, true);
    status(response, 200, 'список id принят');
    assert.equal(response.json().content, '@webhook_human @\u200bwebhook_reader @\u200bhuman @\u200beveryone');
    assert.equal(response.json().mentionRoles, undefined);
  });
});

test('R279 карточки хранятся отдельно, свёртка совместимости приходит только без собственного текста и никого не зовёт', async () => {
  // Класс ошибки: сохранение карточки теряет DTO или отдаёт старому клиенту звонящий fallback вместо безопасной цитаты.
  await withFixture(async f => {
    const embeds = [{ title: '@everyone', description: '@here @webhook_human', image: { url: 'https://tracker.invalid/pixel' } }];
    const only = await f.execute({ embeds }, true);
    status(only, 200, 'сообщение только с карточкой');
    assert.equal(only.json().embedsFallback, true);
    assert.equal(only.json().content, '> **@\u200beveryone**\n> @\u200bhere @\u200bwebhook_human');
    assert.equal(only.json().embeds[0].imageLink, 'https://tracker.invalid/pixel');
    assert.equal(only.json().embeds[0].image, undefined);
    assert.equal(only.json().mentionRoles, undefined);
    const both = await f.execute({ content: 'Своя подпись', embeds }, true);
    status(both, 200, 'подпись с карточкой');
    assert.equal(both.json().content, 'Своя подпись');
    assert.notEqual(both.json().embedsFallback, true);
    const rows = await f.rows();
    assert.equal(rows[0].embedsFallback, true);
    assert.equal(rows[1].embedsFallback, false);
    assert.deepEqual(rows[0].embeds, only.json().embeds);
    assert.equal(f.events.length, 2);
    status(await f.execute({ embeds: [{}] }), 400, 'пустая нормализованная карточка не создаёт сообщение');
    assert.equal((await f.rows()).length, 2);
  });
});

test('R279 HTTP принимает суммарно 6000 знаков карточек, 6001 отклоняет как 400 без записи', async () => {
  // Класс ошибки: ручка обходит общий предел карточек либо отклоняет допустимое сообщение ровно на границе.
  await withFixture(async f => {
    const embeds = [{ description: 'x'.repeat(4000) }, { description: 'y'.repeat(2000) }];
    status(await f.execute({ embeds }), 204, '6000 знаков включены');
    status(await f.execute({ embeds: [...embeds, { title: 'x' }] }), 400, '6001 знак отклонён схемой');
    assert.equal((await f.rows()).length, 1);
  });
});

function form(files: readonly { field?: string; name?: string; mime?: string }[], payload = '{}') {
  const boundary = 'r279-webhook-boundary';
  const parts = [`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\n\r\n${payload}\r\n`];
  for (const [i, file] of files.entries()) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? `files[${i}]`}"; filename="${file.name ?? `${i}.png`}"\r\nContent-Type: ${file.mime ?? 'image/png'}\r\n\r\nfixture-file\r\n`);
  parts.push(`--${boundary}--\r\n`);
  return { payload: parts.join(''), type: `multipart/form-data; boundary=${boundary}` };
}

test('R279 multipart принимает ровно десять файлов и attachment://, одиннадцатый даёт 413 до записи', async () => {
  // Класс ошибки: общий multipart-плагин по умолчанию допускает один файл; маршрут должен задать свой предел 10.
  await withFixture(async f => {
    const accepted = form(Array.from({ length: 10 }, () => ({})), JSON.stringify({ embeds: [{ image: { url: 'attachment://0.png' } }] }));
    const response = await f.request('POST', `/webhooks/hook/${TOKEN}?wait=true`, accepted.payload, undefined, undefined, accepted.type);
    status(response, 200, 'ровно 10 файлов принимаются');
    assert.equal(response.json().attachments.length, 10);
    assert.equal(response.json().embeds[0].image.url, `${OWN}attachments/0.png`);
    const rejected = form(Array.from({ length: 11 }, () => ({})));
    status(await f.request('POST', `/webhooks/hook/${TOKEN}`, rejected.payload, undefined, undefined, rejected.type), 413, '11 файлов превышают лимит');
    assert.equal((await f.rows()).length, 1);
  });
});

test('R279 multipart отвергает SVG по MIME и расширению, чужое поле и кривой payload_json, PNG принимается', async () => {
  // Класс ошибки: исполняемый файл или некорректный multipart сохраняется как успешное сообщение вместо явного отказа.
  await withFixture(async f => {
    for (const [files, payload, expected] of [
      [[{ name: 'pixel.png', mime: 'image/svg+xml' }], '{}', 415],
      [[{ name: 'pixel.svg', mime: 'image/png' }], '{}', 415],
      [[{ field: 'avatar' }], '{}', 400],
      [[{}], '{broken', 400],
    ] as const) {
      const data = form(files, payload);
      status(await f.request('POST', `/webhooks/hook/${TOKEN}`, data.payload, undefined, undefined, data.type), expected, 'опасный или некорректный multipart');
      assert.equal((await f.rows()).length, 0, 'отказ не оставляет сообщение');
    }
    const data = form([{}]);
    status(await f.request('POST', `/webhooks/hook/${TOKEN}`, data.payload, undefined, undefined, data.type), 204, 'парный PNG проходит');
    assert.equal((await f.rows()).length, 1);
  });
});

async function serverListScenario(mutation?: Mutation) {
  // Класс ошибки: одного MANAGE_WEBHOOKS недостаточно для раскрытия скрытого канала; одного VIEW_CHANNEL — для управления.
  await withFixture(async f => {
    await t.db.insert(schema.webhooks).values([
      { id: 'hidden-hook', serverId: 'server', channelId: 'target', userId: 'bot', name: 'Закрытый',
        tokenHash: rules.hashWebhookToken(TOKEN), createdBy: 'manager' },
      { id: 'readable-hook', serverId: 'server', channelId: 'readable', userId: 'bot', name: 'Без управления',
        tokenHash: rules.hashWebhookToken(TOKEN), createdBy: 'manager' },
    ]);
    status(await f.request('GET', '/servers/server/webhooks', undefined, 'outsider'), 404, 'неучастник не узнаёт список');
    status(await f.request('GET', '/servers/missing/webhooks', undefined, 'manager'), 404, 'нет сервера');
    status(await f.request('GET', '/servers/server/webhooks', undefined, 'reader'), 403, 'нет ни одного управляемого канала');
    status(await f.request('GET', '/servers/server/webhooks'), 401, 'вход обязателен');
    const response = await f.request('GET', '/servers/server/webhooks', undefined, 'manager');
    status(response, 200, 'управляемый канал доступен');
    assert.deepEqual(response.json().map((hook: { id: string }) => hook.id), ['hook'], 'R280:список-требует-VIEW_CHANNEL-и-MANAGE_WEBHOOKS');
    assert.equal(response.json()[0].token, undefined);
    assert.equal(response.json()[0].tokenHash, undefined);
  }, mutation);
}

test('R280 список сервера сохраняет 404 и 403 и показывает только каналы с VIEW_CHANNEL и MANAGE_WEBHOOKS одновременно', async () => serverListScenario());

test('R279 миграция 0153 добавляет nullable embeds и false для старых сообщений без карточки', async () => {
  // Класс ошибки: новые обязательные поля ломают чтение старой истории или ошибочно скрывают её обычный текст.
  await withFixture(async f => {
    assert.ok(t.appliedMigrations.includes('0153_message_embeds.sql'));
    await t.db.insert(schema.messages).values({ id: 'legacy-message', channelId: 'text', authorId: 'human', content: 'старое сообщение' });
    const [row] = await f.rows();
    assert.equal(row.embeds, null);
    assert.equal(row.embedsFallback, false);
    const dto = f.serialize.serializeMessage({ ...row, author: await f.author(), replyTo: null });
    assert.equal(dto.embeds, undefined);
    assert.equal(dto.embedsFallback, undefined);
  });
});

test('R274 чужой avatar_url игнорируется, собственный принимается и попадает в снимок сообщения', async () => {
  await withFixture(async f => {
    for (const avatar of ['https://tracker.invalid/pixel.png', 'https://media.invalid.evil/gusvoice/avatars/a.png', `${OWN}avatars/override.png`]) {
      const response = await f.execute({ content: 'аватар', avatar_url: avatar }, true); status(response, 200, 'аватар не мешает приёму');
      const expected = avatar.startsWith(OWN) ? avatar : `${OWN}avatars/old.png`;
      assert.equal(response.json().author.avatarUrl, expected);
      const [row] = await t.db.select().from(schema.messages).where(orm.eq(schema.messages.id, response.json().id));
      assert.equal(row.webhookAvatar, expected);
    }
  });
});

async function historyScenario(mutation?: Mutation) {
  await withFixture(async f => {
    status(await f.execute({ content: 'первое', username: 'Снимок CI', avatar_url: `${OWN}avatars/snapshot.png` }), 204, 'первая запись');
    const patched = await f.request('PATCH', '/webhooks/hook', { name: 'Новое имя', avatarUrl: null }, 'manager'); status(patched, 200, 'управляющий меняет вебхук');
    assert.equal(patched.json().name, 'Новое имя'); assert.equal((await f.author()).displayName, 'Новое имя');
    const [old] = await f.rows();
    assert.equal(old.webhookName, 'Снимок CI', 'R274:PATCH-не-переписывает-имя-истории');
    assert.equal(old.webhookAvatar, `${OWN}avatars/snapshot.png`, 'R274:PATCH-не-переписывает-аватар-истории');
    const dto = f.serialize.serializeMessage({ ...old, author: await f.author(), replyTo: null });
    assert.equal(dto.author.displayName, 'Снимок CI'); assert.equal(dto.author.avatarUrl, `${OWN}avatars/snapshot.png`);
    const next = await f.execute({ content: 'после правки' }, true); status(next, 200, 'новое сообщение');
    assert.equal(next.json().author.displayName, 'Новое имя'); assert.equal(next.json().author.avatarUrl, null);
  }, mutation);
}
test('R274 PATCH меняет профиль автора и будущие сообщения, не имя и аватар сохранённой истории', async () => historyScenario());

async function deleteScenario(mutation?: Mutation) {
  await withFixture(async f => {
    status(await f.execute(), 204, 'сообщение до удаления');
    status(await f.request('DELETE', '/webhooks/hook', undefined, 'manager'), 204, 'удаление вебхука');
    assert.ok(await f.author(), 'R274:DELETE-сохраняет-строку-автора');
    const rows = await f.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].authorId, 'bot'); assert.equal(rows[0].webhookId, 'hook');
    assert.equal((await t.db.select().from(schema.webhooks)).length, 0);
    status(await f.execute(), 404, 'старый адрес больше не действует');
  }, mutation);
}
test('R274 DELETE убивает адрес, но оставляет автора и его сообщения', async () => deleteScenario());

test('R274 управление требует вход и MANAGE_WEBHOOKS; наличие одного входа не разрешает список, создание и PATCH', async () => {
  await withFixture(async f => {
    for (const [method, url, payload] of [
      ['GET', '/channels/text/webhooks', undefined], ['POST', '/channels/text/webhooks', { name: 'Новый' }],
      ['PATCH', '/webhooks/hook', { name: 'Чужая правка' }], ['POST', '/webhooks/hook/token', undefined], ['DELETE', '/webhooks/hook', undefined],
    ] as const) {
      status(await f.request(method, url, payload), 401, 'аноним не управляет');
      status(await f.request(method, url, payload, 'reader'), 403, 'читатель без права не управляет');
    }
    const list = await f.request('GET', '/channels/text/webhooks', undefined, 'manager'); status(list, 200, 'список с правом разрешён');
    assert.equal(list.json().length, 1); assert.equal(list.json()[0].token, undefined); assert.equal(list.json()[0].tokenHash, undefined);
    status(await f.request('PATCH', '/webhooks/hook', { channelId: 'target' }, 'manager'), 403, 'право требуется также на целевой канал');
    status(await f.request('PATCH', '/webhooks/hook', { name: 'Разрешено' }, 'manager'), 200, 'парная правка имени разрешена');
    const created = await f.request('POST', '/channels/text/webhooks', { name: 'Созданный' }, 'manager'); status(created, 201, 'создание с правом');
    const [row] = await t.db.select().from(schema.webhooks).where(orm.eq(schema.webhooks.id, created.json().id));
    const [bot] = await t.db.select().from(schema.users).where(orm.eq(schema.users.id, row.userId));
    assert.equal(row.tokenHash, rules.hashWebhookToken(created.json().token)); assert.notEqual(row.tokenHash, created.json().token);
    assert.equal(bot.bot, true); assert.equal(bot.hiddenFromPeers, true); assert.equal(bot.verified, false); assert.equal(bot.approvedAt, null);
    assert.equal(bot.canCreateServers, false); assert.equal(bot.email, null); assert.equal(bot.username, `webhook:${row.id}`);
  });
});

test('R274 повторная генерация токена разрешена управляющему, старый адрес сразу закрывается, новый действует', async () => {
  await withFixture(async f => {
    const fresh = await f.request('POST', '/webhooks/hook/token', undefined, 'manager'); status(fresh, 200, 'ротация разрешена');
    assert.notEqual(fresh.json().token, TOKEN); assert.equal(fresh.json().tokenHash, undefined);
    status(await f.execute(), 404, 'старый токен больше не действует');
    status(await f.request('POST', `/webhooks/hook/${fresh.json().token}`, { content: 'новый' }), 204, 'новый токен принят');
  });
});

test('R274 пятнадцатый вебхук канала ещё создаётся, шестнадцатый отклоняется без лишней записи или автора', async () => {
  await withFixture(async f => {
    // В fixture уже один вебхук; заполняем до 14 без четырнадцати посторонних HTTP-сценариев.
    await t.db.insert(schema.webhooks).values(Array.from({ length: 13 }, (_, n) => ({
      id: `seed-hook-${n}`, serverId: 'server', channelId: 'text', userId: 'bot', name: `Сид ${n}`,
      tokenHash: rules.hashWebhookToken(TOKEN), createdBy: 'manager',
    })));
    assert.equal((await t.db.select().from(schema.webhooks)).length, 14);
    const accepted = await f.request('POST', '/channels/text/webhooks', { name: 'Пятнадцатый' }, 'manager');
    status(accepted, 201, 'ровно 15 вебхуков разрешены');
    assert.equal((await t.db.select().from(schema.webhooks)).length, 15);
    const authorsBefore = (await t.db.select().from(schema.users)).length;
    const denied = await f.request('POST', '/channels/text/webhooks', { name: 'Шестнадцатый' }, 'manager');
    status(denied, 400, 'шестнадцатый вебхук отклонён');
    assert.equal((await t.db.select().from(schema.webhooks)).length, 15, 'отказ не создаёт лишний вебхук');
    assert.equal((await t.db.select().from(schema.users)).length, authorsBefore, 'отказ не оставляет лишнего служебного автора');
  });
});

test('R274 право управления не разрешает вебхук голосового канала, парный текстовый канал принимает создание', async () => {
  await withFixture(async f => {
    const denied = await f.request('POST', '/channels/voice/webhooks', { name: 'В голос' }, 'manager');
    status(denied, 400, 'в голосовом канале создавать нельзя даже с MANAGE_WEBHOOKS');
    assert.equal((await t.db.select().from(schema.webhooks)).length, 1);
    assert.equal((await t.db.select().from(schema.users)).length, 4);
    const accepted = await f.request('POST', '/channels/text/webhooks', { name: 'В текст' }, 'manager');
    status(accepted, 201, 'то же право и тело разрешены в текстовом канале');
    assert.equal(accepted.json().channelId, 'text');
    assert.equal((await t.db.select().from(schema.webhooks)).length, 2);
    assert.equal((await t.db.select().from(schema.users)).length, 5);
  });
});

async function adminScenario(mutation?: Mutation) {
  await withFixture(async f => {
    const response = await f.request('GET', '/admin/users', undefined, 'manager'); status(response, 200, 'настоящий admin/users');
    assert.deepEqual(response.json().map((row: { id: string }) => row.id).sort(), ['human', 'manager', 'reader'], 'R274:admin-не-показывает-бота');
    assert.ok(await f.author(), 'бот отфильтрован SQL-выдачей, не удалён');
  }, mutation, 'admin');
}
test('R274 настоящий admin/users не отдаёт служебного автора, обычные люди остаются', async () => adminScenario());

async function directScenario(mutation?: Mutation) {
  await withFixture(async f => {
    const denied = await f.request('POST', '/conv/direct', { userId: 'bot' }, 'manager');
    status(denied, 403, 'R274:direct-к-боту-запрещён'); assert.equal(denied.json().error, 'Это вебхук — ему нельзя написать');
    const human = await f.request('POST', '/conv/direct', { userId: 'human' }, 'manager'); status(human, 200, 'парная существующая беседа человека доступна');
    assert.equal(human.json().id, 'existing');
  }, mutation, 'conv');
}
test('R274 настоящий conv/direct отвечает 403 служебному автору, но открывает существующую беседу человека', async () => directScenario());

const mutants: readonly [string, Mutation, (mutation?: Mutation) => Promise<unknown>, string][] = [
  ['401 раскрывает ошибку токена', { module: 'routes/webhooks', from: "const notFound = () => reply.code(404).send({ error: 'unknown webhook' });", to: "const notFound = () => reply.code(401).send({ error: 'unknown webhook' });" }, notFoundScenario, 'R274:неверный-id-токен-и-форма-одинаково-404'],
  ['роли обходят allowedRoleIds', { module: 'routes/webhooks', from: 'allowedRoleIds(await resolveRoleMentions(text, channel.serverId, Permission.MENTION_EVERYONE), policy)', to: 'await resolveRoleMentions(text, channel.serverId, Permission.MENTION_EVERYONE)' }, rolesScenario, 'R274:роли-ограничены-allowedRoleIds-и-mentionable'],
  ['закрытая роль теряется при MANAGE_ROLES вместо MENTION_EVERYONE', { module: 'routes/webhooks', from: 'resolveRoleMentions(text, channel.serverId, Permission.MENTION_EVERYONE)', to: 'resolveRoleMentions(text, channel.serverId, Permission.MANAGE_ROLES)' }, rolesScenario, 'R280:закрытая-роль-по-умолчанию-позвана'],
  ['список раскрывает управляемый канал без VIEW_CHANNEL', { module: 'routes/webhooks', from: 'has(p, Permission.VIEW_CHANNEL) && has(p, Permission.MANAGE_WEBHOOKS)', to: 'has(p, Permission.MANAGE_WEBHOOKS)' }, serverListScenario, 'R280:список-требует-VIEW_CHANNEL-и-MANAGE_WEBHOOKS'],
  ['wait игнорируется', { module: 'routes/webhooks', from: "return query.wait === 'true' ? reply.code(200).send(message) : reply.code(204).send();", to: 'return reply.code(204).send();' }, waitScenario, 'R274:wait-возвращает-сообщение'],
  // У оригинала нет UPDATE истории и DELETE автора: контрфакт добавляет именно ошибочный SQL
  // в выполняемый обработчик, а не ищет несуществующее выражение или мёртвую ветку.
  ['PATCH переписывает историю', { module: 'routes/webhooks', from: 'await db.update(users).set({ displayName: row.name, avatarUrl: row.avatarUrl }).where(eq(users.id, row.userId));', to: 'await db.update(users).set({ displayName: row.name, avatarUrl: row.avatarUrl }).where(eq(users.id, row.userId));\nawait db.update(messages).set({ webhookName: row.name, webhookAvatar: row.avatarUrl }).where(eq(messages.webhookId, row.id));' }, historyScenario, 'R274:PATCH-не-переписывает-имя-истории'],
  ['DELETE удаляет автора', { module: 'routes/webhooks', from: 'await db.delete(webhooks).where(and(eq(webhooks.id, hook.id), eq(webhooks.serverId, hook.serverId)));', to: 'await db.delete(users).where(eq(users.id, hook.userId));' }, deleteScenario, 'R274:DELETE-сохраняет-строку-автора'],
  ['снят bodyLimit', { module: 'routes/webhooks', from: '{ bodyLimit: WEBHOOK_BODY_LIMIT }', to: '{}' }, bodyScenario, 'R274:64KiB-плюс-байт-отклонён'],
  ['admin снова показывает бота', { module: 'routes/admin', from: 'and(isNull(users.deletedAt), isNull(users.homeInstanceId), eq(users.bot, false))', to: 'and(isNull(users.deletedAt), isNull(users.homeInstanceId))' }, adminScenario, 'R274:admin-не-показывает-бота'],
  ['direct снова пускает бота', { module: 'routes/conv', from: "if (other.bot) return reply.code(403).send({ error: 'Это вебхук — ему нельзя написать' });", to: '' }, directScenario, 'R274:direct-к-боту-запрещён'],
];
for (const [label, mutation, scenario, marker] of mutants) test(`R274 контрфакт: ${label} ловится адресным AssertionError после проверки оригинала`, async () => {
  await scenario();
  await assert.rejects(scenario(mutation), failure(marker));
});
