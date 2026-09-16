import { eq, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { linkPreviews } from './db/schema.js';
import { isRedundantDescription, parseHead } from './ogParse.js';
import { BlockedTargetError, safeFetchPage } from './safeFetch.js';

/**
 * Сбор OpenGraph-карточки по ссылке из сообщения. Ходит наружу через `safeFetch` — обычным
 * клиентом сюда нельзя, разбор угрозы там.
 *
 * Кэш обязателен и он не про скорость. Без него каждый рендер сообщения = новый запрос наружу:
 * двадцать человек открыли канал → двадцать обращений к чужому сайту с одного адреса. Неудачи
 * кэшируются тоже, иначе битая ссылка в живом канале долбится наружу бесконечно.
 */
const TTL_OK_MS = 7 * 24 * 3600 * 1000;
/** Неудачу держим меньше: сайт мог лежать временно, через час можно попробовать снова. */
const TTL_FAIL_MS = 60 * 60 * 1000;
const MAX_URL = 2048;

export type LinkPreview = {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  /** Заполняется, но клиенту НЕ отдаётся — см. комментарий в `toPublic`. */
  imageUrl: string | null;
};

/**
 * Что уходит клиенту. **Картинка НЕ отдаётся намеренно.**
 *
 * Отдать `og:image` как есть — значит заставить браузер каждого читателя сходить на чужой сервер,
 * то есть раскрыть ему свой IP и факт чтения. Ровно эту дыру уже закрывали для вложений: в
 * `storage.ts` вложения ограничены нашим бакетом именно потому, что произвольный URL в сообщении =
 * трекинг-пиксель и деанонимизация (#4, P1-2). Возвращать её обратно через предпросмотр нельзя.
 *
 * Правильный путь — проксировать картинку через свой storage (кэш в MinIO, отдаём свой URL);
 * `safeFetch` для этого уже есть, нужен бинарный режим + лимит размера + проверка MIME.
 * До тех пор карточка текстовая. В базе `image_url` копится, чтобы прокси потом мог его забрать.
 */
function toPublic(row: { url: string; title: string | null; description: string | null; siteName: string | null }) {
  const description = isRedundantDescription(row.title, row.description) ? null : row.description;
  return { url: row.url, title: row.title, description, siteName: row.siteName, imageUrl: null };
}

/** Нормализация ключа кэша: якорь на страницу не влияет, но плодит записи. */
function cacheKey(raw: string): string | null {
  if (raw.length > MAX_URL) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

export async function getLinkPreview(raw: string): Promise<LinkPreview | null> {
  const key = cacheKey(raw);
  if (!key) return null;

  const [cached] = await db.select().from(linkPreviews).where(eq(linkPreviews.url, key)).limit(1);
  if (cached) {
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (age < (cached.ok ? TTL_OK_MS : TTL_FAIL_MS)) return cached.ok ? toPublic(cached) : null;
  }

  let parsed: Omit<LinkPreview, 'url'> | null = null;
  try {
    const res = await safeFetchPage(key);
    // Не HTML — карточку строить не из чего (картинка/архив/видео по прямой ссылке).
    if (res.status >= 200 && res.status < 300 && /text\/html|application\/xhtml/i.test(res.contentType)) {
      const p = parseHead(res.body, res.url);
      if (p.title || p.description) parsed = p; // пустая карточка хуже её отсутствия
    }
  } catch (e) {
    // Логируем ЛЮБУЮ неудачу, а не только заблокированную цель. Раньше здесь молчали обо всём
    // остальном — и когда весь предпросмотр лёг из-за `ERR_INVALID_IP_ADDRESS`, в логах не было
    // ни строчки, а в базе просто копились `ok=false`. Неотличимо от «сайт без og-тегов».
    if (e instanceof BlockedTargetError) {
      console.warn('[link-preview] отбита цель:', e.detail);
    } else {
      console.warn('[link-preview] не удалось получить', key, '—', (e as Error).message);
    }
  }

  const row = {
    url: key,
    ok: parsed !== null,
    title: parsed?.title ?? null,
    description: parsed?.description ?? null,
    imageUrl: parsed?.imageUrl ?? null,
    siteName: parsed?.siteName ?? null,
    fetchedAt: new Date(),
  };
  await db
    .insert(linkPreviews)
    .values(row)
    .onConflictDoUpdate({ target: linkPreviews.url, set: { ...row, fetchedAt: sql`now()` } });

  return parsed ? toPublic({ ...row, siteName: row.siteName }) : null;
}
