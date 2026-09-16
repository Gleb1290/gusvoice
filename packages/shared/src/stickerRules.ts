/**
 * Правила импорта стикеров из Telegram (#68, часть 2) — ЧИСТЫЕ, без сети и без базы.
 *
 * Живут в `shared`, потому что нужны обеим сторонам: клиент разбирает то, что человек вставил в
 * поле, и показывает ошибку до запроса; сервер обязан проверить то же самое сам — имя набора едет
 * в URL к api.telegram.org, и пускать туда произвольную строку нельзя.
 */

/** Форматы, которые отдаёт Telegram. Больше ничего мы не принимаем. */
export type StickerFormat = 'webp' | 'tgs' | 'webm';

/** Сколько наборов разрешено одному серверу. У self-hosters диск не резиновый. */
export const STICKER_PACKS_PER_SERVER = 12;
/** Потолок на набор — столько же, сколько максимум у Telegram. */
export const STICKERS_PER_PACK = 120;
/**
 * Потолок размера одного стикера. Telegram держит `.webm` в пределах 256 КБ, `.tgs` — 64 КБ,
 * `.webp` — 512 КБ; берём самый большой из них с запасом, чтобы не отсекать легальные файлы.
 */
export const STICKER_MAX_BYTES = 768 * 1024;

/**
 * Имя набора у Telegram: латиница, цифры и подчёркивания, начинается с буквы, до 64 символов.
 *
 * Это НЕ косметика: имя подставляется в путь запроса к Bot API. Без якорей и белого списка сюда
 * пролезет что угодно вида `../../`, и наш сервер начнёт ходить по чужим адресам за наш счёт.
 */
const SET_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type SetNameCheck = { ok: true; name: string } | { ok: false; error: string };

/**
 * Достать имя набора из того, что человек вставил.
 *
 * Принимаем и голое имя, и ссылку — в Telegram «поделиться набором» даёт именно ссылку, и
 * заставлять вырезать из неё имя руками означает гарантированные ошибки при вводе.
 */
export function parseStickerSetName(raw: string): SetNameCheck {
  const input = raw.trim();
  if (!input) return { ok: false, error: 'вставьте ссылку на набор или его имя' };

  // https://t.me/addstickers/NAME · t.me/addstickers/NAME · tg://addstickers?set=NAME
  const fromLink =
    input.match(/(?:t\.me|telegram\.me)\/addstickers\/([^/?#\s]+)/i)?.[1] ??
    input.match(/addstickers\?set=([^&\s]+)/i)?.[1];
  const name = fromLink ?? input;

  if (!SET_NAME_RE.test(name)) {
    // Отдельная подсказка на «похоже на ссылку, но не на набор» — иначе человек будет гадать,
    // почему ссылка на канал не сработала.
    if (/t\.me|telegram\.me|https?:/i.test(input))
      return { ok: false, error: 'это не ссылка на набор стикеров (нужна вида t.me/addstickers/…)' };
    return { ok: false, error: 'имя набора: латиница, цифры и подчёркивание, начиная с буквы' };
  }
  return { ok: true, name };
}

/**
 * Формат стикера по пути файла из Bot API.
 *
 * Определяем по расширению, а не по MIME: `getFile` отдаёт только `file_path`, MIME в ответе нет.
 */
export function stickerFormatFromPath(path: string): StickerFormat | null {
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'webp' || ext === 'png') return 'webp';
  if (ext === 'tgs') return 'tgs';
  if (ext === 'webm') return 'webm';
  return null;
}

/** MIME для заливки в бакет — по формату, потому что от Telegram его не приходит. */
export const STICKER_MIME: Record<StickerFormat, string> = {
  // `.tgs` — это gzip'нутый JSON. Отдаём как gzip, чтобы промежуточные прокси его не «помогли» распаковать.
  tgs: 'application/gzip',
  webm: 'video/webm',
  webp: 'image/webp',
};

export type PackCheck = { ok: true } | { ok: false; error: string };

/** Можно ли принять набор такого размера при таком количестве уже импортированных. */
export function checkPackImport(stickerCount: number, existingPacks: number): PackCheck {
  if (stickerCount <= 0) return { ok: false, error: 'в наборе нет стикеров' };
  if (stickerCount > STICKERS_PER_PACK)
    return { ok: false, error: `в наборе больше ${STICKERS_PER_PACK} стикеров` };
  if (existingPacks >= STICKER_PACKS_PER_SERVER)
    return { ok: false, error: `на сервере уже ${STICKER_PACKS_PER_SERVER} наборов — удалите лишние` };
  return { ok: true };
}
