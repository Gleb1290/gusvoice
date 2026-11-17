import {
  PREDICTION_LOCK_MAX_SEC,
  PREDICTION_LOCK_MIN_SEC,
  PREDICTION_MAX_OPTIONS,
  PREDICTION_MAX_QUESTIONS,
  PREDICTION_MIN_OPTIONS,
  PREDICTION_OPTION_MAX,
  PREDICTION_QUESTION_MAX,
  PREDICTION_TITLE_MAX,
  type PredictionCancelReason,
  type PredictionEventDto,
  type PredictionMyBetDto,
  type PredictionQuestionDto,
} from '@gusvoice/shared';

/**
 * Ставки на события (ГусКоины 2, этап 5) — чистые правила клиента: тексты отказов и причин отмены, отсчёт до закрытия,
 * доли вариантов, моя ставка и мой итог, черновик редактора (проверка по тем же границам, что сервер). Без React и стора —
 * их проверяет Codex отдельно от сцены (`components/Predictions.tsx`).
 */

/** Событие ещё идёт (приём ставок или ждём итога) — точка на кнопке «Активности» горит только для `open`. */
export function predictionLive(ev: Pick<PredictionEventDto, 'state'>): boolean {
  return ev.state === 'open' || ev.state === 'locked';
}

/** Есть событие, на которое можно ставить прямо сейчас — точка «идёт событие» на кнопке и плитке. */
export function predictionsOpen(events: readonly Pick<PredictionEventDto, 'state'>[] | undefined): boolean {
  return !!events?.some((e) => e.state === 'open');
}

/** До таймера закрытия, мс (по часам сервера: `skewMs` из `serverNow`); `null` — закрывается вручную или уже закрыто. */
export function predictionLeftMs(ev: Pick<PredictionEventDto, 'state' | 'lockAt'>, nowMs: number, skewMs: number): number | null {
  if (ev.state !== 'open' || !ev.lockAt) return null;
  const at = Date.parse(ev.lockAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - (nowMs + skewMs));
}

/** «4:05», «1:02:30», «2 дн 3 ч» — длинные таймеры (до недели) без секунд. */
export function predictionClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d} дн ${h} ч`;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Доля варианта в банке вопроса, целые проценты (пустой банк — 0 у всех). */
export function optionShare(pool: number, questionPool: number): number {
  if (!(questionPool > 0) || !(pool > 0)) return 0;
  return Math.round((pool / questionPool) * 100);
}

/** Моя ставка на вопрос: строка `bets` по моему id (в рассылке `mine` всегда null), иначе `mine` из снимка. */
export function myBetOf(q: Pick<PredictionQuestionDto, 'bets' | 'mine'>, meId: string | null | undefined): PredictionMyBetDto | null {
  const row = meId ? q.bets.find((b) => b.userId === meId) : undefined;
  if (row) return { optionId: row.optionId, amount: row.amount, payout: row.payout, refunded: row.refunded };
  return q.mine ?? null;
}

/**
 * Мой итог события: сколько поставил, сколько вернулось по угаданным вопросам (`won` — выплаты ВКЛЮЧАЯ ставку), сколько
 * вернули возвратом (вопрос не состоялся, никто не угадал, отмена). `hits` — угаданных вопросов.
 */
export function myEventResult(
  ev: Pick<PredictionEventDto, 'questions'>,
  meId: string | null | undefined,
): { staked: number; won: number; refunded: number; hits: number; bets: number } {
  let staked = 0;
  let won = 0;
  let refunded = 0;
  let hits = 0;
  let bets = 0;
  for (const q of ev.questions) {
    const b = myBetOf(q, meId);
    if (!b) continue;
    bets += 1;
    staked += b.amount;
    if (b.refunded) refunded += b.amount;
    else if (b.payout != null && b.payout > 0 && q.winnerOptionId === b.optionId) {
      won += b.payout;
      hits += 1;
    } else if (b.payout != null && b.payout > 0) refunded += b.payout;
  }
  return { staked, won, refunded, hits, bets };
}

/** Почему отменено — человеку. Неизвестная причина (новый сервер) — общий текст. */
export function cancelReasonText(reason: PredictionCancelReason | string | null | undefined): string {
  switch (reason) {
    case 'creator':
      return 'Создатель отменил событие — ставки вернулись';
    case 'moderator':
      return 'Событие отменил управляющий сервером — ставки вернулись';
    case 'expired':
      return 'Итог не подвели за неделю — ставки вернулись';
    case 'games-off':
      return 'На сервере выключили игры — ставки вернулись';
    case 'creator-deleted':
      return 'Создатель удалил аккаунт — ставки вернулись';
    default:
      return 'Событие отменено — ставки вернулись';
  }
}

/** Код отказа сервера — человеку. Неизвестный — `fallback`. */
export function predictionErrorText(code: string | undefined, fallback = 'Не получилось — попробуй ещё раз'): string {
  switch (code) {
    case 'not_in_voice':
      return 'Ставить можно, только сидя в голосе этого сервера';
    case 'games-off':
      return 'Игры на этом сервере выключены';
    case 'forbidden':
      return 'Нужно право управлять экономикой сервера';
    case 'creator':
      return 'Создатель события не ставит — итог подводит он';
    case 'not_creator':
      return 'Итог подводит только создатель события';
    case 'bot':
      return 'Боты не играют';
    case 'opted-out':
      return 'Ты не участвуешь в экономике — включи её в настройках сервера';
    case 'games-opted-out':
      return 'Игры у тебя выключены — включи их в кошельке';
    case 'not_found':
      return 'Этого события уже нет';
    case 'already_bet':
    case 'duplicate':
      return 'На этот вопрос ты уже поставил — ставка окончательная';
    case 'not_open':
    case 'round-closed':
      return 'Приём ставок уже закрыт';
    case 'not_locked':
      return 'Сначала закрой приём ставок';
    case 'finished':
      return 'Событие уже закончилось';
    case 'too_many':
      return 'На сервере уже идут три события — дождись итога одного из них';
    case 'poor':
      return 'Не хватает монет';
    case 'loss-limit':
      return 'На сегодня предел проигрыша исчерпан — завтра снова';
    case 'over-bet-max':
      return 'Ставка больше, чем можно на этом сервере';
    case 'bad-amount':
      return 'Ставка — целое число монет, от одной';
    case 'bad-pick':
      return 'Такого варианта нет';
    case 'bad_draft':
      return 'Проверь событие: название, вопросы и варианты';
    case 'bad_winners':
      return 'Укажи исход каждого вопроса';
    case 'busy':
      return 'Уже отправляется — секунду';
    default:
      return fallback;
  }
}

/** Таймер закрытия в редакторе: секунды или `null` — «закрою вручную». */
export const LOCK_CHOICES: readonly { sec: number | null; label: string }[] = [
  { sec: null, label: 'Вручную' },
  { sec: 60, label: '1 мин' },
  { sec: 5 * 60, label: '5 мин' },
  { sec: 15 * 60, label: '15 мин' },
  { sec: 30 * 60, label: '30 мин' },
  { sec: 60 * 60, label: '1 ч' },
];

export interface PredictionDraftState {
  title: string;
  lockInSec: number | null;
  questions: { question: string; options: string[] }[];
}

export function emptyQuestion(): { question: string; options: string[] } {
  return { question: '', options: ['', ''] };
}

export function emptyDraft(): PredictionDraftState {
  return { title: '', lockInSec: 5 * 60, questions: [emptyQuestion()] };
}

/** Схлопнуть пробелы и обрезать края — как сервер (`cleanPredictionText`) для проверки длины и повторов. */
function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Первая ошибка черновика в формате поля сервера (`title|lock|questions|qN|qN.options|qN.oM`, N и M с нуля) или `null` —
 * можно отправлять. Те же границы, что у `validatePredictionDraft` на сервере: сервер всё равно проверит, а здесь —
 * чтобы кнопка «Создать» не отправляла заведомо пустое.
 */
export function draftProblem(d: PredictionDraftState): string | null {
  const title = clean(d.title);
  if (title.length === 0 || title.length > PREDICTION_TITLE_MAX) return 'title';
  if (d.lockInSec !== null && (!Number.isInteger(d.lockInSec) || d.lockInSec < PREDICTION_LOCK_MIN_SEC || d.lockInSec > PREDICTION_LOCK_MAX_SEC)) return 'lock';
  if (d.questions.length === 0 || d.questions.length > PREDICTION_MAX_QUESTIONS) return 'questions';
  for (let n = 0; n < d.questions.length; n++) {
    const q = d.questions[n];
    const question = clean(q.question);
    if (question.length === 0 || question.length > PREDICTION_QUESTION_MAX) return `q${n}`;
    if (q.options.length < PREDICTION_MIN_OPTIONS || q.options.length > PREDICTION_MAX_OPTIONS) return `q${n}.options`;
    const seen = new Set<string>();
    for (let m = 0; m < q.options.length; m++) {
      const label = clean(q.options[m]);
      if (label.length === 0 || label.length > PREDICTION_OPTION_MAX) return `q${n}.o${m}`;
      const key = label.toLocaleLowerCase('ru');
      if (seen.has(key)) return `q${n}.o${m}`;
      seen.add(key);
    }
  }
  return null;
}

/** Текст ошибки поля редактора (номера — человеческие, с единицы). */
export function draftFieldText(field: string | null | undefined, d?: PredictionDraftState): string | null {
  if (!field) return null;
  if (field === 'title') return `Назови событие — до ${PREDICTION_TITLE_MAX} знаков`;
  if (field === 'lock') return 'Таймер закрытия — от 30 секунд до недели';
  if (field === 'questions') return `Нужен хотя бы один вопрос, не больше ${PREDICTION_MAX_QUESTIONS}`;
  const m = /^q(\d+)(?:\.(options|o(\d+)))?$/.exec(field);
  if (!m) return 'Проверь событие: название, вопросы и варианты';
  const n = Number(m[1]) + 1;
  if (!m[2]) return `Вопрос ${n}: напиши сам вопрос — до ${PREDICTION_QUESTION_MAX} знаков`;
  if (m[2] === 'options') return `Вопрос ${n}: вариантов от ${PREDICTION_MIN_OPTIONS} до ${PREDICTION_MAX_OPTIONS}`;
  const o = Number(m[3]);
  const label = d ? clean(d.questions[Number(m[1])]?.options[o] ?? '') : '';
  return label ? `Вопрос ${n}, вариант ${o + 1}: такой уже есть или слишком длинный` : `Вопрос ${n}, вариант ${o + 1}: пустой`;
}

/** Тело `POST /servers/:id/predictions` из черновика (пробелы схлопнуты). */
export function draftBody(d: PredictionDraftState): { title: string; lockInSec: number | null; questions: { question: string; options: string[] }[] } {
  return {
    title: clean(d.title),
    lockInSec: d.lockInSec,
    questions: d.questions.map((q) => ({ question: clean(q.question), options: q.options.map(clean) })),
  };
}
