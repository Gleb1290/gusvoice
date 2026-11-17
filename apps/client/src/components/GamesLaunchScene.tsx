import { useEffect, useRef, useState } from 'react';
import coinDefaultIcon from '../assets/guscoin.svg';
import bellUrl from '../assets/sounds/prediction-closed.mp3';
import cannonUrl from '../assets/sounds/cannon-shot.mp3';
import hornUrl from '../assets/sounds/games-launch.mp3';
import { getSoundSettings } from '../sounds';
import { useWindowMotion } from '../windowCovered';
import { startBoom, type Boom, type BoomEls, type BoomSound } from './gamesLaunchBoom';
import { Icon } from './Icon';

/**
 * Сцена «БУМ» — игры пришли в голос (решения владельца 29.10, пп. 12–14; эталон — прототип `gc2/anim/template2.html`).
 * Ленивый кусок: его грузит хост `GamesLaunchNotice.tsx` (`React.lazy`) только при показе, кадры и звуки — отдельными
 * файлами из этого же куска (`assets/launch/boom/*.png`, выстрел/рында/горн — `assets/sounds/`), качаются тоже только тут.
 *
 * Оболочка: разметка сцены, загрузка кадров (до готовности — экран загрузки), звук (свои `Audio`, чтобы горн глушился по
 * «Пропустить» и ничего не звучало после закрытия), клавиши и пауза под игрой/в накрытом окне. Движение — `gamesLaunchBoom.ts`.
 * Знакомство идёт по нажатию (клик/тап/Enter/Пробел), «Пропустить» — всегда, сразу к карточке; Esc до финала = «Пропустить»,
 * после — закрыть. `prefers-reduced-motion` — статичная версия по нажатиям, как в прототипе.
 */

export interface GamesLaunchSceneProps {
  /** Мне досталось за то, что был на запуске; 0 — строки о подарке нет (зашёл позже, повтор). */
  mine: number;
  iconUrl: string | null;
  /** Корабль для экрана загрузки (`assets/launch/ship.*`, его находит хост). */
  ship: string | null;
  /** Закрыть сцену (крестик, Esc после финала). */
  onClose: () => void;
  /** «Запустить» на карточке — в «Активности». */
  onLaunch: () => void;
  /** Звук разрешён (не заглушён человеком). */
  sound: boolean;
}

const FRAMES: Record<string, string> = import.meta.glob<string>('../assets/launch/boom/*.png', {
  eager: true,
  import: 'default',
  query: '?url',
});
/** Сколько ждать кадры, прежде чем начать с тем, что есть (кадр, которого нет, просто не рисуется). */
const LOAD_LIMIT_MS = 8000;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
function coarsePointer(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
}

function loadFrames(): { images: Record<string, HTMLImageElement>; done: Promise<void> } {
  const images: Record<string, HTMLImageElement> = {};
  const waits: Promise<unknown>[] = [];
  for (const [path, url] of Object.entries(FRAMES)) {
    const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.png$/, '');
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    images[name] = img;
    waits.push(img.decode ? img.decode().catch(() => undefined) : Promise.resolve());
  }
  // Шрифт табличек (`@font-face` «Ruslan Display» в styles.css) браузер качает только при первом тексте — грузим заранее,
  // чтобы таблички не мигнули запасным шрифтом.
  if (typeof document !== 'undefined' && document.fonts?.load) {
    waits.push(document.fonts.load('1em "Ruslan Display"', 'Капитан').catch(() => undefined));
  }
  return { images, done: Promise.all(waits).then(() => undefined) };
}

/** Экран загрузки — и запасной для `Suspense` у хоста (те же классы). */
export function BoomLoading({ ship, onClose }: { ship: string | null; onClose: () => void }) {
  return (
    <div className="boom-overlay boom-loading" role="dialog" aria-modal="true" aria-label="Игры пришли в голос">
      {ship && <img className="boom-loading-ship" src={ship} alt="" />}
      <p className="boom-loading-text">Поднимаем паруса…</p>
      <button type="button" className="boom-skip on" onClick={onClose}>
        Пропустить
      </button>
    </div>
  );
}

export default function GamesLaunchScene({ mine, iconUrl, ship, onClose, onLaunch, sound }: GamesLaunchSceneProps) {
  const [phase, setPhase] = useState<'loading' | 'play' | 'final'>('loading');
  const motion = useWindowMotion();
  const paused = motion.covered || motion.gameFg;
  const boomRef = useRef<Boom | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const goRef = useRef<HTMLButtonElement>(null);
  const refs = useRef<Partial<BoomEls>>({});
  const set =
    <K extends keyof BoomEls>(k: K) =>
    (el: BoomEls[K] | null) => {
      if (el) refs.current[k] = el;
    };
  /** Всё, что живёт от показа до закрытия: кадры, звуки, признак «сцена ещё открыта». */
  const kit = useRef({
    alive: true,
    reduce: false,
    images: {} as Record<string, HTMLImageElement>,
    audio: new Set<HTMLAudioElement>(),
    horn: null as HTMLAudioElement | null,
    held: [] as HTMLAudioElement[],
  });
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Загрузка кадров (до готовности — экран загрузки); размонтирование — стоп цикла, холстов и всех звуков.
  useEffect(() => {
    const k = kit.current;
    k.alive = true;
    k.reduce = reducedMotion();
    const { images, done } = loadFrames();
    k.images = images;
    // Горн и выстрел — прогреть заранее, чтобы первый залп не опаздывал.
    for (const url of [hornUrl, cannonUrl]) {
      const el = new Audio();
      el.preload = 'auto';
      el.src = url;
    }
    const start = () => {
      if (k.alive) setPhase((p) => (p === 'loading' ? 'play' : p));
    };
    const limit = window.setTimeout(start, LOAD_LIMIT_MS);
    void done.then(start);
    return () => {
      k.alive = false;
      window.clearTimeout(limit);
      boomRef.current?.destroy();
      boomRef.current = null;
      for (const el of k.audio) {
        try {
          el.pause();
          el.removeAttribute('src');
          el.load();
        } catch {
          /* освобождаем, что можем */
        }
      }
      k.audio.clear();
      k.horn = null;
      k.held = [];
      for (const img of Object.values(images)) img.src = '';
    };
  }, []);

  // Разметка сцены в DOM — запускаем движок.
  useEffect(() => {
    if (phase !== 'play' || boomRef.current) return;
    const k = kit.current;
    function play(key: BoomSound, vol: number) {
      if (!k.alive || !soundRef.current) return;
      const s = getSoundSettings();
      if (!s.enabled || !s.events.gamesLaunch) return;
      // Громкость — как у события `gamesLaunch` (мастер, потолок 0.55); соотношение звуков — из прототипа (горн 0.7).
      const base = Math.min(s.volume, 0.55);
      const el = new Audio(key === 'horn' ? hornUrl : key === 'cannon' ? cannonUrl : bellUrl);
      el.volume = Math.max(0, Math.min(1, (base * vol) / 0.7));
      k.audio.add(el);
      el.addEventListener('ended', () => k.audio.delete(el));
      if (key === 'horn') k.horn = el;
      void el.play().catch(() => k.audio.delete(el));
    }
    boomRef.current = startBoom(refs.current as BoomEls, {
      reduce: k.reduce,
      images: k.images,
      sound: play,
      stopHorn: () => {
        try {
          k.horn?.pause();
        } catch {
          /* уже остановлен */
        }
      },
      onFinal: () => {
        if (k.alive) setPhase('final');
      },
    });
    boomRef.current.setPaused(paused);
    stageRef.current?.focus({ preventScroll: true });
    // Движок заводится один раз на показ; пауза — своим эффектом ниже.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (phase === 'final') goRef.current?.focus({ preventScroll: true });
  }, [phase]);

  // Пауза: окно накрыто или впереди полноэкранная игра — стоит и цикл, и звук.
  useEffect(() => {
    boomRef.current?.setPaused(paused);
    const k = kit.current;
    if (paused) {
      k.held = [...k.audio].filter((el) => !el.paused);
      for (const el of k.held) el.pause();
    } else {
      for (const el of k.held) void el.play().catch(() => undefined);
      k.held = [];
    }
  }, [paused]);

  // Клавиши: Enter/Пробел — следующий шаг, Esc — «Пропустить» до финала и закрыть после.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (phaseRef.current === 'play' && boomRef.current) boomRef.current.skip();
        else onClose();
        return;
      }
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('button, a, input, textarea, select')) return;
      e.preventDefault();
      boomRef.current?.advance();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (phase === 'loading') return <BoomLoading ship={ship} onClose={onClose} />;

  return (
    <div
      className="boom-overlay"
      ref={stageRef}
      role="dialog"
      aria-modal="true"
      aria-label="Игры пришли в голос. Нажми или Enter, чтобы продолжить"
      tabIndex={0}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, .boom-card')) return;
        boomRef.current?.advance();
      }}
    >
      <div className="boom-stage" ref={set('stage')}>
        <div className="boom-cam" ref={set('cam')}>
          <canvas ref={set('sea')} />
          <canvas ref={set('fx')} />
        </div>
        <div className="boom-deck" ref={set('deck')}>
          <div className="boom-sway" ref={set('sway')}>
            <div className="boom-world" ref={set('worldB')}>
              <img src={FRAMES['../assets/launch/boom/deck-bg.png']} alt="" draggable={false} />
              <img src={FRAMES['../assets/launch/boom/deck-glow.png']} alt="" draggable={false} ref={set('glow')} />
            </div>
            <div className="boom-actors" ref={set('actors')} />
            <div className="boom-world" ref={set('worldF')}>
              <img src={FRAMES['../assets/launch/boom/deck-front.png']} alt="" draggable={false} />
            </div>
          </div>
        </div>
        <div className="boom-veil" ref={set('veil')} />
        <canvas className="boom-veil-c" ref={set('veilC')} />
        <div className="boom-flash" ref={set('flashAll')} />
        <div className="boom-plaque" ref={set('plaque')} aria-live="polite">
          <span className="boom-who" ref={set('plWho')} />
          <span className="boom-line" ref={set('plLine')} />
        </div>
        <div className="boom-bars top" ref={set('barT')} />
        <div className="boom-bars bot" ref={set('barB')} />
        <section className="boom-card" ref={set('card')} aria-hidden={phase !== 'final'}>
          {phase === 'final' && (
            <button type="button" className="icon-close boom-close" title="Закрыть" onClick={onClose}>
              <Icon name="close" size={18} />
            </button>
          )}
          <h2 className="boom-title">Игры пришли в голос</h2>
          <p className="boom-text">Колесо, дуэли и ставки на события{'\u00a0'}— в{'\u00a0'}«Активностях».</p>
          {mine > 0 && (
            <p className="boom-gift">
              <img src={iconUrl || coinDefaultIcon} alt="" className="boom-gift-coin" />+{mine} монет{'\u00a0'}— за то, что был на запуске
            </p>
          )}
          <button type="button" className="boom-go" ref={goRef} onClick={onLaunch} tabIndex={phase === 'final' ? 0 : -1}>
            Запустить
          </button>
        </section>
        <div className="boom-hint" ref={set('hint')} aria-hidden="true">
          {coarsePointer() ? 'Коснись, чтобы продолжить ›' : 'Нажми, чтобы продолжить ›'}
        </div>
        {phase !== 'final' && (
          <button
            type="button"
            className="boom-skip on"
            onClick={(e) => {
              e.stopPropagation();
              boomRef.current?.skip();
            }}
          >
            Пропустить
          </button>
        )}
      </div>
    </div>
  );
}
