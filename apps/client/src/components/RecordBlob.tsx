import { useEffect, useRef, useState } from 'react';
import { useLiteMode } from '../liteMode';
import {
  REC_BLOB,
  accelDecel,
  ampNew,
  ampSet,
  ampTick,
  blobMode,
  blobNew,
  blobPath,
  blobStep,
  canvasDpr,
  circleFrame,
  easeOut,
  exitKindOf,
  exitMs,
  waveScale,
  type Blob,
  type BlobExit,
} from '../recordBlob';

/** Человек просил меньше движения — круг стоит, волн нет. */
function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Круг записи голосового под пальцем (#218) — Telegram Android `ChatActivityEnterView.RecordCircle` +
 * `BlobDrawable` (математика и константы — `recordBlob.ts`). Лежит внутри `.mic-btn` под значком.
 *
 * Пока палец держит (`hold`) — холст с двумя живыми кляксами и сплошным кругом, rAF крутится. Удержание кончилось —
 * играет уход по тому, ЧЕМ кончилось (`exitKindOf`): замок — круг стекает в кнопку, отправка — `exitTransition`
 * (набухание и сжатие), отмена — `canceledByGesture`; доиграл — холст снимается, rAF останавливается.
 * Оптимизированный режим (`gv-lite`) — круг стилем без волн и без холста; `prefers-reduced-motion` — неподвижный круг.
 */
export function RecordCircle(props: { hold: boolean; level: number; slide: number; recording: boolean; recBusy: boolean }) {
  const lite = useLiteMode();
  const [reduced] = useState(prefersReducedMotion);
  const mode = blobMode({ reducedMotion: reduced, lite });
  const [prevHold, setPrevHold] = useState(props.hold);
  const [exit, setExit] = useState<BlobExit | null>(null);
  const [session, setSession] = useState(0);
  // Смена удержания ловится тем же рендером (React «состояние из пропсов»): в этот момент `recording`/`recBusy`
  // уже говорят, чем кончилось — контроллер ставит их тем же синхронным шагом, что и `holdUi: null`.
  if (prevHold !== props.hold) {
    setPrevHold(props.hold);
    if (props.hold) {
      setExit(null);
      setSession((s) => s + 1);
    } else {
      setExit(mode === 'blob' ? exitKindOf(props) : null);
    }
  }
  if (mode !== 'blob') {
    if (!props.hold) return null;
    return (
      <span
        className={`rec-circle ${mode}`}
        aria-hidden
        style={{ '--lvl': mode === 'static' ? 0 : props.level } as React.CSSProperties}
      />
    );
  }
  if (!props.hold && !exit) return null;
  return <BlobCanvas key={session} level={props.level} slide={props.slide} exit={exit} onDone={() => setExit(null)} />;
}

function drawBlob(ctx: CanvasRenderingContext2D, b: Blob, c: number): void {
  const segs = blobPath(b, c, c);
  ctx.beginPath();
  ctx.moveTo(segs[0].x0, segs[0].y0);
  for (const s of segs) ctx.bezierCurveTo(s.c1x, s.c1y, s.c2x, s.c2y, s.x, s.y);
  ctx.closePath();
  ctx.fill();
}

function BlobCanvas(props: { level: number; slide: number; exit: BlobExit | null; onDone: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef(props);
  live.current = props;
  const amps = useRef({ big: ampNew(), tiny: ampNew(), circle: ampNew() });

  // Новая громкость — новая цель сглаживания (Telegram `setAmplitude` на каждый отсчёт рекордера).
  useEffect(() => {
    const a = amps.current;
    ampSet(a.big, props.level, 'big');
    ampSet(a.tiny, props.level, 'tiny');
    ampSet(a.circle, props.level, 'circle');
  }, [props.level]);

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const dpr = canvasDpr(window.devicePixelRatio);
    const half = REC_BLOB.canvasHalf;
    cv.width = Math.round(half * 2 * dpr);
    cv.height = Math.round(half * 2 * dpr);
    // Цвет — из стилей (`color: var(--accent)` у холста): тема меняется без перерисовки кода.
    const color = getComputedStyle(cv).color || '#5865f2';
    const big = blobNew('big');
    const tiny = blobNew('tiny');
    const a = amps.current;
    const t0 = performance.now();
    let last = t0;
    let enter = 0;
    let exitAt: number | null = null;
    let exitFrom = 0;
    let radiusNow = 0;
    let raf = 0;
    const frame = (now: number) => {
      const dt = Math.max(0, Math.min(64, now - last));
      last = now;
      const frames = dt / REC_BLOB.frameMs;
      const st = live.current;
      ampTick(a.big, dt);
      ampTick(a.tiny, dt);
      ampTick(a.circle, dt);
      enter = Math.min(1, enter + REC_BLOB.wavesEnterStep * frames);
      if (st.exit && exitAt === null) {
        exitAt = now;
        exitFrom = radiusNow;
      }
      const t = st.exit && exitAt !== null ? (now - exitAt) / exitMs(st.exit) : 0;
      const f = circleFrame({
        scale: accelDecel((now - t0) / REC_BLOB.appearMs),
        amp: a.circle.value,
        slide: st.slide,
        exit: st.exit,
        t,
        fromR: exitFrom,
      });
      if (!st.exit) radiusNow = f.radius;
      blobStep(big, a.big.value, REC_BLOB.big.speedScale, frames);
      blobStep(tiny, a.tiny.value, REC_BLOB.tiny.speedScale, frames);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (st.exit && t >= 1) {
        st.onDone();
        return;
      }
      ctx.fillStyle = color;
      const w = f.waves * easeOut(enter);
      if (w > 0) {
        for (const [b, kind] of [
          [big, 'big'],
          [tiny, 'tiny'],
        ] as const) {
          const s = waveScale(kind, a[kind].value, w) * dpr;
          ctx.setTransform(s, 0, 0, s, half * dpr * (1 - s / dpr), half * dpr * (1 - s / dpr));
          ctx.globalAlpha = REC_BLOB[kind].alpha;
          drawBlob(ctx, b, half);
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = f.alpha;
      ctx.beginPath();
      ctx.arc(half, half, Math.max(0, f.radius), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} className="rec-blob" aria-hidden />;
}
