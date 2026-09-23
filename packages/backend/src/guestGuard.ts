/**
 * «Гостю нельзя» — одна проверка на все маршруты аккаунта (#139, план §5.8; аудит 19.09, F-17).
 *
 * План закрывает гостю «свой аккаунт на хосте»: пароль, почта, двухфакторная, удаление, имя и
 * аватар — всё это делается ДОМА, а на хосте у теневой строки нет ни пароля, ни почты. Проверки при
 * этом стояли только на создании сервера, передаче владения и личке; гость гостевым токеном мог
 * включить себе 2FA без пароля, переименоваться до следующего входа и положить файл аватара мимо
 * квоты связки (F-05).
 *
 * 🔴 Список ЗАКРЫТОГО, а не открытого (`GUEST_FORBIDDEN_REASONS.account`): гость должен уметь всё,
 * что умеет местный участник, кроме перечисленного. Поэтому это `preHandler` на конкретных
 * маршрутах, а не общий фильтр.
 *
 * Сама проверка — `guestGuardCore.ts` (без базы, вынос для тестов 22.09); здесь чем узнать «местный ли».
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { createRequireLocalUser } from './guestGuardCore.js';

/** Местный ли это человек (не теневая строка гостя). Неизвестный — «не местный»: доступа нет. */
export async function isLocalUser(userId: string): Promise<boolean> {
  const [row] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, userId)).limit(1);
  return row !== undefined && row.home === null;
}

const guard = createRequireLocalUser((userId) => isLocalUser(userId));

/** `preHandler` после `requireAuth`: гостю — 403 с кодом протокола (см. `guestGuardCore.ts`). */
export function requireLocalUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  return guard(req, reply);
}
