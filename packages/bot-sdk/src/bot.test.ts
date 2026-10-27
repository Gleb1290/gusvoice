import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as apiModule from './apiClient.js';
import * as contextModule from './context.js';
import * as wireModule from './wire.js';
import * as webhookModule from './webhook.js';
import type { Bot, BotOptions, WebSocketCtor, WebSocketLike } from './bot.js';
import type { BotUser, Update } from './wire.js';

const source = readFileSync(new URL('./bot.ts', import.meta.url), 'utf8');
const me: BotUser = { id: 'bot', username: 'PanelBot', display_name: 'Panel', bot: true, description: '', about: '', public: true };

function update(id: number, text = 'Привет'): Update {
  return {
    update_id: id,
    message: {
      message_id: `message-${id}`, chat: { id: 'chat', type: 'dm' },
      from: { id: 'user', username: 'friend', display_name: 'Друг', bot: false },
      date: 1_700_000_000, text,
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Граница оборота event loop выпускает все готовые микрозадачи; часы ОС не двигаем.
async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function reached(check: () => boolean, label: string) {
  await flush();
  assert.equal(check(), true, label);
}

function outcome(promise: Promise<void>) {
  const state: { settled: boolean; error?: unknown } = { settled: false };
  void promise.then(() => { state.settled = true; }, (error: unknown) => { state.settled = true; state.error = error; });
  return state;
}

/** Полный bot.ts; только его внешняя среда подменена, сами методы Bot не вырезаются. */
function harness(input = source, socketAvailable = true, options: Partial<BotOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const sleeps: { milliseconds: number; release: () => void }[] = [];
  const intervals = new Map<number, () => void>();
  const fetches: string[] = [];
  let intervalId = 0;

  class FakeSocket implements WebSocketLike {
    readyState = 1;
    onopen: WebSocketLike['onopen'] = null;
    onmessage: WebSocketLike['onmessage'] = null;
    onclose: WebSocketLike['onclose'] = null;
    onerror: WebSocketLike['onerror'] = null;
    readonly sent: { op: string; offset?: number }[] = [];
    constructor(readonly url: string, readonly init: { headers: Record<string, string> }) { sockets.push(this); }
    send(data: string) { this.sent.push(JSON.parse(data) as { op: string; offset?: number }); }
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.({ code, reason });
    }
    receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }

  const sleep = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    sleeps.push({ milliseconds, release: () => { signal?.removeEventListener('abort', abort); resolve(); } });
  });
  const exports: { Bot?: new (token: string, options: BotOptions) => Bot } = {};
  const imports: Record<string, unknown> = {
    './apiClient.js': { ...apiModule, sleep }, './context.js': contextModule,
    './wire.js': wireModule, './webhook.js': webhookModule,
  };
  const compiled = ts.transpileModule(input, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: 'bot.ts', reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error).length, 0, 'harness: bot.ts компилируется');
  runInNewContext(compiled.outputText, {
    exports,
    require: (name: string) => { assert.ok(Object.hasOwn(imports, name), `harness: разрешённый импорт ${name}`); return imports[name]; },
    AbortController, Date, console, queueMicrotask,
    setInterval: (fn: () => void) => { intervals.set(++intervalId, fn); return intervalId; },
    clearInterval: (id: number) => { intervals.delete(id); },
  }, { filename: 'bot.r299.cjs' });
  assert.equal(typeof exports.Bot, 'function', 'harness: полный модуль экспортирует Bot');
  const fetchFake: typeof fetch = async (url) => {
    fetches.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: me }), { status: 200 });
  };
  const bot = new exports.Bot!('synthetic-bot-token', {
    baseUrl: 'https://sdk.invalid', discover: false, fetch: fetchFake, log: false,
    ...(socketAvailable ? { WebSocket: FakeSocket as WebSocketCtor } : {}),
    ...options,
  });
  return { bot, sockets, sleeps, intervals, fetches };
}

async function serial(input = source) {
  const { bot } = harness(input);
  const gate = deferred();
  const log: string[] = [];
  bot.on('message', async (ctx) => {
    const id = ctx.update.update_id;
    log.push(`start:${id}`);
    if (id === 1) await gate.promise;
    log.push(`end:${id}`);
  });
  const first = bot.handleUpdate(update(1));
  const second = bot.handleUpdate(update(2));
  const done = outcome(second);
  try {
    await flush();
    assert.deepEqual([...log], ['start:1'], 'serial: второй не входит, пока первый ждёт');
    assert.equal(done.settled, false, 'serial: промис второго тоже ждёт');
  } finally {
    gate.resolve();
    await Promise.all([first, second]);
  }
  assert.deepEqual(log, ['start:1', 'end:1', 'start:2', 'end:2'], 'serial: порядок завершения совпадает с приёмом');
}

async function duplicate(input = source) {
  const { bot } = harness(input);
  const ids: number[] = [];
  bot.on('message', (ctx) => { ids.push(ctx.update.update_id); });
  await Promise.all([bot.handleUpdate(update(7)), bot.handleUpdate(update(7)), bot.handleUpdate(update(8))]);
  await bot.handleUpdate(update(7));
  await bot.handleUpdate(update(9));
  assert.deepEqual(ids, [7, 8, 9], 'duplicate: повтор в очереди и старое событие пропускаются, новые принимаются');
}

async function commands(input = source) {
  const { bot } = harness(input);
  bot.me = me;
  const log: unknown[] = [];
  bot.command('/STATUS', (ctx) => { log.push(['command', ctx.command, ctx.args]); });
  bot.on('message', (ctx) => { log.push(['message', ctx.text]); });
  await bot.handleUpdate(update(1, '/Status@PanelBot a b'));
  await bot.handleUpdate(update(2, '/missing a'));
  await bot.handleUpdate(update(3, 'обычный текст'));
  assert.deepEqual(log, [
    ['command', 'status', ['a', 'b']], ['message', '/missing a'], ['message', 'обычный текст'],
  ], 'command: известная команда не дублируется сообщением, неизвестная и обычный текст доходят');
}

async function fatal(code: number, expected: number, input = source) {
  const h = harness(input);
  const run = h.bot.start();
  const result = outcome(run);
  try {
    await reached(() => h.sockets.length === 1, 'fatal: сокет создан');
    h.sockets[0].close(code, 'test close');
    await reached(() => result.settled, `fatal:${code}: start отклоняется без переподключения`);
    assert.ok(result.error instanceof apiModule.GusVoiceApiError, `fatal:${code}: тип ошибки API`);
    assert.equal(result.error.code, expected, `fatal:${code}: соответствующий HTTP-код`);
    assert.equal(result.error.method, 'ws', `fatal:${code}: ошибка относится к WS`);
    assert.equal(h.sleeps.length, 0, `fatal:${code}: нет повторной попытки`);
    assert.equal(h.fetches.length, 0, `fatal:${code}: нет проверки getMe вместо фатального кода`);
    assert.equal(h.bot.isRunning, false);
  } finally { await h.bot.stop(); }
  assert.equal(h.intervals.size, 0, 'fatal: таймер соединения снят');
}

async function ack(input = source) {
  const h = harness(input);
  const gate = deferred();
  let entered = false;
  let finished = false;
  h.bot.on('message', async () => { entered = true; await gate.promise; finished = true; });
  const run = h.bot.start();
  outcome(run);
  try {
    await reached(() => h.sockets.length === 1, 'ack: сокет создан');
    const ws = h.sockets[0];
    ws.receive({ op: 'hello', bot: me });
    ws.receive({ op: 'update', update: update(41) });
    await reached(() => entered, 'ack: обработчик начал работу');
    assert.deepEqual(ws.sent, [], 'ack: медленное событие не подтверждено до завершения');
    gate.resolve();
    await reached(() => ws.sent.length === 1, 'ack: завершённое событие подтверждено');
    assert.equal(finished, true, 'ack: подтверждение после побочного эффекта обработчика');
    assert.deepEqual(ws.sent, [{ op: 'ack', offset: 42 }], 'ack: подтверждается следующий offset');
  } finally { gate.resolve(); await h.bot.stop(); await run; }
  assert.equal(h.intervals.size, 0, 'ack: остановка убрала пинг');
}

async function reconnect(input = source) {
  const h = harness(input);
  const received: number[] = [];
  const starts: BotUser[] = [];
  h.bot.on('message', (ctx) => { received.push(ctx.update.update_id); });
  const run = h.bot.start({ onStart: (user) => { starts.push(user); } });
  outcome(run);
  try {
    await reached(() => h.sockets.length === 1, 'reconnect: первое соединение');
    const first = h.sockets[0];
    assert.equal(first.url, 'wss://sdk.invalid/api/bot/v1/ws');
    assert.equal(first.init.headers.authorization, 'Bot synthetic-bot-token');
    first.receive({ op: 'hello', bot: me });
    first.receive({ op: 'update', update: update(16) });
    await reached(() => first.sent.some((msg) => msg.op === 'ack'), 'reconnect: событие закончено до разрыва');
    first.close(1006, 'network lost');
    await reached(() => h.sleeps.length === 1, 'reconnect: нефатальное закрытие ждёт повтор');
    assert.equal(h.sockets.length, 1, 'reconnect: соединение не открывается до разрешения часов');
    assert.ok(h.sleeps[0].milliseconds >= 800 && h.sleeps[0].milliseconds <= 1200, 'reconnect: начальная пауза с jitter');
    h.sleeps[0].release();
    await reached(() => h.sockets.length === 2, 'reconnect: повторное соединение');
    const second = h.sockets[1];
    assert.equal(second.url, 'wss://sdk.invalid/api/bot/v1/ws?offset=17', 'reconnect: URL продолжает с последнего плюс один');
    second.receive({ op: 'hello', bot: me });
    second.receive({ op: 'update', update: update(16) });
    second.receive({ op: 'update', update: update(17) });
    await reached(() => second.sent.some((msg) => msg.offset === 18), 'reconnect: новое событие обработано');
    assert.deepEqual(received, [16, 17], 'reconnect: повтор доставки не вызывает обработчик');
    assert.equal(starts.length, 1, 'reconnect: onStart не повторяется после hello');
    assert.equal(h.fetches.length, 0, 'reconnect: hello не требует getMe');
  } finally { await h.bot.stop(); await run; }
  assert.equal(h.intervals.size, 0, 'reconnect: таймеры обоих соединений сняты');
}

describe('Bot.handleUpdate — последовательность, команды и ошибки', () => {
  it('медленный первый обработчик удерживает следующее событие и его промис', () => serial());
  it('повтор одного update_id пропускается, следующие id принимаются', () => duplicate());
  it('команда забирает сообщение, неизвестная команда остаётся обычным сообщением', () => commands());
  it('ошибка попадает в catch с исходным контекстом, даже упавший catch не ломает очередь', async () => {
    const { bot } = harness();
    const failure = new Error('handler failure');
    const caught: unknown[] = [];
    const log: string[] = [];
    bot.on('message', (ctx) => { if (ctx.update.update_id === 1) throw failure; log.push(`first:${ctx.update.update_id}`); });
    bot.on('message', (ctx) => { log.push(`second:${ctx.update.update_id}`); });
    bot.catch((error, ctx) => { caught.push([error, ctx?.update.update_id, ctx?.type]); throw new Error('catch failure'); });
    await Promise.all([bot.handleUpdate(update(1)), bot.handleUpdate(update(2))]);
    assert.deepEqual(caught, [[failure, 1, 'message']]);
    assert.deepEqual(log, ['second:1', 'first:2', 'second:2']);
  });
  it('неизвестный тип обновления игнорируется, знакомый после него обрабатывается', async () => {
    const { bot } = harness();
    const received: number[] = [];
    const caught: unknown[] = [];
    for (const type of wireModule.UPDATE_TYPES) bot.on(type, (ctx) => { received.push(ctx.update.update_id); });
    bot.catch((error) => { caught.push(error); });
    await bot.handleUpdate({ update_id: 1, future_event: { value: 1 } } as Update);
    await bot.handleUpdate(update(2));
    assert.deepEqual(received, [2]);
    assert.deepEqual(caught, []);
  });
});

function press(id: number, data = 'st'): Update {
  const message = update(id, '/restart nginx').message!;
  return { update_id: id, callback_query: {
    id: `cbq-${id}`, from: message.from,
    message: { ...message, message_id: 'panel', chat: { id: 'panel-chat', type: 'dm' }, from: me,
      reply_markup: { inline_keyboard: [[{ text: 'Статус', callback_data: data }]] },
    }, data, date: message.date,
  } };
}

async function manualAnswer(input = source) {
  const { bot } = harness(input);
  const answers: unknown[] = [];
  bot.api.answerCallbackQuery = async (...args) => { answers.push(args); return true; };
  bot.callbackQuery('st', async ctx => { await ctx.answerCallbackQuery('Готово'); });
  await bot.handleUpdate(press(1));
  assert.equal(answers.length, 1, 'R301-callback-ручной-ответ-ровно-один');
  assert.deepEqual(answers, [['cbq-1', { text: 'Готово' }]]);
}

async function regexpMatch(input = source) {
  const { bot } = harness(input);
  bot.api.answerCallbackQuery = async () => true;
  let capture: string | undefined;
  bot.callbackQuery(/^rs:(.+)$/g, ctx => { capture = ctx.match?.[1]; });
  await bot.handleUpdate(press(1, 'rs:nginx'));
  assert.equal(capture, 'nginx', 'R301-callback-передаёт-группу-регулярки');
}

describe('R301 Bot — callbackQuery и явная публикация команд', () => {
  it('строка совпадает только целиком с тем же регистром, первое правило забирает событие у fallback', async () => {
    const { bot } = harness();
    bot.api.answerCallbackQuery = async () => true;
    const seen: string[] = [];
    assert.equal(bot.callbackQuery('st', ctx => { seen.push(`first:${ctx.callbackData}`); }), bot);
    bot.callbackQuery('st', () => { seen.push('second'); });
    bot.on('callback_query', ctx => { seen.push(`fallback:${ctx.callbackData}`); });
    for (const [i, data] of ['st', 'status', 'ST', ' st', 'st '].entries()) await bot.handleUpdate(press(i + 1, data));
    assert.deepEqual(seen, ['first:st', 'fallback:status', 'fallback:ST', 'fallback: st', 'fallback:st ']);
  });

  it('RegExp отдаёт ctx.match и группы, глобальная регулярка сбрасывается перед каждым событием', async () => {
    const { bot } = harness();
    bot.api.answerCallbackQuery = async () => true;
    const seen: unknown[] = [];
    const re = /^rs:(.+)$/g;
    re.lastIndex = 100;
    bot.callbackQuery(re, ctx => { seen.push([ctx.match?.[0], ctx.match?.[1], ctx.match?.index, ctx.match?.input]); });
    await bot.handleUpdate(press(1, 'rs:nginx'));
    await bot.handleUpdate(press(2, 'rs:redis'));
    assert.deepEqual(seen, [['rs:nginx', 'nginx', 0, 'rs:nginx'], ['rs:redis', 'redis', 0, 'rs:redis']]);
  });

  it('порядок между RegExp и строкой общий: ранняя регулярка побеждает более позднюю точную строку', async () => {
    const { bot } = harness();
    bot.api.answerCallbackQuery = async () => true;
    const seen: string[] = [];
    bot.callbackQuery(/^st$/, () => { seen.push('regex'); });
    bot.callbackQuery('st', () => { seen.push('string'); });
    bot.on('callback_query', () => { seen.push('fallback'); });
    await bot.handleUpdate(press(1));
    assert.deepEqual(seen, ['regex']);
  });

  it('несовпавшие правила оставляют fallback без match, обычная команда не запускается от текста панели', async () => {
    const { bot } = harness();
    bot.api.answerCallbackQuery = async () => true;
    const seen: unknown[] = [];
    bot.command('restart', () => { seen.push('command'); });
    bot.callbackQuery(/^rs:(.+)$/, () => { seen.push('route'); });
    bot.on('callback_query', ctx => { seen.push(['fallback', ctx.match, ctx.command, ctx.text]); });
    await bot.handleUpdate(press(1, 'unknown'));
    assert.deepEqual(seen, [['fallback', undefined, undefined, '']]);
  });

  it('автоответ ждёт завершения обработчика, затем идёт ровно один пустой ответ исходному id', async () => {
    const { bot } = harness();
    const gate = deferred();
    const seen: unknown[] = [];
    bot.api.answerCallbackQuery = async (...args) => { seen.push(['answer', ...args]); return true; };
    bot.callbackQuery('st', async () => { seen.push('start'); await gate.promise; seen.push('done'); });
    const pending = bot.handleUpdate(press(1));
    try {
      await flush();
      assert.deepEqual(seen, ['start']);
    } finally { gate.resolve(); await pending; }
    assert.deepEqual(seen, ['start', 'done', ['answer', 'cbq-1']]);
  });

  it('ручной answerCallbackQuery подавляет второй автоматический ответ', () => manualAnswer());

  it('даже не ожидаемый вручную ответ помечен до await и не дублируется SDK', async () => {
    const { bot } = harness();
    const gate = deferred();
    let calls = 0;
    bot.api.answerCallbackQuery = async () => { calls++; await gate.promise; return true; };
    let manual: Promise<true> | undefined;
    bot.callbackQuery('st', ctx => { manual = ctx.answerCallbackQuery(); });
    try { await bot.handleUpdate(press(1)); assert.equal(calls, 1); }
    finally { gate.resolve(); await manual; }
  });

  it('ошибка callback-обработчика и catch не ломает автоответ и следующее событие', async () => {
    const { bot } = harness();
    const failure = new Error('synthetic callback failure');
    const caught: unknown[] = [];
    const answers: string[] = [];
    const received: number[] = [];
    bot.api.answerCallbackQuery = async id => { answers.push(id); return true; };
    bot.callbackQuery('st', ctx => { received.push(ctx.update.update_id); if (ctx.update.update_id === 1) throw failure; });
    bot.catch((error, ctx) => { caught.push([error, ctx?.type, ctx?.callbackData]); throw new Error('catch failed'); });
    await bot.handleUpdate(press(1));
    await bot.handleUpdate(press(2));
    assert.deepEqual(caught, [[failure, 'callback_query', 'st']]);
    assert.deepEqual(received, [1, 2]);
    assert.deepEqual(answers, ['cbq-1', 'cbq-2']);
  });

  it('отказ API автоответа не останавливает очередь и не делает повторный ответ', async () => {
    const { bot } = harness();
    const answers: string[] = [];
    bot.api.answerCallbackQuery = async id => { answers.push(id); throw new Error('expired'); };
    const seen: number[] = [];
    bot.on('callback_query', ctx => { seen.push(ctx.update.update_id); });
    await bot.handleUpdate(press(1));
    await bot.handleUpdate(press(2));
    assert.deepEqual(answers, ['cbq-1', 'cbq-2']);
    assert.deepEqual(seen, [1, 2]);
  });

  it('обработчик, упавший после ручного ответа, не вызывает второй ответ даже через catch', async () => {
    const { bot } = harness();
    const answers: string[] = [];
    const failure = new Error('after answer');
    const caught: unknown[] = [];
    bot.api.answerCallbackQuery = async id => { answers.push(id); return true; };
    bot.catch(error => { caught.push(error); });
    bot.callbackQuery('st', async ctx => { await ctx.answerCallbackQuery(); throw failure; });
    await bot.handleUpdate(press(1));
    assert.deepEqual(answers, ['cbq-1']);
    assert.deepEqual(caught, [failure]);
  });

  it('отказ ручного ответа уходит в catch, а не повторяется автоматическим ответом', async () => {
    const { bot } = harness();
    const answers: string[] = [];
    const failure = new Error('query expired');
    const caught: unknown[] = [];
    bot.api.answerCallbackQuery = async id => { answers.push(id); throw failure; };
    bot.catch(error => { caught.push(error); });
    bot.callbackQuery('st', async ctx => { await ctx.answerCallbackQuery(); });
    await bot.handleUpdate(press(1));
    assert.deepEqual(answers, ['cbq-1']);
    assert.deepEqual(caught, [failure]);
  });

  it('autoAnswerCallbackQuery:false отключает лишь автоответ, ручной по-прежнему доступен', async () => {
    const { bot } = harness(source, true, { autoAnswerCallbackQuery: false });
    const answers: unknown[] = [];
    bot.api.answerCallbackQuery = async (...args) => { answers.push(args); return true; };
    bot.callbackQuery('manual', async ctx => { await ctx.answerCallbackQuery({ show_alert: true, text: 'Нет доступа' }); });
    await bot.handleUpdate(press(1, 'unhandled'));
    await bot.handleUpdate(press(2, 'manual'));
    assert.deepEqual(answers, [['cbq-2', { show_alert: true, text: 'Нет доступа' }]]);
  });

  it('необработанное нажатие автоматически закрывается, обычное сообщение ответа на callback не вызывает', async () => {
    const { bot } = harness();
    const answers: string[] = [];
    bot.api.answerCallbackQuery = async id => { answers.push(id); return true; };
    await bot.handleUpdate(press(1));
    await bot.handleUpdate(update(2));
    assert.deepEqual(answers, ['cbq-1']);
  });

  it('описания публикуются только setCommands: нормализация, порядок, скрытые команды и замещение описания', async () => {
    const { bot } = harness();
    const calls: unknown[] = [];
    // setCommands собирает объекты внутри VM; сравниваем JSON-провод, не прототипы разных realm.
    bot.api.setMyCommands = async commands => { calls.push(JSON.parse(JSON.stringify(commands))); return true; };
    bot.command('/STATUS', () => {}, { description: '  Состояние  ' });
    bot.command(['start', 'panel'], () => {}, { description: 'Открыть' });
    bot.command('hidden', () => {});
    bot.command('blank', () => {}, { description: '  ' });
    bot.command('status', () => {}, { description: 'Обновить статус' });
    await bot.handleUpdate(update(1, '/STATUS'));
    assert.deepEqual(calls, [], 'регистрация и обработка команды не публикуют подсказки автоматически');
    assert.equal(await bot.setCommands(), true);
    assert.deepEqual(calls, [[
      { command: 'status', description: 'Обновить статус' }, { command: 'start', description: 'Открыть' },
      { command: 'panel', description: 'Открыть' },
    ]]);
  });

  it('старт по WS не публикует команды без явного setCommands', async () => {
    const h = harness();
    let publications = 0;
    h.bot.api.setMyCommands = async () => { publications++; return true; };
    h.bot.command('status', () => {}, { description: 'Состояние' });
    const run = h.bot.start();
    outcome(run);
    try {
      await reached(() => h.sockets.length === 1, 'R301: WS создан');
      h.sockets[0].receive({ op: 'hello', bot: me });
      await flush();
      assert.equal(publications, 0);
    } finally { await h.bot.stop(); await run; }
  });

  it('setCommands без описаний явно публикует пустой список, описание 256 проходит, 257 отклоняется', async () => {
    const { bot } = harness();
    const calls: unknown[] = [];
    bot.api.setMyCommands = async commands => { calls.push(JSON.parse(JSON.stringify(commands))); return true; };
    assert.equal(await bot.setCommands(), true);
    bot.command('ok', () => {}, { description: 'x'.repeat(256) });
    assert.throws(() => bot.command('too_long', () => {}, { description: 'x'.repeat(257) }), /256/);
    await bot.setCommands();
    assert.deepEqual(calls, [[], [{ command: 'ok', description: 'x'.repeat(256) }]]);
  });

  for (const mutation of [
    { title: 'двойной автоответ после ручного', scenario: manualAnswer,
      from: 'this.autoAnswer && !ctx.callbackAnswered && update.callback_query', to: 'this.autoAnswer && update.callback_query',
      label: 'R301-callback-ручной-ответ-ровно-один', actual: 2, expected: 1 },
    { title: 'потерянная группа ctx.match', scenario: regexpMatch,
      from: 'ctx.match = m;', to: '/* mutant: match потерян */',
      label: 'R301-callback-передаёт-группу-регулярки', actual: undefined, expected: 'nginx' },
  ]) {
    it(`контрфакт ${mutation.title}: полный оригинал проходит первым`, async () => {
      await mutation.scenario(source);
      const mutant = replaceOnce(mutation.from, mutation.to);
      await assert.rejects(mutation.scenario(mutant), error => {
        assert.ok(error instanceof assert.AssertionError, 'поймана регрессия поведения, не VM/импорт');
        assert.equal(error.code, 'ERR_ASSERTION');
        assert.equal(error.operator, 'strictEqual');
        assert.equal(error.message.split(/\r?\n/, 1)[0], mutation.label);
        assert.equal(error.actual, mutation.actual);
        assert.equal(error.expected, mutation.expected);
        return true;
      });
    });
  }
});

describe('Bot.start — WebSocket без сети и реальных задержек', () => {
  for (const [code, expected] of [[4001, 401], [4003, 403], [4009, 409]]) {
    it(`закрытие ${code} отклоняет start ошибкой ${expected} без переподключения`, () => fatal(code, expected));
  }
  it('ack уходит только после завершения обработчика', () => ack());
  it('1006 переподключается с offset последнего обработанного события плюс один', () => reconnect());
  it('без WebSocket сообщает про Node.js < 22 и способы запуска', async () => {
    const h = harness(source, false);
    await assert.rejects(h.bot.start(), (error: unknown) => {
      // Error создан внутри VM, поэтому не используем instanceof Error другого realm.
      assert.ok(error && typeof error === 'object' && 'message' in error);
      assert.match(String(error.message), /Node\.js < 22/);
      assert.match(String(error.message), /WebSocket/);
      assert.match(String(error.message), /polling/);
      return true;
    });
    assert.equal(h.bot.isRunning, false);
    assert.equal(h.sockets.length, 0);
    assert.equal(h.fetches.length, 0);
    await h.bot.stop();
  });
  it('stop и start завершаются после окончания уже запущенного обработчика', async () => {
    const h = harness();
    const gate = deferred();
    let entered = false;
    let finished = false;
    h.bot.on('message', async () => { entered = true; await gate.promise; finished = true; });
    const run = h.bot.start();
    const running = outcome(run);
    let stopping: Promise<void> | undefined;
    try {
      await reached(() => h.sockets.length === 1, 'stop: сокет создан');
      h.sockets[0].receive({ op: 'update', update: update(1) });
      await reached(() => entered, 'stop: обработчик запущен');
      stopping = h.bot.stop();
      const stopped = outcome(stopping);
      await flush();
      assert.equal(h.bot.isRunning, false);
      assert.equal(stopped.settled, false, 'stop: ждёт обработчик');
      assert.equal(running.settled, false, 'stop: start тоже ждёт обработчик');
      gate.resolve();
      await stopping;
      await run;
      assert.equal(finished, true);
      assert.equal(h.sockets[0].readyState, 3);
      assert.equal(h.intervals.size, 0);
      await h.bot.stop();
    } finally { gate.resolve(); await (stopping ?? h.bot.stop()); await run; }
  });
});

function replaceOnce(from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, `mutant: единственный якорь ${from}`);
  return source.replace(from, to);
}

async function polling400(input = source) {
  const h = harness(input); let calls = 0;
  h.bot.api.getUpdates = async (_params, signal) => {
    calls++;
    if (calls === 1) throw new apiModule.GusVoiceApiError(400, 'Bad Request: unsupported allowed_updates', undefined, 'getUpdates');
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const run = h.bot.start({ mode: 'polling' }); const result = outcome(run);
  try {
    await flush();
    assert.equal(h.sleeps.length, 1, 'R303-poll-400-планирует-повтор');
    assert.equal(result.settled, false); assert.equal(calls, 1);
    h.sleeps[0].release();
    await reached(() => calls === 2, 'R303 повтор действительно зовёт getUpdates');
    assert.equal(result.settled, false);
  } finally { await h.bot.stop(); await run.catch(() => {}); }
}

it('R303 getUpdates 400 повторяется после паузы и не убивает polling', () => polling400());
it('R303 getUpdates 409 фатален: исходная ошибка возвращается без следующего опроса и паузы', async () => {
  const h = harness(); let calls = 0;
  const error = new apiModule.GusVoiceApiError(409, 'Conflict: terminated by another getUpdates/WS connection of this bot', undefined, 'getUpdates');
  h.bot.api.getUpdates = async () => { calls++; throw error; };
  await assert.rejects(h.bot.start({ mode: 'polling' }), e => e === error);
  assert.equal(calls, 1); assert.equal(h.sleeps.length, 0); assert.equal(h.bot.isRunning, false);
});
it('R303 контрфакт общего fatal-400 ловится на отсутствии паузы, оригинал проходит первым', async () => {
  await polling400();
  const mutant = replaceOnce('return isFatal(e) && e.code !== 400;', 'return isFatal(e);');
  await assert.rejects(polling400(mutant), e => e instanceof assert.AssertionError && e.operator === 'strictEqual'
    && e.message.split(/\r?\n/, 1)[0] === 'R303-poll-400-планирует-повтор' && e.actual === 0 && e.expected === 1);
});
it('R303 WS 4009 при перехвате другим потребителем сообщает именно terminated, не webhook', async () => {
  const h = harness(); const run = h.bot.start(); outcome(run);
  try {
    await reached(() => h.sockets.length === 1, 'R303 конкурент: сокет создан');
    h.sockets[0].close(4009, 'terminated by other connection');
    await assert.rejects(run, (e: unknown) => e instanceof apiModule.GusVoiceApiError && e.code === 409
      && e.description === 'Conflict: terminated by another getUpdates/WS connection of this bot; make sure that only one bot instance is running');
    assert.equal(h.sleeps.length, 0); assert.equal(h.sockets.length, 1);
  } finally { await h.bot.stop(); }
});
it('R303 новые reaction, chat_member и kicked приходят только своим обработчикам в порядке update_id', async () => {
  const { bot } = harness(); const log: unknown[] = [];
  bot.on('message', () => { log.push('лишнее сообщение'); });
  bot.on('message_reaction', ctx => { log.push([ctx.type, ctx.chat.id, ctx.from?.id, ctx.isChannel, ctx.serverId]); });
  bot.on('chat_member', ctx => { log.push([ctx.type, ctx.chat.id, ctx.payload.old_status, ctx.payload.new_status]); });
  bot.on('my_chat_member', ctx => { log.push([ctx.type, ctx.chat.id, ctx.payload.old_status, ctx.payload.new_status]); });
  const user = update(1).message!.from;
  await bot.handleUpdate({ update_id: 1, message_reaction: { chat: { id: 'channel', type: 'channel', server_id: 'server' },
    message_id: 'message', user, date: 1, old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👍' }] } });
  await bot.handleUpdate({ update_id: 2, chat_member: { chat: { id: 'server', type: 'server' }, from: me, user,
    date: 1, old_status: 'left', new_status: 'member' } });
  await bot.handleUpdate({ update_id: 3, my_chat_member: { chat: { id: 'dm', type: 'dm' }, from: user,
    date: 1, old_status: 'member', new_status: 'kicked' } });
  assert.deepEqual(log, [['message_reaction', 'channel', 'user', true, 'server'],
    ['chat_member', 'server', 'left', 'member'], ['my_chat_member', 'dm', 'member', 'kicked']]);
});
it('R303 polling узнаёт ник до первого события канала и не исполняет /cmd@other', async () => {
  const h = harness(); const log: string[] = []; let polls = 0;
  h.bot.command('status', ctx => { log.push(`command:${ctx.chat.id}:${ctx.argsText}`); });
  h.bot.on('message', ctx => { log.push(`message:${ctx.text}`); });
  const stopped = new apiModule.GusVoiceApiError(409, 'Conflict: stopped test consumer', undefined, 'getUpdates');
  h.bot.api.getUpdates = async () => {
    if (++polls > 1) throw stopped;
    return ['/Status@Other', '/STATUS@pAnElBoT a'].map((text, i) => ({ update_id: i + 1,
      message: { ...update(i + 1, text).message!, chat: { id: 'channel', type: 'channel' as const, server_id: 'server' } } }));
  };
  await assert.rejects(h.bot.start({ mode: 'polling' }), e => e === stopped);
  assert.deepEqual(h.fetches, ['https://sdk.invalid/api/bot/v1/getMe']);
  assert.deepEqual(log, ['message:/Status@Other', 'command:channel:a']);
});

describe('Bot — адресные контрфакты на полном модуле, оригинал проходит первым', () => {
  const mutations = [
    {
      title: 'параллельный dispatch ломает барьер первого события', invariant: serial,
      from: 'this.queue.then(() => this.dispatch(update))', to: 'this.dispatch(update)', label: 'serial: второй не входит, пока первый ждёт',
      operator: 'deepStrictEqual', actual: ['start:1', 'start:2', 'end:2'], expected: ['start:1'],
    },
    {
      title: 'без проверки повторного id сообщение доставляется дважды', invariant: duplicate,
      from: 'if (update.update_id <= this.lastUpdateId) return;', to: '',
      label: 'duplicate: повтор в очереди и старое событие пропускаются, новые принимаются',
      operator: 'deepStrictEqual', actual: [7, 7, 8, 7, 9], expected: [7, 8, 9],
    },
    {
      title: 'добавление команды к общим обработчикам даёт двойную доставку', invariant: commands,
      from: 'if (cmd) list = cmd;', to: 'if (cmd) list = [...cmd, ...list];',
      label: 'command: известная команда не дублируется сообщением, неизвестная и обычный текст доходят',
      operator: 'deepStrictEqual',
      actual: [['command', 'status', ['a', 'b']], ['message', '/Status@PanelBot a b'], ['message', '/missing a'], ['message', 'обычный текст']],
      expected: [['command', 'status', ['a', 'b']], ['message', '/missing a'], ['message', 'обычный текст']],
    },
    {
      title: 'ранний ack обнаруживается пока обработчик стоит на барьере', invariant: ack,
      from: 'void this.handleUpdate(msg.update).finally(() => {',
      to: 'queueMicrotask(() => queueMicrotask(ack)); void this.handleUpdate(msg.update).finally(() => {',
      label: 'ack: медленное событие не подтверждено до завершения',
      operator: 'deepStrictEqual', actual: [{ op: 'ack', offset: 42 }], expected: [],
    },
    {
      title: 'возобновление без плюс одного возвращается к старому событию', invariant: reconnect,
      from: 'this.api.wsUrl(this.lastUpdateId > 0 ? this.lastUpdateId + 1 : undefined)',
      to: 'this.api.wsUrl(this.lastUpdateId > 0 ? this.lastUpdateId : undefined)',
      label: 'reconnect: URL продолжает с последнего плюс один',
      operator: 'strictEqual', actual: 'wss://sdk.invalid/api/bot/v1/ws?offset=16', expected: 'wss://sdk.invalid/api/bot/v1/ws?offset=17',
    },
    {
      title: 'перепутанный код отозванного токена не проходит проверку ошибки', invariant: (input: string) => fatal(4001, 401, input),
      from: "4001: [401,", to: '4001: [403,', label: 'fatal:4001: соответствующий HTTP-код',
      operator: 'strictEqual', actual: 403, expected: 401,
    },
  ];
  for (const mutation of mutations) {
    it(mutation.title, async () => {
      await mutation.invariant(source);
      const mutant = replaceOnce(mutation.from, mutation.to);
      await assert.rejects(mutation.invariant(mutant), (error: unknown) => {
        assert.ok(error instanceof assert.AssertionError, 'mutant: падение — host assertion, не ошибка VM/импорта/таймера');
        assert.equal(error.message.split(/\r?\n/, 1)[0], mutation.label, 'mutant: точное имя упавшей проверки');
        assert.equal(error.code, 'ERR_ASSERTION', 'mutant: код AssertionError');
        assert.equal(error.operator, mutation.operator, 'mutant: ожидаемый оператор сравнения');
        assert.deepEqual(error.actual, mutation.actual, 'mutant: конкретный наблюдаемый контрфакт');
        assert.deepEqual(error.expected, mutation.expected, 'mutant: конкретное нарушенное ожидание');
        return true;
      });
    });
  }
});
