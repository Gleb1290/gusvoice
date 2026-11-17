import {
  isAdmin,
  WHEEL_COOLDOWN_MS,
  WHEEL_PAYOUT_X100,
  WHEEL_SECTORS,
  WHEEL_SPIN_MS,
  sectorFromHash,
  wheelCommitInput,
  wheelRestAngle,
  wheelSectorInput,
  type WheelBetDto,
  type WheelPick,
  type WheelResultDto,
  type WheelSnapshotDto,
} from '@gusvoice/shared';

/**
 * Колесо гусей-пиратов на клиенте (ГусКоины 2, этап 2) — ЧИСТЫЕ правила: без React, стора и сети.
 *
 * Исход раунда решает сервер (зерно до ставок, сектор — при блокировке окна); клиент только рисует и
 * может ПЕРЕПРОВЕРИТЬ итог: та же чистая функция `sectorFromHash` из `packages/shared/src/wheel.ts`, хеш — `crypto.subtle`.
 * Сцена — `components/WheelScene.tsx`, загрузка снимка — `economyClient.ensureWheel`, срез стора — `store.wheel`.
 */

/**
 * Снимок колеса + поправка часов: `skewMs` = часы сервера − наши в момент приёма (таймер окна ставок без дрожи).
 * Слияние событий со снимком — в `store.ts` (`applyWheelState`/`applyWheelResult`): у стора закрытая граница импортов.
 */
export interface WheelView extends WheelSnapshotDto {
  skewMs: number;
}

/** Есть ли у сервера живой раунд (значок-точка на кнопке «Активности»). */
export function wheelLive(view: WheelView | undefined): boolean {
  return !!view?.enabled && !!view.round;
}

export type WheelPhase =
  | { kind: 'idle' }
  | { kind: 'open'; leftMs: number }
  | { kind: 'spinning'; leftMs: number }
  | { kind: 'cooldown'; leftMs: number };

/**
 * Что сейчас с колесом по часам сервера. `open` с истёкшим окном — ещё ждём блокировку от сервера (такт 1 с):
 * ставки уже не примут, поэтому показываем «0:00» и кнопки гасим.
 */
export function wheelPhase(view: WheelView, nowMs: number): WheelPhase {
  const now = nowMs + view.skewMs;
  const r = view.round;
  if (r?.state === 'open') return { kind: 'open', leftMs: Math.max(0, Date.parse(r.lockAt) - now) };
  if (r?.state === 'locked') {
    const settle = r.settleAt ? Date.parse(r.settleAt) : NaN;
    return { kind: 'spinning', leftMs: Number.isFinite(settle) ? Math.max(0, settle - now) : 0 };
  }
  const cd = view.cooldownUntil ? Date.parse(view.cooldownUntil) : NaN;
  if (Number.isFinite(cd) && cd > now) return { kind: 'cooldown', leftMs: Math.min(cd - now, WHEEL_COOLDOWN_MS * 2) };
  return { kind: 'idle' };
}

/** «0:07» — таймер окна ставок. Секунды вверх: «0:00» появляется только когда окно правда закрылось. */
export function clockLabel(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Множитель выплаты (включая ставку) по-русски: ×1,9 · ×3,8 · ×5,75 · ×11,5 · ×23. */
export function multiplierLabel(pick: WheelPick): string {
  return `×${String(WHEEL_PAYOUT_X100[pick] / 100).replace('.', ',')}`;
}

/** Цвет сектора на кнопке — ровно как нарисовано на колесе; все пять уже токены `:root`. */
export const PICK_COLOR: Record<WheelPick, string> = {
  1: 'var(--accent)',
  3: 'var(--green)',
  5: 'var(--peer-6)',
  10: 'var(--peer-3)',
  20: 'var(--danger)',
};

/** Сколько секторов из 25 у числа — подпись «шанс» под кнопкой. */
export function pickSectors(pick: WheelPick): number {
  return WHEEL_SECTORS.filter((v) => v === pick).length;
}

/** Пресеты суммы: не выше потолка ставки и не выше баланса. Пусто — кнопки сумм не рисуем, остаётся поле. */
export const BET_PRESETS = [10, 50, 100, 300] as const;
export function betPresets(betMax: number, balance: number): number[] {
  return BET_PRESETS.filter((v) => v <= betMax && v <= balance);
}

/** Сумма из поля: целое ≥ 1, не выше потолка и баланса; мусор — 0 (кнопка «Поставить» гаснет). */
export function clampBet(raw: number, betMax: number, balance: number): number {
  if (!Number.isFinite(raw)) return 0;
  const v = Math.floor(raw);
  if (v < 1) return 0;
  return Math.max(0, Math.min(v, betMax, balance));
}

/** Ставки раунда по людям, порядок — как пришли (первый поставивший сверху). */
export function betsByUser(bets: readonly WheelBetDto[]): { userId: string; bets: WheelBetDto[]; total: number }[] {
  const out: { userId: string; bets: WheelBetDto[]; total: number }[] = [];
  const at = new Map<string, number>();
  for (const b of bets) {
    let i = at.get(b.userId);
    if (i === undefined) {
      i = out.length;
      at.set(b.userId, i);
      out.push({ userId: b.userId, bets: [], total: 0 });
    }
    out[i].bets.push(b);
    out[i].total += b.amount;
  }
  return out;
}

/**
 * Конечный угол вращения: от текущего `fromDeg` не меньше `turns` полных оборотов, и сектор встаёт под указатель.
 * Угол только растёт (колесо крутится в одну сторону, назад не дёргается).
 */
export function spinTarget(fromDeg: number, sector: number, turns: number): number {
  const base = fromDeg + Math.max(0, Math.floor(turns)) * 360;
  const rest = wheelRestAngle(sector);
  return base + ((((rest - base) % 360) + 360) % 360);
}

/** Сколько оборотов успеть за остаток: полное вращение — 5, вошёл посреди — меньше, но хотя бы один. */
export function spinTurns(leftMs: number): number {
  return Math.max(1, Math.round((5 * Math.min(leftMs, WHEEL_SPIN_MS)) / WHEEL_SPIN_MS));
}

/** Кривая замедления вращения: одна и та же у CSS (`transition-timing-function`) и у планировщика трещотки. */
export const WHEEL_EASE: readonly [number, number, number, number] = [0.15, 0.62, 0.18, 1];
export const WHEEL_EASE_CSS = `cubic-bezier(${WHEEL_EASE.join(', ')})`;

/**
 * Моменты (мс от старта), когда граница сектора проходит под указателем, — по той же кривой, что у CSS.
 * Кривая Безье параметрическая: сэмплируем её и для каждой доли пути ищем долю времени линейной интерполяцией.
 */
export function tickTimes(fromDeg: number, toDeg: number, durationMs: number, stepDeg = 360 / WHEEL_SECTORS.length): number[] {
  const total = toDeg - fromDeg;
  if (!(total > 0) || !(durationMs > 0)) return [];
  const [x1, y1, x2, y2] = WHEEL_EASE;
  const N = 600;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const a = 3 * u * (1 - u) * (1 - u);
    const b = 3 * u * u * (1 - u);
    const c = u * u * u;
    xs.push(a * x1 + b * x2 + c);
    ys.push(a * y1 + b * y2 + c);
  }
  const out: number[] = [];
  // Первая граница после старта: ближайшее кратное шагу (границы стоят на k·шаг, фаза уже в арте).
  let next = (Math.floor(fromDeg / stepDeg) + 1) * stepDeg;
  let j = 0;
  while (next < toDeg) {
    const yTarget = (next - fromDeg) / total;
    while (j < N && ys[j + 1] < yTarget) j++;
    const y0 = ys[j];
    const y1n = ys[Math.min(N, j + 1)];
    const f = y1n > y0 ? (yTarget - y0) / (y1n - y0) : 0;
    const x = xs[j] + f * (xs[Math.min(N, j + 1)] - xs[j]);
    out.push(Math.round(x * durationMs));
    next += stepDeg;
  }
  return out;
}

/**
 * Не чаще одного щелчка за столько мс (30.10, «клекот»): на старте граница сектора проходит под пером раз в ~12 мс,
 * а запись щелчка длится ~86 мс — щелчки сливались в дребезг. Порог чуть меньше записи: соседние щелчки касаются
 * хвостами, но не накладываются кучей.
 */
export const WHEEL_TICK_MIN_GAP_MS = 70;

/**
 * Расписание трещотки из моментов `tickTimes`: лишние щелчки быстрой фазы ВЫБРАСЫВАЮТСЯ (каждый оставшийся по-прежнему
 * стоит на настоящей границе сектора, очередь не копится и не сползает), последний — ровно на остановке `durationMs`
 * (колесо встало на выпавший сектор); граница ближе порога к остановке уступает ему место.
 */
export function wheelTickPlan(times: readonly number[], durationMs: number, gapMs = WHEEL_TICK_MIN_GAP_MS): number[] {
  if (!(durationMs > 0)) return [];
  const out: number[] = [];
  let prev = -Infinity;
  for (const t of times) {
    if (!(t >= 0) || t - prev < gapMs || durationMs - t < gapMs) continue;
    out.push(t);
    prev = t;
  }
  out.push(Math.round(durationMs));
  return out;
}

/**
 * Где сейчас вращение (30.10, догоняние): от начала прошло `elapsedMs` из `durationMs`. Кончилось (или длины нет) —
 * `done`: колесо обязано стоять на итоговом угле без прокрутки; иначе — момент для `Animation.currentTime`.
 * Отрицательное прошедшее время (часы сдвинулись назад) — начало.
 */
export function spinProgress(elapsedMs: number, durationMs: number): { done: true } | { done: false; atMs: number } {
  if (!(durationMs > 0) || !(elapsedMs < durationMs)) return { done: true };
  return { done: false, atMs: Math.max(0, elapsedMs) };
}

// ——— Вращение по одной формуле: колесо, перо и трещотка (30.10, «оживить колесо») ———
// Жалоба владельца: на замедлении щелчок расходился с картинкой. Причины: картинку крутил CSS-easing, а щелчки считались
// по выборке той же кривой; запись щелчка начинается с 20 мс шороха (`WHEEL_TICK_LEAD_S` в `sounds.ts`); последний
// щелчок стоял на «остановке», где на колесе ничего не происходит. Теперь угол — ОДНА функция времени `wheelAngleAt`:
// по ней строятся ключевые кадры колеса и пера (Web Animations, линейно между частыми точками) и моменты щелчков —
// срыв штырька с пера (`wheelPegClicks`). Образец — казуальные колёса (Coin Master, «Поле чудес»): флажок на оси,
// штырьки на каждой границе, замах перед стартом, остановка у кромки с откатом.

/** Штырёк стоит на каждой границе секторов. */
export const WHEEL_PEG_STEP = 360 / WHEEL_SECTORS.length;
// Геометрия в единицах холста арта 1024×1200: центр колеса [512, 688], ось пера (жёлтая шляпка) [512, 117] — на 571
// выше центра; штырьки на ободе в радиусе 380 (там же золотые заклёпки арта); перо от оси до кончика — 198; зазор
// «полуширина пера у кончика + радиус штырька» — 46.
const PEG_R = 380;
const AXIS_D = 571;
const FEATHER_L = 198;
const FEATHER_GAP = 46;
const RAD = Math.PI / 180;
/** Где штырёк срывается с кончика пера: угол штырька от «12 часов» (по ходу вращения), ≈ 6,4°. */
export const WHEEL_PEG_RELEASE_DEG = Math.acos((PEG_R * PEG_R + AXIS_D * AXIS_D - FEATHER_L * FEATHER_L) / (2 * PEG_R * AXIS_D)) / RAD;
/**
 * Точка остановки внутри выпавшего сектора — не центр, а на столько градусов дальше по ходу (сектор 14,4°, кромка в 7,2°):
 * штырёк границы со СЛЕДУЮЩИМ сектором уже упёрся в перо и отогнул его — «чуть-чуть не дотянуло».
 */
export const WHEEL_LAND_DEG = 4.6;
/** Перекат за точку остановки перед откатом (штырёк дожимает перо, перо отталкивает колесо назад): 4,6 + 1,9 < 7,2. */
export const WHEEL_SETTLE_OVER_DEG = 1.9;
export const WHEEL_SETTLE_MS = 420;
/** Замах назад перед разгоном — только на свежем старте (догоняя середину после ухода из окна, замаха нет). */
export const WHEEL_WINDUP_MS = 260;
export const WHEEL_WINDUP_MAX_DEG = 4.5;
/** Свежий старт: до остановки осталось не меньше полного вращения без этого запаса. */
const WHEEL_FRESH_SLACK_MS = 300;
/** Профиль скорости основного хода: разгон за долю `SPIN_RAMP`, дальше спад как (1 − u)^`SPIN_DECAY`. */
const SPIN_RAMP = 0.08;
const SPIN_DECAY = 2;

const mod = (a: number, m: number) => ((a % m) + m) % m;

/** Сектор под пером при угле колеса (по часовой); на кромке — тот, что ещё не ушёл. */
export function wheelSectorAt(angleDeg: number): number {
  return Math.floor(mod(-angleDeg, 360) / WHEEL_PEG_STEP) % WHEEL_SECTORS.length;
}

/** Угол покоя сектора с `WHEEL_LAND_DEG`: остановка у кромки, а не в центре. */
export function wheelLandAngle(sector: number): number {
  return wheelRestAngle(sector) + WHEEL_LAND_DEG;
}

/** Как `spinTarget`, но с остановкой у кромки: не меньше `turns` оборотов от `fromDeg`, сектор под пером тот же. */
export function wheelLandTarget(fromDeg: number, sector: number, turns: number): number {
  return spinTarget(fromDeg - WHEEL_LAND_DEG, sector, turns) + WHEEL_LAND_DEG;
}

/**
 * Насколько штырёк, стоящий в `alphaDeg` от «12 часов», отгибает перо (градусы, кончик по ходу вращения); штырёк не
 * достаёт до пера (дальше кончика) — `-Infinity`. Перо — отрезок от оси, штырёк упирается в его бок.
 */
export function featherPushDeg(alphaDeg: number): number {
  const x = PEG_R * Math.sin(alphaDeg * RAD);
  const y = AXIS_D - PEG_R * Math.cos(alphaDeg * RAD);
  const rho = Math.hypot(x, y);
  if (rho > FEATHER_L) return -Infinity;
  return (Math.atan2(x, y) + Math.asin(Math.min(1, FEATHER_GAP / rho))) / RAD;
}

/** Ниже какого угла перо не опустится при угле колеса `angleDeg`: упор ближайшего ещё не сорвавшегося штырька. */
export function featherFloorDeg(angleDeg: number): number {
  return featherPushDeg(WHEEL_PEG_RELEASE_DEG - mod(WHEEL_PEG_RELEASE_DEG - angleDeg, WHEEL_PEG_STEP));
}

/** Перо в покое: висит прямо или лежит на штырьке. */
export function featherRestDeg(angleDeg: number): number {
  return Math.max(0, featherFloorDeg(angleDeg));
}

export interface WheelSpinPlan {
  from: number;
  /** Итоговый угол (сектор под пером = серверный). */
  to: number;
  dur: number;
  windupMs: number;
  windupDeg: number;
  settleMs: number;
  overDeg: number;
}

/**
 * План вращения от `from` к `to` (≥ `from`) за `durMs`. Замах — только на свежем старте и не дальше, чем позволяет
 * последний сорвавшийся штырёк (назад сквозь перо он не пойдёт); перекат с откатом — если хватает длины.
 */
export function wheelSpinPlan(from: number, to: number, durMs: number): WheelSpinPlan {
  const dur = Math.max(0, durMs);
  const settleMs = dur >= 1500 ? WHEEL_SETTLE_MS : 0;
  const freeDeg = mod(from - WHEEL_PEG_RELEASE_DEG, WHEEL_PEG_STEP) - 0.5;
  let windupDeg = dur >= WHEEL_SPIN_MS - WHEEL_FRESH_SLACK_MS ? Math.min(WHEEL_WINDUP_MAX_DEG, Math.max(0, freeDeg)) : 0;
  if (windupDeg < 0.5) windupDeg = 0;
  return { from, to, dur, windupMs: windupDeg > 0 ? WHEEL_WINDUP_MS : 0, windupDeg, settleMs, overDeg: settleMs > 0 ? WHEEL_SETTLE_OVER_DEG : 0 };
}

/** Доля пути основного хода за долю времени `u`: линейный разгон, потом спад скорости как (1 − u)^`SPIN_DECAY`. */
function spinEase(u: number): number {
  const a = SPIN_RAMP;
  const m = SPIN_DECAY;
  const total = a / 2 + (1 - a) / (m + 1);
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (u < a) return (u * u) / (2 * a) / total;
  return (a / 2 + ((1 - a) / (m + 1)) * (1 - ((1 - u) / (1 - a)) ** (m + 1))) / total;
}

/** Угол колеса через `tMs` от начала вращения — единственный источник правды для картинки и трещотки. */
export function wheelAngleAt(p: WheelSpinPlan, tMs: number): number {
  if (!(tMs > 0)) return p.from;
  if (tMs >= p.dur) return p.to;
  if (tMs < p.windupMs) return p.from - (p.windupDeg * (1 - Math.cos((Math.PI * tMs) / p.windupMs))) / 2;
  const mainEnd = p.dur - p.settleMs;
  const start = p.from - p.windupDeg;
  if (tMs < mainEnd) return start + (p.to + p.overDeg - start) * spinEase((tMs - p.windupMs) / (mainEnd - p.windupMs));
  return p.to + (p.overDeg * (1 + Math.cos((Math.PI * (tMs - mainEnd)) / p.settleMs))) / 2;
}

/**
 * Моменты срыва штырьков с пера (мс от начала): угол колеса проходит `k·шаг + WHEEL_PEG_RELEASE_DEG`. Ищется только на
 * основном ходу — он монотонен; замах и откат штырёк через перо не проводят (так построен план).
 */
export function wheelPegReleases(p: WheelSpinPlan): number[] {
  const t0 = p.windupMs;
  const t1 = p.dur - p.settleMs;
  if (!(t1 > t0)) return [];
  const a0 = wheelAngleAt(p, t0);
  const a1 = wheelAngleAt(p, t1);
  const out: number[] = [];
  let lo = t0;
  for (let target = a0 + (WHEEL_PEG_STEP - mod(a0 - WHEEL_PEG_RELEASE_DEG, WHEEL_PEG_STEP)); target <= a1; target += WHEEL_PEG_STEP) {
    let hi = t1;
    for (let i = 0; i < 40 && hi - lo > 0.01; i++) {
      const mid = (lo + hi) / 2;
      if (wheelAngleAt(p, mid) < target) lo = mid;
      else hi = mid;
    }
    out.push(hi);
    lo = hi;
  }
  return out;
}

/**
 * Трещотка: каждый срыв штырька — щелчок, но не чаще `gapMs` (`WHEEL_TICK_MIN_GAP_MS`): на разгоне штырьки идут раз в
 * ~15 мс, лишние срывы выбрасываются (перо дрожит без звука), на замедлении каждый штырёк = щелчок в его момент.
 * Щелчка «на остановке» нет: колесо встаёт, упёршись штырьком в перо, — срыва нет.
 */
export function wheelPegClicks(p: WheelSpinPlan, gapMs = WHEEL_TICK_MIN_GAP_MS): number[] {
  const out: number[] = [];
  let prev = -Infinity;
  for (const t of wheelPegReleases(p)) {
    if (t < prev + gapMs) continue;
    out.push(Math.round(t * 10) / 10);
    prev = t;
  }
  return out;
}

/** Пружина пера: ~7 Гц, затухание 0,28 — отпущенное перо проскакивает прямое положение и гаснет за ~0,2 с. */
const FEATHER_W = 2 * Math.PI * 7;
const FEATHER_ZETA = 0.28;
const FEATHER_STEP_MS = 0.5;

/**
 * Перо за всё вращение — выборка раз в `everyMs`: штырёк держит перо снизу (не даёт опуститься ниже упора), сорвался —
 * перо свободно пружинит к прямому положению; на большой скорости следующий штырёк подхватывает его раньше, чем оно
 * успевает упасть, — перо дрожит в отогнутом положении. Детерминировано: те же план и момент — тот же угол у всех.
 */
export function featherTrack(p: WheelSpinPlan, everyMs = 8): { t: number; deg: number }[] {
  const out: { t: number; deg: number }[] = [];
  let phi = featherRestDeg(p.from);
  let w = 0;
  let floorPrev = featherFloorDeg(p.from);
  let nextSample = 0;
  const h = FEATHER_STEP_MS / 1000;
  const steps = Math.ceil(p.dur / FEATHER_STEP_MS);
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(p.dur, i * FEATHER_STEP_MS);
    const floor = featherFloorDeg(wheelAngleAt(p, t));
    if (floor < floorPrev - 5) w = 0; // штырёк сорвался — перо отпущено с места, без разлёта
    w += (-FEATHER_W * FEATHER_W * phi - 2 * FEATHER_ZETA * FEATHER_W * w) * h;
    phi += w * h;
    if (phi < floor) {
      w = Math.max(w, Number.isFinite(floorPrev) ? (floor - floorPrev) / h : 0);
      phi = floor;
    }
    floorPrev = floor;
    if (t >= nextSample - 1e-9 || i === steps) {
      out.push({ t, deg: phi });
      nextSample += everyMs;
    }
  }
  return out;
}

/** Ключевой кадр Web Animations (`Element.animate`), без DOM-типов — правила остаются чистыми. */
export type SpinFrame = {
  offset: number;
  transform: string;
};

/**
 * Ключевые кадры колеса и пера из `wheelAngleAt`/`featherTrack`: колесо — раз в 10 мс, перо — раз в 8 мс, между ними
 * анимация идёт ЛИНЕЙНО (`easing: 'linear'`), так что картинка — та же функция времени, что и щелчки (расхождение
 * пересечения ≤ 0,05 мс). Перо отгибается по ходу вращения — кончик вправо, то есть `rotate` с минусом.
 */
export function wheelSpinFrames(p: WheelSpinPlan, wheelEveryMs = 10, featherEveryMs = 8): { wheel: SpinFrame[]; feather: SpinFrame[] } {
  const wheel: SpinFrame[] = [];
  if (!(p.dur > 0)) return { wheel, feather: [] };
  for (let t = 0; t < p.dur; t += wheelEveryMs) wheel.push({ offset: t / p.dur, transform: `rotate(${wheelAngleAt(p, t).toFixed(3)}deg)` });
  wheel.push({ offset: 1, transform: `rotate(${p.to}deg)` });
  const feather = featherTrack(p, featherEveryMs).map((f) => ({ offset: Math.min(1, f.t / p.dur), transform: `rotate(${(-f.deg).toFixed(2)}deg)` }));
  return { wheel, feather };
}

/**
 * Решение владельца 30.10: «Крутить сейчас» спрашивает «не все поставили» ОДИН раз за сессию — флаг в памяти модуля
 * (не в localStorage: новая вкладка/перезапуск спросит снова). `spinNowAsked` — уже спрашивали; `markSpinNowAsked` — отметить.
 */
let spinNowAskedFlag = false;
export function spinNowAsked(): boolean {
  return spinNowAskedFlag;
}
export function markSpinNowAsked(): void {
  spinNowAskedFlag = true;
}

/**
 * Кто сидит в голосе сервера и ещё не поставил в раунде (боты не в счёт, себя не считаем) — для предупреждения
 * «Крутить сейчас». `voiceUserIds` — люди в голосовых каналах сервера (presence), повторы допустимы.
 */
export function unbetVoiceUsers(voiceUserIds: readonly string[], bets: readonly WheelBetDto[], meId: string | null): string[] {
  const bet = new Set(bets.map((b) => b.userId));
  const out: string[] = [];
  for (const id of voiceUserIds) if (id !== meId && !bet.has(id) && !out.includes(id)) out.push(id);
  return out;
}

/**
 * Блок «Замок раунда … зерно загадано» и «Проверить честность» — только владельцу сервера и тем, у кого право
 * ADMINISTRATOR (решение владельца 30.10). `perms` — права на ЭТОМ сервере или `null` (открыт другой сервер — прав не
 * знаем, не показываем).
 */
export function wheelFairVisible(meId: string | null, ownerId: string | null | undefined, perms: bigint | null): boolean {
  if (!meId) return false;
  if (ownerId && ownerId === meId) return true;
  return perms !== null && isAdmin(perms);
}

/** «Крутить сейчас» видно тому, кто поставил в текущем раунде, пока идёт приём ставок (решение владельца 30.10). */
export function canSpinNow(round: { state: string; bets: readonly WheelBetDto[] } | null, meId: string | null, openLeftMs: number | null): boolean {
  return !!round && round.state === 'open' && !!meId && openLeftMs !== null && openLeftMs > 0 && round.bets.some((b) => b.userId === meId);
}

/**
 * Отказ ставки — человеку. Машинная причина приходит в `reason` (`api.ts` `parseResponse`); незнакомая — текст сервера.
 * Коды этапа 2 — с подчёркиванием, этапа 1 (деньги, `gameMoneyRules.StakeBlock`) — через дефис.
 */
export function wheelBetErrorText(reason: string | undefined, fallback: string): string {
  switch (reason) {
    case 'not_in_voice':
      return 'Ставки принимаются только с палубы — зайди в голосовой канал этого сервера';
    case 'round_locked':
      return 'Колесо уже крутится — ставка пойдёт в следующий раунд';
    case 'cooldown':
      return 'Команда переводит дух — новый раунд через несколько секунд';
    case 'duplicate_pick':
    case 'duplicate':
      return 'На это число ты уже поставил в этом раунде';
    case 'games-off':
      return 'Игры на этом сервере выключены';
    case 'opted-out':
      return 'Ты не участвуешь в экономике — включи её в настройках сервера';
    case 'games-opted-out':
      return 'Ты выключил себе игры — включить можно в кошельке';
    case 'over-bet-max':
      return 'Больше максимальной ставки на этом сервере';
    case 'poor':
      return 'Не хватает монет в сундуке';
    case 'loss-limit':
      return 'Сегодняшний предел проигрыша исчерпан — завтра снова в море';
    case 'bad-amount':
      return 'Ставка — целое число монет, от одной';
    case 'bot':
      return 'Боты не играют';
    default:
      return fallback || 'Ставка не прошла';
  }
}

function hexOf(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** SHA-256 строки UTF-8 через `crypto.subtle`; в небезопасном окне (http не localhost) его нет — `null`. */
export async function sha256(text: string): Promise<Uint8Array | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(buf);
}

export type WheelVerdict =
  | { ok: true; sector: number }
  | { ok: false; why: 'commit' | 'sector' | 'unavailable'; sector?: number };

/**
 * «Проверить честность»: зерно раунда (открыто после итога) даёт тот самый замок `commit`, что висел с начала
 * раунда, и тот самый сектор. `digest` подменяемый — для проверки без `crypto.subtle`.
 */
export async function verifyWheelResult(
  r: Pick<WheelResultDto, 'id' | 'seed' | 'commit' | 'sector'>,
  digest: (text: string) => Promise<Uint8Array | null> = sha256,
): Promise<WheelVerdict> {
  const commit = await digest(wheelCommitInput(r.id, r.seed));
  if (!commit) return { ok: false, why: 'unavailable' };
  if (hexOf(commit) !== r.commit.toLowerCase()) return { ok: false, why: 'commit' };
  const h = await digest(wheelSectorInput(r.id, r.seed));
  if (!h) return { ok: false, why: 'unavailable' };
  const sector = sectorFromHash(h);
  return sector === r.sector ? { ok: true, sector } : { ok: false, why: 'sector', sector };
}

/** Пометка навязанного срыва в итоге раунда (флаг тестового инстанса `WHEEL_FORCE_JACKPOT`). */
export const WHEEL_FORCED_TEXT = 'принудительный (dev)';

/**
 * Вердикт проверки честности в строку для `FairCheck`. 🔴 Раунд с навязанным срывом (`forced`) НЕ получает зелёную
 * галку, даже если замок и сектор сошлись: сундук в нём сорван флагом тестового сервера, а не зерном.
 */
export function wheelVerdictView(
  verdict: WheelVerdict,
  result: { sector: number; forced?: boolean },
): { tone: 'ok' | 'bad'; text: string } {
  if (verdict.ok) {
    return result.forced === true
      ? { tone: 'bad', text: `⚠ Раунд ${WHEEL_FORCED_TEXT}: замок и сектор сошлись, но сундук сорван флагом тестового сервера, а не зерном` }
      : { tone: 'ok', text: '✓ Совпадает: зерно открывает замок, и сектор тот самый' };
  }
  if (verdict.why === 'unavailable') return { tone: 'bad', text: 'Браузер здесь не умеет считать хеш (нужно защищённое соединение)' };
  if (verdict.why === 'commit') return { tone: 'bad', text: '✗ Зерно не открывает замок раунда' };
  return { tone: 'bad', text: `✗ По зерну выходит сектор ${verdict.sector}, а не ${result.sector}` };
}

/**
 * Сколько держится эмоция капитана и открытый сундук после итога раунда (по часам сервера от `settledAt`), потом —
 * обычный капитан и закрытый сундук. Пауза между раундами `WHEEL_COOLDOWN_MS` дольше — следующий раунд эмоцию не застанет.
 */
export const WHEEL_MOOD_MS = 8000;

/**
 * Эмоция капитана на итог: `idle` — поза покоя под штурвалом, `joy` — кадр танца (на живой итог — пляска, `wheelFx.ts`),
 * `jackpot` — пик `captain-peak`, `sad` — цельный кадр `captain-sad`.
 */
export type WheelMood = 'idle' | 'joy' | 'sad' | 'jackpot';

/**
 * Эмоция на итог раунда: сундук сорван — `jackpot` всем (и при принудительном dev-срыве `forced`); иначе моя ставка
 * выиграла — `joy`, ставил и мимо — `sad`; не ставил — капитан не меняется. Вне окна `WHEEL_MOOD_MS` после `settledAt`
 * (и без итога) — `idle`. `iBet` — были ли мои ставки в раунде итога (сам итог называет только выигравших).
 */
export function wheelMood(
  last: Pick<WheelResultDto, 'jackpotHit' | 'settledAt' | 'winners'> | null,
  meId: string | null,
  iBet: boolean,
  serverNowMs: number,
): WheelMood {
  if (!last) return 'idle';
  const at = Date.parse(last.settledAt);
  if (!Number.isFinite(at) || serverNowMs - at > WHEEL_MOOD_MS) return 'idle';
  if (last.jackpotHit) return 'jackpot';
  if (meId && last.winners.some((w) => w.userId === meId && w.payout > 0)) return 'joy';
  return iBet ? 'sad' : 'idle';
}

/** Эмоция казначея (красный попугай на сундуке): `idle` — цикл ожидания, `cheer`/`sad` — кадр на окно итога. */
export type ParrotMood = 'idle' | 'cheer' | 'sad' | 'jackpot';

/**
 * Эмоция казначея на итог (то же окно `WHEEL_MOOD_MS`): сундук сорван — `jackpot`; мой выигрыш — `cheer`; ставил и
 * мимо — `sad`; сам не ставил, но кто-то выиграл — тоже `cheer` (крупье радуется за стол); иначе — `idle`.
 */
export function parrotMood(
  last: Pick<WheelResultDto, 'jackpotHit' | 'settledAt' | 'winners'> | null,
  meId: string | null,
  iBet: boolean,
  serverNowMs: number,
): ParrotMood {
  const m = wheelMood(last, meId, iBet, serverNowMs);
  if (m === 'jackpot') return 'jackpot';
  if (m === 'joy') return 'cheer';
  if (m === 'sad') return 'sad';
  if (!last || iBet) return 'idle';
  const at = Date.parse(last.settledAt);
  const fresh = Number.isFinite(at) && serverNowMs - at <= WHEEL_MOOD_MS;
  return fresh && last.winners.some((w) => w.payout > 0) ? 'cheer' : 'idle';
}
