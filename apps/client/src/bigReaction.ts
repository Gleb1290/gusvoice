/**
 * «Большая» реакция удержанием (08.10, #211, G43, решение владельца п.11 «как TG»; признак сервера `bigreact1`).
 *
 * Telegram Android (`ReactionsContainerLayout`): палец держит реакцию в полосе — через `getLongPressTimeout` (400 мс) она
 * начинает расти (`pressedProgress` += 16/1500 за кадр: масштаб 1 → 3, соседи 1 → 0,85), дорос до конца — уходит «большой»
 * сама; отпустил, когда выросла больше чем на 0,8, — тоже «большая»; отпустил раньше — ничего (реакция сжимается обратно).
 * Сдвиг пальца дальше порога касания — отмена. Отправитель и тот, у кого сообщение на экране, видят крупный эмодзи поверх
 * ленты (`ReactionsEffectOverlay.LONG_ANIMATION`). Чистые правила — здесь; разметка — `ReactionBar`, эффект — `BigReactionLayer`.
 */

/** Сколько держать, пока реакция не начнёт расти (Android `ViewConfiguration.getLongPressTimeout`). */
export const BIG_HOLD_DELAY_MS = 400;
/** За сколько реакция дорастает до конца после начала роста (Android: 16/1500 за кадр). */
export const BIG_GROW_MS = 1500;
/** С какой доли роста отпускание даёт «большую» (Android `pressedProgress > 0.8f`). */
export const BIG_RELEASE_AT = 0.8;
/** Сдвиг указателя, после которого удержание отменяется (px; Android `touchSlop` ≈ 8 dp). */
export const BIG_MOVE_SLOP_PX = 10;
/** Сколько длится крупная анимация поверх ленты (мс; эффект Telegram ≈ 3 с, наш без частиц короче). */
export const BIG_EFFECT_MS = 2000;

/** Доля роста по времени удержания: 0 до начала роста, 1 — дорос. */
export function bigHoldProgress(heldMs: number): number {
  if (!(heldMs > BIG_HOLD_DELAY_MS)) return 0;
  return Math.min(1, (heldMs - BIG_HOLD_DELAY_MS) / BIG_GROW_MS);
}

/**
 * Чем кончилось нажатие по реакции в полосе:
 * - `click` — отпустили до начала роста: обычная реакция (как простое нажатие);
 * - `cancel` — рост начался, но отпустили раньше `BIG_RELEASE_AT`, либо указатель ушёл / нажатие сорвалось: ничего;
 * - `big` — дорос до конца (`released: false`) или отпустили после `BIG_RELEASE_AT`;
 * - `pending` — ещё держат и не доросло.
 */
export type BigHoldOutcome = 'click' | 'cancel' | 'big' | 'pending';

export function bigHoldOutcome(heldMs: number, released: boolean, aborted = false): BigHoldOutcome {
  const p = bigHoldProgress(heldMs);
  if (aborted) return 'cancel';
  if (!released) return p >= 1 ? 'big' : 'pending';
  if (p === 0) return 'click';
  return p > BIG_RELEASE_AT ? 'big' : 'cancel';
}

/** Условия показа крупной анимации — снимает `BigReactionLayer` по живой обстановке. */
export type BigEffectConditions = {
  /** Вкладка скрыта / окно свёрнуто. */
  tabHidden: boolean;
  /** `prefers-reduced-motion: reduce`. */
  reducedMotion: boolean;
  /** Лёгкий режим (`liteMode.ts`). */
  lite: boolean;
  /** Эта беседа открыта сейчас. */
  convOpen: boolean;
  /** Сообщение на экране (пересекает видимую часть ленты). */
  onScreen: boolean;
};

/**
 * Играть ли крупную анимацию. Реакция ставится в любом случае — здесь решается только эффект. Движение человек просил
 * убрать (`reducedMotion`) или включил лёгкий режим — не играем вовсе (как перья: убираем движение, а не время).
 */
export function shouldPlayBigEffect(c: BigEffectConditions): boolean {
  if (c.tabHidden || c.reducedMotion || c.lite) return false;
  return c.convOpen && c.onScreen;
}
