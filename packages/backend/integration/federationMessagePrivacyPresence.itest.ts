import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import ts from 'typescript';
import { z } from 'zod';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as lastSeenRules from '../src/lastSeenRules.js';
import * as privacyRules from '../src/messagePrivacyRules.js';
import * as authRules from '../src/authRules.js';
import * as guestRules from '../src/federation/guestRules.js';
import * as convRules from '../src/convRules.js';
import * as dmRules from '../src/dmRules.js';
import * as scheduleRules from '../src/scheduleRules.js';
import * as strangerRules from '../src/strangerRules.js';
import * as blockRules from '../src/blockRules.js';
import * as contactRules from '../src/contactRules.js';
import * as superAdminRules from '../src/superAdminRules.js';
import * as userSearchRules from '../src/userSearchRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';
import type { StoredLink } from '../src/federation/linkService.js';

let t: TestDb;
const unexpected: string[] = [], warnings: string[] = [];
before(async () => { t = await createTestDb(); });
beforeEach(() => { unexpected.length = 0; warnings.length = 0; });
afterEach(async () => { await t.raw.query('SELECT 1'); assert.deepEqual(unexpected, [], 'никакой swallowed ошибки неописанной границы'); assert.deepEqual(warnings, []); });
after(async () => {
  try { await t.close(); } finally { const { pool } = await import('../src/db/index.js'); await pool.end(); }
});
const self = 'a'.repeat(32), peer = 'b'.repeat(32), otherHome = 'c'.repeat(32), NOW = 2_000_000_000_000;
type Mutation = { file: string; from: string; to: string };
const forbidden = (label: string) => () => { unexpected.push(label); throw new Error(`вне сценария noMessages: ${label}`); };
function moduleOf<T>(name: string, explicit: Record<string, unknown>, mutation?: Mutation, expose = '', globals: Record<string, unknown> = {}): T {
  let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation?.file === name) {
    assert.equal(source.split(mutation.from).length - 1, 1, 'единственный якорь noMessages'); source = source.replace(mutation.from, mutation.to);
  }
  source += expose; // Только export-ссылка private функции: исполняется весь модуль, не её копия.
  const deps = { ...explicit }, ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  for (const node of ast.statements) if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
    const id = node.moduleSpecifier.text;
    if (!Object.hasOwn(deps, id)) deps[id] = new Proxy({}, { get: (_target, key) => key === '__esModule' ? true : forbidden(`${id}.${String(key)}`) });
  }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, URL, Buffer, Map, Set, Promise,
      setTimeout: forbidden(`${name}:timer`), setInterval: forbidden(`${name}:interval`), fetch: forbidden(`${name}:fetch`),
      console: { warn: (...args: unknown[]) => warnings.push(`${name}:${args.map(String).join(' ')}`),
        error: (...args: unknown[]) => warnings.push(`${name}:error:${args.map(String).join(' ')}`), log() {} }, ...globals,
      require(id: string) { if (!Object.hasOwn(deps, id)) unexpected.push(`require:${name}:${id}`);
        assert.equal(Object.hasOwn(deps, id), true, `явный импорт noMessages ${id}`); return deps[id]; } });
  return module.exports as T;
}
type Ephemeral = typeof import('../src/federation/dmEphemeral.js') & { testFlushPresence(user: string, alive: boolean): Promise<void> };
type Guard = typeof import('../src/routes/conv.js') & {
  testPrivacyRefused(reply: unknown, me: string, access: { kind: string; saved: boolean; peerId: string | null }): Promise<boolean>;
};
async function fixture(mutation?: Mutation) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'msgpriv_local', displayName: 'Наш', passwordHash: 'fixture', messagePrivacy: 'contacts', lastSeenPrivacy: 'everyone', lastSeenAt: new Date(NOW - 1000) },
    { id: 'viewer', username: 'msgpriv_viewer', displayName: 'Другой наш', passwordHash: 'fixture' },
    { id: 'shadow', username: 'msgpriv_shadow', displayName: 'Сосед', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'remote' },
    { id: 'shadow2', username: 'msgpriv_shadow2', displayName: 'Второй сосед', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'remote2' },
  ]);
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: 'peer.invalid', apiBase: 'https://peer.invalid/api', clientOrigin: 'https://peer.invalid', rootKey: 'fixture', state: 'active', features: ['dm1', 'dm3'] });
  const saved = (await t.db.select().from(schema.federationLinks))[0]!; assert.equal(saved.state, 'active');
  const link: StoredLink = { ...saved, state: 'active' };
  await t.db.insert(schema.conversations).values([
    { id: 'privacy-direct', kind: 'direct', directKey: 'local:shadow', createdBy: 'local' },
    { id: 'privacy-direct2', kind: 'direct', directKey: 'local:shadow2', createdBy: 'local' },
    { id: 'privacy-group', kind: 'group', createdBy: 'local' },
  ]);
  await t.db.insert(schema.conversationMembers).values([
    { conversationId: 'privacy-direct', userId: 'local' }, { conversationId: 'privacy-direct', userId: 'shadow' },
    { conversationId: 'privacy-direct2', userId: 'local' }, { conversationId: 'privacy-direct2', userId: 'shadow2' },
    { conversationId: 'privacy-group', userId: 'local' }, { conversationId: 'privacy-group', userId: 'shadow' },
  ]);
  await t.db.insert(schema.userContacts).values({ ownerId: 'local', contactId: 'shadow2' });
  const privacy = moduleOf<typeof import('../src/messagePrivacy.js')>('messagePrivacy', { 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './lastSeenRules.js': lastSeenRules, './messagePrivacyRules.js': privacyRules }, mutation);
  const blocks = moduleOf<typeof import('../src/blocks.js')>('blocks', { 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema });
  const guest = moduleOf<typeof import('../src/federation/guestHost.js')>('federation/guestHost', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: t.db }, '../db/schema.js': schema, '../authRules.js': authRules, './guestRules.js': guestRules,
  });
  const sent: { path: string; payload: Record<string, unknown> }[] = [], online: [string, boolean][] = [];
  class Clock extends Date { constructor(value?: number | string) { super(value ?? NOW); } static now() { return NOW; } }
  const ephemeral = moduleOf<Ephemeral>('federation/dmEphemeral', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../blocks.js': blocks, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../gateway.js': { isUserDmPresent: (id: string) => id === 'local', relayFedTyping: forbidden('typing'), setRemoteDmPresence: (id: string, value: boolean) => online.push([id, value]) },
    '../lastSeenRules.js': lastSeenRules, './directorySync.js': { refreshCapabilities: async () => link.features }, './guestHost.js': guest,
    './instance.js': { federation: { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'fixture', privateKeyDer: new Uint8Array([1]) }) } },
    './peerClient.js': { postSignedToPeer: async (request: { path: string; payload: Record<string, unknown> }) => { sent.push(request); return { ok: true, value: { status: 202 } }; } },
  }, mutation, '\nexport { flushPresence as testFlushPresence };\n', { Date: Clock });
  ephemeral.configurePresenceMessagePrivacy(privacy.messageAllowedFor);
  const route = moduleOf<Guard>('routes/conv', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: { z }, '../convRules.js': convRules, '../dmRules.js': dmRules,
    '../scheduleRules.js': scheduleRules, '../strangerRules.js': strangerRules, '../blockRules.js': blockRules, '../contactRules.js': contactRules,
    '../superAdminRules.js': superAdminRules, '../userSearchRules.js': userSearchRules,
  }, mutation, '\nexport { messagePrivacyRefused as testPrivacyRefused };\n');
  route.configureMessagePrivacy({ allowed: privacy.messageAllowedFor, wrote: privacy.wroteInDirect, remoteRefused: ephemeral.remoteMessageRefusedFor });
  async function guarded(peerId = 'shadow') {
    const responses: { status: number; body: unknown }[] = []; let status = 200;
    const reply = { code(value: number) { status = value; return reply; }, async send(body: unknown) { responses.push({ status, body }); } };
    const refused = await route.testPrivacyRefused(reply, 'local', { kind: 'direct', saved: false, peerId });
    return { refused, responses };
  }
  return { privacy, ephemeral, route, blocks, link, sent, online, guarded };
}
function wire(at: number, refused: string[], home = self) {
  return shared.serializeEphemeralWire(peer, { kind: 'presence', user: { instanceId: peer, userId: 'remote' }, at, online: true,
    views: refused.map(userId => ({ user: { instanceId: home, userId }, lastSeen: NOW - 1000, approx: null, noMessages: true as const })) });
}
async function sendFlag(mutation?: Mutation) {
  const f = await fixture(mutation); await f.ephemeral.testFlushPresence('local', false);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0]!.path, '/api/fed/v1/ephemeral');
  const parsed = shared.parseEphemeralWire(f.sent[0]!.payload); assert.ok(parsed && parsed !== 'unknown' && parsed.kind === 'presence');
  assert.equal(parsed.views.find(v => v.user.userId === 'remote')?.noMessages, true, 'R212-presence-refusal: noMessages только у не прошедшего получателя');
  assert.equal(parsed.views.find(v => v.user.userId === 'remote2')?.noMessages, undefined);
  const rawViews = f.sent[0]!.payload.views as { user: { user_id: string }; no_messages?: true }[];
  assert.equal(rawViews.find(v => v.user.user_id === 'remote')?.no_messages, true);
  assert.equal(Object.hasOwn(rawViews.find(v => v.user.user_id === 'remote2')!, 'no_messages'), false);
}
test('R212 присутствие сообщает noMessages только отказанному, контакт того же дома получает вид без поля', () => sendFlag());
test('R212 everyone и неподключённый hook не отправляют no_messages ни одному собеседнику', async () => {
  for (const mode of ['everyone', 'no-hook'] as const) {
    const f = await fixture();
    if (mode === 'everyone') await t.db.update(schema.users).set({ messagePrivacy: 'everyone' }).where(orm.eq(schema.users.id, 'local'));
    else f.ephemeral.configurePresenceMessagePrivacy(null);
    await f.ephemeral.testFlushPresence('local', false);
    assert.equal(f.sent.length, 1); const views = f.sent[0]!.payload.views as Record<string, unknown>[];
    assert.equal(views.length, 2); assert.equal(views.some(v => Object.hasOwn(v, 'no_messages')), false);
  }
});
async function replaces(mutation?: Mutation) {
  const f = await fixture(mutation);
  assert.equal((await f.ephemeral.acceptEphemeral(f.link, wire(NOW, ['local']))).status, 202);
  assert.equal(f.ephemeral.remoteMessageRefusedFor('shadow', 'local'), true); assert.equal(f.ephemeral.remoteMessageRefusedFor('shadow', 'viewer'), false);
  await f.ephemeral.acceptEphemeral(f.link, wire(NOW + 1, ['viewer']));
  assert.equal(f.ephemeral.remoteMessageRefusedFor('shadow', 'local'), false, 'R212-presence-replace: прежний зритель удалён из полного набора');
  assert.equal(f.ephemeral.remoteMessageRefusedFor('shadow', 'viewer'), true); assert.equal(f.ephemeral.remoteMessageRefusedFor('shadow2', 'viewer'), false);
}
test('R212 новый presence целиком заменяет отказанный набор, а не накапливает его между записями', () => replaces());
async function clears(mutation?: Mutation) {
  const f = await fixture(mutation); await f.ephemeral.acceptEphemeral(f.link, wire(NOW, ['local', 'viewer']));
  await f.ephemeral.acceptEphemeral(f.link, wire(NOW + 1, []));
  assert.equal(f.ephemeral.remoteMessageRefusedFor('shadow', 'local'), false, 'R212-presence-clear: пустой новый набор снимает запрет');
  assert.equal(f.ephemeral.remoteMessageRefusedFor('shadow', 'viewer'), false);
}
test('R212 пустой полный presence снимает все прежние запреты писать', () => clears());
async function wrongHome(mutation?: Mutation) {
  const f = await fixture(mutation); await f.ephemeral.acceptEphemeral(f.link, wire(NOW, ['local']));
  await f.ephemeral.acceptEphemeral(f.link, wire(NOW + 1, ['local'], otherHome));
  assert.equal(f.ephemeral.remoteMessageRefusedFor('shadow', 'local'), false, 'R212-presence-home: вид другого дома не запрещает нашему одноимённому человеку писать');
}
test('R212 зритель с другого инстанса игнорируется даже при совпадающем user_id и no_messages', () => wrongHome());
test('R212 старый и равный at не снимают запрет, сообщение про человека не дома связки отвергается', async () => {
  const f = await fixture(); await f.ephemeral.acceptEphemeral(f.link, wire(NOW, ['local']));
  for (const at of [NOW - 1, NOW]) {
    assert.equal((await f.ephemeral.acceptEphemeral(f.link, wire(at, []))).body.ignored, true);
    assert.equal(f.ephemeral.remoteMessageRefusedFor('shadow', 'local'), true);
  }
  const other = wire(NOW + 1, []); other.user = { instance_id: otherHome, user_id: 'remote' };
  assert.equal((await f.ephemeral.acceptEphemeral(f.link, other)).status, 403); assert.equal(f.ephemeral.remoteMessageRefusedFor('shadow', 'local'), true);
});
async function message(authorId: string, options: { service?: boolean; deleted?: boolean; group?: boolean } = {}) {
  await t.db.insert(schema.conversationMessages).values({ id: `wrote-${authorId}-${options.service}-${options.deleted}-${options.group}`,
    conversationId: options.group ? 'privacy-group' : 'privacy-direct', authorId, sortKey: options.service ? 1 : options.deleted ? 2 : options.group ? 3 : 4,
    content: 'Первое сообщение', attachments: [], service: options.service ? { kind: 'call', callId: 'wrote-call', reason: 'missed', duration: 0 } : null,
    deletedAt: options.deleted ? new Date() : null });
}
async function replied(mutation?: Mutation) {
  const f = await fixture(mutation); await f.ephemeral.acceptEphemeral(f.link, wire(NOW, ['local']));
  const before = await f.guarded(); assert.equal(before.refused, true); assert.equal(before.responses.length, 1);
  assert.equal(before.responses[0]?.status, 403); assert.equal((before.responses[0]?.body as { error: unknown }).error, shared.MESSAGE_PRIVACY_ERROR);
  await message('shadow'); assert.equal(await f.privacy.wroteInDirect('shadow', 'local'), true);
  const after = await f.guarded();
  assert.equal(after.refused, false, 'R212-remote-write: собеседник сам написал, ответ разрешён до нового presence');
  assert.deepEqual(after.responses, []); assert.equal(f.ephemeral.remoteMessageRefusedFor('shadow', 'local'), true);
}
test('R212 реальное обычное сообщение собеседника снимает remote-запрет в настоящем route guard без нового presence', () => replied());
test('R212 служебное, удалённое, наше сообщение и сообщение группы не считаются первым письмом соседа', async () => {
  const f = await fixture(); await f.ephemeral.acceptEphemeral(f.link, wire(NOW, ['local']));
  for (const [author, options] of [['shadow', { service: true }], ['shadow', { deleted: true }], ['shadow', { group: true }], ['local', {}]] as const) {
    await message(author, options); assert.equal(await f.privacy.wroteInDirect('shadow', 'local'), false);
    assert.equal((await f.guarded()).refused, true);
  }
});
test('R212 без remote noMessages route guard не запрещает ответ и не выдаёт 403', async () => {
  const f = await fixture(); const result = await f.guarded(); assert.equal(result.refused, false); assert.deepEqual(result.responses, []);
});
for (const [label, mutation, check, prefix, actual, expected] of [
  ['разрешение спутано с отказом', { file: 'federation/dmEphemeral', from: 'messageGate !== null && !(await messageGate(p.peer, userId))', to: 'messageGate !== null && (await messageGate(p.peer, userId))' }, sendFlag, 'R212-presence-refusal:', undefined, true],
  ['набор накапливается', { file: 'federation/dmEphemeral', from: 'remoteNoMessages.set(shadow.id, refused);', to: 'remoteNoMessages.set(shadow.id, new Set([...(remoteNoMessages.get(shadow.id) ?? []), ...refused]));' }, replaces, 'R212-presence-replace:', true, false],
  ['пустой набор не снимает', { file: 'federation/dmEphemeral', from: 'else remoteNoMessages.delete(shadow.id);', to: 'else void 0;' }, clears, 'R212-presence-clear:', true, false],
  ['чужой дом влияет на наших', { file: 'federation/dmEphemeral', from: 'v.noMessages && self && v.user.instanceId === self.instanceId', to: 'v.noMessages && self' }, wrongHome, 'R212-presence-home:', true, false],
  ['ответ не учитывает первое письмо', { file: 'routes/conv', from: '&& !(await g.wrote(access.peerId, me))', to: '&& true' }, replied, 'R212-remote-write:', true, false],
] as const) test(`R212 строгий контрфакт presence: ${label}`, async () => {
  await check(); await assert.rejects(check(mutation), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
});
