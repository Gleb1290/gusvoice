import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { placeDropdown, toLayoutRect, viewportSafe } from '../popover';
import {
  type SelectOption,
  filterOptions,
  groupOptions,
  hasValue,
  initialHighlight,
  moveHighlight,
  shouldSearch,
  triggerTextOf,
} from '../selectRules';
import { Goose } from './Goose';
import { Icon, type IconName } from './Icon';

export type { SelectOption } from '../selectRules';

/** Телефонная ширина — там список раскрывается листом снизу, как остальные поповеры приложения. */
function useIsMobile(): boolean {
  const [m, setM] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 620px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 620px)');
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

/**
 * Свой список выбора вместо нативного `<select>` (#153, макет `docs/design/design-step9/Dropdown.dc.html`).
 *
 * Правила — в `selectRules.ts`; здесь вид и клавиатура. Три вещи, ради которых он вообще написан:
 *
 * 1. **Не схлопывается от перерисовки.** Нативный список — виджет системы: любая перерисовка
 *    родителя закрывала его посреди выбора (в настройках звука из-за этого индикатор уровня
 *    микрофона гоняют мимо React).
 * 2. **Длинное имя не ломает верстку.** «Микрофон (2- High Definition Audio Device)» в триггере
 *    обрезается многоточием, а в строке списка переносится целиком — видно, что выбираешь.
 * 3. **Клавиатура.** ↑↓ ходят по доступным строкам, Enter выбирает, Esc закрывает, печать уходит в
 *    поиск. У длинных списков поиск появляется сам (`SEARCH_FROM`).
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = 'Выберите…',
  disabled,
  error,
  icon,
  title,
  searchPlaceholder = 'Поиск',
  emptyText = 'Ничего не найдено',
  id,
  className,
  ariaLabel,
  ariaDescribedBy,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Текст отказа под триггером: рамка краснеет, подпись объясняет. */
  error?: string;
  /** Иконка слева в триггере (микрофон, наушники). */
  icon?: IconName;
  /** Заголовок мобильного листа; на десктопе не виден. */
  title?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  id?: string;
  className?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(-1);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number; up: boolean } | null>(null);
  const [width, setWidth] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  const searchable = shouldSearch(options.length);
  const shown = useMemo(() => (searchable ? filterOptions(options, query) : options), [options, query, searchable]);
  const groups = useMemo(() => groupOptions(shown), [shown]);
  const text = triggerTextOf(options, value, placeholder);
  const filled = hasValue(options, value);
  const selectedDot = options.find((o) => o.value === value)?.dot;

  function openList() {
    if (disabled) return;
    setQuery('');
    setHi(initialHighlight(options, value));
    setOpen(true);
  }

  function choose(o: SelectOption) {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
    // Возвращаем фокус на триггер: иначе после выбора он улетает в body, и следующий Tab начинает
    // обход страницы заново — с клавиатуры это выглядит как «список проглотил фокус».
    triggerRef.current?.focus();
  }

  // Размер и место попапа считаем ПОСЛЕ отрисовки: высота зависит от числа строк, а ширина —
  // от триггера. Первый кадр прячем (visibility), чтобы список не мигнул в левом верхнем углу.
  useLayoutEffect(() => {
    if (!open || isMobile) return;
    const t = triggerRef.current;
    const el = popRef.current;
    if (!t || !el) return;
    const rect = toLayoutRect(t.getBoundingClientRect());
    setWidth(rect.width);
    setPlace(placeDropdown(rect, rect.width, el.offsetHeight, 8, viewportSafe()));
  }, [open, isMobile, shown.length]);

  useEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    window.addEventListener('mousedown', onDown);
    // Лист на телефоне от этого не закрываем: экранная клавиатура шлёт и resize, и blur.
    if (!isMobile) {
      window.addEventListener('resize', close);
      window.addEventListener('blur', close);
    }
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [open, isMobile]);

  // Лист на телефоне закрывается Esc/«назад» сам: у него нет поля с фокусом, и без этого слушателя
  // `stepBack` (Esc на window) закрывал окно под листом, а лист оставался (C1).
  useEffect(() => {
    if (!open || !isMobile) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [open, isMobile]);

  // Поле поиска ловит фокус само: длинный список открывают, чтобы найти, а не чтобы любоваться.
  useEffect(() => {
    if (!open || isMobile || !searchable) return;
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, isMobile, searchable]);

  // Подсветка не должна показывать на пустоту после фильтрации.
  useEffect(() => {
    if (!open) return;
    if (hi >= shown.length || (hi >= 0 && shown[hi]?.disabled)) setHi(shown.findIndex((o) => !o.disabled));
  }, [open, shown, hi]);

  function onKey(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((cur) => moveHighlight(shown, cur, e.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const o = shown[hi];
      if (o) choose(o);
      return;
    }
    if (e.key === 'Tab') setOpen(false);
  }

  const rows = (
    <>
      {groups.map((g, gi) => (
        <div key={g.group ?? `g${gi}`} className="dd-group">
          {g.group != null && <div className="dd-group-label">{g.group}</div>}
          {g.items.map((o) => {
            const idx = shown.indexOf(o);
            const sel = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={sel}
                className={`dd-row${sel ? ' sel' : ''}${idx === hi ? ' hi' : ''}${o.disabled ? ' off' : ''}`}
                disabled={o.disabled}
                onMouseEnter={() => setHi(idx)}
                onClick={() => choose(o)}
              >
                <span className="dd-check">{sel && <Icon name="check" size={15} />}</span>
                {o.dot != null && <span className="dd-dot" style={{ background: o.dot }} />}
                <span className="dd-labels">
                  <span className="dd-label">{o.label}</span>
                  {o.hint != null && <span className="dd-hint">{o.hint}</span>}
                </span>
                {o.meta != null && <span className="dd-meta">{o.meta}</span>}
              </button>
            );
          })}
        </div>
      ))}
      {shown.length === 0 && (
        <div className="dd-empty">
          <Goose pose="look" size={76} />
          <div className="dd-empty-title">{emptyText}</div>
          <div className="dd-empty-sub">Гусь искал, но не нашёл «{query}».</div>
        </div>
      )}
    </>
  );

  const search = searchable && (
    <div className="dd-search">
      <Icon name="search" size={15} />
      <input
        ref={searchRef}
        value={query}
        placeholder={searchPlaceholder}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
      />
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        className={`dd-trigger${open ? ' open' : ''}${error ? ' bad' : ''}${className ? ` ${className}` : ''}`}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKey}
      >
        {icon != null && <Icon name={icon} size={16} />}
        {selectedDot != null && <span className="dd-dot" style={{ background: selectedDot }} />}
        <span className={`dd-value${filled ? '' : ' ph'}`}>{text}</span>
        <Icon name="chevron-down" size={16} />
      </button>
      {error != null && <div className="dd-error">{error}</div>}

      {open &&
        !isMobile &&
        createPortal(
          <div
            ref={popRef}
            className={`dd-pop${place?.up ? ' up' : ''}`}
            role="listbox"
            style={{
              left: place?.left ?? 0,
              top: place?.top ?? 0,
              width: width || undefined,
              visibility: place ? 'visible' : 'hidden',
            }}
            onKeyDown={onKey}
          >
            {search}
            <div className="dd-list" style={{ maxHeight: place ? Math.max(120, place.maxHeight - 88) : 260 }}>
              {rows}
            </div>
            <div className="dd-foot">
              <kbd>↑↓</kbd> выбор <kbd>Enter</kbd> применить
            </div>
          </div>,
          document.body,
        )}

      {open &&
        isMobile &&
        createPortal(
          <div className="sheet-scrim" onMouseDown={() => setOpen(false)}>
            <div
              ref={popRef}
              className="sheet dd-sheet"
              role="listbox"
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={onKey}
            >
              <div className="sheet-grab" />
              {title != null && <div className="dd-sheet-title">{title}</div>}
              {search}
              <div className="dd-list">{rows}</div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
