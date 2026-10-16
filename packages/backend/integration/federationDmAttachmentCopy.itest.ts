import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { before, after, test } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as attRules from '../src/attachmentRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
type Row = typeof schema.attachments.$inferSelect;
type Att = typeof import('../src/federation/convAtt.js') & { __test: {
  copyOne(origin: string, row: Row): Promise<string>; copyBig(origin: string, row: Row): Promise<string>;
  copyLoop(origin: string): Promise<void>; markCopied(row: Row): Promise<boolean>;
  homeBackoff: Map<string, { until: number; step: number }>; fileBackoff: Map<string, { until: number; step: number }>;
} };
const peer = 'b'.repeat(32), self = 'a'.repeat(32), cid = 'copy-conv', aid = '10000000-0000-4000-8000-000000000001';
const otherAid = '10000000-0000-4000-8000-000000000002';
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t.close(); });
function moduleOf<T>(name: string, deps: Record<string, unknown>, mutation?: Mutation, expose = false): T {
  let raw = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation) { assert.equal(raw.split(mutation[0]).length - 1, 1, 'единственный якорь'); raw = raw.replace(...mutation); }
  // Только ссылки на функции/состояние целого модуля: ни копии алгоритмов, ни исполнения фрагментов исходника.
  if (expose) raw += '\nexport const __test = { copyOne, copyBig, copyLoop, markCopied, homeBackoff, fileBackoff };\n';
  const imports: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true).statements)
    if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly) {
      const id = (n.moduleSpecifier as ts.StringLiteral).text;
      imports[id] = new Proxy({}, { get: (_t, key) => key === '__esModule' ? true : () => { throw new Error(`запрещённая граница ${id}.${String(key)}`); } });
    }
  Object.assign(imports, deps); const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, console,
      require: (id: string) => { assert.equal(Object.hasOwn(imports, id), true, `явный импорт ${id}`); return imports[id]; } });
  return module.exports as T;
}
async function fixture(options: { mutation?: Mutation; size?: number; quota?: number } = {}) {
  await truncateAll(t.raw);
  await t.raw.query(`INSERT INTO users(id,username,display_name,password_hash,verified,approved_at,home_instance_id,home_user_id)
    VALUES ('local','dmtest_local','Местный','hash',true,now(),NULL,NULL),('shadow','dmtest_shadow','Удалённый','hash',true,now(),$1,'remote')`, [peer]);
  await t.raw.query(`INSERT INTO federation_links(instance_id,domain,api_base,client_origin,root_key,state,features,used_bytes,quota_bytes,local_name)
    VALUES ($1,'peer.invalid','https://peer.invalid/api','https://peer.invalid','fixture-root','active','["dm2"]',0,$2,'Дом файлов')`, [peer, options.quota ?? 0]);
  const deliveries: unknown[] = [], puts: Array<{ key: string; bytes: Buffer }> = [], removes: string[] = [];
  const parts: Array<{ n: number; size: number }> = [], requests: any[] = [];
  let aborted = 0, completed = 0, putError = false, completeError = false, tombstoneOnPut = false;
  let binary: any = { ok: true, value: { status: 200, bytes: Buffer.from('0123456789') } };
  let streamed: any = () => ({ ok: true, value: { status: 200, contentLength: 10, contentRange: null, body: Readable.from([Buffer.from('0123456789')]) } });
  const c = moduleOf<typeof import('../src/conversations.js')>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './convRules.js': rules, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './util.js': { uuidv7: randomUUID }, './env.js': { env: {} },
  });
  c.configureFederatedConv({ selfInstanceId: () => self, record: null });
  await c.createDirect('shadow', 'local', { id: cid, originInstanceId: peer });
  const size = options.size ?? 10;
  await t.db.insert(schema.conversationMessages).values({ id: 'copy-msg', conversationId: cid, authorId: 'shadow', sortKey: 1, content: 'Копия',
    attachments: [
      { id: aid, url: '', name: 'copy.bin', contentType: 'application/octet-stream', size, fedState: 'copying' },
      { id: otherAid, url: '', name: 'other.bin', contentType: 'application/octet-stream', size: 10, fedState: 'copying' },
    ] });
  await t.db.insert(schema.attachments).values({ id: aid, conversationId: cid, ownerId: 'shadow', messageId: 'copy-msg', storageKey: `dm/${aid}`, name: 'copy.bin', contentType: 'application/octet-stream', size, state: 'remote', originInstanceId: peer });
  const quota = moduleOf<typeof import('../src/federation/guestQuota.js')>('federation/guestQuota', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
  });
  const att = moduleOf<Att>('federation/convAtt', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../attachmentRules.js': attRules, '../convRules.js': rules,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema, '../conversations.js': { ...c, deliver: async (d: unknown) => { if (d) deliveries.push(d); } },
    '../safeFetch.js': { PEER_MAX_ATT_BYTES: 25 * 1024 * 1024 }, './guestQuota.js': quota,
    './instance.js': { federation: { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'fixture', privateKeyDer: Buffer.from([1]) }) } },
    './peerClient.js': { getSignedFromPeer: async (arg: any) => { requests.push(arg); return binary; } },
    './peerStream.js': { streamSignedFromPeer: async (arg: any) => { requests.push(arg); return streamed(); } },
    '../attachments.js': { attachmentStore: {
      ready: () => true,
      put: async (key: string, bytes: Buffer) => {
        if (putError) throw new Error('fixture-put-failed');
        puts.push({ key, bytes: Buffer.from(bytes) });
        if (tombstoneOnPut) {
          await t.raw.query("UPDATE attachments SET state='deleted' WHERE id=$1", [aid]);
          await t.raw.exec("UPDATE conversation_messages SET deleted_at=now() WHERE id='copy-msg'");
        }
      },
      remove: async (key: string) => { removes.push(key); },
      multipart: {
        create: async () => 'fixture-multipart',
        part: async (_key: string, _id: string, n: number, bytes: Buffer) => { parts.push({ n, size: bytes.length }); return `etag-${n}`; },
        complete: async () => { if (completeError) throw new Error('fixture-complete-failed'); completed++; },
        abort: async () => { aborted++; },
      },
    }, purgeDeleted: async () => {} },
  }, options.mutation, true);
  const row = async () => (await t.db.select().from(schema.attachments).where(orm.eq(schema.attachments.id, aid)))[0]!;
  const msg = async () => (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, 'copy-msg')))[0]!;
  const used = async () => Number((await t.db.select().from(schema.federationLinks))[0].usedBytes);
  return { att, row, msg, used, puts, removes, parts, requests, deliveries,
    binary: (value: any) => { binary = value; }, stream: (value: () => any) => { streamed = value; },
    failPut: () => { putError = true; }, failComplete: () => { completeError = true; }, tombstoneOnPut: () => { tombstoneOnPut = true; },
    aborted: () => aborted, completed: () => completed };
}
for (const length of [9, 10, 11]) test(`R194 малая копия ${length} байт при заявленных 10 ${length === 10 ? 'принимается' : 'остаётся remote'}`, async () => {
  // Класс ошибки достоверности размера: нельзя отмечать готовым обрезанный или подменённый объект.
  const f = await fixture(); const bytes = Buffer.alloc(length, 3);
  f.binary({ ok: true, value: { status: 200, bytes } });
  assert.equal(await f.att.__test.copyOne(peer, await f.row()), length === 10 ? 'done' : 'file-fail');
  assert.equal((await f.row()).state, length === 10 ? 'attached' : 'remote'); assert.equal(await f.used(), length === 10 ? 10 : 0);
  assert.equal(f.puts.length, length === 10 ? 1 : 0);
  assert.equal(f.requests[0].maxBytes, 10); assert.equal(f.requests[0].binary, true); assert.equal(f.requests[0].attachment, true);
  if (length === 10) {
    assert.equal(f.puts[0].bytes.equals(bytes), true); assert.equal('fedState' in (await f.msg()).attachments[0], false);
    assert.equal((await f.msg()).attachments[1].fedState, 'copying'); assert.equal(f.deliveries.length, 1);
  }
});
for (const status of [404, 500, null] as const) test(`R194 сбой ${status ?? 'сети'} ставит паузу ${status === 404 ? 'файлу, не дому' : 'дому, не файлу'} и возвращает резерв`, async () => {
  // Класс ошибки retry-scope: один исчезнувший файл не задерживает исправные файлы того же дома.
  const f = await fixture(); f.binary(status === null ? { ok: false } : { ok: true, value: { status, bytes: Buffer.alloc(0) } });
  await f.att.__test.copyLoop(peer);
  assert.equal((await f.row()).state, 'remote'); assert.equal(await f.used(), 0);
  assert.equal(f.att.__test.homeBackoff.has(peer), status !== 404); assert.equal(f.att.__test.fileBackoff.has(aid), status === 404);
});
test('R195 квота ровно на файл принимает копию, на байт меньше не пишет бакет и copying→remote сообщает только один раз', async () => {
  // Класс ошибки границы и идемпотентности: отказ квоты не оставляет вечную заглушку «копируется» и не спамит журнал.
  const pass = await fixture({ quota: 10 }); assert.equal(await pass.att.__test.copyOne(peer, await pass.row()), 'done'); assert.equal(await pass.used(), 10);
  const f = await fixture({ quota: 9 });
  assert.equal(await f.att.__test.copyOne(peer, await f.row()), 'quota');
  assert.equal(f.requests.length, 0); assert.equal(f.puts.length, 0); assert.equal((await f.row()).state, 'remote');
  assert.equal((await f.msg()).attachments[0].fedState, 'remote'); assert.equal((await f.msg()).attachments[1].fedState, 'copying');
  assert.equal(f.deliveries.length, 1); const n = (await t.db.select().from(schema.userChanges)).length;
  assert.equal(await f.att.__test.copyOne(peer, await f.row()), 'quota');
  assert.equal(f.deliveries.length, 1); assert.equal((await t.db.select().from(schema.userChanges)).length, n);
});
async function releaseOnFailure(mutation?: Mutation) {
  const f = await fixture({ mutation }); f.failPut();
  await assert.rejects(f.att.__test.copyOne(peer, await f.row()), /fixture-put-failed/);
  assert.equal(await f.used(), 0, 'ошибка записи возвращает резерв квоты'); assert.equal((await f.row()).state, 'remote');
}
test('R195 finally малой копии возвращает резерв после сбоя, удаление release обнаруживается used_bytes', async () => {
  // Класс ошибки утечки квоты: транспорт/бакет могут упасть после резервирования, но до attached.
  await releaseOnFailure();
  await assert.rejects(releaseOnFailure([
    "if (!kept) await releaseLinkQuota(origin, row.size).catch(() => {});\n  }\n}\n\n/** Файл ≤ 25 МБ",
    "// release удалён\n  }\n}\n\n/** Файл ≤ 25 МБ",
  ]), e => e instanceof assert.AssertionError && e.message.includes('ошибка записи возвращает'));
});
test('R195 надгробие между put и markCopied стирает объект и возвращает квоту, не выдаёт обновление готового файла', async () => {
  // Класс ошибки гонки: байты могут приехать после удаления сообщения, нельзя воскресить вложение.
  const f = await fixture(); f.tombstoneOnPut();
  assert.equal(await f.att.__test.copyOne(peer, await f.row()), 'gone');
  assert.equal((await f.row()).state, 'deleted'); assert.equal(f.removes.includes(`dm/${aid}`), true); assert.equal(await f.used(), 0);
  assert.equal(f.deliveries.length, 0);
});
async function chunkScenario(mutation?: Mutation) {
  const n = attRules.BIGFILE_PART_BYTES;
  const f = await fixture({ size: n + 1, mutation });
  f.stream(() => ({ ok: true, value: { status: 200, body: Readable.from([Buffer.alloc(n, 1), Buffer.alloc(1, 2)]) } }));
  assert.equal(await f.att.__test.copyBig(peer, await f.row()), 'done');
  assert.equal(f.parts.length, 2, 'ровно порог multipart отдаётся отдельным куском');
  assert.equal(f.parts[0].size, n); assert.equal(f.parts[1].size, 1); assert.equal(f.parts[0].size >= 5 * 1024 * 1024, true);
  assert.equal(f.completed(), 1); assert.equal(f.aborted(), 0); assert.equal(await f.used(), n + 1);
}
test('R195 точный порог multipart режется сейчас, мутант > вместо >= сливает последний байт в первый кусок', async () => {
  // Класс ошибки границы буферизации: ровно полный кусок не должен ждать ещё одного входящего байта.
  await chunkScenario();
  await assert.rejects(chunkScenario(['if (bufLen >= BIGFILE_PART_BYTES) await flush();', 'if (bufLen > BIGFILE_PART_BYTES) await flush();']),
    e => e instanceof assert.AssertionError && e.message.includes('ровно порог multipart'));
});
for (const incoming of [5 * 1024 * 1024 - 1, 5 * 1024 * 1024, 5 * 1024 * 1024 + 1]) test(`R195 входящий кусок ${incoming} байт сохраняет минимум S3 5 МиБ для всех не последних частей`, async () => {
  // Класс ошибки chunking: куски транспорта не равны частям S3, маленькие входящие надо накапливать.
  const n = attRules.BIGFILE_PART_BYTES, size = 2 * n + 1;
  const f = await fixture({ size });
  f.stream(() => ({ ok: true, value: { status: 200, body: Readable.from([Buffer.alloc(incoming), Buffer.alloc(n - incoming), Buffer.alloc(n), Buffer.alloc(1)]) } }));
  assert.equal(await f.att.__test.copyBig(peer, await f.row()), 'done');
  assert.equal(f.parts.length, 3); assert.equal(f.parts.slice(0, -1).every(p => p.size >= 5 * 1024 * 1024), true);
  assert.equal(f.parts.reduce((sum, p) => sum + p.size, 0), size); assert.equal(f.parts.at(-1)?.size, 1);
});
for (const failure of ['short', 'complete'] as const) test(`R195 большая копия при ${failure} отменяет multipart и возвращает резерв`, async () => {
  // Класс ошибки компенсации: незавершённая multipart-загрузка не занимает вечное место связки.
  const f = await fixture();
  if (failure === 'complete') f.failComplete();
  f.stream(() => ({ ok: true, value: { status: 200, body: Readable.from([Buffer.alloc(failure === 'short' ? 9 : 10)]) } }));
  assert.equal(await f.att.__test.copyBig(peer, await f.row()), failure === 'short' ? 'file-fail' : 'peer-down');
  assert.equal(f.aborted(), 1); assert.equal(await f.used(), 0); assert.equal((await f.row()).state, 'remote');
});
async function bigRelease(mutation?: Mutation) {
  const f = await fixture({ mutation }); f.failComplete();
  assert.equal(await f.att.__test.copyBig(peer, await f.row()), 'peer-down');
  assert.equal(await f.used(), 0, 'сбой multipart возвращает резерв квоты');
}
test('R195 finally multipart возвращает резерв, удаление release обнаруживается SQL-счётчиком', async () => {
  // Класс ошибки компенсации: отменённые части бакета не должны оставлять занятые байты связки.
  await bigRelease();
  await assert.rejects(bigRelease([
    "if (!kept) await releaseLinkQuota(origin, row.size).catch(() => {});\n  }\n}\n\n/** Копии, которые ждут",
    "// release удалён\n  }\n}\n\n/** Копии, которые ждут",
  ]), e => e instanceof assert.AssertionError && e.message.includes('сбой multipart возвращает'));
});
for (const bad of ['range-status', 'range-value', 'length'] as const) test(`R195 выдача remote отклоняет ${bad}, уничтожает тело и сохраняет имя дома`, async () => {
  // Класс ошибки достоверности ответа: чужие заголовки не разрешают отдавать не тот диапазон или размер.
  const f = await fixture(); const body = Readable.from([Buffer.from('123')]);
  const range = bad === 'length' ? null : { start: 0, end: 1 };
  f.stream(() => ({ ok: true, value: { status: bad === 'range-value' ? 206 : 200, contentRange: 'bytes 1-2/10', contentLength: 3, body } }));
  const res = await f.att.serveRemoteAttachment(await f.row(), range);
  assert.equal(res.kind, 'unavailable'); assert.equal(body.destroyed, true);
  assert.equal(res.kind === 'unavailable' && res.instance, 'Дом файлов');
});
for (const mode of ['full', 'range', 'gone', 'paused', 'no-dm2'] as const) test(`R195 выдача remote ${mode} соблюдает статус, диапазон и состояние связки`, async () => {
  // Класс ошибки доступности: готовый ответ принимается парно отказам, пауза не открывает транспорт.
  const f = await fixture();
  const range = mode === 'range' ? { start: 0, end: 1 } : null;
  const body = Readable.from([Buffer.from(range ? '01' : '0123456789')]);
  if (mode === 'paused') await t.raw.exec("UPDATE federation_links SET state='paused'");
  if (mode === 'no-dm2') await t.raw.exec("UPDATE federation_links SET features='[\"dm1\"]'");
  f.stream(() => ({ ok: true, value: { status: mode === 'gone' ? 404 : range ? 206 : 200, contentRange: range ? 'bytes 0-1/10' : null, contentLength: range ? 2 : 10, body } }));
  const res = await f.att.serveRemoteAttachment(await f.row(), range);
  assert.equal(res.kind, mode === 'gone' ? 'gone' : mode === 'paused' || mode === 'no-dm2' ? 'unavailable' : 'stream');
  if (res.kind === 'stream') { assert.equal(res.body === body, true); res.body.destroy(); }
  if (mode === 'gone') assert.equal(body.destroyed, true);
  if (mode === 'paused' || mode === 'no-dm2') { assert.equal(f.requests.length, 0); assert.equal(res.kind === 'unavailable' && res.instance, 'Дом файлов'); body.destroy(); }
  if (mode === 'range') { assert.equal(f.requests[0].range, 'bytes=0-1'); assert.equal(f.requests[0].maxBytes, 2); }
});

async function rangeLengthScenario(mutation?: Mutation) {
  for (const length of [1, 2, 3, null]) {
    const f = await fixture({ mutation });
    const body = Readable.from([Buffer.alloc(length ?? 2)]);
    f.stream(() => ({ ok: true, value: { status: 206, contentRange: 'bytes 0-1/10', contentLength: length, body } }));
    const res = await f.att.serveRemoteAttachment(await f.row(), { start: 0, end: 1 });
    const accepted = length === 2 || length === null;
    assert.equal(res.kind, accepted ? 'stream' : 'unavailable', 'длина Range должна совпадать с запрошенным куском');
    assert.equal(f.requests[0].maxBytes, 2, 'транспорт ограничивает размер самого диапазона');
    if (res.kind === 'stream') {
      assert.equal(res.body === body, true); assert.equal(body.destroyed, false); res.body.destroy();
    } else {
      assert.equal(body.destroyed, true, 'неверное тело уничтожено');
      assert.equal(res.kind === 'unavailable' && res.instance, 'Дом файлов');
    }
  }
}
test('R199 длина Range ровно2 проходит,1 и3 отвергаются; без заголовка применяется контракт Content-Range', () => {
  // Ловит R195 §4: правильный Content-Range раньше позволял отдавать короткое тело с объявленной другой длиной.
  return rangeLengthScenario();
});
test('R199 потеря сверки Content-Length диапазона обнаруживается на коротком206', async () => {
  // Исходный целый модуль первым; возвращаем именно прежний дефект, не поломку загрузчика.
  await rangeLengthScenario();
  await assert.rejects(() => rangeLengthScenario([
    '(v.contentLength === null || v.contentLength === range.end - range.start + 1)', 'true',
  ]), e => e instanceof assert.AssertionError && e.message.includes('длина Range должна совпадать'));
});
