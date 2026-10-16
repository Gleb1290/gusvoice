import {
  accuracyText,
  contactHandle,
  contactName,
  geoText,
  geoUri,
  parseConvMedia,
  type ConvContactMedia,
  type ConvGeoMedia,
  type ConvMediaMark,
  yandexMapsUrl,
} from '@gusvoice/shared';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { serverOsmMap, serverYandexMap } from '../convSyncRules';
import { openLink } from '../linkGuard';
import { GEO_MAP_CSS_H, GEO_MAP_CSS_W, loadMapImage, mapThemeNow } from '../mapImage';
import { useStore } from '../store';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

/**
 * Геопозиция и карточка контакта в ленте ЛС (14.10, G69, признак сервера `geocontact1`; правила — `shared/convMedia.ts`).
 *
 * Как у Telegram: геопозиция — пузырь с картой, по нажатию — место во внешних картах (Android `LocationActivity`, «Open in…»;
 * Web K открывает ссылку карт); контакт — аватар, имя, ник и кнопка «Написать» (Android `SharedContactCell` /
 * `ChatMessageCell` с `MessageObject.TYPE_CONTACT`, Web K `messageMediaContact`). Картинку карты клиент берёт ТОЛЬКО у своего
 * сервера (`mapImage.ts`, признак `yamap1`; сервер проксирует Static API Яндекса) — к сторонним серверам не ходит (приватность и CSP).
 * Нет признака или картинка не пришла — карточка без неё: значок места, координаты и точность.
 */

/** Вид сообщения ленты: только знакомый (`parseConvMedia`); незнакомый — `null`, и лента покажет запасной `content`. */
export function convMediaOf(m: { media?: unknown }): ConvMediaMark | null {
  return m.media ? parseConvMedia(m.media) : null;
}

const stripped = new WeakMap<object, object>();

/**
 * Сообщение для строки ленты без запасного текста (координаты со ссылкой, «Контакт: …»): его место занимает карточка. Тот же
 * объект на тот же вход (`WeakMap`) — строка ленты не перерисовывается зря. Незнакомый вид — как есть (покажется текст).
 */
export function withoutMediaFallback<T extends { content: string }>(m: T): T {
  if (!m.content || !convMediaOf(m as { media?: unknown })) return m;
  const hit = stripped.get(m);
  if (hit) return hit as T;
  const out = { ...m, content: '' };
  stripped.set(m, out);
  return out;
}

type GeoBridge = { openExternalUri?: (uri: string, fallback: string) => boolean };

/**
 * Открыть место во внешних картах. Приложение Android — `geo:` через мост (`MainActivity.openExternalUri`: ACTION_VIEW, нет
 * приложения карт — Яндекс Карты в браузере); ПК — Яндекс Карты в браузере ОС, веб — в новой вкладке (`openLink`).
 * Запасной текст сообщения (для старых клиентов) остаётся с OpenStreetMap — это провод (`convMediaFallback`).
 */
export function openGeoExternally(lat: number, lon: number): void {
  const web = yandexMapsUrl(lat, lon);
  const bridge = (window as unknown as { GusVoiceNative?: GeoBridge }).GusVoiceNative;
  if (bridge?.openExternalUri) {
    try {
      if (bridge.openExternalUri(geoUri(lat, lon), web)) return;
    } catch {
      // старый мост без метода или исключение натива — как в браузере
    }
  }
  openLink(web);
}

/**
 * Картинка карты над подписью: грузится, когда карточка рядом с видимой частью ленты (`IntersectionObserver`, как плитки
 * `GifPicker`); до прихода держит место (`.msg-geo-map`), чтобы лента не прыгала. Отказ — `onFail`, карточка без картинки.
 */
function GeoMapPic({ lat, lon, onFail }: { lat: number; lon: number; onFail: () => void }) {
  const box = useRef<HTMLSpanElement | null>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const el = box.current;
    if (near || !el) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) setNear(true);
    }, { rootMargin: '240px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  useEffect(() => {
    if (!near) return;
    let live = true;
    void loadMapImage(lat, lon, mapThemeNow()).then((url) => {
      if (!live) return;
      if (url) setSrc(url);
      else onFail();
    });
    return () => {
      live = false;
    };
  }, [near, lat, lon, onFail]);
  return (
    <span className="msg-geo-map" ref={box} style={{ aspectRatio: `${GEO_MAP_CSS_W} / ${GEO_MAP_CSS_H}` }}>
      {src && <img src={src} alt="" draggable={false} onError={onFail} />}
    </span>
  );
}

/**
 * Живая карта своего сервера (`osmmap1`, 14.10): компоненты с MapLibre грузятся лениво — в основной бандл не входят и не запрашиваются,
 * пока нет признака и карточки на экране. Карточка: маленькая карта, нажатие — окно на весь экран (`GeoMapFull`).
 */
const GeoMapLiveLazy = lazy(() => import('./GeoMapLive'));
const GeoMapFullLazy = lazy(() => import('./GeoMapLive').then((m) => ({ default: m.GeoMapFull })));

/**
 * Карточка геопозиции в пузыре: карта (если сервер её даёт), значок места, «Геопозиция», координаты и точность.
 * Карта: своя живая (`osmmap1`, нажатие — полноэкранная карта с «Открыть в картах»), иначе картинка Яндекса (`yamap1`, нажатие — внешние карты).
 */
export function GeoCard({ geo }: { geo: ConvGeoMedia }) {
  const acc = accuracyText(geo.accuracy);
  const mapOn = useStore((st) => serverYandexMap(st.serverFeatures));
  const osmOn = useStore((st) => serverOsmMap(st.serverFeatures));
  const [mapFailed, setMapFailed] = useState(false);
  const failMap = useCallback(() => setMapFailed(true), []);
  const [osmFailed, setOsmFailed] = useState(false);
  const failOsm = useCallback(() => setOsmFailed(true), []);
  const [full, setFull] = useState(false);
  const liveMap = osmOn && !osmFailed;
  const withMap = mapOn && !mapFailed;
  const hasMap = liveMap || withMap;
  const card = (
    <button
      type="button"
      className={`msg-geo${hasMap ? ' has-map' : ''}`}
      title={liveMap ? 'Открыть карту' : 'Открыть на карте'}
      onClick={(e) => {
        e.stopPropagation();
        if (liveMap) setFull(true);
        else openGeoExternally(geo.lat, geo.lon);
      }}
    >
      {liveMap ? (
        <Suspense fallback={<span className="msg-geo-map msg-geo-live" style={{ aspectRatio: `${GEO_MAP_CSS_W} / ${GEO_MAP_CSS_H}` }} />}>
          <GeoMapLiveLazy lat={geo.lat} lon={geo.lon} accuracy={geo.accuracy ?? null} onFail={failOsm} />
        </Suspense>
      ) : (
        withMap && <GeoMapPic lat={geo.lat} lon={geo.lon} onFail={failMap} />
      )}
      <span className="msg-geo-ico" aria-hidden="true">
        <Icon name="map-pin" size={22} />
      </span>
      <span className="msg-geo-text">
        <span className="msg-geo-title">Геопозиция</span>
        <span className="msg-geo-sub">{geoText(geo.lat, geo.lon)}</span>
        {acc && <span className="msg-geo-sub">{acc}</span>}
      </span>
    </button>
  );
  if (!full) return card;
  // Окно рядом с кнопкой, не внутри неё: нажатия в окне не должны попадать в карточку.
  return (
    <>
      {card}
      <Suspense fallback={null}>
        <GeoMapFullLazy
          lat={geo.lat}
          lon={geo.lon}
          accuracy={geo.accuracy ?? null}
          onClose={() => setFull(false)}
          onOpenExternal={() => openGeoExternally(geo.lat, geo.lon)}
        />
      </Suspense>
    </>
  );
}

/**
 * Карточка контакта: аватар, имя, `@ник` (у человека другого инстанса — `@ник@домен` и название инстанса). Нажатие на шапку —
 * профиль (`onProfile`), «Написать» — беседа с ним (`onMessage`). Человека у нас нет (`userId: null`) — карточка без действий.
 */
export function ContactCard({
  contact,
  onProfile,
  onMessage,
}: {
  contact: ConvContactMedia;
  onProfile?: (e: MouseEvent, userId: string) => void;
  onMessage?: (userId: string) => void;
}) {
  const name = contactName(contact);
  const handle = contactHandle(contact);
  const home = contact.home ? contact.home.name || contact.home.domain : null;
  const userId = contact.userId;
  const head = (
    <>
      <Avatar url={contact.avatarUrl} name={name} size={44} />
      <span className="msg-contact-text">
        <span className="msg-contact-name">{name}</span>
        {handle && <span className="msg-contact-sub">{handle}</span>}
        {home && (
          <span className="msg-contact-sub msg-contact-home">
            <Icon name="globe" size={12} />
            {home}
          </span>
        )}
      </span>
    </>
  );
  return (
    <div className="msg-contact">
      {userId && onProfile ? (
        <button
          type="button"
          className="msg-contact-head"
          title="Профиль"
          onClick={(e) => {
            e.stopPropagation();
            onProfile(e, userId);
          }}
        >
          {head}
        </button>
      ) : (
        <div className="msg-contact-head">{head}</div>
      )}
      {userId && onMessage && (
        <button
          type="button"
          className="msg-contact-act"
          onClick={(e) => {
            e.stopPropagation();
            onMessage(userId);
          }}
        >
          Написать
        </button>
      )}
    </div>
  );
}

/** Карточка вида сообщения для ленты (одна точка: следующий вид — опрос — новой веткой здесь). */
export function ConvMediaView({
  media,
  onProfile,
  onMessage,
}: {
  media: ConvMediaMark;
  onProfile?: (e: MouseEvent, userId: string) => void;
  onMessage?: (userId: string) => void;
}) {
  if (media.kind === 'geo') return <GeoCard geo={media} />;
  // Опрос (`convpoll1`) рисует `ConvPoll.tsx` — ему нужны беседа и сообщение (голос), лента зовёт его сама.
  if (media.kind === 'poll') return null;
  // Трансляция геопозиции (`geolive1`) рисует `GeoLiveCard.tsx` — ему нужны беседа и сообщение (остановить), лента зовёт его сама.
  if (media.kind === 'geolive') return null;
  return <ContactCard contact={media} onProfile={onProfile} onMessage={onMessage} />;
}
