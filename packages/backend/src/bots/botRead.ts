/**
 * Бот забрал события (#229, владелец 26.10: «прочитано» — как в Telegram, при получении, а не при ответе) → его
 * «прочитано до» в беседах сдвигается тем же путём, что у человека (`markRead` + `deliver`): у собеседника загораются ✓✓
 * по WS. Кто зовёт: `getUpdates` (отданная пачка), WS `ack`/`?offset` (подтверждённые строки журнала), доставка на адрес
 * (ответ 2xx; копит пачку и отмечает при выходе из цикла). Одна отметка на беседу за пачку — по самому позднему сообщению.
 * Сбой — только в лог: выдача событий от отметки не зависит.
 */
import { and, eq, inArray, max } from 'drizzle-orm';
import { deliver, loadAccess, markRead } from '../conversations.js';
import { db } from '../db/index.js';
import { conversationMessages } from '../db/schema.js';
import { readMarksOf } from './botRules.js';

export async function markTakenRead(botId: string, rows: readonly { type: string; payload: unknown }[]): Promise<void> {
  const marks = readMarksOf(rows);
  for (const [conversationId, ids] of marks) {
    try {
      const access = await loadAccess(conversationId, botId);
      if (!access || access.kind !== 'direct' || access.saved || !access.peerId) continue;
      const [top] = await db
        .select({ key: max(conversationMessages.sortKey) })
        .from(conversationMessages)
        .where(and(eq(conversationMessages.conversationId, conversationId), inArray(conversationMessages.id, ids)));
      const key = top?.key == null ? null : Number(top.key);
      if (key === null || !Number.isFinite(key)) continue; // сообщения уже удалены — отмечать нечего
      const read = await markRead(botId, access, key);
      if (read.kind === 'ok' && read.delivery) await deliver({ ...read.delivery, actor: botId });
    } catch (err) {
      console.warn('[bots] прочитано:', err instanceof Error ? err.message : err);
    }
  }
}
