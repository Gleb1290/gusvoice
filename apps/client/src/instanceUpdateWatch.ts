import type { InstanceUpdateStatus } from '@gusvoice/shared';

/**
 * Ждать ли ещё конца обновления инстанса, начатого кнопкой в панели (О2б). Чистое правило — просьба Codex после
 * находки при проверке.
 *
 * 🔴 Смысл `baseline` (время начала ПРЕДЫДУЩЕГО, уже законченного обновления): между «хост забрал запрос» и «хост
 * записал новый статус» есть окно, в котором запроса уже нет, а в статусе лежит прошлый итог. Без сверки времени
 * страница показала бы прошлое «Обновлено» результатом нового нажатия.
 */
export type UpdateWatchOutcome = 'wait' | 'done' | 'failed';

export function updateWatchOutcome(input: {
  /** `startedAt` статуса на момент начала ожидания; null — статуса не было или он шёл. */
  baseline: string | null;
  status: InstanceUpdateStatus | null;
  requestPending: boolean;
}): UpdateWatchOutcome {
  if (input.requestPending) return 'wait';
  const s = input.status;
  if (!s || s.state === 'running') return 'wait';
  if (s.startedAt === input.baseline) return 'wait'; // итог ещё не наш — статус прошлого обновления
  return s.state === 'done' ? 'done' : 'failed';
}
