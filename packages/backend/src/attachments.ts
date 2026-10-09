import type { Readable } from 'node:stream';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  attLink,
  attSig,
  attSigValid,
  copyTimeoutMs,
  deriveAttKey,
  DM_DAILY_UPLOAD_BYTES,
  pendingEvictions,
  PENDING_MAX_BYTES_BIGFILE,
  PENDING_MAX_COUNT,
  PENDING_TTL_HOURS,
  uploadStartBlock,
} from './attachmentRules.js';
import { db } from './db/index.js';
import { attachmentUploads, attachments } from './db/schema.js';
import { dmWriteBarrier } from './dmWriteBarrier.js';
import { env } from './env.js';
import {
  abortPrivateMultipart,
  completePrivateMultipart,
  copyPrivate,
  createPrivateMultipart,
  listPrivateMultipart,
  putPrivatePart,
  getPrivate,
  privateStorageReady,
  putPrivate,
  removePrivate,
  statPrivate,
  storageConfigured,
  tryPreparePrivateNow,
} from './storage.js';
import { uuidv7 } from './util.js';

/**
 * Закрытые файлы ЛС (шаг 1в) — строки `attachments` и файлы в закрытом бакете. Правила — `attachmentRules.ts` и
 * `convRules.attachmentAccess`; выдача — `routes/att.ts`; привязка к сообщению и надгробие — `conversations.ts`.
 *
 * ⚠️ Модуль без Redis и шлюза: его берут `cleanup.ts` и тесты на PGlite. Хранилище подменяется (`setAttachmentStoreForTests`).
 */

/** Операции с файлами — подменяемые, чтобы тест обходился без S3. */
export interface AttachmentStore {
  /** Можно принимать новые файлы: закрытый бакет подготовлен и проверен. */
  ready(): boolean;
  /** Подготовить прямо сейчас, если ещё не готов (для загрузки). */
  ensureReady(): Promise<boolean>;
  /**
   * Можно отдавать уже лежащие файлы: хранилище настроено. Отдачу НЕ гасим флагом подготовки (ревью 30.09): после
   * рестарта при лежащем хранилище все картинки ЛС иначе отдавали бы 404 ещё минуты после того, как оно поднялось.
   */
  configured(): boolean;
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  stat(key: string): Promise<{ size: number } | null>;
  get(key: string, range?: { start: number; end: number }): Promise<Readable>;
  remove(key: string): Promise<void>;
  /**
   * Копия файла под новым ключом внутри хранилища (пересылка, `conv5`). Необязательна: хранилище без неё (подмены в
   * тестах) копируется чтением и записью (`copyStored`).
   */
  copy?(fromKey: string, toKey: string): Promise<void>;
  /**
   * Загрузка кусками (`bigfile1`, `bigUploads.ts`). Необязательна: хранилище без неё (подмены в тестах) — ручки кусков
   * отвечают 503, одиночная загрузка работает как была.
   */
  multipart?: MultipartStore;
}

/** S3 multipart закрытого бакета (`storage.ts`). */
export interface MultipartStore {
  create(key: string, mime: string): Promise<string>;
  part(key: string, uploadId: string, part: number, bytes: Buffer): Promise<string>;
  complete(key: string, uploadId: string, parts: { part: number; etag: string }[]): Promise<void>;
  abort(key: string, uploadId: string): Promise<void>;
  /** Незавершённые в хранилище под префиксом — уборка брошенных, о которых база забыла. */
  list(prefix: string): Promise<{ key: string; uploadId: string; initiated: Date }[]>;
}

const s3Store: AttachmentStore = {
  ready: privateStorageReady,
  ensureReady: tryPreparePrivateNow,
  configured: storageConfigured,
  put: putPrivate,
  stat: statPrivate,
  get: getPrivate,
  remove: removePrivate,
  copy: copyPrivate,
  multipart: {
    create: createPrivateMultipart,
    part: putPrivatePart,
    complete: completePrivateMultipart,
    abort: abortPrivateMultipart,
    list: listPrivateMultipart,
  },
};

export let attachmentStore: AttachmentStore = s3Store;

/** Для тестов: своё хранилище; `null` — вернуть настоящее. */
export function setAttachmentStoreForTests(store: AttachmentStore | null): void {
  attachmentStore = store ?? s3Store;
}

let key: Buffer | null = null;
function attKey(): Buffer {
  return (key ??= deriveAttKey(env.jwtSecret));
}

/** Можно ли сейчас принимать закрытые файлы ЛС: хранилище готово и есть внешний адрес API для ссылок. */
export function privateAttachmentsReady(): boolean {
  return attachmentStore.ready() && !!env.publicApiUrl;
}

/** Ссылка на файл для конкретного смотрящего (`tokenGen` — поколение его токенов). */
export function attachmentLink(attId: string, viewerId: string, tokenGen: number): string {
  return attLink(env.publicApiUrl, attId, viewerId, attSig(attKey(), attId, viewerId, tokenGen));
}

/** Подлинна ли подпись ссылки для этого смотрящего и поколения его токенов (сравнение за постоянное время). */
export function attachmentSigValid(attId: string, viewerId: string, tokenGen: number, sig: string): boolean {
  return attSigValid(attKey(), attId, viewerId, tokenGen, sig);
}

/**
 * Принять загрузку: строка `pending` ДО записи файла — тогда сирота может быть только строкой без файла, и её убирает
 * уборка по сроку (обратный порядок оставлял бы файлы без строк, которые находятся лишь обходом бакета).
 * Сверх предела незавершённых на человека самые старые ВЫТЕСНЯЮТСЯ (`pendingEvictions`), а не отказ. Подсчёт и
 * вставка — под замком владельца (`pg_advisory_xact_lock`): параллельные загрузки не проскочат предел вдвоём.
 * Возвращает id вложения. Имя — уже очищенное вызывающим (`sanitizeFilename`).
 */
export async function createPending(input: {
  ownerId: string;
  conversationId: string;
  name: string;
  contentType: string;
  bytes: Buffer;
  /**
   * Проверить суточный объём владельца (`DM_DAILY_UPLOAD_BYTES`) под тем же замком, что и вставку (ревью `bigfile1`, L3):
   * проверка ДО замка пропускала параллельные загрузки вдвоём. Сверх — `DailyQuotaError` (429).
   */
  daily?: boolean;
}): Promise<string> {
  const id = uuidv7();
  const storageKey = `dm/${id}`;
  const { daily, bytes, ...row } = input;
  await insertPendingRow({ ...row, id, storageKey, size: bytes.length }, { daily });
  try {
    await attachmentStore.put(storageKey, bytes, input.contentType);
  } catch (e) {
    // Только ещё незавершённую: привязанную к сообщению строку сбой записи не стирает.
    await db
      .delete(attachments)
      .where(and(eq(attachments.id, id), eq(attachments.state, 'pending')))
      .catch(() => {});
    throw e;
  }
  return id;
}

/** Сверх суточного объёма загрузок (`DM_DAILY_UPLOAD_BYTES`): глобальный обработчик ошибок отдаёт 429 с этим текстом. */
export class DailyQuotaError extends Error {
  readonly statusCode = 429;
  constructor(message: string) {
    super(message);
    this.name = 'DailyQuotaError';
  }
}

type Exec = Pick<typeof db, 'select'>;

/**
 * Объём загрузок человека в ЛС за скользящие сутки: файлы (любого состояния — залитое есть залитое; копии пересылки —
 * тоже) + заявленный размер ещё открытых загрузок кусками.
 */
export async function uploadedLastDay(ownerId: string, ex: Exec = db): Promise<{ bytes: number; open: number }> {
  const since = sql`now() - interval '24 hours'`;
  const [files] = await ex
    .select({ bytes: sql<string>`coalesce(sum(${attachments.size}), 0)` })
    .from(attachments)
    .where(and(eq(attachments.ownerId, ownerId), gte(attachments.createdAt, since)));
  const [open] = await ex
    .select({ bytes: sql<string>`coalesce(sum(${attachmentUploads.size}), 0)`, n: sql<number>`count(*)::int` })
    .from(attachmentUploads)
    .where(eq(attachmentUploads.ownerId, ownerId));
  return { bytes: Number(files?.bytes ?? 0) + Number(open?.bytes ?? 0), open: open?.n ?? 0 };
}

/** Под замком `att-pending:<владелец>`: ещё `adding` байт не превысят суточный объём — иначе `DailyQuotaError`. */
async function assertDailyRoom(ownerId: string, adding: number, tx: Exec): Promise<void> {
  const used = await uploadedLastDay(ownerId, tx);
  if (used.bytes + adding <= DM_DAILY_UPLOAD_BYTES) return;
  const quota = uploadStartBlock(adding, used.bytes, 0, Number.MAX_SAFE_INTEGER);
  throw new DailyQuotaError(quota?.error ?? 'За сутки загружено слишком много');
}

/**
 * Строка `pending` с вытеснением старых сверх предела — под замком владельца. Общая для одиночной загрузки
 * (`createPending`) и сборки кусков (`bigUploads.completeUpload`): файл появляется в хранилище ПОСЛЕ строки.
 */
export async function insertPendingRow(
  input: {
    id: string;
    storageKey: string;
    ownerId: string;
    conversationId: string;
    name: string;
    contentType: string;
    size: number;
  },
  opts: {
    /** Проверить суточный объём под замком (`assertDailyRoom`). */
    daily?: boolean;
    /** Ещё шаги в той же транзакции после вставки (сборка кусков: стереть строку загрузки — атомарно с появлением файла). */
    inTx?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>;
  } = {},
): Promise<void> {
  const { id, storageKey } = input;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`att-pending:${input.ownerId}`}))`);
    if (opts.daily) await assertDailyRoom(input.ownerId, input.size, tx);
    const existing = await tx
      .select({ id: attachments.id, size: attachments.size })
      .from(attachments)
      .where(and(eq(attachments.ownerId, input.ownerId), eq(attachments.state, 'pending')))
      .orderBy(attachments.createdAt);
    const evict = pendingEvictions(existing, input.size, PENDING_MAX_COUNT, PENDING_MAX_BYTES_BIGFILE);
    await dmWriteBarrier.beforePendingEvict?.({ tx, evict }); // точка для теста гонки с привязкой (`dmWriteBarrier.ts`)
    if (evict.length > 0) {
      // 🔴 Только ещё незавершённые (04.10): строку, выбранную на вытеснение, параллельная отправка или пересылка могла
      // успеть привязать к сообщению (`FOR UPDATE` → `attached`). Этот UPDATE ждёт её фиксации и перепроверяет условие на
      // новой версии строки: без `state = 'pending'` он пометил бы удалённым файл уже отправленного сообщения.
      await tx
        .update(attachments)
        .set({ state: 'deleted', deletedAt: new Date() })
        .where(and(inArray(attachments.id, evict), eq(attachments.state, 'pending')));
    }
    await tx.insert(attachments).values({
      id,
      conversationId: input.conversationId,
      ownerId: input.ownerId,
      storageKey,
      name: input.name,
      contentType: input.contentType,
      size: input.size,
    });
    await opts.inTx?.(tx);
  });
}

/** Операция с хранилищем не дольше `ms`: у S3-клиента своего таймаута нет, подвисшее хранилище держало бы вызов вечно. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`хранилище не ответило за ${ms} мс`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Удалить файлы, чьи строки уже помечены `deleted` (после фиксации транзакции надгробия): сначала файл, потом строка.
 * Сбой — строка остаётся `deleted`, и её подберёт суточная уборка.
 */
export async function purgeDeleted(keys: readonly string[]): Promise<number> {
  let n = 0;
  for (const k of keys) {
    try {
      await withTimeout(attachmentStore.remove(k), 30_000);
      await db.delete(attachments).where(and(eq(attachments.storageKey, k), eq(attachments.state, 'deleted')));
      n++;
    } catch (e) {
      console.error('[attachments] не удалось удалить файл ЛС, повторит уборка:', (e as Error).message);
    }
  }
  return n;
}

type AttachmentRow = typeof attachments.$inferSelect;

/** Копия файла без известного размера (GIF в «Мои») не дольше этого: у S3-клиента своего таймаута нет. */
const COPY_TIMEOUT_MS = 60_000;

/** Скопировать файл: своей копией хранилища (S3 CopyObject), а у хранилища без неё — чтением и записью. */
async function copyStored(fromKey: string, toKey: string, mime: string): Promise<void> {
  if (attachmentStore.copy) return attachmentStore.copy(fromKey, toKey);
  const chunks: Buffer[] = [];
  for await (const c of await attachmentStore.get(fromKey)) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  await attachmentStore.put(toKey, Buffer.concat(chunks), mime);
}

/**
 * Копии вложений для пересылки (04.10, `conv5`): у пересланного сообщения СВОИ строки и СВОИ файлы, а не ссылки на файлы
 * оригинала. Ссылка на тот же объект потребовала бы счётчика ссылок во всех местах удаления (надгробие, уборка), а откат
 * на прежний бэкенд, который счётчика не знает, стирал бы общий файл при удалении любого из двух сообщений. С копией
 * правило «одна строка = один файл» остаётся: «удалить у обоих» оригинала не задевает пересланное, и наоборот; доступ —
 * по своей строке (беседа-получатель, своё сообщение).
 *
 * Как у `createPending`: строки `pending` (владелец — пересылающий, беседа — получатель) — ДО файлов, тогда сирота может
 * быть только строкой без файла, и её уберёт уборка по сроку. Пределы незавершённых здесь не вытесняют ничего: копии
 * живут секунды до привязки (`conversations.forwardMessages`), а их число и объём ограничены пачкой
 * (`convRules.FORWARD_ATTACHMENTS_MAX` / `FORWARD_BYTES_MAX` = пределам незавершённых).
 * Копии считаются в суточный объём владельца (ревью `bigfile1`, M2: иначе 512 МБ × 10 в минуту в «Избранное» обходили
 * предел): сумма проверяется под замком `att-pending:<владелец>` вместе со вставкой — сверх `DailyQuotaError` (429).
 * Срок одной копии — от размера (`attachmentRules.copyTimeoutMs`): файл в 512 МБ хранилище копирует дольше минуты.
 * Возвращает «id исходного вложения → новая строка». Сбой — новые строки «удалены», их файлы уберёт `purgeDeleted`.
 */
export async function copyForForward(input: {
  ownerId: string;
  conversationId: string;
  sources: readonly AttachmentRow[];
}): Promise<Map<string, AttachmentRow>> {
  const out = new Map<string, AttachmentRow>();
  if (input.sources.length === 0) return out;
  const planned = input.sources.map((src) => ({ src, id: uuidv7() }));
  const total = input.sources.reduce((sum, s) => sum + s.size, 0);
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`att-pending:${input.ownerId}`}))`);
    await assertDailyRoom(input.ownerId, total, tx);
    return tx
      .insert(attachments)
      .values(
        planned.map(({ src, id }) => ({
          id,
          conversationId: input.conversationId,
          ownerId: input.ownerId,
          storageKey: `dm/${id}`,
          name: src.name,
          contentType: src.contentType,
          size: src.size,
        })),
      )
      .returning();
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  try {
    for (const { src, id } of planned) {
      const row = byId.get(id);
      if (!row) throw new Error('строка копии вложения не вернулась');
      await withTimeout(copyStored(src.storageKey, row.storageKey, src.contentType), copyTimeoutMs(src.size));
      out.set(src.id, row);
    }
  } catch (e) {
    await discardForwardCopies(rows.map((r) => r.id)).catch(() => {});
    throw e;
  }
  return out;
}

/**
 * Бросить копии пересылки, которые не понадобились (повтор, отказ, сбой): только ещё незавершённые → «удалено», файлы — в
 * фоне, как после надгробия. Привязанные к сообщению не трогаются.
 */
export async function discardForwardCopies(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const dead = await db
    .update(attachments)
    .set({ state: 'deleted', deletedAt: new Date() })
    .where(and(inArray(attachments.id, [...ids]), eq(attachments.state, 'pending')))
    .returning({ key: attachments.storageKey });
  if (dead.length > 0) void purgeDeleted(dead.map((d) => d.key)).catch(() => {});
}

/**
 * Суточная уборка: незавершённые загрузки старше `PENDING_TTL_HOURS` → `deleted`; все `deleted` (включая недоудалённые
 * после надгробия) — файл и строка. Возвращает число удалённых файлов.
 */
export async function purgeAttachments(): Promise<number> {
  if (!attachmentStore.ready()) return 0;
  await db
    .update(attachments)
    .set({ state: 'deleted', deletedAt: new Date() })
    .where(and(eq(attachments.state, 'pending'), lt(attachments.createdAt, sql`now() - make_interval(hours => ${PENDING_TTL_HOURS})`)));
  const rows = await db
    .select({ key: attachments.storageKey })
    .from(attachments)
    .where(eq(attachments.state, 'deleted'))
    .limit(1000);
  return purgeDeleted(rows.map((r) => r.key));
}

/**
 * Файлы человека, уже помеченные «удалено», — сейчас, а не часовой уборкой: удаление аккаунта (файлы его отложенных
 * сообщений, `conv10`, помечает `accountRows.anonymizeAccountRows`), после фиксации. Сбой — подберёт уборка.
 */
export async function purgeDeletedOf(ownerId: string): Promise<number> {
  const rows = await db
    .select({ key: attachments.storageKey })
    .from(attachments)
    .where(and(eq(attachments.ownerId, ownerId), eq(attachments.state, 'deleted')))
    .limit(1000);
  return purgeDeleted(rows.map((r) => r.key));
}

/** Строки вложений по id — для привязки к сообщению и выдачи. */
export async function attachmentsByIds(ids: readonly string[]) {
  if (ids.length === 0) return [];
  return db.select().from(attachments).where(inArray(attachments.id, [...ids]));
}

// ─── «Мои GIF» (Р-7, `gifs1`) ───────────────────────────────────────────────────────────────────────────────────────
// Файл сохранённого GIF — своя копия в закрытом хранилище (`gif/<id>`); ссылка подписана тем же ключом, что у вложений,
// но с приставкой `gif:` в подписываемом id: подпись вложения на GIF не подходит, и наоборот.

/** Ссылка на файл «Моего GIF» для его владельца (`routes/gifs.ts`, путь `/api/gifs/<id>/<смотрящий>/<подпись>`). */
export function gifLink(gifId: string, viewerId: string, tokenGen: number): string {
  return `${env.publicApiUrl}/api/gifs/${gifId}/${viewerId}/${attSig(attKey(), `gif:${gifId}`, viewerId, tokenGen)}`;
}

/** Подлинна ли подпись ссылки «Моего GIF». */
export function gifSigValid(gifId: string, viewerId: string, tokenGen: number, sig: string): boolean {
  return attSigValid(attKey(), `gif:${gifId}`, viewerId, tokenGen, sig);
}

/** Скопировать файл закрытого хранилища (сохранить GIF из ленты) — с тем же сроком, что у копий пересылки. */
export function copyStoredFile(fromKey: string, toKey: string, mime: string): Promise<void> {
  return withTimeout(copyStored(fromKey, toKey, mime), COPY_TIMEOUT_MS);
}
