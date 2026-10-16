import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import Fastify, { type InjectOptions } from 'fastify';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as gifRules from '../src/gifRules.js';
import * as attachmentRules from '../src/attachmentRules.js';
import { createTestDb, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
let t: TestDb;
const peer = 'b'.repeat(32), self = 'a'.repeat(32), attId = randomUUID(), gifId = randomUUID();
before(async () => {
  t = await createTestDb();
  await t.db.insert(schema.users).values([
    { id: 'me', username: 'gate_me', displayName: 'Автор', passwordHash: 'fixture' },
    { id: 'local', username: 'gate_local', displayName: 'Местный', passwordHash: 'fixture' },
    { id: 'shadow', username: 'gate_shadow', displayName: 'Сосед', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'remote' },
  ]);
  await t.db.insert(schema.conversations).values([
    { id: 'remote', kind: 'direct', directKey: `${self}:me|${peer}:remote`, createdBy: 'me' },
    { id: 'local', kind: 'direct', directKey: 'local:me', createdBy: 'me' },
    { id: 'source', kind: 'direct', directKey: 'me:me', createdBy: 'me' },
    { id: 'group', kind: 'group', directKey: null, createdBy: 'me' },
  ]);
  await t.db.insert(schema.conversationMembers).values([
    { conversationId: 'remote', userId: 'me' }, { conversationId: 'remote', userId: 'shadow' },
    { conversationId: 'local', userId: 'me' }, { conversationId: 'local', userId: 'local' },
    { conversationId: 'source', userId: 'me' }, { conversationId: 'group', userId: 'me' },
    { conversationId: 'group', userId: 'shadow' },
  ]);
  await t.db.insert(schema.conversationMessages).values({ id: 'file-source', conversationId: 'source', authorId: 'me', sortKey: 1,
    content: 'Файл', attachments: [{ id: attId, name: 'sample.txt', contentType: 'text/plain', size: 1, url: '/fixture' }] });
});
after(async () => { await t.close(); });
const raw = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load<T>(name: string, deps: Record<string, unknown>, mutation?: Mutation, globals: Record<string, unknown> = {}): T {
  let source = raw(name);
  if (mutation) { assert.equal(source.split(mutation[0]).length - 1, 1, 'единственный якорь всего модуля'); source = source.replace(...mutation); }
  const imports: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true).statements) if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly) {
    const id = (n.moduleSpecifier as ts.StringLiteral).text;
    imports[id] = new Proxy({}, { get: (_obj, key) => key === '__esModule' ? true : () => { throw new Error(`неисполняемая граница ${id}.${String(key)}`); } });
  }
  Object.assign(imports, deps);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, Buffer, URL, AbortSignal, ...globals,
      require: (id: string) => { assert.ok(Object.hasOwn(imports, id), `явный импорт ${id}`); return imports[id]; } });
  return module.exports as T;
}
// Выбираем callback по пути через AST; исполняется целый модуль, не вырезанный обработчик.
function withoutGuard(name: string, path: string, guard: string): Mutation {
  const source = raw(name), tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const matches: ts.Node[] = [];
  function visit(n: ts.Node) {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'post'
      && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === path) matches.push(n.arguments[n.arguments.length - 1]);
    ts.forEachChild(n, visit);
  }
  visit(tree); assert.equal(matches.length, 1, 'один POST нужного входа');
  const body = matches[0].getText(tree);
  assert.equal(body.split(guard).length - 1, 1, 'один guard в выбранном обработчике');
  return [body, body.replace(guard, '// адресный guard удалён')];
}
async function fixture(mutation?: { name: string; pair: Mutation }) {
  const io: string[] = [], fileCalls: string[] = [], onceCalls: string[] = [];
  const common = { '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: await import('zod') };
  const c = load<typeof import('../src/conversations.js')>('conversations', { ...common, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './convRules.js': rules, './serialize.js': { homeInstanceOf: () => null } });
  const att = load<typeof import('../src/routes/att.js')>('routes/att', common);
  const auth = { requireAuth: async (req: any) => { req.user = { sub: 'me' }; }, isSuperAdmin: () => false };
  const conv = load<typeof import('../src/routes/conv.js')>('routes/conv', { ...common,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema, '../auth.js': auth, '../guestGuard.js': { requireLocalUser: async () => {} },
    '../authGuard.js': { rateHit: async () => 0, messageSendBlock: async () => 0 }, '../convRules.js': rules,
    '../dmRules.js': await import('../src/dmRules.js'), '../blockRules.js': await import('../src/blockRules.js'),
    '../blocks.js': { isBlockedBy: async () => false },
    './att.js': { ...att, acceptDmUpload: async () => { io.push('upload'); return { accepted: true }; } },
    '../conversations.js': { ...c,
      sendMessage: async () => { io.push('send'); return { kind: 'replay', row: { id: 'send-spy' } }; },
      messageFor: async () => ({ id: 'send-spy' }),
      forwardMessages: async () => { io.push('forward'); return { kind: 'replay', rows: [] }; }, messagesFor: async () => new Map(),
    },
    '../scheduleRules.js': await import('../src/scheduleRules.js'), '../scheduled.js': {
      createScheduled: async () => { io.push('scheduled'); return { kind: 'replay', list: { pts: 0, items: [] } }; },
    },
  }, mutation?.name === 'routes/conv' ? mutation.pair : undefined);
  const uploads = load<typeof import('../src/routes/uploads.js')>('routes/uploads', { ...common,
    '../auth.js': auth, '../conversations.js': c, './conv.js': conv, '../attachmentRules.js': attachmentRules,
    '../attachments.js': { privateAttachmentsReady: () => true, attachmentStore: { multipart: {} } },
    '../authGuard.js': { attachmentUploadBlock: async () => 0 }, '../storage.js': { attachmentBlocked: () => false },
    '../bigUploads.js': { startUpload: async () => { io.push('chunks'); return { id: 'chunk-spy', partSize: 8, parts: 1 }; } },
  }, mutation?.name === 'routes/uploads' ? mutation.pair : undefined);
  const gifs = load<typeof import('../src/routes/gifs.js')>('routes/gifs', { ...common,
    '../auth.js': auth, '../conversations.js': c, './conv.js': conv, '../gifRules.js': gifRules,
    '../env.js': { env: { gifProvider: 'tenor', gifApiKey: 'fixture-key-not-a-secret' } },
    '../authGuard.js': { rateHit: async () => 0 }, '../attachments.js': { privateAttachmentsReady: () => true },
    '../gifs.js': { attachSavedGif: async () => { io.push('gif'); return { kind: 'ok', attachmentId: attId }; },
      attachExternalBytes: async () => { io.push('external'); return attId; }, saveGifBytes: async () => {}, announceGifs: async () => {} },
  }, mutation?.name === 'routes/gifs' ? mutation.pair : undefined, {
    fetch: async () => { io.push('fetch'); return { ok: true, headers: { get: () => 'video/mp4' },
      body: { async *[Symbol.asyncIterator]() { yield Buffer.from([1]); } } }; },
  });
  const app = Fastify(); await app.register(conv.convRoutes); await app.register(uploads.uploadRoutes); await app.register(gifs.gifRoutes); await app.ready();
  return { app, c, io, fileCalls, onceCalls,
    files(value: boolean | null) { conv.configureFedFilesGuard(value === null ? null : async id => { fileCalls.push(id); return value; }); },
    once(value: boolean | null) { conv.configureFedOnceGuard(value === null ? null : async id => { onceCalls.push(id); return value; }); },
  };
}
const paths = ['upload', 'chunks', 'gif', 'external', 'send', 'scheduled', 'forward'] as const;
type Path = typeof paths[number];
function request(path: Path, local = false, once = false): InjectOptions {
  const cid = local ? 'local' : 'remote';
  const payload = { clientId: randomUUID(), content: 'Подпись', attachments: [{ id: attId, ...(once ? { once: true } : {}) }] };
  switch (path) {
    case 'upload': return { method: 'POST', url: `/conv/${cid}/attachments`, payload: {} };
    case 'chunks': return { method: 'POST', url: `/conv/${cid}/uploads`, payload: { name: 'sample.txt', size: 1, type: 'text/plain' } };
    case 'gif': return { method: 'POST', url: `/gifs/${gifId}/attach`, payload: { conversationId: cid } };
    case 'external': return { method: 'POST', url: '/gifs/external/attach', payload: { conversationId: cid, url: 'https://media.tenor.com/fixture.mp4' } };
    case 'send': return { method: 'POST', url: `/conv/${cid}/messages`, payload };
    case 'scheduled': return { method: 'POST', url: `/conv/${cid}/scheduled`, payload: { ...payload, sendAt: new Date(Date.now() + 3600000).toISOString() } };
    case 'forward': return { method: 'POST', url: `/conv/${cid}/forward`, payload: { clientId: randomUUID(), fromConversationId: 'source', messageIds: ['file-source'] } };
  }
}
const success: Record<Path, number> = { upload: 200, chunks: 201, gif: 201, external: 201, send: 200, scheduled: 200, forward: 200 };
async function filesScenario(path: Path, mutation?: { name: string; pair: Mutation }) {
  const f = await fixture(mutation);
  try {
    for (const allowed of [null, false, true]) {
      f.files(allowed); f.io.length = 0;
      const res = await f.app.inject(request(path));
      assert.equal(res.statusCode, allowed === true ? success[path] : 400, 'каждый вход соблюдает разрешение файлов до IO');
      if (allowed !== true) { assert.equal(res.json().error, shared.FED_ERRORS.dmAttachmentsLater); assert.equal(f.io.length, 0); }
      else assert.equal(f.io.includes(path), true, 'разрешённый вход доходит до обозначенного IO');
      f.io.length = 0; const calls = f.fileCalls.length;
      assert.equal((await f.app.inject(request(path, true))).statusCode, success[path], 'местный вход доступен независимо от соседа');
      assert.equal(f.fileCalls.length, calls, 'крючок возможностей не запрашивается для местного');
    }
  } finally { await f.app.close(); }
}
const guardInfo: Record<Path, [string, string, string]> = {
  upload: ['routes/conv', '/conv/:id/attachments', 'if (await fedFilesRefused(reply, access.peerId)) return;'],
  chunks: ['routes/uploads', '/conv/:id/uploads', 'if (await fedFilesRefused(reply, access.peerId)) return;'],
  gif: ['routes/gifs', '/gifs/:id/attach', 'if (await gifToFedRefused(reply, me, conversationId)) return reply;'],
  external: ['routes/gifs', '/gifs/external/attach', 'if (await gifToFedRefused(reply, me, body.conversationId)) return reply;'],
  send: ['routes/conv', '/conv/:id/messages', 'if (body.attachments.length > 0 && (await fedFilesRefused(reply, access.peerId))) return;'],
  scheduled: ['routes/conv', '/conv/:id/scheduled', 'if (body.attachments.length > 0 && (await fedFilesRefused(reply, access.peerId))) return;'],
  forward: ['routes/conv', '/conv/:id/forward', 'if (withFiles.length > 0 && (await fedFilesRefused(reply, access.peerId))) return;'],
};
for (const path of paths) {
  test(`R194 файлы через ${path}: без крючка и false отказ, true и местный адресат разрешены`, async () => {
    // Класс ошибки: один из обходных путей принимает файл без согласованных возможностей соседа.
    await filesScenario(path);
  });
  test(`R194 снятый guard ${path} обнаруживается реальным HTTP-входом до IO`, async () => {
    // Класс ошибки: закрытая кнопка не заменяет серверный отказ на каждом отдельном входе.
    await filesScenario(path); const [name, route, guard] = guardInfo[path];
    await assert.rejects(filesScenario(path, { name, pair: withoutGuard(name, route, guard) }),
      e => e instanceof assert.AssertionError && e.message.includes('каждый вход соблюдает разрешение файлов'));
  });
}
async function onceScenario(path: 'send' | 'scheduled', mutation?: { name: string; pair: Mutation }) {
  const f = await fixture(mutation);
  try {
    f.files(true);
    for (const allowed of [null, false, true]) {
      f.once(allowed); f.io.length = 0;
      const res = await f.app.inject(request(path, false, true));
      assert.equal(res.statusCode, allowed === true ? success[path] : 400, 'один раз требует отдельного признака на обоих входах');
      if (allowed !== true) { assert.equal(res.json().error, shared.FED_ERRORS.dmAttachmentsLater); assert.equal(f.io.length, 0); }
      const before = f.onceCalls.length;
      assert.equal((await f.app.inject(request(path, true, true))).statusCode, success[path]);
      assert.equal(f.onceCalls.length, before, 'местное одноразовое не зависит от связки');
      assert.equal((await f.app.inject(request(path))).statusCode, success[path], 'обычный файл не требует dm2once');
    }
  } finally { await f.app.close(); }
}
for (const path of ['send', 'scheduled'] as const) {
  test(`R196 одноразовое ${path} требует true, местное и обычное вложение проходят`, async () => {
    // Класс ошибки: dm2 ошибочно разрешает once старому соседу, который никогда не погасит копию.
    await onceScenario(path);
  });
  test(`R196 снятая проверка once только на ${path} ловится HTTP-матрицей`, async () => {
    // Класс ошибки: отложенное обходит запрет, который обычная отправка уже соблюдает (и наоборот).
    await onceScenario(path);
    const route = path === 'send' ? '/conv/:id/messages' : '/conv/:id/scheduled';
    const guard = 'if (onceRefs(body.attachments) && (await fedOnceRefused(access.peerId))) return reply.code(400).send({ error: FED_ERRORS.dmAttachmentsLater });';
    await assert.rejects(onceScenario(path, { name: 'routes/conv', pair: withoutGuard('routes/conv', route, guard) }),
      e => e instanceof assert.AssertionError && e.message.includes('один раз требует отдельного признака'));
  });
}

test('R194 fedNoFiles только у удалённого 1:1, местная беседа и группа не заимствуют запрет одного дома', async () => {
  // Класс ошибки: сводка закрывает файлы местным или группе по одному участнику-тени.
  const f = await fixture();
  try {
    for (const lacking of [true, false]) {
      f.c.configureFederatedConv({ selfInstanceId: () => self, record: null,
        noFiles: async () => new Set(lacking ? [peer] : []) });
      // Без groups=true старый клиент намеренно не получает группу и «Избранное» — это не пропавший fed-hook.
      const list = (await f.c.listConversations('me', true)).conversations;
      const remote = list.find(c => c.id === 'remote')!;
      assert.equal((remote as { fedNoFiles?: boolean }).fedNoFiles, lacking ? true : undefined);
      for (const id of ['local', 'group', 'source']) {
        const item = list.find(c => c.id === id)!;
        assert.equal(item !== undefined, true, 'парная беседа действительно присутствует в сводке');
        assert.equal(Object.hasOwn(item, 'fedNoFiles'), false, 'не удалённый 1:1 не содержит fedNoFiles');
      }
    }
  } finally { await f.app.close(); }
});
