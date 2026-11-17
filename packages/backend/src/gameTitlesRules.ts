import {
  GAME_TITLE_KEYS,
  type EconomyRecapPersonalDto,
  type EconomyRecapServerDto,
  type GameBoardStats,
  type GameFamily,
  type GamesRecapPersonalDto,
  type GamesRecapServerDto,
  type GameTitleKey,
  type RecapRecordDto,
} from '@gusvoice/shared';
import { dayKey } from './coinRules.js';

/**
 * Звания месяца и лидерборд игр (ГусКоины 2, этап 6) — ЧИСТЫЕ правила над выборкой месяца (`gameTitlesData.ts`).
 *
 * Условия и равенства — таблица плана (`docs/guscoins-v2-plan.md`, «Звания: описания и условия выдачи»; 27 строк) и решения
 * контракта этапа 6 (`S:\gv-stand\gc2\stage6-contract.md`): джекпот — каждый раунд с долей сундука считается каждому
 * получившему; «Реактивный гусь» — от открытия раунда, создатель раунда не в счёт; кубики в «Тугодума» не идут.
 *
 * 🔴 Исключённые (бот, отказ от экономики или от игр) не получают НИ ОДНОГО звания и не видны в таблице. Но их ставки
 * остаются в выборке: доля варианта в банке вопроса и «поставил вслед за другим» считаются по всем деньгам, иначе отказ
 * одного человека задним числом менял бы чужие звания.
 * 🔴 Порог не достигнут — звание за месяц не выдаётся никому. Равенство — каскад «больше X → всем» (константы ниже).
 */

/** Ставка месяца: только рассчитанные раунды, без возвращённых (`refunded_at`). */
export interface TitleStake {
  roundId: string;
  kind: GameFamily;
  userId: string;
  pick: string;
  amount: number;
  /** Выплата (0 — проиграла); `null` — не рассчитана. */
  payout: number | null;
  createdAt: Date;
  /** Открытие раунда (колесо создаётся первой ставкой) и кто его открыл. */
  roundCreatedAt: Date;
  roundCreatedBy: string | null;
  /** Конец окна ставок колеса. */
  lockAt: Date | null;
}

/** Дуэль (`game_rounds kind='duel'`) с итогом или без (`settledAt` пуст — вызов, который не сыгран). */
export interface TitleDuel {
  id: string;
  createdAt: Date;
  settledAt: Date | null;
  settled: boolean;
  challengerId: string;
  targetId: string;
  game: 'dice' | 'rps' | 'greedy' | 'twentyone';
  amount: number;
  /** Победитель; `null` у рассчитанной — возврат обоим. */
  winnerId: string | null;
  payout: number | null;
  /** Сколько раз сервер сходил за сторону по сроку (`data.auto`, этап 4). */
  auto: { challenger: number; target: number } | null;
  /** Счёт КНБ (`data.rps.wins`). */
  rpsWins: { challenger: number; target: number } | null;
}

/** Ход дуэли с выбором (`game_moves`, только рассчитанные партии КНБ и Жадного гуся). */
export interface TitleMove {
  roundId: string;
  userId: string;
  game: 'rps' | 'greedy' | 'twentyone';
  thinkMs: number | null;
  auto: boolean;
  /** Жадный гусь: `roll` / `stop`, выпавшая грань и сгоревшие очки хода. */
  kind: string | null;
  die: number | null;
  burned: number | null;
}

/** Чистый результат человека по игре за месяц — сумма строк журнала (ставка < 0, выигрыш и возврат > 0). */
export interface TitleLedgerNet {
  userId: string;
  family: GameFamily;
  net: number;
}

export interface TitleJackpot {
  userId: string;
  count: number;
  coins: number;
}

/** Событие со ставками, подведённое за месяц (отменённые не в счёт), и все, кто в нём ставил. */
export interface TitleEvent {
  id: string;
  createdBy: string | null;
  participants: string[];
}

/** Голос за месяц: всего секунд и секунд «один, а потом пришла компания» (Хатико). */
export interface TitleVoice {
  userId: string;
  seconds: number;
  waitedSeconds: number;
}

/** Заход в голос: начало (по первому срезу минус его длина) и начало первого среза с включённым микрофоном. */
export interface TitleVoiceEntry {
  userId: string;
  entryAt: Date;
  firstUnmutedAt: Date | null;
}

/** Сутки МСК с чистым минусом в играх: минус, кошелёк на начало суток, секунд голоса после последней игровой строки. */
export interface TitleLossDay {
  userId: string;
  day: string;
  loss: number;
  wallet: number;
  voiceAfterSec: number;
}

export interface GameMonthInput {
  /** Бот, отказ от экономики или от игр — не участвует ни в таблице, ни в званиях. */
  excluded: ReadonlySet<string>;
  stakes: TitleStake[];
  duels: TitleDuel[];
  moves: TitleMove[];
  ledger: TitleLedgerNet[];
  jackpots: TitleJackpot[];
  events: TitleEvent[];
  voice: TitleVoice[];
  entries: TitleVoiceEntry[];
  lossDays: TitleLossDay[];
  /** Кто в месяце сделал хоть одну ставку, вызов или прогноз (в любом состоянии) — для «Святого гуся». */
  played: ReadonlySet<string>;
}

export interface TitleAward {
  key: GameTitleKey;
  userIds: string[];
  /** Число повода в единицах `GAME_TITLE_UNIT`. */
  value: number;
}

/** Пороги званий (план, «Условие»). */
export const TITLE_MIN = {
  fortune: 1,
  regularRounds: 20,
  shareStakes: 20,
  twentyShare: 0.5,
  pensionerShare: 0.8,
  credit: 1000,
  emptyHoldWallet: 500,
  emptyHoldShare: 0.8,
  emptyHoldVoiceSec: 30 * 60,
  slowpokeMoves: 10,
  jetRounds: 10,
  lastSecond: 5,
  follower: 5,
  nightOwl: 10,
  straightToBusiness: 3,
  truthStreak: 3,
  kingOfHill: 3,
  fiascoDuels: 10,
  revenge: 3,
  sleightOfHand: 2,
  englishExit: 2,
  greed: 10,
  carefulGames: 5,
  vangaStakes: 10,
  againstTide: 1,
  couchAnalyst: 3,
  bookmaker: 2,
  hachikoSec: 60 * 60,
  holyGooseSec: 10 * 60 * 60,
} as const;

/** Окна в мс: последние секунды колеса, «вслед за другим», тихий заход, реванш. */
export const TITLE_WINDOW_MS = {
  lastSecond: 3_000,
  follower: 3_000,
  quietEntry: 120_000,
  revenge: 120_000,
} as const;

/** Смелый прогноз: доля варианта в банке вопроса МЕНЬШЕ этой. */
export const BOLD_SHARE = 0.2;
/** Ночь МСК: часы [3, 6). */
export const NIGHT_HOURS = { from: 3, to: 6 } as const;
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

interface Candidate {
  userId: string;
  primary: number;
  /** Второй ключ равенства (всегда «больше — лучше»); нет — равные получают все. */
  secondary?: number;
  value: number;
}

/**
 * Лучшие кандидаты: по `primary` (`max`/`min`), равенство — больше `secondary`, дальше — всем. Порог проверяет вызывающий.
 * Порядок userIds — по идентификатору, чтобы повтор заморозки давал те же строки.
 */
export function bestOf(cands: Candidate[], dir: 'max' | 'min'): { userIds: string[]; value: number } | null {
  if (cands.length === 0) return null;
  const better = (a: number, b: number) => (dir === 'max' ? a > b : a < b);
  let top = cands[0].primary;
  for (const c of cands) if (better(c.primary, top)) top = c.primary;
  let tied = cands.filter((c) => c.primary === top);
  if (tied.length > 1 && tied.every((c) => c.secondary !== undefined)) {
    const best = Math.max(...tied.map((c) => c.secondary as number));
    tied = tied.filter((c) => c.secondary === best);
  }
  return { userIds: tied.map((c) => c.userId).sort(), value: tied[0].value };
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const pct = (share: number) => Math.round(share * 100);

function group<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function counts(keys: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const k of keys) out.set(k, (out.get(k) ?? 0) + 1);
  return out;
}

/** Час суток МСК момента. */
export function mskHour(at: Date): number {
  return new Date(at.getTime() + MSK_OFFSET_MS).getUTCHours();
}

function sideOf(d: TitleDuel, userId: string): 'challenger' | 'target' | null {
  if (d.challengerId === userId) return 'challenger';
  if (d.targetId === userId) return 'target';
  return null;
}

/** Дуэли с исходом, по времени итога. */
function decidedDuels(duels: TitleDuel[]): TitleDuel[] {
  return duels
    .filter((d) => d.settled && d.winnerId !== null && d.settledAt !== null)
    .sort((a, b) => a.settledAt!.getTime() - b.settledAt!.getTime() || a.id.localeCompare(b.id));
}

/** Самая длинная серия побед человека подряд (возвраты серию не рвут и не продолжают) и выигрыш в ней. */
export function bestStreak(userId: string, decided: TitleDuel[]): { length: number; coins: number } {
  let best = { length: 0, coins: 0 };
  let cur = { length: 0, coins: 0 };
  for (const d of decided) {
    if (!sideOf(d, userId)) continue;
    if (d.winnerId === userId) {
      cur = { length: cur.length + 1, coins: cur.coins + Math.max(0, (d.payout ?? 0) - d.amount) };
      if (cur.length > best.length || (cur.length === best.length && cur.coins > best.coins)) best = cur;
    } else {
      cur = { length: 0, coins: 0 };
    }
  }
  return best;
}

/** Доля каждого варианта в банке вопроса прогноза — по ВСЕМ ставкам (включая исключённых). */
export function optionShares(stakes: TitleStake[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [roundId, list] of group(stakes.filter((s) => s.kind === 'prediction'), (s) => s.roundId)) {
    const total = list.reduce((sum, s) => sum + s.amount, 0);
    if (total <= 0) continue;
    for (const [pick, picks] of group(list, (s) => s.pick)) {
      out.set(`${roundId}\u0000${pick}`, picks.reduce((sum, s) => sum + s.amount, 0) / total);
    }
  }
  return out;
}

/** Ставка колеса сделана в пределах `follower` после чужой ставки на то же число того же раунда. */
export function followerCounts(stakes: TitleStake[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [, list] of group(stakes.filter((s) => s.kind === 'wheel'), (s) => s.roundId)) {
    for (const s of list) {
      const t = s.createdAt.getTime();
      const followed = list.some(
        (o) => o.userId !== s.userId && o.pick === s.pick && o.createdAt.getTime() < t && t - o.createdAt.getTime() <= TITLE_WINDOW_MS.follower,
      );
      if (followed) out.set(s.userId, (out.get(s.userId) ?? 0) + 1);
    }
  }
  return out;
}

/** Тихие заходы: первая ставка после входа — не позже `quietEntry`, а микрофон до неё не включался. */
export function quietEntryCounts(entries: TitleVoiceEntry[], stakes: TitleStake[]): Map<string, number> {
  const times = new Map<string, number[]>();
  for (const s of stakes) {
    const list = times.get(s.userId);
    if (list) list.push(s.createdAt.getTime());
    else times.set(s.userId, [s.createdAt.getTime()]);
  }
  for (const list of times.values()) list.sort((a, b) => a - b);
  const out = new Map<string, number>();
  for (const e of entries) {
    const from = e.entryAt.getTime();
    const first = (times.get(e.userId) ?? []).find((t) => t >= from);
    if (first === undefined || first - from > TITLE_WINDOW_MS.quietEntry) continue;
    if (e.firstUnmutedAt && e.firstUnmutedAt.getTime() <= first) continue;
    out.set(e.userId, (out.get(e.userId) ?? 0) + 1);
  }
  return out;
}

/** Реванши: вызов тому же сопернику в пределах `revenge` после проигрыша ему. Каждый вызов — один раз. */
export function revengeCounts(duels: TitleDuel[]): Map<string, number> {
  const out = new Map<string, number>();
  const losses = decidedDuels(duels);
  for (const c of duels) {
    const t = c.createdAt.getTime();
    const isRevenge = losses.some((d) => {
      if (d.winnerId !== c.targetId || d.id === c.id) return false;
      const loser = d.winnerId === d.challengerId ? d.targetId : d.challengerId;
      if (loser !== c.challengerId) return false;
      const lostAt = d.settledAt!.getTime();
      return t > lostAt && t - lostAt <= TITLE_WINDOW_MS.revenge;
    });
    if (isRevenge) out.set(c.challengerId, (out.get(c.challengerId) ?? 0) + 1);
  }
  return out;
}

/** «Царь горы»: лучшие сутки МСК — разных побеждённых соперников при нуле поражений. */
export function kingOfHillBest(userId: string, decided: TitleDuel[]): number {
  let best = 0;
  for (const [, list] of group(decided.filter((d) => sideOf(d, userId)), (d) => dayKey(d.settledAt!))) {
    if (list.some((d) => d.winnerId !== userId)) continue;
    const beaten = new Set(list.map((d) => (d.challengerId === userId ? d.targetId : d.challengerId)));
    best = Math.max(best, beaten.size);
  }
  return best;
}

/** Лидерборд игр за период: строка на каждого НЕисключённого со строками журнала игр. По чистому результату, ничья — по id. */
export function gameBoard(
  ledger: TitleLedgerNet[],
  jackpots: TitleJackpot[],
  duels: TitleDuel[],
  excluded: ReadonlySet<string>,
): ({ userId: string; net: number; place: number } & GameBoardStats)[] {
  const rows = new Map<string, GameBoardStats>();
  const row = (userId: string) => {
    let r = rows.get(userId);
    if (!r) {
      r = { wheel: 0, duel: 0, prediction: 0, jackpots: 0, jackpotCoins: 0, duels: 0, duelWins: { dice: 0, rps: 0, greedy: 0 } };
      rows.set(userId, r);
    }
    return r;
  };
  for (const l of ledger) if (!excluded.has(l.userId)) row(l.userId)[l.family] += l.net;
  for (const j of jackpots) {
    if (excluded.has(j.userId)) continue;
    const r = row(j.userId);
    r.jackpots += j.count;
    r.jackpotCoins += j.coins;
  }
  for (const d of decidedDuels(duels)) {
    for (const u of [d.challengerId, d.targetId]) {
      if (excluded.has(u) || !rows.has(u)) continue;
      const r = row(u);
      r.duels += 1;
      if (d.winnerId === u) r.duelWins[d.game] = (r.duelWins[d.game] ?? 0) + 1;
    }
  }
  return [...rows.entries()]
    .map(([userId, s]) => ({ userId, net: s.wheel + s.duel + s.prediction, ...s }))
    .sort((a, b) => b.net - a.net || a.userId.localeCompare(b.userId))
    .map((r, i) => ({ ...r, place: i + 1 }));
}

/** Все 27 званий месяца. Нет кандидатов или порог не достигнут — звания в списке нет. */
export function awardTitles(input: GameMonthInput): TitleAward[] {
  const ok = (userId: string) => !input.excluded.has(userId);
  const stakes = input.stakes.filter((s) => ok(s.userId));
  const wheel = stakes.filter((s) => s.kind === 'wheel');
  const wheelBy = group(wheel, (s) => s.userId);
  const preds = stakes.filter((s) => s.kind === 'prediction' && s.payout !== null);
  const predBy = group(preds, (s) => s.userId);
  const decided = decidedDuels(input.duels);
  const duelists = new Set<string>();
  for (const d of input.duels) for (const u of [d.challengerId, d.targetId]) if (ok(u)) duelists.add(u);
  const moves = input.moves.filter((m) => ok(m.userId));
  const shares = optionShares(input.stakes);
  const out: TitleAward[] = [];
  const give = (key: GameTitleKey, cands: Candidate[], dir: 'max' | 'min' = 'max') => {
    const best = bestOf(cands, dir);
    if (best) out.push({ key, ...best });
  };
  const fromCounts = (key: GameTitleKey, map: Map<string, number>, min: number) =>
    give(key, [...map].filter(([u, n]) => ok(u) && n >= min).map(([userId, n]) => ({ userId, primary: n, value: n })));

  // 1. Фортуна: срывов ≥ 1; равенство — больше сумма долей, дальше всем.
  give('fortune', input.jackpots
    .filter((j) => ok(j.userId) && j.count >= TITLE_MIN.fortune)
    .map((j) => ({ userId: j.userId, primary: j.count, secondary: j.coins, value: j.count })));

  // 2. Постоянный клиент: раундов колеса со своей ставкой ≥ 20; равенство — больше поставлено.
  give('regular', [...wheelBy]
    .map(([userId, list]) => ({ userId, rounds: new Set(list.map((s) => s.roundId)).size, sum: list.reduce((a, s) => a + s.amount, 0) }))
    .filter((c) => c.rounds >= TITLE_MIN.regularRounds)
    .map((c) => ({ userId: c.userId, primary: c.rounds, secondary: c.sum, value: c.rounds })));

  // 3, 4. Доля ставок на «20» (≥ 50 %) и на «1» (≥ 80 %) среди своих ставок колеса, ставок ≥ 20; равенство — больше таких ставок.
  const sharePick = (key: GameTitleKey, pick: string, minShare: number) =>
    give(key, [...wheelBy]
      .filter(([, list]) => list.length >= TITLE_MIN.shareStakes)
      .map(([userId, list]) => {
        const n = list.filter((s) => s.pick === pick).length;
        return { userId, primary: n / list.length, secondary: n, value: pct(n / list.length) };
      })
      .filter((c) => c.primary >= minShare));
  sharePick('twenty', '20', TITLE_MIN.twentyShare);
  sharePick('pensioner', '1', TITLE_MIN.pensionerShare);

  // 5. Кредит одобрен: чистый минус на колесе (с джекпотом) ≥ 1000; равенство — всем.
  give('credit', input.ledger
    .filter((l) => l.family === 'wheel' && ok(l.userId) && -l.net >= TITLE_MIN.credit)
    .map((l) => ({ userId: l.userId, primary: -l.net, value: -l.net })));

  // 6. Пустой трюм: сутки — минус ≥ 80 % кошелька (≥ 500) на начало суток и ≥ 30 мин голоса после; лучшая доля.
  const holdBest = new Map<string, number>();
  for (const d of input.lossDays) {
    if (!ok(d.userId) || d.wallet < TITLE_MIN.emptyHoldWallet || d.voiceAfterSec < TITLE_MIN.emptyHoldVoiceSec) continue;
    const share = d.loss / d.wallet;
    if (share < TITLE_MIN.emptyHoldShare) continue;
    holdBest.set(d.userId, Math.max(holdBest.get(d.userId) ?? 0, share));
  }
  give('empty-hold', [...holdBest].map(([userId, share]) => ({ userId, primary: share, value: pct(share) })));

  // 7. Тугодум: медиана времени хода КНБ и Жадного гуся (свои ходы, не автоходы), ходов ≥ 10. Кубики сюда не идут.
  give('slowpoke', [...group(moves.filter((m) => !m.auto && m.thinkMs !== null), (m) => m.userId)]
    .filter(([, list]) => list.length >= TITLE_MIN.slowpokeMoves)
    .map(([userId, list]) => {
      const m = median(list.map((x) => x.thinkMs as number));
      return { userId, primary: m, value: Math.round(m) };
    }));

  // 8. Крупная ставка: самая большая одна ставка месяца; равенство — у кого выиграла; выиграли или проиграли все — всем.
  const settledStakes = stakes.filter((s) => s.payout !== null);
  if (settledStakes.length > 0) {
    const max = Math.max(...settledStakes.map((s) => s.amount));
    const top = settledStakes.filter((s) => s.amount === max);
    const won = top.filter((s) => (s.payout ?? 0) > 0);
    const pickFrom = won.length > 0 && won.length < top.length ? won : top;
    out.push({ key: 'high-roller', userIds: [...new Set(pickFrom.map((s) => s.userId))].sort(), value: max });
  }

  // 9. Реактивный гусь: медиана от открытия раунда колеса до своей первой ставки в нём; создатель раунда не в счёт; ≥ 10.
  const jet: Candidate[] = [];
  for (const [userId, list] of wheelBy) {
    const firstByRound = new Map<string, number>();
    for (const s of list) {
      if (s.roundCreatedBy === userId) continue;
      const dt = s.createdAt.getTime() - s.roundCreatedAt.getTime();
      firstByRound.set(s.roundId, Math.min(firstByRound.get(s.roundId) ?? Infinity, dt));
    }
    if (firstByRound.size < TITLE_MIN.jetRounds) continue;
    const m = median([...firstByRound.values()]);
    jet.push({ userId, primary: m, value: Math.round(m) });
  }
  give('jet', jet, 'min');

  // 10. Последние 3 секунды окна колеса (≥ 5).
  fromCounts('last-second', counts(wheel
    .filter((s) => s.lockAt && s.lockAt.getTime() - s.createdAt.getTime() >= 0 && s.lockAt.getTime() - s.createdAt.getTime() <= TITLE_WINDOW_MS.lastSecond)
    .map((s) => s.userId)), TITLE_MIN.lastSecond);

  // 11. Куда все: на то же число в 3 с после чужой ставки (≥ 5).
  fromCounts('follower', followerCounts(input.stakes), TITLE_MIN.follower);

  // 12. Полуночник: ставки (все игры) с 03:00 до 06:00 МСК (≥ 10).
  fromCounts('night-owl', counts(stakes.filter((s) => {
    const h = mskHour(s.createdAt);
    return h >= NIGHT_HOURS.from && h < NIGHT_HOURS.to;
  }).map((s) => s.userId)), TITLE_MIN.nightOwl);

  // 13. Сразу к делу: тихих заходов ≥ 3.
  fromCounts('straight-to-business', quietEntryCounts(input.entries.filter((e) => ok(e.userId)), stakes), TITLE_MIN.straightToBusiness);

  // 14. Сила в правде: серия побед дуэлей подряд ≥ 3; равенство — больше выиграно в серии.
  give('truth-streak', [...duelists]
    .map((userId) => ({ userId, s: bestStreak(userId, decided) }))
    .filter((c) => c.s.length >= TITLE_MIN.truthStreak)
    .map((c) => ({ userId: c.userId, primary: c.s.length, secondary: c.s.coins, value: c.s.length })));

  // 15. Царь горы: за сутки ≥ 3 разных побеждённых и ни одного поражения; больше соперников.
  give('king-of-hill', [...duelists]
    .map((userId) => ({ userId, n: kingOfHillBest(userId, decided) }))
    .filter((c) => c.n >= TITLE_MIN.kingOfHill)
    .map((c) => ({ userId: c.userId, primary: c.n, value: c.n })));

  // 16. Фиаско: наименьшая доля побед при ≥ 10 дуэлях с исходом; равенство — больше дуэлей.
  give('fiasco', [...duelists]
    .map((userId) => {
      const mine = decided.filter((d) => sideOf(d, userId));
      const wins = mine.filter((d) => d.winnerId === userId).length;
      return { userId, n: mine.length, share: mine.length ? wins / mine.length : 0 };
    })
    .filter((c) => c.n >= TITLE_MIN.fiascoDuels)
    .map((c) => ({ userId: c.userId, primary: c.share, secondary: c.n, value: pct(c.share) })), 'min');

  // 17. Отыграюсь: реваншей ≥ 3.
  fromCounts('revenge', revengeCounts(input.duels), TITLE_MIN.revenge);

  // 18. Ловкость рук: побед в КНБ всухую (2:0) ≥ 2.
  fromCounts('sleight-of-hand', counts(decided.flatMap((d) => {
    if (d.game !== 'rps' || !d.rpsWins || !d.winnerId) return [];
    const side = sideOf(d, d.winnerId);
    const other = side === 'challenger' ? 'target' : 'challenger';
    return side && d.rpsWins[side] >= 2 && d.rpsWins[other] === 0 ? [d.winnerId] : [];
  })), TITLE_MIN.sleightOfHand);

  // 19. Ушёл по-английски: рассчитанных партий, где за него ходил сервер (`data.auto`), ≥ 2. Нет данных — не выдаётся.
  fromCounts('english-exit', counts(input.duels.filter((d) => d.settled && d.auto).flatMap((d) =>
    [d.auto!.challenger > 0 ? d.challengerId : null, d.auto!.target > 0 ? d.targetId : null].filter((u): u is string => u !== null),
  )), TITLE_MIN.englishExit);

  // 20. Жадность: больше всех очков сгорело за ОДИН ход (≥ 10).
  const greedy = moves.filter((m) => m.game === 'greedy');
  const burnedMax = new Map<string, number>();
  for (const m of greedy) if ((m.burned ?? 0) > 0) burnedMax.set(m.userId, Math.max(burnedMax.get(m.userId) ?? 0, m.burned!));
  give('greed', [...burnedMax].filter(([, n]) => n >= TITLE_MIN.greed).map(([userId, n]) => ({ userId, primary: n, value: n })));

  // 21. Бережёного: наименьшая доля сгоревших ходов (выпала «1») от всех законченных ходов (стоп или «1»), партий ≥ 5;
  // равенство — больше побед в Жадном гусе.
  const greedyDuels = decided.filter((d) => d.game === 'greedy');
  const careful: Candidate[] = [];
  for (const [userId, list] of group(greedy, (m) => m.userId)) {
    const games = new Set(input.duels.filter((d) => d.settled && d.game === 'greedy' && sideOf(d, userId)).map((d) => d.id)).size;
    if (games < TITLE_MIN.carefulGames) continue;
    const burnedTurns = list.filter((m) => m.kind === 'roll' && m.die === 1).length;
    const turns = burnedTurns + list.filter((m) => m.kind === 'stop').length;
    if (turns === 0) continue;
    const wins = greedyDuels.filter((d) => d.winnerId === userId).length;
    careful.push({ userId, primary: burnedTurns / turns, secondary: wins, value: pct(burnedTurns / turns) });
  }
  give('careful', careful, 'min');

  // 22. Ванга: доля угаданных при ≥ 10 рассчитанных ставках; равенство — больше угаданных.
  give('vanga', [...predBy]
    .filter(([, list]) => list.length >= TITLE_MIN.vangaStakes)
    .map(([userId, list]) => {
      const hits = list.filter((s) => (s.payout ?? 0) > 0).length;
      return { userId, primary: hits / list.length, secondary: hits, value: pct(hits / list.length) };
    }));

  // 23, 24. Смелые прогнозы (доля варианта < 20 % банка вопроса): угаданные (≥ 1, равенство — больше выиграно) и
  // несыгравшие (≥ 3, равенство — больше сгорело).
  const bold = preds.filter((s) => (shares.get(`${s.roundId}\u0000${s.pick}`) ?? 1) < BOLD_SHARE);
  const tide: Candidate[] = [];
  const couch: Candidate[] = [];
  for (const [userId, list] of group(bold, (s) => s.userId)) {
    const hits = list.filter((s) => (s.payout ?? 0) > 0);
    const misses = list.filter((s) => (s.payout ?? 0) === 0);
    if (hits.length >= TITLE_MIN.againstTide) {
      tide.push({ userId, primary: hits.length, secondary: hits.reduce((a, s) => a + (s.payout ?? 0) - s.amount, 0), value: hits.length });
    }
    if (misses.length >= TITLE_MIN.couchAnalyst) {
      couch.push({ userId, primary: misses.length, secondary: misses.reduce((a, s) => a + s.amount, 0), value: misses.length });
    }
  }
  give('against-tide', tide);
  give('couch-analyst', couch);

  // 25. Букмекер: подведённых событий ≥ 2; равенство — больше разных участников.
  give('bookmaker', [...group(input.events.filter((e) => e.createdBy && ok(e.createdBy)), (e) => e.createdBy!)]
    .filter(([, list]) => list.length >= TITLE_MIN.bookmaker)
    .map(([userId, list]) => ({ userId, primary: list.length, secondary: new Set(list.flatMap((e) => e.participants)).size, value: list.length })));

  // 26. Хатико: минут одному в отрезках, после которых пришла компания, ≥ 60.
  give('hachiko', input.voice
    .filter((v) => ok(v.userId) && v.waitedSeconds >= TITLE_MIN.hachikoSec)
    .map((v) => ({ userId: v.userId, primary: v.waitedSeconds, value: Math.floor(v.waitedSeconds / 60) })));

  // 27. Святой гусь: ≥ 10 ч в голосе и ни одной ставки, дуэли или прогноза — ВСЕМ подходящим; `value` — наибольшее.
  const saints = input.voice.filter((v) => ok(v.userId) && !input.played.has(v.userId) && v.seconds >= TITLE_MIN.holyGooseSec);
  if (saints.length > 0) {
    out.push({
      key: 'holy-goose',
      userIds: saints.map((v) => v.userId).sort(),
      value: Math.floor(Math.max(...saints.map((v) => v.seconds)) / 60),
    });
  }

  const order = new Map(GAME_TITLE_KEYS.map((k, i) => [k, i]));
  return out.sort((a, b) => order.get(a.key)! - order.get(b.key)!);
}

/**
 * Игры включились посреди месяца: первый раунд сервера позже начала месяца и раньше раундов нет — итог частичный, «с <даты>».
 * `firstRoundAt` — самый ранний раунд сервера вообще (не только за месяц).
 */
export function partialFrom(firstRoundAt: Date | null, range: { from: Date; to: Date }): Date | null {
  if (!firstRoundAt) return null;
  const t = firstRoundAt.getTime();
  return t > range.from.getTime() && t < range.to.getTime() ? firstRoundAt : null;
}

/** Любимое число колеса: самое частое `pick` среди своих ставок; равенство — меньшее число. */
export function favoritePick(stakes: TitleStake[], userId: string): { pick: string; count: number } | null {
  const c = counts(stakes.filter((s) => s.kind === 'wheel' && s.userId === userId).map((s) => s.pick));
  let best: { pick: string; count: number } | null = null;
  for (const [pick, count] of c) {
    if (!best || count > best.count || (count === best.count && Number(pick) < Number(best.pick))) best = { pick, count };
  }
  return best;
}

/** Рекорд сервера: сумма остаётся всегда, держатель — только если не исключён. */
export function recordOf(list: { userId: string; amount: number }[], excluded: ReadonlySet<string>): RecapRecordDto | null {
  const top = list[0];
  if (!top || top.amount <= 0) return null;
  return { userId: excluded.has(top.userId) ? null : top.userId, amount: top.amount };
}

/**
 * «Итоги месяца игр»: общая часть и личные (строка на каждого НЕисключённого из таблицы). Чистое: всё уже выбрано
 * (`gameTitlesData.ts`) и посчитано (`gameBoard`, `awardTitles`).
 */
export function gamesRecapOf(i: {
  input: GameMonthInput;
  board: ReturnType<typeof gameBoard>;
  awards: TitleAward[];
  rounds: Record<GameFamily, number>;
  fees: number;
  records: { bets: { userId: string; amount: number }[]; wins: { userId: string; amount: number }[] };
  partialFrom: Date | null;
}): { server: GamesRecapServerDto; personal: Map<string, GamesRecapPersonalDto> } {
  const { input, board, awards } = i;
  const server: GamesRecapServerDto = {
    partialFrom: i.partialFrom ? i.partialFrom.toISOString() : null,
    people: board.length,
    rounds: i.rounds,
    // Сумма — по всем (безымянный итог сервера), включая отказавшихся.
    jackpots: input.jackpots.reduce((a, j) => a + j.count, 0),
    jackpotCoins: input.jackpots.reduce((a, j) => a + j.coins, 0),
    fees: i.fees,
    biggestBet: recordOf(i.records.bets, input.excluded),
    biggestWin: recordOf(i.records.wins, input.excluded),
    topUserId: board[0]?.userId ?? null,
    titles: awards.map((a) => ({ key: a.key, userIds: a.userIds, value: a.value })),
  };
  const personal = new Map<string, GamesRecapPersonalDto>();
  for (const row of board) {
    const mine = input.stakes.filter((s) => s.userId === row.userId);
    const preds = mine.filter((s) => s.kind === 'prediction' && s.payout !== null);
    const { userId: _u, place, ...stats } = row;
    personal.set(row.userId, {
      ...stats,
      place,
      favoriteNumber: favoritePick(mine, row.userId),
      biggestWin: Math.max(0, ...mine.map((s) => (s.payout ?? 0) - s.amount)),
      predictions: { hits: preds.filter((s) => (s.payout ?? 0) > 0).length, misses: preds.filter((s) => s.payout === 0).length },
      titles: awards.filter((a) => a.userIds.includes(row.userId)).map((a) => a.key),
    });
  }
  return { server, personal };
}

/**
 * «Итоги сезона экономики»: общая часть и личные. `economyOut` — бот или отказ от экономики (личной части нет, имени в
 * рекордах нет); `gamesOut` — отказ от игр (в личной части `gamesNet: null`). `places` — места замороженного итога
 * (`season_results`), у сухого прогона — по заработанному.
 */
export function economyRecapOf(i: {
  rows: { userId: string; earned: number; spent: number; tipsIn: number; gamesNet: number; favoritePurchase: { reason: string; count: number } | null }[];
  totals: { burned: number; minted: number };
  fees: number;
  circulation: number;
  voice: ReadonlyMap<string, { seconds: number; waitedSeconds: number }>;
  places: ReadonlyMap<string, number>;
  records: { bets: { userId: string; amount: number }[]; wins: { userId: string; amount: number }[] };
  economyOut: ReadonlySet<string>;
  gamesOut: ReadonlySet<string>;
}): { server: EconomyRecapServerDto; personal: Map<string, EconomyRecapPersonalDto> } {
  const earned = i.rows.reduce((a, r) => a + r.earned, 0);
  const spent = i.rows.reduce((a, r) => a + r.spent, 0);
  let voiceSeconds = 0;
  for (const v of i.voice.values()) voiceSeconds += v.seconds;
  const top = [...i.places].filter(([u]) => !i.economyOut.has(u)).sort((a, b) => a[1] - b[1])[0];
  const server: EconomyRecapServerDto = {
    earned,
    spent,
    spentPercent: earned > 0 ? Math.round((spent / earned) * 100) : 0,
    burned: i.totals.burned + i.fees,
    minted: i.totals.minted,
    circulation: i.circulation,
    people: i.rows.filter((r) => r.earned > 0).length,
    topUserId: top ? top[0] : null,
    voiceHours: Math.floor(voiceSeconds / 3600),
    biggestBet: recordOf(i.records.bets, i.economyOut),
    biggestWin: recordOf(i.records.wins, i.economyOut),
  };
  const personal = new Map<string, EconomyRecapPersonalDto>();
  for (const r of i.rows) {
    if (i.economyOut.has(r.userId)) continue;
    const v = i.voice.get(r.userId);
    personal.set(r.userId, {
      earned: r.earned,
      spent: r.spent,
      tipsIn: r.tipsIn,
      gamesNet: i.gamesOut.has(r.userId) ? null : r.gamesNet,
      place: i.places.get(r.userId) ?? null,
      voiceMinutes: Math.floor((v?.seconds ?? 0) / 60),
      waitedMinutes: Math.floor((v?.waitedSeconds ?? 0) / 60),
      favoritePurchase: r.favoritePurchase,
    });
  }
  return { server, personal };
}
