/**
 * Сторона ДОМА: чем мы ручаемся за своего человека на чужом инстансе (#139, F3, план §5.5).
 *
 * Здесь выпускается токен личности. Ровно один вопрос решается в этом модуле — **за кого мы готовы
 * поручиться**, — и ответ на него уже стоил бы нам репутации инстанса: подпись под токеном ставится
 * тем же ключом, что и под всеми нашими запросами.
 */

import { eq } from 'drizzle-orm';
import { FED_ERRORS, FED_FEATURES, type FedErrorCode } from '@gusvoice/shared';
import { db } from '../db/index.js';
import { federationGuestGrants, users } from '../db/schema.js';
import { federation } from './instance.js';
import { getLink } from './links.js';
import { linkVerdict } from './linkRules.js';
import { readInstanceMeta } from './instanceMeta.js';
import { mediaHashOf } from './directoryRules.js';
import { issueIdentityToken } from './identityToken.js';

export type IdentityIssue =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; problem: FedErrorCode | 'unavailable' | 'not-found' };

/**
 * Выпустить токен личности для указанного хоста.
 *
 * Порядок проверок выбран по цене: сначала свои (связка, пауза, возможности соседа), и только потом
 * чтение человека из базы. Криптография — последней, после всех «нет».
 */
export async function issueIdentityFor(input: {
  userId: string;
  hostInstanceId: string;
  now: number;
}): Promise<IdentityIssue> {
  const self = federation.identity();
  const key = federation.signingKey();
  // Нет ключа — нечем ручаться. Это про нас, а не про человека, поэтому отдельный ответ.
  if (!self || !key) return { ok: false, problem: 'unavailable' };

  const link = await getLink(input.hostInstanceId);
  if (!link) return { ok: false, problem: FED_ERRORS.noLink };

  const refusal = linkVerdict(link, (await readInstanceMeta()).paused);
  if (refusal) return { ok: false, problem: refusal };

  // 🔴 Решение «умеет ли сосед гостей» — ТОЛЬКО по `features`, никогда по версии приложения
  // (`docs/federation-compat.md`). Иначе первый же сосед на старом релизе получил бы токен, который
  // ему некуда предъявить, и человек увидел бы не «нужна новая версия», а молчаливую неудачу.
  if (!link.features.includes(FED_FEATURES.guests)) return { ok: false, problem: FED_ERRORS.unsupported };

  const [user] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!user) return { ok: false, problem: 'not-found' };

  /**
   * 🔴 Гость с ТРЕТЬЕГО инстанса через нас не ходит (§5.2). Иначе мы становились бы пересыльщиком
   * личностей: человек инстанса C получал бы от нас поручительство перед B, а B считал бы его нашим.
   * Ручаться можно только за своих.
   */
  if (user.homeInstanceId !== null) return { ok: false, problem: FED_ERRORS.guestForbidden };
  // Удалённый, неподтверждённый и неодобренный не могут войти даже к нам — тем более к соседу.
  if (user.deletedAt !== null || !user.verified || user.approvedAt === null) {
    return { ok: false, problem: 'not-found' };
  }

  /**
   * 🔴 Запоминаем, перед кем поручились, — ДО выдачи токена (аудит 19.09, F-04). Это единственное,
   * что дом знает о гостевании сам: всё остальное (членства, просьбы разбудить телефон) приходит со
   * слов хоста и принимается только для пар, записанных здесь. Порядок важен: токен, выданный без
   * записи, привёл бы к гостю, чьи членства мы потом отвергали бы как чужие.
   */
  await db
    .insert(federationGuestGrants)
    .values({ userId: user.id, instanceId: link.instanceId })
    .onConflictDoUpdate({
      target: [federationGuestGrants.userId, federationGuestGrants.instanceId],
      set: { lastIssuedAt: new Date(input.now) },
    });

  const issued = issueIdentityToken({
    claims: {
      iss: self.instanceId,
      sub: user.id,
      aud: link.instanceId,
      // Поколение сессий: по нему хост поймёт, что человек нажал «выйти везде» (§5.6.1), даже если
      // наше событие об этом до него не доехало.
      gen: user.tokenGeneration,
      username: user.username,
      displayName: user.displayName,
      avatarHash: mediaHashOf(user.avatarUrl),
    },
    kid: key.kid,
    privateKeyDer: key.privateKeyDer,
    now: input.now,
  });
  return { ok: true, token: issued.token, expiresAt: issued.claims.exp };
}
