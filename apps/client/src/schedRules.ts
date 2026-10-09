/**
 * Правила окна «Отправить позже» (`SchedPick`, раунд 12, `docs/design/design-step12/HANDOFF.md` §8.2) — ЧИСТОЕ: без React
 * и без часов внутри. «Сейчас» приходит параметром (тест не переводит часы машины), все даты — по МЕСТНОМУ времени
 * человека: его «завтра утром» — 9:00 на его часах, а не на серверных. Дни считаются календарными числами, а не сутками по
 * 24 часа (в день перевода часов сутки короче или длиннее), поэтому для дней `new Date(y, m, d, …)`, а не `+ 86_400_000`;
 * «через час» — настоящие 60 минут.
 *
 * 🔴 Перевод часов (05.10, находки Codex): «начало минуты» и округление «через час» считаются по АБСОЛЮТНОМУ времени (мс),
 * а не пересборкой из местных полей. Пересборка `new Date(y, m, d, h, min)` в повторяющемся часе осеннего перевода берёт
 * ПЕРВЫЙ проход: «через час» из второго прохода давал +0 минут, а прошлое в этом часе принималось как будущее. Весной
 * набранного часа может не быть вовсе (02:30 в ночь перевода вперёд) — `new Date` сдвигает его на час вперёд; окно
 * показывает это подсказкой и ставит в поля настоящее время (`schedShift`, решение владельца 05.10).
 *
 * Названия дней и месяцев — свои массивы, не `Intl`: подпись кнопки не должна зависеть от ICU устройства.
 */

/** «Завтра утром» — 9:00. */
export const SCHED_MORNING_HOUR = 9;
/** «Завтра вечером» — 19:00. */
export const SCHED_EVENING_HOUR = 19;
/** «Через час» — на столько минут вперёд от «сейчас»… */
export const SCHED_SOON_MINUTES = 60;
/** …и вверх до такого шага: 21:07 → 22:10, а не 22:07 — круглое время читается на карточке с первого взгляда. */
export const SCHED_ROUND_MINUTES = 5;
/**
 * Предел вперёд — год (365 суток), как у сервера (`SCHEDULE_MAX_AHEAD_DAYS`, `packages/backend/src/scheduleRules.ts`):
 * позже сервер ответит 400 `send_at too far`. В календаре дальше этого дни недоступны.
 */
export const SCHED_MAX_AHEAD_DAYS = 365;
/** Под полями времени, пока выбранное время уже позади (HANDOFF §8.2); главная кнопка в этот момент неактивна. */
export const SCHED_PAST_TEXT = 'Это время уже прошло';
/** Шапка сетки месяца — с понедельника. */
export const SCHED_WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] as const;

/** День недели коротко, как в подписях макета («пн, 9:00»): индекс — `Date.getDay()`, 0 — воскресенье. */
const WEEKDAY_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
/** «Октябрь 2026» — шапка календаря: месяц в именительном падеже. */
const MONTH_NAME = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
/** «8 октября»: месяц в родительном падеже. */
const MONTH_OF = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** Месяц календаря: год и номер месяца 0…11 (как у `Date`). */
export interface MonthRef {
  y: number;
  m: number;
}

/** Быстрый вариант: одно касание — и сообщение в отложенных. */
export interface SchedQuick {
  id: 'soon' | 'morning' | 'evening';
  /** «Через час», «Завтра утром», «Завтра вечером». */
  label: string;
  /** Крупная строка карточки: «22:10» (сегодня) или «пн, 9:00» (другой день). */
  time: string;
  /** Момент отправки. */
  at: Date;
}

/** Ячейка сетки месяца. */
export interface SchedCell {
  /** Уникален в сетке: год-месяц-число ячейки. */
  key: string;
  /** Этот день, местная полночь. */
  date: Date;
  /** Число месяца 1…31. */
  n: number;
  /** День соседнего месяца (серый; нажатие переводит календарь в его месяц). */
  out: boolean;
  /** Сегодня (обведено) — только у дней этого месяца, как в макете. */
  today: boolean;
  /** Выбранный день (мёдом) — только у дней этого месяца, как в макете. */
  on: boolean;
  /** Недоступен: уже прошёл или дальше предела вперёд. */
  disabled: boolean;
  /** Для читалок: «5 октября», «4 октября, сегодня». */
  aria: string;
}

/** `ok` — можно отправлять; `past` — время уже позади («Это время уже прошло»); `invalid` — время не набрано до конца. */
export type SchedStatus = 'ok' | 'past' | 'invalid';

/** Откуда начать выбор: день и время в полях. */
export interface SchedStart {
  day: Date;
  h: number;
  m: number;
  /**
   * Точный момент начала выбора — перенос у отложенного (`initial`). Пока человек не менял ни день, ни поля, уходит ОН, а не
   * пересборка полей: во втором проходе повторяющегося часа (осенний перевод) пересборка дала бы первый — на час раньше.
   */
  at?: Date;
}

const MINUTE_MS = 60_000;
const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const pad2 = (n: number): string => String(n).padStart(2, '0');
/** Сдвиг пояса в момент `t`, мс: местное время = `t − offsetMs(t)` (как `getTimezoneOffset`, запад — плюс). */
const offsetMs = (t: number): number => new Date(t).getTimezoneOffset() * MINUTE_MS;

/**
 * Округлить момент ВНИЗ (`ceil = false`) или ВВЕРХ до шага в минутах местного времени — по абсолютному времени: сдвиг пояса
 * берётся у самого момента, поэтому результат остаётся в ТОМ ЖЕ проходе повторяющегося часа (пересборка из полей уводила
 * во второй проход первого). Для поясов со сдвигом, кратным 5 минутам (все нынешние), это то же, что округлить сами мс.
 */
function roundTo(t: number, stepMin: number, ceil: boolean): number {
  const step = stepMin * MINUTE_MS;
  const off = offsetMs(t);
  const local = t - off;
  return (ceil ? Math.ceil(local / step) : Math.floor(local / step)) * step + off;
}

/**
 * Начало текущей минуты: время «в эту же минуту» прошедшим не считается (человек выбрал её, пока она шла). По абсолютному
 * времени — во втором проходе повторяющегося часа это начало ЭТОЙ минуты, а не той же минуты часом раньше.
 */
const minuteStart = (now: Date): number => roundTo(now.getTime(), 1, false);

/** Последний день, на который ещё можно отложить: сегодня + 364 суток — в любое время суток он укладывается в год. */
const lastDay = (now: Date): Date => addDays(startOfDay(now), SCHED_MAX_AHEAD_DAYS - 1);

/** «9:00», «19:30», «0:05» — час без нуля впереди, как в подписях макета («Отправить завтра в 9:00»). */
export function clockLabel(d: Date): string {
  return `${d.getHours()}:${pad2(d.getMinutes())}`;
}

/** Тот же местный день, час и минута — в другом проходе повторяющегося часа или нет. */
const sameWall = (a: Date, b: Date): boolean =>
  sameDay(a, b) && a.getHours() === b.getHours() && a.getMinutes() === b.getMinutes();

/**
 * Второй проход того же местного времени (осенний перевод назад: 01:30 бывает дважды). `new Date(y, m, d, h, min)` берёт
 * первый; второй — тот же циферблат на 30, 60 или 120 минут позже (бывают переводы на полчаса и на два часа). Нет — `null`.
 */
function laterPass(at: Date): Date | null {
  for (const minutes of [30, 60, 120]) {
    const t = new Date(at.getTime() + minutes * MINUTE_MS);
    if (sameWall(t, at)) return t;
  }
  return null;
}

/**
 * Местные день и время одним моментом (секунды — ноль). Весной набранного часа может не быть (02:30 в ночь перевода вперёд) —
 * тогда это момент на величину перевода позже (03:30), как у `new Date`; узнать, что так вышло, — `schedShift`.
 * `notBefore` (мс) — повторяющийся час осеннего перевода: первый проход уже позади, а второй ещё нет — берётся второй (человек
 * в 01:10 второго прохода, набравший 01:20, имеет в виду будущие 01:20, а не прошедшие час назад). Без `notBefore` — первый.
 */
export function composeAt(day: Date, h: number, m: number, notBefore?: number): Date {
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
  if (notBefore === undefined || at.getTime() >= notBefore) return at;
  const later = laterPass(at);
  return later && later.getTime() >= notBefore ? later : at;
}

/**
 * Набранного времени в этот день нет на часах (весенний перевод вперёд: 02:30 → на деле 03:30): что набрано — `from`
 * («2:30»), что уйдёт на самом деле — `to` («3:30»). Время есть — `null`.
 */
export function schedShift(day: Date, h: number, m: number, at: Date): { from: string; to: string } | null {
  if (Number.isNaN(at.getTime())) return null;
  if (sameDay(at, day) && at.getHours() === h && at.getMinutes() === m) return null;
  return { from: `${h}:${pad2(m)}`, to: clockLabel(at) };
}

/** Подсказка у полей времени, когда набранного часа в этот день нет (решение владельца 05.10: показанное = отправляемое). */
export function schedShiftText(shift: { from: string; to: string }): string {
  return `Часы переводятся: ${shift.from} нет, будет ${shift.to}`;
}

/**
 * Момент, который уйдёт из окна по дню и полям времени. Поля не набраны до конца — `null`. День и поля — те же, с которых
 * начался выбор (`start`, перенос у отложенного), — точный момент начала, а не пересборка (второй проход повторяющегося часа
 * так и остаётся вторым). Иначе — `composeAt` с «не раньше начала текущей минуты» (повторяющийся час — будущий проход).
 */
export function pickAt(day: Date, h: number | null, m: number | null, now: Date, start?: SchedStart): Date | null {
  if (h === null || m === null) return null;
  if (start?.at && sameDay(day, start.day) && h === start.h && m === start.m) return new Date(start.at.getTime());
  return composeAt(day, h, m, minuteStart(now));
}

/**
 * Округлить момент ВВЕРХ до шага в минутах; секунды сверх ровной минуты считаются: 21:10:20 → 21:15, 21:10:00 → 21:10.
 * По абсолютному времени (`roundTo`): из второго прохода повторяющегося часа результат не уезжает в первый.
 */
function roundUp(d: Date, step: number): Date {
  return new Date(roundTo(d.getTime(), step, true));
}

/**
 * Быстрые варианты (HANDOFF §8.2): «Через час» — сейчас + 60 минут, вверх до 5; «Завтра утром» — 9:00; «Завтра вечером» —
 * 19:00. Под названием — когда именно: «22:10» для сегодняшнего момента, «пн, 9:00» (день недели коротко) для остальных —
 * в том числе для «через час» за полночь («вт, 0:30»).
 */
export function quickOptions(now: Date): SchedQuick[] {
  const soon = roundUp(new Date(now.getTime() + SCHED_SOON_MINUTES * 60_000), SCHED_ROUND_MINUTES);
  const tomorrow = addDays(now, 1);
  const morning = composeAt(tomorrow, SCHED_MORNING_HOUR, 0);
  const evening = composeAt(tomorrow, SCHED_EVENING_HOUR, 0);
  const withDay = (d: Date) => `${WEEKDAY_SHORT[d.getDay()]}, ${clockLabel(d)}`;
  return [
    { id: 'soon', label: 'Через час', time: sameDay(soon, now) ? clockLabel(soon) : withDay(soon), at: soon },
    { id: 'morning', label: 'Завтра утром', time: withDay(morning), at: morning },
    { id: 'evening', label: 'Завтра вечером', time: withDay(evening), at: evening },
  ];
}

/** Месяц, в котором лежит день. */
export function monthOf(d: Date): MonthRef {
  return { y: d.getFullYear(), m: d.getMonth() };
}

/** Сдвинуть месяц на `delta` (−1, +1; через границу года тоже). */
export function shiftMonth(view: MonthRef, delta: number): MonthRef {
  return monthOf(new Date(view.y, view.m + delta, 1));
}

/** «Октябрь 2026» — шапка календаря. */
export function monthTitle(view: MonthRef): string {
  return `${MONTH_NAME[view.m]} ${view.y}`;
}

/** Назад — пока месяц позже нынешнего: раньше только прошедшие дни. */
export function canGoPrev(view: MonthRef, now: Date): boolean {
  return view.y * 12 + view.m > now.getFullYear() * 12 + now.getMonth();
}

/** Вперёд — пока следующий месяц начинается не позже последнего дня, на который можно отложить. */
export function canGoNext(view: MonthRef, now: Date): boolean {
  return new Date(view.y, view.m + 1, 1).getTime() <= lastDay(now).getTime();
}

/**
 * Сетка месяца с понедельника: 5 недель, а если месяц не помещается (30–31 день с субботы или воскресенья) — 6; дни соседних
 * месяцев добивают крайние недели. Прошедшие дни и дни дальше предела вперёд недоступны; сегодня и выбранный день помечены
 * только внутри своего месяца (в макете у серых дней соседнего месяца ни кольца, ни мёда нет).
 */
export function monthGrid(view: MonthRef, selected: Date, now: Date): SchedCell[] {
  const first = new Date(view.y, view.m, 1);
  const offset = (first.getDay() + 6) % 7; // понедельник — 0
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const weeks = Math.max(5, Math.ceil((offset + days) / 7));
  const today = startOfDay(now);
  const last = lastDay(now);
  const cells: SchedCell[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const date = new Date(view.y, view.m, 1 - offset + i);
    const out = date.getMonth() !== view.m;
    const isToday = !out && sameDay(date, today);
    cells.push({
      key: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
      date,
      n: date.getDate(),
      out,
      today: isToday,
      on: !out && sameDay(date, selected),
      disabled: date.getTime() < today.getTime() || date.getTime() > last.getTime(),
      aria: `${date.getDate()} ${MONTH_OF[date.getMonth()]}${sameDay(date, today) ? ', сегодня' : ''}`,
    });
  }
  return cells;
}

/**
 * С чего начинается выбор: `initial` (перенос времени у уже отложенного), если оно ещё впереди и укладывается в год;
 * иначе — завтра в 9:00 («Отправить завтра в 9:00» — подпись на кадрах макета). `at` — точный момент `initial` до минуты
 * (`pickAt` отдаёт его, пока поля не трогали); у «завтра в 9:00» его нет — время собирается из полей.
 */
export function initialPick(now: Date, initial?: Date | null): SchedStart {
  if (
    initial &&
    !Number.isNaN(initial.getTime()) &&
    initial.getTime() >= minuteStart(now) &&
    startOfDay(initial).getTime() <= lastDay(now).getTime()
  ) {
    return {
      day: startOfDay(initial),
      h: initial.getHours(),
      m: initial.getMinutes(),
      at: new Date(roundTo(initial.getTime(), 1, false)),
    };
  }
  return { day: addDays(startOfDay(now), 1), h: SCHED_MORNING_HOUR, m: 0 };
}

/**
 * Можно ли отправлять выбранное. Позади — только то, что раньше НАЧАЛА текущей минуты: 21:08 в 21:08:40 ещё не «прошло» (сервер
 * прощает минуту, и человек, нажавший кнопку через секунду после выбора, не должен получать отказ); 21:07 — уже прошло.
 * `null` и непонятная дата — `invalid` (поле времени очищено, кнопка неактивна без упрёка).
 */
export function schedStatus(at: Date | null, now: Date): SchedStatus {
  if (!at || Number.isNaN(at.getTime())) return 'invalid';
  return at.getTime() < minuteStart(now) ? 'past' : 'ok';
}

/**
 * Подпись главной кнопки — говорит, что будет (HANDOFF §8.2): «Отправить сегодня в 21:30», «Отправить завтра в 9:00»,
 * «Отправить в чт, 8 октября, в 19:30»; в другом году год стоит после месяца («…8 января 2027, в 9:00»). Времени нет —
 * просто «Отправить».
 */
export function sendLabel(at: Date | null, now: Date): string {
  if (!at || Number.isNaN(at.getTime())) return 'Отправить';
  return `Отправить ${whenPhrase(at, now)}`;
}

/** «сегодня в 21:30», «завтра в 9:00», «в чт, 8 октября, в 19:30», в другом году — «в пт, 8 января 2027, в 9:00». */
function whenPhrase(at: Date, now: Date): string {
  const time = clockLabel(at);
  if (sameDay(at, now)) return `сегодня в ${time}`;
  if (sameDay(at, addDays(now, 1))) return `завтра в ${time}`;
  const year = at.getFullYear() === now.getFullYear() ? '' : ` ${at.getFullYear()}`;
  return `в ${WEEKDAY_SHORT[at.getDay()]}, ${at.getDate()} ${MONTH_OF[at.getMonth()]}${year}, в ${time}`;
}

/**
 * Значение поля часов (`max` 23) или минут (`max` 59) как число. Пустое, не из цифр, из трёх цифр или больше `max` — `null`
 * (время не набрано до конца).
 */
export function parseTimeField(text: string, max: number): number | null {
  if (!/^\d{1,2}$/.test(text)) return null;
  const n = Number(text);
  return n <= max ? n : null;
}

/** Что остаётся в поле при наборе: только цифры, не больше двух; больше `max` — `max` («75» минут → «59»). */
export function typedTimeField(raw: string, max: number): string {
  const digits = raw.replace(/\D/g, '').slice(0, 2);
  return digits !== '' && Number(digits) > max ? String(max) : digits;
}

/** Что остаётся в поле, когда курсор ушёл: двумя цифрами; пустое — «00». */
export function settledTimeField(text: string, max: number): string {
  const n = parseTimeField(typedTimeField(text, max), max);
  return pad2(n ?? 0);
}

/** Шаг стрелками ↑ / ↓ в поле: по кругу в пределах 0…`max`, без переноса в соседнее поле. */
export function stepTimeField(text: string, delta: 1 | -1, max: number): string {
  const n = parseTimeField(text, max) ?? 0;
  return pad2((n + delta + max + 1) % (max + 1));
}

/** Текст сообщения для строки под заголовком: пробелы и переводы строк сжаты, в кавычках-ёлочках, длинное обрезано. */
export function quotedText(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return `«${flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat}»`;
}

// ─── Вид «Отложенные» (раунд 12, порция 8; HANDOFF §8.4, макет `SchedFeed`) ──────────────────────────────────────────

/** Отложенное глазами вида — ровно те поля `ConvScheduled`, по которым строятся метки (правила не знают DTO целиком). */
export interface SchedItemTime {
  /** «Отправить позже»: когда (ISO). `null` — «Когда будет в сети». */
  sendAt: string | null;
  whenOnline: boolean;
  /** Не отправлено, сервер больше не пытается (`ConvScheduled.failed`). */
  failed?: { reason: string } | null;
}

/** Склонение «сообщение» по числу: 1 сообщение, 2 сообщения, 5 сообщений, 21 сообщение (11–14 — как 5). */
function messagesWord(n: number): string {
  const a = Math.abs(n) % 10;
  const b = Math.abs(n) % 100;
  return a === 1 && b !== 11 ? 'сообщение' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'сообщения' : 'сообщений';
}

/** Подпись под «Отложенные» в шапке вида: «<имя собеседника> · 2 сообщения». */
export function schedHeadSub(peerName: string, count: number): string {
  return `${peerName} · ${count} ${messagesWord(count)}`;
}

/** Пилюля над отложенными «когда будет в сети»: «Когда <имя собеседника> будет в сети». */
export function schedOnlineLabel(peerName: string): string {
  return `Когда ${peerName} будет в сети`;
}

/**
 * Дневная пилюля вида «Отложенные» (макет: «Завтра, 5 октября»): «Сегодня, 4 октября», «Завтра, 5 октября», дальше —
 * «8 октября», в другом году — «8 января 2027». Дни — календарные, по местному времени.
 */
export function schedDayLabel(at: Date, now: Date): string {
  const date = `${at.getDate()} ${MONTH_OF[at.getMonth()]}`;
  if (sameDay(at, now)) return `Сегодня, ${date}`;
  if (sameDay(at, addDays(now, 1))) return `Завтра, ${date}`;
  return at.getFullYear() === now.getFullYear() ? date : `${date} ${at.getFullYear()}`;
}

/**
 * Раздел ленты вида: день отправки (пилюля `schedDayLabel`) или «Когда <имя> будет в сети». `key` одинаков у соседей одного
 * раздела — по нему лента ставит пилюлю над первым и склеивает пузыри в группу. Непонятная дата — свой раздел без пилюли.
 */
export function schedSection(item: SchedItemTime, peerName: string, now: Date): { key: string; label: string } {
  if (item.whenOnline || !item.sendAt) return { key: 'online', label: schedOnlineLabel(peerName) };
  const at = new Date(item.sendAt);
  if (Number.isNaN(at.getTime())) return { key: 'bad', label: '' };
  return { key: `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`, label: schedDayLabel(at, now) };
}

/** Время в пузыре отложенного — время отправки, как в макете («9:00»); у «когда будет в сети» — пусто (пузырь без времени). */
export function schedBubbleTime(item: SchedItemTime): string {
  if (item.whenOnline || !item.sendAt) return '';
  const at = new Date(item.sendAt);
  return Number.isNaN(at.getTime()) ? '' : clockLabel(at);
}

/**
 * Подвал меню отложенного (HANDOFF §3, «Отложенное»): «Будет отправлено завтра в 9:00» (та же фраза, что у главной кнопки
 * `SchedPick`), «Будет отправлено, когда <имя> будет в сети». Время уже прошло, а сообщение ещё в списке (планировщик
 * сервера идёт раз в несколько секунд) — «Отправляется…». Не отправлено после всех попыток — почему, и что можно сделать.
 */
export function schedFootLabel(item: SchedItemTime, peerName: string, now: Date): string {
  if (item.failed) {
    return item.failed.reason === 'peer-gone'
      ? 'Не отправлено: собеседник удалил аккаунт'
      : 'Не отправлено — отправьте сейчас или перенесите';
  }
  if (item.whenOnline || !item.sendAt) return `Будет отправлено, когда ${peerName} будет в сети`;
  const at = new Date(item.sendAt);
  if (Number.isNaN(at.getTime())) return '';
  if (at.getTime() < minuteStart(now)) return 'Отправляется…';
  return `Будет отправлено ${whenPhrase(at, now)}`;
}
