/**
 * Ctrl+Tab — окно недавних бесед (08.10, #211, G65; Telegram Desktop `window/window_chat_switch_process.cpp`, `core/shortcuts.cpp`).
 *
 * У Telegram Ctrl+Tab не листает беседы по кругу, а открывает плитки недавно открытых (аватар + имя): первое нажатие Tab
 * выбирает ПРЕДЫДУЩУЮ беседу (текущая стоит первой плиткой), каждое следующее двигает выбор, Shift+Tab — назад, стрелки
 * двигают по сетке, Esc закрывает, Q убирает выбранную плитку из списка недавних, отпускание Ctrl открывает выбранную.
 * Меньше двух плиток — окна нет. Здесь — чистые правила без React; окно — `components/ChatSwitch.tsx`.
 */

/** Сколько недавних плиток помним и показываем (две строки по семь: у Telegram `canPerRow > 2*7` — одна строка до семи). */
export const CHAT_SWITCH_MAX = 14;
const PER_ROW_MAX = 7;

export type ChatSwitchAction = 'next' | 'prev' | 'left' | 'right' | 'up' | 'down' | 'close' | 'choose' | 'remove';

/** Начало переключения: Ctrl+Tab / Ctrl+Shift+Tab без Alt и ⌘. */
export function isChatSwitchStart(e: { code: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  return e.code === 'Tab' && e.ctrlKey && !e.altKey && !e.metaKey;
}

/** Клавиша внутри открытого окна → действие. Удерживаемый Ctrl — условие жизни окна, остальное он не меняет. */
export function chatSwitchAction(e: { code: string; shiftKey: boolean; altKey: boolean }): ChatSwitchAction | null {
  if (e.altKey) return null;
  switch (e.code) {
    case 'Tab':
      return e.shiftKey ? 'prev' : 'next';
    case 'ArrowRight':
      return 'right';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'Escape':
      return 'close';
    case 'Enter':
    case 'NumpadEnter':
      return 'choose';
    case 'KeyQ':
      return 'remove';
    default:
      return null;
  }
}

/** Запомнить открытую беседу: наверх списка, без повторов, не длиннее `CHAT_SWITCH_MAX`. */
export function pushRecent(recent: readonly string[], id: string, max = CHAT_SWITCH_MAX): string[] {
  return [id, ...recent.filter((x) => x !== id)].slice(0, max);
}

/**
 * Плитки окна. Текущая беседа — первой; за ней открытые недавно (если ещё есть в списке), потом остальные беседы списка в
 * его порядке — иначе сразу после запуска (недавних ещё нет) окно было бы пустым. Это добавка к Telegram, у которого
 * недавние пока не накоплены — окно просто не открывается.
 */
export function chatSwitchList(
  recent: readonly string[],
  allIds: readonly string[],
  currentId: string | null,
  max = CHAT_SWITCH_MAX,
): string[] {
  const known = new Set(allIds);
  const out: string[] = [];
  const add = (id: string | null) => {
    if (id && known.has(id) && !out.includes(id)) out.push(id);
  };
  add(currentId);
  recent.forEach(add);
  allIds.forEach(add);
  return out.slice(0, max);
}

/** Сетка: до семи в ряд — одна строка; больше — две, поровну. */
export function chatSwitchLayout(count: number): { rows: number; perRow: number } {
  if (count <= 0) return { rows: 0, perRow: 0 };
  const rows = count <= PER_ROW_MAX ? 1 : 2;
  return { rows, perRow: Math.ceil(count / rows) };
}

/** Tab / → : дальше; с края или без выбора — на первую (как `ChatSwitchProcess::process`). */
export function stepNext(selected: number, count: number): number {
  if (count <= 0) return -1;
  return selected < 0 || selected + 1 >= count ? 0 : selected + 1;
}

/** Shift+Tab / ← : назад; с первой или без выбора — на последнюю. */
export function stepPrev(selected: number, count: number): number {
  if (count <= 0) return -1;
  return selected <= 0 ? count - 1 : selected - 1;
}

/** ↑ / ↓ : на ряд выше/ниже, за край — с другого конца (у Telegram `now < 0 ? count + now : now`). */
export function stepRow(selected: number, count: number, perRow: number, dir: 'up' | 'down'): number {
  if (count <= 0 || perRow <= 0) return -1;
  const now = Math.max(selected, 0) + (dir === 'down' ? perRow : -perRow);
  if (now < 0) return Math.max(0, count + now);
  return now >= count ? now - count : now;
}

/** Новая позиция выбора после действия движения; `null` — действие не движение. */
export function moveSelection(action: ChatSwitchAction, selected: number, count: number): number | null {
  const { perRow } = chatSwitchLayout(count);
  switch (action) {
    case 'next':
    case 'right':
      return stepNext(selected, count);
    case 'prev':
    case 'left':
      return stepPrev(selected, count);
    case 'up':
    case 'down':
      return stepRow(selected, count, perRow, action);
    default:
      return null;
  }
}

/** Убрать плитку `index` (клавиша Q). Выбор остаётся на месте удалённой (на следующей), за краем — на последней; пусто → -1. */
export function removeTile(
  ids: readonly string[],
  index: number,
): { ids: string[]; selected: number } {
  if (index < 0 || index >= ids.length) return { ids: [...ids], selected: index };
  const next = ids.filter((_, i) => i !== index);
  return { ids: next, selected: next.length ? Math.min(index, next.length - 1) : -1 };
}
