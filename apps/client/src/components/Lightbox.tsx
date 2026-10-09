import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { downloadInApp, fileJobOf, progressRatio, progressText, subscribeFileJobs, type DownloadNote } from '../fileActions';
import { canShareFiles, ringDownloads, shareDownload, startDownload, toggleDownload, type DownloadTarget } from '../pcDownloads';
import { ProgressRing } from './FileCard';
import {
  DOUBLE_TAP_MS,
  DOUBLE_TAP_ZOOM,
  DRAG_CLICK_PX,
  GESTURE_LOCK_PX,
  dismissDim,
  dismissResult,
  gestureAxis,
  isDoubleTap,
  nearMediaEdge,
  pageDragOffset,
  pageSwipeResult,
  stripWindow,
  tapZone,
  wheelPageStep,
  wheelZoomStep,
  zoomAt,
  type GestureAxis,
} from '../lightboxGestures';
import { clampPan, fitZoom, pinchStep, type ZoomPoint } from '../lightboxZoom';
import {
  AUTO_LOOP_MAX_S,
  FRAME_STEP_S,
  SPEED_BOOST_HOLD_MS,
  SPEED_BOOST_RATE,
  VIDEO_SEEK_LONG_S,
  inertiaTarget,
  orderViewerMenu,
  quarterTurned,
  rotateFit,
  rotateStep,
  rubberPan,
  seekClamp,
  videoKeyAction,
  videoTapSide,
  viewerDate,
  type VideoKeyAction,
  type ViewerMenuId,
} from '../mediaViewerRules';
import { nativeMediaAvailable } from '../nativeMedia';
import { usePhoneLayout } from '../phoneLayout';
import { toast } from '../toast';
import { openPip, pipSupported } from '../videoPip';
import { MenuItem } from './ContextMenu';
import { Icon, type IconName } from './Icon';
import { BLANK_POSTER, videoFrameSrc } from './VideoAttachment';
import { VoiceSpeedButton } from './VoiceSpeedButton';

export type LightboxImage = {
  url: string;
  name: string;
  /** Вес файла. Не всегда известен: аватар приходит ссылкой, без карточки вложения. */
  size?: number;
  /** Подпись под заголовком («Аватар»). */
  sub?: string;
  downloadUrl?: string;
  /** Видео (06.10): играет плеером — звук, перемотка; без масштаба. */
  video?: boolean;
  /** Тип файла для «Скачать» в приложении Android (выдача публичных говорит `application/octet-stream`). */
  type?: string;
  /** Вложение сообщения (G10, волна 6): кто прислал — строка «отправитель · дата» вместо имени файла, как у Telegram. */
  from?: string;
  /** Когда прислано (ISO) — «сегодня в 14:05» (`mediaViewerRules.viewerDate`). */
  at?: string;
  /** Подпись к фото — текст сообщения, внизу над лентой миниатюр. */
  caption?: string;
  /**
   * Ключ вложения (`fileActions.attachmentKey`) — «Скачать» на ПК идёт тем же ходом, что кольцо на карточке и «⬇» в ленте
   * (G31, 08.10). Нет (аватар) — ключ — сама ссылка.
   */
  jobKey?: string;
};

/** Пункт меню «⋯» / ПКМ просмотрщика (G10): что делать с файлом на экране. «Сохранить как…» просмотр добавляет сам. */
export type LightboxAction = { id: ViewerMenuId; label: string; icon: IconName; danger?: boolean; run: () => void };

/** Скорость видео в просмотрщике — одна на сеанс, отдельно от голосовых (у tdesktop своя настройка видео). */
let videoSpeed = 1;
/** К чему переключает щелчок по кнопке скорости (последнее ускорение). */
let videoSpedUp = 2;

const kb = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} КБ` : `${(n / 1024 / 1024).toFixed(1)} МБ`);
const ZMIN = 0.5;
const ZMAX = 3;
const NO_PAN: ZoomPoint = { x: 0, y: 0 };
const midOf = (a: ZoomPoint, b: ZoomPoint): ZoomPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distOf = (a: ZoomPoint, b: ZoomPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const isFinger = (e: ReactPointerEvent) => e.pointerType === 'touch' || e.pointerType === 'pen';
/** Мышь не двигалась столько — панель просмотра гаснет (Telegram Desktop: 1,1 с, VD-22). */
const IDLE_MS = 1100;

/**
 * Full-screen image viewer (round-7 P4): prev/next across all images in the view, zoom (+/−),
 * download, filmstrip, counter. Keyboard: Esc close, ←/→ navigate, +/− zoom. Portalled.
 * Пальцы (05.10): щипок — масштаб к точке под пальцами, одним пальцем — сдвиг увеличенного (страница щипком не
 * масштабируется, `index.html`).
 * Видео (06.10, как у Telegram): тот же ряд, что фото; играет сразу, со звуком, управление — родное `<video controls>`
 * (пауза, перемотка, громкость); масштаба и щипка у него нет. Своё «Скачать» сверху — родное в меню плеера скрыто
 * (`nodownload`: в приложении Android оно молчит, как молчали ссылки). В приложении Android плеер ещё и без «на весь
 * экран» (`nofullscreen`, кнопка серая): оболочка wry сразу закрывает полноэкранный вид, а просмотр и так на весь экран.
 * Жесты как у Telegram (G11, 07.10; пороги и решения — `lightboxGestures.ts`): палец — свайп вбок листает, смахивание вниз
 * закрывает (фон светлеет), тап у края листает, тап по середине прячет и показывает панель, двойной тап — ×3 в точке и
 * обратно; мышь — колесо листает, Ctrl+колесо — масштаб к курсору, Ctrl+0 — «по размеру», увеличенное фото тащится,
 * панель гаснет, пока мышь стоит. У видео пальцы на самом плеере — его управлению, жесты — с полей вокруг.
 */
export function Lightbox({
  images,
  index,
  onClose,
  onIndex,
  onNearEdge,
  actions,
  onAuthor,
}: {
  images: LightboxImage[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
  /**
   * Листание дошло до края набора (`lightboxGestures.nearMediaEdge`): `-1` — к старым, `1` — к новым. Лента подтягивает
   * медиа беседы дальше загруженного окна и расширяет `images` (G11, «листать всей медиатекой»); не передали — набор как есть.
   */
  onNearEdge?: (dir: -1 | 1) => void;
  /** Пункты меню «⋯» / ПКМ для файла на экране (G10): к сообщению, копировать, переслать, удалить. Нет — только «Сохранить». */
  actions?: (img: LightboxImage, index: number) => LightboxAction[];
  /** Нажали имя отправителя — профиль (G10, как у Telegram: просмотр закрывается, карточка у курсора). */
  onAuthor?: (index: number, e: React.MouseEvent) => void;
}) {
  const phone = usePhoneLayout();
  const [zoom, setZoom] = useState(1);
  /** Сдвиг увеличенной картинки пальцем или мышью, px (кнопками и клавишами масштаб — от середины, как был). */
  const [pan, setPan] = useState<ZoomPoint>(NO_PAN);
  /** Пальцы или мышь ведут картинку — без перехода `transform`, иначе она догоняла бы их с опозданием. */
  const [gesture, setGesture] = useState(false);
  /**
   * Листание и смахивание пальцем (G11): сдвиг всей сцены за пальцем и прозрачность фона (1 — как обычно). `sliding` —
   * палец ещё на экране (без перехода); отпустили — сцена плавно возвращается или уезжает.
   */
  const [slide, setSlide] = useState<ZoomPoint>(NO_PAN);
  const [sliding, setSliding] = useState(false);
  const [dim, setDim] = useState(1);
  /** Панель (верх, низ, стрелки) спрятана тапом по середине (VA-10) — и показывается им же. */
  const [bareTap, setBareTap] = useState(false);
  /** Мышь замерла — панель гаснет через `IDLE_MS`, шевельнули — вернулась (VD-22). */
  const [idle, setIdle] = useState(false);
  /**
   * Ход и итог «Скачать» в приложении на телефоне (натив кладёт файл в «Загрузки», 06.10): вместо строки веса. Итог
   * гаснет сам, ход держится, пока идёт.
   */
  const [saveNote, setSaveNote] = useState<(DownloadNote & { url: string }) | null>(null);
  useEffect(() => {
    if (!saveNote?.final) return;
    const t = window.setTimeout(() => setSaveNote(null), 2600);
    return () => window.clearTimeout(t);
  }, [saveNote]);
  /** Видео не играет (кодек, нет связи) — сказать об этом строкой под именем; «Скачать» остаётся. */
  const [videoFailed, setVideoFailed] = useState(false);
  /**
   * Первый кадр видео есть. До него у плеера нет размера (метаданных ещё нет) — на сцене пусто; большое видео с индексом в
   * конце файла (запись экрана, стенд 06.10: 13 МБ — около 3 с) показывает крутилку, а не пустой экран.
   */
  const [videoReady, setVideoReady] = useState(false);
  /** Поворот фото, градусы без приведения (G66, tdesktop «Повернуть»: −90° за нажатие; `rotateStep`); новый файл — снова 0. */
  const [rot, setRot] = useState(0);
  const rotRef = useRef(rot);
  rotRef.current = rot;
  /**
   * Зеркало фото (G66): tdesktop `OverlayWidget::handleKeyPress` — H по горизонтали, V по вертикали, без кнопки и пункта
   * меню (только клавиши); новый файл — снова прямо (`_flip = {}`).
   */
  const [flip, setFlip] = useState({ h: false, v: false });
  /** Меню «⋯» / ПКМ (G10): где открыто. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuOpen = useRef(false);
  menuOpen.current = !!menu;
  /** Отпущенное после перетаскивания фото доезжает по инерции — плавный переход длиннее обычного. */
  const [glide, setGlide] = useState(false);
  const glideTimer = useRef(0);
  /** Видео (G33): скорость, «Зациклить» (`null` — по длине, Web A: до 30 с — по кругу), удержание Пробела — ×2. */
  const [rate, setRate] = useState(videoSpeed);
  const [loopPick, setLoopPick] = useState<boolean | null>(null);
  const [autoLoop, setAutoLoop] = useState(false);
  const loop = loopPick ?? autoLoop;
  const [boost, setBoost] = useState(false);
  const hold = useRef<{ timer: number; boosting: boolean } | null>(null);
  /** Подсказка «−10 с» / «+10 с» у края видео после двойного тапа (Android `videoForwardDrawable`). */
  const [seekHint, setSeekHint] = useState<{ side: -1 | 1; n: number } | null>(null);
  const videoTap = useRef<{ t: number; x: number; y: number } | null>(null);
  /** Последний указатель — палец: ПКМ (долгое нажатие) на телефоне меню не открывает. */
  const lastTouch = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dlRef = useRef<HTMLAnchorElement>(null);
  /** Скорость ведения фото (мышь или палец), px/с — для инерции; сглажена, как у листания. */
  const vel = useRef({ x: 0, y: 0, t: 0, vx: 0, vy: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const img = images[index];
  const isVideo = img?.video === true;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;
  /** Масштаб «по размеру» этой картинки (`fitZoom`): к нему возвращают Ctrl+0 и второй двойной тап. */
  const baseZoom = useRef(1);
  /** Пальцы на сцене: где каждый сейчас. */
  const fingers = useRef(new Map<number, ZoomPoint>());
  /** Щипок (два пальца): с чего начался — `lightboxZoom.pinchStep`. Ведение одним пальцем увеличенной картинки — `drag`. */
  const pinch = useRef<{ zoom0: number; pan0: ZoomPoint; center: ZoomPoint; mid0: ZoomPoint; dist0: number } | null>(
    null,
  );
  const drag = useRef<{ pan0: ZoomPoint; from: ZoomPoint } | null>(null);
  /** Один палец при «по размеру»: листание, смахивание или тап — решается по ходу (`gestureAxis`). */
  const swipe = useRef<{ from: ZoomPoint; t0: number; axis: GestureAxis; last: { x: number; t: number }; vx: number } | null>(
    null,
  );
  /** Перетаскивание увеличенного фото мышью (VD-19). `moved` — ушла дальше `DRAG_CLICK_PX`: щелчок после него не закрывает. */
  const mouseDrag = useRef<{ pan0: ZoomPoint; from: ZoomPoint; moved: boolean } | null>(null);
  /** Касание одним пальцем: где и когда началось и ушёл ли палец дальше `GESTURE_LOCK_PX` (тогда это не тап). */
  const touchStart = useRef<{ x: number; y: number; t: number; moved: boolean } | null>(null);
  /** Первый тап (ждём, не будет ли второго) и таймер его действия. */
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const tapTimer = useRef<number | null>(null);
  /** До этого момента щелчок по фону не закрывает: он — хвост жеста пальцем или перетаскивания мышью. */
  const swallowClick = useRef(0);
  const indexRef = useRef(index);
  indexRef.current = index;
  const countRef = useRef(images.length);
  countRef.current = images.length;

  /** Сдвиг в пределах сцены при этом масштабе (`clampPan`); тот же — тот же объект, без лишней перерисовки. */
  const fitPan = useCallback((p: ZoomPoint, z: number): ZoomPoint => {
    const el = imgRef.current;
    const stage = stageRef.current;
    if (!el || !stage) return NO_PAN;
    // Повёрнутое на четверть — ширина и высота на экране меняются местами.
    const turned = quarterTurned(rotRef.current);
    const size = turned ? { w: el.offsetHeight, h: el.offsetWidth } : { w: el.offsetWidth, h: el.offsetHeight };
    const c = clampPan(p, z, size, { w: stage.clientWidth, h: stage.clientHeight });
    return c.x === p.x && c.y === p.y ? p : c;
  }, []);
  /** Сдвиг пальцем или мышью за край — с сопротивлением («резина», G66); отпустили — возвращается к краю. */
  const rubberFit = (p: ZoomPoint, z: number): ZoomPoint => rubberPan(p, fitPan(p, z));
  const trackVel = (x: number, y: number, t: number, reset = false) => {
    const k = vel.current;
    const dt = t - k.t;
    if (reset) Object.assign(k, { vx: 0, vy: 0 });
    else if (dt > 0) {
      k.vx = k.vx * 0.3 + ((x - k.x) / dt) * 1000 * 0.7;
      k.vy = k.vy * 0.3 + ((y - k.y) / dt) * 1000 * 0.7;
    }
    Object.assign(k, { x, y, t });
  };
  /** Отпустили увеличенное фото: доезжает по инерции и встаёт в пределы сцены (стоял перед отпусканием — сразу к краю). */
  const releasePan = (t: number) => {
    const k = vel.current;
    const still = t - k.t > 80;
    const target = fitPan(inertiaTarget(panRef.current, still ? { x: 0, y: 0 } : { x: k.vx, y: k.vy }), zoomRef.current);
    setGlide(true);
    window.clearTimeout(glideTimer.current);
    glideTimer.current = window.setTimeout(() => setGlide(false), 420);
    setPan(target);
  };
  /** Картинка при этом масштабе больше сцены — её можно вести (пальцем, мышью); иначе палец листает. */
  const canPan = (z = zoomRef.current) => {
    const el = imgRef.current;
    const stage = stageRef.current;
    if (!el || !stage || isVideo) return false;
    const turned = quarterTurned(rotRef.current);
    const w = turned ? el.offsetHeight : el.offsetWidth;
    const h = turned ? el.offsetWidth : el.offsetHeight;
    return w * z > stage.clientWidth + 1 || h * z > stage.clientHeight + 1;
  };
  /** Середина картинки без сдвига, экранная (для масштаба к точке). */
  const imgCenter = (): ZoomPoint | null => {
    const el = imgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const p = panRef.current;
    return { x: r.left + r.width / 2 - p.x, y: r.top + r.height / 2 - p.y };
  };
  /** Масштаб к точке экрана (Ctrl+колесо, двойной тап) — точка картинки под ней остаётся на месте. */
  const zoomToPoint = (z: number, point: ZoomPoint) => {
    const center = imgCenter();
    if (!center) return;
    const next = zoomAt({ zoom0: zoomRef.current, pan0: panRef.current, center, point, zoom: z, min: ZMIN, max: ZMAX });
    setZoom(next.zoom);
    setPan(fitPan(next.pan, next.zoom));
  };
  const resetZoom = () => {
    setZoom(baseZoom.current);
    setPan(NO_PAN);
  };
  const go = (dir: -1 | 1) => {
    const next = indexRef.current + dir;
    if (next >= 0 && next < countRef.current) onIndex(next);
  };

  /**
   * Масштаб — только внутри просмотра (05.10): страница щипком больше не увеличивается (`index.html`), поэтому щипок и
   * ведение увеличенной картинки — здесь, по указателям пальцев. Новый палец или поднятый — жест начинается заново с того,
   * что на экране: два пальца — щипок, один на картинке больше сцены — сдвиг, один «по размеру» — листание или смахивание.
   */
  const restartGesture = () => {
    const pts = [...fingers.current.values()];
    const el = imgRef.current;
    pinch.current = null;
    drag.current = null;
    if (pts.length >= 2 && el && !isVideo) {
      swipe.current = null;
      const r = el.getBoundingClientRect();
      const p = panRef.current;
      pinch.current = {
        zoom0: zoomRef.current,
        pan0: p,
        center: { x: r.left + r.width / 2 - p.x, y: r.top + r.height / 2 - p.y },
        mid0: midOf(pts[0], pts[1]),
        dist0: distOf(pts[0], pts[1]),
      };
    } else if (pts.length === 1 && canPan()) {
      drag.current = { pan0: panRef.current, from: pts[0] };
      trackVel(pts[0].x, pts[0].y, performance.now(), true);
    }
    setGesture(!!(pinch.current || drag.current));
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    lastTouch.current = isFinger(e);
    if (isFinger(e)) {
      // Пальцы на самом плеере — его управлению (перемотка, громкость); жесты видео — с полей вокруг него.
      if (e.target instanceof HTMLVideoElement) return;
      fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      touchStart.current = fingers.current.size === 1 ? { x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false } : null;
      swipe.current =
        fingers.current.size === 1 && !canPan()
          ? { from: { x: e.clientX, y: e.clientY }, t0: e.timeStamp, axis: 'wait', last: { x: e.clientX, t: e.timeStamp }, vx: 0 }
          : null;
      restartGesture();
      return;
    }
    // Мышь: левой кнопкой тащим увеличенное фото (VD-19).
    if (e.button !== 0 || !canPan()) return;
    mouseDrag.current = { pan0: panRef.current, from: { x: e.clientX, y: e.clientY }, moved: false };
    trackVel(e.clientX, e.clientY, performance.now(), true);
    setGlide(false);
    e.currentTarget.setPointerCapture(e.pointerId);
    setGesture(true);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const md = mouseDrag.current;
    if (md && e.pointerType === 'mouse') {
      const dx = e.clientX - md.from.x;
      const dy = e.clientY - md.from.y;
      if (Math.hypot(dx, dy) > DRAG_CLICK_PX) md.moved = true;
      trackVel(e.clientX, e.clientY, performance.now());
      setPan(rubberFit({ x: md.pan0.x + dx, y: md.pan0.y + dy }, zoomRef.current));
      return;
    }
    if (!fingers.current.has(e.pointerId)) return;
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const ts = touchStart.current;
    if (ts && Math.hypot(e.clientX - ts.x, e.clientY - ts.y) >= GESTURE_LOCK_PX) ts.moved = true;
    const pts = [...fingers.current.values()];
    const g = pinch.current;
    if (g && pts.length >= 2) {
      const next = pinchStep({ ...g, mid: midOf(pts[0], pts[1]), dist: distOf(pts[0], pts[1]), min: ZMIN, max: ZMAX });
      setZoom(next.zoom);
      setPan(fitPan(next.pan, next.zoom));
      return;
    }
    const d = drag.current;
    if (d && pts.length === 1) {
      trackVel(pts[0].x, pts[0].y, performance.now());
      setPan(rubberFit({ x: d.pan0.x + pts[0].x - d.from.x, y: d.pan0.y + pts[0].y - d.from.y }, zoomRef.current));
      return;
    }
    const s = swipe.current;
    if (!s || pts.length !== 1) return;
    const dx = e.clientX - s.from.x;
    const dy = e.clientY - s.from.y;
    const dt = e.timeStamp - s.last.t;
    if (dt > 0) s.vx = s.vx * 0.3 + (((e.clientX - s.last.x) / dt) * 1000) * 0.7;
    s.last = { x: e.clientX, t: e.timeStamp };
    if (s.axis === 'wait') s.axis = gestureAxis(dx, dy);
    if (s.axis === 'page') {
      setSliding(true);
      setSlide({ x: pageDragOffset(dx, indexRef.current > 0, indexRef.current < countRef.current - 1), y: 0 });
    } else if (s.axis === 'dismiss') {
      const h = stageRef.current?.clientHeight ?? window.innerHeight;
      setSliding(true);
      // Смахивание в любую сторону по вертикали (вверх тоже — 08.10): картинка идёт за пальцем, фон светлеет по модулю сдвига.
      setSlide({ x: 0, y: dy });
      setDim(dismissDim(Math.abs(dy), h));
    }
  };

  /** Одиночный тап пальцем: у края — соседний файл сразу (VA-11), по середине — панель (VA-10), двойной — масштаб (VA-12). */
  const onTap = (x: number, y: number, t: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    const zoomed = zoomRef.current > baseZoom.current + 0.01;
    const zone = zoomed ? 0 : tapZone(x - r.left, r.width);
    if (zone !== 0 && indexRef.current + zone >= 0 && indexRef.current + zone < countRef.current) {
      lastTap.current = null;
      go(zone);
      return;
    }
    if (tapTimer.current !== null) window.clearTimeout(tapTimer.current);
    tapTimer.current = null;
    if (!isVideo && isDoubleTap(lastTap.current, t, x, y)) {
      lastTap.current = null;
      if (zoomed) resetZoom();
      else zoomToPoint(Math.min(ZMAX, DOUBLE_TAP_ZOOM), { x, y });
      return;
    }
    lastTap.current = { t, x, y };
    // Ждём, не второй ли это тап: у фото двойной тап — масштаб, панель тогда не мигает. У видео двойного нет.
    if (isVideo) setBareTap((b) => !b);
    else tapTimer.current = window.setTimeout(() => {
      tapTimer.current = null;
      setBareTap((b) => !b);
    }, DOUBLE_TAP_MS);
  };

  const endSwipe = (e: ReactPointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    const dx = e.clientX - s.from.x;
    const dy = e.clientY - s.from.y;
    const stage = stageRef.current;
    const w = stage?.clientWidth ?? window.innerWidth;
    const h = stage?.clientHeight ?? window.innerHeight;
    setSliding(false);
    if (e.type === 'pointercancel') {
      setSlide(NO_PAN);
      setDim(1);
      return;
    }
    if (s.axis === 'page') {
      const dir = pageSwipeResult(dx, s.vx, w, indexRef.current > 0, indexRef.current < countRef.current - 1);
      if (dir) {
        // Следующий въезжает с той стороны, куда тянули, — видно, что листнули, а не подменили картинку.
        go(dir);
        setSliding(true);
        setSlide({ x: dir * w * 0.25, y: 0 });
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            setSliding(false);
            setSlide(NO_PAN);
          }),
        );
      } else setSlide(NO_PAN);
      return;
    }
    if (s.axis === 'dismiss') {
      if (dismissResult(Math.abs(dy), h)) onClose();
      else {
        setSlide(NO_PAN);
        setDim(1);
      }
      return;
    }
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const md = mouseDrag.current;
    if (md && e.pointerType === 'mouse') {
      mouseDrag.current = null;
      setGesture(false);
      // Щелчок после перетаскивания приходит следом и закрыл бы просмотр (по фону) — его пропускаем.
      if (md.moved) {
        swallowClick.current = performance.now() + 400;
        releasePan(performance.now());
      }
      return;
    }
    if (!fingers.current.has(e.pointerId)) return;
    const wasOnly = fingers.current.size === 1;
    if (wasOnly && drag.current) releasePan(performance.now());
    fingers.current.delete(e.pointerId);
    // Касание пальцем рождает ещё и щелчок: на телефоне тап по фону теперь прячет панель, а не закрывает (как у Telegram).
    swallowClick.current = performance.now() + 500;
    // Тап — палец не уходил и не задержался; и «по размеру», и на увеличенном (там двойной тап возвращает масштаб).
    const ts = touchStart.current;
    touchStart.current = null;
    const isTap = wasOnly && !!ts && !ts.moved && e.type !== 'pointercancel' && e.timeStamp - ts.t < 500;
    if (wasOnly) endSwipe(e);
    else swipe.current = null;
    if (isTap) onTap(e.clientX, e.clientY, e.timeStamp);
    restartGesture();
  };
  // Кнопки и клавиши сменили масштаб — сдвиг не уводит картинку за край (при «влезает» — снова посередине).
  useEffect(() => {
    setPan((p) => fitPan(p, zoom));
  }, [zoom, fitPan]);

  /** Подтянуть маленькую картинку к сцене — аватар 256×256 иначе теряется посреди чёрного поля. */
  const applyFit = useCallback(() => {
    const stage = stageRef.current;
    const el = imgRef.current;
    if (!stage || !el || !el.naturalWidth) return;
    const z = fitZoom({ w: el.naturalWidth, h: el.naturalHeight }, { w: stage.clientWidth, h: stage.clientHeight });
    baseZoom.current = z;
    setZoom(z);
  }, []);

  /**
   * Смена картинки: сбрасываем масштаб и сразу пробуем подогнать.
   *
   * ⚠️ Одним `onLoad` обойтись нельзя: у картинки из кэша событие успевает пройти ДО того, как React
   * повесит обработчик, — и тогда аватар остался бы в единице именно на повторном открытии, то есть
   * ровно в самом частом случае.
   */
  useEffect(() => {
    baseZoom.current = 1;
    setZoom(1);
    setPan(NO_PAN);
    setVideoFailed(false);
    setVideoReady(false);
    setRot(0);
    rotRef.current = 0;
    setFlip({ h: false, v: false });
    setLoopPick(null);
    setAutoLoop(false);
    setBoost(false);
    setMenu(null);
    hold.current = null;
    lastTap.current = null;
    applyFit();
  }, [index, applyFit]);

  // Дошли до края набора — лента подтягивает медиа беседы дальше (`onNearEdge`).
  useEffect(() => {
    const dir = nearMediaEdge(index, images.length);
    if (dir && onNearEdge) onNearEdge(dir);
  }, [index, images.length, onNearEdge]);

  useEffect(
    () => () => {
      if (tapTimer.current !== null) window.clearTimeout(tapTimer.current);
      window.clearTimeout(glideTimer.current);
      if (hold.current) window.clearTimeout(hold.current.timer);
    },
    [],
  );

  /**
   * «Повернуть» (G66, tdesktop `playbackControlsRotate`): −90° за нажатие. На четверти оборота картинка ужимается, чтобы
   * влезть в сцену (`rotateFit`), и это становится её «по размеру» — к нему возвращают Ctrl+0 и двойной тап.
   */
  const rotate = () => {
    const next = rotateStep(rotRef.current);
    const el = imgRef.current;
    const stage = stageRef.current;
    let base = baseZoom.current;
    if (el && stage && el.naturalWidth) {
      const cs = getComputedStyle(stage);
      const sw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const sh = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const z0 = fitZoom({ w: el.naturalWidth, h: el.naturalHeight }, { w: stage.clientWidth, h: stage.clientHeight });
      base = z0 * rotateFit(el.offsetWidth * z0, el.offsetHeight * z0, sw, sh, next);
    }
    rotRef.current = next;
    setRot(next);
    baseZoom.current = base;
    setZoom(base);
    setPan(NO_PAN);
  };

  // Видео (G33): пауза, перемотка, кадр, позиция, удержание Пробела — ×2, скорость, «Зациклить», «картинка в картинке».
  const applyRate = (r: number) => {
    videoSpeed = r;
    if (Math.abs(r - 1) > 1e-9) videoSpedUp = r;
    setRate(r);
    const v = videoRef.current;
    if (v && !hold.current?.boosting) v.playbackRate = r;
  };
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };
  const applyVideoKey = (a: VideoKeyAction) => {
    const v = videoRef.current;
    if (!v) return;
    if (a.kind === 'toggle') togglePlay();
    else if (a.kind === 'seek') v.currentTime = seekClamp(v.currentTime, a.by, v.duration);
    else if (a.kind === 'frame') v.currentTime = seekClamp(v.currentTime, a.dir * FRAME_STEP_S, v.duration);
    else if (Number.isFinite(v.duration) && v.duration > 0) v.currentTime = Math.min(v.duration, a.frac * v.duration);
  };
  /** Пробел нажат: коротко — пауза, держат дольше `SPEED_BOOST_HOLD_MS` — ×2, пока держат (tdesktop `startSpeedBoost`). */
  const holdStart = () => {
    if (hold.current) return;
    const h = { timer: 0, boosting: false };
    h.timer = window.setTimeout(() => {
      const v = videoRef.current;
      if (!v || hold.current !== h) return;
      h.boosting = true;
      v.playbackRate = SPEED_BOOST_RATE;
      if (v.paused) v.play().catch(() => {});
      setBoost(true);
    }, SPEED_BOOST_HOLD_MS);
    hold.current = h;
  };
  const holdEnd = () => {
    const h = hold.current;
    if (!h) return;
    hold.current = null;
    window.clearTimeout(h.timer);
    if (h.boosting) {
      if (videoRef.current) videoRef.current.playbackRate = videoSpeed;
      setBoost(false);
    } else togglePlay();
  };
  const seekHintTimer = useRef(0);
  /** Двойной тап пальцем по видео (телефон, Android `onDoubleTap`): левая треть — −10 с, правая — +10 с. */
  const onVideoPointerUp = (e: ReactPointerEvent<HTMLVideoElement>) => {
    if (!isFinger(e)) return;
    const v = e.currentTarget;
    const r = v.getBoundingClientRect();
    const side = videoTapSide(e.clientX - r.left, r.width);
    if (side !== 0 && isDoubleTap(videoTap.current, e.timeStamp, e.clientX, e.clientY)) {
      videoTap.current = null;
      const target = seekClamp(v.currentTime, side * VIDEO_SEEK_LONG_S, v.duration);
      v.currentTime = target;
      // Свой «двойной тап — 10 с» бывает и у плеера браузера на телефоне: прыгнул вторым — возвращаем на нашу точку.
      window.setTimeout(() => {
        if (Math.abs(v.currentTime - target) > 1) v.currentTime = target;
      }, 80);
      setSeekHint((h) => ({ side, n: (h?.n ?? 0) + 1 }));
      window.clearTimeout(seekHintTimer.current);
      seekHintTimer.current = window.setTimeout(() => setSeekHint(null), 700);
      return;
    }
    videoTap.current = { t: e.timeStamp, x: e.clientX, y: e.clientY };
  };
  const startPip = () => {
    const v = videoRef.current;
    if (!v || !img) return;
    openPip({ url: img.url, at: v.currentTime, rate: videoSpeed, loop }).then(
      () => {
        // Как у Telegram Desktop: видео ушло в окошко — просмотр закрывается, лента под рукой.
        v.pause();
        onClose();
      },
      () => toast('error', 'Не удалось открыть «Картинку в картинке»'),
    );
  };

  // Мышь замерла — панель гаснет (VD-22), шевельнули — вернулась. Над самой панелью не гаснет.
  const idleTimer = useRef<number | null>(null);
  const onMouseActivity = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    setIdle(false);
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    const overPanel = e.target instanceof Element && !!e.target.closest('.lb-top, .lb-bottom, .lb-nav');
    idleTimer.current = overPanel || e.buttons ? null : window.setTimeout(() => setIdle(true), IDLE_MS);
  };
  useEffect(
    () => () => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    },
    [],
  );

  /*
   * Колесо (VD-16, VD-17): без Ctrl — соседний файл, по одному на серию событий (тачпад шлёт их десятками); с Ctrl —
   * масштаб к курсору. Слушатель свой, не React: только так `preventDefault` срабатывает (React вешает колесо пассивным),
   * а без него Ctrl+колесо масштабировало бы всю страницу. Над миниатюрами колесо их и листает (у полосы своя прокрутка).
   */
  const wheel = useRef({ acc: 0, spent: false, lastStep: 0, timer: 0 });
  const wheelHandler = useRef<(e: WheelEvent) => void>(() => {});
  wheelHandler.current = (e: WheelEvent) => {
    if (e.target instanceof Element && e.target.closest('.lb-strip')) return;
    e.preventDefault();
    if (e.ctrlKey) {
      if (isVideo) return;
      zoomToPoint(wheelZoomStep(zoomRef.current, e.deltaY, ZMIN, ZMAX), { x: e.clientX, y: e.clientY });
      return;
    }
    const w = wheel.current;
    window.clearTimeout(w.timer);
    w.timer = window.setTimeout(() => {
      w.acc = 0;
      w.spent = false;
    }, 160);
    const now = performance.now();
    if (w.spent && now - w.lastStep < 350) return;
    const r = wheelPageStep(w.spent ? 0 : w.acc, e.deltaX, e.deltaY, e.deltaMode);
    w.spent = false;
    w.acc = r.acc;
    if (!r.step) return;
    w.spent = true;
    w.lastStep = now;
    go(r.step);
  };
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const fn = (e: WheelEvent) => wheelHandler.current(e);
    el.addEventListener('wheel', fn, { passive: false });
    return () => {
      el.removeEventListener('wheel', fn);
      window.clearTimeout(wheel.current.timer);
    };
  }, []);

  const keysRef = useRef({ menuItems: [] as LightboxAction[], applyVideoKey, holdStart, holdEnd });
  useEffect(() => {
    const k = () => keysRef.current;
    const runItem = (id: ViewerMenuId) => {
      const it = k().menuItems.find((x) => x.id === id);
      if (it) it.run();
      return !!it;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isVideo && e.code === 'Space') {
        e.preventDefault();
        k().holdEnd();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      // Фокус на плеере видео: стрелки — его перемотка, а не соседний файл.
      const onPlayer = e.target instanceof HTMLVideoElement;
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        // Открыто меню — Esc закрывает его, а не просмотр.
        if (menuOpen.current) setMenu(null);
        else onClose();
        return;
      }
      if (menuOpen.current) return;
      // Ctrl+S — «Сохранить как…», Ctrl+C — «Копировать» (tdesktop `handleKeyPress`: `QKeySequence::Save`, `Key_C && ctrl`).
      if (ctrl && !e.altKey && e.code === 'KeyS') {
        e.preventDefault();
        runItem('save');
        return;
      }
      if (ctrl && !e.altKey && e.code === 'KeyC' && !window.getSelection()?.toString()) {
        if (runItem('copy')) e.preventDefault();
        return;
      }
      const v = isVideo ? videoRef.current : null;
      if (v && e.code === 'Space' && !ctrl && !e.altKey) {
        // Пробел у плеера свой (пауза при нажатии) — забираем: короткое нажатие — пауза, удержание — ×2.
        e.preventDefault();
        if (!e.repeat) k().holdStart();
        return;
      }
      const act = v ? videoKeyAction(e.code, { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey }, v.paused) : null;
      if (act) {
        e.preventDefault();
        k().applyVideoKey(act);
        return;
      }
      if (onPlayer) return;
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      else if (e.key === 'ArrowRight' && index < images.length - 1) onIndex(index + 1);
      else if (isVideo) return;
      else if (!ctrl && !e.altKey && (e.code === 'KeyH' || e.code === 'KeyV')) {
        // Зеркало (tdesktop: H / V), по коду клавиши — и в русской раскладке.
        const axis = e.code === 'KeyH' ? 'h' : 'v';
        setFlip((f) => ({ ...f, [axis]: !f[axis] }));
      } else if (e.ctrlKey && e.key === '0') {
        // Ctrl+0 — сброс к «по размеру» (VD-17); без `preventDefault` браузер сбросил бы масштаб всей страницы.
        e.preventDefault();
        setZoom(baseZoom.current);
        setPan(NO_PAN);
      } else if (e.key === '+' || e.key === '=') {
        if (e.ctrlKey) e.preventDefault();
        setZoom((z) => Math.min(ZMAX, +(z + 0.25).toFixed(2)));
      } else if (e.key === '-') {
        if (e.ctrlKey) e.preventDefault();
        setZoom((z) => Math.max(ZMIN, +(z - 0.25).toFixed(2)));
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [index, images.length, onClose, onIndex, isVideo]);

  // «Скачать» на ПК (G31): тот же ход, что у карточки в ленте (`jobKey`), — кольцо с отменой на кнопке и «пришло / всего».
  const dlTarget: DownloadTarget | null = img?.downloadUrl
    ? {
        key: img.jobKey || img.downloadUrl,
        url: img.downloadUrl,
        name: img.name,
        size: img.size,
        type: img.type || (img.video ? 'video/mp4' : 'image/jpeg'),
      }
    : null;
  const dlKey = dlTarget?.key ?? '';
  const dlJob = useSyncExternalStore(subscribeFileJobs, () => (dlKey ? fileJobOf(dlKey) : null));
  // Пункты «⋯» / ПКМ: от вызывающего (к сообщению, копировать, переслать, удалить) + «Сохранить как…» по ссылке «Скачать».
  const menuItems: LightboxAction[] = img
    ? orderViewerMenu([
        ...(actions?.(img, index) ?? []),
        ...(img.downloadUrl
          ? [{ id: 'save' as const, icon: 'download' as const, label: phone ? 'Сохранить' : 'Сохранить как…', run: () => (dlTarget && ringDownloads() ? startDownload(dlTarget) : dlRef.current?.click()) }]
          : []),
        // «Поделиться» (G10): системное окно браузера с самим файлом — где `navigator.canShare({ files })` (Edge, Chrome на
        // Windows, браузер телефона); нет — пункта нет. Приложение Android — свой натив (меню сообщения).
        ...(img.downloadUrl && dlTarget && canShareFiles()
          ? [
              {
                id: 'share' as const,
                icon: 'share' as const,
                label: 'Поделиться',
                run: () => {
                  const url = img.downloadUrl ?? '';
                  void shareDownload(dlTarget, (n) => setSaveNote({ ...n, url }));
                },
              },
            ]
          : []),
      ])
    : [];
  keysRef.current = { menuItems, applyVideoKey, holdStart, holdEnd };
  /** Открыть меню у точки (ПКМ) или под кнопкой «⋯», не вылезая за окно. */
  const openMenuAt = (x: number, y: number) => {
    const w = 248;
    const h = menuItems.length * 40 + 12;
    setMenu({ x: Math.max(8, Math.min(x, window.innerWidth - w - 8)), y: y + h > window.innerHeight - 8 ? Math.max(8, y - h) : y });
  };
  const runMenu = (id: ViewerMenuId) => menuItems.find((x) => x.id === id)?.run();

  if (!img) return null;

  // Подпись собирается из того, что известно: назначение картинки, вес файла, место в наборе.
  // Для одиночной картинки «1 из 1» — шум, поэтому счётчик появляется только у набора.
  const sub = [img.sub, img.size != null ? kb(img.size) : null, images.length > 1 ? `${index + 1} из ${images.length}` : null]
    .filter(Boolean)
    .join(' · ');
  // Вложение сообщения (G10): «отправитель» крупно, ниже «дата · вес · N из M»; дата ведёт к сообщению.
  const date = img.at ? viewerDate(img.at) : '';
  // Ход «Скачать» — того файла, с которого его начали (листнули дальше — у соседа своя подпись).
  const saving = saveNote && saveNote.url === img.downloadUrl ? saveNote : null;
  const note = saving?.text || (dlJob?.kind === 'download' ? `Скачивание… ${progressText(dlJob.loaded, dlJob.total)}` : '') || (isVideo && videoFailed ? 'Видео не воспроизводится — его можно скачать' : '') || sub;
  // Смахивание вниз прячет панель на время жеста (Telegram).
  const bare = bareTap || idle || dim < 1;
  const pannable = !isVideo && canPan();
  const [stripFrom, stripTo] = stripWindow(images.length, index);
  // Смахивание вниз: фон светлеет за пальцем (тот же цвет, что у `.lightbox`, прозрачнее).
  const rootStyle: CSSProperties | undefined = dim < 1 ? { backgroundColor: `rgba(10, 9, 13, ${(0.93 * dim).toFixed(3)})` } : undefined;

  return createPortal(
    <div
      className={bare ? 'lightbox lb-bare' : 'lightbox'}
      ref={rootRef}
      style={rootStyle}
      onClick={() => {
        // Открыто меню — щелчок мимо закрывает только его.
        if (menu) {
          setMenu(null);
          return;
        }
        // Щелчок по фону и по самому фото закрывает просмотр (G66, tdesktop: щелчок без перетаскивания — `close()`).
        if (performance.now() < swallowClick.current) return;
        onClose();
      }}
      onContextMenu={(e) => {
        // ПКМ — то же меню, что «⋯» (G10, tdesktop). Долгое нажатие пальцем — нет: на телефоне меню у кнопки «⋯».
        if (lastTouch.current || menuItems.length === 0) return;
        if (e.target instanceof Element && e.target.closest('.lb-menu')) return;
        e.preventDefault();
        openMenuAt(e.clientX, e.clientY);
      }}
      onPointerMove={onMouseActivity}
      onPointerDown={onMouseActivity}
    >
      <div
        className="lb-top"
        onClick={(e) => {
          e.stopPropagation();
          if (menu) setMenu(null);
        }}
      >
        <div className="lb-meta">
          {img.from ? (
            <button
              type="button"
              className="lb-name lb-link"
              title="Профиль"
              disabled={!onAuthor}
              onClick={(e) => onAuthor?.(index, e)}
            >
              {img.from}
            </button>
          ) : (
            <div className="lb-name">{img.name}</div>
          )}
          {date && note === sub ? (
            <div className="lb-sub">
              <button type="button" className="lb-link" title="Перейти к сообщению" onClick={() => runMenu('goto')}>
                {date}
              </button>
              {sub ? ` · ${sub}` : ''}
            </div>
          ) : (
            note && <div className="lb-sub">{note}</div>
          )}
        </div>
        {/* Видео (G33): скорость 0,5–2,5× (кнопка голосовых со своей скоростью), «Зациклить», «картинка в картинке» (Р-3). */}
        {isVideo && <VoiceSpeedButton value={rate} onChange={applyRate} spedUp={videoSpedUp} />}
        {isVideo && (
          <button
            type="button"
            className={loop ? 'lb-btn on' : 'lb-btn'}
            title="Зациклить"
            aria-pressed={loop}
            onClick={() => setLoopPick(!loop)}
          >
            <Icon name="repeat" size={18} />
          </button>
        )}
        {isVideo && pipSupported() && (
          <button type="button" className="lb-btn" title="Картинка в картинке" onClick={startPip}>
            <Icon name="pip" size={18} />
          </button>
        )}
        {/* «Повернуть» (G66) — у фото; у видео родные кнопки плеера повернулись бы вместе с кадром. */}
        {!isVideo && (
          <button type="button" className="lb-btn" title="Повернуть" onClick={rotate}>
            <Icon name="rotate" size={18} />
          </button>
        )}
        {/* downloadUrl = the backend force-download endpoint; the bare `download` attribute is
            a no-op cross-origin (MinIO lives on another host), so it alone never saved anything.
            Нет такого маршрута — кнопки нет: она увела бы картинку в соседнюю вкладку вместо того,
            чтобы сохранить файл. Правый клик по картинке («Сохранить изображение») остаётся.
            Приложение на телефоне: `download` в WebView молча ничего не делает — файл кладёт натив, с 06.10 в «Загрузки»
            (`fileActions.downloadInApp`, ход — строкой под именем); без моста ссылка живёт как была. */}
        {img.downloadUrl && (
          <a
            ref={dlRef}
            className="lb-btn"
            // Телефон: «Сохранить» — в меню «⋯» (верх у Telegram Android — только «⋯»), ссылка остаётся ему для щелчка.
            hidden={phone}
            href={img.downloadUrl}
            download={img.name}
            title={dlJob ? 'Отменить загрузку' : 'Скачать'}
            onClick={(e) => {
              const url = img.downloadUrl;
              if (!url) return;
              // Уже качается — второй раз не начинаем.
              if (saving && !saving.final) {
                e.preventDefault();
                return;
              }
              const type = img.type || (img.video ? 'video/mp4' : 'image/jpeg');
              if (downloadInApp(url, img.name, type, (n) => setSaveNote({ ...n, url }))) {
                e.preventDefault();
                return;
              }
              // ПК (G31): страницей, с кольцом на кнопке; повторный щелчок — отмена.
              if (dlTarget && ringDownloads()) {
                e.preventDefault();
                toggleDownload(dlTarget);
              }
            }}
          >
            {dlJob ? <ProgressRing ratio={progressRatio(dlJob.loaded, dlJob.total)} /> : <Icon name="download" size={18} />}
          </a>
        )}
        {menuItems.length > 0 && (
          <button
            type="button"
            className="lb-btn"
            title="Ещё"
            aria-haspopup="menu"
            aria-expanded={!!menu}
            onClick={(e) => {
              if (menu) {
                setMenu(null);
                return;
              }
              const r = e.currentTarget.getBoundingClientRect();
              openMenuAt(r.right - 248, r.bottom + 4);
            }}
          >
            <Icon name="more" size={18} />
          </button>
        )}
        <button type="button" className="lb-btn" title="Закрыть" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>

      {/* Пальцы — щипок, сдвиг увеличенного, листание, смахивание и тапы; мышь — перетаскивание увеличенного.
          `touch-action: none` у сцены — жест не забирает браузер. Щелчок по фону закрывает (обработчик корня). */}
      <div
        className={`lb-stage${isVideo ? ' video' : ''}${sliding ? ' sliding' : ''}${pannable ? ' pannable' : ''}${img.caption ? ' has-caption' : ''}`}
        ref={stageRef}
        style={slide.x || slide.y ? { transform: `translate(${slide.x}px, ${slide.y}px)` } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {isVideo ? (
          /* Видео: играет сразу и со звуком (нажатие, открывшее просмотр, — жест человека; в приложении Android WebView
             автозапуск разрешён оболочкой), `preload="metadata"` — дальше браузер качает по ходу просмотра. `key` —
             новый плеер на каждый файл: листнули — прежний остановился вместе со своим элементом. Прозрачный постер —
             как в ленте: до первого кадра WebView иначе рисует свою серую заглушку с ▶ (`VideoAttachment`). */
          <video
            key={img.url}
            ref={videoRef}
            className="lb-img lb-video"
            src={img.url}
            poster={BLANK_POSTER}
            controls
            autoPlay
            playsInline
            preload="metadata"
            loop={loop}
            controlsList={nativeMediaAvailable() ? 'nodownload nofullscreen' : 'nodownload'}
            onLoadedMetadata={(e) => {
              // Смена файла сбрасывает скорость — ставим выбранную; короткое видео — по кругу (Web A, до 30 с).
              const v = e.currentTarget;
              v.defaultPlaybackRate = videoSpeed;
              v.playbackRate = videoSpeed;
              setAutoLoop(Number.isFinite(v.duration) && v.duration <= AUTO_LOOP_MAX_S);
            }}
            onRateChange={(e) => {
              // Скорость сменили в меню самого плеера — кнопка показывает то же. Удержание Пробела (×2) — не выбор.
              const r = e.currentTarget.playbackRate;
              if (!hold.current?.boosting && Math.abs(r - videoSpeed) > 1e-9) applyRate(r);
            }}
            onLoadedData={() => setVideoReady(true)}
            onError={() => setVideoFailed(true)}
            onClick={(e) => e.stopPropagation()}
            onPointerUp={onVideoPointerUp}
          />
        ) : (
          /* data-ctxsave: контент — правый клик оставляет «Сохранить изображение» (#75). `draggable={false}` — мышь
             тащит увеличенное фото, а не призрак картинки браузера. */
          <img
            className={`lb-img${gesture ? ' gesture' : ''}${glide ? ' glide' : ''}`}
            data-ctxsave
            ref={imgRef}
            src={img.url}
            alt={img.name}
            draggable={false}
            onLoad={applyFit}
            style={{
              transform: `${pan.x || pan.y ? `translate(${pan.x}px, ${pan.y}px) ` : ''}${rot ? `rotate(${rot}deg) ` : ''}scale(${zoom})${flip.h || flip.v ? ` scale(${flip.h ? -1 : 1}, ${flip.v ? -1 : 1})` : ''}`,
            }}
          />
        )}
        {/* Крутилка — общая `.confirm-spin` (её гасят игровой и лёгкий режимы), пока у видео нет первого кадра. */}
        {isVideo && !videoReady && !videoFailed ? <span className="confirm-spin lb-spin" aria-hidden="true" /> : null}
      </div>
      {/* Удержание Пробела — ×2 (tdesktop: плашка скорости сверху), двойной тап у края — «−10 с» / «+10 с». */}
      {isVideo && boost ? (
        <div className="lb-boost" aria-live="polite">
          {SPEED_BOOST_RATE}×
          <Icon name="skip-forward" size={14} />
        </div>
      ) : null}
      {isVideo && seekHint ? (
        <div key={seekHint.n} className={seekHint.side < 0 ? 'lb-seek-hint left' : 'lb-seek-hint right'} aria-hidden="true">
          {seekHint.side < 0 ? `−${VIDEO_SEEK_LONG_S} с` : `+${VIDEO_SEEK_LONG_S} с`}
        </div>
      ) : null}
      {/* Подпись к фото (G10) — текст сообщения, над миниатюрами; длинная прокручивается. */}
      {img.caption ? (
        <div className="lb-caption" onClick={(e) => e.stopPropagation()}>
          {img.caption}
        </div>
      ) : null}

      {index > 0 && (
        <button
          type="button"
          className="lb-nav prev"
          title="Назад"
          onClick={(e) => {
            e.stopPropagation();
            onIndex(index - 1);
          }}
        >
          <Icon name="chevron-right" size={22} className="lb-flip" />
        </button>
      )}
      {index < images.length - 1 && (
        <button
          type="button"
          className="lb-nav next"
          title="Вперёд"
          onClick={(e) => {
            e.stopPropagation();
            onIndex(index + 1);
          }}
        >
          <Icon name="chevron-right" size={22} />
        </button>
      )}

      <div
        className="lb-bottom"
        onClick={(e) => {
          e.stopPropagation();
          if (menu) setMenu(null);
        }}
      >
        {images.length > 1 && (
          <div className="lb-strip">
            {/* Только соседи текущей (`stripWindow`): медиатека беседы бывает в сотни файлов. */}
            {images.slice(stripFrom, stripTo).map((im, k) => {
              const i = stripFrom + k;
              return (
                <button
                  type="button"
                  key={i}
                  className={`lb-thumb ${i === index ? 'active' : ''}`}
                  onClick={() => onIndex(i)}
                  title={im.name}
                >
                  {im.video ? (
                    <>
                      <video src={videoFrameSrc(im.url)} poster={BLANK_POSTER} preload="metadata" muted playsInline tabIndex={-1} />
                      <span className="lb-thumb-play" aria-hidden="true">
                        <Icon name="play" size={10} />
                      </span>
                    </>
                  ) : (
                    <img src={im.url} alt="" draggable={false} />
                  )}
                </button>
              );
            })}
          </div>
        )}
        {/* Масштаб — только у фото: у видео свой плеер. */}
        {!isVideo && (
          <div className="lb-zoom">
            <button
              type="button"
              title="Уменьшить"
              disabled={zoom <= ZMIN}
              onClick={() => setZoom((z) => Math.max(ZMIN, +(z - 0.25).toFixed(2)))}
            >
              <Icon name="minus" size={17} />
            </button>
            <span className="lb-zoom-val">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              title="Увеличить"
              disabled={zoom >= ZMAX}
              onClick={() => setZoom((z) => Math.min(ZMAX, +(z + 0.25).toFixed(2)))}
            >
              <Icon name="plus" size={17} />
            </button>
          </div>
        )}
      </div>
      {menu && menuItems.length > 0 ? (
        <div className="ctx-menu lb-menu" role="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menuItems.map((a) => (
            <MenuItem
              key={a.id}
              icon={a.icon}
              label={a.label}
              danger={a.danger}
              onClick={() => {
                setMenu(null);
                a.run();
              }}
            />
          ))}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
