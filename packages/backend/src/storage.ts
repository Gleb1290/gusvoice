import type { Readable } from 'node:stream';
import * as Minio from 'minio';
import { policyGrantsPublic } from './attachmentRules.js';
import { env } from './env.js';
import {
  attachmentExt,
  audioExt,
  bucketRetryDelayMs,
  contentDisposition,
  mediaExt,
  startRetryUntilOk,
  urlBelongsToBucket,
} from './storageRules.js';

// Чистые предикаты живут в `storageRules.ts` (там же — почему). Реэкспорт, чтобы роуты продолжали
// брать их из `storage.js`: это I/O-модуль, но для вызывающих он остаётся одной точкой входа.
export { attachmentBlocked, isSupportedAudio, isSupportedImage, resolveAudioMime } from './storageRules.js';

// S3 (MinIO) media storage. One public-read bucket (env.minio.bucket, default
// "gusvoice") holds everything under category prefixes:
//   avatars/        user avatars
//   channel-icons/  server & channel icons        (future)
//   stickers/       custom per-server stickers     (future)
//   emoji/          custom per-server emoji         (future)
// Null when not configured (uploads then 503).
export const minio = env.minio.endpoint
  ? new Minio.Client({
      endPoint: env.minio.endpoint,
      port: env.minio.port,
      useSSL: env.minio.useSSL,
      accessKey: env.minio.accessKey,
      secretKey: env.minio.secretKey,
    })
  : null;

export function storageConfigured(): boolean {
  return !!minio;
}

/** `urlBelongsToBucket` с нашей конфигурацией — защита от чужого URL во вложении (#4, P1-2). */
export function isOwnMediaUrl(url: string): boolean {
  return urlBelongsToBucket(url, env.minio.publicUrl, env.minio.bucket);
}

/**
 * Прочитать НАШ объект из хранилища в память (F2, §5.4 — отдача аватара соседу).
 *
 * 🔴 Адрес обязан быть нашим (`isOwnMediaUrl`) и разбирается на бакет и ключ здесь же: иначе сюда
 * можно было бы передать чужой URL и заставить нас читать что угодно чужими руками.
 * ⚠️ Предел размера обязателен: объект читается В ПАМЯТЬ, и «просто отдать файл» без предела — это
 * способ съесть память инстанса одним запросом.
 */
export async function readOwnMedia(
  url: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!minio || !isOwnMediaUrl(url)) return null;
  const prefix = `${env.minio.publicUrl.replace(/\/+$/, '')}/${env.minio.bucket}/`;
  if (!url.startsWith(prefix)) return null;
  const key = decodeURIComponent(url.slice(prefix.length));
  if (key.length === 0) return null;

  const stat = await minio.statObject(env.minio.bucket, key).catch(() => null);
  if (!stat) return null;
  if (stat.size > maxBytes) return null;

  const stream = await minio.getObject(env.minio.bucket, key);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    size += buf.length;
    // Размер известен заранее, но проверяем и по ходу: объект мог смениться между stat и чтением.
    if (size > maxBytes) return null;
    chunks.push(buf);
  }
  const contentType = String(stat.metaData?.['content-type'] ?? 'application/octet-stream');
  return { bytes: Buffer.concat(chunks), contentType };
}

/** Один заход: бакет есть и публично читается (только GetObject — без листинга). */
async function prepareMediaBucket(client: Minio.Client): Promise<void> {
  if (!(await client.bucketExists(env.minio.bucket))) {
    await client.makeBucket(env.minio.bucket);
  }
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${env.minio.bucket}/*`],
      },
    ],
  };
  await client.setBucketPolicy(env.minio.bucket, JSON.stringify(policy));
}

/**
 * Ensure the media bucket exists and is publicly readable (run at startup).
 *
 * Первая попытка — до `listen`, как было. Не вышло (хранилище ещё поднимается) — дальше повторяем в
 * фоне по `bucketRetryDelayMs`, не задерживая старт: бакет-то чаще всего уже есть, и загрузки
 * заработают сами, как только хранилище ответит (#137 S1).
 */
export async function ensureMediaBucket(): Promise<void> {
  if (!minio) {
    console.warn('[storage] MinIO not configured (MINIO_ENDPOINT empty) — media upload disabled.');
    return;
  }
  const client = minio;
  await startRetryUntilOk({
    run: () => prepareMediaBucket(client),
    delayMs: bucketRetryDelayMs,
    schedule: (next, ms) => {
      setTimeout(next, ms).unref();
    },
    onFailure: (failures, delay, e) =>
      console.error(
        `[storage] bucket setup failed (attempt ${failures}), retrying in ${Math.round(delay / 1000)}s:`,
        (e as Error).message,
      ),
    onSuccess: (failures) => {
      const after = failures ? ` after ${failures + 1} attempts` : '';
      console.log(`[storage] bucket "${env.minio.bucket}" ready (public-read) at ${env.minio.endpoint}${after}.`);
    },
  });
}

// ─── Закрытый бакет файлов ЛС (шаг 1в) ────────────────────────────────────────────────────────────────────────────

let privateReady = false;

/** Закрытые файлы ЛС можно принимать и отдавать: хранилище настроено, бакет создан и проверен (без политики для всех). */
export function privateStorageReady(): boolean {
  return !!minio && privateReady;
}

/**
 * Один заход: закрытый бакет есть и НИКОМУ, кроме бэкенда, не открыт.
 *
 * 🔴 Политику на него не ставим никогда (в отличие от `prepareMediaBucket`). Совпал по имени с публичным или на нём
 * нашлась политика «для всех» — это отказ, а не предупреждение: `/api/download/attachment` и публичный адрес хранилища
 * отдали бы такие файлы кому угодно. Закрытые файлы тогда выключены, загрузки в ЛС отвечают 503.
 */
async function preparePrivateBucket(client: Minio.Client): Promise<void> {
  const bucket = env.minio.privateBucket;
  if (bucket === env.minio.bucket) throw new Error(`MINIO_PRIVATE_BUCKET совпадает с публичным бакетом «${bucket}»`);
  if (!(await client.bucketExists(bucket))) await client.makeBucket(bucket);
  // Нет политики — S3 отвечает ошибкой NoSuchBucketPolicy: это и есть нужное состояние. Любая ДРУГАЯ ошибка — не
  // «политики нет», а «не знаем»: бросаем, попытка повторится (иначе сбой чтения политики открывал бы дорогу).
  const policy = await client.getBucketPolicy(bucket).catch((e: { code?: string }) => {
    if (e?.code === 'NoSuchBucketPolicy') return '';
    throw e;
  });
  if (policyGrantsPublic(policy)) throw new Error(`на закрытом бакете «${bucket}» висит политика, открывающая его всем`);
  privateReady = true;
}

let lastOnDemand = 0;

/**
 * Подготовить закрытый бакет прямо сейчас (не чаще раза в 30 с) — для загрузки, пришедшей, пока фоновые повторы ещё
 * ждут своей очереди: хранилище поднялось позже бэкенда (ревью 30.09), а следующая плановая попытка — через минуты.
 */
export async function tryPreparePrivateNow(): Promise<boolean> {
  if (privateReady || !minio || !env.publicApiUrl) return privateReady;
  const now = Date.now();
  if (now - lastOnDemand < 30_000) return false;
  lastOnDemand = now;
  await preparePrivateBucket(minio).catch(() => {});
  return privateReady;
}

/** Подготовить закрытый бакет при старте; не вышло — повторяем в фоне, как публичный (`ensureMediaBucket`). */
export async function ensurePrivateBucket(): Promise<void> {
  if (!minio) return;
  if (!env.publicApiUrl) {
    console.warn('[storage] PUBLIC_API_URL/VITE_API_URL пуст — закрытые файлы ЛС выключены (ссылки /api/att не собрать).');
    return;
  }
  const client = minio;
  await startRetryUntilOk({
    run: () => preparePrivateBucket(client),
    delayMs: bucketRetryDelayMs,
    schedule: (next, ms) => {
      setTimeout(next, ms).unref();
    },
    onFailure: (failures, delay, e) =>
      console.error(
        `[storage] private bucket setup failed (attempt ${failures}), retrying in ${Math.round(delay / 1000)}s:`,
        (e as Error).message,
      ),
    onSuccess: () => console.log(`[storage] private bucket "${env.minio.privateBucket}" ready (no public policy).`),
  });
}

/** Положить файл ЛС в закрытый бакет. Заголовки выдачи ставит бэкенд при отдаче (`routes/att.ts`), не хранилище. */
export async function putPrivate(key: string, bytes: Buffer, mime: string): Promise<void> {
  if (!minio) throw new Error('storage not configured');
  await minio.putObject(env.minio.privateBucket, key, bytes, bytes.length, { 'Content-Type': mime });
}

/** Размер файла ЛС; `null` — объекта нет. */
export async function statPrivate(key: string): Promise<{ size: number } | null> {
  if (!minio) return null;
  const st = await minio.statObject(env.minio.privateBucket, key).catch(() => null);
  return st ? { size: st.size } : null;
}

/** Поток файла ЛС целиком или диапазона (границы включительно) — для перемотки голосовых. */
export async function getPrivate(key: string, range?: { start: number; end: number }): Promise<Readable> {
  if (!minio) throw new Error('storage not configured');
  return range
    ? minio.getPartialObject(env.minio.privateBucket, key, range.start, range.end - range.start + 1)
    : minio.getObject(env.minio.privateBucket, key);
}

/** Удалить файл ЛС. Отсутствующий объект — не ошибка (повтор уборки после частичного сбоя). */
export async function removePrivate(key: string): Promise<void> {
  if (!minio) throw new Error('storage not configured');
  await minio.removeObject(env.minio.privateBucket, key);
}

/** Upload a custom server sound (one per server+event) and return its public URL. */
export async function putSound(
  serverId: string,
  /**
   * Что именно кладём: имя события (`join`, `leave`, …) либо сэмпл саундборда (`sb-<id>`).
   * ⚠️ Раньше параметр звался `event` — переименован, когда тем же путём поехал саундборд: имя
   * `event` подталкивало бы к отдельному хранилищу там, где схема ключей ровно та же.
   */
  slot: string,
  buffer: Buffer,
  mime: string,
  stamp: number,
): Promise<string> {
  if (!minio) {
    throw Object.assign(new Error('media storage not configured'), { statusCode: 503 });
  }
  const key = `sounds/${serverId}-${slot}-${stamp}.${audioExt(mime)}`;
  await minio.putObject(env.minio.bucket, key, buffer, buffer.length, { 'Content-Type': mime });
  return `${env.minio.publicUrl}/${env.minio.bucket}/${key}`;
}

/**
 * Upload a media object under a category prefix and return its public URL.
 * `category` e.g. 'avatars' | 'channel-icons' | 'stickers' | 'emoji'.
 */
export async function putMedia(
  category: string,
  id: string,
  buffer: Buffer,
  mime: string,
  stamp: number,
): Promise<string> {
  if (!minio) {
    throw Object.assign(new Error('media storage not configured'), { statusCode: 503 });
  }
  const key = `${category}/${id}-${stamp}.${mediaExt(mime)}`;
  await minio.putObject(env.minio.bucket, key, buffer, buffer.length, { 'Content-Type': mime });
  return `${env.minio.publicUrl}/${env.minio.bucket}/${key}`;
}

/**
 * Удалить ВСЕ файлы аватаров человека — обычные и анимированные, включая прежние (замена аватара старый
 * файл не удаляет). Зовётся при удалении аккаунта (F0 #139): картинка лица — личные данные.
 *
 * ⚠️ Префикс `avatars/<id>-` однозначен: id — UUID фиксированной длины, так что чужой id не может
 * начинаться с `<id>-`. Анимированный аватар лежит там же как `avatars/<id>-anim-<stamp>` (`users.ts`).
 */
export async function removeUserAvatars(userId: string): Promise<number> {
  if (!minio || !userId) return 0;
  const names: string[] = [];
  for await (const obj of minio.listObjectsV2(env.minio.bucket, `avatars/${userId}-`, true)) {
    if (obj.name) names.push(obj.name);
  }
  for (const name of names) await minio.removeObject(env.minio.bucket, name);
  return names.length;
}

/**
 * Удалить НАШ объект по его публичному адресу — прежний аватар соседа при замене, картинку по
 * надгробию каталога (аудит 19.09, F-05). Адрес обязан быть нашим — та же проверка, что у чтения.
 */
export async function removeOwnMedia(url: string): Promise<number> {
  if (!minio || !isOwnMediaUrl(url)) return 0;
  const prefix = `${env.minio.publicUrl.replace(/\/+$/, '')}/${env.minio.bucket}/`;
  if (!url.startsWith(prefix)) return 0;
  const key = decodeURIComponent(url.slice(prefix.length));
  if (key.length === 0) return 0;
  // Размер — чтобы вернуть место в квоту связки (ревью #195 п. 7); объекта уже нет — вернуть нечего.
  let size = 0;
  try {
    size = (await minio.statObject(env.minio.bucket, key)).size;
  } catch {
    size = 0;
  }
  await minio.removeObject(env.minio.bucket, key);
  return size;
}

/** Convenience wrapper for user avatars. */
export function uploadAvatar(userId: string, buffer: Buffer, mime: string, stamp: number): Promise<string> {
  return putMedia('avatars', userId, buffer, mime, stamp);
}

/** Upload a chat attachment (any file type) and return its public URL, keeping the file's extension. */
export async function putAttachment(
  id: string,
  buffer: Buffer,
  mime: string,
  filename: string,
  stamp: number,
): Promise<string> {
  if (!minio) {
    throw Object.assign(new Error('media storage not configured'), { statusCode: 503 });
  }
  const key = `attachments/${id}-${stamp}.${attachmentExt(filename, mime)}`;
  await minio.putObject(env.minio.bucket, key, buffer, buffer.length, {
    'Content-Type': mime,
    'Content-Disposition': contentDisposition(mime, filename),
  });
  return `${env.minio.publicUrl}/${env.minio.bucket}/${key}`;
}
