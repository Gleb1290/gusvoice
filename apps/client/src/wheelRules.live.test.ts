import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import * as shared from '@gusvoice/shared';
import { load, edited, sourceOf, type Edit } from './predictions.harness';

function paired(source: string, check: (raw: string) => void, edits: readonly Edit[], prefix: string): void {
  check(source);
  for (const edit of edits) {
    counterfact(() => {
      const mutant = edited(source, edit);
      assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.startsWith(prefix),
        'контрфакт убит адресным host AssertionError, не setup/import/исключением');
    });
    check(source);
  }
}

type Rules = typeof import('./wheelRules');
const source = sourceOf('./wheelRules.ts');
const P = 'R358/wheel-live/';
const rules = (raw = source) => load<Rules>(raw, { '@gusvoice/shared': shared });
const mod = (a: number, m: number) => ((a % m) + m) % m;
const close = (a: number, b: number, message: string, epsilon = 1e-8) => assert.ok(Math.abs(a - b) <= epsilon, message);
const plan = (r: Rules, duration = 6000, sector = 4) => {
  const from = r.wheelLandAngle(0);
  return r.wheelSpinPlan(from, r.wheelLandTarget(from, sector, 5), duration);
};

for (const duration of [1, 1499, 1500, 3000, 5699, 5700, 6000]) {
  test(`R358 ${duration} мс: точные концы и монотонный основной ход без замаха посреди вращения`, () => {
    const r = rules(), p = plan(r, duration);
    close(r.wheelAngleAt(p, 0), p.from, P + 'angle/from');
    close(r.wheelAngleAt(p, duration), p.to, P + 'angle/to');
    close(r.wheelAngleAt(p, -1), p.from, P + 'angle/before');
    close(r.wheelAngleAt(p, duration + 1), p.to, P + 'angle/after');
    let previous = r.wheelAngleAt(p, p.windupMs);
    for (let t = p.windupMs; t <= p.dur - p.settleMs; t++) {
      const angle = r.wheelAngleAt(p, t);
      assert.ok(angle >= previous - 1e-9, P + 'angle/main-monotonic');
      previous = angle;
    }
    assert.equal(p.windupDeg > 0, duration >= 5700, P + 'angle/fresh-only');
    if (duration >= 1500) assert.ok(p.settleMs > 0 && p.overDeg > 0, P + 'angle/live-settle');
    else assert.equal(p.settleMs, 0, P + 'angle/short-no-settle');
  });
}

test('R358 замах на границе 5700 мс ограничен свободой последнего сорвавшегося штырька', () => paired(source, raw => {
  const r = rules(raw);
  for (const free of [0, 0.3, 0.9, 1.1, 3, 8, 14.3]) {
    const from = 720 + r.WHEEL_PEG_RELEASE_DEG + free;
    const to = r.wheelLandTarget(from, 3, 5);
    for (const dur of [3000, 5699, 5700, 6000]) {
      const p = r.wheelSpinPlan(from, to, dur);
      const allowed = Math.max(0, mod(from - r.WHEEL_PEG_RELEASE_DEG, 14.4) - 0.5);
      assert.ok(p.windupDeg <= Math.min(4.5, allowed) + 1e-8, P + 'windup/peg-freedom');
      if (dur < 5700) assert.equal(p.windupDeg, 0, P + 'windup/no-midflight');
      if (dur >= 5700 && free >= 1.1) assert.ok(p.windupDeg > 0, P + 'windup/fresh-accepted');
      close(r.wheelAngleAt(p, p.windupMs), from - p.windupDeg, P + 'windup/end-angle');
    }
  }
}, [['dur >= WHEEL_SPIN_MS - WHEEL_FRESH_SLACK_MS', 'dur >= 3000']], P + 'windup/'));

function stableSector(r: Rules, sector: number): void {
  const p = plan(r, 6000, sector), releases = r.wheelPegReleases(p);
  assert.ok(releases.length > 0, P + 'settle/real-releases');
  for (let t = Math.ceil(releases.at(-1)!); t <= p.dur; t++) {
    assert.equal(r.wheelSectorAt(r.wheelAngleAt(p, t)), sector, P + 'settle/no-edge-crossing');
  }
  assert.equal(r.wheelSectorAt(r.wheelAngleAt(p, p.dur)), sector, P + 'settle/final-sector');
}

for (let sector = 0; sector < 25; sector++) {
  test(`R358 сектор ${sector}: остановка +4,6° от центра и ни одного перехода кромки после последнего срыва`, () => {
    const r = rules();
    for (const from of [-725, -1, 0, 13.2, 1371]) for (const turns of [0, 1, 5]) {
      const to = r.wheelLandTarget(from, sector, turns);
      assert.ok(to >= from + turns * 360 - 1e-8, P + 'landing/forward-only');
      assert.equal(r.wheelSectorAt(to), sector, P + 'landing/server-sector');
      close(mod(to - shared.wheelRestAngle(sector), 360), 4.6, P + 'landing/not-center');
    }
    stableSector(r, sector);
  });
}

test('R358 перекат на три градуса запрещён: иначе на откате показывался бы чужой сектор', () => paired(source,
  raw => stableSector(rules(raw), 0), [['export const WHEEL_SETTLE_OVER_DEG = 1.9;', 'export const WHEEL_SETTLE_OVER_DEG = 3;']], P + 'settle/'));

test('R358 щелчки стоят на срывах штырьков, разделены 70 мс и не добавляют звук остановки', () => paired(source, raw => {
  const r = rules(raw), p = plan(r), clicks = r.wheelPegClicks(p), releases = r.wheelPegReleases(p);
  assert.equal(r.WHEEL_TICK_MIN_GAP_MS, 70, P + 'clicks/gap-contract');
  assert.ok(clicks.length > 5 && clicks.length < releases.length, P + 'clicks/pruned-not-silent');
  for (const [i, t] of clicks.entries()) {
    assert.ok(t < p.dur, P + 'clicks/no-stop-click');
    if (i) assert.ok(t - clicks[i - 1] >= 70, P + 'clicks/min-gap');
    // Результат округлён до 0,1 мс, бисекция срыва — до 0,01 мс: проверяем честный интервал ±0,061 мс.
    const angle = r.wheelAngleAt(p, t);
    const k = Math.round((angle - r.WHEEL_PEG_RELEASE_DEG) / 14.4);
    const release = k * 14.4 + r.WHEEL_PEG_RELEASE_DEG;
    assert.ok(r.wheelAngleAt(p, t - 0.061) <= release + 1e-8 && r.wheelAngleAt(p, t + 0.061) >= release - 1e-8,
      P + 'clicks/exact-release');
  }
}, [['    out.push(Math.round(t * 10) / 10);\n    prev = t;\n  }\n  return out;',
  '    out.push(Math.round(t * 10) / 10);\n    prev = t;\n  }\n  out.push(p.dur);\n  return out;']], P + 'clicks/'));

test('R358 перо не проходит сквозь упор, на быстрой фазе отогнуто и заканчивает в положении покоя', () => paired(source, raw => {
  const r = rules(raw), p = plan(r), track = r.featherTrack(p, 1);
  assert.ok(track.length > 1000, P + 'feather/whole-spin');
  let fast = 0, supported = 0;
  for (const f of track) {
    const angle = r.wheelAngleAt(p, f.t), floor = r.featherFloorDeg(angle);
    assert.ok(Number.isFinite(f.deg), P + 'feather/finite');
    if (Number.isFinite(floor)) { supported++; assert.ok(f.deg >= floor - 1e-8, P + 'feather/hard-stop'); }
    const speed = (r.wheelAngleAt(p, f.t + 0.5) - r.wheelAngleAt(p, f.t - 0.5)) * 1000;
    if (speed > 500) { fast++; assert.ok(f.deg >= 14.5, P + 'feather/high-speed-deflection'); }
  }
  assert.ok(fast > 100 && supported > 100, P + 'feather/exercised-fast-and-contact');
  assert.equal(track.at(-1)!.t, p.dur, P + 'feather/final-time');
  close(track.at(-1)!.deg, r.featherRestDeg(p.to), P + 'feather/final-rest', 0.05);
}, [['if (phi < floor) {', 'if (false) {']], P + 'feather/'));

// Маленький test-only декодер стандартного RGBA8 PNG, без новой зависимости и без Canvas/браузера.
function rgba(bytes: Buffer) {
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), P + 'art/png');
  const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
  assert.equal(bytes[24], 8, P + 'art/depth');
  assert.equal(bytes[25], 6, P + 'art/rgba');
  assert.equal(bytes[28], 0, P + 'art/noninterlaced');
  const chunks: Buffer[] = [];
  for (let pos = 8; pos < bytes.length;) {
    const size = bytes.readUInt32BE(pos), kind = bytes.toString('ascii', pos + 4, pos + 8);
    if (kind === 'IDAT') chunks.push(bytes.subarray(pos + 8, pos + 8 + size));
    pos += size + 12;
  }
  const scan = inflateSync(Buffer.concat(chunks)), stride = w * 4, data = Buffer.alloc(w * h * 4);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const filter = scan[y * (stride + 1)];
    assert.ok(filter <= 4, P + 'art/png-filter');
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, left = x >= 4 ? data[at - 4] : 0, up = y ? data[at - stride] : 0;
      const corner = y && x >= 4 ? data[at - stride - 4] : 0;
      const add = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)][filter];
      data[at] = (scan[y * (stride + 1) + 1 + x] + add) & 255;
    }
  }
  return { w, h, data };
}

test('R358 обод 1024×1024 уже содержит 25 золотых штырьков радиуса 380, без отдельного wh-pegs', () => {
  const image = rgba(readFileSync(new URL('./assets/wheel/rim.png', import.meta.url)));
  assert.deepEqual([image.w, image.h], [1024, 1024], P + 'art/dimensions');
  for (let k = 0; k < 25; k++) {
    const a = k * 14.4 * Math.PI / 180, x = Math.round(512 + 380 * Math.sin(a)), y = Math.round(512 - 380 * Math.cos(a));
    const at = (y * image.w + x) * 4, [red, green, blue, alpha] = image.data.subarray(at, at + 4);
    assert.ok(red > 220 && green > 130 && blue < 90 && alpha > 240, P + 'art/gold-centre-' + k);
    let outline = 0;
    for (let dy = -14; dy <= 14; dy++) for (let dx = -14; dx <= 14; dx++) {
      const radius = Math.hypot(dx, dy);
      if (radius < 11 || radius > 14) continue;
      const pixel = ((y + dy) * image.w + x + dx) * 4;
      if (image.data[pixel] < 70 && image.data[pixel + 1] < 70 && image.data[pixel + 2] < 100 && image.data[pixel + 3] > 240) outline++;
    }
    assert.ok(outline >= 30, P + 'art/peg-outline-' + k);
  }
  const scene = sourceOf('./components/WheelScene.tsx');
  assert.doesNotMatch(scene, /\bwh-pegs\b/, P + 'art/no-double-pegs');
});
