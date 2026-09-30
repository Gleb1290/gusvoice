import type { CoinNotifyLevel } from './coinNotifyRules';
import { isDesktop, isTauri } from './hotkeys';
import type { OsNotifyLevel } from './notifyRules';

// OS-level notifications: the web Notification API in browsers, the Tauri notification plugin
// in the desktop app (rides the NEXT release tag — older .exe builds silently skip). Fired only
// for events that already passed the sound/DND gates in sockets.ts, and only while the window
// is unfocused — the in-app UI covers the focused case. Enabled per-browser via `gv_os_notify`.

const KEY = 'gv_notify_clickable';

/** Заводской уровень — «упоминания и ЛС» (см. пояснение ниже). */
export const OS_NOTIFY_DEFAULT: OsNotifyLevel = 'mentions';

/**
 * Уровень системных уведомлений (#77). Раньше это был булев тумблер, и «включено» означало
 * «упоминания и ЛС» — обычные сообщения канала не уведомляли вообще.
 *
 * ⚠️ Ключ хранилища ТОТ ЖЕ: у кого стояло `'1'`, читается как `'mentions'` — то есть настройка
 * человека не сбрасывается и поведение у него не меняется, пока он сам не выберет «все».
 */
export function osNotifyLevel(): OsNotifyLevel {
  const raw = localStorage.getItem(KEY);
  if (raw === 'off' || raw === 'mentions' || raw === 'all') return raw;
  // Ключа нет — человек НИКОГДА не открывал эту настройку. Раньше это значило «выключено», и
  // получалось, что уведомлений нет ни у кого, кто про настройку не знал: фича есть, а мессенджер
  // молчит, и выглядит это сломанной фичей, а не выбором. Умолчание — «упоминания и ЛС»:
  // так ведёт себя любой мессенджер, и оно не спамит. «Все сообщения» и «выключить» — в настройках.
  return OS_NOTIFY_DEFAULT;
}

export function setOsNotifyLevel(level: OsNotifyLevel): void {
  localStorage.setItem(KEY, level);
}

const COIN_KEY = 'gv_coin_notify';

/** Заводской уровень монетных уведомлений — «когда типают/щипают меня». */
export const COIN_NOTIFY_DEFAULT: CoinNotifyLevel = 'mine';

/**
 * Уровень уведомлений про монеты — СВОЙ, независимый от уведомлений о сообщениях (запрос
 * 04.09). Умолчание «когда типают/щипают меня»: адресное событие редкое и его пропуск обиден, а
 * чужую ленту человек включает сам, если хочет.
 */
export function coinNotifyLevel(): CoinNotifyLevel {
  const raw = localStorage.getItem(COIN_KEY);
  if (raw === 'off' || raw === 'mine' || raw === 'all') return raw;
  return COIN_NOTIFY_DEFAULT;
}

export function setCoinNotifyLevel(level: CoinNotifyLevel): void {
  localStorage.setItem(COIN_KEY, level);
}

export function osNotifyEnabled(): boolean {
  return osNotifyLevel() !== 'off';
}

/**
 * Разрешение у ОС спрашивали только при ручном включении тумблера. С умолчанием «упоминания и ЛС»
 * его больше некому спросить — делаем это на старте ДЕСКТОПА (там диалога либо нет, либо он один
 * раз). В браузере молчим: незапрошенный `Notification.requestPermission()` без жеста пользователя
 * браузеры и режут, и штрафуют — там разрешение по-прежнему спрашивает сама настройка.
 */
export function ensureNotifyPermission(): void {
  if (!isTauri() || osNotifyLevel() === 'off') return;
  void requestNotifyPermission().catch(() => {});
}

export type NotifyPermission = 'granted' | 'denied' | 'unsupported';

/**
 * Текущее разрешение БЕЗ запроса — чтобы настройки могли честно показать состояние.
 *
 * 🔴 Раньше состояние нигде не показывалось, и отказ системы выглядел как сломанные кнопки: человек
 * жмёт «когда меня», выбор молча откатывается на «выключены», и кажется, что кнопка не нажимается
 * (замечание 04.09). Показать «разрешение не дано» и дать кнопку — половина решения; вторая
 * половина в том, чтобы выбор ПРИ ЭТОМ СОХРАНЯЛСЯ.
 * ⚠️ В Tauri ответ асинхронный, в браузере — синхронный; наружу отдаём одинаково.
 */
export async function notifyPermissionState(): Promise<NotifyPermission> {
  if (isTauri()) {
    try {
      const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
      return (await isPermissionGranted()) ? 'granted' : 'denied';
    } catch {
      return 'unsupported';
    }
  }
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  // 'default' — ещё не спрашивали: для интерфейса это «не дано», но запрос ещё возможен.
  return 'denied';
}

/** Ask the platform for permission (called when the settings toggle flips on). */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (isTauri()) {
    try {
      const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
      if (await isPermissionGranted()) return 'granted';
      return (await requestPermission()) === 'granted' ? 'granted' : 'denied';
    } catch {
      return 'unsupported'; // pre-notification desktop build — the plugin isn't in this .exe yet
    }
  }
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return (await Notification.requestPermission()) === 'granted' ? 'granted' : 'denied';
}

/**
 * True while the user is actually looking at the app — then we stay silent.
 * Экспортируется, чтобы решение «уведомлять или нет» целиком считалось чистым `notifyRules.ts`,
 * а не разъезжалось между вызывающим и этим модулем.
 */
export function windowFocused(): boolean {
  return document.hasFocus() && document.visibilityState === 'visible';
}

/**
 * Show an OS notification if enabled + permitted + the window is unfocused (`force` skips the
 * focus gate — used by the settings "Проверить" button). `onClick` (web only) runs after the
 * window is focused — e.g. open the mentioning channel. Never throws into the message path.
 */
export function osNotify(title: string, body: string, onClick?: () => void, force = false): void {
  if (!osNotifyEnabled() || (!force && windowFocused())) return;
  deliver(title, body, onClick);
}

/**
 * Показать всплывашку БЕЗ гейтов этого модуля — решение принято снаружи.
 *
 * ⚠️ Нужен монетам: их гейт свой (`coinNotifyRules`), и проверка `osNotifyEnabled()` тут означала
 * бы, что выключивший уведомления о сообщениях молча теряет и уведомления о монетах, хотя это
 * разные настройки. Фокус и «не беспокоить» вызывающий обязан проверить сам.
 */
export function osNotifyRaw(title: string, body: string, onClick?: () => void): void {
  deliver(title, body, onClick);
}

type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
type TauriEvent = {
  listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
};
function tauriGlobal(): { core?: TauriCore; event?: TauriEvent } | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore; event?: TauriEvent } }).__TAURI__ ?? null;
}

/**
 * Клик по системному тосту в десктопе (#212, Б11).
 *
 * 🔴 Плагин уведомлений на десктопе клик не отдаёт, поэтому `onClick` в Tauri раньше просто
 * игнорировался: клик по уведомлению ЛС поднимал окно, но не открывал беседу. Теперь тост с
 * `onClick` показывает своя команда `gv_notify_clickable` (`os_notify.rs`) и на клик шлёт
 * `gv://notify-click` с меткой; метка → обработчик. Держим последние 50 — тосты старше давно ушли.
 */
const clickHandlers = new Map<string, () => void>();
let clickSeq = 0;
let clickListening = false;
function listenNotifyClicks(ev: TauriEvent): void {
  if (clickListening) return;
  clickListening = true;
  void ev.listen('gv://notify-click', (e) => {
    const tag = typeof e.payload === 'string' ? e.payload : '';
    const fn = clickHandlers.get(tag);
    clickHandlers.delete(tag);
    fn?.();
  });
}

function deliver(title: string, body: string, onClick?: () => void): void {
  if (isTauri()) {
    const t = tauriGlobal();
    if (onClick && isDesktop() && t?.core && t.event) {
      listenNotifyClicks(t.event);
      const tag = `n${++clickSeq}`;
      clickHandlers.set(tag, onClick);
      if (clickHandlers.size > 50) clickHandlers.delete(clickHandlers.keys().next().value as string);
      void t.core.invoke('gv_notify_clickable', { title, body, tag }).catch(() => {
        // Сборка без команды — показываем тостом плагина, как раньше (без клика).
        clickHandlers.delete(tag);
        deliverViaPlugin(title, body);
      });
      return;
    }
    deliverViaPlugin(title, body);
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch {
    /* some WebViews throw on construction — never break the message path */
  }
}

function deliverViaPlugin(title: string, body: string): void {
  void (async () => {
    try {
      const { isPermissionGranted, sendNotification } = await import('@tauri-apps/plugin-notification');
      if (await isPermissionGranted()) sendNotification({ title, body });
    } catch {
      /* plugin absent in this build — skip */
    }
  })();
}

/** «Имя» for a message author DTO (display name over the handle). */
export function authorName(m: { author: { username: string; displayName?: string | null } }): string {
  return m.author.displayName || m.author.username;
}

/** Short notification body for a message: trimmed text or an attachment marker. */
export function messagePreview(m: { content: string; attachments?: unknown[] | null }): string {
  const text = m.content?.trim();
  if (text) return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  return m.attachments?.length ? '📎 Вложение' : 'Новое сообщение';
}
