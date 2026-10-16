import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as authRules from '../src/authRules.js';
import * as pushRules from '../src/pushRules.js';
import * as contactRules from '../src/contactRules.js';
import * as groupRules from '../src/groupRules.js';
import * as privacyRules from '../src/messagePrivacyRules.js';
import * as lastSeenRules from '../src/lastSeenRules.js';
import * as dmRules from '../src/dmRules.js';
import * as guestRules from '../src/federation/guestRules.js';
import * as userSearchRules from '../src/userSearchRules.js';
import * as barrier from '../src/dmWriteBarrier.js';
import * as statusRules from '../src/statusRules.js';
import * as shopRules from '../src/shopRules.js';
import * as callRules from '../src/callRules.js';
import * as superAdminRules from '../src/superAdminRules.js';
import * as threatRules from '../src/linkThreatsRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';
import type { StoredLink } from '../src/federation/linkService.js';

let t: TestDb;
const unexpected: string[] = [], warnings: string[] = [], deliveries: Promise<void>[] = [];
before(async () => { t = await createTestDb(); });
beforeEach(() => { unexpected.length = 0; warnings.length = 0; deliveries.length = 0; });
afterEach(async () => {
  await Promise.all(deliveries); await t.raw.query('SELECT 1');
  assert.deepEqual(unexpected, [], 'никакой swallowed ошибки неописанной границы');
  assert.equal(warnings.every(w => [incomingId, proposedId].some(id => w === `federation/convOpen:[fed-dm] ${peer}: строка conv ${id} отклонена (privacy)`)), true,
    'в мутантах допустим только точный ожидаемый отказ строки privacy, не скрытая внутренняя ошибка');
});
after(async () => {
  try { await t.close(); } finally { const { pool } = await import('../src/db/index.js'); await pool.end(); }
});
const self = 'a'.repeat(32), peer = 'b'.repeat(32);
const incomingId = '10000000-0000-4000-8000-000000000001', proposedId = '20000000-0000-4000-8000-000000000001';
const profile = { username: 'privacy_remote', displayName: 'Человек соседа', avatarHash: null };
type Mutation = { file: string; from: string; to: string };
const forbidden = (label: string) => () => { unexpected.push(label); throw new Error(`вне сценария privacy: ${label}`); };
function moduleOf<T>(name: string, explicit: Record<string, unknown>, mutation?: Mutation): T {
  let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation?.file === name) {
    assert.equal(source.split(mutation.from).length - 1, 1, 'единственный якорь privacy'); source = source.replace(mutation.from, mutation.to);
  }
  // Недостижимые импорты закрыты, а не заменены вычислением: любое обращение прекращает тест.
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
        error: (...args: unknown[]) => warnings.push(`${name}:error:${args.map(String).join(' ')}`), log() {} },
      require(id: string) { if (!Object.hasOwn(deps, id)) unexpected.push(`require:${name}:${id}`);
        assert.equal(Object.hasOwn(deps, id), true, `явный импорт privacy ${id}`); return deps[id]; } });
  return module.exports as T;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function waitForPush(work: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([work, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new assert.AssertionError({ message: 'R212-push-await: разрешённый пуш достиг физической границы', actual: 0, expected: 1, operator: 'strictEqual' })), 4000);
  })]); } finally { if (timer) clearTimeout(timer); }
}
async function fixture(mutation?: Mutation) {
  await Promise.all(deliveries);
  await truncateAll(t.raw);
  const warningStart = warnings.length;
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'privacy_local', displayName: 'Получатель', passwordHash: 'fixture', verified: true, approvedAt: new Date(), messagePrivacy: 'contacts' },
    { id: 'shadow', username: 'privacy_shadow', displayName: profile.displayName, passwordHash: 'fixture', verified: true, approvedAt: new Date(), homeInstanceId: peer, homeUserId: 'remote', homeUsername: profile.username },
  ]);
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: 'peer.invalid', apiBase: 'https://peer.invalid/api', clientOrigin: 'https://peer.invalid', rootKey: 'fixture', state: 'active', features: ['dm1', 'dm3'] });
  const saved = (await t.db.select().from(schema.federationLinks))[0]!; assert.equal(saved.state, 'active');
  const link: StoredLink = { ...saved, state: 'active' };
  // PGlite имеет одно соединение: SQL крючка внутри applyMessage должен идти в тот же настоящий tx,
  // а не ждать самого себя через второй запрос вне транзакции. SQL/результаты не подменяются.
  let activeTx: typeof t.db | undefined;
  const gateDb = new Proxy(t.db, { get(db, name) {
    const owner = activeTx ?? db, value = Reflect.get(owner, name); return typeof value === 'function' ? value.bind(owner) : value;
  } });
  const acceptDb = new Proxy(t.db, { get(db, name) {
    if (name === 'transaction') return async (callback: (tx: typeof t.db) => Promise<unknown>) => db.transaction(async tx => {
      const previous = activeTx; activeTx = tx as unknown as typeof t.db;
      try { return await callback(tx as unknown as typeof t.db); } finally { activeTx = previous; }
    });
    const value = Reflect.get(db, name); return typeof value === 'function' ? value.bind(db) : value;
  } });
  const privacy = moduleOf<typeof import('../src/messagePrivacy.js')>('messagePrivacy', { 'drizzle-orm': orm, './db/index.js': { db: gateDb }, './db/schema.js': schema,
    './lastSeenRules.js': lastSeenRules, './messagePrivacyRules.js': privacyRules });
  const blocks = moduleOf<typeof import('../src/blocks.js')>('blocks', { 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema });
  const peers = moduleOf<typeof import('../src/db/peerQueries.js')>('db/peerQueries', { 'drizzle-orm': orm, './index.js': { db: t.db } });
  const getLink = async () => link;
  const guest = moduleOf<typeof import('../src/federation/guestHost.js')>('federation/guestHost', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, 'node:crypto': { randomUUID }, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../auth.js': { hashPassword: forbidden('теневая строка уже есть') }, '../authRules.js': authRules, './guestRules.js': guestRules,
    './links.js': { getLink }, './avatars.js': { refreshGuestAvatar: forbidden('аватар не загружаем') },
  });
  const counts = new Map<string, number>(), windows = new Map<string, number>(), events: { userId: string; event: unknown }[] = [], pushes: string[][] = [];
  const guard = moduleOf<typeof import('../src/authGuard.js')>('authGuard', { '@gusvoice/shared': shared, './authRules.js': authRules, './pushRules.js': pushRules,
    './realtime.js': { redisPub: { async incr(id: string) { const n = (counts.get(id) ?? 0) + 1; counts.set(id, n); return n; }, async expire(id: string, n: number) { windows.set(id, n); }, async ttl(id: string) { return windows.get(id) ?? 60; } } } });
  const threats = moduleOf<typeof import('../src/linkThreats.js')>('linkThreats', { './env.js': { env: { linkThreats: { enabled: false, urls: [], files: [] } } },
    './linkThreatsRules.js': threatRules, 'node:fs/promises': { readFile: forbidden('чтение списка угроз') } });
  const serialize = moduleOf<typeof import('../src/serialize.js')>('serialize', {
    '@gusvoice/shared': shared, './superAdminRules.js': superAdminRules, './statusRules.js': statusRules, './shopRules.js': shopRules,
    './callRules.js': callRules, './lastSeenRules.js': lastSeenRules, './env.js': { env: {} }, './linkThreats.js': threats,
    './federation/instanceLabels.js': { instanceLabel: (instanceId: string) => ({ instanceId, name: 'Сосед', domain: 'peer.invalid', reports: false }) },
  });
  const conversations = moduleOf<typeof import('../src/conversations.js')>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './convRules.js': rules, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './dmWriteBarrier.js': barrier, './env.js': { env: {} }, './util.js': { uuidv7: randomUUID }, './serialize.js': serialize,
    './realtime.js': { publishToUser: async (userId: string, event: unknown) => { events.push({ userId, event }); } },
  });
  const changes = moduleOf<typeof import('../src/federation/convChanges.js')>('federation/convChanges', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
  });
  conversations.configureFederatedConv({ selfInstanceId: () => self, record: changes.recordFedConvChanges });
  const trackedConversations = { ...conversations, deliver(d: Parameters<typeof conversations.deliver>[0]) {
    const work = conversations.deliver(d); deliveries.push(work); return work;
  } };
  const contacts = moduleOf<typeof import('../src/contacts.js')>('contacts', { 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema, './contactRules.js': contactRules,
    './messagePrivacy.js': privacy });
  const pushed = deferred<void>();
  const fan = moduleOf<typeof import('../src/convSendFanout.js')>('convSendFanout', {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema, './conversations.js': trackedConversations,
    './authGuard.js': guard, './contacts.js': contacts, './contactRules.js': contactRules, './groupRules.js': groupRules,
    './push.js': { ...pushRules, sendPushToUsers: async (ids: string[]) => { pushes.push([...ids]); pushed.resolve(); } },
  });
  const accept = moduleOf<typeof import('../src/federation/convAccept.js')>('federation/convAccept', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../conversations.js': trackedConversations, '../convRules.js': rules,
    '../convSendFanout.js': fan, '../db/index.js': { db: acceptDb }, '../db/schema.js': schema,
  }, mutation);
  accept.configureFedMessagePrivacy(privacy.messageAllowedFor);
  const entered = deferred<void>(), answer = deferred<unknown>(); let mode: 'hold' | 'lost' = 'lost';
  const open = moduleOf<typeof import('../src/federation/convOpen.js')>('federation/convOpen', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../authGuard.js': guard, '../blocks.js': blocks, '../conversations.js': trackedConversations,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema, '../db/peerQueries.js': peers, '../dmRules.js': dmRules,
    '../instanceSetup.js': { fedDmPolicy: async () => 'anyone' }, '../userSearchRules.js': userSearchRules, '../util.js': { uuidv7: () => proposedId },
    './directorySync.js': { refreshCapabilities: async () => link.features }, './guestHost.js': guest, './links.js': { getLink },
    './instance.js': { federation: { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'fixture', privateKeyDer: new Uint8Array([1]) }) } },
    './peerClient.js': { postSignedToPeer: async () => { entered.resolve(); return mode === 'hold' ? answer.promise : { ok: false }; } },
  }, mutation);
  open.configureFedOpenPrivacy((sender, recipient) => privacy.messageAllowedFor(sender ?? '', recipient));
  const message = (id: string, service: Record<string, unknown> | null = null, editVersion = 0, deleted = false) => shared.serializeConvMessageWire({
    id, conversationId: incomingId, author: { instanceId: peer, userId: 'remote' }, clientId: null, payloadHash: null, createdAt: 1_700_000_000_000,
    originSortKey: 1, content: editVersion ? 'Правка' : 'Привет', replyToId: null, replyQuote: null, forwardedFrom: null,
    silent: false, noPreview: false, captionAbove: false, sticker: null, service, attachments: [], editVersion, editedAt: editVersion ? 1_700_000_000_001 : null, deleted,
  });
  return { privacy, open, accept, conversations, events, pushes, counts, link, message, pushed,
    hold() { mode = 'hold'; }, entered, answer,
    async clean(expected: string[] = []) { await Promise.all(deliveries); await t.raw.query('SELECT 1');
      assert.deepEqual(unexpected, [], 'все исполняемые вычисления настоящие, непредусмотренный IO не поглощён catch');
      assert.deepEqual(warnings.slice(warningStart), expected); } };
}
const request = () => shared.serializeConvOpenRequest({ instanceId: peer, conversationId: incomingId,
  from: { userId: 'remote', ...profile }, toUserId: 'local', sharedServerIds: [], createdAt: 1 });
const row = (id = incomingId) => shared.serializeConvWire({ id, kind: 'direct', title: null, members: [{ instanceId: self, userId: 'local' }, { instanceId: peer, userId: 'remote' }], originInstanceId: peer, createdAt: 1 });
async function direct(f: Awaited<ReturnType<typeof fixture>>) {
  assert.ok(await f.conversations.createDirect('shadow', 'local', { id: incomingId, originInstanceId: peer }));
}
async function deniedOpen(mutation?: Mutation) {
  const f = await fixture(mutation), answer = await f.open.acceptConvOpen(f.link, request());
  assert.equal(answer.body.reason, 'privacy', 'R212-open-privacy: отказ имеет отдельную причину privacy');
  assert.equal(answer.status, 403); assert.equal((await t.db.select().from(schema.conversations)).length, 0); assert.equal(f.counts.size, 0);
  await f.clean();
}
test('R212 соседу отказано с privacy до создания беседы и расходования лимита', () => deniedOpen());
test('R212 everyone и контакт получателя принимают открытие; отсутствие hook сохраняет старую политику', async () => {
  for (const mode of ['everyone', 'contact', 'no-hook'] as const) {
    const f = await fixture();
    if (mode === 'everyone') await t.db.update(schema.users).set({ messagePrivacy: 'everyone' }).where(orm.eq(schema.users.id, 'local'));
    if (mode === 'contact') await t.db.insert(schema.userContacts).values({ ownerId: 'local', contactId: 'shadow' });
    if (mode === 'no-hook') f.open.configureFedOpenPrivacy(null);
    const answer = await f.open.acceptConvOpen(f.link, request()); assert.equal(answer.status, 200); assert.equal(answer.body.ok, true);
    assert.equal((await t.db.select().from(schema.conversations)).length, 1);
    await f.clean();
  }
});
async function reciprocal(mutation?: Mutation) {
  const f = await fixture(mutation); f.hold(); const outgoing = f.open.openFederatedDirect('local', { instanceId: peer, homeUserId: 'remote' });
  await f.entered.promise;
  try {
    const incoming = await f.open.acceptConvOpen(f.link, request());
    assert.equal(incoming.body.ok, true, 'R212-open-mine: встречное открытие не режется приватностью');
    assert.equal(incoming.status, 200); assert.equal((await t.db.select().from(schema.conversations))[0]?.id, incomingId);
  } finally {
    f.answer.resolve({ ok: true, value: { status: 200, body: JSON.stringify(shared.serializeConvOpenResponse({ kind: 'exists', conversationId: incomingId, to: profile })) } });
    await outgoing;
  }
  await f.clean();
}
test('R212 наш запрос в пути освобождает встречное открытие с меньшим id от privacy', () => reciprocal());
async function deniedRow(mutation?: Mutation) {
  const f = await fixture(mutation);
  assert.equal(await f.open.acceptConvRow(peer, self, incomingId, row()), false, 'R212-row-privacy: строка новой беседы не обходит privacy');
  assert.equal((await t.db.select().from(schema.conversations)).length, 0);
  await f.clean([`federation/convOpen:[fed-dm] ${peer}: строка conv ${incomingId} отклонена (privacy)`]);
}
test('R212 новая строка conv соседа не создаёт запрещённую беседу и возвращает false', () => deniedRow());
async function requestedRow(mutation?: Mutation) {
  const f = await fixture(mutation), outgoing = await f.open.openFederatedDirect('local', { instanceId: peer, homeUserId: 'remote' });
  assert.equal(outgoing.ok, false); assert.equal(!outgoing.ok && outgoing.status, 503);
  assert.equal(await f.open.acceptConvRow(peer, self, proposedId, row(proposedId)), true, 'R212-row-mine: запрошенная нами строка conv не режется privacy');
  assert.equal((await t.db.select().from(schema.conversationMembers)).find(m => m.userId === 'local')?.pending, false);
  await f.clean();
}
test('R212 ответ потерян, но строка с нашим ранее предложенным id принимается вопреки contacts', () => requestedRow());
test('R212 разрешённая строка соседа создаётся, а повтор существующей беседы не пересматривает privacy', async () => {
  const f = await fixture(); await t.db.update(schema.users).set({ messagePrivacy: 'everyone' }).where(orm.eq(schema.users.id, 'local'));
  assert.equal(await f.open.acceptConvRow(peer, self, incomingId, row()), true);
  await t.db.update(schema.users).set({ messagePrivacy: 'contacts' }).where(orm.eq(schema.users.id, 'local'));
  assert.equal(await f.open.acceptConvRow(peer, self, incomingId, row()), true); assert.equal((await t.db.select().from(schema.conversations)).length, 1);
  await f.clean();
});
async function withheld(mutation?: Mutation) {
  const f = await fixture(mutation); await direct(f); await f.accept.applyChange(peer, self, 'msg', incomingId, f.message('withheld'));
  const stored = (await t.db.select().from(schema.conversationMessages))[0]!;
  assert.equal(stored.withheld, true, 'R212-copy-privacy: обычная копия скрыта при отказе');
  assert.equal(stored.content, 'Привет'); assert.equal(f.pushes.length, 0); assert.equal(f.events.some(e => e.userId === 'local'), false);
  assert.equal((await t.db.select().from(schema.userChanges)).some(c => c.userId === 'local' && c.messageId === stored.id), false);
  const history = await f.conversations.history('local', incomingId, { limit: 10 }); assert.ok(history && history !== 'no-anchor'); assert.equal(history.messages.length, 0);
  await f.accept.applyChange(peer, self, 'msg', incomingId, f.message('withheld', null, 1));
  assert.equal((await t.db.select().from(schema.conversationMessages))[0]?.content, 'Правка');
  await f.accept.applyChange(peer, self, 'msg', incomingId, f.message('withheld', null, 2, true));
  assert.ok((await t.db.select().from(schema.conversationMessages))[0]?.deletedAt); assert.equal(f.pushes.length, 0);
  await f.clean();
}
test('R212 запрещённая копия записана withheld без события и пуша получателю, её правка и удаление применяются', () => withheld());
async function visible(service: boolean, mutation?: Mutation) {
  const f = await fixture(mutation); await direct(f);
  if (!service) await t.db.update(schema.users).set({ messagePrivacy: 'everyone' }).where(orm.eq(schema.users.id, 'local'));
  await f.accept.applyChange(peer, self, 'msg', incomingId, f.message('visible', service ? { kind: 'call', callId: 'privacy-call', reason: 'missed', duration: 0 } : null));
  assert.equal((await t.db.select().from(schema.conversationMessages))[0]?.withheld, false, 'R212-call-service: служебная запись звонка не режется message privacy');
  await waitForPush(f.pushed.promise); assert.deepEqual(f.pushes, [['local']]); assert.equal(f.events.some(e => e.userId === 'local'), true);
  const history = await f.conversations.history('local', incomingId, { limit: 10 }); assert.ok(history && history !== 'no-anchor'); assert.equal(history.messages.length, 1);
  await f.clean();
}
test('R212 разрешённая обычная копия появляется в истории и будит получателя', () => visible(false));
test('R212 служебная запись о звонке проходит contacts без контакта и остаётся видимой', () => visible(true));
for (const [label, mutation, check, prefix, actual, expected] of [
  ['удалён отказ открытия', { file: 'federation/convOpen', from: 'if (!mine && messageGate && !(await messageGate(shadowBefore?.id ?? null, target!.id)))', to: 'if (false && messageGate && !(await messageGate(shadowBefore?.id ?? null, target!.id)))' }, deniedOpen, 'R212-open-privacy:', undefined, 'privacy'],
  ['встречное открытие ограничено', { file: 'federation/convOpen', from: 'if (!mine && messageGate && !(await messageGate(shadowBefore?.id ?? null, target!.id)))', to: 'if (messageGate && !(await messageGate(shadowBefore?.id ?? null, target!.id)))' }, reciprocal, 'R212-open-mine:', undefined, true],
  ['строка обходит privacy', { file: 'federation/convOpen', from: 'if (!mine && messageGate && !(await messageGate(shadowBefore?.id ?? null, target.id)))', to: 'if (false && messageGate && !(await messageGate(shadowBefore?.id ?? null, target.id)))' }, deniedRow, 'R212-row-privacy:', true, false],
  ['наша строка ограничена', { file: 'federation/convOpen', from: 'if (!mine && messageGate && !(await messageGate(shadowBefore?.id ?? null, target.id)))', to: 'if (messageGate && !(await messageGate(shadowBefore?.id ?? null, target.id)))' }, requestedRow, 'R212-row-mine:', false, true],
  ['копия не скрывается', { file: 'federation/convAccept', from: 'messageGate !== null && !(await messageGate(author.id, recipients[0]!.id))', to: 'false && messageGate !== null && !(await messageGate(author.id, recipients[0]!.id))' }, withheld, 'R212-copy-privacy:', false, true],
  ['служебная запись скрывается', { file: 'federation/convAccept', from: 'recipients.length === 1 && !w.service && messageGate', to: 'recipients.length === 1 && messageGate' }, (m?: Mutation) => visible(true, m), 'R212-call-service:', true, false],
] as const) test(`R212 строгий контрфакт федерации: ${label}`, async () => {
  await check(); await assert.rejects(check(mutation), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
});
