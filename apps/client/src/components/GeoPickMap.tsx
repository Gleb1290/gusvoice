import { useEffect, useMemo, useState } from 'react';
import type { MapPoint } from '../mapRules';
import type { GeoPickMapProps } from './GeoPickDialog';
import { MapView } from './MapView';

/**
 * Карта в окне «Геопозиция» (15.10, `geopick2`): своя карта (`MapView`, MapLibre/PMTiles нашего сервера), грузится ЛЕНИВО — модуль
 * подключает `MessagePane` через `lazy(import('./GeoPickMap'))` и отдаёт окну пропом `map` (само окно ничего тяжёлого не импортирует).
 * Как Telegram Android `ChatAttachAlertLocationLayout`: пока места нет, камера стоит на последнем известном месте устройства
 * (`localStorage` `gv_geo_last`; Telegram берёт последнее место из `LocationManager.getLastKnownLocation`), иначе — весь файл карты (`emptyFit`);
 * своё место — точкой «вы здесь», пока окно не двигали — камера идёт за ним (`follow`).
 * Сервер без карты или нет WebGL — `onFail`, окно живёт без карты.
 */

const LAST_KEY = 'gv_geo_last';

function readLast(): { lat: number; lon: number } | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(LAST_KEY) ?? 'null') as { lat?: unknown; lon?: unknown } | null;
    if (!v || typeof v.lat !== 'number' || typeof v.lon !== 'number') return null;
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon) || Math.abs(v.lat) > 90 || Math.abs(v.lon) > 180) return null;
    return { lat: v.lat, lon: v.lon };
  } catch {
    return null;
  }
}

export default function GeoPickMap({ fix, follow, recenter, onUserMove, onFail }: GeoPickMapProps) {
  // Последнее место читаем один раз — им ставится только первая камера.
  const [start] = useState(readLast);
  useEffect(() => {
    if (!fix) return;
    try {
      window.localStorage.setItem(LAST_KEY, JSON.stringify({ lat: fix.lat, lon: fix.lon }));
    } catch {
      /* хранилище недоступно — в следующий раз начнём с центра карты */
    }
  }, [fix]);
  const points = useMemo<MapPoint[]>(() => (fix ? [{ id: 'me', lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy, me: true }] : []), [fix]);
  return (
    <MapView
      className="geo-pick-map-view"
      points={points}
      follow={follow}
      interactive
      emptyCenter={start}
      emptyFit
      onUserMove={onUserMove}
      recenter={recenter}
      onFail={onFail}
    />
  );
}
