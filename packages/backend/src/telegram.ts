import { type StickerFormat, stickerFormatFromPath, STICKER_MAX_BYTES } from '@gusvoice/shared';
import { env } from './env.js';

/**
 * Тонкий клиент Bot API — ровно то, что нужно для импорта набора стикеров (#68).
 *
 * Почему Bot API, а не «выгрузить архивом руками»: у стикера в наборе есть подпись-эмодзи, и
 * именно по ней их потом ищут в пикере. Ручная выгрузка эту привязку теряет — остаётся сто
 * безымянных картинок, в которых ничего не найти.
 *
 * Хост здесь ФИКСИРОВАННЫЙ, поэтому `safeFetch` (защита от SSRF по пользовательским URL) не нужен.
 * Пользовательское тут одно — имя набора, и оно проходит `parseStickerSetName` до вызова: имя
 * подставляется в путь запроса, и без белого списка символов туда пролезет обход пути.
 */

const API = 'https://api.telegram.org';
/** Ответ метода приходит мгновенно; долгая пауза = что-то не так, а не «ещё немного». */
const CALL_TIMEOUT_MS = 10_000;
/** Скачивание файла: 120 штук подряд, каждому даём больше времени, чем на вызов метода. */
const DOWNLOAD_TIMEOUT_MS = 20_000;

export function telegramConfigured(): boolean {
  return !!env.telegramBotToken;
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
  ) {
    super(message);
  }
}

async function call<T>(method: string, params: Record<string, string>): Promise<T> {
  if (!telegramConfigured()) throw new TelegramError('импорт стикеров не настроен на этом сервере', 503);
  const url = `${API}/bot${env.telegramBotToken}/${method}?${new URLSearchParams(params)}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch {
    // Наружу отдаём про «не дозвонились», НЕ про URL: в нём токен бота.
    throw new TelegramError('не удалось связаться с Telegram');
  }

  const body = (await res.json().catch(() => null)) as
    | { ok: boolean; result?: T; description?: string }
    | null;
  if (!body?.ok) {
    const why = body?.description ?? `HTTP ${res.status}`;
    // 404 от Bot API на getStickerSet = «такого набора нет», а не поломка сервера.
    if (/not found|STICKERSET_INVALID/i.test(why))
      throw new TelegramError('такого набора стикеров нет', 404);
    if (/unauthorized/i.test(why)) throw new TelegramError('токен бота Telegram недействителен', 503);
    throw new TelegramError(`Telegram отказал: ${why}`);
  }
  return body.result as T;
}

export interface TgSticker {
  file_id: string;
  emoji?: string;
  is_animated?: boolean;
  is_video?: boolean;
}

export interface TgStickerSet {
  name: string;
  title: string;
  stickers: TgSticker[];
}

/** Набор целиком: заголовок + список стикеров с их подписями-эмодзи. */
export function getStickerSet(name: string): Promise<TgStickerSet> {
  return call<TgStickerSet>('getStickerSet', { name });
}

/**
 * Скачать файл стикера. Возвращает null, если формат нам незнаком, — такой стикер пропускаем,
 * а не роняем весь импорт из-за одной странной записи в наборе.
 */
export async function downloadSticker(
  fileId: string,
): Promise<{ buffer: Buffer; format: StickerFormat } | null> {
  const file = await call<{ file_path?: string }>('getFile', { file_id: fileId });
  const path = file.file_path;
  // `file_path` приходит от Telegram, но подставляется в URL — пустой или с обходом пути не берём.
  if (!path || path.includes('..') || path.startsWith('/')) return null;

  const format = stickerFormatFromPath(path);
  if (!format) return null;

  let res: Response;
  try {
    res = await fetch(`${API}/file/bot${env.telegramBotToken}/${path}`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new TelegramError('не удалось скачать стикер из Telegram');
  }
  if (!res.ok) throw new TelegramError(`не удалось скачать стикер (HTTP ${res.status})`);

  // Смотрим объявленный размер ДО чтения тела: иначе неожиданно огромный файл сначала окажется
  // целиком в памяти, а уже потом будет отвергнут.
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > STICKER_MAX_BYTES) return null;

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0 || buffer.length > STICKER_MAX_BYTES) return null;
  return { buffer, format };
}
