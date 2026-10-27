/**
 * Подключение к голосовому каналу: комната LiveKit (`@livekit/rtc-node`) + очередь + ffmpeg → PCM → дорожка.
 * Единственный модуль пакета, который импортирует нативный `@livekit/rtc-node`; вся логика решений — в чистых модулях
 * `queue.ts` / `pcm.ts` / `ffmpeg.ts` / `reconnect.ts` / `grants.ts`.
 *
 * Бот ЛЮДЕЙ НЕ СЛЫШИТ: токен выдан без права слушать (`canSubscribe: false`) — это держит сервер LiveKit, а не SDK.
 * Поэтому `autoSubscribe: false`, приём звука в пакете не реализован. Звук публикуется как микрофон (`SOURCE_MICROPHONE`):
 * так у слушателя работает ползунок громкости именно этого бота.
 */
import { EventEmitter } from 'node:events';
import {
  AudioFrame,
  AudioSource,
  DisconnectReason,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  dispose as disposeRtc,
  type Participant,
  type RemoteParticipant,
} from '@livekit/rtc-node';
import type {
  PlayOptions,
  PlaySource,
  Track,
  VoiceConnection,
  VoiceEvents,
  VoiceHost,
  VoiceJoinOptions,
  VoiceMember,
  VoiceStateUpdated,
} from '@gusvoice/bot';
import { checkFfmpeg, resolveFfmpegPath, spawnFfmpeg, type FfmpegRun } from './ffmpeg.js';
import { CHANNELS, FRAME_SAMPLES, FrameSlicer, SAMPLE_RATE, applyVolume, clampVolume } from './pcm.js';
import { canSpeakFromToken } from './grants.js';
import { PlaybackGate, TrackQueue, type QueueTrack } from './queue.js';
import { MOVE_WAIT_MS, classifyDisconnect, isPermanentJoinError, moveTarget, retryDelay } from './reconnect.js';

const DEFAULT_BITRATE = 64_000;
/** Очередь `AudioSource`, мс: столько звука лежит у LiveKit впереди; пока полна, `captureFrame` ждёт — это и есть темп. */
const SOURCE_QUEUE_MS = 1000;
/** Запасная проба: как часто пробовать опубликовать звук заново, пока бот заглушён (если права по токену неизвестны). */
const UNMUTE_PROBE_MS = 5000;
/** Перенос, о котором `voice_state` сообщил раньше отключения, действителен столько. */
const PENDING_MOVE_TTL_MS = 10_000;

let disposed = false;

/** Освободить нативную часть `@livekit/rtc-node` (после этого звук в процессе недоступен). */
export async function disposeVoice(): Promise<void> {
  if (disposed) return;
  disposed = true;
  await disposeRtc();
}

interface PlayRun {
  readonly ctl: AbortController;
  kill: () => void;
}

type Listener<K extends keyof VoiceEvents> = (...args: VoiceEvents[K]) => void;

export class Connection extends EventEmitter implements VoiceConnection {
  private readonly host: VoiceHost;
  private readonly opts: Required<Pick<VoiceJoinOptions, 'normalize' | 'followMoves'>> & { bitrate: number; ffmpegPath: string };
  private selfId = '';
  private chId: string;
  private srvId: string | undefined;
  private st: VoiceConnection['state'] = 'connected';

  private room: Room | null = null;
  private source: AudioSource | null = null;
  private pubSid: string | null = null;
  private isMuted = false;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private probing = false;

  private readonly queueImpl: TrackQueue;
  private readonly gate = new PlaybackGate();
  private vol = 1;
  private run: PlayRun | null = null;

  private closed = false;
  private readonly life = new AbortController();
  private unsubscribe: (() => void) | null = null;
  private moveWaiter: ((to: string | null) => void) | null = null;
  private pendingMove: { to: string; at: number } | null = null;
  private recovering = false;

  private constructor(host: VoiceHost, channelId: string, options: VoiceJoinOptions) {
    super();
    this.host = host;
    this.chId = channelId;
    this.opts = {
      bitrate: options.bitrate ?? DEFAULT_BITRATE,
      normalize: options.normalize !== false,
      followMoves: options.followMoves !== false,
      ffmpegPath: resolveFfmpegPath(options.ffmpegPath),
    };
    this.queueImpl = new TrackQueue({
      start: (t) => this.startTrack(t),
      abort: () => this.run?.kill(),
      ended: (t, reason) => this.emit('trackEnd', t, reason),
      idle: () => this.emit('idle'),
      pauseChanged: (paused) => {
        this.gate.set('paused', paused);
        if (paused) this.source?.clearQueue();
      },
    });
  }

  /** Войти в канал: проверка ffmpeg → `joinVoice` → комната LiveKit → публикация дорожки. */
  static async open(host: VoiceHost, channelId: string, options: VoiceJoinOptions = {}): Promise<Connection> {
    if (disposed) throw new Error('Voice is disposed in this process (bot.stop() was called); start a new process to join voice again');
    const c = new Connection(host, channelId, options);
    await checkFfmpeg(c.opts.ffmpegPath);
    c.selfId = (await host.getMe()).id;
    try {
      await c.connect(channelId);
    } catch (e) {
      await c.teardownRoom();
      await host.api.leaveVoice(channelId).catch(() => {});
      throw e;
    }
    c.unsubscribe = host.onVoiceState((u) => c.onVoiceState(u));
    return c;
  }

  // ─── Состояние ───────────────────────────────────────────────────────────────────────────────────────────────────

  get channelId(): string {
    return this.chId;
  }
  get serverId(): string | undefined {
    return this.srvId;
  }
  get state(): VoiceConnection['state'] {
    return this.st;
  }
  get queue(): readonly Track[] {
    return this.queueImpl.waiting;
  }
  get current(): Track | null {
    return this.queueImpl.current;
  }
  get paused(): boolean {
    return this.queueImpl.paused;
  }
  get muted(): boolean {
    return this.isMuted;
  }
  get volume(): number {
    return this.vol;
  }
  set volume(v: number) {
    this.vol = clampVolume(v);
  }
  get members(): readonly VoiceMember[] {
    const out: VoiceMember[] = [];
    for (const p of this.room?.remoteParticipants.values() ?? []) {
      if (p.identity === this.selfId || p.identity.endsWith('#screen')) continue;
      out.push(toMember(p));
    }
    return out;
  }

  // ─── Управление ──────────────────────────────────────────────────────────────────────────────────────────────────

  play(source: PlaySource, options?: PlayOptions): Track {
    if (this.closed) throw new Error('The voice connection is closed (leave() was called)');
    return this.queueImpl.add(source, options);
  }
  skip(): boolean {
    return this.queueImpl.skip();
  }
  stop(): void {
    this.queueImpl.stop();
  }
  pause(): boolean {
    return this.queueImpl.pause();
  }
  resume(): boolean {
    return this.queueImpl.resume();
  }

  async leave(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.st = 'closed';
    this.life.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.moveWaiter?.(null);
    this.stopProbe();
    this.queueImpl.stop();
    this.gate.wake();
    await this.teardownRoom();
    await this.host.api.leaveVoice(this.chId).catch(() => {});
  }

  /** Зайти снова после `disconnected` (очередь сохранена). */
  async rejoin(channelId?: string): Promise<void> {
    if (this.closed) throw new Error('The voice connection is closed (leave() was called)');
    if (this.st === 'connected' && !channelId) return;
    if (channelId) this.chId = channelId;
    this.gate.set('offline', true);
    try {
      await this.connect(this.chId);
    } catch (e) {
      await this.teardownRoom();
      this.st = 'disconnected';
      throw e;
    }
    this.st = 'connected';
    this.gate.set('offline', false);
    this.emit('reconnected');
  }

  // ─── Типизированные подписки ─────────────────────────────────────────────────────────────────────────────────────

  override on<K extends keyof VoiceEvents>(event: K, listener: Listener<K>): this {
    return super.on(event, listener as (...a: unknown[]) => void);
  }
  override once<K extends keyof VoiceEvents>(event: K, listener: Listener<K>): this {
    return super.once(event, listener as (...a: unknown[]) => void);
  }
  override off<K extends keyof VoiceEvents>(event: K, listener: Listener<K>): this {
    return super.off(event, listener as (...a: unknown[]) => void);
  }

  /** `error` без слушателя в EventEmitter бросил бы исключение и уронил бота — пишем в лог бота. */
  private reportError(err: Error & { stderr?: string }, track: Track | null): void {
    if (this.listenerCount('error') > 0) this.emit('error', err, track);
    else this.host.log(`voice error${track ? ` (track "${track.title}")` : ''}: ${err.message}`);
  }

  // ─── Вход и комната ──────────────────────────────────────────────────────────────────────────────────────────────

  /** `joinVoice` на сервере → комната LiveKit → дорожка (если не заглушены). Прошлую комнату закрывает. */
  private async connect(channelId: string): Promise<void> {
    await this.teardownRoom();
    const info = await this.host.api.joinVoice(channelId, { bitrate: this.opts.bitrate });
    this.chId = info.chat?.id || channelId;
    this.srvId = info.chat?.server_id;
    const bitrate = info.audio?.bitrate || this.opts.bitrate;
    const room = new Room();
    this.bindRoom(room);
    this.room = room;
    await room.connect(info.url, info.token, { autoSubscribe: false, dynacast: false });
    if (this.room !== room) throw new Error('voice connection was closed while joining');
    this.isMuted = info.server_muted;
    this.gate.set('muted', info.server_muted);
    if (info.server_muted) this.startProbe();
    else await this.publish(room, bitrate);
  }

  private async publish(room: Room, bitrate = this.opts.bitrate): Promise<void> {
    const local = room.localParticipant;
    if (!local) throw new Error('room has no local participant');
    const source = new AudioSource(SAMPLE_RATE, CHANNELS, SOURCE_QUEUE_MS);
    const track = LocalAudioTrack.createAudioTrack('music', source);
    const options = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE, dtx: false, audioEncoding: { maxBitrate: BigInt(bitrate) } });
    try {
      const pub = await local.publishTrack(track, options);
      this.pubSid = pub.sid ?? null;
      this.source = source;
    } catch (e) {
      await source.close().catch(() => {});
      throw e;
    }
  }

  private async teardownRoom(): Promise<void> {
    const room = this.room;
    const source = this.source;
    this.room = null;
    this.source = null;
    this.pubSid = null;
    if (room) await room.disconnect().catch(() => {});
    if (source) await source.close().catch(() => {});
  }

  private bindRoom(room: Room): void {
    const mine = () => this.room === room && !this.closed;
    room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      if (mine() && p.identity !== this.selfId && !p.identity.endsWith('#screen')) this.emit('memberJoin', toMember(p));
    });
    room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      if (mine() && p.identity !== this.selfId && !p.identity.endsWith('#screen')) this.emit('memberLeave', toMember(p));
    });
    room.on(RoomEvent.Reconnecting, () => {
      if (!mine()) return;
      this.st = 'reconnecting';
      this.gate.set('offline', true);
      this.source?.clearQueue();
      this.emit('reconnecting');
    });
    room.on(RoomEvent.Reconnected, () => {
      if (!mine()) return;
      this.st = 'connected';
      this.gate.set('offline', false);
      this.emit('reconnected');
    });
    room.on(RoomEvent.Disconnected, (reason: DisconnectReason) => {
      if (this.room !== room || this.closed) return;
      void this.onDisconnected(DisconnectReason[reason] ?? String(reason));
    });
    // Мьют модератором = смена прав. rtc-node 1.1.0 сообщает о ней ТОЛЬКО перевыпуском токена (`room.token`, см. `grants.ts`).
    room.on(RoomEvent.TokenRefreshed, () => {
      if (mine()) this.onGrants(room);
    });
    // Запасные признаки (в rtc-node 1.1.0 при смене прав не приходят, но могут прийти в других версиях).
    // 🔴 Публикация может прийти `undefined`: после `unpublishTrack` rtc-node уже убрал её из своего списка и шлёт событие
    // с пустым местом (без `?.` процесс бота падал на собственном снятии дорожки).
    room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (mine() && pub?.sid && pub.sid === this.pubSid) this.onServerMuted();
    });
    room.on(RoomEvent.LocalTrackRepublished, (pub, previousSid) => {
      if (mine() && previousSid && previousSid === this.pubSid) this.pubSid = pub?.sid ?? null;
    });
    room.on(RoomEvent.TrackMuted, (pub, p: Participant) => {
      if (mine() && p?.identity === this.selfId && pub?.sid && pub.sid === this.pubSid) this.onServerMuted();
    });
  }

  // ─── Мьют модератором ────────────────────────────────────────────────────────────────────────────────────────────

  /** Права из свежего токена: стало нельзя — мьют; снова можно — сразу публикуем звук заново (не ждём пробы). */
  private onGrants(room: Room): void {
    const can = canSpeakFromToken(room.token);
    if (can === false) this.onServerMuted();
    else if (can === true && this.isMuted) void this.probe();
  }

  private onServerMuted(): void {
    if (this.isMuted) return;
    this.isMuted = true;
    const sid = this.pubSid;
    this.pubSid = null;
    this.gate.set('muted', true);
    this.source?.clearQueue();
    // Сервер нашу публикацию уже снял, а rtc-node её помнит: убираем локально, иначе новая публикация упрётся в старую.
    const local = this.room?.localParticipant;
    if (sid && local) void local.unpublishTrack(sid).catch(() => {});
    this.startProbe();
    this.emit('muted');
  }

  /** Событий «мьют снят» у rtc-node нет: пока заглушены, раз в несколько секунд пробуем опубликовать звук снова. */
  private startProbe(): void {
    if (this.probeTimer || this.closed) return;
    this.probeTimer = setInterval(() => void this.probe(), UNMUTE_PROBE_MS);
    this.probeTimer.unref?.();
  }

  private stopProbe(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  private async probe(): Promise<void> {
    const room = this.room;
    if (this.probing || !room || this.closed || !this.isMuted || this.st !== 'connected') return;
    // Токен говорит «нельзя» — не стучимся зря (снятие мьюта придёт новым токеном, см. `onGrants`).
    if (canSpeakFromToken(room.token) === false) return;
    this.probing = true;
    try {
      const oldSource = this.source;
      await this.publish(room);
      if (this.room !== room) return;
      if (oldSource && oldSource !== this.source) await oldSource.close().catch(() => {});
      this.isMuted = false;
      this.stopProbe();
      this.gate.set('muted', false);
      this.emit('unmuted');
    } catch {
      /* прав на публикацию ещё нет — повторим */
    } finally {
      this.probing = false;
    }
  }

  // ─── Отключение, повторы, перенос ────────────────────────────────────────────────────────────────────────────────

  private onVoiceState(update: VoiceStateUpdated): void {
    if (!this.opts.followMoves || this.closed) return;
    const to = moveTarget(update, this.selfId, this.chId);
    if (!to) return;
    if (this.moveWaiter) this.moveWaiter(to);
    else this.pendingMove = { to, at: Date.now() };
  }

  private waitMove(ms: number): Promise<string | null> {
    const pending = this.pendingMove;
    this.pendingMove = null;
    if (pending && Date.now() - pending.at < PENDING_MOVE_TTL_MS) return Promise.resolve(pending.to);
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), ms);
      const done = (to: string | null) => {
        clearTimeout(timer);
        this.moveWaiter = null;
        resolve(to);
      };
      this.moveWaiter = done;
    });
  }

  private async onDisconnected(reasonName: string): Promise<void> {
    if (this.recovering) return;
    const action = classifyDisconnect(reasonName);
    if (action === 'ignore') return;
    this.recovering = true;
    try {
      this.gate.set('offline', true);
      this.source?.clearQueue();
      this.stopProbe();
      await this.teardownRoom();
      if (action === 'kicked') {
        // Бота убрали из комнаты (штатно): без повторов. Но если это перенос модератором — идём следом.
        const to = this.opts.followMoves ? await this.waitMove(MOVE_WAIT_MS) : null;
        if (this.closed) return;
        if (to) {
          const from = this.chId;
          this.chId = to;
          if (await this.retryJoin(true)) this.emit('moved', to, from);
          return;
        }
        this.markDisconnected({ kicked: true, reason: reasonName });
        return;
      }
      this.st = 'reconnecting';
      this.emit('reconnecting');
      if (await this.retryJoin(false)) this.emit('reconnected');
    } finally {
      this.recovering = false;
    }
  }

  /** Повторные `joinVoice` с паузами 1-2-4-8-16-30 с (до 6). `true` — вошли. Перед первой попыткой при `immediate` пауз нет. */
  private async retryJoin(immediate: boolean): Promise<boolean> {
    let lastError = 'unknown';
    for (let attempt = 0; ; attempt++) {
      const delay = retryDelay(attempt);
      if (delay === null) break;
      if (!(immediate && attempt === 0) && !(await this.sleep(delay))) return false;
      if (this.closed) return false;
      try {
        await this.connect(this.chId);
        this.st = 'connected';
        this.gate.set('offline', false);
        return true;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        await this.teardownRoom();
        if (isPermanentJoinError(e)) break;
      }
    }
    if (!this.closed) this.markDisconnected({ kicked: false, reason: lastError });
    return false;
  }

  /** `disconnected` — ровно один раз на одно отключение: повторный признак того же отключения (второе событие комнаты, гонка
   *  с повторами) не шлёт его снова. Следующее разрешено только после `rejoin`/успешного входа (`st` снова `connected`). */
  private markDisconnected(info: { kicked: boolean; reason: string }): void {
    if (this.st === 'disconnected') return;
    this.st = 'disconnected';
    this.emit('disconnected', info);
  }

  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(true), ms);
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        this.life.signal.removeEventListener('abort', onAbort);
        resolve(ok);
      };
      const onAbort = () => finish(false);
      if (this.life.signal.aborted) return finish(false);
      this.life.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ─── Воспроизведение ─────────────────────────────────────────────────────────────────────────────────────────────

  private startTrack(t: QueueTrack): void {
    this.emit('trackStart', t);
    void this.runTrack(t).catch((e) => {
      this.reportError(asError(e), t);
      this.queueImpl.finish(t, 'error');
    });
  }

  private async runTrack(t: QueueTrack): Promise<void> {
    const ctl = new AbortController();
    const run: PlayRun = { ctl, kill: () => {} };
    this.run = run;
    const abort = () => {
      ctl.abort();
      this.gate.wake();
    };
    let ff: FfmpegRun | null = null;
    try {
      const src = t.source;
      let readable: AsyncIterable<Uint8Array> & { destroy(): unknown };
      if (typeof src === 'string' || !('pcm' in src)) {
        ff = spawnFfmpeg(this.opts.ffmpegPath, src as string | import('node:stream').Readable, { normalize: this.opts.normalize });
        readable = ff.stdout;
        const f = ff;
        run.kill = () => {
          abort();
          f.kill();
        };
      } else {
        readable = src.pcm;
        run.kill = () => {
          abort();
          src.pcm.destroy();
        };
      }
      const slicer = new FrameSlicer();
      try {
        for await (const chunk of readable) {
          if (ctl.signal.aborted) break;
          for (const frame of slicer.push(chunk)) {
            if (!(await this.sendFrame(ctl.signal, t, frame))) return;
          }
        }
      } catch (e) {
        if (ctl.signal.aborted) return;
        // Поток читается до конца, но ffmpeg мог упасть: даём ему слово в `exited`, иначе это ошибка потока.
        const ffErr = ff ? await ff.exited : null;
        throw ffErr ?? e;
      }
      if (ctl.signal.aborted) return;
      const tail = slicer.flush();
      if (tail && !(await this.sendFrame(ctl.signal, t, tail))) return;
      const ffErr = ff ? await ff.exited : null;
      if (ctl.signal.aborted) return;
      if (ffErr) throw ffErr;
      await this.drain(ctl.signal);
      if (ctl.signal.aborted) return;
      this.queueImpl.finish(t, 'finished');
    } catch (e) {
      if (ctl.signal.aborted) return;
      this.reportError(asError(e), t);
      run.kill = () => {};
      this.queueImpl.finish(t, 'error');
    } finally {
      if (this.run === run) this.run = null;
      ff?.kill();
    }
  }

  /** Один кадр: ждём ворота, применяем громкость, отдаём в источник (он ждёт, пока в его очереди есть место). */
  private async sendFrame(signal: AbortSignal, t: QueueTrack, frame: Buffer): Promise<boolean> {
    if (!(await this.gate.wait(signal))) return false;
    const source = this.source;
    if (!source) return true; // связь рвётся прямо сейчас: кадр теряем, ворота закроются
    const pcm = applyVolume(frame, this.vol * t.volume);
    try {
      await source.captureFrame(new AudioFrame(pcm, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES));
    } catch (e) {
      if (signal.aborted || !this.gate.open || this.source !== source) return true;
      throw e;
    }
    return true;
  }

  /** Дождаться, пока доиграет то, что лежит в очереди источника. Пауза/обрыв посреди ожидания — ждём открытия и повторяем. */
  private async drain(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (!(await this.gate.wait(signal))) return;
      const source = this.source;
      if (!source) return;
      await source.waitForPlayout().catch(() => {});
      if (this.gate.open) return;
    }
  }
}

function toMember(p: RemoteParticipant): VoiceMember {
  let bot = false;
  try {
    const meta = p.metadata ? (JSON.parse(p.metadata) as { bot?: unknown }) : null;
    bot = meta?.bot === true;
  } catch {
    /* метаданные не JSON — человек */
  }
  return { id: p.identity, name: p.name || p.identity, bot };
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
