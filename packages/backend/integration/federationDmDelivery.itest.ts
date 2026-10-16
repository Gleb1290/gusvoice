import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as convRules from '../src/convRules.js';
import * as dmRules from '../src/dmRules.js';
import * as blockRules from '../src/blockRules.js';
import * as contactRules from '../src/contactRules.js';
import * as groupRules from '../src/groupRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
beforeEach(async () => {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    { id: 'me', username: 'local', displayName: 'Автор', passwordHash: 'fixture', verified: true, approvedAt: new Date() },
    { id: 'local', username: 'other', displayName: 'Местный', passwordHash: 'fixture', verified: true, approvedAt: new Date() },
    { id: 'shadow', username: 'shadow', displayName: 'Сосед', passwordHash: 'fixture', verified: true,
      homeInstanceId: 'b'.repeat(32), homeUserId: 'remote', homeUsername: 'remote' },
  ]);
  await t.db.insert(schema.conversations).values([
    { id: 'remote', kind: 'direct', directKey: 'me:shadow', createdBy: 'me' },
    { id: 'local', kind: 'direct', directKey: 'local:me', createdBy: 'me' },
    { id: 'source', kind: 'direct', directKey: 'me:me', createdBy: 'me' },
  ]);
  await t.db.insert(schema.conversationMembers).values([
    { conversationId: 'remote', userId: 'me' }, { conversationId: 'remote', userId: 'shadow' },
    { conversationId: 'local', userId: 'me' }, { conversationId: 'local', userId: 'local' },
    { conversationId: 'source', userId: 'me' },
  ]);
  await t.db.insert(schema.conversationMessages).values([
    { id: 'text', conversationId: 'source', authorId: 'me', sortKey: 1, content: 'Текст', attachments: [] },
    { id: 'file', conversationId: 'source', authorId: 'me', sortKey: 2, content: 'Подпись',
      attachments: [{ id: 'fixture-file', name: 'sample.txt', contentType: 'text/plain', size: 1, url: '/fixture-file' }] },
  ]);
});
after(async () => { await t.close(); });

type Mutation = readonly [string, string];
const fail = (name: string) => () => { throw new Error(`неисполняемая граница ${name}`); };
function moduleOf<T>(path: string, explicit: Record<string, unknown>, mutation?: Mutation): T {
  let source = readFileSync(new URL(`../src/${path}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation) {
    assert.equal(source.split(mutation[0]).length - 1, 1, 'единственный якорь мутанта');
    source = source.replace(...mutation);
  }
  const deps: Record<string, unknown> = {};
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  for (const node of tree.statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const spec = node.moduleSpecifier.text;
    if (Object.hasOwn(explicit, spec)) { deps[spec] = explicit[spec]; continue; }
    const exports: Record<string, unknown> = {};
    const bindings = node.importClause?.namedBindings;
    assert.ok(!bindings || ts.isNamedImports(bindings), `неописанный namespace ${spec}`);
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      if (!item.isTypeOnly) exports[item.propertyName?.text ?? item.name.text] = fail(`${spec}.${item.name.text}`);
    }
    deps[spec] = exports;
  }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, Date, Map, Set, Promise, Buffer,
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `неописанный require ${id}`); return deps[id]; } });
  return module.exports as T;
}
function accessModule() {
  return moduleOf<typeof import('../src/conversations.js')>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './convRules.js': convRules,
    './db/index.js': { db: t.db }, './db/schema.js': schema,
  });
}
async function routes(mutation?: Mutation, filesAllowed: boolean | null = null) {
  const forwarded: unknown[][] = [], uploads: string[] = [];
  const conv = accessModule();
  const route = moduleOf<typeof import('../src/routes/conv.js')>('routes/conv', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: { z },
    '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../convRules.js': convRules, '../dmRules.js': dmRules,
    '../blockRules.js': blockRules, '../contactRules.js': contactRules,
    '../auth.js': { requireAuth: async (req: FastifyRequest) => { req.user = { sub: 'me', username: 'local' }; }, isSuperAdmin: () => false },
    '../guestGuard.js': { requireLocalUser: async () => {} },
    '../authGuard.js': { messageSendBlock: async () => 0, rateHit: async () => 0, retryMessage: fail('retryMessage') },
    '../conversations.js': { ...conv,
      // Персистентная пересылка проверяется отдельно; здесь граница показывает, прошёл ли настоящий HTTP-отбор.
      forwardMessages: async (...args: unknown[]) => { forwarded.push(args); return { kind: 'replay', rows: [] }; },
      messagesFor: async () => new Map(),
    },
    '../blocks.js': { isBlockedBy: async () => false },
    './att.js': {
      // Схема другого, неисполняемого /messages: эти тесты не проверяют его разбор вложений.
      convAttachmentRefsSchema: z.array(z.unknown()).default([]),
      acceptDmUpload: async (_req: unknown, _reply: unknown, id: string) => { uploads.push(id); return { accepted: id }; },
    },
  }, mutation);
  route.configureFedFilesGuard(filesAllowed === null ? null : async () => filesAllowed);
  const app = Fastify(); await app.register(route.convRoutes); await app.ready();
  return { app, forwarded, uploads };
}
const forwardBody = (ids: string[]) => ({ clientId: randomUUID(), fromConversationId: 'source', messageIds: ids });

async function uploadScenario(mutation?: Mutation) {
  for (const allowed of [null, false, true]) {
    const f = await routes(mutation, allowed);
    try {
      const remote = await f.app.inject({ method: 'POST', url: '/conv/remote/attachments', payload: {} });
      assert.equal(remote.statusCode, allowed === true ? 200 : 400, 'межинстансная загрузка соблюдает крючок до хранилища');
      if (allowed === true) assert.equal(remote.json().accepted, 'remote');
      else assert.equal(remote.json().error, shared.FED_ERRORS.dmAttachmentsLater);
      assert.equal(f.uploads.length, allowed === true ? 1 : 0);
      const local = await f.app.inject({ method: 'POST', url: '/conv/local/attachments', payload: {} });
      assert.equal(local.statusCode, 200); assert.equal(local.json().accepted, 'local');
      assert.deepEqual(f.uploads, allowed === true ? ['remote', 'local'] : ['local']);
      const inaccessible = await f.app.inject({ method: 'POST', url: '/conv/absent/attachments', payload: {} });
      assert.equal(inaccessible.statusCode, 404); assert.equal(f.uploads.length, allowed === true ? 2 : 1);
    } finally { await f.app.close(); }
  }
}
test('R190 загрузка в межинстансный ЛС объясняет отсрочку файлов, местная доходит до upload, чужая не доходит', async () => {
  // Класс ошибки: недоступное удалённое хранилище принимается как местное либо запрет ломает местную загрузку.
  await uploadScenario();
});
async function forwardScenario(mutation?: Mutation) {
  for (const allowed of [null, false, true]) {
    const f = await routes(mutation, allowed);
    try {
      const file = await f.app.inject({ method: 'POST', url: '/conv/remote/forward', payload: forwardBody(['text', 'file']) });
      assert.equal(file.statusCode, allowed === true ? 200 : 400, 'межинстансная пересылка с одним файлом соблюдает крючок до копирования');
      if (allowed !== true) assert.equal(file.json().error, shared.FED_ERRORS.dmAttachmentsLater);
      assert.equal(f.forwarded.length, allowed === true ? 1 : 0);
      const text = await f.app.inject({ method: 'POST', url: '/conv/remote/forward', payload: forwardBody(['text']) });
      assert.equal(text.statusCode, 200); assert.equal(f.forwarded.length, allowed === true ? 2 : 1);
      const local = await f.app.inject({ method: 'POST', url: '/conv/local/forward', payload: forwardBody(['file']) });
      assert.equal(local.statusCode, 200); assert.equal(f.forwarded.length, allowed === true ? 3 : 2);
    } finally { await f.app.close(); }
  }
}
test('R190 пересылка текста соседу и файла местному проходит, смешанная пачка соседу отклоняется целиком', async () => {
  // Класс ошибки: проверяется только первое сообщение пачки или файлы запрещаются также в обычном местном ЛС.
  await forwardScenario();
});
for (const [name, scenario, mutation, target] of [
  ['загрузка без fedFiles guard', uploadScenario,
    ['if (await fedFilesRefused(reply, access.peerId)) return;\n    return acceptDmUpload', '// проверка файлов удалена\n    return acceptDmUpload'],
    'межинстансная загрузка соблюдает крючок'],
  ['один файл ошибочно разрешён', forwardScenario,
    ['sql`jsonb_array_length(${conversationMessages.attachments}) > 0`', 'sql`jsonb_array_length(${conversationMessages.attachments}) > 1`'],
    'межинстансная пересылка с одним файлом соблюдает крючок'],
] as const) test(`R190 контрфакт «${name}» отклонён настоящим маршрутом`, async () => {
  // Класс ошибки: мутант проходит HTTP+SQL и ловится отказом контракта, а не loader/TypeError.
  await scenario();
  await assert.rejects(scenario(mutation), e => e instanceof assert.AssertionError && e.message.includes(target));
});

function fanout(mutation?: Mutation) {
  const deliveries: unknown[] = [], bursts: string[] = [], pushes: unknown[][] = [];
  let completed!: () => void;
  const sent = new Promise<void>(resolve => { completed = resolve; });
  const module = moduleOf<typeof import('../src/convSendFanout.js')>('convSendFanout', {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './conversations.js': { deliver: async (d: unknown) => { deliveries.push(d); } },
    './authGuard.js': { pushBurst: async (id: string) => { bursts.push(id); return 'loud'; } },
    './contacts.js': { contactNamesFor: async () => new Map() }, './contactRules.js': contactRules, './groupRules.js': groupRules,
    './push.js': {
      contentPreview: () => 'Превью', pushThrottleSource: () => 'fixture-source',
      sendPushToUsers: async (...args: unknown[]) => { pushes.push(args); completed(); },
      withSilent: (payload: unknown) => payload, stickerPushText: () => 'Стикер', pushAlwaysUsers: fail('pushAlwaysUsers'),
    },
  }, mutation);
  return { module, deliveries, bursts, pushes, sent };
}
function message(peerId: string | null, notifyRecipient = true): import('../src/convSendFanout.js').SentMessage {
  return { me: 'me', peerId, conversationId: 'remote', row: { id: 'message', createdAt: new Date(1), sortKey: 1 },
    delivery: { conversationId: 'remote', messageId: 'message', pts: new Map([['me', 1]]) },
    notifyRecipient, content: 'Текст', attachments: [], silent: false };
}
async function remoteFanout(mutation?: Mutation) {
  const f = fanout(mutation); const s = message('shadow');
  await f.module.fanOutSend(s);
  assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0], s.delivery);
  assert.equal(f.bursts.length, 0, 'дом отправителя не будит удалённого собеседника');
  assert.equal(f.pushes.length, 0);
}
test('R190 событие отправки доставляется, удалённый собеседник не тратит pushBurst и не получает пуш через наш дом', async () => {
  // Класс ошибки: guest.notify задерживает звонок conv.changed и дублирует пуш, которым владеет дом получателя.
  await remoteFanout();
});
test('R190 местный собеседник получает пуш, отсутствие получателя и notify=false оставляют только доставку события', async () => {
  // Класс ошибки: исправление удалённых пушей случайно выключает местные или обходится при запрещённом уведомлении.
  const f = fanout(); await f.module.fanOutSend(message('local')); await f.sent;
  assert.deepEqual(f.bursts, ['local']); assert.equal(f.pushes.length, 1);
  assert.deepEqual([...(f.pushes[0][0] as string[])], ['local']); assert.equal(f.deliveries.length, 1);
  for (const s of [message(null), message('local', false)]) {
    const quiet = fanout(); await quiet.module.fanOutSend(s);
    assert.equal(quiet.deliveries.length, 1); assert.equal(quiet.bursts.length, 0); assert.equal(quiet.pushes.length, 0);
  }
});
test('R190 удаление remote home guard обнаруживается счётчиком настоящего fanOutSend', async () => {
  // Класс ошибки: весь модуль мутанта доходит до pushBurst, targeted AssertionError отличает это от сбоя загрузки.
  await remoteFanout();
  await assert.rejects(remoteFanout(['if (peerRow?.home) return;', 'if (false) return;']),
    e => e instanceof assert.AssertionError && e.message.includes('дом отправителя не будит'));
});
