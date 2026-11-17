/**
 * Анимации джекпота колеса (ГусКоины 2): раскадровка сундука, пляска капитана за штурвалом и монеты-спрайты.
 *
 * Эталон движения — прототип движения, одобренный владельцем (сцены «Сундук сорван» и «Капитан на джекпоте»): здесь те же
 * тайминги и та же физика. Модуль без картинок: кадры приносит `WheelScene` (только она подключает `assets/wheel/*`,
 * страж `Activities.wheelWiring`), сюда приходят готовые `HTMLImageElement` и узлы разметки.
 *
 * Время — своё, из суммы шагов кадра (`FxLoop`), а не `performance.now()`: пока окно накрыто игрой (`gv-covered`) или
 * вкладка спрятана, цикл стоит и всё встаёт на месте, а потом продолжается с того же кадра. Шаг ограничен 50 мс —
 * после паузы ничего не перескакивает. Один `requestAnimationFrame` на всё; нет дорожек — цикл не крутится.
 *
 * Позы — чистые функции времени (`chestPoseAt`, `captainPoseAt`): их проверяют тесты без DOM.
 */

const clamp01 = (k: number) => Math.max(0, Math.min(1, k));
const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

// ——— Сундук ———

/** Кадры сундука по порядку: закрыт, щель, полуоткрыт, открыт, удар. */
export type ChestFrame = 0 | 1 | 2 | 3 | 4;

/** Шаги раскадровки, мс от начала (прототип: дрожь 800, щель 520, полуоткрыт 220, замах 150, удар 380, отдача 420). */
export const CHEST_STEPS = { crack: 800, half: 1320, windup: 1540, burst: 1690, settle: 2070, hold: 2490, fly: 3150, end: 3600 } as const;
/** Момент удара: вспышка, встряска, фонтан монет и выстрел `wheelJackpot`. */
export const CHEST_BURST_MS = CHEST_STEPS.burst;
/** Вся раскадровка крупным планом вместе с возвратом сундука на место у суммы. */
export const CHEST_FX_MS = CHEST_STEPS.end;

export type ChestPose = {
  frame: ChestFrame;
  /** Сдвиг корпуса вверх (px), наклон (°), сжатие по осям. */
  ty: number;
  rot: number;
  sx: number;
  sy: number;
  /** Цель яркости лучей 0…1 и их масштаб — цикл плавно догоняет. */
  rays: number;
  raysScale: number;
  /** Свечение пола под сундуком 0…1. */
  glow: number;
  /** Затемнение сцены под крупным планом 0…1. */
  veil: number;
  /** Доля полёта обратно к месту у суммы 0…1 (0 — ещё не летит). */
  fly: number;
};

/** Поза сундука на момент `ms` раскадровки (после конца — открытый на месте, полёт завершён). */
export function chestPoseAt(ms: number): ChestPose {
  const S = CHEST_STEPS;
  const base: ChestPose = { frame: 0, ty: 0, rot: 0, sx: 1, sy: 1, rays: 0, raysScale: 0.75, glow: 0, veil: clamp01(ms / 220), fly: 0 };
  if (ms < S.crack) {
    // Дрожь закрытого: подпрыгивает всё выше.
    const k = clamp01(ms / S.crack);
    const q = 0.035 * Math.abs(Math.sin(k * 26));
    return { ...base, rot: Math.sin(k * 52) * (1.2 + 2.6 * k), ty: -Math.abs(Math.sin(k * Math.PI * 3)) * 8 * k, sx: 1 + q * 0.7, sy: 1 - q };
  }
  if (ms < S.half) {
    // Щель: из неё бьют лучи.
    const k = (ms - S.crack) / (S.half - S.crack);
    const q = 0.045 * Math.abs(Math.sin(k * 30));
    return { ...base, frame: 1, rot: Math.sin(k * 64) * 3.4 * (1 - 0.3 * k), ty: -Math.abs(Math.sin(k * Math.PI * 2)) * 11, sx: 1 + q * 0.7, sy: 1 - q, rays: 0.55, raysScale: 0.9, glow: 0.35 };
  }
  if (ms < S.windup) {
    // Полуоткрыт: вытягивается вверх.
    const s = Math.sin(Math.PI * ((ms - S.half) / (S.windup - S.half)));
    return { ...base, frame: 2, ty: -16 * s, sx: 1 - 0.04 * s, sy: 1 + 0.07 * s, rays: 0.8, raysScale: 1.05, glow: 0.35 };
  }
  if (ms < S.burst) {
    // Открыт — замах перед ударом.
    const k = (ms - S.windup) / (S.burst - S.windup);
    return { ...base, frame: 3, ty: -20 * Math.sin((Math.PI / 2) * k), sx: 0.95, sy: 1.09, rays: 0.8, raysScale: 1.05, glow: 0.35 };
  }
  if (ms < S.settle) {
    // Удар: кадр «взрыв», корпус приседает и пружинит.
    const k = (ms - S.burst) / (S.settle - S.burst);
    const e = Math.exp(-5 * k) * Math.cos(k * 15);
    return { ...base, frame: 4, sx: 1 + 0.14 * e, sy: 1 - 0.18 * e, rays: 1, raysScale: 1.3, glow: 0.9 };
  }
  if (ms < S.hold) {
    const k = (ms - S.settle) / (S.hold - S.settle);
    const e = Math.exp(-6 * k) * Math.sin(k * 18);
    return { ...base, frame: 3, ty: -4 * Math.max(0, e), sx: 1 - 0.03 * e, sy: 1 + 0.04 * e, rays: 1, raysScale: 1.12, glow: 0.9 };
  }
  if (ms < S.fly) return { ...base, frame: 3, rays: 1, raysScale: 1.12, glow: 0.9 };
  // Возврат: затемнение гаснет, сундук с лучами уменьшается и летит к месту у суммы (там свечение подхватывает панель).
  const k = clamp01((ms - S.fly) / (S.end - S.fly));
  return { ...base, frame: 3, rays: 1, raysScale: 1.12, glow: 0.9 * (1 - k), veil: 1 - k, fly: easeInOut(k) };
}

/**
 * Свечение за сундуком (лучи + ореол) держится, пока звучит выстрел с фанфарами `wheel-jackpot.mp3` (~9,9 с от удара),
 * потом гаснет за `JACKPOT_GLOW_FADE_MS`. Длина — по самой записи (`soundDurationMs`), звук выключен, глухота или длина
 * ещё неизвестна — эта константа.
 */
export const JACKPOT_GLOW_MS = 9900;
export const JACKPOT_GLOW_FADE_MS = 900;

/** Длительность свечения от удара: длина записи в разумных пределах (3–20 с), иначе `JACKPOT_GLOW_MS`. */
export function jackpotGlowMs(soundMs: number | null): number {
  return soundMs != null && Number.isFinite(soundMs) && soundMs >= 3000 ? Math.min(20000, soundMs) : JACKPOT_GLOW_MS;
}

/** Яркость свечения 0…1 через `msFromBurst` после удара: 1 до конца звука, потом линейно гаснет. */
export function jackpotGlowAt(msFromBurst: number, glowMs: number): number {
  if (msFromBurst < 0) return 0;
  if (msFromBurst <= glowMs) return 1;
  return Math.max(0, 1 - (msFromBurst - glowMs) / JACKPOT_GLOW_FADE_MS);
}

// ——— Капитан ———

export type CaptainFrame = 'idle' | 'dance1' | 'dance2' | 'peak';
export type CaptainDance = 'joy' | 'jackpot';

/** Такт пляски — кадр танца сменяется через 0,3 с (прототип). */
export const CAPTAIN_BEAT_MS = 300;
const JOY_BEATS = 10;
const PEAK_MS = 620;
const LAND_MS = 200;
const SETTLE_MS = 500;
/** Длительность пляски: выигрыш — десять тактов; джекпот — пять тактов, прыжок с оборотом штурвала, пять тактов, успокоение. */
export const CAPTAIN_DANCE_MS: Record<CaptainDance, number> = {
  joy: JOY_BEATS * CAPTAIN_BEAT_MS + SETTLE_MS,
  jackpot: 10 * CAPTAIN_BEAT_MS + PEAK_MS + LAND_MS + SETTLE_MS,
};

export type CaptainPose = { frame: CaptainFrame; lift: number; rot: number; sx: number; sy: number; wheel: number };

/** Один такт: подскок с наклоном в сторону, штурвал подкручивается на `step`. */
function beatPose(i: number, k: number, wheel0: number, step: number): CaptainPose {
  const s = Math.sin(Math.PI * k);
  const c = Math.cos(2 * Math.PI * k);
  const side = i % 2 ? 1 : -1;
  return { frame: i % 2 ? 'dance2' : 'dance1', lift: 14 * s, rot: side * 4 * s, sx: 1 + 0.045 * c, sy: 1 - 0.06 * c, wheel: wheel0 + step * easeOut(k) };
}

/**
 * Поза капитана на момент `ms` пляски. Выигрыш: штурвал покачивается ±12° (пять тактов туда, пять обратно);
 * джекпот: ±24° и на пике — полный оборот. После конца — кадр, который держится до конца показа итога
 * (выигрыш — первый кадр танца, джекпот — пик), без движения.
 */
export function captainPoseAt(dance: CaptainDance, ms: number): CaptainPose {
  const B = CAPTAIN_BEAT_MS;
  const rest: CaptainPose = { frame: dance === 'joy' ? 'dance1' : 'peak', lift: 0, rot: 0, sx: 1, sy: 1, wheel: 0 };
  if (ms < 0) return { ...rest, frame: 'idle' };
  if (dance === 'joy') {
    const step = 12;
    if (ms < JOY_BEATS * B) {
      const i = Math.floor(ms / B);
      const k = (ms - i * B) / B;
      const half = JOY_BEATS / 2;
      const w0 = i < half ? i * step : half * step - (i - half) * step;
      return beatPose(i, k, w0, i < half ? step : -step);
    }
    const k = (ms - JOY_BEATS * B) / SETTLE_MS;
    if (k < 1) {
      const e = Math.exp(-5 * k) * Math.cos(k * 14);
      return { ...rest, sx: 1 + 0.04 * e, sy: 1 - 0.05 * e };
    }
    return rest;
  }
  const step = 24;
  const firstEnd = 5 * B;
  const peakEnd = firstEnd + PEAK_MS;
  const landEnd = peakEnd + LAND_MS;
  const secondEnd = landEnd + 5 * B;
  if (ms < firstEnd) {
    const i = Math.floor(ms / B);
    return beatPose(i, (ms - i * B) / B, i * step, step);
  }
  const top = 5 * step;
  if (ms < peakEnd) {
    // Пик: кадр «джекпот», высокий прыжок, штурвал делает полный оборот.
    const k = (ms - firstEnd) / PEAK_MS;
    const s = Math.sin(Math.PI * k);
    return { frame: 'peak', lift: 40 * s, rot: -3 * s, sx: 1 - 0.05 * s, sy: 1 + 0.09 * s, wheel: top + 360 * easeInOut(k) };
  }
  if (ms < landEnd) {
    const e = Math.sin(Math.PI * ((ms - peakEnd) / LAND_MS));
    return { frame: 'peak', lift: 0, rot: 0, sx: 1 + 0.08 * e, sy: 1 - 0.12 * e, wheel: top + 360 };
  }
  if (ms < secondEnd) {
    const j = Math.floor((ms - landEnd) / B);
    return beatPose(j + 5, (ms - landEnd - j * B) / B, top + 360 - j * step, -step);
  }
  const k = (ms - secondEnd) / SETTLE_MS;
  if (k < 1) {
    const e = Math.exp(-5 * k) * Math.cos(k * 14);
    return { ...rest, sx: 1 + 0.04 * e, sy: 1 - 0.05 * e };
  }
  return rest;
}

// ——— Казначей (красный попугай на сундуке) ———

/**
 * Кадры попугая (`assets/wheel/red-*.png`, холст 429×560: нижние 384 px — ровно холст сундука, попугай поверх него тем
 * же масштабом). Сидит: `sit1` держит дублон → `sit2` подбросил → `sit3` поймал; `watch` следит за колесом; `cheer`
 * радуется (лапы на крышке); `sad` поник; `jp1` взлёт над щелью (`chest-crack`); `jp2` завис над открытым сундуком.
 */
export type ParrotFrame = 'sit1' | 'sit2' | 'sit3' | 'watch' | 'cheer' | 'sad' | 'jp1' | 'jp2';
export const PARROT_FRAMES: ParrotFrame[] = ['sit1', 'sit2', 'sit3', 'watch', 'cheer', 'sad', 'jp1', 'jp2'];

/** Цикл ожидания: дублон в крыле 2–4 с, подбросил 0,4 с, поймал 0,7 с — паузы разные, не метроном. */
export const PARROT_IDLE = { holdMin: 2000, holdMax: 4000, toss: 400, catch: 700 } as const;
/** «Вдох» на долгой паузе: корпус вытягивается по Y на 1,5 % за всю паузу и опускается за подброс. */
export const PARROT_BREATH = 1.015;

/** Шаг `i` цикла ожидания (`rnd` 0…1 — длина паузы с дублоном в крыле). */
export function parrotIdleStep(i: number, rnd: number): { frame: ParrotFrame; ms: number; breath: number } {
  const P = PARROT_IDLE;
  const k = ((i % 3) + 3) % 3;
  if (k === 0) return { frame: 'sit1', ms: Math.round(P.holdMin + clamp01(rnd) * (P.holdMax - P.holdMin)), breath: PARROT_BREATH };
  if (k === 1) return { frame: 'sit2', ms: P.toss, breath: 1 };
  return { frame: 'sit3', ms: P.catch, breath: 1 };
}

/** Покачивание в полёте вверх от опоры, 0…6 px холста 429 (только вверх: лапы не опускаются к крышке). */
export function parrotBob(ms: number): number {
  return 3 * (1 - Math.cos(ms / 140));
}

export type ParrotPose = {
  frame: ParrotFrame;
  /** Сидит на крышке: повторяет всю позу сундука (дрожь, наклон, сжатие); иначе — только его подскок `ty`. */
  ride: boolean;
  /** Подъём над опорой кадра, px холста 429 (вверх). */
  lift: number;
};

/**
 * Попугай на крупном плане сорванного сундука (`ms` той же раскадровки, `chest` = `chestPoseAt(ms)`): до щели сидит на
 * крышке (следит, потом радуется), на щели взлетает (`jp1` — кадр выверен по `chest-crack`, зазор ≈ 17 px), с
 * полуоткрытого — завис выше (`jp2`, по `chest-open` зазор 12–16 px). Лапы не касаются крышки: вытягивание сундука
 * (`sy` > 1) поднимает и попугая; на удар (`chest-burst` — крышка выше, зазор ≈ 1 px) он поднимается на 22 px, пока
 * корпус ещё сжат (`sy` 0,82), — не раньше, чтобы с замахом не улететь в заголовок сцены.
 */
export function parrotJackpotAt(ms: number, chest: ChestPose): ParrotPose {
  const S = CHEST_STEPS;
  if (ms < S.crack) return { frame: ms < 400 ? 'watch' : 'cheer', ride: true, lift: 0 };
  if (ms < S.half) return { frame: 'jp1', ride: false, lift: parrotBob(ms - S.crack) };
  // Вход в верхний кадр — снизу (верхняя опора на 88 px выше), чтобы взлёт не был скачком.
  const enter = -60 * (1 - easeOut(clamp01((ms - S.half) / 220)));
  const stretch = Math.max(0, chest.sy - 1) * 371;
  const guard =
    ms < S.burst ? 0 : ms < S.settle ? 22 * easeOut(clamp01((ms - S.burst) / 100)) : ms < S.hold ? 22 - 14 * easeInOut((ms - S.settle) / (S.hold - S.settle)) : 8;
  return { frame: 'jp2', ride: false, lift: enter + stretch + guard + parrotBob(ms - S.half) };
}

/**
 * Цикл ожидания попугая без `requestAnimationFrame`: смена кадра раз в 0,4–4 с — таймером, «вдох» — конечным CSS
 * `transition` от кадра до кадра (бесконечных анимаций нет). `setActive(false)` — сидит не в ожидании (крутка, эмоция,
 * джекпот, уменьшенное движение); `setPaused(true)` — окно накрыто игрой: таймер снят, остаток паузы сохранён.
 * `dispose()` — сцена закрыта. `apply` получает кадр, «вдох» (масштаб по Y) и длину шага.
 */
export class ParrotIdle {
  private i = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dueAt = 0;
  private left = 0;
  private active = false;
  private paused = false;
  private dead = false;

  constructor(
    private readonly apply: (frame: ParrotFrame, breath: number, ms: number) => void,
    private readonly rnd: () => number = Math.random,
    private readonly now: () => number = () => Date.now(),
  ) {}

  setActive(a: boolean): void {
    if (this.dead || this.active === a) return;
    this.active = a;
    this.stop();
    this.left = 0;
    if (a) {
      this.i = 0;
      if (!this.paused) this.step();
    }
  }

  setPaused(p: boolean): void {
    if (this.dead || this.paused === p) return;
    this.paused = p;
    if (!this.active) return;
    if (p) {
      this.left = this.timer ? Math.max(0, this.dueAt - this.now()) : 0;
      this.stop();
    } else if (this.left > 0) {
      this.wait(this.left);
      this.left = 0;
    } else this.step();
  }

  dispose(): void {
    this.dead = true;
    this.active = false;
    this.stop();
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private step(): void {
    const s = parrotIdleStep(this.i, this.rnd());
    this.apply(s.frame, s.breath, s.ms);
    this.wait(s.ms);
  }

  private wait(ms: number): void {
    this.dueAt = this.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dead || !this.active || this.paused) return;
      this.i++;
      this.step();
    }, ms);
  }
}

// ——— Цикл кадров ———

/** Дорожка: `ms` — время от её старта, `dt` — шаг в секундах. Вернула `false` — снята. */
export type FxTrack = (ms: number, dt: number) => boolean | void;

/**
 * Один `requestAnimationFrame` на все дорожки. Пауза (`setPaused`) и пустой список — цикл не запрошен вовсе;
 * `dispose()` (размонтирование сцены) снимает всё и больше ничего не запускает.
 */
export class FxLoop {
  private tracks: { start: number; fn: FxTrack }[] = [];
  private t = 0;
  private raf = 0;
  private last = 0;
  private paused = false;
  private dead = false;
  /** Поколение: `clear()` посреди кадра отменяет его хвост. */
  private gen = 0;

  /** Дорожка со сдвигом `delayMs` от текущего времени цикла. */
  add(fn: FxTrack, delayMs = 0): void {
    if (this.dead) return;
    this.tracks.push({ start: this.t + delayMs, fn });
    this.kick();
  }

  /** Разовое действие через `delayMs` по времени цикла (стоит вместе с ним). */
  at(delayMs: number, fn: () => void): void {
    this.add(() => {
      fn();
      return false;
    }, delayMs);
  }

  setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    if (p) this.halt();
    else this.kick();
  }

  /** Снять все дорожки (новый итог перебивает старую сцену). */
  clear(): void {
    this.tracks = [];
    this.gen++;
    this.halt();
  }

  dispose(): void {
    this.dead = true;
    this.clear();
  }

  private halt(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
  }

  private kick(): void {
    if (this.raf || this.paused || this.dead || !this.tracks.length || typeof requestAnimationFrame !== 'function') return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.raf = 0;
    // Шаг ≤ 50 мс: вкладка проспала или телефон 120 Гц — время не прыгает.
    const dt = this.last ? Math.min(0.05, Math.max(0, (now - this.last) / 1000)) : 1 / 60;
    this.last = now;
    this.t += dt * 1000;
    const cur = this.tracks;
    const gen = ++this.gen;
    this.tracks = []; // дорожки, добавленные во время кадра, попадут сюда
    const keep: { start: number; fn: FxTrack }[] = [];
    for (const tr of cur) {
      if (this.dead || gen !== this.gen) return; // сцену сняли или перебили посреди кадра
      if (this.t < tr.start) {
        keep.push(tr);
        continue;
      }
      let alive: boolean | void = false;
      try {
        alive = tr.fn(this.t - tr.start, dt);
      } catch {
        alive = false; // одна дорожка не роняет остальные
      }
      if (alive !== false) keep.push(tr);
    }
    if (this.dead || gen !== this.gen) return;
    this.tracks = keep.concat(this.tracks);
    this.kick();
  };
}

// ——— Монеты ———

/** Кадров вращения в полосе `coin-spin.png` (12 квадратов в ряд). */
export const COIN_FRAMES = 12;

export type CoinSpec = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Размер на экране, css px. */
  size: number;
  /** Ускорение вниз, px/с². */
  g: number;
  /** Пол (css px от верха холста); касание — отскок. */
  floor: number;
  /** Кадров вращения в секунду и стартовая фаза. */
  fps: number;
  phase: number;
  /** Секунд до затухания (0,45 с), задержка старта, доля отскока, сила бокового ветра. */
  life: number;
  delay: number;
  bounce: number;
  wind: number;
};

type Coin = CoinSpec & { age: number; frame: number; hits: number; rest: boolean; wph: number };

/** Шаг одной монеты: падение с ускорением, снос ветром, до трёх отскоков, затухание. Вернула `false` — погасла или улетела. */
export function stepCoin(c: Coin, dt: number, width: number): boolean {
  c.age += dt;
  if (c.age < 0) return true;
  if (!c.rest) {
    c.vy += c.g * dt;
    c.vx += c.wind * Math.sin(c.age * 2.3 + c.wph) * dt;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.frame += c.fps * dt;
    if (c.y > c.floor - c.size / 2 && c.vy > 0) {
      c.y = c.floor - c.size / 2;
      c.vy *= -c.bounce;
      c.vx *= 0.55;
      c.fps *= 0.55;
      c.hits++;
      if (c.hits >= 3 || Math.abs(c.vy) < 70) {
        c.rest = true;
        c.vy = 0;
        c.frame = Math.round(c.frame / COIN_FRAMES) * COIN_FRAMES;
      }
    }
  }
  return coinAlpha(c) > 0 && c.x > -80 && c.x < width + 80;
}

/** Прозрачность монеты: до `life` — 1, потом гаснет за 0,45 с. */
export function coinAlpha(c: { age: number; life: number }): number {
  return c.age > c.life ? Math.max(0, 1 - (c.age - c.life) / 0.45) : 1;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Фонтан из сундука (удар): ~50 монет вверх и в стороны из точки `(x, y)`, ширина устья `spread`. */
export function fountainCoins(x: number, y: number, spread: number, floor: number, n = 50): CoinSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    x: x + (Math.random() - 0.5) * spread,
    y,
    vx: (Math.random() - 0.5) * 560,
    vy: -rnd(420, 980),
    size: rnd(18, 32),
    g: 1500,
    floor: floor - Math.random() * 18,
    fps: rnd(14, 28),
    phase: Math.random() * COIN_FRAMES,
    life: rnd(2.3, 3.2),
    delay: i * 0.011,
    bounce: 0.42,
    wind: 0,
  }));
}

/** Дождь сверху (капитан на джекпоте): ~66 монет по всей ширине, вразнобой за 2,3 с, со сносом ветром. */
export function rainCoins(width: number, floor: number, n = 66): CoinSpec[] {
  return Array.from({ length: n }, () => ({
    x: Math.random() * width,
    y: -rnd(24, 64),
    vx: (Math.random() - 0.5) * 50 + 18,
    vy: rnd(40, 170),
    size: rnd(18, 31),
    g: rnd(760, 980),
    floor: floor - Math.random() * 20,
    fps: rnd(10, 26),
    phase: Math.random() * COIN_FRAMES,
    life: rnd(2.6, 3.4),
    delay: Math.random() * 2.3,
    bounce: 0.38,
    wind: 70,
  }));
}

/** Горсть у капитана на обычный выигрыш: ~12 монет невысоко вверх из точки `(x, y)`. */
export function handfulCoins(x: number, y: number, floor: number, n = 12): CoinSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    x: x + (Math.random() - 0.5) * 24,
    y,
    vx: (Math.random() - 0.5) * 260,
    vy: -rnd(320, 560),
    size: rnd(16, 24),
    g: 1400,
    floor: floor - Math.random() * 10,
    fps: rnd(14, 24),
    phase: Math.random() * COIN_FRAMES,
    life: rnd(1.4, 2),
    delay: i * 0.03,
    bounce: 0.4,
    wind: 0,
  }));
}

/**
 * Холст монет поверх сцены. Свой размер подгоняет под css-размер × `devicePixelRatio` на каждом кадре (поворот
 * телефона, масштаб окна); кадр вращения — квадрат из полосы `sheet`. Пока монет нет — дорожки в цикле нет.
 */
export class CoinLayer {
  private coins: Coin[] = [];
  private running = false;

  constructor(
    private loop: FxLoop,
    private canvas: HTMLCanvasElement,
    private sheet: HTMLImageElement,
  ) {}

  /** css-размер холста — для расчёта точек вылета. */
  size(): { w: number; h: number } {
    return { w: this.canvas.clientWidth, h: this.canvas.clientHeight };
  }

  add(specs: CoinSpec[]): void {
    for (const s of specs) this.coins.push({ ...s, age: -s.delay, frame: s.phase, hits: 0, rest: false, wph: Math.random() * 6 });
    if (this.running || !this.coins.length) return;
    this.running = true;
    this.loop.add((_ms, dt) => this.step(dt));
  }

  clear(): void {
    this.coins = [];
    this.wipe();
  }

  private ctx(): { x: CanvasRenderingContext2D; w: number; h: number } | null {
    const c = this.canvas;
    const w = c.clientWidth;
    const h = c.clientHeight;
    const d = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const pw = Math.round(w * d);
    const ph = Math.round(h * d);
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    const x = c.getContext('2d');
    if (!x) return null;
    x.setTransform(d, 0, 0, d, 0, 0);
    x.clearRect(0, 0, w, h);
    return { x, w, h };
  }

  private wipe(): void {
    const x = this.canvas.getContext('2d');
    x?.setTransform(1, 0, 0, 1, 0, 0);
    x?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private step(dt: number): boolean {
    const g = this.coins.length ? this.ctx() : null;
    if (!g) {
      this.running = false;
      this.coins = [];
      this.wipe();
      return false;
    }
    const cell = this.sheet.naturalHeight || 64;
    this.coins = this.coins.filter((c) => {
      const alive = stepCoin(c, dt, g.w);
      if (!alive || c.age < 0) return alive;
      const a = coinAlpha(c);
      const f = ((Math.floor(c.frame) % COIN_FRAMES) + COIN_FRAMES) % COIN_FRAMES;
      g.x.globalAlpha = a;
      g.x.drawImage(this.sheet, f * cell, 0, cell, cell, c.x - c.size / 2, c.y - c.size / 2, c.size, c.size);
      return true;
    });
    g.x.globalAlpha = 1;
    if (this.coins.length) return true;
    this.running = false;
    this.wipe();
    return false;
  }
}
