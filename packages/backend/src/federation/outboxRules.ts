/**
 * Правила очереди исходящих событий (#139 F1, #148) — без базы и сети.
 *
 * Очередь нужна потому, что сосед бывает недоступен: перезагружается, обновляется, у него моргнула
 * сеть. Без очереди событие в этот момент теряется навсегда, и состояния двух инстансов расходятся
 * молча — а это худший вид расхождения, потому что никто о нём не узнает.
 */

/** Сколько раз пробуем доставить, прежде чем признать событие потерянным. */
export const OUTBOX_MAX_ATTEMPTS = 12;

/** Сколько событие вообще имеет право лежать в очереди. */
export const OUTBOX_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Когда пробовать снова. Задержка растёт вдвое с каждой неудачей и упирается в потолок.
 *
 * 🔴 Растущая задержка здесь не про вежливость, а про нас самих: лежачий сосед иначе собирал бы на
 * себя каждый проход очереди, и события к ЖИВЫМ соседям ждали бы в очереди за ним.
 */
export function nextAttemptDelayMs(attempts: number): number {
  const base = 10_000; // первая повторная попытка — через десять секунд
  const capped = Math.min(attempts, 8); // 2^8 * 10с ≈ 42 минуты, дальше не растим
  return base * 2 ** capped;
}

export type DropReason = 'too-many-attempts' | 'too-old';

/**
 * Пора ли выбросить событие из очереди.
 *
 * ⚠️ Выбрасываем молча только в лог, а не «доставляем как-нибудь»: событие, пролежавшее трое суток,
 * почти наверняка уже неактуально, а доставленное вне очереди оно сломало бы порядок номеров у
 * соседа (см. `docs/codemap/server.md`, дедуп по номеру).
 */
export function dropReason(
  event: { attempts: number; createdAt: number },
  now: number,
): DropReason | null {
  if (event.attempts >= OUTBOX_MAX_ATTEMPTS) return 'too-many-attempts';
  if (now - event.createdAt >= OUTBOX_MAX_AGE_MS) return 'too-old';
  return null;
}

/**
 * Что делать с очередью этой связки прямо сейчас.
 *
 * `hold` — не трогать: связка не в том состоянии, чтобы слать (пауза, разрыв, потеря доверия).
 * Различать важно: в паузе события КОПЯТСЯ и уедут после снятия, а при разрыве очередь чистится.
 */
export type QueueAction = 'deliver' | 'hold' | 'discard';

export function queueAction(state: string): QueueAction {
  switch (state) {
    case 'active':
      return 'deliver';
    case 'paused':
      return 'hold';
    default:
      // requested / pending — связка ещё не рабочая, но вот-вот станет: держим.
      // blocked / trust-lost — отправлять больше некому и незачем.
      return state === 'requested' || state === 'pending' ? 'hold' : 'discard';
  }
}
