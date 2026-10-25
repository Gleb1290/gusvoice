import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify, { type FastifyRequest } from 'fastify';
import ts from 'typescript';
import { z, ZodError } from 'zod';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as attachmentRules from '../src/attachmentRules.js';
import * as dmRules from '../src/dmRules.js';
import * as blockRules from '../src/blockRules.js';
import * as scheduleRules from '../src/scheduleRules.js';
import * as strangerRules from '../src/strangerRules.js';
import * as contactRules from '../src/contactRules.js';
import * as superAdminRules from '../src/superAdminRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

// Реальная БД со всеми миграциями и настоящие маршруты Fastify. VM загружает целые модули приложения;
// подменены только внешние границы (вход, подпись ссылки, хранилище, push/Redis), не SQL и не правила once.
type Mutation = { module: string; from: string; to: string };
type Conv = typeof import('../src/conversations.js');
type Ref = import('../src/conversations.js').AttachmentRef;
type Response = { statusCode: number; body: string; headers: Record<string, unknown>; json(): any };
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => {
  try { await t?.close(); } finally { await (await import('../src/db/index.js')).pool.end(); }
});

function load<T>(name: string, deps: Record<string, unknown>, dormant: readonly string[] = [], mutation?: Mutation): T {
  let raw = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation?.module === name) {
    assert.equal(raw.split(mutation.from).length - 1, 1, `один адресный якорь ${name}`);
    raw = raw.replace(mutation.from, mutation.to);
  }
  const file = ts.createSourceFile(`${name}.ts`, raw, ts.ScriptTarget.Latest, true);
  assert.equal((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0,
    'мутант обязан остаться синтаксически корректным');
  const imports: Record<string, unknown> = { ...deps };
  for (const id of dormant) imports[id] = new Proxy({}, { get: (_obj, key) => key === '__esModule' ? true : () => {
    throw new Error(`неисполняемая внешняя граница ${name}: ${id}.${String(key)}`);
  } });
  for (const n of file.statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly) continue;
    const id = (n.moduleSpecifier as ts.StringLiteral).text;
    assert.ok(Object.hasOwn(imports, id), `неописанный импорт R262 ${name}: ${id}`);
  }
  const result = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  assert.equal(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const module = { exports: {} };
  runInNewContext(result.outputText, { module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, console, Error,
    require: (id: string) => { assert.ok(Object.hasOwn(imports, id), `неописанный динамический импорт R262 ${name}: ${id}`); return imports[id]; },
  }, { timeout: 2000 });
  return module.exports as T;
}

const signature = 's'.repeat(32);
const link = (id: string, viewer: string) => `/att/${id}/${viewer}/${signature}`;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function status(response: Response, expected: number, marker: string): void {
  // HTTP 500 из-за заглушки/опечатки НЕ считается пойманной регрессией доступа.
  assert.ok(response.statusCode < 500, `R262:внутренняя-ошибка: ${response.body}`);
  assert.equal(response.statusCode, expected, marker);
}
const failure = (marker: string) => (error: unknown) => error instanceof assert.AssertionError && error.message.includes(marker);

async function fixture(mutation?: Mutation) {
  await truncateAll(t.raw);
  const remoteHome = 'b'.repeat(32);
  await t.db.insert(schema.users).values([
    ...['author', 'recipient', 'third', 'outsider'].map(id => ({ id, username: `once_${id}`, displayName: id, passwordHash: 'fixture' })),
    { id: 'remote', username: 'once_remote', displayName: 'remote', passwordHash: 'fixture', homeInstanceId: remoteHome, homeUserId: 'home-user' },
  ]);
  await t.db.insert(schema.conversations).values([
    { id: 'dm', kind: 'direct', directKey: 'author:recipient', createdBy: 'author' },
    { id: 'saved', kind: 'direct', directKey: rules.savedKey('author'), createdBy: 'author' },
    { id: 'group', kind: 'group', title: 'Группа', createdBy: 'author' },
    { id: 'remote-dm', kind: 'direct', directKey: 'author:remote', createdBy: 'author' },
  ]);
  await t.db.insert(schema.conversationMembers).values([
    ...['author', 'recipient'].map(userId => ({ conversationId: 'dm', userId, pending: false })),
    { conversationId: 'saved', userId: 'author', pending: false },
    ...['author', 'recipient', 'third'].map(userId => ({ conversationId: 'group', userId, pending: false })),
    ...['author', 'remote'].map(userId => ({ conversationId: 'remote-dm', userId, pending: false })),
  ]);
  const files = new Map<string, Buffer>(), purged: string[] = [], purgeStates: string[][] = [], purgeTasks: Promise<unknown>[] = [];
  const events: { user: string; message: shared.GatewayServerMessage }[] = [];
  let reads = 0;
  const store = {
    configured: () => true, ready: () => true, ensureReady: async () => true,
    stat: async (key: string) => files.has(key) ? { size: files.get(key)!.length } : null,
    get: async (key: string, range?: { start: number; end: number }) => {
      reads++;
      const bytes = files.get(key); assert.ok(bytes, 'хранилище не должно читать удалённый объект');
      return Readable.from(range ? bytes.subarray(range.start, range.end + 1) : bytes);
    },
  };
  const attachments = {
    attachmentLink: link, attachmentStore: store, privateAttachmentsReady: () => true,
    attachmentSigValid: (_id: string, _viewer: string, _gen: number, sig: string) => sig === signature,
    DailyQuotaError: class extends Error {},
    purgeDeleted: async (keys: string[]) => {
      // Состояние читается новым SQL после COMMIT, а не повторяется в макете хранилища.
      purged.push(...keys); for (const key of keys) files.delete(key);
      const task = t.raw.query<{ state: string }>('SELECT state FROM attachments WHERE storage_key=ANY($1::text[]) ORDER BY storage_key', [keys])
        .then(result => { purgeStates.push(result.rows.map(r => r.state)); });
      purgeTasks.push(task); await task;
    },
  };
  const realtime = { publishToUser: async (user: string, message: shared.GatewayServerMessage) => { events.push({ user, message }); } };
  const serialize = load<typeof import('../src/serialize.js')>('serialize', {
    '@gusvoice/shared': shared, './env.js': { env: {} }, './linkThreats.js': { dangerousLinksOf: () => [] },
    './federation/instanceLabels.js': { instanceLabel: () => null },
  }, ['./auth.js', './superAdminRules.js', './statusRules.js', './shopRules.js', './callRules.js', './lastSeenRules.js']);
  const c = load<Conv>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './convRules.js': rules,
    './db/index.js': { db: t.db }, './db/schema.js': schema, './dmWriteBarrier.js': { dmWriteBarrier: {} },
    './attachments.js': attachments, './env.js': { env: {} }, './serialize.js': serialize, './util.js': { uuidv7: randomUUID },
    './realtime.js': realtime,
  }, [], mutation);
  const scheduled = load<typeof import('../src/scheduled.js')>('scheduled', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './attachments.js': attachments, './blockRules.js': blockRules,
    './conversations.js': c, './convRules.js': rules, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './scheduleRules.js': scheduleRules, './util.js': { uuidv7: randomUUID },
  }, ['./convSendFanout.js'], mutation);
  const authGuard = { rateHit: async () => 0, messageSendBlock: async () => 0, clientIp: () => 'fixture', retryMessage: () => 'fixture' };
  const att = load<typeof import('../src/routes/att.js')>('routes/att', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: { z }, '../attachmentRules.js': attachmentRules,
    '../attachments.js': attachments, '../authGuard.js': authGuard, '../convRules.js': rules,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema,
  }, ['../storage.js'], mutation);
  const routes = load<typeof import('../src/routes/conv.js')>('routes/conv', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: { z },
    '../auth.js': { requireAuth: async (req: FastifyRequest) => { req.user = { sub: String(req.headers['x-fixture-user'] ?? 'author') } as FastifyRequest['user']; } },
    '../authGuard.js': authGuard, './att.js': att, '../blockRules.js': blockRules,
    '../blocks.js': { isBlockedBy: async () => false, blockedBy: async () => new Set() },
    '../conversations.js': c, '../convSendFanout.js': { fanOutSend: async (input: { delivery: Parameters<Conv['deliver']>[0] }) => c.deliver(input.delivery) },
    '../strangerRules.js': strangerRules, '../scheduled.js': scheduled, '../scheduleRules.js': scheduleRules,
    '../convRules.js': rules, '../contactRules.js': contactRules, '../db/index.js': { db: t.db }, '../realtime.js': realtime,
    '../db/schema.js': schema, '../dmRules.js': dmRules, '../superAdminRules.js': superAdminRules,
    '../push.js': { sendReadSyncPush: async () => {} },
  }, ['../guestGuard.js', '../stickerCatalog.js', '../dmReports.js', '../contacts.js', './dmFolders.js', '../db/peerQueries.js',
    '../lastSeen.js', '../instanceSetup.js', '../userSearchRules.js'], mutation);
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'validation', issues: error.issues });
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  });
  await app.register(routes.convRoutes);
  await app.register(att.attRoutes);
  await app.ready();
  const request = (user: string, method: 'GET' | 'HEAD' | 'POST', url: string, payload?: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { 'x-fixture-user': user, ...headers }, ...(payload ? { payload } : {}) });
  async function pending(contentType = 'image/jpeg', conversationId = 'dm') {
    const id = randomUUID(), key = `once/${id}`;
    files.set(key, Buffer.from('once-fixture-bytes'));
    await t.db.insert(schema.attachments).values({ id, conversationId, ownerId: 'author', storageKey: key,
      name: contentType.startsWith('video/') ? 'clip.mp4' : contentType.startsWith('audio/') ? 'voice.ogg' : 'photo.jpg',
      contentType, size: files.get(key)!.length, state: 'pending' });
    return { id, key };
  }
  const row = async (id: string) => (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, id)))[0];
  const attachment = async (id: string) => (await t.db.select().from(schema.attachments).where(orm.eq(schema.attachments.id, id)))[0];
  async function send(refs: Ref[], conversationId = 'dm') {
    return request('author', 'POST', `/conv/${conversationId}/messages`, { clientId: randomUUID(), attachments: refs });
  }
  async function media(contentType = 'image/jpeg', hints: Omit<Ref, 'id'> = { once: true, onceTtl: 1 }, conversationId = 'dm') {
    const uploaded = await pending(contentType, conversationId);
    const response = await send([{ id: uploaded.id, ...hints }], conversationId);
    status(response, 201, 'R262:одиночное-медиа-принимается');
    return { ...uploaded, mid: response.json().id as string, dto: response.json() as shared.ConvMessage };
  }
  return { c, routes, app, request, pending, send, media, row, attachment, files, purged, purgeStates, events,
    reads: () => reads, settled: () => Promise.all(purgeTasks) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function withFixture<T>(run: (f: Fixture) => Promise<T>, mutation?: Mutation): Promise<T> {
  const f = await fixture(mutation);
  try { return await run(f); } finally { await f.settled(); await f.app.close(); }
}

async function serverClockScenario(mutation?: Mutation) {
  // Настоящий HTTP-ответ и запись в БД: serverNow свежий в каждом ответе, openedAt остаётся первым.
  await withFixture(async f => {
    const p = await f.media('image/jpeg', { once: true, onceTtl: 10 });
    const path = `/conv/dm/messages/${p.mid}/once-open`;
    async function open() {
      const before = Date.now();
      const response = await f.request('recipient', 'POST', path);
      const after = Date.now();
      status(response, 200, 'R269:once-open-отвечает-успехом');
      const body = response.json();
      assert.equal(typeof body.openedAt, 'string', 'openedAt сохранён для старых клиентов');
      assert.equal(typeof body.serverNow, 'string', 'R269:once-open-содержит-serverNow');
      const now = Date.parse(body.serverNow);
      assert.equal(Number.isFinite(now), true, 'serverNow — разбираемая ISO-дата');
      assert.equal(new Date(now).toISOString(), body.serverNow, 'serverNow — UTC ISO, как openedAt');
      assert.ok(now >= before && now <= after, 'R269:serverNow-время-ответа-а-не-первого-открытия');
      return body as { openedAt: string; serverNow: string };
    }
    const first = await open();
    assert.equal((await f.row(p.mid)).onceOpenedAt!.toISOString(), first.openedAt);
    // Не ждём секунды: воспроизводим уже открытое сообщение записью на четыре секунды раньше.
    const original = new Date(Date.parse(first.openedAt) - 4000);
    await t.db.update(schema.conversationMessages).set({ onceOpenedAt: original }).where(orm.eq(schema.conversationMessages.id, p.mid));
    const again = await open();
    assert.equal(again.openedAt, original.toISOString(), 'повтор не перезапускает таймер');
    assert.equal((await f.row(p.mid)).onceOpenedAt!.toISOString(), original.toISOString());
    assert.ok(Date.parse(again.serverNow) > Date.parse(again.openedAt));
  }, mutation);
}

test('R269 once-open добавляет текущий serverNow, повтор сохраняет первый openedAt — иначе часы ПК и сервера смешаются', async () => serverClockScenario());

test('R269 контрфакты отсутствующего и скопированного из openedAt serverNow ловятся HTTP-данными, не HTTP500', async () => {
  for (const [from, to, marker] of [
    [', serverNow: new Date().toISOString()', '', 'R269:once-open-содержит-serverNow'],
    ['serverNow: new Date().toISOString()', 'serverNow: res.openedAt.toISOString()', 'R269:serverNow-время-ответа-а-не-первого-открытия'],
  ] as const) {
    await serverClockScenario();
    await assert.rejects(serverClockScenario({ module: 'routes/conv', from, to }), failure(marker));
  }
});

for (const conversation of ['group', 'saved'] as const) for (const contentType of ['image/jpeg', 'video/mp4'])
test(`R262 одноразовое ${contentType} в ${conversation === 'group' ? 'группе' : 'Избранном'} отклоняется явно, обычное принимается — иначе приватный кадр останется навсегда`, async () => {
  await withFixture(async f => {
    const p = await f.pending(contentType, conversation);
    const denied = await f.send([{ id: p.id, once: true }], conversation);
    status(denied, 400, 'R262:не-личка-отклонена');
    assert.equal(denied.json().reason, 'once_media_refused');
    assert.equal((await f.attachment(p.id)).state, 'pending');
    assert.equal((await t.db.select().from(schema.conversationMessages)).length, 0);
    assert.equal((await t.db.select().from(schema.userChanges)).length, 0);
    status(await f.send([{ id: p.id }], conversation), 201, 'обычное фото того же чата разрешено');
  });
});

async function albumScenario(mutation?: Mutation) {
  await withFixture(async f => {
    const first = await f.pending(), second = await f.pending();
    const denied = await f.send([{ id: first.id, once: true }, { id: second.id }]);
    status(denied, 400, 'R262:одноразовый-альбом-отклонён');
    assert.equal(denied.json().reason, 'once_media_refused');
    assert.equal((await f.attachment(first.id)).state, 'pending');
    assert.equal((await f.attachment(second.id)).state, 'pending');
    status(await f.send([{ id: first.id }, { id: second.id }]), 201, 'парный обычный альбом разрешён');
  }, mutation);
}
test('R262 альбом с одним одноразовым кадром отвергается, такой же обычный альбом проходит — иначе часть фото не сгорит', async () => albumScenario());

for (const contentType of ['image/jpeg', 'video/mp4']) test(`R262 ${contentType} один раз нельзя отложить, обычное можно — иначе таймер тихо пропадёт при отправке`, async () => {
  await withFixture(async f => {
    const p = await f.pending(contentType);
    const body = { clientId: randomUUID(), sendAt: new Date(Date.now() + 60_000).toISOString(), attachments: [{ id: p.id, once: true, onceTtl: 1 }] };
    const denied = await f.request('author', 'POST', '/conv/dm/scheduled', body);
    status(denied, 400, 'отложенное одноразовое отклонено');
    assert.equal(denied.json().reason, 'once_media_refused');
    assert.equal((await f.attachment(p.id)).state, 'pending');
    assert.equal((await t.db.select().from(schema.conversationScheduled)).length, 0);
    const accepted = await f.request('author', 'POST', '/conv/dm/scheduled', { ...body, attachments: [{ id: p.id }] });
    status(accepted, 201, 'обычное медиа можно отложить');
    assert.equal((await f.attachment(p.id)).state, 'scheduled');
  });
});

for (const ttl of [0, 1, 60, 61]) test(`R262 TTL=${ttl} ${ttl >= 1 && ttl <= 60 ? 'сохраняется' : 'отклоняется'} на реальной ручке — иначе ошибка границы таймера`, async () => {
  await withFixture(async f => {
    const p = await f.pending();
    const response = await f.send([{ id: p.id, once: true, onceTtl: ttl }]);
    if (ttl === 0 || ttl === 61) {
      status(response, 400, 'неверный TTL отклонён схемой');
      assert.equal((await f.attachment(p.id)).state, 'pending');
      assert.equal((await t.db.select().from(schema.conversationMessages)).length, 0);
    } else {
      status(response, 201, 'граница TTL включена');
      assert.equal((await f.row(response.json().id)).attachments[0].onceTtl, ttl);
      assert.equal(response.json().attachments[0].once, true);
    }
  });
});

test('R262 фото без таймера остаётся одноразовым, а таймер без once снимается — иначе обычное фото получает чужой срок', async () => {
  await withFixture(async f => {
    const once = await f.media('image/jpeg', { once: true });
    assert.equal(once.dto.attachments[0].once, true);
    assert.equal(Object.hasOwn(once.dto.attachments[0], 'onceTtl'), false);
    const ordinary = await f.media('image/jpeg', { onceTtl: 60 });
    assert.equal(Object.hasOwn(ordinary.dto.attachments[0], 'once'), false);
    assert.equal(Object.hasOwn(ordinary.dto.attachments[0], 'onceTtl'), false);
  });
});

test('R262 автор и посторонний не открывают кадр, повтор получателя возвращает первоначальный openedAt — иначе можно перезапускать срок', async () => {
  await withFixture(async f => {
    const p = await f.media(), path = `/conv/dm/messages/${p.mid}/once-open`;
    f.events.length = 0;
    status(await f.request('author', 'POST', path), 404, 'автор не запускает таймер');
    status(await f.request('outsider', 'POST', path), 404, 'посторонний не запускает таймер');
    assert.equal((await f.row(p.mid)).onceOpenedAt, null);
    const first = await f.request('recipient', 'POST', path); status(first, 200, 'получатель открывает');
    const openedAt = new Date(first.json().openedAt).getTime(); assert.ok(Number.isFinite(openedAt));
    const repeat = await f.request('recipient', 'POST', path); status(repeat, 200, 'повтор первого открытия разрешён');
    assert.equal(repeat.json().openedAt, first.json().openedAt, 'повтор возвращает тот же первый openedAt');
    // Сдвигаем запись назад: новый new Date() не сможет случайно совпасть в одну миллисекунду.
    const old = new Date(openedAt - 1000);
    await t.db.update(schema.conversationMessages).set({ onceOpenedAt: old }).where(orm.eq(schema.conversationMessages.id, p.mid));
    const again = await f.request('recipient', 'POST', path); status(again, 200, 'повтор открытия разрешён');
    assert.equal(again.json().openedAt, old.toISOString());
    assert.equal((await f.row(p.mid)).onceOpenedAt!.getTime(), old.getTime());
    assert.equal(f.events.length, 0, 'открытие не уведомляет автора');
  });
});

async function spendScenario(contentType: string, text: string, mutation?: Mutation) {
  await withFixture(async f => {
    const p = await f.media(contentType), path = `/conv/dm/messages/${p.mid}/once-spent`;
    f.events.length = 0;
    status(await f.request('author', 'POST', path), 404, 'автор не сжигает своё медиа');
    status(await f.request('recipient', 'POST', path), 204, 'R262:получатель-сжигает-фото-и-видео');
    await f.settled();
    const row = await f.row(p.mid);
    assert.equal(row.content, text); assert.ok(row.onceSpentAt); assert.deepEqual(row.attachments, []);
    assert.equal((await f.attachment(p.id)).state, 'deleted'); assert.ok((await f.attachment(p.id)).deletedAt);
    assert.equal(f.files.has(p.key), false); assert.deepEqual(f.purged, [p.key]);
    assert.deepEqual(f.purgeStates, [['deleted']], 'объект удалён только после фиксации строки deleted');
    const changes = f.events.filter(e => e.message.t === 'conv.change' && 'message' in e.message && e.message.message?.id === p.mid);
    assert.deepEqual(changes.map(e => e.user).sort(), ['author', 'recipient']);
    for (const event of changes) {
      const message = (event.message as { message: shared.ConvMessage }).message;
      assert.equal(message.content, text); assert.deepEqual(plain(message.attachments), []);
      assert.equal(message.voiceOnceSpent, true);
    }
    const count = (await t.db.select().from(schema.userChanges)).length, eventCount = f.events.length;
    status(await f.request('recipient', 'POST', path), 204, 'повтор сгорания идемпотентен');
    assert.equal((await t.db.select().from(schema.userChanges)).length, count); assert.equal(f.events.length, eventCount);
    assert.deepEqual(f.purged, [p.key]);
    status(await f.request('recipient', 'POST', `/conv/dm/messages/${p.mid}/once-open`), 410, 'сгоревший кадр нельзя открыть повторно');
  }, mutation);
}
for (const [contentType, text] of [['image/jpeg', 'Фото истекло'], ['video/mp4', 'Видео истекло']] as const)
  test(`R262 ${contentType} сгорает в «${text}», удаляет объект и не воскресает — иначе сохранится одноразовый файл`, async () => spendScenario(contentType, text));

for (const [contentType, hints, limit] of [
  ['image/jpeg', { once: true, onceTtl: 1 }, 16_000],
  ['image/jpeg', { once: true, onceTtl: 60 }, 75_000],
  ['video/mp4', { once: true, onceTtl: 1, durationMs: 40_000 }, 55_000],
  ['video/mp4', { once: true, onceTtl: 60, durationMs: 40_000 }, 75_000],
  ['image/jpeg', { once: true }, 300_000],
  ['video/mp4', { once: true, durationMs: 40_000 }, 340_000],
] as const) test(`R262 сторож ${contentType}, TTL=${'onceTtl' in hints ? hints.onceTtl : 'нет'}, срок=${limit} мс — иначе удаляется до конца просмотра или остаётся после него`, async () => {
  await withFixture(async f => {
    const p = await f.media(contentType, hints);
    // Часы явные; никаких sleep и настоящего таймера планировщика.
    const openedAt = new Date('2026-10-19T12:00:00.000Z');
    await t.db.update(schema.conversationMessages).set({ onceOpenedAt: openedAt }).where(orm.eq(schema.conversationMessages.id, p.mid));
    assert.equal(await f.c.sweepOpenedOnce(openedAt.getTime() + limit - 1), 0, 'за 1 мс до границы ещё живо');
    assert.equal((await f.attachment(p.id)).state, 'attached'); assert.equal(f.files.has(p.key), true);
    assert.equal(await f.c.sweepOpenedOnce(openedAt.getTime() + limit), 1, 'ровно срок уже истёк');
    await f.settled(); assert.ok((await f.row(p.mid)).onceSpentAt); assert.equal(f.files.has(p.key), false);
    assert.equal(await f.c.sweepOpenedOnce(openedAt.getTime() + limit + 1), 0, 'повторный такт не сжигает второй раз');
    assert.deepEqual(f.purged, [p.key]);
  });
});

test('R262 сторож не тратит неоткрытое одноразовое и открытое обычное — иначе фоновый таймер удаляет не просмотренные файлы', async () => {
  await withFixture(async f => {
    const unopened = await f.media(), ordinary = await f.media('image/jpeg', {});
    await t.db.update(schema.conversationMessages).set({ onceOpenedAt: new Date('2026-10-19T12:00:00Z') }).where(orm.eq(schema.conversationMessages.id, ordinary.mid));
    assert.equal(await f.c.sweepOpenedOnce(new Date('2026-10-20T12:00:00Z').getTime()), 0);
    assert.equal((await f.attachment(unopened.id)).state, 'attached'); assert.equal((await f.attachment(ordinary.id)).state, 'attached');
    assert.deepEqual(f.purged, []);
    status(await f.request('recipient', 'POST', `/conv/dm/messages/${ordinary.mid}/once-open`), 404, 'обычный кадр не открывается как одноразовый');
    status(await f.request('recipient', 'POST', `/conv/dm/messages/${ordinary.mid}/once-spent`), 404, 'обычный кадр не сгорает');
  });
});

async function closedScenario(mutation?: Mutation) {
  await withFixture(async f => {
    const p = await f.media();
    for (const method of ['GET', 'HEAD'] as const) {
      const denied = await f.request('recipient', method, link(p.id, 'recipient'));
      status(denied, 404, 'R262:файл-закрыт-до-открытия');
      assert.equal(denied.headers['cache-control'], 'no-store');
      const conditional = await f.request('recipient', method, link(p.id, 'recipient'), undefined, { 'if-none-match': `"${p.id}"` });
      status(conditional, 404, 'доступ проверен раньше ETag'); assert.equal(conditional.headers['cache-control'], 'no-store');
    }
    assert.equal(f.reads(), 0, 'закрытый кадр не читается из хранилища');
    const author = await f.request('author', 'GET', link(p.id, 'author')); status(author, 200, 'автор видит собственный кадр до открытия');
    assert.equal(author.body, 'once-fixture-bytes');
    const page = await f.request('recipient', 'GET', link(p.id, 'recipient'), undefined, { 'sec-fetch-dest': 'document' });
    status(page, 204, 'переход как документ не уводит окно приложения'); assert.equal(page.headers['cache-control'], 'no-store');
    status(await f.request('recipient', 'POST', `/conv/dm/messages/${p.mid}/once-open`), 200, 'получатель открыл');
    const beforeHead = f.reads(), head = await f.request('recipient', 'HEAD', link(p.id, 'recipient'));
    status(head, 200, 'HEAD разрешён после открытия'); assert.equal(f.reads(), beforeHead, 'HEAD не открывает поток');
    const opened = await f.request('recipient', 'GET', link(p.id, 'recipient')); status(opened, 200, 'файл разрешён после открытия');
    assert.equal(opened.body, 'once-fixture-bytes');
    status(await f.request('recipient', 'GET', link(p.id, 'recipient'), undefined, { 'if-none-match': `"${p.id}"` }), 304, 'открытый файл допускает условную проверку');
    status(await f.request('recipient', 'POST', `/conv/dm/messages/${p.mid}/once-spent`), 204, 'получатель закрыл');
    for (const method of ['GET', 'HEAD'] as const) for (const viewer of ['author', 'recipient']) {
      const gone = await f.request(viewer, method, link(p.id, viewer), undefined, { 'if-none-match': `"${p.id}"` });
      status(gone, 404, 'сгоревший файл закрыт обоим до ETag'); assert.equal(gone.headers['cache-control'], 'no-store');
    }
  }, mutation);
}
test('R262 настоящая выдача GET/HEAD и ETag закрыта до once-open, доступна автору, открывается получателю и закрывается после spent — иначе утечёт файл', async () => closedScenario());

test('R262 обычное фото получателю выдаётся без once-open — иначе новая защита ломает все картинки ЛС', async () => {
  await withFixture(async f => {
    const p = await f.media('image/jpeg', {});
    status(await f.request('recipient', 'GET', link(p.id, 'recipient')), 200, 'обычному фото открытие не нужно');
  });
});

type ThumbPlace = 'list' | 'reply' | 'pins';
async function thumbScenario(place: ThumbPlace, mutation?: Mutation) {
  await withFixture(async f => {
    // Сначала одноразовое, затем парное обычное: оба проходят одни и те же настоящие SQL и сериализацию.
    for (const once of [true, false]) {
      const p = await f.media('image/jpeg', once ? { once: true } : {});
      let view: { thumb?: string };
      if (place === 'list') {
        const list = await f.c.listConversations('recipient');
        const conversation = list.conversations.find(c => c.id === 'dm'); assert.ok(conversation?.lastMessage);
        view = conversation.lastMessage;
      } else if (place === 'reply') {
        const response = await f.request('recipient', 'POST', '/conv/dm/messages', { clientId: randomUUID(), content: 'ответ', replyToId: p.mid });
        status(response, 201, 'ответ на фото разрешён'); assert.ok(response.json().replyTo);
        view = response.json().replyTo;
      } else {
        await t.db.insert(schema.conversationPins).values({ conversationId: 'dm', userId: 'recipient', messageId: p.mid, pinnedBy: 'author' });
        const list = await f.c.listPins('recipient', 'dm'); assert.ok(list);
        const pin = list.pins.find(item => item.message.id === p.mid); assert.ok(pin); view = pin;
      }
      assert.equal(view.thumb, once ? undefined : link(p.id, 'recipient'), `R262:миниатюра-${place}-не-раскрывает-once`);
    }
  }, mutation);
}
for (const place of ['list', 'reply', 'pins'] as const) test(`R262 ${place} не отдаёт миниатюру одноразового фото, но отдаёт обычного — иначе кадр раскрывается раньше открытия`, async () => thumbScenario(place));

for (const contentType of ['image/jpeg', 'video/mp4']) test(`R262 сосед с dm2once без dm2ttl получает HTTP400 для ${contentType}, голосовое проходит — иначе сосед сохранит одноразовый кадр`, async () => {
  await withFixture(async f => {
    f.routes.configureFedFilesGuard(async () => true);
    const calls: { peer: string; media: boolean }[] = [];
    f.routes.configureFedOnceGuard(async (peer, media = false) => { calls.push({ peer, media }); return !media; });
    const p = await f.pending(contentType, 'remote-dm');
    const denied = await f.send([{ id: p.id, once: true }], 'remote-dm');
    status(denied, 400, 'без dm2ttl медиа не отправляется'); assert.equal(denied.json().error, shared.FED_ERRORS.dmAttachmentsLater);
    assert.equal(calls.some(c => c.peer === 'remote' && c.media), true, 'маршрут запросил media=true');
    assert.equal((await f.attachment(p.id)).state, 'pending');
    const voice = await f.pending('audio/ogg', 'remote-dm');
    status(await f.send([{ id: voice.id, once: true, waveform: [30, 50], durationMs: 1000 }], 'remote-dm'), 201, 'dm2once достаточно голосовому');
    f.routes.configureFedOnceGuard(async () => false);
    const noCapability = await f.send([{ id: p.id, once: true }], 'remote-dm');
    status(noCapability, 400, 'без обоих признаков медиа тоже отклоняется');
    assert.equal(noCapability.json().error, shared.FED_ERRORS.dmAttachmentsLater);
    const refusedVoice = await f.pending('audio/ogg', 'remote-dm');
    const noVoiceCapability = await f.send([{ id: refusedVoice.id, once: true, waveform: [30], durationMs: 1000 }], 'remote-dm');
    status(noVoiceCapability, 400, 'без dm2once голосовое тоже отклоняется');
    assert.equal(noVoiceCapability.json().error, shared.FED_ERRORS.dmAttachmentsLater);
    f.routes.configureFedOnceGuard(async () => true);
    status(await f.send([{ id: p.id, once: true }], 'remote-dm'), 201, 'с dm2ttl тот же кадр принимается');
  });
});

const mutations: readonly [string, Mutation, (mutation?: Mutation) => Promise<unknown>, string][] = [
  ['обход onceClosedFor', { module: 'routes/att', from: 'if (message && onceClosedFor(viewer, message)) return deny();', to: '' }, closedScenario, 'R262:файл-закрыт-до-открытия'],
  ['отсутствующее openedAt больше не закрывает файл', { module: 'routes/att', from: 'return !message.onceOpenedAt || !!message.onceSpentAt;', to: 'return false || !!message.onceSpentAt;' }, closedScenario, 'R262:файл-закрыт-до-открытия'],
  ['альбом больше не запрещён', { module: 'conversations', from: '(!onceOk || input.attachments.length > 1)', to: '(!onceOk)' }, albumScenario, 'R262:одноразовый-альбом-отклонён'],
  ['spend снова принимает только listenable', { module: 'conversations', from: 'if (!m.attachments.some(isOnceSpendable))', to: 'if (!m.attachments.some(isListenable))' }, mutation => spendScenario('image/jpeg', 'Фото истекло', mutation), 'R262:получатель-сжигает-фото-и-видео'],
  ['список раскрывает миниатюру', { module: 'conversations', from: "if (first && typeof first === 'object' && (first as { once?: unknown }).once === true) return null;", to: '' }, mutation => thumbScenario('list', mutation), 'R262:миниатюра-list-не-раскрывает-once'],
  ['цитата раскрывает миниатюру', { module: 'conversations', from: "fields.attachmentKind !== 'photo' || !first || first.once === true", to: "fields.attachmentKind !== 'photo' || !first" }, mutation => thumbScenario('reply', mutation), 'R262:миниатюра-reply-не-раскрывает-once'],
  ['закреп раскрывает миниатюру', { module: 'conversations', from: "kind?.attachmentKind === 'photo' && first && !first.fedState && first.once !== true", to: "kind?.attachmentKind === 'photo' && first && !first.fedState" }, mutation => thumbScenario('pins', mutation), 'R262:миниатюра-pins-не-раскрывает-once'],
];
for (const [label, mutation, scenario, marker] of mutations) test(`R262 контрфакт: ${label} ловится адресным утверждением, не ошибкой VM/SQL/HTTP500`, async () => {
  await scenario();
  await assert.rejects(scenario(mutation), failure(marker));
});
