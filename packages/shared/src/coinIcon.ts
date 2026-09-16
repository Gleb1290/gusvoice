import { isAnimatedImage } from './imageAnimation';

/**
 * Иконка валюты сервера (#117) — правила приёма файла.
 *
 * Картинка рисуется **14 пикселями** в чипе баланса и висит в шапке у всех участников постоянно,
 * поэтому требования жёстче, чем к аватару или эмодзи.
 */

/** Файл больше этого не примем: на 14 пикселей столько не нужно ни при какой детализации. */
export const COIN_ICON_MAX_BYTES = 128 * 1024;

/**
 * Допустимые типы.
 *
 * ⚠️ SVG нет и не будет: это исполняемый документ, а не картинка, и путь для него — тот же, что для
 * любого чужого HTML. Правило уже принято по превью показа (#115), повторяем осознанно.
 */
const COIN_ICON_MIME: Record<string, true> = {
  'image/png': true,
  'image/webp': true,
};

export type CoinIconCheck = { ok: true } | { ok: false; error: string };

/**
 * Можно ли принять этот файл как иконку валюты.
 *
 * 🔴 Анимацию отвергаем, и это не вкусовщина: иконку выбирает ОДИН человек, а дёргается она в шапке
 * у всех и весь вечер. Проверяем по содержимому — тип файла про анимацию не говорит ничего
 * (`isAnimatedImage`).
 */
export function checkCoinIcon(mime: string, bytes: Uint8Array): CoinIconCheck {
  if (!COIN_ICON_MIME[mime]) return { ok: false, error: 'нужен PNG или WebP' };
  if (bytes.length === 0) return { ok: false, error: 'пустой файл' };
  if (bytes.length > COIN_ICON_MAX_BYTES)
    return { ok: false, error: `файл больше ${Math.round(COIN_ICON_MAX_BYTES / 1024)} КБ` };
  if (isAnimatedImage(bytes, mime))
    return { ok: false, error: 'анимированную нельзя: значок висит в шапке у всех и будет мешать' };
  return { ok: true };
}
