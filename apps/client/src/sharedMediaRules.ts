/**
 * Общие медиа беседы (08.10, #211, G29, признак `media1`) — чистые правила вкладок «Медиа / Файлы / Ссылки / GIF /
 * Голосовые». Источник — Telegram: tweb `components/appSearchSuper.ts` (сетка 3 колонки, порция 50,
 * разбивка по месяцам), Web A `components/right/Profile.tsx` (`TABS`), tdesktop `info/media/info_media_list_widget.cpp`
 * (заголовки месяцев, «Показать в чате»).
 */
import { type Attachment, type ConvMessage, messageLinks, type SharedMediaCounts, type SharedMediaKind, sharedMediaKindOf } from '@gusvoice/shared';

/** Подписи вкладок — как у Telegram (Web A: «Медиа», «Файлы», «Ссылки», «GIF», «Голосовые»). */
export const SHARED_MEDIA_TITLES: Record<SharedMediaKind, string> = {
  media: 'Медиа',
  file: 'Файлы',
  link: 'Ссылки',
  gif: 'GIF',
  voice: 'Голосовые',
};

/** Колонок в сетке медиа и GIF (tweb `.search-super-content-media-grid`: `repeat(3, 1fr)`; зазор у нас 2 px — `--sp-1`, у tweb 1 px). */
export const SHARED_MEDIA_COLUMNS = 3;

/** За сколько пикселей до низа списка просить следующую порцию. */
export const SHARED_MEDIA_PRELOAD_PX = 600;

/** Строка счётчика в профиле: «12 фото и видео», «3 файла» — склонение по числу. */
export function sharedMediaCountLabel(kind: SharedMediaKind, n: number): string {
  const forms: Record<SharedMediaKind, [string, string, string]> = {
    media: ['фото и видео', 'фото и видео', 'фото и видео'],
    file: ['файл', 'файла', 'файлов'],
    link: ['ссылка', 'ссылки', 'ссылок'],
    gif: ['GIF', 'GIF', 'GIF'],
    voice: ['голосовое', 'голосовых', 'голосовых'],
  };
  const [one, few, many] = forms[kind];
  const m10 = n % 10;
  const m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}

/** Вкладки, которые показывать: непустые, в порядке Telegram; открытая остаётся, даже если опустела. */
export function visibleSharedTabs(counts: SharedMediaCounts | null, open: SharedMediaKind | null): SharedMediaKind[] {
  const order: SharedMediaKind[] = ['media', 'file', 'link', 'gif', 'voice'];
  if (!counts) return open ? [open] : [];
  return order.filter((k) => counts[k] > 0 || k === open);
}

/** Есть ли что показать в профиле. */
export function hasSharedMedia(counts: SharedMediaCounts | null): boolean {
  return !!counts && (counts.media > 0 || counts.file > 0 || counts.link > 0 || counts.gif > 0 || counts.voice > 0);
}

/** Один элемент вкладки: вложение (медиа, файл, GIF, голосовое) или ссылка из текста. */
export type SharedItem =
  | { key: string; msg: ConvMessage; att: Attachment; url?: undefined; urls?: undefined }
  | { key: string; msg: ConvMessage; url: string; urls: string[]; att?: undefined };

/**
 * Элементы вкладки из порции сообщений (новые первыми, внутри сообщения — по порядку вложений). Ссылки — одна строка на
 * сообщение (`url` — первая, `urls` — все), как у Telegram: счётчик «Ссылки» — по сообщениям.
 */
export function sharedItems(messages: readonly ConvMessage[], kind: SharedMediaKind): SharedItem[] {
  const out: SharedItem[] = [];
  for (const m of messages) {
    if (kind === 'link') {
      const urls = messageLinks(m.content ?? '');
      if (urls.length > 0) out.push({ key: m.id, msg: m, url: urls[0], urls });
      continue;
    }
    (m.attachments ?? []).forEach((a, i) => {
      if (sharedMediaKindOf(a) === kind) out.push({ key: `${m.id}:${a.id ?? i}`, msg: m, att: a });
    });
  }
  return out;
}

/** Порция к уже загруженному: без повторов по id сообщения (сообщение могло прийти дважды на границе порций). */
export function mergeSharedPage(prev: readonly ConvMessage[], page: readonly ConvMessage[]): ConvMessage[] {
  const seen = new Set(prev.map((m) => m.id));
  return [...prev, ...page.filter((m) => !seen.has(m.id))];
}

const MONTH = new Intl.DateTimeFormat('ru-RU', { month: 'long' });

/** Заголовок месяца: «Октябрь 2026» (tdesktop `info_media_list_widget.cpp` — месяц и год у каждой секции). */
export function sharedMonthLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const m = MONTH.format(d);
  return `${m.charAt(0).toUpperCase()}${m.slice(1)} ${d.getFullYear()}`;
}

/** Разбивка по месяцам (по местному времени), порядок сохраняется. */
export function groupByMonth<T extends { msg: { createdAt: string } }>(items: readonly T[]): { key: string; label: string; items: T[] }[] {
  const out: { key: string; label: string; items: T[] }[] = [];
  for (const it of items) {
    const d = new Date(it.msg.createdAt);
    const key = Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${d.getMonth()}`;
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(it);
    else out.push({ key, label: sharedMonthLabel(it.msg.createdAt), items: [it] });
  }
  return out;
}

/** Домен ссылки без `www.` — заголовок строки во вкладке «Ссылки», если у ссылки нет карточки. */
export function linkDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Расширение файла для значка в списке: «PDF», «CSV»; нет — «FILE». Не длиннее 4 знаков. */
export function fileBadge(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? m[1].slice(0, 4).toUpperCase() : 'FILE';
}

/** Порядок просмотрщика: от старых к новым (как лента и просмотр у Telegram), списки вкладок — новые первыми. */
export function viewerOrder<T>(newestFirst: readonly T[]): T[] {
  return [...newestFirst].reverse();
}
