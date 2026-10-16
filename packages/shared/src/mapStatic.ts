/**
 * Картинка карты в карточке геопозиции ЛС (14.10, признак сервера `yamap1`) — правила, общие для сервера и клиента.
 *
 * Клиент к Яндексу не ходит: он просит картинку у СВОЕГО сервера (`GET /api/maps/static`), а тот проксирует Static API Яндекса
 * (`static-maps.yandex.ru/v1`) и отдаёт поток. Провод сообщений не меняется — каждая сторона берёт картинку у своего сервера по
 * координатам из `ConvMessage.media`. Условия бесплатного API: полученное НЕ сохраняем (ни диск, ни S3, ни база).
 */

/** Предел размера картинки Static API, пиксели (`size=w,h`). */
export const MAP_STATIC_MAX_W = 650;
export const MAP_STATIC_MAX_H = 450;
/** Меньше смысла нет: карточка уже; ниже предела отбиваем мусорные запросы. */
export const MAP_STATIC_MIN_SIDE = 80;
/** Масштаб карты (как «улица» у Telegram и ссылка во внешние карты): один для всех карточек, кеш браузера бьёт чаще. */
export const MAP_STATIC_ZOOM = 16;

export type MapStaticTheme = 'dark' | 'light';

export interface MapStaticQuery {
  lat: number;
  lon: number;
  w: number;
  h: number;
  theme: MapStaticTheme;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function intInRange(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const n = typeof raw === 'number' ? raw : /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function coord(raw: unknown, limit: number): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const n = typeof raw === 'number' ? raw : /^-?\d{1,3}(\.\d{1,15})?$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return round6(n);
}

/** Строгий разбор запроса к `/api/maps/static`: координаты — в пределах, до 6 знаков; размер — в пределах API; тема — `light`/`dark`. Иначе `null`. */
export function parseMapStaticQuery(raw: unknown): MapStaticQuery | null {
  if (!raw || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  const lat = coord(q.lat, 90);
  const lon = coord(q.lon, 180);
  const w = intInRange(q.w, MAP_STATIC_MIN_SIDE, MAP_STATIC_MAX_W);
  const h = intInRange(q.h, MAP_STATIC_MIN_SIDE, MAP_STATIC_MAX_H);
  if (lat === null || lon === null || w === null || h === null) return null;
  const theme: MapStaticTheme = q.theme === 'light' ? 'light' : 'dark';
  return { lat, lon, w, h, theme };
}

/** Путь запроса клиента к своему серверу (после `/api`). Размер — в целых пикселях и в пределах API. */
export function mapStaticPath(q: MapStaticQuery): string {
  const w = Math.min(MAP_STATIC_MAX_W, Math.max(MAP_STATIC_MIN_SIDE, Math.round(q.w)));
  const h = Math.min(MAP_STATIC_MAX_H, Math.max(MAP_STATIC_MIN_SIDE, Math.round(q.h)));
  return `/maps/static?lat=${round6(q.lat)}&lon=${round6(q.lon)}&w=${w}&h=${h}&theme=${q.theme}`;
}

/**
 * Размер запрошенной картинки под ширину пузыря: вдвое больше показа (плотный экран), но не больше предела API, пропорция
 * сохраняется. Параметр `scale` Яндекса увеличивает значки, а не точки, — поэтому плотность даём размером.
 */
export function mapStaticSize(cssW: number, cssH: number): { w: number; h: number } {
  const k = Math.min(2, MAP_STATIC_MAX_W / Math.max(1, cssW), MAP_STATIC_MAX_H / Math.max(1, cssH));
  return {
    w: Math.min(MAP_STATIC_MAX_W, Math.max(MAP_STATIC_MIN_SIDE, Math.round(cssW * k))),
    h: Math.min(MAP_STATIC_MAX_H, Math.max(MAP_STATIC_MIN_SIDE, Math.round(cssH * k))),
  };
}

/** Яндекс Карты на месте (ПК и веб; на Android запасная ссылка к `geo:`). `pt=долгота,широта`. */
export function yandexMapsUrl(lat: number, lon: number): string {
  return `https://yandex.ru/maps/?pt=${round6(lon)},${round6(lat)}&z=${MAP_STATIC_ZOOM}&l=map`;
}
