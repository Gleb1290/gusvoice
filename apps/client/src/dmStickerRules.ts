import type { Sticker } from '@gusvoice/shared';
import { FEATURE_STICKERS2, FEATURE_STICKERS3 } from '@gusvoice/shared';

/**
 * Чистые правила стикеров в ЛС (С2, #211, признак `stickers2`). Состояние — `dmStickers.ts`, панель — `StickerPicker.tsx`.
 */

/** Сервер умеет стикеры в ЛС (каталог инстанса, «мои наборы», `stickerId` в отправке беседы). */
export function serverDmStickers(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_STICKERS2);
}

/** Сколько недавних стикеров помнит панель (у Telegram на ПК — по конфигу сервера, у нас — как ряд из четырёх × 5). */
export const RECENT_STICKERS_MAX = 20;

/**
 * Недавние после отправки `s`: он встаёт первым, его прежняя копия уходит, список режется до `max`. Одинаковым считается
 * стикер с той же картинкой — у копий одного набора в каталоге и на сервере id разные, а картинка одна.
 */
export function pushRecentSticker(list: readonly Sticker[], s: Sticker, max = RECENT_STICKERS_MAX): Sticker[] {
  return [s, ...list.filter((x) => x.url !== s.url)].slice(0, Math.max(0, max));
}

/** Разбор недавних из `localStorage`: всё, что не похоже на стикер, отбрасывается (данные чужой версии клиента). */
export function parseRecentStickers(raw: string | null): Sticker[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (x): x is Sticker =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as Sticker).id === 'string' &&
        typeof (x as Sticker).url === 'string' &&
        ['webp', 'tgs', 'webm'].includes((x as Sticker).format),
    )
    .map((x) => ({ id: x.id, url: x.url, format: x.format, emoji: typeof x.emoji === 'string' ? x.emoji : '' }))
    .slice(0, RECENT_STICKERS_MAX);
}

/** Сдвинуть набор в списке на шаг вверх (`-1`) или вниз (`1`); на краю или без такого id — список как был (копией). */
export function moveStickerPack(ids: readonly string[], id: string, dir: -1 | 1): string[] {
  const out = [...ids];
  const i = out.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Подпись кнопки окна набора — как у Telegram: «Добавить 24 стикера» / «Убрать 24 стикера». */
export function stickerPackButton(count: number, mine: boolean): string {
  const a = count % 10;
  const b = count % 100;
  const word = a === 1 && b !== 11 ? 'стикер' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'стикера' : 'стикеров';
  return `${mine ? 'Убрать' : 'Добавить'} ${count} ${word}`;
}

/** «N стикеров» под названием набора в каталоге. */
export function stickerCountLabel(count: number): string {
  return stickerPackButton(count, false).replace(/^Добавить /, '');
}
/** Сервер держит избранные и недавние стикеры (С2 порция 2, `stickers3`): синхронно на всех устройствах. */
export function serverStickerLists(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_STICKERS3);
}

/** Стикер в избранных — тот же id или та же картинка (у копий набора на сервере и в каталоге id разные). */
export function isFavedSticker(faved: readonly Sticker[], s: Pick<Sticker, 'id' | 'url'>): boolean {
  return faved.some((x) => x.id === s.id || x.url === s.url);
}

/** Эмодзи без селекторов вида (U+FE0F/FE0E) и без тона кожи: «❤️» и «❤», «👍🏻» и «👍» — одно и то же для подбора стикеров. */
export function bareEmoji(e: string): string {
  return e.replace(/[\u{FE0E}\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu, '');
}

/** Сколько стикеров в ленте подсказки по эмодзи. */
export const SUGGEST_STICKERS_MAX = 40;

/**
 * Подсказка стикеров по одному эмодзи в пустом поле (tdesktop `field_autocomplete.cpp`, «Suggest stickers by emoji»):
 * подходят стикеры, чья подпись-эмодзи содержит это эмодзи; порядок — избранные, недавние, затем мои наборы по порядку;
 * одна картинка — один раз. Только установленное (избранные, недавние, мои наборы) — как у Telegram без Premium.
 */
export function stickersForEmoji(
  emoji: string,
  sources: { faved?: readonly Sticker[]; recent?: readonly Sticker[]; packs?: readonly { stickers: readonly Sticker[] }[] },
  max = SUGGEST_STICKERS_MAX,
): Sticker[] {
  const want = bareEmoji(emoji.trim());
  if (!want) return [];
  const out: Sticker[] = [];
  const seen = new Set<string>();
  const take = (s: Sticker) => {
    if (out.length >= max || seen.has(s.url) || !bareEmoji(s.emoji).includes(want)) return;
    seen.add(s.url);
    out.push(s);
  };
  for (const s of sources.faved ?? []) take(s);
  for (const s of sources.recent ?? []) take(s);
  for (const p of sources.packs ?? []) for (const s of p.stickers) take(s);
  return out;
}
