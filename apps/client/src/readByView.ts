/**
 * «Прочитано» по ВИДИМОМУ, а не по загруженному (ЛС, G09 плейбука 14; ресерч Telegram 03·3.8.1–3.8.3, 03·3.10, Н11).
 *
 * 🔴 Было: беседа отмечалась прочитанной до ПОСЛЕДНЕГО ЗАГРУЖЕННОГО сообщения — при самом открытии (`useChannelVisit`),
 * на каждое входящее при открытой беседе и при уходе. Человек открыл беседу у черты «Новые сообщения» — собеседник уже
 * видел ✓✓ на тридцати письмах, из которых на экране было четыре; открыл окно настроек поверх беседы — входящее всё равно
 * «читалось». Стало как у Telegram: лента сама сообщает последнее сообщение, НИЖНИЙ край которого попал в её окно
 * (`lastSeenIndex`), и только когда человек действительно смотрит (`canMarkRead`): окно в фокусе и вкладка видна, поверх
 * нет слоя (`feedCovered`), на ПК нет простоя дольше `READ_IDLE_MS`. Отметка уходит на сервер пакетом (`convSyncRules.seenFlushDelay`):
 * сразу, если дочитали до последнего сообщения беседы, иначе через `convSyncRules.READ_BATCH_MS` (срок не продлевается).
 *
 * Чистые правила — сверху (их проверяют тесты); DOM — `feedCovered`, учёт простоя и шина «в конец» внизу, без обращения к
 * `document`/`window` при загрузке модуля (его грузят харнессы тестов в Node).
 */

/** Простой (ПК): нет ввода дольше — не читаем, пока человек не вернётся (Telegram ПК: `offlineIdleTimeout` = 30 с). */
export const READ_IDLE_MS = 30_000;
/**
 * Слои, под которыми лента не читается: окна (`aria-modal` — настройки, пересылка, подтверждения), подложки окон, просмотр
 * фото/видео, нижние шторки телефона. Меню (`.ctx-menu`, `.dd-pop`) — НЕ слой: у Telegram меню прочтение не останавливает.
 */
export const READ_LAYERS = '[aria-modal="true"], .modal-overlay, .confirm-overlay, .lightbox, .sheet';

export interface ReadGate {
  /** Окно в фокусе и вкладка видна (`notifications.windowFocused`). */
  focused: boolean;
  /** Поверх ленты открыт слой (`feedCovered`). */
  covered: boolean;
  /** Сколько миллисекунд не было ввода. */
  idleMs: number;
  /** Телефон: простой не считается (у Telegram Android его нет — экран погаснет сам). */
  mobile: boolean;
}

/** Можно ли сейчас считать видимое прочитанным. */
export function canMarkRead(g: ReadGate): boolean {
  return g.focused && !g.covered && (g.mobile || g.idleMs < READ_IDLE_MS);
}

/**
 * Индекс последней строки, чей НИЖНИЙ край в окне ленты (`viewTop < низ ≤ viewBottom`), — двоичный поиск: строки идут
 * сверху вниз, низ растёт. `-1` — такой нет (лента пуста или одна высокая строка закрывает всё окно — как у Telegram ПК,
 * она прочтётся, когда покажется её низ). `bottomAt(i)` — низ строки в тех же координатах, что и края окна.
 */
export function lastSeenIndex(count: number, bottomAt: (i: number) => number, viewTop: number, viewBottom: number): number {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bottomAt(mid) <= viewBottom + 1) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && bottomAt(found) > viewTop ? found : -1;
}

// ─── DOM ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Открыт ли поверх ленты слой (`READ_LAYERS`). */
export function feedCovered(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector(READ_LAYERS);
}

let lastInput = 0;
let watching = false;
const wakers = new Set<() => void>();

/** Сколько миллисекунд не было ввода (учёт начинается с первого `watchReadActivity`). */
export function idleMs(now = Date.now()): number {
  return lastInput === 0 ? 0 : now - lastInput;
}

/**
 * Учёт ввода для простоя (ПК) + «разбудить» ленту, когда человек вернулся после простоя: увиденное за время простоя не
 * читалось, теперь его надо посмотреть заново. Возвращает отписку. Закрытие слоя лента ловит сама (проверкой, пока он
 * открыт), возврат в окно — событиями `focus`/`visibilitychange`.
 */
export function watchReadActivity(onWake: () => void): () => void {
  wakers.add(onWake);
  if (!watching && typeof window !== 'undefined') {
    watching = true;
    lastInput = Date.now();
    const seen = () => {
      const wasIdle = idleMs() >= READ_IDLE_MS;
      lastInput = Date.now();
      if (wasIdle) for (const w of wakers) w();
    };
    for (const t of ['pointermove', 'pointerdown', 'wheel', 'touchstart', 'keydown'] as const)
      window.addEventListener(t, seen, { capture: true, passive: true });
  }
  return () => {
    wakers.delete(onWake);
  };
}
