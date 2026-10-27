/**
 * PCM: нарезка потока на кадры по 10 мс и громкость. Чистый модуль — без `@livekit/rtc-node`.
 *
 * Формат звука GusVoice для ботов: s16le, 48 000 Гц, 2 канала. Кадр LiveKit — 10 мс = 480 сэмплов на канал = 1920 байт.
 */

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
/** Сэмплов на канал в одном кадре (10 мс). */
export const FRAME_SAMPLES = 480;
/** Байт на сэмпл одного канала. */
export const BYTES_PER_SAMPLE = 2;
/** Байт в кадре (оба канала). */
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * BYTES_PER_SAMPLE;
/** Байт в одном сэмпле всех каналов (границу куска надо держать кратной этому, иначе левый канал станет правым). */
export const BYTES_PER_FRAME_SAMPLE = CHANNELS * BYTES_PER_SAMPLE;

export const VOLUME_MIN = 0;
export const VOLUME_MAX = 2;

/** Громкость в допустимые пределы 0…2; не число и NaN — 1. */
export function clampVolume(v: number): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return 1;
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, v));
}

/**
 * Режет поток кусков произвольного размера на кадры по `FRAME_BYTES`; хвост короче кадра ждёт следующего куска.
 * Куски приходят из `stdout` ffmpeg по 64 КБ и не кратны кадру — остаток нельзя терять.
 */
export class FrameSlicer {
  private rest: Buffer = Buffer.alloc(0);

  /** Добавить кусок, вернуть готовые кадры (каждый ровно `FRAME_BYTES`). */
  push(chunk: Uint8Array): Buffer[] {
    const data = this.rest.length ? Buffer.concat([this.rest, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const frames: Buffer[] = [];
    let off = 0;
    while (data.length - off >= FRAME_BYTES) {
      // Копия: `data` может быть окном общего буфера потока, а кадр уходит в асинхронный вызов.
      frames.push(Buffer.from(data.subarray(off, off + FRAME_BYTES)));
      off += FRAME_BYTES;
    }
    this.rest = Buffer.from(data.subarray(off));
    return frames;
  }

  /** Сколько байт ждёт следующего куска. */
  get pending(): number {
    return this.rest.length;
  }

  /**
   * Конец потока: хвост добивается тишиной до целого кадра. Хвост из неполного сэмпла (меньше 4 байт) отбрасывается.
   * Нет хвоста — `null`.
   */
  flush(): Buffer | null {
    const whole = this.rest.length - (this.rest.length % BYTES_PER_FRAME_SAMPLE);
    const out = whole > 0 ? Buffer.alloc(FRAME_BYTES) : null;
    if (out) this.rest.copy(out, 0, 0, whole);
    this.rest = Buffer.alloc(0);
    return out;
  }

  reset(): void {
    this.rest = Buffer.alloc(0);
  }
}

/**
 * Кадр s16le → `Int16Array` с громкостью `volume` (множитель на сэмплы, предел ±32767). Читает через `readInt16LE`, поэтому
 * не зависит от выравнивания буфера и порядка байт машины. `volume === 1` — просто копия.
 */
export function applyVolume(frame: Uint8Array, volume: number): Int16Array {
  const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const n = buf.length >> 1;
  const out = new Int16Array(n);
  const gain = clampVolume(volume);
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    if (gain === 1) {
      out[i] = v;
    } else {
      const g = Math.round(v * gain);
      out[i] = g > 32767 ? 32767 : g < -32767 ? -32767 : g;
    }
  }
  return out;
}
