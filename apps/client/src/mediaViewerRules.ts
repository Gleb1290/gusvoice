/**
 * Чистые правила просмотрщика (волна 6 телеграмности: G10, G33, G66) — клавиши видео, перемотка, поворот, резина и
 * инерция увеличенного фото, строка даты. Источники — исходники Telegram (`S:\gv-stand\tg-src`), код не копирован:
 * tdesktop `media/view/media_view_overlay_widget.cpp` (`handleKeyPress`, `playbackControlsRotate`, `startSpeedBoost`),
 * `media_view.style` (`mediaviewSpeedBoostHoldDelay`), Web A `components/mediaViewer/VideoPlayer.tsx`
 * (`MAX_LOOP_DURATION`), Android `ui/PhotoViewer.java` (`onDoubleTap`). Компонент — `components/Lightbox.tsx`.
 */
import type { ZoomPoint } from './lightboxZoom';

/** J / L и двойной тап у края видео — ±10 с (tdesktop `kSeekTimeMsLong`, Android `onDoubleTap` ±10000 мс). */
export const VIDEO_SEEK_LONG_S = 10;
/** Пробел держат дольше — видео ускоряется (tdesktop `mediaviewSpeedBoostHoldDelay` = 200 мс). */
export const SPEED_BOOST_HOLD_MS = 200;
/** Скорость на время удержания Пробела (tdesktop `startSpeedBoost`: 2.0). */
export const SPEED_BOOST_RATE = 2;
/** Шаг «,» / «.» на паузе — один кадр при 30 к/с: частоту кадров браузер не сообщает. */
export const FRAME_STEP_S = 1 / 30;
/** Видео не длиннее — зациклено сразу, как у Web A (`MAX_LOOP_DURATION` = 30 с); «Зациклить» переключает. */
export const AUTO_LOOP_MAX_S = 30;

export type VideoKeyAction =
  | { kind: 'toggle' }
  | { kind: 'seek'; by: number }
  | { kind: 'frame'; dir: -1 | 1 }
  | { kind: 'at'; frac: number };

/**
 * Клавиша видео по `KeyboardEvent.code` — от раскладки не зависит (у tdesktop `LayoutIndependentKey`): K — пауза,
 * J / L — ∓10 с, «,» / «.» — кадр назад / вперёд только на паузе, цифры 0–9 — позиция n/10 (у tdesktop цифры — в
 * полноэкранном видео; у нас просмотр и так на весь экран). С Ctrl / Alt / Meta — не наше (Ctrl+S, Ctrl+C, ярлыки системы).
 * Пробел — отдельно (нажатие и отпускание: короткое — пауза, удержание — ×2).
 */
export function videoKeyAction(code: string, mods: { ctrl?: boolean; alt?: boolean; meta?: boolean }, paused: boolean): VideoKeyAction | null {
  if (mods.ctrl || mods.alt || mods.meta) return null;
  if (code === 'KeyK') return { kind: 'toggle' };
  if (code === 'KeyJ') return { kind: 'seek', by: -VIDEO_SEEK_LONG_S };
  if (code === 'KeyL') return { kind: 'seek', by: VIDEO_SEEK_LONG_S };
  if (code === 'Comma' || code === 'Period') return paused ? { kind: 'frame', dir: code === 'Period' ? 1 : -1 } : null;
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return { kind: 'at', frac: Number(digit[1]) / 10 };
  return null;
}

/** Новая позиция: в пределах [0, длительность]; длительность неизвестна (поток, `Infinity`, `NaN`) — только снизу. */
export function seekClamp(cur: number, by: number, duration: number): number {
  const next = Math.max(0, cur + by);
  return Number.isFinite(duration) && duration > 0 ? Math.min(duration, next) : next;
}

/** Двойной тап по видео на телефоне: левая треть — назад, правая — вперёд, середина — ничего (Android `onDoubleTap`). */
export function videoTapSide(x: number, width: number): -1 | 0 | 1 {
  if (!(width > 0)) return 0;
  if (x < width / 3) return -1;
  if (x >= (width / 3) * 2) return 1;
  return 0;
}

/**
 * «Повернуть»: −90° за нажатие (tdesktop `playbackControlsRotate`). Угол НЕ приводится к 0…270: переход CSS от 0° к 270°
 * крутил бы картинку на три четверти по часовой — а от 0° к −90° она поворачивается на четверть, как нажали.
 */
export function rotateStep(deg: number): number {
  return deg - 90;
}

/** Повёрнуто на четверть: ширина и высота меняются местами. */
export function quarterTurned(deg: number): boolean {
  return ((deg % 180) + 180) % 180 === 90;
}

/**
 * Во сколько ужать картинку на четверти оборота, чтобы она влезла в сцену: размер на экране `w×h` (уже вписан без
 * поворота), повёрнутый занимает `h×w`. Только уменьшение — маленькая так и остаётся маленькой.
 */
export function rotateFit(w: number, h: number, stageW: number, stageH: number, deg: number): number {
  if (!quarterTurned(deg) || !(w > 0) || !(h > 0)) return 1;
  return Math.min(1, stageW / h, stageH / w);
}

/** Доля перетяга за край, которая видна: «резина» увеличенного фото — треть пути, как у Telegram Android (`PhotoViewer`: за `minX`/`maxX` `moveDx /= 3`). */
export const RUBBER_K = 1 / 3;

/** Резина: за пределом сдвиг идёт с сопротивлением (`clamped` — тот же сдвиг, прижатый к краю, `lightboxZoom.clampPan`). */
export function rubberPan(p: ZoomPoint, clamped: ZoomPoint, k = RUBBER_K): ZoomPoint {
  return { x: clamped.x + (p.x - clamped.x) * k, y: clamped.y + (p.y - clamped.y) * k };
}

/** Постоянная затухания инерции, с: отпущенное фото проезжает `скорость × INERTIA_TAU` и останавливается. */
export const INERTIA_TAU = 0.25;
/** Скорость броска не больше, px/с — дёрнувшийся указатель не уносит фото за тридевять земель. */
export const INERTIA_MAX_V = 4000;

/** Куда доедет отпущенное фото (потом прижимается к краю тем же `clampPan`). */
export function inertiaTarget(p: ZoomPoint, v: ZoomPoint, tau = INERTIA_TAU): ZoomPoint {
  const cap = (n: number) => Math.max(-INERTIA_MAX_V, Math.min(INERTIA_MAX_V, Number.isFinite(n) ? n : 0));
  return { x: p.x + cap(v.x) * tau, y: p.y + cap(v.y) * tau };
}

const TIME = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const DAY_YEAR = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Дата под именем отправителя в просмотрщике — как у Telegram (`lng_mediaview_today` / `_yesterday` / `_date_time`):
 * «сегодня в 14:05», «вчера в 14:05», «12 сентября в 14:05», другой год — «12 сентября 2025 г. в 14:05». Не разобрать —
 * пустая строка.
 */
export function viewerDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const time = TIME.format(d);
  if (d.toDateString() === now.toDateString()) return `сегодня в ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `вчера в ${time}`;
  const day = d.getFullYear() === now.getFullYear() ? DAY.format(d) : DAY_YEAR.format(d);
  return `${day} в ${time}`;
}

/** Порядок пунктов меню «⋯» / ПКМ просмотрщика — как у tdesktop (`fillContextMenuActions`), «Поделиться» (браузер, G10) — после «Переслать», как у Android `PhotoViewer`; «Удалить» — последним (у нас опасное внизу). */
export const VIEWER_MENU_ORDER = ['goto', 'copy', 'forward', 'share', 'save', 'delete'] as const;
export type ViewerMenuId = (typeof VIEWER_MENU_ORDER)[number];

/** Пункты в порядке `VIEWER_MENU_ORDER`; повтор одного и того же — первый. */
export function orderViewerMenu<T extends { id: ViewerMenuId }>(items: readonly T[]): T[] {
  const seen = new Set<ViewerMenuId>();
  return VIEWER_MENU_ORDER.flatMap((id) => {
    const it = items.find((x) => x.id === id);
    if (!it || seen.has(id)) return [];
    seen.add(id);
    return [it];
  });
}
