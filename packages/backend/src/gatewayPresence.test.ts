import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './gatewayRules.js';
import * as session from './sessionVisibility.js';
import * as hub from './userVisibilityHub.js';
import * as push from './pushRules.js';
import * as lastSeenRules from './lastSeenRules.js';

type Change = { file: string; from: string; to: string };
function source(file: string, change?: Change) {
  const original = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (!change || change.file !== file) return original;
  assert.equal(original.split(change.from).length, 2, 'точный исходниковый якорь уникален');
  const changed = original.replace(change.from, change.to); assert.notEqual(changed, original); return changed;
}
function execute<T>(code: string, deps: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, ...globals, require: (id: string) => { assert.ok(id in deps, `неожиданный импорт ${id}`); return deps[id]; } });
  return module.exports as T;
}
class Socket {
  messages: Record<string, unknown>[] = [];
  private listeners = new Map<string, (...args: any[]) => unknown>();
  on(event: string, cb: (...args: any[]) => unknown) { this.listeners.set(event, cb); }
  send(data: string) { this.messages.push(JSON.parse(data)); }
  close() { this.listeners.get('close')?.(); }
  async frame(value: unknown) { await this.listeners.get('message')?.(Buffer.from(JSON.stringify(value))); }
}
function setup(change?: Change) {
  let now = 100_000; let next = 0;
  const timers = new Map<object, { at: number; fn: () => void }>();
  class ClockDate extends Date {
    constructor(value?: number) { super(value ?? now); }
    static now() { return now; }
  }
  const tick = async (ms: number) => { now += ms; for (const [id, job] of timers) if (job.at <= now) { timers.delete(id); job.fn(); } await settle(); };
  const lastSeen = new Map<string, Date>();
  const users = { id: 'id', presenceStatus: 'presence', lastSeenAt: 'at', lastSeenPrivacy: 'privacy', hideReadTime: 'hide', deletedAt: 'deleted' };
  const exceptions = {};
  const db = {
    select: () => ({ from: (table: unknown) => ({ where: () => {
      const rows = table === users ? ['subject', 'peer'].map(id => ({ id, s: 'online', presence: 'online', privacy: 'everyone', hideReadTime: false, deletedAt: null, lastSeenAt: lastSeen.get(id) ?? new Date(0) })) : [];
      return Object.assign(Promise.resolve(rows), { limit: async () => rows });
    } }) }),
    update: () => ({ set: (fields: { lastSeenAt: Date }) => ({ where: (condition: { value: string }) => { lastSeen.set(condition.value, fields.lastSeenAt); return Promise.resolve(); } }) }),
  };
  const peers = async () => new Set(['subject', 'peer']);
  const drizzle = { eq: (_field: unknown, value: unknown) => ({ value }), and: (...args: unknown[]) => args, or: (...args: unknown[]) => args, inArray: (...args: unknown[]) => args, sql: () => ({}) };
  class Redis { psubscribe() {} on() {} }
  const schema = { users, lastSeenExceptions: exceptions, conversationMembers: {}, conversations: {}, serverMembers: {} };
  const deps: Record<string, unknown> = {
    ioredis: { default: Redis }, './auth.js': { superAdminId: () => null, verifyToken: (token: string) => ({ sub: token, gen: 0 }), tokenGenValid: async () => true },
    './authGuard.js': { clientIp: () => `ip-${++next}`, rateHit: async () => true },
    './blocks.js': { isBlockedBy: async () => false, onBlockChange() {} }, './db/index.js': { db }, './db/peerQueries.js': { loadPeers: peers, arePeers: async () => true },
    './db/schema.js': schema, 'drizzle-orm': drizzle, './env.js': { env: { redisUrl: 'unused-test-transport' } },
    './gatewayRules.js': rules, './gatewayTyping.js': { relayTyping: async () => {} }, './permissions.js': { getChannelAudience: async () => [], getMemberContext: async () => null },
    './pushRules.js': push, './realtime.js': { publishToChannel() {} }, './sessionVisibility.js': session, './userVisibilityHub.js': hub,
  };
  const globals = { Date: ClockDate, Buffer,
    setTimeout: (fn: () => void, ms: number) => { const id = { unref() {} }; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id: object) => { timers.delete(id); },
  };
  const gateway = execute<{ registerGateway: (app: unknown) => void; isUserOnline: (id: string) => boolean; isUserDmPresent: (id: string) => boolean; isUserActive: (id: string) => boolean }>(source('gateway.ts', change), deps, globals);
  let connect!: (socket: Socket, request: unknown) => void;
  gateway.registerGateway({ get: (_path: string, _options: unknown, handler: typeof connect) => { connect = handler; } });
  const open = async (id: string, hidden = false) => { const socket = new Socket(); connect(socket, {}); await socket.frame({ t: 'identify', token: id, caps: ['presence5'], hidden }); await settle(); return socket; };
  const seen = execute<{ lastSeenFor: (viewer: string, subject: string) => Promise<{ online: boolean; at: string }> }>(source('lastSeen.ts', change), {
    ...deps, './gateway.js': gateway, './lastSeenRules.js': lastSeenRules, './conversations.js': { peerReadKeys: async () => [] },
  }, globals);
  return { ...gateway, open, tick, seen, now: () => now };
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
async function checkHidden(change?: Change) {
  const gate = setup(change); const peer = await gate.open('peer'); const subject = await gate.open('subject'); peer.messages.length = 0;
  await subject.frame({ t: 'active', on: true }); assert.equal(gate.isUserActive('subject'), true);
  await subject.frame({ t: 'visible', on: false }); await gate.tick(1999);
  assert.equal(gate.isUserDmPresent('subject'), true); assert.deepEqual(peer.messages, []);
  await gate.tick(1);
  assert.deepEqual(peer.messages, [{ t: 'online.away', userId: 'subject', away: true }], 'скрытие даёт один away без online.update');
  assert.equal(gate.isUserOnline('subject'), true); assert.equal(gate.isUserDmPresent('subject'), false);
  await subject.frame({ t: 'active', on: true }); assert.equal(gate.isUserActive('subject'), false, 'скрытое соединение не становится активным');
  const seen = await gate.seen.lastSeenFor('peer', 'subject');
  assert.equal(seen.online, false, 'last-seen использует присутствие ЛС, не сокет'); assert.equal(seen.at, new Date(gate.now()).toISOString(), 'last-seen свежий после скрытия');
  peer.messages.length = 0; subject.close(); await settle();
  assert.deepEqual(peer.messages, [{ t: 'online.update', userId: 'subject', online: false }, { t: 'online.away', userId: 'subject', away: false }], 'выход рассылается строго раньше снятия away');
  assert.equal(gate.isUserOnline('subject'), false); peer.close();
}
it('шлюз: скрытие через 2с, D10, last-seen и порядок offline перед away:false', async () => { await checkHidden(); });
it('шлюз: скрытый identify сообщает away:true раньше online:true, возвращение отменяет уход', async () => {
  const gate = setup(); const peer = await gate.open('peer'); peer.messages.length = 0;
  const subject = await gate.open('subject', true);
  assert.deepEqual(peer.messages, [{ t: 'online.away', userId: 'subject', away: true }, { t: 'online.update', userId: 'subject', online: true }]);
  assert.equal(gate.isUserDmPresent('subject'), false);
  await subject.frame({ t: 'visible', on: true }); await settle(); assert.equal(gate.isUserDmPresent('subject'), true);
  peer.messages.length = 0; await subject.frame({ t: 'visible', on: false }); await gate.tick(1999);
  await subject.frame({ t: 'visible', on: true }); await gate.tick(1); assert.deepEqual(peer.messages, []);
  subject.close(); peer.close();
});
for (const [name, change, failure] of [
  ['away снят до offline', { file: 'gateway.ts', from: "hub.deliverAboutUser(conn.userId, { t: 'online.update', userId: conn.userId, online: false });", to: "syncDmAway(conn.userId); hub.deliverAboutUser(conn.userId, { t: 'online.update', userId: conn.userId, online: false });" }, 'выход рассылается строго'],
  ['active скрытого', { file: 'gateway.ts', from: '!visibility.isHidden(conn) && connActive(at, now)', to: 'connActive(at, now)' }, 'скрытое соединение не становится'],
  ['last-seen считает сокет', { file: 'lastSeen.ts', from: "import { isUserDmPresent } from './gateway.js';", to: "import { isUserOnline as isUserDmPresent } from './gateway.js';" }, 'last-seen использует'],
] as [string, Change, string][]) {
  it(`шлюз: исходниковый мутант «${name}» пойман`, async () => {
    await checkHidden();
    await assert.rejects(() => checkHidden(change), (error: unknown) => error instanceof assert.AssertionError && error.message.includes(failure));
  });
}
it('планировщик получает пробу присутствия ЛС, а мутант сокетного онлайна ловится', async () => {
  const gate = setup(); const socket = await gate.open('subject', true);
  const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const anchor = 'startScheduledWorker({ isOnline: isUserDmPresent });'; assert.equal(index.split(anchor).length, 2);
  const call = index.slice(index.indexOf(anchor), index.indexOf(anchor) + anchor.length);
  const check = (code: string) => {
    let probe!: (id: string) => boolean;
    runInNewContext(code, { startScheduledWorker: (deps: { isOnline: typeof probe }) => { probe = deps.isOnline; }, isUserDmPresent: gate.isUserDmPresent, isUserOnline: gate.isUserOnline });
    assert.equal(probe('subject'), false, 'планировщик не считает скрытый сокет присутствием');
  };
  check(call); const mutant = call.replace('isUserDmPresent', 'isUserOnline'); assert.notEqual(mutant, call);
  assert.throws(() => check(mutant), (error: unknown) => error instanceof assert.AssertionError && error.message.includes('планировщик не считает')); socket.close();
});
