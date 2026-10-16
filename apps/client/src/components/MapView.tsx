import { useEffect, useRef } from 'react';
import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
import {
  ACC_SOURCE,
  accuracyCollection,
  initialCamera,
  MAP_ATTRIBUTION_TEXT,
  MAP_POINT_ZOOM,
  regionCamera,
  MAP_ATTRIBUTION_URL,
  mapIsLight,
  pointKey,
  validMapPoints,
  type MapPoint,
} from '../mapRules';
import { loadMapInfo, mapApiBase, mapTransformRequest } from '../mapSource';

/**
 * Живая карта OpenStreetMap со своего сервера (14.10, признак `osmmap1`): векторные плитки PMTiles, стиль protomaps basemaps (светлый/тёмный по
 * теме приложения, подписи по-русски), глифы и плитки — только `/api/maps/*` нашего сервера. MapLibre тяжёлый (~1 МБ), поэтому грузится
 * ЛЕНИВО при первом показе карты (`import()` ниже) и в основной бандл не входит.
 *
 * Свойства: `points` — метки (меняются БЕЗ пересоздания карты: переезжают, добавляются, убираются; круг точности — слой стиля);
 * `follow` — вести камеру за первой точкой; `interactive` — жесты и кнопки масштаба (иначе карта-картинка). Размер — от контейнера
 * (`.gv-map` занимает 100 % × 100 %). Подпись «© OpenStreetMap» видна всегда (условие лицензии ODbL).
 * Не получилось (нет WebGL, сервер без карты, сбой сети) — `onFail`, место остаётся пустым.
 */
export interface MapViewProps {
  points: readonly MapPoint[];
  follow?: boolean;
  interactive?: boolean;
  className?: string;
  onFail?: () => void;
  /**
   * Окно выбора места (15.10, `geopick2`): камера, пока точек нет, — здесь (последнее известное место устройства), а не в центре файла карты.
   */
  emptyCenter?: { lat: number; lon: number } | null;
  /**
   * Точек нет и `emptyCenter` нет — показать весь файл карты (его `bounds`), а не центр файла на крупном масштабе (приёмка S20 15.10:
   * у карты России центр файла — долгота 0 из-за Чукотки за 180-м меридианом, окно открывалось над пустым морем).
   */
  emptyFit?: boolean;
  /** Пользователь сам сдвинул карту (жест или кнопки; программный ход камеры не в счёт) — центр после остановки. */
  onUserMove?: (center: { lat: number; lon: number }) => void;
  /** Меняется — камера плавно возвращается к первой точке («к моему месту»). */
  recenter?: number;
}

type Live = { sync: (points: readonly MapPoint[], follow: boolean) => void; recenter: () => void; destroy: () => void };

/** Сдвиг центра меньше этого (px) — не «пользователь выбрал место» (масштаб кнопками/щипком почти не двигает центр). */
const USER_MOVE_MIN_PX = 6;

/** Булавка без значка человека: капля (SVG строим узлами, не строкой). */
function dropIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 32');
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '37');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('gv-map-pin-drop');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M12 0C5.4 0 0 5.2 0 11.7 0 20.3 12 32 12 32s12-11.7 12-20.3C24 5.2 18.6 0 12 0z');
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('cx', '12');
  dot.setAttribute('cy', '11.5');
  dot.setAttribute('r', '4.5');
  svg.append(path, dot);
  return svg;
}

/** Содержимое метки: аватар в круге (если есть) или капля, под ней подпись. */
function fillPin(el: HTMLElement, p: MapPoint): void {
  el.replaceChildren();
  el.classList.toggle('has-avatar', !!p.avatarUrl);
  el.classList.toggle('is-me', !!p.me);
  if (p.me) {
    // «Вы здесь» — точка в кольце (Telegram Android: своё место — точкой слоя карты, капля — выбор в центре).
    const dot = document.createElement('span');
    dot.className = 'gv-map-me';
    el.append(dot);
    return;
  }
  if (p.avatarUrl) {
    const img = document.createElement('img');
    img.className = 'gv-map-pin-img';
    img.alt = '';
    img.draggable = false;
    img.src = p.avatarUrl;
    img.addEventListener('error', () => {
      el.classList.remove('has-avatar');
      img.remove();
      el.prepend(dropIcon());
    });
    el.append(img);
  } else {
    el.append(dropIcon());
  }
  if (p.label) {
    const t = document.createElement('span');
    t.className = 'gv-map-pin-label';
    t.textContent = p.label;
    el.append(t);
  }
}

export function MapView({ points, follow = false, interactive = false, className, onFail, emptyCenter, emptyFit, onUserMove, recenter }: MapViewProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const live = useRef<Live | null>(null);
  const latest = useRef({ points, follow, onFail, emptyCenter, emptyFit, onUserMove });
  latest.current = { points, follow, onFail, emptyCenter, emptyFit, onUserMove };

  useEffect(() => {
    const host = box.current;
    if (!host) return;
    let dead = false;
    void (async () => {
      try {
        // Стиль (`@protomaps/basemaps`) тоже ленивый: статический импорт увёл бы его в тот бандл, откуда подключён MapView.
        // Воркер MapLibre 6 — отдельный файл рядом с библиотекой; Vite сам его не подхватывает, отдаём адрес явно (`?url` — файл идёт в /assets/).
        const [ml, info, { buildMapStyle }, worker] = await Promise.all([
          import('maplibre-gl'),
          loadMapInfo(),
          import('../mapStyle'),
          import('maplibre-gl/dist/maplibre-gl-worker.mjs?url'),
          import('maplibre-gl/dist/maplibre-gl.css'),
        ]);
        if (dead) return;
        if (ml.getWorkerUrl() !== worker.default) ml.setWorkerUrl(worker.default);
        const base = mapApiBase();
        const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f2b33d';
        const lightNow = () => mapIsLight(document.documentElement.getAttribute('data-theme'));
        const first = latest.current.points;
        const empty = latest.current.emptyCenter;
        const plan =
          validMapPoints(first).length === 0 && empty && Number.isFinite(empty.lat) && Number.isFinite(empty.lon)
            ? { kind: 'center' as const, center: [empty.lon, empty.lat] as [number, number], zoom: MAP_POINT_ZOOM }
            : validMapPoints(first).length === 0 && latest.current.emptyFit
              ? regionCamera([info.bounds[0], info.bounds[1], info.bounds[2], info.bounds[3]], new Date().getTimezoneOffset())
              : initialCamera(first, info.center);
        const map: MlMap = new ml.Map({
          container: host,
          style: buildMapStyle(base, info, lightNow(), accent(), first),
          ...(plan.kind === 'center' ? { center: plan.center, zoom: plan.zoom } : { bounds: plan.bounds, fitBoundsOptions: { padding: 48, maxZoom: 16, animate: false } }),
          maxZoom: 19,
          minZoom: Math.max(0, info.minzoom),
          interactive,
          attributionControl: false,
          renderWorldCopies: false,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          transformRequest: (url) => mapTransformRequest(url),
        });
        map.addControl(
          new ml.AttributionControl({
            compact: false,
            customAttribution: interactive
              ? `<a href="${MAP_ATTRIBUTION_URL}" target="_blank" rel="noopener noreferrer">${MAP_ATTRIBUTION_TEXT}</a>`
              : MAP_ATTRIBUTION_TEXT,
          }),
          'bottom-right',
        );
        if (interactive) map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
        map.on('load', () => host.classList.add('is-ready'));

        const markers = new Map<string, MlMarker>();
        let placed = first.length > 0;
        let current: readonly MapPoint[] = first;
        // Ход камеры начат жестом/кнопкой (`originalEvent`) — после остановки сообщаем центр; первая точка камеру уже не дёргает.
        let userFrom: ReturnType<MlMap['getCenter']> | null = null;
        map.on('movestart', (e: { originalEvent?: unknown }) => {
          if (!e.originalEvent) return;
          userFrom = map.getCenter();
        });
        map.on('moveend', () => {
          const from = userFrom;
          userFrom = null;
          if (!from) return;
          // Старый центр в нынешнем виде против нового (центр вида): сдвиг в пикселях экрана.
          const c = map.getCenter();
          const a = map.project(from);
          const b = map.project(c);
          if (Math.hypot(a.x - b.x, a.y - b.y) < USER_MOVE_MIN_PX) return;
          placed = true;
          latest.current.onUserMove?.({ lat: c.lat, lon: c.lng });
        });
        const sync: Live['sync'] = (pts, follow) => {
          current = pts;
          const ok = validMapPoints(pts);
          const seen = new Set<string>();
          ok.forEach((p, i) => {
            const key = pointKey(p, i);
            seen.add(key);
            const have = markers.get(key);
            if (have) {
              have.setLngLat([p.lon, p.lat]);
              const el = have.getElement();
              if (el.dataset.sig !== `${p.label ?? ''}|${p.avatarUrl ?? ''}`) {
                fillPin(el, p);
                el.dataset.sig = `${p.label ?? ''}|${p.avatarUrl ?? ''}`;
              }
              return;
            }
            const el = document.createElement('div');
            el.className = 'gv-map-pin';
            el.dataset.sig = `${p.label ?? ''}|${p.avatarUrl ?? ''}`;
            fillPin(el, p);
            markers.set(key, new ml.Marker({ element: el, anchor: p.avatarUrl || p.me ? 'center' : 'bottom' }).setLngLat([p.lon, p.lat]).addTo(map));
          });
          for (const [key, m] of markers) {
            if (!seen.has(key)) {
              m.remove();
              markers.delete(key);
            }
          }
          const acc = map.getSource(ACC_SOURCE) as { setData?: (d: unknown) => void } | undefined;
          acc?.setData?.(accuracyCollection(ok));
          if (!ok.length) return;
          if (!placed) {
            placed = true;
            const c = initialCamera(ok, info.center);
            if (c.kind === 'center') map.jumpTo({ center: c.center, zoom: c.zoom });
            else map.fitBounds(c.bounds, { padding: 48, maxZoom: 16, animate: false });
          } else if (follow) {
            map.easeTo({ center: [ok[0].lon, ok[0].lat], duration: 500 });
          }
        };
        sync(first, latest.current.follow);

        // Тема приложения сменилась — перекрашиваем стиль; метки живут отдельно от стиля, круги точности вернём из `current`.
        const themeWatch = new MutationObserver(() => {
          map.setStyle(buildMapStyle(base, info, lightNow(), accent(), current), { diff: false });
        });
        themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

        live.current = {
          sync,
          recenter: () => {
            const ok = validMapPoints(current);
            if (!ok.length) return;
            map.easeTo({ center: [ok[0].lon, ok[0].lat], zoom: Math.max(map.getZoom(), MAP_POINT_ZOOM), duration: 500 });
          },
          destroy: () => {
            themeWatch.disconnect();
            for (const m of markers.values()) m.remove();
            markers.clear();
            map.remove();
          },
        };
        if (latest.current.points !== first) sync(latest.current.points, latest.current.follow);
      } catch {
        if (!dead) latest.current.onFail?.();
      }
    })();
    return () => {
      dead = true;
      live.current?.destroy();
      live.current = null;
      host.classList.remove('is-ready');
    };
  }, [interactive]);

  useEffect(() => {
    live.current?.sync(points, follow);
  }, [points, follow]);

  useEffect(() => {
    if (recenter) live.current?.recenter();
  }, [recenter]);

  return <div className={`gv-map${className ? ` ${className}` : ''}`} ref={box} />;
}
