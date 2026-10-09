import { has, Permission, permsFromString, type ServerBootstrap } from '@gusvoice/shared';
import { plural } from './dmRowRules';
import { formatBytes } from './byteSize';

/**
 * «Поделиться в GusVoice» (09.10, G79) — чистые правила приёма. Путь целиком: системное «Поделиться» → Android
 * (`ShareIntent.kt` разбирает намерение, `MediaBridge.onShareIntent` копирует файлы в кеш) → `window.__gvShare()` → окно
 * «Поделиться в…» (`components/ShareIncoming.tsx`, на `ForwardPicker`) → выбранная беседа: файлы — в окно отправки (ПК) или
 * на полосу у поля (телефон), текст — в поле (`MessagePane`, `store.sharedIn`). Ничего не отправляется без нажатия человеком.
 * Как у Telegram Android: `LaunchActivity.handleIntent` (текст / тема / файлы) → `DialogsActivity` в режиме выбора →
 * `ChatActivity` с вложениями в предпросмотре.
 */

export interface IncomingShareFile {
  name: string;
  mime: string;
  size: number;
  /** Натив файл не скопировал: больше 25 МБ или чужое приложение не дало прочитать. */
  skip?: 'too-big' | 'unreadable';
}

/**
 * Предел файла по серверу (`bigfile1`, 09.10): натив копирует до 512 МБ, не зная сервера, — больше предела активного
 * инстанса помечаем `too-big` здесь (на сервере без `bigfile1` предел прежние 25 МБ).
 */
export function shareFilesWithin<T extends { size: number; skip?: 'too-big' | 'unreadable' }>(files: readonly T[], max: number): T[] {
  return files.map((f) => (!f.skip && f.size > max ? { ...f, skip: 'too-big' as const } : f));
}

export interface IncomingShare {
  /** Метка пришедшего у натива: по ней берут байты и забывают (новое «поделиться» её меняет). */
  token: string;
  /** Текст для поля: `EXTRA_TEXT`, при ссылке — с темой сверху (см. `sharedText`). */
  text: string;
  files: IncomingShareFile[];
  /** Сколько файлов не влезло в предел вложений (10) — натив их даже не копировал. */
  dropped: number;
}

/**
 * Текст из `EXTRA_TEXT` / `EXTRA_SUBJECT`, как у Telegram Android (`LaunchActivity.handleIntent`): есть текст — он; текст —
 * ссылка и есть тема (браузер шлёт заголовок страницы) — «тема\nссылка»; текста нет — тема.
 */
export function sharedText(text: string, subject: string): string {
  const t = text.trim();
  const s = subject.trim();
  if (t) return /^https?:\/\//i.test(t) && s && s !== t ? `${s}\n${t}` : t;
  return s;
}

/** Сырой ответ натива (`shared`) → пришедшее; мусор или пусто (ни файлов, ни текста) — `null`. */
export function parseIncomingShare(raw: unknown): IncomingShare | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const token = typeof r.token === 'string' ? r.token : '';
  if (!token) return null;
  const files: IncomingShareFile[] = (Array.isArray(r.files) ? r.files : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => {
      const out: IncomingShareFile = {
        name: typeof f.name === 'string' && f.name ? f.name : 'файл',
        mime: typeof f.mime === 'string' ? f.mime : '',
        size: Number(f.size) > 0 ? Number(f.size) : 0,
      };
      if (f.skip === 'too-big' || f.skip === 'unreadable') out.skip = f.skip;
      return out;
    });
  const text = sharedText(typeof r.text === 'string' ? r.text : '', typeof r.subject === 'string' ? r.subject : '');
  const dropped = Number(r.dropped) > 0 ? Math.floor(Number(r.dropped)) : 0;
  if (files.length === 0 && !text && dropped === 0) return null;
  return { token, text, files, dropped };
}

/** Что пришло, словами: «3 файла и текст», «Текст». */
export function shareHead(s: IncomingShare): string {
  const n = s.files.filter((f) => !f.skip).length;
  return n > 0 ? `${n} ${plural(n, 'файл', 'файла', 'файлов')}${s.text ? ' и текст' : ''}` : s.text ? 'Текст' : 'Нечего отправить';
}

/** Подпись окна выбора: «3 файла · встанут в поле выбранной беседы», «Текст · …». */
export function shareWhat(s: IncomingShare): string {
  return `${shareHead(s)} · встанут в поле выбранной беседы`;
}

/**
 * Текстовый канал сервера в окне «Поделиться в…» (09.10, решение владельца): строка списка — значок сервера, «# имя»,
 * подпись «Сервер».
 */
export interface ShareChannel {
  id: string;
  serverId: string;
  serverName: string;
  serverIconUrl: string | null;
  name: string;
}

/**
 * Каналы, куда можно писать, из ответов `GET /servers/:id` (по одному на сервер, порядок серверов — как на рельсе).
 * Только текстовые; право писать — `canSend` самого канала (с переопределениями; сервер кладёт его в bootstrap), у старого
 * сервера поля нет — тогда право сервера `SEND_MESSAGES`. Нет права — канала нет в списке. Порядок внутри сервера — как в
 * боковой панели: канал без категории раньше категорий, дальше категории и каналы по позиции.
 */
export function shareChannels(boots: readonly ServerBootstrap[]): ShareChannel[] {
  const out: ShareChannel[] = [];
  for (const b of boots) {
    const serverCan = has(permsFromString(b.permissions), Permission.SEND_MESSAGES);
    const catPos = new Map(b.categories.map((c) => [c.id, c.position] as const));
    const rank = (c: { categoryId: string | null }) => (c.categoryId === null ? -1 : (catPos.get(c.categoryId) ?? 0));
    const list = b.channels
      .filter((c) => c.type === 'text' && (c.canSend ?? serverCan))
      .sort((a, c) => rank(a) - rank(c) || a.position - c.position);
    for (const c of list) {
      out.push({ id: c.id, serverId: b.server.id, serverName: b.server.name, serverIconUrl: b.server.iconUrl, name: c.name });
    }
  }
  return out;
}

/** Итог отправки: «Отправлено: Имя», «Отправлено: Имя и #канал», «Отправлено в 3 беседы». */
export function shareDoneText(names: readonly string[]): string {
  if (names.length <= 2) return `Отправлено: ${names.join(' и ')}`;
  return `Отправлено в ${names.length} ${plural(names.length, 'беседу', 'беседы', 'бесед')}`;
}

/**
 * Почему часть пришедшего не встала (тост после выбора беседы): «Больше 25 МБ — не прикрепить: video.mp4», «Не удалось
 * прочитать: a.pdf», «Не больше 10 файлов — ещё 3 не добавлены». Всё встало — пустая строка.
 */
export function shareSkippedText(
  skipped: readonly { name: string; reason: 'too-big' | 'unreadable' }[],
  dropped: number,
  maxBytes: number,
  maxFiles: number,
): string {
  const big = skipped.filter((s) => s.reason === 'too-big').map((s) => s.name);
  const bad = skipped.filter((s) => s.reason === 'unreadable').map((s) => s.name);
  const parts: string[] = [];
  if (big.length) parts.push(`Больше ${formatBytes(maxBytes)} — не прикрепить: ${big.join(', ')}`);
  if (bad.length) parts.push(`Не удалось прочитать: ${bad.join(', ')}`);
  if (dropped > 0) parts.push(`Не больше ${maxFiles} файлов — ещё ${dropped} не ${plural(dropped, 'добавлен', 'добавлены', 'добавлены')}`);
  return parts.join('. ');
}
