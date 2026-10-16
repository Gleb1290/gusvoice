import { MAP_STATIC_ZOOM, type MapStaticQuery } from '@gusvoice/shared';

/**
 * Прокси Static API Яндекса для карточки геопозиции ЛС (14.10, `yamap1`) — чистые правила; маршрут — `routes/mapsStatic.ts`.
 *
 * 🔴 Условия бесплатного API: полученное от Яндекса СОХРАНЯТЬ НЕЛЬЗЯ. Поэтому картинка идёт потоком к человеку, на диск, в S3
 * и в базу не попадает, а ответ клиенту — `Cache-Control: private` с коротким `max-age` (кеш самого браузера на время сессии,
 * не наш).
 */

export const MAPS_STATIC_UPSTREAM = 'https://static-maps.yandex.ru/v1';
/** Ответ клиенту: только его браузеру и на час — при 100 запросах в сутки (бесплатный тариф) повторный показ не тратит квоту. */
export const MAPS_STATIC_CACHE_CONTROL = 'private, max-age=3600';
/** Картинка карты — десятки КБ; больше этого — не карта, обрываем. */
export const MAPS_STATIC_MAX_BYTES = 2 * 1024 * 1024;
export const MAPS_STATIC_TIMEOUT_MS = 8000;
/** Один человек: запросов в минуту (на экране — десяток карточек, остальное берёт кеш клиента). */
export const MAPS_STATIC_USER_MAX = 90;
export const MAPS_STATIC_USER_WINDOW_S = 60;

/** Ключ задан → возможность есть (`yamap1`). Пустая строка и пробелы — нет. */
export function mapsStaticEnabled(key: string | undefined): boolean {
  return !!key && key.trim().length > 0;
}

/**
 * Адрес запроса к Яндексу. Минимальный набор параметров v1: `ll=долгота,широта`, `z`, `size=ширина,высота`, `pt=долгота,широта,метка`,
 * `theme` (тёмная карта к тёмной теме приложения), `lang`, `apikey`. `scale` не передаём: у Яндекса он укрупняет значки, а не
 * плотность точек — для плотного экрана клиент просит картинку вдвое больше (`mapStaticSize`).
 */
export function mapsStaticUpstreamUrl(q: MapStaticQuery, apiKey: string): string {
  const ll = `${q.lon},${q.lat}`;
  const params = new URLSearchParams({
    ll,
    z: String(MAP_STATIC_ZOOM),
    size: `${q.w},${q.h}`,
    pt: `${ll},pm2rdm`,
    theme: q.theme,
    lang: 'ru_RU',
    apikey: apiKey,
  });
  // `,` внутри значений Яндекс принимает и закодированной, но читаемый вид надёжнее для его разборщика.
  return `${MAPS_STATIC_UPSTREAM}?${params.toString().replace(/%2C/gi, ',')}`;
}

/** Ответ Яндекса годится, если это картинка и не больше предела. */
export function mapsStaticReplyOk(status: number, contentType: string | null, contentLength: string | null): boolean {
  if (status !== 200) return false;
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(png|jpeg|webp)$/.test(type)) return false;
  if (contentLength && Number(contentLength) > MAPS_STATIC_MAX_BYTES) return false;
  return true;
}
