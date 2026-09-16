/**
 * Генератор таблицы эмодзи: emojibase-data (ru) → src/emojiData.ts
 *
 * Запуск: `node scripts/gen-emoji.mjs` (или `pnpm run gen:emoji`).
 *
 * Почему генерируем в файл, а не тянем пакет в рантайме:
 *  - `emojibase-data` весит ~900 КБ в исходном виде, а нам нужны 4 поля из десяти;
 *  - результат лежит в репозитории → сборка воспроизводима и не зависит от npm;
 *  - пакет остаётся В DEV-зависимостях, в бандл не попадает вовсе.
 *
 * Почему РУССКАЯ локаль: искать «огонь» должно находить 🔥 по всему набору, а не только по нашим
 * рукописным алиасам. Английский датасет дал бы поиск только для тех, кто печатает `fire`.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const data = require('emojibase-data/ru/data.json');
/**
 * Шорткоды берём АНГЛИЙСКИЕ, хотя названия и поиск — русские. Русский набор у emojibase — это
 * транслитерация (`vosklicatelnyy_i_voprositelnyy_znaki`), печатать такое никто не станет.
 * Разделение получается естественным: ищешь по-русски («огонь»), набираешь по-привычному
 * (`:fire:`, как в Discord). А рукописные русские алиасы (`:огонь`) живут отдельным слоем
 * в emojiShortcodes.ts и имеют приоритет.
 */
const shortcodes = require('emojibase-data/en/shortcodes/emojibase.json');

/**
 * Свои подписи групп: у emojibase они дословные и по-русски звучат странно
 * («тело людей», «путешествия и местности»). Ключ — номер группы в датасете.
 * Группы 2 (component — сами модификаторы тона) и без номера пропускаем: в сетке им не место.
 */
const GROUPS = [
  [0, 'Смайлы'],
  [1, 'Люди и жесты'],
  [3, 'Животные и природа'],
  [4, 'Еда и напитки'],
  [5, 'Путешествия'],
  [6, 'Активности'],
  [7, 'Предметы'],
  [8, 'Символы'],
  [9, 'Флаги'],
];

const groupIndex = new Map(GROUPS.map(([num], i) => [num, i]));

/**
 * 🔴 Убрать ИЗБЫТОЧНЫЙ VS16 (`U+FE0F`).
 *
 * emojibase хранит `👍️` — с вариационным селектором. Клавиатуры, старый рукописный набор и уже
 * проставленные в базе реакции хранят `👍` — без него. Реакции ключуются строкой, поэтому
 * расхождение раскололо бы одно эмодзи на ДВЕ одинаковые с виду плашки. Проверено на живых
 * данных: из 51 ходового эмодзи форма менялась у 13, включая 👍 и ✅.
 *
 * Убирать можно ТОЛЬКО у `type === 1` — тех, что по умолчанию и так рисуются цветными.
 * У `type === 0` (✌ ❤ ⚠ — их 207) селектор обязателен: без него символ станет чёрно-белым
 * текстовым глифом. Слепой `strip` сломал бы ровно их.
 */
const canon = (s, type) => (type === 1 ? s.replace(/️/g, '') : s);

const rows = [];
for (const e of data) {
  const gi = groupIndex.get(e.group);
  if (gi === undefined) continue; // компоненты и записи без группы — мимо
  if (!e.emoji || !e.label) continue;

  // Теги — это ключевые слова для поиска. Дубли с названием выкидываем: оно и так ищется.
  const tags = (e.tags ?? []).filter((t) => t && t !== e.label);
  // Варианты тона кожи. Держим только сами символы: тон определяется позицией в массиве.
  const skins = (e.skins ?? [])
    .filter((s) => s.tone && !Array.isArray(s.tone))
    .map((s) => canon(s.emoji, s.type ?? e.type));

  const sc = shortcodes[e.hexcode];
  const codes = (Array.isArray(sc) ? sc : sc ? [sc] : []).filter(Boolean);

  rows.push({ emoji: canon(e.emoji, e.type), label: e.label, gi, order: e.order ?? 0, tags, codes, skins });
}

rows.sort((a, b) => (a.gi - b.gi) || (a.order - b.order));

const j = JSON.stringify;
const body = rows
  .map((r) => {
    const parts = [j(r.emoji), j(r.label), String(r.gi), j(r.tags), j(r.codes)];
    if (r.skins.length) parts.push(j(r.skins));
    return `[${parts.join(',')}]`;
  })
  .join(',\n');

const out = `/* eslint-disable */
// СГЕНЕРИРОВАНО \`scripts/gen-emoji.mjs\` из emojibase-data (ru). РУКАМИ НЕ ПРАВИТЬ.
// Пересобрать: pnpm --filter @gusvoice/client run gen:emoji
//
// Модуль грузится ЛЕНИВО (динамическим импортом из emojiIndex.ts) — в стартовый бандл не попадает.
// Формат кортежа выбран ради размера: объекты с ключами раздули бы файл вдвое.

/** [эмодзи, название (ru), индекс группы, ключевые слова (ru), шорткоды (en), тона кожи?] */
export type RawEmoji = [string, string, number, string[], string[], string[]?];

export const EMOJI_GROUPS: string[] = ${j(GROUPS.map(([, label]) => label))};

export const EMOJI_DATA: RawEmoji[] = [
${body}
];
`;

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'src', 'emojiData.ts');
writeFileSync(target, out, 'utf8');

const withSkins = rows.filter((r) => r.skins.length).length;
console.log(`эмодзи: ${rows.length}, с тонами кожи: ${withSkins}, групп: ${GROUPS.length}`);
console.log(`записано: ${target} (${(out.length / 1024).toFixed(0)} КБ)`);
