import type { LastSeenExceptions } from '@gusvoice/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { callAllowed, normalizeCallPrivacy } from './callRules.js';
import { db } from './db/index.js';
import { isAcceptedPeer } from './db/peerQueries.js';
import { privacyExceptions, users } from './db/schema.js';
import { LAST_SEEN_EXCEPTIONS_MAX, type LastSeenException } from './lastSeenRules.js';

/**
 * «Кто может звонить» (08.10, #211, решение владельца, `presence4`) — база вокруг чистого `callRules.callAllowed`.
 * Правило — `users.call_privacy`, исключения — `privacy_exceptions` с ключом `calls` (миграция 0122). Списки устроены как у
 * «Времени захода» (`lastSeen.ts`): сохраняются оба целиком, в обоих сразу — остаётся «Никогда», до 200 человек в каждом.
 */

const KEY = 'calls' as const;

/** Разрешает ли `calleeId` звонок `callerId` своей настройкой. Нет такого человека — `false`. Блокировки здесь не смотрим. */
export async function callAllowedFor(callerId: string, calleeId: string): Promise<boolean> {
  if (callerId === calleeId) return false;
  const [row] = await db.select({ privacy: users.callPrivacy }).from(users).where(eq(users.id, calleeId)).limit(1);
  if (!row) return false;
  const privacy = normalizeCallPrivacy(row.privacy);
  const [ex] = await db
    .select({ kind: privacyExceptions.kind })
    .from(privacyExceptions)
    .where(and(eq(privacyExceptions.ownerId, calleeId), eq(privacyExceptions.key, KEY), eq(privacyExceptions.targetId, callerId)))
    .limit(1);
  const exception: LastSeenException = ex ? ex.kind : null;
  // «Собеседники» без исключения — единственный случай, где нужен запрос связи. Для звонков — только ПРИНЯТЫЕ собеседники
  // хозяина (п.26 владельца 08.10): незнакомец с плашкой и пустая беседа, заведённая звонящим, не в счёт (`isAcceptedPeer`).
  const isPeer = privacy === 'peers' && exception === null ? await isAcceptedPeer(calleeId, callerId) : false;
  return callAllowed(privacy, isPeer, exception);
}

/** Мои исключения «Кто может звонить» с именами людей (удалённых нет). */
export async function myCallExceptions(me: string): Promise<LastSeenExceptions> {
  const rows = await db
    .select({
      kind: privacyExceptions.kind,
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(privacyExceptions)
    .innerJoin(users, eq(users.id, privacyExceptions.targetId))
    .where(and(eq(privacyExceptions.ownerId, me), eq(privacyExceptions.key, KEY)))
    .orderBy(privacyExceptions.createdAt);
  const out: LastSeenExceptions = { always: [], never: [] };
  for (const r of rows) out[r.kind].push({ id: r.id, username: r.username, displayName: r.displayName, avatarUrl: r.avatarUrl });
  return out;
}

/** Записать оба списка целиком (как `setLastSeenExceptions`): себя, повторы, неизвестных и удалённых отбрасываем. */
export async function setCallExceptions(me: string, always: readonly string[], never: readonly string[]): Promise<LastSeenExceptions> {
  const neverIds = [...new Set(never)].filter((id) => id !== me).slice(0, LAST_SEEN_EXCEPTIONS_MAX);
  const neverSet = new Set(neverIds);
  const alwaysIds = [...new Set(always)].filter((id) => id !== me && !neverSet.has(id)).slice(0, LAST_SEEN_EXCEPTIONS_MAX);
  const wanted = [...alwaysIds, ...neverIds];
  const live = wanted.length
    ? new Set(
        (await db.select({ id: users.id, deletedAt: users.deletedAt }).from(users).where(inArray(users.id, wanted)))
          .filter((r) => !r.deletedAt)
          .map((r) => r.id),
      )
    : new Set<string>();
  const rows = [
    ...alwaysIds.filter((id) => live.has(id)).map((id) => ({ ownerId: me, targetId: id, key: KEY, kind: 'always' as const })),
    ...neverIds.filter((id) => live.has(id)).map((id) => ({ ownerId: me, targetId: id, key: KEY, kind: 'never' as const })),
  ];
  await db.transaction(async (tx) => {
    await tx.delete(privacyExceptions).where(and(eq(privacyExceptions.ownerId, me), eq(privacyExceptions.key, KEY)));
    if (rows.length) await tx.insert(privacyExceptions).values(rows);
  });
  return myCallExceptions(me);
}
