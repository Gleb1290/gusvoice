/**
 * ЛС, этап 2, шаг 2г — окно ленты беседы: чистые правила (`docs/dm/STAGE2.md`, «Лента (2г, Р9)»).
 *
 * Лента беседы — не вся история, а кусок не длиннее `WINDOW_MAX` сообщений с флагами «выше есть ещё» / «ниже есть
 * ещё» (`ConvWindow`). Открывается у первого непрочитанного или там, где человек ушёл; переход к цитате заменяет кусок
 * на окрестность сообщения, «назад» возвращает к месту перехода. Приём обоих Telegram (Р9): DOM не растёт с историей,
 * а прокрутка держится якорем — сообщением у верхней кромки и его отступом, а не разницей высоты.
 *
 * Здесь — без DOM, стора и сети: обвязка в `convStore.ts` (сеть, окно) и `MessagePane` (прокрутка).
 */

/** Сколько сообщений беседы держит лента. Больше — дальний от человека край отрезается. */
export const WINDOW_MAX = 300;

/** Место в ленте: сообщение у верхней кромки и сколько пикселей от кромки до его верха (обычно ≤ 0). */
export interface FeedPlace {
  messageId: string;
  offset: number;
}

/** Что сделать при открытии беседы: окно в памяти годится, или какую порцию просить. */
export type OpenAction =
  | { fetch: 'none' }
  | { fetch: 'latest' }
  | { fetch: 'after'; key: number }
  | { fetch: 'around'; messageId: string };

/** Окно беседы в памяти глазами открытия. */
export interface WindowView {
  /** Окно из кеша на диске или после смены токена — ссылок на файлы нет, нужна свежая порция. */
  stale: boolean;
  /** Окно у хвоста беседы (ниже ничего нет). */
  atTail: boolean;
  /** Ключ первого сообщения окна; `null` — окно пустое. */
  firstKey: number | null;
  /** Выше окна есть ещё история. */
  hasMoreBefore: boolean;
  /** Сообщение места есть в окне. */
  hasPlace: boolean;
}

/**
 * Как открыть беседу. Непрочитанное важнее места: человек открывает беседу, чтобы прочитать новое, — встаём у первого
 * непрочитанного (`after` ключа прочитанного). Нет непрочитанного — туда, где он ушёл (если ушёл не снизу). Иначе —
 * последние сообщения.
 *
 * Окно в памяти используется без запроса, только когда догонка живая (`live`): события держат его свежим. Без живого
 * шлюза (прокси режет WebSocket) окно могло отстать — просим порцию, как раньше.
 */
export function openAction(p: {
  unread: number;
  lastReadKey: number;
  place: FeedPlace | null;
  live: boolean;
  window: WindowView | null;
}): OpenAction {
  const w = p.live && p.window && !p.window.stale ? p.window : null;
  if (p.unread > 0) {
    // Первое непрочитанное уже в окне у хвоста — черта видна без запроса.
    const covers = !!w && w.atTail && (!w.hasMoreBefore || (w.firstKey !== null && w.firstKey <= p.lastReadKey));
    return covers ? { fetch: 'none' } : { fetch: 'after', key: p.lastReadKey };
  }
  if (p.place) return w?.hasPlace ? { fetch: 'none' } : { fetch: 'around', messageId: p.place.messageId };
  return w?.atTail ? { fetch: 'none' } : { fetch: 'latest' };
}

/**
 * Курсор «после ключа». Ключи сообщений в беседе уникальны и растут (`conversations.ts`, `GREATEST(часы, прошлый + 1)`),
 * а сервер сравнивает по ключу (`after` → `sort_key > ключ`), поэтому вторая половина курсора — заглушка формата.
 */
export function afterKeyCursor(key: number): string {
  return `${Math.max(0, Math.floor(key))}_0`;
}

/**
 * Резать ли окно после подгрузки: подтянули старое (вверху) — отрезаем низ, новое (внизу) — верх. Режется дальний
 * от человека край: он туда только что не смотрел.
 */
export function trimPlan(
  length: number,
  loaded: 'older' | 'newer',
  max = WINDOW_MAX,
): { side: 'top' | 'bottom'; count: number } | null {
  if (length <= max) return null;
  return { side: loaded === 'older' ? 'bottom' : 'top', count: length - max };
}

/**
 * Якорь прокрутки — первая строка, чей низ ниже верхней кромки ленты (видна хотя бы краешком). Строки идут сверху вниз,
 * их низы растут — поэтому двоичный поиск: строк до `WINDOW_MAX`, а мерить каждую на каждом кадре прокрутки дорого.
 * `bottomOf(i)` — низ строки `i` в координатах экрана. `-1` — такой строки нет.
 */
export function anchorIndex(count: number, bottomOf: (i: number) => number, viewTop: number): number {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bottomOf(mid) > viewTop) {
      found = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return found;
}

/**
 * На сколько сдвинуть прокрутку, чтобы якорь снова встал на свой отступ: строка якоря теперь на `nowTop` (экран),
 * кромка ленты — `viewTop`.
 */
export function anchorShift(place: FeedPlace, nowTop: number, viewTop: number): number {
  return nowTop - viewTop - place.offset;
}

/** Стек «назад» после переходов к цитатам: не глубже `max`, самый старый выпадает. */
export const JUMP_STACK_MAX = 20;

export function pushJump(stack: readonly FeedPlace[], from: FeedPlace, max = JUMP_STACK_MAX): FeedPlace[] {
  return [...stack, from].slice(-max);
}

export function popJump(stack: readonly FeedPlace[]): { place: FeedPlace | null; stack: FeedPlace[] } {
  if (stack.length === 0) return { place: null, stack: [] };
  return { place: stack[stack.length - 1], stack: stack.slice(0, -1) };
}

/** С какой стороны от своего отступа строка места «Назад»: `1` — ниже (переход был вверх, к цитате), `-1` — выше. */
export type JumpSide = 1 | -1;

/**
 * Вернулся ли человек к месту «Назад» сам, прокруткой (приёмка телефона 05.10: после перехода к цитате плашка «Назад»
 * висела и у низа ленты, куда вернулись пальцем, — и дальше, над панелью выделения и при пересылке). Как
 * `HistoryWidget::checkReplyReturns` у Telegram Desktop: место возврата снимается, когда до него долистали сами.
 * `off` — отступ строки места от верха ленты сейчас; `side` — с какой стороны от своего отступа она была при прошлой
 * проверке (`null` — ещё не знаем: строки не было в ленте). Пришли — строка на своём отступе (±1 px) или перешла его на
 * другую сторону; иначе в ответе — сторона для следующей проверки.
 */
export function jumpReturn(
  off: number,
  place: FeedPlace,
  side: JumpSide | null,
): { reached: boolean; side: JumpSide | null } {
  const d = off - place.offset;
  if (Math.abs(d) <= 1) return { reached: true, side };
  const now: JumpSide = d > 0 ? 1 : -1;
  return { reached: side !== null && now !== side, side: now };
}

/**
 * Где черта «Новые сообщения» в беседе: первое ЧУЖОЕ сообщение с ключом больше прочитанного (своё новостью не
 * считается). Ключ, а не время: прочитанное сервер ведёт по ключам, а время сообщения и его ключ расходятся на всплеске
 * (ключ = прошлый + 1). `-1` — черты нет (всё прочитано, ключа нет или у сообщений нет ключей — каналы).
 */
export function firstUnreadIndex(
  list: readonly { sortKey?: number; author: { id: string } }[],
  meId: string | undefined,
  readKey: number | null | undefined,
): number {
  if (readKey === null || readKey === undefined) return -1;
  return list.findIndex((m) => m.sortKey !== undefined && m.sortKey > readKey && m.author.id !== meId);
}

/**
 * Сколько непрочитанного в ленте (G26): чужие сообщения с ключом больше прочитанного — число на кнопке «Вниз», пока
 * окно у хвоста беседы (не у хвоста — счётчик сервера). Видно и при входе, а не только для пришедшего при прокрутке.
 */
export function unreadCountAfter(
  list: readonly { sortKey?: number; author: { id: string } }[],
  meId: string | undefined,
  readKey: number | null | undefined,
): number {
  if (readKey === null || readKey === undefined) return 0;
  let n = 0;
  for (const m of list) if (m.sortKey !== undefined && m.sortKey > readKey && m.author.id !== meId) n++;
  return n;
}

/** Начало дня (по часам устройства) — «Перейти к дате» (G25, `chatSearchRules.ts`). */
export function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Первое сообщение дня `day` в загруженной порции (старые сверху): первое не раньше начала дня. Нет такого (день после
 * последнего сообщения) — последнее; пусто — `null`.
 */
export function firstOfDay<T extends { id: string; createdAt: string }>(list: readonly T[], day: Date): string | null {
  const from = dayStart(day).getTime();
  for (const m of list) if (Date.parse(m.createdAt) >= from) return m.id;
  return list.length ? list[list.length - 1].id : null;
}
