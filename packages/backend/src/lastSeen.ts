import type { ConvReadAt, LastSeenExceptions, UserLastSeen } from '@gusvoice/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import { peerReadKeys, type ConvAccess } from './conversations.js';
import { isBlockedBy } from './blocks.js';
import { db } from './db/index.js';
import { arePeers, loadPeers } from './db/peerQueries.js';
import { conversationMessages, lastSeenExceptions, users } from './db/schema.js';
import { isUserDmPresent } from './gateway.js';
import {
  LAST_SEEN_EXCEPTIONS_MAX,
  lastSeenView,
  normalizeLastSeenPrivacy,
  readAtView,
  readTimeHidden,
  type LastSeenExceptionSets,
  type ReadTimeSide,
} from './lastSeenRules.js';

/**
 * «Был(а) в сети» и «Прочитано в …» (С1, #211) — база + шлюз вокруг чистых `lastSeenRules.ts`.
 */

type SideRow = ReadTimeSide & { lastSeenAt: Date | null; deleted: boolean };

/**
 * Исключения, которые меняют картину между зрителем и людьми `ids` (G07, `lastseen3`): МОИ списки про них и ИХ записи про меня
 * (взаимность считается по итогу). Одним запросом; люди без исключений в карте не появляются.
 */
async function loadExceptionSets(viewerId: string, ids: readonly string[]): Promise<Map<string, LastSeenExceptionSets>> {
  const out = new Map<string, { always: Set<string>; never: Set<string> }>();
  const others = ids.filter((id) => id !== viewerId);
  if (others.length === 0) return out;
  const rows = await db
    .select({ owner: lastSeenExceptions.ownerId, target: lastSeenExceptions.targetId, kind: lastSeenExceptions.kind })
    .from(lastSeenExceptions)
    .where(
      or(
        and(eq(lastSeenExceptions.ownerId, viewerId), inArray(lastSeenExceptions.targetId, others)),
        and(inArray(lastSeenExceptions.ownerId, others), eq(lastSeenExceptions.targetId, viewerId)),
      ),
    );
  for (const r of rows) {
    const set = out.get(r.owner) ?? { always: new Set<string>(), never: new Set<string>() };
    set[r.kind].add(r.target);
    out.set(r.owner, set);
  }
  return out;
}

async function loadSides(ids: string[], viewerForExceptions?: string): Promise<Map<string, SideRow>> {
  const rows = await db
    .select({
      id: users.id,
      lastSeenAt: users.lastSeenAt,
      privacy: users.lastSeenPrivacy,
      hideReadTime: users.hideReadTime,
      presence: users.presenceStatus,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(inArray(users.id, ids));
  const exceptions = viewerForExceptions ? await loadExceptionSets(viewerForExceptions, ids) : new Map<string, LastSeenExceptionSets>();
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        exceptions: exceptions.get(r.id),
        lastSeenAt: r.lastSeenAt,
        privacy: normalizeLastSeenPrivacy(r.privacy),
        hideReadTime: r.hideReadTime,
        invisible: r.presence === 'invisible',
        deleted: !!r.deletedAt,
      },
    ]),
  );
}

/** «В сети» / «был(а) …» человека глазами `viewerId`. Нет такого (или удалён) — `null`. */
export async function lastSeenFor(viewerId: string, subjectId: string): Promise<UserLastSeen | null> {
  const sides = await loadSides([viewerId, subjectId], viewerId);
  const subject = sides.get(subjectId);
  const viewer = sides.get(viewerId);
  if (!subject || !viewer || subject.deleted) return null;
  const isPeer = viewerId === subjectId ? true : await arePeers(viewerId, subjectId);
  return lastSeenView({ subject, viewer, isPeer, connected: isUserDmPresent(subjectId), now: Date.now() });
}

/** Сколько людей за один запрос `POST /users/last-seen` (строки беседы + участники групп на экране). */
export const LAST_SEEN_BATCH_MAX = 200;

/**
 * То же, что `lastSeenFor`, но пачкой для списка бесед (точки «в сети», `lastseen2`): соседей зрителя поднимаем ОДНИМ
 * запросом (`loadPeers`). Нет такого / удалён — в ответе пропущен.
 */
export async function lastSeenForMany(viewerId: string, subjectIds: readonly string[]): Promise<UserLastSeen[]> {
  const ids = [...new Set(subjectIds)].slice(0, LAST_SEEN_BATCH_MAX);
  if (ids.length === 0) return [];
  const sides = await loadSides([viewerId, ...ids], viewerId);
  const viewer = sides.get(viewerId);
  if (!viewer) return [];
  const peers = await loadPeers(viewerId);
  const now = Date.now();
  const out: UserLastSeen[] = [];
  for (const id of ids) {
    const subject = sides.get(id);
    if (!subject || subject.deleted) continue;
    out.push(lastSeenView({ subject, viewer, isPeer: id === viewerId || peers.has(id), connected: isUserDmPresent(id), now }));
  }
  return out;
}

/**
 * Можно ли «Отправить, когда будет в сети» собеседнику: только если его время захода мне видно (Telegram
 * `CanScheduleUntilOnline` + серверный `SCHEDULE_STATUS_PRIVATE`). Иначе доставка выдала бы, когда он зашёл.
 */
export async function canScheduleUntilOnline(me: string, peerId: string): Promise<boolean> {
  const v = await lastSeenFor(me, peerId);
  return !!v && v.exact;
}

/**
 * «Прочитано в …» своего сообщения в беседе 1:1. Чужое сообщение, группа, нет сообщения — `null` (404).
 */
export async function readAtFor(me: string, access: ConvAccess, messageId: string): Promise<ConvReadAt | null> {
  const peerId = access.peerId;
  if (!peerId) return null;
  const [msg] = await db
    .select({
      authorId: conversationMessages.authorId,
      sortKey: conversationMessages.sortKey,
      createdAt: conversationMessages.createdAt,
      readAt: conversationMessages.readAt,
    })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.id, messageId), eq(conversationMessages.conversationId, access.conversationId)))
    .limit(1);
  if (!msg || msg.authorId !== me) return null;
  // «Прочитано» — ровно то же, что ✓✓ в сводке (`peerReadKeys`): у того, кто меня заблокировал, ключ под потолком
  // придержанного (Р12, «заблокированный ничего не узнаёт»).
  const peerKey = (await peerReadKeys(me, [access.conversationId])).get(access.conversationId) ?? null;
  const read = peerKey !== null && peerKey >= msg.sortKey;
  const sides = await loadSides([me, peerId], me);
  const mine = sides.get(me);
  const theirs = sides.get(peerId);
  // Заблокировавший меня — без времени (Telegram: заблокированному ни времени захода, ни времени прочтения).
  const hidden =
    !mine || !theirs || (await isBlockedBy(peerId, me)) ? true : readTimeHidden(mine, theirs, await arePeers(me, peerId));
  return readAtView({ read, readAt: msg.readAt, createdAt: msg.createdAt, hidden, now: Date.now() });
}

type ExceptionKind = 'always' | 'never';

/** Мои исключения «Времени захода» с именами людей (удалённых нет). */
export async function myLastSeenExceptions(me: string): Promise<LastSeenExceptions> {
  const rows = await db
    .select({
      kind: lastSeenExceptions.kind,
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(lastSeenExceptions)
    .innerJoin(users, eq(users.id, lastSeenExceptions.targetId))
    .where(eq(lastSeenExceptions.ownerId, me))
    .orderBy(lastSeenExceptions.createdAt);
  const out: LastSeenExceptions = { always: [], never: [] };
  for (const r of rows) {
    out[r.kind as ExceptionKind].push({ id: r.id, username: r.username, displayName: r.displayName, avatarUrl: r.avatarUrl });
  }
  return out;
}

/**
 * Записать списки целиком (Telegram сохраняет оба списка одним действием). Чистка: себя, повторы, неизвестных и удалённых
 * людей отбрасываем; в обоих списках сразу — остаётся «Никогда» (безопасная сторона: не раскрывать), каждый список — до
 * `LAST_SEEN_EXCEPTIONS_MAX`.
 */
export async function setLastSeenExceptions(me: string, always: readonly string[], never: readonly string[]): Promise<LastSeenExceptions> {
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
    ...alwaysIds.filter((id) => live.has(id)).map((id) => ({ ownerId: me, targetId: id, kind: 'always' as const })),
    ...neverIds.filter((id) => live.has(id)).map((id) => ({ ownerId: me, targetId: id, kind: 'never' as const })),
  ];
  await db.transaction(async (tx) => {
    await tx.delete(lastSeenExceptions).where(eq(lastSeenExceptions.ownerId, me));
    if (rows.length) await tx.insert(lastSeenExceptions).values(rows);
  });
  return myLastSeenExceptions(me);
}
