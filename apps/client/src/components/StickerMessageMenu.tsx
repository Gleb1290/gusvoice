import type { MessageSticker } from '@gusvoice/shared';
import { useEffect } from 'react';
import { useDmStickers } from '../dmStickers';
import { isFavedSticker, serverDmStickers, serverStickerLists } from '../dmStickerRules';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { MenuItem } from './ContextMenu';

/**
 * Пункты меню сообщения-стикера (С2 порция 2, #211; tdesktop `history_view_context_menu.cpp`: «View Sticker Set» —
 * `lng_context_pack_info`, «Add to Favorites» / «Remove from Favorites» — `lng_faved_stickers_add|remove`):
 * «Посмотреть набор» (`stickers2`) и «В избранное» / «Убрать из избранного» (`stickers3`). Без признаков — ничего.
 */
export function StickerMenuItems({ sticker, close }: { sticker: MessageSticker; close: () => void }) {
  const setsOn = useStore((s) => serverDmStickers(s.serverFeatures));
  const listsOn = useStore((s) => serverStickerLists(s.serverFeatures));
  const faved = useDmStickers((s) => s.faved);
  useEffect(() => {
    if (listsOn) void useDmStickers.getState().loadLists().catch(() => {});
  }, [listsOn]);
  if (!setsOn) return null;
  const on = isFavedSticker(faved, sticker);
  return (
    <>
      <MenuItem
        icon="sticker"
        label="Посмотреть набор"
        onClick={() => {
          const st = useDmStickers.getState();
          st.openSet({ sticker, send: st.sender ?? undefined });
          close();
        }}
      />
      {listsOn && (
        <MenuItem
          icon="star"
          label={on ? 'Убрать из избранного' : 'В избранное'}
          onClick={() => {
            close();
            void faveSticker(sticker, !on);
          }}
        />
      )}
    </>
  );
}

/**
 * В избранное / из избранного с тостом, как у Telegram («Sticker added to Favorites»). Избранных уже предел — сервер
 * вытесняет самый старый, и тост об этом говорит (tdesktop `FaveStickersToast`).
 */
export async function faveSticker(s: MessageSticker, on: boolean): Promise<void> {
  const st = useDmStickers.getState();
  const full = on && st.faved.length >= st.favedLimit && !isFavedSticker(st.faved, s);
  try {
    await st.fave(s, on);
    toast(
      'info',
      on
        ? full
          ? `Добавлено в избранное; самый старый стикер убран — избранных не больше ${st.favedLimit}`
          : 'Стикер добавлен в избранное'
        : 'Стикер убран из избранного',
    );
  } catch (err) {
    toastError(err);
  }
}
