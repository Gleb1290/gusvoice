import {
  pushStickerId,
  STICKERS_FAVED_MAX,
  STICKERS_RECENT_MAX,
  type Sticker,
  type StickerLists,
} from '@gusvoice/shared';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { stickerPacks, stickers, userFavedStickers, userRecentStickers } from './db/schema.js';
import { publishToUser } from './realtime.js';

/**
 * Избранные и недавние стикеры человека на сервере (С2 порция 2, #211, признак `stickers3`; миграция 0100) — как у Telegram:
 * избранные (tdesktop `Data::Stickers::FavedSetId`, лимит `stickers_faved_limit_default` = 5, лишний старый уходит —
 * `Stickers::checkFavedLimit`) и недавние (`RecentSetId`, на ПК видно 20) общие для всех устройств. Только стикеры каталога:
 * ими и отправляют в ЛС (`catalogSticker`). Ручки — `routes/stickers.ts`.
 */

const stickerCols = { id: stickers.id, emoji: stickers.emoji, url: stickers.url, format: stickers.format };

/**
 * Стикер каталога для списка: по id, а если это стикер набора сервера (пришёл пересылкой из канала) или его строки уже нет —
 * каталожная копия с той же картинкой (`url`).
 */
export async function catalogStickerFor(id: string, url: string | null): Promise<Sticker | null> {
  const [byId] = await db
    .select(stickerCols)
    .from(stickers)
    .innerJoin(stickerPacks, eq(stickers.packId, stickerPacks.id))
    .where(and(eq(stickers.id, id), isNull(stickerPacks.serverId)))
    .limit(1);
  if (byId) return byId;
  if (!url) return null;
  const [byUrl] = await db
    .select(stickerCols)
    .from(stickers)
    .innerJoin(stickerPacks, eq(stickers.packId, stickerPacks.id))
    .where(and(eq(stickers.url, url), isNull(stickerPacks.serverId)))
    .limit(1);
  return byUrl ?? null;
}

/** Выполнитель запросов: сама база или транзакция (`db.transaction(async (tx) => …)`). */
type Exec = Pick<typeof db, 'select' | 'insert' | 'delete' | 'execute'>;

/**
 * Один писатель на человека: пока идёт транзакция одного устройства, второго ждёт. Без этого два `setFaved` / `pushRecent`
 * с разных устройств оба читали список, оба считали «вытеснять нечего» и вместе переполняли предел (TG: 5 избранных / 20
 * недавних). Консультативная блокировка, а не `FOR UPDATE` по строкам: новую строку-вставку `FOR UPDATE` не удержит. Снимается
 * сама в конце транзакции.
 */
async function lockLists(tx: Exec, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sticker-lists:${userId}`}))`);
}

async function favedRows(userId: string, ex: Exec = db): Promise<Sticker[]> {
  return ex
    .select(stickerCols)
    .from(userFavedStickers)
    .innerJoin(stickers, eq(userFavedStickers.stickerId, stickers.id))
    .where(eq(userFavedStickers.userId, userId))
    .orderBy(desc(userFavedStickers.addedAt));
}

/** `limit` для чтения — «на экране» (`STICKERS_RECENT_MAX`); при записи берём ВСЕ строки, чтобы лишние (от прежней гонки) тоже ушли. */
async function recentRows(userId: string, ex: Exec = db, limit = STICKERS_RECENT_MAX): Promise<Sticker[]> {
  return ex
    .select(stickerCols)
    .from(userRecentStickers)
    .innerJoin(stickers, eq(userRecentStickers.stickerId, stickers.id))
    .where(eq(userRecentStickers.userId, userId))
    .orderBy(desc(userRecentStickers.usedAt))
    .limit(limit);
}

export async function stickerListsOf(userId: string): Promise<StickerLists> {
  const [faved, recent] = await Promise.all([favedRows(userId), recentRows(userId)]);
  return { faved, recent, favedLimit: STICKERS_FAVED_MAX };
}

/** В избранное (первым; шестой вытесняет самый старый) или из избранного. */
export async function setFaved(userId: string, stickerId: string, on: boolean): Promise<void> {
  if (!on) {
    await db.delete(userFavedStickers).where(and(eq(userFavedStickers.userId, userId), eq(userFavedStickers.stickerId, stickerId)));
    return;
  }
  await db.transaction(async (tx) => {
    await lockLists(tx, userId);
    // Читаем ПОД блокировкой: список, по которому решаем, кого вытеснить, не может измениться до конца транзакции.
    const have = (await favedRows(userId, tx)).map((s) => s.id);
    const { dropped } = pushStickerId(have, stickerId, STICKERS_FAVED_MAX);
    await tx
      .insert(userFavedStickers)
      .values({ userId, stickerId, addedAt: new Date() })
      .onConflictDoUpdate({ target: [userFavedStickers.userId, userFavedStickers.stickerId], set: { addedAt: new Date() } });
    if (dropped.length)
      await tx.delete(userFavedStickers).where(and(eq(userFavedStickers.userId, userId), inArray(userFavedStickers.stickerId, dropped)));
  });
}

/** Стикер отправлен — первым в недавние; хвост за `STICKERS_RECENT_MAX` стирается. */
export async function pushRecent(userId: string, stickerId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockLists(tx, userId);
    const have = (await recentRows(userId, tx, 100_000)).map((s) => s.id);
    const { dropped } = pushStickerId(have, stickerId, STICKERS_RECENT_MAX);
    await tx
      .insert(userRecentStickers)
      .values({ userId, stickerId, usedAt: new Date() })
      .onConflictDoUpdate({ target: [userRecentStickers.userId, userRecentStickers.stickerId], set: { usedAt: new Date() } });
    if (dropped.length)
      await tx.delete(userRecentStickers).where(and(eq(userRecentStickers.userId, userId), inArray(userRecentStickers.stickerId, dropped)));
  });
}

export async function clearRecent(userId: string): Promise<void> {
  await db.delete(userRecentStickers).where(eq(userRecentStickers.userId, userId));
}

/** Списки целиком — моим устройствам (`stickers.update`); ошибка доставки не роняет ответ. */
export async function publishStickerLists(userId: string, lists: StickerLists): Promise<void> {
  await publishToUser(userId, { t: 'stickers.update', lists }).catch(() => {});
}

/** «Мои наборы» поменялись — устройства перечитают `GET /api/stickers/mine`. */
export async function publishMineChanged(userId: string): Promise<void> {
  await publishToUser(userId, { t: 'stickers.update', mine: true }).catch(() => {});
}
