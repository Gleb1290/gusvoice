/**
 * ЛС между инстансами, этап Э7 часть 1 (#141, `docs/dm/FEDERATION.md` §3.6): `POST /fed/v1/conv/group/op` — участник группы со
 * смешанным составом с другого инстанса просит её дом (хост) выйти, удалить, позвать или переименовать. Отдельным модулем, как
 * `fedCalls.ts`: подпись POST проверяется по сырому телу, свой разбор JSON в своём скоупе; предел — `group` на связку.
 * Регистрируется только при `FEDERATION_DM_ENABLED` (`index.ts`).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FED_GROUP_OP_PATH, realClientIp } from '@gusvoice/shared';
import { acceptGroupOp } from '../federation/convGroup.js';
import { fedRateBlock } from '../federation/guardsRuntime.js';
import { authenticateLinkedPeer } from '../federation/peerAuth.js';
import { createAdmitPeer } from './fedAdmission.js';

const admitPeer = createAdmitPeer({
  rateBlock: (kind, who) => fedRateBlock(kind, who),
  authenticate: (req, instanceId, opts) => authenticateLinkedPeer(req, instanceId, opts),
  clientIp: (req: FastifyRequest) => realClientIp(req.headers['x-forwarded-for'], req.ip),
});

export async function fedGroupRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 16 * 1024 }, (req, raw, done) => {
      (req as { rawBody?: string }).rawBody = typeof raw === 'string' ? raw : raw.toString('utf8');
      try {
        done(null, JSON.parse((req as { rawBody?: string }).rawBody || '{}'));
      } catch {
        done(null, {});
      }
    });

    scope.post(FED_GROUP_OP_PATH, async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const link = await admitPeer(req, reply, body.instance_id, 'group', { requireActive: true });
      if (!link) return;
      const res = await acceptGroupOp(link, body);
      return reply.code(res.status).send(res.body);
    });
  });
}
