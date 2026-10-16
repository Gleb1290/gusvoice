/**
 * Живая карта (14.10, признак сервера `osmmap1`): чистые правила для `components/MapView.tsx` и стиля `mapStyle.ts` — без MapLibre
 * и без DOM, чтобы грузиться в основном бандле дёшево и проверяться тестами.
 */

/** Точка на карте: `id` держит метку при смене списка (нет — по номеру); `accuracy` — радиус круга точности, метры. */
export interface MapPoint {
  id?: string;
  lat: number;
  lon: number;
  accuracy?: number | null;
  label?: string;
  avatarUrl?: string | null;
  /** Своё место в окне выбора (15.10, `geopick2`): точка «вы здесь» вместо капли — капля там означает выбранное место в центре. */
  me?: boolean;
}

/** Масштаб, с которого показываем одиночную точку (карточка и полноэкранная карта). */
export const MAP_POINT_ZOOM = 15;
/** Дальше не приближаем при подгонке под несколько точек. */
export const MAP_FIT_MAX_ZOOM = 16;
/** Без точек — общий обзор по центру файла. */
export const MAP_EMPTY_ZOOM = 10;
/** Круг точности рисуем, если он не меньше этого, метры (меньше — размер метки и так больше круга). */
export const MAP_ACCURACY_MIN_M = 5;
/** Источник GeoJSON кругов точности в стиле (`mapStyle.ts`) и в `MapView`. */
export const ACC_SOURCE = 'gv-acc';
/** Подпись источника (условие ODbL): видна всегда. */
export const MAP_ATTRIBUTION_TEXT = '© OpenStreetMap';
export const MAP_ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';

const EARTH_R = 6371008.8;

/** Годная точка: конечные широта в [-90; 90] и долгота в [-180; 180]. */
export function validMapPoint(p: Pick<MapPoint, 'lat' | 'lon'> | null | undefined): boolean {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}

/** Только годные точки (негодную из чужого сообщения молча пропускаем — карта не должна падать). */
export function validMapPoints(points: readonly MapPoint[]): MapPoint[] {
  return points.filter(validMapPoint);
}

/** Светлая ли тема приложения (`<html data-theme="light">`): карта светлая/тёмная по ней. */
export function mapIsLight(themeAttr: string | null | undefined): boolean {
  return themeAttr === 'light';
}

/** Круг точности: многоугольник вокруг точки, `meters` — радиус; координаты `[долгота, широта]`, кольцо замкнуто. */
export function accuracyRing(lat: number, lon: number, meters: number, steps = 48): [number, number][] {
  const out: [number, number][] = [];
  const dLat = (meters / EARTH_R) * (180 / Math.PI);
  const dLon = dLat / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    out.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  out.push(out[0]);
  return out;
}

/** GeoJSON кругов точности для всех точек, у которых она известна и не мала. */
export function accuracyCollection(points: readonly MapPoint[]): {
  type: 'FeatureCollection';
  features: { type: 'Feature'; properties: Record<string, never>; geometry: { type: 'Polygon'; coordinates: [number, number][][] } }[];
} {
  return {
    type: 'FeatureCollection',
    features: validMapPoints(points)
      .filter((p) => typeof p.accuracy === 'number' && Number.isFinite(p.accuracy) && p.accuracy >= MAP_ACCURACY_MIN_M)
      .map((p) => ({
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'Polygon' as const, coordinates: [accuracyRing(p.lat, p.lon, p.accuracy as number)] },
      })),
  };
}

export type CameraPlan =
  | { kind: 'center'; center: [number, number]; zoom: number }
  | { kind: 'bounds'; bounds: [[number, number], [number, number]] };

/** Масштаб «вся страна» для окна выбора места без точки и без сохранённого места. */
export const MAP_REGION_ZOOM = 3;

/**
 * Камера окна «Геопозиция», пока точки нет и места устройства не помним (15.10, приёмка S20): весь файл карты. Файл через 180-й
 * меридиан (Россия с Чукоткой: bounds [-180..180]) рамкой показывал бы весь мир с центром на долготе 0 — над пустым морем; тогда
 * долгота — по часовому поясу устройства (UTC+3 → 45° в.д., как прикидка места до первой точки), широта — середина файла, масштаб страны.
 */
export function regionCamera(bounds: readonly [number, number, number, number], tzOffsetMin: number): CameraPlan {
  const [w, s, e, n] = bounds;
  if (e - w < 300) return { kind: 'bounds', bounds: [[w, s], [e, n]] };
  const lon = Number.isFinite(tzOffsetMin) ? Math.max(-180, Math.min(180, -tzOffsetMin / 4)) : 0;
  return { kind: 'center', center: [lon, (s + n) / 2], zoom: MAP_REGION_ZOOM };
}

/** Куда ставить камеру при первом показе: нет точек — центр файла, одна — на ней, несколько — рамка вокруг всех. */
export function initialCamera(points: readonly MapPoint[], fallbackCenter: [number, number]): CameraPlan {
  const ok = validMapPoints(points);
  if (ok.length === 0) return { kind: 'center', center: fallbackCenter, zoom: MAP_EMPTY_ZOOM };
  if (ok.length === 1) return { kind: 'center', center: [ok[0].lon, ok[0].lat], zoom: MAP_POINT_ZOOM };
  let w = 180, s = 90, e = -180, n = -90;
  for (const p of ok) {
    w = Math.min(w, p.lon);
    e = Math.max(e, p.lon);
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
  }
  return { kind: 'bounds', bounds: [[w, s], [e, n]] };
}

/** Метка точки в списке: `id`, иначе номер — так при смене координат метка переезжает, а не пересоздаётся. */
export function pointKey(p: MapPoint, index: number): string {
  return p.id ? `id:${p.id}` : `#${index}`;
}

/**
 * Слои стиля без значков: спрайтов у нас нет (внешних запросов не делаем), а слои с `icon-image` (значки мест, стрелки односторонних дорог)
 * без спрайта дают ошибки на каждый кадр. Подписи дорог, районов, городов остаются.
 */
export function dropSpriteLayers<T extends { layout?: Record<string, unknown> | undefined }>(layers: readonly T[]): T[] {
  return layers.filter((l) => !(l.layout && 'icon-image' in l.layout));
}
