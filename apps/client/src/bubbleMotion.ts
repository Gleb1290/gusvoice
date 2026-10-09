/**
 * Движение пузырей ЛС (#211, polish-feed2): появление нового сообщения и схлопывание удалённого, как у Telegram
 * (tweb `components/chat/bubbles.ts` — `zoom-fade` / `can-zoom-fade`, `_chatBubble.scss`; Android `ChatListItemAnimator`).
 * Здесь только правила — какие строки анимировать; сама анимация — CSS (`.message.bub.bub-in` / `.bub-out` в `styles.css`),
 * «меньше движения» её выключает.
 */

/** Больше стольких сразу — это не «пришло сообщение», а подгрузка или смена окна ленты: без анимации. */
export const MOTION_MAX = 3;

/** Сколько мс строка считается «новой» после появления (анимация — 0,28 с; запас на поздние перерисовки). */
export const APPEAR_MS = 1000;

/** Сколько мс удалённая строка схлопывается, прежде чем уйти из разметки (CSS `--t-base`, 0,2 с, + запас). */
export const LEAVE_MS = 260;

type Row = { id: string };

/**
 * Новые строки в хвосте ленты: всё, что встало ПОСЛЕ прежней последней строки, если прежняя последняя на месте и
 * новых не больше `MOTION_MAX`. Первый показ (прежней ленты нет), смена окна (прежнего хвоста нет) и подгрузка
 * старых сверху — пусто.
 */
export function freshTail(prev: readonly Row[] | null, next: readonly Row[]): string[] {
  if (!prev || prev.length === 0 || next.length === 0) return [];
  const lastId = prev[prev.length - 1].id;
  const at = next.findIndex((r) => r.id === lastId);
  if (at < 0) return [];
  const added = next.slice(at + 1);
  if (added.length === 0 || added.length > MOTION_MAX) return [];
  return added.map((r) => r.id);
}

/** Удалённая на месте строка и её прежний сосед сверху (за ним её и дорисовывают на время схлопывания). */
export interface Leaving<T extends Row> {
  row: T;
  afterId: string | null;
}

/**
 * Строки, удалённые «на месте»: пропали из ленты, а выше них осталась хоть одна строка. Это удаление сообщения, а не
 * сдвиг окна ленты: при сдвиге пропадает верхний край целиком, и оставшихся над ним нет.
 * Пропало больше `MOTION_MAX` — без анимации (очистка, смена беседы).
 */
export function removedInPlace<T extends Row>(prev: readonly T[] | null, next: readonly Row[]): Leaving<T>[] {
  if (!prev || prev.length === 0 || next.length === 0) return [];
  const have = new Set(next.map((r) => r.id));
  const gone = prev.filter((r) => !have.has(r.id));
  if (gone.length === 0 || gone.length > MOTION_MAX) return [];
  const out: Leaving<T>[] = [];
  for (const row of gone) {
    const i = prev.indexOf(row);
    // За ближайшей оставшейся сверху (подряд удалённые — за одной и той же); оставшихся сверху нет — край окна, не трогаем.
    let k = i - 1;
    while (k >= 0 && !have.has(prev[k].id)) k--;
    if (k >= 0) out.push({ row, afterId: prev[k].id });
  }
  return out;
}

/** Лента с дорисованными удалёнными: каждая — сразу за своим соседом сверху; соседа уже нет — не дорисовывается. */
export function withLeaving<T extends Row>(rows: readonly T[], leaving: readonly Leaving<T>[]): T[] {
  const out: T[] = [];
  const after = new Map<string, T[]>();
  for (const g of leaving) if (g.afterId) after.set(g.afterId, [...(after.get(g.afterId) ?? []), g.row]);
  const have = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    out.push(r);
    for (const g of after.get(r.id) ?? []) if (!have.has(g.id)) out.push(g);
  }
  return out;
}
