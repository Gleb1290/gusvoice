import { lazy } from 'react';
import type { GeoSystemHooks } from './components/GeoPickDialog';
import { confirmAction } from './confirm';
import { isAndroid } from './hotkeys';

/**
 * Геолокация выключена в системе (15.10, приёмка 0.9.0, замечание к G69 / `geolive1`).
 *
 * Android WebView при выключенной геолокации не отвечает ошибкой сразу — ждёт таймаута (у нас 20 с) и отдаёт «время вышло».
 * Telegram Android на открытии «Геопозиции» сам спрашивает систему (`ChatAttachAlertLocationLayout`: `isProviderEnabled(GPS_PROVIDER)`)
 * и показывает окно `GpsDisabledAlertText` с кнопкой «Включить» → `Settings.ACTION_LOCATION_SOURCE_SETTINGS`. У нас то же через мост
 * `GusVoiceNative.locationEnabled` / `openLocationSettings` (`MainActivity.kt`). Старый APK без моста, ПК и веб — системы не
 * спрашиваем: там только понятный текст ошибки с подсказкой проверить геолокацию (`GeoPickDialog.geoErrorText`). В окно мост
 * приходит пропом `system` (`geoSystemHooks`): сам `GeoPickDialog` ничего не импортирует сверх прежнего.
 */

interface LocationBridge {
  locationEnabled?: () => boolean;
  openLocationSettings?: () => boolean;
}

function bridge(): LocationBridge | null {
  if (!isAndroid() || typeof window === 'undefined') return null;
  const b = (window as unknown as { GusVoiceNative?: LocationBridge }).GusVoiceNative;
  return b && typeof b.locationEnabled === 'function' ? b : null;
}

/** true — система ТОЧНО сказала «геолокация выключена». Нет моста или мост упал — false: окно не должно врать. */
export function systemLocationOff(): boolean {
  const b = bridge();
  if (!b) return false;
  try {
    return b.locationEnabled!() === false;
  } catch {
    return false;
  }
}

/** Есть ли куда вести кнопкой «Включить» (только приложение Android с новым мостом). */
export function canOpenLocationSettings(): boolean {
  const b = bridge();
  return !!b && typeof b.openLocationSettings === 'function';
}

/** Открыть системные настройки геолокации. false — некуда (веб, ПК, старый APK). */
export function openLocationSettings(): boolean {
  const b = bridge();
  if (!b || typeof b.openLocationSettings !== 'function') return false;
  try {
    return b.openLocationSettings() !== false;
  } catch {
    return false;
  }
}

/** Слова окна «геолокация выключена» (Telegram: `GpsDisabledAlertText` + «Включить» / «Отмена»). */
export const GEO_OFF_TITLE = 'Геолокация выключена';
export const GEO_OFF_BODY = 'Включите геолокацию в настройках телефона, чтобы отправить своё местоположение.';
export const GEO_OFF_ACTION = 'Включить';

/** Проп `system` для `GeoPickDialog` (даёт `MessagePane`): окно «Геолокация выключена» — общее `confirmAction`, значок булавки. */
export const geoSystemHooks: GeoSystemHooks = {
  off: systemLocationOff,
  canOpen: canOpenLocationSettings,
  open: () => void openLocationSettings(),
  ask: () => confirmAction({ title: GEO_OFF_TITLE, body: GEO_OFF_BODY, confirmLabel: GEO_OFF_ACTION, cancelLabel: 'Отмена', icon: 'map-pin' }),
};

/**
 * Карта окна «Геопозиция» (15.10, `geopick2`): `GeoPickMap` (MapLibre) — ЛЕНИВО, в основной бандл не входит; `MessagePane` отдаёт её
 * окну пропом `map` рядом с `system` (само окно ничего тяжёлого не импортирует).
 */
export const GeoPickMapLazy = lazy(() => import('./components/GeoPickMap'));
