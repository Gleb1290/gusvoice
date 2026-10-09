/**
 * Обрезка голосового перед отправкой (08.10, #211, G13; Telegram Desktop `history_view_voice_record_bar.cpp` `ListenWrap`:
 * две ручки по огибающей в прослушивании, `applyTrimBeforeSend` режет файл на клиенте; Android `ChatActivityEnterView`
 * `videoTimelineView` над `recordedAudioSeekBar`).
 *
 * Режем БЕЗ перекодирования — по контейнеру: рекордер пишет WebM/Opus (`voiceRecorder.pickMime`), а каждый пакет Opus
 * (20–60 мс) декодируется сам по себе. Из файла берутся заголовок, `Info` и `Tracks` как есть, а блоки (`SimpleBlock`)
 * внутри выбранного отрезка перекладываются в новые кластеры со сдвинутым временем. Быстро (без проигрывания в реальном
 * времени, как у перезаписи через `MediaRecorder`), без потери качества и тем же кодеком. Серверная обрезка по
 * `trimStart/trimEnd` отвергнута: отрезанное ушло бы на сервер и к получателю.
 * Файл не WebM (Safari пишет mp4) или разбор не удался — `voiceTrimmable` отвечает «нет», и ручек нет.
 *
 * Чистый модуль (без React и DOM, кроме `Blob`) — под тест Codex.
 */

import { WAVEFORM_BUCKETS } from '@gusvoice/shared';

/** Короче не режем: меньше секунды не отправляется и без обрезки (`VOICE_DESKTOP.minTakeMs`). */
export const VOICE_TRIM_MIN_MS = 1000;
/** Ручки появляются у записи от двух секунд: короче резать нечего — останется меньше минимума. */
export const VOICE_TRIM_FROM_MS = 2000;

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_CLUSTER = 0x1f43b675;
const ID_INFO = 0x1549a966;
const ID_TRACKS = 0x1654ae6b;
const ID_TIMECODE = 0xe7;
const ID_SIMPLEBLOCK = 0xa3;
const ID_BLOCKGROUP = 0xa0;
/** Кластер — не длиннее: время блока внутри кластера — знаковое 16-битное (мс). */
const CLUSTER_SPAN_MS = 30_000;

interface Block {
  /** Абсолютное время блока, мс (при `TimecodeScale` 1 мс — так пишет `MediaRecorder`). */
  at: number;
  /** Тело `SimpleBlock` целиком: номер дорожки, 2 байта времени, флаги, данные. */
  body: Uint8Array;
  /** Сколько байт занимает номер дорожки (время — сразу за ним). */
  trackLen: number;
}

interface Parsed {
  header: Uint8Array;
  info: Uint8Array | null;
  tracks: Uint8Array;
  blocks: Block[];
}

/** Длина числа EBML по первому байту (1–8); 0 — испорчено. */
function vintLen(b: number): number {
  for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1;
  return 0;
}

/** Идентификатор элемента (с маркерными битами, как в спецификации). */
function readId(buf: Uint8Array, pos: number): { id: number; len: number } | null {
  if (pos >= buf.length) return null;
  const len = vintLen(buf[pos]);
  if (len === 0 || len > 4 || pos + len > buf.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[pos + i];
  return { id, len };
}

/** Размер элемента; `size: -1` — «неизвестен» (все биты значения — единицы, так `MediaRecorder` пишет сегмент и кластеры). */
function readSize(buf: Uint8Array, pos: number): { size: number; len: number } | null {
  if (pos >= buf.length) return null;
  const len = vintLen(buf[pos]);
  if (len === 0 || pos + len > buf.length) return null;
  let v = buf[pos] & (0xff >> len);
  let allOnes = v === 0xff >> len;
  for (let i = 1; i < len; i++) {
    v = v * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { size: allOnes ? -1 : v, len };
}

function readUint(buf: Uint8Array, pos: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[pos + i];
  return v;
}

/** Разбор WebM из `MediaRecorder`; не тот контейнер или незнакомое строение — `null`. */
export function parseWebm(buf: Uint8Array): Parsed | null {
  const ebml = readId(buf, 0);
  if (!ebml || ebml.id !== ID_EBML) return null;
  const ebmlSize = readSize(buf, ebml.len);
  if (!ebmlSize || ebmlSize.size < 0) return null;
  const headerEnd = ebml.len + ebmlSize.len + ebmlSize.size;
  const seg = readId(buf, headerEnd);
  if (!seg || seg.id !== ID_SEGMENT) return null;
  const segSize = readSize(buf, headerEnd + seg.len);
  if (!segSize) return null;
  const segStart = headerEnd + seg.len + segSize.len;
  const segEnd = segSize.size < 0 ? buf.length : Math.min(buf.length, segStart + segSize.size);
  let info: Uint8Array | null = null;
  let tracks: Uint8Array | null = null;
  const blocks: Block[] = [];
  let p = segStart;
  while (p < segEnd) {
    const id = readId(buf, p);
    if (!id) break;
    const sz = readSize(buf, p + id.len);
    if (!sz) break;
    const dataStart = p + id.len + sz.len;
    if (id.id === ID_CLUSTER) {
      // Кластер: неизвестный размер кончается там, где начинается следующий элемент верхнего уровня (4-байтный id).
      const end = sz.size < 0 ? segEnd : Math.min(segEnd, dataStart + sz.size);
      let base: number | null = null;
      let q = dataStart;
      while (q < end) {
        const cid = readId(buf, q);
        if (!cid) break;
        if (sz.size < 0 && cid.len === 4) break;
        const csz = readSize(buf, q + cid.len);
        if (!csz || csz.size < 0) return null;
        const cStart = q + cid.len + csz.len;
        const cEnd = cStart + csz.size;
        if (cEnd > buf.length) {
          q = buf.length; // хвост снимка оборван — берём, что целиком
          break;
        }
        if (cid.id === ID_TIMECODE) base = readUint(buf, cStart, csz.size);
        else if (cid.id === ID_BLOCKGROUP) return null; // `MediaRecorder` их не пишет; незнакомое строение не режем
        else if (cid.id === ID_SIMPLEBLOCK) {
          if (base === null) return null;
          const trackLen = vintLen(buf[cStart]);
          if (trackLen === 0 || trackLen + 3 > csz.size) return null;
          const rel = (buf[cStart + trackLen] << 8) | buf[cStart + trackLen + 1];
          const signed = rel & 0x8000 ? rel - 0x10000 : rel;
          blocks.push({ at: base + signed, body: buf.subarray(cStart, cEnd), trackLen });
        }
        q = cEnd;
      }
      p = q;
      continue;
    }
    if (sz.size < 0) return null;
    const end = dataStart + sz.size;
    if (end > buf.length) break;
    if (id.id === ID_INFO) info = buf.subarray(p, end);
    else if (id.id === ID_TRACKS) tracks = buf.subarray(p, end);
    p = end; // SeekHead, Cues, Tags, Void — в обрезанном файле не нужны
  }
  if (!tracks || blocks.length === 0) return null;
  return { header: buf.subarray(0, headerEnd), info, tracks, blocks };
}

/** Размер элемента EBML на 8 байтах (так проще и всегда хватает). */
function size8(n: number): Uint8Array {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = n;
  for (let i = 7; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function idBytes(id: number): Uint8Array {
  const bytes: number[] = [];
  let v = id;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Uint8Array.from(bytes);
}

function uintBytes(n: number): Uint8Array {
  const bytes: number[] = [];
  let v = Math.max(0, Math.floor(n));
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return Uint8Array.from(bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Вырезать из WebM отрезок `[fromMs, toMs)`: блоки внутри него, время — от нуля. Не разобрался или отрезок пуст — `null`.
 */
export function cutWebm(buf: Uint8Array, fromMs: number, toMs: number): Uint8Array | null {
  const parsed = parseWebm(buf);
  if (!parsed) return null;
  const kept = parsed.blocks.filter((b) => b.at >= fromMs && b.at < toMs);
  if (kept.length === 0) return null;
  const start = kept[0].at;
  const clusters: Uint8Array[] = [];
  let i = 0;
  while (i < kept.length) {
    const base = kept[i].at - start;
    const parts: Uint8Array[] = [];
    const tc = uintBytes(base);
    parts.push(idBytes(ID_TIMECODE), Uint8Array.of(0x80 | tc.length), tc);
    while (i < kept.length && kept[i].at - start - base < CLUSTER_SPAN_MS) {
      const b = kept[i];
      const body = b.body.slice();
      const rel = b.at - start - base;
      body[b.trackLen] = (rel >> 8) & 0xff;
      body[b.trackLen + 1] = rel & 0xff;
      parts.push(idBytes(ID_SIMPLEBLOCK), size8(body.length), body);
      i++;
    }
    const content = concat(parts);
    clusters.push(idBytes(ID_CLUSTER), size8(content.length), content);
  }
  const segBody = concat([...(parsed.info ? [parsed.info] : []), parsed.tracks, ...clusters]);
  return concat([parsed.header, idBytes(ID_SEGMENT), size8(segBody.length), segBody]);
}

/** Можно ли резать этот файл: WebM, который разбирается. */
export async function voiceTrimmable(file: Blob): Promise<boolean> {
  if (!/webm/i.test(file.type)) return false;
  try {
    return parseWebm(new Uint8Array(await file.arrayBuffer())) !== null;
  } catch {
    return false;
  }
}

/** Отрезок в мс, зажатый в запись и не короче минимума; `toMs: null` — до конца (запись на паузе допишется при отправке). */
export interface VoiceTrimRange {
  fromMs: number;
  toMs: number | null;
}

/** Обрезка ничего не меняет — отправляем как есть. */
export function voiceTrimIsFull(r: VoiceTrimRange | null): boolean {
  return !r || (r.fromMs <= 0 && r.toMs === null);
}

/**
 * Доли ручек (0..1) → отрезок записи длиной `totalMs`. Правая ручка у края — «до конца» (`null`). Короче минимума —
 * раздвигаем вправо (или влево у края).
 */
export function voiceTrimFromRatios(from: number, to: number, totalMs: number): VoiceTrimRange {
  const a = Math.max(0, Math.min(1, from));
  const b = Math.max(a, Math.min(1, to));
  let fromMs = Math.round(a * totalMs);
  let toMs = Math.round(b * totalMs);
  if (toMs - fromMs < VOICE_TRIM_MIN_MS) {
    toMs = Math.min(totalMs, fromMs + VOICE_TRIM_MIN_MS);
    fromMs = Math.max(0, toMs - VOICE_TRIM_MIN_MS);
  }
  return { fromMs: fromMs <= 0 ? 0 : fromMs, toMs: b >= 0.999 ? null : toMs };
}

/** Огибающая отрезка: кусок исходной, растянутый обратно на `WAVEFORM_BUCKETS` (tdesktop `ResampleWaveformToRange`). */
export function trimWaveform(wave: readonly number[], fromRatio: number, toRatio: number, buckets = WAVEFORM_BUCKETS): number[] {
  if (wave.length === 0) return [];
  const a = Math.max(0, Math.min(1, fromRatio)) * wave.length;
  const b = Math.max(0, Math.min(1, toRatio)) * wave.length;
  const span = Math.max(b - a, 1e-6);
  const out: number[] = [];
  for (let i = 0; i < buckets; i++) {
    const lo = a + (span * i) / buckets;
    const hi = a + (span * (i + 1)) / buckets;
    let peak = 0;
    for (let j = Math.floor(lo); j < Math.max(Math.floor(lo) + 1, Math.ceil(hi)) && j < wave.length; j++) peak = Math.max(peak, wave[j]);
    out.push(peak);
  }
  return out;
}

/**
 * Обрезать готовую запись. Отрезок «вся запись» или нечего резать — та же запись. Не получилось — `null`
 * (вызывающий не отправляет: отрезанное человек слать не хотел).
 */
export async function trimVoiceTake<T extends { file: File; durationMs: number; waveform: number[] }>(
  take: T,
  range: VoiceTrimRange | null,
): Promise<T | null> {
  if (!range || voiceTrimIsFull(range)) return take;
  const total = take.durationMs;
  const fromMs = Math.min(range.fromMs, Math.max(0, total - VOICE_TRIM_MIN_MS));
  const toMs = range.toMs === null ? total : Math.min(total, range.toMs);
  if (toMs - fromMs <= 0) return null;
  const cut = cutWebm(new Uint8Array(await take.file.arrayBuffer()), fromMs, toMs);
  if (!cut) return null;
  // `concat` создаёт массив ровно по своему буферу — буфер и есть файл.
  const file = new File([cut.buffer as ArrayBuffer], take.file.name, { type: take.file.type });
  return {
    ...take,
    file,
    durationMs: toMs - fromMs,
    waveform: trimWaveform(take.waveform, fromMs / total, toMs / total),
  };
}
