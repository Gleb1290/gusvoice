import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import ts from 'typescript';
import { ZodError } from 'zod';
import { INSTANCE_FEATURES } from '../src/instanceFeatures.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
let app: ReturnType<typeof Fastify>;
let tokenFor: (id: string) => string;
let redis: typeof import('../src/realtime.js').redisPub;
const published: { channel: string; message: string }[] = [];
const headers = () => ({ authorization: `Bearer ${tokenFor('a')}` });
const request = (ids: unknown) => app.inject({ method: 'PUT', url: '/conv/pinned-order', headers: headers(), payload: { ids } });
const snapshot = () => t.raw.query<{ conversation_id: string; user_id: string; pinned_at: Date | null }>(`SELECT conversation_id,user_id,pinned_at FROM conversation_members ORDER BY conversation_id,user_id`);
const changes = () => t.raw.query<{ user_id: string; conversation_id: string; kind: string; message_id: string | null }>(
  `SELECT user_id,conversation_id,kind,message_id FROM user_changes ORDER BY pts`);

async function seed(): Promise<void> {
  await truncateAll(t.raw);
  published.length = 0;
  await t.raw.exec(`
    INSERT INTO users(id,username,display_name,password_hash) VALUES ('a','alpha','Alpha','hash'),('b','bravo','Bravo','hash'),('c','charlie','Charlie','hash');
    INSERT INTO conversations(id,kind,direct_key,created_by) VALUES
      ('one','group',NULL,'a'),('two','group',NULL,'a'),('three','group',NULL,'a'),('loose','group',NULL,'a'),('foreign','direct','b:c','b');
    INSERT INTO conversation_members(conversation_id,user_id,pinned_at) VALUES
      ('one','a','2026-01-03'),('two','a','2026-01-02'),('three','a','2026-01-01'),('loose','a',NULL),
      ('one','b','2025-01-01'),('two','b',NULL),('three','b',NULL),('loose','b',NULL),('foreign','b','2026-01-04'),('foreign','c',NULL);
  `);
}

before(async () => {
  t = await createTestDb();
  const auth = await import('../src/auth.js');
  tokenFor = id => auth.signToken({ sub: id, username: id, gen: 0 });
  ({ redisPub: redis } = await import('../src/realtime.js'));
  redis.publish = (async (channel: string, message: string) => { published.push({ channel, message }); return 1; }) as typeof redis.publish;
  redis.incr = (async () => 1) as typeof redis.incr;
  redis.expire = (async () => 1) as typeof redis.expire;
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _req: FastifyRequest, reply: FastifyReply) => error instanceof ZodError
    ? reply.code(400).send({ error: 'validation', details: error.issues }) : reply.send(error));
  await app.register((await import('../src/routes/conv.js')).convRoutes);
  await app.ready();
});
beforeEach(seed);
after(async () => { await app.close(); redis.disconnect(); await t.close(); });

test('чужая, незакреплённая и повторная беседы отвергаются с conv_pin_order без записи и событий', async () => {
  const before = (await snapshot()).rows;
  for (const ids of [['foreign'], ['loose'], ['two', 'two']]) {
    const response = await request(ids);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().reason, 'conv_pin_order');
    assert.deepEqual((await snapshot()).rows, before);
    assert.deepEqual((await changes()).rows, []);
    assert.deepEqual(published, []);
  }
});

test('не-массив ids даёт 400 валидации, корректный массив принимается', async () => {
  // Фактический контракт zod: неверная форма не доходит до семантического conv_pin_order.
  for (const bad of [null, 'two', {}, 1]) {
    const response = await request(bad);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'validation');
  }
  assert.deepEqual((await changes()).rows, []);
  assert.equal((await request(['two'])).statusCode, 200);
});

test('частичный порядок сохраняет неназванные, записывает миллисекунды и draft только владельцу', async () => {
  const peersBefore = (await snapshot()).rows.filter(row => row.user_id !== 'a');
  const response = await request(['three']);
  assert.equal(response.statusCode, 200);
  const pins = response.json().pins as { id: string; pinnedAt: string }[];
  assert.deepEqual(pins.map(pin => pin.id), ['three', 'one', 'two']);
  const times = pins.map(pin => Date.parse(pin.pinnedAt));
  assert.equal(times[0] - times[1], 1);
  assert.equal(times[1] - times[2], 1);
  const saved = await t.raw.query<{ conversation_id: string; pinned_at: Date }>(
    `SELECT conversation_id,pinned_at FROM conversation_members WHERE user_id='a' AND pinned_at IS NOT NULL ORDER BY pinned_at DESC`);
  assert.deepEqual(saved.rows.map(row => ({ id: row.conversation_id, pinnedAt: new Date(row.pinned_at).toISOString() })), pins);
  assert.deepEqual((await snapshot()).rows.filter(row => row.user_id !== 'a'), peersBefore);
  assert.deepEqual((await changes()).rows, ['three', 'one', 'two'].map(conversation_id => ({ user_id: 'a', conversation_id, kind: 'draft', message_id: null })));
  assert.ok(published.length > 0);
  assert.ok(published.every(event => event.channel === 'gw:user:a'), 'собеседнику перестановка не сообщается');
});

test('тот же порядок, префикс и пустой запрос не переписывают отметки, журнал и события', async () => {
  const before = (await snapshot()).rows;
  for (const ids of [['one', 'two', 'three'], ['one'], []]) {
    const response = await request(ids);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().pins.map((pin: { id: string }) => pin.id), ['one', 'two', 'three']);
    assert.deepEqual((await snapshot()).rows, before);
    assert.deepEqual((await changes()).rows, []);
    assert.deepEqual(published, []);
  }
  await t.raw.exec(`UPDATE conversation_members SET pinned_at=NULL WHERE user_id='a'`);
  const empty = await request([]);
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), { pins: [] });
});

test('новый закреп после перестановки выше прежнего блока, pinorder1 объявлен экземпляром', async () => {
  assert.ok(INSTANCE_FEATURES.includes('pinorder1'));
  assert.equal((await request(['three'])).statusCode, 200);
  const pinned = await app.inject({ method: 'PUT', url: '/conv/loose/pinned', headers: headers(), payload: { pinned: true } });
  assert.equal(pinned.statusCode, 200);
  const response = await request([]);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().pins.map((pin: { id: string }) => pin.id), ['loose', 'three', 'one', 'two']);
});

async function clockedModule(journalAll: boolean): Promise<typeof import('../src/conversations.js')> {
  const url = new URL('../src/conversations.ts', import.meta.url);
  let source = readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
  const clock = 'const base = new Date((nowRes.rows[0] as { t: string | Date }).t);';
  assert.ok(source.includes(clock), 'найдено время перестановки');
  // Фиксируем только часы: середина уже имеет нужную отметку, крайние переставляются.
  source = source.replace(clock, "const base = new Date('2026-10-09T12:00:00.000Z');");
  if (journalAll) {
    const anchor = 'for (const conversationId of changed)';
    assert.ok(source.includes(anchor), 'найден фильтр изменённых бесед');
    source = source.replace(anchor, 'for (const conversationId of plan.order)');
  }
  const parsed = ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true);
  const imports: Record<string, unknown> = {};
  for (const decl of parsed.statements) {
    if (!ts.isImportDeclaration(decl) || !ts.isStringLiteral(decl.moduleSpecifier) || decl.importClause?.isTypeOnly) continue;
    const spec = decl.moduleSpecifier.text;
    imports[spec] = await import(spec.startsWith('.') ? new URL(spec, url).href : spec);
  }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, Map, Set, Buffer, URL, Promise, console,
      require: (spec: string) => { assert.ok(spec in imports); return imports[spec]; }, fetch: globalThis.fetch });
  return module.exports as typeof import('../src/conversations.js');
}

test('неизменившаяся отметка не попадает в draft; мутант журнала по всем закрепам ловится на Postgres', async () => {
  const arrange = async () => {
    await seed();
    await t.raw.exec(`UPDATE conversation_members SET pinned_at='2026-10-09T11:59:59.999Z' WHERE conversation_id='two' AND user_id='a';
      UPDATE conversation_members SET pinned_at='2026-10-09T12:00:01.000Z' WHERE conversation_id='one' AND user_id='a'`);
  };
  const verify = async (mod: typeof import('../src/conversations.js')) => {
    await arrange();
    const result = await mod.reorderConversationPins('a', ['three', 'two', 'one']);
    assert.equal(result.kind, 'ok');
    assert.deepEqual((await changes()).rows, ['three', 'one'].map(conversation_id => ({ user_id: 'a', conversation_id, kind: 'draft', message_id: null })));
  };
  await verify(await clockedModule(false));
  await assert.rejects(() => verifyModuleMutant(), assert.AssertionError);
  async function verifyModuleMutant() { await verify(await clockedModule(true)); }
});
