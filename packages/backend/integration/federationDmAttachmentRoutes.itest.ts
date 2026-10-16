import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { before, beforeEach, after, test } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import { z } from 'zod';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as rules from '../src/attachmentRules.js';
import * as convRules from '../src/convRules.js';
import * as admission from '../src/routes/fedAdmission.js';
import * as schema from '../src/db/schema.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
const peer = 'a'.repeat(32), cid = randomUUID(), mid = randomUUID(), aid = randomUUID();
const bytes = Buffer.from('0123456789'), sig = 'x'.repeat(32);
before(async () => { t = await createTestDb(); });
beforeEach(async () => { await seed(); });
after(async () => { await t.close(); });
async function seed() {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['viewer', 'owner'].map(id => ({ id, username: `att_${id}`, displayName: id, passwordHash: 'fixture' })));
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: 'peer.invalid', apiBase: 'https://peer.invalid/api', clientOrigin: 'https://peer.invalid', rootKey: 'fixture', state: 'active' });
  await t.db.insert(schema.conversations).values({ id: cid, kind: 'direct', directKey: 'owner:viewer' });
  await t.db.insert(schema.conversationMembers).values(['viewer', 'owner'].map(userId => ({ conversationId: cid, userId })));
  await t.db.insert(schema.conversationMessages).values({ id: mid, conversationId: cid, authorId: 'owner', sortKey: 1, content: 'Файл' });
  await t.db.insert(schema.attachments).values({ id: aid, conversationId: cid, ownerId: 'owner', messageId: mid, storageKey: `dm/${aid}`, name: 'fixture.bin', contentType: 'application/octet-stream', size: bytes.length, state: 'remote', originInstanceId: peer });
}
const source = (name: string) => readFileSync(new URL(`../src/routes/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load<T>(name: string, deps: Record<string, unknown>, raw = source(name)): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Buffer, Error, Date,
      require: (id: string) => { if (!Object.hasOwn(deps, id)) throw new Error(`неописанный импорт ${id}`); return deps[id]; } });
  return module.exports as T;
}
function guard(name: string) { return () => { throw new Error(`запрещённый IO ${name}`); }; }
function fixture() {
  const gets: Array<{ start: number; end: number } | undefined> = [], rates: Array<[string, string]> = [], active: unknown[] = [];
  let configured = true, allowed = true, stat = true, signature = true;
  const store = {
    configured: () => configured,
    stat: async () => stat ? { size: bytes.length } : null,
    get: async (_key: string, range?: { start: number; end: number }) => { gets.push(range); return Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]); },
    ensureReady: guard('ensureReady'),
  };
  const dependencies = {
    '@gusvoice/shared': shared, '../attachmentRules.js': rules,
    '../attachments.js': { attachmentStore: store, attachmentSigValid: () => signature, attachmentLink: guard('attachmentLink'),
      createPending: guard('createPending'), DailyQuotaError: Error, privateAttachmentsReady: guard('privateAttachmentsReady') },
  };
  const fedDeps = { ...dependencies,
    '../federation/convAtt.js': { fedAttachmentForPeer: async (_peer: string, id: string) => allowed ? (await t.db.select().from(schema.attachments).where(orm.eq(schema.attachments.id, id)))[0] ?? null : null },
    '../federation/guardsRuntime.js': { fedRateBlock: async (kind: string, who: string) => { rates.push([kind, who]); return 0; } },
    // Проверяется переданное требование активности; криптография и permission SQL принадлежат отдельным тестам.
    '../federation/peerAuth.js': { authenticateLinkedPeer: async (_req: unknown, id: string, opts: { requireActive?: boolean }) => {
      active.push(opts.requireActive); return { ok: true, link: (await t.db.select().from(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, id)))[0] };
    } }, './fedAdmission.js': admission,
  };
  const att = load<typeof import('../src/routes/att.js')>('att', { ...dependencies, zod: { z }, 'drizzle-orm': orm,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema, '../convRules.js': convRules,
    '../authGuard.js': { rateHit: async () => 0, clientIp: () => 'fixture-ip', attachmentUploadBlock: guard('upload limit'), retryMessage: guard('retryMessage') },
    '../storage.js': { attachmentBlocked: guard('attachmentBlocked') },
  });
  return { att, fed: (raw?: string) => load<typeof import('../src/routes/fedAtt.js')>('fedAtt', fedDeps, raw), gets, rates, active,
    setConfigured: (value: boolean) => { configured = value; }, setAllowed: (value: boolean) => { allowed = value; },
    setStat: (value: boolean) => { stat = value; }, setSignature: (value: boolean) => { signature = value; } };
}
async function fedApp(f: ReturnType<typeof fixture>, raw?: string) {
  const app = Fastify(); try { await app.register(f.fed(raw).fedAttRoutes); await app.ready(); return app; } catch (e) { await app.close(); throw e; }
}
async function attApp(f: ReturnType<typeof fixture>) {
  const app = Fastify(); try { await app.register(f.att.attRoutes); await app.ready(); return app; } catch (e) { await app.close(); throw e; }
}
const fedUrl = (id: string = aid) => `/fed/v1/att/${id}?instance_id=${peer}`;
const url = `/att/${aid}/viewer/${sig}`;
for (const why of ['неверный id', 'закрытое хранилище', 'нет разрешения', 'нет объекта'] as const) test(`R194 выдача соседу: ${why} скрывается одинаковым 404`, async () => {
  // Класс ошибки: причина отказа раскрывает существование или внутреннее состояние файла.
  const f = fixture(); if (why === 'закрытое хранилище') f.setConfigured(false); if (why === 'нет разрешения') f.setAllowed(false); if (why === 'нет объекта') f.setStat(false);
  const app = await fedApp(f);
  try { const r = await app.inject(fedUrl(why === 'неверный id' ? '%40' : aid)); assert.equal(r.statusCode, 404); assert.equal(r.json().error, 'not found'); assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(f.gets.length, 0); }
  finally { await app.close(); }
});
test('R194 сосед получает весь файл 200 и точный Range 206, предел attachment вызывается по связке', async () => {
  // Класс ошибки: диапазон и длина расходятся с отправленными байтами.
  const f = fixture(), app = await fedApp(f);
  try {
    const all = await app.inject(fedUrl()); assert.equal(all.statusCode, 200); assert.equal(all.body, bytes.toString()); assert.equal(all.headers['content-length'], '10');
    const part = await app.inject({ url: fedUrl(), headers: { range: 'bytes=2-5' } });
    assert.equal(part.statusCode, 206); assert.equal(part.body, '2345'); assert.equal(part.headers['content-range'], 'bytes 2-5/10'); assert.equal(part.headers['content-length'], '4');
    assert.equal(part.headers['accept-ranges'], 'bytes'); assert.equal(part.headers['x-content-type-options'], 'nosniff');
    assert.equal(f.rates.filter(([kind, who]) => kind === 'attachment' && who === peer).length, 2);
    assert.equal(JSON.stringify(f.gets), '[null,{"start":2,"end":5}]');
  } finally { await app.close(); }
});
test('R194 Range ровно за последним байтом даёт 416 без открытия потока, последний байт доступен', async () => {
  // Класс ошибки: граница Range выпускает пустой или выходящий за файл поток.
  const f = fixture(), app = await fedApp(f);
  try {
    const denied = await app.inject({ url: fedUrl(), headers: { range: 'bytes=10-' } }); assert.equal(denied.statusCode, 416); assert.equal(denied.headers['content-range'], 'bytes */10'); assert.equal(f.gets.length, 0);
    const accepted = await app.inject({ url: fedUrl(), headers: { range: 'bytes=9-' } }); assert.equal(accepted.statusCode, 206); assert.equal(accepted.body, '9'); assert.equal(accepted.headers['content-length'], '1');
  } finally { await app.close(); }
});
async function activeContract(raw = source('fedAtt')) {
  const f = fixture(), app = await fedApp(f, raw);
  try { assert.equal((await app.inject(fedUrl())).statusCode, 200); assert.equal(f.active.length, 1); assert.equal(f.active[0], true, 'выдача требует активную связку'); }
  finally { await app.close(); }
}
test('R194 HTTP выдачи требует активную связку на границе настоящего допуска', async () => {
  // Класс ошибки: архивная связка продолжает получать файлы.
  await activeContract();
});
test('R194 requireActive=false отвергается адресным требованием параметра авторизации', async () => {
  // Класс ошибки: требование активности снято только у вложений.
  await activeContract(); const raw = source('fedAtt'), anchor = "'attachment', { requireActive: true }";
  assert.equal(raw.split(anchor).length - 1, 1, 'единственный якорь допуска');
  await assert.rejects(activeContract(raw.replace(anchor, "'attachment', { requireActive: false }")), (e: unknown) => e instanceof assert.AssertionError && e.message.includes('выдача требует активную связку'));
});
test('R194 remote без крючка возвращает pending 503 с Retry-After 5 и не читает локальное хранилище', async () => {
  // Класс ошибки: отсутствующая копия маскируется под 404 или читается как местный объект.
  const f = fixture(), app = await attApp(f);
  try { const r = await app.inject(url); assert.equal(r.statusCode, 503); assert.equal(r.json().error, 'federation.att_pending'); assert.equal(r.headers['retry-after'], '5'); assert.equal(f.gets.length, 0); }
  finally { await app.close(); }
});
test('R195 remote крючок получает Range, HTTP выдаёт наши заголовки и HEAD не вызывает крючок', async () => {
  // Класс ошибки: проксируемый поток теряет диапазон или HEAD скачивает файл впустую.
  const f = fixture(), calls: unknown[] = [];
  f.att.configureRemoteAttachments(async (att, range) => { calls.push({ id: att.id, range }); return { kind: 'stream', body: Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]) }; });
  const app = await attApp(f);
  try {
    const part = await app.inject({ url, headers: { range: 'bytes=2-5' } }); assert.equal(part.statusCode, 206); assert.equal(part.body, '2345'); assert.equal(part.headers['content-range'], 'bytes 2-5/10'); assert.equal(part.headers['content-length'], '4');
    assert.equal(JSON.stringify(calls), JSON.stringify([{ id: aid, range: { start: 2, end: 5 } }]));
    const all = await app.inject(url); assert.equal(all.statusCode, 200); assert.equal(all.body, bytes.toString()); assert.equal(all.headers['content-length'], '10');
    const head = await app.inject({ method: 'HEAD', url }); assert.equal(head.statusCode, 200); assert.equal(head.body, ''); assert.equal(head.headers['content-length'], '10'); assert.equal(calls.length, 2); assert.equal(f.gets.length, 0);
    const headRange = await app.inject({ method: 'HEAD', url, headers: { range: 'bytes=2-5' } });
    assert.equal(headRange.statusCode, 206); assert.equal(headRange.body, ''); assert.equal(headRange.headers['content-range'], 'bytes 2-5/10'); assert.equal(headRange.headers['content-length'], '4'); assert.equal(calls.length, 2);
  } finally { await app.close(); }
});
test('R195 непомещающийся Range remote не вызывает крючок', async () => {
  // Класс ошибки: невалидный Range становится запросом к соседу.
  const f = fixture(); let calls = 0; f.att.configureRemoteAttachments(async () => { calls++; throw new Error('крючок не должен вызываться'); });
  const app = await attApp(f);
  try { const r = await app.inject({ url, headers: { range: 'bytes=10-' } }); assert.equal(r.statusCode, 416); assert.equal(r.headers['content-range'], 'bytes */10'); assert.equal(calls, 0); }
  finally { await app.close(); }
});
for (const kind of ['gone', 'named', 'unnamed'] as const) test(`R195 remote ${kind} возвращает 404 или unavailable с именем только когда оно известно`, async () => {
  // Класс ошибки: недоступность автора превращается в потерю файла или имя undefined.
  const f = fixture(); f.att.configureRemoteAttachments(async () => kind === 'gone' ? { kind: 'gone' } : { kind: 'unavailable', instance: kind === 'named' ? 'Гусь' : null });
  const app = await attApp(f);
  try {
    const r = await app.inject(url); assert.equal(r.statusCode, kind === 'gone' ? 404 : 503);
    assert.equal(r.json().error, kind === 'gone' ? 'not found' : 'federation.att_unavailable');
    if (kind !== 'gone') { assert.equal(r.headers['retry-after'], '30'); assert.equal(r.json().instance, kind === 'named' ? 'Гусь' : undefined); }
    assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(f.gets.length, 0);
  } finally { await app.close(); }
});
test('R194 отказ доступа remote сохраняет старые 404 для медиа и 204 для перехода, не вызывает крючок', async () => {
  // Класс ошибки: сведения о доме файла выдаются смотрящему без доступа.
  const f = fixture(); let calls = 0; f.att.configureRemoteAttachments(async () => { calls++; return { kind: 'gone' }; });
  await t.db.delete(schema.conversationMembers).where(orm.eq(schema.conversationMembers.userId, 'viewer'));
  const app = await attApp(f);
  try { assert.equal((await app.inject(url)).statusCode, 404); assert.equal((await app.inject({ url, headers: { 'sec-fetch-dest': 'document' } })).statusCode, 204); assert.equal(calls, 0); }
  finally { await app.close(); }
});
