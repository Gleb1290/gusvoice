import { FEATURE_LASTSEEN1, type ConvReadAt, type UserLastSeen } from '@gusvoice/shared';

/**
 * «В сети» / «был(а) …» и «Прочитано в …» (С1, #211) — ЧИСТЫЕ формулировки, как у Telegram Desktop.
 *
 * Источник: tdesktop `data/data_peer_values.cpp` — `OnlineText` (шапка: < 1 мин «только что», < 60 мин «N минут назад»,
 * < 12 ч «N часов назад», тот же день «сегодня в ЧЧ:ММ», вчера «вчера в ЧЧ:ММ», иначе дата), `OnlineTextFull` (профиль:
 * то же, но вместо даты «дата в время»), `OnlineTextCommon` (примерные: «недавно / на этой неделе / в этом месяце /
 * давно»), `OnlinePhraseChangeInSeconds` (когда строка сменится: граница минуты, часа, полночь); русские строки —
 * ресерч `tg-research/03-navigation.md` 2.1.1. «Прочитано»: `api/api_who_reacted.cpp` `FormatReadDate` (сегодня /
 * вчера / «5 янв.» + время).
 */

/** Сервер отдаёт «был(а) в сети» и «Прочитано в …» (`lastseen1`); без признака — прежние «в сети» / пусто и ✓✓. */
export function serverLastSeen(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_LASTSEEN1);
}

/** Окно «кто прочитал» — 7 суток от отправки (tdesktop `WhoReadExists`, `chat_read_mark_expire_period`); старше — строки нет. */
export const READERS_EXPIRE_MS = 7 * 86_400_000;

/**
 * Показывать ли строку «кто прочитал» в меню сообщения группы: своё, уже с ✓✓ (кто-то прочитал — Telegram Web A
 * `!isMessageUnread`, tdesktop `unseen → false`) и не старше 7 суток. Нет времени отправки — нет строки.
 */
export function readersLineShown(input: { mine: boolean; read: boolean; createdAt: string | undefined; now: number }): boolean {
  const { mine, read, createdAt, now } = input;
  if (!mine || !read || !createdAt) return false;
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && now - t < READERS_EXPIRE_MS;
}

/**
 * Текст строки «кто прочитал» (Telegram Web A `MessageContextMenu` — один прочитавший: его имя; несколько —
 * `ConversationContextMenuSeen`; никого — `ConversationContextMenuNoViews`; tdesktop `lng_context_seen_text`).
 */
export function readersLabel(names: readonly string[]): string {
  if (names.length === 0) return 'Никто не прочитал';
  if (names.length === 1) return names[0];
  return `${names.length} прочитали`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const ddmmyy = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${pad(d.getFullYear() % 100)}`;
const MONTHS_SHORT = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];

export function dayDiff(a: Date, b: Date): number {
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((db - da) / 86_400_000);
}

const APPROX: Record<NonNullable<UserLastSeen['approx']>, string> = {
  recently: 'был(а) недавно',
  week: 'был(а) на этой неделе',
  month: 'был(а) в этом месяце',
  long: 'был(а) давно',
};

/**
 * Строка статуса. `full` — профиль (дата с временем), иначе шапка беседы (только дата). Битая дата — как «давно».
 */
export function lastSeenLabel(v: Pick<UserLastSeen, 'online' | 'at' | 'approx'>, now: Date, full = false): string {
  if (v.online) return 'в сети';
  if (!v.at) return APPROX[v.approx ?? 'long'];
  const at = new Date(v.at);
  if (Number.isNaN(at.getTime())) return APPROX.long;
  const secs = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
  const minutes = Math.floor(secs / 60);
  if (!full) {
    if (minutes === 0) return 'был(а) только что';
    if (minutes < 60) return `был(а) ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`;
    const hours = Math.floor(secs / 3600);
    if (hours < 12) return `был(а) ${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;
  }
  const days = dayDiff(at, now);
  if (days <= 0) return `был(а) сегодня в ${hhmm(at)}`;
  if (days === 1) return `был(а) вчера в ${hhmm(at)}`;
  return full ? `был(а) ${ddmmyy(at)} в ${hhmm(at)}` : `был(а) ${ddmmyy(at)}`;
}

/**
 * Подпись контакта в списке «Новое сообщение» (Telegram `ContactsActivity` → `UserCell`: под именем «в сети» / «был(а) …»,
 * `LocaleController.formatUserStatus`). `online` — присутствие (точка), `seen` — ответ пачки `POST /users/last-seen`; ответа нет — `null`
 * (вызывающий оставляет прежнюю подпись). Снимок «ещё в сети, а присутствия уже нет» — как в шапке беседы: «только что» / «недавно».
 */
export function contactStatusText(online: boolean, seen: UserLastSeen | undefined, now: Date): string | null {
  if (online) return 'в сети';
  if (!seen) return null;
  if (seen.online) return seen.exact ? 'был(а) только что' : 'был(а) недавно';
  return lastSeenLabel(seen, now);
}

/**
 * Через сколько миллисекунд строка шапки сменится (граница минуты, часа или полночь); `null` — не сменится сама.
 * Пределы как у Telegram: от 1 с до суток.
 */
export function lastSeenNextChangeMs(v: Pick<UserLastSeen, 'online' | 'at'>, now: Date): number | null {
  if (v.online || !v.at) return null;
  const at = new Date(v.at).getTime();
  if (Number.isNaN(at)) return null;
  const secs = Math.max(0, Math.floor((now.getTime() - at) / 1000));
  let wait: number;
  if (secs < 3600) wait = (Math.floor(secs / 60) + 1) * 60 - secs;
  else if (secs < 12 * 3600) wait = (Math.floor(secs / 3600) + 1) * 3600 - secs;
  else {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    wait = Math.round((midnight - now.getTime()) / 1000);
  }
  return Math.min(Math.max(wait, 1), 86_400) * 1000;
}

/**
 * Строка «Прочитано …» подвала меню своего сообщения в ЛС: «Прочитано в 12:34» (сегодня), «Прочитано вчера в 12:34»,
 * «Прочитано 5 янв. в 12:34»; время скрыто или неизвестно — просто «Прочитано» (Telegram `lng_context_read_hidden`).
 * Не прочитано — `null` (строки нет: ✓ в первой строке подвала и так говорит «отправлено»).
 */
export function readAtLabel(v: ConvReadAt, now: Date): string | null {
  if (!v.read) return null;
  if (!v.at) return 'Прочитано';
  const at = new Date(v.at);
  if (Number.isNaN(at.getTime())) return 'Прочитано';
  const days = dayDiff(at, now);
  if (days <= 0) return `Прочитано в ${hhmm(at)}`;
  if (days === 1) return `Прочитано вчера в ${hhmm(at)}`;
  const year = at.getFullYear() === now.getFullYear() ? '' : ` ${at.getFullYear()}`;
  return `Прочитано ${at.getDate()} ${MONTHS_SHORT[at.getMonth()]}${year} в ${hhmm(at)}`;
}
