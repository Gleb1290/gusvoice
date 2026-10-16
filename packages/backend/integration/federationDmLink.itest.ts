import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import Fastify, { type InjectOptions } from 'fastify';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
const peer = 'b'.repeat(32), self = 'a'.repeat(32), remoteId = 'remote-conv', localId = 'local-conv';
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t.close(); });
function moduleOf<T>(name: string, deps: Record<string, unknown>, mutation?: Mutation): T {
  let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation) { assert.equal(source.split(mutation[0]).length - 1, 1, 'единственный якорь'); source = source.replace(...mutation); }
  const imports: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true).statements)
    if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly) {
      const id = (n.moduleSpecifier as ts.StringLiteral).text;
      imports[id] = new Proxy({}, { get: (_t, key) => key === '__esModule' ? true : () => { throw new Error(`запрещённая граница ${id}.${String(key)}`); } });
    }
  Object.assign(imports, deps);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, console,
      require: (id: string) => { assert.equal(Object.hasOwn(imports, id), true, `явный импорт ${id}`); return imports[id]; } });
  return module.exports as T;
}
async function fixture(options: { linkMutation?: Mutation; routeMutation?: Mutation } = {}) {
  await truncateAll(t.raw);
  await t.raw.query(`INSERT INTO users(id,username,display_name,password_hash,verified,approved_at,home_instance_id,home_user_id,home_username)
    VALUES ('local','dmtest_local','Локальный','hash',true,now(),NULL,NULL,NULL),
      ('other','dmtest_other','Другой','hash',true,now(),NULL,NULL,NULL),
      ('shadow','dmtest_shadow','Удалённый','hash',true,now(),$1,'remote','dmtest_remote')`, [peer]);
  await t.raw.query(`INSERT INTO federation_links(instance_id,domain,api_base,client_origin,root_key,state,features)
    VALUES ($1,'peer.invalid','https://peer.invalid/api','https://peer.invalid','fixture-root','active','["dm1"]')`, [peer]);
  const serialize = moduleOf<typeof import('../src/serialize.js')>('serialize', {
    '@gusvoice/shared': shared, './env.js': { env: {} }, './linkThreats.js': { dangerousLinksOf: () => [] },
    './federation/instanceLabels.js': { instanceLabel: (id: string) => ({ instanceId: id, name: 'Сосед', domain: 'peer.invalid', reports: false }) },
  });
  const c = moduleOf<typeof import('../src/conversations.js')>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './convRules.js': rules,
    './db/index.js': { db: t.db }, './db/schema.js': schema, './util.js': { uuidv7: randomUUID }, './env.js': { env: {} }, './serialize.js': serialize,
    './dmWriteBarrier.js': { dmWriteBarrier: {} },
    './attachments.js': { purgeDeleted: async () => {}, discardForwardCopies: async () => {} },
  });
  c.configureFederatedConv({ selfInstanceId: () => self, record: null });
  await c.createDirect('local', 'shadow', { id: remoteId, originInstanceId: self });
  await c.createDirect('local', 'other', { id: localId, originInstanceId: self });
  await t.raw.query(`INSERT INTO conversation_messages(id,conversation_id,author_id,sort_key,content)
    VALUES ('remote-msg',$1,'local',1,'Удалённая беседа'),('local-msg',$2,'local',1,'Местная беседа')`, [remoteId, localId]);
  await t.raw.exec('UPDATE conversations SET last_sort_key=1,last_message_at=now()');
  const deliveries: unknown[] = [];
  const deliver = async (d: unknown) => { if (d) deliveries.push(d); };
  let emergency = false;
  const link = moduleOf<typeof import('../src/federation/convLink.js')>('federation/convLink', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../conversations.js': { ...c, deliver }, './instanceMeta.js': { readInstanceMeta: async () => ({ paused: emergency }) },
  }, options.linkMutation);
  const blocks = moduleOf<typeof import('../src/blocks.js')>('blocks', { 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema });
  const scheduled = moduleOf<typeof import('../src/scheduled.js')>('scheduled', {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema, './conversations.js': { ...c, deliver },
    './scheduleRules.js': await import('../src/scheduleRules.js'), './convRules.js': rules,
    './blockRules.js': await import('../src/blockRules.js'), './util.js': { uuidv7: randomUUID },
  });
  const att = moduleOf<typeof import('../src/routes/att.js')>('routes/att', { zod: await import('zod'), '@gusvoice/shared': shared });
  let uploads = 0;
  const readPushes: unknown[][] = [];
  const route = moduleOf<typeof import('../src/routes/conv.js')>('routes/conv', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: await import('zod'), '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../auth.js': { requireAuth: async (req: any) => { req.user = { sub: 'local' }; }, isSuperAdmin: () => false },
    '../guestGuard.js': { requireLocalUser: async () => {} },
    '../authGuard.js': { rateHit: async () => 0, messageSendBlock: async () => 0, pushDebounced: async () => true },
    '../conversations.js': { ...c, deliver, deliverMany: async () => {} }, '../convRules.js': rules,
    '../blocks.js': blocks, '../blockRules.js': await import('../src/blockRules.js'), '../dmRules.js': await import('../src/dmRules.js'),
    '../scheduled.js': scheduled, '../scheduleRules.js': await import('../src/scheduleRules.js'),
    '../superAdminRules.js': { asUserId: (id: string) => id },
    './att.js': { ...att, acceptDmUpload: async (_req: unknown, reply: any) => { uploads++; return reply.code(201).send({ id: 'fixture-upload' }); } },
    '../convSendFanout.js': { fanOutSend: async () => {} },
    '../push.js': { ...await import('../src/pushRules.js'), sendPushToUsers: async () => {},
      sendReadSyncPush: async (...args: unknown[]) => { readPushes.push(args); } },
  }, options.routeMutation);
  route.configureFedLinkGuard(link.fedLinkBrokenFor);
  const app = Fastify(); await app.register(route.convRoutes); await app.ready();
  async function list() {
    // Контракт hook проверяется отдельно от соединений: actual brokenHomes SQL ДО snapshot GET /conv.
    // Разделение осталось от R191; исправленную в R193 сквозную передачу q этот адаптер пока не проверяет.
    const broken = await link.brokenHomes([peer]);
    c.configureFederatedConv({ selfInstanceId: () => self, record: null, linkBroken: async () => broken });
    const res = await app.inject({ method: 'GET', url: '/conv' }); assert.equal(res.statusCode, 200);
    return res.json().conversations as Array<{ id: string; fedLink?: string }>;
  }
  const state = async (value: string) => { await t.raw.query('UPDATE federation_links SET state=$1 WHERE instance_id=$2', [value, peer]); };
  const close = async () => { await link.refreshFedLinks(); await app.close(); };
  return { app, c, link, list, state, close, emergency: (value: boolean) => { emergency = value; }, deliveries, readPushes, uploads: () => uploads };
}
const paths = ['send', 'reaction', 'delete-both', 'pin-both', 'clear-both', 'upload', 'forward', 'scheduled'] as const;
type Path = typeof paths[number];
function request(path: Path, remote = true): InjectOptions {
  const id = remote ? remoteId : localId, mid = remote ? 'remote-msg' : 'local-msg';
  const base = `/conv/${id}`;
  switch (path) {
    case 'send': return { method: 'POST', url: `${base}/messages`, payload: { clientId: randomUUID(), content: 'Новый текст' } };
    case 'reaction': return { method: 'POST', url: `${base}/messages/${mid}/reactions`, payload: { emoji: '👍', op: 'add' } };
    case 'delete-both': return { method: 'DELETE', url: `${base}/messages/${mid}?for=both` };
    case 'pin-both': return { method: 'PUT', url: `${base}/messages/${mid}/pin`, payload: { for: 'both' } };
    case 'clear-both': return { method: 'POST', url: `${base}/clear`, payload: { for: 'both' } };
    case 'upload': return { method: 'POST', url: `${base}/attachments` };
    case 'forward': return { method: 'POST', url: `${base}/forward`, payload: { clientId: randomUUID(), fromConversationId: localId, messageIds: ['local-msg'] } };
    case 'scheduled': return { method: 'POST', url: `${base}/scheduled`, payload: { clientId: randomUUID(), content: 'Позже', sendAt: new Date(Date.now() + 3600000).toISOString() } };
  }
}
const accepted: Record<Path, number> = { send: 201, reaction: 204, 'delete-both': 204, 'pin-both': 200, 'clear-both': 204, upload: 201, forward: 201, scheduled: 201 };
for (const path of paths) test(`R191 разрыв отклоняет ${path}, та же операция местной пары остаётся разрешённой`, async () => {
  // Класс ошибки feature-gate: пауза соседа закрывает запись удалённой пары, но не местные операции.
  const f = await fixture();
  try {
    await f.state('paused');
    const denied = await f.app.inject(request(path));
    assert.equal(denied.statusCode, 403, `разрыв запрещает ${path}`); assert.equal(denied.json().error, shared.FED_ERRORS.dmLinkBroken);
    await f.state('active');
    const restored = await f.app.inject(request(path));
    assert.equal(restored.statusCode, path === 'upload' ? 400 : accepted[path], `активная удалённая ${path} работает`);
    if (path === 'upload') assert.equal(restored.json().error, shared.FED_ERRORS.dmAttachmentsLater);
    await f.state('paused');
    const pass = await f.app.inject(request(path, false));
    assert.equal(pass.statusCode, accepted[path], `местная ${path} работает`);
    if (path === 'send') assert.deepEqual(f.readPushes, [['local', remoteId, restored.json().sortKey], ['local', localId, pass.json().sortKey]]);
    if (path === 'upload') assert.equal(f.uploads(), 1);
  } finally { await f.close(); }
});
test('R191 GET conv показывает broken при paused, active убирает поле и настоящая отправка создаёт сообщение', async () => {
  // Класс ошибки согласованности UI/API: снятая пауза должна снять режим архива, не только разрешить кнопку.
  const f = await fixture();
  try {
    await f.state('paused'); const paused = await f.list();
    assert.equal(paused.find(c => c.id === remoteId)?.fedLink, 'broken'); assert.equal(Object.hasOwn(paused.find(c => c.id === localId)!, 'fedLink'), false);
    await f.state('active'); const active = await f.list();
    assert.equal(Object.hasOwn(active.find(c => c.id === remoteId)!, 'fedLink'), false);
    const sent = await f.app.inject(request('send')); assert.equal(sent.statusCode, 201);
    assert.equal(sent.json().content, 'Новый текст');
    assert.equal((await t.db.select().from(schema.conversationMessages)).some(m => m.conversationId === remoteId && m.content === 'Новый текст'), true);
  } finally { await f.close(); }
});
test('R191 удалить только у меня можно при разрыве, копия собеседника и надгробие не меняются', async () => {
  // Класс ошибки области запрета: локальное скрытие не требует работающей связки.
  const f = await fixture();
  try {
    await f.state('paused');
    const res = await f.app.inject({ method: 'DELETE', url: `/conv/${remoteId}/messages/remote-msg?for=me` });
    assert.equal(res.statusCode, 204);
    const row = (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, 'remote-msg')))[0];
    assert.equal(row.hiddenFor.includes('local'), true); assert.equal(row.hiddenFor.includes('shadow'), false); assert.equal(row.deletedAt, null);
  } finally { await f.close(); }
});
test('R191 явный отказ paused ставит broken, успешный ответ снимает отказ и не меняет активную строку связки', async () => {
  // Класс ошибки состояния: отказ соседа и состояние нашей связки — независимые причины режима чтения.
  const f = await fixture();
  try {
    f.link.notePeerAnswer(peer, 403, JSON.stringify({ error: shared.FED_ERRORS.paused })); await f.link.refreshFedLinks();
    assert.equal((await f.list()).find(c => c.id === remoteId)?.fedLink, 'broken');
    f.link.notePeerAnswer(peer, 200, '{}'); await f.link.refreshFedLinks();
    assert.equal(Object.hasOwn((await f.list()).find(c => c.id === remoteId)!, 'fedLink'), false);
    assert.equal((await t.db.select().from(schema.federationLinks))[0].state, 'active');
  } finally { await f.close(); }
});
for (const status of [null, 400, 403, 404, 500, 503] as const) test(`R191 ${status ?? 'сеть без ответа'} без явного отказа не объявляет связку разорванной`, async () => {
  // Класс ошибки классификации сети: обычная HTTP-ошибка не является решением держателя о паузе.
  const f = await fixture();
  try {
    f.link.notePeerAnswer(peer, status, status === 503 ? JSON.stringify({ error: shared.FED_ERRORS.paused }) : JSON.stringify({ error: 'ordinary-error' }));
    await f.link.refreshFedLinks();
    assert.equal((await f.link.brokenHomes([peer])).has(peer), false, 'обычный сбой не ломает связку');
    assert.equal(Object.hasOwn((await f.list()).find(c => c.id === remoteId)!, 'fedLink'), false);
  } finally { await f.close(); }
});
async function ordinaryError(mutation?: Mutation) {
  const f = await fixture({ linkMutation: mutation });
  try {
    for (const status of [403, 503]) {
      f.link.notePeerAnswer(peer, status, '{"error":"ordinary-error"}'); await f.link.refreshFedLinks();
      assert.equal((await f.link.brokenHomes([peer])).has(peer), false, 'обычный сбой не ломает связку');
    }
  } finally { await f.close(); }
}
test('R191 считать любые 4xx и 5xx отказом обнаруживается настоящим решением brokenHomes', async () => {
  // Класс ошибки классификации: временная недоступность превращается в постоянный запрет переписки.
  await ordinaryError();
  await assert.rejects(ordinaryError([
    "if (status === null || status < 400 || status >= 500 || !body) return;",
    "if (status === null || status < 400) return; refusedBy.set(instanceId, 'any-http-error'); return;",
  ]), e => e instanceof assert.AssertionError && e.message.includes('обычный сбой не ломает связку'));
});
async function emergencyPause(mutation?: Mutation) {
  const f = await fixture({ linkMutation: mutation });
  try {
    assert.equal((await f.link.brokenHomes([peer])).has(peer), false);
    f.emergency(true);
    assert.equal((await f.link.brokenHomes([peer])).has(peer), true, 'аварийная пауза ломает удалённую связку');
    assert.equal(await f.link.fedLinkBrokenFor('other'), false);
    assert.equal((await f.list()).find(c => c.id === remoteId)?.fedLink, 'broken');
    assert.equal((await f.app.inject(request('send'))).statusCode, 403);
    f.emergency(false); assert.equal((await f.link.brokenHomes([peer])).has(peer), false);
  } finally { await f.close(); }
}
test('R191 аварийная пауза закрывает удалённую пару, удаление её проверки обнаруживается SQL-решением', async () => {
  // Класс ошибки аварийного выключателя: active связка не отменяет общую паузу федерации.
  await emergencyPause();
  await assert.rejects(emergencyPause(['if ((await readInstanceMeta(q)).paused) return new Set(uniq);', '// аварийная пауза проигнорирована']),
    e => e instanceof assert.AssertionError && e.message.includes('аварийная пауза ломает'));
});
async function uploadGuard(mutation?: Mutation) {
  const f = await fixture({ routeMutation: mutation });
  try {
    await f.state('paused'); const res = await f.app.inject(request('upload'));
    assert.equal(res.statusCode, 403, 'guard загрузки возвращает запрет разрыва');
    assert.equal(res.json().error, shared.FED_ERRORS.dmLinkBroken); assert.equal(f.uploads(), 0);
  } finally { await f.close(); }
}
test('R191 пропуск route guard загрузки обнаруживается отличием 400 от обязательного 403', async () => {
  // Класс ошибки порядка guard: ограничение вложений не заменяет запрет сломанной связки.
  await uploadGuard();
  await assert.rejects(uploadGuard([
    "if (await fedLinkRefused(reply, access)) return;\n    if (await fedFilesRefused(reply, access.peerId)) return;\n    return acceptDmUpload",
    "if (await fedFilesRefused(reply, access.peerId)) return;\n    return acceptDmUpload",
  ]), e => e instanceof assert.AssertionError && e.message.includes('guard загрузки возвращает'));
});
