import { createHash } from 'node:crypto';

/**
 * Отложенные сообщения (С4, 05.10, признак `conv9`, раунд 12 — `docs/design/design-step12/PORT-PLAN.md` §3 «SchedPick»,
 * «Отложенные», §5 С4) — ЧИСТЫЕ правила: когда можно, когда пора, сколько можно, что делать при сбое. Без базы, env, Redis
 * и часов: «сейчас» приходит аргументом. Запись и планировщик — `scheduled.ts`, чтение и события — `conversations.ts`.
 *
 * Как в Telegram: «Отправить позже» (время) и «Когда будет в сети» (уйдёт, когда собеседник 1:1 появится в сети); лежат
 * на сервере и уходят, даже если автор не в сети; видит их только автор.
 */

/** Потолок текста — как у обычной отправки (`routes/conv.ts`). */
export const SCHEDULED_TEXT_MAX = 4096;
/** Пределы: в одной беседе — как у Telegram (100), всего у человека — 500 (`scheduledLimit`). */
export const SCHEDULED_PER_CONVERSATION_MAX = 100;
export const SCHEDULED_PER_USER_MAX = 500;
/** Как далеко вперёд — год (как у Telegram). */
export const SCHEDULE_MAX_AHEAD_DAYS = 365;
/**
 * Насколько `sendAt` может быть в прошлом — минута: часы клиента и сервера расходятся, а человек мог выбрать ближайшую
 * минуту, которая успела наступить, пока шёл запрос. Такое уходит ближайшим тактом. Раньше — 400 `send_at in the past`.
 */
export const SCHEDULE_PAST_GRACE_MS = 60_000;
/** Такт планировщика и сколько строк он разбирает за раз (остальные — следующим тактом). */
export const SCHED_TICK_MS = 5_000;
export const SCHED_TICK_BATCH = 100;
/** Неудачных попыток отправки подряд, после которых сервер сдаётся (`failed`, причина `error`). */
export const SCHED_MAX_ATTEMPTS = 8;
const SCHED_RETRY_BASE_MS = 30_000;
const SCHED_RETRY_MAX_MS = 60 * 60_000;
/**
 * Отложенные С ВЛОЖЕНИЯМИ (06.10, признак `conv10`). Число файлов и размер каждого — как у обычной отправки (до 10 в
 * сообщении — схема ручки, до 25 МБ — приём загрузки). Сверх того: файлы лежат в хранилище до отправки и не видны никому,
 * кроме автора, поэтому свои пределы — таких отложенных в одной беседе не больше `SCHEDULED_MEDIA_PER_CONVERSATION_MAX`, а
 * файлов, ждущих в отложенных, у человека во всех беседах — не больше `SCHEDULED_MEDIA_BYTES_PER_USER_MAX` (1 ГиБ: десяток
 * тяжёлых альбомов или тысячи сжатых фото; без предела 500 отложенных по 10 файлов по 25 МБ — до 125 ГБ на человека).
 */
export const SCHEDULED_MEDIA_PER_CONVERSATION_MAX = 20;
export const SCHEDULED_MEDIA_BYTES_PER_USER_MAX = 1024 * 1024 * 1024;
/** Машинная причина отказа 409 (`reason`) — по ней клиент узнаёт предел отложенных с файлами; `error` — текст человеку. */
export const SCHEDULED_MEDIA_LIMIT_REASON = 'scheduled_media_limit';

const DAY_MS = 24 * 60 * 60 * 1000;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Строка времени ISO 8601 с поясом (`Z` или `±чч:мм`) → миллисекунды; иначе `null`. Строго: несуществующая дата
 * («30 февраля» — `Date.parse` молча делает из неё 2 марта), час 24, время без пояса (чей это час — неизвестно) — мусор.
 */
export function parseIsoInstant(raw: string): number | null {
  const m = ISO_RE.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const s = m[6] ? Number(m[6]) : 0;
  const ms = m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0;
  if (y < 2000 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59) return null;
  let offsetMin = 0;
  if (!m[8]) {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (oh > 14 || om > 59) return null;
    offsetMin = (m[9] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  return Date.UTC(y, mo - 1, d, h, mi, s, ms) - offsetMin * 60_000;
}

/** Когда уйдёт отложенное: в момент `sendAt` или когда собеседник будет в сети. */
export type ScheduleTarget = { sendAt: Date; whenOnline: false } | { sendAt: null; whenOnline: true };

export type ScheduleTargetError = 'schedule mode required' | 'bad send_at' | 'send_at in the past' | 'send_at too far';

/**
 * Разобрать режим из запроса: ровно одно из `sendAt` (строка ISO с поясом) и `whenOnline: true`; оба или ни одного —
 * `schedule mode required`. `sendAt` — не раньше «сейчас» минус `SCHEDULE_PAST_GRACE_MS` и не дальше
 * `SCHEDULE_MAX_AHEAD_DAYS` дней вперёд.
 */
export function scheduleTarget(
  input: { sendAt?: string | null; whenOnline?: boolean },
  now: Date,
): { ok: true; target: ScheduleTarget } | { ok: false; error: ScheduleTargetError } {
  const online = input.whenOnline === true;
  const hasAt = typeof input.sendAt === 'string';
  if (online === hasAt) return { ok: false, error: 'schedule mode required' };
  if (online) return { ok: true, target: { sendAt: null, whenOnline: true } };
  const at = parseIsoInstant(input.sendAt as string);
  if (at === null) return { ok: false, error: 'bad send_at' };
  if (at < now.getTime() - SCHEDULE_PAST_GRACE_MS) return { ok: false, error: 'send_at in the past' };
  if (at > now.getTime() + SCHEDULE_MAX_AHEAD_DAYS * DAY_MS) return { ok: false, error: 'send_at too far' };
  return { ok: true, target: { sendAt: new Date(at), whenOnline: false } };
}

/** Тот же ли режим и время (правка, которая ничего не меняет, — без журнала). */
export function sameTarget(a: { sendAt: Date | null; whenOnline: boolean }, b: ScheduleTarget): boolean {
  if (a.whenOnline !== b.whenOnline) return false;
  return (a.sendAt?.getTime() ?? null) === (b.sendAt?.getTime() ?? null);
}

/**
 * Отпечаток запроса СОЗДАНИЯ отложенного (своя версия `'s1'`): повтор с тем же id отправки и тем же отпечатком — то же
 * отложенное (200), с другим — 409. Входит всё, что задаёт запрос: беседа, текст (после `trim`), ответ, «без звука» и
 * режим со временем, а с вложениями (`conv10`) — и их id по порядку. Без вложений строка та же, что до `conv10`: повтор
 * текстового создания, начатого на прежнем сервере, узнаёт своё. Отпечаток хранится и при правке не меняется: запоздалый
 * повтор создания узнаёт своё и после правки.
 */
export function schedPayloadHash(p: {
  conversationId: string;
  content: string;
  replyToId: string | null;
  silent: boolean;
  target: ScheduleTarget;
  attachmentIds?: readonly string[];
}): string {
  const when = p.target.whenOnline ? 'online' : p.target.sendAt.toISOString();
  const files = p.attachmentIds && p.attachmentIds.length > 0 ? [[...p.attachmentIds]] : [];
  const canon = JSON.stringify(['s1', p.conversationId, p.content, p.replyToId ?? null, p.silent, when, ...files]);
  return createHash('sha256').update(canon).digest('hex');
}

/** Предел: `null` — можно ещё одно; иначе — какой предел упёрся (ответ 409 `{error: 'scheduled limit', scope, max}`). */
export function scheduledLimit(counts: {
  inConversation: number;
  total: number;
}): { scope: 'conversation' | 'user'; max: number } | null {
  if (counts.inConversation >= SCHEDULED_PER_CONVERSATION_MAX) return { scope: 'conversation', max: SCHEDULED_PER_CONVERSATION_MAX };
  if (counts.total >= SCHEDULED_PER_USER_MAX) return { scope: 'user', max: SCHEDULED_PER_USER_MAX };
  return null;
}

/** Какой предел отложенных с вложениями упёрся: в беседе — по числу, у человека — по объёму файлов. */
export type ScheduledMediaLimit = { scope: 'conversation'; max: number } | { scope: 'user'; maxBytes: number };

/**
 * Предел отложенных С ВЛОЖЕНИЯМИ (`conv10`): `null` — можно; иначе — какой упёрся. `mediaInConversation` — сколько моих
 * отложенных с файлами уже в беседе, `parkedBytes` — объём моих файлов, ждущих в отложенных (все беседы), `addBytes` — файлы
 * нового. Ровно до предела — можно: 20-е в беседе и ровно 1 ГиБ проходят, 21-е и байт сверх — нет.
 */
export function scheduledMediaLimit(c: { mediaInConversation: number; parkedBytes: number; addBytes: number }): ScheduledMediaLimit | null {
  if (c.mediaInConversation >= SCHEDULED_MEDIA_PER_CONVERSATION_MAX) {
    return { scope: 'conversation', max: SCHEDULED_MEDIA_PER_CONVERSATION_MAX };
  }
  if (c.parkedBytes + c.addBytes > SCHEDULED_MEDIA_BYTES_PER_USER_MAX) {
    return { scope: 'user', maxBytes: SCHEDULED_MEDIA_BYTES_PER_USER_MAX };
  }
  return null;
}

/**
 * Тело отказа 409 на предел отложенных с вложениями: `error` — словами (клиент показывает его в тосте как есть), `reason` —
 * машинная причина, `scope` и сам предел (`max` — штук в беседе, `maxBytes` — байт у человека).
 */
export function scheduledMediaLimitBody(l: ScheduledMediaLimit): {
  error: string;
  reason: string;
  scope: 'conversation' | 'user';
  max?: number;
  maxBytes?: number;
} {
  return l.scope === 'conversation'
    ? { error: `Отложенных с файлами в одной беседе — не больше ${l.max}`, reason: SCHEDULED_MEDIA_LIMIT_REASON, scope: l.scope, max: l.max }
    : {
        error: `Файлы в отложенных сообщениях — не больше ${Math.round(l.maxBytes / 1024 ** 3)} ГБ: отправьте или удалите часть`,
        reason: SCHEDULED_MEDIA_LIMIT_REASON,
        scope: l.scope,
        maxBytes: l.maxBytes,
      };
}

/**
 * Состояние собеседника для «Когда будет в сети»: `online` — в сети ГЛАЗАМИ АВТОРА (живое соединение со шлюзом и статус
 * не «невидимый»: иначе уход отложенного выдал бы автору, что невидимый на самом деле в сети); `offline`; `gone` — писать
 * некому (аккаунт удалён, собеседника в беседе нет).
 */
export type PeerPresence = 'online' | 'offline' | 'gone';

export function peerPresence(p: { exists: boolean; deleted: boolean; connected: boolean; status: string }): PeerPresence {
  if (!p.exists || p.deleted) return 'gone';
  return p.connected && p.status !== 'invisible' ? 'online' : 'offline';
}

/** Поля строки, по которым решается «пора». */
export interface SchedRipeRow {
  sendAt: Date | null;
  whenOnline: boolean;
  failedAt: Date | null;
  nextAttemptAt: Date | null;
}

/**
 * Пора ли разбирать строку (планировщик; то же условие — SQL `scheduled.ripeWhere`, менять оба места вместе):
 * - сдавшаяся (`failedAt`) — никогда, пока автор не вернёт её новым временем/режимом или «Отправить сейчас»;
 * - после сбоя — не раньше `nextAttemptAt`;
 * - «Отправить позже» — когда `sendAt` наступило (`sendAt <= now`);
 * - «Когда будет в сети» — когда собеседник в сети, а когда писать некому (`gone`) — сразу: строку надо пометить
 *   «не отправлено», а не держать вечно.
 */
export function isRipe(row: SchedRipeRow, now: Date, peer: PeerPresence): boolean {
  if (row.failedAt) return false;
  if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now.getTime()) return false;
  if (row.whenOnline) return peer !== 'offline';
  return !!row.sendAt && row.sendAt.getTime() <= now.getTime();
}

/** Отсрочка перед следующей попыткой после `attempts` неудач подряд: 30 с, 1, 2, 4… мин, не больше часа. */
export function schedRetryDelayMs(attempts: number): number {
  return Math.min(SCHED_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), SCHED_RETRY_MAX_MS);
}

/**
 * Что записать после неудачной попытки: число неудач, следующая попытка или «сдаться». Без вечного цикла: на
 * `SCHED_MAX_ATTEMPTS`-й неудаче (около часа повторов) строка помечается «не отправлено» (`failed`, причина `error`) и
 * остаётся у автора — вернуть её можно «Отправить сейчас» или новым временем.
 */
export function schedFailurePlan(
  attemptsBefore: number,
  now: Date,
): { attempts: number; giveUp: true; nextAttemptAt: null } | { attempts: number; giveUp: false; nextAttemptAt: Date } {
  const attempts = attemptsBefore + 1;
  if (attempts >= SCHED_MAX_ATTEMPTS) return { attempts, giveUp: true, nextAttemptAt: null };
  return { attempts, giveUp: false, nextAttemptAt: new Date(now.getTime() + schedRetryDelayMs(attempts)) };
}

/**
 * Что делать со строкой, которую пора отправить: `drop` — автора нет (аккаунт удалён, вышел из беседы): отправлять не от
 * кого и показывать некому, строка удаляется; `peer-gone` — собеседник удалил аккаунт: писать некому, строка остаётся у
 * автора «не отправлено»; `send` — обычная отправка.
 */
export function schedSendDecision(i: {
  authorMember: boolean;
  authorDeleted: boolean;
  peerExists: boolean;
  peerDeleted: boolean;
}): 'send' | 'drop' | 'peer-gone' {
  if (!i.authorMember || i.authorDeleted) return 'drop';
  if (!i.peerExists || i.peerDeleted) return 'peer-gone';
  return 'send';
}
