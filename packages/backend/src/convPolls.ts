import { checkConvPollVote, type ConvPollMedia } from '@gusvoice/shared';
import { and, asc, eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { conversationMessages, convPollVotes, users } from './db/schema.js';
import { fedRecordPollVote, journal, lockMessage, msgEntries, type ConvAccess, type Delivery } from './conversations.js';
import { changeAudience, messageView } from './convRules.js';

/**
 * Опрос в ЛС (14.10, признак `convpoll1`): голос, отмена голоса, остановка автором и «кто голосовал». Правила — чистые
 * `shared/convPoll.ts` (`checkConvPollVote`, `convPollView`); здесь — то, что ходит в базу. Как у Telegram: Android
 * `SendMessagesHelper.sendVote` / `MessagesController` (`messages.sendVote` с пустым списком — отмена), `StopPoll`
 * (`messages.editMessage` с `poll.closed`), `PollVotesAlert` (`messages.getPollVotes`).
 *
 * Любое изменение итогов — строка журнала о сообщении ВСЕМ участникам (как правка): каждый получает `conv.change` с видом опроса
 * своими глазами (итоги — только проголосовавшим), догонка `/api/conv/sync` отдаёт то же. Голоса заблокированных не прячутся:
 * итог опроса общий.
 */

export type ConvPollActResult =
  | { kind: 'ok'; delivery: Delivery | null }
  | { kind: 'not-found' }
  | { kind: 'refused'; code: 400 | 403; error: string };

/** Сообщение-опрос беседы под замком, видимое мне; иначе `null` (404). */
async function lockPoll(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  me: string,
  access: ConvAccess,
  messageId: string,
): Promise<{ poll: ConvPollMedia; authorId: string; withheld: boolean } | null> {
  const m = await lockMessage(tx, access.conversationId, messageId);
  if (!m || messageView(m, me) !== 'full' || m.media?.kind !== 'poll') return null;
  return { poll: m.media, authorId: m.authorId, withheld: m.withheld };
}

/**
 * Журнал «сообщение изменилось» — всем участникам (придержанное — только автору действия, как правка). Соседям (`dmpoll1`): голос —
 * строкой `pollvote` (`fedRecordPollVote`), а не `msg` (`fed: false`); остановка — строкой `msg` (как правка: копия закрывается).
 */
async function journalPoll(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  me: string,
  access: ConvAccess,
  messageId: string,
  withheld: boolean,
  vote = false,
): Promise<Delivery> {
  const audience = changeAudience({ action: 'edit', actorId: me, memberIds: access.memberIds, withheld, blockedActor: new Set() });
  const pts = await journal(tx, msgEntries(audience, access.conversationId, messageId), vote ? { fed: false } : {});
  if (vote) await fedRecordPollVote(tx, access.conversationId, messageId);
  return { conversationId: access.conversationId, messageId, pts };
}

/**
 * Голос (`optionIds` — отмеченные варианты) или его отмена (пустой список). Повторный голос без отмены, голос в закрытом и
 * отмена ответа викторины — отказ (`checkConvPollVote`).
 */
export async function voteConvPoll(me: string, access: ConvAccess, messageId: string, optionIds: readonly string[]): Promise<ConvPollActResult> {
  return db.transaction(async (tx): Promise<ConvPollActResult> => {
    const p = await lockPoll(tx, me, access, messageId);
    if (!p) return { kind: 'not-found' };
    const mine = (
      await tx
        .select({ optionId: convPollVotes.optionId })
        .from(convPollVotes)
        .where(and(eq(convPollVotes.messageId, messageId), eq(convPollVotes.userId, me)))
    ).map((r) => r.optionId);
    const check = checkConvPollVote(p.poll, mine, optionIds);
    if (!check.ok) return { kind: 'refused', code: check.code, error: check.error };
    if (optionIds.length === 0) {
      await tx.delete(convPollVotes).where(and(eq(convPollVotes.messageId, messageId), eq(convPollVotes.userId, me)));
    } else {
      await tx
        .insert(convPollVotes)
        .values(optionIds.map((optionId) => ({ messageId, userId: me, optionId })))
        .onConflictDoNothing();
    }
    return { kind: 'ok', delivery: await journalPoll(tx, me, access, messageId, p.withheld, true) };
  });
}

/** «Остановить опрос» — только автор, навсегда; повтор — успех без события. */
export async function closeConvPoll(me: string, access: ConvAccess, messageId: string): Promise<ConvPollActResult> {
  return db.transaction(async (tx): Promise<ConvPollActResult> => {
    const p = await lockPoll(tx, me, access, messageId);
    if (!p) return { kind: 'not-found' };
    if (p.authorId !== me) return { kind: 'refused', code: 403, error: 'остановить опрос может только автор' };
    if (p.poll.closed) return { kind: 'ok', delivery: null };
    await tx
      .update(conversationMessages)
      .set({ media: { ...p.poll, closed: true } })
      .where(eq(conversationMessages.id, messageId));
    return { kind: 'ok', delivery: await journalPoll(tx, me, access, messageId, p.withheld) };
  });
}

export interface ConvPollVoter {
  id: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
}

export type ConvPollVotersResult =
  | { kind: 'ok'; options: { optionId: string; voters: ConvPollVoter[] }[] }
  | { kind: 'not-found' }
  | { kind: 'refused'; code: 403; error: string };

/**
 * «Посмотреть голоса» (Telegram `PollVotesAlert`): кто за что, по порядку голосования. Только неанонимный и только тому, кому
 * итоги открыты (проголосовал или опрос остановлен) — проверка здесь, не в клиенте.
 */
export async function convPollVoters(me: string, access: ConvAccess, messageId: string): Promise<ConvPollVotersResult> {
  const [m] = await db
    .select()
    .from(conversationMessages)
    .where(and(eq(conversationMessages.id, messageId), eq(conversationMessages.conversationId, access.conversationId)))
    .limit(1);
  if (!m || messageView(m, me) !== 'full' || m.media?.kind !== 'poll') return { kind: 'not-found' };
  const poll = m.media;
  if (poll.anonymous) return { kind: 'refused', code: 403, error: 'опрос анонимный' };
  const rows = await db
    .select({ optionId: convPollVotes.optionId, id: users.id, displayName: users.displayName, username: users.username, homeUsername: users.homeUsername, avatarUrl: users.avatarUrl })
    .from(convPollVotes)
    .innerJoin(users, eq(users.id, convPollVotes.userId))
    .where(eq(convPollVotes.messageId, messageId))
    .orderBy(asc(convPollVotes.createdAt), asc(convPollVotes.userId));
  if (!poll.closed && !rows.some((r) => r.id === me)) return { kind: 'refused', code: 403, error: 'сначала проголосуйте' };
  return {
    kind: 'ok',
    options: poll.options.map((o) => ({
      optionId: o.id,
      voters: rows
        .filter((r) => r.optionId === o.id)
        .map((r) => ({ id: r.id, displayName: r.displayName, username: r.homeUsername || r.username, avatarUrl: r.avatarUrl ?? null })),
    })),
  };
}
