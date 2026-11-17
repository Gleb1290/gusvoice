import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientIp, rateHit, retryMessage } from '../authGuard.js';
import { env } from '../env.js';
import { FcmRelay } from '../fcmRelay.js';
import { FCM_RELAY_BODY_MAX, parseServiceAccount, validFcmToken, type FcmServiceAccount } from '../fcmRelayRules.js';

/** Лимиты шлюза: с одного адреса (инстанс-отправитель шлёт пачками на всех своих) и на один токен (одно устройство). */
const IP_MAX = 600;
const TOKEN_MAX = 60;
const WINDOW_S = 60;

/**
 * Ключ шлюза из env `FCM_SERVICE_ACCOUNT_B64`; нет — `null` (шлюз выключен). Задан, но не разобрался — тоже `null` и
 * строка в журнал БЕЗ значения ключа.
 */
export function fcmRelayServiceAccount(logError: (msg: string) => void): FcmServiceAccount | null {
  const raw = env.fcm.serviceAccountB64.trim();
  if (!raw) return null;
  const sa = parseServiceAccount(raw);
  if (!sa) logError('[fcm] FCM_SERVICE_ACCOUNT_B64 не разобран (нужны project_id, client_email, private_key) — шлюз FCM выключен');
  return sa;
}

const tokenOf = (req: FastifyRequest): string => (req.params as { '*'?: string })['*'] ?? '';

/**
 * Шлюз FCM (#247): `POST /api/push/fcm/<токен FCM>` — БЕЗ входа, как ntfy. Тело — сырые байты web-push (обычно
 * `application/octet-stream` + `Content-Encoding: aes128gcm`; любой тип принимается буфером), не больше
 * `FCM_RELAY_BODY_MAX` → иначе 413. Ответ: 201 доставлено в FCM, 410 токен мёртв (отправитель удаляет устройство),
 * 502/503 сбой FCM (`Retry-After`, если дал FCM), 429 лимит. Регистрируется ТОЛЬКО при ключе `FCM_SERVICE_ACCOUNT_B64`
 * (`index.ts`): выключенный шлюз — отсутствие маршрута. Маршрут — подстановка `*`, а не `:token`: у параметра предел
 * длины 100 знаков, токен FCM длиннее; формат токена проверяется сам (`validFcmToken`, один сегмент).
 */
export async function fcmRelayRoutes(app: FastifyInstance, opts: { serviceAccount: FcmServiceAccount }): Promise<void> {
  const relay = new FcmRelay(opts.serviceAccount);
  await app.register(async (scope) => {
    // Свой разбор тела в своей области: любые типы — буфером с пределом шлюза (общий JSON-разборщик здесь не нужен).
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: FCM_RELAY_BODY_MAX }, (_req, body, done) => done(null, body));

    const limited = (reply: FastifyReply, wait: number) =>
      reply.code(429).header('Retry-After', String(wait)).send({ error: retryMessage(wait) });

    // Лимиты и формат токена — ДО чтения тела.
    scope.addHook('onRequest', async (req, reply) => {
      const ipWait = await rateHit(`pushfcm:ip:${clientIp(req)}`, IP_MAX, WINDOW_S);
      if (ipWait) return limited(reply, ipWait);
      const token = tokenOf(req);
      if (!validFcmToken(token)) return reply.code(404).send({ error: 'not found' });
      const tokenWait = await rateHit(`pushfcm:tok:${createHash('sha256').update(token).digest('base64url').slice(0, 22)}`, TOKEN_MAX, WINDOW_S);
      if (tokenWait) return limited(reply, tokenWait);
    });

    scope.post('/push/fcm/*', async (req, reply) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.length > FCM_RELAY_BODY_MAX) return reply.code(413).send({ error: 'payload too large' });
      const out = await relay.send(tokenOf(req), body, {
        ttl: req.headers['ttl'],
        urgency: req.headers['urgency'],
        priority: req.headers['priority'],
      });
      if (out.retryAfter !== undefined) reply.header('Retry-After', String(out.retryAfter));
      return reply.code(out.code).send(out.code === 201 ? undefined : { error: out.code === 410 ? 'gone' : 'fcm unavailable' });
    });
  });
}
