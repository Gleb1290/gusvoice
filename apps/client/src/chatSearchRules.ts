/**
 * Поиск в беседе и «Перейти к дате» (G05, G25 темы 14 плейбука, #211; признак сервера `search1`) — ЧИСТЫЕ правила.
 *
 * Источники (Telegram): tdesktop `history/view/controls/history_view_compose_search.cpp` (`BottomBar`: счётчик «N of M»,
 * N = 1 — САМОЕ НОВОЕ найденное; «next» / F3 — к более старому, «previous» / Shift+F3 — к более новому; ноль —
 * «No results»), Web A `components/middle/search/MiddleSearch.tsx` (`handleFocusOlder` / `handleFocusNewer`: стрелка
 * вверх — старее, вниз — новее; следующая порция — когда до конца загруженного меньше `FOCUSED_SEARCH_TRIGGER_OFFSET` = 5),
 * календарь — tdesktop `window/window_session_controller.cpp` (`showCalendar`: открыт на месяце нажатой даты, день
 * выделен; позже сегодняшнего выбрать нельзя), Web A `components/common/CalendarModal.tsx` (будущие дни неактивны).
 * Плавающая дата гаснет через 1 с — tdesktop `history_inner_widget.cpp` `kScrollDateHideTimeout = 1000`.
 */
import { monthTitle, SCHED_WEEKDAYS, shiftMonth, monthOf, type MonthRef } from './schedRules';
import { dayStart, firstOfDay } from './feedWindowRules';

export { monthTitle, shiftMonth, monthOf, SCHED_WEEKDAYS as JUMP_WEEKDAYS, dayStart, firstOfDay, type MonthRef };

/** Пауза набора до запроса (мс): каждая буква — не запрос. */
export const SEARCH_DEBOUNCE_MS = 300;
/** Порция найденного с сервера (сервер даёт до 50). */
export const SEARCH_PAGE = 30;
/** До конца загруженного найденного осталось меньше — просим следующую порцию (Web A: 5). */
export const SEARCH_PREFETCH = 5;
/** Плавающая дата над лентой гаснет через столько после прокрутки (tdesktop `kScrollDateHideTimeout`). */
export const FLOAT_DAY_HIDE_MS = 1000;

/** Найденное: id (переход «вокруг»), ключ (курсор продолжения), время. Новые первыми. */
export interface SearchHitRef {
  id: string;
  sortKey: number;
  createdAt: string;
}

/** Состояние поиска одной беседы: найденное (новые первыми), текущий номер (0 — самое новое), всего, курсор дальше. */
export interface SearchState {
  query: string;
  hits: SearchHitRef[];
  index: number;
  total: number;
  next: string | null;
}

/** «3 из 120» — как `lng_search_messages_n_of_amount`; ничего — «Нет результатов». `null` — запроса ещё нет. */
export function counterLabel(s: Pick<SearchState, 'index' | 'total'> | null): string | null {
  if (!s) return null;
  if (s.total <= 0) return 'Нет результатов';
  return `${Math.min(s.index + 1, s.total)} из ${s.total}`;
}

/** Можно ли к более старому (`older`) / более новому найденному. Старее — пока номер меньше всего найденного. */
export function canStep(s: SearchState | null, dir: 'older' | 'newer'): boolean {
  if (!s || s.total <= 0) return false;
  return dir === 'older' ? s.index + 1 < s.total : s.index > 0;
}

/**
 * Шаг по найденному: новый номер или `null` (край; или старее, но порция ещё не пришла — тогда `needMore`).
 * `needMore` — пора просить следующую порцию: до конца загруженного меньше `SEARCH_PREFETCH`, а сервер обещал ещё.
 */
export function stepPlan(s: SearchState, dir: 'older' | 'newer'): { index: number | null; needMore: boolean } {
  if (!canStep(s, dir)) return { index: null, needMore: false };
  const want = dir === 'older' ? s.index + 1 : s.index - 1;
  const needMore = !!s.next && s.hits.length - want <= SEARCH_PREFETCH;
  return { index: want < s.hits.length ? want : null, needMore };
}

/** Слить порцию продолжения: без повторов (по id), порядок «новые первыми» сохраняется. */
export function appendHits(s: SearchState, more: SearchHitRef[], next: string | null, total: number): SearchState {
  const seen = new Set(s.hits.map((h) => h.id));
  return { ...s, hits: [...s.hits, ...more.filter((h) => !seen.has(h.id))], next, total };
}

/**
 * Где в тексте подсветить запрос: пары [начало, конец) всех вхождений без учёта регистра, не накладываясь. Пустой запрос
 * (после trim) — ничего. Сравнение — по `toLowerCase` посимвольно: длина строки не меняется (буквы, у которых нижний
 * регистр длиннее, не совпадут — это не страшно, подсветка лишь подсказка).
 */
export function matchRanges(text: string, query: string): Array<[number, number]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const low = text.toLowerCase();
  if (low.length !== text.length) return [];
  const out: Array<[number, number]> = [];
  for (let at = low.indexOf(q); at >= 0; at = low.indexOf(q, at + q.length)) out.push([at, at + q.length]);
  return out;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Клетка календаря «Перейти к дате». */
export interface JumpCell {
  key: string;
  date: Date;
  n: number;
  /** День соседнего месяца (серый). */
  out: boolean;
  today: boolean;
  on: boolean;
  /** Позже сегодняшнего — выбрать нельзя. */
  disabled: boolean;
  aria: string;
}

const MONTH_OF = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/**
 * Сетка месяца с понедельника (как у окна «Отправить позже»): 5 или 6 недель, дни соседних месяцев добивают крайние.
 * Недоступны дни позже сегодняшнего (у Telegram — так же: ни Web A, ни ПК не дают выбрать будущее; дни без сообщений
 * выбрать можно — переход к ближайшему сообщению после).
 */
export function jumpMonthGrid(view: MonthRef, selected: Date, now: Date): JumpCell[] {
  const first = new Date(view.y, view.m, 1);
  const offset = (first.getDay() + 6) % 7;
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const weeks = Math.max(5, Math.ceil((offset + days) / 7));
  const today = dayStart(now).getTime();
  const cells: JumpCell[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const date = new Date(view.y, view.m, 1 - offset + i);
    const out = date.getMonth() !== view.m;
    const isToday = !out && sameDay(date, now);
    cells.push({
      key: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
      date,
      n: date.getDate(),
      out,
      today: isToday,
      on: !out && sameDay(date, selected),
      disabled: date.getTime() > today,
      aria: `${date.getDate()} ${MONTH_OF[date.getMonth()]}${isToday ? ', сегодня' : ''}`,
    });
  }
  return cells;
}

/** Вперёд по месяцам — пока следующий месяц не позже нынешнего. Назад — всегда. */
export function canGoNextMonth(view: MonthRef, now: Date): boolean {
  return view.y * 12 + view.m < now.getFullYear() * 12 + now.getMonth();
}
