import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { finiteDeep, nativeEncodeStatsFrom } from './diagRules.js';
import type { NativeShareStats } from './nativeScreenShare.js';

describe('очистка нечисловых метрик диагностики', () => {
  it('заменяет NaN и бесконечности на любой глубине, включая массивы', () => {
    // Один NaN в глубоко вложенной метрике становится null при JSON.stringify и раньше отбрасывал
    // целый отчёт. Проверяем весь путь, а не только плоский объект кодировщика.
    const input = {
      fps: Number.NaN,
      capture: { avg: Infinity, recent: -Infinity },
      layers: [30, { encodeMs: Number.NaN }, [Infinity]],
    };

    assert.deepEqual(finiteDeep(input), {
      fps: 0,
      capture: { avg: 0, recent: 0 },
      layers: [30, { encodeMs: 0 }, [0]],
    });
  });

  it('сохраняет конечные числа, нули и нечисловые данные без подмены', () => {
    // Ноль означает «измерение не удалось»; чистка не должна путать его с плохим числом или
    // придумывать значения для строк, null и флагов.
    const input = {
      zero: 0,
      negative: -12.5,
      max: Number.MAX_VALUE,
      ready: false,
      adapter: 'NVIDIA',
      optional: null,
      values: [1, null, 'n/a', true],
    };

    assert.deepEqual(finiteDeep(input), {
      zero: 0,
      negative: -12.5,
      max: Number.MAX_VALUE,
      ready: false,
      adapter: 'NVIDIA',
      optional: null,
      values: [1, null, 'n/a', true],
    });
  });
});

const nativeStats = (patch: Partial<NativeShareStats> = {}): NativeShareStats => ({
  width: 1920, height: 1080, fps: 29.96, bytes_sent: 1, packets_sent: 2,
  target_bitrate: 3_499_999.6, frames_encoded: 10, key_frames: 2,
  limit_reason: 'bandwidth', limit_cpu_s: 1.26, limit_bandwidth_s: 2.34,
  resolution_changes: 3, encoder: 'NvCodec', power_efficient: true, nack: 4, pli: 5,
  codec: 'h264', rtt_ms: 12.36, fraction_lost: 0.1236, packets_lost: 6, at_ms: 1,
  capture_ms: 1, convert_ms: 2, src_width: 1920, src_height: 1080,
  frames_captured: 11, frames_late: 0, capture_ms_now: 1, heals: 0, stuck_s: 0,
  ...patch,
});

describe('метрики нативного кодировщика', () => {
  it('округляет канал и слои, режет строки и оставляет только первые четыре слоя', () => {
    // Ловит расхождение единиц бит/с и кбит/с, а также срез, который сервер молча отбрасывает по лимитам.
    const layers = Array.from({ length: 5 }, (_, i) => ({
      rid: `layer-${i}-long`, active: i % 2 === 0, width: 1920 >> i, height: 1080 >> i,
      fps: 29.96 - i, frames_encoded: 1, encode_ms: 1.236 + i, target_bitrate: 3_499_600 - i * 1000,
    }));
    const out = nativeEncodeStatsFrom(nativeStats({
      bwe_bps: 12_900_000.6, bwe_min_bps: 15_500_000.4, server_rtt_ms: 1.26,
      pipeline: 'gpu-extra', pipeline_note: 'n'.repeat(120), encode_ms_per_frame: 2.5, layers,
    }));
    assert.equal(out.frames_sent, 0);
    assert.equal(out.fps, 30);
    assert.equal(out.target_bitrate, 3_500_000);
    assert.equal(out.bwe_bps, 12_900_001);
    assert.equal(out.bwe_min_bps, 15_500_000);
    assert.equal(out.server_rtt_ms, 1.3);
    assert.equal(out.pipeline, 'gpu-extr');
    assert.equal(out.pipeline_note?.length, 96);
    assert.equal(out.layers?.length, 4);
    assert.deepEqual(out.layers?.[0], {
      rid: 'layer-0-', active: 1, w: 1920, h: 1080, fps: 30, encode_ms: 1.24, target_kbps: 3500,
    });
    assert.equal(out.layers?.[1]?.active, 0);
  });

  it('старая оболочка без новых полей даёт безопасные нули, а не NaN', () => {
    // Ловит несовместимость веба, обновившегося раньше десктопной оболочки.
    const out = nativeEncodeStatsFrom(nativeStats());
    assert.equal(out.encode_ms_per_frame, 0);
    assert.equal(out.bwe_bps, 0);
    assert.equal(out.bwe_min_bps, 0);
    assert.equal(out.server_rtt_ms, 0);
    assert.equal(out.layers, undefined);
    assert.equal(out.pipeline, undefined);
    assert.equal(out.qp, undefined, 'оболочка без qp_sum не сообщает выдуманный нулевой QP');
    assert.equal(out.kbps, undefined, 'без накопительных байтов старый отчёт сохраняет прежнюю форму');
    assert.equal(out.cfg, undefined, 'эффективная конфигурация отсутствует у старого протокола');
  });

  it('nativeEncodeStatsFrom предыдущего среза считает чёрный ящик и слой за окно', () => {
    // Диагностика должна объяснять последние секунды, а не делить накопленные счётчики на всё время показа.
    const layer = {
      rid: 'f', active: true, width: 1920, height: 1080, fps: 30, frames_encoded: 10, encode_ms: 2,
      qp_sum: 200, key_frames: 1, bytes_sent: 1_000, encoded_bytes_target: 1_200,
    };
    const prev = nativeStats({
      at_ms: 1_000, frames_encoded: 10, qp_sum: 200, bytes_sent: 1_000,
      encoded_bytes_target: 1_200, retransmitted_bytes: 500,
      width: 1920, height: 1080, layers: [layer],
    });
    const current = nativeStats({
      at_ms: 3_000, frames_encoded: 50, qp_sum: 1_600, bytes_sent: 126_000,
      encoded_bytes_target: 101_200, retransmitted_bytes: 25_500, huge_frames: 6, ice_rtt_ms: 12.34,
      cfg_width: 3840, cfg_height: 2160, cfg_fps: 30, cfg_bitrate: 8_000_000,
      mode: 'motion', max_quality: true, layers_on: false, keyframe_scale: 10,
      width: 1920, height: 1080,
      layers: [{ ...layer, frames_encoded: 50, qp_sum: 1_600, key_frames: 4, bytes_sent: 126_000, encoded_bytes_target: 101_200 }],
    });
    const out = nativeEncodeStatsFrom(current, prev);
    assert.equal(out.qp, 35, 'QP — среднее по 40 новым кадрам');
    assert.equal(out.kbps, 500, 'фактически отправлено 500 кбит/с за интервал');
    assert.equal(out.enc_kbps, 400, 'цель кодировщика — 400 кбит/с за интервал');
    assert.equal(out.retx_kbps, 100, 'повторные байты рассчитаны по разности');
    assert.equal(out.huge_frames, 6, 'сохраняются накопительные большие кадры');
    assert.equal(out.ice_rtt_ms, 12.3, 'проверки ICE округлены до десятых');
    assert.deepEqual(out.cfg, { w: 3840, h: 2160, fps: 30, kbps: 8000, mode: 'motion', maxq: 1, kf: 10 });
    assert.equal(out.layers?.[0]?.qp, 35, 'QP слоя вычислен из его собственного предыдущего счётчика');
    assert.equal(out.layers?.[0]?.kbps, 500, 'байты слоя тоже переводятся в скорость за окно');
    assert.equal(out.layers?.[0]?.enc_kbps, 400, 'цель слоя не смешана с фактической скоростью');
    assert.equal(out.layers?.[0]?.key_frames, 4, 'опорные кадры слоя остаются накопительными');
  });
});
