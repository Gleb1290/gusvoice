import type { StickerPack } from '@gusvoice/shared';
import { useStore } from './store';

/**
 * Наборы стикеров ТЕКУЩЕГО сервера (#68).
 *
 * Как и кастомные эмодзи, берутся из bootstrap и действуют ровно в пределах сервера: в ЛС пикер
 * стикеров не показывается вовсе. Решение то же, что в #73 про ники и в #18 про эмодзи — серверная
 * настройка не должна протекать в личку.
 */
const EMPTY: StickerPack[] = [];

export function useStickerPacks(): StickerPack[] {
  return useStore((s) => s.bootstrap?.stickerPacks ?? EMPTY);
}

/** Настроен ли на инстансе токен бота — без него импортировать наборы нечем. */
export function useStickersEnabled(): boolean {
  return useStore((s) => s.bootstrap?.stickersEnabled ?? false);
}
