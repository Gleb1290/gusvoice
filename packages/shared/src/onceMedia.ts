import { isOnceMedia, isRoundVideo } from './voiceMessage';
import { PHOTO_ONCE_SPENT_TEXT, ROUND_ONCE_SPENT_TEXT, VIDEO_ONCE_SPENT_TEXT, VOICE_ONCE_SPENT_TEXT } from './ws';

/**
 * Запасная фраза потраченного «один раз» (`ConvMessage.voiceOnceSpent`) по составу вложений: кружок — «Видеосообщение
 * просмотрено», одноразовое фото/видео (`ttlmedia1`, #226) — «Фото/Видео истекло» (как Telegram «Expired photo», решение владельца 19.10), иначе голосовое. Отдельно от
 * `voiceMessage.ts`: тот исполняется проверками без зависимостей.
 */
export function onceSpentText(list: readonly { once?: true; contentType: string; asFile?: true; gif?: true; round?: true }[]): string {
  if (list.some(isRoundVideo)) return ROUND_ONCE_SPENT_TEXT;
  const media = list.find(isOnceMedia);
  if (media) return media.contentType.startsWith('video/') ? VIDEO_ONCE_SPENT_TEXT : PHOTO_ONCE_SPENT_TEXT;
  return VOICE_ONCE_SPENT_TEXT;
}
