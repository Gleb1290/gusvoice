import type { Sticker, StickerPack } from '@gusvoice/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { placeByAnchor, toLayoutRect } from '../popover';
import { StickerView } from './StickerView';

/** Отступ от кнопки и от края экрана — тот же, что у пикера эмодзи. */
const M = 8;
/** Сторона плитки в сетке. */
const CELL = 72;

/**
 * Пикер стикеров (#68). Отдельный от пикера эмодзи намеренно: там сетка символов с тонами кожи и
 * подсказками про `:код:`, здесь — крупные картинки, которые ещё и анимируются. Сложить это в один
 * компонент значило бы вести в нём две несвязанные жизни.
 *
 * Математика размещения общая — `placeByAnchor` уже вынесена в `popover.ts` (#65), поэтому
 * единственная по-настоящему хитрая часть не дублируется.
 */
export function StickerPicker({
  anchor,
  packs,
  onPick,
  onClose,
}: {
  anchor: DOMRect;
  packs: StickerPack[];
  onPick: (s: Sticker) => void;
  onClose: () => void;
}) {
  const [packId, setPackId] = useState<string>(packs[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const popRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

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
      const { offsetWidth: w, offsetHeight: h } = el;
      setPos(placeByAnchor(toLayoutRect(anchor), w, h, M));
    }
    place();
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [anchor]);

  const shown: Sticker[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Ищем по подписи-эмодзи и по названию набора. Своего текста у стикера нет — искать больше не по чему.
    if (q)
      return packs.flatMap((p) =>
        p.title.toLowerCase().includes(q) ? p.stickers : p.stickers.filter((s) => s.emoji.includes(q)),
      );
    return packs.find((p) => p.id === packId)?.stickers ?? [];
  }, [packs, packId, query]);

  return (
    <>
      <div className="emoji-backdrop" onClick={onClose} />
      <div
        className="sticker-pop"
        ref={popRef}
        // Первый кадр скрыт: пока не измерили, куда встать, показывать в левом верхнем углу — это рывок.
        style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="emoji-search">
          <input
            autoFocus
            value={query}
            placeholder="Поиск по эмодзи или названию набора"
            aria-label="Поиск стикеров"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {!query && packs.length > 1 && (
          <div className="emoji-tabs">
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
          </div>
        )}

        <div className="sticker-grid" ref={gridRef}>
          {shown.map((s) => (
            <StickerCell key={s.id} sticker={s} root={gridRef} onPick={onPick} />
          ))}
          {shown.length === 0 && (
            <div className="emoji-empty muted">{query ? 'Ничего не нашлось' : 'В наборе пусто'}</div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Одна плитка. Анимация включается, только когда плитка реально видна.
 *
 * Без этого сотня Lottie-анимаций в наборе запускается разом и вкладка начинает захлёбываться —
 * это не догадка, у `.tgs` каждый экземпляр строит собственное SVG-дерево.
 */
function StickerCell({
  sticker,
  root,
  onPick,
}: {
  sticker: Sticker;
  root: React.RefObject<HTMLDivElement | null>;
  onPick: (s: Sticker) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(false);

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
      onClick={() => onPick(sticker)}
    >
      <StickerView url={sticker.url} format={sticker.format} emoji={sticker.emoji} size={CELL} animate={visible} />
    </button>
  );
}
