/**
 * «Живой» круг записи голосового (#218) — чистая математика, без DOM.
 *
 * Повторяет Telegram Android по исходнику (код не копирован, GPL; константы — буквально):
 * - `TMessagesProj/.../ui/Components/BlobDrawable.java` — сама клякса: N точек по кругу, у каждой радиус и угол
 *   плавно перетекают к следующим случайным (`generateBlob`/`update`), контур — кубические Безье с плечом
 *   `L = 4/3·tan(π/2N)` (`draw`); громкость сглаживается линейно за фиксированное время (`setValue`/`updateAmplitude`).
 * - `ChatActivityEnterView.java`, класс `RecordCircle` — две кляксы (`tinyWaveDrawable` 11 точек, `bigWaveDrawable`
 *   12 точек), круг `41 dp + 30 dp × громкость`, кривая появления `scale` (300 мс), уход `exitTransition` (360 мс:
 *   0,6 — набухание на 16 dp, 0,4 — сжатие в ноль и угасание), отмена жестом (`canceledByGesture`, 200 мс:
 *   0,7 × EASE_OUT(1 − p), не меньше 19 dp, угасание после 0,7), волны входят по +0,04 за кадр (`wavesEnterAnimation`).
 * - `WaveDrawable.java` — альфа волн `CIRCLE_ALPHA_1 = 0,30` (большая) и `CIRCLE_ALPHA_2 = 0,15` (малая),
 *   скорость сглаживания круга `ANIMATION_SPEED_CIRCLE = 0,45`.
 *
 * Отрисовка — `components/RecordBlob.tsx` (canvas + rAF только пока круг на экране).
 */

/** Константы Telegram Android (`BlobDrawable`, `RecordCircle`, `WaveDrawable`). Размеры — в CSS-пикселях (= dp). */
export const REC_BLOB = {
  /** `RecordCircle.circleRadius = dpf2(41)`, `circleRadiusAmplitude = dp(30)`. */
  circleR: 41,
  circleAmpR: 30,
  /** `tinyWaveDrawable = new BlobDrawable(11)`: радиусы 47 … 47 + 15 × `FORM_SMALL_MAX` (0,6). */
  tiny: { points: 11, minR: 47, maxR: 47 + 15 * 0.6, speedScale: 1.02, scaleMin: 0.926, alpha: 0.15 },
  /** `bigWaveDrawable = new BlobDrawable(12)`: радиусы 50 … 50 + 12 × `FORM_BIG_MAX` (0,6). */
  big: { points: 12, minR: 50, maxR: 50 + 12 * 0.6, speedScale: 1.01, scaleMin: 0.878, alpha: 0.3 },
  /** `BlobDrawable.MIN_SPEED` / `MAX_SPEED`: ход точки за кадр = speed × (0,8 + громкость × 8,2 × speedScale). */
  minSpeed: 0.8,
  maxSpeed: 8.2,
  /** Волна растёт как `scaleMin + 1,4 × громкость` (`RecordCircle.onDraw`). */
  ampScale: 1.4,
  /** `wavesEnterAnimation += 0.04f` за кадр. */
  wavesEnterStep: 0.04,
  /** Кадр Telegram — 60 Гц; у нас ход шкалируется по реальному dt. */
  frameMs: 1000 / 60,
  /** `ObjectAnimator.ofFloat(recordCircle, recordCircleScale, 1).setDuration(300)`. */
  appearMs: 300,
  /** `exitTransition` → 1 за 360 мс (отправка). */
  sendMs: 360,
  /** `slideToCancelProgress` → 1 за 200 мс, EASE_BOTH (отмена жестом). */
  cancelMs: 200,
  /** Замок: `lockAnimatedTranslation` → старт за 200 мс; у нас круг стекает в кнопку (радиус 22 = кнопка 44). */
  lockMs: 200,
  /** Радиус кнопки, в которую стекает круг при замке. */
  buttonR: 22,
  /** `canceledByGesture`: круг не меньше 19 dp, пока отмена не доиграла. */
  cancelMinR: 19,
  /** Сколько CSS-пикселей нужно холсту от центра: большая клякса 57,2 × (0,878 + 1,4) + запас. */
  canvasHalf: 136,
} as const;

export type BlobKind = 'tiny' | 'big';

/** Состояние одной кляксы: текущие и следующие радиусы/углы точек, прогресс перетекания и скорость каждой. */
export type Blob = {
  n: number;
  minR: number;
  maxR: number;
  r: number[];
  a: number[];
  rNext: number[];
  aNext: number[];
  p: number[];
  speed: number[];
};

/** Случайное число в (−1; 1) — как `(random.nextInt() % 100f) / 100f` у Telegram. */
function sym(rnd: () => number): number {
  return rnd() * 2 - 1;
}

/** Новая цель для точки `i` (`BlobDrawable.generateBlob(radius, angle, i)`). */
export function blobPoint(b: Blob, i: number, rnd: () => number, into: 'cur' | 'next'): void {
  const angleDif = (360 / b.n) * 0.05;
  const radDif = b.maxR - b.minR;
  const r = b.minR + Math.abs(sym(rnd)) * radDif;
  const a = (360 / b.n) * i + sym(rnd) * angleDif;
  if (into === 'cur') {
    b.r[i] = r;
    b.a[i] = a;
  } else {
    b.rNext[i] = r;
    b.aNext[i] = a;
  }
  b.speed[i] = 0.017 + 0.003 * Math.abs(sym(rnd));
}

export function blobNew(kind: BlobKind, rnd: () => number = Math.random): Blob {
  const k = REC_BLOB[kind];
  const n = k.points;
  const b: Blob = {
    n,
    minR: k.minR,
    maxR: k.maxR,
    r: new Array<number>(n).fill(0),
    a: new Array<number>(n).fill(0),
    rNext: new Array<number>(n).fill(0),
    aNext: new Array<number>(n).fill(0),
    p: new Array<number>(n).fill(0),
    speed: new Array<number>(n).fill(0),
  };
  for (let i = 0; i < n; i++) {
    blobPoint(b, i, rnd, 'cur');
    blobPoint(b, i, rnd, 'next');
  }
  return b;
}

/**
 * Шаг перетекания (`BlobDrawable.update`). `frames` — сколько кадров по 60 Гц прошло (у Telegram всегда 1).
 * Дошедшая точка берёт следующую цель и получает новую.
 */
export function blobStep(b: Blob, amp: number, speedScale: number, frames: number, rnd: () => number = Math.random): void {
  for (let i = 0; i < b.n; i++) {
    b.p[i] += (b.speed[i] * REC_BLOB.minSpeed + amp * b.speed[i] * REC_BLOB.maxSpeed * speedScale) * frames;
    if (b.p[i] >= 1) {
      b.p[i] = 0;
      b.r[i] = b.rNext[i];
      b.a[i] = b.aNext[i];
      blobPoint(b, i, rnd, 'next');
    }
  }
}

/** Отрезок контура: из (x0, y0) кубической Безье через (c1, c2) в (x, y). */
export type BlobSeg = { x0: number; y0: number; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number };

/** Контур кляксы вокруг (cx, cy) (`BlobDrawable.draw`): N отрезков, замкнутый. */
export function blobPath(b: Blob, cx: number, cy: number): BlobSeg[] {
  const L = (4 / 3) * Math.tan(Math.PI / (2 * b.n));
  const out: BlobSeg[] = [];
  for (let i = 0; i < b.n; i++) {
    const j = i + 1 < b.n ? i + 1 : 0;
    const p1 = b.p[i];
    const p2 = b.p[j];
    const r1 = b.r[i] * (1 - p1) + b.rNext[i] * p1;
    const r2 = b.r[j] * (1 - p2) + b.rNext[j] * p2;
    const a1 = ((b.a[i] * (1 - p1) + b.aNext[i] * p1) * Math.PI) / 180;
    const a2 = ((b.a[j] * (1 - p2) + b.aNext[j] * p2) * Math.PI) / 180;
    const l = L * (Math.min(r1, r2) + (Math.max(r1, r2) - Math.min(r1, r2)) / 2);
    // Точка «вверх на r» и плечо вправо/влево, повёрнутые на угол точки (как `Matrix.setRotate` вокруг центра).
    const s1 = Math.sin(a1);
    const k1 = Math.cos(a1);
    const s2 = Math.sin(a2);
    const k2 = Math.cos(a2);
    out.push({
      x0: cx + r1 * s1,
      y0: cy - r1 * k1,
      c1x: cx + l * k1 + r1 * s1,
      c1y: cy + l * s1 - r1 * k1,
      c2x: cx - l * k2 + r2 * s2,
      c2y: cy - l * s2 - r2 * k2,
      x: cx + r2 * s2,
      y: cy - r2 * k2,
    });
  }
  return out;
}

/**
 * Сглаживание громкости: к цели — линейно за фиксированное время (`BlobDrawable.setValue` + `updateAmplitude`,
 * `RecordCircle.setAmplitude`). Время по Telegram: большая волна вверх 100 + 300 × 0,35 = 205 мс, вниз 275 мс;
 * малая вверх 100 + 400 × 0,55 = 320 мс, вниз 375 мс; круг 100 + 500 × 0,55 = 375 мс в обе стороны.
 */
export type AmpKind = BlobKind | 'circle';

export function ampRiseMs(kind: AmpKind, up: boolean): number {
  if (kind === 'big') return up ? 100 + 300 * (1 - 0.65) : 100 + 500 * (1 - 0.65);
  if (kind === 'tiny') return up ? 100 + 400 * (1 - 0.45) : 100 + 500 * (1 - 0.45);
  return 100 + 500 * (1 - 0.45);
}

export type Amp = { value: number; target: number; diff: number };

export function ampNew(): Amp {
  return { value: 0, target: 0, diff: 0 };
}

/** Новая цель: скорость считается от текущего значения, как у Telegram (дошли быстрее — стоим). */
export function ampSet(s: Amp, target: number, kind: AmpKind): void {
  const t = Math.max(0, Math.min(1, Number.isFinite(target) ? target : 0));
  s.target = t;
  s.diff = (t - s.value) / ampRiseMs(kind, t > s.value);
}

export function ampTick(s: Amp, dtMs: number): void {
  if (s.value === s.target) return;
  s.value += s.diff * dtMs;
  if ((s.diff > 0 && s.value > s.target) || (s.diff < 0 && s.value < s.target) || s.diff === 0) s.value = s.target;
}

/** Кривая Безье (x1, y1, x2, y2) по x — как `CubicBezierInterpolator`. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const bx = (u: number) => 3 * x1 * u * (1 - u) * (1 - u) + 3 * x2 * u * u * (1 - u) + u * u * u;
  const by = (u: number) => 3 * y1 * u * (1 - u) * (1 - u) + 3 * y2 * u * u * (1 - u) + u * u * u;
  let lo = 0;
  let hi = 1;
  let u = t;
  for (let i = 0; i < 24; i++) {
    u = (lo + hi) / 2;
    if (bx(u) < t) lo = u;
    else hi = u;
  }
  return by(u);
}

/** `CubicBezierInterpolator.EASE_BOTH` (.42, 0, .58, 1) и `EASE_OUT` (0, 0, .58, 1). */
export const easeBoth = (t: number) => cubicBezier(0.42, 0, 0.58, 1, t);
export const easeOut = (t: number) => cubicBezier(0, 0, 0.58, 1, t);
/** Интерполятор `ObjectAnimator` по умолчанию на Android (AccelerateDecelerate). */
export const accelDecel = (t: number) => Math.cos((Math.min(1, Math.max(0, t)) + 1) * Math.PI) / 2 + 0.5;

/** Масштаб круга от `scale` появления (`RecordCircle.onDraw`, `sc`): рост до 1, просадка до 0,9, возврат к 1. */
export function circleAppearScale(scale: number): number {
  const s = Math.max(0, Math.min(1, scale));
  if (s <= 0.5) return s / 0.5;
  if (s <= 0.75) return 1 - ((s - 0.5) / 0.25) * 0.1;
  return 0.9 + ((s - 0.75) / 0.25) * 0.1;
}

export type BlobExit = 'lock' | 'send' | 'cancel';

export type CircleFrame = {
  /** Радиус сплошного круга, CSS-пиксели. */
  radius: number;
  /** Непрозрачность круга 0…1. */
  alpha: number;
  /** Множитель масштаба волн (0 — волн нет). */
  waves: number;
};

/**
 * Кадр круга. `scale` — появление 0…1 (уже через кривую аниматора), `amp` — сглаженная громкость круга,
 * `slide` — продвижение отмены влево 0…1 (у Telegram `slideToCancelProgress = 1 − slide`), `exit`/`t` — уход и его доля 0…1.
 */
export function circleFrame(o: { scale: number; amp: number; slide: number; exit: BlobExit | null; t: number; fromR?: number }): CircleFrame {
  const sc = circleAppearScale(o.scale);
  const stc = 1 - Math.max(0, Math.min(1, o.slide));
  const t = Math.max(0, Math.min(1, o.t));
  const base = REC_BLOB.circleR + REC_BLOB.circleAmpR * Math.max(0, Math.min(1, o.amp));
  let alpha = 1;
  let wavesMul = o.scale * Math.min(1, stc / 0.7);
  if (o.exit === 'cancel') {
    // Отмена жестом: `slideToCancelProgress` доезжает до 1 (EASE_BOTH), круг 0,7 × EASE_OUT(1 − p), не меньше 19 dp.
    const p = easeBoth(t);
    let radius = base * sc * 0.7 * easeOut(1 - p);
    if (t < 1) radius = Math.max(radius, REC_BLOB.cancelMinR);
    if (p > 0.7) alpha = 1 - (p - 0.7) / 0.3;
    return { radius, alpha: Math.max(0, alpha), waves: 0 };
  }
  let radius = base * sc * (0.7 + stc * 0.3);
  if (o.exit === 'send') {
    const step1 = easeBoth(t > 0.6 ? 1 : t / 0.6);
    const step2 = easeBoth(Math.max(0, (t - 0.6) / 0.4));
    radius = (radius + 16 * step1) * (1 - step2);
    if (t > 0.6) alpha = Math.max(0, 1 - (t - 0.6) / 0.4);
    wavesMul *= 1 - step1;
    if (step2 >= 0.4) wavesMul = 0;
  } else if (o.exit === 'lock') {
    // Замок: круг стекает в кнопку (кнопка становится «Отправить»), волны гаснут вместе с ним.
    const e = easeBoth(t);
    const from = o.fromR ?? radius;
    radius = from + (REC_BLOB.buttonR - from) * e;
    wavesMul *= 1 - e;
  }
  return { radius, alpha, waves: Math.max(0, wavesMul) };
}

/** Масштаб волны: `scaleMin + 1,4 × громкость` × общий множитель кадра. */
export function waveScale(kind: BlobKind, amp: number, mul: number): number {
  return mul * (REC_BLOB[kind].scaleMin + REC_BLOB.ampScale * amp);
}

/** Сколько длится уход. */
export function exitMs(exit: BlobExit): number {
  return exit === 'send' ? REC_BLOB.sendMs : exit === 'cancel' ? REC_BLOB.cancelMs : REC_BLOB.lockMs;
}

/** Какой уход играть, когда удержание кончилось: замок — запись идёт дальше; отправка — пошла отправка; иначе отмена. */
export function exitKindOf(s: { recording: boolean; recBusy: boolean }): BlobExit {
  if (s.recording) return 'lock';
  if (s.recBusy) return 'send';
  return 'cancel';
}

/** Чем рисовать круг: клякса на холсте, лёгкий круг стилем без волн (оптимизированный режим) или неподвижный круг. */
export type BlobMode = 'blob' | 'lite' | 'static';

export function blobMode(o: { reducedMotion: boolean; lite: boolean }): BlobMode {
  if (o.reducedMotion) return 'static';
  if (o.lite) return 'lite';
  return 'blob';
}

/** Плотность пикселей холста: резкость на DPR 2–3, но не больше 3 (иначе холст 816² при DPR 4 зря). */
export function canvasDpr(dpr: number | undefined): number {
  if (!dpr || !Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.min(3, dpr);
}
