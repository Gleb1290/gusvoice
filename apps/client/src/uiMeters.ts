/**
 * Счётчики нагрузки ИНТЕРФЕЙСА для диагностики (#193).
 *
 * 🔴 **Зачем.** Телеметрия 20.09 показала: на машине тестера процессы отрисовки съедали 26 % машины,
 * пока человек просто сидел в голосе и играл (наше окно перекрыто игрой), и 41 % — когда показывал
 * экран. Сам показ при этом стоил 8,7 %. То есть дорого обходится рисование, а ЧТО именно там
 * крутится — по коду видно лишь списком подозреваемых. Гадать нельзя: подозреваемых четыре, и
 * чинить не того значит выкатить людям правку, которая ничего не даст.
 *
 * Меряем три вещи, каждая отвечает на свой вопрос:
 *  * `vad_ms` — сколько миллисекунд ушло на определение «кто говорит» (тик 20 раз в секунду на
 *    каждого участника). Главный подозреваемый в покое.
 *  * `long_ms` / `long_max_ms` — длинные задачи главного потока (>50 мс) за тот же отрезок: сколько
 *    всего и самая долгая. Это уже не «кто виноват», а «насколько плохо» — и ровно они превращаются
 *    в рывки картинки у того, кто в игре.
 *  * `hidden` / `focused` — считает ли страница себя скрытой и есть ли у неё фокус. 🔴 Ключевая
 *    проверка гипотезы: окно, перекрытое полноэкранной игрой, скорее всего считает себя ВИДИМЫМ, и
 *    тогда все тормоза движка «для фоновых вкладок» просто не включаются.
 *
 * ⚠️ Счётчики накапливаются между срезами и обнуляются чтением (`takeUiMeters`), как `Meters::diff`
 * в нативной части: среднее за всё время сгладило бы ровно те всплески, ради которых всё и затеяно.
 */

interface UiMeters {
  /** Суммарное время в тике «кто говорит», мс. */
  vad_ms: number;
  /** Сколько раз тик отработал — без него `vad_ms` не переводится в «сколько стоит один». */
  vad_ticks: number;
  /** Сколько дорожек слушал анализатор на последнем тике (по человеку на дорожку). */
  vad_tracks: number;
  /** Суммарная длительность длинных задач главного потока, мс. */
  long_ms: number;
  /** Самая долгая из них, мс. */
  long_max_ms: number;
  /** Сколько их было. */
  long_count: number;
  /** Страница считает себя скрытой (свёрнуто), 1/0. */
  hidden: number;
  /** У страницы есть фокус, 1/0. */
  focused: number;
  /**
   * Сколько кадров отрисовки браузер выдал за ОКНО ВЫБОРКИ (см. `frames_ms`).
   *
   * 🔴 Считается короткими выборками, а не постоянно. Первая версия крутила самопланирующийся цикл
   * отрисовки всё время — и тем САМА заставляла браузер рисовать кадр за кадром, даже когда рисовать
   * нечего. Замер добавлял ровно ту нагрузку, которую мерил: у человека с показом расход вырос на
   * два пункта, и это была не беда, а наш счётчик. Теперь окно выборки короткое и редкое.
   */
  frames: number;
  /** Длительность окна выборки, мс: без неё `frames` не переводится в кадры в секунду. */
  frames_ms: number;
  /** Считает ли оболочка, что наше окно полностью закрыто чужим (1/0). Заполняется в `diag`. */
  covered?: number;
  /** На сколько процентов окно накрыто окном переднего плана — 100 = целиком. */
  cover_pct?: number;
  /** Сколько анимаций крутилось на последнем замере и какие именно (имя → сколько). */
  anims: number;
  anim_names: Record<string, number>;
}

let vadMs = 0;
let vadTicks = 0;
let vadTracks = 0;
let longMs = 0;
let longMax = 0;
let longCount = 0;
let observer: PerformanceObserver | null = null;
let frames = 0;
let rafId = 0;
let framesMs = 0;
let sampleUntil = 0;
let animNames: Record<string, number> = {};
let anims = 0;

/** Записать стоимость одного тика определения говорящего. */
export function noteVadTick(ms: number, tracks: number): void {
  vadMs += ms;
  vadTicks += 1;
  vadTracks = tracks;
}

/**
 * Подписка на длинные задачи. Браузер без `longtask` (или WebView постарее) просто не даст записей —
 * это не повод ронять сбор, поэтому всё в try/catch, а поля останутся нулями.
 */
export function watchLongTasks(): void {
  if (observer || typeof PerformanceObserver === 'undefined') return;
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longMs += e.duration;
        longCount += 1;
        if (e.duration > longMax) longMax = e.duration;
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    observer = null;
  }
  sampleFrames();
}

/**
 * Короткая выборка частоты отрисовки.
 *
 * 🔴 Цикл живёт `SAMPLE_MS` и гаснет. Держать его постоянно нельзя: сам по себе он удерживает
 * браузер в режиме непрерывной отрисовки, и замер начинает создавать нагрузку вместо того, чтобы
 * её мерить (поймано 20.09 на живых людях). Двух секунд хватает: частота кадров — величина
 * мгновенная, а не накопительная.
 */
const SAMPLE_MS = 2000;

function countFrame(): void {
  if (performance.now() >= sampleUntil) {
    rafId = 0;
    return;
  }
  frames += 1;
  rafId = requestAnimationFrame(countFrame);
}

/** Начать выборку, если предыдущая уже кончилась. */
function sampleFrames(): void {
  if (rafId) return;
  frames = 0;
  framesMs = SAMPLE_MS;
  sampleUntil = performance.now() + SAMPLE_MS;
  rafId = requestAnimationFrame(countFrame);
}

/**
 * Перепись активных анимаций через Web Animations API: `getAnimations` возвращает и те, что
 * заданы в стилях. Считаем по именам — так сразу видно, кто именно крутится, а не «что-то крутится».
 * ⚠️ Имена наши собственные, из стилей: чужих данных в них нет.
 */
function readAnimations(): void {
  try {
    const list = typeof document.getAnimations === 'function' ? document.getAnimations() : [];
    const names: Record<string, number> = {};
    for (const a of list) {
      if (a.playState !== 'running') continue;
      const name = (a as unknown as { animationName?: string }).animationName ?? 'иная';
      names[name] = (names[name] ?? 0) + 1;
    }
    animNames = names;
    anims = Object.values(names).reduce((n, v) => n + v, 0);
  } catch {
    animNames = {};
    anims = 0;
  }
}

/** Снять накопленное и обнулить. Видимость и фокус — мгновенные, их копить незачем. */
export function takeUiMeters(): UiMeters {
  readAnimations();
  const out: UiMeters = {
    vad_ms: Math.round(vadMs * 10) / 10,
    vad_ticks: vadTicks,
    vad_tracks: vadTracks,
    long_ms: Math.round(longMs),
    long_max_ms: Math.round(longMax),
    long_count: longCount,
    hidden: document.visibilityState === 'hidden' ? 1 : 0,
    focused: document.hasFocus() ? 1 : 0,
    frames,
    frames_ms: framesMs,
    anims,
    anim_names: animNames,
  };
  vadMs = 0;
  vadTicks = 0;
  longMs = 0;
  longMax = 0;
  longCount = 0;
  // Следующая выборка — к следующему срезу: между ними цикл не крутится вовсе.
  sampleFrames();
  return out;
}
