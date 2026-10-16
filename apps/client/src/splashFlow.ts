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

export interface SplashDeps {
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

  const t0 = deps.now();
  deps.show({ stage: 'checking', version: null, progress: null });
  deps.ping();
  let update: SplashUpdate | null = null;
  try {
    const r = await Promise.race([deps.check(), deps.sleep(t.checkTimeoutMs).then(() => TIMEOUT)]);
    update = r === TIMEOUT ? null : (r as SplashUpdate | null);
  } catch (e) {
    console.warn('[splash] update check failed (starting current version):', e);
    update = null;
  }
  await holdUntil(t0 + t.checkMinMs);
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
