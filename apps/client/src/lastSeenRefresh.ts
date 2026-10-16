/**
 * Перезапрос «был(а) в сети» (Э7 ч.3, D; замечание живой проверки 12.10: «был(а) 13 минут назад» при реальных трёх).
 * Хук `useLastSeen` спрашивал сервер только при показе и при смене «в сети» собеседника; пока вкладка спала или шлюз
 * был оборван, событий о нём не было, и текст «был(а) N минут назад» отставал. Как у Telegram (возврат приложения на
 * передний план и возвращение сети обновляют статусы): возврат во вкладку (`visibilitychange` → видимая) и возвращение
 * шлюза на связь (`connState.onConnChange` → `online`) поднимают счётчик `lastSeenEpoch` в сторе — его читают ТОЛЬКО
 * смонтированные `useLastSeen` (открытая шапка / профиль) и перезапрашивают себя; невидимые хуки не спрашивают.
 * Дедупликация: не чаще раза в `REFRESH_MIN_GAP_MS` (возврат во вкладку и переподключение приходят вместе).
 */
import { onConnChange } from './connState';
import { useStore } from './store';

/** Минимальный промежуток между двумя перезапросами. */
export const REFRESH_MIN_GAP_MS = 5000;

/** Чистое правило: пора ли поднимать счётчик (прошло ли достаточно с прошлого раза). */
export function shouldRefreshLastSeen(now: number, last: number | null, gapMs: number = REFRESH_MIN_GAP_MS): boolean {
  return last === null || now - last >= gapMs;
}

let started = false;
let last: number | null = null;

/** Поднять счётчик перезапроса (с дедупликацией). Возвращает, поднят ли. */
export function bumpLastSeenEpoch(now: number = Date.now()): boolean {
  if (!shouldRefreshLastSeen(now, last)) return false;
  last = now;
  useStore.setState((s) => ({ lastSeenEpoch: (s.lastSeenEpoch ?? 0) + 1 }));
  return true;
}

/** Подключить (`main.tsx`): возврат во вкладку и шлюз снова на связи. Повторный вызов — пусто. */
export function startLastSeenRefresh(): void {
  if (started) return;
  started = true;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') bumpLastSeenEpoch();
    });
  }
  onConnChange((state) => {
    if (state === 'online') bumpLastSeenEpoch();
  });
}
