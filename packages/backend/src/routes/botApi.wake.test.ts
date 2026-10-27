import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as drizzle from 'drizzle-orm';
import * as zod from 'zod';
import * as schema from '../db/schema.js';
import * as rules from '../bots/botRules.js';
import * as wire from '../bots/botWire.js';
import type { BotUpdateRow, BotWake, BotWakeAlarm } from '../bots/botStore.js';

const source = readFileSync(new URL('./botApi.ts', import.meta.url), 'utf8');
const storeSource = readFileSync(new URL('../bots/botStore.ts', import.meta.url), 'utf8');
const botId = 'R298-wake-bot';
// Только синтетический токен, секреты окружения не читаются.
const token = `gvb_${'A'.repeat(43)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

// Граница оборота event loop, а не пауза в миллисекундах: все Promise-продолжения
// IO-заглушек завершатся до неё. Время приложения при этом остаётся неизменным.
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));

interface Timer { fn: () => void; ms: number; interval: boolean; unref(): void }
class Clock {
  readonly now = 100_000;
  readonly pending = new Set<Timer>();
  readonly globals = {
    Date: class extends Date { static override now() { return 100_000; } },
    setTimeout: (fn: () => void, ms: number) => this.add(fn, ms, false),
    setInterval: (fn: () => void, ms: number) => this.add(fn, ms, true),
    clearTimeout: (timer: Timer) => { this.pending.delete(timer); },
    clearInterval: (timer: Timer) => { this.pending.delete(timer); },
  };
  private add(fn: () => void, ms: number, interval: boolean) {
    const timer = { fn, ms, interval, unref() {} };
    this.pending.add(timer);
    return timer;
  }
}

function compile<T>(text: string, dependencies: Record<string, unknown>, globals: Record<string, unknown>): T {
  const module = { exports: {} };
  const compiled = ts.transpileModule(text, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  runInNewContext(compiled, { module, exports: module.exports, Buffer, AbortController,
    require: (name: string) => {
      assert.ok(Object.hasOwn(dependencies, name), `R298 необъявленная зависимость ${name}`);
      return dependencies[name];
    }, ...globals });
  return module.exports as T;
}

class Socket extends EventEmitter {
  readyState = 1;
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  deferClose = false;
  readonly frames: { op: string; update?: { update_id: number } }[] = [];
  send(raw: string) { this.frames.push(JSON.parse(raw)); }
  close(code?: number, reason?: string) { this.closes.push({ code, reason }); this.readyState = 3; if (!this.deferClose) this.emit('close'); }
  ping() {}
}

interface WakeStore {
  listenBotWake(bot: string, fn: () => void): BotWake;
  armBotWake(bot: string, ms: number, signal?: AbortSignal): BotWakeAlarm;
  wireUpdateOf(row: BotUpdateRow): Record<string, unknown>;
}
interface Api {
  __methods: { getupdates(ctx: unknown, params: unknown, extra: unknown): Promise<unknown[]> };
  __serve(socket: Socket, request: unknown): Promise<void>;
  __sockets: Map<string, Set<Socket>>;
  closeBotSockets(botId: string | null, code: number, reason: string): void;
}

function harness(text = source, options: { holdAuth?: boolean; holdConfirm?: boolean; holdFirstQuery?: boolean } = {}) {
  const clock = new Clock();
  const faults: string[] = [];
  const auth = deferred<void>();
  const confirming = deferred<void>();
  const querying = deferred<void>();
  const rows: BotUpdateRow[] = [];
  const reads: number[][] = [];
  const queries: number[] = [];
  const confirms: number[] = [];
  const subscriptions: string[] = [];
  const unsubscriptions: string[] = [];
  const pendingAck: { channel: string; ack: ReturnType<typeof deferred<number>> }[] = [];
  const channels = new Set<string>();
  const desiredChannels = new Set<string>();
  let subscriber: FakeRedis | undefined;
  const forbidden = (name: string) => (..._args: unknown[]): never => {
    faults.push(name); throw new Error(`R298 непредусмотренный IO: ${name}`);
  };
  const dormant = (name: string) => new Proxy({}, { get: (_target, key) => forbidden(`${name}.${String(key)}`) });
  class FakeRedis extends EventEmitter {
    constructor(_url: string) { super(); assert.equal(subscriber, undefined); subscriber = this; }
    subscribe(channel: string) {
      subscriptions.push(channel);
      desiredChannels.add(channel);
      const ack = deferred<number>();
      pendingAck.push({ channel, ack });
      return ack.promise;
    }
    async unsubscribe(channel: string) {
      unsubscriptions.push(channel); desiredChannels.delete(channel); channels.delete(channel); return 0;
    }
    ping = forbidden('Redis.ping');
  }
  const globals = { ...clock.globals, console: { warn: (...args: unknown[]) => {
    faults.push(`warning:${args.map(String).join(' ')}`);
  } } };
  // Исполняется ВЕСЬ botStore; подменён Redis, но не listen/arm/ready/off.
  const store = compile<WakeStore>(storeSource, {
    'drizzle-orm': drizzle, ioredis: FakeRedis, '../db/index.js': { db: dormant('db') },
    '../db/schema.js': schema, '../env.js': { env: { redisUrl: 'redis://test.invalid' } }, './botRules.js': rules,
  }, globals);
  const ctx = { bot: { userId: botId, webhookUrl: null, disabledAt: null, description: '', about: '', public: true },
    user: { id: botId, username: 'wakebot', displayName: 'Будильник', avatarUrl: null }, allowInternal: false };
  const storeBoundary = {
    ...store,
    botByToken: async (got: string) => {
      assert.equal(got, token);
      if (options.holdAuth) await auth.promise;
      return { bot: ctx.bot, user: ctx.user };
    },
    readBotSettings: async () => ({ enabled: true, allowInternalWebhooks: false }),
    // Журнал здесь — явная IO-граница, НЕ имитация доказательства SQL. SQL проверяет PGlite integration.
    updatesFrom: async (id: string, from: number, limit: number) => {
      assert.equal(id, botId); queries.push(from);
      if (options.holdFirstQuery && queries.length === 1) await querying.promise;
      return rows.filter(row => row.updateId >= from).slice(0, limit);
    },
    confirmUpdates: async (id: string, offset: number) => {
      assert.equal(id, botId); confirms.push(offset);
      if (options.holdConfirm) await confirming.promise;
      return [];
    },
    dropUpdates: forbidden('dropUpdates'), pendingCount: forbidden('pendingCount'),
  };
  const dependencies: Record<string, unknown> = {
    zod, 'drizzle-orm': drizzle, '../db/schema.js': schema, '../db/index.js': { db: dormant('db') },
    '../authGuard.js': { rateHit: async () => 0, clientIp: () => '192.0.2.1', attachmentUploadBlock: forbidden('attachmentUploadBlock') },
    '../bots/botRules.js': rules, '../bots/botWire.js': wire, '../bots/botStore.js': storeBoundary,
    '../bots/botRead.js': { markTakenRead: async (id: string, taken: BotUpdateRow[]) => {
      assert.equal(id, botId); reads.push(Array.from(taken, row => row.updateId));
    } },
  };
  for (const name of ['../attachmentRules.js', '../attachments.js', '../blocks.js', '../bots/botUpdates.js',
    '../bots/webhookDelivery.js', '../conversations.js', '../convSendFanout.js', '../gateway.js', '../safeFetch.js',
    '../storage.js', '../webhookRules.js']) dependencies[name] = dormant(name);
  // Добавляются только ссылки на приватные функции/Map: ни один фрагмент функции не вырезается для eval.
  const api = compile<Api>(`${text}\nexport { methods as __methods, serveBotSocket as __serve, sockets as __sockets };`, dependencies, globals);
  const req = (offset?: number) => ({ headers: { authorization: `Bot ${token}` }, raw: new EventEmitter(), query: { offset } });
  const publish = () => {
    const channel = `bot:upd:${botId}`;
    if (channels.has(channel)) subscriber!.emit('message', channel, 'wake');
  };
  const ack = () => {
    for (const item of pendingAck.splice(0)) {
      // UNSUBSCRIBE, уже поставленный после этого SUBSCRIBE, не должен быть отменён поздним ack.
      if (desiredChannels.has(item.channel)) channels.add(item.channel);
      item.ack.resolve(1);
    }
  };
  const append = (updateId: number) => {
    rows.push({ updateId, botId, type: 'message', payload: { message_id: `m-${updateId}` }, createdAt: new Date(0) });
    publish(); // До SUBSCRIBE ack PUBLISH действительно теряется, журнал остаётся.
  };
  const healthy = () => assert.deepEqual(faults, [], 'R298 ошибки IO/фоновые catch не скрыты');
  return { api, ctx, req, clock, rows, reads, queries, confirms, subscriptions, unsubscriptions, channels,
    auth, confirming, querying, ack, append, publish, healthy };
}

const pollMarker = 'getUpdates завершился с событием после ack без достижения deadline';
async function checkPoll(text: string) {
  const h = harness(text);
  const req = h.req();
  let settled = false;
  let result: unknown[] | undefined;
  const done = h.api.__methods.getupdates(h.ctx, { timeout: 30 }, { req, files: [] }).then(value => {
    settled = true; result = value;
  });
  try {
    await checkpoint();
    assert.deepEqual(h.subscriptions, [`bot:upd:${botId}`]);
    assert.equal(settled, false);
    h.append(17);
    assert.equal(h.channels.size, 0, 'публикация до ack не доставляется');
    h.ack(); await checkpoint(); h.healthy();
    assert.strictEqual(settled, true, pollMarker);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), [{ update_id: 17, message: { message_id: 'm-17' } }]);
    assert.deepEqual(h.reads, [[17]]);
    assert.equal(h.clock.now, 100_000, 'ни deadline 30 с, ни страховка 5 с не запускались');
    assert.equal(h.clock.pending.size, 0);
    assert.equal(h.channels.size, 0);
  } finally {
    req.raw.emit('close'); h.ack(); await done;
  }
}

const socketMarker = 'WS отдал событие после ack без следующего PUBLISH';
async function checkSocket(text: string) {
  const h = harness(text);
  const socket = new Socket();
  const done = h.api.__serve(socket, h.req());
  try {
    await checkpoint();
    assert.deepEqual(socket.frames.map(frame => frame.op), ['hello']);
    h.append(21);
    assert.equal(h.channels.size, 0);
    h.ack(); await checkpoint(); h.healthy();
    assert.strictEqual(socket.frames.filter(frame => frame.op === 'update').length, 1, socketMarker);
    // Повторный будильник — сигнал перечитать журнал, а не послать сохранённый кадр ещё раз.
    h.publish(); h.publish(); await checkpoint(); h.healthy();
    assert.deepEqual(socket.frames.map(frame => frame.op), ['hello', 'update']);
    assert.deepEqual(socket.frames.filter(frame => frame.update).map(frame => frame.update!.update_id), [21]);
    assert.deepEqual(h.reads, [], 'WS доставка сама по себе не подтверждает прочтение');
  } finally {
    socket.close(); h.ack(); await done;
  }
  assert.equal(h.api.__sockets.size, 0);
  assert.equal(h.clock.pending.size, 0);
  assert.equal(h.channels.size, 0);
}

const confirmMarker = 'закрытие при незавершённом confirm не оставило слот WS';
async function checkConfirmClose(text: string) {
  const h = harness(text, { holdConfirm: true });
  const socket = new Socket();
  const done = h.api.__serve(socket, h.req(42));
  try {
    await checkpoint();
    assert.deepEqual(h.confirms, [42], 'confirm действительно начат и заблокирован');
    socket.close();
    h.confirming.resolve(); await checkpoint();
    h.ack(); await checkpoint(); h.healthy();
    assert.strictEqual(h.api.__sockets.size, 0, confirmMarker);
    assert.equal(h.clock.pending.size, 0, 'нет pinger и страховки готовности');
    assert.equal(h.unsubscriptions.length, 1, 'close снял последнего ждущего');
    assert.equal(h.channels.size, 0);
    const frames = socket.frames.length;
    h.publish(); await checkpoint();
    assert.equal(socket.frames.length, frames);
  } finally {
    h.confirming.resolve(); socket.close(); h.ack(); await done;
  }
}

const authMarker = 'закрытый во время auth сокет не занял слот';
async function checkAuthClose(text: string) {
  const h = harness(text, { holdAuth: true });
  const socket = new Socket();
  const done = h.api.__serve(socket, h.req());
  try {
    await checkpoint();
    assert.equal(socket.frames.length, 0);
    assert.equal(h.api.__sockets.size, 0);
    socket.close(); assert.equal(socket.readyState, 3);
    h.auth.resolve(); await checkpoint(); h.healthy();
    assert.strictEqual(h.api.__sockets.size, 0, authMarker);
    assert.equal(h.subscriptions.length, 0);
    assert.equal(socket.frames.length, 0);
    assert.equal(h.clock.pending.size, 0);
  } finally {
    h.auth.resolve(); socket.close(); h.ack(); await done;
  }
}

describe('R298 гонка Bot API: целые botApi/botStore и управляемый Redis', () => {
  it('getUpdates видит запись до SUBSCRIBE ack без ожидания timeout', () => checkPoll(source));
  it('WS после hello получает запись до SUBSCRIBE ack без второго события и дублей', () => checkSocket(source));
  it('незавершённое подтверждение offset не мешает close снять слот и будильник', () => checkConfirmClose(source));
  it('сокет закрыт во время auth — нет подписки, hello и занятого слота', () => checkAuthClose(source));
});

function replaceOnce(text: string, from: string, to: string) {
  assert.equal(text.split(from).length - 1, 1, `R298 единственный якорь ${from}`);
  return text.replace(from, to);
}
const mutants = [
  { name: 'выборка getUpdates до взвода теряет запись между выборкой и ack', verify: checkPoll,
    marker: pollMarker, actual: false, expected: true,
    mutate: (text: string) => {
      const query = '      const rows = await updatesFrom(botId, from, q.limit ?? 100, q.allowed_updates);';
      return replaceOnce(replaceOnce(text, query, ''), '      const before = deadline - Date.now();', `${query}\n      const before = deadline - Date.now();`);
    } },
  { name: 'WS без await ready засыпает до следующего события', verify: checkSocket,
    marker: socketMarker, actual: 0, expected: 1,
    mutate: (text: string) => replaceOnce(text, '  await wake.ready;', '') },
  { name: 'await confirm открывает окно утечки слота при close', verify: checkConfirmClose,
    marker: confirmMarker, actual: 1, expected: 0,
    mutate: (text: string) => replaceOnce(text, 'if (cursor > 0) void confirm(cursor);', 'if (cursor > 0) await confirm(cursor);') },
  { name: 'без readyState guard закрытый во время auth сокет занимает слот', verify: checkAuthClose,
    marker: authMarker, actual: 1, expected: 0,
    mutate: (text: string) => replaceOnce(text, '  if (socket.readyState !== undefined && socket.readyState !== 1) return;', '') },
];
describe('R298 гонка Bot API: адресные контрфакты полного модуля', () => {
  for (const m of mutants) it(m.name, async () => {
    await m.verify(source);
    const changed = m.mutate(source);
    assert.notEqual(changed, source);
    await assert.rejects(() => m.verify(changed), (error: unknown) => error instanceof assert.AssertionError
      && error.code === 'ERR_ASSERTION' && error.message.split(/\r?\n/, 1)[0] === m.marker
      && error.operator === 'strictEqual' && error.actual === m.actual && error.expected === m.expected,
    `только адресный ERR_ASSERTION: ${m.marker}`);
  });
});

const pollConflict = 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running';
async function checkTakeover(text: string) {
  const h = harness(text, { holdFirstQuery: true });
  const first = h.api.__methods.getupdates(h.ctx, { timeout: 30 }, { req: h.req(), files: [] })
    .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await checkpoint(); h.ack(); await checkpoint();
  assert.equal(h.queries.length, 1, 'первый опрос завис именно внутри выборки');
  h.append(61);
  const second = await h.api.__methods.getupdates(h.ctx, { timeout: 0 }, { req: h.req(), files: [] });
  h.querying.resolve(); const old = await first;
  h.healthy();
  assert.equal(old.error?.code, 409, 'R303 старый опрос не забирает пачку после вытеснения');
  assert.equal(old.error?.description, pollConflict);
  assert.deepEqual(JSON.parse(JSON.stringify(second)), [{ update_id: 61, message: { message_id: 'm-61' } }]);
  assert.deepEqual(h.reads, [[61]], 'только новый потребитель отмечает пачку прочитанной');
  assert.equal(h.clock.pending.size, 0);
}

async function checkSocketTakeover(text: string, next: 'poll' | 'socket') {
  const h = harness(text), old = new Socket(); old.deferClose = true;
  const initial = h.api.__serve(old, h.req());
  await checkpoint(); h.ack(); await initial;
  const fresh = new Socket();
  try {
    if (next === 'poll') await h.api.__methods.getupdates(h.ctx, { timeout: 0 }, { req: h.req(), files: [] });
    else { const connected = h.api.__serve(fresh, h.req()); await checkpoint(); h.ack(); await connected; }
    assert.equal(old.closes[0]?.code, 4009, 'R303 прежний WS вытеснен новым потребителем');
    assert.equal(old.closes[0]?.reason, 'terminated by other connection');
    if (next === 'socket') {
      assert.equal(fresh.closes.length, 0, 'R303 новый WS не отвергнут занятым старым слотом');
      h.append(73); await checkpoint();
      assert.deepEqual(fresh.frames.filter(f => f.update).map(f => f.update!.update_id), [73]);
    }
    h.healthy();
  } finally { old.emit('close'); fresh.close(); h.ack(); await checkpoint(); }
  assert.equal(h.clock.pending.size, 0);
}

async function checkReplyClose(text: string) {
  const h = harness(text), req = h.req(), reply = { raw: new EventEmitter() };
  let settled = false;
  const task = h.api.__methods.getupdates(h.ctx, { timeout: 30 }, { req, reply, files: [] }).then(() => { settled = true; });
  try {
    await checkpoint(); h.ack(); await checkpoint();
    req.raw.emit('close'); await checkpoint();
    assert.equal(settled, false, 'R303 прочитанное тело POST не отменяет ожидание ответа');
    reply.raw.emit('close'); await checkpoint();
    assert.equal(settled, true, 'R303 обрыв ответа снимает long-poll без достижения срока');
    assert.equal(h.clock.pending.size, 0); h.healthy();
  } finally { reply.raw.emit('close'); req.raw.emit('close'); h.ack(); await task; }
}

async function checkKick(text: string, code: number, expected: number) {
  const h = harness(text), req = h.req();
  let result: { value?: unknown; error?: { code: number } } | undefined;
  const task = h.api.__methods.getupdates(h.ctx, { timeout: 30 }, { req, files: [] })
    .then(value => { result = { value }; }, error => { result = { error }; });
  try {
    await checkpoint(); h.ack(); await checkpoint();
    h.api.closeBotSockets(code === 4003 ? null : botId, code, 'synthetic revoke');
    await checkpoint();
    assert.equal(result?.error?.code, expected, 'R303 отзыв доступа будит poll до срока');
    assert.equal(result?.value, undefined);
    assert.deepEqual(h.reads, []); assert.equal(h.clock.pending.size, 0); h.healthy();
  } finally { req.raw.emit('close'); h.ack(); await task; }
}

describe('R303 один потребитель и отзыв long-poll', () => {
  it('второй poll получает пачку, первый получает точный Telegram 409 даже после начатого SQL', () => checkTakeover(source));
  it('poll вытесняет WS кодом 4009', () => checkSocketTakeover(source, 'poll'));
  it('новый WS вытесняет старый до асинхронного close и не получает 4029', () => checkSocketTakeover(source, 'socket'));
  it('POST ждёт после close запроса и заканчивается по close ответа', () => checkReplyClose(source));
  for (const [name, code, expected] of [['перевыпуск', 4001, 401], ['выключение бота', 4001, 401], ['общий тумблер', 4003, 403], ['webhook', 4009, 409]] as const) {
    it(`${name} будит getUpdates и возвращает ${expected}, а не пачку`, () => checkKick(source, code, expected));
  }
  it('контрфакт kickPolls без пробуждения ловится до deadline, без зависания теста', async () => {
    await checkKick(source, 4001, 401);
    const changed = replaceOnce(source, 'for (const id of ids) for (const k of [...(polls.get(id) ?? [])]) k(err);', '/* poll revocation lost */');
    await assert.rejects(checkKick(changed, 4001, 401), (error: unknown) => error instanceof assert.AssertionError
      && error.message.split(/\r?\n/, 1)[0] === 'R303 отзыв доступа будит poll до срока' && error.actual === undefined && error.expected === 401);
  });
  for (const [name, from, to, verify, marker, actual, expected] of [
    ['нет takeover poll', '    takeOverConsumer(botId);', '', checkTakeover, 'R303 старый опрос не забирает пачку после вытеснения', undefined, 409],
    ['нет проверки после SQL', '      if (k1) throw k1;', '', checkTakeover, 'R303 старый опрос не забирает пачку после вытеснения', undefined, 409],
    ['старый WS остаётся в slots', '    sockets.get(botId)?.delete(s);', '', (raw: string) => checkSocketTakeover(raw, 'socket'), 'R303 новый WS не отвергнут занятым старым слотом', 1, 0],
    ['close запроса вместо ответа', "(reply?.raw ?? req.raw).on('close', () => gone.abort());", "req.raw.on('close', () => gone.abort());", checkReplyClose, 'R303 прочитанное тело POST не отменяет ожидание ответа', true, false],
  ] as const) it(`контрфакт: ${name}`, async () => {
    await verify(source);
    await assert.rejects(verify(replaceOnce(source, from, to)), (error: unknown) => error instanceof assert.AssertionError
      && error.message.split(/\r?\n/, 1)[0] === marker && error.actual === actual && error.expected === expected);
  });
});
