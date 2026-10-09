/**
 * «Мои GIF» (Р-7, #211, признак `gifs1`, миграция 0104): сохранённые GIF человека — одни на всех его устройствах, как у
 * Telegram (tdesktop `chat_helpers/gifs_list_widget.cpp`, «Сохранить GIF» — `history_view_context_menu.cpp`). Файл — своя
 * копия в закрытом хранилище (`gif/<id>`): удалят сообщение — GIF остаётся. Отправка — копия файла в беседу как обычное
 * вложение (`copyForForward`), дальше обычная отправка с подсказкой `gif: true`. Правила — `gifRules.ts`.
 */
import type { SavedGif } from '@gusvoice/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { attachmentStore, copyForForward, copyStoredFile, createPending, gifLink } from './attachments.js';
import { loadAccess, type Tx } from './conversations.js';
import { db } from './db/index.js';
import { attachments, userSavedGifs, users } from './db/schema.js';
import { GIFS_SAVED_MAX, gifFileName, gifSavable, gifsOverLimit } from './gifRules.js';
import { publishToUser } from './realtime.js';
import { uuidv7 } from './util.js';

type GifRow = typeof userSavedGifs.$inferSelect;
type AttachmentRow = typeof attachments.$inferSelect;

async function tokenGen(userId: string): Promise<number> {
  const [u] = await db.select({ gen: users.tokenGeneration }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.gen ?? 0;
}

function view(r: GifRow, me: string, gen: number): SavedGif {
  return {
    id: r.id,
    url: gifLink(r.id, me, gen),
    contentType: r.contentType,
    size: r.size,
    width: r.width,
    height: r.height,
    durationMs: r.durationMs,
  };
}

/** Мои GIF, новые первыми. */
export async function listGifs(me: string): Promise<SavedGif[]> {
  const rows = await db
    .select()
    .from(userSavedGifs)
    .where(eq(userSavedGifs.userId, me))
    .orderBy(desc(userSavedGifs.addedAt))
    .limit(GIFS_SAVED_MAX);
  const gen = rows.length ? await tokenGen(me) : 0;
  return rows.map((r) => view(r, me, gen));
}

/**
 * «Мои GIF» — на все мои устройства (08.10, `groups3`): после каждой правки списка — событие `gifs.update` со списком
 * целиком (как `GET /api/gifs`), как `stickers.update` у стикеров. Ошибка доставки ответ не роняет.
 */
export async function announceGifs(me: string): Promise<void> {
  await publishToUser(me, { t: 'gifs.update', gifs: await listGifs(me) }).catch(() => {});
}

/**
 * Файлы «Моих GIF» человека (08.10, удаление аккаунта): ключи `gif/…` — свои копии в закрытом хранилище (не ссылки на
 * чужие вложения), поэтому их можно стирать все. Читать ДО удаления строк (`accountDelete.ts`, в той же транзакции).
 */
export async function savedGifKeysOf(q: Tx, userId: string): Promise<string[]> {
  const rows = await q.select({ key: userSavedGifs.storageKey }).from(userSavedGifs).where(eq(userSavedGifs.userId, userId));
  return rows.map((r) => r.key);
}

/** Стереть файлы «Моих GIF» удалённого аккаунта (после фиксации); не успело — останутся сиротами в `gif/`. */
export async function removeGifFiles(keys: readonly string[]): Promise<void> {
  for (const key of keys) await attachmentStore.remove(key).catch(() => {});
}

/** Строка «Моего GIF» владельца (для файла и отправки). */
export async function gifOf(me: string, id: string): Promise<GifRow | null> {
  const [r] = await db
    .select()
    .from(userSavedGifs)
    .where(and(eq(userSavedGifs.id, id), eq(userSavedGifs.userId, me)))
    .limit(1);
  return r ?? null;
}

/** Убрать строки сверх предела (самые старые) и их файлы. */
async function trim(me: string): Promise<void> {
  const rows = await db
    .select({ id: userSavedGifs.id, key: userSavedGifs.storageKey })
    .from(userSavedGifs)
    .where(eq(userSavedGifs.userId, me))
    .orderBy(desc(userSavedGifs.addedAt));
  const over = new Set(gifsOverLimit(rows.map((r) => r.id)));
  if (over.size === 0) return;
  await db.delete(userSavedGifs).where(and(eq(userSavedGifs.userId, me), inArray(userSavedGifs.id, [...over])));
  for (const r of rows) if (over.has(r.id)) await attachmentStore.remove(r.key).catch(() => {});
}

export type SaveGifResult = { kind: 'ok'; gif: SavedGif } | { kind: 'not-found' } | { kind: 'bad-type' };

/**
 * «Сохранить GIF» из ленты: вложение беседы, где я участник, видео или `image/gif` до предела. Уже сохранённое (то же
 * вложение) поднимается наверх без новой копии — как повторное `messages.saveGif` у Telegram.
 */
export async function saveGifFromAttachment(
  me: string,
  attId: string,
  hints: { width?: number | null; height?: number | null; durationMs?: number | null },
): Promise<SaveGifResult> {
  const [att] = await db.select().from(attachments).where(eq(attachments.id, attId)).limit(1);
  if (!att || att.state !== 'attached' || !(await loadAccess(att.conversationId, me))) return { kind: 'not-found' };
  if (!gifSavable(att.contentType, att.size)) return { kind: 'bad-type' };
  return upsert(me, `att:${att.id}`, att.contentType, att.size, hints, (key) => copyStoredFile(att.storageKey, key, att.contentType));
}

/** Сохранить привезённый от поставщика GIF (отправка из поиска кладёт его в «Мои GIF», как у Telegram). */
export async function saveGifBytes(me: string, origin: string, contentType: string, bytes: Buffer, hints: { width?: number | null; height?: number | null }): Promise<SavedGif> {
  const r = await upsert(me, origin, contentType, bytes.length, hints, (key) => attachmentStore.put(key, bytes, contentType));
  if (r.kind !== 'ok') throw new Error('gif save failed');
  return r.gif;
}

async function upsert(
  me: string,
  origin: string,
  contentType: string,
  size: number,
  hints: { width?: number | null; height?: number | null; durationMs?: number | null },
  write: (key: string) => Promise<void>,
): Promise<SaveGifResult> {
  const [had] = await db
    .select()
    .from(userSavedGifs)
    .where(and(eq(userSavedGifs.userId, me), eq(userSavedGifs.origin, origin)))
    .limit(1);
  if (had) {
    const [row] = await db.update(userSavedGifs).set({ addedAt: new Date() }).where(eq(userSavedGifs.id, had.id)).returning();
    return { kind: 'ok', gif: view(row ?? had, me, await tokenGen(me)) };
  }
  const id = uuidv7();
  const storageKey = `gif/${id}`;
  await write(storageKey);
  const [row] = await db
    .insert(userSavedGifs)
    .values({
      id,
      userId: me,
      storageKey,
      contentType,
      size,
      width: hints.width ?? null,
      height: hints.height ?? null,
      durationMs: hints.durationMs ?? null,
      origin,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    // Параллельное сохранение того же успело раньше — свою копию убираем, отдаём его строку.
    await attachmentStore.remove(storageKey).catch(() => {});
    const [other] = await db
      .select()
      .from(userSavedGifs)
      .where(and(eq(userSavedGifs.userId, me), eq(userSavedGifs.origin, origin)))
      .limit(1);
    if (!other) return { kind: 'not-found' };
    return { kind: 'ok', gif: view(other, me, await tokenGen(me)) };
  }
  await trim(me);
  return { kind: 'ok', gif: view(row, me, await tokenGen(me)) };
}

/** Убрать GIF из «Моих» (и его файл). `false` — такого нет. */
export async function deleteGif(me: string, id: string): Promise<boolean> {
  const [r] = await db
    .delete(userSavedGifs)
    .where(and(eq(userSavedGifs.id, id), eq(userSavedGifs.userId, me)))
    .returning({ key: userSavedGifs.storageKey });
  if (!r) return false;
  await attachmentStore.remove(r.key).catch(() => {});
  return true;
}

export type AttachGifResult =
  | { kind: 'ok'; attachmentId: string; contentType: string; width: number | null; height: number | null; durationMs: number | null }
  | { kind: 'not-found' };

/**
 * Отправка «Моего GIF» в беседу: копия файла — незавершённое вложение этой беседы (как у пересылки), дальше клиент шлёт
 * обычное сообщение с ним и подсказкой `gif: true`. Чужая беседа или чужой GIF — `not-found`.
 */
export async function attachSavedGif(me: string, gifId: string, conversationId: string): Promise<AttachGifResult> {
  const [gif, access] = await Promise.all([gifOf(me, gifId), loadAccess(conversationId, me)]);
  if (!gif || !access) return { kind: 'not-found' };
  const source = {
    id: gif.id,
    storageKey: gif.storageKey,
    name: gifFileName(gif.contentType),
    contentType: gif.contentType,
    size: gif.size,
  } as AttachmentRow;
  const copies = await copyForForward({ ownerId: me, conversationId, sources: [source] });
  const row = copies.get(gif.id);
  if (!row) return { kind: 'not-found' };
  // Отправка поднимает GIF наверх «Моих» (Telegram: недавно отправленные — первыми).
  await db.update(userSavedGifs).set({ addedAt: new Date() }).where(eq(userSavedGifs.id, gif.id));
  return { kind: 'ok', attachmentId: row.id, contentType: gif.contentType, width: gif.width, height: gif.height, durationMs: gif.durationMs };
}

/** Привезённый от поставщика файл — незавершённое вложение беседы. */
export async function attachExternalBytes(me: string, conversationId: string, contentType: string, bytes: Buffer): Promise<string | null> {
  if (!(await loadAccess(conversationId, me))) return null;
  return createPending({ ownerId: me, conversationId, name: gifFileName(contentType), contentType, bytes });
}
