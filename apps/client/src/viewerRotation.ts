import { PHONE_LAYOUT_QUERY, setPhoneLayoutPin } from './phoneLayout';

/**
 * Поворот экрана в полноэкранном просмотре фото, видео и стрима. Приложение на телефоне закреплено в
 * портрете (`MainActivity.onCreate`), а пока открыт просмотр, оболочка снимает закреп — экран следует датчику с учётом
 * системного «автоповорота», как окно Telegram Android (активность без фиксации; `PhotoViewer` сам ставит альбомную только
 * кнопкой «во весь экран» у видео и по закрытию возвращает прежнюю, `PhotoViewer.java:6062`/`:18154`). Закрыли — портрет.
 *
 * `Lightbox` и просмотр галереи вложений рисуются порталом прямо в `<body>`. Полноэкранный стрим остаётся внутри голосовой
 * сцены и держит поворот через `holdViewerRotation()`. Возвращаем портрет после закрытия последнего просмотра.
 * Мост — `GusVoiceNative.setViewerRotation(on)`; ответ `true` — закреп действует (телефон),
 * и на время просмотра держим телефонную раскладку (`setPhoneLayoutPin`): в альбомной окно шире 760 px. Планшет, браузер,
 * десктоп, старая оболочка без метода — ничего не делаем (Fullscreen API и `screen.orientation.lock` не трогаем).
 */
const VIEWER_LAYERS = ':scope > .lightbox, :scope > .pick-viewer';
/** Портрет не вернулся (поворот выключен, датчик молчит) — всё равно отпустить раскладку, мс. */
const UNPIN_FALLBACK_MS = 2500;

interface NativeRotation {
  setViewerRotation?: (on: boolean) => boolean;
}

function bridge(): NativeRotation | undefined {
  return (window as unknown as { GusVoiceNative?: NativeRotation }).GusVoiceNative;
}

/** Открыт ли полноэкранный просмотр среди детей `root` (обычно `<body>`). */
export function viewerOpen(root: ParentNode): boolean {
  return !!root.querySelector(VIEWER_LAYERS);
}

let held = false;
let pinned = false;
let stopUnpin: (() => void) | null = null;
const inlineViewers = new Set<symbol>();

function cancelUnpin(): void {
  stopUnpin?.();
  stopUnpin = null;
}

/** Снять закреп раскладки, когда окно снова узкое (вернулся портрет), — иначе компьютерная раскладка мелькнула бы на повороте. */
function releasePin(): void {
  if (!pinned) return;
  const mq = window.matchMedia(PHONE_LAYOUT_QUERY);
  const done = () => {
    cancelUnpin();
    pinned = false;
    setPhoneLayoutPin(false);
  };
  if (mq.matches) return done();
  const onChange = () => {
    if (mq.matches) done();
  };
  const timer = window.setTimeout(done, UNPIN_FALLBACK_MS);
  mq.addEventListener('change', onChange);
  stopUnpin = () => {
    window.clearTimeout(timer);
    mq.removeEventListener('change', onChange);
  };
}

function hold(on: boolean): void {
  if (held === on) return;
  held = on;
  let locked = false;
  try {
    locked = bridge()?.setViewerRotation?.(on) === true;
  } catch {
    /* оболочка без метода */
  }
  if (on) {
    cancelUnpin();
    if (locked && !pinned && window.matchMedia(PHONE_LAYOUT_QUERY).matches) {
      pinned = true;
      setPhoneLayoutPin(true);
    }
  } else releasePin();
}

function sync(): void {
  hold(inlineViewers.size > 0 || viewerOpen(document.body));
}

/** Разрешить поворот просмотрщику, который остаётся в своём дереве компонентов. */
export function holdViewerRotation(): (() => void) | undefined {
  if (typeof bridge()?.setViewerRotation !== 'function') return;
  const viewer = Symbol();
  inlineViewers.add(viewer);
  sync();
  return () => {
    inlineViewers.delete(viewer);
    sync();
  };
}

/** Подключить на старте (`main.tsx`). Только в оболочке Android с методом моста. */
export function installViewerRotation(): void {
  const native = bridge();
  if (typeof native?.setViewerRotation !== 'function' || typeof MutationObserver !== 'function' || !document.body) return;
  // Страница перезагрузилась с открытым просмотром — оболочка осталась без закрепа: вернуть портрет.
  try {
    native.setViewerRotation(false);
  } catch {
    /* оболочка без метода */
  }
  new MutationObserver(sync).observe(document.body, { childList: true });
  sync();
}
