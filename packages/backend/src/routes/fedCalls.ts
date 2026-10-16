import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FED_CALL_INVITE_PATH, realClientIp } from '@gusvoice/shared';
import { acceptCallInvite } from '../federation/dmCalls.js';
import { fedRateBlock } from '../federation/guardsRuntime.js';
import { authenticateLinkedPeer } from '../federation/peerAuth.js';
import { createAdmitPeer } from './fedAdmission.js';

/**
 * ЛС между инстансами, Э6 (#141, признак `dmcall1`): приглашение на звонок 1:1 — `POST /fed/v1/call/invite` (ответ `{ ok }` или
 * `{ refused }`, `federation/dmCalls.acceptCallInvite`). Отдельным модулем, как `fedEphemeral.ts`: `routes/federation.ts` проверки
 * собирают с явным перечнем зависимостей. Регистрирует `index.ts` только при `FEDERATION_ENABLED` и `FEDERATION_DM_ENABLED`.
 * Допуск соседа — `createAdmitPeer` (предел по адресу до подписи, подпись связки, рабочая связка, предел `call`).
 * ⚠️ Повтор подписи не отсекаем: повтор приглашения с тем же `call_id` — `ok` без второго звонка (`calls.ringRemote`), а
 * просроченное (`expires_at`) не звонит.
 */
const admitPeer = createAdmitPeer({
  rateBlock: (kind, who) => fedRateBlock(kind, who),
  authenticate: (req, instanceId, opts) => authenticateLinkedPeer(req, instanceId, opts),
  clientIp: (req: FastifyRequest) => realClientIp(req.headers['x-forwarded-for'], req.ip),
});

export async function fedCallRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    // Подпись POST проверяется по СЫРОМУ телу — свой разбор JSON в своём скоупе (как `fedEphemeral.ts`).
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 16 * 1024 }, (req, raw, done) => {
      (req as { rawBody?: string }).rawBody = typeof raw === 'string' ? raw : raw.toString('utf8');
      try {
        done(null, JSON.parse((req as { rawBody?: string }).rawBody || '{}'));
      } catch {
        done(null, {});
      }
    });

    scope.post(FED_CALL_INVITE_PATH, async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const link = await admitPeer(req, reply, body.instance_id, 'call', { requireActive: true });
      if (!link) return;
      const res = await acceptCallInvite(link, body);
      return reply.code(res.status).send(res.body);
    });
  });
}
