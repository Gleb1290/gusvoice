/**
 * Системная «назад» на Android (#157).
 *
 * 🔴 **Повод — прогон на живом телефоне 19.09.** «Назад» в приложении не навигировала ВООБЩЕ: из
 * канала, из настроек, из списка разделов — любой жест назад выбрасывал на рабочий стол. На Android
 * это основной способ вернуться, и приложение без него ощущается чужим.
 *
 * Как устроено: нативная сторона перехватывает жест и зовёт `window.__gvBack()`. Решение принимает
 * КЛИЕНТ — он один знает, что сейчас открыто; если закрывать нечего, он сам просит оболочку свернуть
 * приложение (`GusVoiceNative.exitApp()`). Так нативному коду не нужно ничего знать про экраны, а
 * асинхронность `evaluateJavascript` перестаёт мешать: ответ не нужен.
 *
 * ⚠️ Порядок — от самого верхнего слоя к самому нижнему, как человек их открывал. Ошибка в порядке
 * означала бы, что «назад» закрывает окно ПОД открытым листом.
 */

import { isAndroid, isTauri } from './hotkeys';
import { useStore } from './store';

type Native = { exitApp?: () => void };
function native(): Native | null {
  return (window as unknown as { GusVoiceNative?: Native }).GusVoiceNative ?? null;
}

/**
 * Есть ли сверху слой, который закрывается клавишей Esc (лист снизу, контекстное меню, окно
 * подтверждения, выбор эмодзи).
 *
 * ⚠️ Спрашиваем РАЗМЕТКУ, а не стор: таких слоёв много, они живут в разных компонентах со своим
 * состоянием, и единого флага на них нет. Зато все они уже умеют закрываться по Esc — этим и
 * пользуемся, вместо того чтобы заводить реестр, который разойдётся с жизнью на первом же новом листе.
 */
function topLayer(): boolean {
  return !!document.querySelector(TOP_LAYERS);
}

/**
 * Слои, которые «назад» закрывает первыми.
 *
 * 🔴 Б7 (#212, 28.09): просмотр картинки (`.lightbox`) и выбор эмодзи/наклеек (`.emoji-backdrop`) сюда не
 * входили, хотя комментарий выше обещал «выбор эмодзи». «Назад» уводила ленту в список, а просмотрщик —
 * портал в `body` — оставался висеть поверх списка. Заодно звуковая панель и выбор статуса: тоже
 * закрываются по Esc и тоже висели.
 * 🔴 Приёмка 14.10 (D2): карта на весь экран (`.geo-full`, портал `GeoMapFull`) — «назад» закрывала беседу под ней, а не карту.
 * ⚠️ `.modal-overlay` НЕ добавлять: им же закрываются настройки, и Esc закрыл бы окно целиком, минуя шаг
 * «из раздела к списку разделов» (перехватчики ниже) — эту ошибку уже чинили.
 */
export const TOP_LAYERS = '.sheet, .ctx-menu, .confirm-overlay, .dd-pop, .lightbox, .emoji-backdrop, .sb-pop, .status-pop, .geo-full';

/**
 * Есть ли над окном `el` слой из `TOP_LAYERS` (лист выбора, меню, подтверждение…), который должен
 * забрать Esc/«назад» первым.
 *
 * 🔴 C1 (эмулятор, 08.10): «назад» поверх настроек с открытым листом «Повторять уведомления» закрывала и
 * лист, и все настройки — `stepBack` шлёт Esc на window, и окно (`useDialogChrome`) ловит его наравне с
 * листом. Один Esc — один слой: окно молчит, пока над ним есть чужой слой. Слои-ПРЕДКИ окна не в счёт
 * (окно, живущее внутри `.sheet`, само и есть этот слой).
 */
export function layerAbove(el: Element | null): boolean {
  for (const l of Array.from(document.querySelectorAll(TOP_LAYERS))) {
    if (el && l.contains(el)) continue;
    return true;
  }
  return false;
}

/**
 * Перехватчики «назад» от компонентов — стек, последний зарегистрированный спрашивается первым.
 *
 * 🔴 **Зачем они нужны.** Порядок ниже знает про ОКНА, но не про экраны ВНУТРИ них. На телефоне
 * настройки и админка устроены как список разделов → экран раздела, и это состояние живёт в самом
 * компоненте. Без перехватчика «назад» из раздела закрывала окно целиком: человек, зашедший в
 * «Устройства и звук», одним жестом терял и раздел, и настройки разом. Поймано на живом телефоне.
 *
 * ⚠️ Стек, а не один обработчик: окон с внутренними экранами больше одного, и открыты они могут быть
 * одновременно (настройки поверх админки). Спрашиваем сверху вниз — как человек их открывал.
 */
const handlers: (() => boolean)[] = [];
/** «Сработает ли перехватчик» без действия (для предиктивной анимации); у кого нет — считается, что сработает. */
const peeks = new Map<() => boolean, () => boolean>();

/**
 * `peek` — необязательный вопрос «заберёшь ли ты эту „назад“?» БЕЗ действия. Нужен перехватчикам, которые иногда отвечают
 * `false` (пропускают шаг): без него предиктивная «назад» (`backLeavesPane`) считает, что шаг заберут, и экран за пальцем не ведёт.
 */
export function pushBackHandler(fn: () => boolean, peek?: () => boolean): () => void {
  handlers.push(fn);
  if (peek) peeks.set(fn, peek);
  return () => {
    const i = handlers.indexOf(fn);
    if (i >= 0) handlers.splice(i, 1);
    peeks.delete(fn);
  };
}

/**
 * Следующая «назад» уведёт экран беседы к списку — и только это (ни слоя сверху, ни перехватчика, ни окна)? Тогда, и только
 * тогда, системный жест Android 14+ ведёт экран за пальцем (G16, анимация); меню, листы, правка, выбор закрываются без анимации,
 * как у Telegram (`ActionBarLayout.onBackStarted`: `onBackPressed(false)`, `hasShownSheet`). Порядок — тот же, что в `stepBack`.
 */
export function backLeavesPane(): boolean {
  if (topLayer()) return false;
  for (let i = handlers.length - 1; i >= 0; i--) {
    const peek = peeks.get(handlers[i]!);
    if (!peek || peek()) return false;
  }
  const s = useStore.getState();
  if (s.adminOpen || s.settingsOpen || s.mobileProfileOpen || s.mobileMembersOpen) return false;
  return s.mobilePane === 'content';
}

/** Фаза системного жеста «назад» Android 14+, как её шлёт оболочка. */
export type BackGesturePhase = 'start' | 'progress' | 'cancel' | 'invoked';
/**
 * Приёмник жеста — экран беседы (`useSwipeBack`). На `invoked` отвечает `true`, если жест вёл он: тогда он доводит уход и зовёт
 * `done` (тот же шаг `stepBack`), иначе `stepBack` идёт сразу.
 */
export type BackGestureSink = (
  phase: BackGesturePhase,
  progress: number,
  edge: number,
  y: number,
  done?: () => void,
) => boolean;
let sink: BackGestureSink | null = null;

/** Повесить приёмник жеста (один; `null` — снять, только свой). Возвращает снятие. */
export function setBackGestureSink(fn: BackGestureSink): () => void {
  sink = fn;
  return () => {
    if (sink === fn) sink = null;
  };
}

/** Один шаг назад. `true` — было что закрыть. */
export function stepBack(): boolean {
  if (topLayer()) {
    /* 🔴 callbar D1 (08.10): Esc — ОДИН раз, на `document`; всплывая, он доходит и до слушателей `window`. Второй Esc прямо
       на `window` слушатели окна получали ДВАЖДЫ: первый закрывал слой, второй — то, что под ним (ленту → список), то есть
       одна «назад» делала два шага. */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  }

  // Экран внутри окна (раздел настроек, раздел админки) — ДО самих окон: «назад» обязана сначала
  // вернуть к списку, а уже потом закрыть окно.
  for (let i = handlers.length - 1; i >= 0; i--) {
    if (handlers[i]!()) return true;
  }

  const s = useStore.getState();
  // Окна поверх всего.
  if (s.adminOpen) {
    s.setAdminOpen(false);
    return true;
  }
  if (s.settingsOpen) {
    s.setSettingsOpen(false);
    return true;
  }
  // Корневая вкладка «Профиль» → «Сообщения» (список), а не прошлая вкладка (приёмка 0.9.0). Как Telegram Android:
  // «назад» не на стартовой вкладке листает к стартовой («Чаты»), на ней — выход (`MainTabsActivity.onBackPressed`,
  // `TA/ui/MainTabsActivity.java` — `getStartPosition()` = `POSITION_CHATS`). Тот же переход, что у нажатия вкладки в `MobileNav`.
  if (s.mobileProfileOpen) {
    s.setMobileProfileOpen(false);
    toChatsTab(s);
    return true;
  }
  // Панель участников поверх канала.
  if (s.mobileMembersOpen) {
    s.setMobileMembersOpen(false);
    return true;
  }
  // Экран канала → список каналов (то самое list→detail).
  if (s.mobilePane === 'content') {
    s.setMobilePane('list');
    return true;
  }
  // Список каналов сервера → список серверов (#218, вкладка «Серверы» на телефоне: тот же шаг, что «Назад» в шапке каналов).
  if (s.view === 'server' && s.currentServerId && !s.serverListOpen) {
    s.setServerListOpen(true);
    return true;
  }
  // Корень вкладки «Серверы» (список серверов) → «Сообщения», как «Профиль» выше (R230 D.1, решение владельца — как Telegram:
  // с любой корневой вкладки, кроме стартовой, «назад» ведёт на стартовую; с неё — выход).
  if (s.view === 'server') {
    toChatsTab(s);
    return true;
  }
  return false;
}

/** Переход на вкладку «Сообщения» к списку бесед — как нажатие вкладки в `MobileNav` (вид, подгрузка списка, список). */
function toChatsTab(s: ReturnType<typeof useStore.getState>): void {
  if (s.view !== 'dm') s.setView('dm');
  void s.loadDms();
  s.setMobilePane('list');
}

/**
 * Повесить обработчик. Зовётся один раз на старте; вне Android ничего не делает — там «назад» это
 * жест оболочки, которого нет.
 */
/**
 * Повтор «назад» быстрее этого (мс) — тот же жест, доставленный оболочкой ещё раз, а не второе нажатие человека.
 *
 * 🔴 callbar D1 (приёмка 08.10, телефон владельца): одна системная «назад» на развёрнутом исходящем звонке и свернула звонок,
 * и закрыла беседу. Один вызов `__gvBack` в клиенте — ровно один шаг (стенд Edge и эмулятор Android 15/16: шаг один), значит,
 * на устройстве жест дошёл дважды (в оболочке два обработчика «назад»: свой в `MainActivity` и wry). Человек дважды за
 * 250 мс «назад» не нажимает — второй вызов в этом окне глушим.
 */
export const BACK_REPEAT_MS = 250;

/** Вызов «назад» через `ms` после предыдущего — повтор того же жеста (глушить)? */
export function isBackRepeat(ms: number): boolean {
  return ms >= 0 && ms < BACK_REPEAT_MS;
}

export function installAndroidBack(): void {
  if (!isAndroid()) return;
  let last = Number.NEGATIVE_INFINITY;
  // Экран беседы доводит уход после предиктивного жеста — «назад» в эти 380 мс глушим, иначе шаг сделался бы дважды.
  let committing = false;
  const step = () => {
    // 🔴 Если закрывать нечего — сворачиваем, а НЕ закрываем: голос переживает сворачивание (служба
    // переднего плана), и человек, вышедший «назад» из списка каналов, не должен вылетать из разговора.
    if (!stepBack()) native()?.exitApp?.();
  };
  const w = window as unknown as {
    __gvBack?: () => void;
    __gvBackGesture?: (phase: BackGesturePhase, progress: number, edge: number, y: number) => void;
  };
  w.__gvBack = () => {
    if (committing) return;
    const now = performance.now();
    if (isBackRepeat(now - last)) return;
    last = now;
    const led = sink?.('invoked', 1, 0, 0, () => {
      committing = false;
      step();
    });
    if (led) committing = true;
    else step();
  };
  // Ход системного жеста Android 14+ (оболочка: `MainActivity.handleOnBack*`). Отпускание приходит в `__gvBack`.
  w.__gvBackGesture = (phase, progress, edge, y) => {
    if (committing || phase === 'invoked') return;
    sink?.(phase, Number(progress) || 0, Number(edge) || 0, Number(y) || 0);
  };
}

/** Метка записи-стража в `history.state` (запасной путь `installBrowserBack` — браузер без `CloseWatcher`). */
const BACK_GUARD_KEY = 'gvBackGuard';

/**
 * Заберёт ли `stepBack` следующую «назад» — тот же порядок, что в `stepBack`, но БЕЗ действия. Перехватчик без `peek` считаем
 * забирающим (ошибка в эту сторону стоит одной проглоченной «назад» на корне, её ловит `installBrowserBack`).
 */
export function canStepBack(): boolean {
  if (topLayer()) return true;
  for (let i = handlers.length - 1; i >= 0; i--) {
    const peek = peeks.get(handlers[i]!);
    if (!peek || peek()) return true;
  }
  const s = useStore.getState();
  if (s.adminOpen || s.settingsOpen || s.mobileProfileOpen || s.mobileMembersOpen) return true;
  if (s.mobilePane === 'content') return true;
  return s.view === 'server';
}

/** `CloseWatcher` (Chrome 120+): системная «назад» Android и Esc закрывают его вместо шага по истории. В lib.dom TS 5.9 его нет. */
type CloseWatcherLike = { destroy(): void; onclose: ((ev: Event) => void) | null };
type CloseWatcherCtor = new () => CloseWatcherLike;

/**
 * Системная «назад» во вкладке браузера телефона (29.10). У приложения её ловит оболочка (`__gvBack` выше), а у вкладки
 * Chrome «назад» — это шаг по истории: история у клиента одна запись, и любой жест «назад» — из канала, из настроек,
 * из открытого листа — уводил с сайта (а голос рвался).
 *
 * 🔴 Приёмка 29.10 (S20, Chrome): первая версия держала над записью истории запись-страж и после шага клала её заново в
 * `popstate`. Это добавление БЕЗ действия человека, и Chrome (history manipulation intervention, `NavigationControllerImpl`:
 * запись, с которой страница без жеста добавила новую, помечается «пропускаемой на назад/вперёд») на второй «назад» подряд
 * перескакивал и стража, и исходную запись — вкладка, открытая извне, закрывалась целиком.
 *
 * Как устроено теперь: основной путь — `CloseWatcher` (HTML, «close requests»; Chrome 120+, на Android «назад» — это запрос
 * закрытия, он достаётся последнему наблюдателю раньше истории). Один наблюдатель без действия человека разрешён всегда
 * (`allowed number of groups` = 1), а закрытый «назад» освобождает место — так держится сколько угодно «назад» подряд без
 * касаний. Наблюдатель стоит, только пока `canStepBack()`: на корне его нет, и «назад» уходит с сайта/сворачивает Chrome
 * обычным путём. Наличие пересчитывается по стору, касаниям, клавишам и порталам в `body`.
 * Esc на ПК тоже закрывает наблюдатель — тогда шаг НЕ делаем: Esc слои ловят сами (`stepBack` и так шлёт Esc).
 *
 * Запасной путь (браузер без `CloseWatcher`): запись-страж по касанию (`pointerdown` — с действием человека), `popstate` →
 * `stepBack`; заново страж кладёт только следующее касание, не `popstate`.
 *
 * Только телефонная раскладка браузера (окно ≤ 760 px, граница `PHONE_LAYOUT_QUERY` из `phoneLayout.ts`): на ПК «назад»
 * браузера остаётся обычной; в оболочках Tauri истории нет.
 */
export function installBrowserBack(): void {
  if (isTauri() || typeof window === 'undefined' || typeof history === 'undefined' || typeof history.pushState !== 'function') return;
  const CW = (window as unknown as { CloseWatcher?: CloseWatcherCtor }).CloseWatcher;
  if (typeof CW === 'function') {
    installCloseWatcherBack(CW);
    return;
  }
  let leaving = false;
  const armed = () => (history.state as Record<string, unknown> | null)?.[BACK_GUARD_KEY] === true;
  const arm = () => {
    if (leaving || armed() || !phoneWidth()) return;
    const state = history.state && typeof history.state === 'object' ? (history.state as Record<string, unknown>) : {};
    history.pushState({ ...state, [BACK_GUARD_KEY]: true }, '');
  };
  window.addEventListener('pointerdown', arm, { capture: true, passive: true });
  window.addEventListener('popstate', () => {
    // «Вперёд» на стража — не наш шаг.
    if (armed() || !phoneWidth()) return;
    // Стража НЕ кладём заново здесь: без действия человека Chrome пометит запись пропускаемой (см. выше).
    if (stepBack()) return;
    leaving = true;
    // Прошлой записи нет (вкладка открыта сразу на клиенте) — `back()` ничего не делает; через секунду страж снова можно класть.
    window.setTimeout(() => {
      leaving = false;
    }, 1000);
    history.back();
  });
}

/** Основной путь `installBrowserBack`: один `CloseWatcher`, пока есть что закрыть. */
function installCloseWatcherBack(CW: CloseWatcherCtor): void {
  let watcher: CloseWatcherLike | null = null;
  let lastEsc = Number.NEGATIVE_INFINITY;
  // «Назад» пришла, а шагать оказалось некуда (перехватчик без `peek` отказался) — не ставим наблюдатель до касания/клавиши,
  // иначе он проглатывал бы каждую «назад» на корне.
  let stuck = false;
  let pending = false;
  const drop = () => {
    const w = watcher;
    watcher = null;
    if (w) {
      w.onclose = null;
      w.destroy();
    }
  };
  const onClose = () => {
    watcher = null;
    // Esc (клавиатура) тоже запрос закрытия: его слои уже поймали сами — шага нет, наблюдатель вернём.
    if (performance.now() - lastEsc < 300 || !phoneWidth()) {
      schedule();
      return;
    }
    if (stepBack()) {
      schedule();
      return;
    }
    stuck = true;
    history.back();
  };
  const sync = () => {
    pending = false;
    const want = !stuck && phoneWidth() && canStepBack();
    if (want && !watcher) {
      try {
        const w = new CW();
        w.onclose = onClose;
        watcher = w;
      } catch {
        watcher = null;
      }
    } else if (!want && watcher) drop();
  };
  // Пересчёт — после того, как обработчики касания/стора дорисовали слой (лист, меню открываются в том же такте или следующем).
  const schedule = () => {
    if (pending) return;
    pending = true;
    window.setTimeout(sync, 0);
  };
  const touched = () => {
    stuck = false;
    schedule();
  };
  window.addEventListener('pointerdown', touched, { capture: true, passive: true });
  window.addEventListener('pointerup', schedule, { capture: true, passive: true });
  window.addEventListener('click', schedule, { capture: true, passive: true });
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.isTrusted && e.key === 'Escape') lastEsc = performance.now();
      else if (e.isTrusted) stuck = false;
    },
    { capture: true },
  );
  window.addEventListener('keyup', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('popstate', schedule);
  useStore.subscribe(schedule);
  // Листы, меню, просмотрщик — порталы прямо в `body` (только дети `body`, без поддерева: лента не будит пересчёт).
  if (typeof MutationObserver === 'function' && document.body) new MutationObserver(schedule).observe(document.body, { childList: true });
  schedule();
}

/** Окно в раскладке телефона (≤ 760 px, `PHONE_LAYOUT_QUERY` в `phoneLayout.ts`). */
function phoneWidth(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches;
}
