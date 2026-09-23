/**
 * Расписание синхронизации каталога (#139, F2, план §5.4) — чистые правила «что пора делать».
 *
 * Обмен держится на трёх слоях, и каждый закрывает дыру предыдущего:
 *  - **событие** прилетает сразу, но может не доехать (сосед лежал, очередь выбросила протухшее);
 *  - **дельта раз в 15 минут** добирает пропущенное, но не ловит то, о чём мы никогда не слышали —
 *    например, удаление, случившееся, пока связка была на паузе;
 *  - 🔴 **полная сверка раз в сутки** ловит именно это: расхождение, которого не видно ни по одному
 *    отдельному событию. Без неё кеш соседа тихо разъезжается с правдой и никогда не сходится.
 *
 * Часы приходят параметром: «раз в сутки ночью» иначе нельзя проверить, не дождавшись ночи.
 */

export const DELTA_INTERVAL_MS = 15 * 60_000;
export const FULL_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Окно для полной сверки — ночь по часам инстанса: она тяжелее дельты и людям в это время не мешает.
 * Границы включительно-исключительно: 2, 3, 4 часа ночи.
 */
export const NIGHT_FROM_HOUR = 2;
export const NIGHT_TO_HOUR = 5;

/**
 * 🔴 Сколько ждём НОЧИ, прежде чем сверить днём.
 *
 * Без этого правила инстанс, который по ночам выключен (домашний сервер, ноутбук), не сверился бы
 * НИ РАЗУ: условие «сутки прошли И сейчас ночь» у него не выполняется никогда. Пропустили окно —
 * сверяемся когда получится.
 */
export const MISSED_NIGHT_GRACE_MS = 8 * 60 * 60_000;

/** Потолок отступления при недоступном соседе: дальше растить бессмысленно, это уже «раз в смену». */
export const SYNC_BACKOFF_MAX_MS = 4 * 60 * 60_000;

export interface SyncState {
  /** Когда дельта в последний раз прошла УДАЧНО (мс эпохи). `null` — ни разу. */
  lastDeltaAt: number | null;
  /** Когда удачно прошла полная сверка. `null` — ни разу. */
  lastFullAt: number | null;
  /** Сколько попыток подряд не удались: по ним считается отступление. */
  failures: number;
  /**
   * Затребована внеочередная полная сверка: пропуск в номерах событий, неразобранный ответ,
   * возобновление связки после паузы. Сбрасывается удачной сверкой.
   */
  needsFull: boolean;
}

export type SyncPlan = 'full' | 'delta' | 'idle';

/** Отступление после неудач: первая — по обычному расписанию, дальше вдвое, до потолка. */
export function syncBackoffMs(failures: number): number {
  if (failures <= 1) return DELTA_INTERVAL_MS;
  return Math.min(DELTA_INTERVAL_MS * 2 ** (failures - 1), SYNC_BACKOFF_MAX_MS);
}

export function isNight(hour: number): boolean {
  return hour >= NIGHT_FROM_HOUR && hour < NIGHT_TO_HOUR;
}

/**
 * Что делать со связкой прямо сейчас.
 *
 * ⚠️ Порядок проверок важен: полная сверка ПЕРЕД дельтой. Иначе связка, которой нужна сверка, вечно
 * обновлялась бы дельтами (они дешевле и подходят чаще) и расхождение так и жило бы в кеше.
 */
export function planSync(state: SyncState, now: number, hour: number): SyncPlan {
  // Ни разу не синхронизировались или сами попросили сверку — сверяемся, не дожидаясь ночи.
  if (state.lastFullAt === null || state.needsFull) {
    return dueAfterFailures(state, now, state.lastFullAt) ? 'full' : 'idle';
  }

  const sinceFull = now - state.lastFullAt;
  if (sinceFull >= FULL_INTERVAL_MS && (isNight(hour) || sinceFull >= FULL_INTERVAL_MS + MISSED_NIGHT_GRACE_MS)) {
    return dueAfterFailures(state, now, state.lastFullAt) ? 'full' : 'idle';
  }

  const sinceDelta = state.lastDeltaAt === null ? Number.POSITIVE_INFINITY : now - state.lastDeltaAt;
  if (sinceDelta >= DELTA_INTERVAL_MS) {
    return dueAfterFailures(state, now, state.lastDeltaAt) ? 'delta' : 'idle';
  }
  return 'idle';
}

/**
 * Не частим ли мы с недоступным соседом.
 *
 * ⚠️ Отсчёт идёт от последней УДАЧИ, а не от последней попытки: попытки мы не записываем в базу
 * (лишняя запись на каждый круг), а от удачи считается ровно то, что нужно — «сколько он уже лежит».
 */
function dueAfterFailures(state: SyncState, now: number, lastOkAt: number | null): boolean {
  if (state.failures === 0 || lastOkAt === null) return true;
  return now - lastOkAt >= syncBackoffMs(state.failures);
}

/**
 * Как показать держателю свежесть кеша: «обновлено N назад» (план §5.4).
 *
 * Словами, а не меткой времени: держателю важно «минуту назад или вчера», а не «14:02».
 */
export function freshnessText(lastOkAt: number | null, now: number): string {
  if (lastOkAt === null) return 'ещё не синхронизировано';
  const ms = Math.max(0, now - lastOkAt);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'обновлено только что';
  if (minutes < 60) return `обновлено ${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `обновлено ${hours} ч назад`;
  return `обновлено ${Math.floor(hours / 24)} сут назад`;
}
