/**
 * Alt+↑/↓ и Ctrl+Alt+Home/End — соседняя, первая и последняя лента списка (07.10, G14, Telegram 03·1.7.3). Одно правило
 * для бесед ЛС и текстовых каналов сервера (решение владельца 07.10): по кругу не ходит, из поля ввода работает.
 */

/** Клавиша навигации по лентам или `null`: Alt+↑/↓ без Ctrl, Ctrl+Alt+Home/End; Shift и ⌘ — не наши. */
export function feedNavKey(e: {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): 'up' | 'down' | 'first' | 'last' | null {
  if (!e.altKey || e.shiftKey || e.metaKey) return null;
  if (!e.ctrlKey && e.code === 'ArrowUp') return 'up';
  if (!e.ctrlKey && e.code === 'ArrowDown') return 'down';
  if (e.ctrlKey && e.code === 'Home') return 'first';
  if (e.ctrlKey && e.code === 'End') return 'last';
  return null;
}

/**
 * Куда перейти из `currentId` по списку `ids` (сверху вниз). Текущей нет в списке — стрелки ведут к первой. Край списка
 * — остаёмся (без круга). Возвращает id цели или `null`, когда переходить некуда (список пуст или цель — текущая).
 */
export function feedNavTarget(
  ids: readonly string[],
  currentId: string | null | undefined,
  key: 'up' | 'down' | 'first' | 'last',
): string | null {
  if (ids.length === 0) return null;
  const idx = currentId ? ids.indexOf(currentId) : -1;
  const at =
    key === 'first' ? 0 : key === 'last' ? ids.length - 1 : idx < 0 ? 0 : idx + (key === 'down' ? 1 : -1);
  const next = ids[Math.max(0, Math.min(ids.length - 1, at))];
  return next !== currentId ? next : null;
}
