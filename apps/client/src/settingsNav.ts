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

export type SectionKey = 'sound' | 'notif' | 'look' | 'data' | 'folders' | 'account' | 'privacy' | 'federation' | 'apps';

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
  /** Только на телефоне (свайп по строке беседы — `chatSwipe.ts`, G42): на ПК жеста нет, и настройка ничего не делала бы. */
  mobileOnly?: boolean;
  /** Только там, где на инстансе включена федерация («Где я гость»). */
  fedOnly?: boolean;
  /**
   * Только там, где у приложения есть свой реестр инстансов — десктоп и Android (`multiInstanceEnabled`).
   * В вебе инстанс один: адрес страницы и есть инстанс, добавлять и переключать нечего.
   */
  multiOnly?: boolean;
  /**
   * Только супер-админу инстанса: служебные переключатели (ЛС этап 2 — «Новые ЛС»: откат на одном устройстве). В поиск
   * такие группы не заносятся.
   */
  adminOnly?: boolean;
  /** Только там, где сервер умеет папки бесед ЛС (`folders1`, G40) и включены новые ЛС. */
  foldersOnly?: boolean;
  /**
   * Везде, КРОМЕ самого Android-приложения (приёмка 0.9.0): инструкция «как поставить GusVoice на Android» внутри
   * установленного приложения не к месту.
   */
  notAndroidApp?: boolean;
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
      { id: 'set-g-stream', label: 'Качество трансляции', notMobile: true },
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
      { id: 'set-g-notify-popup', label: 'Всплывающие окна', desktopOnly: true },
      { id: 'set-g-notify-view', label: 'Имя и текст в уведомлениях' },
      { id: 'set-g-notify-dm', label: 'Личные сообщения' },
      { id: 'set-g-notify-groups', label: 'Уведомления из групп' },
      { id: 'set-g-notify-exceptions', label: 'Исключения' },
      { id: 'set-g-notify-repeat', label: 'Повторять уведомления' },
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
      { id: 'set-g-listview', label: 'Вид списка бесед' },
      { id: 'set-g-lite', label: 'Оптимизированный режим' },
      { id: 'set-g-avatars', label: 'Аватары' },
      { id: 'set-g-links', label: 'Ссылки' },
      { id: 'set-g-send', label: 'Отправка сообщений', notMobile: true },
      { id: 'set-g-emoji', label: 'Подсказки эмодзи' },
      { id: 'set-g-dblclick', label: 'Двойной клик по сообщению' },
      { id: 'set-g-swipe', label: 'Свайп по чату', mobileOnly: true },
      { id: 'set-g-overlay', label: 'Оверлей поверх игр', desktopOnly: true },
    ],
  },
  {
    // «Данные и память» (G32, как у Telegram): автозагрузка медиа, автовоспроизведение, место на устройстве.
    key: 'data',
    label: 'Данные и память',
    sub: 'Автозагрузка медиа и место на устройстве',
    icon: 'archive',
    groups: [
      { id: 'set-g-autodl', label: 'Автозагрузка медиа' },
      { id: 'set-g-autoplay', label: 'Автовоспроизведение' },
      { id: 'set-g-dllist', label: 'Загрузки' },
      { id: 'set-g-storage', label: 'Использование памяти' },
    ],
  },
  {
    // Папки бесед ЛС (07.10, #211, G40): у Telegram — свой раздел настроек «Папки» (`lng_filters_title`).
    key: 'folders',
    label: 'Папки',
    sub: 'Папки бесед в личных сообщениях',
    icon: 'folder',
    groups: [{ id: 'set-g-folders', label: 'Мои папки', foldersOnly: true }],
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
    ],
  },
  /**
   * «Конфиденциальность» — отдельный раздел сразу после аккаунта (приёмка 0.9.0), как «Конфиденциальность» у Telegram Android
   * (`TA/ui/SettingsActivity.java` — пункт `SettingsPrivacySecurity` третьим в списке, после аккаунта и чатов). Раньше эти
   * группы жили в конце «Аккаунта и безопасности», и «Кто может мне писать» там не находили.
   */
  {
    key: 'privacy',
    label: 'Конфиденциальность',
    sub: 'Кто может писать, звонить и видеть время захода',
    icon: 'shield',
    groups: [
      { id: 'set-g-messages', label: 'Кто может мне писать' },
      { id: 'set-g-lastseen', label: 'Время захода' },
      { id: 'set-g-calls', label: 'Звонки' },
      // «Заблокированные» — как у Telegram, в «Конфиденциальности» (R230 D.2; раньше жили в конце «Аккаунта»).
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
      { id: 'set-g-windows', label: 'Приложение для Windows', notMobile: true },
      { id: 'set-g-android', label: 'GusVoice на Android', notAndroidApp: true },
      { id: 'set-g-push', label: 'Пуш-уведомления' },
    ],
  },
];

/**
 * Подзаголовок раздела. На телефоне у «Приложений» нет слова «Десктоп»: приложения для компьютера там не настраиваются
 * (разделы `desktopOnly` скрыты), и подпись обещала бы то, чего на экране нет (#218).
 */
export function sectionSub(section: Pick<SettingsSection, 'key' | 'sub'>, phoneUi: boolean): string | undefined {
  if (phoneUi && section.key === 'apps') return 'Android и обновления';
  return section.sub;
}

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
  { id: 'set-g-notify-view', title: 'Что показывать в уведомлениях', section: 'notif', group: 'Имя и текст', keywords: 'имя отправителя текст сообщения превью скрыть приватность пуш телефон тост новое сообщение' },
  { id: 'set-g-notify-dm', title: 'Личные сообщения', section: 'notif', group: 'Личные', keywords: 'личные беседы лс уведомления выключить пуш телефон тишина' },
  { id: 'set-g-notify-exceptions', title: 'Исключения', section: 'notif', group: 'Исключения', keywords: 'исключения беседы отключённые заглушённые без звука выключенные включить сбросить' },
  { id: 'set-g-notify-repeat', title: 'Повторять уведомления', section: 'notif', group: 'Повтор', keywords: 'повтор напоминание непрочитанное каждые минут час никогда телефон' },
  { id: 'set-g-notify-groups', title: 'Уведомления из групп', section: 'notif', group: 'Группы', keywords: 'группы групповые беседы пуш телефон выключить' },
  { id: 'set-g-notify-popup', title: 'Всплывающие окна уведомлений', section: 'notif', group: 'Всплывающие окна', keywords: 'windows уведомления системные тост окно угол экран положение количество монитор ответить поверх игры' },
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
  { id: 'set-g-listview', title: 'Вид списка бесед: две или три строки', section: 'look', group: 'Вид списка бесед', keywords: 'список бесед чатов две три строки строка вид компактный превью аватары узкая колонка' },
  { id: 'set-g-lite', title: 'Оптимизированный режим', section: 'look', group: 'Производительность', keywords: 'оптимизация слабый компьютер лагает тормозит нагрузка процессор анимация игра fps' },
  { id: 'set-g-avatars', title: 'Анимированные аватары', section: 'look', group: 'Аватары', keywords: 'аватар гиф анимация' },
  { id: 'set-g-links', title: 'Превью ссылок', section: 'look', group: 'Ссылки', keywords: 'ссылка превью картинка предпросмотр' },
  { id: 'set-g-send', title: 'Отправка по Enter или Ctrl+Enter', section: 'look', group: 'Отправка сообщений', keywords: 'enter ctrl отправить отправка перенос строки клавиша' },
  { id: 'set-g-emoji', title: 'Подсказывать эмодзи при наборе', section: 'look', group: 'Подсказки эмодзи', keywords: 'эмодзи смайлик подсказка подсказывать автозамена слово двоеточие клавиатура набор' },
  { id: 'set-g-dblclick', title: 'Двойной клик по сообщению: реакция, ответ или ничего; быстрая реакция', section: 'look', group: 'Двойной клик по сообщению', keywords: 'двойной клик тап реакция ответ быстрая реакция лайк эмодзи сообщение' },
  { id: 'set-g-swipe', title: 'Свайп по чату: что делает свайп влево по беседе', section: 'look', group: 'Свайп по чату', keywords: 'свайп смахнуть строка беседа чат архив закрепить прочитано без звука удалить папка жест телефон' },
  { id: 'set-g-autodl', title: 'Автозагрузка медиа', section: 'data', group: 'Автозагрузка', keywords: 'автозагрузка скачивать загрузка фото видео gif трафик экономия размер предел мб данные' },
  { id: 'set-g-autoplay', title: 'Автовоспроизведение GIF и видео', section: 'data', group: 'Автовоспроизведение', keywords: 'автовоспроизведение автоплей gif гиф видео видеосообщения кружки кружок играть само' },
  { id: 'set-g-dllist', title: 'Загрузки — скачанные файлы', section: 'data', group: 'Загрузки', keywords: 'загрузки скачанные файлы скачать отменить открыть список' },
  { id: 'set-g-storage', title: 'Использование памяти и очистка кэша', section: 'data', group: 'Память', keywords: 'кэш кеш память хранилище место очистить удалить данные диск' },
  { id: 'set-g-overlay', title: 'Оверлей поверх игр', section: 'look', group: 'Оверлей', keywords: 'оверлей поверх игра кто говорит' },
  { id: 'set-g-profile', title: 'Имя и аватар', section: 'account', group: 'Профиль', keywords: 'профиль имя аватар ник' },
  { id: 'set-g-game', title: 'Игровая активность', section: 'account', group: 'Игры', keywords: 'играет статус игра steam' },
  { id: 'set-g-email', title: 'Почта', section: 'account', group: 'Email', keywords: 'почта email адрес' },
  { id: 'set-g-password', title: 'Смена пароля', section: 'account', group: 'Пароль', keywords: 'пароль сменить' },
  { id: 'set-g-sessions', title: 'Сессии и выход везде', section: 'account', group: 'Сессии', keywords: 'сессия выйти устройства вход' },
  { id: 'set-g-2fa', title: 'Двухфакторная аутентификация', section: 'account', group: '2FA', keywords: '2fa двухфакторная код totp резервные' },
  { id: 'set-g-folders', title: 'Папки бесед', section: 'folders', group: 'Мои папки', keywords: 'папка папки вкладки беседы личные сообщения лс непрочитанные' },
  { id: 'set-g-lastseen', title: 'Время захода', section: 'privacy', group: 'Время захода', keywords: 'был в сети была последний заход онлайн приватность конфиденциальность видимость время прочтения прочитано скрыть никто все собеседники' },
  { id: 'set-g-calls', title: 'Кто может звонить', section: 'privacy', group: 'Звонки', keywords: 'звонки звонок позвонить кто может мне звонить приватность конфиденциальность никто все собеседники' },
  { id: 'set-g-calls-exceptions', title: 'Исключения звонков', section: 'privacy', group: 'Звонки', keywords: 'всегда разрешать никогда не разрешать исключения звонки звонить' },
  { id: 'set-g-messages', title: 'Кто может мне писать', section: 'privacy', group: 'Сообщения', keywords: 'сообщения писать кто может мне писать приватность конфиденциальность все мои контакты незнакомцы' },
  { id: 'set-g-messages-exceptions', title: 'Исключения сообщений', section: 'privacy', group: 'Сообщения', keywords: 'всегда разрешать исключения сообщения писать' },
  { id: 'set-g-lastseen-exceptions', title: 'Исключения времени захода', section: 'privacy', group: 'Время захода', keywords: 'всегда показывать никогда не показывать исключения время захода был в сети скрыть от человека' },
  { id: 'set-g-blocked', title: 'Заблокированные', section: 'privacy', group: 'Чёрный список', keywords: 'заблокировать блокировка чёрный черный список игнор личные сообщения лс разблокировать конфиденциальность приватность' },
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
  superAdmin?: boolean;
  folders?: boolean;
}): SettingsSection[] {
  return SECTIONS.filter((s) => !s.fedOnly || opts.federation)
    .map((s) => ({
      ...s,
      groups: s.groups.filter(
        (g) =>
          (!g.desktopOnly || opts.desktop) &&
          !(g.notMobile && opts.mobile) &&
          !(g.mobileOnly && !opts.mobile) &&
          (!g.fedOnly || opts.federation) &&
          (!g.multiOnly || !!opts.multi) &&
          (!g.adminOnly || !!opts.superAdmin) &&
          (!g.foldersOnly || !!opts.folders),
      ),
    }))
    .filter((s) => s.groups.length > 0);
}

/**
 * Внутри самого Android-приложения (`isAndroid()`) — без групп `notAndroidApp`; раздел, оставшийся без групп, пропадает.
 * Отдельно от `visibleSections`, поверх его результата: поиск (`searchSettings`) берёт тот же список и в скрытую группу не ведёт.
 */
export function withoutInAppGroups(sections: SettingsSection[], androidApp: boolean): SettingsSection[] {
  if (!androidApp) return sections;
  return sections
    .map((s) => ({ ...s, groups: s.groups.filter((g) => !g.notAndroidApp) }))
    .filter((s) => s.groups.length > 0);
}

/** Где запущен клиент — для строки версии внизу списка настроек. */
export type AppPlatform = 'android' | 'desktop' | 'web';

/**
 * Строка версии внизу списка разделов настроек (приёмка 0.9.0: «версии приложения нигде не видно»). Как подпись под списком
 * настроек Telegram Android — «Telegram для Android v12.x (…)» (`TA/ui/SettingsActivity.java` `getVersionName`, `versionView`:
 * 14 dp, серый, по центру). Версия — `tauri.conf.json` установленного приложения (`appVersion`), у веба номера нет:
 * собранный веб-клиент своей версии не знает, и выдумывать её нельзя.
 */
export function appVersionLabel(platform: AppPlatform, version: string | null): string {
  const name = platform === 'android' ? 'GusVoice для Android' : platform === 'desktop' ? 'GusVoice для ПК' : 'GusVoice для веба';
  const v = version?.trim().replace(/^v/, '');
  return v ? `${name} ${v}` : name;
}
