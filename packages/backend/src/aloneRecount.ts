import { and, asc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { ALONE_RECOUNT_KIND, recountDiffs, recountWindow } from './aloneRecountRules.js';
import { applyCoins, pushWallet, toEconomy, type ServerEconomy } from './coins.js';
import { beforeCutoff, type ReplaySample } from './coinRules.js';
import { db } from './db/index.js';
import { coinBalances, coinRecounts, serverEconomy, serverMembers, users, voiceActivity } from './db/schema.js';

/**
 * Разовый перерасчёт сезона по правилу «один — затухание не бьёт» (28.10, миграции 0158/0159).
 *
 * Старое правило тратило затухание и на время одному, и ждавший компанию к вечеру получал меньше
 * пришедших сразу. Каждому серверу с включённой экономикой — один раз: срезы присутствия текущего
 * сезона до смены правила прогоняются по новому и по старому правилу (`aloneRecountRules.ts`),
 * положительная разница начисляется причиной `recount` (заработок: сезон и звания) и оставляет строку
 * одноразовой карточки в `coin_recounts`. Отрицательная — ничего: монеты у людей не забираем.
 *
 * Гарантии — как у ретро (`routes/economy.ts`, #124 Д1+С5):
 *  - верхняя граница — момент смены правила (`applied_at` миграции 0158), а не «сейчас»: после неё тикер
 *    уже платит по новому; срезы отсекаются и в SQL, и `beforeCutoff` в коде;
 *  - отметка `server_economy.alone_recount_at` и все начисления — ОДНОЙ транзакцией, отметка условным
 *    UPDATE по `IS NULL` — замок от второго запуска (два процесса бэкенда, перезапуск посреди);
 *  - не получают: боты, удалённые аккаунты, ушедшие с сервера, отказавшиеся от экономики (`optedOut`);
 *    число пропущенных — в лог;
 *  - `pushWallet` — после коммита.
 * ⚠️ Живые суточные счётчики (затухание, порог одному, потолок) не трогаются — только баланс, журнал и
 * сезонный зачёт через `applyCoins`. Тикер в это время работает: кошелёк он блокирует так же
 * (`lockWallet`), так что пересечься они могут только очередью.
 */

/** Имя миграции, момент применения которой и есть смена правила. */
export const ALONE_RULE_MIGRATION = '0158_alone_cap.sql';

export interface RecountOutcome {
  serverId: string;
  people: number;
  sum: number;
  skipped: number;
}

/** Момент смены правила на этом инстансе; `null` — миграция не записана (такого после старта быть не должно). */
async function ruleCutoff(): Promise<Date | null> {
  const res = await db.execute(sql`SELECT applied_at FROM _migrations WHERE name = ${ALONE_RULE_MIGRATION}`);
  const row = (res as unknown as { rows: { applied_at: Date | string }[] }).rows[0];
  return row ? new Date(row.applied_at) : null;
}

/** Перерасчёт одного сервера. `null` — уже был (или окна нет: отметка ставится и так). */
export async function recountServer(economy: ServerEconomy, cutoff: Date): Promise<RecountOutcome | null> {
  const serverId = economy.serverId;
  const window = recountWindow(cutoff, economy.seasonLength, economy.accrualSince);

  let paid: { userId: string; amount: number; coinsNew: number; coinsOld: number }[] = [];
  let skipped = 0;
  if (window) {
    const rows = await db
      .select({
        userId: voiceActivity.userId,
        seconds: voiceActivity.seconds,
        peers: voiceActivity.peers,
        muted: voiceActivity.muted,
        deafened: voiceActivity.deafened,
        away: voiceActivity.away,
        at: voiceActivity.createdAt,
      })
      .from(voiceActivity)
      .where(
        and(
          eq(voiceActivity.serverId, serverId),
          gte(voiceActivity.createdAt, window.from),
          lt(voiceActivity.createdAt, window.to),
        ),
      )
      .orderBy(asc(voiceActivity.createdAt));
    // Отсекаем ещё раз в коде — как ретро: гарантия держится там, где её видит тест.
    const diffs = recountDiffs(beforeCutoff(rows as ReplaySample[], window.to), economy);

    // Кому можно: текущие участники, не боты, не удалённые, не отказавшиеся.
    const memberRows = await db
      .select({ userId: serverMembers.userId })
      .from(serverMembers)
      .innerJoin(users, eq(users.id, serverMembers.userId))
      .where(and(eq(serverMembers.serverId, serverId), eq(users.bot, false), isNull(users.deletedAt)));
    const members = new Set(memberRows.map((r) => r.userId));
    const optedOutRows = await db
      .select({ userId: coinBalances.userId })
      .from(coinBalances)
      .where(and(eq(coinBalances.serverId, serverId), eq(coinBalances.optedOut, true)));
    const optedOut = new Set(optedOutRows.map((r) => r.userId));
    paid = diffs.filter((d) => members.has(d.userId) && !optedOut.has(d.userId));
    skipped = diffs.length - paid.length;
  }

  const sum = await db.transaction(async (tx) => {
    const marked = await tx
      .update(serverEconomy)
      .set({ aloneRecountAt: new Date() })
      .where(and(eq(serverEconomy.serverId, serverId), isNull(serverEconomy.aloneRecountAt)))
      .returning({ serverId: serverEconomy.serverId });
    if (marked.length === 0) return null;
    let total = 0;
    for (const d of paid) {
      await applyCoins(tx, {
        serverId,
        userId: d.userId,
        amount: d.amount,
        reason: 'recount',
        data: {
          kind: ALONE_RECOUNT_KIND,
          seasonId: window!.seasonId,
          from: window!.from.toISOString(),
          until: window!.to.toISOString(),
          coinsNew: d.coinsNew,
          coinsOld: d.coinsOld,
        },
        seasonLength: economy.seasonLength,
        // Доплата за уже отсиженное время — заработок, как ретро: в сезон и в звания.
        countsAsEarned: true,
      });
      await tx
        .insert(coinRecounts)
        .values({ serverId, userId: d.userId, kind: ALONE_RECOUNT_KIND, amount: d.amount, seasonId: window!.seasonId })
        .onConflictDoNothing();
      total += d.amount;
    }
    return total;
  });
  if (sum === null) return null;

  // Шина — после коммита: числа уже в базе.
  for (const d of paid) await pushWallet(serverId, d.userId);
  return { serverId, people: paid.length, sum, skipped };
}

/**
 * Пройти все серверы с включённой экономикой, где перерасчёта ещё не было. Зовётся на старте бэкенда
 * асинхронно (`index.ts`); ошибка одного сервера не мешает остальным и не роняет процесс.
 */
export async function runAloneRecount(log: (msg: string) => void = console.log): Promise<RecountOutcome[]> {
  const cutoff = await ruleCutoff();
  if (!cutoff) {
    log(`[recount] миграция ${ALONE_RULE_MIGRATION} не записана — перерасчёт пропущен`);
    return [];
  }
  const rows = await db
    .select()
    .from(serverEconomy)
    .where(and(eq(serverEconomy.enabled, true), isNull(serverEconomy.aloneRecountAt)));
  const out: RecountOutcome[] = [];
  for (const row of rows) {
    try {
      const r = await recountServer(toEconomy(row), cutoff);
      if (!r) continue;
      out.push(r);
      log(`[recount] сервер ${r.serverId}: доначислено ${r.people} чел., всего ${r.sum}, пропущено ${r.skipped} (отказ/бот/ушёл)`);
    } catch (err) {
      log(`[recount] сервер ${row.serverId}: перерасчёт не удался: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
