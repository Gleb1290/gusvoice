import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FED_EPHEMERAL_PATH, realClientIp } from '@gusvoice/shared';
import { acceptEphemeral } from '../federation/dmEphemeral.js';
import { fedRateBlock } from '../federation/guardsRuntime.js';
import { authenticateLinkedPeer } from '../federation/peerAuth.js';
import { createAdmitPeer } from './fedAdmission.js';

/**
 * ЛС между инстансами, Э4 (#141, признак `dm3`): мгновенное — `POST /fed/v1/ephemeral` («печатает», «в сети / был(а)»).
 * Отдельным модулем, а не в `routes/federation.ts`: тот проверки собирают с явным перечнем зависимостей. Регистрирует `index.ts`
 * только при `FEDERATION_ENABLED` и `FEDERATION_DM_ENABLED` (иначе 404 — у соседа без признака мы и не спрашиваем).
 * Допуск соседа — тот же `createAdmitPeer` (предел по адресу до подписи, подпись связки, рабочая связка, предел `ephemeral`).
 * ⚠️ Повтор подписи не отсекаем: запись идемпотентна («печатает» живёт 6 с, у «в сети» — версия `at`), а запись одноразовых
 * меток на каждое «печатает» стоила бы больше самой записи.
 */
const admitPeer = createAdmitPeer({
  rateBlock: (kind, who) => fedRateBlock(kind, who),
  authenticate: (req, instanceId, opts) => authenticateLinkedPeer(req, instanceId, opts),
  clientIp: (req: FastifyRequest) => realClientIp(req.headers['x-forwarded-for'], req.ip),
});

export async function fedEphemeralRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    // Подпись POST проверяется по СЫРОМУ телу — свой разбор JSON в своём скоупе (как `proto` в `routes/federation.ts`; снять
    // унаследованный сначала, иначе Fastify бросает `FST_ERR_CTP_ALREADY_PRESENT`).
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 64 * 1024 }, (req, raw, done) => {
      (req as { rawBody?: string }).rawBody = typeof raw === 'string' ? raw : raw.toString('utf8');
      try {
        done(null, JSON.parse((req as { rawBody?: string }).rawBody || '{}'));
      } catch {
        done(null, {});
      }
    });

    scope.post(FED_EPHEMERAL_PATH, async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const link = await admitPeer(req, reply, body.instance_id, 'ephemeral', { requireActive: true });
      if (!link) return;
      const res = await acceptEphemeral(link, body);
      return reply.code(res.status).send(res.body);
    });
  });
}
