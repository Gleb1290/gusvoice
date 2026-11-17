import assert from 'node:assert/strict';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import { test } from 'node:test';
import { load, edited, sourceOf, type Edit } from './predictions.harness';

function paired(raw: string, check: (source: string) => void, makeEdit: () => Edit, prefix: string) {
  check(raw);
  counterfact(() => {
    assert.throws(() => check(edited(raw, makeEdit())), error => error instanceof assert.AssertionError
      && error.message.startsWith(prefix));
  });
  check(raw);
}

type Sounds = typeof import('./sounds');
const source = sourceOf('./sounds.ts');
const P = 'R354/spin-ticks/';
function spinEdit(): Edit {
  const scheduleStart = source.indexOf('export function scheduleWheelTicks(');
  const contextStart = source.indexOf('  const ac = audioCtx();', scheduleStart);
  const adjustStart = source.indexOf('    timesMs = timesMs.map', contextStart);
  // Одна атомарная правка всего участка: lag считается ДО audioCtx.
  const contextAndLag = source.slice(contextStart, adjustStart);
  const lagBeforeContext = '  const lagBeforeAudio = anchorMs === undefined ? 0 : performance.now() - anchorMs;\n'
    + contextAndLag.replace('const lag = performance.now() - anchorMs;', 'const lag = lagBeforeAudio;');
  return [contextAndLag, lagBeforeContext];
}

// Исполняется целый sounds.ts. Первая выдача AudioContext расходует 75 мс часов страницы:
// именно такая задержка раньше сдвигала трещотку относительно уже запущенного вращения.
function fixture(raw: string) {
  let now = 1_000;
  const starts: number[] = [];
  const clockReads: number[] = [];
  const parameter = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect<T>(other: T): T { return other; }, disconnect() {} });
  const context = {
    currentTime: 17, state: 'running', destination: {},
    createGain: () => ({ ...node(), gain: parameter() }),
    createOscillator: () => ({ ...node(), type: '', frequency: parameter(), start(at: number) { starts.push(at); }, stop() {} }),
  };
  const api = load<Sounds>(raw, { './voiceKeepAlive': { sharedAudioContext() { now += 75; return context; } } }, {
    localStorage: { getItem: () => null, setItem() {} },
    performance: { now() { clockReads.push(now); return now; } },
  });
  api.setSoundSettings({ ...api.getSoundSettings(), enabled: true, events: { ...api.getSoundSettings().events, wheelTick: true } });
  return { api, starts, clockReads };
}

// Якорь должен учитывать и время самого первого audioCtx(), не только время до вызова функции.
test('R354 якорь трещотки вычитает задержку создания AudioContext, прошедшие щелчки выбрасывает', () => paired(source, raw => {
  const f = fixture(raw);
  f.api.scheduleWheelTicks([0, 50, 74, 75, 100, 175], 1_000);
  assert.deepEqual(f.starts, [17, 17.025, 17.1], P + 'anchor/late-clicks-discarded');
  assert.deepEqual(f.clockReads, [1_075], P + 'anchor/clock-after-context');
}, spinEdit, P + 'anchor/'));

// Без якоря прежний контракт «от вызова» сохраняется, в том числе зажатие отрицательного времени.
test('R354 без якоря щелчки планируются от текущего AudioContext без чтения часов страницы', () => {
  const f = fixture(source);
  const cancel = f.api.scheduleWheelTicks([-50, 0, 125, 1_250]);
  assert.deepEqual(f.starts, [17, 17, 17.125, 18.25], P + 'legacy/times');
  assert.deepEqual(f.clockReads, [], P + 'legacy/no-page-clock');
  assert.doesNotThrow(cancel, P + 'legacy/cancel');
});

// Вернувшаяся поздно вкладка не должна проигрывать целое вращение одним звуковым залпом.
test('R354 полностью просроченное расписание молчит, ровно текущий щелчок остаётся', () => {
  const late = fixture(source);
  late.api.scheduleWheelTicks([0, 20, 74], 1_000);
  assert.deepEqual(late.starts, [], P + 'expired/silent');
  const exact = fixture(source);
  exact.api.scheduleWheelTicks([74, 75], 1_000);
  assert.deepEqual(exact.starts, [17], P + 'expired/exact-zero-kept');
});
