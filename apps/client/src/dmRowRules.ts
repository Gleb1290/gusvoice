import { attachmentWords, stripFormatting, type ConvAttachmentKind, type ConvLastMessage } from '@gusvoice/shared';
import { readByPeer } from './bubbleRules';
import type { IconName } from './components/Icon';

/**
 * Строка списка личных бесед (раунд 11, `docs/design/design-step11/HANDOFF.md` §2) — чистые правила: что написать в
 * превью, какое время, какая отметка, что найдено поиском и что прочитает скринридер. Разметка — `DmRow` в
 * `components/DmSidebar.tsx`, стили — блок «Раунд 11» после «Direct messages» в `styles.css`.
 *
 * Строка знает ровно то, что знает список (HANDOFF §2.6): имя, аватар, в сети ли собеседник, последнее сообщение из
 * сводки сервера (`ConvLastMessage`: одна строка до 200 знаков, число вложений и — с раунда 11 — их вид), его время,
 * чьё оно и прочитал ли собеседник моё (`peerReadKey`, Р6), число непрочитанных, мой черновик (Р7), «печатает».
 * Неотправленное из своей очереди («!», решение владельца 04.10) — флаг от вызывающего: это не данные списка.
 */

/** Склонение по числу: 1 вложение, 2–4 вложения, 5–20 вложений, 21 вложение (11–14 — как 5). */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 10;
  const b = Math.abs(n) % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}

/** Одна строка не длиннее `max` знаков (по кодовым точкам) — то же правило, что у превью сервера (`previewText`). */
export function oneLine(s: string, max = 200): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}

// ─── Время последнего сообщения (HANDOFF §2.4) ─────────────────────────────────────────────────────────────────────

/** Часы и минуты — тем же форматом, что время в пузыре (`MessagePane.TIME_FMT`): список и лента не расходятся. */
const TIME = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
/** День недели — по-русски, как весь интерфейс: «сб» → «Сб». */
const WEEKDAY = new Intl.DateTimeFormat('ru', { weekday: 'short' });

export interface DmListTime {
  /** Что видно в строке: «21:08», «Сб», «27.09», «31.12.25». */
  label: string;
  /** Для `<time dateTime>` — полная дата. */
  dateTime: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * Время строки, как в Telegram: сегодня — часы и минуты; последние шесть дней (вчера тоже) — короткий день недели с
 * заглавной; раньше в этом году — день и месяц; в прошлые годы — день, месяц и год двумя цифрами. Дни — календарные, по
 * местному времени (полночь, а не «24 часа назад»). Время из будущего (часы устройства отстают) — как сегодня. Нет
 * времени или оно не разбирается — `null`.
 */
export function dmListTime(iso: string | null | undefined, now: number = Date.now()): DmListTime | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const today = new Date(now);
  const days = Math.round((dayStart(today) - dayStart(d)) / 86_400_000);
  let label: string;
  if (days <= 0) label = TIME.format(d);
  else if (days <= 6) {
    const w = WEEKDAY.format(d).replace(/\.$/, '');
    label = w.charAt(0).toUpperCase() + w.slice(1);
  } else {
    const dm = `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
    label = d.getFullYear() === today.getFullYear() ? dm : `${dm}.${pad2(d.getFullYear() % 100)}`;
  }
  return { label, dateTime: d.toISOString() };
}

/** Моложе этого — часы, даже если вчера (Telegram Desktop `FormatDialogsDate`: `kRecentlyInSeconds = 20 * 3600`). */
export const ROW_RECENT_MS = 20 * 3_600_000;
/** Старше этого — дата с годом (Telegram Android `stringForMessageListDate`: 31536000000 мс). */
export const ROW_YEAR_MS = 365 * 86_400_000;
/** Месяцы в родительном падеже коротко — «27 сен» (Android `formatterMonth` «dd MMM» в русской локали). */
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/**
 * Время строки беседы по правилу Telegram (07.10, G34; сверено с исходниками): сегодня ИЛИ моложе 20 часов — часы и
 * минуты (Desktop `ui/text/format_values.cpp: FormatDialogsDate`); календарные 1–6 дней назад — короткий день недели
 * («Сб»; Desktop `daysTo < 7`, Android `dayDiff > -7`); дальше, но моложе года — «27 сен» (Android
 * `LocaleController.stringForMessageListDate`, `formatterDayMonth`); старше года — «31.12.24» (там же, `formatterYear`).
 * Время из будущего — как сегодня. Нет времени или не разбирается — `null`. Прежнее правило (`dmListTime`: полночь
 * отсекает часы, «27.09») остаётся до перевода его проверок.
 */
export function dmRowTime(iso: string | null | undefined, now: number = Date.now()): DmListTime | null {
  if (!iso) return null;
  const d = new Date(iso);
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  const days = Math.round((dayStart(new Date(now)) - dayStart(d)) / 86_400_000);
  let label: string;
  if (days <= 0 || now - t < ROW_RECENT_MS) label = TIME.format(d);
  else if (days <= 6) {
    const w = WEEKDAY.format(d).replace(/\.$/, '');
    label = w.charAt(0).toUpperCase() + w.slice(1);
  } else if (now - t < ROW_YEAR_MS) label = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  else label = `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${pad2(d.getFullYear() % 100)}`;
  return { label, dateTime: d.toISOString() };
}

/** Время из ISO в мс; нет или не разбирается — `null`. */
const msOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Показывать ли черновик в строке (07.10, G34): Telegram Android (`DialogCell`, условие у `getDraft`) прячет черновик,
 * когда ПОСЛЕ него пришло сообщение и оно не прочитано — строка показывает новое. Время черновика неизвестно (только что
 * набран, сервер ещё не ответил) — черновик свежее всего.
 */
export function rowShowsDraft(p: { draftAt: string | null | undefined; lastAt: string | null | undefined; unread: boolean }): boolean {
  if (!p.unread) return true;
  const draft = msOf(p.draftAt);
  const last = msOf(p.lastAt);
  return draft === null || last === null || draft >= last;
}

/**
 * Время, по которому строка встаёт в списке и которое она показывает (07.10, G34): черновик поднимает беседу — у Telegram
 * диалог сортируется по дате черновика, если он новее последнего сообщения, и строка показывает её (Android `DialogCell`:
 * `timeString` от `draftMessage.date`). Черновика нет — последнее сообщение, иначе создание беседы.
 */
export function rowActivityAt(p: { lastMessageAt: string | null; createdAt: string; draftAt?: string | null }): string {
  const base = p.lastMessageAt ?? p.createdAt;
  const draft = msOf(p.draftAt);
  const b = msOf(base);
  return draft !== null && (b === null || draft > b) ? new Date(draft).toISOString() : base;
}

// ─── Превью ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const ATTACHMENT_KINDS: readonly ConvAttachmentKind[] = ['photo', 'voice', 'sticker', 'file'];

export interface DmAttachmentPreview {
  icon: IconName;
  label: string;
}

type LastAttachments = Pick<
  ConvLastMessage,
  'text' | 'attachments' | 'attachmentKind' | 'attachmentDurationMs' | 'attachmentName' | 'attachmentVideo' | 'attachmentGif' | 'attachmentOnce' | 'attachmentRound'
>;

/**
 * Вложение в превью (HANDOFF §2.5). Вложений нет — `null`. Подписи — по правилу цитат раунда 10: у фото с подписью —
 * подпись; у голосового, стикера и файла — что это (подпись к файлу превью не показывает, как в макете).
 * С полем вида (сервер раунда 11): `photo` — «Фото» / «3 фото» («фото» не склоняется), `voice` — «Голосовое сообщение»
 * (без длительности: решение владельца 08.10, как Telegram), `sticker` — «Стикер», `file` — имя файла / «2 файла»; `file` с признаком видео
 * (`attachmentVideo`, 05.10) — значок камеры и «Видео» / «3 видео» («видео» не склоняется).
 * GIF (`attachmentGif`, 08.10) — «GIF», как у Telegram (tdesktop `lng_in_dlg_*`, Android `AttachGif`), у подписанного — подпись.
 * Без поля (сервер до раунда 11, сводка из кеша до его обновления) или с незнакомым видом — скрепка и «Вложение» /
 * «3 вложения», у подписанного — подпись.
 */
export function dmAttachmentPreview(last: LastAttachments): DmAttachmentPreview | null {
  const n = typeof last.attachments === 'number' && Number.isFinite(last.attachments) ? Math.floor(last.attachments) : 0;
  const caption = typeof last.text === 'string' ? last.text.trim() : '';
  // Стикер ЛС (С2, `stickers2`) — не вложение (`attachments: 0`), а текст сводки — его эмодзи: «😎 Стикер», как у Telegram.
  if (last.attachmentKind === 'sticker' && n <= 0) return { icon: 'sticker', label: caption ? `${caption} Стикер` : 'Стикер' };
  if (n <= 0) return null;
  // GIF (`gifs1`, `attachmentGif`): Telegram пишет «GIF» и у `image/gif`, и у GIF-видео (`isAnimation`); подпись — как у фото.
  if (last.attachmentGif === true) {
    return { icon: last.attachmentKind === 'photo' ? 'photo' : 'play', label: caption || (n === 1 ? 'GIF' : `${n} GIF`) };
  }
  const kind = ATTACHMENT_KINDS.includes(last.attachmentKind as ConvAttachmentKind) ? last.attachmentKind : undefined;
  switch (kind) {
    case 'photo':
      return { icon: 'photo', label: caption || (n === 1 ? 'Фото' : `${n} фото`) };
    case 'voice': {
      // «Один раз» (`voice3`, G54; tdesktop `lng_in_dlg_voice_message_ttl`). Решение владельца 08.10: как Telegram — «Голосовое сообщение» без длительности.
      if (last.attachmentOnce === true) return { icon: 'mic', label: 'Одноразовое голосовое сообщение' };
      return { icon: 'mic', label: attachmentWords({ kind: 'voice' }) };
    }
    case 'sticker':
      return { icon: 'sticker', label: 'Стикер' };
    case 'file': {
      // Кружок (`circles1`, G68): tdesktop `lng_in_dlg_video_message` / `lng_in_dlg_video_message_ttl`.
      if (last.attachmentRound === true && n === 1) {
        if (last.attachmentOnce === true) return { icon: 'camera', label: 'Одноразовое видеосообщение' };
        return { icon: 'camera', label: attachmentWords({ kind: 'file', video: true, round: true }) };
      }
      if (last.attachmentVideo === true) {
        return { icon: 'camera', label: n === 1 ? attachmentWords({ kind: 'file', video: true }) : `${n} видео` };
      }
      const name = typeof last.attachmentName === 'string' ? oneLine(last.attachmentName) : '';
      return { icon: 'file', label: n === 1 ? attachmentWords({ kind: 'file', name }) : `${n} ${plural(n, 'файл', 'файла', 'файлов')}` };
    }
    default:
      return { icon: 'paperclip', label: caption || (n === 1 ? 'Вложение' : `${n} ${plural(n, 'вложение', 'вложения', 'вложений')}`) };
  }
}

/** Вид вложений сообщения — поля превью строки списка (`ConvLastMessage`) без текста и числа. */
export type AttachmentPreviewFields = Pick<
  ConvLastMessage,
  'attachmentKind' | 'attachmentDurationMs' | 'attachmentName' | 'attachmentVideo' | 'attachmentGif' | 'attachmentRound'
>;

/**
 * Вид вложений по самим вложениям сообщения (05.10) — то же правило, что у сервера для сводки беседы
 * (`backend convRules.lastAttachmentPreview`): голосовое — по первому (огибающая + `audio/*`, как `isVoiceMessage`),
 * `photo` — все картинки, иначе `file` с именем первого; все видео (`video/*`) — `file` с признаком `attachmentVideo`.
 * Не-объекты в списке пропускаются; вложений нет — `null`.
 */
export function attachmentPreviewOf(list: readonly unknown[]): AttachmentPreviewFields | null {
  const atts = list.filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && !Array.isArray(a));
  if (atts.length === 0) return null;
  const type = (a: Record<string, unknown>) => (typeof a.contentType === 'string' ? a.contentType : '');
  const isVoice = (a: Record<string, unknown>) =>
    Array.isArray(a.waveform) && a.waveform.length > 0 && type(a).startsWith('audio/');
  const first = atts[0];
  const ms = first.durationMs;
  const duration = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : null;
  if (isVoice(first)) {
    return duration !== null
      ? { attachmentKind: 'voice', attachmentDurationMs: duration }
      : { attachmentKind: 'voice' };
  }
  const gif = atts.every((a) => a.gif === true) ? ({ attachmentGif: true } as const) : {};
  if (atts.every((a) => type(a).startsWith('image/') && !isVoice(a))) return { attachmentKind: 'photo', ...gif };
  const name = typeof first.name === 'string' ? oneLine(first.name) : '';
  const file: AttachmentPreviewFields = name
    ? { attachmentKind: 'file', attachmentName: name, ...gif }
    : { attachmentKind: 'file', ...gif };
  if (!atts.every((a) => type(a).startsWith('video/'))) return file;
  // Кружок (`circles1`) — «Видеосообщение», как у сервера (`convRules.lastAttachmentPreview`).
  const round = first.round === true ? ({ attachmentRound: true } as const) : {};
  return duration !== null
    ? { ...file, attachmentVideo: true, attachmentDurationMs: duration, ...round }
    : { ...file, attachmentVideo: true, ...round };
}

/**
 * Вложения сообщения одной строкой — тело уведомления о сообщении без текста (05.10, вместо «📎 Вложение»): те же слова,
 * что в превью строки списка (`dmAttachmentPreview`) — «Фото» / «3 фото», «Видео», «Голосовое сообщение», имя файла /
 * «2 файла»; стикер — «Стикер». Ни вложений, ни стикера — `null`.
 */
export function messageAttachmentLabel(m: {
  attachments?: readonly unknown[] | null;
  sticker?: unknown;
}): string | null {
  // Стикер: «😎 Стикер», как Telegram (`lng_in_dlg_sticker_emoji`); эмодзи нет — «Стикер».
  if (m.sticker) {
    const emoji = (m.sticker as { emoji?: unknown }).emoji;
    return typeof emoji === 'string' && emoji.trim() ? `${emoji.trim()} Стикер` : 'Стикер';
  }
  const list: readonly unknown[] = Array.isArray(m.attachments) ? m.attachments : [];
  const kind = attachmentPreviewOf(list);
  if (!kind) return null;
  return dmAttachmentPreview({ text: '', attachments: list.length, ...kind })?.label ?? null;
}

/** Что стоит во второй линии строки — ровно одно (HANDOFF §2.1). */
export type DmPreview =
  | { kind: 'typing' }
  | { kind: 'draft'; text: string }
  | { kind: 'attachment'; icon: IconName; label: string }
  | { kind: 'text'; text: string }
  | { kind: 'none' };

/**
 * Превью по старшинству: печатает → черновик → последнее сообщение (вложение или текст). Черновик — только с текстом:
 * один ответ без слов — не черновик для списка. Последнего сообщения нет (беседа пустая или список без сводок — старый
 * путь `/api/dm`) — `none`.
 */
export function dmRowPreview(p: { typing: boolean; draft?: string | null; last?: ConvLastMessage | null }): DmPreview {
  if (p.typing) return { kind: 'typing' };
  // Маркеры формата (G51) в строке списка не показываем — как Telegram: свой черновик словами, чужой спойлер закрыт.
  const draft = typeof p.draft === 'string' ? oneLine(stripFormatting(p.draft, { spoiler: 'keep' })) : '';
  if (draft) return { kind: 'draft', text: draft };
  const last = p.last;
  if (!last || typeof last !== 'object') return { kind: 'none' };
  const att = dmAttachmentPreview(last);
  if (att) return { kind: 'attachment', ...att };
  const text = typeof last.text === 'string' ? stripFormatting(last.text).trim() : '';
  return text ? { kind: 'text', text } : { kind: 'none' };
}

/** Текст превью словами — для `aria-label` (в строке он же, только с точками и значками). */
export function dmPreviewText(p: DmPreview): string {
  switch (p.kind) {
    case 'typing':
      return 'печатает';
    case 'draft':
      return `Черновик: ${p.text}`;
    case 'attachment':
      return p.label;
    case 'text':
      return p.text;
    default:
      return '';
  }
}

// ─── Отметка ✓ / ✓✓ ─────────────────────────────────────────────────────────────────────────────────────────────────

export type DmRowStatus = 'sent' | 'read';

/**
 * Отметка перед временем (HANDOFF §2.1): только у МОЕГО последнего сообщения и не при черновике — превью тогда не о
 * последнем сообщении (при «печатает» остаётся). ✓✓ — собеседник прочитал до него: `readByPeer(sortKey, peerReadKey)`,
 * то же правило, что в пузырях (Р6); ключа нет (сервер до `conv4`, сводка из кеша) — ✓.
 */
export function dmRowStatus(p: {
  last?: ConvLastMessage | null;
  meId?: string | null;
  peerReadKey: number | null;
  preview: DmPreview;
}): DmRowStatus | null {
  const last = p.last;
  if (!last || typeof last !== 'object' || !p.meId || last.authorId !== p.meId || p.preview.kind === 'draft') return null;
  return readByPeer(last.sortKey, p.peerReadKey) ? 'read' : 'sent';
}

// ─── Поиск по беседам (HANDOFF §3) ─────────────────────────────────────────────────────────────────────────────────

/** Без регистра, «ё» = «е». Длина строки сохраняется (знак за знак) — найденное место совпадает с исходным именем. */
function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const low = ch.toLowerCase();
    const one = low.length === ch.length ? low : ch;
    out += one === 'ё' ? 'е' : one;
  }
  return out;
}

export interface DmNameMatch {
  before: string;
  /** Совпавшее — `<mark className="dm-hit">`; пустой запрос — пусто. */
  hit: string;
  after: string;
}

/**
 * Совпадение запроса с именем — по началу ЛЮБОГО слова, без регистра, «ё» = «е» («ко» находит и «Кот Учёный», и «Учёный
 * Кот», но не «Пакостник»). Пустой запрос — всё имя без выделения. Не совпало — `null`. По тексту сообщений не ищем:
 * список знает только последнее.
 */
export function matchDmName(name: string, query: string): DmNameMatch | null {
  const q = fold(query.trim());
  if (!q) return { before: name, hit: '', after: '' };
  const n = fold(name);
  for (let i = 0; i < n.length; i++) {
    if ((i === 0 || /\s/.test(n[i - 1])) && n.startsWith(q, i)) {
      return { before: name.slice(0, i), hit: name.slice(i, i + q.length), after: name.slice(i + q.length) };
    }
  }
  return null;
}

/**
 * Совпадение запроса с ЛОГИНОМ собеседника («Найти беседу», 05.10): по началу логина, без регистра; «@» впереди
 * срезается — «@cat» и «cat» находят одно и то же. Имя в строке при этом не выделяется: логина в строке нет. Пустой
 * запрос («», «@») — `false`: весь список показывает сам пустой запрос, а не это правило.
 */
export function matchDmUsername(username: string, query: string): boolean {
  const q = query.trim().replace(/^@/, '').toLowerCase();
  return q.length > 0 && username.toLowerCase().startsWith(q);
}

// ─── Для скринридера ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `aria-label` строки (HANDOFF §2.6): «<имя>, в сети. Вы: <текст>. 21:08, отправлено» или «<имя>, в сети. <текст>. 20:47.
 * 2 непрочитанных». «Вы:» — только для скринридера: в строке это говорит отметка. `unread` — число, `'dot'` — флаг без
 * числа, `0` — нет. При неотправленном (`failed`) красный «!» стоит на месте ✓ / ✓✓, поэтому «есть неотправленное»
 * встаёт на место «отправлено» / «прочитано» («21:08, есть неотправленное») — их скринридер уже не называет, — а число
 * непрочитанных остаётся последней частью: счётчик в строке тоже на своём месте.
 */
export function dmRowLabel(p: {
  name: string;
  online: boolean;
  preview: DmPreview;
  mine: boolean;
  time: string | null;
  status: DmRowStatus | null;
  unread: number | 'dot';
  failed: boolean;
}): string {
  const shown = dmPreviewText(p.preview);
  const aboutLast = p.preview.kind === 'attachment' || p.preview.kind === 'text';
  const unread =
    p.unread === 'dot'
      ? 'есть непрочитанное'
      : p.unread > 0
        ? `${p.unread} ${plural(p.unread, 'непрочитанное', 'непрочитанных', 'непрочитанных')}`
        : '';
  const mark = p.failed ? 'есть неотправленное' : p.status === 'read' ? 'прочитано' : p.status === 'sent' ? 'отправлено' : '';
  return [
    p.name + (p.online ? ', в сети' : ''),
    shown && (p.mine && aboutLast ? `Вы: ${shown}` : shown),
    [p.time, mark].filter(Boolean).join(', '),
    unread,
  ]
    .filter(Boolean)
    .join('. ');
}
