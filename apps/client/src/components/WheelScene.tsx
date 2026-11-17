import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { permsFromString, WHEEL_JACKPOT_ODDS, WHEEL_PICKS, WHEEL_SECTORS, type WheelBetDto, type WheelPick } from '@gusvoice/shared';
import { api } from '../api';
import { GameRules } from './GameRules';
import { isMockEconomy } from '../benchMock';
import { confirmAction } from '../confirm';
import coinDefaultIcon from '../assets/guscoin.svg';
import captainUrl from '../assets/wheel/captain.png';
import faceUrl from '../assets/wheel/face.png';
import hubUrl from '../assets/wheel/hub.png';
import pointerUrl from '../assets/wheel/pointer.png';
import rimUrl from '../assets/wheel/rim.png';
import { gamesView } from '../economy';
import { ensureWheel } from '../economyClient';
import { useLiteMode } from '../liteMode';
import { usePhoneLayout } from '../phoneLayout';
import { playSound, scheduleWheelTicks, soundDurationMs, warmBuiltinSound } from '../sounds';
import { useStore, voiceIsHere } from '../store';
import {
  CAPTAIN_DANCE_MS,
  CHEST_BURST_MS,
  CHEST_FX_MS,
  captainPoseAt,
  chestPoseAt,
  CoinLayer,
  FxLoop,
  fountainCoins,
  handfulCoins,
  jackpotGlowAt,
  jackpotGlowMs,
  PARROT_FRAMES,
  parrotBob,
  ParrotIdle,
  parrotJackpotAt,
  rainCoins,
  type CaptainDance,
  type CaptainFrame,
  type CaptainPose,
  type ParrotFrame,
} from '../wheelFx';
import {
  betPresets,
  canSpinNow,
  clampBet,
  clockLabel,
  multiplierLabel,
  PICK_COLOR,
  pickSectors,
  featherRestDeg,
  spinProgress,
  spinTurns,
  wheelLandAngle,
  wheelLandTarget,
  wheelPegClicks,
  wheelSectorAt,
  wheelSpinFrames,
  wheelSpinPlan,
  markSpinNowAsked,
  spinNowAsked,
  unbetVoiceUsers,
  verifyWheelResult,
  WHEEL_FORCED_TEXT,
  wheelFairVisible,
  wheelMood,
  parrotMood,
  wheelVerdictView,
  wheelBetErrorText,
  wheelPhase,
  type WheelMood,
  type WheelVerdict,
} from '../wheelRules';
import { useWindowMotion } from '../windowCovered';
import { WheelBets } from './WheelBets';
import { BottomSheet } from './BottomSheet';
import { Icon } from './Icon';

/**
 * Сцена «Колесо гусей-пиратов» (ГусКоины 2, этап 2) — грузится лениво (`Activities.tsx`), вместе с ней и картинки колеса.
 *
 * ПК — крупная карточка `.modal-overlay > .modal` (рамка как у `RecountNotice`/`EconomyWelcome`), телефон (`usePhoneLayout`,
 * ≤ 760) — `BottomSheet page`. Разметка одна.
 *
 * Колесо — слои арта `trial-r322` (холст 1024×1200, колесо 1024×1024 со смещением 176 сверху, центр [512,688]): face/rim/hub
 * вращаются вместе (штырьки на границах секторов нарисованы в `rim.png`, R357), перо (`pointer.png`, весь холст) качается на оси. Фаза +7.2° уже нарисована —
 * сектор под пером даёт `wheelRestAngle` из shared; встаёт колесо не в центр сектора, а у кромки (`wheelLandAngle`).
 *
 * Вращение — анимация Web Animations (`Element.animate`) поверх уже итогового угла: сервер присылает сектор при
 * блокировке окна (`wheel.state` locked), кручение длится до `settleAt`. Вошёл посреди — докручиваем остаток (меньше
 * оборотов, без замаха); ушёл из окна и вернулся — фаза по часам (`syncSpin`); `prefers-reduced-motion` — сразу итог.
 * 30.10 — одна формула угла (`wheelAngleAt`): по ней ключевые кадры колеса и пера (`wheelSpinFrames`, линейно) и щелчки
 * трещотки в моменты срыва штырька с пера (`wheelPegClicks`, не чаще порога).
 */

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Кадры капитана, сундука, казначея-попугая и монет (арт ГусКоинов 2) — динамическим `import()`: статически сцена подключает ровно пять
 * слоёв колеса (страж `Activities.wheelWiring`). Капитан — слоями на холсте 265×384 (поза ПОД штурвалом
 * `captain-helm`, ступни на одной линии), сундуки — один ракурс 429×384, монета — полоса 12 кадров вращения 64×64.
 * URL отдаём только после того, как картинки загружены (`decode`), — первая смена кадра не мигает пустым местом. Пока
 * не загрузились — цельный `captain.png`, сундука нет, анимаций нет. Грусть — цельный кадр `captain-sad` (со своим
 * штурвалом): позы «грусть без штурвала» нет, а придумывать её CSS-ом поверх весёлого кадра — не тот рисунок.
 */
type WheelArt = {
  sad: string;
  cap: Record<CaptainFrame, string>;
  helm: string;
  chest: [string, string, string, string, string];
  rays: string;
  /** Казначей — красный попугай на сундуке (`red-*.png`, холст 429×560 поверх холста сундука). */
  parrot: Record<ParrotFrame, string>;
  coins: HTMLImageElement;
};
const CAPTAIN_FRAMES: CaptainFrame[] = ['idle', 'dance1', 'dance2', 'peak'];
function useWheelArt(): WheelArt | null {
  const [art, setArt] = useState<WheelArt | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      import('../assets/wheel/captain-sad.png'),
      import('../assets/wheel/captain-idle.png'),
      import('../assets/wheel/captain-dance-1.png'),
      import('../assets/wheel/captain-dance-2.png'),
      import('../assets/wheel/captain-peak.png'),
      import('../assets/wheel/captain-helm.png'),
      import('../assets/wheel/chest-closed.png'),
      import('../assets/wheel/chest-crack.png'),
      import('../assets/wheel/chest-half.png'),
      import('../assets/wheel/chest-open.png'),
      import('../assets/wheel/chest-burst.png'),
      import('../assets/wheel/chest-rays.png'),
      import('../assets/wheel/coin-spin.png'),
      import('../assets/wheel/red-sit-1.png'),
      import('../assets/wheel/red-sit-2.png'),
      import('../assets/wheel/red-sit-3.png'),
      import('../assets/wheel/red-watch.png'),
      import('../assets/wheel/red-cheer.png'),
      import('../assets/wheel/red-sad.png'),
      import('../assets/wheel/red-jackpot-1.png'),
      import('../assets/wheel/red-jackpot-2.png'),
    ])
      .then(async ([sad, idle, d1, d2, peak, helm, c0, c1, c2, c3, c4, rays, coin, p1, p2, p3, pw, pc, ps, pj1, pj2]) => {
        const coins = new Image();
        coins.src = coin.default;
        const next: WheelArt = {
          sad: sad.default,
          cap: { idle: idle.default, dance1: d1.default, dance2: d2.default, peak: peak.default },
          helm: helm.default,
          chest: [c0.default, c1.default, c2.default, c3.default, c4.default],
          rays: rays.default,
          parrot: {
            sit1: p1.default,
            sit2: p2.default,
            sit3: p3.default,
            watch: pw.default,
            cheer: pc.default,
            sad: ps.default,
            jp1: pj1.default,
            jp2: pj2.default,
          },
          coins,
        };
        const urls = [next.sad, ...Object.values(next.cap), next.helm, ...next.chest, next.rays, ...Object.values(next.parrot)];
        await Promise.all([
          coins.decode().catch(() => {}),
          ...urls.map((src) => {
            const img = new Image();
            img.src = src;
            return img.decode().catch(() => {});
          }),
        ]);
        if (alive) setArt(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return art;
}

/** Капитанская поза → узлы рига: кадр — атрибутом (CSS показывает один `img`), подскок и штурвал — трансформом. */
function applyCaptain(body: HTMLElement | null, helm: HTMLElement | null, p: CaptainPose, px: number): void {
  if (!body || !helm) return;
  body.dataset.frame = p.frame;
  body.style.transform = `translateY(${(-p.lift * px).toFixed(2)}px) rotate(${p.rot.toFixed(2)}deg) scale(${p.sx.toFixed(4)}, ${p.sy.toFixed(4)})`;
  helm.style.transform = `rotate(${p.wheel.toFixed(2)}deg)`;
}

function shortHash(h: string): string {
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-8)}` : h;
}

export default function WheelScene({ serverId, onClose, onBack }: { serverId: string; onClose: () => void; onBack: () => void }) {
  const phone = usePhoneLayout();
  const view = useStore((s) => s.wheel[serverId]);
  const eco = useStore((s) => s.economy[serverId]);
  const meId = useStore((s) => s.user?.id ?? null);
  const members = useStore((s) => s.members);
  const presence = useStore((s) => s.presence);
  const inVoiceHere = useStore((s) => !!s.voice && voiceIsHere(s.voice) && (s.voice.serverId ?? s.bootstrap?.server.id) === serverId);
  const setWheel = useStore((s) => s.setWheel);
  const now = useTick(500);
  const art = useWheelArt();

  // Снимок заново при открытии и возврате фокуса: событие одним пушем могло потеряться.
  useEffect(() => {
    // Макет стенда (`benchMock.mockWheelSnapshot`) живой снимок не затирает.
    if (isMockEconomy()) return;
    ensureWheel(serverId, true);
    const onFocus = () => ensureWheel(serverId, true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [serverId]);

  useEffect(() => {
    if (phone) return; // у листа свой Esc
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone, onClose]);

  // ——— Вращение ———
  // 🔴 30.10 (догоняние после ухода из окна): угол в разметке (`angle`) — ВСЕГДА итоговый, с первого кадра вращения;
  // само вращение — анимация Web Animations поверх него с началом, приколотым к часам (`spin.start`, шкала
  // `performance.now`). Раньше крутил CSS `transition`, а он живёт только в отрисованном окне: под `gv-covered` его
  // гасит `transition: none !important`, в скрытой вкладке переход заводится лишь на первом кадре после возврата, —
  // колесо вставало на старом угле или докручивало с нуля, хотя итог уже на табличке. Теперь при возврате (вкладка
  // видна, снят `gv-covered`/пауза, фокус) `syncSpin` ставит анимацию на фазу по часам, а кончилось — снимает её:
  // под ней уже итоговый угол, без прокрутки.
  const [angle, setAngle] = useState(() => wheelLandAngle(view?.last ? view.last.sector : 0));
  const [spinning, setSpinning] = useState(false);
  const angleRef = useRef(angle);
  angleRef.current = angle;
  const rotRef = useRef<HTMLDivElement>(null);
  const featherRef = useRef<HTMLImageElement>(null);
  const spinRef = useRef<{
    id: string;
    start: number;
    dur: number;
    ticks: number[];
    frames: Keyframe[];
    featherFrames: Keyframe[];
    anim: Animation | null;
    feather: Animation | null;
  } | null>(null);
  const spunRound = useRef<string | null>(null);
  const stopTicks = useRef<() => void>(() => {});
  const holdRef = useRef(false);
  const endTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishSpin = () => {
    const s = spinRef.current;
    spinRef.current = null;
    if (endTimer.current) clearTimeout(endTimer.current);
    endTimer.current = null;
    s?.anim?.cancel();
    s?.feather?.cancel();
    setSpinning(false);
  };
  // Щелчки — от начала вращения `s.start` (якорь на часах страницы): прошедшие выбрасываются, остаток — на своих местах.
  const scheduleRestTicks = (s: NonNullable<typeof spinRef.current>) => {
    stopTicks.current();
    stopTicks.current = scheduleWheelTicks(s.ticks, s.start);
  };
  /** Поставить вращение на фазу по часам: кончилось — снять (итоговый угол уже в разметке); пауза — заморозить там же. */
  const syncSpin = (retick: boolean) => {
    const s = spinRef.current;
    if (!s) return;
    const elapsed = performance.now() - s.start;
    const p = spinProgress(elapsed, s.dur);
    const el = rotRef.current;
    if (p.done || !el || typeof el.animate !== 'function') {
      finishSpin();
      return;
    }
    if (!s.anim) {
      // Колесо и перо — линейно по частым кадрам одной функции угла (`wheelSpinFrames`), с одного начала `s.start`.
      s.anim = el.animate(s.frames, { duration: s.dur, easing: 'linear' });
      s.anim.onfinish = () => {
        if (spinRef.current === s) finishSpin();
      };
      const pen = featherRef.current;
      s.feather = pen && typeof pen.animate === 'function' && s.featherFrames.length > 1 ? pen.animate(s.featherFrames, { duration: s.dur, easing: 'linear' }) : null;
    }
    if (holdRef.current) {
      s.anim.pause();
      s.anim.currentTime = p.atMs;
      if (s.feather) {
        s.feather.pause();
        s.feather.currentTime = p.atMs;
      }
    } else {
      if (s.feather) s.feather.startTime = s.start;
      // Начало — то же `s.start`, что у трещотки (шкала `document.timeline` = `performance.now`), а не «текущий кадр
      // минус прошедшее»: время кадра отстаёт от `performance.now` до 16 мс, и колесо обгоняло бы щелчки.
      s.anim.startTime = s.start;
      if (retick) scheduleRestTicks(s);
    }
    if (endTimer.current) clearTimeout(endTimer.current);
    endTimer.current = setTimeout(() => syncSpin(false), s.dur - p.atMs + 50);
  };
  const round = view?.round ?? null;
  const roundBets = useRef<{ serverId: string; id: string; bets: WheelBetDto[] } | null>(null);
  if (round) roundBets.current = { serverId, id: round.id, bets: round.bets };
  const lockedSector = round?.state === 'locked' ? round.sector : null;
  useEffect(() => {
    if (!view || !round || lockedSector === null || spunRound.current === round.id) return;
    spunRound.current = round.id;
    const ph = wheelPhase(view, Date.now());
    const left = ph.kind === 'spinning' ? ph.leftMs : 0;
    const from = angleRef.current;
    finishSpin();
    stopTicks.current();
    if (reducedMotion() || left < 400) {
      setAngle(wheelLandTarget(from, lockedSector, 0));
      return;
    }
    const to = wheelLandTarget(from, lockedSector, spinTurns(left));
    // Замах, ход, перекат с откатом — одна функция угла; на свежем старте — замах, вошёл посреди — без него.
    const plan = wheelSpinPlan(from, to, left);
    const fr = wheelSpinFrames(plan);
    const s = { id: round.id, start: performance.now(), dur: left, ticks: wheelPegClicks(plan), frames: fr.wheel, featherFrames: fr.feather, anim: null, feather: null };
    spinRef.current = s;
    setAngle(to);
    setSpinning(true);
    // Анимация и трещотка — от одного начала `s.start`: щелчок — в момент срыва штырька с пера.
    syncSpin(false);
    scheduleRestTicks(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.id, lockedSector]);
  useEffect(
    () => () => {
      stopTicks.current();
      finishSpin();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Итог и угол не расходятся никогда: угол в разметке не на секторе итога (проспали блокировку, открыли сцену в паузе,
  // сектор блокировки разошёлся с итогом) — снять вращение и встать на сектор молча.
  const last = view?.last ?? null;
  useEffect(() => {
    // Живой раунд новее итога (идёт приём ставок или вращение к новому сектору) — итог прошлого раунда угол не трогает.
    if (!last || (round && round.id !== last.id)) return;
    if (wheelSectorAt(angleRef.current) !== last.sector) {
      if (spinRef.current) {
        stopTicks.current();
        finishSpin();
      }
      setAngle(wheelLandTarget(angleRef.current, last.sector, 0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last, round?.id]);

  // Возврат в окно: вкладка снова видна, окно в фокусе, снята пауза (`holdFx` ниже) — колесо на фазу по часам.
  useEffect(() => {
    const onBack = () => {
      if (document.visibilityState === 'visible') syncSpin(true);
    };
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('focus', onBack);
    window.addEventListener('pageshow', onBack);
    return () => {
      document.removeEventListener('visibilitychange', onBack);
      window.removeEventListener('focus', onBack);
      window.removeEventListener('pageshow', onBack);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Мои ставки по раундам — итог (`wheel.result`) называет только выигравших, а «мимо» человеку тоже надо сказать.
  const myBetsByRound = useRef(new Map<string, WheelBetDto[]>());
  if (round && meId) {
    const mine = round.bets.filter((b) => b.userId === meId);
    if (mine.length) myBetsByRound.current.set(round.id, mine);
  }

  // ——— Анимации итога (`wheelFx.ts`) ———
  // Один цикл кадров на сцену: стоит, пока окно накрыто игрой (`gv-covered`) или — в оптимизированном режиме — пока
  // впереди игра (как анимированные аватарки, `Avatar`); спрятанную вкладку останавливает сам `requestAnimationFrame`.
  // Размонтирование — `dispose()`: ни кадра, ни отложенного выстрела после закрытия сцены.
  const loopRef = useRef<FxLoop | null>(null);
  useEffect(() => {
    const loop = new FxLoop();
    loopRef.current = loop;
    return () => {
      loop.dispose();
      loopRef.current = null;
    };
  }, []);
  const motion = useWindowMotion();
  const lite = useLiteMode();
  const holdFx = motion.covered || (motion.gameFg && lite);
  useEffect(() => loopRef.current?.setPaused(holdFx), [holdFx]);
  // Вращение стоит вместе с циклом анимаций и на снятии паузы встаёт на фазу по часам (трещотка — заново с остатка).
  holdRef.current = holdFx;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => syncSpin(!holdFx), [holdFx]);
  const artRef = useRef(art);
  artRef.current = art;
  /** Идущая анимация итога: пока она есть, кадры капитана ведёт цикл, а не `wheelMood`. */
  const [fx, setFx] = useState<{ id: string; kind: CaptainDance } | null>(null);
  /** Крупный план сундука поверх колеса (только джекпот). */
  const [chestStage, setChestStage] = useState(false);
  /** Свечение за сундуком у суммы — пока звучит выстрел с фанфарами (`jackpotGlowMs`); сундук всё это время открыт. */
  const [glowing, setGlowing] = useState(false);
  const chestGlowRef = useRef<HTMLSpanElement>(null);
  const chestHaloRef = useRef<HTMLSpanElement>(null);
  const chestRaysRef = useRef<HTMLImageElement>(null);
  // Запись выстрела — заранее в буфер: так известна её длина (свечение) и первый выстрел не ждёт сети.
  useEffect(() => warmBuiltinSound('wheelJackpot'), []);
  const burstSound = useRef<() => void>(() => {});
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const capRigRef = useRef<HTMLDivElement>(null);
  const capBodyRef = useRef<HTMLDivElement>(null);
  const capHelmRef = useRef<HTMLImageElement>(null);
  const fxVeilRef = useRef<HTMLDivElement>(null);
  const fxGlowRef = useRef<HTMLDivElement>(null);
  const fxBoxRef = useRef<HTMLDivElement>(null);
  const fxBodyRef = useRef<HTMLDivElement>(null);
  const fxRaysARef = useRef<HTMLImageElement>(null);
  const fxRaysBRef = useRef<HTMLImageElement>(null);
  const fxFlashRef = useRef<HTMLDivElement>(null);
  const chestSlotRef = useRef<HTMLImageElement>(null);
  const coinsRef = useRef<CoinLayer | null>(null);
  /** Казначей у суммы (`.wh-parrot` на картинке сундука) и его двойник на крупном плане джекпота. */
  const parrotRef = useRef<HTMLSpanElement>(null);
  const fxParrotRef = useRef<HTMLDivElement>(null);
  // Цикл ожидания казначея — таймером, без `requestAnimationFrame` (кадр раз в 0,4–4 с); стоит вместе с циклом
  // анимаций (`holdFx`), снят на время крутки/эмоции/джекпота и при уменьшенном движении.
  const idleRef = useRef<ParrotIdle | null>(null);
  useLayoutEffect(() => {
    const idle = new ParrotIdle((frame, breath, ms) => {
      const el = parrotRef.current;
      if (!el) return;
      el.dataset.frame = frame;
      el.style.transition = `transform ${breath > 1 ? ms : 400}ms ease-in-out`;
      el.style.transform = breath > 1 ? `scaleY(${breath})` : '';
    });
    idleRef.current = idle;
    return () => {
      idle.dispose();
      idleRef.current = null;
    };
  }, []);
  useEffect(() => idleRef.current?.setPaused(holdFx), [holdFx]);

  // Звук выигрыша — при открытой сцене: мой выигрыш или сорванный джекпот. Сундук сорван, а я ставил в этом раунде —
  // пушечный выстрел `wheelJackpot` (этап 7) вместо обычного выигрыша; зрителю без ставки — прежний `wheelWin`.
  // Идёт раскадровка сундука — звук в момент удара (`CHEST_BURST_MS`), иначе сразу.
  const seenLast = useRef<string | null>(last?.id ?? null);
  useEffect(() => {
    if (!last || seenLast.current === last.id) return;
    seenLast.current = last.id;
    const won = !!meId && last.winners.some((w) => w.userId === meId);
    const iBet = !!myBetsByRound.current.get(last.id)?.length;
    const sound = () => {
      if (useStore.getState().selfDeafened) return;
      if (last.jackpotHit && iBet) playSound('wheelJackpot');
      else if (won || last.jackpotHit) playSound('wheelWin');
    };
    const kind: CaptainDance | null = last.jackpotHit ? 'jackpot' : won ? 'joy' : null;
    if (kind && artRef.current && loopRef.current && !reducedMotion()) {
      burstSound.current = kind === 'jackpot' ? sound : () => {};
      if (kind === 'joy') sound();
      setChestStage(kind === 'jackpot');
      setGlowing(false);
      setFx({ id: last.id, kind });
      return;
    }
    sound();
  }, [last, meId]);

  // Раскадровка: до отрисовки (`useLayoutEffect`) — первый кадр рига и крупного плана ставит цикл, без мигания.
  useLayoutEffect(() => {
    const loop = loopRef.current;
    const a = artRef.current;
    if (!fx || !loop || !a) return;
    loop.clear();
    coinsRef.current?.clear();
    const canvas = canvasRef.current;
    const coins = canvas ? new CoinLayer(loop, canvas, a.coins) : null;
    coinsRef.current = coins;
    const rel = (el: Element | null) => {
      if (!el || !canvas) return null;
      const r = el.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height };
    };
    // Размеры прототипа: капитан 312 px ростом, сундук 320 px шириной — смещения в px масштабируем к нашей сцене.
    const dance = (delay: number) => {
      loop.add((ms) => {
        const body = capBodyRef.current;
        if (ms >= CAPTAIN_DANCE_MS[fx.kind]) {
          if (body) body.style.transform = '';
          if (capHelmRef.current) capHelmRef.current.style.transform = '';
          setFx(null);
          return false;
        }
        applyCaptain(body, capHelmRef.current, captainPoseAt(fx.kind, ms), (body?.clientHeight ?? 312) / 312);
      }, delay);
    };
    applyCaptain(capBodyRef.current, capHelmRef.current, captainPoseAt(fx.kind, -1), 1);

    if (fx.kind === 'joy') {
      const rig = rel(capRigRef.current);
      if (coins && rig) coins.add(handfulCoins(rig.x + rig.w / 2, rig.y + rig.h * 0.3, rig.y + rig.h));
      dance(0);
      return;
    }

    // Джекпот: сундук крупным планом → удар → возврат на место у суммы → пляска капитана под дождём монет.
    let rays = 0;
    let raysScale = 0.75;
    let fly: { dx: number; dy: number; s: number } | null = null;
    loop.add((ms, dt) => {
      const box = fxBoxRef.current;
      const body = fxBodyRef.current;
      if (!box || !body) return false;
      const p = chestPoseAt(ms);
      const px = box.clientWidth / 320;
      body.dataset.frame = String(p.frame);
      body.style.transform = `translateY(${(p.ty * px).toFixed(2)}px) rotate(${p.rot.toFixed(2)}deg) scale(${p.sx.toFixed(4)}, ${p.sy.toFixed(4)})`;
      // Казначей: сидит — повторяет позу сундука целиком (та же опора), взлетел — только его подскок, плюс свой подъём.
      const parrot = fxParrotRef.current;
      if (parrot) {
        const pp = parrotJackpotAt(ms, p);
        parrot.dataset.frame = pp.frame;
        parrot.style.transform = pp.ride ? body.style.transform : `translateY(${(p.ty * px - (pp.lift * box.clientWidth) / 429).toFixed(2)}px)`;
      }
      // Лучи: качаются (±9°) и пульсируют, яркость плавно догоняет цель.
      rays += (p.rays - rays) * (1 - Math.exp(-dt / 0.18));
      raysScale += (p.raysScale - raysScale) * (1 - Math.exp(-dt / 0.25));
      const pulse = 1 + 0.07 * Math.sin(ms / 170);
      const ra = fxRaysARef.current;
      const rb = fxRaysBRef.current;
      if (ra) {
        ra.style.opacity = (rays * (0.8 + 0.2 * Math.sin(ms / 130))).toFixed(3);
        ra.style.transform = `rotate(${(9 * Math.sin(ms / 1300)).toFixed(2)}deg) scale(${(raysScale * pulse).toFixed(4)})`;
      }
      if (rb) {
        const sc = raysScale * 1.08 * pulse;
        rb.style.opacity = (rays * 0.55 * (0.8 + 0.2 * Math.sin(ms / 150 + 2))).toFixed(3);
        rb.style.transform = `rotate(${(-7 * Math.sin(ms / 1100 + 1)).toFixed(2)}deg) scale(${(-sc).toFixed(4)}, ${sc.toFixed(4)})`;
      }
      if (fxGlowRef.current) fxGlowRef.current.style.opacity = p.glow.toFixed(3);
      if (fxVeilRef.current) fxVeilRef.current.style.opacity = p.veil.toFixed(3);
      if (fxFlashRef.current) {
        const k = (ms - CHEST_BURST_MS) / 520;
        fxFlashRef.current.style.opacity = k >= 0 && k < 1 ? (0.95 * Math.pow(1 - k, 2)).toFixed(3) : '0';
      }
      if (p.fly > 0) {
        // Возврат: к картинке сундука у суммы (снята с места на время крупного плана); её не видно — просто гаснет.
        if (!fly) {
          const from = box.getBoundingClientRect();
          const to = chestSlotRef.current?.getBoundingClientRect();
          fly =
            to && to.width > 0 && from.width > 0
              ? { dx: to.left + to.width / 2 - (from.left + from.width / 2), dy: to.top + to.height / 2 - (from.top + from.height / 2), s: to.width / from.width }
              : { dx: 0, dy: 0, s: 0.6 };
        }
        box.style.transform = `translate(${(fly.dx * p.fly).toFixed(1)}px, ${(fly.dy * p.fly).toFixed(1)}px) scale(${(1 + (fly.s - 1) * p.fly).toFixed(4)})`;
        box.style.opacity = p.fly > 0.85 ? ((1 - p.fly) / 0.15).toFixed(3) : '1';
      }
      return ms < CHEST_FX_MS;
    });
    let glowMs = jackpotGlowMs(null);
    loop.at(CHEST_BURST_MS, () => {
      burstSound.current();
      glowMs = jackpotGlowMs(soundDurationMs('wheelJackpot'));
      const box = rel(fxBoxRef.current);
      if (coins && box) coins.add(fountainCoins(box.x + box.w / 2, box.y + box.h * 0.42, box.w * 0.45, coins.size().h - 20));
      // Короткая встряска сцены: свойство `translate` — не трогает `transform` колонки на телефоне.
      const stage = stageRef.current;
      loop.add((ms) => {
        if (!stage) return false;
        const k = Math.min(1, ms / 560);
        const m = 12 * Math.pow(1 - k, 2);
        stage.style.setProperty('translate', k >= 1 ? '' : `${((Math.random() - 0.5) * m).toFixed(2)}px ${((Math.random() - 0.5) * m).toFixed(2)}px`);
        return k < 1;
      });
    });
    loop.at(CHEST_FX_MS, () => {
      setChestStage(false);
      // Сундук вернулся к сумме — свечение за ним: лучи медленно вращаются и пульсируют, ореол дышит; держится до
      // конца звука от удара и гаснет. Узлы появляются после `setGlowing` — дорожка ждёт их.
      setGlowing(true);
      loop.add((ms) => {
        const I = jackpotGlowAt(ms + CHEST_FX_MS - CHEST_BURST_MS, glowMs) * Math.min(1, ms / 250);
        const el = chestGlowRef.current;
        if (el) el.style.opacity = I.toFixed(3);
        if (chestRaysRef.current) {
          chestRaysRef.current.style.transform = `rotate(${((ms / 1000) * 24).toFixed(2)}deg) scale(${(1 + 0.07 * Math.sin(ms / 170)).toFixed(4)})`;
        }
        if (chestHaloRef.current) chestHaloRef.current.style.opacity = (0.8 + 0.2 * Math.sin(ms / 260)).toFixed(3);
        // Казначей висит над открытым сундуком (`jp2`), покачиваясь вверх от опоры, пока сундук светится.
        const parrot = parrotRef.current;
        if (parrot) parrot.style.transform = I <= 0 && ms > 300 ? '' : `translateY(${(-(parrotBob(ms) * parrot.clientWidth) / 429).toFixed(2)}px)`;
        if (I <= 0 && ms > 300) {
          setGlowing(false);
          return false;
        }
      });
      if (coins) {
        const { w, h } = coins.size();
        coins.add(rainCoins(w, h - 10));
      }
    });
    dance(CHEST_FX_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fx?.id]);

  // ——— Ставка ———
  const balance = eco?.wallet.balance ?? 0;
  const games = eco ? gamesView(eco) : null;
  const betMax = view?.betMax ?? 0;
  const lossLeft =
    games?.games.effectiveLimit != null ? Math.max(0, games.games.effectiveLimit - games.games.lossToday) : null;
  const cap = Math.max(0, Math.min(betMax, balance, lossLeft ?? Number.MAX_SAFE_INTEGER));
  const presets = betPresets(cap, cap);
  const [pick, setPick] = useState<WheelPick | null>(null);
  const [amountRaw, setAmountRaw] = useState<string>('');
  const amount = clampBet(Number(amountRaw || (presets[0] ?? 0)), betMax, cap);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const phase = view ? wheelPhase(view, now) : null;
  const canBet =
    !!view?.enabled && inVoiceHere && !busy && (phase?.kind === 'idle' || (phase?.kind === 'open' && phase.leftMs > 0));
  const myPicks = new Set(round && meId ? round.bets.filter((b) => b.userId === meId).map((b) => b.pick) : []);
  const placing = useRef(false);

  async function place() {
    if (placing.current || !canBet || !pick || myPicks.has(pick) || amount < 1) return;
    placing.current = true;
    setBusy(true);
    setErr(null);
    try {
      const snap = await api.placeWheelBet(serverId, pick, amount);
      setWheel(serverId, snap);
      setPick(null);
    } catch (e) {
      const er = e as Error & { reason?: string };
      setErr(wheelBetErrorText(er.reason, er.message));
      if (er.reason === 'cooldown' || er.reason === 'round_locked') ensureWheel(serverId, true);
    } finally {
      placing.current = false;
      setBusy(false);
    }
  }

  // ——— «Крутить сейчас» (30.10) ———
  // Люди в голосе сервера колеса: каналы открытого сервера, если это он, иначе — мой голосовой канал. Строкой: селектор
  // не должен отдавать новый массив на каждый вызов.
  const voiceIds = useStore((s) => {
    const own = s.bootstrap?.server.id === serverId ? s.bootstrap.channels.map((c) => c.id) : s.voice?.channelId ? [s.voice.channelId] : [];
    return own.flatMap((cid) => (s.presence[cid] ?? []).filter((p) => p.bot !== true).map((p) => p.userId)).join(',');
  });
  const fairVisible = useStore((s) =>
    wheelFairVisible(
      s.user?.id ?? null,
      s.servers.find((x) => x.id === serverId)?.ownerId,
      s.bootstrap?.server.id === serverId ? permsFromString(s.bootstrap.permissions) : null,
    ),
  );
  const spinNowShown = canSpinNow(round, meId, phase?.kind === 'open' ? phase.leftMs : null);
  const spinRequest = useRef(false);
  async function spinNow() {
    if (!round || busy || !spinNowShown || spinRequest.current) return;
    spinRequest.current = true;
    try {
    const missing = unbetVoiceUsers(voiceIds ? voiceIds.split(',') : [], round.bets, meId);
    if (missing.length > 0 && !spinNowAsked()) {
      markSpinNowAsked();
      const ok = await confirmAction({
        title: 'Не все в голосе поставили',
        body: 'Крутить без них? Приём ставок закроется для всех сразу. Больше в этот раз не спросим.',
        items: missing.slice(0, 8).map(nameOf),
        confirmLabel: 'Крутить',
        cancelLabel: 'Подождать',
      });
      if (!ok) return;
    }
    setBusy(true);
    setErr(null);
    try {
      setWheel(serverId, await api.spinWheelNow(serverId));
    } catch (e) {
      const er = e as Error & { reason?: string };
      setErr(wheelBetErrorText(er.reason, er.message));
      ensureWheel(serverId, true);
    } finally {
      setBusy(false);
    }
    } finally { spinRequest.current = false; }
  }

  const nameOf = (id: string) => {
    if (id === meId) return 'Ты';
    const m = members.find((x) => x.user.id === id);
    return m ? m.nickname || m.user.displayName || m.user.username
      : Object.values(presence).flat().find(p => p.userId === id)?.displayName || 'Гусь';
  };
  const avatarOf = (id: string) => members.find((x) => x.user.id === id)?.user.avatarUrl ?? null;
  const coin = <img src={eco?.iconUrl || coinDefaultIcon} alt="" className="wh-coin" />;

  // ——— Подписи состояния ———
  let status: { big: string; small: string; live?: boolean };
  if (!view) status = { big: '…', small: 'Поднимаем паруса' };
  else if (!view.enabled) status = { big: 'Стоп', small: 'Игры на этом сервере выключены' };
  else if (phase?.kind === 'open')
    status = phase.leftMs > 0 ? { big: clockLabel(phase.leftMs), small: 'до конца ставок', live: true } : { big: '0:00', small: 'Ставки закрыты — сейчас закрутится', live: true };
  else if (phase?.kind === 'spinning') status = { big: 'Крутим!', small: 'Ставки закрыты — смотри на стрелку', live: true };
  else if (phase?.kind === 'cooldown') status = { big: clockLabel(phase.leftMs), small: 'команда переводит дух' };
  else status = { big: 'Ждём', small: 'С первой ставки пойдут 30 секунд на ставки' };

  const lastValue = last ? WHEEL_SECTORS[last.sector] : null;
  const showResult = !!last && !round;
  const myLast = last ? (myBetsByRound.current.get(last.id) ?? []) : [];
  const myWin = last && meId ? last.winners.filter((w) => w.userId === meId).reduce((a, w) => a + w.payout, 0) : 0;
  // Эмоция капитана и сундук на время показа итога (`WHEEL_MOOD_MS` от `settledAt`), потом — обычные кадры.
  const mood: WheelMood = showResult && view ? wheelMood(last, meId, myLast.length > 0, now + view.skewMs) : 'idle';
  // Идёт анимация итога — кадры ведёт она (и дольше окна `WHEEL_MOOD_MS`, пока не допляшет).
  const shown: WheelMood = fx ? fx.kind : mood;
  const capFrame: CaptainFrame = shown === 'jackpot' ? 'peak' : shown === 'joy' ? 'dance1' : 'idle';
  // Сундук у суммы открывается (подскок `wh-chest-pop`), когда крупный план вернул его на место.
  const chestOpen = (shown === 'jackpot' && !chestStage) || glowing;
  // Казначей на сундуке у суммы: над открытым — завис (`jp2`), колесо крутится — следит, итог — радуется или поник
  // (`parrotMood`, то же окно, что у капитана); иначе — цикл ожидания (`ParrotIdle`), при уменьшенном движении — `sit1`.
  const pMood = showResult && view ? parrotMood(last, meId, myLast.length > 0, now + view.skewMs) : 'idle';
  const parrotFrame: ParrotFrame | null = chestOpen
    ? 'jp2'
    : phase?.kind === 'spinning' || spinning
      ? 'watch'
      : fx?.kind === 'joy' || pMood === 'cheer'
        ? 'cheer'
        : pMood === 'sad'
          ? 'sad'
          : pMood === 'jackpot'
            ? 'jp2'
            : null;
  const parrotIdle = parrotFrame === null && !!art && !reducedMotion();
  useLayoutEffect(() => {
    idleRef.current?.setActive(parrotIdle);
    const el = parrotRef.current;
    if (!parrotIdle && el) {
      el.style.transition = '';
      el.style.transform = '';
    }
  }, [parrotIdle]);
  const parrotImgs = art
    ? PARROT_FRAMES.map((f) => <img key={f} data-f={f} src={art.parrot[f]} alt="" draggable={false} />)
    : null;

  // Капитан: пока кадры не загружены — цельный `captain.png`; грусть — цельный `captain-sad`; иначе риг «поза под
  // штурвалом». Кадр рига — `data-frame`; пока идёт анимация, его пишет цикл, React атрибут не трогает.
  const captain = !art ? (
    <img className="wh-captain" src={captainUrl} alt="" draggable={false} />
  ) : shown === 'sad' ? (
    <img className="wh-captain sad" src={art.sad} alt="" draggable={false} />
  ) : (
    <div className={`wh-captain wh-cap-rig${shown !== 'idle' ? ` ${shown}` : ''}`} ref={capRigRef} aria-hidden="true">
      <div className="wh-cap-body" ref={capBodyRef} data-frame={fx ? undefined : capFrame}>
        {CAPTAIN_FRAMES.map((f) => (
          <img key={f} data-f={f} src={art.cap[f]} alt="" draggable={false} />
        ))}
      </div>
      <img className="wh-cap-helm" ref={capHelmRef} src={art.helm} alt="" draggable={false} />
    </div>
  );

  const wheel = (
    <div className="wh-stage" ref={stageRef}>
      <div className="wh-wheel">
        <div
          className="wh-rot"
          ref={rotRef}
          style={{ transform: `rotate(${angle}deg)` }}
        >
          <img src={faceUrl} alt="" draggable={false} />
          <img src={rimUrl} alt="" draggable={false} />
          <img src={hubUrl} alt="" draggable={false} />
        </div>
        {/* Перо качается на оси: в покое — лежит на штырьке (`featherRestDeg`), во вращении — ключевые кадры `s.feather`. */}
        <img
          className="wh-pointer"
          ref={featherRef}
          src={pointerUrl}
          alt=""
          draggable={false}
          style={{ transform: `rotate(${(-featherRestDeg(angle)).toFixed(2)}deg)` }}
        />
        {showResult && lastValue !== null && (
          <span className="wh-landed" style={{ ['--pick' as string]: PICK_COLOR[lastValue] }}>
            Выпало {lastValue}
          </span>
        )}
      </div>
      {captain}
      {art && chestStage && (
        // Крупный план сорванного сундука — поверх колеса и капитана, панель с итогом и суммой остаётся открытой.
        <div className="wh-fx-chest" aria-hidden="true">
          <div className="wh-fx-veil" ref={fxVeilRef} />
          <div className="wh-fx-glow" ref={fxGlowRef} />
          <div className="wh-fx-box" ref={fxBoxRef}>
            <img className="wh-fx-rays" ref={fxRaysARef} src={art.rays} alt="" draggable={false} />
            <img className="wh-fx-rays" ref={fxRaysBRef} src={art.rays} alt="" draggable={false} />
            <div className="wh-fx-body" ref={fxBodyRef} data-frame="0">
              {art.chest.map((src, i) => (
                <img key={i} data-f={i} src={src} alt="" draggable={false} />
              ))}
            </div>
            <div className="wh-parrot wh-fx-parrot" ref={fxParrotRef} data-frame="watch">
              {parrotImgs}
            </div>
          </div>
          <div className="wh-fx-flash" ref={fxFlashRef} />
        </div>
      )}
      {art && <canvas className="wh-fx-coins" ref={canvasRef} width={0} height={0} aria-hidden="true" />}
    </div>
  );

  const shownBets = round?.bets ?? (last && roundBets.current?.serverId === serverId && roundBets.current.id === last.id ? roundBets.current.bets : []);

  const panel = (
    <div className="wh-panel">
      <div className="wh-top">
        <div className={`wh-timer${status.live ? ' live' : ''}`} aria-live="polite">
          <span className="wh-timer-big">{status.big}</span>
          <span className="wh-timer-small" title={status.small}>{status.small}</span>
        </div>
        <div
          className={`wh-chest${chestOpen ? ' open' : ''}${chestStage ? ' away' : ''}`}
          title={`Джекпот срывается примерно в одном раунде из ${WHEEL_JACKPOT_ODDS} и делится между всеми, кто ставил`}
        >
          {art && (
            <span className="wh-chest-art">
              {glowing && (
                <span className="wh-chest-glow" ref={chestGlowRef} aria-hidden="true">
                  <span className="wh-chest-halo" ref={chestHaloRef} />
                  <img className="wh-chest-rays" ref={chestRaysRef} src={art.rays} alt="" draggable={false} />
                </span>
              )}
              <img className="wh-chest-img" ref={chestSlotRef} src={chestOpen ? art.chest[3] : art.chest[0]} alt="" draggable={false} />
              <span className="wh-parrot" ref={parrotRef} data-frame={parrotIdle ? undefined : (parrotFrame ?? 'sit1')} aria-hidden="true">
                {parrotImgs}
              </span>
            </span>
          )}
          <span className="wh-chest-text">
            <span className="wh-chest-label">Сундук</span>
            <span className="wh-chest-sum">
              {view?.jackpot ?? 0}
              {coin}
            </span>
          </span>
        </div>
      </div>

      <div className="wh-result-slot">{showResult && last && (
        <div className="wh-result">
          <span className="wh-result-head">
            Стрелка встала на <b style={{ color: PICK_COLOR[lastValue as WheelPick] }}>{lastValue}</b>
            {last.jackpotHit && (
              <span className="wh-jackpot-hit">
                {' '}
                · сундук сорван: {last.jackpotPaid}
                {last.forced === true && ` (${WHEEL_FORCED_TEXT})`}
              </span>
            )}
          </span>
          {(myWin > 0 || myLast.length > 0) && (
            <span className={`wh-result-mine${myWin > 0 ? ' win' : ''}`}>
              {myWin > 0 ? (
                <>
                  Твой улов: +{myWin}
                  {coin}
                </>
              ) : (
                'В этот раз мимо — колесо ещё повернётся'
              )}
            </span>
          )}
        </div>
      )}

      </div>
      <div className="wh-picks" role="radiogroup" aria-label="Число">
        {WHEEL_PICKS.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={pick === p}
            className={`wh-pick${pick === p ? ' sel' : ''}${myPicks.has(p) ? ' mine' : ''}`}
            style={{ ['--pick' as string]: PICK_COLOR[p] }}
            disabled={!canBet || myPicks.has(p)}
            title={myPicks.has(p) ? 'Уже поставил на это число' : `${pickSectors(p)} из 25 секторов`}
            onClick={() => setPick(p)}
          >
            <span className="wh-pick-num">{p}</span>
            <span className="wh-pick-x">{multiplierLabel(p)}</span>
          </button>
        ))}
      </div>

      <div className="wh-amount">
        {presets.map((v) => (
          <button
            key={v}
            type="button"
            className={`wh-chip${amount === v ? ' sel' : ''}`}
            disabled={!canBet}
            onClick={() => setAmountRaw(String(v))}
          >
            {v}
          </button>
        ))}
        <input
          className="wh-amount-input"
          type="number"
          inputMode="numeric"
          min={1}
          max={cap || undefined}
          placeholder="Своя"
          aria-label="Сумма ставки"
          value={amountRaw}
          disabled={!canBet}
          onChange={(e) => setAmountRaw(e.target.value)}
        />
      </div>
      <p className="wh-hint">
        Максимум {betMax}
        {lossLeft !== null && ` · сегодня можно проиграть ещё ${lossLeft}`} · в кошельке {balance}
      </p>

      <div className="wh-submit-actions"><button type="button" className="ew-btn ew-btn-main wh-place" disabled={!canBet || !pick || myPicks.has(pick) || amount < 1} onClick={() => void place()}>
        {pick ? `Поставить ${amount || '…'} на «${pick}»` : 'Выбери число'}
      </button>
      {spinNowShown && (
        <button
          type="button"
          className="ew-btn wh-place wh-spin-now"
          disabled={busy}
          title="Закрыть приём ставок досрочно и закрутить колесо для всех"
          onClick={() => void spinNow()}
        >
          Крутить сейчас
        </button>
      )}
      </div>
      {!inVoiceHere && <p className="wh-err">Ставки принимаются только с палубы — зайди в голосовой канал этого сервера.</p>}
      {err && (
        <p className="wh-err" role="alert">
          {err}
        </p>
      )}


    </div>
  );

  const body = (
    <div className="wh-game-page"><div className="wh-body">
      <GameRules game="wheel"><p className="wh-hint">Максимум {betMax} · в кошельке {balance}{lossLeft !== null ? ` · сегодня можно проиграть ещё ${lossLeft}` : ''}</p>
      {/* Замок и проверка честности — только владельцу сервера и администраторам (решение владельца 30.10). */}
      {fairVisible && round && (
        <p className="wh-commit" title={round.commit}>
          Замок раунда: <code>{shortHash(round.commit)}</code> — зерно загадано до первой ставки
        </p>
      )}
      {fairVisible && last && <FairCheck key={last.id} result={last} />}</GameRules>
      <div className="wh-visual">
        {wheel}
        <WheelBets roundId={round?.id ?? last?.id ?? null} bets={shownBets} nameOf={nameOf} avatarOf={avatarOf} meId={meId}
          title={round ? 'Ставки раунда' : last ? 'Ставки прошлого раунда' : 'Ставки'}
          emptyText={last && !round ? 'Ставки этого раунда не сохранены' : 'Пока никто не поставил'} />
      </div>
      {panel}
    </div><div className="game-actions wh-navigation"><button type="button" className="ew-btn game-actions-back" onClick={onBack}>К выбору игр</button></div></div>
  );

  if (phone) {
    return (
      <BottomSheet page title="Колесо гусей-пиратов" onClose={onClose} onBack={onBack}>
        {body}
      </BottomSheet>
    );
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <section className="modal eco-welcome game-frame wheel-scene" role="dialog" aria-modal="true" aria-labelledby="wh-title" onClick={(e) => e.stopPropagation()}>
        <div className="ew-head dc-header"><h2 id="wh-title" className="ew-title">Колесо гусей-пиратов</h2><button type="button" className="icon-close" title="Закрыть" onClick={onClose}><Icon name="close" size={18} /></button></div>
        {body}
      </section>
    </div>
  );
}

/** «Проверить честность»: зерно открыто после итога — пересчитываем замок и сектор у себя в браузере. */
function FairCheck({ result }: { result: { id: string; seed: string; commit: string; sector: number; forced?: boolean } }) {
  const [verdict, setVerdict] = useState<WheelVerdict | null>(null);
  const [busy, setBusy] = useState(false);
  const verdictView = verdict ? wheelVerdictView(verdict, result) : null;
  return (
    <details className="wh-fair">
      <summary>Проверить честность прошлого раунда</summary>
      <p className="wh-fair-text">
        Зерно раунда загадано до первой ставки, а его замок (хеш) виден с самого начала. После итога зерно открыто — из него
        считается и замок, и сектор. Проверка идёт прямо здесь, у тебя.
      </p>
      <dl className="wh-fair-kv">
        <dt>Замок</dt>
        <dd>
          <code>{result.commit}</code>
        </dd>
        <dt>Зерно</dt>
        <dd>
          <code>{result.seed}</code>
        </dd>
        <dt>Сектор</dt>
        <dd>
          №{result.sector} по часовой от верха (число {WHEEL_SECTORS[result.sector]})
        </dd>
      </dl>
      <div className="wh-fair-row">
        <button
          type="button"
          className="ew-btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void verifyWheelResult(result)
              .then(setVerdict)
              .catch(() => setVerdict({ ok: false, why: 'unavailable' }))
              .finally(() => setBusy(false));
          }}
        >
          Проверить
        </button>
        {verdictView && (
          <span className={`wh-verdict ${verdictView.tone}`} role="status">
            {verdictView.text}
          </span>
        )}
      </div>
    </details>
  );
}
