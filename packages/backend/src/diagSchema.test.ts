import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDiagReport } from './diagSchema.js';

const sample = (patch: Record<string, unknown> = {}) => ({
  t: 1,
  procs: [],
  gpu_adapter_total_mb: 0,
  ...patch,
});

const report = (samples: unknown[]) => ({
  kind: 'screenshare' as const,
  context: {},
  marks: [],
  samples,
});

describe('схема отчёта диагностики', () => {
  it('старый срез без новых полей сохраняет фазу показа, а не становится фоном', () => {
    // До смены модели сессии отчёты приходили только во время показа. default=0 переписал бы
    // историю задним числом и сделал сравнение нагрузки «до/во время показа» бессмысленным.
    const parsed = parseDiagReport(report([sample()]));
    assert.ok(parsed);
    const [legacy] = parsed.samples.ok;
    assert.ok(legacy);
    assert.equal(parsed.samples.dropped, 0);
    assert.equal(legacy.sharing, 1);
    assert.equal(legacy.cpu_pct, 0);
    assert.equal(legacy.gpu_pct, 0);
  });

  it('один негодный срез не отбрасывает весь отчёт и оставляет причину потери', () => {
    // Регрессия аварии 2026-08-22: одна null-метрика не должна заставлять клиента бесконечно
    // слать отчёт, который сервер целиком отвергает и чью причину невозможно увидеть.
    const parsed = parseDiagReport(report([sample({ t: 10 }), sample({ t: 'не число' })]));
    assert.ok(parsed);
    assert.equal(parsed.samples.ok.length, 1);
    assert.equal(parsed.samples.ok[0]?.t, 10);
    assert.equal(parsed.samples.dropped, 1);
    assert.match(parsed.samples.firstError ?? '', /^t:/);
  });

  it('длинное имя кодировщика обрезается, а годный срез не теряется', () => {
    // Два слоя дали реальное имя длиннее старого потолка и стоили всей телеметрии показа. Здесь
    // ограничение нужно только против раздувания БД, поэтому корректное действие — обрезать.
    const encoder = 'x'.repeat(129);
    const parsed = parseDiagReport(report([
      sample({
        enc: {
          frames_encoded: 0,
          frames_sent: 0,
          fps: 0,
          limitation: '',
          limited_cpu_s: 0,
          limited_bw_s: 0,
          pli: 0,
          nack: 0,
          width: 0,
          height: 0,
          target_bitrate: 0,
          encode_ms_per_frame: 0,
          encoder,
        },
      }),
    ]));
    assert.ok(parsed);
    const [accepted] = parsed.samples.ok;
    assert.ok(accepted?.enc);
    assert.equal(parsed.samples.dropped, 0);
    assert.equal(accepted.enc.encoder, encoder.slice(0, 128));
  });
});
