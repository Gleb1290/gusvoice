import { and, eq, getTableColumns, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  ASSEMBLY_CLAIM_STALE_MS,
  ASSEMBLY_TIMEOUT_MS,
  BIGFILE_PART_BYTES,
  expectedPartSize,
  missingParts,
  MULTIPART_OP_TIMEOUT_MS,
  PART_STORE_TIMEOUT_MS,
  partCount,
  resolveAttachmentMime,
  UPLOAD_TTL_HOURS,
  uploadStartBlock,
} from './attachmentRules.js';
import { attachmentStore, insertPendingRow, uploadedLastDay, withTimeout } from './attachments.js';
import { db } from './db/index.js';
import { attachmentUploadParts, attachmentUploads, attachments, conversationMembers } from './db/schema.js';
import { uuidv7 } from './util.js';

/**
 * Загрузка кусками (`bigfile1`, 09.10): файл ЛС до `BIGFILE_MAX_BYTES` идёт S3 multipart в закрытый бакет, каждый кусок —
 * отдельным запросом через бэкенд (`routes/uploads.ts`). Строка `attachment_uploads` живёт от начала до сборки; сборка
 * превращает её в обычную строку `attachments` `pending` (тот же id) — дальше отправка как у одиночной загрузки.
 *
 * Обрыв — не беда: клиент спрашивает, какие куски уже лежат (`uploadStatus`), и доливает остальные. Брошенные — уборка
 * (`purgeStaleUploads`): строки без активности дольше `UPLOAD_TTL_HOURS` и незавершённые загрузки хранилища, о которых база
 * не знает.
 *
 * Ревью безопасности (09.10): все операции хранилища — со сроком (`withTimeout`: у S3-клиента своего нет); загрузка видна
 * только участнику беседы (`left_at IS NULL`); сборка атомарна — «забор» `completing_at`, файл в хранилище собирается ДО
 * строки вложения, а строка вложения и стирание строки загрузки — одной транзакцией (id вложения = id загрузки известен
 * клиенту заранее, и строка до сборки дала бы отправить несобранный файл).
 *
 * ⚠️ Модуль без Redis и шлюза (как `attachments.ts`): его берут `cleanup.ts` и тесты на PGlite. Частоту режет ручка.
 */

export { uploadedLastDay };

export type UploadFail = { code: 202 | 400 | 404 | 409 | 413 | 429 | 503; error: string; missing?: number[]; assembling?: true };

function multipart() {
  return attachmentStore.multipart ?? null;
}

const unavailable: UploadFail = { code: 503, error: 'Загрузка кусками на этом сервере недоступна' };
const notFound: UploadFail = { code: 404, error: 'загрузка не найдена' };
const assembling: UploadFail = { code: 202, error: 'файл собирается — повторите чуть позже', assembling: true };

/** Начать загрузку кусками (участие в беседе проверил вызывающий; имя — уже очищенное, запрещённый тип — отсеян). */
export async function startUpload(input: {
  ownerId: string;
  conversationId: string;
  name: string;
  declaredType: string;
  size: number;
}): Promise<{ id: string; partSize: number; parts: number } | UploadFail> {
  const mp = multipart();
  if (!mp) return unavailable;
  const id = uuidv7();
  const storageKey = `dm/${id}`;
  const partSize = BIGFILE_PART_BYTES;
  // Предел и вставка — под замком владельца (как `insertPendingRow`): параллельные начала не проскочат суточный предел вдвоём.
  const block = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`att-pending:${input.ownerId}`}))`);
    const used = await uploadedLastDay(input.ownerId, tx);
    const fail = uploadStartBlock(input.size, used.bytes, used.open);
    if (fail) return fail;
    await tx.insert(attachmentUploads).values({
      id,
      conversationId: input.conversationId,
      ownerId: input.ownerId,
      storageKey,
      s3UploadId: '',
      name: input.name,
      declaredType: input.declaredType,
      size: input.size,
      partSize,
    });
    return null;
  });
  if (block) return block;
  // Строка — ДО загрузки в хранилище: сирота тогда только строка, её стирает уборка по сроку.
  try {
    const s3UploadId = await withTimeout(mp.create(storageKey, input.declaredType), MULTIPART_OP_TIMEOUT_MS);
    await db.update(attachmentUploads).set({ s3UploadId }).where(eq(attachmentUploads.id, id));
  } catch (e) {
    await db.delete(attachmentUploads).where(eq(attachmentUploads.id, id)).catch(() => {});
    throw e;
  }
  return { id, partSize, parts: partCount(input.size, partSize) };
}

/** Загрузка человека в беседе, где он всё ещё участник (вышедшему — как нет: 404). Без id хранилища — ещё не начата. */
async function ownUpload(ownerId: string, conversationId: string, uploadId: string) {
  const [row] = await db
    .select(getTableColumns(attachmentUploads))
    .from(attachmentUploads)
    .innerJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversationId, attachmentUploads.conversationId),
        eq(conversationMembers.userId, attachmentUploads.ownerId),
        isNull(conversationMembers.leftAt),
      ),
    )
    .where(and(eq(attachmentUploads.id, uploadId), eq(attachmentUploads.ownerId, ownerId), eq(attachmentUploads.conversationId, conversationId)))
    .limit(1);
  return row && row.s3UploadId ? row : null;
}

/** Метка сборки ещё действует (не старше `ASSEMBLY_CLAIM_STALE_MS`). */
function assemblingNow(completingAt: Date | null, now = Date.now()): boolean {
  return !!completingAt && now - completingAt.getTime() < ASSEMBLY_CLAIM_STALE_MS;
}

/**
 * Куда пойдёт кусок `n` и сколько в нём байт (`want`). Ручка спрашивает это ДО чтения тела (ревью H1: чужой или выдуманный
 * uploadId не заставляет сервер принять 8 МиБ в память) и сверяет `want` с `Content-Length`.
 */
export async function partTarget(
  ownerId: string,
  conversationId: string,
  uploadId: string,
  n: number,
): Promise<{ row: typeof attachmentUploads.$inferSelect; want: number } | UploadFail> {
  if (!multipart()) return unavailable;
  const row = await ownUpload(ownerId, conversationId, uploadId);
  if (!row) return notFound;
  // Во время сборки куски не меняются: перезапись куска сменила бы ETag, и сборка по прочитанному списку упала бы.
  if (assemblingNow(row.completingAt)) return { code: 409, error: 'файл уже собирается' };
  const want = expectedPartSize(row.size, n, row.partSize);
  if (want === null) return { code: 400, error: 'нет такого куска' };
  return { row, want };
}

/**
 * Положить кусок `n`. Размер обязан совпасть с ожидаемым (`expectedPartSize`); повтор того же номера — перезапись.
 * `track` — держатель пропуска памяти (`uploadGate`): кусок в хранилище держит буфер, пока запрос к нему не завершится.
 */
export async function uploadPart(input: {
  ownerId: string;
  conversationId: string;
  uploadId: string;
  n: number;
  bytes: Buffer;
  track?: <T>(p: Promise<T>) => Promise<T>;
}): Promise<{ n: number } | UploadFail> {
  const mp = multipart();
  if (!mp) return unavailable;
  const target = await partTarget(input.ownerId, input.conversationId, input.uploadId, input.n);
  if ('code' in target) return target;
  const { row, want } = target;
  if (input.bytes.length !== want) return { code: 400, error: `кусок ${input.n}: ждали ${want} байт, пришло ${input.bytes.length}` };
  const put = mp.part(row.storageKey, row.s3UploadId, input.n, input.bytes);
  const etag = await withTimeout(input.track ? input.track(put) : put, PART_STORE_TIMEOUT_MS);
  await db
    .insert(attachmentUploadParts)
    .values({ uploadId: row.id, partNumber: input.n, etag, size: input.bytes.length })
    .onConflictDoUpdate({
      target: [attachmentUploadParts.uploadId, attachmentUploadParts.partNumber],
      set: { etag, size: input.bytes.length },
    });
  // Тип — по содержимому начала файла, как у одиночной загрузки (`resolveAttachmentMime`), а не со слов клиента.
  const contentType = input.n === 1 ? resolveAttachmentMime(row.declaredType, input.bytes.subarray(0, 64)) : undefined;
  // Последняя активность (0134) — уборка считает срок от неё.
  await db
    .update(attachmentUploads)
    .set(contentType ? { contentType, lastPartAt: sql`now()` } : { lastPartAt: sql`now()` })
    .where(eq(attachmentUploads.id, row.id));
  return { n: input.n };
}

/** Где загрузка: какие куски уже лежат (продолжение после обрыва). `null` — нет такой (истекла, отменена, собрана). */
export async function uploadStatus(
  ownerId: string,
  conversationId: string,
  uploadId: string,
): Promise<{ id: string; size: number; partSize: number; parts: number; done: number[] } | null> {
  const row = await ownUpload(ownerId, conversationId, uploadId);
  if (!row) return null;
  const parts = await db
    .select({ part: attachmentUploadParts.partNumber, size: attachmentUploadParts.size })
    .from(attachmentUploadParts)
    .where(eq(attachmentUploadParts.uploadId, row.id));
  const bad = new Set(missingParts(row.size, parts, row.partSize));
  const done = parts.map((p) => p.part).filter((n) => !bad.has(n)).sort((a, b) => a - b);
  return { id: row.id, size: row.size, partSize: row.partSize, parts: partCount(row.size, row.partSize), done };
}

/** Уже собранное и ещё не отправленное вложение этой загрузки (повтор `complete` после успеха, ответ потерялся). */
async function assembled(ownerId: string, conversationId: string, uploadId: string) {
  const [att] = await db
    .select({ id: attachments.id, name: attachments.name, contentType: attachments.contentType, size: attachments.size })
    .from(attachments)
    .innerJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversationId, attachments.conversationId),
        eq(conversationMembers.userId, attachments.ownerId),
        isNull(conversationMembers.leftAt),
      ),
    )
    .where(
      and(
        eq(attachments.id, uploadId),
        eq(attachments.ownerId, ownerId),
        eq(attachments.conversationId, conversationId),
        eq(attachments.state, 'pending'),
      ),
    )
    .limit(1);
  return att ?? null;
}

class UploadGone extends Error {}

/**
 * Собрать файл. Порядок (ревью M1): все куски на месте → «забор» условным UPDATE `completing_at` (второй `complete`, пока
 * идёт сборка, получает 202 «собирается», а не вторую сборку и дубль ключа) → сборка в хранилище → ОДНОЙ транзакцией строка
 * `attachments` `pending` (тот же id) + стирание строки загрузки. До конца сборки строки вложения нет — отправить несобранный
 * файл нельзя. Сбой сборки — метка снимается, загрузка остаётся (можно повторить); если хранилище файл всё же собрало
 * (ответ потерялся), повтор найдёт его по размеру и доведёт. Загрузку отменили или человек вышел посреди сборки — файл
 * стирается, ответ 404. Повтор после успешной сборки отдаёт то же вложение.
 */
export async function completeUpload(
  ownerId: string,
  conversationId: string,
  uploadId: string,
): Promise<{ id: string; name: string; contentType: string; size: number } | UploadFail> {
  const mp = multipart();
  if (!mp) return unavailable;
  const row = await ownUpload(ownerId, conversationId, uploadId);
  if (!row) return (await assembled(ownerId, conversationId, uploadId)) ?? notFound;
  const parts = await db
    .select({ part: attachmentUploadParts.partNumber, size: attachmentUploadParts.size, etag: attachmentUploadParts.etag })
    .from(attachmentUploadParts)
    .where(eq(attachmentUploadParts.uploadId, row.id))
    .orderBy(attachmentUploadParts.partNumber);
  const missing = missingParts(row.size, parts, row.partSize);
  if (missing.length > 0) return { code: 409, error: 'не все куски загружены', missing };

  const claimed = await db
    .update(attachmentUploads)
    .set({ completingAt: sql`now()` })
    .where(
      and(
        eq(attachmentUploads.id, row.id),
        or(isNull(attachmentUploads.completingAt), lt(attachmentUploads.completingAt, sql`now() - ${`${ASSEMBLY_CLAIM_STALE_MS} milliseconds`}::interval`)),
      ),
    )
    .returning({ id: attachmentUploads.id });
  if (claimed.length === 0) return (await assembled(ownerId, conversationId, uploadId)) ?? assembling;
  const unclaim = () =>
    db
      .update(attachmentUploads)
      .set({ completingAt: null })
      .where(eq(attachmentUploads.id, row.id))
      .catch(() => {});

  try {
    await withTimeout(
      mp.complete(
        row.storageKey,
        row.s3UploadId,
        parts.map((p) => ({ part: p.part, etag: p.etag })),
      ),
      ASSEMBLY_TIMEOUT_MS,
    );
  } catch (e) {
    // Хранилище могло собрать файл, а ответ потерялся (срок вышел, прошлая попытка): файл нужного размера на месте — дальше.
    const st = await withTimeout(attachmentStore.stat(row.storageKey), MULTIPART_OP_TIMEOUT_MS).catch(() => null);
    if (!st || st.size !== row.size) {
      await unclaim();
      throw e;
    }
  }

  const contentType = row.contentType ?? resolveAttachmentMime(row.declaredType, Buffer.alloc(0));
  try {
    await insertPendingRow(
      { id: row.id, storageKey: row.storageKey, ownerId, conversationId, name: row.name, contentType, size: row.size },
      {
        inTx: async (tx) => {
          const gone = await tx.delete(attachmentUploads).where(eq(attachmentUploads.id, row.id)).returning({ id: attachmentUploads.id });
          if (gone.length === 0) throw new UploadGone();
        },
      },
    );
  } catch (e) {
    if (e instanceof UploadGone) {
      // Отменили или вышел из беседы посреди сборки: строки вложения нет (транзакция откатилась) — собранный файл ничей.
      await withTimeout(attachmentStore.remove(row.storageKey), MULTIPART_OP_TIMEOUT_MS).catch(() => {});
      return notFound;
    }
    // Сбой базы: файл в хранилище оставляем — повтор `complete` найдёт его по размеру; не повторят — уборка сотрёт.
    await unclaim();
    throw e;
  }
  return { id: row.id, name: row.name, contentType, size: row.size };
}

/** Отменить загрузку: строка — сразу, куски в хранилище — по возможности (не вышло — подберёт уборка). */
export async function abortUpload(ownerId: string, conversationId: string, uploadId: string): Promise<boolean> {
  const gone = await db
    .delete(attachmentUploads)
    .where(and(eq(attachmentUploads.id, uploadId), eq(attachmentUploads.ownerId, ownerId), eq(attachmentUploads.conversationId, conversationId)))
    .returning({ storageKey: attachmentUploads.storageKey, s3UploadId: attachmentUploads.s3UploadId });
  const mp = multipart();
  for (const g of gone) if (mp && g.s3UploadId) await withTimeout(mp.abort(g.storageKey, g.s3UploadId), MULTIPART_OP_TIMEOUT_MS).catch(() => {});
  return gone.length > 0;
}

/**
 * Уборка брошенных загрузок кусками (часовая, `cleanup.startAttachmentSweeper`; первый проход — через минуту после
 * старта): (1) строки без активности дольше `UPLOAD_TTL_HOURS` (последнее из: начало, последний кусок, начало сборки — 0134)
 * — бросить в хранилище и стереть; у начатой сборки ещё и стереть файл (сборка в хранилище могла пройти, а строка
 * вложения не появилась — тогда файл ничей); (2) незавершённые загрузки хранилища под `dm/` старше того же срока, которых
 * нет в базе (строка ушла при выходе из беседы или каскадом, сбой посреди отмены) — бросить.
 * Возвращает, сколько загрузок брошено.
 */
export async function purgeStaleUploads(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - UPLOAD_TTL_HOURS * 3600_000);
  const stale = await db
    .delete(attachmentUploads)
    .where(
      sql`greatest(${attachmentUploads.createdAt}, ${attachmentUploads.lastPartAt}, ${attachmentUploads.completingAt}) < ${cutoff.toISOString()}::timestamptz`,
    )
    .returning({ storageKey: attachmentUploads.storageKey, s3UploadId: attachmentUploads.s3UploadId, completingAt: attachmentUploads.completingAt });
  const mp = multipart();
  if (!mp) return stale.length;
  let n = 0;
  for (const s of stale) {
    if (s.completingAt) await withTimeout(attachmentStore.remove(s.storageKey), MULTIPART_OP_TIMEOUT_MS).catch(() => {});
    if (!s.s3UploadId) continue;
    await withTimeout(mp.abort(s.storageKey, s.s3UploadId), MULTIPART_OP_TIMEOUT_MS).then(
      () => n++,
      () => {},
    );
  }
  const listed = (await withTimeout(mp.list('dm/'), MULTIPART_OP_TIMEOUT_MS).catch(() => [])).filter((u) => u.initiated < cutoff);
  if (listed.length === 0) return n;
  const known = new Set(
    (
      await db
        .select({ s3UploadId: attachmentUploads.s3UploadId })
        .from(attachmentUploads)
        .where(inArray(attachmentUploads.s3UploadId, listed.map((u) => u.uploadId)))
    ).map((r) => r.s3UploadId),
  );
  for (const u of listed) {
    if (known.has(u.uploadId)) continue;
    await withTimeout(mp.abort(u.key, u.uploadId), MULTIPART_OP_TIMEOUT_MS).then(
      () => n++,
      () => {},
    );
  }
  return n;
}

/**
 * Человек вышел из беседы (или его удалили, `convGroups.removeGroupMember`): его загрузки в ней стираются в той же
 * транзакции. Куски в хранилище подберёт уборка (`purgeStaleUploads`, шаг 2: незавершённые, о которых база не знает).
 */
export async function dropUploadsOfMember(
  tx: Pick<typeof db, 'delete'>,
  conversationId: string,
  userId: string,
): Promise<void> {
  await tx.delete(attachmentUploads).where(and(eq(attachmentUploads.conversationId, conversationId), eq(attachmentUploads.ownerId, userId)));
}
