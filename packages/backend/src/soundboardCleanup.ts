import { asc, eq, lte } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db } from './db/index.js';
import { soundboardCleanup } from './db/schema.js';
import { env } from './env.js';
import { audioExt } from './storageRules.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const CLEANUP_INTERVAL_MS = 5_000;
const UPLOAD_GRACE_MS = 5 * 60_000;

export async function scheduleSoundboardUploadCleanup(serverId: string, clipId: string, mime: string, stamp: number) {
  // Тот же адрес, который создаёт putSound. Записываем его до обращения к S3: запись переживёт
  // обрыв соединения после приёма объекта и откат транзакции публикации клипа.
  const url = `${env.minio.publicUrl}/${env.minio.bucket}/sounds/${serverId}-sb-${clipId}-${stamp}.${audioExt(mime)}`;
  await db.insert(soundboardCleanup).values({ clipId, serverId, url, nextAttemptAt: new Date(stamp + UPLOAD_GRACE_MS) });
}

export async function lockSoundboardUpload(tx: Tx, clipId: string): Promise<void> {
  const [job] = await tx.select({ clipId: soundboardCleanup.clipId }).from(soundboardCleanup)
    .where(eq(soundboardCleanup.clipId, clipId)).for('update');
  if (!job) throw new Error('soundboard upload cleanup reservation expired');
}

export async function finishSoundboardUpload(tx: Tx, clipId: string): Promise<void> {
  await tx.delete(soundboardCleanup).where(eq(soundboardCleanup.clipId, clipId));
}

type RemoveSoundboardObject = (serverId: string, clipId: string, url: string) => Promise<unknown>;

export async function runSoundboardCleanupJob(
  removeObject: RemoveSoundboardObject,
  onError: (error: unknown) => void,
  now = new Date(),
): Promise<boolean> {
  const result = await db.transaction(async (tx) => {
    const [job] = await tx.select().from(soundboardCleanup)
      .where(lte(soundboardCleanup.nextAttemptAt, now))
      .orderBy(asc(soundboardCleanup.nextAttemptAt), asc(soundboardCleanup.clipId))
      .limit(1).for('update', { skipLocked: true });
    if (!job) return { processed: false } as const;

    try {
      await removeObject(job.serverId, job.clipId, job.url);
    } catch (error) {
      const failures = Math.min(job.failures + 1, 7);
      const delay = Math.min(CLEANUP_INTERVAL_MS * 2 ** (failures - 1), UPLOAD_GRACE_MS);
      await tx.update(soundboardCleanup).set({ failures, nextAttemptAt: new Date(now.getTime() + delay) })
        .where(eq(soundboardCleanup.clipId, job.clipId));
      return { processed: true, failure: { error } } as const;
    }

    await tx.delete(soundboardCleanup).where(eq(soundboardCleanup.clipId, job.clipId));
    return { processed: true } as const;
  });

  if (result.failure) onError(result.failure.error);
  return result.processed;
}

export function startSoundboardCleanup(removeObject: RemoveSoundboardObject, logger: Pick<FastifyBaseLogger, 'error'>): () => void {
  const onError = (err: unknown) => logger.error({ err }, 'soundboard cleanup failed');
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (let i = 0; i < 25; i += 1) {
        if (!await runSoundboardCleanupJob(removeObject, onError)) break;
      }
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), CLEANUP_INTERVAL_MS);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
