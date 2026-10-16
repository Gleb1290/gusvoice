import { type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BIG_MOVE_SLOP_PX, bigHoldOutcome, bigHoldProgress } from '../bigReaction';
import { useImageViewerOpen } from '../imageViewer';
import {
  clampAxis,
  placeByHalf,
  placeByPoint,
  placeStackByPoint,
  stackCardMaxHeight,
  toLayoutPoint,
  toLayoutRect,
  viewportAboveSafeBottom,
  viewportSafe,
} from '../popover';
import type { DotStatus } from '../status';
import { Icon, type IconName } from './Icon';
import { StatusDot } from './StatusDot';

export type MenuPos = { x: number; y: number };

/** К какому краю якоря прижат блок «полоса + карточка» (раунд 12): `'end'` — к правому, своё сообщение на телефоне. */
export type MenuAlign = 'start' | 'end';

/**
 * Полоса окна, которая остаётся яркой под подложкой (раунд 12, телефон): строка сообщения, поле ввода. Экранные px по
 * вертикали — `top` / `bottom` из `getBoundingClientRect()`, как `pos` и `anchor`; в вёрсточные меню переводит само.
 */
export type MenuSpotlight = { top: number; bottom: number };

type ContextMenuCommonProps = {
  onClose: () => void;
  children: ReactNode;
  width?: number;
  /**
   * Ширина — нижняя граница, а не точный размер: меню растёт под самый длинный пункт (до окна за вычетом полей). Для меню с
   * подписями, которые при крупном системном шрифте (font_scale 1.3) не влезали в `width` в px: «Выключить на врем…».
   */
  fit?: boolean;
  /** Edge-to-edge content (no padding, clipped corners) — for the banner profile card. */
  bare?: boolean;
  /**
   * Полоса быстрых реакций (`<ReactionBar />`, раунд 12) — своей поверхностью НАД карточкой, ставится вместе с ней; клик
   * по ней — не «мимо меню». На телефоне без `anchor` меню, как и прежде, лист — полоса тогда первой строкой листа.
   */
  reactions?: ReactNode;
  /** К какому краю якоря прижать полосу и карточку (раунд 12): `'end'` — своё сообщение на телефоне. По умолчанию `'start'`. */
  align?: MenuAlign;
  /** Приглушить экран двумя половинами подложки, кроме полосы `[top, bottom]` (раунд 12, телефон: строка сообщения). */
  spotlight?: MenuSpotlight;
  /**
   * Выпадающее меню кнопки шапки (10.10, телефон; Telegram Android `ActionBarMenuItem.updateOrShowPopup` +
   * `ActionBarPopupWindow.startAnimation`): только с `anchor` (прямоугольник кнопки). Карточка встаёт верхом на верх кнопки,
   * правым краем к её правому краю (кнопку накрывает, как у Telegram), раскрывается сверху вниз от правого верхнего угла
   * (`.ctx-stack.drop`), пункты проявляются по мере раскрытия — задержку каждому ставит сам блок (`dropStagger`).
   */
  drop?: boolean;
  /**
   * Уровни внутри меню на телефоне (#218, решение владельца 12.10): системная «Назад» (`stepBack` шлёт Esc, слой `.ctx-menu` забирает
   * его первым) ведёт на уровень выше, а не закрывает меню целиком — как подменю `ActionBarPopupWindow` у Telegram Android
   * (`ChatNotificationsPopupWrapper`: «Назад» возвращает основной список). Порядок: пункт с `back` (`MenuItem back`) или `.ctx-back`
   * в открытом уровне — нажимается; иначе `onBack` (меню, где уровень — состояние зовущего); иначе меню закрывается. На ПК Esc
   * закрывает меню целиком, как и прежде.
   */
  onBack?: () => void;
};

/** Ровно одно из двух: `pos` (точка клика) или `anchor` (прямоугольник якоря, раунд 12). */
export type ContextMenuProps = ContextMenuCommonProps &
  (
    | {
        /** Точка клика, экранная (`clientX` / `clientY`). Ровно одно из двух: `pos` или `anchor`. */
        pos: MenuPos;
        /** Прямоугольник якоря — пузырь или кнопка, экранный (`getBoundingClientRect()`). Вместо `pos`. */
        anchor?: never;
      }
    | {
        /** Точка клика, экранная (`clientX` / `clientY`). Ровно одно из двух: `pos` или `anchor`. */
        pos?: never;
        /** Прямоугольник якоря — пузырь или кнопка, экранный (`getBoundingClientRect()`). Вместо `pos`. */
        anchor: DOMRect;
      }
  );

/** Есть ли что рисовать: `false` / `null` / `''` из условного `cond && <X />` — пусто, как и `undefined`. */
const hasContent = (n: ReactNode) => n !== undefined && n !== null && typeof n !== 'boolean' && n !== '';

/**
 * Клавиши, которыми листают (у меню у якоря они — прокрутка человеком, меню закрывается). Тот же набор, что у плавающей
 * даты ленты (`MessagePane.SCROLL_KEYS`).
 */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
/** Палец ушёл дальше этого, px, — это ведение (прокрутка), а не нажатие; тот же порог, что у долгого нажатия в ленте. */
const TOUCH_SLOP = 10;

/**
 * True on a phone-width viewport — context menus become bottom-sheets there (round-7 P7). С якорем (`anchor`, раунд 12)
 * меню и на телефоне не лист: оно встаёт у пузыря.
 */
function useIsMobile(): boolean {
  const [m, setM] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 620px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 620px)');
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

/**
 * Shared right-click menu: a portalled popover anchored at a screen point, clamped to the
 * viewport, dismissed on outside-click / Esc / resize / window blur (on a phone it is a bottom
 * sheet and ignores resize: the soft keyboard fires it). Used for the user, channel, category and
 * message menus (the design-step3 shell). Compose rows with the
 * MenuItem / MenuDivider / MenuSection / MenuHeader primitives below.
 *
 * **Раунд 12 — меню сообщения «как в Telegram»** (`docs/design/design-step12/HANDOFF.md` §3), четыре необязательных
 * пропса: `reactions` — полоса быстрых реакций (`ReactionBar`) над карточкой; `anchor` вместо `pos` — меню у пузыря или
 * кнопки (на телефоне — не лист); `align` — к какому краю якоря прижать; `spotlight` — подложка, кроме полосы строки.
 * С любым из них разметка другая: блок `.ctx-stack` (`.end` при `align="end"`, `.anchored` у якоря) с полосой и обычной
 * карточкой `.ctx-menu` внутри (у якоря — `.ctx-menu.anchored`: на телефоне строки под палец) и две половины подложки
 * `.ctx-spot`. Без них — всё ровно как было, все прежние меню рисуются прежней разметкой.
 *
 * Расстановка: по `pos` — карточка от точки клика, как без полосы, полоса над ней (`placeStackByPoint`); у `anchor` —
 * над якорем или под ним по половине экрана, край — по `align` (`placeByHalf`). У якоря и с подложкой меню закрывает
 * КЛИК мимо, а не нажатие, и этот клик дальше не идёт: иначе он «проваливался» бы в ленту, и тап по пузырю под подложкой
 * тут же открывал бы меню снова. Там же меню закрывает прокрутка ЧЕЛОВЕКОМ за его пределами — колесо, ведение пальцем,
 * клавиши прокрутки (меню оторвалось бы от строки), — и правый клик мимо (иначе рядом открылось бы второе меню).
 * Прокрутка кодом (новое сообщение у низа ленты, догрузка картинки) и смена размера окна (спряталась клавиатура) меню у
 * якоря НЕ закрывают: смена размера ставит блок заново, а за строкой следит вызывающий — передаёт новый `anchor` и
 * `spotlight` (`MessagePane`). ⚠️ Меню у якоря открывают по `click`, а не по `touchend` / `pointerup`: иначе `click`
 * того же касания придёт, когда меню уже слушает, и закроет его.
 *
 * Подвал «когда отправлено» — не пропс, а последний ребёнок карточки:
 * `<div className="ctx-foot" role="none"><span className="ctx-foot-ico">{✓ / ✓✓ — Icon 14, обводка 1.5; или пусто}</span><span>{когда}</span></div>`.
 * На ПК он внизу карточки, у якоря на телефоне — сверху (`order: -1`).
 */
export function ContextMenu({
  pos,
  anchor,
  onClose,
  children,
  width = 224,
  fit = false,
  bare = false,
  reactions,
  align = 'start',
  spotlight,
  drop = false,
  onBack,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const menuWidth: CSSProperties = fit
    ? { minWidth: width, width: 'max-content', maxWidth: 'calc(var(--vw-px, 100vw) - 16px)' }
    : { width };
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  /** У якоря: окно сменило размер — поставить блок заново (меню при этом не закрывается). */
  const [relayout, setRelayout] = useState(0);
  /**
   * Где палец коснулся мимо блока (у якоря и с подложкой): повёл дальше порога — прокрутка человеком. В рефе, а не в
   * эффекте закрытия: тот переподписывается на каждую перерисовку зовущего (новый `onClose`), а прокрутка под пальцем
   * как раз перерисовывает его (меню идёт за строкой) — касание терялось бы посреди жеста.
   */
  const touchFrom = useRef<{ x: number; y: number } | null>(null);
  /** Последний щелчок по самому блоку (у якоря и с подложкой): пока он доставляется, вложенный `.click()` — не «мимо». */
  const itemClick = useRef<Event | null>(null);
  // Лист снизу — только на узком экране и только без якоря.
  const sheet = isMobile && !anchor;
  // Новая разметка — блок «полоса + карточка» и подложка — только с новыми пропсами.
  const stacked = !sheet && (hasContent(reactions) || !!anchor || !!spotlight);
  // Закрывать кликом, а не нажатием, — у пузыря и с подложкой (см. описание выше).
  const tapClose = stacked && (!!anchor || !!spotlight);

  useLayoutEffect(() => {
    if (sheet) return;
    const el = ref.current;
    if (!el) return;
    if (!stacked) {
      if (!pos) return;
      // Размер берём из offsetWidth/Height, а не из getBoundingClientRect: первый в вёрсточных
      // единицах, второй — в экранных, и при масштабе интерфейса ≠ 100% они расходятся на zoom.
      // `pos` пришёл из clientX/clientY события, то есть тоже экранный — переводим.
      // Меню раскрывается в свободный квадрант от курсора; ползти вдоль кромки, накрывая точку
      // клика, — крайний случай, когда не влез ни один. Влезть вообще ему помогает `max-height`
      // у `.ctx-menu`: без него высокое меню участника не помещалось ни в какую позицию.
      const p = toLayoutPoint(pos.x, pos.y);
      // Между строкой состояния и панелью навигации (`viewportSafe`, разведка наплывов 09.10).
      setPlace(placeByPoint(p.x, p.y, el.offsetWidth, el.offsetHeight, 8, viewportSafe()));
      return;
    }
    // Блок: размер — у `.ctx-stack`, место и размер карточки в нём — у самой карточки (offsetParent карточки — блок,
    // у него `position: fixed`). Высота полосы и зазор под ней — из разметки, не константой.
    const card = cardRef.current;
    if (!card) return;
    // Между строкой состояния и панелью навигации (`--gv-sat` / `--gv-sab`), а не между краями окна.
    const vp = viewportSafe();
    /* Карточка не выше доступной области за вычетом полосы реакций над ней (разведка наплывов 09.10, ландшафт 740×360:
       «Изменить»/«Удалить» уходили за низ) — дальше прокрутка внутри карточки. Ставим ДО замера блока: его высота от неё. */
    card.style.maxHeight = `${stackCardMaxHeight(vp, card.offsetTop)}px`;
    if (anchor && drop) {
      const a = toLayoutRect(anchor);
      const vp2 = viewportAboveSafeBottom();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      setPlace({ left: clampAxis(a.right - w, w, vp2.vw, 8, vp2.left ?? 0), top: clampAxis(a.top, h, vp2.vh, 8, vp2.top ?? 0) });
      dropStagger(card);
    } else if (anchor) {
      // `viewportAboveSafeBottom` = `viewportSafe` (и верхняя вставка) — имя прежнее, его держит проверка R114.
      setPlace(placeByHalf(toLayoutRect(anchor), el.offsetWidth, el.offsetHeight, align, 8, 8, viewportAboveSafeBottom()));
    } else if (pos) {
      const p = toLayoutPoint(pos.x, pos.y);
      setPlace(
        placeStackByPoint(p.x, p.y, el.offsetWidth, el.offsetHeight, {
          left: card.offsetLeft,
          top: card.offsetTop,
          w: card.offsetWidth,
          h: card.offsetHeight,
        }, 8, vp),
      );
    }
  }, [pos?.x, pos?.y, anchor?.left, anchor?.top, anchor?.right, anchor?.bottom, align, sheet, stacked, relayout, drop]);

  // Меню у якоря переживает смену размера окна (на телефоне это клавиатура: спряталась от того же тапа) — ставим заново.
  const anchored = !sheet && !!anchor;
  /* И смену своего размера (приёмка S20+, 08.10): «Выключить на время…» меняет вид меню на месте (`DmMuteMenuItems`), список
     сроков выше — а место считалось по прежней высоте, и низ уходил за экран. Не только у якоря (разведка наплывов 09.10):
     карточка профиля (`bare`) дорастает после первого замера (присутствие, баннер) и уходила на 37 px за низ. */
  useEffect(() => {
    const el = ref.current;
    if (!anchored || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setRelayout((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchored]);
  // То же — у меню по точке (не лист, не якорь): карточка профиля.
  useEffect(() => {
    const el = ref.current;
    if (anchored || sheet || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setRelayout((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchored, sheet, stacked]);
  useEffect(() => {
    if (!anchored) return;
    const again = () => setRelayout((n) => n + 1);
    window.addEventListener('resize', again);
    window.visualViewport?.addEventListener('resize', again);
    return () => {
      window.removeEventListener('resize', again);
      window.visualViewport?.removeEventListener('resize', again);
    };
  }, [anchored]);

  /**
   * Просмотрщик картинки открыт (аватар из карточки профиля) — меню замирает.
   *
   * Картинка рисуется НАД меню и порталом в `body`, то есть любой клик по ней формально «мимо
   * меню», а её Esc — тот же Esc, что закрывает меню. Без этой уступки карточка схлопывалась бы от
   * первого же клика по картинке, которую сама и открыла.
   */
  const viewerOpen = useImageViewerOpen();

  useEffect(() => {
    if (viewerOpen) return;
    // «Мимо меню». У блока (`.ctx-stack`) мимо — и его пустое место: полоса и карточка разной ширины, и рядом с
    // меньшей из них остаётся кусок блока, на вид — лента.
    const outside = (t: EventTarget | null) =>
      !!ref.current && (!ref.current.contains(t as Node) || (stacked && t === ref.current));
    const onDown = (e: MouseEvent) => {
      if (!tapClose && outside(e.target)) onClose();
    };
    /* Клавиша листает (у якоря и с подложкой — прокрутка человеком): фокуса нет — браузер листает то, по чему щёлкнули
       последним; фокус в меню или в поле ввода — это не прокрутка, пробел на кнопке её нажимает. */
    const scrollKey = (e: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(e.key) || e.ctrlKey || e.altKey || e.metaKey) return false;
      const t = e.target;
      if (!(t instanceof Element) || t === document.body || t === document.documentElement) return true;
      if (!outside(t) || t.closest('input, textarea, select, [contenteditable]')) return false;
      return !(e.key === ' ' && t.closest('button, a, [role="button"]'));
    };
    /* Шаг на уровень выше (только телефон) — `true`, если сделан и меню закрывать не нужно. */
    const stepOut = () => {
      if (!window.matchMedia('(max-width: 620px)').matches) return false;
      const up = ref.current?.querySelector<HTMLElement>('[data-menu-back], .ctx-back');
      if (up) {
        up.click();
        return true;
      }
      if (!onBack) return false;
      onBack();
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!stepOut()) onClose();
      } else if (tapClose && scrollKey(e)) onClose();
    };
    // У якоря и с подложкой: клик мимо закрывает меню и дальше не идёт — ни в ленту под подложкой, ни в строку.
    /* Кроме щелчка, вложенного в щелчок по пункту (тот ещё не доставлен до конца — `eventPhase`): `.click()` из обработчика
       пункта — скрытое поле выбора файла у скрепки, ссылка скачивания — тоже «мимо меню» (меню ещё стоит), и
       `preventDefault` гасил окно выбора файла / скачивание (08.10). */
    const onTap = (e: MouseEvent) => {
      if (!outside(e.target)) {
        itemClick.current = e;
        return;
      }
      if (itemClick.current && itemClick.current !== e && itemClick.current.eventPhase !== Event.NONE) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    // Правый клик или долгое нажатие мимо — закрыть (нажатие мимо здесь не закрывает), своё меню цель откроет сама.
    const onOtherMenu = (e: MouseEvent) => {
      if (outside(e.target)) onClose();
    };
    /* Прокрутка ЧЕЛОВЕКОМ мимо меню — колесо или палец повёл (дальше порога нажатия): строка уехала бы из-под полосы
       подложки, меню оторвалось бы от своего сообщения. Само событие `scroll` не слушаем: прокрутку кодом (новое
       сообщение у низа, догрузка картинки) от человеческой оно не отличает, а меню из-за неё закрываться не должно. */
    const onWheel = (e: WheelEvent) => {
      if (outside(e.target)) onClose();
    };
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      touchFrom.current = t && e.touches.length === 1 && outside(e.target) ? { x: t.clientX, y: t.clientY } : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      const from = touchFrom.current;
      if (!from || !t) return;
      if (Math.abs(t.clientX - from.x) <= TOUCH_SLOP && Math.abs(t.clientY - from.y) <= TOUCH_SLOP) return;
      touchFrom.current = null;
      onClose();
    };
    const passive = { capture: true, passive: true };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    if (tapClose) {
      window.addEventListener('click', onTap, true);
      window.addEventListener('contextmenu', onOtherMenu, true);
      window.addEventListener('wheel', onWheel, passive);
      window.addEventListener('touchstart', onTouchStart, passive);
      window.addEventListener('touchmove', onTouchMove, passive);
    }
    // A mobile sheet shouldn't dismiss on scroll/resize (the soft keyboard fires those). Меню у якоря — тоже: его
    // смена размера ставит заново (эффект выше).
    if (!isMobile) {
      if (!anchored) window.addEventListener('resize', onClose);
      window.addEventListener('blur', onClose);
    }
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onTap, true);
      window.removeEventListener('contextmenu', onOtherMenu, true);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('touchstart', onTouchStart, true);
      window.removeEventListener('touchmove', onTouchMove, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose, onBack, isMobile, viewerOpen, stacked, tapClose, anchored]);

  // Phone: a bottom-sheet sliding up over a scrim (taps outside close it).
  if (sheet) {
    return createPortal(
      <div className="ctx-sheet-backdrop" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
        <div
          ref={ref}
          className={`ctx-menu sheet${bare ? ' bare' : ''}`}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {!bare && <div className="ctx-grabber" />}
          {reactions}
          {children}
        </div>
      </div>,
      document.body,
    );
  }

  if (!stacked) {
    return createPortal(
      <div
        ref={ref}
        className={`ctx-menu${bare ? ' bare' : ''}`}
        role="menu"
        style={{ left: place?.left ?? pos?.x, top: place?.top ?? pos?.y, ...menuWidth, visibility: place ? 'visible' : 'hidden' }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {children}
      </div>,
      document.body,
    );
  }

  // Раунд 12: подложка половинами (строка между ними яркая) и блок «полоса + карточка». Полоса — экранная, как `pos` и
  // `anchor`; CSS ждёт вёрсточные.
  const spot = spotlight ? { top: toLayoutPoint(0, spotlight.top).y, bottom: toLayoutPoint(0, spotlight.bottom).y } : null;
  const noNativeMenu = (e: { preventDefault: () => void }) => e.preventDefault();
  return createPortal(
    <>
      {spot && (
        <>
          <div className="ctx-spot top" style={{ height: spot.top }} aria-hidden="true" onContextMenu={noNativeMenu} />
          <div className="ctx-spot bottom" style={{ top: spot.bottom }} aria-hidden="true" onContextMenu={noNativeMenu} />
        </>
      )}
      <div
        ref={ref}
        className={`ctx-stack${anchor ? ' anchored' : ''}${align === 'end' ? ' end' : ''}${anchor && drop ? ' drop' : ''}`}
        style={{ left: place?.left ?? 0, top: place?.top ?? 0, visibility: place ? 'visible' : 'hidden' }}
        onContextMenu={noNativeMenu}
      >
        {reactions}
        <div
          ref={cardRef}
          className={`ctx-menu${anchor ? ' anchored' : ''}${bare ? ' bare' : ''}`}
          role="menu"
          style={menuWidth}
        >
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}

/**
 * Раскрытие выпадающего меню (`drop`), как Telegram Android `ActionBarPopupWindow.startAnimation`: подложка раскрывается
 * за `150 + 16 × N` мс (N — видимых пунктов), пункт проявляется (`alpha 0→1`, `translationY −6→0` за 180 мс,
 * `ActionBarPopupWindowLayout.startChildAnimation`), когда край раскрытия дошёл до его середины
 * (`ActionBarPopupWindowLayout.setBackScaleY`). Длительность и задержки — CSS-переменными: `--drop-ms` у карточки,
 * `--drop-at` у пункта.
 */
function dropStagger(card: HTMLElement) {
  const items = Array.from(card.children).filter((c): c is HTMLElement => c instanceof HTMLElement);
  const shown = items.filter((c) => c.classList.contains('ctx-item')).length;
  const ms = 150 + 16 * shown;
  const h = card.offsetHeight || 1;
  card.style.setProperty('--drop-ms', `${ms}ms`);
  for (const c of items) c.style.setProperty('--drop-at', `${Math.round((ms * Math.min(h, c.offsetTop + c.offsetHeight / 2)) / h)}ms`);
}

/**
 * Наш набор быстрых реакций (решение владельца 03.10): полоса меню сообщения (`ReactionBar`, раунд 12) и лист сообщения
 * раунда 10. Набор один на приложение — лента берёт его отсюда, а не держит свою копию (до переноса меню сообщения в
 * ленту копия ещё живёт в `MessagePane.tsx`).
 */
export const QUICK_REACTIONS: readonly string[] = ['👍', '🔥', '😂', '❤️', '🦆'];

export type ReactionBarProps = {
  /** Быстрые реакции по порядку; по умолчанию наш набор `QUICK_REACTIONS` (👍 🔥 😂 ❤️ 🦆). */
  reactions?: readonly string[];
  /** Уже поставленные мной — подсвечены (`.on`); нажатие по такой снимает её. */
  mine?: readonly string[];
  /** Нажата реакция: поставить или снять и закрыть меню — решает вызывающий. */
  onPick: (emoji: string) => void;
  /** «Все реакции» — полный пикер на месте полосы (меню при этом закрывается); кнопка приходит в событии — для якоря пикера. */
  onMore: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  /**
   * «Выбрать по умолчанию» (G45, Telegram Desktop `lng_context_set_as_quick`): правый клик или долгое нажатие по реакции
   * открывает под ней одну кнопку — сделать эту реакцию быстрой (её ставит двойной клик, у Telegram она стоит первой в
   * полосе). Нет пропса — реакции без правого клика, как было.
   */
  onSetQuick?: (emoji: string) => void;
  /** Нынешняя быстрая реакция: на ней «Выбрать по умолчанию» не предлагается (у Telegram — так же: `id == favorite`). */
  quick?: string;
  /**
   * «Большая» реакция удержанием ПАЛЬЦЕМ (08.10, G43, `bigreact1`; Telegram Android `ReactionsContainerLayout`; мышью — нет,
   * решение владельца 08.10, п.28: клик ставит реакцию, правый клик — «Выбрать по умолчанию»): держишь реакцию —
   * через 0,4 с она растёт поверх полосы, дорос — уходит «большой» (отпустил после 0,8 роста — тоже), отпустил раньше — ничего;
   * отпустил до начала роста — обычное нажатие. Правила — `bigReaction.ts`. Пальцем удержание больше не открывает «Выбрать по
   * умолчанию» (у Telegram на телефоне быстрая реакция — в настройках); правый клик мышью — по-прежнему. Нет пропса — как было.
   */
  onBig?: (emoji: string) => void;
};

/**
 * Полоса быстрых реакций (раунд 12, HANDOFF §2.1) — своя поверхность-пилюля над карточкой меню сообщения, на ПК и на
 * телефоне одна деталь: в `ContextMenu` её передают пропсом `reactions`. Последняя кнопка — «Все реакции»
 * (`chevron-down`). Кнопки 36 px, эмодзи 22 px; у меню у пузыря на телефоне — 44 и 26 (`.ctx-stack.anchored`).
 */
export function ReactionBar({ reactions = QUICK_REACTIONS, mine = [], onPick, onMore, onSetQuick, quick, onBig }: ReactionBarProps) {
  // Кнопка «Выбрать по умолчанию» под реакцией: какая реакция и сколько от левого края полосы. Гаснет Esc, нажатием мимо.
  const [setq, setSetq] = useState<{ emoji: string; left: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // Удержание для «большой» (`onBig`): что держат, с какого момента и откуда; `held` — какая реакция растёт (класс `.held`).
  const hold = useRef<{ emoji: string; start: number; x: number; y: number; raf: number; ready?: boolean } | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  // Нажатие кончилось «большой» или отменой — следующий `click` по кнопке не обычная реакция. Сбрасывается новым нажатием.
  const swallowClick = useRef(false);
  const lastPointer = useRef<string>('mouse');
  const stopHold = () => {
    const h = hold.current;
    if (h) cancelAnimationFrame(h.raf);
    hold.current = null;
    setHeld(null);
    barRef.current?.style.removeProperty('--big-p');
  };
  useEffect(() => () => {
    if (hold.current) cancelAnimationFrame(hold.current.raf);
  }, []);
  const fireBig = (emoji: string) => {
    swallowClick.current = true;
    stopHold();
    onBig?.(emoji);
  };
  const tick = () => {
    const h = hold.current;
    if (!h) return;
    const elapsed = performance.now() - h.start;
    const p = bigHoldProgress(elapsed);
    if (p > 0) {
      setHeld(h.emoji);
      barRef.current?.style.setProperty('--big-p', p.toFixed(3));
    }
    /* Дорос, пока палец ещё держит: Telegram отправляет сразу, мы — на отпускании. Иначе меню закрылось бы под пальцем, и
       отпускание стало бы «тапом» по сообщению под ним (открыло бы его меню; проверено на стенде). Реакция стоит выросшей. */
    if (bigHoldOutcome(elapsed, false) === 'big') {
      h.ready = true;
      return;
    }
    h.raf = requestAnimationFrame(tick);
  };
  useEffect(() => {
    if (!setq) return;
    const off = (ev: Event) => {
      if (ev.type === 'keydown' && (ev as KeyboardEvent).key !== 'Escape') return;
      if (ev.type === 'pointerdown' && barRef.current?.querySelector('.react-bar-setq')?.contains(ev.target as Node)) return;
      setSetq(null);
    };
    document.addEventListener('pointerdown', off, true);
    document.addEventListener('keydown', off, true);
    return () => {
      document.removeEventListener('pointerdown', off, true);
      document.removeEventListener('keydown', off, true);
    };
  }, [setq]);
  return (
    <div
      className={['react-bar', onBig ? 'can-big' : '', held ? 'holding' : ''].filter(Boolean).join(' ')}
      role="toolbar"
      aria-label="Быстрые реакции"
      ref={barRef}
    >
      {reactions.map((e) => {
        const on = mine.includes(e);
        return (
          <button
            type="button"
            className={['react-bar-btn', on ? 'on' : '', held === e ? 'held' : ''].filter(Boolean).join(' ')}
            key={e}
            aria-pressed={on}
            onPointerDown={
              onBig
                ? (ev) => {
                    lastPointer.current = ev.pointerType;
                    swallowClick.current = false;
                    // Мышью удержание ничего «большого» не делает (решение владельца 08.10, п.28; Telegram — только палец).
                    if (ev.pointerType === 'mouse') return;
                    stopHold();
                    hold.current = { emoji: e, start: performance.now(), x: ev.clientX, y: ev.clientY, raf: 0 };
                    hold.current.raf = requestAnimationFrame(tick);
                  }
                : undefined
            }
            onPointerMove={
              onBig
                ? (ev) => {
                    const h = hold.current;
                    if (!h || h.ready || Math.hypot(ev.clientX - h.x, ev.clientY - h.y) <= BIG_MOVE_SLOP_PX) return;
                    // Ушёл с места — отмена (Android `touchSlop`); если рост уже шёл, обычной реакции тоже нет.
                    if (bigHoldProgress(performance.now() - h.start) > 0) swallowClick.current = true;
                    stopHold();
                  }
                : undefined
            }
            onPointerUp={
              onBig
                ? () => {
                    const h = hold.current;
                    if (!h) return;
                    const out = h.ready ? 'big' : bigHoldOutcome(performance.now() - h.start, true);
                    if (out === 'big') return fireBig(h.emoji);
                    if (out === 'cancel') swallowClick.current = true;
                    stopHold();
                  }
                : undefined
            }
            onPointerCancel={onBig ? () => (hold.current?.ready ? fireBig(hold.current.emoji) : stopHold()) : undefined}
            onPointerLeave={onBig ? () => (hold.current?.ready ? fireBig(hold.current.emoji) : stopHold()) : undefined}
            onClick={() => {
              setSetq(null);
              if (swallowClick.current) {
                swallowClick.current = false;
                return;
              }
              onPick(e);
            }}
            onContextMenu={
              onSetQuick || onBig
                ? (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    // Пальцем удержание — «большая» реакция; «Выбрать по умолчанию» на телефоне — в настройках (как у Telegram).
                    if (!onSetQuick || (onBig && lastPointer.current !== 'mouse')) return;
                    if (e === quick) return setSetq(null);
                    setSetq({ emoji: e, left: ev.currentTarget.offsetLeft });
                  }
                : undefined
            }
          >
            {e}
          </button>
        );
      })}
      {setq && onSetQuick ? (
        <button
          type="button"
          role="menuitem"
          className="react-bar-setq"
          style={{ left: setq.left }}
          onClick={() => {
            onSetQuick(setq.emoji);
            setSetq(null);
          }}
        >
          Выбрать по умолчанию
        </button>
      ) : null}
      <button type="button" className="react-bar-more" aria-label="Все реакции" title="Все реакции" onClick={onMore}>
        <Icon name="chevron-down" size={20} />
      </button>
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  sub,
  onClick,
  danger,
  disabled,
  submenu,
  active,
  shortcut,
  note,
  back,
}: {
  icon?: IconName;
  label: ReactNode;
  /** Optional dim second line under the label (e.g. "только для вас"). */
  sub?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  submenu?: boolean;
  active?: boolean;
  /** Optional keyboard hint shown mono/dim on the right (e.g. "R", "Del"). */
  shortcut?: string;
  /**
   * `shortcut` — не клавиша, а справка к пункту (остаток срока заглушки «3 ч»): в листе на телефоне её НЕ прячем.
   * Подсказки клавиш (R, Del) на телефоне скрыты правилом `.ctx-menu.sheet .ctx-shortcut` — клавиатуры там нет.
   */
  note?: boolean;
  /** Пункт «назад на уровень выше» — его нажимает системная «Назад» на телефоне (`ContextMenu`, `onBack`). */
  back?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-back={back ? '' : undefined}
      className={`ctx-item ${danger ? 'danger' : ''} ${active ? 'active' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon ? (
        <span className="ctx-ico">
          <Icon name={icon} size={16} />
        </span>
      ) : (
        <span className="ctx-ico" />
      )}
      <span className={`ctx-label ${sub ? 'has-sub' : ''}`}>
        <span className="ctx-label-main">{label}</span>
        {sub ? <span className="ctx-sublabel">{sub}</span> : null}
      </span>
      {shortcut ? (
        <span className={note ? 'ctx-shortcut ctx-note' : 'ctx-shortcut'}>{shortcut}</span>
      ) : submenu ? (
        <span className="ctx-arrow">
          <Icon name="chevron-right" size={14} />
        </span>
      ) : null}
    </button>
  );
}

export const MenuDivider = () => <div className="ctx-divider" />;

export function MenuSection({ children }: { children: ReactNode }) {
  return <div className="ctx-section">{children}</div>;
}

/** Non-clickable identity block at the top of a menu: avatar (+ optional status dot) + name + subtitle. */
export function MenuHeader({
  avatar,
  name,
  sub,
  online,
  status,
}: {
  avatar?: ReactNode;
  name: ReactNode;
  sub?: ReactNode;
  /** When provided, overlays a green/grey presence dot on the avatar. */
  online?: boolean;
  /** A 4-state presence dot — takes precedence over `online` when set. */
  status?: DotStatus;
}) {
  return (
    <div className="ctx-header">
      {avatar ? (
        status !== undefined ? (
          <span className="ctx-ava-wrap">
            {avatar}
            <span className="ctx-ava-dot-wrap">
              <StatusDot status={status} size={12} ringColor="var(--bg-2)" />
            </span>
          </span>
        ) : online === undefined ? (
          avatar
        ) : (
          <span className="ctx-ava-wrap">
            {avatar}
            <span className={`ctx-ava-dot ${online ? 'on' : 'off'}`} />
          </span>
        )
      ) : null}
      <div className="ctx-header-text">
        <div className="ctx-header-name">{name}</div>
        {sub ? <div className="ctx-header-sub">{sub}</div> : null}
      </div>
    </div>
  );
}
