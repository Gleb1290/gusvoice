/**
 * Боты (#229) — база и Redis: настройка инстанса (читается в МОМЕНТ запроса, урок 0.9.14), бот по токену, журнал событий
 * (`bot_updates`), будильник ожидающих (Redis pub/sub `bot:upd:<id>` — долгий опрос и WS не крутят базу) и уборка.
 */
import type { BotCommandInfo, BotCommandsScoped, BotSettings } from '@gusvoice/shared';
import { and, asc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { db } from '../db/index.js';
import { botUpdates, bots, instanceSettings, serverBots, users } from '../db/schema.js';
import { env } from '../env.js';
import { BOT_UPDATES_CAP, BOT_UPDATES_CAP_READ_ALL, BOT_UPDATES_TTL_MS, type BotCommandScope, type BotUpdateType, botTokenMatches, CALLBACK_QUERY_STALE_S, BOTS_SETTINGS_KEY, hashBotToken, normalizeBotSettings } from './botRules.js';

export type BotRow = typeof bots.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type BotUpdateRow = typeof botUpdates.$inferSelect;

// ─── Настройка инстанса ──────────────────────────────────────────────────────────────────────────────────────────────

/** Текущая настройка — из базы на каждый вызов (тумблер админа действует сразу, без перезапуска). */
/** `q` — транзакция вызывающего: внутри неё общий `db` брал бы второе соединение (на PGlite — вечное ожидание самого себя). */
export async function readBotSettings(q: Pick<typeof db, 'select'> = db): Promise<BotSettings & { enabled: boolean }> {
  const [row] = await q.select({ value: instanceSettings.value }).from(instanceSettings).where(eq(instanceSettings.key, BOTS_SETTINGS_KEY)).limit(1);
  return normalizeBotSettings(row?.value);
}

export async function writeBotSettings(next: BotSettings & { enabled?: boolean }): Promise<BotSettings & { enabled: boolean }> {
  const value = normalizeBotSettings(next) as unknown as Record<string, unknown>;
  await db
    .insert(instanceSettings)
    .values({ key: BOTS_SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: new Date() } });
  return normalizeBotSettings(value);
}

// ─── Бот ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Бот по токену (поиск по хешу + сравнение за постоянное время). Удалённый — `null`; выключенный — как есть (решает вызывающий). */
export async function botByToken(token: string): Promise<{ bot: BotRow; user: UserRow } | null> {
  const [row] = await db
    .select({ bot: bots, user: users })
    .from(bots)
    .innerJoin(users, eq(users.id, bots.userId))
    .where(eq(bots.tokenHash, hashBotToken(token)))
    .limit(1);
  if (!row || !botTokenMatches(token, row.bot.tokenHash) || row.user.deletedAt) return null;
  return row;
}

export async function botById(botId: string): Promise<{ bot: BotRow; user: UserRow } | null> {
  const [row] = await db.select({ bot: bots, user: users }).from(bots).innerJoin(users, eq(users.id, bots.userId)).where(eq(bots.userId, botId)).limit(1);
  return row ?? null;
}

/** Живые (не выключенные админом, не удалённые) боты среди `ids`. */
export async function liveBotsAmong(ids: readonly string[]): Promise<Map<string, BotRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ bot: bots })
    .from(bots)
    .innerJoin(users, eq(users.id, bots.userId))
    .where(and(inArray(bots.userId, [...ids]), isNull(bots.disabledAt), isNull(users.deletedAt)));
  return new Map(rows.map((r) => [r.bot.userId, r.bot]));
}

// ─── Журнал событий ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Записать событие и разбудить ждущих (долгий опрос, WS) на любом процессе. Потолок журнала `BOT_UPDATES_CAP` держится
 * ЗДЕСЬ, на вставке (аудит 26.10): часовая уборка `pruneBotUpdates` — только страховка, а между её проходами бот, который
 * не забирает события, копил бы их без предела. Сверх потолка уходят самые старые этого бота (`update_id` — общий на инстанс,
 * у бота не подряд → граница — `OFFSET` от свежего).
 */
export async function pushUpdate(botId: string, type: BotUpdateType, payload: Record<string, unknown>): Promise<number> {
  const [row] = await db.insert(botUpdates).values({ botId, type, payload }).returning({ updateId: botUpdates.updateId });
  await trimJournal(botId, await capOf(botId));
  const { redisPub } = await import('../realtime.js');
  await redisPub.publish(wakeChannel(botId), String(row.updateId)).catch(() => 0);
  return row.updateId;
}

/** Потолок журнала бота: «читать всё» хоть на одном сервере — `BOT_UPDATES_CAP_READ_ALL` (#231), иначе `BOT_UPDATES_CAP`. */
async function capOf(botId: string): Promise<number> {
  const [r] = await db
    .select({ one: sql<number>`1` })
    .from(serverBots)
    .where(and(eq(serverBots.botId, botId), eq(serverBots.readAll, true)))
    .limit(1);
  return r ? BOT_UPDATES_CAP_READ_ALL : BOT_UPDATES_CAP;
}

/** Срезать сверх потолка (старые первыми) и посчитать потерю (`bots.dropped_update_count`, #231 — бот видит, что терял). */
async function trimJournal(botId: string, cap: number): Promise<void> {
  const res = await db.execute(sql`
    DELETE FROM bot_updates WHERE bot_id = ${botId} AND update_id < (
      SELECT update_id FROM bot_updates WHERE bot_id = ${botId} ORDER BY update_id DESC OFFSET ${cap - 1} LIMIT 1
    )`);
  const dropped = Number((res as { rowCount?: number }).rowCount ?? 0);
  if (dropped > 0) {
    await db
      .update(bots)
      .set({ droppedUpdateCount: sql`least(${bots.droppedUpdateCount}::bigint + ${dropped}, 2147483647)::int` })
      .where(eq(bots.userId, botId));
  }
}

/**
 * Пачка событий (#231, разлёт события канала по ботам): ОДИН многострочный INSERT, затем потолок журнала на каждого бота
 * (тот же, что у `pushUpdate`; `readAll` уже известен вызывающему) и будильник каждому. Возвращает ботов, кому записано.
 */
export async function pushUpdates(rows: readonly { botId: string; type: BotUpdateType; payload: Record<string, unknown>; readAll?: boolean }[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const inserted = await db
    .insert(botUpdates)
    .values(rows.map((r) => ({ botId: r.botId, type: r.type, payload: r.payload })))
    .returning({ updateId: botUpdates.updateId, botId: botUpdates.botId });
  const last = new Map<string, number>();
  for (const r of inserted) last.set(r.botId, Math.max(last.get(r.botId) ?? 0, r.updateId));
  const readAll = new Map<string, boolean>();
  for (const r of rows) if (r.readAll !== undefined) readAll.set(r.botId, readAll.get(r.botId) === true || r.readAll);
  const { redisPub } = await import('../realtime.js');
  for (const [botId, updateId] of last) {
    const known = readAll.get(botId);
    await trimJournal(botId, known === undefined ? await capOf(botId) : known ? BOT_UPDATES_CAP_READ_ALL : BOT_UPDATES_CAP);
    await redisPub.publish(wakeChannel(botId), String(updateId)).catch(() => 0);
  }
  return [...last.keys()];
}

/**
 * Снятие бота с сервера (#231, решение владельца: «снятие бота чистит роль и подписки»): его события ЭТОГО сервера — сообщения
 * каналов, реакции, нажатия (`chat.server_id` / `message.chat.server_id`). ЛС и другие серверы целы.
 */
export async function dropServerUpdates(botId: string, serverId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM bot_updates WHERE bot_id = ${botId}
      AND (payload #>> '{chat,server_id}' = ${serverId} OR payload #>> '{message,chat,server_id}' = ${serverId})`);
}

/**
 * Подтвердить всё до `offset` (не включая) — как `offset` у Telegram. Возвращает снятые строки (вид + груз): WS `ack` по ним
 * отмечает «прочитано» (`bots/botRead.ts`).
 */
export async function confirmUpdates(botId: string, offset: number): Promise<{ type: string; payload: unknown }[]> {
  return db
    .delete(botUpdates)
    .where(and(eq(botUpdates.botId, botId), lt(botUpdates.updateId, offset)))
    .returning({ type: botUpdates.type, payload: botUpdates.payload });
}

/**
 * Не протухшее: `callback_query` старше `CALLBACK_QUERY_STALE_S` боту НЕ отдаётся (#230, безопасность) — бот панели, лежавший
 * час, при старте не выполнит старое «Перезапустить». Фильтр один на getUpdates, WS и доставку на адрес (все берут `updatesFrom`).
 */
function notStale() {
  return or(ne(botUpdates.type, 'callback_query'), gte(botUpdates.createdAt, sql`now() - make_interval(secs => ${CALLBACK_QUERY_STALE_S})`));
}

/** События с `fromId` включительно, по порядку; `types` — только эти виды (`allowed_updates`). */
export async function updatesFrom(botId: string, fromId: number, limit: number, types?: readonly string[]): Promise<BotUpdateRow[]> {
  return db
    .select()
    .from(botUpdates)
    .where(
      and(eq(botUpdates.botId, botId), gte(botUpdates.updateId, fromId), types ? inArray(botUpdates.type, [...types]) : undefined, notStale()),
    )
    .orderBy(asc(botUpdates.updateId))
    .limit(limit);
}

export async function dropUpdates(botId: string): Promise<void> {
  await db.delete(botUpdates).where(eq(botUpdates.botId, botId));
}

export async function pendingCount(botId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(botUpdates).where(and(eq(botUpdates.botId, botId), notStale()));
  return Number(r?.n ?? 0);
}

/** Событие → объект провода `{update_id, <type>: payload}`. */
export function wireUpdateOf(u: BotUpdateRow): Record<string, unknown> {
  return { update_id: u.updateId, [u.type]: u.payload };
}

/** Уборка: старше суток и сверх потолка на бота (старые первыми). Число удалённых. */
export async function pruneBotUpdates(now = Date.now()): Promise<number> {
  const old = await db
    .delete(botUpdates)
    .where(
      or(
        lt(botUpdates.createdAt, new Date(now - BOT_UPDATES_TTL_MS)),
        // Протухшее нажатие (#230) боту всё равно не отдаётся — место в журнале не держит.
        and(eq(botUpdates.type, 'callback_query'), lt(botUpdates.createdAt, new Date(now - CALLBACK_QUERY_STALE_S * 1000))),
      ),
    )
    .returning({ id: botUpdates.updateId });
  const over = await db.execute(sql`
    DELETE FROM bot_updates WHERE update_id IN (
      SELECT update_id FROM (
        SELECT update_id, row_number() OVER (PARTITION BY bot_id ORDER BY update_id DESC) AS rn FROM bot_updates
      ) x WHERE x.rn > ${BOT_UPDATES_CAP_READ_ALL}
    )`);
  return old.length + Number((over as { rowCount?: number }).rowCount ?? 0);
}

// ─── Команды (#230) ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `setMyCommands` / `deleteMyCommands`: список целиком (уже проверен `botWire`); `[]` — снять. Область (#231): `default` —
 * `bots.commands`; `all_private_chats` / `all_group_chats` — ключ в `bots.commands_scoped`. `null` у области — снять её
 * (`deleteMyCommands` со scope: дальше действует `default`, как в Telegram).
 */
export async function setBotCommands(botId: string, commands: BotCommandInfo[] | null, scope: BotCommandScope = 'default'): Promise<void> {
  const list = (commands ?? []).map((c) => ({ command: c.command, description: c.description }));
  if (scope === 'default') {
    await db.update(bots).set({ commands: list, commandsUpdatedAt: new Date() }).where(eq(bots.userId, botId));
    return;
  }
  const [row] = await db.select({ scoped: bots.commandsScoped }).from(bots).where(eq(bots.userId, botId)).limit(1);
  const next: BotCommandsScoped = { ...(row?.scoped ?? {}) };
  if (commands === null) delete next[scope];
  else next[scope] = list;
  await db.update(bots).set({ commandsScoped: next, commandsUpdatedAt: new Date() }).where(eq(bots.userId, botId));
}

/** Команды бота для области: на сервере — `all_group_chats`, в ЛС — `all_private_chats`, иначе `default` (как Telegram). */
export function commandsFor(bot: Pick<BotRow, 'commands' | 'commandsScoped'>, where: 'dm' | 'server'): BotCommandInfo[] {
  const own = where === 'server' ? bot.commandsScoped?.all_group_chats : bot.commandsScoped?.all_private_chats;
  return (own ?? bot.commands ?? []).map((c) => ({ command: c.command, description: c.description }));
}

// ─── Будильник (Redis pub/sub) ───────────────────────────────────────────────────────────────────────────────────────

export function wakeChannel(botId: string): string {
  return `bot:upd:${botId}`;
}

let sub: Redis | null = null;
const waiters = new Map<string, Set<() => void>>();
/** Подписка канала бота подтверждена Redis (ответ на SUBSCRIBE) — общий обещанный итог на всех ждущих этого бота в процессе. */
const subscribed = new Map<string, Promise<void>>();
/** Потолок ожидания подтверждения SUBSCRIBE: Redis лёг — не держать ждущего вечно, журнал прочитаем и так (страховка, не пауза). */
const WAKE_READY_CAP_MS = 5_000;

function fireAll(): void {
  for (const set of [...waiters.values()]) for (const fn of [...set]) fn();
}

/**
 * Отдельное соединение-подписчик (в режиме подписки ioredis не выполняет обычные команды) — одно на процесс, лениво, при
 * первом ждущем; каналы — по боту, пока у бота есть ждущие в этом процессе. После переподключения ioredis сам
 * переподписывает каналы, но всё, что опубликовали за обрыв, потеряно → когда переподписка подтверждена (PING идёт за ней
 * по тому же соединению), будим всех ждущих: они перечитают журнал.
 */
function subscriber(): Redis {
  if (sub) return sub;
  const s = new Redis(env.redisUrl);
  sub = s;
  s.on('message', (channel: string) => {
    const botId = channel.startsWith('bot:upd:') ? channel.slice(8) : null;
    if (!botId) return;
    for (const fn of [...(waiters.get(botId) ?? [])]) fn();
  });
  let firstReady = true;
  s.on('ready', () => {
    if (firstReady) {
      firstReady = false;
      return;
    }
    void s.ping().catch(() => '').finally(fireAll);
  });
  s.on('error', (err) => console.warn('[bots] подписка Redis:', err.message));
  return s;
}

export interface BotWake {
  /** Отписка (повторный вызов безвреден). */
  off: () => void;
  /**
   * Подписка подтверждена Redis: событие, опубликованное ПОСЛЕ этого, точно разбудит `fn`. Порядок у ждущих — «подписка
   * встала → выборка журнала»: иначе событие, записанное между выборкой и подтверждением SUBSCRIBE, будильник не принесёт
   * (#229). Не отклоняется: сбой Redis или потолок `WAKE_READY_CAP_MS` — тоже «готово» (журнал всё равно источник правды).
   */
  ready: Promise<void>;
}

/** Звать `fn` на каждое новое событие бота (это только сигнал «загляни в журнал»). */
export function listenBotWake(botId: string, fn: () => void): BotWake {
  let set = waiters.get(botId);
  if (!set) {
    set = new Set();
    waiters.set(botId, set);
    // Команды одного соединения Redis выполняет по порядку: UNSUBSCRIBE прошлого ждущего уже ушёл раньше этого SUBSCRIBE.
    const p = subscriber()
      .subscribe(wakeChannel(botId))
      .then(
        () => undefined,
        () => undefined,
      );
    subscribed.set(botId, p);
  }
  set.add(fn);
  // Снятый ждущий отпускает `ready` сразу (`release` в `off`): иначе WS, закрытый до ответа на SUBSCRIBE, висел бы на нём вечно (Codex R298).
  let release: () => void = () => {};
  const released = new Promise<void>((res) => (release = res));
  const confirmed = Promise.race([subscribed.get(botId) ?? Promise.resolve(), released]);
  let cap: ReturnType<typeof setTimeout> | undefined;
  const ready = Promise.race([confirmed, new Promise<void>((res) => (cap = setTimeout(res, WAKE_READY_CAP_MS)))]).finally(() => clearTimeout(cap));
  let done = false;
  const off = (): void => {
    if (done) return;
    done = true;
    clearTimeout(cap);
    release();
    const s = waiters.get(botId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) {
      waiters.delete(botId);
      subscribed.delete(botId);
      void subscriber().unsubscribe(wakeChannel(botId)).catch(() => {});
    }
  };
  return { off, ready };
}

/** Звать `fn` на каждое новое событие бота; возвращает отписку. Без ожидания подписки — для новых мест `listenBotWake`. */
export function onBotWake(botId: string, fn: () => void): () => void {
  return listenBotWake(botId, fn).off;
}

export interface BotWakeAlarm {
  /** Подписка встала (см. `BotWake.ready`) — теперь читать журнал. */
  ready: Promise<void>;
  /** Будильник сработал (событие после взвода — запоминается, даже если `wait` ещё не ждут), истёк срок или `signal`. */
  wait: Promise<void>;
  cancel: () => void;
}

/**
 * Взвести будильник на `ms` (или до `signal`) ДО выборки журнала: `await ready` → выборка → пусто → `await wait`. Событие,
 * записанное в любой момент после взвода, не проспать.
 */
export function armBotWake(botId: string, ms: number, signal?: AbortSignal): BotWakeAlarm {
  let resolve!: () => void;
  const wait = new Promise<void>((res) => (resolve = res));
  let wake: BotWake | null = null;
  const done = (): void => {
    clearTimeout(timer);
    wake?.off();
    signal?.removeEventListener('abort', done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  wake = listenBotWake(botId, done);
  signal?.addEventListener('abort', done, { once: true });
  if (signal?.aborted) done();
  return { ready: Promise.race([wake.ready, wait]), wait, cancel: done };
}

/** Ждать события не дольше `ms` (или до `signal`). ⚠️ Выборку журнала до вызова не защищает — для «выборка → ждать» `armBotWake`. */
export function waitBotWake(botId: string, ms: number, signal?: AbortSignal): Promise<void> {
  return armBotWake(botId, ms, signal).wait;
}
