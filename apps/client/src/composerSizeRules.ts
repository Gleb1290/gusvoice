/**
 * Потолок роста поля ввода (разведка наплывов 09.10): постоянные 200 px в ландшафте телефона (740×360) съедали экран —
 * лента сжималась до полоски, а со вставками кнопки «Отправить» / «+» / эмодзи уходили под панель навигации.
 *
 * Правило — как у Telegram: потолок зависит от высоты окна. tweb `components/richMessageInput/index.tsx` (`syncHeight`):
 * телефон — 160 px, низкое окно (≤ 480) — `max(36, высота − 32 − 160)`, иначе 440; Android `ChatActivityEnterView` —
 * `setMaxLines(6)`. У нас: прежние 200 px (примерно восемь строк), но не больше 35 % доступной высоты (видимое окно без
 * системных вставок — клавиатура и поворот её меняют) и не меньше двух строк.
 */
export const COMPOSER_MAX_PX = 200;
/** Доля доступной высоты, выше которой поле не растёт. */
export const COMPOSER_MAX_SHARE = 0.35;
/** Нижняя граница потолка: две строки поля (строка 20 px + поля), чтобы на совсем низком окне поле не схлопнулось. */
export const COMPOSER_MIN_CAP_PX = 56;

/** Потолок высоты поля для доступной высоты `availH` (вёрсточные px). Не число / ≤ 0 — прежние 200. */
export function composerMaxPx(availH: number): number {
  if (!Number.isFinite(availH) || availH <= 0) return COMPOSER_MAX_PX;
  return Math.min(COMPOSER_MAX_PX, Math.max(COMPOSER_MIN_CAP_PX, Math.round(availH * COMPOSER_MAX_SHARE)));
}
