import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { rateHit, retryMessage } from '../authGuard.js';
import { deliver, journalMuteChange } from '../conversations.js';
import { MUTE_SECONDS_MAX, MUTE_SECONDS_MIN } from '../convRules.js';
import { validWebPushKeys } from '../pushCrypto.js';
import {
  listPushAlways,
  listPushMutes,
  pushEndpointAllowed,
  registerPushDevice,
  removePushAlways,
  removePushMute,
  setPushAlways,
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
        // Ключи шифрования пуша (#213, WebPush) — только у новых установок; старые шлют без них.
        keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }).nullish(),
        // Что умеет приложение (Р1, G17, миграция 0102): `read1` — снимает уведомление по сигналу «прочитано»,
        // `reply1` — отвечает из шторки. Неизвестные отбрасываются (`normalizePushCaps`); старое приложение поля не шлёт.
        caps: z.array(z.string().max(20)).max(10).nullish(),
        // Часовой пояс устройства (IANA, миграция 0128): повтор уведомления идёт только днём. Старое приложение поля не шлёт.
        tz: z.string().max(64).nullish(),
      })
      .parse(req.body);
    if (!pushEndpointAllowed(b.endpoint)) return reply.code(400).send({ error: 'endpoint host not allowed' });
    if (b.keys && !validWebPushKeys(b.keys)) return reply.code(400).send({ error: 'invalid push keys' });
    await registerPushDevice(req.user!.sub, b.deviceId, b.endpoint, b.platform ?? null, b.keys ?? null, b.caps ?? null, b.tz ?? null);
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

  /**
   * Заглушка собеседника сменилась (07.10, `conv11`) — сводка беседы с ним (в ней `muted`) всем моим устройствам:
   * второй экран тоже перестаёт звенеть и показывает значок. Сбой события заглушку не отменяет (она уже записана).
   */
  const syncDmMute = async (me: string, scope: string, targetId: string): Promise<void> => {
    if (scope !== 'dm_user') return;
    await deliver(await journalMuteChange(me, targetId)).catch(() => {});
  };

  // Mute pushes from a source (a server's @mentions, or a person's DMs). `seconds` (07.10, `conv11`) — на срок;
  // без него — навсегда (старые клиенты). Для `dm_user` глушит и звук, тост и мигание в приложении (клиент `conv11`).
  app.post('/push/mute', async (req, reply) => {
    const wait = await rateHit(`push:mute:${req.user!.sub}`, 60, 300);
    if (wait) return reply.code(429).send({ error: retryMessage(wait) });
    const b = muteBody
      .extend({
        seconds: z.number().int().min(MUTE_SECONDS_MIN).max(MUTE_SECONDS_MAX).optional(),
        // «Выключить звук» (07.10, `conv13`): уведомление приходит без звука; без поля — полная заглушка, как раньше.
        soundOnly: z.boolean().optional(),
      })
      .parse(req.body);
    await setPushMute(req.user!.sub, b.scope, b.targetId, b.seconds, b.soundOnly === true);
    await syncDmMute(req.user!.sub, b.scope, b.targetId);
    return reply.code(204).send();
  });

  // Un-mute a previously muted source.
  app.delete('/push/mute', async (req, reply) => {
    const wait = await rateHit(`push:mute:${req.user!.sub}`, 60, 300);
    if (wait) return reply.code(429).send({ error: retryMessage(wait) });
    const b = muteBody.parse(req.body);
    await removePushMute(req.user!.sub, b.scope, b.targetId);
    await syncDmMute(req.user!.sub, b.scope, b.targetId);
    return reply.code(204).send();
  });

  /**
   * «Исключения: уведомления включены» (08.10, #211, решение владельца 38, признак `push4`): беседа уведомляет, хотя «Личные
   * сообщения» / «Уведомления из групп» выключены (Telegram «Включить уведомления» в чате при выключенных «Личные чаты»).
   * Новые пути — старый клиент их не зовёт; `targetId` — как у заглушки `dm_user` (id собеседника или `group:<id беседы>`).
   * Включение снимает полную заглушку беседы — сводка беседы (`muted`) уходит моим устройствам, как при снятии заглушки.
   */
  app.get('/push/always', async (req) => {
    return listPushAlways(req.user!.sub);
  });

  const alwaysBody = z.object({ scope: z.literal('dm_user'), targetId: z.string().min(1).max(200) });

  app.post('/push/always', async (req, reply) => {
    const wait = await rateHit(`push:mute:${req.user!.sub}`, 60, 300);
    if (wait) return reply.code(429).send({ error: retryMessage(wait) });
    const b = alwaysBody.parse(req.body);
    await setPushAlways(req.user!.sub, b.targetId);
    await syncDmMute(req.user!.sub, b.scope, b.targetId);
    return reply.code(204).send();
  });

  app.delete('/push/always', async (req, reply) => {
    const wait = await rateHit(`push:mute:${req.user!.sub}`, 60, 300);
    if (wait) return reply.code(429).send({ error: retryMessage(wait) });
    const b = alwaysBody.parse(req.body);
    await removePushAlways(req.user!.sub, b.targetId);
    return reply.code(204).send();
  });
}
