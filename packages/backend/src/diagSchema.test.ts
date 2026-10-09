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

it('чёрный ящик сохраняет новые числа слоёв и конфиг, вырезая неизвестные поля на каждом уровне',()=>{
  // HTTP 200 без новых полей в JSONB сделал бы жалобу снова неразбираемой.
  const layer={rid:'f',active:1,w:1920,h:1080,fps:30,encode_ms:1,target_kbps:9000,qp:27,kbps:8000,enc_kbps:8500,key_frames:12};
  const cfg={w:1920,h:1080,fps:30,kbps:9000,mode:'detail',maxq:1,kf:10};
  const added={qp:27,kbps:8000,enc_kbps:8500,retx_kbps:10,huge_frames:1,ice_rtt_ms:17};
  const parsed=parseDiagReport(report([sample({enc:enc({...added,layers:[{...layer,private:'drop'}],cfg:{...cfg,private:'drop'},private:'drop'})})]));
  assert.ok(parsed,'срез с новым чёрным ящиком принят');const actual=parsed.samples.ok[0]?.enc;assert.ok(actual,'enc не потерялся');
  for(const [key,value] of Object.entries(added))assert.equal((actual as Record<string,unknown>)[key],value);
  assert.deepEqual(actual.layers,[layer]);assert.deepEqual(actual.cfg,cfg);assert.ok(!('private' in actual),'неизвестное enc поле удалено');
});

const enc = (patch: Record<string, unknown> = {}) => ({
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
  ...patch,
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
        enc: enc({ encoder }),
      }),
    ]));
    assert.ok(parsed);
    const [accepted] = parsed.samples.ok;
    assert.ok(accepted?.enc);
    assert.equal(parsed.samples.dropped, 0);
    assert.equal(accepted.enc.encoder, encoder.slice(0, 128));
  });

  it('путь кадра доходит до отчёта, режется по границам и остаётся необязательным', () => {
    // Ловит тихое удаление новых полей Zod-схемой и отказ отчётов от старой оболочки.
    const pipeline = 'gpu-extra';
    const note = 'n'.repeat(120);
    const parsed = parseDiagReport(report([
      sample({ enc: enc({ pipeline, pipeline_note: note }) }),
      sample({ t: 2, enc: enc() }),
    ]));
    assert.ok(parsed);
    assert.equal(parsed.samples.dropped, 0);
    assert.equal(parsed.samples.ok[0]?.enc?.pipeline, pipeline.slice(0, 8));
    assert.equal(parsed.samples.ok[0]?.enc?.pipeline_note, note.slice(0, 96));
    assert.equal(parsed.samples.ok[1]?.enc?.pipeline, undefined);
    assert.equal(parsed.samples.ok[1]?.enc?.pipeline_note, undefined);
  });

  it('оценка канала, сервер и цели слоёв доходят до отчёта и остаются необязательными', () => {
    // Ловит тихое вырезание новых чисел Zod-схемой и отказ срезов от старой оболочки.
    const layer = { rid: 'h', active: 1, w: 1920, h: 1080, fps: 30, encode_ms: 4, target_kbps: 3_500 };
    const parsed = parseDiagReport(report([
      sample({ enc: enc({ bwe_bps: 12_900_000, bwe_min_bps: 15_500_000, server_rtt_ms: 1.25, layers: [layer] }) }),
      sample({ t: 2, enc: enc({ layers: [{ ...layer, target_kbps: undefined }] }) }),
      sample({ t: 3, enc: enc() }),
    ]));
    assert.ok(parsed);
    assert.equal(parsed.samples.dropped, 0);
    assert.equal(parsed.samples.ok[0]?.enc?.bwe_bps, 12_900_000);
    assert.equal(parsed.samples.ok[0]?.enc?.bwe_min_bps, 15_500_000);
    assert.equal(parsed.samples.ok[0]?.enc?.server_rtt_ms, 1.25);
    assert.equal(parsed.samples.ok[0]?.enc?.layers?.[0]?.target_kbps, 3_500);
    assert.equal(parsed.samples.ok[1]?.enc?.bwe_bps, undefined);
    assert.equal(parsed.samples.ok[1]?.enc?.bwe_min_bps, undefined);
    assert.equal(parsed.samples.ok[1]?.enc?.server_rtt_ms, undefined);
    assert.equal(parsed.samples.ok[1]?.enc?.layers?.[0]?.target_kbps, undefined);
    assert.equal(parsed.samples.ok[2]?.enc?.layers, undefined);
  });

  it('владельцы GPU, игра и задержка мышиного хука доходят до хранилища', () => {
    // Ловит тихое вырезание новых полей строгим объектом Zod при успешном ответе 200.
    const load = { '3d': 1, copy: 2, venc: 3, vdec: 4, other: 5 };
    const parsed = parseDiagReport(report([
      sample({ gpu_by: { game: load, native: load, webview: load, dwm: load }, game_exe: 'x'.repeat(80), mouse_hook_events: 7, mouse_hook_lag_max_ms: 16 }),
      sample({ t: 2, gpu_by: { native: load, webview: load, dwm: load } }),
    ]));
    assert.ok(parsed);
    assert.equal(parsed.samples.dropped, 0);
    assert.deepEqual(parsed.samples.ok[0]?.gpu_by?.game, load);
    assert.equal(parsed.samples.ok[0]?.game_exe, 'x'.repeat(64));
    assert.equal(parsed.samples.ok[0]?.mouse_hook_events, 7);
    assert.equal(parsed.samples.ok[0]?.mouse_hook_lag_max_ms, 16);
    assert.equal(parsed.samples.ok[1]?.gpu_by?.game, undefined);
  });

  it('до четырёх слоёв принимаются с обрезанным rid, а пятый отбрасывает только свой срез', () => {
    // Ловит раздувание отчёта и повтор старой аварии, где один плохой срез стоил всей пачки.
    const layer = (rid: string) => ({ rid, active: 1, w: 1280, h: 720, fps: 30, encode_ms: 2 });
    const parsed = parseDiagReport(report([
      sample({ enc: enc({ layers: [layer('very-long-rid'), layer('m'), layer('l'), layer('x')] }) }),
      sample({ t: 2, enc: enc({ layers: [layer('a'), layer('b'), layer('c'), layer('d'), layer('e')] }) }),
    ]));
    assert.ok(parsed);
    assert.equal(parsed.samples.ok.length, 1);
    assert.equal(parsed.samples.dropped, 1);
    assert.equal(parsed.samples.ok[0]?.enc?.layers?.[0]?.rid, 'very-lon');
    assert.match(parsed.samples.firstError ?? '', /^enc\.layers:/);
  });

  it('признак полноэкранной игры принимает только 0/1 и остаётся необязательным', () => {
    // Ловит потерю поля, из-за которой нельзя доказать работу остановки анимаций.
    const ui = { vad_ms: 0, vad_ticks: 0, vad_tracks: 0, long_ms: 0, long_max_ms: 0, long_count: 0, hidden: 0, focused: 1 };
    const parsed = parseDiagReport(report([
      sample({ ui: { ...ui, game_fg: 1 } }), sample({ t: 2, ui }), sample({ t: 3, ui: { ...ui, game_fg: 2 } }),
    ]));
    assert.ok(parsed);
    assert.equal(parsed.samples.ok[0]?.ui?.game_fg, 1);
    assert.equal(parsed.samples.ok[1]?.ui?.game_fg, undefined);
    assert.equal(parsed.samples.dropped, 1);
  });
});
