import { isAnimatedImage } from './imageAnimation';

/**
 * Анимированный аватар за монеты (#117, этап 4) — правила приёма файла.
 *
 * 🔴 **Число кадров считается ТОЧНЫМ разбором контейнера, а не поиском байтовых меток.** Это не
 * педантизм: проверка стоит здесь против бомб распаковки — файла, где в сотню килобайт упакованы
 * тысячи кадров, и каждый зритель раскрывает их у себя в памяти. Поиск меток по файлу может и
 * недосчитать (метка попала в сжатые данные — тогда бомба проходит), и пересчитать (тогда честный
 * файл отвергается без причины). Оба формата PNG и WebP несут число кадров прямо в заголовке, а
 * GIF честно обходится по блокам — это сорок строк и никакого декодера.
 *
 * ⚠️ **Длительность НЕ ограничивается напрямую**, и это осознанно. Она складывается из задержек
 * каждого кадра, то есть требует полного обхода всех кадров ради числа, которое ничего не защищает:
 * трёхкадровая гифка с минутными паузами безобидна, а опасна именно тысяча кадров. Потолок кадров
 * заодно ограничивает и разумную длительность.
 */

/**
 * Потолок размера — 4 МБ (было 1 МБ, поднят 05.09, когда анимации начали покупать вживую).
 *
 * ⚠️ Прежний комментарий уверял, что это «вдвое больше обычного аватара», и врал: обычный аватар и
 * тогда принимался до 5 МБ. Гифка того же качества весит БОЛЬШЕ статичной картинки, а не меньше, и
 * мегабайта на приличную анимацию не хватало.
 *
 * 🔴 От бомб распаковки защищает не этот потолок, а `ANIMATED_AVATAR_MAX_FRAMES`: опасна тысяча
 * кадров в сотне килобайт, а не четыре мегабайта в тридцати кадрах. Поэтому поднимать размер
 * безопасно, а вот потолок кадров трогать нельзя.
 * ⚠️ Транспорт держит: multipart принимает 25 МБ (`index.ts`), обычный аватар — 5 МБ.
 */
export const ANIMATED_AVATAR_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Потолок кадров.
 *
 * ⚠️ Ограничивает ПАМЯТЬ зрителя, а не длину ролика: 240 кадров на 128×128 в развёрнутом виде — это
 * около 15 МБ у каждого, кто навёл мышь. Больше — уже не аватар, а видео.
 */
export const ANIMATED_AVATAR_MAX_FRAMES = 240;

/**
 * Насколько стороны могут разойтись.
 *
 * 🔴 Проверка нужна потому, что анимированный аватар НЕ обрезается: наша обрезка идёт через холст,
 * а холст убивает анимацию (остаётся один кадр). Значит либо резать покадрово на сервере — дорого и
 * требует декодера, — либо принимать почти квадратное как есть. Взято второе, и тогда допуск обязан
 * быть проверкой, а не пожеланием: широкую картинку круглая рамка обрежет по краям сама, и человек
 * получит не то, что выбирал.
 */
export const ANIMATED_AVATAR_ASPECT_TOLERANCE = 0.1;

const ANIMATED_MIME: Record<string, true> = {
  'image/gif': true,
  'image/png': true,
  'image/webp': true,
};

/** Есть ли по смещению `at` метка `tag` (ASCII). */
function tagAt(b: Uint8Array, at: number, tag: string): boolean {
  if (at + tag.length > b.length) return false;
  for (let i = 0; i < tag.length; i++) if (b[at + i] !== tag.charCodeAt(i)) return false;
  return true;
}

const u32be = (b: Uint8Array, at: number) =>
  ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const u32le = (b: Uint8Array, at: number) =>
  b[at] + (b[at + 1] << 8) + (b[at + 2] << 16) + ((b[at + 3] << 24) >>> 0);
const u16le = (b: Uint8Array, at: number) => b[at] + (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] + (b[at + 1] << 8) + (b[at + 2] << 16);

/** Размер картинки из ЗАГОЛОВКА, без декодера. `null` — заголовок не разобрался. */
export function imageSize(bytes: Uint8Array, mime: string): { w: number; h: number } | null {
  if (mime === 'image/gif') {
    // Логический экран лежит сразу за подписью `GIF87a`/`GIF89a`.
    if (bytes.length < 10 || !tagAt(bytes, 0, 'GIF8')) return null;
    return { w: u16le(bytes, 6), h: u16le(bytes, 8) };
  }
  if (mime === 'image/png') {
    // Подпись 8 байт, затем длина(4) + `IHDR`(4) + ширина(4) + высота(4), порядок старший-первым.
    if (bytes.length < 24 || !tagAt(bytes, 12, 'IHDR')) return null;
    return { w: u32be(bytes, 16), h: u32be(bytes, 20) };
  }
  if (mime === 'image/webp') {
    // Размер холста живёт только в расширенном контейнере `VP8X`; у простого WebP он внутри потока.
    if (bytes.length < 30 || !tagAt(bytes, 12, 'VP8X')) return null;
    return { w: u24le(bytes, 24) + 1, h: u24le(bytes, 27) + 1 };
  }
  return null;
}

/**
 * Сколько кадров в файле. `null` — формат не разобрался (тогда решение принимает вызывающий).
 *
 * ⚠️ `null` — это НЕ «один кадр». Разница существенная: непонятный файл нельзя молча пропустить как
 * безобидный, иначе достаточно слегка испортить заголовок, чтобы обойти потолок.
 */
export function frameCount(bytes: Uint8Array, mime: string): number | null {
  if (mime === 'image/png') return apngFrames(bytes);
  if (mime === 'image/webp') return webpFrames(bytes);
  if (mime === 'image/gif') return gifFrames(bytes);
  return null;
}

/** APNG объявляет число кадров прямо в чанке `acTL` — читаем его, а не считаем `fcTL`. */
function apngFrames(b: Uint8Array): number | null {
  let at = 8; // подпись PNG
  while (at + 8 <= b.length) {
    const len = u32be(b, at);
    if (len < 0 || at + 12 + len > b.length) return null;
    if (tagAt(b, at + 4, 'acTL')) return u32be(b, at + 8);
    // Дошли до данных изображения и не встретили `acTL` — картинка не анимирована.
    if (tagAt(b, at + 4, 'IDAT')) return 1;
    at += 12 + len; // длина + метка + данные + контрольная сумма
  }
  return null;
}

/** У WebP каждый кадр — отдельный чанк `ANMF` в контейнере RIFF. */
function webpFrames(b: Uint8Array): number | null {
  if (b.length < 12 || !tagAt(b, 0, 'RIFF') || !tagAt(b, 8, 'WEBP')) return null;
  let at = 12;
  let frames = 0;
  while (at + 8 <= b.length) {
    const len = u32le(b, at + 4);
    if (len < 0) return null;
    if (tagAt(b, at, 'ANMF')) frames += 1;
    // Чанки RIFF выровнены по чётной границе — нечётная длина добирается байтом-заполнителем.
    at += 8 + len + (len % 2);
  }
  return frames > 0 ? frames : 1;
}

/**
 * GIF обходится по блокам: числа кадров в заголовке нет.
 *
 * ⚠️ Обход честный, а не поиск метки: последовательность `0x21 0xF9` встречается и внутри сжатых
 * данных, и подсчёт по ней врал бы в обе стороны — то пропуская бомбу, то отвергая нормальный файл.
 */
function gifFrames(b: Uint8Array): number | null {
  if (b.length < 13 || !tagAt(b, 0, 'GIF8')) return null;
  let at = 13;
  // Глобальная палитра, если объявлена флагом в байте 10.
  if (b[10] & 0x80) at += 3 * (1 << ((b[10] & 0x07) + 1));

  /** Пропустить цепочку под-блоков: каждый начинается длиной, ноль завершает цепочку. */
  const skipSubBlocks = (): boolean => {
    while (at < b.length) {
      const n = b[at];
      at += 1;
      if (n === 0) return true;
      at += n;
    }
    return false;
  };

  let frames = 0;
  while (at < b.length) {
    const marker = b[at];
    if (marker === 0x3b) break; // конец файла
    if (marker === 0x21) {
      // Блок расширения: метка, затем под-блоки.
      at += 2;
      if (!skipSubBlocks()) return null;
      continue;
    }
    if (marker === 0x2c) {
      // Описание изображения = КАДР. Девять байт, затем локальная палитра, затем данные.
      if (at + 10 > b.length) return null;
      const packed = b[at + 9];
      at += 10;
      if (packed & 0x80) at += 3 * (1 << ((packed & 0x07) + 1));
      at += 1; // минимальный размер кода LZW
      if (!skipSubBlocks()) return null;
      frames += 1;
      continue;
    }
    return null; // непонятный маркер — честнее не гадать
  }
  return frames > 0 ? frames : null;
}

export type AnimatedAvatarCheck = { ok: true; frames: number } | { ok: false; error: string };

/**
 * Можно ли принять этот файл как анимированный аватар.
 *
 * 🔴 Проверки идут от дешёвых к дорогим и от общих к частным, и порядок — часть правила: сперва тип
 * и размер (они отсекают почти всё), потом «а анимирован ли вообще» (иначе купивший загрузил бы
 * обычную картинку и решил, что покупка не работает), и только потом разбор кадров.
 */
export function checkAnimatedAvatar(mime: string, bytes: Uint8Array): AnimatedAvatarCheck {
  if (!ANIMATED_MIME[mime]) return { ok: false, error: 'нужен GIF, APNG или анимированный WebP' };
  if (bytes.length === 0) return { ok: false, error: 'пустой файл' };
  if (bytes.length > ANIMATED_AVATAR_MAX_BYTES) {
    return { ok: false, error: `файл больше ${Math.round(ANIMATED_AVATAR_MAX_BYTES / 1024 / 1024)} МБ` };
  }
  if (!isAnimatedImage(bytes, mime)) {
    return { ok: false, error: 'эта картинка не анимирована — обычный аватар ставится как обычно' };
  }

  const size = imageSize(bytes, mime);
  if (!size || size.w <= 0 || size.h <= 0) return { ok: false, error: 'не удалось прочитать размер картинки' };
  const ratio = size.w / size.h;
  if (Math.abs(ratio - 1) > ANIMATED_AVATAR_ASPECT_TOLERANCE) {
    // ⚠️ Говорим ПОЧЕМУ и что делать: анимацию мы не обрезаем, и без объяснения отказ выглядит
    // придиркой к файлу, который «нормально открывается».
    return { ok: false, error: 'нужна почти квадратная: анимацию мы не обрезаем, и круглая рамка срежет края' };
  }

  const frames = frameCount(bytes, mime);
  if (frames === null) return { ok: false, error: 'не удалось разобрать кадры — попробуйте пересохранить файл' };
  if (frames > ANIMATED_AVATAR_MAX_FRAMES) {
    return { ok: false, error: `слишком много кадров (${frames}), предел — ${ANIMATED_AVATAR_MAX_FRAMES}` };
  }
  return { ok: true, frames };
}
