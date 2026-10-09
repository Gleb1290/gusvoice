/**
 * «Плохая картинка» у ЗРИТЕЛЯ (06.10, #207) — чистые правила, без браузера, LiveKit и сети: их можно
 * импортировать из Node и покрыть тестами (сама отправка — `badPicture.ts`).
 *
 * 🔴 Зачем. Жалоба «мылится/сыпется» приходила словами и без момента: у показывающего телеметрия есть
 * (срезы раз в 15 с), а что видел зритель и КОГДА — неизвестно; у зрителя-браузера телеметрии нет
 * вовсе. Кнопка в меню качества показа отмечает момент и прикладывает статистику приёма за 2 секунды
 * после нажатия: размер кадра, к/с, битрейт, средний QP, NACK/PLI, заморозки, потери, какой слой
 * пришёл и кто показывал. Сервер кладёт отметку рядом со срезами показывающего (`diag_reports`), а
 * `scripts/ops/bad-picture.sh` выводит случай с окружающими срезами обеих сторон.
 */

import { ownerOf } from './streamAudioRules';

/** Не чаще раза в 20 с: человек жмёт по нескольку раз подряд, а отметка нужна одна на момент. */
export const BAD_PICTURE_COOLDOWN_MS = 20_000;
/** Окно замера после нажатия: два снимка статистики приёма через столько миллисекунд. */
export const BAD_PICTURE_WINDOW_MS = 2_000;

/** Снимок статистики приёма одного видеопотока (накопительные счётчики WebRTC `inbound-rtp`). */
export interface InboundSnap {
  atMs: number;
  w: number;
  h: number;
  fps: number;
  framesDecoded: number;
  keyFramesDecoded: number;
  framesDropped: number;
  /** Сумма QP декодированных кадров; `hasQp` — браузер её отдаёт (не все отдают для H.264). */
  qpSum: number;
  hasQp: boolean;
  bytes: number;
  packetsReceived: number;
  packetsLost: number;
  nack: number;
  pli: number;
  fir: number;
  /** Заморозки картинки (>3 кадров без смены) и паузы (>5 с) — число и секунды, накопительно. */
  freezes: number;
  freezeS: number;
  pauses: number;
  pauseS: number;
  jitterMs: number;
  /** Буфер дрожания: суммарная задержка, с, и сколько кадров через него прошло. */
  jbDelayS: number;
  jbEmitted: number;
  decodeS: number;
  decoder: string;
  codec: string;
  /** Задержка до сервера по ICE, мс, и оценка входящего канала, кбит/с (0 — нет данных). */
  rttMs: number;
  availInKbps: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Снимок из записей отчёта `getStats()` приёмника. Видеопотоков в отчёте приёмника один, но берём
 * самый крупный — на случай, если браузер положит туда и устаревшую запись. `null` — видео нет.
 */
export function inboundSnapshot(entries: Iterable<Record<string, unknown>>, nowMs: number): InboundSnap | null {
  let best: Record<string, unknown> | null = null;
  let pair: Record<string, unknown> | null = null;
  const codecs = new Map<string, string>();
  for (const r of entries) {
    if (r.type === 'inbound-rtp' && r.kind === 'video') {
      const area = num(r.frameWidth) * num(r.frameHeight);
      if (!best || area >= num(best.frameWidth) * num(best.frameHeight)) best = r;
    } else if (r.type === 'codec' && typeof r.id === 'string') {
      codecs.set(r.id, str(r.mimeType, 32));
    } else if (r.type === 'candidate-pair' && (r.nominated === true || r.selected === true) && r.state !== 'failed') {
      pair = r;
    }
  }
  if (!best) return null;
  const b = best;
  return {
    atMs: num(b.timestamp) || nowMs,
    w: num(b.frameWidth),
    h: num(b.frameHeight),
    fps: num(b.framesPerSecond),
    framesDecoded: num(b.framesDecoded),
    keyFramesDecoded: num(b.keyFramesDecoded),
    framesDropped: num(b.framesDropped),
    qpSum: num(b.qpSum),
    // У Chrome на H.264 (аппаратный декодер) поля нет вовсе (стенд 06.10), у других бывает 0 — оба
    // случая «не знаем», а не «QP 0».
    hasQp: typeof b.qpSum === 'number' && b.qpSum > 0,
    bytes: num(b.bytesReceived),
    packetsReceived: num(b.packetsReceived),
    packetsLost: num(b.packetsLost),
    nack: num(b.nackCount),
    pli: num(b.pliCount),
    fir: num(b.firCount),
    freezes: num(b.freezeCount),
    freezeS: num(b.totalFreezesDuration),
    pauses: num(b.pauseCount),
    pauseS: num(b.totalPausesDuration),
    jitterMs: num(b.jitter) * 1000,
    jbDelayS: num(b.jitterBufferDelay),
    jbEmitted: num(b.jitterBufferEmittedCount),
    decodeS: num(b.totalDecodeTime),
    decoder: str(b.decoderImplementation, 48),
    codec: codecs.get(str(b.codecId, 128)) ?? '',
    rttMs: pair ? num(pair.currentRoundTripTime) * 1000 : 0,
    availInKbps: pair ? Math.round(num(pair.availableIncomingBitrate) / 1000) : 0,
  };
}

/** Что изменилось за окно между двумя снимками — «как было в эти секунды». */
export interface InboundWindow {
  ms: number;
  kbps: number;
  /** Декодировано кадров в секунду (а не «как говорит браузер» — тот усредняет по-своему). */
  fps: number;
  /** Средний QP за окно; `null` — браузер QP не отдаёт или кадров не было. */
  qp: number | null;
  lossPct: number;
  nack: number;
  pli: number;
  freezes: number;
  freezeMs: number;
  dropped: number;
  keyFrames: number;
  /** Средняя задержка буфера дрожания за окно, мс. */
  jbMs: number;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Разности двух снимков. Счётчики пошли назад (поток пересоздан) — `null`. */
export function inboundWindow(a: InboundSnap, b: InboundSnap): InboundWindow | null {
  const ms = b.atMs - a.atMs;
  if (ms <= 0 || b.framesDecoded < a.framesDecoded || b.bytes < a.bytes) return null;
  const frames = b.framesDecoded - a.framesDecoded;
  const lost = Math.max(0, b.packetsLost - a.packetsLost);
  const got = Math.max(0, b.packetsReceived - a.packetsReceived);
  const emitted = b.jbEmitted - a.jbEmitted;
  return {
    ms: Math.round(ms),
    kbps: Math.round(((b.bytes - a.bytes) * 8) / ms),
    fps: round1((frames * 1000) / ms),
    qp: b.hasQp && frames > 0 && b.qpSum >= a.qpSum ? round1((b.qpSum - a.qpSum) / frames) : null,
    lossPct: got + lost > 0 ? round1((lost * 100) / (got + lost)) : 0,
    nack: Math.max(0, b.nack - a.nack),
    pli: Math.max(0, b.pli - a.pli),
    freezes: Math.max(0, b.freezes - a.freezes),
    freezeMs: Math.max(0, Math.round((b.freezeS - a.freezeS) * 1000)),
    dropped: Math.max(0, b.framesDropped - a.framesDropped),
    keyFrames: Math.max(0, b.keyFramesDecoded - a.keyFramesDecoded),
    jbMs: emitted > 0 ? Math.round(((b.jbDelayS - a.jbDelayS) / emitted) * 1000) : 0,
  };
}

/**
 * Какой слой пришёл — по высоте кадра против объявленных слоёв трека (верхний — `high`, нижний —
 * `low`, между ними — `medium`). Объявленный размер — настройка показывающего, реальный кадр бывает
 * меньше (ультраширокий монитор, окно), поэтому берём БЛИЖАЙШИЙ по короткой стороне. Слоёв нет — ''.
 */
export function layerOfFrame(
  frame: { w: number; h: number },
  layers: readonly { width?: number; height?: number }[] | undefined,
): 'high' | 'medium' | 'low' | '' {
  const shorts = [
    ...new Set((layers ?? []).map((l) => Math.min(l.width || l.height || 0, l.height || l.width || 0)).filter((v) => v > 0)),
  ].sort((x, y) => y - x);
  const s = Math.min(frame.w, frame.h);
  if (shorts.length < 2 || s <= 0) return '';
  let best = 0;
  for (let i = 1; i < shorts.length; i++) {
    if (Math.abs(shorts[i] - s) < Math.abs(shorts[best] - s)) best = i;
  }
  if (best === 0) return 'high';
  return best === shorts.length - 1 ? 'low' : 'medium';
}

/** Тело отметки — то, что уходит на сервер (`kind: 'badpic'`, схема `diagBadPicture.ts`). */
export interface BadPictureReport {
  kind: 'badpic';
  /** Момент нажатия по часам зрителя, мс; сервер ставит и свою отметку (`created_at`). */
  at: number;
  /** Кто показывал: участник LiveKit как есть и владелец (`<id>#screen` → `<id>`). */
  sharer: { identity: string; userId: string; native: boolean };
  channelId: string | null;
  viewer: { platform: 'desktop' | 'android' | 'web'; version: string };
  /** Что зритель просил (`auto`/`high`/…), какой слой пришёл, какие слои объявлены. */
  want: string;
  layer: string;
  layers: { w: number; h: number }[];
  /** Окно 2 с после нажатия и накопительное «с начала просмотра» на конец окна. */
  win: InboundWindow | null;
  now: Omit<InboundSnap, 'atMs'>;
}

/** Собрать тело отметки. Чисто: всё нужное — аргументами. */
export function buildBadPictureReport(input: {
  at: number;
  identity: string;
  channelId: string | null;
  platform: 'desktop' | 'android' | 'web';
  version: string;
  want: string;
  layers: readonly { width?: number; height?: number }[] | undefined;
  a: InboundSnap | null;
  b: InboundSnap;
}): BadPictureReport {
  const { atMs: _at, ...now } = input.b;
  // Спутник нативного показа `<id>#screen` — владелец `<id>` (тот же `ownerOf`, что у звука показа).
  const userId = ownerOf(input.identity);
  return {
    kind: 'badpic',
    at: Math.round(input.at),
    sharer: { identity: input.identity.slice(0, 128), userId: userId.slice(0, 64), native: input.identity.endsWith('#screen') },
    channelId: input.channelId ? input.channelId.slice(0, 64) : null,
    viewer: { platform: input.platform, version: input.version.slice(0, 32) },
    want: input.want.slice(0, 8),
    layer: layerOfFrame({ w: input.b.w, h: input.b.h }, input.layers),
    layers: (input.layers ?? []).slice(0, 4).map((l) => ({ w: l.width ?? 0, h: l.height ?? 0 })),
    win: input.a ? inboundWindow(input.a, input.b) : null,
    now: { ...now, jitterMs: round1(now.jitterMs), rttMs: round1(now.rttMs), freezeS: round1(now.freezeS), pauseS: round1(now.pauseS) },
  };
}
