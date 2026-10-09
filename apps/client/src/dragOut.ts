/**
 * Перетаскивание сообщений ЛС (08.10, #211, G76) — правила без DOM, чтобы их можно было проверять отдельно.
 *
 * Источник — Telegram Desktop: `history_inner_widget.cpp` (`performDrag` собирает `QMimeData` из выделенных сообщений либо из
 * одной цели под курсором: текст, ссылки, файл) и `dialogs_inner_widget.cpp` (`dragEnterEvent` / `dropEvent`: сообщения,
 * брошенные на строку беседы, уходят в «пересылку» этой беседы). У нас при броске на строку открывается окно «Переслать в…»
 * с этой беседой, уже отмеченной (решение владельца 08.10: пересылка по броску не уходит молча, а ждёт «Отправить»).
 *
 * Что кладём в `DataTransfer` при `dragstart` (`MessagePane.tsx`):
 *  - `text/plain` — текст сообщений (как «Скопировать» выделенного);
 *  - `DownloadURL` + `text/uri-list` — если тянут ровно одно сообщение с одним вложением: Chromium / Edge сам скачает файл
 *    в проводник или другое приложение (Firefox и Safari `DownloadURL` не знают — для них остаётся ссылка);
 *  - `application/x-gusvoice-messages` — `{ conv, ids }`, по нему строка беседы понимает бросок.
 */

/** Свой тип данных перетаскивания: список сообщений одной беседы. */
export const DRAG_MSG_MIME = 'application/x-gusvoice-messages';

/** Пачка сообщений не больше, чем умеет выделение и пачка сервера (`SELECT_MAX` в `MessagePane`). */
export const DRAG_MSG_MAX = 100;

/** Что тащим: беседа-источник и id сообщений в порядке ленты. */
export interface MsgDragPayload {
  conv: string;
  ids: string[];
}

export function encodeMsgDrag(p: MsgDragPayload): string {
  return JSON.stringify({ conv: p.conv, ids: p.ids });
}

/** Разобрать свой тип; чужое, битое и пустое — `null` (на строку может упасть что угодно из другого приложения). */
export function parseMsgDrag(raw: string): MsgDragPayload | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const { conv, ids } = v as { conv?: unknown; ids?: unknown };
  if (typeof conv !== 'string' || !conv) return null;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > DRAG_MSG_MAX) return null;
  if (!ids.every((x) => typeof x === 'string' && x.length > 0)) return null;
  return { conv, ids: ids as string[] };
}

/** В `dragenter` / `dragover` содержимое не читается, видны только типы: есть ли среди них наш. */
export function hasMsgDrag(types: ArrayLike<string> | null | undefined): boolean {
  return !!types && Array.prototype.includes.call(types, DRAG_MSG_MIME);
}

/**
 * Какие сообщения уйдут с пузырём `rowId`. Режим выделения: тянут выбранное — всё выбранное по порядку ленты; невыбранную
 * строку не тянем (протяжка по ней выделяет диапазон), `null`. Вне выделения — одно это сообщение.
 */
export function dragIds(rowId: string, picked: readonly string[], order: readonly string[], selecting: boolean): string[] | null {
  if (!selecting) return [rowId];
  if (!picked.includes(rowId)) return null;
  const set = new Set(picked);
  const ids = order.filter((id) => set.has(id));
  return ids.length ? ids : null;
}

/** Значение `DownloadURL`: `тип:имя:адрес` (формат Chromium). Двоеточие в имени ломает разбор — заменяем; адрес — абсолютный http(s). */
export function downloadUrlValue(contentType: string, name: string, url: string, base: string): string | null {
  let abs: URL;
  try {
    abs = new URL(url, base);
  } catch {
    return null;
  }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
  const safe = name.replace(/[:\\/\r\n]+/g, '_').trim() || 'file';
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(contentType) ? contentType : 'application/octet-stream';
  return `${type}:${safe}:${abs.href}`;
}

/**
 * Можно ли начать перетаскивание сообщения за это место. Текст сообщения — для выделения мышью, ссылка и картинка тащатся
 * сами (браузер кладёт адрес / файл), поля и кнопки — свои. За пузырь вне этих мест (поля, время, подпись) — тащим сообщение.
 * `zone` — признаки места нажатия, собранные из DOM вызывающим.
 */
export function grabsMessage(zone: { text: boolean; link: boolean; image: boolean; own: boolean }): boolean {
  return !zone.text && !zone.link && !zone.image && !zone.own;
}

/** Бросок сообщений на строку беседы: источник → получатель (`to`), слушает лента-источник (`onForwardDrop`). */
const FORWARD_DROP = 'gv-forward-drop';

export function requestForwardDrop(p: MsgDragPayload, to: string): void {
  window.dispatchEvent(new CustomEvent<{ payload: MsgDragPayload; to: string }>(FORWARD_DROP, { detail: { payload: p, to } }));
}

export function onForwardDrop(fn: (p: MsgDragPayload, to: string) => void): () => void {
  const h = (e: Event) => {
    const d = (e as CustomEvent<{ payload: MsgDragPayload; to: string }>).detail;
    if (d?.payload) fn(d.payload, d.to);
  };
  window.addEventListener(FORWARD_DROP, h);
  return () => window.removeEventListener(FORWARD_DROP, h);
}
