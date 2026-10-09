import type { Attachment } from '@gusvoice/shared';
import { attachmentKey } from './fileActions';

/**
 * Спойлер у вложения (08.10, #211, G48, признак сервера `media2`; Telegram Desktop `send_files_box.cpp` `toggleSpoilers`,
 * Android `MediaController` — спойлер у фото и видео). ЧИСТЫЕ правила + память «уже открыл» (в сеансе, у каждого смотрящего
 * своя; при перезапуске клиента спойлер снова закрыт — как у Telegram).
 *
 * Спойлер применяется только к фото и видео, показанным кадром: у карточки файла («Отправить как файл») пометки нет.
 */

/** Есть ли у вложения пометка спойлера, которую клиент уважает (фото или видео, не «как файл»). */
export function spoilerApplies(a: Pick<Attachment, 'spoiler' | 'asFile' | 'contentType'>): boolean {
  return a.spoiler === true && a.asFile !== true && (a.contentType.startsWith('image/') || a.contentType.startsWith('video/'));
}

const revealed = new Set<string>();
const listeners = new Set<() => void>();

/** Скрыто ли сейчас: пометка есть и смотрящий ещё не нажимал. */
export function spoilerHidden(a: Pick<Attachment, 'id' | 'url' | 'spoiler' | 'asFile' | 'contentType'>): boolean {
  return spoilerApplies(a) && !revealed.has(attachmentKey(a));
}

/** Снять спойлер у этого вложения (локально, только у смотрящего). */
export function revealSpoiler(a: Pick<Attachment, 'id' | 'url'>): void {
  const k = attachmentKey(a);
  if (revealed.has(k)) return;
  revealed.add(k);
  for (const l of [...listeners]) l();
}

export function subscribeSpoilers(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Только для проверок: забыть снятые спойлеры. */
export function resetSpoilers(): void {
  revealed.clear();
}
