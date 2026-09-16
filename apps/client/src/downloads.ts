/**
 * Desktop downloads: where files go, and what the user sees when they land.
 *
 * Chat attachments are plain links to the backend's force-download endpoint (Content-Disposition:
 * attachment). In the browser that's fine — the browser picks a folder, shows its own download UI and
 * lets you change the destination. Inside the Tauri desktop app WebView2 swallows all of it: the file
 * lands in Загрузки with NO shelf, NO "saved" hint, nothing at all on failure, and no way to choose
 * anywhere else, so a download is indistinguishable from a dead button.
 *
 * The shell (wire_download_notifications in lib.rs) mirrors WebView2's download lifecycle into events
 * and asks US for the destination:
 *   • folder known   → the shell redirects the file there and we toast the result
 *   • folder unknown → the shell CANCELS the download and emits `gv-download-need-dir`; we open the OS
 *                      folder picker and re-issue the request once the user has chosen
 * The client owns the persisted folder (localStorage); the shell keeps a mirror of it only so its
 * DownloadStarting handler — which must answer synchronously — can read it without calling into JS.
 * Self-gates to desktop: on web every function here is a no-op and the browser keeps doing its thing.
 */
import { onDownloadEvents, pickFolder, setNativeDownloadDir, type DownloadAsk } from './desktopWindow';
import { toast } from './toast';

const DIR_KEY = 'gv_download_dir';

/** The chosen downloads folder, or null = not chosen yet (the next download will ask). */
export function getDownloadDir(): string | null {
  return localStorage.getItem(DIR_KEY) || null;
}

/** Persist the folder and mirror it into the shell. null clears it (back to "ask me"). */
export function setDownloadDir(dir: string | null): void {
  if (dir) localStorage.setItem(DIR_KEY, dir);
  else localStorage.removeItem(DIR_KEY);
  setNativeDownloadDir(dir);
}

/** Open the OS folder picker and remember the choice. Returns the folder, or null if cancelled. */
export async function chooseDownloadDir(): Promise<string | null> {
  const dir = await pickFolder('Куда сохранять файлы из GusVoice', getDownloadDir());
  if (dir) setDownloadDir(dir);
  return dir;
}

/**
 * Re-issue a download the shell cancelled for lack of a folder. A fresh <a> click is the same path the
 * attachment button takes, so WebView2 raises DownloadStarting again — this time with a folder to use.
 * (`download` is ignored cross-origin; the endpoint's Content-Disposition is what makes it a download.)
 */
function reissue(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

let asking = false;
const queued: DownloadAsk[] = [];

/** One picker for a burst of downloads: everything asked while the dialog is open replays after it. */
async function handleNeedDir(ask: DownloadAsk): Promise<void> {
  queued.push(ask);
  if (asking) return;
  asking = true;
  try {
    // Only explain when the folder USED to work — a picker appearing mid-download would be baffling
    // otherwise. The first-time case needs no toast: the dialog's own title says what it's for.
    if (ask.lost) {
      toast('warn', 'Папка для загрузок недоступна', `${getDownloadDir() ?? ''} — выберите другую`);
    }
    const dir = await chooseDownloadDir();
    const batch = queued.splice(0);
    if (!dir) {
      const what = batch.length > 1 ? `${batch.length} файл(ов)` : (batch[0]?.name ?? '');
      toast('error', 'Скачивание отменено', `${what} — папка для загрузок не выбрана`);
      return;
    }
    toast('success', 'Папка для загрузок выбрана', `${dir} · изменить — Настройки → Десктоп`);
    batch.forEach((q) => reissue(q.url, q.name));
  } finally {
    asking = false;
  }
}

let started = false;

/** Idempotent: safe to call on every mount (App.tsx boot effect). */
export function initDownloads(): void {
  if (started) return;
  started = true;
  // Hand the shell the folder we already know about — it starts every run with none.
  setNativeDownloadDir(getDownloadDir());
  onDownloadEvents({
    // Only the terminal states are toasted: attachments are usually small, so a "started" toast would
    // fire and be replaced a blink later. The started event still exists for a future progress UI.
    done: (d) => toast('success', 'Файл скачан', d.dir ? `${d.name} → ${d.dir}` : d.name),
    failed: (d) => toast('error', 'Не удалось скачать файл', `${d.name} — загрузка прервана`),
    needDir: (a) => void handleNeedDir(a),
  });
}
