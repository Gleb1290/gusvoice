import { create } from 'zustand';

import { fedCallText, fedDmOpenText, fedErrorText, isFedErrorCode } from './fedErrorText';
import { humanLengthError } from './longTextRules';

export type ToastType = 'success' | 'info' | 'warn' | 'error';

export interface Toast {
  id: number;
  type: ToastType;
  title: string;
  subtitle?: string;
  /** When true, ToastHost never auto-dismisses this toast — it stays until the user clicks ✕.
   *  Use for low-frequency, must-not-miss heads-ups (e.g. "обновлён до vX"). Still non-blocking. */
  sticky?: boolean;
  /** Кнопка справа в тосте («Отмена» у «Чат в архиве»): щелчок закрывает тост и зовёт `onClick`. Добавлено 07.10 (G41). */
  action?: { label: string; onClick: () => void };
  /** Сколько тост висит, мс (по умолчанию 3,8 с; тост с кнопкой — дольше, чтобы успеть нажать). */
  durationMs?: number;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id'>) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Fire a toast from anywhere (component or not). Pass `{ sticky: true }` for a toast that stays
 *  until the user closes it. Returns the toast id (for programmatic dismiss). */
export function toast(
  type: ToastType,
  title: string,
  subtitle?: string,
  opts?: { sticky?: boolean; action?: Toast['action']; durationMs?: number },
): number {
  return useToasts.getState().push({ type, title, subtitle, sticky: opts?.sticky, action: opts?.action, durationMs: opts?.durationMs });
}

/** Поменять текст уже показанного тоста (проценты у «Упаковываю…», `folderZip.ts`); тоста нет — ничего. */
export function updateToast(id: number, patch: Partial<Pick<Toast, 'title' | 'subtitle'>>): void {
  useToasts.setState((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
}

/**
 * Convenience for the common `catch (e) { alert(e.message) }` pattern.
 *
 * ⚠️ Отказ «инстанс сменился» (`switched`) глотаем молча: он не про поломку, а про то, что человек
 * ушёл в другой инстанс, пока запрос был в полёте. Показать его значило бы выдать каждый переход за
 * ошибку — ровно там, где человек и так уже смотрит на новое место. Метка, а не `instanceof`:
 * `toast.ts` не должен зависеть от `api.ts` ради одного признака.
 */
export function toastError(e: unknown, title?: string): void {
  if ((e as { switched?: boolean } | null)?.switched === true) return;
  const raw = e instanceof Error ? e.message : String(e);
  /**
   * 🔴 Код федерации переводим ЗДЕСЬ, а не в каждом месте по отдельности (приёмка 18.09): клик по
   * гостю в списке участников выдавал человеку тост «federation.dm_unavailable». Таких мест
   * столько же, сколько вызовов `toastError`, и следующее забудется так же, как забылось это.
   */
  // Сырая строка проверки длины от сервера постарше («String must contain at most 4000 character(s)») — словами (07.10).
  // Э1 (`fedm1`): отказ «Написать» человеку другого инстанса помечен `dmOpen` (`store.openDmWith`) — причина своими словами.
  const fed = !isFedErrorCode(raw)
    ? null
    : (e as { dmOpen?: boolean } | null)?.dmOpen === true
      ? fedDmOpenText(raw, (e as { reason?: string }).reason)
      : (e as { fedCall?: boolean } | null)?.fedCall === true
        ? fedCallText(raw, (e as { fedWho?: string | null } | null)?.fedWho ?? null)
        : fedErrorText(raw, (e as { fedWho?: string | null } | null)?.fedWho ?? null);
  const msg = fed || humanLengthError(raw) || raw;
  if (title) toast('error', title, msg);
  else toast('error', msg);
}
