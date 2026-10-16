import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as callRules from '../src/callRules.js';
import * as lastSeenRules from '../src/lastSeenRules.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as contactRules from '../src/contactRules.js';
import * as groupRules from '../src/groupRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';
import type { StoredLink } from '../src/federation/linkService.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
beforeEach(async () => { await truncateAll(t.raw); });
after(async () => { await t.close(); });
type Mutation = { file: string; from: string; to: string };
const self = 'a'.repeat(32), peer = 'b'.repeat(32);
const conv = 'fed-call-direct', callId = 'fed-call-id', NOW = 2_000_000_000_000;
const guard = (label: string) => () => { throw new Error(`неисполняемая граница ${label}`); };
function moduleOf<T>(name: string, deps: Record<string, unknown>, mutation?: Mutation): T {
  let code = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation?.file === name) { assert.equal(code.split(mutation.from).length, 2, 'единственный якорь calls'); code = code.replace(mutation.from, mutation.to); }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Date, Buffer, URL, console: { log() {}, warn() {}, error: guard('console.error') },
    setTimeout: guard('timer'), setInterval: guard('interval'),
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `явный импорт ${id}`); return deps[id]; },
  });
  return module.exports as T;
}
async function fixture(mutation?: Mutation) {
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'call_local', displayName: 'Получатель', passwordHash: 'fixture', callPrivacy: 'everyone' },
    { id: 'other', username: 'call_other', displayName: 'Другой', passwordHash: 'fixture' },
    { id: 'shadow', username: 'call_shadow', displayName: 'Звонящий', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'remote' },
  ]);
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: 'peer.invalid', apiBase: 'https://peer.invalid/api', clientOrigin: 'https://peer.invalid', rootKey: 'fixture', state: 'active', features: ['dmcall1'] });
  await t.db.insert(schema.conversations).values([
    { id: conv, kind: 'direct', directKey: `${self}:local|${peer}:remote`, createdBy: 'local' },
    { id: 'local-direct', kind: 'direct', directKey: 'local:other', createdBy: 'local' },
    { id: 'saved', kind: 'direct', directKey: 'local:local', createdBy: 'local' },
    { id: 'group', kind: 'group', createdBy: 'local' },
  ]);
  await t.db.insert(schema.conversationMembers).values([
    { conversationId: conv, userId: 'local' }, { conversationId: conv, userId: 'shadow' },
    { conversationId: 'local-direct', userId: 'local' }, { conversationId: 'local-direct', userId: 'other' },
    { conversationId: 'saved', userId: 'local' }, { conversationId: 'group', userId: 'local' }, { conversationId: 'group', userId: 'shadow' },
  ]);
  const deliveries: unknown[] = [];
  const deliver = async (d: unknown) => { deliveries.push(d); };
  const c = moduleOf<typeof import('../src/conversations.js')>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './convRules.js': rules, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './dmWriteBarrier.js': { dmWriteBarrier: guard('write barrier') },
    './attachments.js': { attachmentLink: guard('attachmentLink'), attachmentStore: {}, copyForForward: guard('copyForForward'), DailyQuotaError: class extends Error {}, discardForwardCopies: guard('discardForwardCopies'), privateAttachmentsReady: guard('privateAttachmentsReady'), purgeDeleted: guard('purgeDeleted') },
    './env.js': { env: {} }, './util.js': { uuidv7: randomUUID },
    './serialize.js': { homeInstanceOf: (u: any) => u?.homeInstanceId ? { instanceId: u.homeInstanceId, name: 'Сосед', domain: 'peer.invalid', reports: false } : null, serializeMessage: guard('serializeMessage') },
  }, mutation);
  const blocks = moduleOf<typeof import('../src/blocks.js')>('blocks', { 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema });
  const privacy = moduleOf<typeof import('../src/callPrivacy.js')>('callPrivacy', {
    'drizzle-orm': orm, './callRules.js': callRules, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './db/peerQueries.js': { isAcceptedPeer: async () => true }, './lastSeenRules.js': lastSeenRules,
  });
  const link = async (): Promise<StoredLink> => { const r = (await t.db.select().from(schema.federationLinks))[0]!; assert.equal(r.state, 'active'); return { ...r, state: 'active' }; };
  let ring: 'ok' | 'busy' = 'ok'; const rings: shared.DmCall[] = [];
  let status: number | null = 200; let answer: shared.FedCallInviteAnswer = { ok: true };
  let refreshed: string[] | undefined;
  const refreshes: string[] = [], requests: any[] = [], events: unknown[][] = [];
  const dm = moduleOf<typeof import('../src/federation/dmCalls.js')>('federation/dmCalls', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../blocks.js': blocks, '../callPrivacy.js': privacy, '../callRules.js': callRules,
    '../calls.js': { ringRemote: async (call: shared.DmCall) => { rings.push(call); return ring; }, applyRemoteState: guard('event applyRemoteState') },
    '../conversations.js': { ...c, deliver }, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    './directorySync.js': { refreshCapabilities: async (l: { instanceId: string; features: string[] }) => { refreshes.push(l.instanceId); return refreshed ?? l.features; } },
    './eventStream.js': { onFedEvent: guard('onFedEvent'), sendEventTo: async (...args: unknown[]) => { events.push(args); } },
    './guestHost.js': { shadowUserFor: async (home: string, userId: string) => (await t.db.select().from(schema.users).where(orm.and(orm.eq(schema.users.homeInstanceId, home), orm.eq(schema.users.homeUserId, userId))).limit(1))[0] ?? null },
    './instance.js': { federation: { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'fixture', privateKeyDer: new Uint8Array([1]) }) } },
    './instanceMeta.js': { readInstanceMeta: async () => ({ paused: false }) }, './linkRules.js': linkRules,
    './links.js': { getLink: async (id: string) => id === peer ? link() : null },
    './peerClient.js': { postSignedToPeer: async (arg: unknown) => { requests.push(arg); return status === null ? { ok: false } : { ok: true, value: { status, body: JSON.stringify(shared.serializeCallInviteAnswer(answer)) } }; } },
  }, mutation);
  const fanout: any[] = [], pushes: string[][] = [], pushWork: Promise<void>[] = [], done: (() => void)[] = [];
  const fan = moduleOf<typeof import('../src/convSendFanout.js')>('convSendFanout', {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema, './conversations.js': { ...c, deliver },
    './authGuard.js': { pushBurst: async () => { pushWork.push(new Promise<void>(resolve => { done.push(resolve); })); return 'loud'; } },
    './contacts.js': { contactNamesFor: async () => new Map() }, './contactRules.js': contactRules, './groupRules.js': groupRules,
    './push.js': { contentPreview: (s: string) => s, pushAlwaysUsers: guard('group pushAlwaysUsers'), pushThrottleSource: (id: string) => id, stickerPushText: () => 'Стикер',
      withSilent: (p: unknown) => p, sendPushToUsers: async (ids: string[]) => { pushes.push([...ids]); done.shift()?.(); } },
  });
  const accept = moduleOf<typeof import('../src/federation/convAccept.js')>('federation/convAccept', {
    'drizzle-orm': orm, '@gusvoice/shared': shared, '../conversations.js': { ...c, deliver }, '../convRules.js': rules,
    '../convSendFanout.js': { fanOutSend: async (arg: Parameters<typeof fan.fanOutSend>[0]) => { fanout.push(arg); await fan.fanOutSend(arg); } },
    '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    './convLink.js': { notePeerAnswer: guard('notePeerAnswer'), onLinkRestored: guard('onLinkRestored') },
    './eventStream.js': { onFedEvent: guard('onFedEvent'), sendEventTo: guard('sendEventTo') },
    './instance.js': { federation: { identity: () => ({ instanceId: self }), signingKey: guard('signingKey') } },
    './peerClient.js': { getSignedFromPeer: guard('getSignedFromPeer') },
  }, mutation);
  accept.configureFedCallRecord({ plan: dm.callRecordPlanFor, read: dm.callRecordCopied });
  async function copy(reason: shared.CallEndReason, id = 'call-record') {
    await accept.applyChange(peer, self, 'msg', conv, shared.serializeConvMessageWire({ id, conversationId: conv, author: { instanceId: peer, userId: 'remote' }, clientId: null, payloadHash: null,
      createdAt: Date.now(), originSortKey: 1, content: 'Звонок', replyToId: null, forwardedFrom: null, silent: false, noPreview: false, captionAbove: false, replyQuote: null, sticker: null,
      service: { kind: 'call', callId, reason, duration: reason === 'hangup' ? 12 : 0 }, attachments: [], editVersion: 0, editedAt: null, deleted: false }));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(pushWork), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new assert.AssertionError({ message: 'пуш копии дошёл до IO-границы' })), 5000); })]);
    } finally { if (timeout) clearTimeout(timeout); }
  }
  return { dm, c, accept, blocks, link, rings, refreshes, requests, events, fanout, pushes, copy, deliveries,
    busy: (value: typeof ring) => { ring = value; }, status: (value: typeof status) => { status = value; },
    answer: (value: typeof answer) => { answer = value; }, refreshed: (value: string[]) => { refreshed = value; } };
}
function invite(overrides: Partial<shared.FedCallInvite> = {}) {
  return shared.serializeCallInvite({ instanceId: peer, callId, conversationId: conv, fromUserId: 'remote', toUserId: 'local', video: true, createdAt: NOW - 1000, expiresAt: NOW + 1000, ...overrides });
}
function outgoing(): shared.DmCall {
  return { id: callId, conversationId: conv, callerId: 'local', calleeId: 'shadow', phase: 'ringing', callerDevice: 'pc', createdAt: new Date(NOW).toISOString(), video: true };
}
test('R200 приглашение просрочено или не с нашим собеседником недоступно, подходящая живая пара звонит', async () => {
  const f = await fixture(); const l = await f.link();
  for (const body of [invite({ expiresAt: NOW }), invite({ fromUserId: 'unknown' }), invite({ conversationId: 'missing' }), invite({ conversationId: 'local-direct' }), invite({ conversationId: 'group' }), invite({ conversationId: 'saved' })]) {
    const r = await f.dm.acceptCallInvite(l, body, NOW); assert.equal(r.body.refused, 'unavailable'); assert.equal(f.rings.length, 0);
  }
  await t.db.update(schema.users).set({ deletedAt: new Date() }).where(orm.eq(schema.users.id, 'local'));
  assert.equal((await f.dm.acceptCallInvite(l, invite(), NOW)).body.refused, 'unavailable');
  await t.db.update(schema.users).set({ deletedAt: null }).where(orm.eq(schema.users.id, 'local'));
  assert.equal((await f.dm.acceptCallInvite(l, invite({ expiresAt: NOW + 1 }), NOW)).body.ok, true);
  assert.equal(f.rings[0].callerId, 'shadow'); assert.equal(f.rings[0].calleeId, 'local'); assert.equal(f.rings[0].host?.instanceId, peer);
});
async function blockScenario(mutation?: Mutation) {
  const f = await fixture(mutation); const l = await f.link();
  for (const [one, two] of [['shadow', 'local'], ['local', 'shadow']]) {
    await f.blocks.blockUser(one, two);
    assert.equal((await f.dm.acceptCallInvite(l, invite(), NOW)).body.refused, 'unavailable', `блок ${one}→${two} не раскрывает и не будит`);
    assert.equal(f.rings.length, 0); await f.blocks.unblockUser(one, two);
  }
  assert.equal((await f.dm.acceptCallInvite(l, invite(), NOW)).body.ok, true); assert.equal(f.rings.length, 1);
}
test('R200 блокировка в обе стороны одинаково маскируется unavailable, после снятия пара звонит', async () => { await blockScenario(); });
test('R200 privacy отдаёт privacy, always пускает, busy приходит только после всех проверок', async () => {
  const f = await fixture(); const l = await f.link();
  await t.db.update(schema.users).set({ callPrivacy: 'nobody' }).where(orm.eq(schema.users.id, 'local'));
  assert.equal((await f.dm.acceptCallInvite(l, invite(), NOW)).body.refused, 'privacy'); assert.equal(f.rings.length, 0);
  await t.db.insert(schema.privacyExceptions).values({ ownerId: 'local', targetId: 'shadow', key: 'calls', kind: 'always' });
  assert.equal((await f.dm.acceptCallInvite(l, invite(), NOW)).body.ok, true);
  f.busy('busy'); assert.equal((await f.dm.acceptCallInvite(l, invite({ callId: 'second-call' }), NOW)).body.refused, 'busy');
  assert.equal((await f.dm.acceptCallInvite(l, { ...invite(), instance_id: 'c'.repeat(32) }, NOW)).status, 400);
});
for (const status of [404, 500, 503, 429, null] as const) test(`R200 ответ приглашению ${status ?? 'сеть'} даёт ${status === 404 ? 'unsupported' : 'peer_unreachable'}`, async () => {
  const f = await fixture(); f.status(status);
  const result = await f.dm.inviteRemote(outgoing(), peer, NOW);
  assert.equal(result?.status, status === 404 ? 409 : 503); assert.equal(result?.error, status === 404 ? shared.FED_ERRORS.unsupported : shared.FED_ERRORS.peerUnreachable);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].path, '/api/fed/v1/call/invite');
  assert.equal(f.requests[0].payload.to_user_id, 'remote'); assert.equal(f.requests[0].payload.from.user_id, 'local');
  assert.deepEqual([...f.requests[0].allowHosts], ['peer.invalid']);
});
test('R200 ответы busy/privacy/unavailable сохраняют адресные коды, ok разрешает звонок', async () => {
  const f = await fixture();
  for (const [refused, status, error] of [['busy', 409, shared.CALL_BUSY_ERROR], ['privacy', 403, shared.CALL_PRIVACY_ERROR], ['unavailable', 403, 'Позвонить нельзя']] as const) {
    f.answer({ refused }); const r = await f.dm.inviteRemote(outgoing(), peer, NOW); assert.equal(r?.status, status); assert.equal(r?.error, error);
  }
  f.answer({ ok: true }); assert.equal(await f.dm.inviteRemote(outgoing(), peer, NOW), null);
});
test('R200 сосед без dmcall1 перечитывается и получает unsupported, свежая визитка открывает invite', async () => {
  const f = await fixture(); await t.db.update(schema.federationLinks).set({ features: ['dm4'] });
  const denied = await f.dm.inviteRemote(outgoing(), peer, NOW); assert.equal(denied?.error, shared.FED_ERRORS.unsupported); assert.equal(f.requests.length, 0); assert.equal(f.refreshes.length, 1);
  f.refreshed(['dmcall1']); assert.equal(await f.dm.inviteRemote(outgoing(), peer, NOW), null); assert.equal(f.requests.length, 1);
});
test('R200 homesWithoutCalls и сводка fedNoCalls выделяют только удалённую 1:1 без dmcall1', async () => {
  const f = await fixture(); await t.db.update(schema.federationLinks).set({ features: ['dm4'] });
  assert.deepEqual([...await f.dm.homesWithoutCalls([peer, peer, 'missing'])].sort(), ['missing', peer].sort()); assert.equal(f.refreshes.length, 1);
  f.c.configureFederatedConv({ selfInstanceId: () => self, record: null, noCalls: f.dm.homesWithoutCalls });
  const list = await f.c.listConversations('local', true);
  assert.equal(list.conversations.find(c => c.id === conv)?.fedNoCalls, true);
  for (const id of ['local-direct', 'saved', 'group']) assert.equal(list.conversations.find(c => c.id === id)?.fedNoCalls, undefined);
  await t.db.update(schema.federationLinks).set({ features: ['dmcall1'] });
  assert.equal((await f.c.listConversations('local', true)).conversations.find(c => c.id === conv)?.fedNoCalls, undefined);
});
async function recordScenario(mutation?: Mutation) {
  const f = await fixture(mutation); await f.copy('hangup', 'hangup-record');
  assert.equal(f.pushes.length, 0, 'состоявшийся звонок не будит копией записи');
  assert.equal(f.fanout[0].notifyRecipient, false); assert.equal(f.fanout[0].silent, true);
  const [member] = await t.db.select().from(schema.conversationMembers).where(orm.and(orm.eq(schema.conversationMembers.conversationId, conv), orm.eq(schema.conversationMembers.userId, 'local')));
  const [row] = await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, 'hangup-record'));
  assert.equal(member.lastReadKey, row.sortKey, 'дом получателя читает тихую копию записи звонка');
  await f.copy('missed', 'missed-record');
  assert.deepEqual(f.pushes, [['local']]); assert.equal(f.fanout[1].notifyRecipient, true); assert.equal(f.fanout[1].silent, false);
  const [after] = await t.db.select().from(schema.conversationMembers).where(orm.and(orm.eq(schema.conversationMembers.conversationId, conv), orm.eq(schema.conversationMembers.userId, 'local')));
  assert.equal(after.lastReadKey, member.lastReadKey, 'пропущенный остаётся непрочитанным');
}
test('R200 convAccept с callPlan тихо читает hangup, а missed остаётся непрочитанным и будит настоящую fanout-ветку', async () => { await recordScenario(); });
test('R200 удаление callPlan поймано лишним пушем состоявшегося звонка', async () => {
  await recordScenario(); await truncateAll(t.raw);
  await assert.rejects(recordScenario({ file: 'federation/convAccept', from: 'const callPlan = service && callRecordHooks ? callRecordHooks.plan(service as { kind?: unknown; reason?: unknown }) : null;', to: 'const callPlan = null;' }),
    e => e instanceof assert.AssertionError && e.message.includes('состоявшийся звонок не будит'));
});
for (const [name, from, to, failure] of [
  ['снят блок звонящего', '(await isBlockedBy(caller.id, inv.toUserId)) || ', '', 'блок shadow→local'],
  ['снят блок получателя', ' || (await isBlockedBy(inv.toUserId, caller.id))', '', 'блок local→shadow'],
]) test(`R200 мутант «${name}» пойман unavailable без раскрытия блокировки`, async () => {
  await blockScenario(); await truncateAll(t.raw);
  await assert.rejects(blockScenario({ file: 'federation/dmCalls', from, to }), e => e instanceof assert.AssertionError && e.message.includes(failure));
});
