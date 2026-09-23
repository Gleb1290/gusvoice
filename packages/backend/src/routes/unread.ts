import type { UnreadSummary } from '@gusvoice/shared';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.js';
import { unreadSummary } from '../unread.js';

/**
 * Сводка непрочитанного по всему инстансу — её спрашивает фоновый шлюз (#139, §5.7).
 *
 * Сам подсчёт живёт в `src/unread.ts`: маршрут — тонкая обёртка, чтобы правило можно было позвать
 * из интеграционного теста на настоящей базе, а не только через HTTP.
 */
export async function unreadRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/unread', async (req): Promise<UnreadSummary> => unreadSummary(req.user!.sub));
}
