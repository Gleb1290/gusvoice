import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './gatewayRules.js';

const source = readFileSync(new URL('./gateway.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Frame = Record<string, unknown>;
class Socket {
  messages: Frame[] = [];
  private listeners = new Map<string, (...args: any[]) => unknown>();
  on(event: string, cb: (...args: any[]) => unknown) { this.listeners.set(event, cb); }
  send(data: string) { this.messages.push(JSON.parse(data)); }
  close() { this.listeners.get('close')?.(); }
  async frame(value: unknown) { await this.listeners.get('message')?.(Buffer.from(JSON.stringify(value))); }
}
async function fixture(raw = source) {
  let member: 'present' | 'absent' | 'throws' = 'throws';
  const lookups: string[][] = [];
  let broadcast!: (pattern: string, channel: string, payload: string) => void;
  class Redis {
    constructor(url: string) { assert.equal(url, 'no-network-test-transport'); }
    psubscribe() {}
    on(event: string, fn: typeof broadcast) { assert.equal(event, 'pmessage'); broadcast = fn; }
  }
  const noop = () => {};
  const forbidden = (label: string) => () => assert.fail(`неожиданный побочный эффект ${label}`);
  const users = { id: 'id', presenceStatus: 'presenceStatus' };
  const deps: Record<string, unknown> = {
    ioredis: { default: Redis },
    './auth.js': { superAdminId: () => null, verifyToken: () => ({ sub: 'viewer', gen: 0 }), tokenGenValid: async () => true },
    './authGuard.js': { clientIp: () => 'test-ip', rateHit: forbidden('rateHit') },
    './blocks.js': { isBlockedBy: forbidden('isBlockedBy'), onBlockChange: noop },
    './db/index.js': { db: {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      update: forbidden('db.update'),
    } },
    './db/peerQueries.js': { loadPeers: forbidden('loadPeers') },
    './db/schema.js': { users, conversationMembers: {}, conversations: {}, serverMembers: {} },
    'drizzle-orm': { eq: noop, and: noop, sql: noop },
    './env.js': { env: { redisUrl: 'no-network-test-transport' } },
    './gatewayRules.js': rules,
    './gatewayTyping.js': { relayTyping: forbidden('relayTyping') },
    './permissions.js': {
      getChannelAudience: forbidden('getChannelAudience'),
      getMemberContext: async (serverId: string, userId: string) => {
        lookups.push([serverId, userId]);
        if (member === 'throws') throw new Error('synthetic unavailable database');
        return member === 'present' ? { serverId, userId } : null;
      },
    },
    './pushRules.js': { connActive: forbidden('connActive') },
    './realtime.js': { publishToChannel: forbidden('publishToChannel'), publishToUser: forbidden('publishToUser') },
    './sessionVisibility.js': { HIDDEN_OFFLINE_MS: 2000, createSessionVisibility: () => ({ open: noop, close: noop }) },
    './userVisibilityHub.js': { createUserVisibilityHub: () => ({
      attach: noop, detach: noop, setInvisible: noop, goOnline: () => false, goOffline: () => false,
      isOnline: () => false, setDmAway: () => false, sendOnlineSnapshot: async () => {},
    }) },
  };
  const module = { exports: {} as { registerGateway(app: unknown): void } };
  // Весь gateway, настоящие message/identify/subscribe и byServer. Ни Redis, ни env, ни SQL не импортируются.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, { module, exports: module.exports, Buffer,
    setTimeout: () => ({ unref: noop }), clearTimeout: noop,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `описана граница gateway ${id}`); return deps[id]; },
  });
  let connect!: (socket: Socket, request: unknown) => void;
  module.exports.registerGateway({ get: (_path: string, _options: unknown, handler: typeof connect) => { connect = handler; } });
  const socket = new Socket(); connect(socket, {});
  await socket.frame({ t: 'identify', token: 'synthetic-token' });
  assert.deepEqual(socket.messages, [{ t: 'ready', userId: 'viewer' }], 'сценарий действительно проходит identify');
  socket.messages.length = 0;
  return { socket, lookups, setMember: (value: typeof member) => { member = value; },
    publish(serverId: string) { broadcast('gw:server:*', `gw:server:${serverId}`, JSON.stringify({ m: { t: 'pong' } })); },
  };
}

async function rejected(raw = source) {
  const f = await fixture(raw);
  // При удалённом catch сохраняем отвержение как наблюдение, чтобы мутант падал НЕ аварией промиса,
  // а точной проверкой отсутствующего error-кадра.
  let transportFailure: unknown;
  try { await f.socket.frame({ t: 'subscribe', serverId: 'server-a' }); }
  catch (error) { transportFailure = error; }
  assert.deepEqual(f.socket.messages, [{ t: 'error', message: 'subscribe failed', serverId: 'server-a' }],
    'R264 backend catch: отказ базы возвращает адресный subscribe failed');
  assert.equal(transportFailure, undefined, 'ошибка базы не покидает обработчик кадра');
  assert.deepEqual(f.lookups, [['server-a', 'viewer']]);
  f.publish('server-a');
  assert.equal(f.socket.messages.length, 1, 'сбой не оставляет действующую подписку');
  f.setMember('present');
  await f.socket.frame({ t: 'subscribe', serverId: 'server-a' });
  assert.equal(f.socket.messages.length, 1, 'восстановившаяся база больше не возвращает отказ');
  f.publish('server-a');
  assert.deepEqual(f.socket.messages[1], { t: 'pong' }, 'следующая успешная попытка реально подписывает соединение');
}
// Класс ошибки: await getMemberContext отклоняется без адресного ответа, клиент остаётся глухим до reconnect.
it('R264 backend сбой членства возвращает subscribe failed с serverId, следующий запрос может восстановиться', () => rejected());
// Класс ошибки: отсутствие членства смешивается со временной ошибкой или доступ выдаётся после отказа.
it('R264 backend отсутствие членства возвращает not a member, действующий участник подписывается без ошибки', async () => {
  const f = await fixture(); f.setMember('absent');
  await f.socket.frame({ t: 'subscribe', serverId: 'server-a' });
  assert.deepEqual(f.socket.messages, [{ t: 'error', message: 'not a member', serverId: 'server-a' }]);
  f.publish('server-a'); assert.equal(f.socket.messages.length, 1, 'неучастник не получает серверные кадры');
  f.setMember('present'); f.socket.messages.length = 0;
  await f.socket.frame({ t: 'subscribe', serverId: 'server-b' });
  assert.deepEqual(f.socket.messages, []);
  // Проверяем реальный byServer по доставке безопасного события, не по spy функции subscribe.
  // Не server.invalidate: он дополнительно запускает пересчёт аудитории через SQL.
  f.publish('server-a'); assert.deepEqual(f.socket.messages, []);
  f.publish('server-b'); assert.deepEqual(f.socket.messages, [{ t: 'pong' }]);
  assert.deepEqual(f.lookups, [['server-a', 'viewer'], ['server-b', 'viewer']]);
});

function withoutSubscribeCatch() {
  const file = ts.createSourceFile('gateway.ts', source, ts.ScriptTarget.Latest, true);
  const clauses: ts.CaseClause[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'subscribe') clauses.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file); assert.equal(clauses.length, 1);
  const tries: ts.TryStatement[] = [];
  const findTry = (node: ts.Node) => { if (ts.isTryStatement(node)) tries.push(node); ts.forEachChild(node, findTry); };
  findTry(clauses[0]); assert.equal(tries.length, 1); assert.ok(tries[0].catchClause);
  const guarded = tries[0];
  const mutated = source.slice(0, guarded.getStart(file)) + guarded.tryBlock.getText(file) + source.slice(guarded.end);
  assert.notEqual(mutated, source); return mutated;
}
// Класс ошибки: мутационный тест считает произвольный краш доказательством чувствительности.
it('R264 backend мутант без catch пойман отсутствием адресного кадра после original-first', async () => {
  await rejected();
  await assert.rejects(() => rejected(withoutSubscribeCatch()),
    e => e instanceof assert.AssertionError && e.message.startsWith('R264 backend catch:'));
});
