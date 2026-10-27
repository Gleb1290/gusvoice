import type { LastSeenExceptions } from '@gusvoice/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { privacyExceptions, users } from './db/schema.js';
import { LAST_SEEN_EXCEPTIONS_MAX } from './lastSeenRules.js';
import { messageAllowed, normalizeMessagePrivacy } from './messagePrivacyRules.js';

/**
 * «Кто может мне писать» (13.10, #218, `msgpriv1`) — база вокруг чистого `messagePrivacyRules.messageAllowed`. Правило —
 * `users.message_privacy`, исключения «Всегда разрешать» — `privacy_exceptions` с ключом `messages` (миграция 0146; «Никогда» у
 * этой настройки нет, как у Telegram). Устроено как `callPrivacy.ts`.
 */

const KEY = 'messages' as const;

/**
 * Пускает ли `recipientId` сообщения от `senderId` своей настройкой. Нет такого получателя — `true` (решают другие проверки:
 * «собеседник удалён», 404). Блокировку здесь не смотрим. Одним запросом: контакт, «я писал ему первым» (в беседе 1:1 есть
 * НЕ служебное и не удалённое сообщение получателя — тот же признак «я ответил», что у `peerQueries.isAcceptedPeer`), исключение.
 */
export async function messageAllowedFor(
  senderId: string,
  recipientId: string,
  /** Транзакция вызывающего (аудит ЛС #236, п.10: отложенное проверяется под замком беседы); по умолчанию — пул. */
  q: Pick<typeof db, 'select' | 'execute'> = db,
): Promise<boolean> {
  if (senderId === recipientId) return true;
  const [row] = await q.select({ privacy: users.messagePrivacy }).from(users).where(eq(users.id, recipientId)).limit(1);
  if (!row) return true;
  const privacy = normalizeMessagePrivacy(row.privacy);
  if (privacy === 'everyone') return true;
  const res = await q.execute(sql`
    SELECT
      EXISTS (SELECT 1 FROM user_contacts uc WHERE uc.owner_id = ${recipientId} AND uc.contact_id = ${senderId}) AS contact,
      EXISTS (SELECT 1 FROM privacy_exceptions pe
        WHERE pe.owner_id = ${recipientId} AND pe.key = ${KEY} AND pe.target_id = ${senderId} AND pe.kind = 'always') AS always,
      EXISTS (SELECT 1 FROM conversations c
        JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = ${recipientId}
        JOIN conversation_members p ON p.conversation_id = c.id AND p.user_id = ${senderId}
        WHERE c.kind = 'direct'
          AND EXISTS (SELECT 1 FROM conversation_messages sx WHERE sx.conversation_id = c.id AND sx.author_id = ${recipientId}
            AND sx.deleted_at IS NULL AND sx.service IS NULL)) AS wrote
  `);
  const r = (res.rows as { contact: boolean; always: boolean; wrote: boolean }[])[0];
  return messageAllowed({ privacy, isContact: !!r?.contact, wroteFirst: !!r?.wrote, alwaysAllowed: !!r?.always });
}

/**
 * Писал ли `authorId` человеку `otherId` в их беседе 1:1 (не служебное, не удалённое). Для собеседника с другого инстанса
 * (`routes/conv.ts`): его дом сказал «писать нельзя» (`noMessages`), но он сам уже написал мне — по правилу Telegram
 * («кому я писал первым») отвечать можно, не дожидаясь следующей записи его дома.
 */
export async function wroteInDirect(authorId: string, otherId: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM conversations c
      JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = ${authorId}
      JOIN conversation_members p ON p.conversation_id = c.id AND p.user_id = ${otherId}
      WHERE c.kind = 'direct'
        AND EXISTS (SELECT 1 FROM conversation_messages sx WHERE sx.conversation_id = c.id AND sx.author_id = ${authorId}
          AND sx.deleted_at IS NULL AND sx.service IS NULL)
      LIMIT 1
  `);
  return res.rows.length > 0;
}

/** Мои исключения «Всегда разрешать» с именами людей (удалённых нет); `never` всегда пуст. */
export async function myMessageExceptions(me: string): Promise<LastSeenExceptions> {
  const rows = await db
    .select({ id: users.id, username: users.username, displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(privacyExceptions)
    .innerJoin(users, eq(users.id, privacyExceptions.targetId))
    .where(and(eq(privacyExceptions.ownerId, me), eq(privacyExceptions.key, KEY), eq(privacyExceptions.kind, 'always')))
    .orderBy(privacyExceptions.createdAt);
  return { always: rows.map((r) => ({ id: r.id, username: r.username, displayName: r.displayName, avatarUrl: r.avatarUrl })), never: [] };
}

/** Записать список «Всегда разрешать» целиком: себя, повторы, неизвестных и удалённых отбрасываем; до 200 человек. */
export async function setMessageExceptions(me: string, always: readonly string[]): Promise<LastSeenExceptions> {
  const ids = [...new Set(always)].filter((id) => id !== me).slice(0, LAST_SEEN_EXCEPTIONS_MAX);
  const live = ids.length
    ? (await db.select({ id: users.id, deletedAt: users.deletedAt }).from(users).where(inArray(users.id, ids))).filter((r) => !r.deletedAt).map((r) => r.id)
    : [];
  const liveSet = new Set(live);
  const rows = ids.filter((id) => liveSet.has(id)).map((id) => ({ ownerId: me, targetId: id, key: KEY, kind: 'always' as const }));
  await db.transaction(async (tx) => {
    await tx.delete(privacyExceptions).where(and(eq(privacyExceptions.ownerId, me), eq(privacyExceptions.key, KEY)));
    if (rows.length) await tx.insert(privacyExceptions).values(rows);
  });
  return myMessageExceptions(me);
}
