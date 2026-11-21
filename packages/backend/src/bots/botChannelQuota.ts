import { and, eq, gte, sql } from 'drizzle-orm';
import { DM_DAILY_UPLOAD_BYTES } from '../attachmentRules.js';
import { db } from '../db/index.js';
import { botChannelUploadReservations as reservations } from '../db/schema.js';

/** Одно окно на все каналы бота. Успешную резервацию списываем до любых записей в MinIO. */
export async function reserveBotChannelUpload(botId: string, messageId: string, bytes: number): Promise<boolean> {
  if (bytes === 0) return true;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`bot-channel-upload:${botId}`}))`);
    const [used] = await tx.select({ bytes: sql<string>`coalesce(sum(${reservations.bytes}), 0)` })
      .from(reservations)
      .where(and(eq(reservations.botId, botId), gte(reservations.reservedAt, sql`statement_timestamp() - interval '24 hours'`)));
    if (Number(used.bytes) + bytes > DM_DAILY_UPLOAD_BYTES) return false;
    // Списывается весь принятый пакет, даже если часть записей в хранилище либо их удаление не подтвердились.
    await tx.insert(reservations).values({ id: messageId, botId, bytes });
    return true;
  }, { isolationLevel: 'read committed' });
}
