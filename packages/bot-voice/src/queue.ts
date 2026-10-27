/**
 * Очередь треков как конечный автомат и «ворота» воспроизведения. Чистый модуль — без `@livekit/rtc-node` и без звука:
 * проигрыватель (`connection.ts`) только исполняет решения очереди через хуки.
 *
 * Состояния трека: `queued` → `playing` → `ended`. Причины конца: `finished` (доиграл), `skipped` (`skip()`),
 * `stopped` (`stop()`/`leave()`), `error` (ошибка ffmpeg или потока). После конца играет следующий; нет следующего — `idle`.
 */
import type { PlaySource, PlayOptions, Track, TrackEndReason } from '@gusvoice/bot';
import { clampVolume } from './pcm.js';

export class QueueTrack implements Track {
  readonly id: number;
  readonly title: string;
  readonly source: PlaySource;
  readonly volume: number;
  state: 'queued' | 'playing' | 'ended' = 'queued';
  endReason: TrackEndReason | null = null;
  readonly finished: Promise<TrackEndReason>;
  /** @internal */
  readonly settle: (reason: TrackEndReason) => void;

  constructor(id: number, source: PlaySource, options: PlayOptions = {}) {
    this.id = id;
    this.source = source;
    this.title = options.title?.trim() || defaultTitle(source);
    this.volume = options.volume === undefined ? 1 : clampVolume(options.volume);
    let settle!: (r: TrackEndReason) => void;
    this.finished = new Promise<TrackEndReason>((resolve) => (settle = resolve));
    this.settle = settle;
  }
}

/** Название по умолчанию: имя файла, `хост/последний-сегмент` адреса или `stream`. */
export function defaultTitle(source: PlaySource): string {
  if (typeof source !== 'string') return 'stream';
  try {
    if (/^https?:\/\//i.test(source)) {
      const u = new URL(source);
      const last = u.pathname.split('/').filter(Boolean).pop();
      return last ? `${u.hostname}/${decodeURIComponent(last)}` : u.hostname;
    }
  } catch {
    /* не адрес — считаем путём */
  }
  return source.split(/[\\/]/).filter(Boolean).pop() || source;
}

export interface QueueHooks {
  /** Начать играть `track` (он уже `current`, `state === 'playing'`). */
  start(track: QueueTrack): void;
  /** Немедленно прервать воспроизведение текущего (его конец очередь оформит сама). */
  abort(track: QueueTrack): void;
  /** Трек закончился (до запуска следующего). */
  ended(track: QueueTrack, reason: TrackEndReason): void;
  /** Играть больше нечего. */
  idle(): void;
  /** Пауза включена/выключена. */
  pauseChanged?(paused: boolean): void;
}

export class TrackQueue {
  private readonly hooks: QueueHooks;
  private nextId = 1;
  private cur: QueueTrack | null = null;
  private list: QueueTrack[] = [];
  private isPaused = false;

  constructor(hooks: QueueHooks) {
    this.hooks = hooks;
  }

  /** Играющий (в том числе на паузе). */
  get current(): QueueTrack | null {
    return this.cur;
  }

  /** Ожидающие, без играющего. */
  get waiting(): readonly QueueTrack[] {
    return this.list.slice();
  }

  get paused(): boolean {
    return this.isPaused;
  }

  /** Поставить в очередь; очередь пуста — трек играет сразу. */
  add(source: PlaySource, options: PlayOptions = {}): QueueTrack {
    const t = new QueueTrack(this.nextId++, source, options);
    if (this.cur) this.list.push(t);
    else this.begin(t);
    return t;
  }

  /** Пропустить играющий. `false` — играть нечего. */
  skip(): boolean {
    const t = this.cur;
    if (!t) return false;
    this.hooks.abort(t);
    this.end(t, 'skipped');
    return true;
  }

  /** Остановить всё: играющий и ожидающие получают `stopped`, `idle` — один раз, если что-то играло. */
  stop(): void {
    const t = this.cur;
    const waiting = this.list;
    this.list = [];
    if (t) this.hooks.abort(t);
    this.cur = null;
    this.setPaused(false);
    if (t) this.finishTrack(t, 'stopped');
    for (const w of waiting) this.finishTrack(w, 'stopped');
    if (t) this.hooks.idle();
  }

  /** `false` — нечего ставить на паузу или уже на паузе. */
  pause(): boolean {
    if (!this.cur || this.isPaused) return false;
    this.setPaused(true);
    return true;
  }

  /** `false` — не было паузы. */
  resume(): boolean {
    if (!this.isPaused) return false;
    this.setPaused(false);
    return true;
  }

  /**
   * Проигрыватель сообщает: текущий закончился сам (`finished`) или упал (`error`). Чужой или уже закончившийся трек
   * игнорируется (`false`) — прерванный `skip()` ffmpeg не должен закрыть следующий трек.
   */
  finish(track: QueueTrack, reason: 'finished' | 'error'): boolean {
    if (this.cur !== track) return false;
    this.end(track, reason);
    return true;
  }

  private begin(t: QueueTrack): void {
    this.cur = t;
    t.state = 'playing';
    this.hooks.start(t);
  }

  private end(t: QueueTrack, reason: TrackEndReason): void {
    this.cur = null;
    this.finishTrack(t, reason);
    const next = this.list.shift();
    if (next) {
      this.begin(next);
    } else {
      this.setPaused(false);
      this.hooks.idle();
    }
  }

  private finishTrack(t: QueueTrack, reason: TrackEndReason): void {
    t.state = 'ended';
    t.endReason = reason;
    t.settle(reason);
    this.hooks.ended(t, reason);
  }

  private setPaused(v: boolean): void {
    if (this.isPaused === v) return;
    this.isPaused = v;
    this.hooks.pauseChanged?.(v);
  }
}

/** Причины, по которым воспроизведение стоит, хотя трек «играет»: пауза пользователя, мьют модератора, обрыв связи. */
export type GateFlag = 'paused' | 'muted' | 'offline';

/**
 * Ворота воспроизведения: пока закрыты хоть по одной причине, проигрыватель не читает ffmpeg (тот сам тормозит на полном
 * канале), а после открытия трек идёт с того же места.
 */
export class PlaybackGate {
  private flags: Record<GateFlag, boolean> = { paused: false, muted: false, offline: false };
  private waiters = new Set<() => void>();

  get open(): boolean {
    return !this.flags.paused && !this.flags.muted && !this.flags.offline;
  }

  get(flag: GateFlag): boolean {
    return this.flags[flag];
  }

  set(flag: GateFlag, value: boolean): void {
    if (this.flags[flag] === value) return;
    this.flags[flag] = value;
    if (this.open) this.wake();
  }

  /** Разбудить ожидающих (в том числе для проверки отмены). */
  wake(): void {
    const list = [...this.waiters];
    this.waiters.clear();
    for (const w of list) w();
  }

  /** Ждать открытия ворот. `true` — открыты, `false` — прервали `signal`. */
  async wait(signal: { readonly aborted: boolean; addEventListener(t: 'abort', l: () => void, o?: { once: boolean }): void; removeEventListener(t: 'abort', l: () => void): void }): Promise<boolean> {
    while (!signal.aborted) {
      if (this.open) return true;
      await new Promise<void>((resolve) => {
        const done = () => {
          this.waiters.delete(done);
          signal.removeEventListener('abort', done);
          resolve();
        };
        this.waiters.add(done);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    return false;
  }
}
