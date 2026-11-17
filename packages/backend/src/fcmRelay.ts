/**
 * Шлюз FCM (#247): отправка в FCM HTTP v1 и access_token сервисного аккаунта. Правила — `fcmRelayRules.ts`, маршрут —
 * `routes/fcmRelay.ts`. Модуль не читает env: ключ, `fetch` и часы передаются, поэтому его можно гонять заглушками.
 *
 * OAuth2 без новых зависимостей: JWT RS256 (`serviceAccountJwt`) меняется на access_token у Google, токен живёт в
 * памяти до истечения минус запас; одновременные запросы ждут ОДИН обмен. 401 от FCM — токен сбрасывается.
 */
import {
  GOOGLE_TOKEN_URL,
  accessTokenValidUntil,
  buildFcmMessage,
  fcmOutcome,
  parseRetryAfter,
  serviceAccountJwt,
  type FcmServiceAccount,
  type RelayOutcome,
} from './fcmRelayRules.js';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface FcmRelayDeps {
  fetch?: FetchLike;
  now?: () => number;
  /** Предел ожидания одного запроса к Google, мс. */
  timeoutMs?: number;
}

export interface FcmRelayHeaders {
  ttl?: string | string[];
  urgency?: string | string[];
  priority?: string | string[];
}

export class FcmRelay {
  private cached: { token: string; until: number } | null = null;
  private pending: Promise<string> | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly sa: FcmServiceAccount,
    deps: FcmRelayDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
  }

  /** access_token из кеша или новый обмен JWT (один на всех одновременных). */
  async accessToken(): Promise<string> {
    const c = this.cached;
    if (c && this.now() < c.until) return c.token;
    if (!this.pending) {
      this.pending = this.exchange().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  private async exchange(): Promise<string> {
    const assertion = serviceAccountJwt(this.sa, Math.floor(this.now() / 1000));
    const res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
    if (!res.ok || typeof j.access_token !== 'string' || !j.access_token) throw new Error(`fcm oauth ${res.status}`);
    this.cached = { token: j.access_token, until: accessTokenValidUntil(this.now(), Number(j.expires_in)) };
    return j.access_token;
  }

  /** Переслать тело web-push в FCM на `token`. Сбой сети или OAuth — 502 (отправитель устройство не удаляет). */
  async send(token: string, body: Buffer, headers: FcmRelayHeaders): Promise<RelayOutcome> {
    let access: string;
    try {
      access = await this.accessToken();
    } catch {
      return { code: 502 };
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.sa.projectId)}/messages:send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
        body: JSON.stringify(buildFcmMessage(token, body, headers)),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { code: 502 };
    }
    if (res.status === 401) this.cached = null;
    // Тело читается всегда (и при успехе): недочитанный ответ держит соединение пула.
    const json: unknown = await res.json().catch(() => null);
    return fcmOutcome(res.status, json, parseRetryAfter(res.headers.get('retry-after'), this.now()));
  }
}
