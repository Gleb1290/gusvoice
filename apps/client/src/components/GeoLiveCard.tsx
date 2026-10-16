import { geoLiveAgoText, geoLiveEnded, geoLiveLeftShare, geoLiveLeftText, geoText, type ConvGeoLiveMedia } from '@gusvoice/shared';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { serverOsmMap } from '../convSyncRules';
import { stopGeoLive, useGeoLive } from '../geoLiveSharing';
import { GEO_MAP_CSS_H, GEO_MAP_CSS_W } from '../mapImage';
import { useStore } from '../store';
import { toastError } from '../toast';
import { openGeoExternally } from './ConvMediaCard';
import { Icon } from './Icon';

/** Своя живая карта (`osmmap1`) — лениво, как в `GeoCard`: MapLibre не входит в основной бандл. */
const GeoMapLiveLazy = lazy(() => import('./GeoMapLive'));
const GeoMapFullLazy = lazy(() => import('./GeoMapLive').then((m) => ({ default: m.GeoMapFull })));

/**
 * Трансляция геопозиции в ЛС (14.10, `geolive1`): карточка в ленте и плашка над беседой. Как Telegram: ячейка
 * `SharingLiveLocationCell` (название вида, «updated N ago», кольцо оставшегося времени вокруг значка), у автора «Stop»
 * (`StopLiveLocation`), плашка `FragmentContextView` («Sharing live location» + «Stop») над беседой, пока трансляция идёт.
 * Карта: своя живая (`osmmap1`, `GeoMapLive` с `follow`, пока трансляция идёт) — нажатие открывает её на весь экран с «Открыть
 * в картах»; без своей карты нажатие открывает ТЕКУЩУЮ точку во внешних картах (`openGeoExternally`).
 */

/** Часы карточки: пока идёт — раз в 15 с (подпись «N мин назад» и кольцо), по концу срока — ещё один тик, чтобы подпись сменилась. */
function useLiveNow(live: Pick<ConvGeoLiveMedia, 'until' | 'stopped' | 'updatedAt'>): number {
  const [now, setNow] = useState(() => Date.now());
  const ended = geoLiveEnded(live, now);
  useEffect(() => {
    if (ended) return;
    const iv = window.setInterval(() => setNow(Date.now()), 15_000);
    const end = window.setTimeout(() => setNow(Date.now()), Math.max(0, live.until - Date.now()) + 50);
    return () => {
      window.clearInterval(iv);
      window.clearTimeout(end);
    };
  }, [ended, live.until]);
  // Пришло обновление точки/остановка — подпись пересчитать сразу.
  useEffect(() => setNow(Date.now()), [live.updatedAt, live.stopped, live.until]);
  return now;
}

const RING_R = 24;
const RING_LEN = 2 * Math.PI * RING_R;

export function GeoLiveCard({ live, conversationId, messageId, mine }: { live: ConvGeoLiveMedia; conversationId: string; messageId: string; mine: boolean }) {
  const now = useLiveNow(live);
  const ended = geoLiveEnded(live, now);
  const [busy, setBusy] = useState(false);
  const share = geoLiveLeftShare(live, now);
  const osmOn = useStore((st) => serverOsmMap(st.serverFeatures));
  const [osmFailed, setOsmFailed] = useState(false);
  const failOsm = useCallback(() => setOsmFailed(true), []);
  const [full, setFull] = useState(false);
  const liveMap = osmOn && !osmFailed;
  const stop = () => {
    if (busy) return;
    setBusy(true);
    stopGeoLive(conversationId, messageId)
      .catch(toastError)
      .finally(() => setBusy(false));
  };
  return (
    <div className={`geo-live${ended ? ' ended' : ''}`}>
      <button
        type="button"
        className={`msg-geo${liveMap ? ' has-map' : ''}`}
        title={liveMap ? 'Открыть карту' : 'Открыть на карте'}
        onClick={(e) => {
          e.stopPropagation();
          if (liveMap) setFull(true);
          else openGeoExternally(live.lat, live.lon);
        }}
      >
        {liveMap && (
          <Suspense fallback={<span className="msg-geo-map msg-geo-live" style={{ aspectRatio: `${GEO_MAP_CSS_W} / ${GEO_MAP_CSS_H}` }} />}>
            {/* Метка движется вместе с точкой: MapView меняет точки без пересоздания карты, камера идёт за меткой, пока трансляция идёт. */}
            <GeoMapLiveLazy lat={live.lat} lon={live.lon} accuracy={live.accuracy ?? null} follow={!ended} onFail={failOsm} />
          </Suspense>
        )}
        <span className="msg-geo-ico geo-live-ico" aria-hidden="true">
          {!ended && (
            <svg className="geo-live-ring" viewBox="0 0 52 52" width="52" height="52">
              <circle className="geo-live-track" cx="26" cy="26" r={RING_R} fill="none" strokeWidth="3" />
              <circle
                className="geo-live-left"
                cx="26"
                cy="26"
                r={RING_R}
                fill="none"
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={`${RING_LEN * share} ${RING_LEN}`}
                transform="rotate(-90 26 26)"
              />
            </svg>
          )}
          <Icon name="map-pin" size={22} />
        </span>
        <span className="msg-geo-text">
          <span className="msg-geo-title">Геопозиция в реальном времени</span>
          <span className="msg-geo-sub">{ended ? 'трансляция завершена' : geoLiveAgoText(live.updatedAt, now)}</span>
          <span className="msg-geo-sub">{ended ? geoText(live.lat, live.lon) : geoLiveLeftText(live, now)}</span>
        </span>
      </button>
      {mine && !ended && (
        <button type="button" className="msg-contact-act" disabled={busy} onClick={stop}>
          Остановить
        </button>
      )}
      {full && (
        // Окно рядом с кнопкой, не внутри неё: нажатия в окне не должны попадать в карточку.
        <Suspense fallback={null}>
          <GeoMapFullLazy
            lat={live.lat}
            lon={live.lon}
            accuracy={live.accuracy ?? null}
            follow={!ended}
            title="Геопозиция в реальном времени"
            onClose={() => setFull(false)}
            onOpenExternal={() => openGeoExternally(live.lat, live.lon)}
          />
        </Suspense>
      )}
    </div>
  );
}

/** Плашка над беседой, пока я здесь транслирую (Telegram `FragmentContextView`, режим live location): «Вы транслируете геопозицию · Остановить». */
export function GeoLiveBar({ conversationId }: { conversationId: string | undefined }) {
  const list = useGeoLive((s) => s.list);
  const mine = conversationId ? list.filter((s) => s.conversationId === conversationId) : [];
  const [busy, setBusy] = useState(false);
  if (mine.length === 0 || !conversationId) return null;
  const stopAll = () => {
    if (busy) return;
    setBusy(true);
    void Promise.all(mine.map((s) => stopGeoLive(conversationId, s.messageId)))
      .catch(toastError)
      .finally(() => setBusy(false));
  };
  return (
    <div className="stranger-bar geo-live-bar" role="status">
      <span className="stranger-bar-text">Вы транслируете геопозицию</span>
      <span className="stranger-bar-actions">
        <button type="button" className="stranger-bar-btn danger" disabled={busy} onClick={stopAll}>
          Остановить
        </button>
      </span>
    </div>
  );
}
