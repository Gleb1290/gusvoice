/**
 * «Показывать имя» / «Показывать текст» в уведомлениях (08.10, #211, G38, признак `push2`) — как у Telegram
 * («Настройки → Уведомления»: галочки «Имя» и «Текст сообщения»; tdesktop `settings_notifications.cpp`, `NotifyView`
 * `ShowPreview` < `ShowName` < `ShowNothing`; `window/notifications_manager.cpp` `hideNameAndPhoto` / `hideMessageText`).
 *
 * Одно значение на человека, хранится на сервере (`users.notify_view`, миграция 0111) и действует везде: пуш на телефон
 * собирает сервер, уведомление браузера и тост десктопа — клиент. Как у Telegram, без имени нет и текста: снял «Имя» —
 * снимается и «Текст» (`ShowNothing`), включил «Текст» — включается и «Имя».
 *
 * - `all` — имя и текст (умолчание, как было);
 * - `name` — имя без текста: «Новое сообщение»;
 * - `nothing` — ни имени, ни текста: заголовок «GusVoice», текст «Новое сообщение».
 */
export type NotifyView = 'all' | 'name' | 'nothing';

export const NOTIFY_VIEWS: readonly NotifyView[] = ['all', 'name', 'nothing'];

/** Заголовок уведомления, когда имя скрыто (у Telegram — «Telegram»). */
export const NOTIFY_HIDDEN_TITLE = 'GusVoice';
/** Текст уведомления, когда текст скрыт (у Telegram — `lng_notification_preview` «You have a new message»). */
export const NOTIFY_HIDDEN_BODY = 'Новое сообщение';

/** Неизвестное или пустое — `all` (как было до настройки). */
export function normalizeNotifyView(v: unknown): NotifyView {
  return v === 'name' || v === 'nothing' ? v : 'all';
}

export function notifyShowsName(v: NotifyView): boolean {
  return v !== 'nothing';
}

export function notifyShowsText(v: NotifyView): boolean {
  return v === 'all';
}

/**
 * Значение по двум галочкам, как у Telegram: без имени текста не бывает (`ShowNothing`), галочка «Текст» без «Имени»
 * читается как обе.
 */
export function notifyViewOf(showName: boolean, showText: boolean): NotifyView {
  if (showText) return 'all';
  return showName ? 'name' : 'nothing';
}

/** Заголовок и текст уведомления с учётом настройки. `all` — как есть. */
export function maskNotice(view: NotifyView, n: { title: string; body: string }): { title: string; body: string } {
  if (view === 'all') return { title: n.title, body: n.body };
  return {
    title: notifyShowsName(view) ? n.title : NOTIFY_HIDDEN_TITLE,
    body: NOTIFY_HIDDEN_BODY,
  };
}

/**
 * «Повторять уведомления» (08.10, #211, G38, признак `push3`) — как у Telegram для Android (`NotificationsSettingsActivity`:
 * «Повторять уведомления» — «Никогда», 5, 10, 30 минут, 1, 2, 4 часа, ключ `repeat_messages`; `NotificationsController.
 * scheduleNotificationRepeat` — только пока висят непрочитанные ЛИЧНЫЕ сообщения). Значение — минуты, `0` — не повторять
 * (умолчание — 60, как у Telegram: решение владельца 08.10, миграция 0124). Хранится на сервере (`users.notify_repeat`,
 * миграция 0118): повтор шлёт сервер (`pushDefer.ts`), пока беседа не прочитана, и не шлёт, пока человек за ПК.
 */
export const NOTIFY_REPEAT_MINUTES: readonly number[] = [0, 5, 10, 30, 60, 120, 240];

/**
 * Защитный потолок повтора одного висящего пуша беседы. У Telegram повтор идёт, ПОКА НЕ ПРОЧИТАНО, без предела (решение
 * владельца 08.10: так и у нас), но забытый телефон не должен звенеть вечно: не больше `NOTIFY_REPEAT_MAX` повторов подряд и
 * не дальше `NOTIFY_REPEAT_WINDOW_MIN` минут от первого пуша (сутки: 24 раза при часе, 6 раз при 4 часах, 2 часа при 5 минутах).
 */
export const NOTIFY_REPEAT_MAX = 24;
export const NOTIFY_REPEAT_WINDOW_MIN = 24 * 60;

/** Можно ли поставить повтор номер `n` (с 1) при интервале `minutes`: в пределах потолка по числу и по времени. */
export function notifyRepeatAllowed(n: number, minutes: number): boolean {
  return minutes > 0 && n >= 1 && n <= NOTIFY_REPEAT_MAX && n * minutes <= NOTIFY_REPEAT_WINDOW_MIN;
}

/**
 * Запас на задержку такта очереди (2 с на такт, до 24 тактов подряд) к окну `NOTIFY_REPEAT_WINDOW_MIN`: без него последний
 * повтор, по плану встающий ровно на сутки (24-й при часе), терялся бы из-за пары секунд опоздания такта.
 */
export const NOTIFY_REPEAT_GRACE_MS = 60_000;

/**
 * Повтор в момент `at` (мс) ещё в окне «сутки от первого пуша» `firstAt` (мс)? `notifyRepeatAllowed` считает окно по плану
 * (`n * minutes`), а настоящее время уезжает: перенос повтора, пока человек за ПК, номер не растит, простой бэкенда копит
 * просрочку (ревью Codex 08.10: повтор, просроченный на 48 ч, уходил). Неизвестное или «будущее» `firstAt` (старая запись
 * очереди, часы соседнего процесса) — в окне: такой повтор считается от текущего такта.
 */
export function notifyRepeatInWindow(firstAt: number | undefined, at: number): boolean {
  if (typeof firstAt !== 'number' || !Number.isFinite(firstAt) || at <= firstAt) return true;
  return at - firstAt <= NOTIFY_REPEAT_WINDOW_MIN * 60_000 + NOTIFY_REPEAT_GRACE_MS;
}

/**
 * Повтор — только днём (09.10, сверка с Telegram п.3): Android Telegram повторяет уведомление, лишь когда местный час в
 * 11..22 включительно (`NotificationsController.repeatNotificationMaybe`: `hour >= 11 && hour <= 22`), ночью просто ждёт
 * следующего срока. Часовой пояс получателя — IANA-имя, которое приложение шлёт при `POST /push/register` (`tz`, поле
 * `push_devices.tz`); нет пояса или он не разобрался — окна нет, повтор идёт как раньше.
 */
export const NOTIFY_REPEAT_FROM_HOUR = 11;
export const NOTIFY_REPEAT_TO_HOUR = 22;

/** Час (0..23) момента `at` в поясе `tz`; пояс не IANA или не разобрался — `null`. */
const hourFormats = new Map<string, Intl.DateTimeFormat | null>();
export function localHourIn(tz: string, at: number): number | null {
  try {
    let f = hourFormats.get(tz);
    if (f === undefined) {
      if (hourFormats.size > 200) hourFormats.clear();
      try {
        f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: 'numeric' });
      } catch {
        f = null;
      }
      hourFormats.set(tz, f);
    }
    if (!f) return null;
    const parts = f.formatToParts(new Date(at));
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    return Number.isInteger(h) && h >= 0 && h < 24 ? h : null;
  } catch {
    return null;
  }
}

/** Настоящее ли имя пояса (IANA), короткое: годится для хранения. */
export function validTimeZone(tz: unknown): tz is string {
  return typeof tz === 'string' && tz.length > 0 && tz.length <= 64 && localHourIn(tz, 0) !== null;
}

/** Попадает ли местный час в окно повторов (11..22 включительно). */
export function notifyRepeatHourOk(hour: number): boolean {
  return hour >= NOTIFY_REPEAT_FROM_HOUR && hour <= NOTIFY_REPEAT_TO_HOUR;
}

/**
 * Сколько мс ждать повтору до окна повторов у получателя с поясом `tz`: `0` — сейчас можно (или пояса нет / он непонятен —
 * поведение как раньше). Ночью — до ближайшего начала местного часа окна (11:00), с точностью до минуты.
 */
export function notifyRepeatWaitMs(tz: string | null | undefined, at: number): number {
  if (!tz) return 0;
  const now = localHourIn(tz, at);
  if (now === null || notifyRepeatHourOk(now)) return 0;
  const minute = 60_000;
  const start = Math.ceil(at / minute) * minute;
  // Максимум сутки с запасом: пояса со сдвигом переводов часов не длиннее.
  for (let t = start; t <= at + 26 * 60 * minute; t += minute) {
    const h = localHourIn(tz, t);
    if (h !== null && notifyRepeatHourOk(h)) return t - at;
  }
  return 0;
}

/** Неизвестное — `0` (не повторять). */
export function normalizeNotifyRepeat(v: unknown): number {
  return typeof v === 'number' && NOTIFY_REPEAT_MINUTES.includes(v) ? v : 0;
}

/** Подпись пункта выбора: «Никогда», «5 минут», «1 час», «2 часа». */
export function notifyRepeatLabel(minutes: number): string {
  const m = normalizeNotifyRepeat(minutes);
  if (m === 0) return 'Никогда';
  if (m < 60) return `${m} минут`;
  const h = m / 60;
  return h === 1 ? '1 час' : `${h} часа`;
}
