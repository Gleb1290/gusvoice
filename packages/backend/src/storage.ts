import * as Minio from 'minio';
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
