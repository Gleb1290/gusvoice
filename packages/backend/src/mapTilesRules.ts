/**
 * Своя карта OpenStreetMap (14.10, признак `osmmap1`): векторные плитки из ОДНОГО файла PMTiles (сборка protomaps, схема basemap v4),
 * лежащего на нашем сервере — чистые правила; маршруты — `routes/mapsTiles.ts`, чтение файла — `mapTiles.ts`.
 * Нет `MAP_PMTILES_PATH` — карты нет (маршрутов нет, признака нет), карточка геопозиции работает как раньше.
 */

/** Файл неизменный (меняет только админ, подменяя его), поэтому плитки живут в браузере долго — но не вечно: подмена доедет за сутки. */
export const MAP_TILES_CACHE_CONTROL = 'private, max-age=86400';
/** Глифы (шрифт подписей) — неизменные данные пакета; кеш неделю. */
export const MAP_GLYPHS_CACHE_CONTROL = 'private, max-age=604800';
/** Выше этого масштаба плиток в PMTiles не бывает (protomaps режет не выше 15; клиент растягивает сам). */
export const MAP_TILE_MAX_Z = 22;

/** Путь к файлу задан → карта включена (`osmmap1`). Пустая строка и пробелы — нет. */
export function mapTilesEnabled(path: string | undefined): boolean {
  return !!path && path.trim().length > 0;
}

export type MapTileXyz = { z: number; x: number; y: number };

/**
 * Разбор адреса `/maps/tiles/:z/:x/:y.mvt`: целые без знака и лишних нулей, `x`, `y` < 2^z. Что угодно другое — `null` (400).
 * Расширение `.mvt` обязательно (клиент всегда его шлёт; так же устроен `{z}/{x}/{y}` у protomaps).
 */
export function parseMapTileParams(z: unknown, x: unknown, yFile: unknown): MapTileXyz | null {
  if (typeof z !== 'string' || typeof x !== 'string' || typeof yFile !== 'string') return null;
  const m = /^(0|[1-9]\d{0,7})\.mvt$/.exec(yFile);
  if (!m || !/^(0|[1-9]\d{0,2})$/.test(z) || !/^(0|[1-9]\d{0,7})$/.test(x)) return null;
  const zn = Number(z);
  if (zn > MAP_TILE_MAX_Z) return null;
  const xn = Number(x);
  const yn = Number(m[1]);
  const n = 2 ** zn;
  return xn < n && yn < n ? { z: zn, x: xn, y: yn } : null;
}

/** Диапазон глифов `0-255.pbf` (MapLibre просит их по 256 кодов). Неверный вид — `null`. */
export function parseGlyphRange(file: unknown): string | null {
  if (typeof file !== 'string') return null;
  const m = /^(\d{1,6})-(\d{1,6})\.pbf$/.exec(file);
  return m && Number(m[1]) <= Number(m[2]) ? `${m[1]}-${m[2]}` : null;
}

/** Слабый ETag по размеру и времени изменения файла: подмена файла меняет его, 304 экономит трафик. */
export function mapEtag(size: number, mtimeMs: number): string {
  return `W/"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`;
}
