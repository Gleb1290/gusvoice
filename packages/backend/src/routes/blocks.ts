import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { rateHit, retryMessage } from '../authGuard.js';
import { blockedBy, blockUser, unblockUser } from '../blocks.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

/**
 * Чёрный список личных сообщений (#212, этап 0 ЛС). Что блокировка делает — `blockRules.ts`.
 * Список видит только его хозяин; заблокированному о нём не сообщается ничем.
 */
export async function blockRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Кого я заблокировал — с профилями, чтобы настройки могли показать список без второго запроса.
  app.get('/blocks', async (req) => {
    const ids = [...(await blockedBy(req.user!.sub))];
    if (ids.length === 0) return [];
    const rows = await db
      .select({ id: users.id, username: users.username, displayName: users.displayName, avatarUrl: users.avatarUrl })
      .from(users)
      .where(inArray(users.id, ids));
    return rows;
  });

  app.post('/blocks', async (req, reply) => {
    const me = req.user!.sub;
    const wait = await rateHit(`blocks:${me}`, 30, 300);
    if (wait) return reply.code(429).send({ error: retryMessage(wait) });
    const { userId } = z.object({ userId: z.string().min(1).max(64) }).parse(req.body);
    if (userId === me) return reply.code(400).send({ error: 'cannot block yourself' });
    const [row] = await db.select({ id: users.id }).from(users).where(inArray(users.id, [userId])).limit(1);
    if (!row) return reply.code(404).send({ error: 'user not found' });
    await blockUser(me, userId);
    return reply.code(204).send();
  });

  app.delete('/blocks/:userId', async (req, reply) => {
    const me = req.user!.sub;
    const wait = await rateHit(`blocks:${me}`, 30, 300);
    if (wait) return reply.code(429).send({ error: retryMessage(wait) });
    const { userId } = z.object({ userId: z.string().min(1).max(64) }).parse(req.params);
    await unblockUser(me, userId);
    return reply.code(204).send();
  });
}
