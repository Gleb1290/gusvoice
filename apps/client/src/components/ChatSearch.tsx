/**
 * Поиск в беседе и «Перейти к дате» (G05, G25 темы 14 плейбука, #211; признак сервера `search1`). Правила — чистые, в
 * `chatSearchRules.ts` (там же источники Telegram). Здесь — состояние поиска ленты (`useChatSearch`), шапка с полем
 * (`ChatSearchHead`), нижняя панель телефона на месте поля ввода (`ChatSearchFoot`, как у Telegram Android и Web A на
 * телефоне), подсветка найденного слова (`useSearchHighlight`) и календарь (`JumpDateDialog`).
 *
 * Клавиши (tdesktop `history_view_compose_search.cpp`, `BottomBar::handleKeyPress`): Ctrl+F — открыть поиск (в ЛС тоже;
 * в десктопе WebView2 браузерный поиск и так выключен — перехват на всякий случай); Enter в поле и F3 — к более старому,
 * Shift+Enter и Shift+F3 — к более новому; Esc — закрыть. Стрелка вверх — старее, вниз — новее (Web A).
 * Телефон: «назад» в шапке (`MainLayout`) сначала закрывает поиск — `exitChatSearch`, как у выделения.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ConvSearchResponse } from '@gusvoice/shared';
import {
  appendHits,
  canGoNextMonth,
  canStep,
  counterLabel,
  JUMP_WEEKDAYS,
  jumpMonthGrid,
  matchRanges,
  monthOf,
  monthTitle,
  SEARCH_DEBOUNCE_MS,
  SEARCH_PAGE,
  shiftMonth,
  stepPlan,
  type JumpCell,
  type SearchState,
} from '../chatSearchRules';
import { pushBackHandler } from '../androidBack';
import { useDialogChrome } from '../dialogChrome';
import { usePhoneLayout } from '../phoneLayout';
import { useStore } from '../store';
import { BottomSheet } from './BottomSheet';
import { Icon } from './Icon';

/** Что лента получает от владельца (`DmChatView`): открыт ли поиск и как искать / прыгать к дате. */
export interface ChatSearchSource {
  open: boolean;
  setOpen: (open: boolean) => void;
  search: (q: string, before?: string) => Promise<ConvSearchResponse>;
  /** Окно ленты — у первого сообщения дня; ответ — его id (`null` — беседа пуста). */
  jumpToDate: (day: Date) => Promise<string | null>;
}

// ─── «Назад» телефона закрывает поиск (как выделение, `dmSelection.exitSelection`) ─────────────────────────────────────
let exitFn: (() => void) | null = null;
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};
function setExit(f: (() => void) | null) {
  exitFn = f;
  for (const l of listeners) l();
}
/** Закрыть открытый поиск ленты; `false` — поиска нет. */
export function exitChatSearch(): boolean {
  const f = exitFn;
  if (!f) return false;
  f();
  return true;
}
/** Открыт ли поиск — подпись «назад» в шапке телефона. */
export function useChatSearchOpen(): boolean {
  return useSyncExternalStore(subscribe, () => exitFn !== null, () => exitFn !== null);
}

function typingTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

export interface ChatSearchCtl {
  open: boolean;
  query: string;
  setQuery: (q: string) => void;
  state: SearchState | null;
  busy: boolean;
  label: string | null;
  canOlder: boolean;
  canNewer: boolean;
  older: () => void;
  newer: () => void;
  /** Enter в поле: новый запрос — искать сразу, тот же — к более старому (Shift — к более новому). */
  submit: (shift: boolean) => void;
  close: () => void;
  inputRef: React.RefObject<HTMLInputElement>;
  /** Календарь: день, на котором он открыт (`null` — закрыт). */
  calendarAt: Date | null;
  openCalendar: (day?: Date) => void;
  closeCalendar: () => void;
  pickDay: (day: Date) => void;
}

/**
 * Состояние поиска ленты. `go` — переход к сообщению (окно «вокруг», подсветка строки); ленту ведёт `MessagePane`.
 * Без `src` (каналы, старый сервер) — всё выключено, слушателей клавиш нет.
 */
export function useChatSearch(src: ChatSearchSource | undefined, go: (id: string) => Promise<void>, feedId: string | null): ChatSearchCtl {
  const open = !!src?.open;
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState | null>(null);
  const [busy, setBusy] = useState(false);
  const [calendarAt, setCalendarAt] = useState<Date | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const srcRef = useRef(src);
  srcRef.current = src;
  const goRef = useRef(go);
  goRef.current = go;
  const stateRef = useRef(state);
  stateRef.current = state;
  const moreRef = useRef<Promise<void> | null>(null);

  const close = useCallback(() => {
    seq.current++;
    setQuery('');
    setState(null);
    setBusy(false);
    srcRef.current?.setOpen(false);
  }, []);

  // Другая беседа — поиск закрыт (Telegram: поиск живёт в своём чате).
  useEffect(() => {
    if (srcRef.current?.open) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedId]);

  const run = useCallback(async (q: string) => {
    const s = srcRef.current;
    const my = ++seq.current;
    if (!s || !q.trim()) {
      setState(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const res = await s.search(q.trim());
      if (my !== seq.current) return;
      const next: SearchState = { query: q, hits: res.hits, index: 0, total: res.total, next: res.next };
      setState(next);
      // Сразу к самому новому найденному — как `BottomBar::setTotal` → `setCurrent(1)` у tdesktop.
      if (res.hits[0]) void goRef.current(res.hits[0].id);
    } catch {
      if (my === seq.current) setState({ query: q, hits: [], index: 0, total: 0, next: null });
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }, []);

  // Набор — с паузой; пустое поле — без найденного.
  useEffect(() => {
    if (!open) return;
    if (!query.trim()) {
      seq.current++;
      setState(null);
      setBusy(false);
      return;
    }
    if (stateRef.current?.query === query) return;
    const t = window.setTimeout(() => void run(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, open, run]);

  const loadMore = useCallback(async (): Promise<void> => {
    const s = srcRef.current;
    const cur = stateRef.current;
    if (!s || !cur?.next) return;
    if (moreRef.current) return moreRef.current;
    const my = seq.current;
    const p = (async () => {
      try {
        const res = await s.search(cur.query.trim(), cur.next ?? undefined);
        if (my !== seq.current) return;
        setState((st) => (st && st.query === cur.query ? appendHits(st, res.hits, res.next, res.total) : st));
        stateRef.current = stateRef.current && appendHits(stateRef.current, res.hits, res.next, res.total);
      } catch {
        /* следующая стрелка попробует снова */
      } finally {
        moreRef.current = null;
      }
    })();
    moreRef.current = p;
    return p;
  }, []);

  const step = useCallback(
    async (dir: 'older' | 'newer') => {
      const cur = stateRef.current;
      if (!cur) return;
      const plan = stepPlan(cur, dir);
      let index = plan.index;
      if (plan.needMore || (index === null && canStep(cur, dir))) {
        const wait = loadMore();
        if (index === null) {
          await wait;
          const after = stateRef.current;
          if (!after || after.query !== cur.query) return;
          index = cur.index + 1 < after.hits.length ? cur.index + 1 : null;
        }
      }
      if (index === null) return;
      const hit = stateRef.current?.hits[index];
      if (!hit) return;
      setState((st) => (st ? { ...st, index: index! } : st));
      void goRef.current(hit.id);
    },
    [loadMore],
  );

  const submit = useCallback(
    (shift: boolean) => {
      const cur = stateRef.current;
      if (!cur || cur.query !== query) {
        void run(query);
        return;
      }
      void step(shift ? 'newer' : 'older');
    },
    [query, run, step],
  );

  // Открыли — фокус в поле; «назад» телефона (стрелка в шапке и системная) закрывает поиск; выход из беседы — тоже.
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    setExit(close);
    /* Системная «назад» Android (`__gvBack` → `stepBack`) — перехватчик, как у выделения и ответа: сначала поиск, потом беседа
       (TG Android `ChatActivity.java:34667`, `onBackPressed`: `actionBar.isSearchFieldVisible()` → `closeSearchField()`).
       Раньше её ловила только стрелка в шапке (`exitChatSearch`), а системная уводила в список (аудит S20+ 10.10, B2). Поверх
       ленты окно — шаг не наш. */
    const back = pushBackHandler(() => {
      const s = useStore.getState();
      if (s.adminOpen || s.settingsOpen || s.mobileProfileOpen || s.mobileMembersOpen || s.mobilePane !== 'content')
        return false;
      close();
      return true;
    });
    /* Ушли из беседы к списку (свайп, вкладка, «назад» мимо поиска) — поиск закрыт: на телефоне лента остаётся смонтированной, и
       следующий вход открывался бы прямо в поиске со старым запросом и без поля ввода (B2). */
    const unsub = useStore.subscribe((s, prev) => {
      if (prev.mobilePane === 'content' && s.mobilePane !== 'content') close();
    });
    return () => {
      setExit(null);
      back();
      unsub();
    };
  }, [open, close]);

  // Ctrl+F — открыть (и не дать браузеру свой поиск), F3 / Shift+F3 — по найденному, Esc вне поля — закрыть.
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyF') {
        e.preventDefault();
        e.stopPropagation();
        if (srcRef.current?.open) {
          inputRef.current?.focus();
          inputRef.current?.select();
        } else srcRef.current?.setOpen(true);
        return;
      }
      if (!srcRef.current?.open) return;
      if (e.key === 'F3' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        void step(e.shiftKey ? 'newer' : 'older');
        return;
      }
      if (e.key === 'Escape' && !e.defaultPrevented && !typingTarget(e.target)) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [src ? 1 : 0, step, close]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickDay = useCallback((day: Date) => {
    setCalendarAt(null);
    const s = srcRef.current;
    if (!s) return;
    void s.jumpToDate(day).then(
      (id) => {
        if (id) void goRef.current(id);
      },
      () => {
        /* тост покажет лента при следующем переходе; молча — как у «Вниз» без сети */
      },
    );
  }, []);

  return {
    open,
    query,
    setQuery,
    state,
    busy,
    label: query.trim() && state && state.query === query ? counterLabel(state) : null,
    canOlder: canStep(state, 'older'),
    canNewer: canStep(state, 'newer'),
    older: () => void step('older'),
    newer: () => void step('newer'),
    submit,
    close,
    inputRef,
    calendarAt,
    openCalendar: (day) => setCalendarAt(day ?? new Date()),
    closeCalendar: () => setCalendarAt(null),
    pickDay,
  };
}

function NavButtons({ cs, size }: { cs: ChatSearchCtl; size: number }) {
  return (
    <>
      <button
        type="button"
        className="topbar-btn"
        aria-label="Более старое"
        title="Более старое · Enter, F3"
        disabled={!cs.canOlder}
        onClick={cs.older}
      >
        <Icon name="chevron-up" size={size} />
      </button>
      <button
        type="button"
        className="topbar-btn"
        aria-label="Более новое"
        title="Более новое · Shift+Enter, Shift+F3"
        disabled={!cs.canNewer}
        onClick={cs.newer}
      >
        <Icon name="chevron-down" size={size} />
      </button>
    </>
  );
}

/**
 * Шапка ленты в поиске: поле с лупой; на ПК справа — «N из M», стрелки, календарь и крестик (Web A на ПК: всё в шапке),
 * на телефоне — только поле и крестик (счётчик и стрелки — внизу, `ChatSearchFoot`).
 */
export function ChatSearchHead({ cs }: { cs: ChatSearchCtl }) {
  const phone = usePhoneLayout();
  return (
    <div className="channel-topbar chat-search-head" role="search">
      <label className="chat-search-field">
        <Icon name="search" size={16} />
        <input
          ref={cs.inputRef}
          type="search"
          value={cs.query}
          placeholder="Поиск"
          aria-label="Поиск по беседе"
          enterKeyHint="search"
          onChange={(e) => cs.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              cs.submit(e.shiftKey);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cs.close();
            }
          }}
        />
      </label>
      {!phone && (
        <span className="topbar-actions">
          {cs.label && (
            <span className="chat-search-count" aria-live="polite">
              {cs.label}
            </span>
          )}
          <NavButtons cs={cs} size={18} />
          <button type="button" className="topbar-btn" aria-label="Перейти к дате" title="Перейти к дате" onClick={() => cs.openCalendar()}>
            <Icon name="calendar-time" size={18} />
          </button>
          <button type="button" className="topbar-btn" aria-label="Закрыть поиск" title="Закрыть поиск · Esc" onClick={cs.close}>
            <Icon name="close" size={18} />
          </button>
        </span>
      )}
      {phone && cs.query && (
        <span className="topbar-actions">
          <button type="button" className="topbar-btn" aria-label="Очистить" title="Очистить" onClick={() => cs.setQuery('')}>
            <Icon name="close" size={18} />
          </button>
        </span>
      )}
    </div>
  );
}

/** Нижняя панель телефона в поиске — на месте поля ввода и в его рамке: календарь, «N из M», вверх / вниз. */
export function ChatSearchFoot({ cs }: { cs: ChatSearchCtl }) {
  return (
    <div className="composer sel-bar chat-search-foot">
      <button type="button" className="topbar-btn" aria-label="Перейти к дате" title="Перейти к дате" onClick={() => cs.openCalendar()}>
        <Icon name="calendar-time" size={20} />
      </button>
      <span className="chat-search-count" aria-live="polite">
        {cs.label ?? ''}
      </span>
      <NavButtons cs={cs} size={20} />
    </div>
  );
}

/**
 * Подсветка найденного в тексте пузырей — CSS Custom Highlight API (`::highlight(gv-search)`): диапазоны поверх текста,
 * DOM ленты не трогается (React-узлы не подменяются). Нет API (старый движок) — без подсветки, переход и вспышка строки
 * остаются. Только текст сообщений (`.message-body`), не время и не имена.
 */
export function useSearchHighlight(listRef: React.RefObject<HTMLElement>, query: string, version: unknown) {
  useEffect(() => {
    const reg = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    const HL = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!reg || !HL) return;
    const list = listRef.current;
    if (!list || !query.trim()) {
      reg.delete('gv-search');
      return;
    }
    const ranges: Range[] = [];
    for (const body of list.querySelectorAll('.message-body')) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement?.closest('.bub-meta')) continue;
        for (const [a, b] of matchRanges(n.textContent ?? '', query)) {
          const r = document.createRange();
          r.setStart(n, a);
          r.setEnd(n, b);
          ranges.push(r);
        }
      }
    }
    reg.set('gv-search', new HL(...ranges));
    return () => {
      reg.delete('gv-search');
    };
  }, [listRef, query, version]);
}

const dayClass = (c: JumpCell): string => `sched-day${c.today ? ' today' : ''}${c.on ? ' on' : ''}${c.out ? ' out' : ''}`;

/**
 * «Перейти к дате»: месяц сеткой (классы календаря «Отправить позже»), открыт на месяце нажатой даты с выделенным днём;
 * нажатие на день — сразу переход (tdesktop: щелчок по дню календаря прыгает). Позже сегодня — неактивно.
 * ПК — окно по центру, телефон — лист снизу.
 */
export function JumpDateDialog({ at, onPick, onClose }: { at: Date; onPick: (day: Date) => void; onClose: () => void }) {
  const phone = usePhoneLayout();
  const now = useMemo(() => new Date(), []);
  const [view, setView] = useState(() => monthOf(at));
  const cells = jumpMonthGrid(view, at, now);
  const body = (
    <div className="sched-pick jump-date">
      <div className="sched-cal">
        <div className="sched-cal-head">
          <button type="button" className="sched-cal-nav" aria-label="Предыдущий месяц" onClick={() => setView(shiftMonth(view, -1))}>
            <Icon name="chevron-left" size={18} />
          </button>
          <strong aria-live="polite">{monthTitle(view)}</strong>
          <button
            type="button"
            className="sched-cal-nav"
            aria-label="Следующий месяц"
            disabled={!canGoNextMonth(view, now)}
            onClick={() => setView(shiftMonth(view, 1))}
          >
            <Icon name="chevron-right" size={18} />
          </button>
        </div>
        <div className="sched-grid">
          {JUMP_WEEKDAYS.map((w) => (
            <span className="sched-wd" key={w} aria-hidden="true">
              {w}
            </span>
          ))}
          {cells.map((c) => (
            <button
              type="button"
              className={dayClass(c)}
              key={c.key}
              disabled={c.disabled}
              aria-pressed={c.on}
              aria-label={c.aria}
              onClick={() => onPick(c.date)}
            >
              {c.n}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
  if (phone)
    return (
      <BottomSheet title="Перейти к дате" onClose={onClose}>
        {body}
      </BottomSheet>
    );
  return <JumpDateModal onClose={onClose}>{body}</JumpDateModal>;
}

function JumpDateModal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useDialogChrome<HTMLDivElement>(onClose);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal create-channel jump-date-modal"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Перейти к дате"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-head">
          <h2>Перейти к дате</h2>
          <button type="button" className="icon-close" aria-label="Закрыть" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
