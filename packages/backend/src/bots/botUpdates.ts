/**
 * События бота (#229) из записей бесед. `conversations.deliver`/`deliverMany` после фиксации зовут `recordBotUpdates` с теми
 * же `Delivery`, что уходят людям: у кого из получателей (`pts`) есть живой бот — тому событие в журнал:
 * - новое сообщение собеседника → `message`; правка текста (`Delivery.edited`) → `edited_message`;
 * - сообщение пропало у бота (удалено у обоих) → `message_deleted`;
 * - реакции, закрепы, прочтения — этап 1 боту не шлёт.
 * Своё (бот автор или действие сделал он сам через Bot API, `Delivery.actor`) боту не пишется. Только беседы 1:1.
 *
 * `my_chat_member` (человек открыл беседу / удалил её у себя) зовут маршруты бесед — `chatMemberUpdate`.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { BotChatStatus, Delivery } from '../conversations.js';
import { messagesFor } from '../conversations.js';
import { db } from '../db/index.js';
import { conversationMembers, conversationMessageReactions, conversations, users } from '../db/schema.js';
import { unixSeconds } from './botRules.js';
import { liveBotsAmong, pushUpdate, readBotSettings } from './botStore.js';
import { kickWebhook } from './webhookDelivery.js';
import { dmChat, toWireMessage, toWireUser } from './botWire.js';

export async function recordBotUpdates(ds: readonly Delivery[]): Promise<void> {
  const withMsg = ds.filter((d) => d.messageId);
  if (withMsg.length === 0) return;
  const bots = await liveBotsAmong([...new Set(withMsg.flatMap((d) => [...d.pts.keys()]))]);
  if (bots.size === 0) return;
  if (!(await readBotSettings()).enabled) return;
  const touched = new Set<string>();
  for (const d of withMsg) {
    const recipients = [...d.pts.keys()].filter((uid) => bots.has(uid) && uid !== d.actor);
    if (recipients.length === 0) continue;
    if (!(await isDirect(d.conversationId))) continue;
    for (const botId of recipients) {
      // Вторая линия решения A (26.10): приватному боту пишет только владелец — событий от остальных в журнал нет, даже если
      // сообщение прошло мимо гейта отправки (отложенное, ушедшее после смены «Доступен всем»). Собеседник — второй участник 1:1.
      const bot = bots.get(botId)!;
      if (!bot.public && !(await ownerOnlyChat(d.conversationId, botId, bot.ownerId))) continue;
      // Реакция (#231): человек поставил или снял реакцию на ЛЮБОЕ сообщение беседы с ботом → `message_reaction` с наборами
      // ЕГО реакций до и после. Реакции ботов боту не пишутся.
      if (d.reaction) {
        if (d.reaction.userId === botId) continue;
        const payload = await reactionPayload(d.conversationId, d.messageId!, d.reaction);
        if (!payload) continue;
        await pushUpdate(botId, 'message_reaction', payload);
        touched.add(botId);
        continue;
      }
      const view = (await messagesFor([d.messageId!], botId)).get(d.messageId!);
      if (!view) continue;
      if ('gone' in view) {
        await pushUpdate(botId, 'message_deleted', { message_id: view.id, chat: dmChat(view.conversationId), date: unixSeconds(Date.now()) });
        touched.add(botId);
        continue;
      }
      if (view.author.id === botId) continue;
      const type = d.created ? 'message' : d.edited ? 'edited_message' : null;
      if (!type) continue;
      await pushUpdate(botId, type, toWireMessage(view));
      touched.add(botId);
    }
  }
  for (const botId of touched) kickWebhook(botId);
}

async function reactionPayload(
  conversationId: string,
  messageId: string,
  r: { userId: string; emoji: string; op: 'add' | 'remove' },
): Promise<Record<string, unknown> | null> {
  const [who] = await db.select().from(users).where(eq(users.id, r.userId)).limit(1);
  if (!who || (who.bot && who.verified)) return null;
  const rows = await db
    .select({ emoji: conversationMessageReactions.emoji })
    .from(conversationMessageReactions)
    .where(and(eq(conversationMessageReactions.messageId, messageId), eq(conversationMessageReactions.userId, r.userId)))
    .orderBy(asc(conversationMessageReactions.createdAt));
  const now = rows.map((x) => x.emoji);
  const before = r.op === 'add' ? now.filter((e) => e !== r.emoji) : [...now, r.emoji];
  return {
    chat: dmChat(conversationId),
    message_id: messageId,
    user: toWireUser({ ...who, bot: false }),
    date: unixSeconds(Date.now()),
    old_reaction: before.map((emoji) => ({ type: 'emoji', emoji })),
    new_reaction: now.map((emoji) => ({ type: 'emoji', emoji })),
  };
}

/** Беседа 1:1 бота — с его владельцем (второй участник = `ownerId`). */
async function ownerOnlyChat(conversationId: string, botId: string, ownerId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId));
  const others = rows.map((r) => r.userId).filter((u) => u !== botId);
  return others.length > 0 && others.every((u) => u === ownerId);
}

async function isDirect(conversationId: string): Promise<boolean> {
  const [c] = await db.select({ kind: conversations.kind }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  return c?.kind === 'direct';
}

/**
 * Человек `humanId` открыл беседу с ботом (`member`), удалил её у себя (`left`) или заблокировал бота (`kicked`, аудит 26.10;
 * разблокировал — `kicked` → `member`, `old`). Не бот / выключен / боты выключены / приватный бот, а человек не владелец —
 * ничего. Сбой — только в лог: маршрут человека от журнала бота не зависит.
 */
export async function chatMemberUpdate(
  botId: string,
  humanId: string,
  conversationId: string,
  status: BotChatStatus,
  old?: BotChatStatus,
): Promise<void> {
  try {
    const live = await liveBotsAmong([botId]);
    const bot = live.get(botId);
    if (!bot || !(await readBotSettings()).enabled) return;
    if (!bot.public && humanId !== bot.ownerId) return;
    const [human] = await db.select().from(users).where(eq(users.id, humanId)).limit(1);
    if (!human) return;
    await pushUpdate(botId, 'my_chat_member', {
      chat: dmChat(conversationId),
      from: toWireUser({ ...human, bot: false }),
      date: unixSeconds(Date.now()),
      old_status: old ?? (status === 'member' ? 'left' : 'member'),
      new_status: status,
    });
    kickWebhook(botId);
  } catch (err) {
    console.warn('[bots] my_chat_member:', err instanceof Error ? err.message : err);
  }
}
