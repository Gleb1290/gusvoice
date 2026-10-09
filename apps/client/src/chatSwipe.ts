/**
 * «Свайп по чату» (07.10, #211, G42): что делает свайп влево по строке беседы на телефоне. Источник — Telegram Android:
 * `DialogsActivity.SwipeController` (строка уходит влево, действие срабатывает на отпускании: порог `getSwipeThreshold` =
 * 0.45 ширины строки или бросок быстрее `getSwipeEscapeVelocity` = 3500 px/с), `SharedConfig.getChatSwipeAction` (по
 * умолчанию — «Сменить папку», если папки есть, иначе «Архив»; «Сменить папку» без папок = «Архив»),
 * `SwipeGestureSettingsView` (варианты: закрепить, прочитано, архив, без звука, удалить, сменить папку) и строки
 * `SwipeSettings*` / `SwipeMute` / `SwipeUnmute` / `SwipePin` / `SwipeUnpin` / `SwipeMarkAsRead` / `SwipeMarkAsUnread`.
 * Настройка устройства (localStorage), как у Telegram (`chatSwipeAction` в `SharedConfig`): аккаунт не синкает.
 */
export type SwipeAction = 'pin' | 'read' | 'archive' | 'mute' | 'delete' | 'folders';
export type SwipeSetting = 'auto' | SwipeAction;

export const SWIPE_DEFAULT: SwipeSetting = 'auto';
const KEY = 'gv.dm.chatSwipe';
const ALL: readonly SwipeAction[] = ['pin', 'read', 'archive', 'mute', 'delete', 'folders'];

/** Порог срабатывания — доля ширины строки (`getSwipeThreshold`). */
export const SWIPE_ROW_COMMIT = 0.45;
/** Бросок быстрее этого срабатывает и без порога (`getSwipeEscapeVelocity`), px/с. */
export const SWIPE_ROW_FLING = 3500;

export function readSwipeSetting(): SwipeSetting {
  try {
    const v = localStorage.getItem(KEY);
    return (ALL as readonly string[]).includes(v ?? '') ? (v as SwipeAction) : SWIPE_DEFAULT;
  } catch {
    return SWIPE_DEFAULT;
  }
}

export function writeSwipeSetting(v: SwipeSetting): void {
  try {
    if (v === SWIPE_DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch {
    /* хранилище недоступно — остаётся «как у Telegram» */
  }
}

/** Что умеет этот сервер и список: каждое действие есть, только если есть его пункт в меню строки. */
export interface SwipeCaps {
  /** Полоса папок показана (есть своя папка). */
  folders: boolean;
  archive: boolean;
  pin: boolean;
  read: boolean;
  mute: boolean;
  del: boolean;
}

export const swipeAvailable = (a: SwipeAction, caps: SwipeCaps): boolean =>
  a === 'folders' ? caps.folders : a === 'archive' ? caps.archive : a === 'pin' ? caps.pin : a === 'read' ? caps.read : a === 'mute' ? caps.mute : caps.del;

/** Варианты в настройке — только применимые (у Telegram «Сменить папку» без папок тоже не работает: `getChatSwipeAction`). */
export function swipeChoices(caps: SwipeCaps): SwipeAction[] {
  return ALL.filter((a) => swipeAvailable(a, caps));
}

/**
 * Действие, которое сейчас стоит на свайпе: заданное, а нет (или недоступно) — как у Telegram: «Сменить папку», пока папки
 * есть, иначе «Архив»; нет и архива — «Без звука» (доступно везде). `null` — свайпать нечем.
 */
export function effectiveSwipe(setting: SwipeSetting, caps: SwipeCaps): SwipeAction | null {
  const fallback: SwipeAction | null = caps.archive ? 'archive' : caps.mute ? 'mute' : null;
  if (setting === 'auto') return caps.folders ? 'folders' : fallback;
  return swipeAvailable(setting, caps) ? setting : fallback;
}

/**
 * Действие свайпа для КОНКРЕТНОЙ строки. Бывшая группа (`former`, `groups3`): закреп, архив, метки и заглушка у сервера —
 * «нет такой» (404), остаётся только удаление — как в меню строки (`DmRowMenu`). Поэтому у неё свайп работает лишь когда стоит
 * «Удалить», любое другое действие для неё выключено (жест уходит в листание папок). Обычная строка — действие как есть.
 */
export function rowSwipeAction(act: SwipeAction | null, former: boolean): SwipeAction | null {
  if (!former) return act;
  return act === 'delete' ? 'delete' : null;
}

/** Состояние строки, от которого зависит надпись и смысл действия. */
export interface SwipeRowState {
  pinned: boolean;
  unread: boolean;
  muted: boolean;
  archived: boolean;
  /** Бывшая группа: из действий жива только «Удалить» (`rowSwipeAction`). */
  former?: boolean;
  /** Своя папка со своим набором закреплённых (09.10, `pinset1`): «Закрепить» свайпом — только в ней; `pinned` — по её набору. */
  pinFolder?: string;
}

/** Надпись на открывшейся подложке строки (Telegram Android `SwipeMute` / `SwipeUnmute` и т.д.). */
export function swipeLabel(a: SwipeAction, s: SwipeRowState): string {
  switch (a) {
    case 'pin':
      return s.pinned ? 'Открепить' : 'Закрепить';
    case 'read':
      return s.unread ? 'Прочитано' : 'Непрочитано';
    case 'archive':
      return s.archived ? 'Вернуть' : 'В архив';
    case 'mute':
      return s.muted ? 'Вкл. звук' : 'Без звука';
    case 'delete':
      return 'Удалить';
    case 'folders':
      return 'Папки';
  }
}

/** Название варианта в настройке (`SwipeSettingsPin` … `SwipeSettingsFolders`). */
export const SWIPE_CHOICE_LABEL: Record<SwipeAction, string> = {
  pin: 'Закрепить',
  read: 'Прочитано',
  archive: 'В архив',
  mute: 'Без звука',
  delete: 'Удалить',
  folders: 'Сменить папку',
};

/** Срабатывает ли свайп на отпускании: `dx` — сдвиг строки (влево отрицателен), `vx` — скорость пальца, px/с. */
export function swipeCommits(dx: number, vx: number, width: number): boolean {
  if (dx >= 0) return false;
  return -dx >= width * SWIPE_ROW_COMMIT || (-vx >= SWIPE_ROW_FLING && -dx > 24);
}

/** Строка уходит влево только на длину, нужную подложке, и дальше тянется туго — как у `ItemTouchHelper` (строка целиком). */
export function swipeShift(dx: number, width: number): number {
  return Math.max(Math.min(dx, 0), -width);
}
