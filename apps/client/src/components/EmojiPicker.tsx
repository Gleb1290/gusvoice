import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ServerEmoji } from '@gusvoice/shared';
import { loadedIndex, loadEmojiIndex, type EmojiIndex } from '../emojiIndex';
import { type Emoji, rankEmoji, withSkinTone } from '../emojiSearch';
import { EMOJI_SHORTCODES } from '../emojiAliases';
import { codeForEmoji } from '../emojiShortcodes';
import { clampAxis, placeByAnchor, toLayoutRect, viewport } from '../popover';

const RECENT_KEY = 'gv_emoji_recent';
const TONE_KEY = 'gv_emoji_tone';

function getRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.slice(0, 24) : [];
  } catch {
    return [];
  }
}

function pushRecent(e: string): void {
  const cur = getRecents().filter((x) => x !== e);
  cur.unshift(e);
  localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, 24)));
}

function getTone(): number {
  const n = Number(localStorage.getItem(TONE_KEY));
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 0;
}

/** Кружки выбора тона: нейтральный плюс пять модификаторов Фитцпатрика. */
const TONE_SWATCHES = ['✋', '✋🏻', '✋🏼', '✋🏽', '✋🏾', '✋🏿'];

/** Gap between the popover and both the trigger and the viewport edge. */
const M = 8;
/** How long a pointer must rest on an emoji before we explain how to type it. */
const HINT_MS = 1000;

/**
 * Что рисуем в клетке: символ (уже с тоном) и запись таблицы, если известна.
 * `custom` — эмодзи сервера: рисуется картинкой и наружу уходит вторым аргументом `onPick`.
 */
type Cell = { char: string; base?: Emoji; custom?: ServerEmoji };

/**
 * Emoji picker popover anchored above a trigger button. Used by message reactions and the
 * composer. Renders a transparent backdrop that closes it on outside-click / Escape.
 *
 * Placement MEASURES the popover instead of trusting constants. It used to hardcode 340×400 to
 * match the CSS, which quietly breaks the moment the two disagree — a different size under a media
 * query, or a viewport shorter than the popover — and a wrong height meant the clamp did nothing
 * and the whole thing slid off-screen. The element also shrinks to fit small windows (see
 * `.emoji-pop`), so measuring is the only way to know how big it actually ended up.
 *
 * Таблица на 1914 эмодзи грузится ЛЕНИВО (#68). Пока её нет, сетка показывает рукописный набор —
 * то есть открывается мгновенно и уже пригодна к делу, а не встречает пустотой со спиннером.
 */
export function EmojiPicker({
  anchor,
  onPick,
  onClose,
  custom,
}: {
  anchor: DOMRect;
  /** Юникодный символ, либо (для кастомного) сам символ-заглушка + запись эмодзи вторым аргументом. */
  onPick: (emoji: string, custom?: ServerEmoji) => void;
  onClose: () => void;
  /**
   * Кастомные эмодзи сервера. НЕ передаются в подборе статуса и в ЛС: статус хранит юникодный
   * символ, а в личке серверных эмодзи нет по определению (#18).
   */
  custom?: ServerEmoji[];
}) {
  const recents = getRecents();
  const mine = custom ?? [];
  const [idx, setIdx] = useState<EmojiIndex | null>(loadedIndex);
  // Свои эмодзи — первой вкладкой и по умолчанию: их пара десятков и они всегда «своя шутка»,
  // ради которой пикер и открывают. Юникод никуда не денется, он рядом.
  const [cat, setCat] = useState<number | 'recent' | 'custom'>(
    mine.length ? 'custom' : recents.length ? 'recent' : 0,
  );
  const [query, setQuery] = useState('');
  const [tone, setTone] = useState(getTone);
  const [toneOpen, setToneOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let alive = true;
    void loadEmojiIndex()
      .then((i) => alive && setIdx(i))
      .catch(() => {
        /* останемся на рукописном наборе — он уже показан */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useLayoutEffect(() => {
    function place() {
      const el = popRef.current;
      if (!el) return;
      // offsetWidth/Height уже вёрсточные — а вот anchor пришёл из getBoundingClientRect и потому
      // экранный. Без перевода при масштабе ≠ 100% поповер уезжает на zoom-долю экрана.
      const { offsetWidth: w, offsetHeight: h } = el;
      setPos(placeByAnchor(toLayoutRect(anchor), w, h, M));
    }
    place();
    window.addEventListener('resize', place);
    // The keyboard opening fires visualViewport resize, not window resize.
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [anchor]);

  /** Запасной набор до загрузки таблицы: рукописные алиасы, показываются одной кучей. */
  const fallback: Emoji[] = useMemo(
    () => EMOJI_SHORTCODES.map((e) => ({ emoji: e.emoji, label: e.codes[0], group: 0, tags: [], codes: e.codes })),
    [],
  );

  const cells: Cell[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Свои эмодзи ищутся по имени и идут ПЕРВЫМИ: их мало, они локальная шутка сервера, и
    // потеряться среди двух тысяч юникодных им нельзя.
    const mineHits: Cell[] = q
      ? mine.filter((e) => e.name.includes(q)).map((e) => ({ char: `:${e.name}:`, custom: e }))
      : [];
    if (q) {
      const pool = idx?.all ?? fallback;
      const uni = rankEmoji(pool, query, 120).map((e) => ({ char: withSkinTone(e, tone), base: e }));
      return [...mineHits, ...uni];
    }
    if (cat === 'custom') return mine.map((e) => ({ char: `:${e.name}:`, custom: e }));
    if (cat === 'recent') return recents.map((char) => ({ char }));
    if (!idx) return fallback.map((e) => ({ char: e.emoji, base: e }));
    return (idx.byGroup[cat] ?? []).map((e) => ({ char: withSkinTone(e, tone), base: e }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, cat, query, tone, fallback, mine]);

  function choose(c: Cell) {
    // Кастомные в «недавние» не кладём: список хранится строками символов и переживает смену
    // сервера, а `:имя:` на чужом сервере ничего не значит.
    if (!c.custom) pushRecent(c.char);
    onPick(c.char, c.custom);
  }

  function pickTone(t: number) {
    setTone(t);
    setToneOpen(false);
    try {
      localStorage.setItem(TONE_KEY, String(t));
    } catch {
      /* приватный режим — тон просто не переживёт перезагрузку */
    }
  }

  // Rest the pointer on an emoji and we show the `:code:` that types it. Only for emoji that
  // actually HAVE a shortcode — a hint telling you to type something that won't work is worse
  // than staying quiet.
  const hintTimer = useRef<number | null>(null);
  const hintRef = useRef<HTMLDivElement | null>(null);
  const [hint, setHint] = useState<{ code: string; cx: number; top: number } | null>(null);

  // Centre on the cell, then pull back inside the viewport. Measured, because a hint for a long code
  // («:heart_decoration:») is far wider than one for «:ok:» — a fixed guess clips one or the other.
  useLayoutEffect(() => {
    const el = hintRef.current;
    if (!hint || !el) return;
    const w = el.offsetWidth;
    el.style.left = `${clampAxis(hint.cx - w / 2, w, viewport().vw, M)}px`;
  }, [hint]);

  function clearHint() {
    if (hintTimer.current !== null) {
      clearTimeout(hintTimer.current);
      hintTimer.current = null;
    }
    setHint(null);
  }
  function armHint(el: HTMLElement, c: Cell) {
    clearHint();
    // Код ищем по БАЗОВОМУ символу: у эмодзи с тоном кожи своего шорткода нет, и подсказка
    // молчала бы ровно там, где выбран не нейтральный тон.
    const code = c.custom ? c.custom.name : c.base ? (c.base.codes[0] ?? null) : codeForEmoji(c.char);
    if (!code) return;
    // Measure NOW: by the time the timer fires React has cleared currentTarget.
    const r = toLayoutRect(el.getBoundingClientRect());
    hintTimer.current = window.setTimeout(() => setHint({ code, cx: r.left + r.width / 2, top: r.top }), HINT_MS);
  }
  useEffect(() => clearHint, []);

  const tabs = idx?.groups ?? [];

  return (
    <>
      <div className="emoji-backdrop" onClick={onClose} />
      <div
        className="emoji-pop"
        ref={popRef}
        // Hidden for the first paint only: placement needs the rendered size, so there is one frame
        // where we don't know where it goes — showing it at 0,0 first would read as a jump.
        style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="emoji-search">
          <input
            autoFocus
            value={query}
            placeholder="Поиск: огонь, кот, пицца…"
            aria-label="Поиск эмодзи"
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="emoji-tone">
            <button type="button" title="Тон кожи" onClick={() => setToneOpen((v) => !v)}>
              {TONE_SWATCHES[tone]}
            </button>
            {toneOpen && (
              <div className="emoji-tone-pop" role="listbox" aria-label="Тон кожи">
                {TONE_SWATCHES.map((s, i) => (
                  <button
                    type="button"
                    key={i}
                    className={i === tone ? 'active' : ''}
                    role="option"
                    aria-selected={i === tone}
                    onClick={() => pickTone(i)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {!query && (
          <div className="emoji-tabs">
            {mine.length > 0 && (
              <button
                type="button"
                className={cat === 'custom' ? 'active' : ''}
                title="Эмодзи сервера"
                onClick={() => setCat('custom')}
              >
                <img className="emoji-tab-img" src={mine[0].url} alt="" />
              </button>
            )}
            {recents.length > 0 && (
              <button
                type="button"
                className={cat === 'recent' ? 'active' : ''}
                title="Недавние"
                onClick={() => setCat('recent')}
              >
                🕘
              </button>
            )}
            {tabs.map((label, i) => (
              <button
                type="button"
                key={label}
                className={cat === i ? 'active' : ''}
                title={label}
                onClick={() => setCat(i)}
              >
                {idx?.byGroup[i]?.[0]?.emoji ?? '•'}
              </button>
            ))}
          </div>
        )}

        <div className="emoji-grid">
          {cells.map((c, i) => (
            <button
              type="button"
              key={`${c.char}-${i}`}
              className="emoji-cell"
              title={c.custom ? `:${c.custom.name}:` : c.base?.label}
              onClick={() => choose(c)}
              onMouseEnter={(ev) => armHint(ev.currentTarget, c)}
              onMouseLeave={clearHint}
              onFocus={(ev) => armHint(ev.currentTarget, c)}
              onBlur={clearHint}
            >
              {c.custom ? <img className="custom-emoji" src={c.custom.url} alt={c.char} loading="lazy" /> : c.char}
            </button>
          ))}
          {cells.length === 0 && (
            <div className="emoji-empty muted">{query ? 'Ничего не нашлось' : 'Пока пусто'}</div>
          )}
        </div>
      </div>
      {/* Sibling, not a child: `.emoji-pop` clips its overflow, so a tooltip inside it would be cut. */}
      {hint && (
        <div
          className="emoji-hint"
          role="tooltip"
          ref={hintRef}
          // left lands in the layout effect above, once the width is known.
          style={{ left: 0, top: hint.top - 6 }}
        >
          <code>:{hint.code}:</code>
          <span>наберите в чате</span>
        </div>
      )}
    </>
  );
}
