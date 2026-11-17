import type { RecapKind } from '@gusvoice/shared';
import { api } from './api';
import { isMockEconomy, mockGameTitles, mockRecap } from './benchMock';
import { useStore } from './store';

/**
 * Звания месяца и «Итоги» (ГусКоины 2, этап 6) — загрузка в стор (`gameTitles[serverId]`, `recaps[serverId]`).
 *
 * Звания меняются раз в месяц, «Итоги» — раз в месяц/сезон: опрос не нужен, перечитываем не чаще `STALE_MS` (открытие
 * кошелька, карточки человека, смена сервера). Провал молчит: это украшение, а не данные, без которых нельзя.
 * Стенд с макетом экономики (`benchMock`) получает макеты — маршрутов там нет.
 */

const STALE_MS = 10 * 60_000;
const titlesAt = new Map<string, number>();
const recapsAt = new Map<string, number>();


/** Звания сервера: 27 штук с названиями и носителями прошлого месяца. */
export function ensureGameTitles(serverId: string | null | undefined, force = false): void {
  if (!serverId) return;
  // Смена инстанса чистит срез в сторе — тогда перечитываем, даже если отметка времени свежая.
  const at = titlesAt.get(serverId);
  if (!force && at && Date.now() - at < STALE_MS && useStore.getState().gameTitles[serverId]) return;
  titlesAt.set(serverId, Date.now());
  if (isMockEconomy()) {
    useStore.getState().setGameTitles(serverId, mockGameTitles(useStore.getState().user?.id ?? 'me'));
    return;
  }
  api
    .getGameTitles(serverId)
    .then((dto) => useStore.getState().setGameTitles(serverId, dto))
    .catch(() => titlesAt.delete(serverId));
}

/** Последние замороженные «Итоги» обоих видов — для авто-показа и кнопки «Итоги». */
export function ensureRecaps(serverId: string | null | undefined, force = false): void {
  if (!serverId) return;
  const at = recapsAt.get(serverId);
  if (!force && at && Date.now() - at < STALE_MS && useStore.getState().recaps[serverId]) return;
  recapsAt.set(serverId, Date.now());
  const meId = useStore.getState().user?.id ?? 'me';
  (['economy', 'games'] as RecapKind[]).forEach((kind) => {
    if (isMockEconomy()) {
      useStore.getState().setRecap(serverId, kind, mockRecap(kind, meId, false));
      return;
    }
    api
      .getRecap(serverId, kind)
      .then((r) => useStore.getState().setRecap(serverId, kind, r.recap))
      .catch(() => useStore.getState().setRecap(serverId, kind, null));
  });
}

/** `localStorage` для отметок «Итоги видел»; недоступно (приватный режим, запрет) — `null`. */
export function recapStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
