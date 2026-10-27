import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { rateHit, retryMessage } from '../authGuard.js';
import { blockedBy, blockUser, unblockUser } from '../blocks.js';
import { findDirect, queueBotChatMember } from '../conversations.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

/**
 * Блокировка бота (аудит 26.10, как Telegram): боту — `my_chat_member` `kicked` (разблокировка — `kicked` → `member`), если
 * беседа с ним есть. Не бот / беседы нет — ничего; проверки «живой / приватный» — в `bots/botUpdates.chatMemberUpdate`.
 */
async function botBlockChange(me: string, userId: string, blocked: boolean): Promise<void> {
  const [row] = await db.select({ bot: users.bot }).from(users).where(inArray(users.id, [userId])).limit(1);
  if (!row?.bot) return;
  const conv = await findDirect(me, userId);
  if (!conv) return;
  queueBotChatMember(userId, me, conv.id, blocked ? 'kicked' : 'member', blocked ? 'member' : 'kicked');
}

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
    await botBlockChange(me, userId, true).catch((err) => console.warn('[bots] блокировка:', err instanceof Error ? err.message : err));
    return reply.code(204).send();
  });

  app.delete('/blocks/:userId', async (req, reply) => {
    const me = req.user!.sub;
    const wait = await rateHit(`blocks:${me}`, 30, 300);
    if (wait) return reply.code(429).send({ error: retryMessage(wait) });
    const { userId } = z.object({ userId: z.string().min(1).max(64) }).parse(req.params);
    await unblockUser(me, userId);
    await botBlockChange(me, userId, false).catch((err) => console.warn('[bots] разблокировка:', err instanceof Error ? err.message : err));
    return reply.code(204).send();
  });
}
