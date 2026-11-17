import type { GameFamily } from '@gusvoice/shared';
import { sql, type SQL } from 'drizzle-orm';
import { EARNED_REASONS } from './coinRules.js';
import type { db } from './db/index.js';
import { GAME_LOSS_REASONS } from './gameMoneyRules.js';
import type {
  GameMonthInput,
  TitleDuel,
  TitleEvent,
  TitleJackpot,
  TitleLedgerNet,
  TitleLossDay,
  TitleMove,
  TitleStake,
  TitleVoice,
  TitleVoiceEntry,
} from './gameTitlesRules.js';

/**
 * Выборка месяца игр для званий, лидерборда и «Итогов» (ГусКоины 2, этап 6) — ТОЛЬКО SQL за окно `[from, to)`. Пороги,
 * равенства, медианы и серии — чистые функции `gameTitlesRules.ts`.
 *
 * Окна: строки журнала — по `created_at` (журнал — источник денег), раунды и их ставки — по `settled_at` рассчитанных
 * (`state = 'settled'`, возвращённые ставки — нет), голос — по `voice_activity.created_at` (живёт 90 дней, `cleanup.ts`).
 * ⚠️ Принимает и транзакцию: заморозка месяца читает внутри транзакции закрытия (`gameMonths.ts`).
 */

export type Querier = Pick<typeof db, 'execute'>;
export interface Range {
  from: Date;
  to: Date;
}
type Row = Record<string, unknown>;

async function rows(q: Querier, query: SQL): Promise<Row[]> {
  const res = (await q.execute(query)) as unknown as { rows?: Row[] };
  return res.rows ?? [];
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const date = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));
const dateOrNull = (v: unknown) => (v === null || v === undefined ? null : date(v));
const reasonList = (list: readonly string[]) => sql.join(list.map((r) => sql`${r}`), sql`, `);

/**
 * Кто не участвует: `economy` — боты инстанса и отказавшиеся от экономики на этом сервере, `games` — отказавшиеся от игр.
 * Сейчас, а не на момент игры: отказ прячет человека и задним числом (как `economy/leaderboard`).
 */
export async function loadOptOuts(q: Querier, serverId: string): Promise<{ economy: Set<string>; games: Set<string> }> {
  const r = await rows(q, sql`
    SELECT id AS user_id, 'economy' AS what FROM users WHERE bot = true
    UNION ALL
    SELECT user_id, CASE WHEN opted_out THEN 'economy' ELSE 'games' END
      FROM coin_balances WHERE server_id = ${serverId} AND (opted_out = true OR games_opt_out = true)
  `);
  const economy = new Set<string>();
  const games = new Set<string>();
  for (const x of r) (x.what === 'economy' ? economy : games).add(String(x.user_id));
  return { economy, games };
}

/** Исключённые из таблицы и званий игр: боты, отказ от экономики или от игр. */
export async function loadExcluded(q: Querier, serverId: string): Promise<Set<string>> {
  const { economy, games } = await loadOptOuts(q, serverId);
  return new Set([...economy, ...games]);
}

/** Чистый результат по играм на человека (журнал: ставка < 0, выигрыш, возврат и доля джекпота > 0). */
export async function loadLedgerNets(q: Querier, serverId: string, w: Range): Promise<TitleLedgerNet[]> {
  const r = await rows(q, sql`
    SELECT user_id, split_part(reason, '.', 1) AS family, SUM(amount)::int AS net
      FROM coin_ledger
     WHERE server_id = ${serverId} AND created_at >= ${w.from} AND created_at < ${w.to}
       AND reason IN (${reasonList(GAME_LOSS_REASONS)})
     GROUP BY 1, 2
  `);
  return r.map((x) => ({ userId: String(x.user_id), family: String(x.family) as GameFamily, net: num(x.net) }));
}

/** Срывы джекпота: строка `wheel.jackpot` на человека на раунд. */
export async function loadJackpots(q: Querier, serverId: string, w: Range): Promise<TitleJackpot[]> {
  const r = await rows(q, sql`
    SELECT user_id, COUNT(*)::int AS n, SUM(amount)::int AS coins
      FROM coin_ledger
     WHERE server_id = ${serverId} AND created_at >= ${w.from} AND created_at < ${w.to} AND reason = 'wheel.jackpot'
     GROUP BY user_id
  `);
  return r.map((x) => ({ userId: String(x.user_id), count: num(x.n), coins: num(x.coins) }));
}

/** Дуэли: рассчитанные за окно и вызовы, сделанные в окне (для реваншей). */
export async function loadDuels(q: Querier, serverId: string, w: Range): Promise<TitleDuel[]> {
  const r = await rows(q, sql`
    SELECT id, created_at, settled_at, state, data
      FROM game_rounds
     WHERE server_id = ${serverId} AND kind = 'duel'
       AND ((state = 'settled' AND settled_at >= ${w.from} AND settled_at < ${w.to})
            OR (created_at >= ${w.from} AND created_at < ${w.to}))
  `);
  return r.map((x) => {
    const d = (x.data ?? {}) as Record<string, unknown>;
    const settled = x.state === 'settled';
    const pair = (v: unknown) => {
      const o = v as { challenger?: unknown; target?: unknown } | undefined;
      return o && typeof o === 'object' ? { challenger: num(o.challenger), target: num(o.target) } : null;
    };
    const game = d.game === 'rps' || d.game === 'greedy' || d.game === 'twentyone' ? d.game : 'dice';
    return {
      id: String(x.id),
      createdAt: date(x.created_at),
      settledAt: settled ? dateOrNull(x.settled_at) : null,
      settled,
      challengerId: String(d.challengerId ?? ''),
      targetId: String(d.targetId ?? ''),
      game,
      amount: num(d.amount),
      winnerId: typeof d.winnerId === 'string' ? d.winnerId : null,
      payout: d.payout === null || d.payout === undefined ? null : num(d.payout),
      auto: pair(d.auto),
      rpsWins: pair((d.rps as { wins?: unknown } | undefined)?.wins),
    };
  });
}

/** Ставки рассчитанных за окно раундов всех игр (без возвращённых), с моментом открытия раунда и концом окна колеса. */
export async function loadStakes(q: Querier, serverId: string, w: Range): Promise<TitleStake[]> {
  const r = await rows(q, sql`
    SELECT s.round_id, r.kind, s.user_id, s.pick, s.amount, s.payout, s.created_at,
           r.created_at AS round_created_at, r.created_by, r.lock_at
      FROM game_stakes s
      JOIN game_rounds r ON r.id = s.round_id
     WHERE r.server_id = ${serverId} AND r.state = 'settled'
       AND r.settled_at >= ${w.from} AND r.settled_at < ${w.to}
       AND s.refunded_at IS NULL
  `);
  return r.map((x) => ({
    roundId: String(x.round_id),
    kind: String(x.kind) as GameFamily,
    userId: String(x.user_id),
    pick: String(x.pick),
    amount: num(x.amount),
    payout: x.payout === null || x.payout === undefined ? null : num(x.payout),
    createdAt: date(x.created_at),
    roundCreatedAt: date(x.round_created_at),
    roundCreatedBy: x.created_by === null || x.created_by === undefined ? null : String(x.created_by),
    lockAt: dateOrNull(x.lock_at),
  }));
}

/** Ходы КНБ и Жадного гуся рассчитанных за окно партий. */
export async function loadMoves(q: Querier, serverId: string, w: Range): Promise<TitleMove[]> {
  const r = await rows(q, sql`
    SELECT m.round_id, m.user_id, r.data->>'game' AS game, m.think_ms, m.move
      FROM game_moves m
      JOIN game_rounds r ON r.id = m.round_id
     WHERE r.server_id = ${serverId} AND r.kind = 'duel' AND r.state = 'settled'
       AND r.settled_at >= ${w.from} AND r.settled_at < ${w.to}
       AND r.data->>'game' IN ('rps', 'greedy', 'twentyone')
  `);
  return r.map((x) => {
    const m = (x.move ?? {}) as Record<string, unknown>;
    return {
      roundId: String(x.round_id),
      userId: String(x.user_id),
      game: x.game === 'greedy' ? 'greedy' : x.game === 'twentyone' ? 'twentyone' : 'rps',
      thinkMs: x.think_ms === null || x.think_ms === undefined ? null : num(x.think_ms),
      auto: m.auto === true,
      kind: typeof m.kind === 'string' ? m.kind : null,
      die: typeof m.die === 'number' ? m.die : null,
      burned: typeof m.burned === 'number' ? m.burned : null,
    };
  });
}

/** События, подведённые за окно (отменённые не в счёт), с участниками. */
export async function loadEvents(q: Querier, serverId: string, w: Range): Promise<TitleEvent[]> {
  const r = await rows(q, sql`
    SELECT e.id, e.created_by,
           COALESCE(array_agg(DISTINCT s.user_id) FILTER (WHERE s.user_id IS NOT NULL), '{}') AS participants
      FROM prediction_events e
      LEFT JOIN game_rounds r ON r.kind = 'prediction' AND r.data->>'eventId' = e.id
      LEFT JOIN game_stakes s ON s.round_id = r.id
     WHERE e.server_id = ${serverId} AND e.state = 'settled' AND e.settled_at >= ${w.from} AND e.settled_at < ${w.to}
     GROUP BY e.id, e.created_by
  `);
  return r.map((x) => ({
    id: String(x.id),
    createdBy: x.created_by === null || x.created_by === undefined ? null : String(x.created_by),
    participants: Array.isArray(x.participants) ? x.participants.map(String) : [],
  }));
}

/**
 * Голос за окно по заходам. Заход — непрерывные срезы одного канала: разрыв больше 2 минут или смена канала начинает
 * новый (срез пишется раз в минуту, `voiceActivityRules.SAMPLE_PERIOD_MS`). Внутри захода — отрезки «один / не один»;
 * «ждал» — отрезок одному, сразу за которым в том же заходе пришла компания. Начало захода — первый срез минус его длина;
 * микрофон между срезами неизвестен — точность ±1 минута (честно в описании «Сразу к делу»).
 */
export async function loadVoice(q: Querier, serverId: string, w: Range): Promise<{ voice: TitleVoice[]; entries: TitleVoiceEntry[] }> {
  const r = await rows(q, sql`
    WITH v AS (
      SELECT user_id, channel_id, created_at, seconds, peers, muted,
             LAG(created_at) OVER w AS prev_at, LAG(channel_id) OVER w AS prev_ch
        FROM voice_activity
       WHERE server_id = ${serverId} AND created_at >= ${w.from} AND created_at < ${w.to}
      WINDOW w AS (PARTITION BY user_id ORDER BY created_at)
    ), b AS (
      SELECT *, CASE WHEN prev_at IS NULL OR created_at - prev_at > interval '120 seconds' OR prev_ch <> channel_id
                     THEN 1 ELSE 0 END AS brk
        FROM v
    ), s AS (
      SELECT *, SUM(brk) OVER (PARTITION BY user_id ORDER BY created_at) AS sess FROM b
    ), r AS (
      SELECT *, CASE WHEN LAG(peers) OVER w2 IS NULL OR ((LAG(peers) OVER w2) = 0) <> (peers = 0) THEN 1 ELSE 0 END AS rbrk
        FROM s
      WINDOW w2 AS (PARTITION BY user_id, sess ORDER BY created_at)
    ), g AS (
      SELECT *, SUM(rbrk) OVER (PARTITION BY user_id, sess ORDER BY created_at) AS run FROM r
    ), runs AS (
      SELECT user_id, sess, run, bool_and(peers = 0) AS alone, SUM(seconds) AS secs FROM g GROUP BY 1, 2, 3
    ), waited AS (
      SELECT a.user_id, a.sess, SUM(a.secs)::int AS waited
        FROM runs a
        JOIN runs n ON n.user_id = a.user_id AND n.sess = a.sess AND n.run = a.run + 1
       WHERE a.alone AND NOT n.alone
       GROUP BY 1, 2
    )
    SELECT s.user_id, s.sess,
           MIN(s.created_at - s.seconds * interval '1 second') AS entry_at,
           MIN(s.created_at - s.seconds * interval '1 second') FILTER (WHERE NOT s.muted) AS first_unmuted,
           SUM(s.seconds)::int AS secs,
           COALESCE(MAX(wt.waited), 0)::int AS waited
      FROM s
      LEFT JOIN waited wt ON wt.user_id = s.user_id AND wt.sess = s.sess
     GROUP BY s.user_id, s.sess
  `);
  const total = new Map<string, TitleVoice>();
  const entries: TitleVoiceEntry[] = [];
  for (const x of r) {
    const userId = String(x.user_id);
    const t = total.get(userId) ?? { userId, seconds: 0, waitedSeconds: 0 };
    t.seconds += num(x.secs);
    t.waitedSeconds += num(x.waited);
    total.set(userId, t);
    entries.push({ userId, entryAt: date(x.entry_at), firstUnmutedAt: dateOrNull(x.first_unmuted) });
  }
  return { voice: [...total.values()], entries };
}

/** Окно «после проигрыша остался в голосе» для «Пустого трюма» — часов от последней игровой строки суток. */
export const LOSS_DAY_VOICE_HOURS = 6;

/** Сутки МСК с чистым минусом в играх: минус, кошелёк на начало суток (весь журнал до), голос после последней игры. */
export async function loadLossDays(q: Querier, serverId: string, w: Range): Promise<TitleLossDay[]> {
  const r = await rows(q, sql`
    WITH g AS (
      SELECT user_id, to_char((created_at AT TIME ZONE 'UTC') + interval '3 hours', 'YYYY-MM-DD') AS day,
             SUM(amount)::int AS net, MAX(created_at) AS last_at
        FROM coin_ledger
       WHERE server_id = ${serverId} AND created_at >= ${w.from} AND created_at < ${w.to}
         AND reason IN (${reasonList(GAME_LOSS_REASONS)})
       GROUP BY 1, 2
      HAVING SUM(amount) < 0
    )
    SELECT g.user_id, g.day, -g.net AS loss,
           (SELECT COALESCE(SUM(l.amount), 0)::int FROM coin_ledger l
             WHERE l.server_id = ${serverId} AND l.user_id = g.user_id
               AND l.created_at < (g.day::date::timestamp - interval '3 hours') AT TIME ZONE 'UTC') AS wallet,
           (SELECT COALESCE(SUM(v.seconds), 0)::int FROM voice_activity v
             WHERE v.server_id = ${serverId} AND v.user_id = g.user_id
               AND v.created_at > g.last_at AND v.created_at <= g.last_at + ${LOSS_DAY_VOICE_HOURS}::int * interval '1 hour') AS voice_after
      FROM g
  `);
  return r.map((x) => ({
    userId: String(x.user_id),
    day: String(x.day),
    loss: num(x.loss),
    wallet: num(x.wallet),
    voiceAfterSec: num(x.voice_after),
  }));
}

/** Кто в окне сделал хоть одну ставку (любого раунда и состояния). */
export async function loadPlayed(q: Querier, serverId: string, w: Range): Promise<Set<string>> {
  const r = await rows(q, sql`
    SELECT DISTINCT user_id FROM game_stakes WHERE server_id = ${serverId} AND created_at >= ${w.from} AND created_at < ${w.to}
  `);
  return new Set(r.map((x) => String(x.user_id)));
}

/** Самый ранний раунд сервера вообще — для пометки «частичный месяц». */
export async function loadFirstRoundAt(q: Querier, serverId: string): Promise<Date | null> {
  const r = await rows(q, sql`SELECT MIN(created_at) AS at FROM game_rounds WHERE server_id = ${serverId}`);
  return dateOrNull(r[0]?.at);
}

/** Раунды за окно: рассчитанные по видам и сгоревшая комиссия (`data.fee`, у колеса — преимущество). */
export async function loadRoundTotals(
  q: Querier,
  serverId: string,
  w: Range,
): Promise<{ rounds: Record<GameFamily, number>; fees: number; any: boolean }> {
  const r = await rows(q, sql`
    SELECT kind, COUNT(*)::int AS n, COALESCE(SUM(NULLIF(data->>'fee', '')::numeric), 0)::int AS fee
      FROM game_rounds
     WHERE server_id = ${serverId} AND state = 'settled' AND settled_at >= ${w.from} AND settled_at < ${w.to}
     GROUP BY kind
  `);
  const [any] = await rows(q, sql`
    SELECT EXISTS (SELECT 1 FROM game_rounds WHERE server_id = ${serverId} AND created_at >= ${w.from} AND created_at < ${w.to}) AS any
  `);
  const rounds: Record<GameFamily, number> = { wheel: 0, duel: 0, prediction: 0 };
  let fees = 0;
  for (const x of r) {
    const k = String(x.kind) as GameFamily;
    if (k in rounds) rounds[k] = num(x.n);
    fees += num(x.fee);
  }
  return { rounds, fees, any: any?.any === true };
}

/** Вся выборка месяца для званий. */
export async function loadMonthInput(q: Querier, serverId: string, w: Range): Promise<GameMonthInput> {
  const excluded = await loadExcluded(q, serverId);
  const stakes = await loadStakes(q, serverId, w);
  const duels = await loadDuels(q, serverId, w);
  const moves = await loadMoves(q, serverId, w);
  const ledger = await loadLedgerNets(q, serverId, w);
  const jackpots = await loadJackpots(q, serverId, w);
  const events = await loadEvents(q, serverId, w);
  const { voice, entries } = await loadVoice(q, serverId, w);
  const lossDays = await loadLossDays(q, serverId, w);
  const played = await loadPlayed(q, serverId, w);
  return { excluded, stakes, duels, moves, ledger, jackpots, events, voice, entries, lossDays, played };
}

/** Строка «Итогов сезона экономики» на человека — сырые суммы журнала за окно. */
export interface EconomyRecapRow {
  userId: string;
  earned: number;
  spent: number;
  tipsIn: number;
  gamesNet: number;
  favoritePurchase: { reason: string; count: number } | null;
}

/** Суммы журнала за окно сезона на человека (заработано, потрачено, типы, игры) и любимая покупка. */
export async function loadEconomyRows(q: Querier, serverId: string, w: Range): Promise<EconomyRecapRow[]> {
  const r = await rows(q, sql`
    SELECT user_id,
           COALESCE(SUM(amount) FILTER (WHERE reason IN (${reasonList(EARNED_REASONS)})), 0)::int AS earned,
           COALESCE(-SUM(amount) FILTER (WHERE (reason LIKE 'shop.%' OR reason = 'tip.out') AND amount < 0), 0)::int AS spent,
           COALESCE(SUM(amount) FILTER (WHERE reason = 'tip.in'), 0)::int AS tips_in,
           COALESCE(SUM(amount) FILTER (WHERE reason IN (${reasonList(GAME_LOSS_REASONS)})), 0)::int AS games_net
      FROM coin_ledger
     WHERE server_id = ${serverId} AND created_at >= ${w.from} AND created_at < ${w.to}
     GROUP BY user_id
  `);
  const fav = await rows(q, sql`
    SELECT DISTINCT ON (user_id) user_id, reason, COUNT(*)::int AS n
      FROM coin_ledger
     WHERE server_id = ${serverId} AND created_at >= ${w.from} AND created_at < ${w.to} AND reason LIKE 'shop.%' AND amount < 0
     GROUP BY user_id, reason
     ORDER BY user_id, COUNT(*) DESC, reason
  `);
  const favBy = new Map(fav.map((x) => [String(x.user_id), { reason: String(x.reason), count: num(x.n) }]));
  return r.map((x) => ({
    userId: String(x.user_id),
    earned: num(x.earned),
    spent: num(x.spent),
    tipsIn: num(x.tips_in),
    gamesNet: num(x.games_net),
    favoritePurchase: favBy.get(String(x.user_id)) ?? null,
  }));
}

/** Сервер за окно: строки журнала по причинам (для `economyTotals`) и монет на руках сейчас. */
export async function loadEconomyServer(
  q: Querier,
  serverId: string,
  w: Range,
): Promise<{ byReason: { reason: string; total: number; count: number }[]; circulation: number }> {
  const byReason = await rows(q, sql`
    SELECT reason, SUM(amount)::int AS total, COUNT(*)::int AS count
      FROM coin_ledger
     WHERE server_id = ${serverId} AND created_at >= ${w.from} AND created_at < ${w.to}
     GROUP BY reason
  `);
  const [c] = await rows(q, sql`SELECT COALESCE(SUM(balance), 0)::int AS total FROM coin_balances WHERE server_id = ${serverId}`);
  return {
    byReason: byReason.map((x) => ({ reason: String(x.reason), total: num(x.total), count: num(x.count) })),
    circulation: num(c?.total),
  };
}

/** Рекорды раундов за окно: самая крупная ставка и самый крупный выигрыш (выплата минус ставка), с держателем. */
export async function loadRecords(
  q: Querier,
  serverId: string,
  w: Range,
): Promise<{ bets: { userId: string; amount: number }[]; wins: { userId: string; amount: number }[] }> {
  const pick = async (expr: SQL) =>
    (await rows(q, sql`
      SELECT s.user_id, (${expr})::int AS amount
        FROM game_stakes s JOIN game_rounds r ON r.id = s.round_id
       WHERE r.server_id = ${serverId} AND r.state = 'settled' AND r.settled_at >= ${w.from} AND r.settled_at < ${w.to}
         AND s.refunded_at IS NULL
       ORDER BY 2 DESC, s.user_id
       LIMIT 20
    `)).map((x) => ({ userId: String(x.user_id), amount: num(x.amount) }));
  return { bets: await pick(sql`s.amount`), wins: await pick(sql`COALESCE(s.payout, 0) - s.amount`) };
}

/** Секунды голоса и «ждал компанию» на человека за окно (для «Итогов» экономики). */
export async function loadVoiceTotals(q: Querier, serverId: string, w: Range): Promise<Map<string, TitleVoice>> {
  const { voice } = await loadVoice(q, serverId, w);
  return new Map(voice.map((v) => [v.userId, v]));
}
