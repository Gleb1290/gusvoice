import { parseMapStaticQuery } from '@gusvoice/shared';
import type { FastifyInstance } from 'fastify';
import { Readable, Transform } from 'node:stream';
import { requireAuth } from '../auth.js';
import { rateHit, retryMessage } from '../authGuard.js';
import { env } from '../env.js';
import {
  MAPS_STATIC_CACHE_CONTROL,
  MAPS_STATIC_MAX_BYTES,
  MAPS_STATIC_TIMEOUT_MS,
  MAPS_STATIC_USER_MAX,
  MAPS_STATIC_USER_WINDOW_S,
  mapsStaticEnabled,
  mapsStaticReplyOk,
  mapsStaticUpstreamUrl,
} from '../mapsStaticRules.js';

/**
 * Картинка карты для карточки геопозиции ЛС (14.10, признак `yamap1`): `GET /api/maps/static?lat&lon&w&h&theme`.
 * Прокси Static API Яндекса — клиент к Яндексу не ходит, ключ ему не отдаётся. Правила — `mapsStaticRules.ts`.
 *
 * 🔴 Ничего не сохраняем (условие бесплатного API): ни диск, ни S3, ни база — картинка идёт потоком. Маршрут регистрируется только
 * при заданном `YANDEX_MAPS_STATIC_KEY` (`index.ts`); без ключа это честный 404, как у выключенных `diag`/`economy`.
 * Защита: только вошедшим; предел частоты на человека и суточный потолок на инстанс (ключ у Яндекса не безграничен).
 */
export async function mapsStaticRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/maps/static', async (req, reply) => {
    const key = env.yandexMapsStaticKey;
    if (!mapsStaticEnabled(key)) return reply.code(404).send({ error: 'disabled' });
    const q = parseMapStaticQuery(req.query);
    if (!q) return reply.code(400).send({ error: 'bad query' });
    const userWait = await rateHit(`maps:${req.user!.sub}`, MAPS_STATIC_USER_MAX, MAPS_STATIC_USER_WINDOW_S);
    if (userWait) return reply.header('Retry-After', String(userWait)).code(429).send({ error: retryMessage(userWait) });
    if (env.yandexMapsStaticDailyMax > 0) {
      const dayWait = await rateHit('maps:all', env.yandexMapsStaticDailyMax, 86_400);
      if (dayWait) return reply.header('Retry-After', String(dayWait)).code(429).send({ error: 'карты на сегодня закончились' });
    }

    let upstream: Response;
    try {
      // Адрес с ключом наружу не светим: ни в ответ, ни в лог (ошибки ниже — без URL).
      upstream = await fetch(mapsStaticUpstreamUrl(q, key), { redirect: 'error', signal: AbortSignal.timeout(MAPS_STATIC_TIMEOUT_MS) });
    } catch {
      return reply.code(502).send({ error: 'map unavailable' });
    }
    if (!upstream.body || !mapsStaticReplyOk(upstream.status, upstream.headers.get('content-type'), upstream.headers.get('content-length'))) {
      await upstream.body?.cancel().catch(() => {});
      return reply.code(502).send({ error: 'map unavailable' });
    }
    let total = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        total += chunk.length;
        if (total > MAPS_STATIC_MAX_BYTES) cb(new Error('map too large'));
        else cb(null, chunk);
      },
    });
    const body = Readable.fromWeb(upstream.body as never).pipe(cap);
    body.on('error', () => body.destroy());
    return reply
      .header('Content-Type', (upstream.headers.get('content-type') ?? 'image/png').split(';')[0].trim())
      .header('Cache-Control', MAPS_STATIC_CACHE_CONTROL)
      .header('X-Content-Type-Options', 'nosniff')
      .send(body);
  });
}
