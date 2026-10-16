/**
 * Геопозиция и контакт в ЛС (14.10, G69, признак сервера `geocontact1`, признак связки `dmmedia1`) — «вид сообщения»:
 * поле `ConvMessage.media` с общим дискриминатором `kind`. Следующий вид (опрос) ложится рядом тем же способом: новый
 * `kind` в `ConvMediaMark`, своя ветка в `parseConvMedia` / `convMediaPreview` / `convMediaFallback`, своя ветка провода.
 *
 * Как у Telegram: `messageMediaGeo` / `messageMediaContact` (Web K `appMessagesManager`, подписи «Location» / «Contact»),
 * лист вложений Android `ChatAttachAlertLocationLayout` («Send my current location», «Accurate to N m») и
 * `ChatAttachAlertContactsLayout`. Код Telegram не копируется — только поведение.
 *
 * У сообщения такого вида `content` — запасная фраза (её покажет старый клиент и старый сосед, по ней ищет поиск); новый
 * клиент вместо неё рисует карточку. Сообщение без подписи, правке не подлежит (как стикер).
 */

import { convGeoLiveFallback, convGeoLivePreview, parseGeoLive, type ConvGeoLiveInput, type ConvGeoLiveMedia } from './convGeoLive';
import { convPollFallback, convPollPreview, parseConvPoll, type ConvPollInput, type ConvPollMedia } from './convPoll';

/** Геопозиция: широта/долгота в градусах (WGS84), точность — радиус в метрах (`null` — неизвестна). */
export interface ConvGeoMedia {
  kind: 'geo';
  lat: number;
  lon: number;
  accuracy: number | null;
}

/** Дом человека с другого инстанса в карточке контакта: id инстанса, id человека там и как мы инстанс знаем (домен, название). */
export interface ConvContactHome {
  instanceId: string;
  userId: string;
  domain: string | null;
  name: string | null;
}

/**
 * Карточка контакта — СНИМОК на момент отправки (имя и ник могли смениться — как у Telegram, карточка показывает то, что
 * прислали). `userId` — id человека на ЭТОМ инстансе (своя строка или теневая строка соседа); `null` — у нас его нет:
 * карточка без перехода в профиль.
 */
export interface ConvContactMedia {
  kind: 'contact';
  userId: string | null;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** Человек с другого инстанса. Нет поля — свой. */
  home?: ConvContactHome;
}

/** Опрос (14.10, `convpoll1`) — правила в `convPoll.ts`. */
/** Геопозиция в реальном времени (14.10, `geolive1`) — правила в `convGeoLive.ts`. */
export type ConvMediaMark = ConvGeoMedia | ConvContactMedia | ConvPollMedia | ConvGeoLiveMedia;

/**
 * Тело `media` в отправке (`POST /api/conv/:id/messages`, `geocontact1`): геопозицию клиент присылает числами, контакт — только id
 * человека (снимок имени, ника и дома сервер берёт из базы). Опрос ляжет сюда новой веткой `kind`.
 */
export type ConvMediaInput = { kind: 'geo'; lat: number; lon: number; accuracy?: number | null } | { kind: 'contact'; userId: string } | ConvPollInput | ConvGeoLiveInput;

/** Пределы: имя и ник — как у провода федерации; точность больше 100 км смысла не несёт. */
export const CONV_MEDIA_LIMITS = { name: 255, username: 64, accuracyMax: 100_000, url: 2048 } as const;

/** Широта и долгота в допустимых диапазонах (и числа вообще). */
export function validGeo(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
  );
}

/** Шесть знаков после запятой — около 10 см, точнее GPS телефона не бывает. */
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Точность: неотрицательное конечное число не больше предела, до 0.1 м; иначе `null`. */
export function normAccuracy(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.round(Math.min(v, CONV_MEDIA_LIMITS.accuracyMax) * 10) / 10;
}

/** Геопозиция из присланного (клиент, провод): `null` — координаты вне диапазона. */
export function geoMedia(lat: unknown, lon: unknown, accuracy: unknown): ConvGeoMedia | null {
  if (!validGeo(lat, lon)) return null;
  return { kind: 'geo', lat: round6(lat as number), lon: round6(lon as number), accuracy: normAccuracy(accuracy) };
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length <= max ? v : null;
}

/**
 * Разобрать `media` (строка базы, DTO): незнакомый `kind` и битые поля — `null` (клиент покажет запасной текст `content`,
 * правило 11). Строгий разбор нужен и клиенту: сервер новее клиента может прислать вид, которого клиент не знает.
 */
export function parseConvMedia(raw: unknown): ConvMediaMark | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'geo') return geoMedia(r.lat, r.lon, r.accuracy);
  if (r.kind === 'poll') return parseConvPoll(r);
  if (r.kind === 'geolive') return parseGeoLive(r);
  if (r.kind === 'contact') {
    const username = str(r.username, CONV_MEDIA_LIMITS.username);
    const displayName = str(r.displayName, CONV_MEDIA_LIMITS.name);
    if (username === null || displayName === null || (!username && !displayName)) return null;
    const userId = typeof r.userId === 'string' && r.userId.length > 0 && r.userId.length <= 64 ? r.userId : null;
    const avatarUrl = typeof r.avatarUrl === 'string' && r.avatarUrl.length <= CONV_MEDIA_LIMITS.url && /^(https?:\/\/|\/)/.test(r.avatarUrl) ? r.avatarUrl : null;
    const h = r.home && typeof r.home === 'object' ? (r.home as Record<string, unknown>) : null;
    const home: ConvContactHome | null =
      h && typeof h.instanceId === 'string' && h.instanceId.length > 0 && h.instanceId.length <= 64 && typeof h.userId === 'string' && h.userId.length > 0 && h.userId.length <= 64
        ? { instanceId: h.instanceId, userId: h.userId, domain: str(h.domain, 253), name: str(h.name, CONV_MEDIA_LIMITS.name) }
        : null;
    return { kind: 'contact', userId, username, displayName, avatarUrl, ...(home ? { home } : {}) };
  }
  return null;
}

/** `@ник` контакта; с другого инстанса — `@ник@домен` (домена не знаем — просто `@ник`). */
export function contactHandle(c: Pick<ConvContactMedia, 'username' | 'home'>): string {
  if (!c.username) return '';
  return c.home?.domain ? `@${c.username}@${c.home.domain}` : `@${c.username}`;
}

/** Имя в карточке и подписях: имя, а без него — ник. */
export function contactName(c: Pick<ConvContactMedia, 'displayName' | 'username'>): string {
  return c.displayName.trim() || c.username;
}

/** Ссылка на место в OpenStreetMap (ПК и веб открывают её в браузере; она же — в запасном тексте). */
export function osmUrl(lat: number, lon: number): string {
  const la = round6(lat);
  const lo = round6(lon);
  return `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=16/${la}/${lo}`;
}

/** `geo:`-ссылка (RFC 5870) с меткой — Android отдаёт её приложению карт. */
export function geoUri(lat: number, lon: number): string {
  const la = round6(lat);
  const lo = round6(lon);
  return `geo:${la},${lo}?q=${la},${lo}`;
}

/** Координаты для показа: «55.755800, 37.617300». */
export function geoText(lat: number, lon: number): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

/** Точность словами, как Telegram «Accurate to N m»: «точность 12 м» / «точность 1,5 км»; неизвестна — пусто. */
export function accuracyText(accuracy: number | null): string {
  if (accuracy === null) return '';
  if (accuracy < 1000) return `точность ${Math.max(1, Math.round(accuracy))} м`;
  return `точность ${(Math.round(accuracy / 100) / 10).toString().replace('.', ',')} км`;
}

/** Подпись вида в списке бесед, поиске, цитате, закрепе и пуше: «Геопозиция» / «Контакт: Имя». */
export function convMediaPreview(m: ConvMediaMark): string {
  if (m.kind === 'geo') return 'Геопозиция';
  if (m.kind === 'poll') return convPollPreview(m);
  if (m.kind === 'geolive') return convGeoLivePreview();
  return `Контакт: ${contactName(m)}`;
}

/**
 * Запасной текст (`content`) — для клиента и соседа, которые вид не знают: координаты со ссылкой на карту или имя с ником.
 * Он же входит в отпечаток повтора отправки (`payloadHash`) и попадает в поиск.
 */
export function convMediaFallback(m: ConvMediaMark): string {
  if (m.kind === 'geo') return `📍 Геопозиция: ${geoText(m.lat, m.lon)} ${osmUrl(m.lat, m.lon)}`;
  if (m.kind === 'poll') return convPollFallback(m);
  if (m.kind === 'geolive') return convGeoLiveFallback(m);
  const handle = contactHandle(m);
  // Имени нет — вместо него ник: «Контакт: @ник», а не «Контакт: ник @ник».
  const name = m.displayName.trim();
  return `👤 Контакт: ${[name, handle].filter(Boolean).join(' ')}`;
}
