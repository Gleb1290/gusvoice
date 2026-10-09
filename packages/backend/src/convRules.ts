import { createHash } from 'node:crypto';
import type { ConvLastMessage } from '@gusvoice/shared';

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

/** Длина запроса поиска по беседе (`GET /api/conv/:id/search`, G05): длиннее — 400. */
export const SEARCH_QUERY_MAX = 128;

/**
 * Образец ILIKE для поиска по беседе (G05): запрос без краевых пробелов как ПОДСТРОКА текста, `%`, `_` и `\` в нём —
 * буквы, а не шаблон. Пустой после trim — `null` (искать нечего).
 */
export function searchPattern(raw: string): string | null {
  const q = raw.trim();
  if (!q) return null;
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Ключ беседы 1:1 — «меньший:больший» id: одна беседа на пару, кто бы ни открыл её первым. */
export function directKey(one: string, two: string): string {
  return one < two ? `${one}:${two}` : `${two}:${one}`;
}

/**
 * «Избранное» (08.10, `saved1`) — беседа с самим собой: тот же `direct_key`, но пара из одного человека («я:я»). Отдельной
 * колонки нет; ключ уникален — у человека не больше одной такой беседы, и параллельное создание безопасно.
 */
export function savedKey(userId: string): string {
  return directKey(userId, userId);
}

/** Это «Избранное» человека `userId` (по ключу беседы)? Чужое «я:я» для `userId` — не оно. */
export function isSavedKey(key: string | null | undefined, userId: string): boolean {
  return key === savedKey(userId);
}

/**
 * Отпечаток отправки для id отправки (`client_id`): повтор с тем же отпечатком — то же сообщение, с другим — 409.
 *
 * Канон (разбор Codex 30.09): массив с постоянным порядком — порядок полей в JSON запроса ни на что не влияет; текст —
 * ПОСЛЕ той же нормализации, что и при сохранении (`trim`), иначе повтор с лишним пробелом давал бы 409; ссылки
 * вложений — в порядке отправки (порядок виден человеку); беседа входит в отпечаток — тот же `client_id` в другой
 * беседе даёт 409, а не «вернул» бы сообщение из чужой беседы. Новая смысловая опция отправки = новая версия (`'p2'`).
 *
 * 🔴 «Без звука» (`silent`, С3, `conv8`) в отпечаток НЕ входит — решение 05.10. Это не смысл сообщения (текст, файлы,
 * ответ — то, что видят оба), а способ однажды оповестить получателя в момент вставки: повтор того же id ничего
 * повторно не оповещает и уже случившееся не отменит, поэтому честный ответ на него — 200 и сообщение как есть (его DTO
 * несёт настоящий `silent`). 409 здесь пометил бы «не отправлено» сообщение, которое у собеседника УЖЕ есть, а «Повторить»
 * с новым id дал бы ему дубль. Попутно `'p1'` не меняется: отпечатки строк до 0084 и откат бэкенда считают его так же.
 * У пересылки (`forwardPayloadHash`) — то же. Опция, меняющая само сообщение или его место (`sendAt` С4), — в `'p2'`.
 */
export function payloadHash(p: {
  conversationId: string;
  content: string;
  attachmentRefs: readonly string[];
  replyToId: string | null | undefined;
  /** Стикер (`stickers2`): входит в отпечаток ТОЛЬКО если есть — отпечатки прежних сообщений не меняются. */
  stickerId?: string | null;
  /** Цитата фрагмента (`quote1`, G55) как её прислал клиент: в отпечатке ТОЛЬКО если есть — как стикер. */
  replyQuote?: { text: string; offset?: number } | null;
}): string {
  const base: unknown[] = ['p1', p.conversationId, p.content, [...p.attachmentRefs], p.replyToId ?? null];
  if (p.stickerId) base.push(['sticker', p.stickerId]);
  if (p.replyQuote) base.push(['quote', p.replyQuote.text, p.replyQuote.offset ?? null]);
  const canon = JSON.stringify(base);
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

/** Другой участник беседы глазами смотрящего — вход «прочитано собеседником» (Р6). */
export interface PeerReadState {
  /** Его «прочитано до». */
  lastReadKey: number;
  /**
   * Он держит СМОТРЯЩЕГО в чёрном списке (Р12): ключ первого придержанного сообщения смотрящего в этой беседе с начала
   * ТЕКУЩЕЙ блокировки. `null` — не блокирует или придержанного с её начала ещё нет.
   */
  firstWithheldKey: number | null;
}

/**
 * «Прочитано собеседником» (Р6, ✓✓) глазами смотрящего — наибольшее «прочитано до» остальных участников (для 1:1 —
 * собеседника); `null` — сравнивать не с кем. Решение владельца 03.10: видно всегда, без настройки, как в Telegram.
 * - Вышедшие участники считаются тоже: их прочтение было, а исключение откатило бы уже показанные ✓✓.
 * - 🔴 Блокировка (Р12, «заблокированный ничего не узнаёт»): пока участник держит смотрящего в чёрном списке, его ключ
 *   для смотрящего — строго ниже первого придержанного с начала блокировки. Придержанное тот не видит и прочитать не
 *   может, а его ключ уходит вперёд и по собственным сообщениям — без потолка ✓✓ на придержанном выдали бы, что он
 *   читает переписку. Начало — ТЕКУЩЕЙ блокировки, а не первое придержанное вообще: после разблокировки ✓✓ на старых
 *   придержанных уже могли показаться, и повторная блокировка, опустив ключ под них, сняла бы ✓✓ — то есть выдала бы
 *   себя. С потолком от начала текущей ключ не убывает: в момент первого придержанного он и так ниже его ключа.
 */
export function peerReadKey(others: readonly PeerReadState[]): number | null {
  let best: number | null = null;
  for (const o of others) {
    const k = o.firstWithheldKey === null ? o.lastReadKey : Math.max(0, Math.min(o.lastReadKey, o.firstWithheldKey - 1));
    if (best === null || k > best) best = k;
  }
  return best;
}

/**
 * Кому строка журнала о сдвиге МОЕГО «прочитано до» (Р6): мне — остальные мои устройства гасят непрочитанное — и
 * остальным действующим участникам: их устройства получают сводку с новым `peerReadKey` (✓✓). Кроме тех, кого я держу в
 * чёрном списке (Р12): пока блокировка действует, им ни строки журнала, ни события — по ним было бы видно, что я читаю.
 * Заблокировавший меня собеседник моё «прочитано» получает: блокировка прячет его от меня, а не меня от него.
 */
export function readAudience(input: {
  readerId: string;
  /** Действующие участники, включая читающего. */
  memberIds: readonly string[];
  /** Кого читающий держит в чёрном списке. */
  readerBlocked: ReadonlySet<string>;
}): string[] {
  const { readerId, memberIds, readerBlocked } = input;
  return [readerId, ...memberIds.filter((id) => id !== readerId && !readerBlocked.has(id))];
}

/**
 * `pin` (С2, `conv7`) — «мой список закреплённого в беседе изменился» (без сообщения: догонка отдаёт список целиком).
 * `sched` (С4, `conv9`) — «мой список отложенных в беседе изменился» — тоже без сообщения и только автору.
 */
export type ChangeKind = 'msg' | 'read' | 'conv' | 'draft' | 'pin' | 'sched';

/**
 * Закреп беседы наверху списка (07.10, `conv11`): не больше стольких закреплённых бесед у человека — умолчание Telegram
 * (03·1.3.5: 5 в основном списке). Шестой закреп — 409 `{ reason: 'conv_pin_limit', max }`, клиент показывает тост.
 */
export const CONV_PIN_LIMIT = 5;

/** «Выключить уведомления» на срок (07.10, `conv11`): от минуты до года; без срока — навсегда. */
export const MUTE_SECONDS_MIN = 60;
export const MUTE_SECONDS_MAX = 366 * 24 * 3600;

/**
 * Порядок списка бесед (07.10, `conv11`): закреплённые первыми, свежезакреплённая выше (как `toggleDialogPin` у
 * Telegram); дальше — по последнему сообщению, у пустой — по созданию. Без `pinnedAt` — прежний порядок «свежие сверху».
 * Время — строки ISO одного вида (`toISOString`), сравниваются как строки. То же правило у клиента — `dmListRules.byRecent`.
 */
export function convListOrder(
  a: { pinnedAt?: string | null; lastMessageAt: string | null; createdAt: string },
  b: { pinnedAt?: string | null; lastMessageAt: string | null; createdAt: string },
): number {
  const pa = a.pinnedAt ?? null;
  const pb = b.pinnedAt ?? null;
  if (pa !== null || pb !== null) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    if (pa !== pb) return pb.localeCompare(pa);
  }
  return (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt);
}

/**
 * Перестановка закреплённых бесед (08.10, `pinorder1`, Telegram `messages.reorderPinnedDialogs`). `current` — мои
 * закреплённые сверху вниз (по `pinnedAt`, свежее выше), `ids` — новый порядок от клиента. Повтор id или id не из моих
 * закреплённых — `bad` (400): так нельзя закрепить чужое или открепить своё перестановкой. Закреплённые, которых клиент
 * не назвал (закреп с другого устройства, пока тянули), остаются после названных в прежнем порядке — как `force = false`
 * у Telegram. Ничего не изменилось — `same` (без записи и событий).
 */
export function convPinOrderPlan(
  current: readonly string[],
  ids: readonly string[],
): { kind: 'bad' } | { kind: 'same' } | { kind: 'ok'; order: string[] } {
  const known = new Set(current);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id) || !known.has(id)) return { kind: 'bad' };
    seen.add(id);
  }
  const order = [...ids, ...current.filter((id) => !seen.has(id))];
  return order.every((id, i) => id === current[i]) ? { kind: 'same' } : { kind: 'ok', order };
}

/**
 * Отметки закрепа для нового порядка: верхняя — `base`, каждая следующая на миллисекунду раньше (ISO в списке и сводке —
 * с миллисекундами, `toISOString`), чтобы `convListOrder` и клиентский `byRecent` дали тот же порядок, а закреп после
 * перестановки (его `now()` позже `base`) встал выше всех, как у Telegram.
 */
export function convPinOrderStamps(base: Date, count: number): Date[] {
  const top = Math.floor(base.getTime());
  return Array.from({ length: count }, (_, i) => new Date(top - i));
}

/**
 * Предел текста одного сообщения — 4096 знаков UTF-16, как у Telegram (Desktop `data_premium_limits.cpp`
 * `message_length_limit_default`, Android `maxMessageLength`). Было 4000; расширение безопасно: старые клиенты шлют ≤ 4000.
 */
export const MESSAGE_TEXT_MAX = 4096;

/** Потолок черновика — как у текста сообщения (`routes/conv.ts`, отправка). */
export const DRAFT_TEXT_MAX = MESSAGE_TEXT_MAX;

/**
 * Ответ на текст длиннее предела (07.10): словами, а не строкой проверки zod «String must contain at most N
 * character(s)» — её клиент показывал как есть. Клиенты постарше переводят ту строку сами (`longTextRules.humanLengthError`).
 */
export const TEXT_TOO_LONG = `Слишком длинное сообщение: не больше ${MESSAGE_TEXT_MAX} знаков`;

/**
 * Черновик к записи (Р7): ни текста, ни ответа — удалён (`null`). Правило то же, что у клиента
 * (`convSyncRules.updateDrafts`): пробелы без ответа — пусто, иначе текст хранится как набран.
 */
export function normalizeDraft(text: string, replyToId: string | null): { text: string; replyToId: string | null } | null {
  return !text.trim() && !replyToId ? null : { text, replyToId };
}

/** Тот же черновик — записи и строки журнала не нужно (повторное сохранение с другого устройства тоже). */
export function sameDraft(
  a: { text: string; replyToId: string | null } | null,
  b: { text: string; replyToId: string | null } | null,
): boolean {
  if (!a || !b) return a === b;
  return a.text === b.text && a.replyToId === b.replyToId;
}

/** Метка устройства от клиента: короткая строка без пробелов — уходит обратно в сводке как есть. */
export function isDraftDevice(x: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(x);
}

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
 * Кому слать эффект «большой» реакции `reaction.big` (08.10, `bigreact1`, G43; Telegram Android `sendReaction(…, big)` →
 * `messagePeerReaction.big`, эффект `ReactionsEffectOverlay.LONG_ANIMATION` у тех, кто видит сообщение).
 * - только постановка (`op: 'add'`) с `big`; снятие «большим» не бывает;
 * - и при ПОВТОРЕ уже стоящей реакции (`changed: false`): у Telegram удержание по своей реакции снова играет большую — строка в
 *   базе одна, событие — лишь эффект, частоту держит лимит реакций;
 * - тем же, до кого дошла реакция (`changeAudience`: придержанное — никому, заблокировавшим реагирующего — нет), КРОМЕ самого
 *   реагирующего: свою он проиграл на месте.
 */
export function bigReactionTargets(input: {
  big: boolean;
  op: 'add' | 'remove';
  actorId: string;
  /** `ReactResult.audience` — кому дошла реакция, вместе с реагирующим. */
  audience: readonly string[];
}): string[] {
  if (!input.big || input.op !== 'add') return [];
  return input.audience.filter((id) => id !== input.actorId);
}

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

/**
 * Стикер последнего сообщения из «сырого» jsonb (0092, `stickers2`): объект с непустым `url` — стикер, остальное (NULL,
 * мусор, строка, которую не разобрать) — нет. Эмодзи — строка или пусто.
 */
export function stickerOf(v: unknown): { emoji: string } | null {
  let o: unknown = v;
  if (typeof v === 'string') {
    try {
      o = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.url !== 'string' || !r.url) return null;
  return { emoji: typeof r.emoji === 'string' ? r.emoji : '' };
}

/**
 * Текст превью строки списка (`ConvLastMessage.text`) с учётом стикера: у стикера без текста — его эмодзи (клиент пишет
 * «😀 Стикер», как Telegram); у остальных — `previewText(content)`, как было.
 */
export function stickerAwarePreview(content: string, sticker: unknown): { text: string } {
  const st = stickerOf(sticker);
  return { text: previewText(content || (st?.emoji ?? '')) };
}

/** Поля вида вложений в `ConvLastMessage` (раунд 11; `attachmentVideo` — 05.10). */
export type LastAttachmentPreview = Pick<
  ConvLastMessage,
  'attachmentKind' | 'attachmentDurationMs' | 'attachmentName' | 'attachmentVideo' | 'attachmentGif' | 'attachmentOnce' | 'attachmentRound'
>;

/**
 * Что за вложения у последнего сообщения — для превью в строке списка бесед (раунд 11, `docs/design/design-step11`).
 * Вход — вложения как они лежат в `conversation_messages.attachments` (jsonb; у перенесённых до шага 1в полей бывает
 * меньше — поэтому каждое поле проверяется). Вложений нет — `null`: полей в сводке нет вовсе.
 * - первое — голосовое (огибающая + `audio/*`, то же правило, что `isVoiceMessage` в `@gusvoice/shared`; голосовое
 *   уходит одно) — `voice` и длительность, если известна;
 * - ВСЕ вложения — картинки — `photo` («Фото», «3 фото»);
 * - иначе — `file` и имя первого (одним абзацем, как текст превью). Смесь картинки с файлом — тоже `file`: «2 файла»
 *   честнее, чем «2 фото».
 * - ВСЕ вложения — видео (`video/*`, 05.10) — тоже `file` с именем первого, плюс `attachmentVideo` (и длительность,
 *   если вложение её несёт): новый клиент пишет «Видео», клиент до этой правки — «Файл: имя», как раньше. Новый вид
 *   `video` старый клиент считал бы незнакомым и писал бы «Вложение».
 * - ВСЕ вложения — GIF (`gif: true` — пометка сервера у вложения из «GIF»-выбора, 08.10, `gifs1`; просто файл `image/gif` без неё остаётся фото) — к виду выше добавляется `attachmentGif`:
 *   новый клиент пишет «GIF» (Telegram `AttachGif`), прежний — «Фото» / «Видео», как раньше.
 * `sticker` отсюда не выходит: стикер — поле сообщения, а не вложение; вид `sticker` ставит вызывающий по `stickerOf`
 * (сводка беседы и закреп, `conversations.ts`, `stickers2`).
 */
export function lastAttachmentPreview(list: readonly unknown[]): LastAttachmentPreview | null {
  const atts = list.filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && !Array.isArray(a));
  if (atts.length === 0) return null;
  const type = (a: Record<string, unknown>) => (typeof a.contentType === 'string' ? a.contentType : '');
  const isVoice = (a: Record<string, unknown>) =>
    Array.isArray(a.waveform) && a.waveform.length > 0 && type(a).startsWith('audio/');
  const first = atts[0];
  const ms = first.durationMs;
  const duration = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : null;
  if (isVoice(first)) {
    // «Один раз» (`voice3`, G54) — «Одноразовое голосовое сообщение»; поле только у таких.
    const once = first.once === true ? ({ attachmentOnce: true } as const) : {};
    return duration !== null
      ? { attachmentKind: 'voice', attachmentDurationMs: duration, ...once }
      : { attachmentKind: 'voice', ...once };
  }
  const gif = atts.every((a) => a.gif === true) ? ({ attachmentGif: true } as const) : {};
  if (atts.every((a) => type(a).startsWith('image/') && !isVoice(a))) return { attachmentKind: 'photo', ...gif };
  const name = typeof first.name === 'string' ? previewText(first.name) : '';
  const file: LastAttachmentPreview = name
    ? { attachmentKind: 'file', attachmentName: name, ...gif }
    : { attachmentKind: 'file', ...gif };
  if (!atts.every((a) => type(a).startsWith('video/'))) return file;
  // Кружок (`circles1`, 08.10): «Видеосообщение» (tdesktop `lng_in_dlg_video_message`), одноразовый — с `attachmentOnce`.
  if (first.round === true) {
    const once = first.once === true ? ({ attachmentOnce: true } as const) : {};
    return duration !== null
      ? { ...file, attachmentVideo: true, attachmentRound: true, attachmentDurationMs: duration, ...once }
      : { ...file, attachmentVideo: true, attachmentRound: true, ...once };
  }
  return duration !== null
    ? { ...file, attachmentVideo: true, attachmentDurationMs: duration }
    : { ...file, attachmentVideo: true };
}

/** Поля вложений цитаты (`MessageReplyPreview`, 05.10) — без миниатюры: её ссылка — дело вызывающего. */
export type ReplyAttachmentPreview = LastAttachmentPreview & { attachments?: number };

/**
 * Что за вложения у цитируемого (05.10): та же форма, что у превью строки списка (`lastAttachmentPreview`) плюс их
 * число; стикер (`sticker` — в каналах: у сообщения беседы его нет) — вид `sticker`, без числа. Ни вложений, ни
 * стикера — пусто: DTO цитаты остаётся прежним. Миниатюру кладёт вызывающий: у закрытого файла ЛС это ссылка
 * смотрящего.
 */
export function replyAttachmentPreview(list: readonly unknown[], sticker = false): ReplyAttachmentPreview {
  if (sticker) return { attachmentKind: 'sticker' };
  const kind = lastAttachmentPreview(list);
  return kind ? { attachments: list.length, ...kind } : {};
}

/** Что нужно знать о вложении, чтобы решить, отдать ли его человеку (шаг 1в). */
export interface AttachmentAccessInput {
  viewerId: string;
  /** Аккаунт смотрящего удалён — ссылка больше не работает, даже если была выдана. */
  viewerDeleted: boolean;
  att: { ownerId: string; conversationId: string; state: 'pending' | 'attached' | 'deleted' | 'scheduled'; messageId: string | null };
  /** Участие СМОТРЯЩЕГО в беседе вложения; `null` — не участник. */
  member: { leftAt: Date | string | null } | null;
  /** Сообщение, к которому прикреплено вложение (для `attached`). */
  message: (ViewableMessage & { conversationId: string }) | null;
}

/**
 * Отдать ли файл ЛС этому человеку (разбор Codex 30.09, п. 8): одного участия в беседе мало.
 * - удалённое вложение и удалённый аккаунт — никому;
 * - незавершённая загрузка (`pending`) — только загрузившему, пока он участник;
 * - файл, ждущий в отложенном сообщении (`scheduled`, 06.10, `conv10`), — тоже только автору (вид «Отложенные»): собеседник
 *   не узнаёт ни о файле, ни о самом отложенном, пока оно не ушло;
 * - прикреплённое — участнику без `left_at`, если сообщение из ЭТОЙ беседы и видно ему (`messageView`): надгробие,
 *   спрятанное им «у себя» и чужое придержанное — нет.
 */
export function attachmentAccess(i: AttachmentAccessInput): boolean {
  if (i.viewerDeleted || i.att.state === 'deleted') return false;
  if (!i.member || i.member.leftAt) return false;
  if (i.att.state === 'pending' || i.att.state === 'scheduled') return i.att.ownerId === i.viewerId;
  if (!i.message || i.att.messageId === null) return false;
  if (i.message.conversationId !== i.att.conversationId) return false;
  return messageView(i.message, i.viewerId) === 'full';
}

// ─── Пачки: пересылка и удаление выделенного (04.10, признак `conv5`) ───────────────────────────────────────────────

/** Сообщений в одной пачке — пересылки и удаления (как у Telegram: выделить можно до 100). */
export const MESSAGE_BATCH_MAX = 100;

/**
 * Предел вложений одной пересылки: файлы копируются (`attachments.copyForForward`), и сколько копий держит одна операция,
 * столько же, сколько у человека может висеть незавершённых загрузок (`attachmentRules.PENDING_MAX_COUNT` /
 * `PENDING_MAX_BYTES`, 40 файлов / 6 ГиБ с 09.10, было 600 МиБ): копии живут в `pending` секунды до привязки. Числа здесь, а не импортом:
 * этот модуль — чистый и тянет только `node:crypto`. Суточный объём пересылки — `DM_DAILY_UPLOAD_BYTES` (задача bigfix).
 */
export const FORWARD_ATTACHMENTS_MAX = 40;
export const FORWARD_BYTES_MAX = 6 * 1024 * 1024 * 1024;

/**
 * id отправки i-го сообщения пачки пересылки — из id отправки пачки (`clientId` запроса). Уникальность `(автор,
 * client_id)` и повтор без дублей работают так же, как у обычной отправки; строка — UUID версии 8 (RFC 9562, «своя»
 * раскладка): проходит любую проверку формата и не совпадает с UUID v4/v7, которые клиент выдаёт сам.
 */
export function forwardClientId(clientId: string, index: number): string {
  const h = createHash('sha256').update(`gv-fwd-v1:${clientId.toLowerCase()}:${index}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Отпечаток i-го сообщения пачки пересылки (своя версия `'f1'`, не `'p1'` отправки): беседа-получатель, беседа-источник,
 * НАБОР пересылаемых (порядок в запросе не важен — порядок задают оригиналы) и номер в пачке. Повтор с теми же — то же
 * сообщение, с другими (другой набор, другая беседа) — 409.
 */
export function forwardPayloadHash(p: {
  conversationId: string;
  fromConversationId: string;
  messageIds: readonly string[];
  index: number;
}): string {
  const canon = JSON.stringify(['f1', p.conversationId, p.fromConversationId, [...p.messageIds].sort(), p.index]);
  return createHash('sha256').update(canon).digest('hex');
}

/**
 * Повтор пересылки: что уже есть у автора по id отправки сообщений пачки. Пачка пишется ОДНОЙ транзакцией — в базе
 * либо вся, либо ничего, поэтому «есть часть» или «есть, но с другим отпечатком» — это другая пачка с тем же id (409).
 */
export function forwardReplayDecision(
  existing: readonly { clientId: string | null; payloadHash: string | null }[],
  expected: readonly { clientId: string; hash: string }[],
): IdempotencyDecision {
  if (existing.length === 0) return 'insert';
  if (existing.length !== expected.length) return 'conflict';
  const byId = new Map(existing.map((e) => [e.clientId, e.payloadHash]));
  return expected.every((x) => byId.get(x.clientId) === x.hash) ? 'replay' : 'conflict';
}

/**
 * «Переслано от» в строке сообщения: автор оригинала, его имя на момент пересылки, время оригинала (ISO); `deleted` —
 * аккаунт автора удалён (05.10, только у удалённого; ставит обезличивание, `accountRows`).
 */
export interface ForwardedFrom {
  userId: string;
  displayName: string;
  at: string;
  deleted?: true;
}

/**
 * «Переслано от» нового сообщения. Пересылают пересланное — остаётся ПЕРВЫЙ автор и время оригинала (как у Telegram:
 * цепочка пересылок не подменяет автора тем, кто переслал по дороге), с признаком `deleted`, если он был в снимке.
 * Пересылают сообщение удалённого автора (`authorDeleted`) — снимок сразу с `deleted`, как после обезличивания.
 */
export function forwardedFromOf(src: {
  authorId: string;
  authorName: string;
  createdAt: Date | string;
  forwardedFrom: ForwardedFrom | null;
  /** Аккаунт автора оригинала удалён (обезличен). */
  authorDeleted?: boolean;
}): ForwardedFrom {
  if (src.forwardedFrom) {
    const f = src.forwardedFrom;
    return { userId: f.userId, displayName: f.displayName, at: f.at, ...(f.deleted === true ? { deleted: true as const } : {}) };
  }
  const at = (typeof src.createdAt === 'string' ? new Date(src.createdAt) : src.createdAt).toISOString();
  return { userId: src.authorId, displayName: src.authorName, at, ...(src.authorDeleted ? { deleted: true as const } : {}) };
}

/**
 * Номер журнала каждой строки пачки. `journal` пишет строки одного человека подряд в порядке передачи и возвращает его
 * последний номер: k-я строка человека с `n` строками получает `last − n + 1 + k`. Нужен, чтобы у каждого сообщения
 * пачки было своё событие со своим `pts` — клиент применяет их подряд, как обычные отправки.
 */
export function entryPts(entries: readonly { userId: string }[], last: ReadonlyMap<string, number>): number[] {
  const total = new Map<string, number>();
  for (const e of entries) total.set(e.userId, (total.get(e.userId) ?? 0) + 1);
  const seen = new Map<string, number>();
  return entries.map((e) => {
    const k = seen.get(e.userId) ?? 0;
    seen.set(e.userId, k + 1);
    const end = last.get(e.userId);
    if (end === undefined) throw new Error(`нет номера журнала для ${e.userId}`);
    return end - (total.get(e.userId) ?? 0) + 1 + k;
  });
}

// ─── Удаление: своё и чужое (С1, 04.10, признак `conv6`) ─────────────────────────────────────────────────────────────

/** Вид беседы (`conversations.kind`): 1:1 или группа (этап 3). */
export type ConversationKind = 'direct' | 'group';

/**
 * С1 (04.10, признак `conv6`, решение владельца «как в Telegram»): удалить ЧУЖОЕ сообщение «у обоих» может любой из двух
 * участников беседы 1:1 — переписка принадлежит обоим. В группе (этап 3) — только своё, как было.
 */
export function othersDeletableForBoth(kind: ConversationKind): boolean {
  return kind === 'direct';
}

export type DeleteAction = 'hide' | 'tombstone' | 'repeat' | 'forbidden' | 'not-found';

/**
 * Что сделать с ОДНИМ сообщением (`DELETE /conv/:id/messages/:mid`, старая `DELETE /dm/:id/messages/:mid`):
 * - `me` — видимое мне прячется у меня (`hide`), уже спрятанное мной — `repeat`, невидимое — `not-found`;
 * - `both`, своё — надгробие у всех (`tombstone`), уже удалённое — `repeat` (ответ на первый запрос мог потеряться);
 * - `both`, чужое придержанное (его для меня нет) — `not-found`;
 * - `both`, чужое без права на чужое (`othersForBoth` = false: группа, старые ручки `/api/dm*`) — `forbidden`, а уже
 *   исчезнувшее для меня — `not-found`, как было до С1;
 * - `both`, чужое с правом (С1, беседа 1:1, новые ручки) — `tombstone`; уже удалённое у обоих — `repeat` (повтор или
 *   собеседник удалил сам); спрятанное мной «у меня» — `not-found`: право на чужое даётся тем, что оно есть в МОЕЙ
 *   переписке (пачка его пропускает — `batchDeleteDecision`).
 * `othersForBoth` по умолчанию `false`: право на чужое даётся явно (`othersDeletableForBoth`), забытый аргумент его не
 * расширит.
 */
export function deleteDecision(
  m: ViewableMessage | undefined,
  viewerId: string,
  scope: 'me' | 'both',
  othersForBoth = false,
): DeleteAction {
  if (!m) return 'not-found';
  if (scope === 'me') {
    if (m.hiddenFor.includes(viewerId)) return 'repeat';
    return messageView(m, viewerId) === 'full' ? 'hide' : 'not-found';
  }
  if (m.authorId === viewerId) return m.deletedAt ? 'repeat' : 'tombstone';
  if (m.withheld) return 'not-found';
  if (!othersForBoth) return m.deletedAt || m.hiddenFor.includes(viewerId) ? 'not-found' : 'forbidden';
  if (m.deletedAt) return 'repeat';
  return m.hiddenFor.includes(viewerId) ? 'not-found' : 'tombstone';
}

export type BatchDeleteAction = 'hide' | 'tombstone' | 'skip' | 'forbidden' | 'not-found';

/**
 * Что сделать с одним сообщением пачки удаления (`POST /conv/:id/messages/delete`). Права — те же, что у удаления по
 * одному (`deleteDecision`): `both` — своё, а с правом на чужое (`othersForBoth`, С1: беседа 1:1) — и чужое видимое
 * (надгробие); `me` — любое видимое (спрятать у себя).
 * - нет в этой беседе и чужое придержанное (его для меня нет вовсе) → `not-found`: вся пачка 404;
 * - чужое видимое «у обоих» без права на чужое → `forbidden`: вся пачка 403, не меняется ничего;
 * - уже исчезнувшее для меня (удалено у обоих, спрятано мной, чужое уже удалённое) → `skip`: результат тот, о котором
 *   просили, а собеседник мог удалить, пока человек выделял. Одиночное удаление отвечает тут 404 — у пачки это сорвало
 *   бы удаление остальных.
 * `othersForBoth` по умолчанию `false` — как у `deleteDecision`.
 */
export function batchDeleteDecision(
  m: ViewableMessage | undefined,
  viewerId: string,
  scope: 'me' | 'both',
  othersForBoth = false,
): BatchDeleteAction {
  if (!m) return 'not-found';
  if (m.withheld && m.authorId !== viewerId) return 'not-found';
  if (scope === 'me') return m.deletedAt || m.hiddenFor.includes(viewerId) ? 'skip' : 'hide';
  if (m.authorId !== viewerId) {
    if (m.deletedAt || m.hiddenFor.includes(viewerId)) return 'skip';
    return othersForBoth ? 'tombstone' : 'forbidden';
  }
  return m.deletedAt ? 'skip' : 'tombstone';
}

// ─── Закреп в беседе (С2, 05.10, признак `conv7`) ───────────────────────────────────────────────────────────────────

/**
 * Предел закреплённых у человека в одной беседе — столько же, сколько показывает список закреплённого в канале (50).
 * Список едет ЦЕЛИКОМ в каждом событии об изменении закрепа: без предела событие росло бы без конца.
 */
export const PINS_MAX = 50;

/** Как закрепляют и открепляют: только у себя (`me`) или ещё и у собеседника (`both`, галочка «…для собеседника»). */
export type PinScope = 'me' | 'both';

export type PinRowAction = 'insert' | 'share' | 'keep' | 'full';

/**
 * Что сделать со строкой закрепа ОДНОГО человека, когда сообщение закрепляют (`count` — сколько видимого ему уже
 * закреплено в этой беседе):
 * - строки нет — `insert`, а если список полон (`PINS_MAX`) — `full`;
 * - есть «только у себя», а закрепляют «для обоих» — `share`: закреп становится общим, у обоих одинаковым (и у обоих при
 *   откреплении будет галочка);
 * - иначе — `keep`: уже закреплено, повтор ничего не меняет, и «для меня» не снимает «для обоих».
 */
export function pinRowAction(existing: { forBoth: boolean } | undefined, scope: PinScope, count: number): PinRowAction {
  if (existing) return scope === 'both' && !existing.forBoth ? 'share' : 'keep';
  return count >= PINS_MAX ? 'full' : 'insert';
}

/**
 * Кому ставится закреп (С2): себе — всегда (что сообщение видно МНЕ, проверяет вызывающий); «для обоих» — ещё каждому
 * другому участнику, которому сообщение видно (`messageView`: не спрятано им «у себя», не придержано от него), кроме тех,
 * кто заблокировал закрепляющего, — правило реакций (`changeAudience`, `react`): действия заблокированного им не доходят,
 * а сам он этого не узнаёт — его закреп ставится как обычно.
 */
export function pinAudience(input: {
  message: ViewableMessage;
  actorId: string;
  scope: PinScope;
  /** Действующие участники, включая закрепляющего. */
  memberIds: readonly string[];
  /** Участники, заблокировавшие закрепляющего. */
  blockedActor: ReadonlySet<string>;
}): string[] {
  const { message, actorId, scope, memberIds, blockedActor } = input;
  if (scope === 'me') return [actorId];
  return [actorId, ...memberIds.filter((id) => id !== actorId && !blockedActor.has(id) && messageView(message, id) === 'full')];
}

/**
 * Чьи закрепы сообщения снимает открепление (С2): мой — всегда; `both` — ещё закрепы «для обоих» остальных участников,
 * кроме заблокировавших открепляющего (правило реакций). Закреп другого «только у себя» не трогается: это его личное —
 * открепляющий о нём не знает и прав на него не имеет.
 */
export function unpinTargets(input: {
  actorId: string;
  scope: PinScope;
  /** Строки закрепа этого сообщения (у всех участников). */
  rows: readonly { userId: string; forBoth: boolean }[];
  /** Участники, заблокировавшие открепляющего. */
  blockedActor: ReadonlySet<string>;
}): string[] {
  const { actorId, scope, rows, blockedActor } = input;
  return rows
    .filter((r) => r.userId === actorId || (scope === 'both' && r.forBoth && !blockedActor.has(r.userId)))
    .map((r) => r.userId);
}

/**
 * Цитата ответа, как она лежит в строке сообщения (`conversation_messages.reply_quote`, миграция 0117, `quote1`, G55):
 * фрагмент текста цитируемого и его смещение. `auto` — не выбранный человеком фрагмент, а снимок начала текста у ответа
 * из ДРУГОЙ беседы без цитаты: его видит читатель, у которого нет доступа к той беседе (в DTO `quote` у такого нет).
 */
/**
 * Предел цитаты — `REPLY_QUOTE_MAX` (`shared/ws.ts`, 1024). Своё значение здесь намеренно: модуль правил не берёт из пакетов
 * ничего, кроме типов (его компилируют в памяти контрфактные проверки, и лишняя зависимость там — падение).
 */
const REPLY_QUOTE_LIMIT = 1024;

export interface ReplyQuoteMark {
  text: string;
  offset: number;
  auto?: true;
}

/**
 * Проверить цитату фрагмента (`quote1`): непустая, не длиннее `REPLY_QUOTE_MAX` знаков UTF-16 и — подстрока текста
 * цитируемого. Смещение клиента берётся, если по нему стоит ровно эта цитата, иначе — первое вхождение. `null` — цитата
 * негодна (ручка отвечает 400).
 */
export function resolveReplyQuote(content: string, quote: { text: string; offset?: number }): ReplyQuoteMark | null {
  const { text } = quote;
  if (!text.trim() || text.length > REPLY_QUOTE_LIMIT) return null;
  if (quote.offset !== undefined && quote.offset >= 0 && content.startsWith(text, quote.offset)) return { text, offset: quote.offset };
  const at = content.indexOf(text);
  return at < 0 ? null : { text, offset: at };
}

/**
 * Снимок начала текста для ответа из другой беседы без цитаты (`ReplyQuoteMark.auto`): не длиннее `REPLY_QUOTE_MAX`,
 * суррогатную пару на краю не рвём.
 */
export function replyQuoteSnapshot(content: string): ReplyQuoteMark {
  let text = content.length > REPLY_QUOTE_LIMIT ? content.slice(0, REPLY_QUOTE_LIMIT) : content;
  const last = text.charCodeAt(text.length - 1);
  if (content.length > REPLY_QUOTE_LIMIT && last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  return { text, offset: 0, auto: true };
}
