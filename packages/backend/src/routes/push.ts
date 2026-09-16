import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { rateHit, retryMessage } from '../authGuard.js';
import {
  listPushMutes,
  pushEndpointAllowed,
  registerPushDevice,
  removePushMute,
  setPushMute,
  unregisterPushDevice,
} from '../push.js';

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Register (or refresh) this device's UnifiedPush endpoint. The backend POSTs wake payloads here
  // when the user is offline. The endpoint MUST be on our own ntfy host (SSRF guard).
  app.post('/push/register', async (req, reply) => {
    const wait = await rateHit(`push:reg:${req.user!.sub}`, 30, 300);
    if (wait) return reply.code(429).send({ error: retryMessage(wait) });
    const b = z
      .object({
        endpoint: z.string().url().max(500),
        deviceId: z.string().min(1).max(200),
        platform: z.enum(['android', 'ios', 'web', 'desktop']).nullish(),
      })
      .parse(req.body);
    if (!pushEndpointAllowed(b.endpoint)) return reply.code(400).send({ error: 'endpoint host not allowed' });
    await registerPushDevice(req.user!.sub, b.deviceId, b.endpoint, b.platform ?? null);
    return reply.code(204).send();
  });

  // Drop this device's registration (logout / disable push).
  app.post('/push/unregister', async (req, reply) => {
    const wait = await rateHit(`push:unreg:${req.user!.sub}`, 30, 300);
    if (wait) return reply.code(429).send({ error: retryMessage(wait) });
    const { deviceId } = z.object({ deviceId: z.string().min(1).max(200) }).parse(req.body);
    await unregisterPushDevice(req.user!.sub, deviceId);
    return reply.code(204).send();
  });

  // List my push-mute rules (server + dm_user). Loaded on bootstrap so the UI can render toggles.
  app.get('/push/mutes', async (req) => {
    return listPushMutes(req.user!.sub);
  });

  const muteBody = z.object({
    scope: z.enum(['server', 'dm_user']),
    targetId: z.string().min(1).max(200),
  });

  // Mute pushes from a source (a server's @mentions, or a person's DMs).
  app.post('/push/mute', async (req, reply) => {
    const wait = await rateHit(`push:mute:${req.user!.sub}`, 60, 300);
    if (wait) return reply.code(429).send({ error: retryMessage(wait) });
    const b = muteBody.parse(req.body);
    await setPushMute(req.user!.sub, b.scope, b.targetId);
    return reply.code(204).send();
  });

  // Un-mute a previously muted source.
  app.delete('/push/mute', async (req, reply) => {
    const wait = await rateHit(`push:mute:${req.user!.sub}`, 60, 300);
    if (wait) return reply.code(429).send({ error: retryMessage(wait) });
    const b = muteBody.parse(req.body);
    await removePushMute(req.user!.sub, b.scope, b.targetId);
    return reply.code(204).send();
  });
}
