/**
 * Заставка при запуске десктопа (как у Discord, 15.10) — ход этапов без DOM и без Tauri.
 *
 * Окно `index.html?window=splash` (`tauri.windows.conf.json`, `splash.rs`) показывает гуся и строку этапа:
 * «Проверяю обновления…» → нет обновления → «Запускаю…» → главное окно; есть → «Скачиваю обновление X» с
 * процентом → «Устанавливаю…» → установщик в тихом режиме закрывает приложение и запускает новую версию.
 *
 * 🔴 Этапы обязаны быть ВИДНЫ (жалоба владельца: скачивание проходит за доли секунды, и человек видел
 * только окно установщика). Поэтому у каждого этапа минимальное время на экране (`SPLASH_TIMING`), а полоса
 * скачивания доезжает до 100 % не быстрее `downloadMinMs`, даже если файл пришёл мгновенно. Но запуск БЕЗ
 * обновления не тормозит больше ~1.6 с: проверка ≥1.2 с + «Запускаю…» 0.4 с.
 *
 * Ошибка/таймаут проверки (нет сети, фид недоступен) — молча «Запускаю…»: заставка запуск не блокирует.
 * Сломалось скачивание или установка — то же самое, приложение стартует на текущей версии.
 *
 * 🔴 Обновление «в один проход» (26.10, жалоба владельца: «Обновить» в открытом приложении давало ДВА круга
 * «Проверяю обновления…»). Запуск размечается заранее (`SplashIntent`, метки в localStorage — `updater.ts`):
 * - `update` — перезапуск ради обновления (кнопка «Обновить», `applyPendingUpdate`): обновление уже известно,
 *   поэтому сразу «Скачиваю обновление vX…», а `check()` за handle идёт молча под этим этапом, без минимума;
 * - `justUpdated` — первый запуск только что поставленной версии: проверки нет, только «Запускаю…»;
 * - `normal` — как раньше.
 *
 * Все зависимости — параметры (`SplashDeps`): так ход проверяется в Node без окон и настоящего времени.
 */

export type SplashStage = 'checking' | 'starting' | 'downloading' | 'installing';

export interface SplashView {
  stage: SplashStage;
  /** Версия, которую качаем/ставим (только для downloading/installing). */
  version: string | null;
  /** Показанная доля скачивания 0…1 (уже с плавным доездом), null — неизвестна. */
  progress: number | null;
}

/** Минимальные времена этапов и пределы, мс. */
export const SPLASH_TIMING = {
  /** «Проверяю обновления…» на экране не короче этого. */
  checkMinMs: 1200,
  /** Проверка дольше — считаем, что обновлений нет (сети нет / фид лежит). */
  checkTimeoutMs: 4000,
  /** «Запускаю…» перед показом главного окна. */
  startMinMs: 400,
  /** Полоса скачивания доезжает до 100 % не быстрее этого. */
  downloadMinMs: 2000,
  /** «Устанавливаю…» на экране до запуска установщика. */
  installMinMs: 1200,
  /** Скачивание без единого байта прогресса столько — бросаем и запускаемся на текущей версии. */
  stallMs: 45_000,
  /** Шаг перерисовки полосы. */
  tickMs: 50,
} as const;

export type SplashTiming = { -readonly [K in keyof typeof SPLASH_TIMING]: number };

/** Событие скачивания плагина обновлений (подмножество `DownloadEvent`). */
export type SplashDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

export interface SplashUpdate {
  version: string;
  download(onEvent: (e: SplashDownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
}

/**
 * Чем размечен запуск (26.10, «в один проход»): `update` — перезапуск ради уже найденного обновления
 * (`version` — что показать до ответа фида), `justUpdated` — первый запуск только что установленной версии,
 * `normal` — обычный запуск.
 */
export type SplashIntent = { kind: 'normal' } | { kind: 'update'; version: string } | { kind: 'justUpdated'; version: string };

/** Сырые значения меток из localStorage (`updater.ts`: `takeSplashMarkers`/`peekSplashMarkers`). */
export interface SplashMarkers {
  /** `gv:update-on-relaunch` — JSON `{ version, at }`: «Обновить» перезапустило приложение ради обновления. */
  relaunch: string | null;
  /** `gv:installed-update` — версия, которую только что поставил апдейтер (ставится вместе с `gv:just-updated`). */
  installed: string | null;
}

/** Метка «перезапуск ради обновления» старше этого — застряла (перезапуск не случился): обычный запуск. */
export const RELAUNCH_UPDATE_TTL_MS = 2 * 60_000;

function parseRelaunch(raw: string | null, nowMs: number): string | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { version?: unknown; at?: unknown };
    if (typeof v.version !== 'string' || !v.version || typeof v.at !== 'number') return null;
    const age = nowMs - v.at;
    return age >= 0 && age <= RELAUNCH_UPDATE_TTL_MS ? v.version : null;
  } catch {
    return null;
  }
}

/**
 * Разметка запуска по меткам. `current` — версия запущенного приложения (null — не узнали).
 * `justUpdated` — ТОЛЬКО если поставленная версия совпала с текущей: метка от сорвавшейся установки (версия
 * чужая) проверку не отключает. `update` — свежая метка (≤ `RELAUNCH_UPDATE_TTL_MS`) с версией, отличной от
 * текущей (совпала — обновление уже стоит, проверяем как обычно).
 */
export function splashIntent(m: SplashMarkers, current: string | null, nowMs: number): SplashIntent {
  if (m.installed && current !== null && m.installed === current) return { kind: 'justUpdated', version: current };
  const relaunch = parseRelaunch(m.relaunch, nowMs);
  if (relaunch && relaunch !== current) return { kind: 'update', version: relaunch };
  return { kind: 'normal' };
}

/**
 * Первый кадр заставки — до того, как узнали версию приложения (иначе на долю секунды мелькает
 * «Проверяю обновления…»). Догадка по меткам; ход (`runSplashFlow`) её сразу поправит, если не подтвердится.
 */
export function initialSplashView(m: SplashMarkers, nowMs: number): SplashView {
  if (m.installed) return { stage: 'starting', version: null, progress: null };
  const relaunch = parseRelaunch(m.relaunch, nowMs);
  if (relaunch) return { stage: 'downloading', version: relaunch, progress: 0 };
  return { stage: 'checking', version: null, progress: null };
}

export interface SplashDeps {
  /** Разметка запуска (26.10). Нет или бросила — обычный запуск. */
  intent?(): Promise<SplashIntent> | SplashIntent;
  /** Проверка фида; null — обновлений нет. Может бросить. */
  check(): Promise<SplashUpdate | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Отрисовать этап. */
  show(view: SplashView): void;
  /** Признак жизни для страховки в Rust (`gv_splash_ping`). */
  ping(): void;
  /** Перед установщиком: штатно погасить показ и оставить метку «обновлён до X». */
  beforeInstall(version: string): Promise<void>;
  /** Установка сорвалась — снять метку «обновлён до X». */
  installFailed(): void;
  /** Показать главное окно и закрыть заставку (`gv_splash_done`). */
  done(): Promise<void> | void;
  timing?: Partial<SplashTiming>;
}

/** Показанная доля скачивания: не больше настоящей и не быстрее `minMs` от начала. Настоящая неизвестна
 *  (`null`) — едем по времени, но до конца не доезжаем (0.9), пока скачивание не закончится. */
export function shownDownloadFraction(real: number | null, elapsedMs: number, minMs: number, finished: boolean): number {
  const byTime = minMs > 0 ? Math.max(0, elapsedMs) / minMs : 1;
  const realPart = finished ? 1 : real === null ? 0.9 : real;
  return Math.max(0, Math.min(1, byTime, realPart));
}

const TIMEOUT = Symbol('timeout');

/**
 * Весь ход заставки. Возвращает, чем кончилось: `started` — главное окно показано; `installing` —
 * установщик запущен (на Windows до возврата обычно не доходит: плагин сам закрывает процесс).
 */
export async function runSplashFlow(deps: SplashDeps): Promise<'started' | 'installing'> {
  const t = { ...SPLASH_TIMING, ...deps.timing };
  const holdUntil = async (at: number) => {
    const left = at - deps.now();
    if (left > 0) await deps.sleep(left);
  };
  const start = async (): Promise<'started'> => {
    deps.show({ stage: 'starting', version: null, progress: null });
    deps.ping();
    await deps.sleep(t.startMinMs);
    await deps.done();
    return 'started';
  };

  let intent: SplashIntent = { kind: 'normal' };
  try {
    intent = (await deps.intent?.()) ?? intent;
  } catch (e) {
    console.warn('[splash] launch intent unknown (normal launch):', e);
  }
  // Первый запуск только что поставленной версии: проверять нечего — сразу «Запускаю…».
  if (intent.kind === 'justUpdated') return start();

  const checkFeed = async (): Promise<SplashUpdate | null> => {
    try {
      const r = await Promise.race([deps.check(), deps.sleep(t.checkTimeoutMs).then(() => TIMEOUT)]);
      return r === TIMEOUT ? null : (r as SplashUpdate | null);
    } catch (e) {
      console.warn('[splash] update check failed (starting current version):', e);
      return null;
    }
  };

  let update: SplashUpdate | null = null;
  if (intent.kind === 'update') {
    // Перезапуск ради обновления: оно уже найдено — без этапа проверки, handle берём молча под «Скачиваю».
    deps.show({ stage: 'downloading', version: intent.version, progress: 0 });
    deps.ping();
    update = await checkFeed();
  } else {
    const t0 = deps.now();
    deps.show({ stage: 'checking', version: null, progress: null });
    deps.ping();
    update = await checkFeed();
    await holdUntil(t0 + t.checkMinMs);
  }
  if (!update) return start();

  const version = update.version;
  let marked = false;
  try {
    // Скачивание: настоящая доля копится в событиях, на экран — плавно (не быстрее downloadMinMs).
    let total = 0;
    let got = 0;
    let finished = false;
    let failed: unknown = null;
    let lastProgressAt = deps.now();
    const t1 = deps.now();
    const real = () => (total > 0 ? Math.min(1, got / total) : null);
    deps.show({ stage: 'downloading', version, progress: 0 });
    deps.ping();
    void update
      .download((e) => {
        lastProgressAt = deps.now();
        if (e.event === 'Started') total = e.data.contentLength ?? 0;
        else if (e.event === 'Progress') got += e.data.chunkLength;
        else if (e.event === 'Finished') finished = true;
      })
      .then(
        () => {
          finished = true;
        },
        (e: unknown) => {
          failed = e ?? new Error('download failed');
        },
      );
    let lastPing = deps.now();
    for (;;) {
      if (failed) throw failed;
      const now = deps.now();
      if (!finished && now - lastProgressAt > t.stallMs) throw new Error('download stalled');
      const shown = shownDownloadFraction(real(), now - t1, t.downloadMinMs, finished);
      deps.show({ stage: 'downloading', version, progress: shown });
      if (now - lastPing >= 1000) {
        deps.ping();
        lastPing = now;
      }
      if (finished && shown >= 1) break;
      await deps.sleep(t.tickMs);
    }

    const t2 = deps.now();
    deps.show({ stage: 'installing', version, progress: null });
    deps.ping();
    await deps.beforeInstall(version);
    marked = true;
    await holdUntil(t2 + t.installMinMs);
    deps.ping();
    await update.install();
    // На Windows сюда не доходим (плагин закрывает процесс сам). Вернулись — установщик отработал без
    // выхода (другая ОС): не держим человека без окна, новая версия подхватится при следующем запуске.
    await deps.done();
    return 'installing';
  } catch (e) {
    console.warn('[splash] update failed (starting current version):', e);
    if (marked) deps.installFailed();
    return start();
  }
}
