/**
 * Удаление ботов (#229): владельцем или админом (`routes/bots.ts`) и вместе с аккаунтом владельца (`accountDelete.ts`).
 * Бот удаляется как аккаунт: строка `users` обезличена (`anonymizeAccount`), беседы с ним остаются; токен непригоден, адрес
 * доставки и журнал сняты, его WS закрыты. Запись `bots` остаётся (по ней видно, что это был бот, а не вебхук).
 */
import { DELETED_BOT_NAME } from '@gusvoice/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { anonymizeAccount } from '../accountDelete.js';
import { db } from '../db/index.js';
import { bots, users } from '../db/schema.js';
import { closeBotSockets } from '../routes/botApi.js';
import { deadTokenHash } from './botRules.js';
import { dropUpdates } from './botStore.js';
import { resetWebhookRetry } from './webhookDelivery.js';

export async function deleteBot(botId: string): Promise<void> {
  await db
    .update(bots)
    .set({ tokenHash: deadTokenHash(), webhookUrl: null, webhookSecret: null, webhookDisabledAt: null, webhookFailures: 0, webhookLastError: null })
    .where(eq(bots.userId, botId));
  resetWebhookRetry(botId);
  closeBotSockets(botId, 4001, 'bot deleted');
  // Этап 4 (#232): вон из голосовых комнат (лениво — модуль голоса тянет LiveKit; добьёт страховочный обход).
  await import('./botVoice.js').then((m) => m.dropBotVoice(botId), () => undefined);
  await dropUpdates(botId);
  // Имя в беседах — «Удалённый бот» (26.10), а не «Удалённый пользователь».
  await anonymizeAccount(botId, { displayName: DELETED_BOT_NAME, bot: true });
}

/** Владелец удалил аккаунт — его боты уходят следом (иначе остались бы ничьими, с живыми токенами). Число удалённых. */
export async function deleteBotsOwnedBy(ownerId: string): Promise<number> {
  const rows = await db
    .select({ id: bots.userId })
    .from(bots)
    .innerJoin(users, eq(users.id, bots.userId))
    .where(and(eq(bots.ownerId, ownerId), isNull(users.deletedAt)));
  for (const r of rows) await deleteBot(r.id);
  return rows.length;
}
