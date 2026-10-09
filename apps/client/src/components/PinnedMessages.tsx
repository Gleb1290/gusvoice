import type { Message } from '@gusvoice/shared';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api';
import { replyQuoteLook } from '../bubbleRules';
import { useNameResolver } from '../memberName';
import { roomBelow, toLayoutRect, viewportSafe } from '../popover';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

function when(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/**
 * Закреплённое сообщение канала одной строкой — правилом цитат раунда 10 (`replyQuoteLook`), как строка списка закреплённых
 * ЛС (`convSyncRules.pinPreview(…, true)`): миниатюры в списке нет, поэтому у фото с подписью впереди «Фото · ». Раньше
 * всё без текста было «вложение» (замечание приёмки 05.10). Ни текста, ни вложений, ни стикера (опрос) — пусто, как было.
 */
function pinLine(m: Message): string {
  if (!m.content && !m.attachments.length && !m.sticker) return '';
  const look = replyQuoteLook({ content: m.content, deleted: false }, m);
  return look.kind === 'photo' && m.content.trim() ? `Фото · ${look.text}` : look.text;
}

/**
 * Channel-header pinned-messages popover (round-7 P4). Fetches the channel's pins on open;
 * a manager (MANAGE_MESSAGES) can unpin from here. Live message.update events keep the chat
 * in sync separately — this list is fetched fresh each time it opens.
 */
export function PinnedMessages({ channelId, canManage }: { channelId: string; canManage: boolean }) {
  const nameOf = useNameResolver();
  const [open, setOpen] = useState(false);
  const [pins, setPins] = useState<Message[] | null>(null);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setPins(null);
    api
      .listPins(channelId)
      .then(setPins)
      .catch((e) => {
        toastError(e);
        setOpen(false);
      });
  }

  async function unpin(m: Message) {
    try {
      await api.unpinMessage(channelId, m.id);
      setPins((cur) => (cur ?? []).filter((x) => x.id !== m.id));
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="pins">
      <button type="button" className="pins-btn" title="Закреплённые сообщения" onClick={toggle}>
        <Icon name="pin" size={18} />
      </button>
      {open && (
        <>
          <div className="pins-backdrop" onClick={() => setOpen(false)} />
          <div className="pins-pop">
            <div className="pins-head">
              <Icon name="pin" size={18} className="pins-head-icon" />
              <span className="pins-title">Закреплённые</span>
              <span className="pins-count">{pins?.length ?? '…'}</span>
            </div>
            <div className="pins-body">
              {pins == null ? (
                <div className="pins-empty muted">Загрузка…</div>
              ) : pins.length === 0 ? (
                <div className="pins-empty muted">Пока ничего не закреплено</div>
              ) : (
                pins.map((m) => (
                  <div className="pin-item" key={m.id}>
                    <Avatar url={m.author.avatarUrl} name={nameOf(m.author.id, m.author.displayName)} size={34} />
                    <div className="pin-main">
                      <div className="pin-head">
                        <span className="pin-author">{nameOf(m.author.id, m.author.displayName)}</span>
                        <span className="pin-when">{m.pinnedAt ? when(m.pinnedAt) : ''}</span>
                      </div>
                      <div className="pin-text">{pinLine(m)}</div>
                    </div>
                    {canManage && (
                      <button type="button" className="pin-unpin" title="Открепить" onClick={() => void unpin(m)}>
                        <Icon name="close" size={14} />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Строка списка закреплённых беседы ЛС — уже готовыми словами (имя, время, текст одной строкой). */
export interface DmPinsItem {
  /** id закреплённого сообщения. */
  id: string;
  author: string;
  /** «сегодня, 21:08» (`convSyncRules.pinWhenLabel`). */
  when: string;
  /** Текст по правилу цитат (`convSyncRules.pinPreview(…, true)`). */
  text: string;
}

/**
 * Все закреплённые беседы ЛС (раунд 12, порция 7; HANDOFF §2.3, §10; макет `Desktop-pins-3-list`) — тот же поповер
 * `.pins-pop` раунда 7, что у канала, но строки БЕЗ аватаров (решение владельца 04.10), время — Manrope (`.pin-bar
 * .pin-when` в блоке «Раунд 12»), значок шапки 16 в своей обёртке, как в макете. Нажатие строки — переход к сообщению,
 * крестик — открепить (что спросить — решает зовущий). Ставит его полоса закрепа (`PinnedBar`, `children`); подложку
 * `.pins-backdrop` кладёт зовущий. Поповер — `aria-modal`: под ним подложка на весь экран, Esc зовущего при нём молчит.
 */
export function DmPinsList({
  items,
  onOpen,
  onUnpin,
  onUnpinAll,
  onHide,
}: {
  items: readonly DmPinsItem[];
  onOpen: (id: string) => void;
  onUnpin: (id: string) => void;
  /** «Открепить все N» (Telegram `UnpinAllMessages`): что спросить и как открепить — решает зовущий. Нет — пункта нет. */
  onUnpinAll?: () => void;
  /** «Скрыть закреплённые» (Telegram `HidePinnedBar`): полоса скрыта только у меня, до нового закреплённого. Нет — пункта нет. */
  onHide?: () => void;
}) {
  const openByKey = (e: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onOpen(id);
  };
  /* Не ниже доступной области (разведка наплывов 09.10, ландшафт 740×360: список уходил на 174 px за низ): потолок — от
     своего верха до панели навигации, дальше прокручивается тело списка (`.pin-bar .pins-pop` — колонка). Пересчёт при
     повороте и клавиатуре. */
  const popRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const el = popRef.current;
      if (!el) return;
      el.style.maxHeight = `${roomBelow(toLayoutRect(el.getBoundingClientRect()).top, viewportSafe())}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    return () => {
      window.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('resize', fit);
    };
  }, []);
  return (
    <div ref={popRef} className="pins-pop" role="dialog" aria-modal="true" aria-label="Закреплённые сообщения">
      <div className="pins-head">
        <span className="pins-head-icon">
          <Icon name="pin" size={16} />
        </span>
        <span className="pins-title">Закреплённые</span>
        <span className="pins-count">{items.length}</span>
      </div>
      <div className="pins-body">
        {items.map((it) => (
          <div className="pin-item" key={it.id} onClick={() => onOpen(it.id)}>
            <div className="pin-main" role="button" tabIndex={0} onKeyDown={(e) => openByKey(e, it.id)}>
              <div className="pin-head">
                <span className="pin-author">{it.author}</span>
                <span className="pin-when">{it.when}</span>
              </div>
              <div className="pin-text">{it.text}</div>
            </div>
            <button
              type="button"
              className="pin-unpin"
              aria-label="Открепить"
              title="Открепить"
              onClick={(e) => {
                e.stopPropagation();
                onUnpin(it.id);
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
      {(onUnpinAll || onHide) && (
        <div className="pins-foot">
          {onUnpinAll && (
            <button type="button" className="pins-foot-btn danger" onClick={onUnpinAll}>
              {`Открепить все ${items.length}`}
            </button>
          )}
          {onHide && (
            <button type="button" className="pins-foot-btn" onClick={onHide}>
              Скрыть закреплённые
            </button>
          )}
        </div>
      )}
    </div>
  );
}
