import type { SavedGif } from '@gusvoice/shared';

/**
 * «Мои GIF» в памяти вкладки (07.10, `gifs1`; 08.10, `groups3`): последний известный список и есть ли внешний поиск.
 * Окно GIF (`components/GifPicker.tsx`) рисует его сразу и перечитывает `GET /api/gifs` при открытии; правки с другого
 * устройства приходят событием `gifs.update` (`sockets.ts` → `applyRemoteGifs`) — открытое окно обновляется на месте,
 * как у Telegram (сохранённые GIF общие для всех устройств). Без импортов, кроме типов: его тянет и `sockets.ts`.
 */
export type SavedGifsState = { gifs: SavedGif[]; search: boolean };

let current: SavedGifsState | null = null;
const listeners = new Set<(s: SavedGifsState) => void>();

export function savedGifsNow(): SavedGifsState | null {
  return current;
}

/** Свой ответ (`GET /api/gifs`, удаление в окне) — запомнить и разослать открытым окнам. */
export function setSavedGifs(next: SavedGifsState): void {
  current = next;
  for (const l of listeners) l(next);
}

/** Событие `gifs.update`: список целиком; признак поиска — прежний (событие его не несёт), до первого ответа — нет. */
export function applyRemoteGifs(gifs: SavedGif[]): void {
  setSavedGifs({ gifs, search: current?.search ?? false });
}

export function subscribeSavedGifs(l: (s: SavedGifsState) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
