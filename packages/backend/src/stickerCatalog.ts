import {
  checkPackImport,
  STICKER_MIME,
  type MessageSticker,
  type Sticker,
  type StickerCatalogPack,
  type StickerFormat,
} from '@gusvoice/shared';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { stickerPacks, stickers, userStickerPacks } from './db/schema.js';
import { putMedia } from './storage.js';
import { downloadSticker, getStickerSet, TelegramError } from './telegram.js';
import { id } from './util.js';

/**
 * Общий каталог стикеров инстанса и «мои наборы» (С2, #211, миграция 0092, признак `stickers2`).
 *
 * Каталог — строки `sticker_packs` без сервера. Наборы серверов живут как раньше; у каждого имени Telegram в каталоге
 * одна копия, и её строки `stickers` ссылаются на ТЕ ЖЕ файлы в бакете: второй раз ничего не качается.
 */

export type PackRow = typeof stickerPacks.$inferSelect;
/** Строка стикера без набора — то, что копируется между набором сервера и каталогом. */
export type StickerData = { emoji: string; url: string; format: StickerFormat; position: number };

/** Набор каталога по имени Telegram. */
export async function catalogPackByName(name: string): Promise<PackRow | undefined> {
  const [row] = await db
    .select()
    .from(stickerPacks)
    .where(and(isNull(stickerPacks.serverId), eq(stickerPacks.name, name)))
    .limit(1);
  return row;
}

/** Набор каталога по id (набор сервера — `undefined`: его id в ЛС не годится). */
export async function catalogPackById(packId: string): Promise<PackRow | undefined> {
  const [row] = await db
    .select()
    .from(stickerPacks)
    .where(and(isNull(stickerPacks.serverId), eq(stickerPacks.id, packId)))
    .limit(1);
  return row;
}

/** Сколько наборов человек привёз в каталог (предел — `STICKER_PACKS_PER_USER`). */
export async function catalogUploadedBy(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(stickerPacks)
    .where(and(isNull(stickerPacks.serverId), eq(stickerPacks.createdBy, userId)));
  return Number(row?.n ?? 0);
}

/** Стикеры набора по порядку — для копии (без id и набора). */
export async function packStickerData(packId: string): Promise<StickerData[]> {
  const rows = await db
    .select({ emoji: stickers.emoji, url: stickers.url, format: stickers.format, position: stickers.position })
    .from(stickers)
    .where(eq(stickers.packId, packId))
    .orderBy(asc(stickers.position));
  return rows;
}

/** Любой набор (сервера или каталога) с таким именем — источник файлов, чтобы не качать набор второй раз. */
export async function anyPackByName(name: string): Promise<PackRow | undefined> {
  const [row] = await db
    .select()
    .from(stickerPacks)
    .where(eq(stickerPacks.name, name))
    .orderBy(asc(stickerPacks.createdAt))
    .limit(1);
  return row;
}

/**
 * Копия набора в каталоге, если её ещё нет: строки стикеров — с теми же ссылками. Гонка двух загрузок одного имени
 * решается уникальным индексом (0092): вторая получает уже записанный набор.
 */
export async function ensureCatalogCopy(
  pack: { name: string; title: string; createdBy: string | null },
  rows: readonly StickerData[],
): Promise<{ pack: PackRow; created: boolean }> {
  const created = await db.transaction(async (tx) => {
    const packId = id();
    const [row] = await tx
      .insert(stickerPacks)
      .values({ id: packId, serverId: null, name: pack.name, title: pack.title, createdBy: pack.createdBy })
      .onConflictDoNothing()
      .returning();
    if (!row) return null;
    if (rows.length) await tx.insert(stickers).values(rows.map((r) => ({ id: id(), packId, ...r })));
    return row;
  });
  if (created) return { pack: created, created: true };
  const existing = await catalogPackByName(pack.name);
  if (!existing) throw new Error('набор каталога пропал между вставкой и чтением');
  return { pack: existing, created: false };
}

/**
 * Скачать набор из Telegram в бакет — ПОСЛЕДОВАТЕЛЬНО (120 одновременных скачиваний = 429 от Bot API и половина набора
 * битой). Незнакомый формат или крупный файл пропускает один стикер, а не весь набор. `existingPacks` — сколько наборов
 * уже на сервере (для предела сервера); каталогу передают 0.
 */
export async function downloadTelegramPack(
  name: string,
  existingPacks: number,
): Promise<{ ok: true; title: string; rows: StickerData[]; skipped: number } | { ok: false; status: number; error: string }> {
  let set;
  try {
    set = await getStickerSet(name);
  } catch (err) {
    const e = err as TelegramError;
    return { ok: false, status: e.statusCode ?? 502, error: e.message };
  }
  const sizeCheck = checkPackImport(set.stickers.length, existingPacks);
  if (!sizeCheck.ok) return { ok: false, status: 400, error: sizeCheck.error };

  const rows: StickerData[] = [];
  let skipped = 0;
  for (const [i, tg] of set.stickers.entries()) {
    let got;
    try {
      got = await downloadSticker(tg.file_id);
    } catch (err) {
      const e = err as TelegramError;
      return { ok: false, status: e.statusCode ?? 502, error: e.message };
    }
    if (!got) {
      skipped++;
      continue;
    }
    let url: string;
    try {
      url = await putMedia('stickers', id(), got.buffer, STICKER_MIME[got.format], Date.now());
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return { ok: false, status: e.statusCode ?? 500, error: e.message ?? 'не удалось сохранить стикер' };
    }
    rows.push({ emoji: tg.emoji ?? '', url, format: got.format, position: i });
  }
  if (!rows.length) return { ok: false, status: 400, error: 'ни один стикер набора не удалось загрузить' };
  return { ok: true, title: set.title, rows, skipped };
}

/** Поставить набор в «мои» первым (как у Telegram: только что добавленный — сверху). Уже стоит — ничего. */
export async function addToMine(userId: string, packId: string): Promise<boolean> {
  const [top] = await db
    .select({ p: sql<number | null>`min(${userStickerPacks.position})` })
    .from(userStickerPacks)
    .where(eq(userStickerPacks.userId, userId));
  const position = top?.p == null ? 0 : Number(top.p) - 1;
  const res = await db.insert(userStickerPacks).values({ userId, packId, position }).onConflictDoNothing().returning();
  return res.length > 0;
}

/** Мои наборы по порядку (id). */
export async function mineIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ packId: userStickerPacks.packId })
    .from(userStickerPacks)
    .where(eq(userStickerPacks.userId, userId))
    .orderBy(asc(userStickerPacks.position), sql`${userStickerPacks.addedAt} DESC`);
  return rows.map((r) => r.packId);
}

/** Стикеры наборов: все (`limit` не задан) или первые `limit` каждого — для обложек каталога. */
export async function stickersOf(packIds: readonly string[], limit?: number): Promise<Map<string, Sticker[]>> {
  const out = new Map<string, Sticker[]>();
  if (!packIds.length) return out;
  const rows = limit
    ? ((
        await db.execute(sql`
          SELECT id, pack_id, emoji, url, format FROM (
            SELECT s.*, row_number() OVER (PARTITION BY s.pack_id ORDER BY s.position) AS rn
            FROM stickers s WHERE s.pack_id IN (${sql.join(packIds.map((p) => sql`${p}`), sql`, `)})
          ) t WHERE t.rn <= ${limit} ORDER BY pack_id, rn`)
      ).rows as { id: string; pack_id: string; emoji: string; url: string; format: StickerFormat }[]).map((r) => ({
        id: r.id,
        packId: r.pack_id,
        emoji: r.emoji,
        url: r.url,
        format: r.format,
      }))
    : await db
        .select({ id: stickers.id, packId: stickers.packId, emoji: stickers.emoji, url: stickers.url, format: stickers.format })
        .from(stickers)
        .where(inArray(stickers.packId, [...packIds]))
        .orderBy(asc(stickers.position));
  for (const r of rows) {
    const list = out.get(r.packId) ?? [];
    list.push({ id: r.id, emoji: r.emoji, url: r.url, format: r.format });
    out.set(r.packId, list);
  }
  return out;
}

/** Число стикеров в наборах. */
export async function stickerCounts(packIds: readonly string[]): Promise<Map<string, number>> {
  if (!packIds.length) return new Map();
  const rows = await db
    .select({ packId: stickers.packId, n: count() })
    .from(stickers)
    .where(inArray(stickers.packId, [...packIds]))
    .groupBy(stickers.packId);
  return new Map(rows.map((r) => [r.packId, Number(r.n)]));
}

/** DTO набора каталога для смотрящего. */
export function catalogDto(
  p: PackRow,
  list: Sticker[],
  n: number,
  mine: boolean,
  canDelete: boolean,
): StickerCatalogPack {
  return { id: p.id, name: p.name, title: p.title, stickers: list, count: n, mine, canDelete };
}

/**
 * Стикер для сообщения беседы: только из каталога (набор сервера в ЛС не годится — его видят лишь участники сервера),
 * КОПИЕЙ (`MessageSticker`).
 */
export async function catalogSticker(stickerId: string): Promise<MessageSticker | null> {
  const [row] = await db
    .select({ id: stickers.id, emoji: stickers.emoji, url: stickers.url, format: stickers.format })
    .from(stickers)
    .innerJoin(stickerPacks, eq(stickers.packId, stickerPacks.id))
    .where(and(eq(stickers.id, stickerId), isNull(stickerPacks.serverId)))
    .limit(1);
  return row ?? null;
}

/**
 * Набор каталога, из которого этот стикер (для «Добавить набор» по полученному стикеру): по id стикера, а если его строки
 * уже нет или она из набора сервера — по картинке (у копий одна ссылка).
 */
export async function catalogPackOfSticker(stickerId: string | null, url: string | null): Promise<PackRow | undefined> {
  let link = url;
  if (stickerId) {
    const [hit] = await db
      .select({ pack: stickerPacks, url: stickers.url })
      .from(stickers)
      .innerJoin(stickerPacks, eq(stickers.packId, stickerPacks.id))
      .where(eq(stickers.id, stickerId))
      .limit(1);
    if (hit && hit.pack.serverId === null) return hit.pack;
    if (hit) {
      // Стикер набора сервера: его каталожная копия — по имени набора Telegram, а по картинке — если копию удаляли.
      const byName = await catalogPackByName(hit.pack.name);
      if (byName) return byName;
      link = hit.url;
    }
  }
  if (!link) return undefined;
  const [byUrl] = await db
    .select({ pack: stickerPacks })
    .from(stickers)
    .innerJoin(stickerPacks, eq(stickers.packId, stickerPacks.id))
    .where(and(eq(stickers.url, link), isNull(stickerPacks.serverId)))
    .limit(1);
  return byUrl?.pack;
}
