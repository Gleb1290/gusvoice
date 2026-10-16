import type { ConvReadAt, ConvReaders, LastSeenExceptions, UserLastSeen } from '@gusvoice/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import { peerReadKeys, type ConvAccess } from './conversations.js';
import { isBlockedBy } from './blocks.js';
import { db } from './db/index.js';
import { arePeers, loadPeers } from './db/peerQueries.js';
import { conversationMembers, conversationMessages, lastSeenExceptions, userBlocks, users } from './db/schema.js';
import { isUserDmPresent } from './gateway.js';
import {
  groupReaders,
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

type SideRow = ReadTimeSide & { lastSeenAt: Date | null; deleted: boolean; remote?: boolean };

/**
 * ЛС между инстансами, Э4 (#141, `dm3`): время захода человека соседа (теневая строка `subjectId`) глазами нашего `viewerId` —
 * итог правил ЕГО дома, присланный этим домом (`federation/dmEphemeral.ts`): `shares` — точное время видно (`lastSeenAt`), иначе
 * только примерное (`lastSeenAt` — представитель категории, наружу не уходит). `null` — дом ничего не присылал: строка как есть.
 * Задаёт `index.ts` (крючок, без импорта: модуль проверки исполняют с закрытым перечнем зависимостей).
 */
export type RemoteLastSeen = (subjectId: string, viewerId: string) => { shares: boolean; lastSeenAt: Date | null } | null;
let remoteLastSeen: RemoteLastSeen | null = null;
export function configureRemoteLastSeen(fn: RemoteLastSeen | null): void {
  remoteLastSeen = fn;
}

/** Сторона человека соседа: правило и исключения его дома уже применены там — здесь «всем» либо «никому». */
function withRemote(subject: SideRow, viewerId: string): SideRow {
  const r = remoteLastSeen?.(subject.id, viewerId);
  // Исправления ревью 12.10, п. 8: от дома ничего — правила его дома нам неизвестны, местная теневая строка (гостевые заходы)
  // их не заменяет: «никому» и без времени.
  if (!r) return subject.remote ? { ...subject, lastSeenAt: null, privacy: 'nobody', exceptions: undefined } : subject;
  return { ...subject, lastSeenAt: r.lastSeenAt, privacy: r.shares ? 'everyone' : 'nobody', exceptions: undefined };
}

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
      home: users.homeInstanceId,
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
        remote: !!r.home,
      },
    ]),
  );
}

/** «В сети» / «был(а) …» человека глазами `viewerId`. Нет такого (или удалён) — `null`. */
export async function lastSeenFor(viewerId: string, subjectId: string): Promise<UserLastSeen | null> {
  const sides = await loadSides([viewerId, subjectId], viewerId);
  const stored = sides.get(subjectId);
  const viewer = sides.get(viewerId);
  if (!stored || !viewer || stored.deleted) return null;
  const subject = withRemote(stored, viewerId);
  const isPeer = viewerId === subjectId ? true : await arePeers(viewerId, subjectId);
  // F5 (приёмка 13.10): заблокировавший меня — «был(а) давно», как у Telegram. Человек соседа, заблокировавший меня у себя
  // дома, сюда не попадает (его блок наш инстанс не знает) — «давно» даёт пустой вид из его дома (`dmEphemeral.fedBlockChanged`).
  const blockedViewer = viewerId !== subjectId && (await isBlockedBy(subjectId, viewerId));
  return lastSeenView({ subject, viewer, isPeer, connected: isUserDmPresent(subjectId), now: Date.now(), blockedViewer });
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
    const stored = sides.get(id);
    if (!stored || stored.deleted) continue;
    const blockedViewer = id !== viewerId && (await isBlockedBy(id, viewerId)); // F5: заблокировавший меня — «давно»
    const subject = withRemote(stored, viewerId);
    out.push(lastSeenView({ subject, viewer, isPeer: id === viewerId || peers.has(id), connected: isUserDmPresent(id), now, blockedViewer }));
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

/**
 * «Кто прочитал» СВОЁ сообщение в группе (15.10, `readers1`, `GET /conv/:id/messages/:mid/readers`). Не группа («Избранное»,
 * 1:1 — у него `read-at`), чужое или удалённое сообщение, нет такого — `null` (404). Правила — `lastSeenRules.groupReaders`;
 * здесь только чтение: «прочитано до» действующих участников, стороны времени захода, блокировки в обе стороны, «собеседники».
 * Люди соседа в группе — по их `last_read_key` у нас (строки `read` хоста, `dmgroupmarks1`); нет отметок — их и нет в списке.
 */
export async function readersFor(me: string, access: ConvAccess, messageId: string): Promise<ConvReaders | null> {
  if (access.kind !== 'group' || access.saved || access.peerId) return null;
  const [msg] = await db
    .select({
      authorId: conversationMessages.authorId,
      sortKey: conversationMessages.sortKey,
      createdAt: conversationMessages.createdAt,
      deletedAt: conversationMessages.deletedAt,
    })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.id, messageId), eq(conversationMessages.conversationId, access.conversationId)))
    .limit(1);
  if (!msg || msg.authorId !== me || msg.deletedAt) return null;
  const others = access.memberIds.filter((id) => id !== me);
  if (others.length === 0) {
    // В группе, кроме автора, никого: срок «кто прочитал» решает то же правило (`groupReaders`), что и при участниках —
    // старое сообщение отвечает `expired`, а не пустым списком (находка Codex R239).
    const solo = (await loadSides([me], me)).get(me);
    if (!solo) return null;
    const view = groupReaders({ me: solo, sortKey: msg.sortKey, createdAt: msg.createdAt, now: Date.now(), members: [] });
    return view.expired ? { items: [], expired: true } : { items: [] };
  }
  const [keys, sides, blockRows, peers] = await Promise.all([
    db
      .select({ id: conversationMembers.userId, key: conversationMembers.lastReadKey })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, access.conversationId), inArray(conversationMembers.userId, others))),
    loadSides([me, ...others], me),
    db
      .select({ blocker: userBlocks.blockerId, blocked: userBlocks.blockedId })
      .from(userBlocks)
      .where(
        or(
          and(eq(userBlocks.blockerId, me), inArray(userBlocks.blockedId, others)),
          and(inArray(userBlocks.blockerId, others), eq(userBlocks.blockedId, me)),
        ),
      ),
    loadPeers(me),
  ]);
  const mine = sides.get(me);
  if (!mine) return null;
  const keyOf = new Map(keys.map((k) => [k.id, Number(k.key)]));
  const blocked = new Set(blockRows.map((b) => (b.blocker === me ? b.blocked : b.blocker)));
  const members = others.flatMap((id) => {
    const side = sides.get(id);
    return side
      ? [{ ...side, lastReadKey: keyOf.get(id) ?? 0, blocked: blocked.has(id), isPeer: peers.has(id) }]
      : [];
  });
  const view = groupReaders({ me: mine, sortKey: msg.sortKey, createdAt: msg.createdAt, now: Date.now(), members });
  if (view.expired) return { items: [], expired: true };
  if (view.ids.length === 0) return { items: [] };
  const rows = await db
    .select({ id: users.id, username: users.username, displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(inArray(users.id, view.ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    items: view.ids.flatMap((id) => {
      const r = byId.get(id);
      return r ? [{ userId: r.id, username: r.username, displayName: r.displayName, avatarUrl: r.avatarUrl }] : [];
    }),
  };
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
