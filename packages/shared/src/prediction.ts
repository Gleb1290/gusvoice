/**
 * «Ставки на события» (прогнозы, ГусКоины 2, этап 5) — общие константы, DTO и чистый делёж банка для сервера и клиента.
 *
 * 🔴 Без зависимостей: клиент считает прикидку «поставишь 100 — получишь ~N» ТЕМ ЖЕ кодом, которым сервер платит
 * (`splitParimutuel`). Событие уровня сервера: несколько вопросов, у каждого 2..10 вариантов; ставят сидящие в голосе
 * этого сервера, кроме создателя; итог подводит только создатель, отменить — он же или `MANAGE_PREDICTIONS`/`MANAGE_ECONOMY`/владелец.
 */

/** Вопросов в событии — не больше. */
export const PREDICTION_MAX_QUESTIONS = 10;
export const PREDICTION_MIN_OPTIONS = 2;
export const PREDICTION_MAX_OPTIONS = 10;
/** Живых (`open|locked`) событий на сервер — не больше. */
export const PREDICTION_MAX_LIVE = 3;
export const PREDICTION_TITLE_MAX = 120;
export const PREDICTION_QUESTION_MAX = 200;
export const PREDICTION_OPTION_MAX = 80;
/** Таймер закрытия приёма ставок (секунды от создания); `null` — закрыть вручную. */
export const PREDICTION_LOCK_MIN_SEC = 30;
export const PREDICTION_LOCK_MAX_SEC = 7 * 24 * 60 * 60;
/** Закрыто, а итога нет столько — такт отменяет событие с возвратом всех ставок. */
export const PREDICTION_AUTO_CANCEL_MS = 7 * 24 * 60 * 60 * 1000;
/** Пуш `prediction.state` одного события — не чаще. */
export const PREDICTION_PUSH_MIN_MS = 1_000;
/** Сколько закончившееся событие ещё лежит в снимке (итог «с перьями» опоздавшему). */
export const PREDICTION_RESULT_SHOW_MS = 24 * 60 * 60 * 1000;

export type PredictionState = 'open' | 'locked' | 'settled' | 'cancelled';

/**
 * Причина отмены: `creator` — отменил создатель, `moderator` — `MANAGE_PREDICTIONS`/`MANAGE_ECONOMY`/владелец, `expired` — нет итога 7 суток
 * после закрытия, `games-off` — игры сервера выключены, `creator-deleted` — создатель удалил аккаунт.
 * Неизвестную причину клиент показывает общим «Событие отменено».
 */
export type PredictionCancelReason = 'creator' | 'moderator' | 'expired' | 'games-off' | 'creator-deleted';

export interface PredictionOptionDto {
  id: string;
  label: string;
  /** Сумма живых (не возвращённых) ставок на вариант. */
  pool: number;
  /** Сколько человек поставило на вариант. */
  bettors: number;
}

/** Ставка — открыто всем, как ставки колеса. */
export interface PredictionBetDto {
  userId: string;
  optionId: string;
  amount: number;
  /** Выплата по итогу (0 — не угадал); null — итога ещё нет или ставка возвращена. */
  payout: number | null;
  refunded: boolean;
}

export interface PredictionMyBetDto {
  optionId: string;
  amount: number;
  payout: number | null;
  refunded: boolean;
}

export interface PredictionQuestionDto {
  /** id вопроса (= раунд `game_rounds kind='prediction'`). */
  id: string;
  pos: number;
  question: string;
  options: PredictionOptionDto[];
  /** Банк вопроса — сумма живых ставок. */
  pool: number;
  /** Угадавший вариант; null — итога нет или вопрос не состоялся (`void`). */
  winnerOptionId: string | null;
  /** «Вопрос не состоялся» — все ставки по нему вернулись. */
  void: boolean;
  /** Сгорело по итогу (комиссия с проигравшего пула + остатки округления); null — итога нет. */
  fee: number | null;
  bets: PredictionBetDto[];
  /**
   * Моя ставка — только в снимке `GET /servers/:id/predictions`; в `prediction.state` (общая рассылка) всегда null:
   * клиент берёт свою строку из `bets` по своему id.
   */
  mine: PredictionMyBetDto | null;
}

export interface PredictionEventDto {
  id: string;
  serverId: string;
  title: string;
  /** null — аккаунт создателя удалён. */
  createdBy: string | null;
  state: PredictionState;
  /** Таймер закрытия приёма ставок; null — закрывается вручную. */
  lockAt: string | null;
  createdAt: string;
  lockedAt: string | null;
  /** Конец события: итог или отмена. */
  settledAt: string | null;
  cancelReason: PredictionCancelReason | null;
  /** Когда такт отменит закрытое событие без итога (`lockedAt + 7 суток`); null — не закрыто или закончено. */
  autoCancelAt: string | null;
  /** Комиссия, замороженная при создании (с проигравшего пула). */
  feePercent: number;
  questions: PredictionQuestionDto[];
}

export interface PredictionSnapshotDto {
  serverId: string;
  serverNow: string;
  /** Экономика видна человеку и игры на сервере включены. */
  enabled: boolean;
  /** Потолок ставки (`gamesBetMax`). */
  betMax: number;
  /** Может заводить события и отменять чужие (`MANAGE_PREDICTIONS`, `MANAGE_ECONOMY` или владелец; `canRunPredictions`). Итог — только создатель. */
  canManage: boolean;
  /** Живые события и закончившиеся за `PREDICTION_RESULT_SHOW_MS`, новые сверху. */
  events: PredictionEventDto[];
}

/** Ставка в банке вопроса; `key` — любой идентификатор у вызывающего. */
export interface ParimutuelStake {
  key: string;
  amount: number;
  winner: boolean;
}

export interface ParimutuelSplit {
  /** Выплата на каждую ставку ВКЛЮЧАЯ саму ставку (0 — не угадал). При возврате — сама ставка. */
  payouts: Map<string, number>;
  /** Сгорело: банк минус сумма выплат (комиссия с проигравшего пула + остатки округления). */
  fee: number;
  /** Никто не угадал или никто не проиграл — всем вернуть ставки, комиссии нет. */
  refundAll: boolean;
}

/**
 * Делёж банка вопроса (parimutuel). Комиссия `⌊проигравший_пул × feePercent / 100⌋` — ТОЛЬКО с проигравшего пула;
 * угадавший получает свою ставку + долю (проигравший_пул − комиссия) пропорционально ставке, дробь вниз, остаток
 * округления сгорает. Поэтому угадавший никогда не получает меньше своей ставки (в отличие от `splitPot` дуэли, где
 * комиссия с ВСЕГО банка и при перекосе «выиграл и проиграл»). Никто не угадал / никто не проиграл — возврат всем.
 * Σ выплат ≤ банка всегда.
 */
export function splitParimutuel(stakes: ParimutuelStake[], feePercent: number): ParimutuelSplit {
  const payouts = new Map<string, number>();
  const live = stakes.filter((x) => Number.isInteger(x.amount) && x.amount > 0);
  const winStake = live.filter((x) => x.winner).reduce((s, x) => s + x.amount, 0);
  const losePool = live.filter((x) => !x.winner).reduce((s, x) => s + x.amount, 0);
  if (winStake <= 0 || losePool <= 0) {
    for (const x of stakes) payouts.set(x.key, Math.max(0, x.amount));
    return { payouts, fee: 0, refundAll: true };
  }
  const pct = Math.min(100, Math.max(0, Math.floor(feePercent)));
  const distributable = losePool - Math.floor((losePool * pct) / 100);
  let paid = 0;
  let pot = 0;
  for (const x of stakes) {
    const amount = Math.max(0, x.amount);
    pot += amount;
    const p = x.winner && amount > 0 ? amount + Math.floor((distributable * amount) / winStake) : 0;
    payouts.set(x.key, p);
    paid += p;
  }
  return { payouts, fee: pot - paid, refundAll: false };
}

/**
 * Прикидка для клиента: сколько получит ставка `amount` на `optionId`, если вариант сыграет, при текущих пулах вопроса
 * (ставка добавляется к пулу варианта). 0 — некорректный ввод. Если на других вариантах пусто — вернётся сама ставка.
 */
export function predictionEstimate(options: Pick<PredictionOptionDto, 'id' | 'pool'>[], optionId: string, amount: number, feePercent: number): number {
  if (!Number.isInteger(amount) || amount <= 0 || !options.some((o) => o.id === optionId)) return 0;
  const stakes: ParimutuelStake[] = options.map((o) => ({ key: `pool:${o.id}`, amount: Math.max(0, o.pool), winner: o.id === optionId }));
  stakes.push({ key: 'me', amount, winner: true });
  return splitParimutuel(stakes, feePercent).payouts.get('me') ?? 0;
}
