import type { ConvGroupService } from '@gusvoice/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { dropUploadsOfMember } from './bigUploads.js';
import { journal, lockConversation, type Delivery, type Tx } from './conversations.js';
import { db } from './db/index.js';
import { conversationMembers, conversationMessages, conversations, users } from './db/schema.js';
import { canRemoveMember, groupAddCheck, groupCreateCheck, nextOwner, serviceText, type GroupRole } from './groupRules.js';
import { uuidv7 } from './util.js';

/**
 * Групповые ЛС (07.10, #211, С4, признак `groups1`) — запись в базу: создать, добавить, удалить, выйти, переименовать,
 * сменить фото. Каждое действие — служебная запись в ленте (`conversation_messages.service`, миграция 0099) обычным путём
 * сообщения: ключ порядка под замком беседы, строка журнала `'msg'` каждому участнику — события и догонка у них прежние.
 * Правила (предел, права, текст) — чистые, `groupRules.ts`. Кто кого вправе позвать — ручка (`routes/convGroups.ts`).
 */

export type GroupOpResult =
  | { kind: 'ok'; conversationId: string; delivery: Delivery }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'empty' }
  | { kind: 'too-many' };

interface MemberRow {
  userId: string;
  role: GroupRole;
  leftAt: Date | null;
}

async function membersOf(tx: Tx, conversationId: string): Promise<MemberRow[]> {
  return tx
    .select({ userId: conversationMembers.userId, role: conversationMembers.role, leftAt: conversationMembers.leftAt })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId))
    .orderBy(asc(conversationMembers.joinedAt), asc(conversationMembers.userId));
}

async function displayNames(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Служебная запись: ключ — следующий под замком (`nextKey` от `lockConversation`), беседа поднимается в списке, журнал
 * `'msg'` — `audience` (действующие после действия + тот, кто вышел или удалён: его сводка придёт «вышел»).
 */
async function insertService(
  tx: Tx,
  conversationId: string,
  nextKey: number,
  actorId: string,
  service: ConvGroupService,
  audience: readonly string[],
): Promise<Delivery> {
  const names = await displayNames(tx, [actorId]);
  const [row] = await tx
    .insert(conversationMessages)
    .values({
      id: uuidv7(),
      conversationId,
      authorId: actorId,
      sortKey: nextKey,
      content: serviceText(names.get(actorId) ?? '', service),
      service,
    })
    .returning({ id: conversationMessages.id, createdAt: conversationMessages.createdAt });
  await tx
    .update(conversations)
    .set({
      lastSortKey: nextKey,
      lastMessageAt: sql`GREATEST(${conversations.lastMessageAt}, ${row.createdAt.toISOString()}::timestamptz)`,
    })
    .where(eq(conversations.id, conversationId));
  const pts = await journal(
    tx,
    [...new Set(audience)].map((userId) => ({ userId, conversationId, kind: 'msg' as const, messageId: row.id })),
  );
  return { conversationId, messageId: row.id, pts, created: true };
}

/** Снимок имён для служебной записи. */
async function brief(tx: Tx, ids: readonly string[]): Promise<{ id: string; displayName: string }[]> {
  const names = await displayNames(tx, ids);
  return ids.map((id) => ({ id, displayName: names.get(id) ?? '' }));
}

/** Создать группу: я — владелец, `userIds` — участники (уже проверенные ручкой). Запись «создал(а) группу». */
export async function createGroup(me: string, title: string, userIds: readonly string[]): Promise<GroupOpResult> {
  const others = [...new Set(userIds)];
  const verdict = groupCreateCheck(me, others);
  if (verdict === 'too-many') return { kind: 'too-many' };
  if (verdict !== 'ok') return { kind: 'empty' };
  return db.transaction(async (tx) => {
    const id = uuidv7();
    await tx.insert(conversations).values({ id, kind: 'group', createdBy: me, title });
    await tx.insert(conversationMembers).values([
      { conversationId: id, userId: me, role: 'owner' as const },
      ...others.map((userId) => ({ conversationId: id, userId, role: 'member' as const })),
    ]);
    const lock = await lockConversation(tx, id);
    if (!lock) throw new Error('группа не найдена сразу после вставки');
    const delivery = await insertService(tx, id, lock.nextKey, me, { kind: 'group', type: 'create', title }, [me, ...others]);
    return { kind: 'ok', conversationId: id, delivery };
  });
}

/** Добавить людей (любой участник). Вышедших раньше возвращает той же строкой; непрочитанное у них — с записи «добавил». */
export async function addGroupMembers(me: string, conversationId: string, userIds: readonly string[]): Promise<GroupOpResult> {
  return db.transaction(async (tx) => {
    const lock = await lockConversation(tx, conversationId);
    if (!lock || lock.kind !== 'group') return { kind: 'not-found' };
    const rows = await membersOf(tx, conversationId);
    const active = rows.filter((r) => !r.leftAt).map((r) => r.userId);
    if (!active.includes(me)) return { kind: 'not-found' };
    const adding = [...new Set(userIds)].filter((id) => !active.includes(id));
    const verdict = groupAddCheck(active.length, adding.length);
    if (verdict !== 'ok') return { kind: verdict };
    const known = new Set(rows.map((r) => r.userId));
    const fresh = {
      leftAt: null,
      joinedAt: new Date(),
      role: 'member' as const,
      pending: false,
      hiddenKey: null,
      lastReadKey: lock.nextKey - 1,
      archivedAt: null,
      pinnedAt: null,
    };
    const back = adding.filter((id) => known.has(id));
    if (back.length > 0) {
      await tx
        .update(conversationMembers)
        .set(fresh)
        .where(and(eq(conversationMembers.conversationId, conversationId), inArray(conversationMembers.userId, back)));
    }
    const added = adding.filter((id) => !known.has(id));
    if (added.length > 0) {
      await tx
        .insert(conversationMembers)
        .values(added.map((userId) => ({ conversationId, userId, role: 'member' as const, lastReadKey: lock.nextKey - 1 })));
    }
    const service: ConvGroupService = { kind: 'group', type: 'add', users: await brief(tx, adding) };
    const delivery = await insertService(tx, conversationId, lock.nextKey, me, service, [...active, ...adding]);
    return { kind: 'ok', conversationId, delivery };
  });
}

/**
 * Удалить участника (только владелец, `groupRules.canRemoveMember`) или выйти самому (`targetId === me`). Владелец
 * выходит — владение переходит самому раннему из оставшихся (`groupRules.nextOwner`).
 */
export async function removeGroupMember(me: string, conversationId: string, targetId: string): Promise<GroupOpResult> {
  return db.transaction(async (tx) => {
    const lock = await lockConversation(tx, conversationId);
    if (!lock || lock.kind !== 'group') return { kind: 'not-found' };
    const rows = (await membersOf(tx, conversationId)).filter((r) => !r.leftAt);
    const mine = rows.find((r) => r.userId === me);
    if (!mine) return { kind: 'not-found' };
    const target = rows.find((r) => r.userId === targetId);
    if (!target) return { kind: 'not-found' };
    const leaving = targetId === me;
    if (!leaving && !canRemoveMember(mine.role, me, targetId)) return { kind: 'forbidden' };
    await tx
      .update(conversationMembers)
      .set({ leftAt: new Date(), role: 'member', pinnedAt: null, archivedAt: null, unreadMarkedAt: null })
      .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, targetId)));
    // Его незаконченные загрузки кусками в этой беседе — тоже (ревью `bigfile1`, L1): строка участника остаётся (`left_at`),
    // каскад внешнего ключа не срабатывает.
    await dropUploadsOfMember(tx, conversationId, targetId);
    const rest = rows.filter((r) => r.userId !== targetId);
    if (target.role === 'owner') {
      const heir = nextOwner(rest.map((r) => ({ id: r.userId })), targetId);
      if (heir) {
        await tx
          .update(conversationMembers)
          .set({ role: 'owner' })
          .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, heir)));
      }
    }
    const service: ConvGroupService = leaving ? { kind: 'group', type: 'leave' } : { kind: 'group', type: 'remove', users: await brief(tx, [targetId]) };
    const audience = [...rest.map((r) => r.userId), targetId];
    const delivery = await insertService(tx, conversationId, lock.nextKey, me, service, audience);
    return { kind: 'ok', conversationId, delivery };
  });
}

/** Переименовать или сменить фото (любой участник). Тот же текст/фото — без записи. */
export async function updateGroupInfo(
  me: string,
  conversationId: string,
  patch: { title: string } | { avatarUrl: string },
): Promise<GroupOpResult | { kind: 'same' }> {
  return db.transaction(async (tx) => {
    const lock = await lockConversation(tx, conversationId);
    if (!lock || lock.kind !== 'group') return { kind: 'not-found' };
    const active = (await membersOf(tx, conversationId)).filter((r) => !r.leftAt).map((r) => r.userId);
    if (!active.includes(me)) return { kind: 'not-found' };
    const [cur] = await tx
      .select({ title: conversations.title, avatarUrl: conversations.avatarUrl })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if ('title' in patch && cur?.title === patch.title) return { kind: 'same' };
    await tx.update(conversations).set(patch).where(eq(conversations.id, conversationId));
    const service: ConvGroupService = 'title' in patch ? { kind: 'group', type: 'title', title: patch.title } : { kind: 'group', type: 'photo' };
    const delivery = await insertService(tx, conversationId, lock.nextKey, me, service, active);
    return { kind: 'ok', conversationId, delivery };
  });
}

/**
 * Остальные действующие участники группы, если `senderId` в ней (для «печатает», `gatewayTyping.ts`); не группа или
 * отправитель не участник — `null`.
 */
export async function groupPeersOf(conversationId: string, senderId: string): Promise<string[] | null> {
  const rows = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversations.kind, 'group'),
        isNull(conversationMembers.leftAt),
      ),
    );
  const ids = rows.map((r) => r.userId);
  return ids.includes(senderId) ? ids.filter((id) => id !== senderId) : null;
}
