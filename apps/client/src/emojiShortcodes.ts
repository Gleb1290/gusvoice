/**
 * Публичный API шорткодов эмодзи: поиск, автозамена `:код:`, подсказка «как набрать».
 *
 * Слоёв три, и они намеренно разделены:
 *  - `emojiAliases.ts` — рукописные РУССКИЕ алиасы (`:огонь`, `:лайк`), доступны мгновенно;
 *  - `emojiData.ts` — юникодная таблица на 1914 эмодзи, грузится ЛЕНИВО через `emojiIndex.ts`;
 *  - `emojiSearch.ts` — чистое ранжирование, без данных и без React.
 *
 * Вызывающему всё равно, загрузилась таблица или нет: до загрузки отвечает рукописный набор,
 * после — полный. Пустой выдачи в момент печати не бывает.
 */
export { EMOJI_SHORTCODES, type EmojiEntry } from './emojiAliases';

import { EMOJI_SHORTCODES, type EmojiEntry } from './emojiAliases';
import { loadedIndex, searchEmojiNow } from './emojiIndex';
import { codeForEmojiIn, emojiByCode, stripVs } from './emojiSearch';

const BY_EMOJI = new Map(EMOJI_SHORTCODES.map((e) => [stripVs(e.emoji), e.codes[0]]));

/**
 * Код для подсказки «как это набрать»: сначала свой русский алиас, потом английский из таблицы.
 *
 * `null` — когда кода нет вовсе (таблица ещё не приехала, а в рукописном наборе эмодзи нет).
 * Тогда подсказка молчит: пообещать `:код:`, которого не существует, хуже, чем не обещать ничего.
 */
export function codeForEmoji(emoji: string): string | null {
  const mine = BY_EMOJI.get(stripVs(emoji));
  if (mine) return mine;
  const idx = loadedIndex();
  return idx ? codeForEmojiIn(idx.all, emoji) : null;
}

/** Точный код → эмодзи, для автозамены в композере. Свои алиасы имеют приоритет. */
export function emojiForCode(code: string): string | null {
  const q = code.toLowerCase();
  const mine = EMOJI_SHORTCODES.find((e) => e.codes.some((c) => c.toLowerCase() === q));
  if (mine) return mine.emoji;
  const idx = loadedIndex();
  return idx ? emojiByCode(idx.all, code) : null;
}

/**
 * Подсказки для `:запроса` — ищет и по русским названиям («огонь»), и по английским кодам
 * (`fire`), по всему набору, как только он загружен. Заодно запускает догрузку таблицы.
 */
export function searchEmoji(query: string, limit = 8): EmojiEntry[] {
  return searchEmojiNow(query, limit).map((e) => ({ emoji: e.emoji, codes: e.codes }));
}

/** Код, который показываем рядом с подсказкой — первый, совпавший с набранным. */
export function primaryCode(e: EmojiEntry, query: string): string {
  const q = query.toLowerCase();
  return (
    e.codes.find((c) => c.toLowerCase().startsWith(q)) ??
    e.codes.find((c) => c.toLowerCase().includes(q)) ??
    e.codes[0]
  );
}
