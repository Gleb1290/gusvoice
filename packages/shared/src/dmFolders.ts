/**
 * Папки бесед ЛС (07.10, #211, G40 темы 14 плейбука, решение владельца Р-8; признак `folders1`).
 *
 * Модель — как у Telegram (`tdesktop data/data_chat_filters.h`, `ChatFilter`): у папки имя, значок-эмодзи, типы бесед,
 * которые в неё попадают сами (правило, не список), явно включённые и явно исключённые беседы. Одна беседа — в скольких
 * угодно папках: папка лишь отбирает беседы из общего списка, а не хранит их. Отбор считает клиент
 * (`dmFolderContains`) — как у Telegram (`ChatFilter::contains`); сервер хранит только определения.
 *
 * Системная папка «Личные сообщения» (`system: 'dms'`) — у Telegram это «Все чаты» (id 0): её нельзя удалить и
 * переименовать, но можно переставить. Её правило — тип «Личные» (все беседы один на один, новые тоже — по правилу).
 */

/** Беседы один на один (у Telegram — `Contacts | NonContacts`: контактов у нас нет, тип один). */
export const DM_FOLDER_PERSONAL = 1 << 0;
/** Групповые беседы ЛС (С4, пока их нет): у Telegram — `Groups`. Флаг заведён заранее, чтобы не менять модель. */
export const DM_FOLDER_GROUPS = 1 << 2;
/** Исключить беседы без уведомлений (`NoMuted`). */
export const DM_FOLDER_NO_MUTED = 1 << 5;
/** Исключить прочитанные (`NoRead`): остаются беседы с новыми сообщениями или пометкой «непрочитано». */
export const DM_FOLDER_NO_READ = 1 << 6;
/** Флаги, которые понимает этот сервер; остальные биты отбрасываются при записи. */
export const DM_FOLDER_FLAGS_KNOWN = DM_FOLDER_PERSONAL | DM_FOLDER_GROUPS | DM_FOLDER_NO_MUTED | DM_FOLDER_NO_READ;
/** Типы «кто попадает сам» (без исключающих). */
export const DM_FOLDER_TYPES = DM_FOLDER_PERSONAL | DM_FOLDER_GROUPS;

/** Пределы Telegram без Premium (`data_premium_limits.cpp`): 10 папок, по 100 бесед в включённых и исключённых. */
export const DM_FOLDERS_MAX = 10;
export const DM_FOLDER_CHATS_MAX = 100;
/** Длина имени папки — `kMaxFilterTitleLength = 12` (`boxes/filters/edit_filter_box.cpp`), в знаках. */
export const DM_FOLDER_TITLE_MAX = 12;
/** Эмодзи-значок: один знак (с модификаторами), запас по длине строки. */
export const DM_FOLDER_EMOTICON_MAX = 16;

/**
 * Значки на выбор — набор эмодзи Telegram Desktop (`ui/filter_icons.cpp`, поле `emoji` у живых значков). Берём только сами
 * эмодзи (их рисует системный шрифт), картинки Telegram — нет.
 */
export const DM_FOLDER_EMOTICONS: readonly string[] = [
  '🐱', '📕', '💰', '🎮', '💡', '👌', '🎵', '🎨', '✈️', '⚽️', '⭐', '🎓', '🛫', '👤', '👥', '💬', '✅', '🤖', '👑', '🌹', '🏠', '❤️', '🎭',
];

export interface DmFolder {
  id: string;
  /** Системная папка: `'dms'` — «Личные сообщения». Нет поля — папка человека. */
  system?: 'dms';
  /** Имя (у системной — пусто: подпись рисует клиент). */
  title: string;
  /** Значок-эмодзи; `null` — значок по правилам (`dmFolderDefaultIcon`). */
  emoticon: string | null;
  /** Битовая маска `DM_FOLDER_*`. */
  flags: number;
  /** Явно включённые беседы (id). */
  include: string[];
  /** Явно исключённые беседы (id); исключение сильнее всего остального. */
  exclude: string[];
  /**
   * Свой порядок закреплённых в этой папке сверху вниз (09.10, `pinorder2`; Telegram — `pinned_peers` фильтра). Нет поля
   * (сервер постарше) или пусто — закреплённые идут общим порядком `pinnedAt`. У системной папки не бывает.
   */
  pinned?: string[];
  /**
   * У папки свой НАБОР закреплённых (09.10, `pinset1`; Telegram — `pinned_peers` фильтра): `pinned` — набор и порядок, общий закреп
   * (`pinnedAt`) в ней не действует, закреплённая в папке беседа видна в ней, пока не исключена (как включённая явно). Нет поля —
   * прежний смысл `pinorder2`: закреплённые общие, `pinned` — только их порядок.
   */
  pinnedOwn?: true;
}

/** `GET /api/dm-folders`, событие `dmFolders.update`: все папки человека в его порядке (системная — тоже). */
export interface DmFolderList {
  folders: DmFolder[];
}

/** Тело `PUT /api/dm-folders/:id/pinned-order` (09.10, `pinorder2`): закреплённые беседы папки в новом порядке сверху вниз. */
export interface DmFolderPinOrderRequest {
  ids: string[];
}

/** Предел закреплённых в своей папке (`pinset1`) — как у Telegram (`dialogs_folder_pinned_limit_default` = 100). */
export const DM_FOLDER_PINNED_MAX = 100;

/**
 * Тело `POST /api/dm-folders/pinned-own` (09.10, `pinset1`): перевести папки на свой набор закреплённых. `ids` — что сейчас видно
 * закреплённым в папке, сверху вниз (клиент считает по своему списку: правила папки, заглушка, непрочитанное). Папка, уже
 * переведённая другим устройством, не трогается.
 */
export interface DmFolderPinOwnRequest {
  folders: { id: string; ids: string[] }[];
}

/** Тело `PUT /api/dm-folders/:id/pinned/:convId` (09.10, `pinset1`): закрепить / открепить беседу только в этой папке. */
export interface DmFolderPinRequest {
  pinned: boolean;
}

/** Набор закреплённых своей папки сверху вниз (`pinset1`), если он у папки свой; иначе `null` — закреп общий. */
export function dmFolderOwnPins(f: Pick<DmFolder, 'system' | 'pinned' | 'pinnedOwn'>): readonly string[] | null {
  if (f.system || f.pinnedOwn !== true) return null;
  return f.pinned ?? [];
}

/**
 * Закрепить / открепить в своём наборе папки (`pinset1`): новый закреп — сверху, как у Telegram (`toggleDialogPin` ставит в
 * начало `pinned_peers`); повтор и откреп незакреплённой — тот же набор.
 */
export function dmFolderPinToggled(set: readonly string[], id: string, pinned: boolean): string[] {
  const rest = set.filter((x) => x !== id);
  return pinned ? [id, ...rest] : rest;
}

/**
 * Перестановка внутри своего набора (`pinset1`): названные в `ids` члены набора занимают места названных в новом порядке,
 * остальные остаются на своих местах; чужие id и повторы не действуют. Полный список набора — ровно этот порядок; старый
 * клиент (`pinorder2`, шлёт общие закреплённые папки) набор не меняет, только переставляет общие с ним.
 */
export function dmFolderPinSlots(set: readonly string[], ids: readonly string[]): string[] {
  const inSet = new Set(set);
  const named: string[] = [];
  for (const id of ids) if (inSet.has(id) && !named.includes(id)) named.push(id);
  const isNamed = new Set(named);
  let k = 0;
  return set.map((id) => (isNamed.has(id) ? named[k++] : id));
}

/**
 * Закреплённые беседы папки по её своему порядку (09.10, `pinorder2`). `pinned` — закреплённые, что видны в папке, в общем
 * порядке (`pinnedAt`, свежее выше); `order` — `DmFolder.pinned`. Не названные в `order` (закреплены после перестановки) —
 * сверху в общем порядке, как новый закреп у Telegram; названные — дальше по `order`. Лишние id в `order` не мешают.
 */
export function dmFolderPinnedOrder(pinned: readonly string[], order: readonly string[] | undefined): string[] {
  if (!order || order.length === 0) return pinned.slice();
  const at = new Map<string, number>();
  order.forEach((id, i) => {
    if (!at.has(id)) at.set(id, i);
  });
  const fresh = pinned.filter((id) => !at.has(id));
  const placed = pinned.filter((id) => at.has(id)).sort((a, b) => (at.get(a) as number) - (at.get(b) as number));
  return [...fresh, ...placed];
}

/** Тело `POST /api/dm-folders` и `PUT /api/dm-folders/:id`. */
export interface DmFolderInput {
  title: string;
  emoticon?: string | null;
  flags: number;
  include: string[];
  exclude: string[];
}

/**
 * Подпись системной папки — «Все чаты», как у Telegram (`FilterAllChats`; tdesktop `lng_filters_all`). Папка берёт ВСЕ беседы,
 * и группы тоже (`dmFolderContains`: `f.system` → да), поэтому прежнее «Личные сообщения» вводило в заблуждение (#218, 12.10).
 * Только подпись: в базе и протоколе системная папка по-прежнему `system: 'dms'`.
 */
export const DM_FOLDER_SYSTEM_TITLE = 'Все чаты';

/** Подпись папки для вкладки и меню. */
export function dmFolderTitle(f: Pick<DmFolder, 'system' | 'title'>): string {
  return f.system === 'dms' ? DM_FOLDER_SYSTEM_TITLE : f.title;
}

/** Длина имени в знаках (как видит человек): суррогатные пары — один знак. */
export function dmFolderTitleLength(title: string): number {
  return [...title].length;
}

/** Беседа глазами правила папки. */
export interface DmFolderChat {
  id: string;
  /** Групповая беседа (С4); сейчас все беседы — один на один. */
  group?: boolean;
  /** Уведомления выключены (заглушка действует сейчас). */
  muted: boolean;
  /** Есть новые сообщения или пометка «непрочитано». */
  unread: boolean;
}

/**
 * Попадает ли беседа в папку — правило Telegram (`ChatFilter::contains`): исключённая — никогда; иначе подходит по типу и
 * проходит исключающие флаги (`NoMuted` — не заглушена, `NoRead` — непрочитана) или включена явно. `keep` — беседа,
 * которую человек сейчас читает в этой папке: у Telegram она не исчезает из «Непрочитанных» до ухода
 * (`fakeUnreadWhileOpened`).
 */
export function dmFolderContains(f: DmFolder, c: DmFolderChat, keep = false): boolean {
  if (f.exclude.includes(c.id)) return false;
  // Закреплённая в своём наборе папки (`pinset1`) — в папке, как включённая явно (Telegram: `pinned_peers` входят в `always`).
  if (dmFolderOwnPins(f)?.includes(c.id)) return true;
  // Системная «Личные сообщения» — это «Все чаты» Telegram (08.10): и группы тоже, хотя в базе у неё флаг «личные».
  if (f.system) return true;
  const type = c.group ? DM_FOLDER_GROUPS : DM_FOLDER_PERSONAL;
  const byType =
    (f.flags & type) !== 0 &&
    (!(f.flags & DM_FOLDER_NO_MUTED) || !c.muted) &&
    (!(f.flags & DM_FOLDER_NO_READ) || c.unread || keep);
  return byType || f.include.includes(c.id);
}

/**
 * Можно ли «Убрать из папки» эту беседу — `CanRemoveFromChatFilter`: беседа в папке, и папка после этого не опустеет по
 * правилам (есть тип или ещё хоть одна явно включённая). Системную не трогаем.
 */
export function dmFolderCanRemove(f: DmFolder, c: DmFolderChat): boolean {
  if (f.system) return false;
  return (f.include.length > 1 || (f.flags & DM_FOLDER_TYPES) !== 0) && dmFolderContains(f, c);
}

/**
 * «Добавить в папку» / «Убрать из папки» — `ChangedFilter`: добавление снимает исключение и, если правила беседу всё равно
 * не берут, включает её явно; удаление снимает явное включение и, если правила её держат, исключает явно.
 */
export function dmFolderToggled(f: DmFolder, c: DmFolderChat, add: boolean): DmFolder {
  let include = f.include.filter((x) => x !== c.id);
  let exclude = f.exclude.filter((x) => x !== c.id);
  // «Убрать из папки» снимает и закреп в ней (`pinset1`; Telegram убирает чат и из `pinned_peers`) — дальше решают правила.
  const base: DmFolder = { ...f, include, exclude };
  if (!add && f.pinned && dmFolderOwnPins(f)) base.pinned = f.pinned.filter((x) => x !== c.id);
  if (dmFolderContains(base, c) === add) return base;
  if (add) include = [...include, c.id];
  else exclude = [...exclude, c.id];
  return { ...base, include, exclude };
}

export type DmFolderInputError = 'title_empty' | 'title_long' | 'no_rule' | 'too_many_chats' | 'emoticon';

/**
 * Проверка папки перед записью (сервер и редактор): имя не пустое и не длиннее 12 знаков; хоть одно правило — тип или
 * включённая беседа (`lng_filters_empty` «Выберите хотя бы один чат для этой папки»); не больше 100 включённых и 100
 * исключённых.
 */
export function dmFolderInputError(input: DmFolderInput): DmFolderInputError | null {
  const title = input.title.trim();
  if (!title) return 'title_empty';
  if (dmFolderTitleLength(title) > DM_FOLDER_TITLE_MAX) return 'title_long';
  if (input.emoticon != null && (input.emoticon.length === 0 || input.emoticon.length > DM_FOLDER_EMOTICON_MAX)) return 'emoticon';
  if (input.include.length > DM_FOLDER_CHATS_MAX || input.exclude.length > DM_FOLDER_CHATS_MAX) return 'too_many_chats';
  if ((input.flags & DM_FOLDER_TYPES) === 0 && input.include.length === 0) return 'no_rule';
  return null;
}

/** Текст ошибки для человека (сервер отдаёт его в `error`, редактор показывает под полем). */
export function dmFolderInputErrorText(e: DmFolderInputError): string {
  switch (e) {
    case 'title_empty':
      return 'Введите название папки';
    case 'title_long':
      return `Название папки — не длиннее ${DM_FOLDER_TITLE_MAX} знаков`;
    case 'no_rule':
      return 'Выберите хотя бы одну беседу для этой папки';
    case 'too_many_chats':
      return `В папке может быть не больше ${DM_FOLDER_CHATS_MAX} бесед`;
    case 'emoticon':
      return 'Значок папки не подходит';
  }
}

/** Значок по умолчанию (`ComputeDefaultFilterIcon`): только «Личные» — человек, только непрочитанные — письмо, иначе папка. */
export function dmFolderDefaultIcon(f: Pick<DmFolder, 'system' | 'flags' | 'include' | 'exclude'>): 'user' | 'mail' | 'bell' | 'folder' {
  if (f.system === 'dms') return 'user';
  if (f.include.length > 0 || f.exclude.length > 0 || (f.flags & DM_FOLDER_TYPES) === 0) return 'folder';
  const removed = f.flags & (DM_FOLDER_NO_READ | DM_FOLDER_NO_MUTED);
  if (removed === DM_FOLDER_NO_READ) return 'mail';
  if (removed === DM_FOLDER_NO_MUTED) return 'bell';
  return 'user';
}

/** Новый порядок — перестановка ровно тех же id; иначе `null` (клиент перечитает список). */
export function reorderDmFolders(have: readonly string[], ids: readonly string[]): string[] | null {
  if (ids.length !== have.length || new Set(ids).size !== ids.length) return null;
  return ids.every((x) => have.includes(x)) ? [...ids] : null;
}

/** Нормализация ввода: имя без краевых пробелов, известные флаги, без повторов и без беседы сразу в обоих списках. */
export function normalizeDmFolderInput(input: DmFolderInput): DmFolderInput {
  const exclude = [...new Set(input.exclude)];
  const include = [...new Set(input.include)].filter((x) => !exclude.includes(x));
  return {
    title: input.title.trim(),
    emoticon: input.emoticon ? input.emoticon : null,
    flags: input.flags & DM_FOLDER_FLAGS_KNOWN,
    include,
    exclude,
  };
}
