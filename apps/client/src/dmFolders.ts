import {
  FEATURE_FOLDERS1,
  dmFolderOwnPins,
  dmFolderPinSlots,
  dmFolderPinToggled,
  dmFolderToggled,
  type DmFolder,
  type DmFolderChat,
  type DmFolderInput,
  type DmFolderList,
} from '@gusvoice/shared';
import { create } from 'zustand';
import { api } from './api';
import { activeInstanceId } from './config';

/**
 * Папки бесед ЛС (07.10, #211, G40, решение владельца Р-8; сервер `folders1`). Определения — с сервера (событие
 * `dmFolders.update` держит все мои устройства в согласии), выбранная вкладка — своя у каждого устройства (как у
 * Telegram). Отбор бесед и счётчики — `dmFolderView.ts`.
 */
const ACTIVE_KEY = 'gv.dmFolder.active';

/** Сервер умеет папки. */
export function serverFolders(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_FOLDERS1);
}

function readActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function saveActive(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* хранилище недоступно — вкладка просто не запомнится */
  }
}

interface DmFoldersState {
  /** Папки по порядку (системная — тоже); `null` — ещё не загружали для этого инстанса. */
  folders: DmFolder[] | null;
  /** Чьи это папки — инстанс (десктоп и Android переключают инстансы). */
  owner: string | null;
  /** Открытая вкладка; `null` или пропавшая — первая по порядку. */
  activeId: string | null;
  load: () => Promise<void>;
  apply: (folders: DmFolder[]) => void;
  select: (id: string) => void;
  create: (input: DmFolderInput) => Promise<string>;
  update: (id: string, input: DmFolderInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reorder: (ids: string[]) => Promise<void>;
  /** Свой порядок закреплённых в папке (09.10, `pinorder2`): сразу на месте, ответ сервера — истина, отказ — откат и ошибка. */
  reorderPins: (folderId: string, ids: string[]) => Promise<void>;
  /** «Добавить в папку» / «Убрать из папки» из меню беседы (`ChangeFilterById`). */
  toggleChat: (folderId: string, chat: DmFolderChat, add: boolean) => Promise<void>;
  /** Сервер ведёт у папок свой набор закреплённых (`pinset1`); ставит `useDmFolderUi`. Новая папка тогда — сразу со своим набором. */
  pinSet: boolean;
  /** Закрепить / открепить беседу только в папке (09.10, `pinset1`): сразу на месте, ответ сервера — истина, отказ — откат и ошибка. */
  pinChat: (folderId: string, convId: string, pinned: boolean) => Promise<void>;
  /** Перевести папки на свой набор (`pinset1`): `ids` — что сейчас видно закреплённым в каждой; ответ сервера — истина. */
  pinOwn: (folders: { id: string; ids: string[] }[]) => Promise<void>;
}

let loading: Promise<void> | null = null;

const inputOf = (f: DmFolder): DmFolderInput => ({
  title: f.title,
  emoticon: f.emoticon,
  flags: f.flags,
  include: f.include,
  exclude: f.exclude,
});

export const useDmFolders = create<DmFoldersState>((set, get) => ({
  folders: null,
  owner: null,
  activeId: readActive(),
  pinSet: false,
  load: async () => {
    const owner = activeInstanceId() ?? '';
    if (get().owner !== owner) set({ folders: null, owner });
    if (loading) return loading;
    loading = api
      .dmFolders()
      .then((r) => {
        if ((activeInstanceId() ?? '') === owner) set({ folders: r.folders });
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  },
  apply: (folders) => {
    if (get().owner === null) set({ owner: activeInstanceId() ?? '' });
    set({ folders });
  },
  select: (id) => {
    saveActive(id);
    set({ activeId: id });
  },
  create: async (input) => {
    const r = await api.dmFolderCreate(get().pinSet ? { ...input, pinnedOwn: true } : input);
    set({ folders: r.folders });
    return r.id;
  },
  update: async (id, input) => {
    const r: DmFolderList = await api.dmFolderUpdate(id, input);
    set({ folders: r.folders });
  },
  remove: async (id) => {
    const r = await api.dmFolderDelete(id);
    set({ folders: r.folders });
  },
  reorder: async (ids) => {
    const was = get().folders;
    // Сразу на месте (перетаскивание не должно прыгать назад), ответ сервера — истина.
    if (was) set({ folders: ids.map((x) => was.find((f) => f.id === x)).filter((f): f is DmFolder => !!f) });
    try {
      set({ folders: (await api.dmFolderOrder(ids)).folders });
    } catch (e) {
      set({ folders: was });
      throw e;
    }
  },
  reorderPins: async (folderId, ids) => {
    const was = get().folders;
    // Свой набор (`pinset1`) сервер только переставляет (`dmFolderPinSlots`) — на месте так же, чтобы не прыгало.
    const at = (f: DmFolder) => {
      const own = dmFolderOwnPins(f);
      return own ? dmFolderPinSlots(own, ids) : ids;
    };
    if (was) set({ folders: was.map((f) => (f.id === folderId ? { ...f, pinned: at(f) } : f)) });
    try {
      set({ folders: (await api.dmFolderPinOrder(folderId, ids)).folders });
    } catch (e) {
      set({ folders: was });
      throw e;
    }
  },
  toggleChat: async (folderId, chat, add) => {
    let f = get().folders?.find((x) => x.id === folderId);
    if (!f || f.system) return;
    // «Убрать из папки» снимает и закреп в ней (`pinset1`, как Telegram) — иначе закреплённая осталась бы в папке.
    if (!add && dmFolderOwnPins(f)?.includes(chat.id)) {
      await get().pinChat(folderId, chat.id, false);
      f = get().folders?.find((x) => x.id === folderId);
      if (!f) return;
    }
    await get().update(folderId, inputOf(dmFolderToggled(f, chat, add)));
  },
  pinChat: async (folderId, convId, pinned) => {
    const was = get().folders;
    if (was)
      set({
        folders: was.map((f) => {
          const own = f.id === folderId ? dmFolderOwnPins(f) : null;
          return own ? { ...f, pinned: dmFolderPinToggled(own, convId, pinned) } : f;
        }),
      });
    try {
      set({ folders: (await api.dmFolderPin(folderId, convId, pinned)).folders });
    } catch (e) {
      set({ folders: was });
      throw e;
    }
  },
  pinOwn: async (folders) => {
    set({ folders: (await api.dmFolderPinOwn(folders)).folders });
  },
}));
