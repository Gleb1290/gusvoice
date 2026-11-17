import { createHash } from 'node:crypto';
import {
  jackpotCentsOf,
  jackpotFromHash,
  sectorFromHash,
  splitJackpot,
  WHEEL_COOLDOWN_MS,
  wheelCommitInput,
  wheelJackpotInput,
  wheelPayout,
  wheelSectorInput,
  isWheelPick,
  type WheelPick,
  type WheelResultDto,
  type WheelRoundDto,
} from '@gusvoice/shared';
import { STAKE_BLOCK_TEXT, type StakeBlock } from './gameMoneyRules.js';

/**
 * Колесо гусей-пиратов (ГусКоины 2, этап 2) — чистое поверх общих правил `@gusvoice/shared/wheel.ts`: хеши зерна, план
 * расчёта раунда, DTO и коды отказов. Транзакции и такт — `gameWheel.ts`, маршруты — `routes/gameWheel.ts`.
 *
 * 🔴 Проверяемая честность (Р5): при заведении раунда сервер берёт зерно `randomBytes(32)` и сразу показывает только
 * `commit = sha256(wheelCommitInput)`; сектор и джекпот — из того же зерна (`wheelSectorInput`/`wheelJackpotInput`).
 * Зерно уходит людям ТОЛЬКО в итоге (`WheelResultDto.seed`) — DTO открытого/запертого раунда собираются здесь из
 * перечисленных полей, `data` целиком наружу не отдаётся никогда.
 */

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();

/** `commit` раунда — sha256 hex строки `wheelCommitInput`. */
export function wheelCommit(roundId: string, seedHex: string): string {
  return sha256(wheelCommitInput(roundId, seedHex)).toString('hex');
}

/** Сектор и срыв джекпота — из зерна, тем же кодом, которым их проверит браузер. */
export function wheelOutcome(roundId: string, seedHex: string): { sector: number; jackpotHit: boolean } {
  return {
    sector: sectorFromHash(new Uint8Array(sha256(wheelSectorInput(roundId, seedHex)))),
    jackpotHit: jackpotFromHash(new Uint8Array(sha256(wheelJackpotInput(roundId, seedHex)))),
  };
}

/** Что лежит в `game_rounds.data` колеса. `seed` — СЕКРЕТ до итога. */
export interface WheelRoundData {
  commit: string;
  seed: string;
  sector?: number;
  jackpotHit?: boolean;
  /** Срыв навязан флагом тестового инстанса (`wheelForcedJackpot`), а не зерном. */
  forced?: boolean;
  /** Приём закрыт досрочно «Крутить сейчас» (30.10) — кем; в DTO не уходит, след для разбора. */
  closedBy?: string;
  /** Итог: выдано из сундука (целые монеты), банк, сгоревшее, взнос раунда в сундук (сотые), победители. */
  jackpotPaid?: number;
  pool?: number;
  fee?: number;
  jackpotCents?: number;
  winners?: WheelResultDto['winners'];
}

export interface WheelStakeRow {
  userId: string;
  pick: string;
  amount: number;
  refundedAt?: Date | null;
}

/** Ставки раунда наружу: возвращённые не показываются, выбор — числом. */
export function wheelBets(stakes: WheelStakeRow[]): WheelRoundDto['bets'] {
  const out: WheelRoundDto['bets'] = [];
  for (const s of stakes) {
    const pick = Number(s.pick);
    if (s.refundedAt || !isWheelPick(pick)) continue;
    out.push({ userId: s.userId, pick, amount: s.amount });
  }
  return out;
}

/** Живой раунд наружу. 🔴 Без зерна; сектор — только у запертого (до блокировки его нет и в базе). */
export function wheelRoundDto(
  row: { id: string; state: string; lockAt: Date | null; settleAt: Date | null; data: Record<string, unknown> },
  stakes: WheelStakeRow[],
): WheelRoundDto | null {
  if ((row.state !== 'open' && row.state !== 'locked') || !row.lockAt) return null;
  const data = row.data as Partial<WheelRoundData>;
  return {
    id: row.id,
    state: row.state,
    lockAt: row.lockAt.toISOString(),
    settleAt: row.settleAt ? row.settleAt.toISOString() : null,
    commit: typeof data.commit === 'string' ? data.commit : '',
    sector: row.state === 'locked' && typeof data.sector === 'number' ? data.sector : null,
    bets: wheelBets(stakes),
  };
}

/** Итог рассчитанного раунда наружу (зерно здесь уже открыто). `null` — раунд не рассчитан или данные битые. */
export function wheelResultDto(row: { id: string; state: string; settledAt: Date | null; data: Record<string, unknown> }): WheelResultDto | null {
  const data = row.data as Partial<WheelRoundData>;
  if (row.state !== 'settled' || !row.settledAt || typeof data.sector !== 'number' || typeof data.seed !== 'string') return null;
  return {
    id: row.id,
    sector: data.sector,
    seed: data.seed,
    commit: typeof data.commit === 'string' ? data.commit : '',
    jackpotHit: data.jackpotHit === true,
    jackpotPaid: typeof data.jackpotPaid === 'number' ? data.jackpotPaid : 0,
    // Поле только у навязанных раундов — у честных его нет вовсе (DTO не меняется для старых клиентов и фикстур).
    ...(data.forced === true ? { forced: true } : {}),
    settledAt: row.settledAt.toISOString(),
    winners: Array.isArray(data.winners) ? data.winners : [],
  };
}

/** До какого момента новый раунд заводить нельзя (пауза после итога); `null` — уже можно. */
export function wheelCooldownUntil(lastSettledAt: Date | null, now: Date): Date | null {
  if (!lastSettledAt) return null;
  const until = lastSettledAt.getTime() + WHEEL_COOLDOWN_MS;
  return until > now.getTime() ? new Date(until) : null;
}

/**
 * Принудительный срыв (флаг тестового инстанса `WHEEL_FORCE_JACKPOT`, `env.wheelForceJackpot`): при включённом флаге
 * раунд срывает сундук, если в нём есть хотя бы монета (`poolCents >= 100`) — иначе делить нечего, и раунд остаётся
 * честным (срыв по зерну как есть). `forced` — только когда срыв навязан поверх «нет» по зерну: честный срыв при
 * поднятом флаге остаётся честным. Режим не однократный — срыв в каждом раунде, пока флаг стоит (проще для роликов).
 */
export function wheelForcedJackpot(natural: boolean, flag: boolean, poolCents: number): { jackpotHit: boolean; forced: boolean } {
  if (natural || !flag || poolCents < 100) return { jackpotHit: natural, forced: false };
  return { jackpotHit: true, forced: true };
}

/** Сундук наружу — целые монеты. */
export function wheelJackpotCoins(cents: number): number {
  return Math.max(0, Math.floor(cents / 100));
}

/** План расчёта раунда: что выплатить по каждой ставке и из сундука. */
export interface WheelSettlePlan {
  /** Выплата на ставку (тот же порядок, что `stakes`); 0 — проиграла. */
  payouts: number[];
  /** Доли сундука (только при срыве), целые монеты. */
  jackpotShares: { userId: string; coins: number }[];
  /** Что останется в сундуке, сотые. */
  leftCents: number;
  /** Σ ставок, Σ выплат по ставкам, Σ из сундука. */
  pool: number;
  paid: number;
  jackpotPaid: number;
  /** Взнос раунда в сундук (сотые) — уже лежит в сундуке со ставок. */
  jackpotCents: number;
  /** Сгорело (доля дома): банк − выплаты − взнос в сундук; в монетах, до сотых. */
  fee: number;
  winners: WheelResultDto['winners'];
}

/**
 * Расчёт раунда без базы. Ставки — незакрытые (не выплаченные и не возвращённые).
 * 🔴 Сундук делится по СУММЕ ставок человека в раунде — между всеми поставившими, а не только угадавшими: джекпот — по
 * хешу зерна, а не по сектору. Монеты вниз, остаток в сотых остаётся в сундуке (`splitJackpot`).
 */
export function wheelSettlePlan(stakes: WheelStakeRow[], sector: number, jackpotHit: boolean, poolCents: number): WheelSettlePlan {
  const payouts = stakes.map((s) => {
    const pick = Number(s.pick);
    return isWheelPick(pick) ? wheelPayout(pick, s.amount, sector) : 0;
  });
  const pool = stakes.reduce((sum, s) => sum + s.amount, 0);
  const paid = payouts.reduce((sum, p) => sum + p, 0);
  const jackpotCents = stakes.reduce((sum, s) => sum + jackpotCentsOf(s.amount), 0);
  const totals = new Map<string, number>();
  for (const s of stakes) totals.set(s.userId, (totals.get(s.userId) ?? 0) + s.amount);
  const split = jackpotHit
    ? splitJackpot(Math.max(0, poolCents), [...totals].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([userId, total]) => ({ userId, total })))
    : { shares: [], leftCents: Math.max(0, poolCents) };
  const jackpotPaid = split.shares.reduce((sum, x) => sum + x.coins, 0);
  const winners: WheelResultDto['winners'] = [];
  stakes.forEach((s, i) => {
    if (payouts[i] > 0) winners.push({ userId: s.userId, pick: Number(s.pick) as WheelPick, payout: payouts[i] });
  });
  for (const x of split.shares) winners.push({ userId: x.userId, pick: 'jackpot', payout: x.coins });
  return {
    payouts,
    jackpotShares: split.shares,
    leftCents: split.leftCents,
    pool,
    paid,
    jackpotPaid,
    jackpotCents,
    fee: (pool * 100 - paid * 100 - jackpotCents) / 100,
    winners,
  };
}

/** Коды отказа ставки колеса (клиент переводит их в текст; `message` — запасной текст для старых клиентов). */
export type WheelBetRefusal = 'games-off' | 'not_in_voice' | 'busy' | 'cooldown' | 'round_locked' | 'duplicate_pick' | StakeBlock;


/** Отказ этапа 1 → код колеса: «раунд закрыт» и «повтор» у колеса называются по-своему (контракт этапа 2). */
export function wheelRefusalOf(block: StakeBlock): WheelBetRefusal {
  if (block === 'round-closed') return 'round_locked';
  if (block === 'duplicate') return 'duplicate_pick';
  return block;
}

export const WHEEL_REFUSAL_TEXT: Record<WheelBetRefusal, string> = {
  ...STAKE_BLOCK_TEXT,
  not_in_voice: 'Ставить можно, только сидя в голосе этого сервера',
  busy: 'Ставка уже отправляется',
  cooldown: 'Колесо отдыхает — новый раунд через несколько секунд',
  round_locked: 'Колесо уже крутится — ставки на этот раунд закрыты',
  duplicate_pick: 'На это число ты уже поставил в этом раунде',
};

/**
 * Отказ «Крутить сейчас» (30.10, `POST /servers/:id/wheel/spin`): приём ставок не идёт — `no_round` (409); вызвавший не
 * ставил в этом раунде — `no_bet` (403). Отдельно от `WheelBetRefusal`: тот перечень — контракт ставки, его карту
 * текстов держит и клиент. Тело ответа — то же `{error, reason, message}`.
 */
export type WheelSpinRefusal = 'no_round' | 'no_bet';

export const WHEEL_SPIN_REFUSAL_TEXT: Record<WheelSpinRefusal, string> = {
  no_round: 'Приём ставок сейчас не идёт',
  no_bet: 'Крутить досрочно может только тот, кто поставил в этом раунде',
};

export function wheelSpinRefusalStatus(code: WheelSpinRefusal): number {
  return code === 'no_bet' ? 403 : 409;
}

/** HTTP-код отказа: неверный ввод — 400, «нельзя тебе/здесь» — 403, состояние раунда и денег — 409, гонка — 429. */
export function wheelRefusalStatus(code: WheelBetRefusal): number {
  if (code === 'bad-amount' || code === 'bad-pick') return 400;
  if (code === 'games-off' || code === 'not_in_voice' || code === 'bot' || code === 'opted-out' || code === 'games-opted-out') return 403;
  if (code === 'busy') return 429;
  return 409;
}
