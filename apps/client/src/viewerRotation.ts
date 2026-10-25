import { PHONE_LAYOUT_QUERY, setPhoneLayoutPin } from './phoneLayout';

/**
 * Поворот экрана в полноэкранном просмотре фото и видео (19.10, просьба владельца). Приложение на телефоне закреплено в
 * портрете (`MainActivity.onCreate`), а пока открыт просмотр, оболочка снимает закреп — экран следует датчику с учётом
 * системного «автоповорота», как окно Telegram Android (активность без фиксации; `PhotoViewer` сам ставит альбомную только
 * кнопкой «во весь экран» у видео и по закрытию возвращает прежнюю, `PhotoViewer.java:6062`/`:18154`). Закрыли — портрет.
 *
 * Счётчик держателей — сами слои просмотра в `<body>`: `Lightbox` (ленты ЛС и каналов, одноразовые, медиатека, отложенные,
 * аватары, предпросмотр отправки) и просмотр галереи вложений рисуются порталом прямо в `<body>`, поэтому наблюдатель только
 * за детьми `<body>` видит любой вход, включая «назад» Android, смену экрана и размонтирование, и два открытых подряд не
 * возвращают портрет друг у друга. Мост — `GusVoiceNative.setViewerRotation(on)`; ответ `true` — закреп действует (телефон),
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
  const sync = () => hold(viewerOpen(document.body));
  new MutationObserver(sync).observe(document.body, { childList: true });
  sync();
}
