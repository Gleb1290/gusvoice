import { callServiceText, convMediaPreview, maskNotice, notifyShowsName, notifyShowsText, parseConvMedia, stripFormatting, type ConvCallService, type NotifyView } from '@gusvoice/shared';
import type { CoinNotifyLevel } from './coinNotifyRules';
import { messageAttachmentLabel } from './dmRowRules';
import { isDesktop, isTauri } from './hotkeys';
import type { OsNotifyLevel } from './notifyRules';

// OS-level notifications: the web Notification API in browsers, the Tauri notification plugin
// in the desktop app (rides the NEXT release tag — older .exe builds silently skip). Fired only
// for events that already passed the sound/DND gates in sockets.ts, and only while the window
// is unfocused — the in-app UI covers the focused case. Enabled per-browser via `gv_os_notify`.

const KEY = 'gv_os_notify';
// Читаем оба ключа: коммит 15a0f755 (28.09) по ошибке переименовал KEY в `gv_notify_clickable` (имя Tauri-команды).
// Выбор до 28.09 лежит в `gv_os_notify`, после — в ошибочном ключе, и он свежее: его переносим в KEY и удаляем.
const MISTAKEN_KEY = 'gv_notify_clickable';

function isOsNotifyLevel(v: string | null): v is OsNotifyLevel {
  return v === 'off' || v === 'mentions' || v === 'all';
}

/** Заводской уровень — «упоминания и ЛС» (см. пояснение ниже). */
export const OS_NOTIFY_DEFAULT: OsNotifyLevel = 'mentions';

/**
 * Уровень системных уведомлений (#77). Раньше это был булев тумблер, и «включено» означало
 * «упоминания и ЛС» — обычные сообщения канала не уведомляли вообще.
 *
 * ⚠️ Ключ хранилища ТОТ ЖЕ: у кого стояло `'1'`, читается как `'mentions'` — то есть настройка
 * человека не сбрасывается и поведение у него не меняется, пока он сам не выберет «все».
 */
export function osNotifyLevel(): OsNotifyLevel {
  try {
    const fresh = localStorage.getItem(MISTAKEN_KEY);
    if (isOsNotifyLevel(fresh)) {
      try {
        // Сначала пишем в настоящий ключ и только потом удаляем ошибочный: сбой записи не должен стоить выбора.
        localStorage.setItem(KEY, fresh);
        localStorage.removeItem(MISTAKEN_KEY);
      } catch {
        /* перенос не вышел — выбор всё равно отдаём, ошибочный ключ останется и перенесётся при следующем чтении */
      }
      return fresh;
    }
    const raw = localStorage.getItem(KEY);
    if (isOsNotifyLevel(raw)) return raw;
  } catch {
    /* localStorage может бросать (хранилище запрещено) — тогда умолчание */
  }
  // Ключа нет — человек НИКОГДА не открывал эту настройку. Раньше это значило «выключено», и
  // получалось, что уведомлений нет ни у кого, кто про настройку не знал: фича есть, а мессенджер
  // молчит, и выглядит это сломанной фичей, а не выбором. Умолчание — «упоминания и ЛС»:
  // так ведёт себя любой мессенджер, и оно не спамит. «Все сообщения» и «выключить» — в настройках.
  return OS_NOTIFY_DEFAULT;
}

export function setOsNotifyLevel(level: OsNotifyLevel): void {
  try {
    localStorage.setItem(KEY, level);
    // Ошибочный ключ при чтении главнее: оставить его — старый выбор перебил бы только что сделанный.
    localStorage.removeItem(MISTAKEN_KEY);
  } catch {
    /* localStorage может бросать — выбор просто не сохранится */
  }
}

const COIN_KEY = 'gv_coin_notify';

/** Заводской уровень монетных уведомлений — «когда типают/щипают меня». */
export const COIN_NOTIFY_DEFAULT: CoinNotifyLevel = 'mine';

/**
 * Уровень уведомлений про монеты — СВОЙ, независимый от уведомлений о сообщениях (запрос
 * 04.09). Умолчание «когда типают/щипают меня»: адресное событие редкое и его пропуск обиден, а
 * чужую ленту человек включает сам, если хочет.
 */
export function coinNotifyLevel(): CoinNotifyLevel {
  const raw = localStorage.getItem(COIN_KEY);
  if (raw === 'off' || raw === 'mine' || raw === 'all') return raw;
  return COIN_NOTIFY_DEFAULT;
}

export function setCoinNotifyLevel(level: CoinNotifyLevel): void {
  localStorage.setItem(COIN_KEY, level);
}

export function osNotifyEnabled(): boolean {
  return osNotifyLevel() !== 'off';
}

/**
 * Разрешение у ОС спрашивали только при ручном включении тумблера. С умолчанием «упоминания и ЛС»
 * его больше некому спросить — делаем это на старте ДЕСКТОПА (там диалога либо нет, либо он один
 * раз). В браузере молчим: незапрошенный `Notification.requestPermission()` без жеста пользователя
 * браузеры и режут, и штрафуют — там разрешение по-прежнему спрашивает сама настройка.
 */
export function ensureNotifyPermission(): void {
  if (!isTauri() || osNotifyLevel() === 'off') return;
  void requestNotifyPermission().catch(() => {});
}

export type NotifyPermission = 'granted' | 'denied' | 'unsupported';

/**
 * Текущее разрешение БЕЗ запроса — чтобы настройки могли честно показать состояние.
 *
 * 🔴 Раньше состояние нигде не показывалось, и отказ системы выглядел как сломанные кнопки: человек
 * жмёт «когда меня», выбор молча откатывается на «выключены», и кажется, что кнопка не нажимается
 * (замечание 04.09). Показать «разрешение не дано» и дать кнопку — половина решения; вторая
 * половина в том, чтобы выбор ПРИ ЭТОМ СОХРАНЯЛСЯ.
 * ⚠️ В Tauri ответ асинхронный, в браузере — синхронный; наружу отдаём одинаково.
 */
export async function notifyPermissionState(): Promise<NotifyPermission> {
  if (isTauri()) {
    try {
      const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
      return (await isPermissionGranted()) ? 'granted' : 'denied';
    } catch {
      return 'unsupported';
    }
  }
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  // 'default' — ещё не спрашивали: для интерфейса это «не дано», но запрос ещё возможен.
  return 'denied';
}

/** Ask the platform for permission (called when the settings toggle flips on). */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (isTauri()) {
    try {
      const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
      if (await isPermissionGranted()) return 'granted';
      return (await requestPermission()) === 'granted' ? 'granted' : 'denied';
    } catch {
      return 'unsupported'; // pre-notification desktop build — the plugin isn't in this .exe yet
    }
  }
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return (await Notification.requestPermission()) === 'granted' ? 'granted' : 'denied';
}

/**
 * True while the user is actually looking at the app — then we stay silent.
 * Экспортируется, чтобы решение «уведомлять или нет» целиком считалось чистым `notifyRules.ts`,
 * а не разъезжалось между вызывающим и этим модулем.
 */
export function windowFocused(): boolean {
  return document.hasFocus() && document.visibilityState === 'visible';
}

/**
 * Show an OS notification if enabled + permitted + the window is unfocused (`force` skips the
 * focus gate — used by the settings "Проверить" button). `onClick` (web only) runs after the
 * window is focused — e.g. open the mentioning channel. Never throws into the message path.
 * `opts.silent` — ЛС «без звука» (С3, `dmListRules.dmSilentDecision`): уведомление показывается, но браузер не играет
 * звук системы (`Notification` с `silent: true`). Тост десктопа беззвучен и так (`os_notify.rs`: `notify-rust` без
 * звука), а у плагина на Android флага нет — там звук задаёт канал (правка APK — своей порцией).
 */
export function osNotify(
  title: string,
  body: string,
  onClick?: () => void,
  force = false,
  opts: { silent?: boolean; group?: string; conv?: string; groupChat?: boolean; dmChat?: boolean; popup?: PopupInfo } = {},
): void {
  if (!osNotifyEnabled() || (!force && windowFocused())) return;
  // «Уведомления из групп» выключены (G38, `push2`) — сообщение группы без всплывашки (звук и счётчик решают свои правила).
  // Исключение «Уведомления включены» этой беседы (решение владельца 38, `push4`) пускает всплывашку и при выключенных.
  if (!notifyAlwaysProbe(opts.group ?? opts.conv)) {
    if (opts.groupChat && !notifyPrefs.groups) return;
    // «Личные сообщения» выключены (G38, `push3`) — личная беседа 1:1 без всплывашки.
    if (opts.dmChat && !notifyPrefs.dm) return;
  }
  // «Показывать имя / текст» (G38): как у Telegram, без текста нет и ответа из тоста (`hideReplyButton`/`hideMarkAsRead`).
  const n = maskNotice(notifyPrefs.view, { title, body });
  const conv = notifyShowsText(notifyPrefs.view) ? opts.conv : undefined;
  // Своё окно ПК (G38, ND-07): имя чата, автор и аватар — только если имя не скрыто (иначе — как у тоста, «GusVoice»).
  // 🔴 Находка Codex R223: проверка `n.title === title` пропускала имя и аватар при «Ничего не показывать», если заголовок уже был
  // «GusVoice» (маска его не меняла) — решает настройка, а не сравнение строк.
  const named = opts.popup && notifyShowsName(notifyPrefs.view) ? opts.popup : undefined;
  // Превью карточки (вид + подпись, `popupPreview` ниже) — только при показе текста; скрыт — строка маски, как у тоста.
  const popup = named?.preview && !notifyShowsText(notifyPrefs.view) ? { ...named, preview: undefined } : named;
  deliver(n.title, n.body, onClick, opts.silent === true, opts.group, conv, popup);
}

/** Что своему окну уведомлений ПК (G38, ND-07) нужно сверх заголовка и текста: имя чата, автор в группе, аватар. */
export interface PopupInfo {
  title: string;
  author?: string;
  avatar?: string | null;
  /** Превью для карточки: вид вложения отдельно от подписи (`popupPreview` ниже, как Telegram Desktop); нет — строка тоста. */
  preview?: PopupPreview;
}

/**
 * Свои всплывающие окна уведомлений на ПК (G38, ND-07, как у Telegram Desktop). Приёмник ставит `notifyPopupHost.ts`
 * (только десктоп, из `App.tsx`); нет приёмника (веб, Android, тесты) — всё как было. `show` вернул `false` — включены
 * системные уведомления, идём прежним путём; `fallback` — окно не ответило (сборка без него), показать системный тост.
 */
export interface PopupSink {
  show(d: {
    tag: string;
    title: string;
    author?: string;
    body: string;
    /** Вид вложения перед текстом («Фото», «📊 вопрос») — своё окно выделяет его (`popupPreview`). */
    kind?: string;
    avatar: string | null;
    conv?: string;
    group?: string;
    fallback: () => void;
  }): boolean;
  clear(group: string): void;
}
let popupSink: PopupSink | null = null;
export function setNotifyPopupSink(sink: PopupSink | null): void {
  popupSink = sink;
}

/**
 * Настройки уведомлений из профиля (08.10, #211, G38, `push2`): «Показывать имя / текст» и «Уведомления из групп».
 * Живут на сервере (синхронно между устройствами); сюда их кладёт `sockets.ts` из профиля в сторе — модуль стор не читает.
 * Нет признака `push2` / профиля — умолчание: всё видно, группы звенят (как было).
 */
const notifyPrefs: { view: NotifyView; groups: boolean; dm: boolean } = { view: 'all', groups: true, dm: true };
export function setNotifyPrefs(p: { view: NotifyView; groups: boolean; dm?: boolean }): void {
  notifyPrefs.view = p.view;
  notifyPrefs.groups = p.groups;
  notifyPrefs.dm = p.dm !== false;
}

/**
 * Исключение «Уведомления включены» (08.10, решение владельца 38, `push4`): есть ли оно у беседы с этим id. Модуль стор не
 * читает — проверку ставит `store.ts` (по `pushAlwaysTargets` и списку бесед); до неё — исключений нет (как было).
 */
let notifyAlwaysProbe: (convId: string | undefined) => boolean = () => false;
export function setNotifyAlwaysProbe(probe: (convId: string | undefined) => boolean): void {
  notifyAlwaysProbe = probe;
}

/**
 * Что делать с ответом из тоста беседы десктопа (Р1, G17): «Ответить» — текст в беседу, «Прочитано» — пометить. Ставит
 * `sockets.ts` (там стор); здесь только маршрутизация события `gv://notify-action`.
 */
export interface ConvNotifyActions {
  reply(convId: string, text: string): void;
  read(convId: string): void;
}
let convActions: ConvNotifyActions | null = null;
export function setConvNotifyActions(a: ConvNotifyActions): void {
  convActions = a;
}

/** Группа уведомлений канала сервера (ЛС и группы живут под своим id беседы — ключи не пересекаются). */
export function channelNoticeGroup(channelId: string): string {
  return `ch:${channelId}`;
}

/** Автозакрытие всплывашки браузера, мс (как у tweb: `uiNotificationsManager.ts`, 8000, не на телефонах). */
export const WEB_NOTICE_AUTOCLOSE_MS = 8000;

/**
 * Опции `new Notification` для беседы (как у tweb, `push.ts`: тег беседы — новое сообщение ЗАМЕНЯЕТ прежнее, а не
 * копится стопкой). Без беседы — прежние опции. `renotify` НЕ ставим (решение владельца 09.10, как tweb: повторное сообщение
 * того же чата молча обновляет плашку, без второго звука; звук первого уже был).
 */
export function webNoticeOptions(body: string, silent: boolean, group?: string): NotificationOptions {
  const o: NotificationOptions = silent ? { body, silent: true } : { body };
  if (group) o.tag = `conv:${group}`;
  return o;
}

/** Телефонный браузер (не Tauri): там автозакрытие не ставим, как tweb (`!IS_MOBILE`). */
function phoneBrowser(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

/** Показанные уведомления браузера по группе (беседе) — `clearOsNotifications` убирает их, когда беседу дочитали. */
const shownByGroup = new Map<string, Notification[]>();

/**
 * Беседа дочитана (G09, как у Telegram: прочтение чистит уведомления беседы) — закрыть её уведомления браузера. Тосты
 * десктопа и уведомления Android по одному снять пока нечем (плагин и `gv_notify_clickable` их не отдают) — остаются.
 */
export function clearOsNotifications(group: string): void {
  // Свои окна ПК (G38): карточки прочитанной беседы уходят сразу, как `unlinkHistory` у Telegram Desktop.
  popupSink?.clear(group);
  const list = shownByGroup.get(group);
  if (!list) return;
  shownByGroup.delete(group);
  for (const n of list) {
    try {
      n.close();
    } catch {
      /* уже закрыто */
    }
  }
}

/**
 * Показать всплывашку БЕЗ гейтов этого модуля — решение принято снаружи.
 *
 * ⚠️ Нужен монетам: их гейт свой (`coinNotifyRules`), и проверка `osNotifyEnabled()` тут означала
 * бы, что выключивший уведомления о сообщениях молча теряет и уведомления о монетах, хотя это
 * разные настройки. Фокус и «не беспокоить» вызывающий обязан проверить сам.
 */
export function osNotifyRaw(title: string, body: string, onClick?: () => void): void {
  deliver(title, body, onClick);
}

type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
type TauriEvent = {
  listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
};
function tauriGlobal(): { core?: TauriCore; event?: TauriEvent } | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore; event?: TauriEvent } }).__TAURI__ ?? null;
}

/**
 * Клик по системному тосту в десктопе (#212, Б11).
 *
 * 🔴 Плагин уведомлений на десктопе клик не отдаёт, поэтому `onClick` в Tauri раньше просто
 * игнорировался: клик по уведомлению ЛС поднимал окно, но не открывал беседу. Теперь тост с
 * `onClick` показывает своя команда `gv_notify_clickable` (`os_notify.rs`) и на клик шлёт
 * `gv://notify-click` с меткой; метка → обработчик. Держим последние 50 — тосты старше давно ушли.
 */
const clickHandlers = new Map<string, () => void>();
let clickSeq = 0;
let clickListening = false;
function listenNotifyClicks(ev: TauriEvent): void {
  if (clickListening) return;
  clickListening = true;
  void ev.listen('gv://notify-click', (e) => {
    const tag = typeof e.payload === 'string' ? e.payload : '';
    const fn = clickHandlers.get(tag);
    clickHandlers.delete(tag);
    fn?.();
  });
}

/**
 * Тост беседы (Р1, G17, `notify_conv.rs`): клик по телу — как у кликабельного, «Ответить» и «Прочитано» — без окна.
 * Слушатель заводится при первом тосте беседы, а не вместе с кликабельным: остальным тостам он не нужен.
 */
let actionListening = false;
function listenNotifyActions(ev: TauriEvent): void {
  if (actionListening) return;
  actionListening = true;
  void ev.listen('gv://notify-action', (e) => {
    const p = (e.payload ?? {}) as { tag?: unknown; group?: unknown; action?: unknown; text?: unknown };
    const tag = typeof p.tag === 'string' ? p.tag : '';
    const conv = typeof p.group === 'string' ? p.group : '';
    const text = typeof p.text === 'string' ? p.text.trim() : '';
    const fn = clickHandlers.get(tag);
    clickHandlers.delete(tag);
    if (p.action === 'reply') {
      if (conv && text) convActions?.reply(conv, text);
    } else if (p.action === 'read') {
      if (conv) convActions?.read(conv);
    } else {
      fn?.();
    }
  });
}

function deliver(
  title: string,
  body: string,
  onClick?: () => void,
  silent = false,
  group?: string,
  conv?: string,
  popup?: PopupInfo | null,
): void {
  if (isTauri()) {
    const t = tauriGlobal();
    // Свои окна ПК (G38, ND-07): карточку рисует окно `notify`, действия приходят тем же `gv://notify-action`, что у тоста
    // беседы (`open` → обработчик клика по метке, `reply` → ответ). `popup === null` — путь отката, только системный тост.
    if (popup !== null && popupSink && isDesktop() && t?.event) {
      const tag = `n${++clickSeq}`;
      if (onClick) clickHandlers.set(tag, onClick);
      if (clickHandlers.size > 50) clickHandlers.delete(clickHandlers.keys().next().value as string);
      listenNotifyActions(t.event);
      const shown = popupSink.show({
        tag,
        title: popup?.title ?? title,
        author: popup?.author,
        body: popup?.preview ? popup.preview.text : body,
        ...(popup?.preview?.kind ? { kind: popup.preview.kind } : {}),
        avatar: popup?.avatar ?? null,
        conv,
        group,
        fallback: () => {
          clickHandlers.delete(tag);
          deliver(title, body, onClick, silent, group, conv, null);
        },
      });
      if (shown) return;
      clickHandlers.delete(tag);
    }
    if (onClick && isDesktop() && t?.core && t.event) {
      listenNotifyClicks(t.event);
      const core = t.core;
      const tag = `n${++clickSeq}`;
      clickHandlers.set(tag, onClick);
      if (clickHandlers.size > 50) clickHandlers.delete(clickHandlers.keys().next().value as string);
      const clickable = () =>
        core.invoke('gv_notify_clickable', { title, body, tag }).catch(() => {
          // Сборка без команды — показываем тостом плагина, как раньше (без клика).
          clickHandlers.delete(tag);
          deliverViaPlugin(title, body);
        });
      // Беседа (Р1, G17): тост с полем ответа и «Прочитано»; сборка без команды — кликабельный, как раньше.
      if (conv) listenNotifyActions(t.event);
      if (conv) void core.invoke('gv_notify_conversation', { title, body, tag, group: conv }).catch(clickable);
      else void clickable();
      return;
    }
    deliverViaPlugin(title, body);
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    // «Без звука» (С3): показать, но без звука системы. У обычного опций прежние — ничего не меняем.
    // Без беседы — прежние опции (без тега); с беседой — тег, замена и автозакрытие (`webNoticeOptions`).
    const n = group
      ? new Notification(title, webNoticeOptions(body, silent, group))
      : new Notification(title, silent ? { body, silent: true } : { body });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
    if (group) {
      const list = shownByGroup.get(group) ?? [];
      // Тег беседы: браузер сам заменил прежнее уведомление новым, прежний объект больше не живёт.
      shownByGroup.set(group, [...list.slice(-9), n]);
      // Автозакрытие, как у tweb (`uiNotificationsManager.ts`): 8 с, на телефонных браузерах не закрываем.
      if (!phoneBrowser()) {
        setTimeout(() => {
          try {
            n.close();
          } catch {
            /* уже закрыто */
          }
          const cur = shownByGroup.get(group);
          if (cur) {
            const rest = cur.filter((x) => x !== n);
            if (rest.length) shownByGroup.set(group, rest);
            else shownByGroup.delete(group);
          }
        }, WEB_NOTICE_AUTOCLOSE_MS);
      }
    }
  } catch {
    /* some WebViews throw on construction — never break the message path */
  }
}

function deliverViaPlugin(title: string, body: string): void {
  void (async () => {
    try {
      const { isPermissionGranted, sendNotification } = await import('@tauri-apps/plugin-notification');
      if (await isPermissionGranted()) sendNotification({ title, body });
    } catch {
      /* plugin absent in this build — skip */
    }
  })();
}

/** «Имя» for a message author DTO (display name over the handle). */
export function authorName(m: { author: { username: string; displayName?: string | null } }): string {
  return m.author.displayName || m.author.username;
}

/**
 * Short notification body for a message: trimmed text or the attachments in words. Без текста (05.10) — те же слова,
 * что в превью строки списка бесед (`dmRowRules.messageAttachmentLabel`): «Фото», «Видео», «Голосовое сообщение»,
 * имя файла, «Стикер» — вместо прежнего «📎 Вложение» (сервер пишет так же текст пуша, `pushRules.contentPreview`).
 */
export function messagePreview(m: {
  content: string;
  attachments?: readonly unknown[] | null;
  sticker?: unknown;
  media?: unknown;
}): string {
  // Геопозиция / контакт (G69): «Геопозиция» / «Контакт: Имя», как пуш сервера, а не запасная фраза со ссылкой.
  const media = m.media ? parseConvMedia(m.media) : null;
  if (media) return convMediaPreview(media);
  // Без маркеров формата (G51) — как пуш сервера (`pushRules.contentPreview`).
  const text = m.content ? stripFormatting(m.content).trim() : '';
  if (text) return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  return messageAttachmentLabel(m) ?? 'Новое сообщение';
}

/**
 * Текст карточки своего окна уведомлений ПК (G38, ND-07) — как у Telegram Desktop. Карточка рисует превью сообщения тем же
 * правилом, что список чатов (`Notification::updateNotifyDisplay` → `HistoryItem::toPreview`): вид вложения в начале
 * строки выделен (`WithCaptionNotificationText` в `data/data_media_types.cpp`: «Фото» без подписи, «Фото, подпись» — с ней,
 * `lng_dialogs_text_media_wrapped` = «{media},»), опрос — «📊 вопрос» (`MediaPoll::notificationText`), звонок — подпись
 * записи глазами получателя. Слова вида — наши, те же, что в строке списка и пуше (`messageAttachmentLabel`,
 * `convMediaPreview`), чтобы одно и то же сообщение не называлось в двух местах по-разному. Системный тост берёт строку
 * целиком (`messagePreview` выше) — здесь только своё окно.
 */
/** Превью для карточки: `kind` — вид вложения (выделяется, перед текстом через запятую), `text` — подпись или текст. */
export interface PopupPreview {
  kind?: string;
  text: string;
}

/** Хватает на две строки карточки с запасом; дальше многоточие ставит вёрстка (`.nfp-body`, две строки, как у Telegram). */
export const POPUP_TEXT_MAX = 300;

function popupClip(s: string): string {
  return s.length > POPUP_TEXT_MAX ? `${s.slice(0, POPUP_TEXT_MAX)}…` : s;
}

/**
 * Превью сообщения для карточки. Поля — как у сообщения ЛС/канала (`content`, `attachments`, `sticker`, `media`,
 * `service`); незнакомый вид (`media`/`service`) — как сообщения без него (правило 11): обычный текст.
 */
export function popupPreview(m: {
  content: string;
  attachments?: readonly unknown[] | null;
  sticker?: unknown;
  media?: unknown;
  service?: unknown;
}): PopupPreview {
  const text = m.content ? popupClip(stripFormatting(m.content).replace(/\s+/g, ' ').trim()) : '';
  // Запись о звонке (`calls1`): автор — звонивший, читатель уведомления — принимающий («Пропущенный звонок»).
  const svc = m.service as { kind?: unknown; reason?: unknown; duration?: unknown; video?: unknown } | null | undefined;
  if (svc && typeof svc === 'object' && svc.kind === 'call' && typeof svc.reason === 'string') {
    const duration = typeof svc.duration === 'number' && Number.isFinite(svc.duration) ? svc.duration : 0;
    return { kind: callServiceText({ reason: svc.reason as ConvCallService['reason'], duration, video: svc.video === true }, false), text: '' };
  }
  const media = m.media ? parseConvMedia(m.media) : null;
  if (media) {
    // Опрос/викторина — «📊 вопрос» (Telegram `MediaPoll::notificationText`), вопрос выделен.
    if (media.kind === 'poll') return { kind: `📊 ${media.question}`, text: '' };
    // Геопозиция, трансляция геопозиции, контакт — вид целиком, подписи у них нет (запасная фраза `content` — для старых).
    return { kind: convMediaPreview(media), text: '' };
  }
  const label = messageAttachmentLabel(m);
  if (label) return { kind: label, text };
  return { text: text || 'Новое сообщение' };
}
