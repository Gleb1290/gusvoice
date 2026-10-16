/**
 * Геопозиция в реальном времени в ЛС (14.10, признак сервера `geolive1`) — четвёртый вид сообщения `ConvMessage.media`
 * (`kind: 'geolive'`, рядом с `geo` / `contact` / `poll`). Точку обновляет только автор, пока трансляция идёт; истечение —
 * на чтении (`until` в прошлом = остановлена), без фоновых таймеров.
 *
 * Как у Telegram: `messageMediaGeoLive` (`period` — 15 минут / 1 час / 8 часов, список в Android `ChatAttachAlertLocationLayout`
 * `showLiveLocationAlert`/Web K `LocationLiveLocation…`), новую точку шлёт `LocationController.broadcastLastKnownLocation`
 * (`messages.editMessage` с `inputGeoPointLive` — у нас `POST …/live`), на переднем плане не чаще раза в 2 с
 * (`SEND_NEW_LOCATION_TIME`), «запасное» обновление — раз в 20 с (`FOREGROUND_UPDATE_TIME`), в фоне — раз в 30 с
 * (`BACKGROUD_UPDATE_TIME`); карточка `SharingLiveLocationCell` («Live Location» + «updated N min ago» + кольцо оставшегося
 * времени). Код Telegram не копируется — только поведение и числа.
 *
 * У сообщения такого вида `content` — запасная фраза с ПЕРВОЙ точкой (старый клиент и старый сосед видят её, не обновляя).
 * Сообщение без подписи, правке не подлежит (как другие `media`), пересылается обычной (статичной) геопозицией.
 */

/** Допустимые сроки трансляции, секунды: 15 минут, 1 час, 8 часов (выбор в Telegram — те же три). */
export const GEO_LIVE_PERIODS = [900, 3600, 28800] as const;
export type GeoLivePeriod = (typeof GEO_LIVE_PERIODS)[number];

/** Пределы: чаще раза в `minGapMs` сервер новую точку молча не принимает; клиент шлёт не чаще `sendGapMs`. */
export const GEO_LIVE_LIMITS = {
  /** Сервер: точка раньше этого промежутка после прошлой — успех без записи (повтор/дребезг). */
  minGapMs: 3000,
  /** Клиент: не чаще (Telegram `SEND_NEW_LOCATION_TIME` = 2 с; у нас каждая точка — строка журнала всем участникам, поэтому 5 с). */
  sendGapMs: 5000,
  /** Клиент: «заметный сдвиг» — не меньше этого, метры (иначе точка шлётся только по таймеру). */
  moveMeters: 10,
  /** Клиент: если не сдвинулись — всё равно раз в столько (Telegram `FOREGROUND_UPDATE_TIME` = 20 с). */
  keepAliveMs: 20_000,
  /** Android в фоне: раз в столько (Telegram `BACKGROUD_UPDATE_TIME` = 30 с). */
  backgroundMs: 30_000,
  /** Курс — градусы 0..360. */
  headingMax: 360,
} as const;

/** Трансляция: хранится и отдаётся клиенту в этой форме (`stopped` на чтении добавляет истечение — `geoLiveView`). */
export interface ConvGeoLiveMedia {
  kind: 'geolive';
  lat: number;
  lon: number;
  /** Радиус точности, метры; `null` — неизвестна. */
  accuracy: number | null;
  /** Курс движения, градусы от севера по часовой; `null` — неизвестен. */
  heading: number | null;
  /** Срок трансляции, секунды (900 / 3600 / 28800). */
  period: GeoLivePeriod;
  /** Начало и конец, миллисекунды Unix. */
  startedAt: number;
  until: number;
  /** Когда принята последняя точка (при отправке — равно `startedAt`). */
  updatedAt: number;
  /** Остановлена автором или (в отдаваемом виде) истекла. */
  stopped: boolean;
}

/** Тело `media` в отправке (`POST /api/conv/:id/messages`, `geolive1`). */
export interface ConvGeoLiveInput {
  kind: 'geolive';
  lat: number;
  lon: number;
  accuracy?: number | null;
  heading?: number | null;
  period: number;
}

/** Тело `POST /api/conv/:id/messages/:mid/live` (`geolive1`). */
export interface GeoLivePoint {
  lat: number;
  lon: number;
  accuracy?: number | null;
  heading?: number | null;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function validPoint(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
  );
}

function normAcc(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.round(Math.min(v, 100_000) * 10) / 10;
}

/** Курс: число в [0, 360); иначе (NaN, `null`, вне диапазона) — `null`. 360 приравнивается к 0. */
export function normHeading(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > GEO_LIVE_LIMITS.headingMax) return null;
  return Math.round(v) % GEO_LIVE_LIMITS.headingMax;
}

/** Срок из присланного: ровно одно из трёх; иначе `null`. */
export function geoLivePeriod(v: unknown): GeoLivePeriod | null {
  return (GEO_LIVE_PERIODS as readonly unknown[]).includes(v) ? (v as GeoLivePeriod) : null;
}

/** Начало трансляции: `null` — координаты вне диапазона или срок не из списка. */
export function geoLiveStart(input: { lat: unknown; lon: unknown; accuracy?: unknown; heading?: unknown; period: unknown }, now: number): ConvGeoLiveMedia | null {
  const period = geoLivePeriod(input.period);
  if (!period || !validPoint(input.lat, input.lon)) return null;
  return {
    kind: 'geolive',
    lat: round6(input.lat as number),
    lon: round6(input.lon as number),
    accuracy: normAcc(input.accuracy),
    heading: normHeading(input.heading),
    period,
    startedAt: now,
    until: now + period * 1000,
    updatedAt: now,
    stopped: false,
  };
}

/** Разбор из базы/DTO: битое — `null` (клиент покажет запасной `content`, правило 11). */
export function parseGeoLive(r: Record<string, unknown>): ConvGeoLiveMedia | null {
  const period = geoLivePeriod(r.period);
  const ms = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
  const startedAt = ms(r.startedAt);
  const until = ms(r.until);
  const updatedAt = ms(r.updatedAt);
  if (!period || !validPoint(r.lat, r.lon) || startedAt === null || until === null || updatedAt === null) return null;
  return {
    kind: 'geolive',
    lat: round6(r.lat as number),
    lon: round6(r.lon as number),
    accuracy: normAcc(r.accuracy),
    heading: normHeading(r.heading),
    period,
    startedAt,
    until,
    updatedAt,
    stopped: r.stopped === true,
  };
}

/** Трансляция кончилась: остановлена автором или срок вышел. */
export function geoLiveEnded(m: Pick<ConvGeoLiveMedia, 'until' | 'stopped'>, now: number): boolean {
  return m.stopped || m.until <= now;
}

/** Сколько осталось, миллисекунды (0 — кончилась). */
export function geoLiveLeftMs(m: Pick<ConvGeoLiveMedia, 'until' | 'stopped'>, now: number): number {
  return geoLiveEnded(m, now) ? 0 : m.until - now;
}

/** Доля оставшегося времени 0..1 — для кольца карточки. */
export function geoLiveLeftShare(m: Pick<ConvGeoLiveMedia, 'until' | 'stopped' | 'period'>, now: number): number {
  return Math.min(1, geoLiveLeftMs(m, now) / (m.period * 1000));
}

/** Вид для отдачи: истёкшая помечается остановленной (истечение — на чтении, без таймеров). */
export function geoLiveView(m: ConvGeoLiveMedia, now: number): ConvGeoLiveMedia {
  return !m.stopped && m.until <= now ? { ...m, stopped: true } : m;
}

export type GeoLiveUpdate =
  /** `media: null` — точка пришла раньше `minGapMs` после прошлой: успех без записи и без события. */
  | { ok: true; media: ConvGeoLiveMedia | null }
  | { ok: false; code: 400 | 403; error: string };

/** Новая точка автора: только пока трансляция идёт; не чаще `minGapMs`; координаты — по диапазону. */
export function geoLiveUpdate(m: ConvGeoLiveMedia, point: { lat: unknown; lon: unknown; accuracy?: unknown; heading?: unknown }, now: number): GeoLiveUpdate {
  if (geoLiveEnded(m, now)) return { ok: false, code: 403, error: 'трансляция геопозиции завершена' };
  if (!validPoint(point.lat, point.lon)) return { ok: false, code: 400, error: 'координаты вне диапазона' };
  if (now - m.updatedAt < GEO_LIVE_LIMITS.minGapMs) return { ok: true, media: null };
  return {
    ok: true,
    media: {
      ...m,
      lat: round6(point.lat as number),
      lon: round6(point.lon as number),
      accuracy: normAcc(point.accuracy),
      heading: normHeading(point.heading),
      updatedAt: now,
    },
  };
}

/** Остановить: только автор (проверяет сервер); повтор — без изменений. */
export function geoLiveStop(m: ConvGeoLiveMedia): ConvGeoLiveMedia {
  return m.stopped ? m : { ...m, stopped: true };
}

/** Расстояние между точками, метры (гаверсинус) — «заметный сдвиг» у клиента. */
export function geoDistanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Слать ли новую точку (клиент, пока трансляция идёт): не чаще `sendGapMs`; первая — всегда; потом при сдвиге на `moveMeters`
 * и больше, а без сдвига — раз в `keepAliveMs`. `gap` — фоновый режим Android подставляет свой период.
 */
export function geoLiveShouldSend(
  last: { lat: number; lon: number; at: number } | null,
  next: { lat: number; lon: number },
  now: number,
  keepAliveMs: number = GEO_LIVE_LIMITS.keepAliveMs,
): boolean {
  if (!last) return true;
  const gap = now - last.at;
  if (gap < GEO_LIVE_LIMITS.sendGapMs) return false;
  if (gap >= keepAliveMs) return true;
  return geoDistanceM(last.lat, last.lon, next.lat, next.lon) >= GEO_LIVE_LIMITS.moveMeters;
}

/** Подпись срока в выборе: «15 минут» / «1 час» / «8 часов». */
export function geoLivePeriodLabel(p: GeoLivePeriod): string {
  return p === 900 ? '15 минут' : p === 3600 ? '1 час' : '8 часов';
}

/** Оставшееся время словами: «осталось 14 мин», «осталось 1 ч 5 мин», «меньше минуты»; кончилась — «трансляция завершена». */
export function geoLiveLeftText(m: Pick<ConvGeoLiveMedia, 'until' | 'stopped'>, now: number): string {
  const left = geoLiveLeftMs(m, now);
  if (left <= 0) return 'трансляция завершена';
  const mins = Math.ceil(left / 60_000);
  if (left < 60_000) return 'осталось меньше минуты';
  if (mins < 60) return `осталось ${mins} мин`;
  const h = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest === 0 ? `осталось ${h} ч` : `осталось ${h} ч ${rest} мин`;
}

/** «Обновлено только что / N мин назад / N ч назад» (Telegram: «updated just now / N minutes ago»). */
export function geoLiveAgoText(updatedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (sec < 60) return 'обновлено только что';
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `обновлено ${mins} мин назад`;
  return `обновлено ${Math.floor(mins / 60)} ч назад`;
}

/** Подпись вида в списке бесед, поиске, цитате, закрепе и пуше. */
export function convGeoLivePreview(): string {
  return 'Геопозиция в реальном времени';
}

/** Запасной текст (`content`): первая точка со ссылкой на карту — для клиента и соседа, которые вид не знают. */
export function convGeoLiveFallback(m: Pick<ConvGeoLiveMedia, 'lat' | 'lon'>): string {
  const la = round6(m.lat);
  const lo = round6(m.lon);
  return `📍 Геопозиция в реальном времени: ${la.toFixed(6)}, ${lo.toFixed(6)} https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=16/${la}/${lo}`;
}
