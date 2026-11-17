import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, load, pairedAsync, sourceOf } from './predictions.harness';

type Sounds = typeof import('./sounds');
const source = sourceOf('./sounds.ts');
const P = 'R358/output-ticks/';
type Stamp = { contextTime: number; performanceTime: number };

// Настоящий sounds.ts, в том числе register/warm/cache: подменена только IO-граница WebAudio и fetch записи.
async function fixture(raw: string, timestamp?: () => Stamp | null, duration = 0.086) {
  const starts: [number, number][] = [], stopped: number[] = [];
  let timestampReads = 0, clockReads = 0, fetches = 0;
  const parameter = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect<T>(other: T): T { return other; }, disconnect() {} });
  const context = {
    currentTime: 17, state: 'running', destination: {},
    ...(timestamp ? { getOutputTimestamp() { timestampReads++; return timestamp(); } } : {}),
    createGain: () => ({ ...node(), gain: parameter() }),
    decodeAudioData: async () => ({ duration }),
    createBufferSource: () => ({ ...node(), buffer: null, playbackRate: { value: 1 },
      start(at: number, offset: number) { starts.push([at, offset]); }, stop() { stopped.push(1); } }),
  };
  const api = load<Sounds>(raw, { './voiceKeepAlive': { sharedAudioContext: () => context } }, {
    localStorage: { getItem: () => null, setItem() {} },
    performance: { now() { clockReads++; return 1000; } },
    fetch: async () => { fetches++; return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; },
  });
  api.setSoundSettings({ ...api.getSoundSettings(), enabled: true, events: { ...api.getSoundSettings().events, wheelTick: true } });
  api.registerBuiltinSound('wheelTick', 'fixture://wheel-click');
  api.warmBuiltinSound('wheelTick');
  await flush();
  assert.equal(fetches, 1, 'R358 setup: запись попала в настоящий буферный cache');
  return { api, starts, stopped, timestampReads: () => timestampReads, clockReads: () => clockReads };
}
const close = (a: number, b: number, message: string) => assert.ok(Math.abs(a - b) < 1e-9, message);

test('R358 timestamp компенсирует 100 мс вывода; запись начинается с offset 0,02 и отменяется', async () => pairedAsync(source, async raw => {
  const f = await fixture(raw, () => ({ contextTime: 16.9, performanceTime: 1000 }));
  const cancel = f.api.scheduleWheelTicks([50, 250, 500], 1000);
  assert.equal(f.starts.length, 3, P + 'shift/not-silenced');
  for (const [i, at] of [17, 17.15, 17.4].entries()) {
    close(f.starts[i][0], at, P + 'shift/output-compensated');
    close(f.starts[i][1], 0.02, P + 'shift/skip-recording-leading-rustle');
  }
  assert.equal(f.timestampReads(), 1, P + 'shift/one-output-clock');
  assert.equal(f.clockReads(), 1, P + 'shift/one-page-clock');
  cancel(); cancel();
  assert.equal(f.stopped.length, 3, P + 'shift/cancel-once-per-source');
}, [['const shiftMs = outputShiftS(ac, anchorMs + lag) * 1000;', 'const shiftMs = 0;']], P + 'shift/'));

for (const [contextTime, expected] of [[16.7, 17.2], [16.2, 17.2], [17.1, 17.5]] as const) {
  test(`R358 timestamp ${contextTime}: компенсация ограничена 0,3 с и никогда не задерживает щелчок`, async () => {
    const f = await fixture(source, () => ({ contextTime, performanceTime: 1000 }));
    f.api.scheduleWheelTicks([500], 1000);
    assert.equal(f.starts.length, 1, P + 'cap/audible');
    close(f.starts[0][0], expected, P + 'cap/bounded-negative-only');
  });
}

for (const mode of ['missing', 'throws', 'zero-time', 'invalid-context', 'nonfinite-shift'] as const) {
  test(`R358 недоступный timestamp (${mode}) сохраняет прежнее расписание`, async () => {
    const stamp = mode === 'missing' ? undefined : () => {
      if (mode === 'throws') throw new Error('fixture unavailable');
      return mode === 'zero-time' ? { contextTime: 16.8, performanceTime: 0 }
        : mode === 'invalid-context' ? { contextTime: NaN, performanceTime: 1000 }
          : { contextTime: 16.8, performanceTime: Infinity };
    };
    const f = await fixture(source, stamp);
    f.api.scheduleWheelTicks([0, 250], 1000);
    assert.deepEqual(f.starts, [[17, 0.02], [17.25, 0.02]], P + 'fallback/legacy-timing');
  });
}

test('R358 без якоря timestamp не опрашивается и прежнее расписание не сдвигается', async () => {
  const f = await fixture(source, () => ({ contextTime: 16.8, performanceTime: 1000 }));
  f.api.scheduleWheelTicks([-50, 0, 250]);
  assert.deepEqual(f.starts, [[17, 0.02], [17, 0.02], [17.25, 0.02]], P + 'unanchored/legacy');
  assert.equal(f.timestampReads(), 0, P + 'unanchored/no-output-clock');
  assert.equal(f.clockReads(), 0, P + 'unanchored/no-page-clock');
});

test('R358 timestamp пересчитывается от performanceTime, уже просроченные щелчки не воскресают', async () => {
  const f = await fixture(source, () => ({ contextTime: 16.8, performanceTime: 900 }));
  f.api.scheduleWheelTicks([0, 50, 150, 350], 900);
  assert.equal(f.starts.length, 2, P + 'elapsed/late-discarded');
  close(f.starts[0][0], 17, P + 'elapsed/compensated-now');
  close(f.starts[1][0], 17.15, P + 'elapsed/timestamp-extrapolated');
});

test('R358 у очень короткой записи offset не выходит за половину буфера', async () => {
  const f = await fixture(source, undefined, 0.02);
  f.api.scheduleWheelTicks([0]);
  assert.deepEqual(f.starts, [[17, 0.01]], P + 'short/offset-safe');
});
