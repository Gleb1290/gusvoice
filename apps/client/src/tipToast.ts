/**
 * Контроллер всплывающей плашки «кто кого типнул» в ГЛАВНОМ окне (только десктоп).
 *
 * Устроен как контроллер оверлея-ростера (`overlay.ts`) и по той же причине: окно плашки не держит
 * ни соединения, ни стора — главное окно кладёт ему готовый снимок через `gv_toast_*`.
 *
 * 🔴 **Окно НЕ показывается и НЕ прячется на событие.** Пока фича включена, оно просто живёт:
 * прозрачное, сквозное для мыши, пустое. На тип или щипок в нём появляется надпись и через
 * `TOAST_MS` гаснет — то есть в момент события не происходит ни одной оконной операции.
 *
 * Почему так, а не «показать на событие и спрятать»: показ окна поверх работающей игры — это
 * перестановка Z-порядка, единственное место, где оверлей может дёрнуть игру или мигнуть пустым
 * кадром, пока содержимое не отрисовалось. Раз этого можно не делать — не делаем.
 *
 * 🔴 **Размер фиксированный** (`TOAST_BASE_*` × множитель), а не «по содержимому», как у ростера.
 * Ростер меряет себя и просит окно ужаться, потому что его высота зависит от числа людей. Здесь
 * такая подгонка означала бы изменение размера окна ровно в момент события — то самое, чего мы
 * избегаем. Цена: очень длинная пара имён обрежется многоточием.
 */
import { useStore } from './store';
import { toastWants } from './toastRules';
import type { ToastEvent } from './toastRules';
import {
  getToastSettings,
  onToastSettings,
  setToastSettings,
  TOAST_BASE_H,
  TOAST_BASE_W,
} from './toastSettings';

export interface ToastPayload {
  events: ToastEvent[];
  opacity: number;
  scale: number;
  /** Человек расставляет плашку мышью — рисуем образец и рамку, даже когда событий нет. */
  positioning?: boolean;
}

type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
function tauriCore(): TauriCore | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core ?? null;
}
type TauriEvent = {
  listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
};
function tauriEvent(): TauriEvent | null {
  return (window as unknown as { __TAURI__?: { event?: TauriEvent } }).__TAURI__?.event ?? null;
}

let started = false;
let positioning = false;
let reschedule: (() => void) | null = null;

/** Подключить контроллер один раз. В вебе выходит сразу — там нет Tauri. */
export function initTipToast(): void {
  if (started) return;
  const core = tauriCore();
  if (!core) return;
  started = true;

  let shown = false;
  let lastPosKey = '';
  let lastSizeKey = '';
  let lastPushKey = '';

  const reconcile = () => {
    const st = getToastSettings();
    const s = useStore.getState();
    const inVoice = !!s.voice?.channelId;
    const shouldShow = positioning || (st.enabled && (!st.onlyInVoice || inVoice));

    if (shouldShow !== shown) {
      shown = shouldShow;
      core.invoke(shouldShow ? 'gv_toast_show' : 'gv_toast_hide').catch(() => {});
      // Показали заново — положение и размер надо проставить заново: окно могло висеть скрытым с
      // прошлой раскладки экрана.
      if (shouldShow) {
        lastPosKey = '';
        lastSizeKey = '';
      }
    }
    if (!shouldShow) return;

    // Размер — от множителя. Меняется ТОЛЬКО когда человек двигает ползунок, не на событие.
    const sizeKey = String(st.scale);
    if (sizeKey !== lastSizeKey) {
      lastSizeKey = sizeKey;
      core
        .invoke('gv_toast_set_size', { w: TOAST_BASE_W * st.scale, h: TOAST_BASE_H * st.scale })
        .catch(() => {});
      // Размер поменялся — прижатие к углу надо пересчитать, иначе плашка уедет за край.
      lastPosKey = '';
    }

    // Положение. Пока человек тащит плашку мышью — не спорим с ним.
    if (!positioning) {
      const posKey =
        st.posMode === 'custom'
          ? `c:${st.customX}:${st.customY}`
          : `k:${st.corner}:${st.marginX}:${st.marginY}`;
      if (posKey !== lastPosKey) {
        lastPosKey = posKey;
        if (st.posMode === 'custom') {
          core.invoke('gv_toast_set_position', { x: st.customX, y: st.customY }).catch(() => {});
        } else {
          core
            .invoke('gv_toast_set_corner', { corner: st.corner, marginX: st.marginX, marginY: st.marginY })
            .catch(() => {});
        }
      }
    }

    const payload: ToastPayload = {
      // Роды фильтруем ЗДЕСЬ, а не при записи в стор: тогда выключенный тумблер действует сразу и
      // на уже прилетевшие события, а не со следующего.
      events: s.toastEvents.filter((e) => toastWants(st, e.kind)),
      opacity: st.opacity,
      scale: st.scale,
      positioning,
    };
    const pushKey = JSON.stringify(payload);
    if (pushKey !== lastPushKey) {
      lastPushKey = pushKey;
      core.invoke('gv_toast_push_state', { payload }).catch(() => {});
    }
  };
  reschedule = reconcile;

  const ev = tauriEvent();
  // Окно объявилось (его слушатель готов) — толкаем текущее состояние: первый пуш мог его обогнать.
  void ev?.listen('gv-toast-ready', () => {
    lastPushKey = '';
    reconcile();
  });
  // «Готово» нажали на самой плашке в режиме расстановки.
  void ev?.listen('gv-toast-reposition-done', () => {
    void finishToastReposition();
  });

  useStore.subscribe(reconcile);
  onToastSettings(reconcile);
  reconcile();
}

/** Режим расстановки: показать образец плашки и дать таскать её мышью. */
export function startToastReposition(): void {
  const core = tauriCore();
  if (!core) return;
  positioning = true;
  core.invoke('gv_toast_show').catch(() => {});
  core.invoke('gv_toast_set_interactive', { interactive: true }).catch(() => {});
  reschedule?.();
}

/**
 * Выйти из расстановки: запомнить перетащенное положение и вернуть сквозной клик.
 *
 * 🔴 **Идемпотентна намеренно.** Её зовёт не только кнопка «Готово» на самой плашке, но и ЗАКРЫТИЕ
 * настроек — а туда можно прийти, ни разу не включив расстановку. Без проверки `positioning`
 * закрытие настроек молча переводило бы позицию из «угол» в «своя».
 */
export async function finishToastReposition(): Promise<void> {
  const core = tauriCore();
  if (!core || !positioning) return;
  const pos = (await core.invoke('gv_toast_get_position').catch(() => null)) as [number, number] | null;
  if (Array.isArray(pos)) {
    setToastSettings({ posMode: 'custom', customX: Math.round(pos[0]), customY: Math.round(pos[1]) });
  }
  positioning = false;
  core.invoke('gv_toast_set_interactive', { interactive: false }).catch(() => {});
  reschedule?.();
}
