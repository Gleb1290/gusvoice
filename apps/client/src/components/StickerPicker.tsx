import type { Sticker, StickerPack } from '@gusvoice/shared';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isFavedSticker } from '../dmStickerRules';
import { ContextMenu, MenuItem } from './ContextMenu';
import { exprAutoFocus } from './ExprTabs';
import { placeByAnchor, toLayoutRect, viewportSafe } from '../popover';
import { StickerView } from './StickerView';
import { Icon } from './Icon';

/** Отступ от кнопки и от края экрана — тот же, что у пикера эмодзи. */
const M = 8;
/** Сторона плитки в сетке. */
const CELL = 72;
/** Служебные вкладки ряда наборов (ЛС, `stickers2`): не id набора — у наборов id из базы. */
const RECENT_TAB = '__recent';
const FAVED_TAB = '__faved';
/** Удержание пальцем до крупного предпросмотра (Android `ContentPreviewViewer`: системный long-press ≈ 400–500 мс). */
const PREVIEW_HOLD_MS = 400;
const CATALOG_TAB = '__catalog';

/**
 * Пикер стикеров (#68). Отдельный от пикера эмодзи намеренно: там сетка символов с тонами кожи и
 * подсказками про `:код:`, здесь — крупные картинки, которые ещё и анимируются. Сложить это в один
 * компонент значило бы вести в нём две несвязанные жизни.
 *
 * Математика размещения общая — `placeByAnchor` уже вынесена в `popover.ts` (#65), поэтому
 * единственная по-настоящему хитрая часть не дублируется.
 *
 * В строке ввода стикеры открываются ВКЛАДКОЙ рядом с эмодзи (#159, как в Telegram): оба пикера
 * получают одну и ту же нижнюю полосу `ExprTabs` и одинаковый размер (`.expr`), а переключение
 * просто меняет один пикер на другой на том же месте. Жизни по-прежнему две — общая только полоса.
 */
export function StickerPicker({
  anchor,
  packs,
  onPick,
  onClose,
  footer,
  recent,
  catalog,
  faved,
  onFave,
  onOpenSet,
  docked,
}: {
  anchor: DOMRect;
  packs: StickerPack[];
  onPick: (s: Sticker) => void;
  onClose: () => void;
  footer?: ReactNode;
  /** Закреплена колонкой справа от ленты (G61, `exprDock.ts`): без подложки и места по якорю, Esc не закрывает. */
  docked?: boolean;
  /**
   * ЛС (С2, `stickers2`): «Недавние» первой вкладкой ряда наборов и «Наборы стикеров» (`catalog` — содержимое: каталог
   * инстанса и мои наборы) последней, как «Популярные» и шестерёнка наборов у Telegram (`tabbed_selector.cpp`,
   * `EmojiView.java`). Без своих наборов панель сразу открывается на каталоге.
   */
  recent?: Sticker[];
  catalog?: ReactNode;
  /**
   * ЛС, С2 порция 2 (`stickers3`): «Избранные» (звезда) — первой вкладкой, перед «Недавними», как у Telegram
   * (tdesktop `StickersListWidget::refreshMySets`: faved, затем recent, затем наборы). `onFave` — пункт меню плитки
   * «В избранное / Убрать из избранного» (ПКМ на ПК), `onOpenSet` — «Посмотреть набор».
   */
  faved?: Sticker[];
  onFave?: (s: Sticker, on: boolean) => void;
  onOpenSet?: (s: Sticker) => void;
}) {
  const [packId, setPackId] = useState<string>(() =>
    catalog && !packs.length && !faved?.length && !recent?.length
      ? CATALOG_TAB
      : faved?.length
        ? FAVED_TAB
        : recent?.length
          ? RECENT_TAB
          : (packs[0]?.id ?? (catalog ? CATALOG_TAB : '')),
  );
  const [cellMenu, setCellMenu] = useState<{ s: Sticker; x: number; y: number } | null>(null);
  const cellMenuOn = !!onFave || !!onOpenSet;
  const [query, setQuery] = useState('');
  const popRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (docked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, docked]);

  useLayoutEffect(() => {
    if (docked) return;
    function place() {
      const el = popRef.current;
      if (!el) return;
      const { offsetWidth: w, offsetHeight: h } = el;
      setPos(placeByAnchor(toLayoutRect(anchor), w, h, M, viewportSafe()));
    }
    place();
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [anchor, docked]);

  const shown: Sticker[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Ищем по подписи-эмодзи и по названию набора. Своего текста у стикера нет — искать больше не по чему.
    if (q)
      return packs.flatMap((p) =>
        p.title.toLowerCase().includes(q) ? p.stickers : p.stickers.filter((s) => s.emoji.includes(q)),
      );
    if (packId === RECENT_TAB) return recent ?? [];
    if (packId === FAVED_TAB) return faved ?? [];
    return packs.find((p) => p.id === packId)?.stickers ?? [];
  }, [packs, packId, query, recent, faved]);
  const inCatalog = !!catalog && packId === CATALOG_TAB;
  const tabsShown = !query && (packs.length > 1 || !!recent?.length || !!faved?.length || !!catalog);

  return (
    <>
      {!docked && <div className="emoji-backdrop" onClick={onClose} />}
      <div
        className={`sticker-pop${footer ? ' expr' : ''}${docked ? ' docked' : ''}`}
        ref={popRef}
        // Первый кадр скрыт: пока не измерили, куда встать, показывать в левом верхнем углу — это рывок.
        style={docked ? undefined : pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        {!inCatalog && (
        <div className="emoji-search">
          <input
            autoFocus={!docked && exprAutoFocus(footer)}
            value={query}
            placeholder="Поиск по эмодзи или названию набора"
            aria-label="Поиск стикеров"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        )}

        {tabsShown && (
          <div className="emoji-tabs">
            {!!faved?.length && (
              <button
                type="button"
                className={packId === FAVED_TAB ? 'active' : ''}
                title="Избранные"
                aria-label="Избранные"
                onClick={() => setPackId(FAVED_TAB)}
              >
                <Icon name="star" size={18} />
              </button>
            )}
            {!!recent?.length && (
              <button
                type="button"
                className={packId === RECENT_TAB ? 'active' : ''}
                title="Недавние"
                aria-label="Недавние"
                onClick={() => setPackId(RECENT_TAB)}
              >
                <Icon name="clock" size={18} />
              </button>
            )}
            {packs.map((p) => (
              <button
                type="button"
                key={p.id}
                className={p.id === packId ? 'active' : ''}
                title={p.title}
                onClick={() => setPackId(p.id)}
              >
                {p.stickers[0] ? (
                  <StickerView
                    url={p.stickers[0].url}
                    format={p.stickers[0].format}
                    emoji={p.stickers[0].emoji}
                    size={22}
                    animate={false}
                  />
                ) : (
                  '📦'
                )}
              </button>
            ))}
            {catalog && (
              <button
                type="button"
                className={inCatalog ? 'active' : ''}
                title="Наборы стикеров"
                aria-label="Наборы стикеров"
                onClick={() => setPackId(CATALOG_TAB)}
              >
                <Icon name="plus" size={18} />
              </button>
            )}
          </div>
        )}

        {inCatalog ? (
          catalog
        ) : (
        <div className="sticker-grid" ref={gridRef}>
          {shown.map((s) => (
            <StickerCell
              key={s.id}
              sticker={s}
              root={gridRef}
              onPick={onPick}
              onMenu={cellMenuOn ? (st, x, y) => setCellMenu({ s: st, x, y }) : undefined}
            />
          ))}
          {shown.length === 0 && (
            <div className="emoji-empty muted">{query ? 'Стикеры не найдены' : 'В наборе пусто'}</div>
          )}
        </div>
        )}
        {footer}
      </div>
      {cellMenu && (
        <ContextMenu pos={{ x: cellMenu.x, y: cellMenu.y }} onClose={() => setCellMenu(null)} width={232}>
          {onFave &&
            (() => {
              const on = isFavedSticker(faved ?? [], cellMenu.s);
              return (
                <MenuItem
                  icon="star"
                  label={on ? 'Убрать из избранного' : 'В избранное'}
                  onClick={() => {
                    onFave(cellMenu.s, !on);
                    setCellMenu(null);
                  }}
                />
              );
            })()}
          {onOpenSet && (
            <MenuItem
              icon="sticker"
              label="Посмотреть набор"
              onClick={() => {
                onOpenSet(cellMenu.s);
                setCellMenu(null);
              }}
            />
          )}
        </ContextMenu>
      )}
    </>
  );
}

/**
 * Одна плитка. Анимация включается, только когда плитка реально видна.
 *
 * Без этого сотня Lottie-анимаций в наборе запускается разом и вкладка начинает захлёбываться —
 * это не догадка, у `.tgs` каждый экземпляр строит собственное SVG-дерево.
 */
export function StickerCell({
  sticker,
  root,
  onPick,
  onMenu,
}: {
  sticker: Sticker;
  root: React.RefObject<HTMLDivElement | null>;
  onPick: (s: Sticker) => void;
  /** Меню плитки (ПКМ) — С2 порция 2: «В избранное», «Посмотреть набор». */
  onMenu?: (s: Sticker, x: number, y: number) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(false);
  /*
   * Удержание пальцем — крупный предпросмотр поверх всего, пока палец на стекле (Android `ContentPreviewViewer.java`,
   * Web A `StickerButton` + `StickerPreview`): отпустил — предпросмотр закрылся, стикер НЕ отправлен. Обычный тап — отправка.
   */
  const [preview, setPreview] = useState(false);
  const hold = useRef<number | null>(null);
  const held = useRef(false);
  const dropHold = () => {
    if (hold.current !== null) window.clearTimeout(hold.current);
    hold.current = null;
  };
  useEffect(() => dropHold, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Нет IntersectionObserver — показываем всё живым: лучше нагрузка, чем неподвижная сетка.
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => setVisible(entries.some((e) => e.isIntersecting)),
      { root: root.current, rootMargin: '64px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  return (
    <button
      type="button"
      ref={ref}
      className="sticker-cell"
      title={sticker.emoji || 'стикер'}
      onClick={() => {
        if (held.current) {
          held.current = false;
          return;
        }
        onPick(sticker);
      }}
      onContextMenu={(e) => {
        // На телефоне системное долгое нажатие тоже шлёт contextmenu — там его место занимает предпросмотр.
        e.preventDefault();
        if (onMenu && hold.current === null && !preview) onMenu(sticker, e.clientX, e.clientY);
      }}
      onTouchStart={() => {
        held.current = false;
        dropHold();
        hold.current = window.setTimeout(() => {
          hold.current = null;
          held.current = true;
          setPreview(true);
        }, PREVIEW_HOLD_MS);
      }}
      onTouchMove={dropHold}
      onTouchEnd={() => {
        dropHold();
        setPreview(false);
      }}
      onTouchCancel={() => {
        dropHold();
        setPreview(false);
      }}
    >
      <StickerView url={sticker.url} format={sticker.format} emoji={sticker.emoji} size={CELL} animate={visible} />
      {preview &&
        createPortal(
          <div className="sticker-preview" aria-hidden="true">
            <div className="sticker-preview-emoji">{sticker.emoji}</div>
            <StickerView url={sticker.url} format={sticker.format} emoji={sticker.emoji} size={256} />
          </div>,
          document.body,
        )}
    </button>
  );
}
