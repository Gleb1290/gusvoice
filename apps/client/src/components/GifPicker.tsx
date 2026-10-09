import type { Attachment, ExternalGif, SavedGif } from '@gusvoice/shared';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import { savedGifsNow, setSavedGifs, subscribeSavedGifs } from '../savedGifs';
import { placeByAnchor, toLayoutRect, viewportSafe } from '../popover';
import { toastError } from '../toast';
import { ContextMenu, MenuItem } from './ContextMenu';
import { exprAutoFocus } from './ExprTabs';

/**
 * Вкладка «GIF» панели строки ввода (07.10, #211, Р-7, признак сервера `gifs1`). Как у Telegram (tdesktop
 * `chat_helpers/gifs_list_widget.cpp`, Web A `middle/composer/GifPicker.tsx`): сверху поиск (только если инстанс задал
 * ключ поставщика — иначе поля нет), ниже сетка «Моих GIF» (новые первыми, общие для всех устройств — список берётся с
 * сервера при каждом открытии); с запросом — находки поставщика. Плитки играют сами, без звука, по кругу — только
 * видимые. ПКМ / долгое нажатие по своему GIF — «Удалить GIF».
 */
export type GifPick = { kind: 'saved'; gif: SavedGif } | { kind: 'external'; gif: ExternalGif };

/** GIF ли вложение: пометка сервера (`Attachment.gif`, видео без звука по кругу) или файл `image/gif`. */
export function isGifAttachment(a: Pick<Attachment, 'gif' | 'contentType'>): boolean {
  return a.gif === true || a.contentType === 'image/gif';
}

const M = 8;
/** Список с прошлого открытия — сетка видна сразу, свежий приходит следом. */
export function GifPicker({
  anchor,
  onPick,
  onClose,
  footer,
  docked,
}: {
  anchor: DOMRect;
  onPick: (g: GifPick) => void;
  onClose: () => void;
  footer?: ReactNode;
  /**
   * Закреплена колонкой справа от ленты (G61, `exprDock.ts`): без подложки, без места по якорю, Esc не закрывает; занимает
   * всю колонку (`.expr-dock`).
   */
  docked?: boolean;
}) {
  const popRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [saved, setSaved] = useState(savedGifsNow);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<ExternalGif[] | null>(null);
  const [menu, setMenu] = useState<{ g: SavedGif; x: number; y: number } | null>(null);

  useEffect(() => {
    let live = true;
    // Правки с другого устройства (`gifs.update`, `groups3`) — в открытое окно сразу.
    const off = subscribeSavedGifs((s) => live && setSaved(s));
    api
      .gifs()
      .then((r) => setSavedGifs({ gifs: r.gifs, search: r.search }))
      .catch((e) => live && toastError(e));
    return () => {
      live = false;
      off();
    };
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q || !saved?.search) {
      setFound(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      api
        .gifSearch(q)
        .then((r) => live && setFound(r.gifs))
        .catch((e) => live && toastError(e));
    }, 400);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query, saved?.search]);

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
      setPos(placeByAnchor(toLayoutRect(anchor), el.offsetWidth, el.offsetHeight, M, viewportSafe()));
    }
    place();
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [anchor, docked]);

  const removeSaved = (g: SavedGif) => {
    api
      .gifDelete(g.id)
      .then(() => {
        const now = savedGifsNow() ?? saved;
        if (now) setSavedGifs({ ...now, gifs: now.gifs.filter((x) => x.id !== g.id) });
      })
      .catch(toastError);
  };

  const searching = !!query.trim() && !!saved?.search;
  return (
    <>
      {!docked && <div className="emoji-backdrop" onClick={onClose} />}
      <div
        className={`sticker-pop gif-pop${footer ? ' expr' : ''}${docked ? ' docked' : ''}`}
        ref={popRef}
        style={docked ? undefined : pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        {saved?.search && (
          <div className="emoji-search">
            <input
              autoFocus={!docked && exprAutoFocus(footer)}
              value={query}
              placeholder="Поиск GIF"
              aria-label="Поиск GIF"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        <div className="gif-grid" ref={gridRef}>
          {searching
            ? (found ?? []).map((g) => (
                <GifCell key={g.id} url={g.previewUrl} root={gridRef} onPick={() => onPick({ kind: 'external', gif: g })} />
              ))
            : (saved?.gifs ?? []).map((g) => (
                <GifCell
                  key={g.id}
                  url={g.url}
                  image={g.contentType === 'image/gif'}
                  root={gridRef}
                  onPick={() => onPick({ kind: 'saved', gif: g })}
                  onMenu={(x, y) => setMenu({ g, x, y })}
                />
              ))}
          {!searching && saved && saved.gifs.length === 0 && (
            <div className="emoji-empty muted">Здесь будут ваши GIF. Сохранить GIF из чата — правой кнопкой по нему, «Сохранить GIF».</div>
          )}
          {searching && found && found.length === 0 && <div className="emoji-empty muted">GIF не найдены</div>}
        </div>
        {footer}
      </div>
      {menu && (
        <ContextMenu pos={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} width={200}>
          <MenuItem
            icon="trash"
            label="Удалить GIF"
            danger
            onClick={() => {
              removeSaved(menu.g);
              setMenu(null);
            }}
          />
        </ContextMenu>
      )}
    </>
  );
}

/** Плитка GIF: видео без звука по кругу играет, только пока плитка видна (сотня видео разом душит вкладку). */
function GifCell({
  url,
  image,
  root,
  onPick,
  onMenu,
}: {
  url: string;
  image?: boolean;
  root: React.RefObject<HTMLDivElement | null>;
  onPick: () => void;
  onMenu?: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver((es) => setSeen(es.some((e) => e.isIntersecting)), { root: root.current, rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);
  return (
    <button
      type="button"
      ref={ref}
      className="gif-cell"
      aria-label="GIF"
      onClick={onPick}
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              onMenu(e.clientX, e.clientY);
            }
          : undefined
      }
    >
      {seen && (image ? <img src={url} alt="" loading="lazy" /> : <video src={url} autoPlay loop muted playsInline preload="metadata" />)}
    </button>
  );
}
