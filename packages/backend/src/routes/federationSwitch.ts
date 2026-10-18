/**
 * Тумблеры федерации во вкладке «Федерация» админки (#224) — `GET`/`PATCH /admin/federation/switch`.
 *
 * Отдельный модуль, а не часть `federation.ts`: эти два маршрута обязаны отвечать и при ВЫКЛЮЧЕННОЙ федерации (иначе её
 * нечем включить), а всё остальное в `federation.ts` за крючком `federationGate` (выключено — 404). Только супер-админ.
 * 🔴 Пароль к ключу не уходит ни в одном ответе (`federationSwitchView`).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireSuperAdmin } from '../auth.js';
import { fedAudit } from '../federation/auditLog.js';
import { federationSwitchView, setFederationSwitch } from '../federation/switch.js';

const PatchBody = z
  .object({ enabled: z.boolean().optional(), dmEnabled: z.boolean().optional() })
  .refine((b) => b.enabled !== undefined || b.dmEnabled !== undefined);

export async function federationSwitchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireSuperAdmin);

  app.get('/admin/federation/switch', async () => federationSwitchView());

  app.patch('/admin/federation/switch', async (req, reply) => {
    const body = PatchBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad-switch' });
    const refused = await setFederationSwitch(body.data);
    if (refused) return reply.code(409).send({ error: refused });
    fedAudit('federation.switch', { actorId: req.user?.sub ?? null, ...body.data });
    return federationSwitchView();
  });
}
