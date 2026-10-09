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

import { isAndroid } from './hotkeys';
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
 * ⚠️ `.modal-overlay` НЕ добавлять: им же закрываются настройки, и Esc закрыл бы окно целиком, минуя шаг
 * «из раздела к списку разделов» (перехватчики ниже) — эту ошибку уже чинили.
 */
export const TOP_LAYERS = '.sheet, .ctx-menu, .confirm-overlay, .dd-pop, .lightbox, .emoji-backdrop, .sb-pop, .status-pop';

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
  if (s.mobileProfileOpen) {
    s.setMobileProfileOpen(false);
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
  return false;
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
