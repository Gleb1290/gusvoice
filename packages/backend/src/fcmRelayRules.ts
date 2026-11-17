/**
 * Шлюз FCM (#247, Google Play) — чистые правила БЕЗ env, базы и сети.
 *
 * Зачем шлюз. В Play-сборке Android пуши идут через Google FCM, а отправлять в FCM может только владелец проекта
 * Firebase. Поэтому любой инстанс шлёт на маршрут шлюза `POST /api/push/fcm/<токен FCM>` тот же зашифрованный web-push
 * (RFC 8291, aes128gcm), что шлёт на ntfy, а шлюз кладёт байты как есть в data-сообщение FCM (поле `gv`, base64).
 * Содержимое шлюз не видит: ключи шифра — только у телефона. Отправка и токен OAuth — `fcmRelay.ts`, маршрут —
 * `routes/fcmRelay.ts`, допуск эндпоинта у отправителя — `push.ts` `pushEndpointAllowed`.
 */
import { createSign } from 'node:crypto';
import { FCM_RELAY_PATH } from './pushRules.js';

/**
 * Допуск эндпоинта шлюза и формат токена живут в `pushRules.ts`: их зовёт `push.ts`, а его обвязки тестов дают ему
 * только `pushRules.js` (новый импорт там — «закрытый импорт»). Здесь — переэкспорт для маршрута шлюза.
 */
export { FCM_RELAY_BODY_MAX, FCM_RELAY_PATH, fcmRelayEndpointAllowed, validFcmToken } from './pushRules.js';
/** TTL по умолчанию (нет или кривой заголовок `TTL`) — сутки, как у ntfy-кеша приложения. */
export const FCM_TTL_DEFAULT = 86_400;
/** Потолок TTL у FCM — 28 суток. */
export const FCM_TTL_MAX = 2_419_200;
/** OAuth2 FCM HTTP v1: право и адресат JWT сервисного аккаунта. */
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Запас до истечения access_token: обновляем заранее, чтобы отправка не ушла с токеном на последней секунде. */
export const FCM_TOKEN_MARGIN_S = 300;

/** Адрес запроса для журнала: токен FCM — адрес устройства, в журнале ему не место. */
export function redactFcmRelayUrl(url: string): string {
  return url.startsWith(FCM_RELAY_PATH) ? `${FCM_RELAY_PATH}…` : url;
}

type HeaderValue = string | string[] | undefined;
const one = (v: HeaderValue): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();

/**
 * Приоритет Android-сообщения из заголовков web-push: `Urgency: high` (RFC 8030) или `Priority: 5` (ntfy; его синонимы
 * `max`/`urgent`) → `HIGH`, иначе `NORMAL`. `push.ts` ставит оба только входящему звонку.
 */
export function fcmAndroidPriority(urgency: HeaderValue, priority: HeaderValue): 'HIGH' | 'NORMAL' {
  if (one(urgency).toLowerCase() === 'high') return 'HIGH';
  const p = one(priority).toLowerCase();
  return p === '5' || p === 'max' || p === 'urgent' ? 'HIGH' : 'NORMAL';
}

/** TTL в секундах из заголовка `TTL` (RFC 8030): целое ≥ 0; нет/кривой — сутки; больше потолка FCM — потолок. */
export function fcmTtlSeconds(ttl: HeaderValue): number {
  const s = one(ttl);
  if (!/^\d{1,12}$/.test(s)) return FCM_TTL_DEFAULT;
  return Math.min(Number(s), FCM_TTL_MAX);
}

export interface FcmMessage {
  message: {
    token: string;
    data: { gv: string };
    android: { priority: 'HIGH' | 'NORMAL'; ttl: string };
  };
}

/** Тело запроса FCM HTTP v1 `messages:send`: байты web-push как есть, base64 в `data.gv`. */
export function buildFcmMessage(
  token: string,
  body: Buffer,
  headers: { ttl?: HeaderValue; urgency?: HeaderValue; priority?: HeaderValue },
): FcmMessage {
  return {
    message: {
      token,
      data: { gv: body.toString('base64') },
      android: { priority: fcmAndroidPriority(headers.urgency, headers.priority), ttl: `${fcmTtlSeconds(headers.ttl)}s` },
    },
  };
}

/** Что ответить отправителю пуша на ответ FCM. `retryAfter` — секунды для `Retry-After`, если FCM его дал. */
export interface RelayOutcome {
  code: 201 | 410 | 502 | 503;
  retryAfter?: number;
}

interface FcmErrorBody {
  error?: {
    status?: string;
    message?: string;
    details?: Array<{ '@type'?: string; errorCode?: string; fieldViolations?: Array<{ field?: string }> }>;
  };
}

/** `Retry-After` из ответа FCM: секунды (целое) или HTTP-дата. Нет/кривой — `undefined`. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | undefined {
  const v = (value ?? '').trim();
  if (!v) return undefined;
  if (/^\d{1,9}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.ceil((t - nowMs) / 1000));
}

/**
 * Ответ FCM → код шлюза. 2xx → 201 (как у web-push). Мёртвый токен → 410, чтобы отправитель удалил устройство:
 * `UNREGISTERED`, 404 и `INVALID_ARGUMENT` именно про токен (поле `message.token` или «registration token» в тексте).
 * 🔴 Прочий `INVALID_ARGUMENT`, 401/403 (ключ шлюза, чужой проект) — НЕ 410: иначе ошибка настройки шлюза стёрла бы
 * регистрации всех телефонов. Квота (429) и `UNAVAILABLE` (503) → 503, прочие сбои → 502; `Retry-After` — если дал FCM.
 */
export function fcmOutcome(status: number, body: unknown, retryAfter?: number): RelayOutcome {
  if (status >= 200 && status < 300) return { code: 201 };
  const err = (body && typeof body === 'object' ? (body as FcmErrorBody).error : undefined) ?? {};
  const details = Array.isArray(err.details) ? err.details : [];
  const codes = new Set(details.map((d) => d?.errorCode).filter(Boolean));
  if (codes.has('UNREGISTERED') || status === 404 || err.status === 'NOT_FOUND') return { code: 410 };
  if (status === 400 && (err.status === 'INVALID_ARGUMENT' || codes.has('INVALID_ARGUMENT'))) {
    const tokenField = details.some((d) => (d?.fieldViolations ?? []).some((f) => f?.field === 'message.token'));
    if (tokenField || /registration token/i.test(err.message ?? '')) return { code: 410 };
  }
  const ra = retryAfter !== undefined ? { retryAfter } : {};
  if (status === 429 || status === 503 || codes.has('QUOTA_EXCEEDED') || codes.has('UNAVAILABLE')) return { code: 503, ...ra };
  return { code: 502, ...ra };
}

/** Ключ сервисного аккаунта Firebase — нужные шлюзу поля. */
export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** Разбор env `FCM_SERVICE_ACCOUNT_B64` (base64 JSON ключа). Пусто или не хватает полей — `null` (шлюз выключен). */
export function parseServiceAccount(b64: string): FcmServiceAccount | null {
  const s = (b64 ?? '').trim();
  if (!s) return null;
  try {
    const j = JSON.parse(Buffer.from(s, 'base64').toString('utf8')) as Record<string, unknown>;
    const projectId = typeof j.project_id === 'string' ? j.project_id : '';
    const clientEmail = typeof j.client_email === 'string' ? j.client_email : '';
    const privateKey = typeof j.private_key === 'string' ? j.private_key : '';
    if (!/^[a-z0-9-]{1,64}$/i.test(projectId) || !clientEmail || !privateKey.includes('PRIVATE KEY')) return null;
    return { projectId, clientEmail, privateKey };
  } catch {
    return null;
  }
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/**
 * JWT RS256 сервисного аккаунта для обмена на access_token (Google OAuth2, грант `jwt-bearer`): `iss` — почта аккаунта,
 * `scope` — FCM, `aud` — адрес выдачи токена, срок — час (больше Google не даёт).
 */
export function serviceAccountJwt(sa: FcmServiceAccount, nowS: number): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.clientEmail, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat: nowS, exp: nowS + 3600 }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${claims}`);
  return `${head}.${claims}.${b64url(signer.sign(sa.privateKey))}`;
}

/** До какого момента (мс) держать access_token в кеше: срок из ответа минус запас; не меньше нуля. */
export function accessTokenValidUntil(nowMs: number, expiresInS: number): number {
  const life = Number.isFinite(expiresInS) && expiresInS > 0 ? expiresInS : 0;
  return nowMs + Math.max(0, life - FCM_TOKEN_MARGIN_S) * 1000;
}
