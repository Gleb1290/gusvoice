/**
 * ffmpeg: сборка аргументов, поиск, запуск и хвост stderr. Чистый модуль — без `@livekit/rtc-node`.
 *
 * Запуск — `spawn` массивом аргументов, без оболочки: адрес или путь от человека не может стать командой. Перечень
 * протоколов закрывает `file:`-трюки внутри плейлистов (m3u, concat), но НЕ обращения к локальной сети машины бота:
 * проверка адресов, которые приносят люди, остаётся на авторе бота.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { CHANNELS, SAMPLE_RATE } from './pcm.js';

/** Какие протоколы ffmpeg вправе открывать (в том числе внутри плейлистов). */
export const FFMPEG_PROTOCOLS = 'file,http,https,tcp,tls,pipe';
/** Выравнивание громкости до −18 LUFS. */
export const LOUDNORM = 'loudnorm=I=-18:TP=-1.5:LRA=11';
/** Сколько байт вывода ffmpeg держим для сообщения об ошибке. */
export const STDERR_TAIL_BYTES = 2048;

export class FfmpegNotFound extends Error {
  override readonly name = 'FfmpegNotFound';
  constructor(path: string, options?: { cause?: unknown }) {
    super(
      `ffmpeg not found (${path}). Install ffmpeg (Debian/Ubuntu: apt install ffmpeg), or pass its path: bot.voice.join(id, { ffmpegPath }) / FFMPEG_PATH. ` +
        `ffmpeg не найден: установите ffmpeg или укажите путь (ffmpegPath / FFMPEG_PATH).`,
      options,
    );
  }
}

/** Ошибка ffmpeg (код выхода не 0): в `stderr` — последние 2 КБ его вывода. */
export class FfmpegError extends Error {
  override readonly name = 'FfmpegError';
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  constructor(exitCode: number | null, signal: string | null, stderr: string) {
    super(`ffmpeg exited with ${signal ? `signal ${signal}` : `code ${exitCode}`}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`);
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderr = stderr;
  }
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/**
 * Что отдать ffmpeg в `-i`. Путь, начинающийся с `-`, ffmpeg принял бы за ключ — ему даётся приставка `file:`.
 */
export function resolveInput(source: string): string {
  return source.startsWith('-') ? `file:${source}` : source;
}

export interface FfmpegArgsOptions {
  /** `loudnorm` до −18 LUFS. */
  normalize?: boolean;
  /** Вход приходит из `Readable` через stdin (`pipe:0`), а не из пути/адреса. */
  stdin?: boolean;
}

/**
 * Аргументы ffmpeg: что угодно → PCM s16le 48 кГц стерео в stdout.
 * `-reconnect*` — только для http(s) (обрыв радиопотока не должен стоить трека).
 */
export function buildFfmpegArgs(input: string, options: FfmpegArgsOptions = {}): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', FFMPEG_PROTOCOLS];
  if (!options.stdin && isHttpUrl(input)) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  args.push('-i', options.stdin ? 'pipe:0' : resolveInput(input), '-vn');
  if (options.normalize) args.push('-af', LOUDNORM);
  args.push('-f', 's16le', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), 'pipe:1');
  return args;
}

/** Путь к ffmpeg: опция → `FFMPEG_PATH` → `ffmpeg` из PATH. */
export function resolveFfmpegPath(option?: string, env: Record<string, string | undefined> = process.env): string {
  return option?.trim() || env.FFMPEG_PATH?.trim() || 'ffmpeg';
}

/** Последние `limit` байт вывода (stderr ffmpeg может быть длинным: каждый кадр с ошибкой — строка). */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly limit = STDERR_TAIL_BYTES) {}

  push(chunk: Uint8Array): void {
    this.chunks.push(Buffer.from(chunk));
    this.size += chunk.byteLength;
    // Старый кусок выкидываем, только если и без него остаётся не меньше `limit`: иначе длинный кусок, за которым пришёл
    // короткий, пропадал целиком и хвост stderr становился короче обещанного.
    while (this.chunks.length > 1 && this.size - this.chunks[0].byteLength >= this.limit) this.size -= this.chunks.shift()!.byteLength;
  }

  toString(): string {
    const all = Buffer.concat(this.chunks);
    return (all.length > this.limit ? all.subarray(all.length - this.limit) : all).toString('utf8');
  }
}

/** Проверить, что ffmpeg запускается (`ffmpeg -version`); иначе `FfmpegNotFound`. */
export function checkFfmpeg(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      err ? reject(err) : resolve();
    };
    try {
      const p = spawn(path, ['-version'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
      p.once('error', (e) => finish(new FfmpegNotFound(path, { cause: e })));
      p.once('close', (code) => finish(code === 0 ? undefined : new FfmpegNotFound(path)));
    } catch (e) {
      finish(new FfmpegNotFound(path, { cause: e }));
    }
  });
}

export interface FfmpegRun {
  readonly stdout: Readable;
  /** Закончился ли ffmpeg: `null` — нормально (код 0), иначе ошибка с хвостом stderr. Не отклоняется. */
  readonly exited: Promise<FfmpegError | null>;
  /** Прервать (SIGKILL); после этого `exited` отдаёт `null` — прерывание не ошибка. */
  kill(): void;
}

/**
 * Запустить ffmpeg. `input` — путь/адрес, либо `Readable` (тогда он льётся в stdin; обрыв stdin — не ошибка).
 */
export function spawnFfmpeg(ffmpegPath: string, input: string | Readable, options: { normalize?: boolean } = {}): FfmpegRun {
  const stdin = typeof input !== 'string';
  const args = buildFfmpegArgs(stdin ? 'pipe:0' : input, { normalize: options.normalize, stdin });
  const child = spawn(ffmpegPath, args, { stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true }) as unknown as ChildProcessByStdio<Writable | null, Readable, Readable>;
  const tail = new TailBuffer();
  child.stderr.on('data', (c: Buffer) => tail.push(c));
  let killed = false;
  if (stdin && child.stdin) {
    child.stdin.on('error', () => {}); // EPIPE, когда ffmpeg вышел раньше конца входа
    input.on('error', () => child.stdin?.destroy());
    input.pipe(child.stdin);
  }
  const exited = new Promise<FfmpegError | null>((resolve) => {
    child.once('error', (e) => resolve(new FfmpegError(null, null, `${e.message}\n${tail.toString()}`)));
    child.once('close', (code, signal) => {
      if (killed || code === 0) resolve(null);
      else resolve(new FfmpegError(code, signal, tail.toString()));
    });
  });
  return {
    stdout: child.stdout,
    exited,
    kill() {
      killed = true;
      if (stdin && typeof input !== 'string') {
        input.unpipe();
        input.destroy();
      }
      child.kill('SIGKILL');
    },
  };
}
