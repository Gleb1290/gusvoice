/**
 * Чистые правила диагностики — БЕЗ браузера, API и конфига, чтобы их можно было импортировать из
 * Node и покрыть тестами. Сам `diag.ts` тянет `window`, Tauri и `api`, и из теста не поднимается.
 */

import type { NativeShareStats } from './nativeScreenShare';

/**
 * Заменить нечисловые значения нулями — рекурсивно, по вложенным объектам и массивам.
 *
 * 🔴 Появилось после разбора 2026-08-22. Сначала заслон был намеренно поверхностным — правили только
 * плоский объект метрик кодирования, чтобы не менять молча данные, которых не проверяли. Довод
 * оказался неверным по последствиям: нечисловое значение ГДЕ УГОДНО в срезе (загрузка видеокарты,
 * память процесса) превращается в JSON в `null`, и схема на сервере отбивает ВЕСЬ срез. Проверено
 * на живой схеме: умолчание спасает только от отсутствующего поля, от пустого — нет.
 *
 * То есть цена «не трогать лишнего» — потеря всего среза целиком. Поэтому вглубь.
 *
 * ⚠️ Меняем ТОЛЬКО нечисловые числа. Строки, `null` и структура остаются как есть: замена нуля не
 * выдумывает данные, а возвращает поле к тому же значению, которое оно и так имело бы при отказе
 * измерения.
 */
export function finiteDeep<T>(value: T): T {
  if (typeof value === 'number') return (Number.isFinite(value) ? value : 0) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => finiteDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      const o = value as Record<string, unknown>;
      o[k] = finiteDeep(o[k]);
    }
  }
  return value;
}

export type EncodeStats = {
  /** Кадров закодировано и отправлено. Расхождение = кадры теряются уже после кодирования. */
  frames_encoded: number;
  frames_sent: number;
  /** Реальная частота кадров у кодировщика — против той, что человек выбрал в настройках. */
  fps: number;
  /** Во что упёрлись: none | cpu | bandwidth | other. */
  limitation: string;
  /** Сколько секунд провели в каждом из состояний ограничения — накопительно за показ. */
  limited_cpu_s: number;
  limited_bw_s: number;
  /** Запросы ключевого кадра от получателей: растут, когда до них не доезжают куски картинки. */
  pli: number;
  nack: number;
  /** Ширина/высота того, что реально уходит (кодировщик мог понизить сам). */
  width: number;
  height: number;
  /** Целевой битрейт кодировщика, бит/с — падает, когда сеть не тянет. */
  target_bitrate: number;
  /** Средняя стоимость кодирования одного кадра, мс. Растёт — процессор не успевает. */
  encode_ms_per_frame: number;

  // ─── Только для НАТИВНОГО показа: этих полей у браузерного пути нет вовсе ───
  /**
   * Название кодировщика от libwebrtc: `NvCodec…` = аппаратный NVENC, `OpenH264`/`libvpx` = софт.
   *
   * 🔴 Прямой ответ на «почему при показе лагает игра»: софтверный кодировщик 1080p съедает заметную
   * долю процессора, и это ложится поверх игры. Раньше это было видно только косвенно.
   */
  encoder?: string;
  power_efficient?: boolean;
  /** Сеть до сервера: задержка, доля и число потерянных пакетов (из отчёта получателя). */
  rtt_ms?: number;
  fraction_lost?: number;
  packets_lost?: number;
  /** Сколько раз кодировщик сам понижал разрешение — прямой признак, что он не тянет. */
  resolution_changes?: number;
  key_frames?: number;
  codec?: string;
  /**
   * Сколько раз показ пересобрался САМ (#111) и сколько секунд подряд залипание держится сейчас.
   *
   * 🔴 Оба поля — проверка самолечения, а не украшение. У здорового показа `heals` обязан остаться
   * нулём: ненулевой у того, кто ни на что не жалуется, значит порог сработал вхолостую. А
   * `stuck_s` показывает «почти сработало», без него о промахах порога мы бы не узнали вовсе.
   */
  heals?: number;
  stuck_s?: number;
  /** Оценка канала самим WebRTC, бит/с (с 0.8.11): застрял оценщик или бюджет ушёл другим слоям. */
  bwe_bps?: number;
  /** Нижняя граница оценщика на показ, бит/с (> 0 — сервер в локалке), и задержка TCP до сервера, мс. */
  bwe_min_bps?: number;
  server_rtt_ms?: number;
  /** Путь кадра (#207, шаг 4, с 0.8.11): `gpu` — не покидает видеокарту, `cpu` — через оперативку. */
  pipeline?: string;
  /** Почему не `gpu`: показ окна, выключено, кодек, экран не на NVIDIA, HDR, отказ посреди показа. */
  pipeline_note?: string;
  /**
   * Слои показа (#207, с 0.8.8): что сейчас кодируется, а что стоит. С dynacast слой, который никто
   * не смотрит, на паузе — без списка `fps = 0` у основного слоя не отличить «не смотрят» от «сломалось».
   */
  layers?: {
    rid: string;
    active: 0 | 1;
    w: number;
    h: number;
    fps: number;
    encode_ms: number;
    /** Цель слоя, кбит/с (с 0.8.11). */
    target_kbps?: number;
    /** «Чёрный ящик» (06.10): средний QP слоя за окно, факт и цель кодировщика за окно, кбит/с, опорных с начала. */
    qp?: number;
    kbps?: number;
    enc_kbps?: number;
    key_frames?: number;
  }[];

  // ─── «Чёрный ящик» (06.10, #207) — только нативный показ новой оболочки ───
  /**
   * Средний QP основного слоя за окно между срезами (без прошлого среза — с начала показа). 20–30 —
   * чёткий текст, 40+ — мыло, 51 — предел H.264. Отвечает на «сыпется» числом, а не словами.
   */
  qp?: number;
  /**
   * Битрейт основного слоя за окно: `kbps` — что реально ушло, `enc_kbps` — сколько кодировщик ДОЛЖЕН
   * был выдать по своей цели. Факт ≪ цели — кодировщику нечего слать (статика, оценке не на чем расти);
   * цель низкая при высокой оценке канала — биты ушли нижним слоям.
   */
  kbps?: number;
  enc_kbps?: number;
  /** Повторы за окно, кбит/с, и «огромные» кадры с начала показа (смена сцены, опорные). */
  retx_kbps?: number;
  huge_frames?: number;
  /** Задержка проверок ICE, мс — настоящая, в отличие от `rtt_ms` (у нативного показа всегда 1). */
  ice_rtt_ms?: number;
  /** С чем показ запущен: размер (у «Родного» — источника), частота, битрейт полного слоя (кбит/с), режим, «Максимальное качество», множитель опорного кадра NVENC. */
  cfg?: { w: number; h: number; fps: number; kbps: number; mode: string; maxq: 0 | 1; kf: number };
};

/** Средний QP за окно по накопительным суммам; без прошлого замера (или он с другого слоя) — с начала. */
function windowQp(qpSum: number, frames: number, prevQp?: number, prevFrames?: number): number {
  if (prevQp !== undefined && prevFrames !== undefined && frames > prevFrames && qpSum >= prevQp) {
    return Math.round(((qpSum - prevQp) / (frames - prevFrames)) * 10) / 10;
  }
  return frames > 0 ? Math.round((qpSum / frames) * 10) / 10 : 0;
}

/** Байты за окно → кбит/с. Нет прошлого замера, окно пустое или счётчик ушёл назад — `undefined`. */
function windowKbps(now: number, prev: number | undefined, dtS: number): number | undefined {
  if (prev === undefined || dtS <= 0 || now < prev) return undefined;
  return Math.round(((now - prev) * 8) / dtS / 1000);
}

/**
 * Метрики кодирования нативного показа из ответа оболочки (`gvScreenShareStats`) — ЧИСТО, без вызова
 * оболочки: округления, обрезка строк, до четырёх слоёв, умолчания для старой оболочки без новых полей.
 *
 * `prev` — прошлый ответ оболочки (прошлый срез, 06.10): из разностей — средний QP, факт и цель
 * кодировщика «за окно». Без него QP — с начала показа, а битрейтов за окно нет. Поля «чёрного ящика»
 * появляются, только если оболочка их отдала: у старой их нет, и форма отчёта остаётся прежней.
 */
export function nativeEncodeStatsFrom(n: NativeShareStats, prev?: NativeShareStats | null): EncodeStats {
  const base = nativeEncodeBase(n);
  const p = prev ?? undefined;
  const dtS = p && p.at_ms < n.at_ms ? (n.at_ms - p.at_ms) / 1000 : 0;
  // Слои: поля «чёрного ящика» — только у слоя, о котором оболочка их сказала (новая оболочка).
  if (base.layers && n.layers) {
    base.layers = base.layers.map((l, i) => {
      const src = n.layers![i];
      if (src?.qp_sum === undefined) return l;
      const was = prevLayer(p, src.rid);
      const ok = was && was.qp_sum !== undefined && was.frames_encoded <= src.frames_encoded;
      const extra: NonNullable<EncodeStats['layers']>[number] = {
        ...l,
        qp: windowQp(src.qp_sum, src.frames_encoded, ok ? was.qp_sum : undefined, ok ? was.frames_encoded : undefined),
        key_frames: src.key_frames ?? 0,
      };
      const kbps = ok ? windowKbps(src.bytes_sent ?? 0, was.bytes_sent, dtS) : undefined;
      if (kbps !== undefined) extra.kbps = kbps;
      const enc = ok ? windowKbps(src.encoded_bytes_target ?? 0, was.encoded_bytes_target, dtS) : undefined;
      if (enc !== undefined) extra.enc_kbps = enc;
      return extra;
    });
  }
  return { ...base, ...blackBox(n, p) };
}

/** Поля «чёрного ящика» (06.10) — только у новой оболочки (есть `qp_sum`). */
function blackBox(n: NativeShareStats, prev?: NativeShareStats): Partial<EncodeStats> {
  if (n.qp_sum === undefined) return {};
  // Прошлый замер годится, только если основной слой тот же (размер) и счётчики не пошли назад —
  // иначе показ перезапустился или основным стал другой слой, и разность врала бы.
  const p =
    prev && prev.qp_sum !== undefined && prev.width === n.width && prev.at_ms < n.at_ms && prev.frames_encoded <= n.frames_encoded
      ? prev
      : undefined;
  const dtS = p ? (n.at_ms - p.at_ms) / 1000 : 0;
  const out: Partial<EncodeStats> = {
    qp: windowQp(n.qp_sum, n.frames_encoded, p?.qp_sum, p?.frames_encoded),
    huge_frames: n.huge_frames ?? 0,
    ice_rtt_ms: Math.round((n.ice_rtt_ms ?? 0) * 10) / 10,
  };
  const kbps = windowKbps(n.bytes_sent, p?.bytes_sent, dtS);
  if (kbps !== undefined) out.kbps = kbps;
  const enc = windowKbps(n.encoded_bytes_target ?? 0, p?.encoded_bytes_target, dtS);
  if (enc !== undefined) out.enc_kbps = enc;
  const retx = windowKbps(n.retransmitted_bytes ?? 0, p?.retransmitted_bytes, dtS);
  if (retx !== undefined) out.retx_kbps = retx;
  if (n.cfg_width !== undefined) {
    out.cfg = {
      w: n.cfg_width,
      h: n.cfg_height ?? 0,
      fps: n.cfg_fps ?? 0,
      kbps: Math.round((n.cfg_bitrate ?? 0) / 1000),
      mode: (n.mode ?? '').slice(0, 8),
      maxq: n.max_quality ? 1 : 0,
      kf: n.keyframe_scale ?? 0,
    };
  }
  return out;
}

/** Прошлый замер слоя с тем же `rid` — для разностей «за окно». */
function prevLayer(prev: NativeShareStats | undefined, rid: string) {
  return prev?.layers?.find((l) => l.rid === rid);
}

function nativeEncodeBase(n: NativeShareStats): EncodeStats {
  return {
    frames_encoded: n.frames_encoded,
    // Нативный отчёт считает пакеты, а не кадры. Приравнивать пакеты к кадрам нельзя — это разные
    // величины, и подставленное сюда число врало бы. Расхождение «закодировано против отправлено»
    // для этого пути смотрим по потерям пакетов ниже.
    frames_sent: 0,
    fps: Math.round(n.fps * 10) / 10,
    limitation: n.limit_reason,
    limited_cpu_s: Math.round(n.limit_cpu_s * 10) / 10,
    limited_bw_s: Math.round(n.limit_bandwidth_s * 10) / 10,
    pli: n.pli,
    nack: n.nack,
    width: n.width,
    height: n.height,
    target_bitrate: Math.round(n.target_bitrate),
    // С 0.8.8 оболочка отдаёт время кодирования; старая — нет, тогда 0, как было.
    encode_ms_per_frame: n.encode_ms_per_frame ?? 0,
    encoder: n.encoder,
    power_efficient: n.power_efficient,
    rtt_ms: Math.round(n.rtt_ms * 10) / 10,
    fraction_lost: Math.round(n.fraction_lost * 1000) / 1000,
    packets_lost: n.packets_lost,
    resolution_changes: n.resolution_changes,
    key_frames: n.key_frames,
    codec: n.codec,
    heals: n.heals,
    stuck_s: n.stuck_s,
    bwe_bps: Math.round(n.bwe_bps ?? 0),
    bwe_min_bps: Math.round(n.bwe_min_bps ?? 0),
    server_rtt_ms: Math.round((n.server_rtt_ms ?? 0) * 10) / 10,
    pipeline: n.pipeline?.slice(0, 8),
    pipeline_note: n.pipeline_note?.slice(0, 96),
    layers: n.layers?.slice(0, 4).map((l) => ({
      rid: l.rid.slice(0, 8),
      active: l.active ? 1 : 0,
      w: l.width,
      h: l.height,
      fps: Math.round(l.fps * 10) / 10,
      encode_ms: Math.round(l.encode_ms * 100) / 100,
      target_kbps: Math.round((l.target_bitrate ?? 0) / 1000),
    })),
  };
}
