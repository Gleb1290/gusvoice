import {
  DEFAULT_GAME_TITLE_NAMES,
  GAME_TITLE_ABOUT,
  GAME_TITLE_KEYS,
  GAME_TITLE_UNIT,
  isGameTitleKey,
  type GameBoardRowDto,
  type GameBoardStats,
  type GameTitleDto,
  type GameTitleKey,
  type GameTitlesDto,
  type RecapDto,
  type RecapKind,
} from '@gusvoice/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { economyTotals, seasonId, seasonName, seasonRange } from './coinRules.js';
import { db } from './db/index.js';
import { gameMonthResults, gameTitlesAwarded, seasonRecaps, seasonResults, serverEconomy, serverGameTitles, users } from './db/schema.js';
import {
  loadDuels,
  loadEconomyRows,
  loadEconomyServer,
  loadExcluded,
  loadFirstRoundAt,
  loadJackpots,
  loadLedgerNets,
  loadMonthInput,
  loadOptOuts,
  loadRecords,
  loadRoundTotals,
  loadVoiceTotals,
  type Querier,
  type Range,
} from './gameTitlesData.js';
import { awardTitles, economyRecapOf, gameBoard, gamesRecapOf, partialFrom } from './gameTitlesRules.js';

/**
 * Игровой месяц (ГусКоины 2, этап 6): закрытие с заморозкой лидерборда, званий и «Итогов месяца игр», заморозка «Итогов
 * сезона экономики», чтение для маршрутов (`routes/gameBoard.ts`).
 *
 * 🔴 Как сезон экономики (`seasons.ts`): итог ЗАПИСЫВАЕТСЯ один раз при смене месяца, а не считается на лету — поздняя
 * правка данных не отнимает звание задним числом, а срезы голоса живут 90 дней. Закрытие — в одной транзакции с
 * блокировкой строки `server_economy` (метка `closed_game_month_id`); повтор после сбоя безопасен: DELETE за месяц + INSERT.
 * Вызывается из `seasons.closeSeasonIfNeeded` — то есть там же, где сезон: тиком голоса (раз в минуту) и лидербордами.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Текущий игровой месяц — календарный месяц МСК, независимо от длины сезона сервера. */
export function gameMonthOf(now: Date): string {
  return seasonId(now, 'month');
}

/**
 * Закрыть прошедший игровой месяц, если он сменился. Возвращает id замороженного месяца или `null`.
 * Первое наблюдение только запоминает текущий месяц. Месяц без единого раунда не морозится (иначе «Святой гусь» доставался
 * бы на сервере, где игр нет вовсе).
 */
export async function closeGameMonthIfNeeded(serverId: string, now: Date): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ closed: serverEconomy.closedGameMonthId })
      .from(serverEconomy)
      .where(eq(serverEconomy.serverId, serverId))
      .limit(1)
      .for('update');
    if (!row) return null;
    const current = gameMonthOf(now);
    if (row.closed === null) {
      await tx.update(serverEconomy).set({ closedGameMonthId: current }).where(eq(serverEconomy.serverId, serverId));
      return null;
    }
    if (row.closed >= current) return null; // тот же месяц (или часы назад) — всё сделано
    const finished = row.closed;
    const frozen = await freezeGameMonth(tx, serverId, finished);
    await tx.update(serverEconomy).set({ closedGameMonthId: current }).where(eq(serverEconomy.serverId, serverId));
    return frozen ? finished : null;
  });
}

/** Посчитать месяц на данных сейчас: таблица, звания, «Итоги». Без записи — общий код заморозки и сухого прогона. */
async function computeGameMonth(q: Querier, serverId: string, monthId: string, upTo?: Date) {
  const r = seasonRange(monthId);
  const w: Range = { from: r.from, to: upTo && upTo < r.to ? upTo : r.to };
  const totals = await loadRoundTotals(q, serverId, w);
  if (!totals.any) return null;
  const input = await loadMonthInput(q, serverId, w);
  const board = gameBoard(input.ledger, input.jackpots, input.duels, input.excluded);
  const awards = awardTitles(input);
  const recap = gamesRecapOf({
    input,
    board,
    awards,
    rounds: totals.rounds,
    fees: totals.fees,
    records: await loadRecords(q, serverId, w),
    partialFrom: partialFrom(await loadFirstRoundAt(q, serverId), r),
  });
  return { range: r, board, awards, recap };
}

async function freezeGameMonth(tx: Tx, serverId: string, monthId: string): Promise<boolean> {
  await tx.delete(gameMonthResults).where(and(eq(gameMonthResults.serverId, serverId), eq(gameMonthResults.monthId, monthId)));
  await tx.delete(gameTitlesAwarded).where(and(eq(gameTitlesAwarded.serverId, serverId), eq(gameTitlesAwarded.monthId, monthId)));
  await tx
    .delete(seasonRecaps)
    .where(and(eq(seasonRecaps.serverId, serverId), eq(seasonRecaps.kind, 'games'), eq(seasonRecaps.periodId, monthId)));
  const m = await computeGameMonth(tx, serverId, monthId);
  if (!m) return false;
  if (m.board.length > 0) {
    await tx.insert(gameMonthResults).values(
      m.board.map(({ userId, net, place, ...stats }) => ({ serverId, monthId, userId, net, place, stats: stats as unknown as Record<string, unknown> })),
    );
  }
  const awarded = m.awards.flatMap((a) => a.userIds.map((userId) => ({ serverId, monthId, titleKey: a.key, userId, value: a.value })));
  if (awarded.length > 0) await tx.insert(gameTitlesAwarded).values(awarded);
  await tx.insert(seasonRecaps).values([
    { serverId, kind: 'games' as const, periodId: monthId, userId: '', data: m.recap.server as unknown as Record<string, unknown> },
    ...[...m.recap.personal].map(([userId, data]) => ({
      serverId,
      kind: 'games' as const,
      periodId: monthId,
      userId,
      data: data as unknown as Record<string, unknown>,
    })),
  ]);
  return true;
}

/** Посчитать «Итоги сезона экономики» за окно. `places` — замороженные места (`season_results`) или по заработанному. */
async function computeEconomyRecap(q: Querier, serverId: string, w: Range, places: Map<string, number> | null) {
  const rows = await loadEconomyRows(q, serverId, w);
  const server = await loadEconomyServer(q, serverId, w);
  const fees = (await loadRoundTotals(q, serverId, w)).fees;
  const { economy, games } = await loadOptOuts(q, serverId);
  const ranked =
    places ??
    new Map(
      rows
        .filter((r) => r.earned > 0 && !economy.has(r.userId))
        .sort((a, b) => b.earned - a.earned || a.userId.localeCompare(b.userId))
        .map((r, i) => [r.userId, i + 1] as const),
    );
  return economyRecapOf({
    rows,
    totals: economyTotals(server.byReason),
    fees,
    circulation: server.circulation,
    voice: await loadVoiceTotals(q, serverId, w),
    places: ranked,
    records: await loadRecords(q, serverId, w),
    economyOut: economy,
    gamesOut: games,
  });
}

/**
 * Заморозить «Итоги сезона экономики» — из `seasons.freeze`, в ТОЙ ЖЕ транзакции, сразу после `season_results` (места
 * берутся оттуда). Срезы голоса живут 90 дней: квартал (92 дня) потом уже не пересчитать — морозим сразу.
 */
export async function freezeEconomyRecap(tx: Tx, serverId: string, finished: string, w: Range): Promise<void> {
  await tx
    .delete(seasonRecaps)
    .where(and(eq(seasonRecaps.serverId, serverId), eq(seasonRecaps.kind, 'economy'), eq(seasonRecaps.periodId, finished)));
  const placed = await tx
    .select({ userId: seasonResults.userId, place: seasonResults.place })
    .from(seasonResults)
    .where(and(eq(seasonResults.serverId, serverId), eq(seasonResults.seasonId, finished)));
  const recap = await computeEconomyRecap(tx, serverId, w, new Map(placed.map((p) => [p.userId, p.place])));
  await tx.insert(seasonRecaps).values([
    { serverId, kind: 'economy' as const, periodId: finished, userId: '', data: recap.server as unknown as Record<string, unknown> },
    ...[...recap.personal].map(([userId, data]) => ({
      serverId,
      kind: 'economy' as const,
      periodId: finished,
      userId,
      data: data as unknown as Record<string, unknown>,
    })),
  ]);
}

// ── Чтение для маршрутов ─────────────────────────────────────────────────────────────────────────────────────────

/** Имена званий сервера с учётом переименований. */
export async function titleNamesOf(serverId: string): Promise<Record<GameTitleKey, string>> {
  const custom = await db
    .select({ key: serverGameTitles.titleKey, name: serverGameTitles.name })
    .from(serverGameTitles)
    .where(eq(serverGameTitles.serverId, serverId));
  const out = { ...DEFAULT_GAME_TITLE_NAMES };
  for (const c of custom) if (isGameTitleKey(c.key)) out[c.key] = c.name;
  return out;
}

/** Последний замороженный месяц сервера с выданными званиями или итогами. */
async function lastClosedMonth(serverId: string): Promise<{ id: string; partialFrom: string | null } | null> {
  const [row] = await db
    .select({ id: seasonRecaps.periodId, data: seasonRecaps.data })
    .from(seasonRecaps)
    .where(and(eq(seasonRecaps.serverId, serverId), eq(seasonRecaps.kind, 'games'), eq(seasonRecaps.userId, '')))
    .orderBy(desc(seasonRecaps.periodId))
    .limit(1);
  if (!row) return null;
  const p = (row.data as { partialFrom?: unknown }).partialFrom;
  return { id: row.id, partialFrom: typeof p === 'string' ? p : null };
}

/** Звания последнего закрытого месяца: ключи по человеку (без исключённых — отказ прячет задним числом). */
async function titlesByUser(serverId: string, monthId: string, excluded: ReadonlySet<string>): Promise<Map<string, GameTitleKey[]>> {
  const rows = await db
    .select({ userId: gameTitlesAwarded.userId, key: gameTitlesAwarded.titleKey })
    .from(gameTitlesAwarded)
    .where(and(eq(gameTitlesAwarded.serverId, serverId), eq(gameTitlesAwarded.monthId, monthId)));
  const out = new Map<string, GameTitleKey[]>();
  for (const r of rows) {
    if (excluded.has(r.userId) || !isGameTitleKey(r.key)) continue;
    out.set(r.userId, [...(out.get(r.userId) ?? []), r.key]);
  }
  return out;
}

async function people(ids: string[]): Promise<Map<string, { displayName: string; avatarUrl: string | null }>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, { displayName: r.displayName, avatarUrl: r.avatarUrl }]));
}

/**
 * Лидерборд игр за окно. Прошлый закрытый месяц (`frozenMonth`) — из `game_month_results`; иначе живой расчёт по журналу
 * (для 20–50 человек и сотен раундов — без кеша, как `economy/leaderboard`).
 */
export async function gameLeaderboard(
  serverId: string,
  w: Range,
  frozenMonth: string | null,
): Promise<{ people: GameBoardRowDto[]; frozen: boolean }> {
  const excluded = await loadExcluded(db, serverId);
  let rows: ({ userId: string; net: number; place: number } & GameBoardStats)[];
  let frozen = false;
  if (frozenMonth) {
    const stored = await db
      .select()
      .from(gameMonthResults)
      .where(and(eq(gameMonthResults.serverId, serverId), eq(gameMonthResults.monthId, frozenMonth)))
      .orderBy(gameMonthResults.place);
    rows = stored
      .filter((r) => !excluded.has(r.userId))
      .map((r) => ({ ...(r.stats as unknown as GameBoardStats), userId: r.userId, net: r.net, place: r.place }));
    frozen = true;
  } else {
    rows = gameBoard(await loadLedgerNets(db, serverId, w), await loadJackpots(db, serverId, w), await loadDuels(db, serverId, w), excluded);
  }
  const last = await lastClosedMonth(serverId);
  const titles = last ? await titlesByUser(serverId, last.id, excluded) : new Map<string, GameTitleKey[]>();
  const who = await people(rows.map((r) => r.userId));
  return {
    frozen,
    // Места пересчитываются после фильтра: отказавшийся пропал — дыры в нумерации нет.
    people: rows.map((r, i) => ({
      ...r,
      place: i + 1,
      displayName: who.get(r.userId)?.displayName ?? '',
      avatarUrl: who.get(r.userId)?.avatarUrl ?? null,
      titles: titles.get(r.userId) ?? [],
    })),
  };
}

/** Есть ли замороженный лидерборд месяца. */
export async function hasFrozenMonth(serverId: string, monthId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: seasonRecaps.periodId })
    .from(seasonRecaps)
    .where(and(eq(seasonRecaps.serverId, serverId), eq(seasonRecaps.kind, 'games'), eq(seasonRecaps.periodId, monthId)))
    .limit(1);
  return !!row;
}

/** Все 27 званий: имя (с переименованием), описание, носители последнего закрытого месяца. */
export async function gameTitles(serverId: string, canManage: boolean): Promise<GameTitlesDto> {
  const names = await titleNamesOf(serverId);
  const last = await lastClosedMonth(serverId);
  const excluded = await loadExcluded(db, serverId);
  const awarded = last
    ? (
        await db
          .select({ key: gameTitlesAwarded.titleKey, userId: gameTitlesAwarded.userId, value: gameTitlesAwarded.value })
          .from(gameTitlesAwarded)
          .where(and(eq(gameTitlesAwarded.serverId, serverId), eq(gameTitlesAwarded.monthId, last.id)))
      ).filter((a) => !excluded.has(a.userId))
    : [];
  const who = await people([...new Set(awarded.map((a) => a.userId))]);
  const titles: GameTitleDto[] = GAME_TITLE_KEYS.map((key) => ({
    key,
    name: names[key],
    defaultName: DEFAULT_GAME_TITLE_NAMES[key],
    renamed: names[key] !== DEFAULT_GAME_TITLE_NAMES[key],
    about: GAME_TITLE_ABOUT[key],
    unit: GAME_TITLE_UNIT[key],
    holders: awarded
      .filter((a) => a.key === key)
      .map((a) => ({ userId: a.userId, value: a.value, displayName: who.get(a.userId)?.displayName ?? '', avatarUrl: who.get(a.userId)?.avatarUrl ?? null })),
  }));
  return { month: last ? { id: last.id, name: seasonName(last.id), partialFrom: last.partialFrom } : null, titles, canManage };
}

/** Переименовать звание (`null` — вернуть название по умолчанию). */
export async function renameGameTitle(serverId: string, key: GameTitleKey, name: string | null): Promise<void> {
  if (name === null || name === DEFAULT_GAME_TITLE_NAMES[key]) {
    await db.delete(serverGameTitles).where(and(eq(serverGameTitles.serverId, serverId), eq(serverGameTitles.titleKey, key)));
    return;
  }
  await db
    .insert(serverGameTitles)
    .values({ serverId, titleKey: key, name })
    .onConflictDoUpdate({ target: [serverGameTitles.serverId, serverGameTitles.titleKey], set: { name, updatedAt: sql`now()` } });
}

/** Замороженные «Итоги»: без `periodId` — последние своего вида. `me` — личная строка читающего (нет — `null`). */
export async function frozenRecap(serverId: string, kind: RecapKind, periodId: string | null, userId: string): Promise<RecapDto | null> {
  const where = [eq(seasonRecaps.serverId, serverId), eq(seasonRecaps.kind, kind), eq(seasonRecaps.userId, '')];
  if (periodId) where.push(eq(seasonRecaps.periodId, periodId));
  const [server] = await db
    .select()
    .from(seasonRecaps)
    .where(and(...where))
    .orderBy(desc(seasonRecaps.frozenAt))
    .limit(1);
  if (!server) return null;
  const [mine] = await db
    .select({ data: seasonRecaps.data })
    .from(seasonRecaps)
    .where(and(eq(seasonRecaps.serverId, serverId), eq(seasonRecaps.kind, kind), eq(seasonRecaps.periodId, server.periodId), eq(seasonRecaps.userId, userId)))
    .limit(1);
  // Отказался после заморозки — личную часть больше не показываем (как `economy/user/:userId` → `card: null`).
  const { economy, games } = await loadOptOuts(db, serverId);
  const hidden = economy.has(userId) || (kind === 'games' && games.has(userId));
  const r = seasonRange(server.periodId);
  return {
    kind,
    periodId: server.periodId,
    name: seasonName(server.periodId),
    from: r.from.toISOString(),
    to: r.to.toISOString(),
    frozenAt: server.frozenAt.toISOString(),
    preview: false,
    server: server.data as unknown as RecapDto['server'],
    me: mine && !hidden ? (mine.data as unknown as RecapDto['me']) : null,
  };
}

/** Сухой прогон «Итогов» на текущих данных (`MANAGE_ECONOMY`): ничего не пишет; окно — период до текущего момента. */
export async function previewRecap(serverId: string, kind: RecapKind, periodId: string, userId: string, now: Date): Promise<RecapDto | null> {
  const r = seasonRange(periodId);
  const w: Range = { from: r.from, to: now < r.to ? now : r.to };
  const base = { kind, periodId, name: seasonName(periodId), from: r.from.toISOString(), to: r.to.toISOString(), frozenAt: null, preview: true };
  if (kind === 'games') {
    const m = await computeGameMonth(db, serverId, periodId, now);
    if (!m) return null;
    return { ...base, server: m.recap.server, me: m.recap.personal.get(userId) ?? null };
  }
  const recap = await computeEconomyRecap(db, serverId, w, null);
  return { ...base, server: recap.server, me: recap.personal.get(userId) ?? null };
}
