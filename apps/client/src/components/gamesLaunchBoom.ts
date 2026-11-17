/**
 * Движок сцены «БУМ» (запуск игр, решения владельца 29.10, пп. 12–14): акт 1 — море и галеон на холсте, залп, переход
 * дымом; акт 2 — палуба, знакомство с командой по нажатию, финал с карточкой. Перенос одобренного прототипа
 * (`gc2/anim/template2.html`) без изменения формул моря, ватерлинии, приглушения у борта и инерционной качки — их проверяла
 * симуляция `gc2/anim/sim.mjs`. React-оболочка — `GamesLaunchScene.tsx` (разметка, звук, загрузка кадров, клавиши).
 *
 * Отличия от прототипа — только инженерные:
 * - ОДИН цикл `requestAnimationFrame` на всё (море, палуба, частицы, твины, ожидания) и своё время сцены `clock`: пока цикл
 *   стоит (`setPaused` — окно накрыто или впереди игра, вкладка скрыта), сцена замирает, а не «проматывается»;
 * - ожидания (`wait`) считаются по тому же времени, а не `setTimeout` — после `destroy` ничего не просыпается;
 * - размер корабля на полном экране растёт с высотой (`Math.max(440, h * 0.8)`), в прототипе окно было 480 px высотой, но не
 *   больше `SHIP_MAX_W` — кадры корабля вдвое крупнее прототипа (1120 px), сильнее растянутые мылятся (владелец 29.10);
 * - глубина палубы по вертикали поджимается в окнах шире 16:9 (`DECK_FLOOR`): иначе лапы стоящих впереди уходили под нижнюю полосу.
 */

export interface BoomEls {
  stage: HTMLElement;
  cam: HTMLElement;
  sea: HTMLCanvasElement;
  fx: HTMLCanvasElement;
  deck: HTMLElement;
  sway: HTMLElement;
  worldB: HTMLElement;
  worldF: HTMLElement;
  actors: HTMLElement;
  glow: HTMLElement;
  veil: HTMLElement;
  veilC: HTMLCanvasElement;
  flashAll: HTMLElement;
  plaque: HTMLElement;
  plWho: HTMLElement;
  plLine: HTMLElement;
  barT: HTMLElement;
  barB: HTMLElement;
  card: HTMLElement;
  hint: HTMLElement;
}

export type BoomSound = 'horn' | 'cannon' | 'bell';

export interface BoomOpts {
  reduce: boolean;
  /** Кадры по имени файла без расширения (`hull`, `sails-1`, `cap-hello`…), заранее загруженные оболочкой. */
  images: Record<string, HTMLImageElement>;
  sound: (key: BoomSound, vol: number) => void;
  stopHorn: () => void;
  /** Карточка показана (финал или «Пропустить»). */
  onFinal: () => void;
}

export interface Boom {
  advance: () => void;
  skip: () => void;
  setPaused: (paused: boolean) => void;
  destroy: () => void;
}

type Step = (x: CanvasRenderingContext2D, w: number, h: number, dt: number) => boolean;
interface Fx {
  canvas: HTMLCanvasElement;
  list: Step[];
  dirty: boolean;
}

const ready = (i: HTMLImageElement | undefined): i is HTMLImageElement => !!(i && i.complete && i.naturalWidth > 0);
const ease = (k: number) => 1 - Math.pow(1 - k, 3);
const eio = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const back = (k: number) => 1 + 2.70158 * Math.pow(k - 1, 3) + 1.70158 * Math.pow(k - 1, 2);

function fit(c: HTMLCanvasElement) {
  const rw = c.clientWidth,
    rh = c.clientHeight,
    d = window.devicePixelRatio || 1;
  if (c.width !== Math.round(rw * d) || c.height !== Math.round(rh * d)) {
    c.width = Math.round(rw * d);
    c.height = Math.round(rh * d);
  }
  const x = c.getContext('2d')!;
  x.setTransform(d, 0, 0, d, 0, 0);
  x.clearRect(0, 0, rw, rh);
  return { x, w: rw, h: rh };
}

/** Ширина корабля не больше этой (CSS px): кадры корабля — ×2 от прототипа (1120 px, из мастеров Codex), дальше растяжение мылит. */
const SHIP_MAX_W = 1120;
/** Нижняя кромка видимой палубы — над киношной полосой `.boom-bars.on` (8 % высоты снизу). */
const DECK_FLOOR = 0.92;
/** Самая ближняя к зрителю глубина (`wy`) — выход попугая на представление; по ней поджимается глубина палубы. */
const FRONT_WY = 612;
/** Пушечные порты по длине корпуса (доля ширины картинки от центра). */
const PORTS = [-0.295, -0.18, -0.06, 0.02, 0.11];
/** Реплики (в тексте `\u00a0` перед тире — тире не уходит в начало строки, `\u2060` после дефиса — слово не рвётся на дефисе;
 * в Ruslan Display нет неразрывного дефиса U+2011) — в вызовах `say`/`parrotIn` ниже. Реплики и цвета ролей — как в прототипе (решение владельца 29.10, п. 14). */
const WHO: Record<string, [string, string]> = {
  cap: ['Капитан', '#f2b53c'],
  red: ['Казначей', '#ff7d68'],
  judge: ['Квартирмейстер', '#5fdc9a'],
  host: ['Впередсмотрящий', '#6cc4ff'],
};
/** Место в ряду: доля видимой полуширины сцены (−1 — левый край, +1 — правый), чтобы на 360 px все стояли в кадре. */
const ROW = {
  cap: { fx: -0.64, wy: 556, dep: 0.88 },
  red: { fx: -0.27, wy: 548, dep: 0.95 },
  judge: { fx: 0.3, wy: 548, dep: 0.95 },
  host: { fx: 0.69, wy: 548, dep: 0.95 },
};

interface Actor {
  el: HTMLDivElement;
  imgs: Record<string, HTMLImageElement>;
  ax: number;
  ay: number;
  wx: number;
  wy: number;
  dep: number;
  lift: number;
  sx: number;
  sy: number;
  rot: number;
  op: number;
  sq: number;
  sqv: number;
  ph: number;
  cur: string | null;
  crew: boolean;
  idle: number;
  rest: number;
  set: (name: string) => void;
}

export function startBoom(E: BoomEls, O: BoomOpts): Boom {
  const reduce = O.reduce;
  const IM = O.images;
  const im = (k: string) => IM[k];

  /* ---------- Время сцены и единый цикл ---------- */
  let raf = 0,
    paused = false,
    dead = false,
    last = 0,
    clock = 0;
  interface Timer {
    at: number;
    done: () => void;
  }
  interface Tween {
    t0: number;
    ms: number;
    fn: (k: number) => void;
    finish: () => void;
  }
  const timers = new Set<Timer>();
  const tweens = new Set<Tween>();
  const RUN = { skip: false, fast: false, live: false, wake: new Set<() => void>() };
  let ACT = 1;

  function kick() {
    if (!raf && !paused && !dead) raf = requestAnimationFrame(loop);
  }
  function loop(t: number) {
    raf = 0;
    if (dead || paused) return;
    const dt = last ? Math.min(50, Math.max(0, t - last)) : 1000 / 60;
    last = t;
    clock += dt;
    try {
      for (const tm of [...timers]) if (clock >= tm.at) tm.done();
      for (const tw of [...tweens]) {
        const k = Math.max(0, Math.min(1, (clock - tw.t0) / tw.ms));
        tw.fn(k);
        if (k >= 1) tw.finish();
      }
      if (ACT === 1) seaFrame(clock, dt);
      else deckFrame(clock, dt / 1000);
      fxStep(boomFx, dt / 1000);
      fxStep(veilFx, dt / 1000);
      flashStep(dt);
    } catch (e) {
      console.error('[boom]', e);
    }
    raf = requestAnimationFrame(loop);
  }

  function wait(ms: number): Promise<void> {
    if (RUN.skip || RUN.fast || ms <= 0) return Promise.resolve();
    return new Promise((res) => {
      const tm: Timer = { at: clock + ms, done: () => {} };
      const done = () => {
        timers.delete(tm);
        RUN.wake.delete(done);
        res();
      };
      tm.done = done;
      timers.add(tm);
      RUN.wake.add(done);
    });
  }
  function tw(ms: number, fn: (k: number) => void): Promise<void> {
    if (RUN.skip || RUN.fast || reduce) {
      fn(1);
      return Promise.resolve();
    }
    return new Promise((res) => {
      let fin = false;
      const tween: Tween = { t0: clock, ms, fn, finish: () => {} };
      const finish = () => {
        fin = true;
        tweens.delete(tween);
        RUN.wake.delete(jump);
        res();
      };
      const jump = () => {
        if (fin) return;
        fn(1);
        finish();
      };
      tween.finish = finish;
      RUN.wake.add(jump);
      fn(0);
      tweens.add(tween);
    });
  }

  /* ---------- Частицы (dt в секундах: телефон бывает 120 Гц) ---------- */
  const boomFx: Fx = { canvas: E.fx, list: [], dirty: false };
  const veilFx: Fx = { canvas: E.veilC, list: [], dirty: false };
  function fxStep(fx: Fx, dt: number) {
    if (!fx.list.length) {
      if (fx.dirty) {
        fit(fx.canvas);
        fx.dirty = false;
      }
      return;
    }
    const { x, w, h } = fit(fx.canvas);
    fx.dirty = true;
    fx.list = fx.list.filter((p) => p(x, w, h, dt) !== false);
    x.globalAlpha = 1;
  }
  let flashA = 0;
  function flashStep(dt: number) {
    if (flashA <= 0) return;
    flashA = Math.max(0, flashA - (0.22 * dt) / 260);
    E.flashAll.style.opacity = flashA.toFixed(3);
  }

  /* ================= Акт 1: море и корабль на одном холсте ================= */
  const CAM = { zoom: 1, shake: 0 };
  interface Pose {
    cx: number;
    yUnder: number;
    sw: number;
    shh: number;
    waterline: number;
    ang: number;
  }
  const SHIP = {
    x: 0.5,
    v: 0,
    sail: false,
    scale: 1,
    bowA: 0,
    wakeA: 0,
    yS: undefined as number | undefined,
    vy: 0,
    sl: 0,
    vs: 0,
    pose: null as Pose | null,
  };
  const SAILS = [1, 2, 3, 4].map((i) => im(`sails-${i}`)),
    FLAG = [1, 2, 3, 4].map((i) => im(`flag-${i}`));
  const BOW = [1, 2, 3].map((i) => im(`bow-${i}`)),
    WAKE = [1, 2, 3].map((i) => im(`wake-${i}`)),
    CREST = [1, 2, 3].map((i) => im(`crest-${i}`));
  interface Crest {
    x: number;
    vx: number;
    w: number;
    layer: number;
    age: number;
    life: number;
    f: number;
  }
  const crests: Crest[] = [];
  let crestNext = 0;
  /* Корпус гасит волну вокруг себя: у борта амплитуда до 60 % меньше (иначе гребни заливают пушечные порты). */
  const CALM = { cx: -1e9, sw: 1, on: false };
  const calmK = (x: number) => (CALM.on ? 1 - 0.6 * Math.exp(-(((x - CALM.cx) / (0.55 * CALM.sw)) ** 2)) : 1);
  /* Высота волны: сумма синусоид — длинная зыбь + короткая рябь; t в мс. */
  function waveY(x: number, t: number, base: number, amp: number) {
    amp *= calmK(x);
    return base + amp * (Math.sin(x / 140 + t / 1300) * 0.55 + Math.sin(x / 61 - t / 820) * 0.3 + Math.sin(x / 23 + t / 430) * 0.15);
  }
  function waveLayer(x: CanvasRenderingContext2D, w: number, h: number, t: number, base: number, amp: number, fill: string, crest: boolean) {
    x.beginPath();
    x.moveTo(0, h);
    for (let px = 0; px <= w + 4; px += 4) x.lineTo(px, waveY(px, t, base, amp));
    x.lineTo(w, h);
    x.closePath();
    x.fillStyle = fill;
    x.fill();
    if (crest) {
      /* дальняя пена на гребнях: белым только там, где волна у вершины */
      for (let px = 0; px <= w; px += 3) {
        const y = waveY(px, t, base, amp),
          y2 = waveY(px + 3, t, base, amp),
          top = base - amp * 0.55;
        if (y < top + amp * 0.35) {
          x.fillStyle = `rgba(240,246,252,${0.55 * (1 - (y - top) / (amp * 0.35))})`;
          x.fillRect(px, Math.min(y, y2) - 1, 3, 2.5);
        }
      }
    }
  }
  /* Гребни-спрайты на передних волнах: редко, плывут, проявляются и гаснут */
  function drawCrests(x: CanvasRenderingContext2D, t: number, layer: number, tm: number, base: number, amp: number) {
    for (const c of crests) {
      if (c.layer !== layer) continue;
      const a = Math.sin(Math.PI * Math.min(1, c.age / c.life));
      if (a <= 0) continue;
      const img = CREST[(c.f + Math.floor(t / 210)) % 3];
      if (!ready(img)) continue;
      const ch = (c.w * 40) / 260,
        y = waveY(c.x, t * tm, base, amp);
      x.globalAlpha = 0.9 * Math.pow(a, 0.8);
      x.drawImage(img, c.x - c.w / 2, y - ch * 0.62, c.w, ch);
      x.globalAlpha = 1;
    }
  }
  function seaFrame(t: number, dt: number) {
    const { x, w, h } = fit(E.sea);
    const horizon = h * 0.47;
    const sky = x.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#0b1526');
    sky.addColorStop(1, '#22406a');
    x.fillStyle = sky;
    x.fillRect(0, 0, w, horizon + 2);
    for (let i = 0; i < 40; i++) {
      x.fillStyle = `rgba(232,238,246,${0.25 + 0.2 * Math.sin(t / 700 + i)})`;
      x.fillRect((i * 97.3) % w, (i * 53.7) % (horizon * 0.8), 1.5, 1.5);
    }
    /* низкая луна за линией хода и дорожка бликов по воде — корабль идёт сквозь свет */
    const mx = w * 0.62,
      my = horizon - 34,
      glow = x.createRadialGradient(mx, my, 0, mx, my, 150);
    glow.addColorStop(0, 'rgba(255,236,190,0.55)');
    glow.addColorStop(1, 'rgba(255,236,190,0)');
    x.fillStyle = glow;
    x.fillRect(mx - 150, my - 150, 300, 300);
    x.fillStyle = '#fff1cf';
    x.beginPath();
    x.arc(mx, my, 24, 0, 7);
    x.fill();
    const deep = x.createLinearGradient(0, horizon, 0, h);
    deep.addColorStop(0, '#16446b');
    deep.addColorStop(1, '#071a2c');
    x.fillStyle = deep;
    x.fillRect(0, horizon, w, h - horizon);
    for (let i = 0; i < 70; i++) {
      const yy = horizon + 4 + (i / 70) * (h * 0.32),
        spread = 10 + (yy - horizon) * 0.55,
        xx = mx + Math.sin(i * 12.9 + t / 600) * spread;
      x.fillStyle = `rgba(255,236,190,${0.08 + 0.22 * Math.abs(Math.sin(i * 3.1 + t / 300))})`;
      x.fillRect(xx, yy, 6 + (yy - horizon) * 0.08, 1.4);
    }
    CALM.on = false;
    waveLayer(x, w, h, t, horizon + 10, 3, 'rgba(30,80,120,0.6)', false);
    waveLayer(x, w, h, t * 1.1, horizon + 34, 6, 'rgba(22,66,104,0.75)', true);
    /* корабль */
    if (SHIP.sail) SHIP.x += (SHIP.v * dt) / 1000;
    const sw = Math.min(w * 0.7, Math.max(440, h * 0.8), SHIP_MAX_W) * (SHIP.scale || 1),
      shh = (sw * 399) / 560,
      cx = SHIP.x * w,
      waterBase = h * 0.75;
    /* Корпус «сидит» на средней воде под всей длиной: качка мягкая, днище всегда ниже самой глубокой ложбины. Качку меряем по открытой волне. */
    const amp = reduce ? 0 : 7 * Math.min(1, sw / 400),
      pts = [-0.4, -0.2, 0, 0.2, 0.4].map((k) => waveY(cx + k * sw, t, waterBase + 4, amp));
    CALM.cx = cx;
    CALM.sw = sw;
    CALM.on = true;
    const yAvg = pts.reduce((a, b) => a + b, 0) / pts.length,
      yTarget = (waterBase + 4) * 0.65 + yAvg * 0.35;
    const slopeTarget = reduce ? 0 : ((pts[4]! - pts[0]!) / (0.8 * sw)) * 0.35;
    /* Тяжёлый галеон: корпус догоняет воду пружиной с затуханием (≈1,5 с), а не следует за ней мгновенно. */
    const k = dt / 1000,
      stiff = 2.2,
      damp = 2.6;
    if (SHIP.yS === undefined || reduce) {
      SHIP.yS = yTarget;
      SHIP.vy = 0;
      SHIP.sl = slopeTarget;
      SHIP.vs = 0;
    }
    SHIP.vy += ((yTarget - SHIP.yS) * stiff * stiff - SHIP.vy * damp) * k;
    SHIP.yS += SHIP.vy * k;
    SHIP.vs += ((slopeTarget - SHIP.sl) * stiff * stiff - SHIP.vs * damp) * k;
    SHIP.sl += SHIP.vs * k;
    const yUnder = SHIP.yS,
      ang = Math.atan(SHIP.sl);
    /* доля высоты картинки на средней воде: порты (0,81) над водой, днище (0,965) глубже ложбин */
    const waterline = 0.9;
    /* бурун и след живут, пока есть ход: бурун гаснет за ~0,35 с, след тянется дольше */
    const spd = SHIP.sail ? SHIP.v : 0;
    SHIP.bowA += (Math.min(1, spd / 0.12) - SHIP.bowA) * (1 - Math.exp(-dt / 350));
    SHIP.wakeA += (Math.min(1, spd / 0.08) - SHIP.wakeA) * (1 - Math.exp(-dt / (spd > 0.04 ? 450 : 1500)));
    if (cx > -sw && cx < w + sw) {
      x.save();
      x.translate(cx, yUnder);
      x.rotate(ang);
      const L = (img: HTMLImageElement | undefined, al: number) => {
        if (ready(img) && al > 0) {
          x.globalAlpha = al;
          x.drawImage(img, -sw / 2, -shh * waterline, sw, shh);
        }
      };
      L(im('hull'), 1);
      const si = reduce ? 3 : Math.round(((1 - Math.cos((t / 1600) * Math.PI * 2)) / 2) * 3);
      L(SAILS[si], 1);
      L(FLAG[reduce ? 0 : Math.floor(t / 125) % 4], 1);
      const fl = reduce
        ? 0.85
        : Math.max(0.35, Math.min(1, 0.72 + 0.18 * Math.sin(t / 170) + 0.12 * Math.sin(t / 53 + 1.7) + 0.07 * Math.sin(t / 23)));
      L(im('lanterns'), fl);
      x.globalAlpha = 1;
      x.globalCompositeOperation = 'lighter';
      const hx = (53 / 560 - 0.5) * sw,
        hy = (261 / 399 - waterline) * shh,
        hr = 0.17 * sw,
        hg = x.createRadialGradient(hx, hy, 0, hx, hy, hr);
      hg.addColorStop(0, `rgba(255,186,90,${(0.3 * fl).toFixed(3)})`);
      hg.addColorStop(1, 'rgba(255,186,90,0)');
      x.fillStyle = hg;
      x.fillRect(hx - hr, hy - hr, hr * 2, hr * 2);
      x.globalCompositeOperation = 'source-over';
      /* пенный след за кормой и бурун у форштевня — кадры; низ уходит под переднюю волну */
      if (SHIP.wakeA > 0.01) {
        const ww = 0.62 * sw,
          wh = (ww * 70) / 320,
          img = WAKE[Math.floor(t / 140) % 3];
        if (ready(img)) {
          x.globalAlpha = 0.95 * SHIP.wakeA;
          x.drawImage(img, -0.33 * sw - ww, -wh * 0.74, ww, wh);
        }
      }
      if (SHIP.bowA > 0.01) {
        const bw = 0.34 * sw,
          bob = 0.88 + 0.12 * Math.sin(t / 95),
          bh = bw * 0.5 * (0.55 + 0.45 * SHIP.bowA) * bob,
          img = BOW[Math.floor(t / 110) % 3];
        if (ready(img)) {
          x.globalAlpha = SHIP.bowA;
          x.drawImage(img, 0.315 * sw - bw, -bh * 0.8, bw, bh);
        }
      }
      x.globalAlpha = 1;
      x.restore();
    }
    /* гребни: редкие, живут 2,6–4 с */
    if (!reduce && t > crestNext) {
      crestNext = t + 1200 + Math.random() * 1600;
      const layer = Math.random() < 0.55 ? 0 : 1;
      crests.push({
        x: Math.random() * w,
        vx: (Math.random() < 0.5 ? -1 : 1) * (10 + Math.random() * 16),
        w: (100 + Math.random() * 70) * Math.min(1, w / 640) * (layer ? 1.3 : 1),
        layer,
        age: 0,
        life: 2600 + Math.random() * 1400,
        f: Math.floor(Math.random() * 3),
      });
    }
    for (let i = crests.length - 1; i >= 0; i--) {
      const c = crests[i]!;
      c.age += dt;
      c.x += (c.vx * dt) / 1000;
      if (c.age >= c.life) crests.splice(i, 1);
    }
    /* передняя волна — ПОВЕРХ корпуса: ниже ватерлинии корабль скрыт водой */
    waveLayer(x, w, h, t * 0.95, waterBase + 4, amp, 'rgba(14,52,86,0.92)', false);
    drawCrests(x, t, 0, 0.95, waterBase + 4, amp);
    waveLayer(x, w, h, t * 1.2, waterBase + 44, reduce ? 0 : 9, 'rgba(8,34,58,0.95)', false);
    drawCrests(x, t, 1, 1.2, waterBase + 44, reduce ? 0 : 9);
    SHIP.pose = { cx, yUnder, sw, shh, waterline, ang };
    /* камера: наезд + затухающая встряска */
    CAM.shake *= Math.pow(0.0008, dt / 1000);
    const sx = (Math.random() - 0.5) * CAM.shake,
      sy = (Math.random() - 0.5) * CAM.shake;
    E.cam.style.transform = `translate(${sx.toFixed(2)}px, ${sy.toFixed(2)}px) scale(${CAM.zoom.toFixed(4)})`;
  }

  function smoke(px: number, py: number, delay: number) {
    let r = 8,
      a = 0.9,
      age = -delay;
    const dx = (Math.random() - 0.5) * 0.5 + 0.25,
      dy = -0.18 - Math.random() * 0.25;
    boomFx.list.push((x, _w, _h, dt) => {
      age += dt;
      if (age < 0) return true;
      const f = dt * 60;
      r += 0.75 * f;
      a -= 0.0062 * f;
      px += dx * f;
      py += dy * f;
      if (a <= 0) return false;
      const gr = x.createRadialGradient(px, py, 0, px, py, r);
      gr.addColorStop(0, `rgba(210,214,222,${a.toFixed(3)})`);
      gr.addColorStop(1, 'rgba(210,214,222,0)');
      x.fillStyle = gr;
      x.beginPath();
      x.arc(px, py, r, 0, 7);
      x.fill();
      return true;
    });
  }
  function flash(px: number, py: number) {
    let f = 1;
    boomFx.list.push((x, _w, _h, dt) => {
      f -= 0.07 * dt * 60;
      if (f <= 0) return false;
      const gr = x.createRadialGradient(px, py, 0, px, py, 34 * f + 6);
      gr.addColorStop(0, `rgba(255,236,170,${f.toFixed(3)})`);
      gr.addColorStop(0.4, `rgba(242,140,40,${(f * 0.8).toFixed(3)})`);
      gr.addColorStop(1, 'rgba(242,140,40,0)');
      x.fillStyle = gr;
      x.beginPath();
      x.arc(px, py, 40, 0, 7);
      x.fill();
      return true;
    });
    for (let i = 0; i < 7; i++) smoke(px + (Math.random() - 0.5) * 14, py + (Math.random() - 0.5) * 6, i * 0.035);
  }
  /* Клуб дыма-наплыва: растёт на весь кадр, держится, гаснет вместе с вуалью */
  function puff(px: number, py: number, vx: number, vy: number, r0: number, grow: number, delay: number, amax = 0.92, tk = 1) {
    let age = -delay,
      r = r0;
    veilFx.list.push((x, _w, _h, dt) => {
      age += dt * tk;
      if (age < 0) return true;
      r += grow * dt * tk * Math.max(0.25, 1 - age / 2.2);
      px += vx * dt;
      py += vy * dt;
      const a = amax * (age < 0.55 ? age / 0.55 : age < 1.35 ? 1 : Math.max(0, 1 - (age - 1.35) / 0.95));
      if (a <= 0 && age > 1) return false;
      const gr = x.createRadialGradient(px, py, 0, px, py, r);
      gr.addColorStop(0, `rgba(240,240,238,${a.toFixed(3)})`);
      gr.addColorStop(0.6, `rgba(214,219,226,${(a * 0.75).toFixed(3)})`);
      gr.addColorStop(1, 'rgba(200,206,216,0)');
      x.fillStyle = gr;
      x.beginPath();
      x.arc(px, py, r, 0, 7);
      x.fill();
      return true;
    });
  }
  function fire(i: number) {
    const p = SHIP.pose;
    if (!p) return;
    const lx = PORTS[i]! * p.sw,
      ly = -p.shh * (p.waterline - 0.81),
      c = Math.cos(p.ang),
      s2 = Math.sin(p.ang);
    O.sound('cannon', Math.max(0.4, 0.95 - i * 0.11));
    flash(p.cx + lx * c - ly * s2, p.yUnder + lx * s2 + ly * c);
    /* отдача: корабль кренит от борта и приподнимает */
    SHIP.vs -= 0.05;
    SHIP.vy -= 6;
    CAM.shake = Math.min(14, CAM.shake + 9);
    flashA = 0.22;
  }
  /* «Нас переносит на корабль»: дым валит из портов на весь кадр, камера ныряет в него */
  async function smokeIn() {
    const p = SHIP.pose,
      W = E.stage.clientWidth,
      H = E.stage.clientHeight,
      big = Math.hypot(W, H);
    const ox = p ? p.cx : W / 2,
      oy = p ? p.yUnder - p.shh * 0.12 : H * 0.6;
    for (let i = 0; i < 26; i++) {
      const px = ox + (Math.random() - 0.5) * (p ? p.sw : 300) * 0.9,
        py = oy + (Math.random() - 0.5) * 50,
        dx = px - ox;
      puff(px, py, dx * 0.5 + (Math.random() - 0.5) * 60, -30 - Math.random() * 50, 30 + Math.random() * 30, big * (0.26 + Math.random() * 0.2), i * 0.03);
    }
    void tw(1300, (k) => {
      CAM.zoom = 1.07 + 0.25 * k * k;
    });
    await wait(250);
    await tw(1000, (k) => {
      E.veil.style.opacity = Math.pow(k, 1.5).toFixed(3);
    });
    E.veil.style.opacity = '1';
  }

  /* ================= Акт 2: палуба ================= */
  function actor(poses: Record<string, string>, w: number, h: number, ax: number, ay: number): Actor {
    const el = document.createElement('div');
    el.className = 'boom-actor';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    el.style.transformOrigin = `${ax}px ${ay}px`;
    const imgs: Record<string, HTMLImageElement> = {};
    for (const k of Object.keys(poses)) {
      const i = document.createElement('img');
      i.src = IM[poses[k]!]?.src ?? '';
      i.alt = '';
      i.draggable = false;
      el.appendChild(i);
      imgs[k] = i;
    }
    E.actors.appendChild(el);
    const o: Actor = {
      el,
      imgs,
      ax,
      ay,
      wx: 640,
      wy: 612,
      dep: 1,
      lift: 0,
      sx: 1,
      sy: 1,
      rot: 0,
      op: 0,
      sq: 0,
      sqv: 0,
      ph: Math.random() * 6,
      cur: null,
      crew: false,
      idle: 0,
      rest: 0,
      set: (name) => {
        if (o.cur === name) return;
        if (o.cur) o.imgs[o.cur]!.classList.remove('on');
        o.imgs[name]!.classList.add('on');
        o.cur = name;
      },
    };
    return o;
  }
  /* порядок слоёв: капитан сзади, попугаи по очереди выхода, общий кадр — спереди */
  const CAPT = actor({ hello: 'cap-hello', present: 'cap-present', bow: 'cap-bow' }, 380, 420, 190, 408);
  const RED = actor({ hello: 'red-hello', spin: 'red-spin', bow: 'red-bow' }, 380, 420, 190, 408);
  const JUDGE = actor({ hello: 'judge-hello', whistle: 'judge-whistle', bow: 'judge-bow' }, 380, 420, 190, 408);
  const HOST = actor({ hello: 'host-hello', announce: 'host-announce', bow: 'host-bow' }, 380, 420, 190, 408);
  const CREW = actor({ wave: 'crew-wave' }, 900, 380, 528, 373);
  CREW.crew = true;
  const CAST = [CAPT, RED, JUDGE, HOST, CREW];

  /* Геометрия: фон палубы — «cover» с запасом под качку; актёры — в мировых координатах 1280×720, по ширине ужимаются */
  function geo() {
    const W = E.stage.clientWidth,
      H = E.stage.clientHeight,
      S = Math.max(W / 1280, H / 720) * 1.05;
    return { W, H, S, a: Math.min(S, W / 800) };
  }
  const edge = (dir: number) => {
    const g = geo();
    return 640 + dir * (g.W / 2 / g.a + 260);
  };
  /** Верх карточки финала (над ней встаёт общий кадр команды); учитывает отступ безопасной зоны снизу. */
  const cardTop = () => {
    const g = geo();
    return E.card.offsetHeight ? E.card.offsetTop - 8 : g.H - 18 - 140 - 8;
  };
  function deckFrame(t: number, dt: number) {
    const { W, H, S, a } = geo();
    const wt = `translate(${(-640 * S).toFixed(2)}px, ${(-360 * S).toFixed(2)}px) scale(${S.toFixed(5)})`;
    E.worldB.style.transform = wt;
    E.worldF.style.transform = wt;
    if (!reduce) {
      /* тяжёлое медленное покачивание всей палубы: крен ≈0,9°, подъём ≈4 px, период ≈5,6 с */
      const ph = (t / 5600) * Math.PI * 2;
      E.sway.style.transform = `translateY(${(4 * Math.sin(ph + 1.2)).toFixed(2)}px) rotate(${(0.9 * Math.sin(ph)).toFixed(3)}deg)`;
      E.glow.style.opacity = Math.max(
        0.35,
        Math.min(1, 0.72 + 0.16 * Math.sin(t / 190) + 0.1 * Math.sin(t / 61 + 2) + 0.06 * Math.sin(t / 27)),
      ).toFixed(3);
    } else {
      E.sway.style.transform = '';
      E.glow.style.opacity = '0.8';
    }
    /* пульс подсказки «нажми» (прототип: 1,6 с, прозрачность 0,55↔1, масштаб 0,97↔1,03) — здесь, а не вечной CSS-анимацией:
       встаёт вместе со сценой под игрой и в накрытом окне */
    if (hintOn) {
      const p = reduce ? 1 : (1 - Math.cos((t / 1600) * Math.PI * 2)) / 2;
      E.hint.style.opacity = (0.55 + 0.45 * p).toFixed(3);
      E.hint.style.transform = `translateX(-50%) scale(${(0.97 + 0.06 * p).toFixed(4)})`;
    }
    const fy = cardTop();
    for (const o of CAST) {
      if (o.op <= 0) {
        if (o.el.style.display !== 'none') o.el.style.display = 'none';
        continue;
      }
      if (o.el.style.display !== 'block') o.el.style.display = 'block';
      if (reduce) {
        o.sq = 0;
        o.sqv = 0;
      } else {
        o.sqv += (-180 * o.sq - 11 * o.sqv) * dt;
        o.sq += o.sqv * dt;
      }
      let X: number, Y: number, sc: number;
      if (o.crew) {
        sc = Math.min(a, (W * 0.94) / 724, Math.max(0.2, (fy - 14) / 362)) * o.dep;
        X = W / 2;
        Y = fy;
      } else {
        X = W / 2 + (o.wx - 640) * a;
        Y = H / 2 + (o.wy - 360) * Math.min(S, (H * (DECK_FLOOR - 0.5) - 10) / (FRONT_WY - 360));
        sc = a * o.dep;
      }
      let rot = o.rot,
        lift = o.lift;
      if (o.idle && !reduce) {
        rot += o.idle * 1.4 * Math.sin(t / 420 + o.ph);
        lift += o.idle * 4 * Math.abs(Math.sin(t / 300 + o.ph));
      }
      Y -= lift * sc;
      const br = reduce ? 0 : 0.012 * Math.sin(t / 470 + o.ph);
      const sy = o.sy * (1 + o.sq + br),
        sx = o.sx * (1 - 0.7 * o.sq - 0.5 * br);
      o.el.style.opacity = Math.min(1, o.op).toFixed(3);
      o.el.style.transform = `translate(${(X - o.ax).toFixed(2)}px, ${(Y - o.ay).toFixed(2)}px) rotate(${rot.toFixed(2)}deg) scale(${(sc * sx).toFixed(4)}, ${(sc * sy).toFixed(4)})`;
    }
  }
  function say(key: string, text: string, o: Actor) {
    const [who, color] = WHO[key]!;
    E.plWho.textContent = who;
    E.plaque.style.setProperty('--who', color);
    E.plLine.textContent = text;
    E.plaque.classList.remove('on');
    void E.plaque.offsetWidth;
    E.plaque.classList.add('on');
    const g = geo(),
      X = g.W / 2 + (o.wx - 640) * g.a,
      pw = E.plaque.offsetWidth;
    E.plaque.style.setProperty('--tail', Math.max(24, Math.min(pw - 24, X - (g.W - pw) / 2)).toFixed(0) + 'px');
  }
  const unsay = () => E.plaque.classList.remove('on');
  /* Прыжками к точке: вытягивание в полёте, «шлёп» с приседанием на каждом приземлении */
  async function hop(o: Actor, to: { wx: number; wy: number; dep?: number }, ms: number, n: number, hgt: number) {
    const f = { wx: o.wx, wy: o.wy, dep: o.dep };
    let landed = 0;
    await tw(ms, (k) => {
      const e = eio(k);
      o.wx = f.wx + (to.wx - f.wx) * e;
      o.wy = f.wy + (to.wy - f.wy) * e;
      if (to.dep != null) o.dep = f.dep + (to.dep - f.dep) * e;
      const ph = Math.min(n, k * n),
        cnt = Math.floor(ph),
        arc = k >= 1 ? 0 : Math.sin(Math.PI * (ph - cnt));
      o.lift = hgt * arc;
      o.sy = 1 + 0.08 * arc;
      o.sx = 1 - 0.05 * arc;
      if (cnt > landed && k < 1) {
        landed = cnt;
        o.sqv -= 2.2;
      }
    });
    o.lift = 0;
    o.sx = 1;
    o.sy = 1;
    o.sqv -= 3;
  }
  /* Смена позы: присел — подскок — новый кадр в воздухе — приземлился с пружинкой */
  async function pose(o: Actor, name: string, h: number) {
    o.sqv -= 2;
    await wait(70);
    o.set(name);
    await tw(280, (k) => {
      o.lift = h * Math.sin(Math.PI * k);
      o.sy = 1 + 0.06 * Math.sin(Math.PI * k);
    });
    o.lift = 0;
    o.sy = 1;
    o.sqv -= 2.6;
  }
  async function wiggle(o: Actor, ms: number, amp: number, per: number) {
    await tw(ms, (k) => {
      o.rot = amp * Math.sin(((k * ms) / per) * Math.PI * 2) * (1 - 0.4 * k);
    });
    o.rot = 0;
  }
  function slotX(fx: number) {
    const g = geo();
    return 640 + fx * (g.W / 2 / g.a);
  }
  /* Попугай выходит: влетает дугой в центр, табличка, жест-кадр — и ждёт нажатия */
  async function parrotIn(o: Actor, key: string, dir: number, line: string, mid: string) {
    o.set('hello');
    o.wx = edge(dir);
    o.wy = 612;
    o.dep = 1.25;
    o.op = 1;
    o.rot = dir * 14;
    o.rest = 0;
    const f0 = o.wx,
      r0 = o.rot;
    await tw(560, (k) => {
      const e = ease(k);
      o.wx = f0 + (640 + dir * 6 - f0) * e;
      o.lift = 150 * Math.sin(Math.PI * (0.5 + 0.5 * k));
      o.rot = r0 * (1 - k);
      o.sy = 1.07 - 0.07 * k;
      o.sx = 0.96 + 0.04 * k;
    });
    o.lift = 0;
    o.rot = 0;
    o.sx = 1;
    o.sy = 1;
    o.sqv -= 3.4;
    say(key, line, o);
    await wait(300);
    await pose(o, mid, 24);
    await wiggle(o, 700, 4, 350);
  }
  /* …и после нажатия кланяется и прыжками отходит на своё место в ряду */
  async function parrotOut(o: Actor, key: keyof typeof ROW) {
    unsay();
    await pose(o, 'bow', 8);
    await wait(280);
    o.set('hello');
    const s = ROW[key];
    await hop(o, { wx: slotX(s.fx), wy: s.wy, dep: s.dep }, 650, 2, 22);
    o.rest = 0.3;
    o.idle = 0.3;
  }
  let hintOn = false;
  function hint(on: boolean) {
    hintOn = on;
    E.hint.classList.toggle('on', on);
    if (!on) {
      E.hint.style.opacity = '';
      E.hint.style.transform = '';
    }
  }
  /* Ворота шага: подсказка «нажми», говорящий покачивается; нажатие во время анимации только дотягивает её до конца */
  let gateRes: (() => void) | null = null;
  function gate(who: Actor | null): Promise<void> {
    RUN.fast = false;
    if (RUN.skip) return Promise.resolve();
    if (who) who.idle = 1;
    hint(true);
    return new Promise((res) => {
      const done = () => {
        RUN.wake.delete(done);
        gateRes = null;
        hint(false);
        if (who) who.idle = who.rest || 0;
        res();
      };
      gateRes = done;
      RUN.wake.add(done);
    });
  }
  function advance() {
    if (!RUN.live || ACT !== 2 || dead) return;
    if (gateRes) {
      gateRes();
      return;
    }
    RUN.fast = true;
    for (const w of [...RUN.wake]) w();
  }
  async function act2() {
    const g = geo();
    CAPT.set('hello');
    CAPT.wx = 640 - (g.W / 2 / g.a + 200);
    CAPT.wy = 612;
    CAPT.dep = 1;
    CAPT.op = 1;
    CAPT.rest = 0;
    void tw(900, (k) => {
      E.veil.style.opacity = (1 - k).toFixed(3);
    }).then(() => {
      E.veil.style.opacity = '0';
    });
    await wait(300);
    await hop(CAPT, { wx: 640, wy: 612 }, 950, 3, 38);
    say('cap', 'Добро пожаловать на борт!', CAPT);
    await wiggle(CAPT, 900, 3, 450);
    await gate(CAPT);
    await pose(CAPT, 'present', 20);
    say('cap', 'Знакомьтесь\u00a0— моя команда!', CAPT);
    await gate(CAPT);
    /* капитан отходит к левому краю, лицом к центру, и остаётся в кадре с лёгким покачиванием */
    unsay();
    await hop(CAPT, { wx: slotX(ROW.cap.fx), wy: ROW.cap.wy, dep: ROW.cap.dep }, 760, 2, 24);
    CAPT.rest = 0.4;
    CAPT.idle = 0.4;
    await parrotIn(RED, 'red', -1, 'Колесо гусей-\u2060пиратов\u00a0— я кручу удачу!', 'spin');
    await gate(RED);
    await parrotOut(RED, 'red');
    await parrotIn(JUDGE, 'judge', 1, 'Дуэли\u00a0— я слежу за честностью!', 'whistle');
    await gate(JUDGE);
    await parrotOut(JUDGE, 'judge');
    await parrotIn(HOST, 'host', 1, 'Ставки на события\u00a0— угадывай и забирай долю банка!', 'announce');
    await gate(HOST);
    await parrotOut(HOST, 'host');
    CAPT.idle = 0;
    await pose(CAPT, 'bow', 10);
    await wait(500);
  }
  async function finale() {
    unsay();
    const g = geo(),
      fy = cardTop();
    if (!RUN.skip && !reduce)
      for (let i = 0; i < 12; i++) {
        const ang = (i / 12) * Math.PI * 2;
        puff(g.W / 2 + Math.cos(ang) * 40, fy - 90 + Math.sin(ang) * 30, Math.cos(ang) * 120, Math.sin(ang) * 60 - 20, 18, 70, 0, 0.55, 2.2);
      }
    CREW.set('wave');
    CREW.op = 1;
    CREW.dep = 0.5;
    E.barT.classList.remove('on');
    E.barB.classList.remove('on');
    void tw(260, (k) => {
      for (const o of [CAPT, RED, JUDGE, HOST]) o.op = 1 - k;
    });
    await tw(520, (k) => {
      CREW.dep = 0.5 + 0.5 * back(k);
    });
    CREW.dep = 1;
    CREW.sqv -= 3;
    CREW.idle = 1;
    await wait(250);
    if (dead) return;
    E.card.classList.add('on');
    O.sound('bell', 0.9);
    O.onFinal();
  }

  /* ---------- Сценарий «БУМ» ---------- */
  async function run() {
    RUN.live = true;
    E.barT.classList.add('on');
    E.barB.classList.add('on');
    kick();
    if (reduce) {
      SHIP.x = 0.5;
      SHIP.scale = 1;
      SHIP.sail = false;
      O.sound('horn', 0.7);
      await wait(1800);
    } else {
      SHIP.x = -0.5;
      SHIP.sail = true;
      SHIP.v = 0.4;
      SHIP.scale = 0.82;
      SHIP.bowA = 0;
      SHIP.wakeA = 0;
      /* гудок — с первых метров хода */
      void wait(500).then(() => {
        if (!RUN.skip && !dead) O.sound('horn', 0.7);
      });
      /* медленный тяжёлый подход: 4,8 с, ход гаснет к центру, корабль растёт (идёт к нам), камера наезжает */
      await tw(4800, (k) => {
        SHIP.v = 0.4 * (1 - Math.pow(k, 1.4)) + 0.002;
        SHIP.scale = 0.82 + 0.18 * (1 - Math.pow(1 - k, 2));
        CAM.zoom = 1 + 0.07 * k * k;
      });
      SHIP.sail = false;
      SHIP.v = 0;
      if (RUN.skip) SHIP.x = 0.5;
      await wait(700);
      for (let i = 0; i < PORTS.length; i++) {
        if (i) await wait(230);
        if (!RUN.skip) fire(i);
      }
      await wait(520);
      if (!RUN.skip) await smokeIn();
    }
    if (dead) return;
    /* смена сцены под вуалью */
    E.veil.style.opacity = reduce ? '0' : '1';
    ACT = 2;
    E.cam.style.visibility = 'hidden';
    E.deck.classList.add('on');
    await act2();
    if (dead) return;
    if (RUN.skip) {
      veilFx.list.length = 0;
      E.veil.style.opacity = '0';
      for (const o of CAST) {
        o.lift = 0;
        o.rot = 0;
        o.sx = 1;
        o.sy = 1;
      }
    }
    await finale();
    RUN.live = false;
    hint(false);
  }
  void run();

  return {
    advance,
    skip() {
      if (dead || RUN.skip) return;
      RUN.skip = true;
      for (const w of [...RUN.wake]) w();
      O.stopHorn();
    },
    setPaused(p) {
      if (p === paused) return;
      paused = p;
      last = 0;
      if (p && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      kick();
    },
    destroy() {
      dead = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      timers.clear();
      tweens.clear();
      RUN.wake.clear();
      gateRes = null;
      boomFx.list.length = 0;
      veilFx.list.length = 0;
      for (const c of [E.sea, E.fx, E.veilC]) {
        c.width = 0;
        c.height = 0;
      }
      for (const o of CAST) o.el.remove();
    },
  };
}
