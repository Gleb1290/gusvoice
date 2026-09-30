import type { Readable } from 'node:stream';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { attLink, attSig, attSigValid, deriveAttKey, pendingEvictions, PENDING_TTL_HOURS } from './attachmentRules.js';
import { db } from './db/index.js';
import { attachments } from './db/schema.js';
import { env } from './env.js';
import {
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
}

const s3Store: AttachmentStore = {
  ready: privateStorageReady,
  ensureReady: tryPreparePrivateNow,
  configured: storageConfigured,
  put: putPrivate,
  stat: statPrivate,
  get: getPrivate,
  remove: removePrivate,
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
}): Promise<string> {
  const id = uuidv7();
  const storageKey = `dm/${id}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`att-pending:${input.ownerId}`}))`);
    const existing = await tx
      .select({ id: attachments.id, size: attachments.size })
      .from(attachments)
      .where(and(eq(attachments.ownerId, input.ownerId), eq(attachments.state, 'pending')))
      .orderBy(attachments.createdAt);
    const evict = pendingEvictions(existing, input.bytes.length);
    if (evict.length > 0) {
      await tx.update(attachments).set({ state: 'deleted', deletedAt: new Date() }).where(inArray(attachments.id, evict));
    }
    await tx.insert(attachments).values({
      id,
      conversationId: input.conversationId,
      ownerId: input.ownerId,
      storageKey,
      name: input.name,
      contentType: input.contentType,
      size: input.bytes.length,
    });
  });
  try {
    await attachmentStore.put(storageKey, input.bytes, input.contentType);
  } catch (e) {
    await db.delete(attachments).where(eq(attachments.id, id)).catch(() => {});
    throw e;
  }
  return id;
}

/** Операция с хранилищем не дольше `ms`: у S3-клиента своего таймаута нет, подвисшее хранилище держало бы вызов вечно. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
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

/** Строки вложений по id — для привязки к сообщению и выдачи. */
export async function attachmentsByIds(ids: readonly string[]) {
  if (ids.length === 0) return [];
  return db.select().from(attachments).where(inArray(attachments.id, [...ids]));
}
