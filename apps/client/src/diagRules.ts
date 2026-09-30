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
  }[];
};

/**
 * Метрики кодирования нативного показа из ответа оболочки (`gvScreenShareStats`) — ЧИСТО, без вызова
 * оболочки: округления, обрезка строк, до четырёх слоёв, умолчания для старой оболочки без новых полей.
 */
export function nativeEncodeStatsFrom(n: NativeShareStats): EncodeStats {
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
