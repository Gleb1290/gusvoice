import { geoLiveEnded, geoLiveShouldSend, GEO_LIVE_LIMITS, type ConvGeoLiveMedia } from '@gusvoice/shared';
import { create } from 'zustand';
import { api, getToken } from './api';
import { activeInstanceId, config } from './config';
import { isAndroid } from './hotkeys';

/**
 * «Транслировать геопозицию» в ЛС (14.10, `geolive1`): мои идущие трансляции и отправка точек.
 *
 * Как у Telegram Android `LocationController` (`sharingLocations`): список идущих трансляций живёт отдельно от ленты, одна
 * подписка на геопозицию на все, точка уходит не чаще раза в `GEO_LIVE_LIMITS.sendGapMs` и только при сдвиге на 10 м или
 * раз в 20 с (`geoLiveShouldSend`; Telegram: `SEND_NEW_LOCATION_TIME` 2 с / `FOREGROUND_UPDATE_TIME` 20 с), по истечении срока —
 * запись снимается (`stopTime <= currentTime`), последнюю точку сообщение хранит. «Остановить» — `stopSharingLocation`.
 *
 * Где точки идут:
 *  - Android-приложение — службой переднего плана `LiveLocationService` (мост `GusVoiceNative.startLiveLocation`): точки уходят и
 *    при свёрнутом приложении, адрес API и токен — в память службы; здесь только учёт (какие идут) и «Остановить»;
 *  - веб, ПК и старый APK без моста — `navigator.geolocation.watchPosition` в самой странице: пока вкладка/приложение открыто.
 * Записи переживают перезагрузку страницы (`localStorage`, пока не вышел срок) — как `sharing_locations` у Telegram в базе.
 */

export interface GeoLiveShare {
  conversationId: string;
  messageId: string;
  /** Конец трансляции, мс Unix (из `ConvGeoLiveMedia.until`). */
  until: number;
  /** Инстанс, на котором она идёт: точки шлются только когда он активен (токен и адрес — его). */
  instanceId: string;
  /** Точки шлёт нативная служба, а не страница. */
  native: boolean;
}

const KEY = 'gv_geolive';

function load(): GeoLiveShare[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    const now = Date.now();
    return raw.filter(
      (r): r is GeoLiveShare =>
        !!r && typeof r === 'object' && typeof r.conversationId === 'string' && typeof r.messageId === 'string' && typeof r.until === 'number' && r.until > now && typeof r.instanceId === 'string',
    );
  } catch {
    return [];
  }
}

function save(list: GeoLiveShare[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* хранилище недоступно — трансляция живёт до перезагрузки */
  }
}

export const useGeoLive = create<{ list: GeoLiveShare[] }>(() => ({ list: [] }));

let booted = false;
function boot(): void {
  if (booted) return;
  booted = true;
  useGeoLive.setState({ list: load() });
}

function setList(list: GeoLiveShare[]): void {
  save(list);
  useGeoLive.setState({ list });
  rearm();
}

/** Моя идущая трансляция этого сообщения. */
export function geoLiveShareOf(list: readonly GeoLiveShare[], messageId: string): GeoLiveShare | undefined {
  return list.find((s) => s.messageId === messageId);
}

// --- мост Android ---
interface LiveBridge {
  startLiveLocation?: (json: string) => boolean;
  stopLiveLocation?: (messageId: string) => void;
  stopAllLiveLocations?: () => void;
  liveLocationIds?: () => string;
}
function liveBridge(): LiveBridge | null {
  if (!isAndroid()) return null;
  const b = (window as unknown as { GusVoiceNative?: LiveBridge }).GusVoiceNative;
  return b && typeof b.startLiveLocation === 'function' ? b : null;
}

/** Служба переднего плана берёт трансляцию: адрес API и токен уходят в её память (не в журнал и не на диск). */
function startNative(s: Omit<GeoLiveShare, 'native'>): boolean {
  const b = liveBridge();
  const token = getToken();
  if (!b || !token) return false;
  try {
    return b.startLiveLocation!(
      JSON.stringify({ apiUrl: config.apiUrl, token, conversationId: s.conversationId, messageId: s.messageId, until: s.until, backgroundMs: GEO_LIVE_LIMITS.backgroundMs }),
    );
  } catch (e) {
    console.warn('[geolive] startLiveLocation failed', e);
    return false;
  }
}

// --- отправка точек со страницы ---
const last = new Map<string, { lat: number; lon: number; at: number }>();
const inFlight = new Set<string>();
let watchId: number | null = null;
let tick: number | null = null;

function errStatus(e: unknown): number | null {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}

function drop(messageId: string): void {
  last.delete(messageId);
  inFlight.delete(messageId);
  const list = useGeoLive.getState().list;
  if (list.some((s) => s.messageId === messageId)) setList(list.filter((s) => s.messageId !== messageId));
}

function onFix(p: GeolocationPosition): void {
  const now = Date.now();
  const point = { lat: p.coords.latitude, lon: p.coords.longitude };
  const accuracy = Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null;
  const heading = p.coords.heading !== null && Number.isFinite(p.coords.heading) ? p.coords.heading : null;
  for (const s of useGeoLive.getState().list) {
    if (s.native || s.instanceId !== (activeInstanceId() ?? '')) continue;
    if (geoLiveEnded({ until: s.until, stopped: false }, now)) {
      drop(s.messageId);
      continue;
    }
    if (inFlight.has(s.messageId) || !geoLiveShouldSend(last.get(s.messageId) ?? null, point, now)) continue;
    inFlight.add(s.messageId);
    last.set(s.messageId, { ...point, at: now });
    void api
      .convGeoLiveUpdate(s.conversationId, s.messageId, { ...point, accuracy, heading })
      .then(
        () => undefined,
        (e) => {
          // Сообщения нет / трансляция кончилась / не автор — дальше слать нечего; сеть и 429 — подождём следующей точки.
          const st = errStatus(e);
          if (st === 403 || st === 404) drop(s.messageId);
        },
      )
      .finally(() => inFlight.delete(s.messageId));
  }
}

function stopWatch(): void {
  if (watchId !== null && typeof navigator !== 'undefined') navigator.geolocation?.clearWatch(watchId);
  watchId = null;
  if (tick !== null) window.clearInterval(tick);
  tick = null;
}

/** Нужна ли подписка на геопозицию (идёт трансляция, которую ведёт страница) и учёт нативных. */
function rearm(): void {
  const list = useGeoLive.getState().list;
  const pageOwned = list.some((s) => !s.native && s.instanceId === (activeInstanceId() ?? ''));
  const anyNative = list.some((s) => s.native);
  if (pageOwned && watchId === null && typeof navigator !== 'undefined' && navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(onFix, () => undefined, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30_000 });
  } else if (!pageOwned && watchId !== null) {
    stopWatch();
  }
  if ((pageOwned || anyNative) && tick === null) {
    // Раз в 10 с: истёкшие снять, у нативных свериться со службой (её могли остановить кнопкой уведомления).
    tick = window.setInterval(housekeeping, 10_000);
  } else if (!pageOwned && !anyNative && tick !== null) {
    window.clearInterval(tick);
    tick = null;
  }
}

function housekeeping(): void {
  const now = Date.now();
  let list = useGeoLive.getState().list.filter((s) => s.until > now);
  const b = liveBridge();
  if (b?.liveLocationIds && list.some((s) => s.native)) {
    try {
      const alive = new Set(JSON.parse(b.liveLocationIds()) as string[]);
      list = list.filter((s) => !s.native || alive.has(s.messageId));
    } catch {
      /* мост без списка — верим записи */
    }
  }
  if (!getToken()) list = [];
  if (list.length !== useGeoLive.getState().list.length) setList(list);
}

/** Начать вести трансляцию только что отправленного сообщения. Нативная служба — если мост есть и взял; иначе страница. */
export function beginGeoLive(conversationId: string, messageId: string, live: Pick<ConvGeoLiveMedia, 'until' | 'lat' | 'lon' | 'accuracy' | 'heading'>): void {
  boot();
  const base = { conversationId, messageId, until: live.until, instanceId: activeInstanceId() ?? '' };
  const native = startNative(base);
  last.set(messageId, { lat: live.lat, lon: live.lon, at: Date.now() });
  setList([...useGeoLive.getState().list.filter((s) => s.messageId !== messageId), { ...base, native }]);
}

/** «Остановить»: служба/страница перестают слать, серверу — стоп (получатели увидят «завершена»). */
export async function stopGeoLive(conversationId: string, messageId: string): Promise<void> {
  boot();
  const mine = geoLiveShareOf(useGeoLive.getState().list, messageId);
  if (mine?.native) {
    try {
      liveBridge()?.stopLiveLocation?.(messageId);
    } catch {
      /* ignore */
    }
  }
  drop(messageId);
  const msg = await api.convGeoLiveStop(conversationId, messageId);
  const { useStore } = await import('./store');
  useStore.getState().convAfterEdit(conversationId, msg);
}

/** Выход из аккаунта: всё, что идёт, гасится на месте (токена уже нет — серверу не сказать, он закроет по сроку). */
export function stopAllGeoLiveLocal(): void {
  boot();
  try {
    liveBridge()?.stopAllLiveLocations?.();
  } catch {
    /* ignore */
  }
  stopWatch();
  last.clear();
  inFlight.clear();
  setList([]);
}

/** При старте приложения: вернуть записи с диска и продолжить (страница — подпиской, служба — заново, если окно на экране). */
export function resumeGeoLive(): void {
  boot();
  const now = Date.now();
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const list = useGeoLive.getState().list.filter((s) => s.until > now);
  const b = liveBridge();
  const alive = new Set<string>();
  if (b?.liveLocationIds) {
    try {
      for (const id of JSON.parse(b.liveLocationIds()) as string[]) alive.add(id);
    } catch {
      /* ignore */
    }
  }
  const next: GeoLiveShare[] = [];
  for (const s of list) {
    if (!s.native || alive.has(s.messageId)) next.push(s);
    // Служба умерла вместе с процессом: поднять заново можно только при видимом окне (Android 14+: старт службы с геопозицией).
    else if (!hidden && startNative(s)) next.push(s);
    else if (!hidden) next.push({ ...s, native: false });
  }
  setList(next);
}
