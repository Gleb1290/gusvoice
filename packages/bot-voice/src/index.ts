/**
 * `@gusvoice/bot-voice` — звук ботов GusVoice в голосовом канале (API 4, #232). Дополнение к `@gusvoice/bot`:
 * обычно его не импортируют напрямую, а зовут `await bot.voice.join(channelId)` — основной пакет подгружает этот.
 *
 * Нужны: Node.js ≥ 18 (linux x64/arm64 только glibc, macOS, Windows x64), `ffmpeg` в PATH или `FFMPEG_PATH`.
 */
import type { VoiceAddon, VoiceConnection, VoiceHost, VoiceJoinOptions } from '@gusvoice/bot';
import { Connection, disposeVoice } from './connection.js';

/** Точка входа для `bot.voice.join()`. */
export function joinVoice(host: VoiceHost, channelId: string, options: VoiceJoinOptions = {}): Promise<VoiceConnection> {
  return Connection.open(host, channelId, options);
}

/** Освободить нативные ресурсы `@livekit/rtc-node` (зовёт `bot.stop()`). */
export const dispose: NonNullable<VoiceAddon['dispose']> = disposeVoice;

export { Connection } from './connection.js';
export { FfmpegError, FfmpegNotFound, buildFfmpegArgs, checkFfmpeg, resolveFfmpegPath } from './ffmpeg.js';
export { FrameSlicer, applyVolume, clampVolume } from './pcm.js';
export { PlaybackGate, TrackQueue } from './queue.js';
export { RETRY_DELAYS_MS, classifyDisconnect, isPermanentJoinError, moveTarget, retryDelay } from './reconnect.js';
