/**
 * «Наше окно сейчас закрыто чужим» — и что интерфейс по этому поводу делает.
 *
 * 🔴 **Откуда взялось.** Замер 20.09 (#193): пока человек играет, а наше окно лежит под игрой, мы
 * рисуем столько же, сколько когда он на него смотрит — 40 % процессора против 42 %. На четырёх
 * ядрах это полтора ядра, отобранных у игры.
 *
 * 🔴 **Почему не по фокусу.** «Нет фокуса — замираем» сломало бы жизнь всем, у кого два монитора:
 * там окно видно на соседнем экране, просто фокус в игре. Поэтому решение принимает оболочка,
 * сравнивая ГЕОМЕТРИЮ окон, а сюда приезжает готовый ответ (`occlusion.rs`).
 *
 * ⚠️ **Что замирает, а что нет.** Замораживаем анимации — их всё равно никто не видит, и они
 * оживают ровно с того же места. НЕ трогаем ничего, что человек может потерять: звук, показ, приём
 * видео, доставку сообщений, значки непрочитанного. Задача — перестать ДВИГАТЬ картинку, а не
 * выключить приложение.
 */

import { isDesktop } from './hotkeys';

const CLASS = 'gv-covered';

type TauriEvent = { listen?: (e: string, cb: (ce: { payload: unknown }) => void) => Promise<() => void> };
type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };

function ev(): TauriEvent | null {
  return (window as unknown as { __TAURI__?: { event?: TauriEvent } }).__TAURI__?.event ?? null;
}
function core(): TauriCore | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core ?? null;
}

let covered = false;
const listeners = new Set<(v: boolean) => void>();

/** Знают ли остальные части клиента, что нас не видно (тики можно разредить). */
export function isWindowCovered(): boolean {
  return covered;
}

/**
 * Насколько окно накрыто чужим, в процентах — только для диагностики (#193).
 *
 * 🔴 Различает две причины молчания механизма: «не работает» и «игра честно не накрывает окно
 * целиком». Без этого числа они выглядят одинаково, и один круг на этом уже потерян.
 */
export async function windowCoverPct(): Promise<number> {
  const c = core();
  if (!isDesktop() || !c) return 0;
  try {
    const v = await c.invoke('gv_window_cover_pct');
    return typeof v === 'number' ? v : 0;
  } catch {
    return 0;
  }
}

/** Подписаться на смену видимости. Возвращает отписку. */
export function onWindowCovered(fn: (v: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function apply(v: boolean): void {
  if (v === covered) return;
  covered = v;
  document.documentElement.classList.toggle(CLASS, v);
  for (const fn of listeners) {
    try {
      fn(v);
    } catch {
      /* один слушатель не должен ронять остальных */
    }
  }
}

/**
 * Начать слушать оболочку. В вебе не делает ничего: там окна как объекта у нас нет, а вкладку
 * браузер тормозит сам.
 */
export function watchWindowCovered(): () => void {
  if (!isDesktop()) return () => {};
  const e = ev();
  if (!e?.listen) return () => {};
  let disposed = false;
  let un: (() => void) | null = null;
  void e
    .listen('gv://covered', (ce) => apply(ce.payload === true))
    .then((u) => (disposed ? u() : (un = u)));
  // Перезагрузка страницы теряет состояние, а окно могло остаться под игрой — спрашиваем текущее.
  void core()
    ?.invoke('gv_window_covered')
    .then((v) => apply(v === true))
    .catch(() => {});
  return () => {
    disposed = true;
    un?.();
    apply(false);
  };
}
