import { create } from 'zustand';

import { fedErrorText, isFedErrorCode } from './fedErrorText';

export type ToastType = 'success' | 'info' | 'warn' | 'error';

export interface Toast {
  id: number;
  type: ToastType;
  title: string;
  subtitle?: string;
  /** When true, ToastHost never auto-dismisses this toast — it stays until the user clicks ✕.
   *  Use for low-frequency, must-not-miss heads-ups (e.g. "обновлён до vX"). Still non-blocking. */
  sticky?: boolean;
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
export function toast(type: ToastType, title: string, subtitle?: string, opts?: { sticky?: boolean }): number {
  return useToasts.getState().push({ type, title, subtitle, sticky: opts?.sticky });
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
  const msg = (isFedErrorCode(raw) && fedErrorText(raw)) || raw;
  if (title) toast('error', title, msg);
  else toast('error', msg);
}
