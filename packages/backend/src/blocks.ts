import { and, eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { userBlocks } from './db/schema.js';

/**
 * Чёрный список: запросы и кеш (#212). Правила — `blockRules.ts`.
 *
 * Кеш в памяти процесса: «печатает» и реакции спрашивают про блокировку часто, а список меняется
 * редко и только через этот же модуль. Бэкенд у нас один процесс; если их станет несколько, кеш надо
 * будет сбрасывать событием — иначе второй процесс продолжит пропускать заблокированного.
 */
const cache = new Map<string, Set<string>>();

async function blockedSet(blockerId: string): Promise<Set<string>> {
  const hit = cache.get(blockerId);
  if (hit) return hit;
  const rows = await db
    .select({ id: userBlocks.blockedId })
    .from(userBlocks)
    .where(eq(userBlocks.blockerId, blockerId));
  const set = new Set(rows.map((r) => r.id));
  if (cache.size > 10_000) cache.clear(); // грубый потолок
  cache.set(blockerId, set);
  return set;
}

/** `blocker` заблокировал `blocked`? */
export async function isBlockedBy(blockerId: string, blockedId: string): Promise<boolean> {
  return (await blockedSet(blockerId)).has(blockedId);
}

/** Кого заблокировал человек — id. */
export async function blockedBy(blockerId: string): Promise<Set<string>> {
  return blockedSet(blockerId);
}

export async function blockUser(blockerId: string, blockedId: string): Promise<void> {
  await db.insert(userBlocks).values({ blockerId, blockedId }).onConflictDoNothing();
  cache.delete(blockerId);
}

export async function unblockUser(blockerId: string, blockedId: string): Promise<void> {
  await db
    .delete(userBlocks)
    .where(and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId)));
  cache.delete(blockerId);
}

/** Для тестов: сбросить кеш после записи в базу мимо модуля. */
export function resetBlockCacheForTests(): void {
  cache.clear();
}
