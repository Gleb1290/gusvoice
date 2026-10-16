import type { ConvReadAt, LastSeenApprox, LastSeenPrivacy, UserLastSeen } from '@gusvoice/shared';

/**
 * «Был(а) в сети» и «Прочитано в …» (С1 плана «телеграмности», #211) — ЧИСТЫЕ правила, без базы и сокетов.
 *
 * Источник — Telegram (сверено по исходникам, код не копировали):
 * - приватность «Время захода»: Все / Мои контакты / Никто, ВЗАИМНО — скрыл своё от человека, его точное время тоже не
 *   видишь, вместо него примерное с пометкой «скрыто мной» (TL `userStatusRecently.by_me`, tdesktop
 *   `data/data_lastseen_status.h` `isHiddenByMe`, `lng_edit_privacy_lastseen_warning`);
 * - примерное время: недавно (до 2–3 суток) / на этой неделе (до 7) / в этом месяце (до 30) / давно (TL
 *   `userStatusRecently` / `LastWeek` / `LastMonth` / `Empty`; tdesktop `data_peer_values.cpp` `OnlineTextCommon`);
 * - «Отправить, когда будет в сети» — только если время захода не скрыто (tdesktop
 *   `history_view_schedule_box.cpp` `CanScheduleUntilOnline`: `!lastseen().isHidden()`), сервер иначе отвечает
 *   `SCHEDULE_STATUS_PRIVATE`;
 * - «Прочитано в 12:34» — только своё сообщение в личке, не старше 7 суток (`pm_read_date_expire_period`), и только если
 *   время прочтения не скрыто ни им, ни мной: «Скрывать время прочтения» действует на тех, от кого скрыто время захода
 *   (tdesktop `api/api_who_reacted.cpp` `WhoReadExists`, `readDatesPrivate`; `lng_edit_lastseen_hide_read_time_about`).
 *
 * Исключения по людям (G07, `lastseen3`; tdesktop `settings_privacy_controllers.cpp` `LastSeenPrivacyController`, общий ящик
 * `boxes/edit_privacy_box.cpp`): «Всегда показывать» (видна при «Собеседники» и «Никто») и «Никогда не показывать» (при «Все» и
 * «Собеседники») перекрывают правило; взаимность считается по ИТОГУ — если я прячу своё от X (правилом или исключением),
 * точного времени X я тоже не вижу.
 *
 * GusVoice: «Мои контакты» → «собеседники и люди с общих серверов» (`peers`, решение владельца Р-2, по умолчанию).
 * 🔴 `presence4` (решения владельца 08.10, отменяют ночное «скрытое время прячет и «в сети»» из `lastseen2`):
 * - «в сети» в ЛС — по факту присутствия и ВСЕГДА, даже при «Никто» / исключении «никогда»: приватность прячет только ВРЕМЯ,
 *   когда человек не в сети («был(а) недавно» вместо «был(а) 5 минут назад»), взаимность прежняя (прячу своё — не вижу чужое
 *   время, но чужое «в сети» вижу). Сидящему в сети точное время не отдаём вовсе (`at` — только у вышедшего);
 * - «Невидимый» — только для серверов (точка шлюза `online.update`): на «Время захода» и время прочтения он больше не влияет
 *   (параметр `invisible` у `sharesLastSeen` остался для совместимости, правила ЛС передают `false`).
 * Поле `online` ответа — прежнее (`lastseen2`: в сети, точка мне видна по шлюзу и время не скрыто), чтобы клиент без
 * `presence4` не остался с пустой строкой вместо «был(а) недавно»; новый клиент берёт «в сети» из присутствия шлюза
 * (`online.update` + `online.dm`).
 */

/** Telegram: «недавно» покрывает до 2–3 суток; берём 3. */
export const RECENTLY_MS = 3 * 86_400_000;
export const WEEK_MS = 7 * 86_400_000;
export const MONTH_MS = 30 * 86_400_000;
/** Telegram `pm_read_date_expire_period` по умолчанию — 7 суток. */
export const READ_DATE_EXPIRE_MS = 7 * 86_400_000;

export const LAST_SEEN_PRIVACY: readonly LastSeenPrivacy[] = ['everyone', 'peers', 'nobody'];
export const DEFAULT_LAST_SEEN_PRIVACY: LastSeenPrivacy = 'peers';

export function normalizeLastSeenPrivacy(v: unknown): LastSeenPrivacy {
  return LAST_SEEN_PRIVACY.includes(v as LastSeenPrivacy) ? (v as LastSeenPrivacy) : DEFAULT_LAST_SEEN_PRIVACY;
}

/** Предел исключений «Времени захода»: людей в каждом из двух списков (у Telegram — сотни; берём 200, как пачку last-seen). */
export const LAST_SEEN_EXCEPTIONS_MAX = 200;

/** Исключение хозяина настройки для одного человека: «Всегда показывать» / «Никогда не показывать» / нет. */
export type LastSeenException = 'always' | 'never' | null;

/** Списки исключений хозяина (id людей); пересечения быть не должно, а если есть — «Никогда» сильнее. */
export interface LastSeenExceptionSets {
  always: ReadonlySet<string>;
  never: ReadonlySet<string>;
}

/** Что у хозяина `side` записано про человека `otherId`. «Никогда» сильнее «Всегда» — на случай рассинхрона списков. */
export function exceptionOf(side: { exceptions?: LastSeenExceptionSets }, otherId: string): LastSeenException {
  if (side.exceptions?.never.has(otherId)) return 'never';
  if (side.exceptions?.always.has(otherId)) return 'always';
  return null;
}

/**
 * Чья сторона видна: человек с этой настройкой и статусом показывает ли время захода тому, кто `isPeer` с ним.
 * `exception` (G07, `lastseen3`) — исключение хозяина для ЭТОГО зрителя: «Всегда» показывает, «Никогда» прячет поверх правила
 * (Telegram: список «Always share with» при «Никто» и «Never share with» при «Все»). «Невидимый» сильнее любого исключения.
 */
export function sharesLastSeen(
  privacy: LastSeenPrivacy,
  invisible: boolean,
  isPeer: boolean,
  exception: LastSeenException = null,
): boolean {
  if (invisible) return false;
  if (exception === 'never') return false;
  if (exception === 'always') return true;
  if (privacy === 'everyone') return true;
  if (privacy === 'peers') return isPeer;
  return false;
}

/** Примерная категория по точному времени (`null` — не заходил: «давно»). */
export function approxOf(lastSeenAt: Date | null, now: number): LastSeenApprox {
  if (!lastSeenAt) return 'long';
  const age = now - lastSeenAt.getTime();
  if (age <= RECENTLY_MS) return 'recently';
  if (age <= WEEK_MS) return 'week';
  if (age <= MONTH_MS) return 'month';
  return 'long';
}

export interface LastSeenSide {
  id: string;
  privacy: LastSeenPrivacy;
  invisible: boolean;
  /** Исключения хозяина стороны (`lastseen3`); не заданы — их нет. */
  exceptions?: LastSeenExceptionSets;
}

/**
 * «В сети» / «был(а) …» человека `subject` глазами `viewer`.
 * `isPeer` — общий сервер или беседа (тот же `loadPeers`, что раздаёт онлайн); `connected` — у шлюза есть его сокет.
 */
export function lastSeenView(input: {
  subject: LastSeenSide & { lastSeenAt: Date | null };
  viewer: LastSeenSide;
  isPeer: boolean;
  connected: boolean;
  now: number;
  /**
   * F5 (приёмка 13.10): `subject` заблокировал `viewer` — как у Telegram, заблокированный видит «был(а) давно»: ни «в сети»,
   * ни времени, ни «недавно» (Android `LocaleController.formatUserStatus` при пустом статусе — `ALongTimeAgo`). Нет поля — как раньше.
   */
  blockedViewer?: boolean;
}): UserLastSeen {
  const { subject, viewer, isPeer, connected, now } = input;
  const self = subject.id === viewer.id;
  if (input.blockedViewer && !self) {
    return { userId: subject.id, online: false, at: null, approx: 'long', byMe: false, exact: false };
  }
  // Зелёная точка: её видят свои и соседи (общий сервер, беседа), «Невидимый» — не в сети (кроме себя самого).
  const online = connected && (self || (isPeer && !subject.invisible));
  if (self) {
    return { userId: subject.id, online, at: subject.lastSeenAt?.toISOString() ?? null, approx: null, byMe: false, exact: true };
  }
  // `presence4`: «Невидимый» на время захода в ЛС не влияет — только правило и исключения хозяина стороны.
  const theyShare = sharesLastSeen(subject.privacy, false, isPeer, exceptionOf(subject, viewer.id));
  const iShare = sharesLastSeen(viewer.privacy, false, isPeer, exceptionOf(viewer, subject.id));
  const exact = theyShare && iShare;
  // Поле `online` — для клиента `lastseen2` (без `presence4`): «в сети» только вместе с видимым временем; иначе «недавно».
  if (online && exact) return { userId: subject.id, online: true, at: null, approx: null, byMe: false, exact };
  // Точное время — только вышедшего: у сидящего в сети (в том числе «Невидимого») время входа выдало бы «зашёл в 14:02».
  if (exact && subject.lastSeenAt && !connected) {
    return { userId: subject.id, online: false, at: subject.lastSeenAt.toISOString(), approx: null, byMe: false, exact: true };
  }
  // Скрыто (или не заходил). Сидит в сети, но `online` выше не отдан (время скрыто, «Невидимый», чужой) — «недавно», не «давно».
  const approx = connected ? 'recently' : approxOf(subject.lastSeenAt, now);
  return { userId: subject.id, online: false, at: null, approx, byMe: theyShare && !iShare, exact };
}

export interface ReadTimeSide extends LastSeenSide {
  hideReadTime: boolean;
}

/**
 * Скрыто ли время прочтения в беседе 1:1 между `me` (автор) и `peer` (читатель). Взаимно: читатель прячет своё, когда у
 * него «Скрывать время прочтения» и время захода от меня скрыто; я прячу своё — тогда не вижу и его.
 */
export function readTimeHidden(me: ReadTimeSide, peer: ReadTimeSide, isPeer: boolean): boolean {
  // `presence4`: «Невидимый» на время прочтения не влияет (он — только про серверы).
  const peerHides = peer.hideReadTime && !sharesLastSeen(peer.privacy, false, isPeer, exceptionOf(peer, me.id));
  const iHide = me.hideReadTime && !sharesLastSeen(me.privacy, false, isPeer, exceptionOf(me, peer.id));
  return peerHides || iHide;
}

/** Ответ подвала меню своего сообщения. `readAt` — колонка сообщения (ставит `markRead`). */
export function readAtView(input: {
  read: boolean;
  readAt: Date | null;
  createdAt: Date;
  hidden: boolean;
  now: number;
}): ConvReadAt {
  const { read, readAt, createdAt, hidden, now } = input;
  if (!read) return { read: false, at: null, hidden: false };
  if (now - createdAt.getTime() >= READ_DATE_EXPIRE_MS) return { read: true, at: null, hidden: false };
  if (hidden) return { read: true, at: null, hidden: true };
  return { read: true, at: readAt ? readAt.toISOString() : null, hidden: false };
}

/** Участник группы глазами автора сообщения для «кто прочитал» (`readers1`). */
export interface GroupReaderSide extends ReadTimeSide {
  /** «Прочитано до» участника (`conversation_members.last_read_key`; у людей соседа — со слов их дома, `dmgroupmarks1`). */
  lastReadKey: number;
  deleted: boolean;
  /** Блокировка между ним и автором в ЛЮБУЮ сторону: заблокированный ничего не узнаёт, заблокировавшего не показываем. */
  blocked: boolean;
  /** «Собеседник» автора для правила времени захода (`arePeers`). */
  isPeer: boolean;
}

/**
 * Кто прочитал СВОЁ сообщение автора `me` в группе (15.10, `readers1`; Telegram `messages.getMessageReadParticipants`,
 * tdesktop `api_who_reacted.cpp` `WhoReadExists`: не старше `chat_read_mark_expire_period` = 7 суток). Прочитал — «прочитано
 * до» не меньше ключа сообщения (то же `>=`, что у ✓✓ `readByPeer`). Без автора, удалённых, блокировок и тех, у кого время
 * прочтения скрыто взаимным правилом 1:1 (`readTimeHidden`: скрыл он — его нет; скрыл я — не вижу и других). Порядок — входной.
 */
export function groupReaders(input: {
  me: ReadTimeSide;
  sortKey: number;
  createdAt: Date;
  now: number;
  members: readonly GroupReaderSide[];
}): { ids: string[]; expired: boolean } {
  const { me, sortKey, createdAt, now, members } = input;
  if (now - createdAt.getTime() >= READ_DATE_EXPIRE_MS) return { ids: [], expired: true };
  const ids = members
    .filter((m) => m.id !== me.id && !m.deleted && !m.blocked && m.lastReadKey >= sortKey && !readTimeHidden(me, m, m.isPeer))
    .map((m) => m.id);
  return { ids, expired: false };
}
