/**
 * Звонки 1:1 в ЛС (08.10, #211, С5, `calls1`) — ручки. Состояние — `calls.ts`, правила — `callRules.ts`.
 *
 * Позвонить можно тому, кому можно писать (`dmRules.canWriteDm`): только беседа 1:1 (не группа и не «Избранное»),
 * собеседник не удалён, блока нет ни в одну сторону — у Telegram заблокированному не позвонить и он не дозвонится.
 * «Кто может звонить» (`presence4`, решение владельца 08.10): настройка собеседника (`callPrivacy.callAllowedFor`) — запрет 403
 * `CALL_PRIVACY_ERROR` (Telegram `USER_PRIVACY_RESTRICTED`). Встречный вызов (он звонит мне сейчас) — это ответ, его не режем.
 */
import { CALL_BUSY_ERROR, CALL_PRIVACY_ERROR, type CallActiveResponse } from '@gusvoice/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { rateHit } from '../authGuard.js';
import { isBlockedBy } from '../blocks.js';
import { callAllowedFor } from '../callPrivacy.js';
import { act, callById, callJoin, callOf, ping, startCall } from '../calls.js';
import { loadAccess } from '../conversations.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { canWriteDm } from '../dmRules.js';

const idParams = z.object({ id: z.string().min(1).max(64) });
const deviceBody = z.object({ device: z.string().min(1).max(64) });
/** Знак жизни (`calls2`): `video` — у меня включена камера. Тело необязательно — клиент `calls1` шлёт `{}`. */
const pingBody = z.object({ video: z.boolean().optional() }).passthrough().nullish();
/** Звонков в минуту с одного человека — защита от «звонилки» по кругу. */
const CALL_START_MAX = 10;
const CALL_START_WINDOW_S = 60;
const CALL_UNAVAILABLE = 'Позвонить нельзя';

export async function callRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/conv/:id/call', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = idParams.parse(req.params);
    const { device } = deviceBody.parse(req.body);
    const wait = await rateHit(`call-start:${me}`, CALL_START_MAX, CALL_START_WINDOW_S);
    if (wait > 0) return reply.code(429).header('Retry-After', String(wait)).send({ error: 'Слишком часто' });
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    if (access.kind !== 'direct' || access.saved || !access.peerId) return reply.code(400).send({ error: CALL_UNAVAILABLE });
    const peerId = access.peerId;
    const [peer] = await db.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, peerId)).limit(1);
    const write = canWriteDm({ member: true, peerExists: !!peer, peerDeleted: !!peer?.deletedAt });
    if (write !== 'ok') return reply.code(403).send({ error: CALL_UNAVAILABLE });
    if ((await isBlockedBy(peerId, me)) || (await isBlockedBy(me, peerId))) return reply.code(403).send({ error: CALL_UNAVAILABLE });
    const incoming = callOf(peerId);
    const answering = !!incoming && incoming.phase === 'ringing' && incoming.callerId === peerId && incoming.calleeId === me;
    if (!answering && !(await callAllowedFor(me, peerId))) return reply.code(403).send({ error: CALL_PRIVACY_ERROR });
    const res = await startCall(me, peerId, conversationId, device);
    if (res.kind === 'busy') return reply.code(409).send({ error: CALL_BUSY_ERROR });
    return reply.code(res.answered ? 200 : 201).send(await callJoin(res.call, me));
  });

  app.post('/calls/:id/answer', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { device } = deviceBody.parse(req.body);
    const res = await act(req.user!.sub, id, 'answer', device);
    if (res.kind === 'gone') return reply.code(404).send({ error: 'call ended' });
    if (res.kind === 'forbidden') return reply.code(409).send({ error: 'cannot answer' });
    return callJoin(res.call, req.user!.sub);
  });

  for (const action of ['decline', 'hangup'] as const) {
    app.post(`/calls/:id/${action}`, async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const res = await act(req.user!.sub, id, action);
      if (res.kind === 'forbidden') return reply.code(409).send({ error: `cannot ${action}` });
      // Уже кончился — для кладущего трубку это успех: звонка нет.
      return { call: res.kind === 'ok' ? res.call : null } satisfies CallActiveResponse;
    });
  }

  app.post('/calls/:id/ping', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = pingBody.safeParse(req.body);
    if (!ping(req.user!.sub, id, body.success && body.data?.video === true)) return reply.code(404).send({ error: 'call ended' });
    return { call: callById(id) } satisfies CallActiveResponse;
  });

  /** Мой текущий звонок — для устройства, которое подключилось посреди звонка (и после перезагрузки страницы). */
  app.get('/calls/active', async (req) => ({ call: callOf(req.user!.sub) }) satisfies CallActiveResponse);
}
