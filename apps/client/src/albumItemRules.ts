import { FEATURE_ALBUM1, type Attachment } from '@gusvoice/shared';

const isImage = (ct: string) => ct.startsWith('image/');
const isVideo = (ct: string) => ct.startsWith('video/');

/**
 * Один элемент альбома (G56, признак сервера `album1`; 13.10). У Telegram элемент альбома — отдельное сообщение с общим
 * `grouped_id`: tdesktop по правому клику на элементе (`HistoryView::FillContextMenu`, `PointState::GroupPart`) пересылает и
 * удаляет ЕГО одного, в просмотрщике (`OverlayWidget`, Android `PhotoViewer`) «Переслать»/«Удалить» — тоже текущий элемент;
 * Android по долгому нажатию в ленте берёт альбом целиком (`ChatActivity`, `selectedObjectGroup`). У нас альбом — одно
 * сообщение со списком вложений, сервер убирает/пересылает элемент отдельной ручкой. Чистые правила — без React.
 */

/** Сервер умеет действия над одним элементом альбома. */
export function serverAlbumItems(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_ALBUM1);
}

/**
 * Элемент `att` сообщения можно взять по одному: альбом (два и больше фото/видео в ленте), у элемента есть `id` (старые
 * публичные вложения до шага 1в назвать нечем), копия с другого инстанса уже доехала. Одиночное фото — это и есть
 * сообщение: его действия — обычные «Переслать»/«Удалить» сообщения.
 */
export function isAlbumItem(attachments: readonly Attachment[] | undefined, att: Attachment | undefined): att is Attachment {
  if (!att?.id || att.fedState === 'copying' || att.once === true) return false;
  const media = (attachments ?? []).filter((a) => !a.asFile && (isImage(a.contentType) || isVideo(a.contentType)));
  return media.length >= 2 && media.includes(att);
}

/** Ячейка альбома под указателем (`.att-img-link`): фото — по `<img src>`, видео — по `<video src>`; вне ячейки — `undefined`. */
export function albumCellFromTarget(attachments: readonly Attachment[] | undefined, target: Element | null): Attachment | undefined {
  const cell = target?.closest('.att-img-link');
  if (!cell) return undefined;
  const src = cell.querySelector('img')?.getAttribute('src') ?? cell.querySelector('video')?.getAttribute('src');
  if (!src) return undefined;
  // Видео без автозапуска рисует первый кадр через `#t=0.1` (`VideoAttachment.tsx`) — сверяем адрес без фрагмента.
  const bare = src.split('#')[0];
  return attachments?.find((a) => a.url === src || a.url === bare);
}

/** Слово элемента в пунктах и окне: «фото» / «видео». */
export function albumItemNoun(att: Pick<Attachment, 'contentType'>): 'фото' | 'видео' {
  return isVideo(att.contentType) ? 'видео' : 'фото';
}

/** Текст отказа 409 `album_item_peer_old`: дом собеседника с другого инстанса не понимает меньший список вложений. */
export const ALBUM_ITEM_PEER_OLD_TEXT =
  'Сервер собеседника пока не умеет убирать одно фото у обоих. Удалите сообщение целиком или уберите фото только у себя.';
