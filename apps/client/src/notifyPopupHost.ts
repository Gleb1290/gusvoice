/**
 * Свои всплывающие уведомления на ПК (G38, ND-07) — сторона ГЛАВНОГО окна. Ставит приёмник в `notifications.ts`
 * (`setNotifyPopupSink`): уведомление, прошедшее все прежние гейты, уходит карточкой в окно `notify`
 * (`gv_notify_popup_push` → событие `gv-notify-popup` → `NotifyPopups.tsx`). Включены системные уведомления
 * (`notifyPopupPrefs.native`) — приёмник отказывается, и показ идёт прежним путём (тост Windows).
 * Только десктоп: в вебе и на Android приёмника нет — поведение прежнее.
 */
import { isDesktop } from './hotkeys';
import { setNotifyPopupSink } from './notifications';
import { getNotifyPopupPrefs, onNotifyPopupPrefs, type NotifyPopupPrefs } from './notifyPopupPrefs';
import type { PopupCorner, PopupNotice } from './notifyPopupRules';

/** Сообщение главного окна окну уведомлений (событие `gv-notify-popup`). */
export type PopupMessage =
  | { kind: 'show'; notice: PopupNotice; corner: PopupCorner; max: number; monitor: string }
  | { kind: 'clear'; group: string }
  | { kind: 'prefs'; corner: PopupCorner; max: number; monitor: string; native: boolean };

type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };

function core(): TauriCore | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core ?? null;
}

let started = false;
let seq = 0;

export function initNotifyPopups(): void {
  if (started || !isDesktop()) return;
  const c = core();
  if (!c) return;
  started = true;
  const push = (payload: PopupMessage) => c.invoke('gv_notify_popup_push', { payload });
  setNotifyPopupSink({
    show(d) {
      const p = getNotifyPopupPrefs();
      if (p.native) return false;
      const notice: PopupNotice = {
        id: `p${++seq}-${Date.now()}`,
        tag: d.tag,
        title: d.title,
        author: d.author,
        body: d.body,
        // Вид вложения в начале строки (`notifications.popupPreview`) — только когда есть: старое окно поля не знает и не ждёт.
        ...(d.kind ? { kind: d.kind } : {}),
        avatar: d.avatar,
        conv: d.conv,
        group: d.group,
      };
      push({ kind: 'show', notice, corner: p.corner, max: p.count, monitor: p.monitor }).catch(d.fallback);
      return true;
    },
    clear(group) {
      if (getNotifyPopupPrefs().native) return;
      push({ kind: 'clear', group }).catch(() => {});
    },
  });
  // Сменили угол, число или монитор — стопка перекладывается сразу; включили системные — карточки уходят.
  onNotifyPopupPrefs((p: NotifyPopupPrefs) => {
    push({ kind: 'prefs', corner: p.corner, max: p.count, monitor: p.monitor, native: p.native }).catch(() => {});
  });
}

/** Имена мониторов для выбора в настройках (`gv_notify_popup_monitors`); не десктоп или сборка без команды — пусто. */
export async function notifyPopupMonitors(): Promise<string[]> {
  const c = isDesktop() ? core() : null;
  if (!c) return [];
  try {
    const v = await c.invoke('gv_notify_popup_monitors');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
