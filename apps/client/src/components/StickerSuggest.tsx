import type { Sticker, StickerPack } from '@gusvoice/shared';
import { useMemo, useRef } from 'react';
import { emojiOnlyCount } from '../bubbleRules';
import { useDmStickers } from '../dmStickers';
import { stickersForEmoji } from '../dmStickerRules';
import { StickerCell } from './StickerPicker';

/**
 * Подсказка стикеров по эмодзи (С2 порция 2, #211; tdesktop `chat_helpers/field_autocomplete.cpp` — «Suggest stickers by
 * emoji», Web A `StickerTooltip`): в поле ввода ровно один эмодзи и больше ничего — над полем лента подходящих стикеров из
 * избранных, недавних и моих наборов (`stickersForEmoji`); нажатие отправляет стикер и очищает поле, как у Telegram.
 * Подходящих нет — ленты нет. Место — то же, что у подсказок `@`/`:` (`.ac-pop`), над полем.
 */
export function StickerSuggest({
  text,
  packs,
  onPick,
}: {
  text: string;
  packs: readonly StickerPack[];
  onPick: (s: Sticker) => void;
}) {
  const faved = useDmStickers((s) => s.faved);
  const recent = useDmStickers((s) => s.recent);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const emoji = emojiOnlyCount(text) === 1 ? text.trim() : '';
  const list = useMemo(
    () => (emoji ? stickersForEmoji(emoji, { faved, recent, packs }) : []),
    [emoji, faved, recent, packs],
  );
  if (!list.length) return null;
  return (
    <div className="ac-pop sticker-suggest" role="listbox" aria-label="Стикеры по эмодзи">
      <div className="sticker-suggest-row" ref={rowRef}>
        {list.map((s) => (
          <StickerCell key={s.url} sticker={s} root={rowRef} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}
