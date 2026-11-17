import {
  PREDICTION_AUTO_CANCEL_MS,
  PREDICTION_LOCK_MAX_SEC,
  PREDICTION_LOCK_MIN_SEC,
  PREDICTION_MAX_OPTIONS,
  PREDICTION_MAX_QUESTIONS,
  PREDICTION_MIN_OPTIONS,
  PREDICTION_OPTION_MAX,
  PREDICTION_QUESTION_MAX,
  PREDICTION_TITLE_MAX,
  splitParimutuel,
  type PredictionBetDto,
  type PredictionCancelReason,
  type PredictionEventDto,
  type PredictionQuestionDto,
  type PredictionState,
} from '@gusvoice/shared';
import { STAKE_BLOCK_TEXT, type StakeBlock } from './gameMoneyRules.js';

/**
 * Ставки на события (ГусКоины 2, этап 5) — чистые правила: проверка редактора, DTO, план итога, коды отказа.
 * Транзакции и такт — `gamePredictions.ts`, маршруты — `routes/gamePredictions.ts`, делёж банка — `splitParimutuel`
 * (`@gusvoice/shared/prediction.ts`: им же клиент считает прикидку).
 */

export { splitParimutuel };

/** `game_rounds.data` вопроса. Итог дописывается: `winnerOptionId` (null + `void` — «вопрос не состоялся»), `pool`, `fee`. */
export interface PredictionRoundData {
  eventId: string;
  pos: number;
  question: string;
  options: { id: string; label: string }[];
  feePercent: number;
  winnerOptionId?: string | null;
  void?: boolean;
  pool?: number;
  fee?: number;
  reason?: string;
}

export interface PredictionDraft {
  title: string;
  /** null — закрывать вручную. */
  lockInSec: number | null;
  questions: { question: string; options: { id: string; label: string }[] }[];
}

/** Строка: управляющие символы — в пробел, пробелы схлопнуты, края обрезаны. */
export function cleanPredictionText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Где ошибка в редакторе: `title`, `lock`, `questions`, `q<N>`, `q<N>.options`, `q<N>.o<M>` (N, M — с нуля). */
export type PredictionDraftResult = { ok: true; draft: PredictionDraft } | { ok: false; field: string };

/**
 * Проверка редактора события: название 1..`PREDICTION_TITLE_MAX`, вопросов 1..`PREDICTION_MAX_QUESTIONS`, текст вопроса
 * 1..`PREDICTION_QUESTION_MAX`, вариантов `PREDICTION_MIN_OPTIONS`..`PREDICTION_MAX_OPTIONS` длиной 1..`PREDICTION_OPTION_MAX`,
 * без повторов в вопросе (без учёта регистра); таймер — null или `PREDICTION_LOCK_MIN_SEC`..`PREDICTION_LOCK_MAX_SEC` целых
 * секунд. Id вариантов раздаёт сервер (`o1`…), клиент их не присылает.
 */
export function validatePredictionDraft(raw: { title?: unknown; lockInSec?: unknown; questions?: unknown }): PredictionDraftResult {
  const title = cleanPredictionText(raw.title);
  if (title.length === 0 || title.length > PREDICTION_TITLE_MAX) return { ok: false, field: 'title' };
  let lockInSec: number | null = null;
  if (raw.lockInSec !== undefined && raw.lockInSec !== null) {
    const v = raw.lockInSec;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < PREDICTION_LOCK_MIN_SEC || v > PREDICTION_LOCK_MAX_SEC) return { ok: false, field: 'lock' };
    lockInSec = v;
  }
  const qs = raw.questions;
  if (!Array.isArray(qs) || qs.length === 0 || qs.length > PREDICTION_MAX_QUESTIONS) return { ok: false, field: 'questions' };
  const questions: PredictionDraft['questions'] = [];
  for (let n = 0; n < qs.length; n++) {
    const q = qs[n] as { question?: unknown; options?: unknown } | null;
    const question = cleanPredictionText(q?.question);
    if (question.length === 0 || question.length > PREDICTION_QUESTION_MAX) return { ok: false, field: `q${n}` };
    const opts = q?.options;
    if (!Array.isArray(opts) || opts.length < PREDICTION_MIN_OPTIONS || opts.length > PREDICTION_MAX_OPTIONS) return { ok: false, field: `q${n}.options` };
    const seen = new Set<string>();
    const options: { id: string; label: string }[] = [];
    for (let m = 0; m < opts.length; m++) {
      const label = cleanPredictionText(opts[m]);
      if (label.length === 0 || label.length > PREDICTION_OPTION_MAX) return { ok: false, field: `q${n}.o${m}` };
      const key = label.toLocaleLowerCase('ru');
      if (seen.has(key)) return { ok: false, field: `q${n}.o${m}` };
      seen.add(key);
      options.push({ id: `o${m + 1}`, label });
    }
    questions.push({ question, options });
  }
  return { ok: true, draft: { title, lockInSec, questions } };
}

/**
 * Итог: на КАЖДЫЙ вопрос события — id варианта или null («вопрос не состоялся»). Лишние ключи, пропуски и чужие варианты —
 * отказ целиком (`bad_winners`): частичный итог не подводится.
 */
export function checkPredictionWinners(
  questions: { id: string; options: { id: string }[] }[],
  winners: Record<string, unknown>,
): Map<string, string | null> | null {
  const keys = Object.keys(winners);
  if (keys.length !== questions.length) return null;
  const out = new Map<string, string | null>();
  for (const q of questions) {
    if (!Object.prototype.hasOwnProperty.call(winners, q.id)) return null;
    const w = winners[q.id];
    if (w === null) out.set(q.id, null);
    else if (typeof w === 'string' && q.options.some((o) => o.id === w)) out.set(q.id, w);
    else return null;
  }
  return out;
}

export interface PredictionStakeRow {
  userId: string;
  pick: string;
  amount: number;
  payout: number | null;
  paidAt: Date | null;
  refundedAt: Date | null;
}

/** Ставка живая: не выплачена и не возвращена (ставка удалённого аккаунта уже возвращена — банк честно меньше). */
export const isLiveStake = (s: Pick<PredictionStakeRow, 'paidAt' | 'refundedAt'>) => s.paidAt === null && s.refundedAt === null;

export interface PredictionSettlePlan {
  /** Возврат всех живых ставок вопроса (`void`, никто не угадал, никто не проиграл). */
  refund: boolean;
  /** Выплата каждой живой ставке (0 — проиграла), если не `refund`. */
  payouts: { userId: string; pick: string; payout: number }[];
  /** Банк живых ставок. */
  pool: number;
  /** Сгорело (0 при возврате). */
  fee: number;
}

/** План итога одного вопроса по ЖИВЫМ ставкам: `winner` null — «не состоялся», иначе `splitParimutuel`. */
export function predictionSettlePlan(stakes: PredictionStakeRow[], winner: string | null, feePercent: number): PredictionSettlePlan {
  const live = stakes.filter(isLiveStake);
  const pool = live.reduce((s, x) => s + x.amount, 0);
  if (winner === null) return { refund: true, payouts: [], pool, fee: 0 };
  const split = splitParimutuel(
    live.map((s) => ({ key: `${s.userId}\u0000${s.pick}`, amount: s.amount, winner: s.pick === winner })),
    feePercent,
  );
  if (split.refundAll) return { refund: true, payouts: [], pool, fee: 0 };
  return {
    refund: false,
    payouts: live.map((s) => ({ userId: s.userId, pick: s.pick, payout: split.payouts.get(`${s.userId}\u0000${s.pick}`) ?? 0 })),
    pool,
    fee: split.fee,
  };
}

const CANCEL_REASONS: readonly PredictionCancelReason[] = ['creator', 'moderator', 'expired', 'games-off', 'creator-deleted'];

export interface PredictionEventRow {
  id: string;
  serverId: string;
  createdBy: string | null;
  title: string;
  state: PredictionState;
  feePercent: number;
  lockAt: Date | null;
  createdAt: Date;
  lockedAt: Date | null;
  settledAt: Date | null;
  cancelReason: string | null;
}

export interface PredictionRoundRow {
  id: string;
  data: Record<string, unknown>;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * DTO события. Пулы и число поставивших — по ставкам, которые не возвращены (живые и выплаченные). `bets` — открыто
 * всем, как ставки колеса. `viewerId` null (общая рассылка) — `mine` у всех вопросов null.
 */
export function predictionEventDto(
  ev: PredictionEventRow,
  rounds: PredictionRoundRow[],
  stakesByRound: Map<string, PredictionStakeRow[]>,
  viewerId: string | null,
): PredictionEventDto {
  const questions: PredictionQuestionDto[] = rounds
    .map((r) => ({ r, d: r.data as unknown as PredictionRoundData }))
    .sort((a, b) => a.d.pos - b.d.pos)
    .map(({ r, d }) => {
      const stakes = stakesByRound.get(r.id) ?? [];
      const counted = stakes.filter((s) => s.refundedAt === null);
      const bets: PredictionBetDto[] = stakes.map((s) => ({
        userId: s.userId,
        optionId: s.pick,
        amount: s.amount,
        payout: s.refundedAt === null && s.paidAt !== null ? (s.payout ?? 0) : null,
        refunded: s.refundedAt !== null,
      }));
      const mineBet = viewerId ? bets.find((b) => b.userId === viewerId) : undefined;
      return {
        id: r.id,
        pos: d.pos,
        question: d.question,
        options: d.options.map((o) => {
          const on = counted.filter((s) => s.pick === o.id);
          return { id: o.id, label: o.label, pool: on.reduce((s, x) => s + x.amount, 0), bettors: new Set(on.map((s) => s.userId)).size };
        }),
        pool: counted.reduce((s, x) => s + x.amount, 0),
        winnerOptionId: typeof d.winnerOptionId === 'string' ? d.winnerOptionId : null,
        void: d.void === true,
        fee: typeof d.fee === 'number' ? d.fee : null,
        bets,
        mine: mineBet ? { optionId: mineBet.optionId, amount: mineBet.amount, payout: mineBet.payout, refunded: mineBet.refunded } : null,
      };
    });
  return {
    id: ev.id,
    serverId: ev.serverId,
    title: ev.title,
    createdBy: ev.createdBy,
    state: ev.state,
    lockAt: iso(ev.lockAt),
    createdAt: ev.createdAt.toISOString(),
    lockedAt: iso(ev.lockedAt),
    settledAt: iso(ev.settledAt),
    cancelReason: ev.state === 'cancelled' ? (CANCEL_REASONS as readonly string[]).includes(ev.cancelReason ?? '') ? (ev.cancelReason as PredictionCancelReason) : 'moderator' : null,
    autoCancelAt: ev.state === 'locked' && ev.lockedAt ? new Date(ev.lockedAt.getTime() + PREDICTION_AUTO_CANCEL_MS).toISOString() : null,
    feePercent: ev.feePercent,
    questions,
  };
}

/** Автоотмена созрела: закрыто без итога `PREDICTION_AUTO_CANCEL_MS`. */
export function predictionAutoCancelDue(ev: Pick<PredictionEventRow, 'state' | 'lockedAt'>, now: Date): boolean {
  return ev.state === 'locked' && ev.lockedAt !== null && now.getTime() - ev.lockedAt.getTime() >= PREDICTION_AUTO_CANCEL_MS;
}

/**
 * Коды отказа (клиент переводит в текст; `message` — запасной текст). `creator` — создатель не ставит на своё событие;
 * `not_creator` — итог подводит только создатель; `forbidden` — нет `MANAGE_PREDICTIONS`/`MANAGE_ECONOMY` (создать/отменить чужое).
 */
export type PredictionRefusal =
  | 'games-off'
  | 'not_in_voice'
  | 'forbidden'
  | 'not_found'
  | 'creator'
  | 'not_creator'
  | 'already_bet'
  | 'not_open'
  | 'not_locked'
  | 'finished'
  | 'too_many'
  | 'bad_draft'
  | 'bad_winners'
  | 'busy'
  | StakeBlock;

export const PREDICTION_REFUSAL_TEXT: Record<PredictionRefusal, string> = {
  ...STAKE_BLOCK_TEXT,
  'round-closed': 'Приём ставок на это событие закрыт',
  duplicate: 'Эта ставка уже сделана',
  'games-off': 'На этом сервере игр нет',
  not_in_voice: 'Ставить можно, только сидя в голосе этого сервера',
  forbidden: 'Нужно право управлять экономикой',
  not_found: 'Событие не найдено',
  creator: 'Создатель события не ставит — итог подводит он',
  not_creator: 'Итог подводит только создатель события',
  already_bet: 'На этот вопрос ты уже поставил — ставка окончательная',
  not_open: 'Приём ставок уже закрыт',
  not_locked: 'Сначала закрой приём ставок',
  finished: 'Событие уже закончилось',
  too_many: 'На сервере уже идут три события — дождись итога одного из них',
  bad_draft: 'Проверь событие: название, вопросы и варианты',
  bad_winners: 'Укажи исход каждого вопроса',
  busy: 'Уже отправляется',
};

/** HTTP-код: неверный ввод — 400, «нельзя тебе/здесь» — 403, нет такого — 404, состояние — 409, гонка — 429. */
export function predictionRefusalStatus(code: PredictionRefusal): number {
  if (code === 'bad-amount' || code === 'bad-pick' || code === 'bad_draft' || code === 'bad_winners') return 400;
  if (
    code === 'games-off' ||
    code === 'not_in_voice' ||
    code === 'forbidden' ||
    code === 'creator' ||
    code === 'not_creator' ||
    code === 'bot' ||
    code === 'opted-out' ||
    code === 'games-opted-out'
  )
    return 403;
  if (code === 'not_found') return 404;
  if (code === 'busy') return 429;
  return 409;
}
