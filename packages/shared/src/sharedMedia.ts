/**
 * Общие медиа беседы (08.10, #211, G29, признак сервера `media1`) — вкладки профиля «Медиа / Файлы / Ссылки / GIF /
 * Голосовые», как у Telegram (tweb `appSearchSuper.ts` / `sidebarRight/tabs/sharedMedia.tsx`: фильтры
 * `inputMessagesFilterPhotoVideo`, `Document`, `Url`, `Gif`, `Voice`; Web A `right/Profile.tsx` `TABS`).
 *
 * Вид вложения — из того, что уже едет с ним: огибающая голосового, подсказки `gif` / `asFile`, тип файла. Те же
 * правила на сервере — SQL-функция `gv_media_count` (миграции 0108, 0125): менять вместе.
 */
import type { Attachment, ConvMessage } from './types';

export type SharedMediaKind = 'media' | 'file' | 'link' | 'gif' | 'voice';

/** Порядок вкладок — как у Web A (`Profile.tsx` `TABS`: media, documents, links, gif; voice — отдельной вкладкой). */
export const SHARED_MEDIA_KINDS: readonly SharedMediaKind[] = ['media', 'file', 'link', 'gif', 'voice'];

/** Порция списка (tweb `appSearchSuper.ts` `LOAD_COUNT = 50`). */
export const SHARED_MEDIA_PAGE = 50;

/**
 * Вид одного вложения. Ссылок у вложений нет — они в тексте (`messageLinks`). Кружок (`round`, видео) — `voice`, как у Telegram
 * (`inputMessagesFilterRoundVoice`: голосовые и видеосообщения одной вкладкой; решение владельца 08.10, миграция 0125).
 */
export function sharedMediaKindOf(
  a: Pick<Attachment, 'contentType' | 'waveform' | 'gif' | 'asFile' | 'round'>,
): Exclude<SharedMediaKind, 'link'> {
  const ct = a.contentType ?? '';
  if (a.round === true && ct.startsWith('video/')) return 'voice';
  if (Array.isArray(a.waveform) && a.waveform.length > 0 && ct.startsWith('audio/')) return 'voice';
  if (a.gif === true) return 'gif';
  if ((ct.startsWith('image/') || ct.startsWith('video/')) && a.asFile !== true) return 'media';
  return 'file';
}

/** Ссылки текста по порядку, без повторов; хвостовая пунктуация — не часть адреса (как `composerPreviewLink` клиента). */
export function messageLinks(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/https?:\/\/[^\s<>"]+/gi) ?? []) {
    const url = raw.replace(/[.,;:!?)\]]+$/, '');
    if (url.length > 'https://'.length && !out.includes(url)) out.push(url);
  }
  return out;
}

/** Сколько всего каждого вида в беседе (`GET /api/conv/:id/media/counts`); у ссылок — сообщений со ссылками. */
export type SharedMediaCounts = Record<SharedMediaKind, number>;

/** Порция списка (`GET /api/conv/:id/media?kind=…`): сообщения, новые первыми; `next` — курсор следующей порции. */
export interface SharedMediaResponse {
  messages: ConvMessage[];
  next: string | null;
}
