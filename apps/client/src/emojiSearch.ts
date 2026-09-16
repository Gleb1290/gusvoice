/**
 * Поиск и ранжирование эмодзи — ЧИСТОЕ, без данных, без стора, без React (#68).
 *
 * Отдельным файлом сразу, а не после падения теста: это пятый случай в проекте
 * (`ogParse`, `afkRules`, `pollRules`, `memberNameRules`). Правило: считает — живёт отдельно.
 */

export type Emoji = {
  emoji: string;
  /** Название по-русски — по нему и ищут («огонь» → 🔥). */
  label: string;
  group: number;
  /** Ключевые слова по-русски. */
  tags: string[];
  /** Шорткоды для набора `:code:` — английские плюс наши рукописные русские алиасы. */
  codes: string[];
  /** Варианты тона кожи, если эмодзи их поддерживает. */
  skins?: string[];
};

/**
 * Приклеить рукописные алиасы к таблице.
 *
 * Наши коды идут ПЕРВЫМИ в списке: `codes[0]` показывается в подсказке «как набрать», и для
 * русскоязычной компании `:огонь` полезнее, чем `:fire:`. Английские остаются рядом — мышечная
 * память из Discord никуда не делась.
 */
export function mergeAliases(entries: Emoji[], aliases: Map<string, string[]>): Emoji[] {
  if (aliases.size === 0) return entries;
  return entries.map((e) => {
    const mine = aliases.get(stripVs(e.emoji));
    if (!mine) return e;
    const rest = e.codes.filter((c) => !mine.includes(c));
    return { ...e, codes: [...mine, ...rest] };
  });
}

/** VS16 (`️`) не меняет символ, но ломает сравнение: `✌️` и `✌` — одно и то же эмодзи. */
export const stripVs = (e: string): string => e.replace(/️/g, '');

/**
 * Ранжированный поиск. Порядок ступеней важнее самих ступеней: человек, набравший «огонь»,
 * ждёт 🔥 первым, а не 🧯 с тегом «огонь» где-то в середине.
 */
export function rankEmoji(entries: Emoji[], query: string, limit = 40): Emoji[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice(0, limit);

  const buckets: Emoji[][] = [[], [], [], [], []];
  for (const e of entries) {
    const codes = e.codes.map((c) => c.toLowerCase());
    const label = e.label.toLowerCase();
    const tags = e.tags.map((t) => t.toLowerCase());

    if (codes.includes(q) || label === q) buckets[0].push(e);
    else if (codes.some((c) => c.startsWith(q))) buckets[1].push(e);
    else if (label.startsWith(q)) buckets[2].push(e);
    else if (tags.some((t) => t.startsWith(q))) buckets[3].push(e);
    else if (label.includes(q) || codes.some((c) => c.includes(q)) || tags.some((t) => t.includes(q)))
      buckets[4].push(e);

    // Ранний выход только когда точных совпадений уже больше лимита: обрывать раньше нельзя,
    // иначе точное совпадение, лежащее в конце таблицы, не попадёт в выдачу вовсе.
    if (buckets[0].length >= limit) break;
  }
  return buckets.flat().slice(0, limit);
}

/** Точный код → эмодзи, для автозамены `:код:` в композере. Регистр не важен. */
export function emojiByCode(entries: Emoji[], code: string): string | null {
  const q = code.toLowerCase();
  for (const e of entries) if (e.codes.some((c) => c.toLowerCase() === q)) return e.emoji;
  return null;
}

/** Какой код показать для эмодзи в подсказке «как это набрать». */
export function codeForEmojiIn(entries: Emoji[], emoji: string): string | null {
  const key = stripVs(emoji);
  for (const e of entries) if (stripVs(e.emoji) === key) return e.codes[0] ?? null;
  return null;
}

/**
 * Применить тон кожи. Эмодзи без вариантов возвращается как есть — вызывающему не нужно
 * проверять поддержку, а тон, молча применённый не к тому символу, дал бы кракозябру.
 */
export function withSkinTone(e: Emoji, tone: number): string {
  if (!e.skins || tone <= 0 || tone > e.skins.length) return e.emoji;
  return e.skins[tone - 1];
}
