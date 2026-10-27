import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import ts from 'typescript';
import * as botRules from './botRules.js';

type Store = typeof import('./botStore.js');
const source = readFileSync(new URL('./botStore.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// Обрабатывается весь botStore, не вырезанная функция и не копия алгоритма. Настоящих IO нет.
const barrier = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function observe(promise: Promise<void>) {
  const state = { settled: false, rejected: false };
  void promise.then(() => { state.settled = true; }, () => { state.settled = true; state.rejected = true; });
  return state;
}

function harness(text = source) {
  let now = 0, nextTimer = 0, connections = 0;
  const timers = new Map<number, { due: number; fn: () => void }>();
  const unexpected: string[] = [];
  const fail = (name: string): never => { unexpected.push(name); throw new Error(`R298 forbidden IO: ${name}`); };
  const unused = (name: string) => new Proxy({}, { get: (_target, key) => fail(`${name}.${String(key)}`) });
  const subscriptions: { channel: string; answer: ReturnType<typeof deferred<number>> }[] = [];
  const unsubscriptions: string[] = [];
  const pings: ReturnType<typeof deferred<string>>[] = [];
  const handlers = new Map<string, ((...args: string[]) => void)[]>();
  class RedisStub {
    constructor(url: string) { assert.equal(url, 'redis://r298.invalid'); connections++; }
    on(event: string, fn: (...args: string[]) => void) {
      assert.ok(['message', 'ready', 'error'].includes(event), `явный Redis event ${event}`);
      handlers.set(event, [...(handlers.get(event) ?? []), fn]); return this;
    }
    subscribe(channel: string) {
      const answer = deferred<number>(); subscriptions.push({ channel, answer }); return answer.promise;
    }
    async unsubscribe(channel: string) { unsubscriptions.push(channel); return 0; }
    ping() { const answer = deferred<string>(); pings.push(answer); return answer.promise; }
  }
  const imports: Record<string, unknown> = {
    'drizzle-orm': unused('orm'), ioredis: RedisStub,
    '../db/index.js': { db: unused('db') }, '../db/schema.js': unused('schema'),
    '../env.js': { env: { redisUrl: 'redis://r298.invalid' } }, './botRules.js': botRules,
  };
  const module = { exports: {} };
  const compiled = ts.transpileModule(text, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } });
  runInNewContext(compiled.outputText, {
    module, exports: module.exports, Promise, Map, Set, Date,
    setTimeout(fn: () => void, ms: number) {
      assert.ok(Number.isFinite(ms) && ms >= 0, 'ручному clock задан конечный срок');
      const id = ++nextTimer; timers.set(id, { due: now + ms, fn }); return id;
    },
    clearTimeout(id: number | undefined) { if (id !== undefined) timers.delete(id); },
    console: { warn: () => fail('console.warn') },
    require(id: string) {
      if (!Object.hasOwn(imports, id)) return fail(`require ${id}`);
      return imports[id];
    },
  }, { filename: 'R298.botStore.whole-module.cjs' });
  const store = module.exports as Store;
  function emit(event: string, ...args: string[]) { for (const fn of handlers.get(event) ?? []) fn(...args); }
  function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!due) break;
      now = due[1].due; timers.delete(due[0]); due[1].fn();
    }
    now = end;
  }
  function clean() { assert.deepEqual(unexpected, [], 'запрещённые IO не спрятаны catch'); }
  return { store, subscriptions, unsubscriptions, pings, emit, advance, clean,
    connections: () => connections, timerCount: () => timers.size };
}

const readyMarker = 'ready ждёт ответ SUBSCRIBE, а не только отправку команды';
async function readyPending(text = source) {
  const h = harness(text), wake = h.store.listenBotWake('a', () => {}), state = observe(wake.ready);
  try {
    await barrier(); h.clean();
    assert.strictEqual(state.settled, false, readyMarker);
    assert.equal(h.subscriptions[0]?.channel, 'bot:upd:a');
    h.subscriptions[0]!.answer.resolve(1); await barrier();
    assert.deepEqual(state, { settled: true, rejected: false });
    assert.equal(h.timerCount(), 0, 'ответ SUBSCRIBE снимает страховочный таймер');
  } finally { wake.off(); h.clean(); }
}

const earlyMarker = 'событие до первого await wait остаётся запомненным';
async function earlyWake(text = source) {
  const h = harness(text), wake = h.store.armBotWake('a', 60_000);
  try {
    h.subscriptions[0]!.answer.resolve(1); await wake.ready;
    // wait намеренно впервые читаем ПОСЛЕ сигнала: выборка журнала может занять любой срок.
    h.emit('message', 'bot:upd:a', '42'); await barrier();
    const state = observe(wake.wait); await barrier(); h.clean();
    assert.strictEqual(state.settled, true, earlyMarker);
    assert.equal(state.rejected, false);
    assert.deepEqual(h.unsubscriptions, ['bot:upd:a']);
    assert.equal(h.timerCount(), 0);
  } finally { wake.cancel(); h.clean(); }
}

const reconnectMarker = 'подтверждённое переподключение будит всех ботов';
async function reconnect(text = source, rejectPing = false) {
  const h = harness(text), first = h.store.armBotWake('a', 60_000), second = h.store.armBotWake('b', 60_000);
  try {
    for (const subscription of h.subscriptions) subscription.answer.resolve(1);
    await Promise.all([first.ready, second.ready]);
    const a = observe(first.wait), b = observe(second.wait);
    h.emit('ready'); await barrier();
    assert.equal(h.pings.length, 0, 'первое ready ещё не переподключение');
    assert.equal(a.settled || b.settled, false, 'первое ready не будит журнал');
    h.emit('ready'); await barrier();
    assert.equal(h.pings.length, 1, 'PING должен идти после восстановления подписок');
    assert.equal(a.settled || b.settled, false, 'до результата PING ждущие не разбужены');
    if (rejectPing) h.pings[0]!.reject(new Error('synthetic PING failure'));
    else h.pings[0]!.resolve('PONG');
    await barrier(); h.clean();
    assert.strictEqual(a.settled && b.settled, true, reconnectMarker);
    assert.equal(a.rejected || b.rejected, false);
    assert.deepEqual(h.unsubscriptions.sort(), ['bot:upd:a', 'bot:upd:b']);
    assert.equal(h.timerCount(), 0);
  } finally { first.cancel(); second.cancel(); h.clean(); }
}

describe('будильник ботов: настоящие whole-module подписки и управляемое время', () => {
  it('готовность наступает только после ответа SUBSCRIBE', () => readyPending());
  it('отказ SUBSCRIBE завершает готовность без отклонения', async () => {
    const h = harness(), wake = h.store.listenBotWake('a', () => {}), state = observe(wake.ready);
    h.subscriptions[0]!.answer.reject(new Error('synthetic SUBSCRIBE failure')); await barrier();
    assert.deepEqual(state, { settled: true, rejected: false });
    assert.equal(h.timerCount(), 0); wake.off(); h.clean();
  });
  it('зависший SUBSCRIBE ждёт 4999 мс, но на 5000 мс готовность успешно завершена', async () => {
    const h = harness(), wake = h.store.listenBotWake('a', () => {}), state = observe(wake.ready);
    h.advance(4_999); await barrier(); assert.equal(state.settled, false);
    h.advance(1); await barrier(); assert.deepEqual(state, { settled: true, rejected: false });
    assert.equal(h.timerCount(), 0); wake.off(); h.clean();
  });
  it('раннее событие не теряется до первого ожидания wait', () => earlyWake());
  it('cancel до подтверждения подписки освобождает wait, ready и последнюю подписку', async () => {
    const h = harness(), wake = h.store.armBotWake('a', 60_000), wait = observe(wake.wait), ready = observe(wake.ready);
    wake.cancel(); wake.cancel(); await barrier();
    assert.deepEqual(wait, { settled: true, rejected: false });
    assert.deepEqual(ready, { settled: true, rejected: false });
    assert.deepEqual(h.unsubscriptions, ['bot:upd:a']); assert.equal(h.timerCount(), 0); h.clean();
  });
  for (const alreadyAborted of [false, true]) it(alreadyAborted
    ? 'уже отменённый signal сразу освобождает wait и подписку'
    : 'abort освобождает wait и подписку без ожидания SUBSCRIBE', async () => {
    const h = harness(), controller = new AbortController();
    if (alreadyAborted) controller.abort();
    const wake = h.store.armBotWake('a', 60_000, controller.signal), wait = observe(wake.wait), ready = observe(wake.ready);
    controller.abort(); await barrier();
    assert.deepEqual(wait, { settled: true, rejected: false });
    assert.deepEqual(ready, { settled: true, rejected: false });
    assert.deepEqual(h.unsubscriptions, ['bot:upd:a']); assert.equal(h.timerCount(), 0);
    wake.cancel(); assert.deepEqual(h.unsubscriptions, ['bot:upd:a']); h.clean();
  });
  it('двое ждущих делят SUBSCRIBE, только последний off отписывает; off идемпотентен', async () => {
    const h = harness(); let a = 0, b = 0;
    const first = h.store.listenBotWake('a', () => { a++; }), second = h.store.listenBotWake('a', () => { b++; });
    assert.equal(h.subscriptions.length, 1); assert.equal(h.connections(), 1);
    const ready1 = observe(first.ready), ready2 = observe(second.ready);
    await barrier(); assert.equal(ready1.settled || ready2.settled, false);
    h.subscriptions[0]!.answer.resolve(1); await Promise.all([first.ready, second.ready]);
    h.emit('message', 'unrelated:a'); h.emit('message', 'bot:upd:'); h.emit('message', 'bot:upd:other');
    assert.deepEqual([a, b], [0, 0], 'чужой канал не будит бота');
    h.emit('message', 'bot:upd:a'); assert.deepEqual([a, b], [1, 1]);
    first.off(); first.off(); assert.deepEqual(h.unsubscriptions, []);
    h.emit('message', 'bot:upd:a'); assert.deepEqual([a, b], [1, 2]);
    second.off(); second.off(); assert.deepEqual(h.unsubscriptions, ['bot:upd:a']);
    h.emit('message', 'bot:upd:a'); assert.deepEqual([a, b], [1, 2]);
    const third = h.store.listenBotWake('a', () => {});
    assert.equal(h.subscriptions.length, 2, 'после последнего off новая подписка нужна заново');
    assert.equal(h.connections(), 1, 'подписчик остаётся общим для процесса');
    third.off(); assert.equal(h.timerCount(), 0); h.clean();
  });
  it('первое ready не будит, а после переподключения PING будит всех', () => reconnect());
  it('даже отказ PING после переподключения будит всех для перечитывания журнала', () => reconnect(source, true));
  it('срок wait выдерживает обе стороны границы и освобождает канал', async () => {
    const h = harness(), wake = h.store.armBotWake('a', 1_000), state = observe(wake.wait);
    h.subscriptions[0]!.answer.resolve(1); await wake.ready;
    h.advance(999); await barrier(); assert.equal(state.settled, false);
    h.advance(1); await barrier(); assert.deepEqual(state, { settled: true, rejected: false });
    assert.deepEqual(h.unsubscriptions, ['bot:upd:a']); assert.equal(h.timerCount(), 0); h.clean();
  });
});

function replaceOnce(text: string, from: string, to: string) {
  assert.equal(text.split(from).length, 2, 'единственный whole-module якорь мутации');
  return text.replace(from, to);
}
const mutants = [
  { name: 'контрфакт: мгновенная ready нарушает барьер SUBSCRIBE', verify: readyPending,
    marker: readyMarker, actual: true, expected: false,
    from: 'const ready = Promise.race([confirmed, new Promise<void>((res) => (cap = setTimeout(res, WAKE_READY_CAP_MS)))]).finally(() => clearTimeout(cap));',
    to: 'const ready = Promise.resolve();' },
  { name: 'контрфакт: lazy wait теряет событие до первого ожидания', verify: earlyWake,
    marker: earlyMarker, actual: false, expected: true,
    from: 'return { ready: Promise.race([wake.ready, wait]), wait, cancel: done };',
    to: 'return { ready: Promise.race([wake.ready, wait]), get wait() { return new Promise<void>((res) => (resolve = res)); }, cancel: done };' },
  { name: 'контрфакт: без fireAll после reconnect журнал остаётся спящим', verify: reconnect,
    marker: reconnectMarker, actual: false, expected: true,
    from: "void s.ping().catch(() => '').finally(fireAll);", to: "void s.ping().catch(() => '');" },
];
describe('будильник ботов: адресные исполняемые whole-module контрфакты', () => {
  for (const mutant of mutants) it(mutant.name, async () => {
    await mutant.verify(source); // Original-first: тот же сценарий и IO-адаптер проходят без мутации.
    const changed = replaceOnce(source, mutant.from, mutant.to);
    await assert.rejects(() => mutant.verify(changed), (error: unknown) => error instanceof assert.AssertionError
      && error.code === 'ERR_ASSERTION' && error.message.split(/\r?\n/, 1)[0] === mutant.marker
      && error.operator === 'strictEqual' && error.actual === mutant.actual && error.expected === mutant.expected,
    `засчитывается только адресный host AssertionError: ${mutant.marker}`);
  });
});
