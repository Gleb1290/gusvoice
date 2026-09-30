/**
 * Карта настроек (#153, дизайн round 9) — чистая, без React и DOM.
 *
 * 🔴 **Повод — слова владельца:** «чтоб найти настройку плашки для уведомлений о типах, надо изрядно
 * напрягать зрение». Причин ровно две, и обе здесь чинятся:
 *
 * 1. **Настройка лежала не там, где её ищут.** Плашка «кто кого типнул» и оверлей поверх игр жили
 *    во вкладке «Аудио и видео» — потому что их туда положили при появлении, а не потому, что там
 *    их станут искать. Разделы ниже собраны по смыслу, а не по истории.
 * 2. **Девять вкладок в строку и до тридцати одинаково серых подписей внутри.** Раздел теперь
 *    знает свои группы, и они видны в рельсе как якоря — оглавление вместо сплошной ленты.
 *
 * Здесь же — реестр для поиска: он перечисляет то, что люди ищут словами, и знает, в какую строку
 * прокрутить. ⚠️ Поиск ходит по ЭТОМУ реестру, а не по разметке, поэтому новая настройка в него не
 * попадёт сама — её надо сюда дописать. Это осознанный размен: зато поиск знает слова, которых в
 * подписи нет («типы», «поук», «шумодав»).
 */

import type { IconName } from './components/Icon';

export type SectionKey = 'sound' | 'notif' | 'look' | 'account' | 'federation' | 'apps';

export interface SettingsGroup {
  /** id узла в разметке, к которому прокручиваем. */
  id: string;
  label: string;
  /** Группа есть не всегда: оверлей и звук-тест живут только в десктопной оболочке. */
  desktopOnly?: boolean;
  /**
   * Есть везде, КРОМЕ телефона. Не то же самое, что `desktopOnly`: ширину боковой панели тянут и в
   * браузере на компьютере, а на телефоне панель полноэкранная и тянуть нечего.
   *
   * ⚠️ Нужно не только рельсу: по этому же признаку считается «изменено N из M», и без него
   * счётчик на телефоне обещал бы настройку, которой там нет.
   */
  notMobile?: boolean;
  /** Только там, где на инстансе включена федерация («Где я гость»). */
  fedOnly?: boolean;
  /**
   * Только там, где у приложения есть свой реестр инстансов — десктоп и Android (`multiInstanceEnabled`).
   * В вебе инстанс один: адрес страницы и есть инстанс, добавлять и переключать нечего.
   */
  multiOnly?: boolean;
}

export interface SettingsSection {
  key: SectionKey;
  label: string;
  /** Одна строка под заголовком раздела: что здесь вообще лежит. */
  sub: string;
  icon: IconName;
  groups: SettingsGroup[];
  /** Раздел целиком — только там, где федерация включена (сейчас таких нет: см. `visibleSections`). */
  fedOnly?: boolean;
}

export const SECTIONS: SettingsSection[] = [
  {
    key: 'sound',
    label: 'Устройства и звук',
    sub: 'Микрофон, наушники, камера и как вас слышно',
    icon: 'mic',
    groups: [
      { id: 'set-g-devices', label: 'Устройства' },
      { id: 'set-g-mic', label: 'Микрофон и чувствительность' },
      { id: 'set-g-audio-proc', label: 'Обработка звука' },
      { id: 'set-g-ptt', label: 'Режим передачи' },
      { id: 'set-g-hotkeys', label: 'Горячие клавиши', notMobile: true },
      { id: 'set-g-stream', label: 'Качество трансляции' },
      { id: 'set-g-stream-cursor', label: 'Курсор в трансляции', desktopOnly: true },
      { id: 'set-g-native-audio', label: 'Тест захвата звука', desktopOnly: true },
    ],
  },
  {
    key: 'notif',
    label: 'Уведомления',
    sub: 'Что показывать и о чём звенеть',
    icon: 'bell',
    groups: [
      { id: 'set-g-osn', label: 'Системные уведомления' },
      { id: 'set-g-coin', label: 'Уведомления о монетах' },
      { id: 'set-g-poke-toast', label: 'Плашка «кто кого типнул»', desktopOnly: true },
      { id: 'set-g-sounds', label: 'Звуки уведомлений' },
    ],
  },
  {
    key: 'look',
    label: 'Вид',
    sub: 'Тема, масштаб и как выглядит лента',
    icon: 'eye',
    groups: [
      { id: 'set-g-theme', label: 'Тема' },
      { id: 'set-g-scale', label: 'Масштаб интерфейса' },
      { id: 'set-g-sidebar', label: 'Ширина боковой панели', notMobile: true },
      { id: 'set-g-lite', label: 'Оптимизированный режим' },
      { id: 'set-g-avatars', label: 'Аватары' },
      { id: 'set-g-links', label: 'Ссылки' },
      { id: 'set-g-overlay', label: 'Оверлей поверх игр', desktopOnly: true },
    ],
  },
  {
    key: 'account',
    label: 'Аккаунт и безопасность',
    sub: 'Профиль, почта, пароль и вход',
    icon: 'user',
    groups: [
      { id: 'set-g-profile', label: 'Профиль' },
      { id: 'set-g-game', label: 'Игровая активность' },
      { id: 'set-g-email', label: 'Email' },
      { id: 'set-g-password', label: 'Смена пароля' },
      { id: 'set-g-sessions', label: 'Сессии' },
      { id: 'set-g-2fa', label: 'Двухфакторная аутентификация' },
      { id: 'set-g-blocked', label: 'Заблокированные' },
    ],
  },
  {
    key: 'federation',
    label: 'Федерация',
    sub: 'Ваши инстансы и где вы в гостях',
    icon: 'globe',
    /**
     * 🔴 Раздел виден, если в нём есть хоть одна группа (23.09): «Мои инстансы» — бывший переключатель
     * внизу рейла («в рейле он больше не нужен») — не зависит от федерации на инстансе, а «Где я
     * гость» — только при ней. Раньше раздел целиком был `fedOnly`.
     */
    groups: [
      { id: 'set-g-instances', label: 'Мои инстансы', multiOnly: true },
      { id: 'set-g-guest', label: 'Где я гость', fedOnly: true },
    ],
  },
  {
    key: 'apps',
    label: 'Приложения',
    sub: 'Десктоп, Android и обновления',
    icon: 'download',
    groups: [
      { id: 'set-g-close', label: 'При нажатии на крестик', desktopOnly: true },
      { id: 'set-g-downloads', label: 'Загрузки', desktopOnly: true },
      { id: 'set-g-updates', label: 'Обновления', desktopOnly: true },
      { id: 'set-g-windows', label: 'Приложение для Windows' },
      { id: 'set-g-android', label: 'GusVoice на Android' },
      { id: 'set-g-push', label: 'Пуш-уведомления' },
    ],
  },
];

export function sectionOf(key: SectionKey): SettingsSection {
  const s = SECTIONS.find((x) => x.key === key);
  if (!s) throw new Error(`неизвестный раздел настроек: ${key}`);
  return s;
}

/** Одна находимая настройка. `id` — узел, к которому прокручиваем и который подсвечиваем. */
export interface SettingsEntry {
  id: string;
  title: string;
  section: SectionKey;
  /** Подпись группы для пути в результате («Уведомления › Монеты»). */
  group: string;
  /** Слова, которых нет в подписи, но которыми эту настройку ищут. */
  keywords?: string;
}

/**
 * Что умеет находить поиск.
 *
 * ⚠️ Список ручной и неполный по замыслу: сюда попадает то, что ищут словами, а не всё подряд.
 * Первым в нём стоит пример, с которого начался весь раунд: «уведомления о монетах» искали
 * глазами посреди длинной вкладки.
 */
export const SETTINGS_INDEX: SettingsEntry[] = [
  { id: 'set-g-coin', title: 'Уведомления о монетах', section: 'notif', group: 'Монеты', keywords: 'гускоины монеты чаевые типы плашка' },
  { id: 'set-g-poke-toast', title: 'Плашка «кто кого типнул»', section: 'notif', group: 'Плашка', keywords: 'типнуть поук poke тык плашка окно' },
  { id: 'set-g-osn', title: 'Системные уведомления', section: 'notif', group: 'Системные', keywords: 'windows тост уведомление всплывающее' },
  { id: 'set-g-sounds', title: 'Звуки уведомлений', section: 'notif', group: 'Звуки', keywords: 'звук сигнал вход выход бип' },
  { id: 'set-g-devices', title: 'Микрофон, наушники, камера', section: 'sound', group: 'Устройства', keywords: 'устройство микрофон наушники динамики камера' },
  { id: 'set-g-mic', title: 'Чувствительность микрофона', section: 'sound', group: 'Микрофон', keywords: 'порог голоса громкость усиление vad' },
  { id: 'set-g-audio-proc', title: 'Шумоподавление и эхо', section: 'sound', group: 'Обработка звука', keywords: 'шумодав шум эхо автоусиление' },
  { id: 'set-g-ptt', title: 'Режим передачи (рация)', section: 'sound', group: 'Режим передачи', keywords: 'рация push to talk ptt зажать' },
  { id: 'set-g-hotkeys', title: 'Горячие клавиши', section: 'sound', group: 'Горячие клавиши', keywords: 'клавиши хоткей сочетание' },
  { id: 'set-g-stream', title: 'Качество трансляции экрана', section: 'sound', group: 'Трансляция', keywords: 'стрим экран битрейт fps кодек разрешение' },
  { id: 'set-g-stream-cursor', title: 'Курсор в трансляции', section: 'sound', group: 'Трансляция', keywords: 'курсор мышь указатель стрим показ экрана зрители' },
  { id: 'set-g-theme', title: 'Тема оформления', section: 'look', group: 'Тема', keywords: 'светлая тёмная тема цвет' },
  { id: 'set-g-scale', title: 'Масштаб интерфейса', section: 'look', group: 'Масштаб', keywords: 'размер шрифт крупный мелкий зум' },
  { id: 'set-g-sidebar', title: 'Ширина боковой панели', section: 'look', group: 'Панель', keywords: 'сайдбар ширина панель каналов' },
  { id: 'set-g-lite', title: 'Оптимизированный режим', section: 'look', group: 'Производительность', keywords: 'оптимизация слабый компьютер лагает тормозит нагрузка процессор анимация игра fps' },
  { id: 'set-g-avatars', title: 'Анимированные аватары', section: 'look', group: 'Аватары', keywords: 'аватар гиф анимация' },
  { id: 'set-g-links', title: 'Превью ссылок', section: 'look', group: 'Ссылки', keywords: 'ссылка превью картинка предпросмотр' },
  { id: 'set-g-overlay', title: 'Оверлей поверх игр', section: 'look', group: 'Оверлей', keywords: 'оверлей поверх игра кто говорит' },
  { id: 'set-g-profile', title: 'Имя и аватар', section: 'account', group: 'Профиль', keywords: 'профиль имя аватар ник' },
  { id: 'set-g-game', title: 'Игровая активность', section: 'account', group: 'Игры', keywords: 'играет статус игра steam' },
  { id: 'set-g-email', title: 'Почта', section: 'account', group: 'Email', keywords: 'почта email адрес' },
  { id: 'set-g-password', title: 'Смена пароля', section: 'account', group: 'Пароль', keywords: 'пароль сменить' },
  { id: 'set-g-sessions', title: 'Сессии и выход везде', section: 'account', group: 'Сессии', keywords: 'сессия выйти устройства вход' },
  { id: 'set-g-2fa', title: 'Двухфакторная аутентификация', section: 'account', group: '2FA', keywords: '2fa двухфакторная код totp резервные' },
  { id: 'set-g-blocked', title: 'Заблокированные', section: 'account', group: 'Чёрный список', keywords: 'заблокировать блокировка чёрный черный список игнор личные сообщения лс разблокировать' },
  { id: 'set-g-instances', title: 'Мои инстансы', section: 'federation', group: 'Мои инстансы', keywords: 'инстанс сервер аккаунт добавить переключить удалить другой' },
  { id: 'set-g-guest', title: 'Где я гость', section: 'federation', group: 'Гость', keywords: 'гость федерация инстанс чужой' },
  { id: 'set-g-close', title: 'При нажатии на крестик', section: 'apps', group: 'Десктоп', keywords: 'закрыть трей свернуть крестик' },
  { id: 'set-g-downloads', title: 'Папка загрузок', section: 'apps', group: 'Десктоп', keywords: 'загрузки папка скачивание' },
  { id: 'set-g-updates', title: 'Обновления', section: 'apps', group: 'Десктоп', keywords: 'обновление версия апдейт' },
  { id: 'set-g-windows', title: 'Приложение для Windows', section: 'apps', group: 'Windows', keywords: 'windows скачать установить десктоп' },
  { id: 'set-g-android', title: 'GusVoice на Android', section: 'apps', group: 'Android', keywords: 'android апк телефон установить f-droid' },
  { id: 'set-g-push', title: 'Пуш-уведомления', section: 'apps', group: 'Push', keywords: 'пуш ntfy телефон уведомления' },
];

/** `ё` = `е`: человек набирает «еще», а в подписи стоит «ещё» — и поиск молча отвечает пустотой. */
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/ё/g, 'е');
}

/** С какой длины запроса показывать результаты: одна буква совпадает с половиной списка. */
export const SEARCH_MIN = 2;

export interface SettingsHit extends SettingsEntry {
  /** «Уведомления › Монеты» — человеку важно не только что нашли, но и где это лежит. */
  path: string;
}

export function searchSettings(query: string, sections: SettingsSection[] = SECTIONS): SettingsHit[] {
  const q = norm(query);
  if (q.length < SEARCH_MIN) return [];
  const live = new Set(sections.map((s) => s.key));
  // Группа раздела может быть скрыта (в вебе нет «Моих инстансов», без федерации — «Где я гость»):
  // запись поиска, указывающая на такую группу, вела бы в пустоту.
  const knownGroups = new Set(SECTIONS.flatMap((s) => s.groups.map((g) => g.id)));
  const liveGroups = new Set(sections.flatMap((s) => s.groups.map((g) => g.id)));
  return SETTINGS_INDEX.filter((e) => live.has(e.section) && (!knownGroups.has(e.id) || liveGroups.has(e.id)))
    .filter((e) => norm(e.title).includes(q) || (e.keywords != null && norm(e.keywords).includes(q)))
    .map((e) => ({ ...e, path: `${sectionOf(e.section).label} › ${e.group}` }));
}

/**
 * Разделы, которые показываем этому человеку в этой оболочке. Раздел без единой видимой группы не
 * показывается (так «Федерация» пропадает в вебе без федерации). `multi` — реестр инстансов в приложении.
 */
export function visibleSections(opts: {
  federation: boolean;
  desktop: boolean;
  mobile: boolean;
  multi?: boolean;
}): SettingsSection[] {
  return SECTIONS.filter((s) => !s.fedOnly || opts.federation)
    .map((s) => ({
      ...s,
      groups: s.groups.filter(
        (g) =>
          (!g.desktopOnly || opts.desktop) &&
          !(g.notMobile && opts.mobile) &&
          (!g.fedOnly || opts.federation) &&
          (!g.multiOnly || !!opts.multi),
      ),
    }))
    .filter((s) => s.groups.length > 0);
}
