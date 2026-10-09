import type { StickerCatalogPack } from '@gusvoice/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { confirmAction } from '../confirm';
import { stickerPackButton } from '../dmStickerRules';
import { useDmStickers } from '../dmStickers';
import { toastError } from '../toast';
import { Icon } from './Icon';
import { StickerCell } from './StickerPicker';

/**
 * Окно набора стикеров (С2, #211, признак `stickers2`): тап по стикеру в ленте или по набору в каталоге. Раскладка — как
 * `StickerSetModal` у Telegram Web A (`telegram-tt` `components/common/StickerSetModal.tsx`): название сверху, сетка
 * стикеров (нажатие отправляет стикер в открытую беседу, если окно открыто из неё), внизу одна широкая кнопка
 * «Добавить N стикеров» / «Убрать N стикеров» (у Telegram — `StickerPack.AddStickerCount` / `RemoveStickerCount`).
 * Загрузивший набор и админ инстанса видят ещё «Убрать из каталога». Хост — у корня приложения (`App.tsx`).
 */
export function StickerSetModal() {
  const open = useDmStickers((s) => s.open);
  const mine = useDmStickers((s) => s.mine);
  const [pack, setPack] = useState<StickerCatalogPack | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const close = useDmStickers((s) => s.closeSet);

  useEffect(() => {
    setPack(null);
    setMissing(false);
    if (!open) return;
    let live = true;
    const load = open.packId
      ? api.stickerPack(open.packId)
      : open.sticker
        ? api.stickerLookup(open.sticker.id, open.sticker.url)
        : null;
    load
      ?.then((p) => live && setPack(p))
      .catch(() => live && setMissing(true));
    void useDmStickers.getState().load();
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;
  // «Мой» — по живому списку стора: добавили в каталоге за этим окном — кнопка уже «Убрать».
  const isMine = !!pack && (mine ? mine.some((p) => p.id === pack.id) : pack.mine);

  async function toggle() {
    if (!pack) return;
    setBusy(true);
    try {
      const st = useDmStickers.getState();
      if (isMine) await st.remove(pack.id);
      else {
        await api.stickerMineAdd(pack.id);
        st.putFirst(pack);
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function dropFromCatalog() {
    if (!pack) return;
    const ok = await confirmAction({
      title: 'Убрать набор из каталога?',
      body: 'Набор пропадёт у всех, кто его добавил. Уже отправленные стикеры останутся в переписке.',
      confirmLabel: 'Убрать',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.stickerPackDelete(pack.id);
      await useDmStickers.getState().load(true);
      close();
    } catch (err) {
      toastError(err);
    }
  }

  const send = open.send;
  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="modal sticker-set-modal"
        role="dialog"
        aria-label={pack?.title ?? 'Набор стикеров'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticker-set-head">
          <h2>{pack ? pack.title : missing ? 'Набор стикеров' : 'Загрузка…'}</h2>
          <button type="button" className="sound-icon-btn" title="Закрыть" onClick={close}>
            <Icon name="close" size={16} />
          </button>
        </div>
        {missing ? (
          <div className="emoji-empty muted">Этого набора нет в каталоге инстанса.</div>
        ) : (
          <div className="sticker-grid sticker-set-grid" ref={gridRef}>
            {pack?.stickers.map((s) => (
              <StickerCell
                key={s.id}
                sticker={s}
                root={gridRef}
                onPick={(st) => {
                  if (!send) return;
                  close();
                  send(st);
                }}
              />
            ))}
          </div>
        )}
        {pack && (
          <div className="sticker-set-actions">
            <button type="button" className={isMine ? 'sticker-set-remove' : undefined} disabled={busy} onClick={() => void toggle()}>
              {stickerPackButton(pack.count, isMine)}
            </button>
            {pack.canDelete && (
              <button type="button" className="link danger-text" onClick={() => void dropFromCatalog()}>
                Убрать из каталога
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
