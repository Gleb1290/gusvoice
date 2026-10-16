import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as health from './socketHealth';
import type { Instance } from './config';

const source = readFileSync(new URL('./bgGateways.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
type Outcome = 'ok' | 'network' | 'timeout' | 'abort' | number;
function fixture(outcomes: Outcome[], raw = source, failurePath = '/unread') {
  const entry = { id: 'guest', name: 'Сосед', apiUrl: 'https://background.invalid', presenceWs: 'wss://background.invalid/presence', token: 'fixture-only', order: 0 } satisfies Instance;
  let registry: Instance[] = [entry], attempt = -1, seq = 0;
  const timers = new Map<number, { fn: () => void; delay: number }>(), intervals = new Map<number, () => void>();
  const requests: string[] = [], unexpectedIO: string[] = [], snapshots: unknown[] = [], sockets: Socket[] = [];
  const boundary = (ok: boolean, message: string) => {
    if (!ok) unexpectedIO.push(message);
    assert.equal(ok, true, message);
  };
  class Socket {
    static OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    constructor(url: string) { boundary(url === 'wss://background.invalid/gateway', 'известный адрес сокета'); sockets.push(this); }
    send(text: string) { boundary(['identify', 'ping', 'subscribe', 'visible'].includes(JSON.parse(text).t), 'известная команда сокета'); }
    close() { this.readyState = 3; this.onclose?.(); }
    ready() { this.readyState = Socket.OPEN; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ t: 'ready', userId: 'me' }) }); }
  }
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared, './socketHealth': health,
    './config': { instances: () => registry, rememberInstanceServers: () => {} },
  };
  const module = { exports: {} as typeof import('./bgGateways') };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, URL, WebSocket: Socket,
    AbortSignal: { timeout(ms: number) { boundary(ms === 15_000, 'срок запроса равен 15 секундам'); return 'fixture-signal'; } },
    setTimeout(fn: () => void, delay: number) { timers.set(++seq, { fn, delay }); return seq; },
    clearTimeout(id: number) { timers.delete(id); },
    setInterval(fn: () => void, delay: number) { assert.equal(delay, health.PING_MS); intervals.set(++seq, fn); return seq; },
    clearInterval(id: number) { intervals.delete(id); },
    async fetch(url: string, init: { headers: { Authorization?: string }; signal?: unknown }) {
      const path = url.startsWith(`${entry.apiUrl}/api`) ? url.slice(`${entry.apiUrl}/api`.length) : '';
      const allowed = ['/unread', '/auth/me', '/servers'].includes(path);
      boundary(allowed, `нет запросов вне замкнутой границы: ${url}`);
      boundary(init.headers.Authorization === `Bearer ${entry.token}`, 'запрос использует токен фоновой записи');
      boundary(init.signal === 'fixture-signal', 'запрос ограничен сроком ожидания');
      requests.push(path);
      if (path === '/unread') attempt++;
      const outcome = path === failurePath ? outcomes[attempt] : 'ok';
      boundary(outcome !== undefined, 'каждая попытка явно задана сценарием');
      if (outcome === 'network') throw new TypeError('fixture network failure');
      if (outcome === 'timeout' || outcome === 'abort') throw Object.assign(new Error('fixture timed out'), { name: outcome === 'timeout' ? 'TimeoutError' : 'AbortError' });
      const status = typeof outcome === 'number' ? outcome : 200;
      return { ok: status === 200, status, async json() {
        return path === '/unread' ? { servers: { server: { unread: 7, mentions: 2 } }, dms: 3 } : path === '/auth/me' ? { id: 'me', username: 'friend' } : [];
      } };
    },
    require(id: string) { assert.equal(Object.hasOwn(deps, id), true, `неожиданный импорт ${id}`); return deps[id]; },
  });
  const api = module.exports;
  const unsubscribe = api.onBgUnread(m => snapshots.push(plain(m)));
  return { api, requests, snapshots, sockets, timers,
    async start(activeId: string | null = 'home') { api.syncBgGateways(activeId); await settle(); },
    async retry() {
      assert.equal(timers.size, 1); const [id, timer] = [...timers][0]!;
      timers.delete(id); timer.fn(); await settle();
    },
    async ready() { assert.equal(sockets.length, 1); sockets[0]!.ready(); await settle(); },
    noToken() { registry = [{ ...entry, token: null }]; },
    async close() { api.stopBgGateways(); await settle(); unsubscribe(); assert.equal(timers.size, 0); assert.equal(intervals.size, 0); assert.deepEqual(unexpectedIO, []); },
  };
}
async function twoFailures(kind: Exclude<Outcome, 'ok' | 401>, raw = source) {
  const f = fixture([kind, kind], raw);
  try {
    await f.start();
    assert.equal(f.api.bgUnread().guest?.down, undefined, 'R234-bg-first: одна сетевая неудача ещё не означает молчащего хоста');
    assert.equal(f.snapshots.length, 0); assert.equal(f.sockets.length, 0);
    assert.equal([...f.timers.values()][0]?.delay, 10_000);
    await f.retry();
    assert.deepEqual(plain(f.api.bgUnread()), { guest: { servers: {}, dms: 0, down: true } });
    assert.equal(f.snapshots.length, 1); assert.equal(f.sockets.length, 0);
    assert.deepEqual(f.requests, ['/unread', '/auth/me', '/unread', '/auth/me']);
    assert.equal([...f.timers.values()][0]?.delay, 20_000);
  } finally { await f.close(); }
}
for (const [kind, name] of [['network', 'сети'], ['timeout', 'таймаута'], ['abort', 'прерванного запроса']] as const)
  it(`R234 фоновый хост становится down только после второго сбоя ${name}`, () => twoFailures(kind));
it('R234 два HTTP 5xx помечают хост молчащим, а первый ещё не помечает', async () => {
  for (const status of [500, 502, 503, 599]) await twoFailures(status);
});
it('R234 HTTP 4xx — ответ хоста, даже три отказа не выставляют down', async () => {
  for (const status of [400, 403, 404, 429, 499]) {
    const f = fixture([status, status, status]);
    try {
      await f.start(); await f.retry(); await f.retry();
      assert.deepEqual(plain(f.api.bgUnread()), {}); assert.equal(f.snapshots.length, 0); assert.equal(f.sockets.length, 0);
    } finally { await f.close(); }
  }
});
it('R234 HTTP 401 от unread или auth/me закрывает шлюз без повторов и без down', async () => {
  for (const path of ['/unread', '/auth/me']) {
    const f = fixture([401], source, path);
    try { await f.start(); assert.deepEqual(plain(f.api.bgUnread()), {}); assert.equal(f.timers.size, 0); assert.equal(f.sockets.length, 0); }
    finally { await f.close(); }
  }
});
async function recovery(raw = source) {
  const f = fixture(['network', 503, 'ok'], raw);
  try {
    await f.start(); await f.retry(); assert.equal(f.api.bgUnread().guest?.down, true);
    await f.retry();
    assert.equal(f.api.bgUnread().guest?.down, undefined, 'R234-bg-recovery: удачный unread снимает down до ready сокета');
    assert.deepEqual(plain(f.api.bgUnread()), { guest: { servers: { server: { unread: 7, mentions: 2 } }, dms: 3 } });
    assert.equal(f.sockets.length, 1); await f.ready();
    assert.equal(f.timers.size, 0);
  } finally { await f.close(); }
}
it('R234 удачный unread заменяет down свежими счётчиками ещё до ready сокета', () => recovery());
it('R234 активному инстансу и записи без токена не открываются фоновые запросы', async () => {
  for (const noToken of [false, true]) {
    const f = fixture([]);
    try { if (noToken) f.noToken(); await f.start(noToken ? 'home' : 'guest'); assert.deepEqual(f.requests, []); assert.equal(f.timers.size, 0); }
    finally { await f.close(); }
  }
});
it('R234 остановка снимает отложенный повтор после сетевой неудачи', async () => {
  const f = fixture(['network']);
  try { await f.start(); assert.equal(f.timers.size, 1); f.api.stopBgGateways(); assert.equal(f.timers.size, 0); assert.deepEqual(plain(f.api.bgUnread()), {}); }
  finally { await f.close(); }
});
for (const mutant of [
  { name: 'порог снижен до одной неудачи', from: 'const DOWN_AFTER_FAILS = 2;', to: 'const DOWN_AFTER_FAILS = 1;', check: (raw: string) => twoFailures('network', raw), prefix: 'R234-bg-first:', actual: true, expected: undefined },
  { name: 'успех сохраняет down из старой записи', from: 'state[link.instanceId] = { servers: sum.servers, dms: sum.dms };', to: 'state[link.instanceId] = { ...state[link.instanceId], servers: sum.servers, dms: sum.dms };', check: recovery, prefix: 'R234-bg-recovery:', actual: true, expected: undefined },
]) it(`R234 контрфакт целого bgGateways: ${mutant.name}`, async () => {
  await mutant.check(source); assert.equal(source.split(mutant.from).length - 1, 1);
  await assert.rejects(() => mutant.check(source.replace(mutant.from, mutant.to)), e => e instanceof assert.AssertionError
    && e.message.startsWith(mutant.prefix) && e.operator === 'strictEqual' && e.actual === mutant.actual && e.expected === mutant.expected);
});
