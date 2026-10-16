import { isDesktop } from './hotkeys';
import { toast } from './toast';
import { useUpdate } from './updateStore';
import { SPLASH_TIMING } from './splashFlow';

/** localStorage marker: set to the installed version right after a successful update, consumed once
 *  on the next launch to show the "обновлён до vX" heads-up. */
const UPDATED_KEY = 'gv:just-updated';

/** How often to re-check for a newer build while the app stays open. */
const POLL_MS = 30 * 60 * 1000; // 30 minutes

/** Typed handle for a pending update (no value import — the plugin is loaded dynamically). */
type UpdateHandle = NonNullable<Awaited<ReturnType<(typeof import('@tauri-apps/plugin-updater'))['check']>>>;

let pendingUpdate: UpdateHandle | null = null;
let snoozedVersion: string | null = null; // version we won't re-offer (user pressed "Позже", or it's already installed)
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Штатно завершить нативный показ, пока процесс ещё жив (#112/#109, найдено 25.09).
 *
 * 🔴 Установщик обновления на Windows закрывает приложение сам, мимо штатного выхода, — как и
 * перезапуск. Метка «показ идёт» (`screenshare-active`) при этом уцелевала, и следующий показ
 * считал, что приложение УПАЛО: снимал слои качества на этот показ, а три обновления посреди
 * показа подряд выключали их НАСОВСЕМ. При наших частых релизах это и было одной из дорог, по
 * которым слои пропали у половины показывающих. Поймал владелец: обновился посреди показа —
 * следующий показ «идёт одним слоем».
 *
 * Импорт динамический: модуль показа тянет стор и Tauri, а порядок загрузки модулей мы уже ломали.
 * Любая ошибка — молча: обновление важнее.
 *
 * `stopShare` — шов для тестов (просьба Codex, 26.09): по умолчанию настоящая остановка, в Node её
 * подменяют, чтобы проверить порядок «сначала показ, потом установка/перезапуск» без Tauri.
 */
export async function endShareBeforeExit(stopShare: () => Promise<void> = stopNativeShareLazily): Promise<void> {
  try {
    await stopShare();
  } catch {
    /* не мешаем обновлению и перезапуску */
  }
}

/** Настоящая остановка показа: модуль показа грузится только в момент вызова (см. выше). */
async function stopNativeShareLazily(): Promise<void> {
  const { stopNativeShareIfActive } = await import('./nativeShareSession');
  await stopNativeShareIfActive();
}

/** Настоящий перезапуск процесса: плагин Tauri грузится только в момент вызова. */
async function relaunchLazily(): Promise<void> {
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

/** Поставить метку «обновлён до X» (её покажет следующий запуск, `notifyIfJustUpdated`). Ставится ДО
 *  `install()`: на Windows установщик закрывает приложение изнутри `install()`, и строка после него не
 *  выполнялась никогда — тост «обновлён до» на Windows не появлялся (найдено 15.10, заставка). */
export function markJustUpdated(version: string): void {
  try {
    localStorage.setItem(UPDATED_KEY, version);
  } catch {
    /* localStorage unavailable — skip the marker, never block the update */
  }
}

/** Снять метку, если установка сорвалась (приложение осталось на прежней версии). */
export function unmarkJustUpdated(): void {
  try {
    localStorage.removeItem(UPDATED_KEY);
  } catch {
    /* ignore */
  }
}

/** Сколько этапы карточки обновления держатся на экране минимум (15.10): скачивание проходило за доли
 *  секунды, и карточку никто не видел. Те же числа, что у заставки (`SPLASH_TIMING`). */
export const PANEL_DOWNLOAD_MIN_MS = SPLASH_TIMING.downloadMinMs;
export const PANEL_INSTALL_MIN_MS = SPLASH_TIMING.installMinMs;

/** Время и пауза — швы для тестов (по умолчанию настоящие). */
export interface UpdatePace {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
const realPace: UpdatePace = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Download + install a known-available update with progress, then 'ready' (awaiting relaunch). Stamps
 *  the just-updated marker so the next launch shows the persistent heads-up. Throws on failure.
 *  Экспортирована с `stopShare` ради теста порядка (показ гасится ДО `install()`); приложение зовёт её
 *  с одним аргументом — остановка настоящая. `pace` — шов времени: этап «скачивание» держится на экране
 *  не меньше `PANEL_DOWNLOAD_MIN_MS` (полосу плавно доводит `UpdatePanel`), «установка» —
 *  `PANEL_INSTALL_MIN_MS` до запуска установщика. */
export async function downloadAndInstall(
  update: Pick<UpdateHandle, 'download' | 'install' | 'version'>,
  stopShare: () => Promise<void> = stopNativeShareLazily,
  pace: UpdatePace = realPace,
): Promise<void> {
  const { set } = useUpdate.getState();
  const t0 = pace.now();
  set({ phase: 'downloading', version: update.version, downloaded: 0, total: 0, startedAt: Date.now(), dlDone: false });
  await update.download((e) => {
    const st = useUpdate.getState();
    if (e.event === 'Started') set({ total: e.data.contentLength ?? 0, downloaded: 0 });
    else if (e.event === 'Progress') set({ downloaded: st.downloaded + e.data.chunkLength });
    else if (e.event === 'Finished') set({ downloaded: st.total || st.downloaded });
  });
  set({ downloaded: useUpdate.getState().total || useUpdate.getState().downloaded, dlDone: true });
  const dlLeft = t0 + PANEL_DOWNLOAD_MIN_MS - pace.now();
  if (dlLeft > 0) await pace.sleep(dlLeft);
  const t1 = pace.now();
  set({ phase: 'installing' });
  // На Windows `install()` сам закрывает приложение — показ завершаем ДО него (см. выше).
  await endShareBeforeExit(stopShare);
  const instLeft = t1 + PANEL_INSTALL_MIN_MS - pace.now();
  if (instLeft > 0) await pace.sleep(instLeft);
  // Метка — ДО `install()`: на Windows из него не возвращаются (см. `markJustUpdated`).
  markJustUpdated(update.version);
  try {
    await update.install();
  } catch (e) {
    unmarkJustUpdated();
    throw e;
  }
  set({ phase: 'ready' });
  pendingUpdate = null;
  snoozedVersion = update.version; // already installed — don't let the 30-min poll re-offer it
}

/**
 * LAUNCH path — silent auto-update. On startup, check our signed endpoint and, if a newer build exists,
 * download + install it in the background, then surface the "Обновление установлено · Перезапустить" card.
 * This is the "приложение само обновляется при перезапуске" behaviour. No-op on web (`isDesktop()`).
 *
 * Fail-safe: a failed CHECK (offline) stays quiet (idle); a failed download/install shows the error card.
 */
export async function runDesktopUpdateCheck(): Promise<void> {
  if (!isDesktop()) return;
  const { set } = useUpdate.getState();
  let update: UpdateHandle | null = null;
  try {
    set({ phase: 'checking' });
    const { check } = await import('@tauri-apps/plugin-updater');
    update = await check();
  } catch (e) {
    console.warn('[updater] launch check failed (offline?):', e);
    set({ phase: 'idle' }); // quiet — don't nag on a failed check
    return;
  }
  if (!update?.available) {
    set({ phase: 'idle' });
    return;
  }
  try {
    await downloadAndInstall(update);
  } catch (e) {
    console.warn('[updater] launch install failed (continuing on current version):', e);
    set({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Проверка при запуске — с учётом заставки (15.10). В Windows-сборке её делает окно заставки
 * (`SplashScreen`, `splash.rs` → `gv_launch_splash`), и главное окно второй раз не проверяет. Заставки
 * нет (другая сборка, команда не ответила) — как раньше, `runDesktopUpdateCheck`. `hadSplash` — шов для тестов.
 */
export async function runLaunchUpdate(hadSplash: () => Promise<boolean> = launchHadSplash): Promise<void> {
  if (!isDesktop()) return;
  let splash = false;
  try {
    splash = await hadSplash();
  } catch {
    splash = false;
  }
  if (!splash) await runDesktopUpdateCheck();
}

/** `launchHadSplash` без исключений: команды нет / не Tauri — «заставки нет». */
async function hadSplashSafe(): Promise<boolean> {
  try {
    return await launchHadSplash();
  } catch {
    return false;
  }
}

async function launchHadSplash(): Promise<boolean> {
  const core = (window as unknown as { __TAURI__?: { core?: { invoke: (c: string) => Promise<unknown> } } }).__TAURI__?.core;
  if (!core) return false;
  return (await core.invoke('gv_launch_splash')) === true;
}

/**
 * POLL path — non-intrusive OFFER. Runs every 30 min while open. If a newer build exists, park the
 * handle and flip the store to 'available' so UpdatePanel shows a small "Доступно обновление vX —
 * Обновить / Позже" card; it does NOT download or install on its own (the user accepts via
 * applyPendingUpdate). Skips while a launch update is already downloading/installing/ready or another
 * offer is on screen. Background failures stay quiet (idle), never popping an error card.
 */
async function checkForUpdateOffer(): Promise<void> {
  if (!isDesktop()) return;
  const { phase, set } = useUpdate.getState();
  if (phase === 'available' || phase === 'downloading' || phase === 'installing' || phase === 'ready') return;
  try {
    set({ phase: 'checking' });
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update?.available) {
      pendingUpdate = null;
      set({ phase: 'idle' });
      return;
    }
    if (update.version === snoozedVersion) {
      set({ phase: 'idle' }); // user said "later" for this version, or it's already installed
      return;
    }
    pendingUpdate = update;
    set({ phase: 'available', version: update.version, notes: update.body ?? null, viaSplash: await hadSplashSafe() });
  } catch (e) {
    console.warn('[updater] background check failed:', e);
    set({ phase: 'idle' });
  }
}

/**
 * MANUAL check — the Settings → Десктоп "Проверить обновления" button. Unlike the silent launch/poll
 * paths this ALWAYS gives feedback: it flips to the 'available' offer card if a newer build exists
 * (ignoring a prior "Позже"), or shows a success toast when you're already on the latest. Desktop-only.
 */
export async function manualUpdateCheck(): Promise<void> {
  if (!isDesktop()) return;
  const { phase, set } = useUpdate.getState();
  if (phase === 'downloading' || phase === 'installing' || phase === 'ready') return; // don't interrupt
  try {
    set({ phase: 'checking' });
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update?.available) {
      set({ phase: 'idle' });
      toast('success', 'У вас последняя версия', 'Обновлений не найдено');
      return;
    }
    snoozedVersion = null; // the user explicitly asked — re-offer even a version they snoozed
    pendingUpdate = update;
    set({ phase: 'available', version: update.version, notes: update.body ?? null, viaSplash: await hadSplashSafe() });
  } catch (e) {
    console.warn('[updater] manual check failed:', e);
    set({ phase: 'idle' });
    toast('error', 'Не удалось проверить обновления', 'Проверьте интернет-соединение');
  }
}

/**
 * Download + install the OFFERED update (UpdatePanel's "Обновить" button), then offer restart.
 * Fail-safe → 'error' phase (app keeps running). The launch path uses downloadAndInstall directly.
 */
export async function applyPendingUpdate(
  hadSplash: () => Promise<boolean> = hadSplashSafe,
  restart: () => Promise<void> = relaunchApp,
): Promise<void> {
  if (!isDesktop() || !pendingUpdate) return;
  // 16.10 (владелец: «всё в заставке», как Discord): в сборке с заставкой открытое приложение обновление
  // только ПРЕДЛАГАЕТ, а качает и ставит его заставка после перезапуска — один показ на всё, с гусём-админом.
  // Раньше карточка качала и ставила сама, а заставка новой версии потом «проверяла» впустую — два показа подряд.
  if (await hadSplash()) {
    await restart();
    return;
  }
  const update = pendingUpdate;
  try {
    await downloadAndInstall(update);
  } catch (e) {
    console.warn('[updater] update failed (continuing on current version):', e);
    useUpdate.getState().set({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
  }
}

/** Dismiss the current offer ("Позже"): hide the card and don't re-offer this exact version until a
 *  newer one ships (or the app restarts). Keeps the 30-min checks quiet but not blind. */
export function snoozeUpdate(): void {
  const { version, set } = useUpdate.getState();
  snoozedVersion = version;
  set({ phase: 'idle' });
}

/**
 * Start the 30-min background OFFER poll (desktop only). Note: the FIRST check happens at launch via
 * runDesktopUpdateCheck (silent auto-update); this only adds the periodic, non-intrusive offer for
 * builds published mid-session. Idempotent.
 */
export function startUpdatePolling(): void {
  if (!isDesktop() || pollTimer) return;
  pollTimer = setInterval(() => void checkForUpdateOffer(), POLL_MS);
}

/**
 * If a previous session installed an update, show a STICKY toast once on this launch so the user knows
 * they're now on a fresh build. Persistent (no auto-dismiss) but non-blocking — a bottom-right heads-up
 * they close with ✕ when they're ready. Desktop-only; consumes the marker so it shows once.
 *
 * NB: the FIRST build carrying this code can't show its own arrival (the old binary that installed it
 * didn't write the marker) — the heads-up starts from the next update onward.
 */
export function notifyIfJustUpdated(): void {
  if (!isDesktop()) return;
  try {
    const ver = localStorage.getItem(UPDATED_KEY);
    if (!ver) return;
    localStorage.removeItem(UPDATED_KEY);
    toast('success', `GusVoice обновлён до v${ver}`, 'Установлена последняя версия', { sticky: true });
  } catch {
    /* localStorage unavailable — skip the heads-up, never break startup */
  }
}

/** Relaunch into the freshly-installed build. Called from the UpdatePanel's "Перезапустить" button.
 *  `stopShare`/`relaunch` — швы для теста порядка (показ гасится ДО перезапуска); кнопка зовёт без
 *  аргументов — работают настоящие. */
export async function relaunchApp(
  stopShare: () => Promise<void> = stopNativeShareLazily,
  relaunch: () => Promise<void> = relaunchLazily,
): Promise<void> {
  try {
    await endShareBeforeExit(stopShare);
    await relaunch();
  } catch (e) {
    console.warn('[updater] relaunch failed:', e);
  }
}
