/**
 * Правила кастомных эмодзи сервера (#18) — ЧИСТЫЕ, без базы и без хранилища.
 *
 * Живут в `shared`, потому что нужны ОБЕИМ сторонам: клиент не должен давать нажать «Загрузить»
 * с заведомо плохим именем, а сервер обязан проверить то же самое сам — клиентская проверка это
 * удобство, а не защита.
 */

/** Ключ реакции для кастомного эмодзи. Смысл префикса — в `isCustomReaction`. */
export const CUSTOM_PREFIX = 'custom:';

export const EMOJI_NAME_MIN = 2;
export const EMOJI_NAME_MAX = 32;
/** Сколько эмодзи разрешено одному серверу. У self-hosters диск не резиновый. */
export const EMOJI_PER_SERVER = 100;
/** Потолок размера файла. 256 КБ — столько же, сколько у видео-стикеров Телеграма. */
export const EMOJI_MAX_BYTES = 256 * 1024;

export const EMOJI_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Имя эмодзи: строчные латинские буквы, цифры и подчёркивание.
 *
 * Почему не кириллица, хотя интерфейс русский: имя набирается как `:имя:` внутри сообщения, а
 * рядом уже живёт автозамена юникодных шорткодов. Смешивать раскладки в одном синтаксисе — верный
 * способ получить `:огонь:`, который иногда эмодзи сервера, а иногда 🔥, в зависимости от того,
 * что нашлось первым.
 */
const NAME_RE = /^[a-z0-9_]+$/;

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

/** Привести и проверить имя. Возвращает УЖЕ приведённое имя — вызывающему не надо повторять. */
export function checkEmojiName(raw: string): NameCheck {
  const name = raw.trim().toLowerCase().replace(/^:+|:+$/g, '');
  if (name.length < EMOJI_NAME_MIN) return { ok: false, error: `имя короче ${EMOJI_NAME_MIN} символов` };
  if (name.length > EMOJI_NAME_MAX) return { ok: false, error: `имя длиннее ${EMOJI_NAME_MAX} символов` };
  if (!NAME_RE.test(name))
    return { ok: false, error: 'только латинские строчные буквы, цифры и подчёркивание' };
  return { ok: true, name };
}

/**
 * Предложить имя по имени файла: `Party Parrot (1).GIF` → `party_parrot_1`.
 *
 * Это только заготовка для поля ввода, а не готовое имя: русское имя файла даст пустую строку,
 * и человек впишет своё. Итог в любом случае проходит `checkEmojiName`.
 */
export function suggestEmojiName(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, EMOJI_NAME_MAX)
    .replace(/_+$/, '');
}

export type UploadCheck = { ok: true } | { ok: false; error: string };

/** Можно ли принять этот файл как эмодзи. */
export function checkEmojiUpload(mime: string, bytes: number, existingCount: number): UploadCheck {
  if (!EMOJI_MIME[mime]) return { ok: false, error: 'нужен PNG, GIF или WebP' };
  if (bytes <= 0) return { ok: false, error: 'пустой файл' };
  if (bytes > EMOJI_MAX_BYTES)
    return { ok: false, error: `файл больше ${Math.round(EMOJI_MAX_BYTES / 1024)} КБ` };
  if (existingCount >= EMOJI_PER_SERVER)
    return { ok: false, error: `на сервере уже ${EMOJI_PER_SERVER} эмодзи — удалите лишние` };
  return { ok: true };
}

/**
 * Реакция кастомным эмодзи ключуется `custom:<id>`, а НЕ `:имя:`.
 *
 * По id, потому что имя меняемо: после переименования уже проставленные реакции по имени осиротели
 * бы и разъехались на две плашки. Плюс `custom:` не может совпасть с юникодным символом, тогда как
 * `:имя:` — вполне себе обычный текст.
 */
export function customReactionKey(emojiId: string): string {
  return CUSTOM_PREFIX + emojiId;
}

/** Id кастомного эмодзи из ключа реакции, либо null для обычного юникодного. */
export function customReactionId(key: string): string | null {
  return key.startsWith(CUSTOM_PREFIX) ? key.slice(CUSTOM_PREFIX.length) : null;
}

/**
 * Найти `:имена:` в тексте сообщения — для подстановки картинок при отрисовке.
 *
 * ⚠️ Перед открывающим двоеточием обязан стоять НЕ буквенно-цифровой символ и не двоеточие.
 * Без этого `10:30:00` разбирается как эмодзи `:30:`, а `http://host:8080:` — как `:8080:`.
 * Ровно эта защита уже стоит в автозамене шорткодов композера; здесь её пришлось повторить,
 * и тест поймал её отсутствие с первого прогона.
 */
const NAME_IN_TEXT = /(?<![\w:]):([a-z0-9_]{2,32}):/g;

export function extractEmojiNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(NAME_IN_TEXT)) out.add(m[1]);
  return [...out];
}
