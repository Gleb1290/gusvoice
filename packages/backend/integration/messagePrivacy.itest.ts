import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, test } from 'node:test';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as privacyRules from '../src/messagePrivacyRules.js';
import * as lastSeenRules from '../src/lastSeenRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Api = typeof import('../src/messagePrivacy.js');
type Mutation = { from: string; to: string };
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { try { await t?.close(); } finally { const { pool } = await import('../src/db/index.js'); await pool.end(); } });
const source = () => readFileSync(new URL('../src/messagePrivacy.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(edit?: Mutation): Api {
  let raw = source();
  if (edit) { assert.equal(raw.split(edit.from).length, 2, 'единственный whole-module якорь приватности'); raw = raw.replace(edit.from, edit.to); }
  const deps: Record<string, unknown> = { 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './messagePrivacyRules.js': privacyRules, './lastSeenRules.js': lastSeenRules };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, Set, Map,
      require(id: string) { assert.ok(Object.hasOwn(deps, id), `закрытый импорт messagePrivacy:${id}`); return deps[id]; } });
  return module.exports as Api;
}
function mutation(name: string, from: string, to: string): Mutation {
  const raw = source(), ast = ts.createSourceFile('messagePrivacy.ts', raw, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.equal(functions.length, 1, `адресный контрфакт ${name}`);
  const body = functions[0].getText(ast); assert.equal(body.split(from).length, 2, `один смысловой якорь ${name}`);
  return { from: body, to: body.replace(from, to) };
}
const killed = (prefix: string, actual: boolean, expected: boolean) => (e: unknown) => e instanceof assert.AssertionError
  && e.code === 'ERR_ASSERTION' && e.message.startsWith(prefix) && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected;

async function fixture(edit?: Mutation) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['sender', 'recipient', 'other', 'deleted'].map(id => ({ id, username: `privacy_${id}`,
    displayName: id, passwordHash: 'synthetic-only', messagePrivacy: id === 'recipient' ? 'contacts' : 'everyone',
    deletedAt: id === 'deleted' ? new Date('2026-01-01T00:00:00Z') : null })));
  await t.db.insert(schema.conversations).values([{ id: 'direct', kind: 'direct', directKey: 'sender:recipient' }, { id: 'group', kind: 'group', title: 'Synthetic group' }]);
  await t.db.insert(schema.conversationMembers).values(['direct', 'group'].flatMap(conversationId => ['sender', 'recipient'].map(userId => ({ conversationId, userId }))));
  return load(edit);
}
async function contactDirection(edit?: Mutation) {
  const api = await fixture(edit);
  await t.db.insert(schema.userContacts).values({ ownerId: 'sender', contactId: 'recipient' });
  assert.equal(await api.messageAllowedFor('sender', 'recipient'), false, 'контакт отправителя не разрешает ему писать получателю');
  await t.db.insert(schema.userContacts).values({ ownerId: 'recipient', contactId: 'sender' });
  assert.equal(await api.messageAllowedFor('sender', 'recipient'), true, 'собственный контакт получателя разрешает отправителя');
}
test('R212 свои и неизвестный получатель разрешены, everyone открыт, contacts без основания закрыт', async () => {
  const api = await fixture();
  assert.equal(await api.messageAllowedFor('recipient', 'recipient'), true);
  assert.equal(await api.messageAllowedFor('sender', 'unknown'), true);
  assert.equal(await api.messageAllowedFor('recipient', 'sender'), true);
  assert.equal(await api.messageAllowedFor('sender', 'recipient'), false);
});
test('R212 право контакта принадлежит получателю, обратная запись отправителя не даёт права', async () => { await contactDirection(); });

async function wrote(kind: 'normal' | 'sender' | 'service' | 'deleted' | 'group', edit?: Mutation) {
  const api = await fixture(edit), qualifying = kind === 'normal';
  await t.db.insert(schema.conversationMessages).values({ id: 'synthetic-message', conversationId: kind === 'group' ? 'group' : 'direct',
    authorId: kind === 'sender' ? 'sender' : 'recipient', sortKey: 1, content: 'Synthetic text',
    service: kind === 'service' ? { kind: 'call', callId: 'synthetic-call', duration: 0, reason: 'missed' } : null,
    deletedAt: kind === 'deleted' ? new Date('2026-01-01T00:00:00Z') : null });
  assert.equal(await api.messageAllowedFor('sender', 'recipient'), qualifying,
    'только обычное живое сообщение получателя в 1:1 открывает ответ');
  assert.equal(await api.wroteInDirect('recipient', 'sender'), qualifying, 'wroteInDirect учитывает ту же сторону и фильтры');
  if (kind === 'sender') assert.equal(await api.wroteInDirect('sender', 'recipient'), true, 'реальный автор написал в своей 1:1');
}
for (const [kind, description] of [['normal', 'живое сообщение получателя разрешает ответ'], ['sender', 'сообщение отправителя не выдаёт ему право'],
  ['service', 'служебный звонок не считается начатой перепиской'], ['deleted', 'удалённое сообщение не открывает переписку'], ['group', 'текст группы не даёт право писать в 1:1']] as const) {
  test(`R212 ${description}`, async () => { await wrote(kind); });
}
async function exceptionKey(edit?: Mutation) {
  const api = await fixture(edit);
  await t.db.insert(schema.privacyExceptions).values({ ownerId: 'recipient', targetId: 'sender', key: 'calls', kind: 'always' });
  assert.equal(await api.messageAllowedFor('sender', 'recipient'), false, 'исключение calls не разрешает messages');
  await t.db.insert(schema.privacyExceptions).values({ ownerId: 'recipient', targetId: 'sender', key: 'messages', kind: 'always' });
  assert.equal(await api.messageAllowedFor('sender', 'recipient'), true, 'собственное messages always открывает переписку');
}
test('R212 исключение сообщений не смешивается со звонками и исключениями других владельцев', async () => {
  await exceptionKey();
  const api = await fixture();
  await t.db.insert(schema.privacyExceptions).values({ ownerId: 'sender', targetId: 'recipient', key: 'messages', kind: 'always' });
  assert.equal(await api.messageAllowedFor('sender', 'recipient'), false, 'обратное исключение не даёт право');
  await t.db.insert(schema.privacyExceptions).values({ ownerId: 'recipient', targetId: 'sender', key: 'messages', kind: 'never' });
  assert.equal(await api.messageAllowedFor('sender', 'recipient'), false, 'never не превращается в always');
});
test('R212 сохранение исключений чистит себя, неизвестных, удалённых и дубли, заменяет только messages', async () => {
  const api = await fixture();
  await t.db.insert(schema.privacyExceptions).values({ ownerId: 'recipient', targetId: 'sender', key: 'calls', kind: 'always' });
  const saved = await api.setMessageExceptions('recipient', ['recipient', 'unknown', 'deleted', 'other', 'sender', 'other']);
  assert.deepEqual(saved.always.map(p => p.id), ['other', 'sender']); assert.equal(saved.never.length, 0);
  assert.equal(await api.messageAllowedFor('sender', 'recipient'), true);
  assert.equal((await api.setMessageExceptions('recipient', [])).always.length, 0);
  assert.equal(await api.messageAllowedFor('sender', 'recipient'), false);
  assert.deepEqual((await t.db.select().from(schema.privacyExceptions)).map(p => [p.key, p.targetId]), [['calls', 'sender']]);
});
test('R212 один отправитель не получает право через другую 1:1 получателя', async () => {
  const api = await fixture();
  await t.db.insert(schema.conversations).values({ id: 'other-direct', kind: 'direct', directKey: 'other:recipient' });
  await t.db.insert(schema.conversationMembers).values(['other', 'recipient'].map(userId => ({ conversationId: 'other-direct', userId })));
  await t.db.insert(schema.conversationMessages).values({ id: 'other-message', conversationId: 'other-direct', authorId: 'recipient', sortKey: 1, content: 'Synthetic text' });
  assert.equal(await api.messageAllowedFor('sender', 'recipient'), false);
  assert.equal(await api.wroteInDirect('recipient', 'sender'), false);
  assert.equal(await api.messageAllowedFor('other', 'recipient'), true);
});
test('R212 контрфакт: owner/contact поменялись местами — обратный контакт ошибочно разрешает отправку', async () => {
  await contactDirection();
  await assert.rejects(() => contactDirection(mutation('messageAllowedFor', 'uc.owner_id = ${recipientId} AND uc.contact_id = ${senderId}',
    'uc.owner_id = ${senderId} AND uc.contact_id = ${recipientId}')), killed('контакт отправителя не разрешает ему писать получателю', true, false));
});
test('R212 контрфакт: снят service IS NULL — служебная запись ошибочно разрешает ответ', async () => {
  await wrote('service');
  await assert.rejects(() => wrote('service', mutation('messageAllowedFor', ' AND sx.service IS NULL', '')),
    killed('только обычное живое сообщение получателя в 1:1 открывает ответ', true, false));
});
test('R212 контрфакт: снят pe.key — разрешение звонков ошибочно распространяется на сообщения', async () => {
  await exceptionKey();
  await assert.rejects(() => exceptionKey(mutation('messageAllowedFor', ' AND pe.key = ${KEY}', '')),
    killed('исключение calls не разрешает messages', true, false));
});
