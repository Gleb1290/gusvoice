import { geoText } from '@gusvoice/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialogChrome } from '../dialogChrome';
import { GEO_MAP_CSS_H, GEO_MAP_CSS_W } from '../mapImage';
import type { MapPoint } from '../mapRules';
import { Icon } from './Icon';
import { MapView } from './MapView';

/**
 * Живая карта в карточке геопозиции ЛС (14.10, признак сервера `osmmap1`; грузится лениво из `ConvMediaCard`, поэтому MapLibre в основной
 * бандл не входит). Две части:
 *  • `GeoMapLive` — маленькая неинтерактивная карта над подписью карточки (грузится, когда карточка рядом с видимой частью ленты, как
 *    картинка Яндекса `GeoMapPic`; до этого место держит `aspect-ratio` — лента не прыгает). Нажатие уходит кнопке карточки;
 *  • `GeoMapFull` — окно на весь экран с интерактивной картой и кнопкой «Открыть в картах» (внешние карты — `openGeoExternally`).
 * Образец — Telegram: нажатие на карту в пузыре открывает большую карту места (Android `LocationActivity`, Web K — ссылка на карты).
 */

export function GeoMapLive({ lat, lon, accuracy, follow = false, onFail }: { lat: number; lon: number; accuracy: number | null; follow?: boolean; onFail: () => void }) {
  const box = useRef<HTMLSpanElement | null>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = box.current;
    if (near || !el) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: '240px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  const points = useMemo<MapPoint[]>(() => [{ lat, lon, accuracy }], [lat, lon, accuracy]);
  return (
    <span className="msg-geo-map msg-geo-live" ref={box} style={{ aspectRatio: `${GEO_MAP_CSS_W} / ${GEO_MAP_CSS_H}` }}>
      {near && <MapView points={points} follow={follow} onFail={onFail} />}
    </span>
  );
}

/** Стоп всплытию по дереву React: окно в портале иначе «нажимает» строку ленты и пузырь под ним. */
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

export function GeoMapFull({
  lat,
  lon,
  accuracy,
  follow = false,
  title = 'Геопозиция',
  onClose,
  onOpenExternal,
}: {
  lat: number;
  lon: number;
  accuracy: number | null;
  /** Трансляция геопозиции: камера идёт за меткой, пока точка обновляется. */
  follow?: boolean;
  title?: string;
  onClose: () => void;
  onOpenExternal: () => void;
}) {
  const dialogRef = useDialogChrome<HTMLDivElement>(onClose);
  const [failed, setFailed] = useState(false);
  const points = useMemo<MapPoint[]>(() => [{ lat, lon, accuracy }], [lat, lon, accuracy]);
  return createPortal(
    <div
      className="geo-full"
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={stop}
      onPointerDown={stop}
      onMouseDown={stop}
      onTouchStart={stop}
      onContextMenu={stop}
    >
      <div className="geo-full-head">
        <button type="button" className="icon-close" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
          <Icon name="chevron-left" size={20} />
        </button>
        <div className="geo-full-title">
          <span>{title}</span>
          <span className="geo-full-sub">{geoText(lat, lon)}</span>
        </div>
      </div>
      <div className="geo-full-map">
        {failed ? <div className="geo-full-fail">Карта недоступна</div> : <MapView points={points} interactive follow={follow} onFail={() => setFailed(true)} />}
      </div>
      <div className="geo-full-foot">
        <button type="button" className="primary" onClick={onOpenExternal}>
          Открыть в картах
        </button>
      </div>
    </div>,
    document.body,
  );
}

export default GeoMapLive;
