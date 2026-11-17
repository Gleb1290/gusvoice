import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';

const ts: typeof import('typescript') = createRequire(import.meta.url)('typescript');
type ServiceApi = typeof import('./nativeVoiceService');

function fixture(options: { hidden?: boolean; android?: boolean; oldApk?: boolean; volumeThrows?: boolean } = {}) {
  const calls: Array<string | boolean> = [];
  const listeners = new Set<() => void>();
  let addCount = 0;
  const document = {
    visibilityState: options.hidden ? 'hidden' : 'visible',
    addEventListener(type: string, listener: () => void) {
      assert.equal(type, 'visibilitychange');
      addCount++;
      listeners.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      assert.equal(type, 'visibilitychange');
      listeners.delete(listener);
    },
  };
  const native: { startVoiceService(): void; stopVoiceService(): void; voiceChannelVolumeSet?: (active: boolean) => void } = {
    startVoiceService() { calls.push('start'); },
    stopVoiceService() { calls.push('stop'); },
  };
  if (!options.oldApk) native.voiceChannelVolumeSet = (active) => {
    calls.push(active);
    if (options.volumeThrows) throw new Error('bridge failure');
  };
  const module = { exports: {} as Record<string, unknown> };
  const source = readFileSync(new URL('./nativeVoiceService.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, {
    module, exports: module.exports,
    require(id: string) {
      assert.equal(id, './hotkeys');
      return { isAndroid: () => options.android !== false };
    },
    window: { GusVoiceNative: native }, document,
    console: { warn() {}, info() {} },
  });
  return {
    api: module.exports as unknown as ServiceApi, calls,
    get listenerCount() { return listeners.size; },
    get addCount() { return addCount; },
    setVisibility(value: 'visible' | 'hidden') {
      document.visibilityState = value;
      for (const listener of [...listeners]) listener();
    },
  };
}

it('видимый вход включает громкость канала и запускает микрофонную службу', () => {
  const f = fixture();
  f.api.startNativeVoiceService();
  assert.deepEqual(f.calls, [true, 'start']);
  assert.equal(f.listenerCount, 1);
});

it('скрытый вход сразу включает громкость, а микрофон запускает при возвращении', () => {
  const f = fixture({ hidden: true });
  f.api.startNativeVoiceService();
  assert.deepEqual(f.calls, [true]);
  f.setVisibility('visible');
  assert.deepEqual(f.calls, [true, true, 'start']);
});

it('выход выключает громкость и снимает обработчик, возврат не возобновляет голос', () => {
  const f = fixture();
  f.api.startNativeVoiceService();
  f.api.stopNativeVoiceService();
  assert.deepEqual(f.calls, [true, 'start', false, 'stop']);
  assert.equal(f.listenerCount, 0);
  f.setVisibility('hidden');
  f.setVisibility('visible');
  assert.deepEqual(f.calls, [true, 'start', false, 'stop']);
});

it('старый APK без метода громкости сохраняет работу службы', () => {
  const f = fixture({ oldApk: true, hidden: true });
  assert.doesNotThrow(() => f.api.startNativeVoiceService());
  assert.deepEqual(f.calls, []);
  f.setVisibility('visible');
  assert.deepEqual(f.calls, ['start']);
  assert.doesNotThrow(() => f.api.stopNativeVoiceService());
  assert.deepEqual(f.calls, ['start', 'stop']);
  assert.equal(f.listenerCount, 0);
});

it('вне Android мост и подписка не используются', () => {
  const f = fixture({ android: false });
  f.api.startNativeVoiceService();
  f.setVisibility('hidden');
  f.setVisibility('visible');
  f.api.stopNativeVoiceService();
  assert.deepEqual(f.calls, []);
  assert.equal(f.listenerCount, 0);
  assert.equal(f.addCount, 0);
});

it('ошибки громкости не мешают старту, возврату и остановке службы', () => {
  const f = fixture({ volumeThrows: true });
  assert.doesNotThrow(() => f.api.startNativeVoiceService());
  f.setVisibility('hidden');
  assert.doesNotThrow(() => f.setVisibility('visible'));
  assert.doesNotThrow(() => f.api.stopNativeVoiceService());
  assert.deepEqual(f.calls, [true, 'start', true, 'start', false, 'stop']);
  assert.equal(f.listenerCount, 0);
});

it('повторный вход и возвращения переутверждают громкость без новых подписок', () => {
  const f = fixture();
  f.api.startNativeVoiceService();
  f.api.startNativeVoiceService();
  f.setVisibility('hidden');
  f.setVisibility('visible');
  f.setVisibility('hidden');
  f.setVisibility('visible');
  assert.equal(f.addCount, 1);
  assert.equal(f.listenerCount, 1);
  assert.deepEqual(f.calls, [true, 'start', true, 'start', true, 'start', true, 'start']);
});
