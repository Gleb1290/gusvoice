import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as apiModule from './apiClient.js';
import * as contextModule from './context.js';
import * as wireModule from './wire.js';
import * as webhookModule from './webhook.js';
import type { Bot, BotOptions, WebSocketLike } from './bot.js';
import type { BotUser } from './wire.js';
import type { BOT_API_VERSION } from '../../backend/src/bots/botRules.js';

// Только тип сервера: импорт не выполняется и не поднимает backend/env/LiveKit.
const serverVersion: typeof BOT_API_VERSION = wireModule.SDK_API_VERSION;
const sdkVersion: typeof wireModule.SDK_API_VERSION = serverVersion;
const source = readFileSync(new URL('./bot.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const me: BotUser = { id: 'bot', username: 'VersionBot', display_name: 'Версии', bot: true, description: '', about: '', public: true };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
type Mode = 'polling' | 'ws';
function harness(raw = source, version?: unknown, features = ['unrecognized-future-feature']) {
  const logs: string[] = [], sockets: FakeSocket[] = [], failures: unknown[] = [];
  const intervals = new Set<number>(); let nextInterval = 0;
  const value = { ...me, ...(version === undefined ? {} : { api_version: version }), features } as BotUser;
  class FakeSocket implements WebSocketLike {
    readyState = 1;
    onopen: WebSocketLike['onopen'] = null;
    onmessage: WebSocketLike['onmessage'] = null;
    onclose: WebSocketLike['onclose'] = null;
    onerror: WebSocketLike['onerror'] = null;
    constructor() { sockets.push(this); }
    send(_raw: string) {}
    close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code, reason }); }
    hello() { this.onmessage?.({ data: JSON.stringify({ op: 'hello', bot: value }) }); }
  }
  const imports: Record<string, unknown> = {
    './apiClient.js': { ...apiModule, sleep: async () => { throw new Error('R307: неожиданный reconnect'); } },
    './context.js': contextModule, './wire.js': wireModule, './webhook.js': webhookModule,
  };
  const exports = {};
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, Error, AbortController, Date, Request, Response, Headers, TextDecoder, Uint8Array,
      setInterval: () => { const id = ++nextInterval; intervals.add(id); return id; }, clearInterval: (id: number) => { intervals.delete(id); },
      console: { error: (...args: unknown[]) => failures.push(args), warn: (...args: unknown[]) => failures.push(args) },
      require: (name: string) => { assert.ok(Object.hasOwn(imports, name), `R307: закрытая граница ${name}`); return imports[name]; } });
  const bot = new (exports as { Bot: new (token: string, opts: BotOptions) => Bot }).Bot('synthetic-version-token', {
    baseUrl: 'https://sdk.invalid', discover: false, WebSocket: FakeSocket,
    fetch: async () => { throw new Error('R307: настоящий HTTP запрещён'); }, log: m => logs.push(m),
  });
  bot.catch(e => { failures.push(e); });
  let getMeCalls = 0, polls = 0;
  bot.api.getMe = async () => { getMeCalls++; return value; };
  bot.api.wsUrl = async () => 'wss://sdk.invalid/api/bot/v1/ws';
  bot.api.getUpdates = async (_params, signal) => {
    polls++;
    assert.ok(signal, 'R307: только управляемый долгий опрос');
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const warnings = () => logs.filter(m => m.startsWith('server speaks Bot API'));
  async function cycle(mode: Mode, check: () => Promise<void>) {
    let starts = 0;
    const firstSocket = sockets.length;
    const running = bot.start({ mode, onStart: () => { starts++; } });
    // Обработчик rejection ставится сразу: ошибка сценария не превращается в unhandledRejection.
    const settled = running.then(() => undefined, e => { failures.push(e); });
    try {
      await flush();
      if (mode === 'ws') {
        assert.equal(sockets.length, firstSocket + 1, 'R307: WS создан');
        sockets[firstSocket].hello(); sockets[firstSocket].hello();
        await flush();
      }
      assert.equal(starts, 1, 'R307: сервер принят, start callback один раз');
      assert.equal(bot.isRunning, true, 'R307: предупреждение не останавливает бота');
      await check();
    } finally { await bot.stop(); await settled; }
    assert.equal(intervals.size, 0); assert.deepEqual(failures, []);
  }
  // Повторные сведения getMe проверяют сам предохранитель полного Bot, а не копию его условия.
  async function repeatVersionSignal() {
    const check = bot as unknown as { warnIfServerNewer(user: BotUser): void };
    check.warnIfServerNewer(await bot.api.getMe()); check.warnIfServerNewer(await bot.api.getMe());
  }
  return { bot, cycle, warnings, repeatVersionSignal, counts: () => ({ getMeCalls, polls }) };
}
it('R307 SDK и сервер знают один Bot API 4 — двусторонний типовой контракт', () => assert.equal(sdkVersion, 4));
async function once(raw = source, mode: Mode = 'polling') {
  const h = harness(raw, 5);
  await h.cycle(mode, async () => {
    assert.equal(h.warnings().length, 1, 'R307 старт предупреждает о новом сервере');
    await h.repeatVersionSignal();
    assert.equal(h.warnings().length, 1, 'R307 версия предупреждается один раз');
    assert.match(h.warnings()[0], /Bot API 5, this SDK knows 4:.*keeps working.*update @gusvoice\/bot/);
  });
}
for (const mode of ['polling', 'ws'] as const) {
  it(`R307 ${mode}: сервер 5 продолжает работу, повтор getMe/hello не дублирует предупреждение`, () => once(source, mode));
  for (const [name, version] of [['равная', 4], ['меньшая', 3], ['нет поля', undefined], ['строка', '5'], ['null', null], ['NaN', NaN]] as const) {
    it(`R307 ${mode}: ${name} версия и неизвестные features не вызывают предупреждение`, async () => {
      const h = harness(source, version);
      await h.cycle(mode, async () => { await h.repeatVersionSignal(); assert.equal(h.warnings().length, 0, 'R307 равная и старая версии молчат'); });
    });
  }
  it(`R307 ${mode}: после stop новый start снова предупреждает о сервере 5`, async () => {
    const h = harness(source, 5);
    for (const expected of [1, 2]) await h.cycle(mode, async () => {
      await h.repeatVersionSignal(); assert.equal(h.warnings().length, expected, 'R307 новый start сбрасывает предупреждение');
    });
  });
}
async function restart(raw = source) {
  const h = harness(raw, 5);
  for (const expected of [1, 2]) await h.cycle('polling', async () => assert.equal(h.warnings().length, expected, 'R307 новый start сбрасывает предупреждение'));
}
async function equal(raw = source) {
  const h = harness(raw, 4);
  await h.cycle('polling', async () => assert.equal(h.warnings().length, 0, 'R307 равная и старая версии молчат'));
}
for (const c of [
  { name: 'предупреждение на каждом сигнале getMe', from: 'this.versionWarned || typeof server', to: 'typeof server', check: once, marker: 'R307 версия предупреждается один раз' },
  { name: 'равная версия ошибочно новее', from: 'server > SDK_API_VERSION', to: 'server >= SDK_API_VERSION', check: equal, marker: 'R307 равная и старая версии молчат' },
  { name: 'флаг не сброшен при start', from: '    this.versionWarned = false;', to: '    /* R307 нет сброса */', check: restart, marker: 'R307 новый start сбрасывает предупреждение' },
  { name: 'polling забыл предупредить при start', from: '    this.warnIfServerNewer(this.me);', to: '    /* R307 нет предупреждения polling */', check: (raw: string) => once(raw, 'polling'), marker: 'R307 старт предупреждает о новом сервере' },
  { name: 'WS забыл предупредить при hello', from: '            this.warnIfServerNewer(me);', to: '            /* R307 нет предупреждения WS */', check: (raw: string) => once(raw, 'ws'), marker: 'R307 старт предупреждает о новом сервере' },
]) it(`R307 версия контрфакт: ${c.name}, оригинал проходит первым`, async () => {
  await c.check(source);
  assert.equal(source.split(c.from).length - 1, 1, 'R307 версия: уникальный якорь');
  await assert.rejects(c.check(source.replace(c.from, c.to)), (e: unknown) => e instanceof assert.AssertionError
    && e.code === 'ERR_ASSERTION' && e.operator === 'strictEqual' && e.message.split('\n', 1)[0] === c.marker);
});
