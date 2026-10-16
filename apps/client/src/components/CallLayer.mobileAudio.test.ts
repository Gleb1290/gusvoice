import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, test } from 'node:test';
import ts from 'typescript';

type Mutation = readonly [string, string];
const source = readFileSync(new URL('./CallLayer.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
// Один проход очереди событий завершает все Promise-продолжения наших управляемых IO-границ.
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const violations: string[] = [];
afterEach(() => { assert.equal(violations.join(','), '', 'R236-IO: никакая запрещённая граница не проглочена catch'); });
const forbidden = (name: string) => () => { violations.push(name); throw new Error(`неожиданная граница ${name}`); };
const unused = (name: string) => new Proxy({}, { get: (_target, key) => forbidden(`${name}.${String(key)}`)() });
function fixture(mobile = true, muted = true, mutation?: Mutation, browser = false) {
  let raw = source;
  if (mutation) {
    assert.equal(raw.split(mutation[0]).length - 1, 1, 'R236-anchor: единственный якорь целого модуля');
    raw = raw.replace(...mutation);
  }
  // Грузим весь модуль и открываем только ссылку на настоящий hook, без извлечения/исполнения фрагментов.
  raw += '\nmodule.exports.__testUseCallMedia = useCallMedia;\n';
  const events = ['TrackSubscribed', 'TrackUnsubscribed', 'TrackUnpublished', 'TrackMuted', 'TrackUnmuted',
    'LocalTrackPublished', 'LocalTrackUnpublished', 'ParticipantConnected', 'ParticipantDisconnected'];
  const order: string[] = [], effects: Array<() => void | (() => void)> = [], errors: unknown[] = [];
  const micOpen = deferred<typeof mic>(), connect = deferred<void>(), publish = deferred<void>(), mute = deferred<void>();
  let capture: Record<string, unknown> | undefined, options: any, stopped = 0, attached = 0, removed = 0, stateIndex = 0;
  let contextAtConnect: unknown, mixAtConnect: unknown, mixAtConstruction: unknown;
  const contexts: FakeAudioContext[] = [];
  class FakeAudioContext {
    closed = 0;
    constructor(readonly settings?: { latencyHint?: string }) { contexts.push(this); order.push('context'); }
    async resume() { order.push('resume'); }
    async close() { this.closed++; order.push('context-close'); }
  }
  const mic = { stop: () => { stopped++; order.push('stop'); }, mute: () => { order.push('mute'); return mute.promise; } };
  const elements: Array<{ dataset: Record<string, string>; remove: () => void }> = [];
  const track = { kind: 'audio', attach: () => {
    attached++; order.push('attach');
    const element = { dataset: {}, remove: () => { removed++; } };
    elements.push(element); return element;
  }, detach: () => elements.splice(0) };
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const state = { join: { url: 'wss://call.invalid', token: 'fixture' }, muted, camera: false, screen: false, facing: 'user',
    setConnected: () => {}, setVideoTracks: () => {}, setScreen: () => {} };
  const useCall = Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state });
  class Room {
    remoteParticipants = new Map();
    localParticipant = {
      getTrackPublication: () => undefined,
      setMicrophoneEnabled: async (enabled: boolean) => { order.push(`enabled:${enabled}`); },
      publishTrack: (t: unknown) => { if (t !== mic) forbidden('publish чужой дорожки')(); order.push('publish'); return publish.promise; },
    };
    constructor(opts: unknown) { options = opts; mixAtConstruction = options.webAudioMix; }
    on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); return this; }
    connect() {
      order.push('connect'); mixAtConnect = options.webAudioMix; contextAtConnect = options.webAudioMix?.audioContext;
      return connect.promise;
    }
    async disconnect() { order.push('disconnect'); }
  }
  const platform = { exports: {} as typeof import('../hotkeys') };
  runInNewContext(ts.transpileModule(readFileSync(new URL('../hotkeys.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module: platform, exports: platform.exports,
    navigator: { userAgent: mobile || browser ? 'Mozilla/5.0 (Linux; Android 14) Chrome/154 Mobile' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154' },
    window: browser ? {} : { __TAURI_INTERNALS__: {} },
    require: forbidden('hotkeys import'), localStorage: unused('localStorage'),
  });
  const deps: Record<string, unknown> = {
    'react/jsx-runtime': { jsx: forbidden('render'), jsxs: forbidden('render') },
    '@gusvoice/shared': { CALL_PING_MS: 1000 },
    'livekit-client': { Room, RoomEvent: Object.fromEntries(events.map(e => [e, e])), Track: { Source: { Camera: 'camera', ScreenShare: 'screen' } },
      createLocalAudioTrack: (value: Record<string, unknown>) => {
        capture = value; order.push('capture');
        return micOpen.promise.then(t => { order.push('mic-open'); return t; });
      } },
    'react': { useEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
      useState: (initial: unknown) => { const index = stateIndex++; return [initial, (value: unknown) => { if (index === 1) order.push(`ready:${value}`); }]; },
      useRef: forbidden('useRef') },
    '../androidBack': unused('androidBack'), '../audioSettings': { getAudioSettings: () => ({ echoCancellation: false, autoGainControl: true, noiseFilter: 'rnnoise', inputDeviceId: 'chosen-mic' }) },
    '../cameraSettings': unused('cameraSettings'), '../callStore': { CALL_DEVICE: 'fixture', useCall }, '../callView': unused('callView'), '../hotkeys': platform.exports,
    '../nativeCallAudio': unused('nativeCallAudio'), '../phoneLayout': unused('phoneLayout'), '../store': unused('store'), '../streamSettings': unused('streamSettings'),
    '../toast': { toastError: (e: unknown) => errors.push(e) }, './Avatar': unused('Avatar'), './BottomSheet': unused('BottomSheet'), './Icon': unused('Icon'),
  };
  const module = { exports: {} as { __testUseCallMedia: () => void } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, console: { error: () => {} }, AudioContext: FakeAudioContext,
    document: { body: { appendChild: () => {} } },
    setTimeout: forbidden('таймер'), setInterval: forbidden('интервал'),
    require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `R236-import: ${id}`); return deps[id]; },
  });
  module.exports.__testUseCallMedia();
  assert.equal(effects.length, 4, 'настоящий hook зарегистрировал эффекты join/mute/camera/screen');
  const cleanup = effects[0]() as () => void;
  return { order, options, micOpen, connect, publish, mute, mic, track, cleanup, errors, contexts,
    contextAtConnect: () => contextAtConnect, mixAtConnect: () => mixAtConnect, mixAtConstruction: () => mixAtConstruction,
    mobile: platform.exports.isMobile,
    capture: () => capture, stopped: () => stopped, attached: () => attached, removed: () => removed,
    emit: (event: string) => { assert.equal(handlers.has(event), true); handlers.get(event)!(track); } };
}
type Fixture = ReturnType<typeof fixture>;
async function openAndConnect(f: Fixture) {
  f.micOpen.resolve(f.mic); f.connect.resolve(); await settle();
}
function killed(prefix: string, actual: unknown, expected: unknown) {
  return (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(prefix) &&
    e.operator === 'strictEqual' && Object.is(e.actual, actual) && Object.is(e.expected, expected);
}
async function captureRule(key: string, expected: boolean, mutation?: Mutation) {
  const f = fixture(true, false, mutation);
  try { assert.equal(f.capture()?.[key], expected, `R236-${key}: мобильный захват`); }
  finally { f.cleanup(); f.micOpen.resolve(f.mic); await settle(); }
}
for (const [key, expected, from, to] of [
  ['echoCancellation', true, 'echoCancellation: mobile ? true : a.echoCancellation', 'echoCancellation: mobile ? false : a.echoCancellation'],
  ['autoGainControl', false, 'autoGainControl: mobile ? false : a.autoGainControl', 'autoGainControl: mobile ? true : a.autoGainControl'],
  ['noiseSuppression', false, "noiseSuppression: mobile ? false : a.noiseFilter !== 'off'", "noiseSuppression: mobile ? true : a.noiseFilter !== 'off'"],
] as const) test(`R236 мобильный ${key} = ${expected}, контрфакт обнаруживается на границе создания дорожки`, async () => {
  await captureRule(key, expected);
  await assert.rejects(captureRule(key, expected, [from, to]), killed(`R236-${key}:`, !expected, expected));
});

test('R236 ПК сохраняет настройки захвата пользователя и сразу подключает звук собеседника', async () => {
  const f = fixture(false, false);
  try {
    assert.equal(f.mobile(), false);
    assert.equal(f.capture(), undefined, 'ПК не открывает отдельный микрофон до connect');
    const a = f.options.audioCaptureDefaults;
    assert.equal(a.echoCancellation, false); assert.equal(a.autoGainControl, true); assert.equal(a.noiseSuppression, true); assert.equal(a.deviceId, 'chosen-mic');
    f.emit('TrackSubscribed'); assert.equal(f.attached(), 1);
    f.connect.resolve(); await settle();
    assert.equal(f.order.includes('enabled:true'), true); assert.equal(f.order.includes('ready:true'), true);
  } finally { f.cleanup(); }
});
async function connectOrder(mutation?: Mutation) {
  const f = fixture(true, false, mutation);
  try {
    assert.equal(f.mobile(), true);
    assert.equal(f.order.includes('capture'), true);
    assert.equal(f.order.includes('connect'), false, 'R237-connect: подключение ждёт завершения микрофона');
    assert.equal(f.contexts.length, 0, 'контекст ещё не рождается до открытого входа');
    await openAndConnect(f);
    assert.equal(f.order.indexOf('mic-open') < f.order.indexOf('context'), true);
    assert.equal(f.order.indexOf('context') < f.order.indexOf('connect'), true);
    assert.equal(f.order.includes('publish'), true);
  }
  finally { f.cleanup(); f.micOpen.resolve(f.mic); await settle(); }
}
test('R237 мобильный connect ждёт микрофона и контекста, раннее подключение обнаруживается', async () => {
  await connectOrder();
  await assert.rejects(connectOrder(['          await micOpen;\n          if (gone) return;', '          void micOpen;\n          if (gone) return;']), killed('R237-connect:', true, false));
});
async function delayed(mutation?: Mutation) {
  const f = fixture(true, false, mutation);
  try {
    await openAndConnect(f);
    f.emit('TrackSubscribed');
    assert.equal(f.attached(), 1, 'R237-attach: после gated connect подписанный звук подключается сразу');
  } finally { f.cleanup(); }
}
test('R237 TrackSubscribed после безопасного connect подключает звук, удаление attach обнаруживается', async () => {
  await delayed();
  await assert.rejects(delayed(["if (track.kind !== 'audio') return pickRemote();\n      attachAudio(track);", "if (track.kind !== 'audio') return pickRemote();"]), killed('R237-attach:', 0, 1));
});
async function unsubscribed(mutation?: Mutation) {
  const f = fixture(true, false, mutation);
  try {
    await openAndConnect(f);
    f.emit('TrackSubscribed'); f.emit('TrackUnsubscribed');
    assert.equal(f.removed(), 1, 'R237-unsubscribed: отписка снимает созданный звуковой элемент');
  } finally { f.cleanup(); }
}
test('R237 TrackUnsubscribed снимает подключённый звук, удаление detach обнаруживается', async () => {
  await unsubscribed();
  await assert.rejects(unsubscribed(['for (const el of track.detach()) {', 'for (const el of []) {']), killed('R237-unsubscribed:', 0, 1));
});
async function keepMic(mutation?: Mutation) {
  const f = fixture(true, true, mutation);
  try { assert.equal(f.options.publishDefaults.stopMicTrackOnMute, false, 'R236-keep: mute не закрывает вход режима связи'); }
  finally { f.cleanup(); f.micOpen.resolve(f.mic); await settle(); }
}
test('R236 stopMicTrackOnMute остаётся false в настоящих опциях Room, мутант true отвергается', async () => {
  await keepMic();
  await assert.rejects(keepMic(['publishDefaults: { dtx: true, red: true, stopMicTrackOnMute: false }', 'publishDefaults: { dtx: true, red: true, stopMicTrackOnMute: true }']), killed('R236-keep:', true, false));
});
async function mutedPublish(mutation?: Mutation) {
  const f = fixture(true, true, mutation);
  try {
    await openAndConnect(f);
    assert.equal(f.order.includes('publish'), false, 'R236-mute: публикация ждёт завершения mute');
    assert.equal(f.order.includes('mute'), true);
    f.mute.resolve(); await settle();
    assert.equal(f.order.indexOf('mute') < f.order.indexOf('publish'), true);
    f.publish.resolve(); await settle();
  } finally { f.cleanup(); }
}
test('R236 muted мобильный звонок сначала дожидается mute, только затем публикует микрофон', async () => {
  await mutedPublish();
  await assert.rejects(mutedPublish(['if (useCall.getState().muted) await t.mute();\n            await r.localParticipant.publishTrack(t);', 'await r.localParticipant.publishTrack(t);\n            if (useCall.getState().muted) await t.mute();']), killed('R236-mute:', true, false));
});
async function readyAfter(mutation?: Mutation) {
  const f = fixture(true, false, mutation);
  try {
    await openAndConnect(f);
    assert.equal(f.order.includes('publish'), true);
    assert.equal(f.order.includes('ready:true'), false, 'R236-ready: ready ждёт завершения publish');
    f.publish.resolve(); await settle();
    assert.equal(f.order.includes('ready:true'), true);
  } finally { f.cleanup(); }
}
test('R236 ready не становится true до завершения публикации, ранний ready обнаруживается', async () => {
  await readyAfter();
  await assert.rejects(readyAfter(['        try {\n          const t = mic as LocalAudioTrack | null;', '        if (!gone) setReady(true);\n        try {\n          const t = mic as LocalAudioTrack | null;']), killed('R236-ready:', true, false));
});
async function readyFinally(mutation?: Mutation) {
  const f = fixture(true, false, mutation);
  try {
    await openAndConnect(f); f.publish.reject(new Error('fixture publish refused')); await settle();
    assert.equal(f.order.includes('ready:true'), true, 'R236-finally: после ошибки публикации слежение может повторить микрофон');
    assert.equal(f.errors.length, 1);
  } finally { f.cleanup(); }
}
test('R236 ready устанавливается в finally и при ошибке публикации, перенос за try не проходит', async () => {
  await readyFinally();
  await assert.rejects(readyFinally(['        } finally {\n          if (!gone) setReady(true);\n        }', '        } catch (e) { throw e; }\n        if (!gone) setReady(true);']), killed('R236-finally:', false, true));
});
async function cleanup(mutation?: Mutation) {
  const f = fixture(true, false, mutation);
  f.micOpen.resolve(f.mic); await settle();
  f.cleanup();
  assert.equal(f.stopped(), 1, 'R236-cleanup: неопубликованная открытая дорожка останавливается');
}
test('R236 cleanup останавливает открытый микрофон до подключения, удаление stop обнаруживается', async () => {
  await cleanup();
  await assert.rejects(cleanup(['      (mic as LocalAudioTrack | null)?.stop();', '      // cleanup stop удалён']), killed('R236-cleanup:', 0, 1));
});
test('R237 окончание звонка до micOpen останавливает поздний микрофон без connect и контекста', async () => {
  const f = fixture(); f.cleanup();
  f.micOpen.resolve(f.mic); f.connect.resolve(); await settle();
  assert.equal(f.stopped(), 1); assert.equal(f.attached(), 0);
  assert.equal(f.order.includes('connect'), false); assert.equal(f.contexts.length, 0);
  assert.equal(f.order.includes('publish'), false); assert.equal(f.order.includes('ready:true'), false);
});
async function captureFailure(mutation?: Mutation) {
  const f = fixture(true, false, mutation);
  try {
    f.connect.resolve(); f.micOpen.reject(new Error('fixture capture refused')); await settle();
    assert.equal(f.order.includes('connect'), true, 'R237-capture-error: даже отказ захвата не отменяет подключение');
    f.emit('TrackSubscribed');
    assert.equal(f.attached(), 1); assert.equal(f.order.includes('publish'), false);
    assert.equal(f.order.includes('ready:true'), true); assert.equal(f.errors.length, 1);
  } finally { f.cleanup(); }
}
test('R237 отказ микрофона всё равно подключает комнату и ready, ранний выход обнаруживается', async () => {
  await captureFailure();
  await assert.rejects(captureFailure(["toastError(e, 'Звонок: не удалось подключить звук');\n          },", "toastError(e, 'Звонок: не удалось подключить звук');\n            throw e;\n          },"]), killed('R237-capture-error:', false, true));
});

async function sharedContext(mutation?: Mutation) {
  const f = fixture(true, false, mutation);
  try {
    await openAndConnect(f);
    assert.equal(f.contexts.length, 1);
    assert.equal(f.mixAtConstruction() === f.options.webAudioMix && f.mixAtConnect() === f.mixAtConstruction(), true,
      'Room сохраняет тот же объект webAudioMix от конструктора до connect');
    assert.equal(f.contextAtConnect() === f.contexts[0], true, 'R237-context: connect уже видит тот самый внешний контекст');
    assert.equal(f.options.webAudioMix.audioContext === f.contexts[0], true);
  } finally { f.cleanup(); }
}
test('R237 webAudioMix получает тот же контекст до connect, поздняя подстановка обнаруживается', async () => {
  await sharedContext();
  await assert.rejects(sharedContext([
    '          mix.audioContext = callPlaybackContext();\n        }\n        await r.connect(join.url, join.token);',
    '        }\n        await r.connect(join.url, join.token);\n        if (mobile) mix.audioContext = callPlaybackContext();',
  ]), killed('R237-context:', false, true));
});
async function latency(mutation?: Mutation) {
  const f = fixture(true, false, mutation);
  try {
    await openAndConnect(f);
    assert.equal(f.contexts.length, 1);
    assert.equal(f.contexts[0].settings?.latencyHint, 'playback', 'R237-latency: звуковой контекст не использует общий MMAP-класс');
  } finally { f.cleanup(); }
}
for (const [name, replacement, actual] of [
  ['interactive', "new AudioContext({ latencyHint: 'interactive' })", 'interactive'],
  ['без latencyHint', 'new AudioContext()', undefined],
] as const) test(`R237 контекст playback: контрфакт ${name} обнаруживается в опциях конструктора`, async () => {
  await latency();
  await assert.rejects(latency(["new AudioContext({ latencyHint: 'playback' })", replacement]), killed('R237-latency:', actual, 'playback'));
});
async function closeContext(mutation?: Mutation) {
  const f = fixture(true, false, mutation);
  try {
    await openAndConnect(f);
    assert.equal(f.contexts[0].closed, 0);
  } finally { f.cleanup(); }
  assert.equal(f.contexts[0].closed, 1, 'R237-close: cleanup закрывает внешний контекст, которым не владеет SDK');
}
test('R237 завершение закрывает свой playback-контекст, отсутствие close обнаруживается', async () => {
  await closeContext();
  await assert.rejects(closeContext(['      void mix.audioContext?.close().catch(() => {});', '      // close удалён']), killed('R237-close:', 0, 1));
});
async function nonMobile(browser: boolean, mutation?: Mutation) {
  const f = fixture(false, false, mutation, browser);
  try {
    assert.equal(f.mobile(), false, 'реальный hotkeys отличает браузер/Windows Tauri от мобильного приложения');
    assert.equal(f.order.includes('connect'), true, 'подключение ПК/веб не ждёт открытия отдельного микрофона');
    assert.equal(Object.hasOwn(f.options, 'webAudioMix'), false, 'R237-platform: у ПК и веб нет особого звукового микшера');
    assert.equal(f.capture(), undefined); assert.equal(f.contexts.length, 0);
    f.connect.resolve(); await settle();
    assert.equal(f.order.includes('enabled:true'), true); assert.equal(f.order.includes('ready:true'), true);
    assert.equal(f.contexts.length, 0);
  } finally { f.cleanup(); }
  assert.equal(f.order.includes('context-close'), false);
}
for (const [browser, name] of [[false, 'Windows Tauri'], [true, 'Android браузер без Tauri']] as const)
  test(`R237 ${name}: connect сразу, без playback и webAudioMix; смешение платформ обнаруживается`, async () => {
    await nonMobile(browser);
    await assert.rejects(nonMobile(browser, [
      '...(mobile ? { webAudioMix: mix as { audioContext: AudioContext } } : {}),',
      '...(true ? { webAudioMix: mix as { audioContext: AudioContext } } : {}),',
    ]), killed('R237-platform:', true, false));
  });
