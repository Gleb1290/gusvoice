import { create } from 'zustand';

import type { ConfirmSpec } from './confirmRules';

/**
 * Окно подтверждения, которое можно позвать откуда угодно — как `toast`, только с ответом.
 *
 * 🔴 Зачем императивный вызов, а не «состояние в компоненте»: замена нативного `confirm` обязана
 * читаться на месте вызова так же, как читалась раньше (`if (!(await confirmAction(…))) return;`).
 * Перепиши мы это состоянием и колбэками — 23 места превратились бы в 23 переписанных компонента,
 * и правка перестала бы быть механической.
 *
 * ⚠️ Одно окно за раз НАМЕРЕННО: два подтверждения поверх друг друга — это всегда ошибка кода, и
 * лучше увидеть её сразу, чем разбирать стопку окон. Новый запрос отменяет прежний (`false`).
 */
interface Pending extends ConfirmSpec {
  id: number;
  resolve: (ok: boolean) => void;
  /**
   * Само действие, если его доверили окну. Тогда окно показывает «в процессе» и держит ОШИБКУ
   * ВНУТРИ себя — рядом с кнопкой, которую человек только что нажал. Без этого отказ улетал тостом
   * в угол, а окно к тому моменту уже закрывалось: связь между нажатием и отказом терялась.
   */
  run?: () => Promise<void>;
}

interface ConfirmState {
  pending: Pending | null;
  answer: (ok: boolean) => void;
  request: (spec: ConfirmSpec & { run?: () => Promise<void> }) => Promise<boolean>;
}

let nextId = 1;

export const useConfirmDialog = create<ConfirmState>((set, get) => ({
  pending: null,
  answer: (ok) => {
    const cur = get().pending;
    if (!cur) return;
    set({ pending: null });
    cur.resolve(ok);
  },
  request: (spec) =>
    new Promise<boolean>((resolve) => {
      const prev = get().pending;
      if (prev) {
        set({ pending: null });
        prev.resolve(false);
      }
      set({ pending: { ...spec, id: nextId++, resolve } });
    }),
}));

/**
 * Спросить подтверждение. `true` — человек согласился (а если передан `run` — ещё и действие
 * прошло успешно).
 */
export function confirmAction(spec: ConfirmSpec & { run?: () => Promise<void> }): Promise<boolean> {
  return useConfirmDialog.getState().request(spec);
}

/** Сообщить и дождаться «Понятно» — замена `alert()`. */
export function alertDialog(title: string, body?: string): Promise<boolean> {
  return confirmAction({ title, body, tone: 'info' });
}
