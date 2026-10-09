import type { Sticker, StickerCatalogPack, StickerLists } from '@gusvoice/shared';
import { create } from 'zustand';
import { api } from './api';
import { moveStickerPack, parseRecentStickers, pushRecentSticker, serverStickerLists } from './dmStickerRules';
import { useStore } from './store';

/**
 * Стикеры в ЛС (С2, #211, признак `stickers2`): «мои наборы» с сервера, недавние — в браузере (`gv_recent_stickers`), и
 * открытое окно набора (тап по стикеру в ленте). Правила — `dmStickerRules.ts`.
 * С2 порция 2 (`stickers3`): избранные и недавние — на сервере (`GET /api/stickers/lists`), общие для всех устройств;
 * правки с других устройств приходят событием `stickers.update` (`applyRemote`, `sockets.ts`). Без признака недавние
 * по-старому в браузере, избранных нет.
 */
const listsOnServer = () => serverStickerLists(useStore.getState().serverFeatures);
const RECENT_KEY = 'gv_recent_stickers';

function readRecent(): Sticker[] {
  try {
    return parseRecentStickers(localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

export interface StickerSetOpen {
  sticker?: Sticker;
  packId?: string;
  send?: (s: Sticker) => void;
}

interface DmStickersState {
  /** Мои наборы; `null` — ещё не загружали. */
  mine: StickerCatalogPack[] | null;
  recent: Sticker[];
  /** Избранные (`stickers3`), новый первым; без признака — пусто. */
  faved: Sticker[];
  favedLimit: number;
  /** Списки с сервера уже читали. */
  listsLoaded: boolean;
  loadLists: (force?: boolean) => Promise<void>;
  /** В избранное / из избранного (только `stickers3`); ответ сервера — списки целиком. */
  fave: (s: Sticker, on: boolean) => Promise<void>;
  /** Событие `stickers.update` с другого устройства (или эхо своего). */
  applyRemote: (msg: { lists?: StickerLists; mine?: true }) => void;
  /**
   * Окно набора: стикер, по которому нажали (набор ищется по нему), или id набора из каталога; `send` — отправить стикер в
   * беседу, из которой окно открыли (нет — сетка только смотрится).
   */
  open: StickerSetOpen | null;
  load: (force?: boolean) => Promise<void>;
  add: (packId: string) => Promise<void>;
  remove: (packId: string) => Promise<void>;
  move: (packId: string, dir: -1 | 1) => Promise<void>;
  /** Набор пришёл целиком (загрузка из Telegram, окно набора) — поставить первым, не перечитывая список. */
  putFirst: (pack: StickerCatalogPack) => void;
  used: (s: Sticker) => void;
  openSet: (o: StickerSetOpen) => void;
  closeSet: () => void;
  /** Отправка стикера в открытую беседу ЛС (ставит `DmChatView`, снимает при уходе) — для окна набора из ленты. */
  sender: ((s: Sticker) => void) | null;
  setSender: (fn: ((s: Sticker) => void) | null) => void;
}

let loading: Promise<void> | null = null;

export const useDmStickers = create<DmStickersState>((set, get) => ({
  mine: null,
  recent: readRecent(),
  faved: [],
  favedLimit: 5,
  listsLoaded: false,
  open: null,
  loadLists: async (force = false) => {
    if (!listsOnServer() || (!force && get().listsLoaded)) return;
    const l = await api.stickerLists();
    set({ faved: l.faved, recent: l.recent, favedLimit: l.favedLimit, listsLoaded: true });
  },
  fave: async (s, on) => {
    const l = await api.stickerFave(s, on);
    set({ faved: l.faved, recent: l.recent, favedLimit: l.favedLimit, listsLoaded: true });
  },
  applyRemote: (msg) => {
    if (msg.lists) set({ faved: msg.lists.faved, recent: msg.lists.recent, favedLimit: msg.lists.favedLimit, listsLoaded: true });
    if (msg.mine && get().mine) void get().load(true);
  },
  load: async (force = false) => {
    if (!force && get().mine) return;
    if (loading) return loading;
    loading = api
      .stickersMine()
      .then((r) => set({ mine: r.packs }))
      .finally(() => {
        loading = null;
      });
    return loading;
  },
  add: async (packId) => {
    await api.stickerMineAdd(packId);
    await get().load(true);
  },
  remove: async (packId) => {
    await api.stickerMineRemove(packId);
    set({ mine: (get().mine ?? []).filter((p) => p.id !== packId) });
  },
  move: async (packId, dir) => {
    const list = get().mine ?? [];
    const ids = moveStickerPack(
      list.map((p) => p.id),
      packId,
      dir,
    );
    const byId = new Map(list.map((p) => [p.id, p]));
    set({ mine: ids.map((i) => byId.get(i)!).filter(Boolean) });
    try {
      await api.stickerMineOrder(ids);
    } catch (err) {
      await get().load(true); // 409 — список поменялся на другом устройстве: берём серверный
      throw err;
    }
  },
  putFirst: (pack) => set({ mine: [{ ...pack, mine: true }, ...(get().mine ?? []).filter((p) => p.id !== pack.id)] }),
  used: (s) => {
    const recent = pushRecentSticker(get().recent, s);
    set({ recent });
    if (listsOnServer()) {
      // Сразу у себя, затем сервер (он же разошлёт остальным устройствам); его ответ — истина.
      api
        .stickerRecentPush(s)
        .then((l) => set({ faved: l.faved, recent: l.recent, favedLimit: l.favedLimit, listsLoaded: true }))
        .catch(() => {});
      return;
    }
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      /* приватный режим / переполнено — недавние живут до перезагрузки */
    }
  },
  openSet: (o) => set({ open: o }),
  closeSet: () => set({ open: null }),
  sender: null,
  setSender: (fn) => set({ sender: fn }),
}));
