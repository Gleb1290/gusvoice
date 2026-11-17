import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { Permission } from '@gusvoice/shared';
import ts from 'typescript';
import { ZodError } from 'zod';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
let app: ReturnType<typeof Fastify>;
let auth: typeof import('../src/auth.js');
let redis: typeof import('../src/realtime.js').redisPub;
const objects = new Map<string, Buffer>();
const storage = {
  storageConfigured: () => true,
  resolveAudioMime: () => 'audio/mpeg',
  async putSound(serverId: string, slot: string, buffer: Buffer) {
    const url = `https://objects.invalid/sounds/${serverId}-${slot}.mp3`;
    objects.set(url, buffer);
    return url;
  },
  async removeSoundboardObject(_serverId: string, _clipId: string, url: string) {
    objects.delete(url);
  },
};

// Реальны запрос, транзакции и права. Подменяем объектное хранилище и публикацию Redis.
async function loadSoundboardRoutes() {
  const url = new URL('../src/routes/soundboard.ts', import.meta.url);
  const source = await readFile(url, 'utf8');
  const tree = ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true);
  const imports: Record<string, unknown> = {};
  for (const node of tree.statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const id = node.moduleSpecifier.text;
    imports[id] = id === '../storage.js' ? storage : await import(id.startsWith('.') ? new URL(id, url).href : id);
  }
  const module = { exports: {} as typeof import('../src/routes/soundboard.js') };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, Buffer, URL, setTimeout, clearTimeout, console,
    require(id: string) { assert.ok(Object.hasOwn(imports, id)); return imports[id]; },
  });
  return module.exports.soundboardRoutes;
}

const headers = (sub: string) => ({ authorization: `Bearer ${auth.signToken({ sub, username: sub, gen: 0 })}` });
const path = (server = 'alpha') => `/servers/${server}/soundboard`;
const policy = (mode: 'off' | 'all' | 'selected', legacyLimit = 24, serverIds: string[] = [], user = 'holder') =>
  app.inject({ method: 'PUT', url: '/admin/soundboard', headers: headers(user), payload: { mode, legacyLimit, serverIds } });
const list = (user = 'editor', server?: string) => app.inject({ method: 'GET', url: path(server), headers: headers(user) });
const quota = (limit: number, user = 'owner') =>
  app.inject({ method: 'PUT', url: `${path()}/quota`, headers: headers(user), payload: { limit } });
const report = (user = 'holder') => app.inject({ method: 'GET', url: '/admin/soundboard', headers: headers(user) });

function upload(user = 'editor', server?: string) {
  const boundary = 'test-soundboard-upload';
  return app.inject({
    method: 'POST', url: path(server), headers: { ...headers(user), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from([
      `--${boundary}`, 'Content-Disposition: form-data; name="name"', '', 'Sound',
      `--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="sample.mp3"',
      'Content-Type: audio/mpeg', '', 'ID3sample', `--${boundary}--`, '',
    ].join('\r\n')),
  });
}

before(async () => {
  t = await createTestDb();
  auth = await import('../src/auth.js');
  auth.setSuperAdminId('holder');
  redis = (await import('../src/realtime.js')).redisPub;
  redis.disconnect();
  redis.publish = (async () => 1) as typeof redis.publish;
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _req: FastifyRequest, reply: FastifyReply) =>
    error instanceof ZodError ? reply.code(400).send({ error: 'validation' }) : reply.send(error));
  await app.register(multipart, { limits: { files: 1 } });
  await app.register(await loadSoundboardRoutes());
  await app.register((await import('../src/routes/adminSoundboard.js')).adminSoundboardRoutes);
  await app.ready();
});

beforeEach(async () => {
  await truncateAll(t.raw);
  objects.clear();
  await t.raw.exec(`
    INSERT INTO users(id,username,display_name,password_hash,verified) VALUES
      ('holder','holder','Holder','hash',true), ('owner','owner','Owner','hash',true),
      ('editor','editor','Editor','hash',true), ('member','member','Member','hash',true);
    INSERT INTO servers(id,name,owner_id) VALUES ('alpha','Alpha','owner'), ('beta','Beta','owner');
    INSERT INTO server_members(server_id,user_id) VALUES
      ('alpha','owner'), ('alpha','editor'), ('alpha','member'), ('beta','owner'), ('beta','editor');
    INSERT INTO instance_settings(key,value) VALUES ('soundboard','{"mode":"off","serverIds":[],"legacyLimit":24}');
    INSERT INTO roles(id,server_id,name,permissions,is_everyone) VALUES
      ('everyone','alpha','@everyone','0',true), ('edit1','alpha','Editor','${Permission.MANAGE_SOUNDBOARD}',false),
      ('edit2','alpha','Editor 2','${Permission.MANAGE_SOUNDBOARD}',false);
    INSERT INTO member_roles(server_id,user_id,role_id) VALUES ('alpha','editor','edit1'), ('alpha','editor','edit2');
  `);
});

after(async () => {
  await app?.close();
  redis?.disconnect();
  auth?.setSuperAdminId(null);
  await t?.close();
});

test('новая модель выключена до настройки, старый лимит применяется к каждому серверу', async () => {
  const config = await report();
  assert.equal(config.statusCode, 200, config.body);
  assert.equal(config.json().mode, 'off');
  assert.equal(config.json().legacyLimit, 24);
  assert.equal((await list()).json().max, 24);
  assert.equal((await policy('off', 1)).statusCode, 200);
  assert.equal((await list('owner', 'beta')).json().max, 1);
  assert.equal((await upload()).statusCode, 200);
  assert.ok((await upload('owner')).statusCode >= 400);
  assert.equal(objects.size, 1);
});

test('только держатель инстанса меняет охват, админ сервера настраивает личную квоту', async () => {
  assert.equal((await report('owner')).statusCode, 403);
  assert.equal((await policy('all', 24, [], 'owner')).statusCode, 403);
  assert.equal((await policy('selected', 24, ['alpha'])).statusCode, 200);
  assert.equal((await list()).json().quota.mode, 'per-user');
  assert.equal((await list('owner', 'beta')).json().quota.mode, 'legacy');
  assert.equal((await quota(1, 'editor')).statusCode, 403);
  assert.equal((await quota(1)).statusCode, 200);
  const alpha = (await report()).json().servers.find((s: { id: string }) => s.id === 'alpha');
  assert.equal(alpha.eligibleEditors, 3, 'владелец, редактор с двумя ролями и держатель инстанса');
  assert.equal(alpha.projectedClipCount, 3);
  assert.equal((await policy('all')).statusCode, 200);
  assert.equal((await list('owner', 'beta')).json().quota.mode, 'per-user');
});

test('параллельные загрузки занимают одно последнее личное место, а другой редактор загружает своё', async () => {
  await policy('all', 1);
  await quota(1);
  const results = await Promise.all([upload(), upload()]);
  assert.equal(results.filter(r => r.statusCode === 200).length, 1, results.map(r => r.body).join(' '));
  assert.equal(objects.size, 1);
  assert.equal((await upload('owner')).statusCode, 200, 'старый общий лимит здесь не действует');
  assert.equal((await upload('member')).statusCode, 403);
  const saved = (await list()).json();
  assert.equal(saved.clips.length, 2);
  assert.equal(saved.quota.used, 1);
  assert.equal((await policy('off', 1)).statusCode, 200);
  assert.equal((await list()).json().clips.length, 2);
  assert.ok((await upload('holder')).statusCode >= 400);
  assert.equal(objects.size, 2);
});
