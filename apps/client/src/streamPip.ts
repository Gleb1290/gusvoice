/**
 * Чужой показ в окошке «картинка в картинке» поверх всех окон (#222, вариант Б — окошко со своими кнопками).
 *
 * Основной путь — окно документа (`documentPictureInPicture.requestWindow`, Chromium/WebView2): в него
 * копируем стили страницы и рисуем React-порталом (`components/StreamPipView.tsx`, хост — в `VoiceConnection`,
 * который смонтирован, пока мы в голосе). Как у Telegram Desktop (`media/view/media_view_pip.cpp`): в окошке
 * «закрыть» и «развернуть обратно», двойной клик — тоже обратно.
 *
 * Запасной путь — окошко у `<video>` того же живого потока (`videoPip.openStreamVideoPip`): API окна документа
 * нет или окно не открылось (в десктопе обвязка пока отвечает `Internal error: no window`). Кнопок там нет —
 * окошко рисует браузер.
 *
 * Окошко одно на всё приложение. В окне документа — до `PIP_MAX` показов сразу (#223): ⧉ при открытом окне
 * добавляет показ в него, пятый вытесняет самый старый; в запасном окошке у `<video>` — один показ, новый
 * заменяет старый. Какие показы в окошке — `pipStreams` в сторе; звук и слой им дают как открытым на сцене
 * (`streamPipRules.streamsInView`, `wantedLayer(..., { inPip })`).
 * Правила без DOM — `streamPipRules.ts`.
 */
import { useSyncExternalStore } from 'react';
import { isAndroid } from './hotkeys';
import { useStore } from './store';
import { parsePipSize, PIP_MAX, STREAM_PIP_SIZE_KEY, streamPipButtonShown, streamPipSize, type PipSize } from './streamPipRules';
import { closeStreamVideoPip, openStreamVideoPip, pipSupported } from './videoPip';

interface DocumentPip extends EventTarget {
  requestWindow(opts?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}

function documentPip(): DocumentPip | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture ?? null;
}

/** Показ — живая дорожка: всё, что нужно запасному пути от `TrackReference`. */
export interface PipTrackRef {
  participant: { identity: string };
  publication?: { track?: { mediaStreamTrack?: MediaStreamTrack } } | undefined;
}

let pipWindow: Window | null = null;
/** Снять слушателей окна и вернуть всё как было; зовётся один раз на окно. */
let releaseWindow: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Окно документа с окошком показа или `null` (нет окошка или открыт запасной путь). */
export function useStreamPipWindow(): Window | null {
  return useSyncExternalStore(
    subscribe,
    () => pipWindow,
    () => null,
  );
}

/** Есть ли где показать кнопку: не Android и есть хоть один путь. */
export function streamPipAvailable(): boolean {
  return streamPipButtonShown({ android: isAndroid(), documentPip: !!documentPip(), videoPip: pipSupported() });
}

function readSize(): PipSize | null {
  try {
    return parsePipSize(localStorage.getItem(STREAM_PIP_SIZE_KEY));
  } catch {
    return null;
  }
}

function saveSize(w: Window): void {
  try {
    if (w.innerWidth > 0 && w.innerHeight > 0) {
      localStorage.setItem(STREAM_PIP_SIZE_KEY, JSON.stringify({ width: w.innerWidth, height: w.innerHeight }));
    }
  } catch {
    /* хранилище недоступно — в следующий раз откроется размер по умолчанию */
  }
}

/** Атрибуты корня (тема, классы, переменные в `style`) — один в один, плюс метка документа окошка. */
function copyRootAttrs(to: Document): void {
  const from = document.documentElement;
  const root = to.documentElement;
  for (const a of Array.from(root.attributes)) if (!from.hasAttribute(a.name)) root.removeAttribute(a.name);
  for (const a of Array.from(from.attributes)) root.setAttribute(a.name, a.value);
  root.classList.add('gv-stream-pip-doc');
  to.body.className = document.body.className;
}

/**
 * Стили страницы — в окно: `<link rel=stylesheet>` (адрес — абсолютный: у окна свой документ) и `<style>`
 * (в разработке Vite кладёт стили так). Тема меняется на лету — следим за атрибутами корня.
 */
function adoptStyles(to: Window): () => void {
  const head = to.document.head;
  for (const node of Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))) {
    const copy = node.cloneNode(true) as HTMLElement;
    if (node instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = node.href;
    head.appendChild(copy);
  }
  copyRootAttrs(to.document);
  if (typeof MutationObserver === 'undefined') return () => {};
  const obs = new MutationObserver(() => copyRootAttrs(to.document));
  obs.observe(document.documentElement, { attributes: true });
  obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return () => obs.disconnect();
}

function takeWindow(w: Window, identity: string): void {
  const stopStyles = adoptStyles(w);
  const onHide = () => {
    // Окно закрыли крестиком системы, нашей кнопкой или заменили новым — забываем его ровно один раз.
    if (pipWindow !== w) return;
    saveSize(w);
    stopStyles();
    w.removeEventListener('pagehide', onHide);
    pipWindow = null;
    releaseWindow = null;
    // Окно одно — вместе с ним уходят все его показы.
    useStore.getState().clearPipStreams();
    emit();
  };
  w.addEventListener('pagehide', onHide);
  pipWindow = w;
  releaseWindow = onHide;
  const st = useStore.getState();
  st.clearPipStreams();
  st.addPipStream(identity, PIP_MAX);
  emit();
}

/**
 * Открыть показ `t` в окошке. Звать прямо из нажатия: оба API требуют жест человека. Окно документа уже
 * открыто — показ ДОБАВЛЯЕТСЯ в него (#223, без нового `requestWindow`; пятый вытесняет самый старый).
 * Иначе открытое запасное окошко закрывается и открывается новое. Не вышло ни одним путём — бросает.
 */
export async function openStreamPip(t: PipTrackRef): Promise<void> {
  const identity = t.participant.identity;
  if (pipWindow && !pipWindow.closed) {
    useStore.getState().addPipStream(identity, PIP_MAX);
    return;
  }
  const api = documentPip();
  // Окно документа одно на страницу: повторный `requestWindow` сам закрывает прежнее. Наше «закрыть»
  // зовём заранее, чтобы стор не увидел два показа сразу.
  closeStreamPip();
  if (api) {
    try {
      const screen = typeof window.screen === 'object' ? { width: window.screen.availWidth, height: window.screen.availHeight } : null;
      const size = streamPipSize(readSize(), screen);
      // Десктоп (#222): обвязка Tauri пускает окно только по одноразовому разрешению (`pip.rs`), и размер окна
      // WebView2 из `requestWindow` не передаёт — отдаём его здесь. В вебе `__TAURI__` нет, вызова нет.
      await armDesktopPip(size);
      const w = await api.requestWindow(size);
      takeWindow(w, identity);
      return;
    } catch {
      /* окно документа не открылось (десктоп: `Internal error: no window`) — запасной путь ниже */
    }
  }
  const track = t.publication?.track?.mediaStreamTrack;
  if (!track) throw new Error('stream pip: no track');
  // Запасное окошко — один показ: в сторе только он.
  const st = useStore.getState();
  st.clearPipStreams();
  st.addPipStream(identity, PIP_MAX);
  const forget = () => {
    const now = useStore.getState();
    if (!pipWindow && now.pipStreams.includes(identity)) now.removePipStream(identity);
  };
  try {
    await openStreamVideoPip(new MediaStream([track]), forget);
  } catch (e) {
    forget();
    throw e;
  }
}

/**
 * Убрать показ `id` из окошка (#223). Последний в окне документа или показ запасного окошка — окошко
 * закрывается целиком; иначе остальные показы остаются в окне.
 */
export function removeFromStreamPip(id: string): void {
  const st = useStore.getState();
  if (!st.pipStreams.includes(id)) return;
  if (!pipWindow || st.pipStreams.length <= 1) {
    closeStreamPip();
    return;
  }
  st.removePipStream(id);
}

/** Закрыть окошко показа, каким бы путём оно ни было открыто. */
export function closeStreamPip(): void {
  const w = pipWindow;
  if (w) {
    releaseWindow?.();
    try {
      w.close();
    } catch {
      /* окно уже закрыто */
    }
    return;
  }
  closeStreamVideoPip();
  useStore.getState().clearPipStreams();
}

interface TauriWindowApi {
  getCurrentWindow?: () => { unminimize?: () => Promise<void>; show?: () => Promise<void>; setFocus?: () => Promise<void> };
}

/**
 * Вернуть главное окно на передний план. В вебе — `window.focus()` (браузер может и не послушаться — окно
 * хотя бы мигнёт на панели задач). В десктопе дополнительно пробуем окно Tauri: развернуть, показать,
 * сфокусировать (порядок — как у второго запуска, `desktop.md`); нет прав — молча остаёмся на `focus()`.
 */
/** Десктоп: взвести разрешение на одно окно PiP (`gv_pip_arm`, действует 1,5 с). Нет команды/не десктоп — ничего. */
async function armDesktopPip(size: { width: number; height: number }): Promise<void> {
  const core = (window as unknown as { __TAURI__?: { core?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } } })
    .__TAURI__?.core;
  if (!core) return;
  await core.invoke('gv_pip_arm', { width: size.width, height: size.height }).catch(() => {});
}

export function focusMainWindow(): void {
  try {
    window.focus();
  } catch {
    /* нечего фокусировать */
  }
  const tw = (window as unknown as { __TAURI__?: { window?: TauriWindowApi } }).__TAURI__?.window?.getCurrentWindow?.();
  if (!tw) return;
  void (async () => {
    try {
      await tw.unminimize?.();
      await tw.show?.();
      await tw.setFocus?.();
    } catch {
      /* у окна нет разрешения на эти команды — хватит и `focus()` */
    }
  })();
}
