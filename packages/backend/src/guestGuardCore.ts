/**
 * «Гостю нельзя» — сама проверка, без базы (вынос для тестов 22.09; проводка — `guestGuard.ts`, там же
 * шапка «почему список закрытого, а не открытого»).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { FED_ERRORS } from '@gusvoice/shared';

/**
 * `preHandler` после `requireAuth`: гостю — 403 с кодом протокола, по которому клиент пишет текст.
 * Нет пользователя в запросе или он неизвестен — тоже отказ: доступа по умолчанию нет.
 */
export function createRequireLocalUser(isLocalUser: (userId: string) => Promise<boolean>) {
  return async function requireLocalUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = req.user?.sub;
    if (!userId || !(await isLocalUser(userId))) {
      await reply.code(403).send({ error: FED_ERRORS.guestForbidden });
    }
  };
}
