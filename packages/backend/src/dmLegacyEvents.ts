import { CAP_CONV1 } from '@gusvoice/shared';
import type { DmChannel, Message } from '@gusvoice/shared';
import { eq } from 'drizzle-orm';
import { reachesPeer } from './blockRules.js';
import {
  conversationRows,
  legacyMessageFor,
  messagesFor,
  messageTimeByKey,
  toLegacyMessage,
  unreadCounts,
} from './conversations.js';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { publishToUser } from './realtime.js';

/**
 * Старые события ЛС (`dm.*`, `read.dm`) — соединениям БЕЗ `caps: ['conv1']`: десктопам и APK 0.8.x, которые вшивают фронт
 * и живут у людей неделями (`docs/dm/STAGE1.md`, «Возможности клиента и совместимость»; правило 11 CLAUDE.md).
 *
 * 🔴 Зовут ОБЕ ручки — и старые `/api/dm*`, и новые `/api/conv/*` — после каждого изменения, рядом с `deliver`
 * (`conv.change` соединениям с `conv1`). До 30.09 рассылали только старые ручки: пока новым путём ходил один человек,
 * это не было видно, а с включением бесед всем сообщение из веба не доходило бы вживую до собеседника на десктопе
 * 0.8.17, «удалить у обоих» оставляло бы удалённое у него на экране, а «прочитано» не гасило счётчик на своём же
 * телефоне (проверка перед включением, 30.09).
 */

export const OLD_CLIENTS = { notCap: CAP_CONV1 } as const;

type UserRow = typeof users.$inferSelect;

export function pickLegacyUser(u: Pick<UserRow, 'id' | 'username' | 'displayName' | 'avatarUrl'>): DmChannel['otherUser'] {
  return { id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl };
}

/**
 * Новое сообщение. Получателю (если план доставки его уведомляет — заблокировавшему автора нет) — беседа
 * (`dm.channel`: появиться или подняться в списке) и само сообщение его глазами; себе — моё сообщение.
 * `mine` — уже посчитанный ответ старой ручки (чтобы не читать второй раз).
 */
export async function publishLegacySend(
  me: string,
  peerId: string | null,
  conversationId: string,
  row: { id: string; createdAt: Date },
  notifyRecipient: boolean,
  mine?: Message | null,
): Promise<void> {
  const own = mine ?? (await legacyMessageFor(row.id, me));
  if (notifyRecipient && peerId) {
    const [author] = await db.select().from(users).where(eq(users.id, me)).limit(1);
    const theirs = await legacyMessageFor(row.id, peerId);
    if (author) {
      const conv = (await conversationRows([conversationId])).get(conversationId);
      const channel: DmChannel = {
        id: conversationId,
        otherUser: pickLegacyUser(author),
        createdAt: (conv?.createdAt ?? row.createdAt).toISOString(),
        lastMessageAt: row.createdAt.toISOString(),
      };
      await publishToUser(peerId, { t: 'dm.channel', channel }, OLD_CLIENTS);
    }
    if (theirs) await publishToUser(peerId, { t: 'dm.create', channelId: conversationId, message: theirs }, OLD_CLIENTS);
  }
  if (own) await publishToUser(me, { t: 'dm.create', channelId: conversationId, message: own }, OLD_CLIENTS);
}

/** Сообщения глазами человека в старом DTO, по порядку `ids`; невидимые ему выпадают. */
async function legacyMessagesFor(ids: readonly string[], viewerId: string): Promise<Message[]> {
  const views = await messagesFor(ids, viewerId);
  return ids.flatMap((id) => {
    const v = views.get(id);
    return v && !('gone' in v) ? [toLegacyMessage(v)] : [];
  });
}

/**
 * Пачка новых сообщений (пересылка, `conv5`) — как `publishLegacySend` на каждое, но беседа (`dm.channel`) получателю —
 * ОДИН раз, с временем последнего, а сообщения — `dm.create` по порядку. Старый клиент звенит на каждое `dm.create`
 * (троттлинга у 0.8.x нет) — это цена живой доставки: без событий он увидел бы пачку только после перезахода в беседу.
 */
export async function publishLegacySendMany(
  me: string,
  peerId: string | null,
  conversationId: string,
  rows: readonly { id: string; createdAt: Date }[],
  notifyRecipient: boolean,
): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  if (notifyRecipient && peerId) {
    const [author] = await db.select().from(users).where(eq(users.id, me)).limit(1);
    if (author) {
      const conv = (await conversationRows([conversationId])).get(conversationId);
      const last = rows[rows.length - 1];
      const channel: DmChannel = {
        id: conversationId,
        otherUser: pickLegacyUser(author),
        createdAt: (conv?.createdAt ?? last.createdAt).toISOString(),
        lastMessageAt: last.createdAt.toISOString(),
      };
      await publishToUser(peerId, { t: 'dm.channel', channel }, OLD_CLIENTS);
    }
    for (const m of await legacyMessagesFor(ids, peerId)) {
      await publishToUser(peerId, { t: 'dm.create', channelId: conversationId, message: m }, OLD_CLIENTS);
    }
  }
  for (const m of await legacyMessagesFor(ids, me)) {
    await publishToUser(me, { t: 'dm.create', channelId: conversationId, message: m }, OLD_CLIENTS);
  }
}

/**
 * Пачка удалений (`conv5`) — как `publishLegacyDelete` на каждое изменённое сообщение по порядку; время беседы и
 * непрочитанное считаются один раз (после всей пачки — одинаковы для каждого события). Себе `unread` — у событий о
 * чужих сообщениях (С1, `own: false`): только они меняют моё непрочитанное.
 */
export async function publishLegacyDeleteMany(
  me: string,
  peerId: string | null,
  conversationId: string,
  scope: 'me' | 'both',
  changed: readonly { messageId: string; withheld: boolean; own?: boolean }[],
  lastMessageAt: string | null,
): Promise<void> {
  if (changed.length === 0) return;
  if (scope === 'me') {
    const unread = (await unreadCounts(me, [conversationId])).get(conversationId) ?? 0;
    for (const c of changed) {
      await publishToUser(me, { t: 'dm.delete', channelId: conversationId, messageId: c.messageId, unread }, OLD_CLIENTS);
    }
    return;
  }
  // Придержанное собеседник не видел — удаление до него не доходит.
  const toPeer = peerId ? changed.filter((c) => !c.withheld) : [];
  if (peerId && toPeer.length > 0) {
    const unread = (await unreadCounts(peerId, [conversationId])).get(conversationId) ?? 0;
    for (const c of toPeer) {
      await publishToUser(
        peerId,
        { t: 'dm.delete', channelId: conversationId, messageId: c.messageId, lastMessageAt, unread },
        OLD_CLIENTS,
      );
    }
  }
  const myUnread = changed.some((c) => c.own === false)
    ? ((await unreadCounts(me, [conversationId])).get(conversationId) ?? 0)
    : undefined;
  for (const c of changed) {
    await publishToUser(
      me,
      {
        t: 'dm.delete',
        channelId: conversationId,
        messageId: c.messageId,
        lastMessageAt,
        ...(c.own === false && myUnread !== undefined ? { unread: myUnread } : {}),
      },
      OLD_CLIENTS,
    );
  }
}

/**
 * Правка. Придержанное собеседник не видел — и правка до него не доходит. Уже доставленное правится у обоих даже при
 * блокировке: новый текст он всё равно увидит после перезагрузки (`blockRules.reachesPeer`).
 */
export async function publishLegacyEdit(
  me: string,
  peerId: string | null,
  conversationId: string,
  messageId: string,
  withheld: boolean,
  mine?: Message | null,
): Promise<void> {
  if (!withheld && peerId) {
    const theirs = await legacyMessageFor(messageId, peerId);
    if (theirs) await publishToUser(peerId, { t: 'dm.update', channelId: conversationId, message: theirs }, OLD_CLIENTS);
  }
  const own = mine ?? (await legacyMessageFor(messageId, me));
  if (own) await publishToUser(me, { t: 'dm.update', channelId: conversationId, message: own }, OLD_CLIENTS);
}

/**
 * Удаление. `me` — только своим устройствам (собеседник не узнаёт) с моим новым непрочитанным; `both` — собеседнику
 * (кроме придержанного: он его не видел) с новым временем беседы и ЕГО непрочитанным, себе — с новым временем, а если
 * удалено ЧУЖОЕ (С1, `own: false`) — и с моим непрочитанным: чужое могло в нём числиться.
 * Без времени удалённое последнее держало беседу наверху списка; без непрочитанного у собеседника оставалась «1».
 */
export async function publishLegacyDelete(
  me: string,
  peerId: string | null,
  conversationId: string,
  messageId: string,
  scope: 'me' | 'both',
  res: { withheld: boolean; lastMessageAt: string | null; own?: boolean },
): Promise<void> {
  if (scope === 'me') {
    const unread = (await unreadCounts(me, [conversationId])).get(conversationId) ?? 0;
    await publishToUser(me, { t: 'dm.delete', channelId: conversationId, messageId, unread }, OLD_CLIENTS);
    return;
  }
  if (!res.withheld && peerId) {
    const unread = (await unreadCounts(peerId, [conversationId])).get(conversationId) ?? 0;
    await publishToUser(
      peerId,
      { t: 'dm.delete', channelId: conversationId, messageId, lastMessageAt: res.lastMessageAt, unread },
      OLD_CLIENTS,
    );
  }
  const mine = res.own === false ? { unread: (await unreadCounts(me, [conversationId])).get(conversationId) ?? 0 } : {};
  await publishToUser(
    me,
    { t: 'dm.delete', channelId: conversationId, messageId, lastMessageAt: res.lastMessageAt, ...mine },
    OLD_CLIENTS,
  );
}

/** Реакция: заблокировавший меня собеседник её не видит ни сейчас, ни в истории. */
export async function publishLegacyReaction(
  me: string,
  peerId: string | null,
  conversationId: string,
  messageId: string,
  emoji: string,
  op: 'add' | 'remove',
  peerBlockedMe: boolean,
): Promise<void> {
  const event = { t: 'dm.reaction' as const, channelId: conversationId, messageId, emoji, userId: me, op };
  if (peerId && reachesPeer(peerBlockedMe)) await publishToUser(peerId, event, OLD_CLIENTS);
  await publishToUser(me, event, OLD_CLIENTS);
}

/**
 * «Прочитано» — своим старым соединениям: `at` = время сообщения, до которого прочитано (нет ключа — сейчас).
 * 🔴 Только МНЕ, собеседнику — никогда (Р6): старый клиент применяет `read.dm` как своё «прочитано» с другого устройства
 * и погасил бы собственное непрочитанное. ✓✓ собеседник получает сводкой в `conv.change` (`conversations.markRead`).
 */
export async function publishLegacyRead(me: string, conversationId: string, lastReadKey: number | null): Promise<void> {
  const at = (lastReadKey !== null ? await messageTimeByKey(conversationId, lastReadKey) : null) ?? new Date();
  await publishToUser(me, { t: 'read.dm', dmId: conversationId, at: at.toISOString() }, OLD_CLIENTS);
}
