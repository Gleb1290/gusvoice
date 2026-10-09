/**
 * Режим выделения в ленте ЛС (раунд 12, порция 5, `docs/design/design-step12/HANDOFF.md` §6): на телефоне кнопка «назад»
 * в шапке (`.mobile-back`) на время выделения становится крестиком «Выйти из выделения». Кнопка живёт в `MainLayout`
 * (поверх шапки ленты), а выделение — состояние `MessagePane`; связывает их этот выключатель — тот же приём, что у
 * «Написать» (`dmCompose.ts`): крошечный сторонний стор. Лента, войдя в выделение, отдаёт сюда, как из него выйти
 * (`holdSelection`), и забирает обратно, когда выделение кончилось или лента ушла с экрана.
 * Ниже — чистые правила выделения мышью (удержание, протяжка, автопрокрутка, предел `SELECT_MAX`): их зовёт `MessagePane`.
 */
import { useSyncExternalStore } from 'react';

let exit: (() => void) | null = null;
const subs = new Set<() => void>();

function emit(): void {
  for (const f of subs) f();
}

function subscribe(f: () => void): () => void {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

/**
 * Лента вошла в выделение: `onExit` — выйти из него. Возвращает «отпустить» (выделение кончилось или лента размонтирована);
 * отпускает только своё — выделение следующей ленты, если оно уже взято, не трогает.
 */
export function holdSelection(onExit: () => void): () => void {
  exit = onExit;
  emit();
  return () => {
    if (exit !== onExit) return;
    exit = null;
    emit();
  };
}

/** Выйти из выделения (крестик на месте «назад»). `false` — выделения нет. */
export function exitSelection(): boolean {
  const f = exit;
  if (!f) return false;
  f();
  return true;
}

/** Открыто ли выделение — для кнопки «назад» в шапке телефона. */
export function useSelectionOpen(): boolean {
  return useSyncExternalStore(subscribe, () => exit !== null, () => exit !== null);
}

// ─── Выделение мышью (замечание владельца 05.10; веб и десктоп) ────────────────────────────────────────────────────────
/*
 * Как у Telegram Desktop (`history_inner_widget.cpp`: `mouseActionStart` → `PrepareSelect` → `Selecting`,
 * `applyDragSelection`): нажатие по пузырю — выделение ТЕКСТА (браузер, как было; лента в него не вмешивается);
 * нажатие рядом с пузырём (пустое место строки, поле ленты, дневная метка) и протяжка — выделение СООБЩЕНИЙ: от строки
 * нажатия до строки под указателем, назад — диапазон сжимается. Протяжка добавляет диапазон к выбранному, если строка
 * нажатия не была выбрана, и снимает, если была. В режиме выделения тянуть можно с любой точки строки, щелчок без
 * протяжки переключает строку (как было). Своё сверх Telegram — удержание (просьба владельца): ЛКМ держат РЯДОМ с
 * пузырём `SELECT_HOLD_MS` без сдвига — сообщение этой строки выбрано, а отпускание уже не щелчок. Удержание на самом
 * пузыре ничего не делает (замечание владельца 05.10: там выделяют текст). Мышь. Палец (G43) — удержание вне текста и протяжка
 * не отрывая палец: те же `selectRange` / `selectRowAt`, цифры Telegram для Android — в конце файла.
 */

/** Сколько сообщений можно выбрать: предел пачки сервера (`convRules.MESSAGE_BATCH_MAX`) и Telegram (`MaxSelectedItems`). */
export const SELECT_MAX = 100;
/** Сколько играет встряска счётчика «Выбрано N» на попытке добавить сверх предела (Telegram Android: `shakeAnimation`, ≈ 0,4 с). */
export const SEL_SHAKE_MS = 400;
/** Удержание ЛКМ рядом с пузырём, после которого сообщение строки выбрано (просьба владельца — около 400 мс). */
export const SELECT_HOLD_MS = 400;
/**
 * Сдвиг указателя (px по любой оси): больше — это уже протяжка, а не удержание. Порядок системного порога протяжки Windows
 * (`SM_CXDRAG` = 4 px) и Qt (`startDragDistance`): дрожь руки при удержании не в счёт.
 */
export const SELECT_SLOP_PX = 5;
/** Автопрокрутка при протяжке: шаг считается на такт этой длины (Telegram — таймер 15 мс)… */
export const SELECT_SCROLL_TICK_MS = 15;
/** …и не больше этого за такт (Telegram, `DraggingScrollManager`: 37 px на 15 мс). */
export const SELECT_SCROLL_MAX = 37;

/**
 * Что начинает нажатие в ленте: `rows` — выделение сообщений (удержание или протяжка), `null` — ничего (нажатие — браузеру
 * и самому элементу: по пузырю выделяется текст). До 05.10 по пузырю было `text` — лента ждала удержания и выбирала
 * сообщение; замечание владельца: на пузыре удержание должно оставаться выделением текста.
 */
export type SelectPress = 'rows' | null;

/** Признаки нажатия — их собирает лента из события. */
export interface SelectPressInput {
  /** Мышь, основная кнопка, без клавиш-модификаторов (Shift+щелчок и прочее — браузеру, как было). */
  mouse: boolean;
  /** В этой ленте есть выделение (пузыри ЛС за переключателем, действия пачкой `conv5`). */
  canSelect: boolean;
  /** Уже в режиме выделения. */
  selecting: boolean;
  /** По самому пузырю: текст, фото, ссылка, цитата, реакция. */
  bubble: boolean;
  /**
   * По тому, что нажатие оставляет себе: действия наведения, аватар, поле правки, строки «в пути» и «Не отправлено»,
   * полоса прокрутки ленты.
   */
  own: boolean;
}

/**
 * Начинать ли выделение сообщений с этого нажатия. Не мышь, в ленте нет выделения, нажатие у своего элемента — нет
 * (`null`). В режиме выделения — строки с любой точки (текст там не выделяется: строка — флажок). Иначе по пузырю — нет
 * (там выделяют текст, удержание ничего не делает), рядом с пузырём — `rows`.
 */
export function selectPress(p: SelectPressInput): SelectPress {
  if (!p.mouse || !p.canSelect || p.own) return null;
  if (p.selecting) return 'rows';
  return p.bubble ? null : 'rows';
}

/** Указатель ушёл дальше `SELECT_SLOP_PX` по любой оси: удержания уже нет, это протяжка. */
export function selectSlopPassed(dx: number, dy: number): boolean {
  return Math.abs(dx) > SELECT_SLOP_PX || Math.abs(dy) > SELECT_SLOP_PX;
}

/**
 * Вошла ли в диапазон строка нажатия (у Telegram — «maybe exclude dragSelFrom»): указатель на другой строке или ушёл по
 * вертикали дальше порога. Сдвиг вбок по той же строке её не выбирает.
 */
export function selectStartIn(at: number, start: number, dy: number): boolean {
  return at !== start || Math.abs(dy) > SELECT_SLOP_PX;
}

/** Строка ленты по вертикали (экранные px). */
export interface SelectBand {
  top: number;
  bottom: number;
}

/**
 * Какая строка под указателем `y` (строки — по порядку ленты сверху вниз, `band(i)` — их полосы). Внутри строки — она; выше
 * первой — первая, ниже последней — последняя; в зазоре между строками (дневная метка, черта «Новые сообщения») — та, что со
 * стороны строки `start`, от которой тянут: следующую указатель ещё не достиг (у Telegram строка входит в диапазон, когда
 * в неё вошёл указатель). `start` < 0 (строки нажатия ещё нет) — ближайшая. Строк нет — −1. Поиск двоичный: полосы читаются
 * из раскладки, а ход мыши частый.
 */
export function selectRowAt(count: number, band: (i: number) => SelectBand, y: number, start: number): number {
  if (count <= 0) return -1;
  let lo = 0;
  let hi = count;
  // Первая строка, чей низ ниже указателя.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (band(mid).bottom > y) hi = mid;
    else lo = mid + 1;
  }
  if (lo >= count) return count - 1;
  if (lo === 0 || band(lo).top <= y) return lo;
  // Зазор между строками lo − 1 и lo.
  if (start >= 0) return start <= lo - 1 ? lo - 1 : lo;
  return y - band(lo - 1).bottom <= band(lo).top - y ? lo - 1 : lo;
}

/**
 * Выбранные после протяжки. Считается на каждый ход заново от `base`, поэтому назад диапазон сжимается.
 * - `order` — id строк ленты по порядку; `base` — выбранные до протяжки; диапазон — от `from` (строка нажатия) до `to`
 *   включительно, в любую сторону; `to === null` (строка нажатия ещё не вошла, `selectStartIn`) — `base` как есть;
 * - `add` — добавить диапазон к `base` по ходу протяжки (от строки нажатия к указателю), пока выбранных меньше `max`;
 *   иначе — снять диапазон с `base`;
 * - `from` или `to` нет в ленте (окно ленты ушло дальше) — `base` как есть.
 */
export function selectRange(
  order: readonly string[],
  base: readonly string[],
  from: string,
  to: string | null,
  add: boolean,
  max: number = SELECT_MAX,
): readonly string[] {
  if (to === null) return base;
  const i = order.indexOf(from);
  const j = order.indexOf(to);
  if (i < 0 || j < 0) return base;
  const range = i <= j ? order.slice(i, j + 1) : order.slice(j, i + 1).reverse();
  if (!add) {
    const drop = new Set(range);
    return base.filter((id) => !drop.has(id));
  }
  const out = [...base];
  const have = new Set(base);
  for (const id of range) {
    if (out.length >= max) break;
    if (!have.has(id)) {
      have.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * «Выделить до этого сообщения» (07.10, сверка 01·1.32 / 4.05; Telegram Desktop): к выбранным добавляются все сообщения между
 * ближайшим выбранным и этим. Ближайшее — по числу строк между ними, поровну — то, что выше. `null` — пункта нет: сообщение
 * уже выбрано, выбранных нет (нечего продолжать), сообщения нет в `order` или всего вышло бы больше `max` (у Telegram в таком
 * случае пункт не показывается). Диапазон — `selectRange`, порядок выбора сохраняется: новые встают после прежних.
 */
export function selectUpTo(
  order: readonly string[],
  picked: readonly string[],
  target: string,
  max: number = SELECT_MAX,
): readonly string[] | null {
  const t = order.indexOf(target);
  if (t < 0 || picked.length === 0 || picked.includes(target)) return null;
  const have = new Set(picked);
  let near = -1;
  for (let d = 1; d < order.length && near < 0; d++) {
    if (t - d >= 0 && have.has(order[t - d])) near = t - d;
    else if (t + d < order.length && have.has(order[t + d])) near = t + d;
  }
  if (near < 0) return null;
  const out = selectRange(order, picked, order[near], target, true, Number.POSITIVE_INFINITY);
  return out.length <= max ? out : null;
}

/** Нажатие клавиши, как его видит правило `selectionKey` (поля `KeyboardEvent`). */
export interface SelectionKeyInput {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

/**
 * Клавиши в режиме выделения (07.10, сверка 01·4.06 / 6.01; Telegram Desktop): Ctrl+C — скопировать выбранные (`copy`),
 * Delete или Backspace — «Удалить N?» (`delete`); Esc — отдельный слушатель ленты. Ctrl — по месту клавиши (`code`): в
 * русской раскладке это «с». На Mac — ⌘. Alt, Shift и повтор при удержании — не наши (Shift+стрелки у Telegram — выделение
 * текста). Где фокус в поле и есть ли поверх ленты окно — решает лента, не это правило.
 */
export function selectionKey(e: SelectionKeyInput): 'copy' | 'delete' | null {
  if (e.altKey || e.shiftKey || e.repeat) return null;
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC') return 'copy';
  if (!e.ctrlKey && !e.metaKey && (e.key === 'Delete' || e.key === 'Backspace')) return 'delete';
  return null;
}

/**
 * Автопрокрутка при протяжке — как у Telegram (`DraggingScrollManager::checkDeltaScroll`): только когда указатель вышел за
 * видимую часть ленты (`top`…`bottom`, экранные px); шаг на такт `SELECT_SCROLL_TICK_MS` растёт с удалением `d` как
 * `d · 3 / 20 + 1` до `SELECT_SCROLL_MAX`. Знак — направление (вверх −, вниз +); внутри ленты — 0.
 */
export function selectScrollStep(y: number, top: number, bottom: number): number {
  const delta = y < top ? y - top : y >= bottom ? y - bottom + 1 : 0;
  if (delta === 0) return 0;
  return Math.sign(delta) * Math.min(Math.trunc((Math.abs(delta) * 3) / 20) + 1, SELECT_SCROLL_MAX);
}

/* ─── Выделение пальцем (G43, телефон): удержание вне текста и протяжка не отрывая палец ─────────────────────────────────
   Цифры — Telegram для Android (`RecyclerListView.onTouchEvent` в режиме `multiSelectionGesture`): протяжка начинается,
   когда палец ушёл по вертикали больше `touchSlop` (8 dp); у верхнего и нижнего края ленты — зона 56 dp, в ней лента
   листается сама по 12 dp за кадр, пока палец там (даже без движения). Диапазон считают те же `selectRange` / `selectRowAt`. */

/** Сдвиг пальца по вертикали (px), после которого удержание стало протяжкой (`ViewConfiguration.getScaledTouchSlop` ≈ 8 dp). */
export const SELECT_TOUCH_SLOP_PX = 8;
/** Зона автопрокрутки у верхнего и нижнего края ленты (`AndroidUtilities.dp(56)` в `RecyclerListView.onTouchEvent`). */
export const SELECT_TOUCH_EDGE_PX = 56;
/** Шаг автопрокрутки за такт `SELECT_SCROLL_TICK_MS` (`dp(12)` в `scroller` у `RecyclerListView`). */
export const SELECT_TOUCH_SCROLL_PX = 12;

/**
 * Автопрокрутка пальцем: знак — направление (вверх −, вниз +), 0 — палец вне зон. `y` — экранная точка пальца, `top`…`bottom` —
 * видимая часть ленты. Нижняя зона проверяется первой, как у Telegram (в низкой ленте, где зоны сходятся, листается вниз).
 */
export function selectTouchScrollStep(y: number, top: number, bottom: number): number {
  if (y > bottom - SELECT_TOUCH_EDGE_PX) return SELECT_TOUCH_SCROLL_PX;
  if (y < top + SELECT_TOUCH_EDGE_PX) return -SELECT_TOUCH_SCROLL_PX;
  return 0;
}
