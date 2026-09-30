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

import { useSyncExternalStore } from 'react';
import { isDesktop } from './hotkeys';

const CLASS = 'gv-covered';

/**
 * Подписчики на смену любого из двух признаков (`useWindowMotion`). Отдельно от `listeners`: тем
 * важен только `covered` (тик «кто говорит»), а этим — оба.
 */
const motionSubs = new Set<() => void>();

function notifyMotion(): void {
  for (const fn of motionSubs) {
    try {
      fn();
    } catch {
      /* один подписчик не должен ронять остальных */
    }
  }
}

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

/**
 * На переднем плане чужое окно на весь монитор, то есть почти всегда игра (#207, плейбук 25.09).
 *
 * 🔴 Не то же, что `covered`. Окно на ВТОРОМ мониторе видно, поэтому целиком его не замораживаем
 * (см. «Почему не по фокусу» выше). Но пока идёт игра, бесконечные украшения (пульс LIVE, дыхание
 * короны, гусь) перерисовывают окно каждый кадр и будят DWM, чья работа на видеокарте идёт впереди
 * игры. Под классом `gv-game-fg` встают ТОЛЬКО бесконечные анимации: появление сообщений и тостов на
 * втором мониторе работает как обычно. Так же делает Discord со своим превью.
 */
const GAME_CLASS = 'gv-game-fg';
let gameFg = false;

/** Идёт ли сейчас полноэкранная игра на переднем плане — для диагностики. */
export function isGameForeground(): boolean {
  return gameFg;
}

/**
 * Состояние окна для тех, кому важны ОБЕ причины замереть: накрыто ли оно и впереди ли игра.
 *
 * 🔴 Зачем (27.09, #207). CSS-классы выше останавливают только CSS-анимации, а анимированный GIF
 * крутит декодер картинки — `animation-play-state` на него не действует. Трейс: 14 анимированных
 * аватарок держали перерисовку ~150 раз в секунду, и под игрой тоже. По этому состоянию `Avatar`
 * подменяет анимацию её первым кадром: всегда — в накрытом окне (его никто не видит), под игрой —
 * только в оптимизированном режиме (окно может быть видно на втором мониторе, `liteMode.ts`).
 */
export function useWindowMotion(): { covered: boolean; gameFg: boolean } {
  // Число, а не объект: снимок `useSyncExternalStore` обязан быть стабильным между вызовами.
  const bits = useSyncExternalStore(
    (fn) => {
      motionSubs.add(fn);
      return () => motionSubs.delete(fn);
    },
    () => (covered ? 1 : 0) | (gameFg ? 2 : 0),
    () => 0,
  );
  return { covered: (bits & 1) !== 0, gameFg: (bits & 2) !== 0 };
}

function applyGame(v: boolean): void {
  if (v === gameFg) return;
  gameFg = v;
  document.documentElement.classList.toggle(GAME_CLASS, v);
  notifyMotion();
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
  notifyMotion();
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
  let unGame: (() => void) | null = null;
  void e
    .listen('gv://covered', (ce) => apply(ce.payload === true))
    .then((u) => (disposed ? u() : (un = u)));
  void e
    .listen('gv://game-foreground', (ce) => applyGame(ce.payload === true))
    .then((u) => (disposed ? u() : (unGame = u)));
  // Перезагрузка страницы теряет состояние, а окно могло остаться под игрой — спрашиваем текущее.
  void core()
    ?.invoke('gv_window_covered')
    .then((v) => apply(v === true))
    .catch(() => {});
  // Оболочка старше 0.8.7 такой команды не знает — тогда признака просто нет, анимации как раньше.
  void core()
    ?.invoke('gv_game_foreground')
    .then((v) => applyGame(v === true))
    .catch(() => {});
  return () => {
    disposed = true;
    un?.();
    unGame?.();
    apply(false);
    applyGame(false);
  };
}
