import { accuracyText, GEO_LIVE_PERIODS, geoLivePeriodLabel, geoText, type ConvMediaInput, type GeoLivePeriod } from '@gusvoice/shared';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useDialogChrome } from '../dialogChrome';
import { usePhoneLayout } from '../phoneLayout';
import { toastError } from '../toast';
import { BottomSheet } from './BottomSheet';
import { Icon } from './Icon';

/**
 * «Геопозиция» из листа вложений ЛС (14.10, G69, `geocontact1`): текущее место (`navigator.geolocation`, высокая точность) и
 * кнопка «Отправить моё местоположение». Как Telegram Android `ChatAttachAlertLocationLayout`: строка `SendLocationCell`
 * «Send my current location» с подписью «Accurate to N meters», точность уточняется, пока окно открыто (`watchPosition`).
 * Телефон — лист снизу, ПК — окно.
 *
 * «Транслировать геопозицию» (14.10, `geolive1`, проп `live`): вторая строка и выбор срока 15 минут / 1 час / 8 часов — как у
 * Telegram Android (`ChatAttachAlertLocationLayout`: «Share My Live Location for…» → `showLiveLocationAlert`). Строку даёт только
 * телефонная раскладка: Telegram Desktop и Web K трансляцию не начинают вовсе (в их исходниках нет исходящего
 * `inputMediaGeoLive`), на ПК место определяется по сети и «живая» точка бессмысленна.
 *
 * Геолокация выключена в системе (15.10, приёмка 0.9.0): приложение Android спрашивает систему сразу (проп `system` — мост
 * `geoSystem.geoSystemHooks`, его даёт `MessagePane`) и один раз за открытие показывает окно «Геолокация выключена» с «Включить» →
 * системные настройки, как Telegram Android
 * (`ChatAttachAlertLocationLayout`, флаг `checkGpsEnabled`); в окне — строка «Геолокация выключена · Включить», пока её не включат
 * (проверка раз в секунду, включили — место ищется заново). ПК, веб, старый APK — текст ошибки с подсказкой (`geoErrorText`).
 * Трансляция начинается из этого же окна — правило общее.
 *
 * Карта и ожидание без отсечки (15.10, `geopick2`, приёмка 0.9.0 — в квартире без GPS окно сдавалось через 20 с): как Telegram Android
 * `ChatAttachAlertLocationLayout` — сразу карта (проп `map`, ленивый `GeoPickMap`; сервер без карты — окно без неё), место ждём сколько
 * угодно (строка «Определяем местоположение…», через `GEO_SLOW_MS` — подсказка, не ошибка). Сдвинули карту — в центре булавка, первая
 * строка становится «Отправить выбранное место» (Telegram `LocationActivityAdapter`: `SendSelectedLocation` вместо `SendLocation`
 * в той же ячейке) и шлёт центр карты без точности; «к моему месту» возвращает камеру (Telegram `locationButton`, `userLocationMoved = false`).
 * Трансляция — только от своей настоящей точки (Telegram `setHasLocation(gpsLocation != null)`), пока её нет — подпись почему.
 */

type Fix = { lat: number; lon: number; accuracy: number | null };
type GeoState = { kind: 'locating' } | { kind: 'fix'; fix: Fix } | { kind: 'error'; text: string } | { kind: 'off' };
type Center = { lat: number; lon: number };

/** Свойства карты окна (`GeoPickMap`): своё место, вести ли за ним камеру, «к моему месту», сдвиг пользователем, «карты нет». */
export interface GeoPickMapProps {
  fix: Fix | null;
  follow: boolean;
  recenter: number;
  onUserMove: (center: Center) => void;
  onFail: () => void;
}

/**
 * Срок одной попытки `watchPosition`, мс. Для слежения это НЕ отсечка: Chromium/WebView после кода 3 слежение продолжают — мы
 * считаем его «пока ничего» (подсказка), а не ошибкой.
 */
const GEO_TIMEOUT_MS = 20_000;
/** Без места дольше этого — подсказка, как помочь телефону (окно, точность местоположения). */
const GEO_SLOW_MS = 15_000;
/** «Место недоступно» (код 2) без выключенной системы — слежение перезапускаем через столько, мс, и ждём дальше. */
const GEO_RESTART_MS = 5_000;
/** Подсказки «место пока не найдено»: телефон — GPS не ловит в помещении; компьютер — место по сети. */
const GEO_SLOW_PHONE = 'Место пока не найдено. Подойдите к окну или включите «Точность местоположения» в настройках телефона.';
const GEO_SLOW_DESKTOP = 'Место пока не найдено: компьютер определяет его по сети, это бывает долго.';
const GEO_SLOW_MAP = 'Можно сдвинуть карту и отправить выбранное место.';

/**
 * Система геолокации (Android-мост): выключена ли, можно ли открыть настройки, открыть, спросить окном «Включить?».
 * Нет пропа — системы не спрашиваем (ПК, веб, старый APK): только текст ошибки с подсказкой.
 */
export interface GeoSystemHooks {
  off: () => boolean;
  canOpen: () => boolean;
  open: () => void;
  ask: () => Promise<boolean>;
}

const GEO_OFF_TEXT = 'Геолокация выключена.';
const GEO_OFF_ACTION = 'Включить';
/** Подсказка к «не удалось»: место не пришло чаще всего потому, что геолокация на устройстве выключена. */
const GEO_CHECK_HINT = 'Проверьте, что геолокация на устройстве включена.';

/**
 * Слова ошибки `GeolocationPositionError` (1 — запрет, 2 — нет места; `null` — API нет вовсе). Код 3 (попытка не уложилась) ошибкой
 * больше не бывает — слежение идёт дальше (`geopick2`).
 * 2 — с подсказкой проверить геолокацию: на ПК и в вебе системы не спросить, а это самая частая причина.
 */
function geoErrorText(code: number | null): string {
  if (code === 1) return 'Нет доступа к геопозиции. Разрешите его в настройках браузера или приложения.';
  if (code === null) return 'Это устройство не умеет определять место.';
  return `Не удалось определить место. ${GEO_CHECK_HINT}`;
}

/** Пока геолокация выключена — спрашивать систему так часто: вернулся из настроек — место ищется без «Повторить». */
const GEO_OFF_POLL_MS = 1000;

export function GeoPickDialog({
  onSend,
  onClose,
  live,
  system,
  map: MapSlot,
}: {
  onSend: (media: ConvMediaInput) => Promise<void>;
  onClose: () => void;
  live?: boolean;
  system?: GeoSystemHooks;
  /** Карта окна (ленивый `GeoPickMap` из `MessagePane`); нет — окно без карты, как на сервере без файла карты. */
  map?: React.ComponentType<GeoPickMapProps>;
}) {
  const phone = usePhoneLayout();
  const liveOn = !!live && phone;
  const [state, setState] = useState<GeoState>({ kind: 'locating' });
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const best = useRef<Fix | null>(null);
  // Выбор срока трансляции (вторая страница окна).
  const [pickPeriod, setPickPeriod] = useState(false);
  // Окно «Геолокация выключена» — один раз за открытие (Telegram `checkGpsEnabled`), дальше — строка с «Включить».
  const offAsked = useRef(false);
  // Место долго не приходит — подсказка (не ошибка): ждём дальше.
  const [slow, setSlow] = useState(false);
  // Центр карты, выбранный пользователем (сдвинул карту); `null` — карта идёт за своим местом.
  const [chosen, setChosen] = useState<Center | null>(null);
  const [recenter, setRecenter] = useState(0);
  const [mapFailed, setMapFailed] = useState(false);
  const mapOn = !!MapSlot && !mapFailed;

  useEffect(() => {
    const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
    if (!geo) {
      setState({ kind: 'error', text: geoErrorText(null) });
      return;
    }
    best.current = null;
    if (system?.off()) {
      setState({ kind: 'off' });
      if (!offAsked.current) {
        offAsked.current = true;
        void system.ask().then((ok) => ok && system.open());
      }
      // Включили (из окна, из шторки) — ищем место заново.
      const t = window.setInterval(() => {
        if (!system.off()) setRound((r) => r + 1);
      }, GEO_OFF_POLL_MS);
      return () => window.clearInterval(t);
    }
    setState({ kind: 'locating' });
    const slowTimer = window.setTimeout(() => setSlow(true), GEO_SLOW_MS);
    let restart = 0;
    // Как Telegram: место уточняется, пока окно открыто; берём самое точное из пришедших. Ждём сколько угодно.
    const id = geo.watchPosition(
      (p) => {
        const fix = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null };
        const prev = best.current;
        if (!prev || prev.accuracy === null || (fix.accuracy !== null && fix.accuracy <= prev.accuracy)) {
          best.current = fix;
          setState({ kind: 'fix', fix });
        }
      },
      (e) => {
        // Место уже есть — ошибка уточнения не отнимает его. Выключили геолокацию, пока искали, — та же строка «Включить».
        if (best.current) return;
        if (e.code !== 1 && system?.off()) setRound((r) => r + 1);
        else if (e.code === 1) setState({ kind: 'error', text: geoErrorText(e.code) });
        else {
          // 3 — попытка не уложилась, слежение идёт дальше; 2 — место пока недоступно: подсказка и новый заход чуть позже.
          setSlow(true);
          if (e.code === 2 && !restart) restart = window.setTimeout(() => setRound((r) => r + 1), GEO_RESTART_MS);
        }
      },
      { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 0 },
    );
    return () => {
      window.clearTimeout(slowTimer);
      window.clearTimeout(restart);
      geo.clearWatch(id);
    };
  }, [round]);

  const send = async () => {
    if (busy) return;
    // Выбранное на карте место — центр карты, точность не указывается (Telegram «Send selected location»).
    const place = chosen ? { lat: chosen.lat, lon: chosen.lon, accuracy: null } : state.kind === 'fix' ? state.fix : null;
    if (!place) return;
    setBusy(true);
    try {
      await onSend({ kind: 'geo', lat: place.lat, lon: place.lon, accuracy: place.accuracy });
      onClose();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  const sendLive = async (period: GeoLivePeriod) => {
    if (state.kind !== 'fix' || busy) return;
    setBusy(true);
    try {
      await onSend({ kind: 'geolive', lat: state.fix.lat, lon: state.fix.lon, accuracy: state.fix.accuracy, period });
      onClose();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  const fix = state.kind === 'fix' ? state.fix : null;
  const acc = fix ? accuracyText(fix.accuracy) : '';
  const waiting = !fix && state.kind === 'locating';
  const toMe = () => {
    setChosen(null);
    setRecenter((r) => r + 1);
  };
  const mySub = waiting ? 'Определяем местоположение…' : fix ? (acc ? `${acc[0].toUpperCase()}${acc.slice(1)}` : geoText(fix.lat, fix.lon)) : '';
  const body = pickPeriod ? (
    <div className="geo-pick" role="group" aria-label="Транслировать геопозицию">
      <button type="button" className="geo-pick-back link" onClick={() => setPickPeriod(false)}>
        <Icon name="chevron-left" size={16} /> Назад
      </button>
      <div className="geo-pick-hint">Собеседник видит, где вы, пока трансляция идёт. Остановить её можно в любой момент.</div>
      {GEO_LIVE_PERIODS.map((p) => (
        <button key={p} type="button" className="geo-pick-send geo-pick-period" disabled={!fix || busy} onClick={() => void sendLive(p)}>
          <span className="geo-pick-ico" aria-hidden="true">
            <Icon name="clock" size={22} />
          </span>
          <span className="geo-pick-text">
            <span className="geo-pick-title">{geoLivePeriodLabel(p)}</span>
          </span>
        </button>
      ))}
    </div>
  ) : (
    <div className="geo-pick">
      {mapOn && MapSlot && (
        <div className="geo-pick-map">
          <Suspense fallback={null}>
            <MapSlot fix={fix} follow={!chosen} recenter={recenter} onUserMove={setChosen} onFail={() => setMapFailed(true)} />
          </Suspense>
          {(chosen || !fix) && (
            // Булавка выбора в центре карты (Telegram `markerImageView`, 28×48 dp): кончик капли — точно в центре.
            <svg className="geo-pick-map-pin gv-map-pin-drop" viewBox="0 0 24 32" width="28" height="37" aria-hidden="true">
              <path d="M12 0C5.4 0 0 5.2 0 11.7 0 20.3 12 32 12 32s12-11.7 12-20.3C24 5.2 18.6 0 12 0z" />
              <circle cx="12" cy="11.5" r="4.5" />
            </svg>
          )}
          {waiting && (
            <span className="geo-pick-map-status" role="status">
              Определяем местоположение…
            </span>
          )}
          {fix && (
            <button type="button" className={`geo-pick-map-me${chosen ? '' : ' is-on'}`} title="К моему месту" aria-label="К моему месту" onClick={toMe}>
              <Icon name="locate" size={20} />
            </button>
          )}
        </div>
      )}
      <button type="button" className={`geo-pick-send${chosen ? ' is-chosen' : ''}`} disabled={(!fix && !chosen) || busy} onClick={() => void send()}>
        <span className="geo-pick-ico" aria-hidden="true">
          <Icon name="map-pin" size={22} />
        </span>
        <span className="geo-pick-text">
          <span className="geo-pick-title">{chosen ? 'Отправить выбранное место' : 'Отправить моё местоположение'}</span>
          <span className="geo-pick-sub">{chosen ? geoText(chosen.lat, chosen.lon) : mySub}</span>
        </span>
      </button>
      {liveOn && (
        <button type="button" className="geo-pick-send geo-pick-live" disabled={!fix || busy} onClick={() => setPickPeriod(true)}>
          <span className="geo-pick-ico" aria-hidden="true">
            <Icon name="clock" size={22} />
          </span>
          <span className="geo-pick-text">
            <span className="geo-pick-title">Транслировать геопозицию</span>
            <span className="geo-pick-sub">{fix ? 'Обновляется, пока вы двигаетесь' : 'Станет доступно, когда найдём ваше место'}</span>
          </span>
        </button>
      )}
      {fix && acc && !chosen && <div className="geo-pick-coords">{geoText(fix.lat, fix.lon)}</div>}
      {waiting && slow && (
        <div className="geo-pick-hint geo-pick-slow" role="status">
          {phone ? GEO_SLOW_PHONE : GEO_SLOW_DESKTOP}
          {mapOn ? ` ${GEO_SLOW_MAP}` : ''}
        </div>
      )}
      {state.kind === 'off' && (
        <div className="geo-pick-error" role="alert">
          <span>{GEO_OFF_TEXT}</span>
          {system?.canOpen() && (
            <button type="button" className="link" onClick={() => system.open()}>
              {GEO_OFF_ACTION}
            </button>
          )}
        </div>
      )}
      {state.kind === 'error' && (
        <div className="geo-pick-error" role="alert">
          <span>{state.text}</span>
          <button type="button" className="link" onClick={() => setRound((r) => r + 1)}>
            Повторить
          </button>
        </div>
      )}
    </div>
  );

  return phone ? (
    <BottomSheet title="Геопозиция" onClose={onClose}>
      {body}
    </BottomSheet>
  ) : (
    <GeoModal onClose={onClose}>{body}</GeoModal>
  );
}

/** ПК: окно по центру, Esc и возврат фокуса — `useDialogChrome` (как «Написать», `DmSidebar.ComposeDialog`). */
function GeoModal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const dialogRef = useDialogChrome<HTMLDivElement>(onClose);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal geo-pick-modal"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Геопозиция"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-head">
          <h2>Геопозиция</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
