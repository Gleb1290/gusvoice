/**
 * Типы голоса (API 4, #232). Объявлены в основном пакете, реализует их дополнение `@gusvoice/bot-voice`: так основной
 * пакет не зависит от дополнения (и от нативного `@livekit/rtc-node`), а дополнение не тянет основной в рантайме.
 */
import type { Readable } from 'node:stream';
import type { Api } from './apiClient.js';
import type { VoiceStateUpdated } from './wire.js';

/** Чем закончился трек: доиграл / `skip()` / `stop()` или `leave()` / ошибка ffmpeg или потока. */
export type TrackEndReason = 'finished' | 'skipped' | 'stopped' | 'error';

/**
 * Что играть: путь к файлу, адрес `http(s)://` (скачивает ffmpeg НА МАШИНЕ БОТА), `Readable` в любом формате ffmpeg или
 * `{ pcm }` — готовый поток PCM s16le 48 кГц, 2 канала (тогда ffmpeg не нужен).
 */
export type PlaySource = string | Readable | { pcm: Readable };

export interface PlayOptions {
  /** Название для очереди и событий; по умолчанию — имя файла или хост адреса. */
  title?: string;
  /** Множитель громкости этого трека, 0…2 (по умолчанию 1); умножается на `vc.volume`. */
  volume?: number;
}

export interface Track {
  /** Порядковый номер в этом подключении. */
  readonly id: number;
  readonly title: string;
  readonly source: PlaySource;
  readonly volume: number;
  readonly state: 'queued' | 'playing' | 'ended';
  /** Причина конца; пока трек не закончился — `null`. */
  readonly endReason: TrackEndReason | null;
  /** Выполняется один раз, когда трек закончился (не отклоняется никогда). */
  readonly finished: Promise<TrackEndReason>;
}

/** Участник комнаты (бот видит, кто в канале, но не слышит их звук). */
export interface VoiceMember {
  /** id пользователя GusVoice (то же, что `User.id`). */
  readonly id: string;
  readonly name: string;
  readonly bot: boolean;
}

export interface VoiceDisconnectInfo {
  /**
   * `true` — бота убрали из комнаты (отключил модератор, сняли с сервера, бот один 5 минут, комната закрыта): это штатно,
   * SDK не переподключается, очередь сохранена, вернуться можно `vc.rejoin()`. `false` — связь не вернулась после повторов.
   */
  kicked: boolean;
  /** Причина LiveKit (`PARTICIPANT_REMOVED`, `ROOM_DELETED`…) или текст последней ошибки входа. */
  reason: string;
}

export interface VoiceEvents {
  trackStart: [track: Track];
  trackEnd: [track: Track, reason: TrackEndReason];
  /** Очередь пуста, играть нечего (дорожка остаётся опубликованной, ничего не шлётся). */
  idle: [];
  /** Ошибка ffmpeg или потока; у ffmpeg в `stderr` — последние 2 КБ его вывода. Без слушателя пишется в лог бота. */
  error: [error: Error & { stderr?: string }, track: Track | null];
  /** Модератор заглушил бота: воспроизведение на паузе. */
  muted: [];
  unmuted: [];
  memberJoin: [member: VoiceMember];
  memberLeave: [member: VoiceMember];
  reconnecting: [];
  reconnected: [];
  disconnected: [info: VoiceDisconnectInfo];
  /** Модератор перенёс бота, SDK зашёл в новый канал (`followMoves`). */
  moved: [channelId: string, fromChannelId: string];
}

export interface VoiceJoinOptions {
  /** Битрейт Opus, 24000–128000 (по умолчанию 64000). */
  bitrate?: number;
  /** Выравнивать громкость до −18 LUFS (ffmpeg `loudnorm`). По умолчанию `true`. */
  normalize?: boolean;
  /** Модератор перенёс бота — зайти в новый канал. По умолчанию `true`. */
  followMoves?: boolean;
  /** Путь к ffmpeg; иначе переменная `FFMPEG_PATH`, иначе `ffmpeg` из PATH. */
  ffmpegPath?: string;
}

export interface VoiceConnection {
  /** Канал, где бот сейчас (меняется при переносе модератором). */
  readonly channelId: string;
  readonly serverId: string | undefined;
  readonly state: 'connected' | 'reconnecting' | 'disconnected' | 'closed';
  /** Ожидающие треки (без играющего). */
  readonly queue: readonly Track[];
  /** Играющий трек (в том числе на паузе) или `null`. */
  readonly current: Track | null;
  readonly paused: boolean;
  /** Модератор заглушил бота: говорить нельзя. */
  readonly muted: boolean;
  /** Общая громкость, 0…2 (по умолчанию 1), меняется на лету. */
  volume: number;
  /** Кто в комнате сейчас (без самого бота). */
  readonly members: readonly VoiceMember[];
  /** Поставить в очередь (играет сразу, если очередь пуста). */
  play(source: PlaySource, options?: PlayOptions): Track;
  /** Пропустить играющий трек (`false` — играть нечего). */
  skip(): boolean;
  /** Остановить и очистить очередь. */
  stop(): void;
  pause(): boolean;
  resume(): boolean;
  /** Зайти снова после `disconnected` (в тот же канал или `channelId`); очередь сохранена. */
  rejoin(channelId?: string): Promise<void>;
  /** Выйти из канала, очистить очередь. Повтор безопасен. */
  leave(): Promise<void>;
  on<K extends keyof VoiceEvents>(event: K, listener: (...args: VoiceEvents[K]) => void): this;
  once<K extends keyof VoiceEvents>(event: K, listener: (...args: VoiceEvents[K]) => void): this;
  off<K extends keyof VoiceEvents>(event: K, listener: (...args: VoiceEvents[K]) => void): this;
}

/** Что основной пакет даёт дополнению. */
export interface VoiceHost {
  readonly api: Pick<Api, 'joinVoice' | 'leaveVoice'>;
  /** Сам бот (id нужен, чтобы узнать «меня перенесли»). */
  getMe(): Promise<{ id: string }>;
  /** События `voice_state` из журнала бота; возвращает отписку. */
  onVoiceState(handler: (update: VoiceStateUpdated) => void): () => void;
  log(message: string): void;
}

/** Модуль `@gusvoice/bot-voice`, как его видит основной пакет. */
export interface VoiceAddon {
  joinVoice(host: VoiceHost, channelId: string, options: VoiceJoinOptions): Promise<VoiceConnection>;
  /** Освободить нативные ресурсы (вызывается из `bot.stop()`). */
  dispose?(): Promise<void> | void;
}
