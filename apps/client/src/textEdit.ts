/**
 * Правка текста в поле ввода — вынуто из `EditContextMenu.tsx` (просьба Codex, #81).
 *
 * Модуль чистый: ошибка здесь режет не тот кусок строки или ставит курсор не туда, а поймать это
 * в компоненте нечем — там DOM, React и буфер обмена.
 */

export interface SpliceResult {
  value: string;
  /** Куда встаёт курсор после правки (выделения не остаётся — как при обычном вводе). */
  caret: number;
}

/**
 * Заменить участок `[start, end)` на `insert`.
 *
 * ⚠️ `selectionStart`/`selectionEnd` у поля могут быть `null` (например, у `type="email"` в
 * некоторых браузерах). Контракт на этот случай выбран явно: **вставка в конец строки**, а не в
 * начало — молчаливая вставка в начало выглядит как порча уже набранного текста. `end < start`
 * (перевёрнутое выделение) нормализуем, иначе `slice` тихо вернёт мусор.
 */
export function spliceText(
  value: string,
  start: number | null,
  end: number | null,
  insert: string,
): SpliceResult {
  const from = clamp(start ?? value.length, value.length);
  const to = clamp(end ?? from, value.length);
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return { value: value.slice(0, lo) + insert + value.slice(hi), caret: lo + insert.length };
}

/** Текст, выделенный в поле сейчас. Пустая строка — выделения нет. */
export function selectedSlice(value: string, start: number | null, end: number | null): string {
  const lo = clamp(Math.min(start ?? 0, end ?? 0), value.length);
  const hi = clamp(Math.max(start ?? 0, end ?? 0), value.length);
  return value.slice(lo, hi);
}

function clamp(n: number, max: number): number {
  return Math.max(0, Math.min(n, max));
}
