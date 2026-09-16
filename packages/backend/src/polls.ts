import type { Poll } from '@gusvoice/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db/index.js';
import { pollVotes, polls } from './db/schema.js';
import { checkVote, pollClosed, resultsVisible, tally } from './pollRules.js';

export { pollClosed } from './pollRules.js';

/**
 * Опросы (#17): сбор результатов и голосование.
 *
 * Считаем в приложении, а не в SQL с группировкой, по одной причине: вариантов у опроса единицы,
 * а голосов — десятки, и лишний круг к базе на каждый вариант дороже, чем пройтись по списку.
 * Зато голоса лежат отдельными строками, поэтому одновременное голосование не теряется — в отличие
 * от счётчика в jsonb, где два голоса в одну секунду затирали бы друг друга.
 */

/**
 * Собрать опросы для пачки сообщений разом.
 *
 * Именно пачкой: список сообщений грузится по 50, и запрос на каждое превратил бы открытие канала
 * в полсотни round-trip'ов. Ровно так же сделано для реакций.
 */
export async function pollsFor(messageIds: string[], viewerId: string): Promise<Map<string, Poll>> {
  const out = new Map<string, Poll>();
  if (messageIds.length === 0) return out;

  const rows = await db.select().from(polls).where(inArray(polls.messageId, messageIds));
  if (rows.length === 0) return out;

  const ids = rows.map((r) => r.messageId);
  const votes = await db.select().from(pollVotes).where(inArray(pollVotes.messageId, ids));

  for (const p of rows) {
    const forThis = votes.filter((v) => v.messageId === p.messageId);
    out.set(p.messageId, tally(p, forThis, viewerId));
  }
  return out;
}

export type VoteResult =
  | { ok: true; poll: Poll; voterIds: string[] }
  | { ok: false; error: string; code: 400 | 403 | 404 };

/**
 * Отдать голос. Первый и единственный: переголосовать нельзя (см. `checkVote`).
 *
 * Возвращает ещё и список тех, кто уже голосовал, — им можно адресно разослать свежие счётчики,
 * не раскрывая их остальным.
 */
export async function vote(messageId: string, userId: string, optionIds: string[]): Promise<VoteResult> {
  const [p] = await db.select().from(polls).where(eq(polls.messageId, messageId)).limit(1);
  if (!p) return { ok: false, error: 'опрос не найден', code: 404 };

  const before = await db.select().from(pollVotes).where(eq(pollVotes.messageId, messageId));
  const mineBefore = before.filter((v) => v.userId === userId);

  const check = checkVote(p, mineBefore.length > 0, optionIds);
  if (!check.ok) return { ok: false, error: check.error, code: pollClosed(p.closesAt) ? 403 : 400 };

  await db
    .insert(pollVotes)
    .values(optionIds.map((optionId) => ({ messageId, userId, optionId })))
    .onConflictDoNothing();

  const fresh = await pollsFor([messageId], userId);
  const poll = fresh.get(messageId);
  if (!poll) return { ok: false, error: 'опрос исчез', code: 404 };
  const voterIds = [...new Set([...before.map((v) => v.userId), userId])];
  return { ok: true, poll, voterIds };
}

export type VotersResult =
  | { ok: true; voters: { optionId: string; userIds: string[] }[] }
  | { ok: false; error: string; code: 403 | 404 };

/**
 * Кто за что проголосовал — только для ПУБЛИЧНОГО опроса и только тому, кому результаты уже
 * открыты. Проверяем оба условия здесь: клиент, который решит не рисовать кнопку, — не защита.
 */
export async function votersOf(messageId: string, viewerId: string): Promise<VotersResult> {
  const [p] = await db.select().from(polls).where(eq(polls.messageId, messageId)).limit(1);
  if (!p) return { ok: false, error: 'опрос не найден', code: 404 };
  if (p.anonymous) return { ok: false, error: 'опрос анонимный', code: 403 };

  const votes = await db.select().from(pollVotes).where(eq(pollVotes.messageId, messageId));
  const voted = votes.some((v) => v.userId === viewerId);
  if (!resultsVisible(voted, pollClosed(p.closesAt)))
    return { ok: false, error: 'сначала проголосуйте', code: 403 };

  return {
    ok: true,
    voters: p.options.map((o) => ({
      optionId: o.id,
      userIds: votes.filter((v) => v.optionId === o.id).map((v) => v.userId),
    })),
  };
}
