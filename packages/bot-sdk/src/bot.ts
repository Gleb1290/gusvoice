/**
 * Бот: обработчики событий и команд, запуск по WS (по умолчанию) или долгим опросом, приём доставки на адрес.
 *
 * WS `GET /api/bot/v1/ws?offset=N` (заголовок `Authorization: Bot <токен>`): сервер шлёт `{op:"hello",bot}`, затем
 * `{op:"update",update}` по порядку; клиент подтверждает `{op:"ack",offset}` (всё до offset), `{op:"ping"}` → `{op:"pong"}`.
 * Закрытие 4001 — токен/бот недействителен, 4003 — боты выключены на инстансе, 4009 — задан адрес доставки,
 * 4029 — предел соединений/частоты (повтор с паузой). Остальное — переподключение с нарастающей паузой.
 */
import { Api, GusVoiceApiError, sleep, type ApiOptions } from './apiClient.js';
import { Context } from './context.js';
import { SDK_API_VERSION, type BotUser, type Update, type UpdateType, type VoiceStateUpdated } from './wire.js';
import type { VoiceAddon, VoiceConnection, VoiceHost, VoiceJoinOptions } from './voiceTypes.js';
import { UPDATE_TYPES } from './wire.js';
import { SIGNATURE_HEADER, verifyWebhookSignature, type VerifyOptions } from './webhook.js';

/** Минимум WebSocket: глобальный (Node 22+, Bun, Deno) или пакет `ws`. Второй аргумент — `{ headers }`. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string, init: { headers: Record<string, string> }) => WebSocketLike;

export type Handler<K extends UpdateType> = (ctx: Context<K>) => unknown;
export type ErrorHandler = (err: unknown, ctx?: Context) => unknown;

export interface BotOptions extends ApiOptions {
  /** Конструктор WebSocket, если глобального нет (Node 18–21): `import WebSocket from 'ws'`. */
  WebSocket?: WebSocketCtor;
  /** Куда писать о переподключениях (по умолчанию `console.warn`; `false` — молчать). */
  log?: ((message: string) => void) | false;
  /**
   * Нажатие кнопки, на которое обработчик не ответил (`ctx.answerCallbackQuery`), SDK закрывает пустым ответом — у человека
   * гаснут часики на кнопке. По умолчанию `true`.
   */
  autoAnswerCallbackQuery?: boolean;
}

export interface StartOptions {
  /** `ws` (по умолчанию) или `polling` — долгий опрос `getUpdates`. */
  mode?: 'ws' | 'polling';
  /** Долгий опрос: срок ожидания одного запроса, секунд (0–50, по умолчанию 30). */
  timeout?: number;
  /** Долгий опрос: какие события забирать (по умолчанию все). */
  allowedUpdates?: UpdateType[];
  /** Позвать, когда бот на связи (после `hello` / `getMe`). */
  onStart?: (me: BotUser) => unknown;
}

export interface WebhookHandlerOptions extends VerifyOptions {
  /** Секрет, переданный в `setWebhook(url, secret)`. */
  secret: string;
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/** Пинг WS со своей стороны: так видно «полуоткрытое» соединение, которое сервер уже не слышит. */
const WS_PING_MS = 30_000;
const WS_SILENCE_MS = 75_000;
/** Подтверждать WS не реже, чем раз в столько обработанных событий (иначе — когда очередь пуста). */
const ACK_EVERY = 20;
/** Коды закрытия WS, после которых переподключаться бессмысленно. */
const FATAL_CLOSE: Record<number, [number, string]> = {
  4001: [401, 'Unauthorized: the token is invalid (revoked?) or the bot is disabled'],
  4003: [403, 'Forbidden: bots are disabled on this instance'],
  4009: [409, 'Conflict: a webhook is set; call deleteWebhook() to receive updates over WS or polling'],
};
/**
 * Сервер выбил это соединение: подключился другой экземпляр бота (новый WS или getUpdates — один потребитель журнала,
 * как Telegram 409). Переподключаться бессмысленно — экземпляры выбивали бы друг друга по кругу.
 */
const CONFLICT_TEXT =
  'Conflict: terminated by another getUpdates/WS connection of this bot; make sure that only one bot instance is running';

/** 4009 от сервера: задан адрес доставки или выбил другой экземпляр (`reason` «terminated by other connection»). */
function wsConflictText(reason: string): string {
  return /terminated/i.test(reason) ? CONFLICT_TEXT : FATAL_CLOSE[4009][1];
}

/** Ошибка, после которой повторять запрос нет смысла (токен, права, адрес доставки, неверные параметры). */
function isFatal(e: unknown): e is GusVoiceApiError {
  return e instanceof GusVoiceApiError && [400, 401, 403, 404, 409].includes(e.code);
}

/**
 * Для цикла `getUpdates`: 400 НЕ фатален (аудит 26.10) — сервер новее/старее SDK может не понять параметр, а опрос должен
 * жить (незнакомые `allowed_updates` сервер и так отбрасывает); повтор с паузой. Остальное — как `isFatal`.
 */
function isFatalPoll(e: unknown): e is GusVoiceApiError {
  return isFatal(e) && e.code !== 400;
}

const jitter = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4));

// ─── Голос (API 4, #232) ─────────────────────────────────────────────────────────────────────────────────────────────
// `bot.voice` — тонкая обёртка: звук живёт в необязательном пакете `@gusvoice/bot-voice` (нативный `@livekit/rtc-node` +
// ffmpeg), основной SDK остаётся без зависимостей; дополнение подгружается при первом `join()`. Код здесь, а не в отдельном
// модуле: набор импортов `bot.ts` закрыт (его проверяет тест-харнесс).

export const VOICE_ADDON_NAME = '@gusvoice/bot-voice';

/** Дополнение `@gusvoice/bot-voice` не установлено. */
export class VoiceAddonMissing extends Error {
  override readonly name = 'VoiceAddonMissing';
  constructor(options?: { cause?: unknown }) {
    super(`Для звука установите ${VOICE_ADDON_NAME} (npm install ${VOICE_ADDON_NAME}) / Install ${VOICE_ADDON_NAME} to use voice`, options);
  }
}

/** Это ошибка «нет пакета дополнения», а не «у дополнения не нашёлся его собственный модуль» (например, `@livekit/rtc-node`). */
export function isAddonNotFound(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return false;
  return typeof message === 'string' && message.includes(`'${VOICE_ADDON_NAME}'`);
}

export interface BotVoiceDeps {
  api: Api;
  getMe(): Promise<BotUser>;
  log(message: string): void;
  /** Подмена загрузки дополнения (тесты); по умолчанию — `import('@gusvoice/bot-voice')`. */
  loadAddon?: () => Promise<VoiceAddon>;
}

async function defaultLoadAddon(): Promise<VoiceAddon> {
  // Имя в переменной: у основного пакета нет зависимости от дополнения, tsc и сборщики его не ищут.
  const name: string = VOICE_ADDON_NAME;
  return (await import(name)) as VoiceAddon;
}

export class BotVoice {
  private readonly deps: BotVoiceDeps;
  private addon: VoiceAddon | null = null;
  private readonly all = new Set<VoiceConnection>();
  private readonly listeners = new Set<(update: VoiceStateUpdated) => void>();

  constructor(deps: BotVoiceDeps) {
    this.deps = deps;
  }

  /** Подключения, которые ещё не закрыты (`leave()`). */
  get connections(): readonly VoiceConnection[] {
    for (const c of this.all) if (c.state === 'closed') this.all.delete(c);
    return [...this.all];
  }

  private async load(): Promise<VoiceAddon> {
    if (this.addon) return this.addon;
    try {
      this.addon = await (this.deps.loadAddon ?? defaultLoadAddon)();
    } catch (e) {
      if (isAddonNotFound(e)) throw new VoiceAddonMissing({ cause: e });
      throw e;
    }
    return this.addon;
  }

  /** Зайти в голосовой канал и получить управление звуком. Нужны права «Подключаться» и «Говорить». */
  async join(channelId: string, options: VoiceJoinOptions = {}): Promise<VoiceConnection> {
    const addon = await this.load();
    const host: VoiceHost = {
      api: this.deps.api,
      getMe: () => this.deps.getMe(),
      onVoiceState: (handler) => {
        this.listeners.add(handler);
        return () => this.listeners.delete(handler);
      },
      log: (m) => this.deps.log(m),
    };
    const vc = await addon.joinVoice(host, channelId, options);
    this.all.add(vc);
    return vc;
  }

  /** Вызывает `Bot` на каждое `voice_state` до пользовательских обработчиков. */
  handleVoiceState(update: VoiceStateUpdated): void {
    for (const h of [...this.listeners]) {
      try {
        h(update);
      } catch (e) {
        this.deps.log(`voice_state handler failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Выйти из всех каналов и освободить нативную часть (`bot.stop()`). Без звука в этом процессе ничего не делает. */
  async shutdown(): Promise<void> {
    const list = [...this.all];
    this.all.clear();
    await Promise.all(list.map((c) => c.leave().catch(() => {})));
    if (this.addon) await Promise.resolve(this.addon.dispose?.()).catch(() => {});
  }
}

export class Bot {
  readonly api: Api;
  /** Сам бот — после `start()` (или первого `getMe`). */
  me: BotUser | undefined;
  /**
   * Голос (API 4): `await bot.voice.join(channelId)`. Нужен необязательный пакет `@gusvoice/bot-voice`; без него `join()`
   * бросает `VoiceAddonMissing`. `bot.stop()` выходит из всех каналов.
   */
  readonly voice: BotVoice;

  private readonly handlers = new Map<UpdateType, Handler<any>[]>();
  private readonly commands = new Map<string, Handler<'message'>[]>();
  /** Описания команд для `setCommands()` (по порядку объявления). */
  private readonly commandDescriptions = new Map<string, string>();
  /** `bot.callbackQuery(…)`: первый совпавший забирает нажатие у `on('callback_query')`. */
  private readonly callbackRoutes: { match: string | RegExp; handler: Handler<'callback_query'> }[] = [];
  private readonly autoAnswer: boolean;
  private errorHandler: ErrorHandler = (err, ctx) => console.error(`[gusvoice-bot] handler failed${ctx ? ` (update ${ctx.update.update_id})` : ''}:`, err);
  private readonly wsCtor: WebSocketCtor | undefined;
  private readonly log: (message: string) => void;

  /** Последнее принятое событие (по нему — возобновление и подтверждение). */
  private lastUpdateId = 0;
  /** Очередь обработки: события идут строго по одному, по порядку. */
  private queue: Promise<void> = Promise.resolve();
  private running = false;
  private abort: AbortController | null = null;
  private closeSocket: (() => void) | null = null;
  private runPromise: Promise<void> | null = null;
  /** `getMe` для приёма на адрес уже спрашивали (не дёргать на каждой доставке, если не ответил). */
  private meAsked = false;
  /** Предупреждение «сервер новее SDK» уже было в этом `start()`. */
  private versionWarned = false;

  constructor(token: string, options: BotOptions) {
    this.api = new Api(token, options);
    this.wsCtor = options.WebSocket;
    this.autoAnswer = options.autoAnswerCallbackQuery !== false;
    this.log = options.log === false ? () => {} : (options.log ?? ((m) => console.warn(`[gusvoice-bot] ${m}`)));
    this.voice = new BotVoice({
      api: this.api,
      getMe: async () => (this.me ??= await this.api.getMe()),
      log: (m) => this.log(m),
    });
  }

  /** Обработчик событий типа `type` (`message`, `edited_message`, `message_deleted`, `my_chat_member`, `callback_query`; API 3: `message_reaction`, `chat_member`; API 4: `voice_state`). */
  on<K extends UpdateType>(type: K, handler: Handler<K>): this {
    if (!UPDATE_TYPES.includes(type)) throw new TypeError(`Unknown update type "${type}"`);
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
    return this;
  }

  /**
   * Команда: сообщение `/name аргументы` (или `/name@ник_бота …`) → `handler`, в `ctx.args` — аргументы.
   * Сообщение, попавшее в команду, обработчикам `on('message')` уже не идёт. `options.description` (1–256 знаков) — строка
   * подсказки по «/» у человека: такие команды публикует `setCommands()`.
   */
  command(name: string | string[], handler: Handler<'message'>, options: { description?: string } = {}): this {
    for (const n of Array.isArray(name) ? name : [name]) {
      const key = n.replace(/^\//, '').toLowerCase();
      if (!/^[a-z0-9_]{1,32}$/.test(key)) throw new TypeError(`Bad command name "${n}": 1–32 of a-z 0-9 _`);
      const list = this.commands.get(key) ?? [];
      list.push(handler);
      this.commands.set(key, list);
      const description = options.description?.trim();
      if (description) {
        if (description.length > 256) throw new TypeError(`Command "${key}": description must be 1–256 characters`);
        this.commandDescriptions.set(key, description);
      }
    }
    return this;
  }

  /**
   * Нажатие кнопки с `callback_data` = `data` (строка — точное совпадение; `RegExp` — совпадение в `ctx.match`). Первый
   * совпавший забирает нажатие; ни один не совпал — идёт в `on('callback_query')`. 🔴 `data` пришло от клиента человека:
   * проверяйте `ctx.from.id` и белые списки.
   */
  callbackQuery(data: string | RegExp | (string | RegExp)[], handler: Handler<'callback_query'>): this {
    for (const match of Array.isArray(data) ? data : [data]) this.callbackRoutes.push({ match, handler });
    return this;
  }

  /** Опубликовать команды с `description` (`bot.command(…, {description})`) — подсказка по «/» у человека. Замещает список. */
  setCommands(): Promise<true> {
    return this.api.setMyCommands([...this.commandDescriptions].map(([command, description]) => ({ command, description })));
  }

  /** Куда идут ошибки обработчиков (по умолчанию `console.error`); бот при этом продолжает работу. */
  catch(handler: ErrorHandler): this {
    this.errorHandler = handler;
    return this;
  }

  /**
   * Обработать одно событие (так его отдают WS, опрос и `webhookHandler`; годится и для своего транспорта).
   * Повтор уже обработанного `update_id` пропускается.
   */
  handleUpdate(update: Update): Promise<void> {
    const run = this.queue.then(() => this.dispatch(update));
    this.queue = run.catch(() => {});
    return run;
  }

  private async dispatch(update: Update): Promise<void> {
    if (!update || typeof update.update_id !== 'number') return;
    if (update.update_id <= this.lastUpdateId) return;
    this.lastUpdateId = update.update_id;
    const type = UPDATE_TYPES.find((t) => update[t] !== undefined);
    if (!type) return; // событие нового типа, о котором SDK ещё не знает
    if (type === 'voice_state' && update.voice_state) this.voice.handleVoiceState(update.voice_state);
    const ctx = new Context(this, update, type);
    let list: Handler<any>[] = this.handlers.get(type) ?? [];
    if (type === 'message' && ctx.command) {
      const cmd = this.commands.get(ctx.command);
      if (cmd) list = cmd;
    }
    if (type === 'callback_query') {
      const data = ctx.callbackData;
      for (const r of this.callbackRoutes) {
        if (typeof r.match === 'string') {
          if (r.match !== data) continue;
        } else {
          r.match.lastIndex = 0;
          const m = r.match.exec(data);
          if (!m) continue;
          ctx.match = m;
        }
        list = [r.handler];
        break;
      }
    }
    for (const h of list) {
      try {
        await h(ctx);
      } catch (err) {
        try {
          await this.errorHandler(err, ctx);
        } catch {
          /* обработчик ошибок сам упал — не роняем бота */
        }
      }
    }
    // Нажатие без ответа — пустой ответ, чтобы у человека погасли часики (и ошибка обработчика их не держит 15 с).
    if (type === 'callback_query' && this.autoAnswer && !ctx.callbackAnswered && update.callback_query) {
      ctx.callbackAnswered = true;
      await this.api.answerCallbackQuery(update.callback_query.id).catch(() => {});
    }
  }

  // ─── Запуск ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Получать события, пока не позовут `stop()`. Промис завершается после `stop()` и отклоняется при ошибке, после которой
   * работать нельзя (`GusVoiceApiError` 401 — токен перевыпущен/бот выключен, 403 — боты выключены, 409 — задан адрес доставки).
   */
  start(options: StartOptions = {}): Promise<void> {
    if (this.running) throw new Error('Bot is already running');
    this.running = true;
    this.versionWarned = false;
    this.abort = new AbortController();
    const mode = options.mode ?? 'ws';
    const run = (mode === 'polling' ? this.runPolling(options) : this.runWs(options)).finally(async () => {
      this.running = false;
      this.closeSocket = null;
      await this.queue;
    });
    this.runPromise = run.catch(() => {});
    return run;
  }

  /**
   * Сервер новее SDK (`api_version` больше `SDK_API_VERSION`) — один раз за `start()` предупреждаем в лог. Не ошибка:
   * провод меняется только добавлениями, бот продолжит работать, просто не увидит новых возможностей.
   */
  private warnIfServerNewer(me: BotUser): void {
    const server = me.api_version;
    if (this.versionWarned || typeof server !== 'number' || !(server > SDK_API_VERSION)) return;
    this.versionWarned = true;
    this.log(`server speaks Bot API ${server}, this SDK knows ${SDK_API_VERSION}: it keeps working, but newer methods and fields are not typed — update @gusvoice/bot`);
  }

  /** Остановить приём: обработка текущего события доводится до конца, принятое подтверждается серверу. */
  async stop(): Promise<void> {
    // Голос: выйти из каналов и освободить нативную часть (без звука в этом процессе — ничего).
    await this.voice.shutdown();
    if (!this.running) return this.runPromise ?? undefined;
    this.running = false;
    this.abort?.abort(new Error('bot stopped'));
    this.closeSocket?.();
    await this.runPromise;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async runPolling(options: StartOptions): Promise<void> {
    const signal = this.abort!.signal;
    this.me = await this.api.getMe();
    this.warnIfServerNewer(this.me);
    await options.onStart?.(this.me);
    const timeout = Math.min(Math.max(options.timeout ?? 30, 0), 50);
    let backoff = RECONNECT_MIN_MS;
    while (this.running) {
      try {
        const updates = await this.api.getUpdates(
          {
            ...(this.lastUpdateId > 0 ? { offset: this.lastUpdateId + 1 } : {}),
            timeout,
            limit: 100,
            ...(options.allowedUpdates ? { allowed_updates: options.allowedUpdates } : {}),
          },
          signal,
        );
        backoff = RECONNECT_MIN_MS;
        for (const u of updates) await this.handleUpdate(u);
      } catch (e) {
        if (!this.running) break;
        if (isFatalPoll(e)) {
          if (e.code === 409) this.log(`stopped: ${e.description}`);
          throw e;
        }
        this.log(`getUpdates failed (${e instanceof Error ? e.message : String(e)}), retry in ${Math.round(backoff / 1000)} s`);
        await sleep(jitter(backoff), signal).catch(() => {});
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      }
    }
    // Подтвердить обработанное: пустой `allowed_updates` ничего не отдаёт (и ничего не помечает прочитанным), но сдвигает offset.
    await this.queue;
    if (this.lastUpdateId > 0) {
      await this.api.getUpdates({ offset: this.lastUpdateId + 1, timeout: 0, limit: 1, allowed_updates: [] }).catch(() => {});
    }
  }

  private async runWs(options: StartOptions): Promise<void> {
    const Ctor = this.wsCtor ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (typeof Ctor !== 'function') {
      throw new Error(
        'WebSocket is not available in this runtime (Node.js < 22). Upgrade to Node.js 22+, pass a constructor ' +
          "(new Bot(token, { baseUrl, WebSocket })) from the 'ws' package, or use bot.start({ mode: 'polling' }).",
      );
    }
    const signal = this.abort!.signal;
    let backoff = RECONNECT_MIN_MS;
    let started = false;
    while (this.running) {
      let session: { code: number; reason: string; hello: boolean };
      try {
        session = await this.wsSession(Ctor, async (me) => {
          backoff = RECONNECT_MIN_MS;
          if (!started) {
            started = true;
            this.warnIfServerNewer(me);
            await options.onStart?.(me);
          }
        });
      } catch (e) {
        session = { code: 0, reason: e instanceof Error ? e.message : String(e), hello: false };
      }
      if (!this.running) break;
      const fatal = FATAL_CLOSE[session.code];
      if (fatal) {
        const text = session.code === 4009 ? wsConflictText(session.reason) : fatal[1];
        if (session.code === 4009) this.log(`stopped: ${text}`);
        // Выбил другой экземпляр — текст ровно как у Telegram 409, причина в нём уже сказана.
        const conflict = text === CONFLICT_TEXT;
        throw new GusVoiceApiError(fatal[0], session.reason && !conflict ? `${text} (${session.reason})` : text, undefined, 'ws');
      }
      if (!session.hello) {
        // Не дошли до приветствия: может, дело в токене или адресе — `getMe` скажет точно.
        try {
          this.me = await this.api.getMe();
        } catch (e) {
          if (isFatal(e)) throw e;
        }
      }
      const wait = session.code === 4029 ? Math.max(backoff, 5000) : backoff;
      this.log(`WS closed (${session.code}${session.reason ? ` ${session.reason}` : ''}), reconnect in ${Math.round(wait / 1000)} s`);
      await sleep(jitter(wait), signal).catch(() => {});
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    }
  }

  /** Одно WS-соединение: до закрытия. */
  private async wsSession(Ctor: WebSocketCtor, onHello: (me: BotUser) => Promise<void>): Promise<{ code: number; reason: string; hello: boolean }> {
    const url = await this.api.wsUrl(this.lastUpdateId > 0 ? this.lastUpdateId + 1 : undefined);
    return new Promise((resolve) => {
      const ws = new Ctor(url, { headers: { authorization: this.api.authHeader() } });
      let hello = false;
      let lastSeen = Date.now();
      let inflight = 0;
      let sinceAck = 0;
      let acked = this.lastUpdateId;
      const send = (msg: object) => {
        if (ws.readyState === 1) {
          try {
            ws.send(JSON.stringify(msg));
          } catch {
            /* закрывается */
          }
        }
      };
      const ack = () => {
        if (this.lastUpdateId > acked) {
          acked = this.lastUpdateId;
          sinceAck = 0;
          send({ op: 'ack', offset: acked + 1 });
        }
      };
      const pinger = setInterval(() => {
        if (Date.now() - lastSeen > WS_SILENCE_MS) ws.close(4000, 'no response');
        else send({ op: 'ping' });
      }, WS_PING_MS);
      this.closeSocket = () => {
        ack();
        ws.close(1000, 'bot stopped');
      };
      ws.onmessage = (ev) => {
        lastSeen = Date.now();
        let msg: { op?: string; bot?: BotUser; update?: Update };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.op === 'hello' && msg.bot) {
          hello = true;
          this.me = msg.bot;
          void onHello(msg.bot).catch((err) => this.errorHandler(err));
        } else if (msg.op === 'update' && msg.update) {
          inflight++;
          void this.handleUpdate(msg.update).finally(() => {
            inflight--;
            if (inflight === 0 || ++sinceAck >= ACK_EVERY) ack();
          });
        }
      };
      ws.onerror = () => {
        /* за ошибкой всегда следует close */
      };
      ws.onclose = (ev) => {
        clearInterval(pinger);
        if (this.closeSocket) this.closeSocket = null;
        resolve({ code: ev.code, reason: ev.reason, hello });
      };
    });
  }

  // ─── Доставка на адрес ─────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Приём доставки на адрес (`setWebhook`): `(Request) => Promise<Response>` для Bun/Deno/Workers, для `node:http` —
   * через `toNodeHandler`. Подпись проверяется (окно 5 мин, сравнение за постоянное время): подделка → 401.
   * Ответ 200 — после обработки события (сервер ждёт до 10 с); упавший обработчик уходит в `bot.catch`, ответ всё равно 200
   * (иначе сервер слал бы то же событие снова, а после 10 сбоев выключил бы доставку).
   */
  webhookHandler(options: WebhookHandlerOptions): (req: Request) => Promise<Response> {
    if (!options?.secret) throw new TypeError('webhookHandler: secret is required (the one passed to setWebhook)');
    return async (req) => {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } });
      const body = new Uint8Array(await req.arrayBuffer());
      const valid = await verifyWebhookSignature(options.secret, req.headers.get(SIGNATURE_HEADER), body, options);
      if (!valid) return new Response('bad signature', { status: 401 });
      // Пакетная доставка (API 3, `setWebhook(…, {batch: true})`): тело — массив событий, обрабатываются по порядку.
      let updates: Update[];
      try {
        const parsed = JSON.parse(new TextDecoder().decode(body)) as Update | Update[];
        updates = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return new Response('bad json', { status: 400 });
      }
      if (!this.me && !this.meAsked) {
        this.meAsked = true;
        // Ник бота нужен разбору `/команда@ник`; без `start()` узнаём один раз.
        this.me = await this.api.getMe().catch(() => undefined);
      }
      for (const update of updates) await this.handleUpdate(update);
      return new Response('ok', { status: 200 });
    };
  }
}
