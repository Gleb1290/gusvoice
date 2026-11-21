/**
 * Боты (#229) — база и Redis: настройка инстанса (читается в МОМЕНТ запроса, урок 0.9.14), бот по токену, журнал событий
 * (`bot_updates`), будильник ожидающих (Redis pub/sub `bot:upd:<id>` — долгий опрос и WS не крутят базу) и уборка.
 */
import type { BotCommandInfo, BotCommandsScoped, BotSettings } from '@gusvoice/shared';
import { and, asc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { db } from '../db/index.js';
import { botUpdates, bots, instanceSettings, serverBots, servers, users } from '../db/schema.js';
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

export async function botById(botId: string, q: Pick<typeof db, 'select'> = db): Promise<{ bot: BotRow; user: UserRow } | null> {
  const [row] = await q.select({ bot: bots, user: users }).from(bots).innerJoin(users, eq(users.id, bots.userId)).where(eq(bots.userId, botId)).limit(1);
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

type BotTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PendingUpdate = { botId: string; type: BotUpdateType; payload: Record<string, unknown>; readAll?: boolean };

/** Записать событие и разбудить потребителей после коммита. Отозванный доступ к серверу даёт `null`. */
export async function pushUpdate(botId: string, type: BotUpdateType, payload: Record<string, unknown>): Promise<number | null> {
  return (await appendUpdates([{ botId, type, payload }])).get(botId) ?? null;
}

/** Разлёт по ботам с одной многострочной вставкой. Возвращает ботов, которым записано событие. */
export async function pushUpdates(rows: readonly PendingUpdate[]): Promise<string[]> {
  return [...(await appendUpdates(rows)).keys()];
}

function serverScope({ payload }: PendingUpdate): string | undefined {
  const message = payload.message as { chat?: unknown } | undefined;
  const chat = (payload.chat ?? message?.chat) as { type?: unknown; id?: unknown; server_id?: unknown } | undefined;
  if (typeof chat?.server_id === 'string') return chat.server_id;
  if (chat?.type === 'server' && typeof chat.id === 'string') return chat.id;
  return undefined;
}

function isLeaveNotice({ type, payload }: PendingUpdate): boolean {
  return type === 'my_chat_member' && (payload.chat as { type?: unknown } | undefined)?.type === 'server' && (payload.new_status === 'left' || payload.new_status === 'kicked');
}

async function appendUpdates(rows: readonly PendingUpdate[]): Promise<Map<string, number>> {
  if (rows.length === 0) return new Map();
  const ids = [...new Set(rows.map((r) => r.botId))];
  const last = await db.transaction(async (tx) => {
    const scoped = rows.map((row) => ({ row, serverId: serverScope(row), leaving: isLeaveNotice(row) }));
    const serverIds = [...new Set(scoped.flatMap((r) => r.serverId ? [r.serverId] : []))];
    const leaveServers = [...new Set(scoped.flatMap((r) => r.leaving && r.serverId ? [r.serverId] : []))];
    const liveServers = leaveServers.length === 0 ? [] : await tx.select({ id: servers.id }).from(servers)
      .where(inArray(servers.id, leaveServers)).orderBy(asc(servers.id)).for('key share');
    // Аудитория могла измениться, пока крючок ждал очередь. Блокировка держит членство до коммита записи.
    const memberships = serverIds.length === 0 ? [] : await tx.select({
      botId: serverBots.botId, serverId: serverBots.serverId,
    }).from(serverBots).where(and(inArray(serverBots.botId, ids), inArray(serverBots.serverId, serverIds)))
      .orderBy(asc(serverBots.serverId), asc(serverBots.botId)).for('key share');
    // Единый порядок с удалением сервера: сервер/членство → боты по ID → журнал.
    // Блокировка бота до INSERT упорядочивает выдачу update_id и коммит.
    const existing = new Set((await lockJournals(tx, ids)).map((r) => r.id));
    const live = new Set(liveServers.map((r) => r.id));
    const member = new Set(memberships.map((r) => JSON.stringify([r.botId, r.serverId])));
    const accepted = scoped.filter(({ row, serverId, leaving }) => existing.has(row.botId) &&
      (!serverId || (leaving ? live.has(serverId) : member.has(JSON.stringify([row.botId, serverId])))));
    if (accepted.length === 0) return new Map<string, number>();
    const inserted = await tx.insert(botUpdates).values(accepted.map(({ row: { botId, type, payload } }) => ({ botId, type, payload })))
      .returning({ updateId: botUpdates.updateId, botId: botUpdates.botId });
    const last = new Map<string, number>();
    for (const r of inserted) last.set(r.botId, Math.max(last.get(r.botId) ?? 0, r.updateId));
    const readAll = new Set(accepted.filter(({ row }) => row.readAll === true).map(({ row }) => row.botId));
    const highCaps = await tx.selectDistinct({ id: serverBots.botId }).from(serverBots)
      .where(and(inArray(serverBots.botId, [...last.keys()]), eq(serverBots.readAll, true)));
    for (const r of highCaps) readAll.add(r.id);
    await trimJournal(tx, [...last.keys()].map((botId) => ({
      botId, cap: readAll.has(botId) ? BOT_UPDATES_CAP_READ_ALL : BOT_UPDATES_CAP,
    })));
    return last;
  });
  if (last.size > 0) {
    const { redisPub } = await import('../realtime.js');
    await Promise.all([...last].map(([botId, updateId]) => redisPub.publish(wakeChannel(botId), String(updateId)).catch(() => 0)));
  }
  return last;
}

/** DELETE и INSERT меняют счётчик через триггеры. Сначала берём строки ботов, всегда в одном порядке. */
async function lockJournals(tx: BotTransaction, botIds: readonly string[]) {
  return tx.select({ id: bots.userId }).from(bots)
    .where(inArray(bots.userId, [...botIds])).orderBy(asc(bots.userId)).for('no key update');
}

/** Точное превышение уже известно из счётчика. База читает первые n записей индекса, обычно одну. */
async function trimJournal(tx: BotTransaction, queues: readonly { botId: string; cap: number }[]): Promise<number> {
  const input = sql.join(queues.map(({ botId, cap }) => sql`(${botId}::text, ${cap}::int)`), sql`, `);
  const result = await tx.execute<{ dropped: number }>(sql`
    WITH queues(bot_id, cap) AS (VALUES ${input})
    SELECT coalesce(sum(trim_bot_journal(b.user_id, b.journal_size - q.cap)), 0)::int AS dropped
    FROM queues q JOIN bots b ON b.user_id = q.bot_id
    WHERE b.journal_size > q.cap
  `);
  return result.rows[0]?.dropped ?? 0;
}

const updateServerId = sql<string | null>`coalesce(
  ${botUpdates.payload} #>> '{chat,server_id}',
  ${botUpdates.payload} #>> '{message,chat,server_id}',
  CASE WHEN ${botUpdates.payload} #>> '{chat,type}' = 'server' THEN ${botUpdates.payload} #>> '{chat,id}' END
)`;

function serverUpdateVisible() {
  return sql`(${updateServerId} IS NULL OR EXISTS (
    SELECT 1 FROM server_bots sb WHERE sb.bot_id = ${botUpdates.botId} AND sb.server_id = ${updateServerId}
  ) OR (
    ${botUpdates.type} = 'my_chat_member' AND ${botUpdates.payload} #>> '{chat,type}' = 'server'
    AND ${botUpdates.payload} #>> '{new_status}' IN ('left', 'kicked')
    AND EXISTS (SELECT 1 FROM servers s WHERE s.id = ${updateServerId})
  ))`;
}

/** Проверка непосредственно перед POST: пачка могла утратить право на доставку после выборки. */
export function journalContains(botId: string, ids: readonly number[]) {
  const matching = and(eq(botUpdates.botId, botId), inArray(botUpdates.updateId, [...ids]), notStale(), serverUpdateVisible());
  return sql`(SELECT count(*) FROM bot_updates WHERE ${matching}) = ${ids.length}`;
}

/** Убрать события сервера у снятого бота. Его новое `my_chat_member` записывается отдельно. */
export async function dropServerUpdates(botId: string, serverId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockJournals(tx, [botId]);
    await tx.delete(botUpdates).where(and(eq(botUpdates.botId, botId), eq(updateServerId, serverId)));
  });
}

/** Вызывать в транзакции удаления сервера после каскадного удаления членства. */
export async function dropDeletedServerUpdates(tx: BotTransaction, serverId: string): Promise<void> {
  const scoped = eq(updateServerId, serverId);
  const affected = await tx.selectDistinct({ id: botUpdates.botId }).from(botUpdates).where(scoped);
  if (affected.length === 0) return;
  const ids = affected.map((r) => r.id);
  await lockJournals(tx, ids);
  await tx.delete(botUpdates).where(and(inArray(botUpdates.botId, ids), scoped));
}

/**
 * Подтвердить всё до `offset` (не включая) — как `offset` у Telegram. Возвращает снятые строки (вид + груз): WS `ack` по ним
 * отмечает «прочитано» (`bots/botRead.ts`).
 */
export async function confirmUpdates(botId: string, offset: number): Promise<{ type: string; payload: unknown }[]> {
  return db.transaction(async (tx) => {
    await lockJournals(tx, [botId]);
    return tx.delete(botUpdates)
      .where(and(eq(botUpdates.botId, botId), lt(botUpdates.updateId, offset)))
      .returning({ type: botUpdates.type, payload: botUpdates.payload });
  });
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
      and(eq(botUpdates.botId, botId), gte(botUpdates.updateId, fromId), types ? inArray(botUpdates.type, [...types]) : undefined, notStale(), serverUpdateVisible()),
    )
    .orderBy(asc(botUpdates.updateId))
    .limit(limit);
}

export async function dropUpdates(botId: string, tx?: BotTransaction): Promise<void> {
  if (!tx) return db.transaction((q) => dropUpdates(botId, q));
  await lockJournals(tx, [botId]);
  await tx.delete(botUpdates).where(eq(botUpdates.botId, botId));
}

export async function pendingCount(botId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(botUpdates).where(and(eq(botUpdates.botId, botId), notStale(), serverUpdateVisible()));
  return Number(r?.n ?? 0);
}

/** Событие → объект провода `{update_id, <type>: payload}`. */
export function wireUpdateOf(u: BotUpdateRow): Record<string, unknown> {
  return { update_id: u.updateId, [u.type]: u.payload };
}

/** Уборка: старше суток и сверх потолка на бота (старые первыми). Число удалённых. */
export async function pruneBotUpdates(now = Date.now()): Promise<number> {
  const expired = or(
    lt(botUpdates.createdAt, new Date(now - BOT_UPDATES_TTL_MS)),
    and(eq(botUpdates.type, 'callback_query'), lt(botUpdates.createdAt, new Date(now - CALLBACK_QUERY_STALE_S * 1000))),
  );
  const [old, over] = await Promise.all([
    db.selectDistinct({ id: botUpdates.botId }).from(botUpdates).where(expired),
    db.select({ id: bots.userId }).from(bots).where(gt(bots.journalSize, BOT_UPDATES_CAP_READ_ALL)),
  ]);
  let removed = 0;
  for (const botId of new Set([...old, ...over].map((r) => r.id))) {
    removed += await db.transaction(async (tx) => {
      await lockJournals(tx, [botId]);
      const deleted = await tx.delete(botUpdates).where(and(eq(botUpdates.botId, botId), expired)).returning({ id: botUpdates.updateId });
      const trimmed = await trimJournal(tx, [{ botId, cap: BOT_UPDATES_CAP_READ_ALL }]);
      return deleted.length + trimmed;
    });
  }
  return removed;
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
