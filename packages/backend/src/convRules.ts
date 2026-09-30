import { createHash } from 'node:crypto';

/**
 * ЛС, этап 1 (#211, `docs/dm/STAGE1.md`) — чистые правила модели бесед. Без базы, env, Redis и сети: здесь решается,
 * каким будет ключ порядка, курсор, отпечаток отправки, кто что видит и что отдаёт догонка. Запись и чтение, которые
 * этими правилами пользуются, — `conversations.ts`.
 */

/**
 * Следующий ключ порядка — гибридные часы (HLC) в МИКРОСЕКУНДАХ: не меньше часов и строго больше прошлого ключа
 * беседы. В базе считается тем же выражением под замком строки беседы (`conversations.ts nextKey`); здесь — для
 * проверки правила.
 *
 * 🔴 Микросекунды, а не «мс << 16» (разбор Codex 30.09): `Date.now() * 65536` больше 2⁵³, и соседние ключи слипались бы
 * в одно число после JSON. Микросекунды — 1,8·10¹⁵ < 2⁵³ до 2255 года: ключ остаётся точным числом JS.
 */
export function nextSortKey(nowUs: number, lastKey: number): number {
  return Math.max(nowUs, lastKey + 1);
}

/** Годится ли значение в ключ порядка: целое, неотрицательное, точное в JS. На КАЖДОМ входе — от клиента и из базы. */
export function isSortKey(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** Курсор истории — непрозрачная для клиента строка `"<sort_key>_<id>"`. */
export interface ConvCursor {
  sortKey: number;
  id: string;
}

export function encodeCursor(c: ConvCursor): string {
  return `${c.sortKey}_${c.id}`;
}

const CURSOR_RE = /^(\d{1,16})_([A-Za-z0-9-]{1,64})$/;

/** Разобрать курсор. Мусор, ключ вне точных целых JS, чужие символы в id → `null` (ответ 400, а не пустая страница). */
export function decodeCursor(raw: string): ConvCursor | null {
  const m = CURSOR_RE.exec(raw);
  if (!m) return null;
  const sortKey = Number(m[1]);
  if (!isSortKey(sortKey)) return null;
  return { sortKey, id: m[2] };
}

/** Ключ беседы 1:1 — «меньший:больший» id: одна беседа на пару, кто бы ни открыл её первым. */
export function directKey(one: string, two: string): string {
  return one < two ? `${one}:${two}` : `${two}:${one}`;
}

/**
 * Отпечаток отправки для id отправки (`client_id`): повтор с тем же отпечатком — то же сообщение, с другим — 409.
 *
 * Канон (разбор Codex 30.09): массив с постоянным порядком — порядок полей в JSON запроса ни на что не влияет; текст —
 * ПОСЛЕ той же нормализации, что и при сохранении (`trim`), иначе повтор с лишним пробелом давал бы 409; ссылки
 * вложений — в порядке отправки (порядок виден человеку); беседа входит в отпечаток — тот же `client_id` в другой
 * беседе даёт 409, а не «вернул» бы сообщение из чужой беседы. Новая смысловая опция отправки = новая версия (`'p2'`).
 */
export function payloadHash(p: {
  conversationId: string;
  content: string;
  attachmentRefs: readonly string[];
  replyToId: string | null | undefined;
}): string {
  const canon = JSON.stringify(['p1', p.conversationId, p.content, [...p.attachmentRefs], p.replyToId ?? null]);
  return createHash('sha256').update(canon).digest('hex');
}

export type IdempotencyDecision = 'insert' | 'replay' | 'conflict';

/**
 * Что делать с отправкой, у которой `client_id` уже встречался у этого автора.
 * `existingHash === undefined` — такой строки нет; `null` — строка без отпечатка (не может совпасть ни с чем).
 */
export function idempotencyDecision(existingHash: string | null | undefined, hash: string): IdempotencyDecision {
  if (existingHash === undefined) return 'insert';
  return existingHash === hash ? 'replay' : 'conflict';
}

/** Сообщение глазами человека: полностью или «его для тебя нет» (`gone`). */
export interface ViewableMessage {
  authorId: string;
  withheld: boolean;
  deletedAt: Date | string | null;
  hiddenFor: readonly string[];
}

/**
 * Видит ли человек сообщение. `gone` — надгробие «у обоих», спрятанное «у меня», чужое придержанное блокировкой.
 * Догонка отдаёт `gone` адресно этому человеку (Codex 30.09): иначе офлайн-клиент оставил бы в кеше то, что спрятано
 * с другого его устройства.
 */
export function messageView(m: ViewableMessage, viewerId: string): 'full' | 'gone' {
  if (m.deletedAt) return 'gone';
  if (m.hiddenFor.includes(viewerId)) return 'gone';
  if (m.withheld && m.authorId !== viewerId) return 'gone';
  return 'full';
}

/**
 * Непрочитано ли сообщение: видно мне, не моё, новее моего «прочитано до». Точное, без окна по времени.
 * ⚠️ То же условие написано в SQL (`conversations.ts`, `unreadSql`) — правило одно, менять оба места.
 */
export function countsAsUnread(m: ViewableMessage & { sortKey: number }, viewerId: string, lastReadKey: number): boolean {
  return m.authorId !== viewerId && m.sortKey > lastReadKey && messageView(m, viewerId) === 'full';
}

/** «Прочитано до» только вперёд: опоздавшее устройство с отставшим хвостом не откатывает отметку. */
export function readKeyMax(current: number, requested: number): number {
  return Math.max(current, requested);
}

export type ChangeKind = 'msg' | 'read' | 'conv';

/** Строка журнала: «у человека X изменилась сущность в беседе Y». */
export interface JournalEntry {
  userId: string;
  conversationId: string;
  kind: ChangeKind;
  messageId: string | null;
}

/**
 * Порядок замков строк `user_sync` — по возрастанию `user_id`, у ВСЕХ писателей одинаковый (после замка беседы).
 * Иначе два изменения с участниками в разном порядке заперли бы друг друга.
 */
export function journalLockOrder(entries: readonly JournalEntry[]): string[] {
  return [...new Set(entries.map((e) => e.userId))].sort();
}

export type MessageAction = 'create' | 'edit' | 'delete-both' | 'delete-me' | 'react';

/**
 * Кому пишется строка журнала о действии с сообщением (таблица в STAGE1, «Журнал и догонка»):
 * - создание, правка, удаление у обоих — автору действия и остальным участникам; придержанное — только автору;
 * - удаление «у меня» — только удалившему (собеседник не узнаёт);
 * - реакция — себе и участникам, кроме придержанного и кроме тех, кто заблокировал реагирующего (они его реакций
 *   не видят и в истории, `blockRules.reachesPeer`).
 */
export function changeAudience(input: {
  action: MessageAction;
  actorId: string;
  memberIds: readonly string[];
  withheld: boolean;
  /** Участники, заблокировавшие действующего. */
  blockedActor: ReadonlySet<string>;
}): string[] {
  const { action, actorId, memberIds, withheld, blockedActor } = input;
  if (action === 'delete-me' || withheld) return [actorId];
  const others = memberIds.filter((id) => id !== actorId);
  const reached = action === 'react' ? others.filter((id) => !blockedActor.has(id)) : others;
  return [actorId, ...reached];
}

/**
 * План ответа догонки `GET /api/conv/sync?pts=N`.
 *
 * - `N < minPts` — нужные строки журнала уже удалены: `reset`, клиент перечитывает список и открытые беседы;
 * - `N > pts` — клиент «впереди» сервера (база восстановлена из снимка): тоже `reset`, иначе он молча пропустил бы
 *   всё, что сервер пронумерует заново;
 * - иначе — до `limit` строк после `N`; `rows` запрашиваются с запасом в одну (`limit + 1`), чтобы узнать `more`.
 *   При `more` водяной знак — номер ПОСЛЕДНЕЙ ОТДАННОЙ строки, а не текущий (Codex 30.09): следующий запрос начнёт
 *   ровно с неё.
 */
export type CatchupPlan<R> =
  | { reset: true; pts: number }
  | { reset: false; pts: number; more: boolean; rows: R[] };

export function catchupPlan<R extends { pts: number }>(
  since: number,
  state: { pts: number; minPts: number },
  rows: readonly R[],
  limit: number,
): CatchupPlan<R> {
  if (since < state.minPts || since > state.pts) return { reset: true, pts: state.pts };
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return { reset: false, pts: more ? page[page.length - 1].pts : state.pts, more, rows: page };
}

/** Срок журнала догонки (Р18): старше — строки удаляются, `min_pts` поднимается. */
export const JOURNAL_TTL_DAYS = 30;

/** Предел размеров страниц. */
export const HISTORY_LIMIT_MAX = 100;
export const SYNC_LIMIT_MAX = 500;

/** Кусок текста для списка бесед — без переводов строк, не длиннее `max` символов (по кодовым точкам). */
export function previewText(content: string, max = 200): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}

/** Что нужно знать о вложении, чтобы решить, отдать ли его человеку (шаг 1в). */
export interface AttachmentAccessInput {
  viewerId: string;
  /** Аккаунт смотрящего удалён — ссылка больше не работает, даже если была выдана. */
  viewerDeleted: boolean;
  att: { ownerId: string; conversationId: string; state: 'pending' | 'attached' | 'deleted'; messageId: string | null };
  /** Участие СМОТРЯЩЕГО в беседе вложения; `null` — не участник. */
  member: { leftAt: Date | string | null } | null;
  /** Сообщение, к которому прикреплено вложение (для `attached`). */
  message: (ViewableMessage & { conversationId: string }) | null;
}

/**
 * Отдать ли файл ЛС этому человеку (разбор Codex 30.09, п. 8): одного участия в беседе мало.
 * - удалённое вложение и удалённый аккаунт — никому;
 * - незавершённая загрузка (`pending`) — только загрузившему, пока он участник;
 * - прикреплённое — участнику без `left_at`, если сообщение из ЭТОЙ беседы и видно ему (`messageView`): надгробие,
 *   спрятанное им «у себя» и чужое придержанное — нет.
 */
export function attachmentAccess(i: AttachmentAccessInput): boolean {
  if (i.viewerDeleted || i.att.state === 'deleted') return false;
  if (!i.member || i.member.leftAt) return false;
  if (i.att.state === 'pending') return i.att.ownerId === i.viewerId;
  if (!i.message || i.att.messageId === null) return false;
  if (i.message.conversationId !== i.att.conversationId) return false;
  return messageView(i.message, i.viewerId) === 'full';
}
