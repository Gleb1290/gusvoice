import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as callRules from './callRules.js';

type Calls = typeof import('./calls.js');
type Mutation = readonly [string, string];
const NOW = 2_000_000_000_000;
const home = 'b'.repeat(32);
const source = readFileSync(new URL('./calls.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function fixture(mutation?: Mutation) {
  let now = NOW, serial = 0;
  class ClockDate extends Date { constructor(value?: number | string) { super(value ?? now); } static now() { return now; } }
  const timers = new Map<object, { at: number; fn: () => void; repeat?: number }>();
  const schedule = (fn: () => void, ms: number, repeat = false) => { const id = { unref() {} }; timers.set(id, { at: now + ms, fn, ...(repeat ? { repeat: ms } : {}) }); return id; };
  const published: { user: string; call: shared.DmCall; options?: unknown }[] = [];
  const pushes: { users: string[]; payload: unknown }[] = [];
  const unread: unknown[][] = [];
  const records: any[] = [], fanout: any[] = [], reads: unknown[][] = [];
  const redis: { kind: string; id: string; value?: string }[] = [];
  const users = { id: 'id', homeInstanceId: 'home', displayName: 'name', username: 'username', avatarUrl: 'avatar' };
  const members = { lastReadKey: 'read', conversationId: 'conv', userId: 'user' };
  const db = { select: () => ({ from: (table: unknown) => ({ where: (condition: { value?: string }) => ({ limit: async () => table === users ? [
    { home: condition.value?.startsWith('shadow') ? home : null, displayName: 'Звонящий', username: 'caller', avatarUrl: null },
  ] : [{ lastReadKey: 42 }] }) }) }) };
  const deps: Record<string, unknown> = {
    'node:crypto': { randomUUID: () => `call-${++serial}` }, '@gusvoice/shared': shared,
    'drizzle-orm': { eq: (_field: unknown, value: string) => ({ value }), and: () => ({}) }, './callRules.js': callRules,
    './conversations.js': {
      loadAccess: async (conversationId: string, userId: string) => ({ conversationId, userId, kind: 'direct', peerId: userId === 'local' ? 'shadow' : 'local' }),
      sendMessage: async (_me: string, _access: unknown, data: any) => { records.push(data); return { kind: 'created', row: { sortKey: 100 }, delivery: {} }; },
      markRead: async (...args: unknown[]) => { reads.push(args); return { kind: 'ok', delivery: {} }; }, deliver: async () => {},
    },
    './convSendFanout.js': { fanOutSend: async (arg: any) => { fanout.push(arg); } },
    './contacts.js': { contactNamesFor: async () => new Map() }, './db/index.js': { db }, './db/schema.js': { users, conversationMembers: members },
    './env.js': { env: { livekit: { urlExternal: 'wss://fixture.invalid' } } },
    './livekit.js': { createVoiceToken: async () => 'fixture-token', removeFromOtherRooms: async () => {} },
    './push.js': { sendPushToUsers: async (ids: string[], payload: unknown) => { pushes.push({ users: [...ids], payload }); }, sendReadSyncPush: async (...args: unknown[]) => { unread.push(args); } },
    './realtime.js': {
      publishToUser: async (user: string, msg: { call: shared.DmCall }, options?: unknown) => { published.push({ user, call: msg.call, options }); },
      redisPub: { hset: async (_key: string, id: string, value: string) => { redis.push({ kind: 'save', id, value }); }, hdel: async (_key: string, id: string) => { redis.push({ kind: 'delete', id }); }, hgetall: async () => ({}) },
    },
  };
  let code = source;
  if (mutation) { assert.equal(code.split(mutation[0]).length, 2, 'единственный якорь calls'); code = code.replace(...mutation); }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Date: ClockDate, console: { error: (...args: unknown[]) => { throw new Error(`неожиданная ошибка calls: ${args[0]}`); } },
    setTimeout: (fn: () => void, ms: number) => schedule(fn, ms), clearTimeout: (id: object) => { timers.delete(id); },
    setInterval: (fn: () => void, ms: number) => schedule(fn, ms, true), clearInterval: (id: object) => { timers.delete(id); },
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `явный импорт ${id}`); return deps[id]; },
  });
  const calls = module.exports as Calls;
  const tick = async (ms: number) => {
    now += ms;
    for (const [id, job] of [...timers]) if (job.at <= now) { if (job.repeat) job.at = now + job.repeat; else timers.delete(id); job.fn(); }
    // Только немедленные fake IO: 20 turns покрывают publish → read-sync цепочку, реального ожидания нет.
    await settle();
  };
  return { calls, published, pushes, unread, records, fanout, reads, redis, timers, tick };
}
function incoming(id = 'incoming', calleeId = 'local'): shared.DmCall {
  return { id, conversationId: 'conv', callerId: 'shadow', calleeId, phase: 'ringing', createdAt: new Date(NOW).toISOString(), callerDevice: 'remote', host: { instanceId: home, apiBase: 'https://peer.invalid/api' } };
}
test('R200 теневой собеседник без hooks недоступен, отказ invite удаляет карту без Redis, записи и таймера', async () => {
  const f = fixture();
  const noHook = await f.calls.startCall('local', 'shadow', 'conv', 'pc');
  assert.equal(noHook.kind, 'refused'); assert.equal(noHook.kind === 'refused' && noHook.status, 409);
  assert.equal(noHook.kind === 'refused' && noHook.error, shared.FED_ERRORS.dmUnavailable);
  assert.equal(f.timers.size, 0);
  f.calls.configureFedCalls({ invite: async () => ({ status: 403, error: shared.CALL_PRIVACY_ERROR }), state() { assert.fail('отказ не публикуется'); } });
  const denied = await f.calls.startCall('local', 'shadow', 'conv', 'pc');
  assert.equal(denied.kind, 'refused'); assert.equal(denied.kind === 'refused' && denied.error, shared.CALL_PRIVACY_ERROR);
  assert.equal(f.calls.callOf('local'), null); assert.equal(f.calls.callOf('shadow'), null);
  assert.equal(f.timers.size, 0); assert.deepEqual(f.redis, []); assert.deepEqual(f.records, []); assert.deepEqual(f.pushes, []);
  f.calls.configureFedCalls({ invite: async () => { throw new Error('fixture-network'); }, state() {} });
  const down = await f.calls.startCall('local', 'shadow', 'conv', 'pc');
  assert.equal(down.kind === 'refused' && down.status, 503); assert.equal(f.calls.callOf('local'), null);
});
async function outgoingScenario(mutation?: Mutation) {
  const f = fixture(mutation); const states: { phase: string; home: string }[] = [];
  f.calls.configureFedCalls({ invite: async (call, target) => { assert.equal(target, home); assert.equal(f.calls.callById(call.id)?.id, call.id); return null; }, state: (call, target) => { states.push({ phase: call.phase, home: target }); } });
  const start = await f.calls.startCall('local', 'shadow', 'conv', 'pc'); assert.equal(start.kind, 'ok'); if (start.kind !== 'ok') return;
  await settle();
  assert.equal(f.pushes.length, 0, 'пуш теневому собеседнику делает только его дом');
  assert.equal(f.published.every(p => p.user === 'local'), true, 'теневая строка не получает местный call.state');
  const answered = await f.calls.act('shadow', start.call.id, 'answer', 'phone'); assert.equal(answered.kind, 'ok');
  if (answered.kind === 'ok') assert.equal(answered.call.calleeDevice, 'phone');
  await f.calls.act('local', start.call.id, 'hangup'); await settle();
  assert.deepEqual(states.map(s => s.phase), ['ringing', 'active', 'ended']); assert.ok(states.every(s => s.home === home));
  assert.equal(f.records.length, 1); assert.equal(f.records[0].service.reason, 'hangup');
  assert.equal(f.reads.length, 0, 'дом звонящего не ставит прочитано теневому собеседнику');
  assert.equal(f.unread.length, 0); assert.equal(f.fanout[0].silent, true); assert.equal(f.fanout[0].notifyRecipient, false);
  assert.equal(f.calls.callOf('local'), null); assert.equal(f.redis.filter(r => r.kind === 'save').length, 2); assert.equal(f.redis.filter(r => r.kind === 'delete').length, 1);
}
test('R200 успешный звонок соседу публикуется только местному, ответ и конец уходят hooks, копия читается в другом доме', async () => { await outgoingScenario(); });
test('R200 местный собеседник по-прежнему получает звонящий пуш, оба состояния и прочитано записи', async () => {
  const f = fixture(); const start = await f.calls.startCall('local', 'other', 'conv', 'pc'); assert.equal(start.kind, 'ok'); if (start.kind !== 'ok') return;
  await settle(); assert.equal(f.pushes.length, 1); assert.deepEqual(f.pushes[0].users, ['other']);
  assert.deepEqual(f.published.map(p => p.user), ['local', 'other']);
  await f.calls.act('other', start.call.id, 'answer', 'phone'); await f.calls.act('local', start.call.id, 'hangup'); await settle();
  assert.equal(f.records.length, 1); assert.equal(f.reads.length, 1); assert.equal(f.reads[0][0], 'other');
  assert.equal(f.unread.length, 1);
});
test('R200 повтор ringRemote идемпотентен, publishRemote только fedcall1, старый callOf не раскрывает удалённое', async () => {
  const f = fixture(); const call = incoming();
  assert.equal(await f.calls.ringRemote(call, NOW + 1000, NOW), 'ok'); await settle();
  assert.equal(await f.calls.ringRemote(call, NOW + 2000, NOW), 'ok'); await settle();
  assert.equal(f.pushes.length, 1); assert.equal(f.published.length, 1); assert.equal(f.timers.size, 1);
  assert.equal(f.published[0].user, 'local'); assert.equal(JSON.stringify(f.published[0].options), JSON.stringify({ cap: 'fedcall1' }));
  assert.equal(f.calls.callOf('local'), null); assert.equal(f.calls.callOf('local', true)?.id, call.id);
  assert.equal(f.calls.callOf('shadow', true), null); assert.equal(f.calls.callById(call.id), null);
});
test('R200 занятость учитывает обе карты: местный звонок блокирует входящий, входящий блокирует новый местный и второй входящий', async () => {
  const local = fixture(); assert.equal((await local.calls.startCall('local', 'other', 'conv', 'pc')).kind, 'ok');
  assert.equal(await local.calls.ringRemote(incoming(), NOW + 1000, NOW), 'busy');
  const remote = fixture(); assert.equal(await remote.calls.ringRemote(incoming(), NOW + 1000, NOW), 'ok');
  assert.equal(await remote.calls.ringRemote(incoming('second'), NOW + 1000, NOW), 'busy');
  assert.equal((await remote.calls.startCall('local', 'other', 'conv', 'pc')).kind, 'busy');
  assert.equal((await remote.calls.startCall('other', 'local', 'conv', 'pc')).kind, 'busy');
});
async function remoteStateScenario(mutation?: Mutation) {
  const f = fixture(mutation); const call = incoming(); await f.calls.ringRemote(call, NOW + 1000, NOW); await settle();
  const state: shared.FedCallState = { callId: call.id, conversationId: call.conversationId, phase: 'active', calleeDevice: 'phone', answeredAt: NOW };
  await f.calls.applyRemoteState('c'.repeat(32), state);
  assert.equal(f.calls.callOf('local', true)?.phase, 'ringing', 'снимок другого дома не меняет фазу');
  await f.calls.applyRemoteState(home, { ...state, conversationId: 'other' });
  assert.equal(f.calls.callOf('local', true)?.phase, 'ringing', 'снимок другой беседы не меняет фазу');
  await f.calls.applyRemoteState(home, state); await settle();
  assert.equal(f.calls.callOf('local', true)?.phase, 'active'); assert.equal(f.calls.callOf('local', true)?.calleeDevice, 'phone');
  assert.equal(f.unread.length, 1); const messages = f.published.length;
  await f.calls.applyRemoteState(home, { ...state, calleeDevice: 'second-phone' });
  assert.equal(f.published.length, messages); assert.equal(f.calls.callOf('local', true)?.calleeDevice, 'phone');
  await f.calls.applyRemoteState(home, { ...state, phase: 'ended', reason: 'hangup', duration: 12 }); await settle();
  assert.equal(f.calls.callOf('local', true), null); assert.equal(f.published.at(-1)?.call.phase, 'ended');
  assert.equal(f.published.at(-1)?.call.duration, 12); assert.equal(f.timers.size, 0); assert.equal(f.records.length, 0); assert.equal(f.redis.length, 0);
}
test('R200 чужой снимок игнорируется, правильный active задаёт устройство, ended снимает карту без дублирования записи', async () => { await remoteStateScenario(); });
async function timerScenario(mutation?: Mutation) {
  const f = fixture(mutation); await f.calls.ringRemote(incoming(), NOW + 1000, NOW); await settle();
  await f.tick(1000 + shared.FED_CALL_GRACE_MS - 1);
  assert.equal(f.calls.callOf('local', true)?.phase, 'ringing', 'звонок ждёт expiresAt плюс весь grace');
  await f.tick(1); assert.equal(f.calls.callOf('local', true), null); assert.equal(f.published.at(-1)?.call.reason, 'missed'); assert.equal(f.unread.length, 1);
  const active = fixture(mutation); await active.calls.ringRemote(incoming(), NOW + 1000, NOW);
  await active.calls.applyRemoteState(home, { callId: 'incoming', conversationId: 'conv', phase: 'active', answeredAt: NOW }); await settle();
  await active.tick(shared.FED_CALL_ACTIVE_MAX_MS - 1);
  assert.equal(active.calls.callOf('local', true)?.phase, 'active', 'активный звонок живёт весь active max');
  await active.tick(1); assert.equal(active.calls.callOf('local', true), null); assert.equal(active.published.at(-1)?.call.reason, 'disconnect');
}
test('R200 фиктивные часы ловят границы grace у звонящего и active max у отвеченного', async () => { await timerScenario(); });
for (const [name, mutation, scenario, failure] of [
  ['ringPush для home', ['if (!l.home) void ringPush(call);', 'void ringPush(call);'], outgoingScenario, 'пуш теневому'],
  ['снимок чужого инстанса', ['r.call.host?.instanceId !== hostInstanceId || ', ''], remoteStateScenario, 'снимок другого дома'],
  ['снимок другой беседы', [' || r.call.conversationId !== s.conversationId', ''], remoteStateScenario, 'снимок другой беседы'],
  ['без grace', ['expiresAt - now + FED_CALL_GRACE_MS', 'expiresAt - now'], timerScenario, 'весь grace'],
  ['сокращён active max', ["remoteTimer(r.call.id, FED_CALL_ACTIVE_MAX_MS, 'disconnect')", "remoteTimer(r.call.id, 1000, 'disconnect')"], timerScenario, 'весь active max'],
] as [string, Mutation, (mutation?: Mutation) => Promise<void>, string][]) {
  test(`R200 мутант calls «${name}» пойман действительным событием или таймером`, async () => {
    await scenario(); await assert.rejects(scenario(mutation), e => e instanceof assert.AssertionError && e.message.includes(failure));
  });
}
