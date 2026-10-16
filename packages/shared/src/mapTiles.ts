/**
 * Своя карта OpenStreetMap (14.10, признак сервера `osmmap1`): провод ручек `GET /api/maps/info`, `/api/maps/tiles/{z}/{x}/{y}.mvt`,
 * `/api/maps/glyphs/{fontstack}/{range}.pbf` (сервер — `backend/routes/mapsTiles.ts`, клиент — `MapView`). Только добавление к протоколу.
 */

/** Ответ `GET /api/maps/info`: что есть в файле PMTiles сервера. */
export interface MapInfoDto {
  minzoom: number;
  maxzoom: number;
  /** [запад, юг, восток, север], градусы. */
  bounds: [number, number, number, number];
  /** [долгота, широта], градусы. */
  center: [number, number];
}

/** Шаблон адреса плиток для MapLibre; `base` — адрес API без хвоста (`https://api.example`). */
export function mapTilesUrlTemplate(base: string): string {
  return `${base}/api/maps/tiles/{z}/{x}/{y}.mvt`;
}

/** Шаблон адреса глифов для стиля MapLibre (`glyphs`). */
export function mapGlyphsUrlTemplate(base: string): string {
  return `${base}/api/maps/glyphs/{fontstack}/{range}.pbf`;
}

/** Разбор ответа `/api/maps/info`: неполный или кривой ответ — `null` (карты не будет). */
export function parseMapInfo(raw: unknown): MapInfoDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const quad = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(num);
  if (!num(o.minzoom) || !num(o.maxzoom) || !quad(o.bounds, 4) || !quad(o.center, 2)) return null;
  if (o.minzoom < 0 || o.maxzoom > 30 || o.minzoom > o.maxzoom) return null;
  return { minzoom: o.minzoom, maxzoom: o.maxzoom, bounds: [o.bounds[0], o.bounds[1], o.bounds[2], o.bounds[3]], center: [o.center[0], o.center[1]] };
}
