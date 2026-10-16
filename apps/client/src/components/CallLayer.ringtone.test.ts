import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Mutation = readonly [string, string];
type Environment = 'android-app' | 'desktop-app' | 'android-web';
const source = readFileSync(new URL('./CallLayer.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const hotkeys = readFileSync(new URL('../hotkeys.ts', import.meta.url), 'utf8');
const violations: string[] = [];
afterEach(() => {
  const seen = violations.splice(0);
  assert.deepEqual(seen, [], 'R237-ring-IO: catch приложения не скрывает запрещённую границу');
});
function forbidden(label: string): never {
  violations.push(label);
  throw new Error(`непредметная граница ${label}`);
}
const dormant = (label: string) => new Proxy({}, { get: (_target, key) => forbidden(`${label}.${String(key)}`) });
const compile = (raw: string) => ts.transpileModule(raw, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;

function fixture(env: Environment = 'android-app', mutation?: Mutation,
  failures: { construct?: boolean; resume?: boolean; close?: boolean } = {}) {
  let raw = source;
  if (mutation) {
    assert.equal(raw.split(mutation[0]).length - 1, 1, 'R237-ring-anchor: единственный якорь целого модуля');
    raw = raw.replace(...mutation);
  }
  const navigator = { userAgent: env === 'desktop-app' ? 'Fixture Windows' : 'Fixture Android' };
  const window = env === 'android-web' ? {} : { __TAURI_INTERNALS__: {} };
  const hotModule = { exports: {} as { isMobile(): boolean } };
  // Определение среды не копируется в тест: выполняется весь настоящий hotkeys.ts.
  runInNewContext(compile(hotkeys), { module: hotModule, exports: hotModule.exports, window, navigator,
    require: (id: string) => forbidden(`hotkeys import ${id}`) });
  assert.equal(hotModule.exports.isMobile(), env === 'android-app', 'настоящий isMobile различает оболочку и браузер');

  let attempts = 0, nextTimer = 0;
  const timers = new Map<number, { callback: () => void; ms: number }>();
  const cleared: number[] = [];
  const contexts: FakeContext[] = [];
  class FakeContext {
    readonly args: unknown[];
    readonly currentTime = 10;
    readonly destination = {};
    readonly notes: Array<{ frequency: number; start: number; end?: number }> = [];
    resumes = 0;
    closes = 0;
    constructor(...args: unknown[]) {
      attempts++;
      if (failures.construct) throw new Error('fixture: WebAudio недоступен');
      this.args = args;
      contexts.push(this);
    }
    resume() {
      this.resumes++;
      return failures.resume ? Promise.reject(new Error('fixture: resume refused')) : Promise.resolve();
    }
    close() {
      this.closes++;
      return failures.close ? Promise.reject(new Error('fixture: close refused')) : Promise.resolve();
    }
    createGain() {
      return { connect: (to: unknown) => { if (to !== this.destination) forbidden('gain destination'); },
        gain: { setValueAtTime() {}, linearRampToValueAtTime() {} } };
    }
    createOscillator() {
      const frequency = { value: 0 };
      let note: { frequency: number; start: number; end?: number } | undefined;
      return { type: '', frequency, connect() {},
        start: (time: number) => { note = { frequency: frequency.value, start: time }; this.notes.push(note); },
        stop: (time: number) => { assert.ok(note, 'нота началась до остановки'); note.end = time; } };
    }
  }
  const deps: Record<string, unknown> = { '../hotkeys': hotModule.exports };
  for (const id of ['react/jsx-runtime', '@gusvoice/shared', 'livekit-client', 'react', '../androidBack',
    '../audioSettings', '../cameraSettings', '../callStore', '../callView', '../nativeCallAudio', '../phoneLayout',
    '../store', '../streamSettings', '../toast', './Avatar', './BottomSheet', './Icon']) deps[id] = dormant(id);
  const module = { exports: {} as { __testRingPattern: (kind: 'incoming' | 'outgoing') => () => void } };
  // Открывается ссылка после ЦЕЛОГО модуля, а не вырезанный регуляркой фрагмент функции.
  runInNewContext(compile(raw + '\nmodule.exports.__testRingPattern = ringPattern;\n'), {
    module, exports: module.exports, window, navigator, AudioContext: FakeContext,
    setInterval(callback: () => void, ms: number) { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
    clearInterval(id: number) { assert.equal(timers.delete(id), true, 'остановка снимает свой живой интервал'); cleared.push(id); },
    setTimeout: () => forbidden('timeout'), fetch: () => forbidden('fetch'),
    require(id: string) { if (!Object.hasOwn(deps, id)) return forbidden(`import ${id}`); return deps[id]; },
  });
  return { ring: module.exports.__testRingPattern, contexts, timers, cleared, attempts: () => attempts };
}

it('R237 рингтоны Android получают отдельные контексты без playback, повторяют ноты и закрываются вместе со своими интервалами', () => {
  const f = fixture();
  const stopIncoming = f.ring('incoming'), stopOutgoing = f.ring('outgoing');
  try {
    assert.equal(f.contexts.length, 2, 'два звонка не делят поток рингтона');
    assert.notEqual(f.contexts[0], f.contexts[1]);
    assert.deepEqual(f.contexts.map(c => c.args), [[], []], 'класс задержки по умолчанию, не playback разговора');
    assert.deepEqual(f.contexts.map(c => c.resumes), [1, 1]);
    assert.deepEqual(f.contexts[0]!.notes.map(n => n.frequency), [784, 659, 784, 659]);
    assert.deepEqual(f.contexts[1]!.notes.map(n => n.frequency), [425]);
    assert.deepEqual([...f.timers.values()].map(t => t.ms), [2000, 4000]);
    [...f.timers.values()][0]!.callback();
    assert.equal(f.contexts[0]!.notes.length, 8, 'таймер вызывает настоящий beep повторно');
  } finally { stopIncoming(); stopOutgoing(); }
  assert.deepEqual(f.contexts.map(c => c.closes), [1, 1]);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.cleared, [1, 2]);
});

for (const env of ['desktop-app', 'android-web'] as const) {
  it(`R237 ${env === 'desktop-app' ? 'ПК в Tauri' : 'браузер Android без Tauri'} переиспользует общий рингтон, но не закрывает его при остановке`, () => {
    const f = fixture(env);
    const first = f.ring('outgoing'); first();
    const second = f.ring('incoming');
    try {
      assert.equal(f.contexts.length, 1, 'другой звонок использует общий ringCtx');
      assert.equal(f.contexts[0]!.resumes, 2);
      assert.equal(f.contexts[0]!.args.length, 0);
    } finally { second(); }
    assert.equal(f.contexts[0]!.closes, 0, 'общий контекст не закрывается между звонками');
    assert.equal(f.timers.size, 0);
  });
}

it('R237 отказ WebAudio оставляет безопасную остановку без таймеров и без попытки играть', () => {
  const f = fixture('android-app', undefined, { construct: true });
  const stop = f.ring('incoming');
  assert.doesNotThrow(stop);
  assert.equal(f.attempts(), 1);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.cleared.length, 0);
});

it('R237 отказ resume/close рингтона не даёт необработанного rejection и не удерживает таймер', async () => {
  const f = fixture('android-app', undefined, { resume: true, close: true });
  f.ring('outgoing')();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.contexts[0]!.resumes, 1);
  assert.equal(f.contexts[0]!.closes, 1);
  assert.equal(f.timers.size, 0);
});

function killed(prefix: string, actual: unknown, expected: unknown) {
  return (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && Object.is(e.actual, actual) && Object.is(e.expected, expected);
}
const contextAnchor = 'ac = own ? new AudioContext() : (ringCtx ??= new AudioContext());';
function isolated(mutation?: Mutation) {
  const f = fixture('android-app', mutation);
  const stopFirst = f.ring('incoming'); stopFirst();
  const stopSecond = f.ring('outgoing');
  try { assert.equal(f.contexts.length, 2, 'R237-ring-isolated: следующий звонок получает новый контекст'); }
  finally { stopSecond(); }
}
it('R237 контрфакт общего ringCtx на телефоне ловится вторым звонком после остановки первого', () => {
  isolated();
  assert.throws(() => isolated([contextAnchor, 'ac = (ringCtx ??= new AudioContext());']),
    killed('R237-ring-isolated:', 1, 2));
});

function defaultLatency(mutation?: Mutation) {
  const f = fixture('android-app', mutation);
  const stop = f.ring('incoming');
  try {
    const options = f.contexts[0]!.args[0] as { latencyHint?: string } | undefined;
    assert.equal(options?.latencyHint, undefined, 'R237-ring-latency: рингтон не занимает playback-класс разговора');
  } finally { stop(); }
}
it('R237 контрфакт playback у рингтона ловится аргументом настоящего создания AudioContext', () => {
  defaultLatency();
  assert.throws(() => defaultLatency([contextAnchor,
    "ac = own ? new AudioContext({ latencyHint: 'playback' }) : (ringCtx ??= new AudioContext());"]),
  killed('R237-ring-latency:', 'playback', undefined));
});

function closed(mutation?: Mutation) {
  const f = fixture('android-app', mutation);
  f.ring('outgoing')();
  assert.equal(f.contexts[0]!.closes, 1, 'R237-ring-close: остановка закрывает собственный поток рингтона');
  assert.equal(f.timers.size, 0);
}
it('R237 контрфакт пропущенного close рингтона ловится на границе контекста, а не только снятия интервала', () => {
  closed();
  assert.throws(() => closed(['    if (own) void ac.close().catch(() => {});', '    // close рингтона удалён']),
    killed('R237-ring-close:', 0, 1));
});
