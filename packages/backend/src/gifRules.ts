/**
 * Правила «Моих GIF» и внешнего поиска (Р-7, #211, признак `gifs1`) — ЧИСТЫЕ, без базы и сети.
 *
 * Источники — исходники Telegram (`S:\gv-stand\tg-src`): tdesktop `chat_helpers/gifs_list_widget.cpp` (вкладка GIF: сохранённые,
 * поиск), `history/view/history_view_context_menu.cpp` («Сохранить GIF» у анимации), `data/data_document.cpp` (GIF = mp4 без
 * звука, `isAnimation`), предел `saved_gifs_limit` = 200 (`main/main_app_config.cpp`); Web A `GifPicker.tsx`.
 */

/** Сколько GIF держит «Мои GIF» (Telegram `saved_gifs_limit` по умолчанию): сверх — самые старые уходят. */
export const GIFS_SAVED_MAX = 200;
/** Самый большой GIF (байт), который можно сохранить или привезти от поставщика. */
export const GIF_MAX_BYTES = 15 * 1024 * 1024;
/** Сколько находок отдаёт одна страница поиска. */
export const GIF_SEARCH_PAGE = 30;

/** Можно ли сохранить вложение как GIF: видео (mp4/webm — GIF Telegram) или `image/gif`, не больше предела. */
export function gifSavable(contentType: string, size: number): boolean {
  if (size <= 0 || size > GIF_MAX_BYTES) return false;
  return contentType === 'image/gif' || contentType === 'video/mp4' || contentType === 'video/webm';
}

/** Имя файла вложения при отправке GIF (видно в «Скачать»). */
export function gifFileName(contentType: string): string {
  return contentType === 'image/gif' ? 'GIF.gif' : contentType === 'video/webm' ? 'GIF.webm' : 'GIF.mp4';
}

/**
 * Какие строки «Моих GIF» убрать после вставки новой (новые первыми): всё за пределом `max`. Вход — id в порядке
 * «новые первыми».
 */
export function gifsOverLimit(idsNewestFirst: readonly string[], max = GIFS_SAVED_MAX): string[] {
  return idsNewestFirst.slice(Math.max(0, max));
}

export type GifProvider = 'giphy' | 'tenor';

/** Поставщик из окружения (`GIF_PROVIDER` + `GIF_API_KEY`): неизвестный или без ключа — поиска нет (`null`). */
export function gifProviderOf(provider: string, key: string): GifProvider | null {
  if (!key.trim()) return null;
  return provider === 'giphy' || provider === 'tenor' ? provider : null;
}

/** Адрес запроса к поставщику: пустой запрос — популярное (как у Telegram пустая строка поиска — «В тренде»). */
export function gifSearchUrl(p: GifProvider, key: string, query: string, pos: string | null, limit = GIF_SEARCH_PAGE): string {
  const q = query.trim();
  if (p === 'giphy') {
    const u = new URL(q ? 'https://api.giphy.com/v1/gifs/search' : 'https://api.giphy.com/v1/gifs/trending');
    u.searchParams.set('api_key', key);
    if (q) u.searchParams.set('q', q);
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('offset', String(Math.max(0, Number.parseInt(pos ?? '0', 10) || 0)));
    u.searchParams.set('rating', 'pg-13');
    u.searchParams.set('lang', 'ru');
    return u.toString();
  }
  const u = new URL(q ? 'https://tenor.googleapis.com/v2/search' : 'https://tenor.googleapis.com/v2/featured');
  u.searchParams.set('key', key);
  u.searchParams.set('client_key', 'gusvoice');
  if (q) u.searchParams.set('q', q);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('media_filter', 'mp4,tinymp4');
  u.searchParams.set('contentfilter', 'medium');
  u.searchParams.set('locale', 'ru_RU');
  if (pos) u.searchParams.set('pos', pos);
  return u.toString();
}

export interface ParsedGif {
  id: string;
  url: string;
  previewUrl: string;
  width: number | null;
  height: number | null;
}

const num = (x: unknown): number | null => {
  const n = typeof x === 'string' ? Number.parseInt(x, 10) : typeof x === 'number' ? x : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});

/** Разобрать ответ поставщика: только записи с mp4 на его медиа-хосте (`gifMediaUrlAllowed`); следующая страница. */
export function parseGifSearch(p: GifProvider, body: unknown, pos: string | null, limit = GIF_SEARCH_PAGE): { gifs: ParsedGif[]; next: string | null } {
  const b = obj(body);
  const out: ParsedGif[] = [];
  if (p === 'giphy') {
    const data = Array.isArray(b.data) ? b.data : [];
    for (const raw of data) {
      const g = obj(raw);
      const images = obj(g.images);
      const full = obj(images.original_mp4 ?? images.original);
      const small = obj(images.fixed_width);
      const url = str(full.mp4);
      const id = str(g.id);
      if (!id || !url || !gifMediaUrlAllowed(p, url)) continue;
      const prev = str(small.mp4);
      out.push({ id, url, previewUrl: prev && gifMediaUrlAllowed(p, prev) ? prev : url, width: num(full.width), height: num(full.height) });
    }
    const start = Math.max(0, Number.parseInt(pos ?? '0', 10) || 0);
    const pg = obj(b.pagination);
    const total = num(pg.total_count) ?? 0;
    const next = data.length >= limit && start + data.length < total ? String(start + data.length) : null;
    return { gifs: out, next };
  }
  const results = Array.isArray(b.results) ? b.results : [];
  for (const raw of results) {
    const g = obj(raw);
    const mf = obj(g.media_formats);
    const full = obj(mf.mp4);
    const tiny = obj(mf.tinymp4);
    const url = str(full.url);
    const id = str(g.id);
    if (!id || !url || !gifMediaUrlAllowed(p, url)) continue;
    const dims = Array.isArray(full.dims) ? full.dims : [];
    const prev = str(tiny.url);
    out.push({ id, url, previewUrl: prev && gifMediaUrlAllowed(p, prev) ? prev : url, width: num(dims[0]), height: num(dims[1]) });
  }
  const next = str(b.next);
  return { gifs: out, next: results.length > 0 && next && next !== '0' ? next : null };
}

/**
 * Файл, который сервер согласен скачать от поставщика (`POST /gifs/external/attach`): только https и только его
 * медиа-хосты — иначе ручка стала бы прокси на любой адрес (SSRF).
 */
export function gifMediaUrlAllowed(p: GifProvider, raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (p === 'giphy') return /^media[0-9]?\.giphy\.com$/.test(h) || h === 'i.giphy.com';
  return h === 'media.tenor.com' || h === 'media1.tenor.com';
}
