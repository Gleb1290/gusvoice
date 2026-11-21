import { attachmentBlocked } from '../storageRules.js';
import { WEBHOOK_FILE_MAX_BYTES, WEBHOOK_FILES_MAX } from '../webhookRules.js';
import { BotApiError } from './botRules.js';

export function validateChannelFiles(files: readonly { name: string; mime: string; buffer: { length: number } }[]): number {
  if (files.length > WEBHOOK_FILES_MAX || files.some((file) => file.buffer.length > WEBHOOK_FILE_MAX_BYTES)) {
    throw new BotApiError(413, 'Bad Request: too many files or file too large');
  }
  if (files.some((file) => attachmentBlocked(file.mime, file.name))) {
    throw new BotApiError(415, 'Bad Request: this file type is not allowed (SVG/HTML)');
  }
  return files.reduce((total, file) => total + file.buffer.length, 0);
}

export type ChannelMessagePersistence = 'inserting' | 'stored';

interface ChannelUpload {
  put(): Promise<void>;
  remove(): Promise<void>;
}

/** Откатываем лишь новые объекты и лишь пока известно, что они не принадлежат сохранённому сообщению. */
export async function sendWithChannelUploads<T>(
  uploads: readonly ChannelUpload[],
  send: (onPersistence: (state: ChannelMessagePersistence) => void) => Promise<T>,
  isStored: () => Promise<boolean>,
  onCleanupError: (error: unknown) => void,
): Promise<T> {
  const attempted: ChannelUpload[] = [];
  let persistence: ChannelMessagePersistence | undefined;
  try {
    for (const upload of uploads) {
      attempted.push(upload);
      await upload.put();
    }
    return await send((state) => { persistence = state; });
  } catch (error) {
    if (persistence === 'stored') throw error;
    if (persistence === 'inserting') {
      const stored = await isStored().catch((checkError: unknown) => {
        onCleanupError(checkError);
        return true;
      });
      if (stored) throw error;
    }
    for (const upload of attempted) {
      try {
        await upload.remove();
      } catch (cleanupError) {
        onCleanupError(cleanupError);
      }
    }
    throw error;
  }
}
