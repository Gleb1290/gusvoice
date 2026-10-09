/**
 * Двойной клик по сообщению и быстрая реакция (07.10, G45 / G75, #211). Как в Telegram Desktop: «Настройки чатов» —
 * «Двойной клик по сообщению»: ответ / реакция / ничего (`DoubleClickQuickAction` в `history_view_quick_action.h`, пункты
 * `lng_settings_chat_quick_action_*`), а какая именно реакция — «любимая» (`favoriteId`): первая в полосе реакций, её же
 * ставит двойной клик; поменять — правый клик по реакции в полосе, «Выбрать по умолчанию» (`lng_context_set_as_quick`,
 * `Manager::showContextMenu` в `history_view_reactions_button.cpp`).
 *
 * Отличие от Telegram — решение владельца 07.10: по умолчанию двойной клик ставит реакцию (у Telegram — отвечает), а
 * быстрая реакция по умолчанию — 👍. Настройка этого устройства (localStorage), аккаунт не синкает — как `sendMode.ts`
 * (у Telegram Desktop обе тоже локальные). Переключатели — «Настройки → Вид → Двойной клик по сообщению»
 * (`UserSettingsModal.tsx`) и «Выбрать по умолчанию» в полосе реакций (`ReactionBar`, `ContextMenu.tsx`).
 */
import { useSyncExternalStore } from 'react';

export type DoubleClickAction = 'react' | 'reply' | 'none';

export const DOUBLE_CLICK_ACTIONS: readonly DoubleClickAction[] = ['react', 'reply', 'none'];
export const DOUBLE_CLICK_DEFAULT: DoubleClickAction = 'react';
export const QUICK_REACTION_DEFAULT = '👍';

const KEY_ACTION = 'gv_dbl_action';
const KEY_REACTION = 'gv_quick_reaction';
const EVENT = 'gv-quick-reaction-change';

/** Что хранится: только известный режим; всё прочее (пусто, мусор, будущее значение) — по умолчанию. */
export function parseDoubleClickAction(raw: string | null | undefined): DoubleClickAction {
  return DOUBLE_CLICK_ACTIONS.find((a) => a === raw) ?? DOUBLE_CLICK_DEFAULT;
}

/**
 * Что хранится в «быстрой реакции»: одна непустая строка не длиннее 32 знаков (предел сервера на `emoji` реакции); иначе
 * — 👍. Пробелы по краям не считаются.
 */
export function parseQuickReaction(raw: string | null | undefined): string {
  const v = (raw ?? '').trim();
  return v.length > 0 && v.length <= 32 ? v : QUICK_REACTION_DEFAULT;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* хранилище недоступно — остаётся значение по умолчанию */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function getDoubleClickAction(): DoubleClickAction {
  return parseDoubleClickAction(read(KEY_ACTION));
}

export function setDoubleClickAction(a: DoubleClickAction): void {
  write(KEY_ACTION, a);
}

export function getQuickReaction(): string {
  return parseQuickReaction(read(KEY_REACTION));
}

export function setQuickReaction(emoji: string): void {
  write(KEY_REACTION, parseQuickReaction(emoji));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}

/** Быстрая реакция для рисования: лента и полоса перерисовываются сами, когда её сменили (настройки, «Выбрать по умолчанию»). */
export function useQuickReaction(): string {
  return useSyncExternalStore(subscribe, getQuickReaction, () => QUICK_REACTION_DEFAULT);
}

/** Режим двойного клика для рисования (то же, что `useQuickReaction`). */
export function useDoubleClickAction(): DoubleClickAction {
  return useSyncExternalStore(subscribe, getDoubleClickAction, () => DOUBLE_CLICK_DEFAULT);
}

/**
 * Порядок полосы реакций: быстрая — первая (у Telegram «любимая» стоит первой), остальные по порядку набора. Длина
 * полосы не растёт: если быстрой нет в наборе (взята из полного выбора), из хвоста выпадает последняя.
 */
export function quickBarOrder(set: readonly string[], quick: string): string[] {
  const rest = set.filter((e) => e !== quick);
  return [quick, ...rest].slice(0, Math.max(set.length, 1));
}
