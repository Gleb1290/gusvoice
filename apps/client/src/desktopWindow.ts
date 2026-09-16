/**
 * Desktop-only window/tray behaviour. The Tauri shell intercepts the window's close (X) button,
 * prevents the default close, and emits `gv-close-requested`; the web client decides what to do
 * based on the user's preference (свернуть в трей / выйти / спросить).
 */
import { isDesktop } from './hotkeys';

export type CloseBehavior = 'ask' | 'tray' | 'quit';
const KEY = 'gv_close_behavior';

type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
function core(): TauriCore | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core ?? null;
}
type TauriEvent = {
  listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
};
function ev(): TauriEvent | null {
  return (window as unknown as { __TAURI__?: { event?: TauriEvent } }).__TAURI__?.event ?? null;
}

export function getCloseBehavior(): CloseBehavior {
  const v = localStorage.getItem(KEY);
  return v === 'tray' || v === 'quit' ? v : 'ask';
}
export function setCloseBehavior(b: CloseBehavior): void {
  if (b === 'ask') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, b);
}

/** Hide the window to the tray. */
export function hideToTray(): void {
  core()
    ?.invoke('gv_window_hide')
    .catch(() => {});
}
/** Quit the app entirely. */
export function quitApp(): void {
  core()
    ?.invoke('gv_app_quit')
    .catch(() => {});
}

/**
 * Open a URL in the OS default browser via the native shell (#40 Steam login). We MUST NOT navigate
 * the main WebView to an external origin — that drops the app's per-origin localStorage and looks like
 * a logout + settings reset (#43) — and `window.open` is a silent no-op in WebView2. Rejects if the
 * native command is missing (older build) so callers can surface an error instead of failing silently.
 */
export async function openExternal(url: string): Promise<void> {
  const c = core();
  if (!c) throw new Error('нативный вызов недоступен');
  await c.invoke('gv_open_external', { url });
}

/**
 * Installed desktop app version (tauri.conf.json "version", e.g. "0.5.62") — what the updater
 * compares against. Uses the built-in app plugin's `version` command (allowed via core:default),
 * so no extra npm dep. Null on web or if the invoke fails.
 */
export async function appVersion(): Promise<string | null> {
  const c = core();
  if (!c) return null;
  try {
    return (await c.invoke('plugin:app|version')) as string;
  } catch {
    return null;
  }
}

/** Native download lifecycle payload — mirrors DownloadInfo in the Tauri shell (lib.rs). */
export type DownloadInfo = { name: string; dir: string; path: string };

/**
 * Shell asking where to put a file: emitted INSTEAD of downloading when no folder is configured
 * (`lost: false`) or the configured one is gone/unwritable (`lost: true`). Mirrors DownloadAsk in lib.rs.
 * The download was cancelled — the client re-issues it by `url` after the user picks a folder.
 */
export type DownloadAsk = { url: string; name: string; lost: boolean };

/**
 * Open the OS folder picker (tauri-plugin-dialog). Resolves to the chosen path, or null if the user
 * cancelled / we're on web. Kept in JS on purpose: the plugin owns the COM apartment and modal loop, so
 * no dialog is ever shown from the WebView2 event-loop thread (that wedge froze the app in v0.5.38).
 */
export async function pickFolder(title: string, defaultPath?: string | null): Promise<string | null> {
  const c = core();
  if (!isDesktop() || !c) return null;
  try {
    const r = await c.invoke('plugin:dialog|open', {
      options: { directory: true, multiple: false, recursive: false, title, defaultPath: defaultPath || undefined },
    });
    // The plugin returns a path, null on cancel — and an array only if `multiple` were set.
    return typeof r === 'string' && r ? r : null;
  } catch {
    return null;
  }
}

/**
 * Mirror the downloads folder into the shell so its DownloadStarting handler can read it synchronously.
 * Pass null to clear it (back to "ask on the next download"). The client stays the source of truth —
 * the shell deliberately doesn't persist this.
 */
export function setNativeDownloadDir(dir: string | null): void {
  core()
    ?.invoke('gv_set_download_dir', { dir })
    .catch(() => {});
}

/**
 * Subscribe to native download events. WebView2 saves chat attachments SILENTLY inside our window —
 * no download shelf, no "saved" hint, and no error either — so the shell hooks DownloadStarting and
 * mirrors each download's state here (wire_download_notifications). Returns a teardown fn.
 * No-op on web, where the browser already renders its own download UI.
 */
export function onDownloadEvents(handlers: {
  started?: (d: DownloadInfo) => void;
  done?: (d: DownloadInfo) => void;
  failed?: (d: DownloadInfo) => void;
  needDir?: (a: DownloadAsk) => void;
}): () => void {
  const e = ev();
  if (!isDesktop() || !e?.listen) return () => {};
  const uns: Array<() => void> = [];
  let disposed = false;
  const sub = <T>(event: string, fn?: (d: T) => void) => {
    if (!fn) return;
    void e.listen(event, (ce) => fn(ce.payload as T)).then((u) => (disposed ? u() : uns.push(u)));
  };
  sub<DownloadInfo>('gv-download-started', handlers.started);
  sub<DownloadInfo>('gv-download-done', handlers.done);
  sub<DownloadInfo>('gv-download-failed', handlers.failed);
  sub<DownloadAsk>('gv-download-need-dir', handlers.needDir);
  return () => {
    disposed = true;
    uns.forEach((u) => u());
  };
}

/** Subscribe to the native "X was clicked" event. Returns a teardown fn (no-op on web). */
export function onCloseRequested(handler: () => void): () => void {
  const e = ev();
  if (!isDesktop() || !e?.listen) return () => {};
  let un: (() => void) | null = null;
  let disposed = false;
  void e
    .listen('gv-close-requested', () => {
      /**
       * 🔴 **Сначала подтверждаем, что взялись, и только потом решаем** (#125).
       * Нативная сторона перехватывает крестик и отдаёт решение сюда. Если интерфейс мёртв,
       * слушать некому — и раньше окно становилось НЕЗАКРЫВАЕМЫМ, оставался диспетчер задач.
       * Теперь нативная сторона ждёт этого подтверждения и без него закрывается сама.
       * ⚠️ Подтверждение уходит ДО показа выбора «в трей или выйти»: оно означает «я взялся», а
       * не «я решил», иначе раздумья человека выглядели бы как смерть интерфейса.
       */
      core()
        ?.invoke('gv_close_ack')
        .catch(() => {});
      handler();
    })
    .then((u) => (disposed ? u() : (un = u)));
  return () => {
    disposed = true;
    un?.();
  };
}
