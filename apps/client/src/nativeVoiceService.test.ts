import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type ServiceApi = typeof import('./nativeVoiceService');

function fixture(options: { hidden?: boolean; android?: boolean; tauri?: boolean; sourceMutation?: boolean; throwingBridge?: boolean } = {}) {
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  let addCount = 0;
  const doc = {
    visibilityState: options.hidden ? 'hidden' : 'visible',
    addEventListener(type: string, listener: () => void) {
      assert.equal(type, 'visibilitychange', 'only the visibility listener is expected');
      addCount++;
      listeners.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      assert.equal(type, 'visibilitychange', 'only the visibility listener is expected');
      listeners.delete(listener);
    },
  };
  const nativeWindow: Record<string, unknown> = {
    GusVoiceNative: {
      startVoiceService() { calls.push('start'); if (options.throwingBridge) throw new Error('Java exception was raised during method invocation'); },
      stopVoiceService() { calls.push('stop'); if (options.throwingBridge) throw new Error('Java exception was raised during method invocation'); },
    },
  };
  if (options.tauri !== false) nativeWindow.__TAURI_INTERNALS__ = {};
  const navigator = { userAgent: options.android === false ? 'Mozilla/5.0 (Windows NT 10.0)' : 'Mozilla/5.0 (Linux; Android 15)' };
  const compile = (path: string, mutate = false) => {
    let source = readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    if (mutate) {
      const original = 'if (!wanted || pageHidden()) return;';
      assert.ok(source.includes(original), 'the hidden-page guard must be present before mutation');
      source = source.replace(original, 'if (!wanted) return;');
    }
    return ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
  };
  const hotkeysModule = { exports: {} as Record<string, unknown> };
  runInNewContext(compile('./hotkeys.ts'), {
    module: hotkeysModule,
    exports: hotkeysModule.exports,
    window: nativeWindow,
    navigator,
  });
  const serviceModule = { exports: {} as Record<string, unknown> };
  const quietConsole = { warn() {}, info() {} };
  runInNewContext(compile('./nativeVoiceService.ts', options.sourceMutation), {
    module: serviceModule,
    exports: serviceModule.exports,
    require(id: string) {
      assert.equal(id, './hotkeys', 'nativeVoiceService must use its actual hotkeys dependency');
      return hotkeysModule.exports;
    },
    window: nativeWindow,
    navigator,
    document: doc,
    console: quietConsole,
  });
  return {
    api: serviceModule.exports as unknown as ServiceApi,
    calls,
    get listenerCount() { return listeners.size; },
    get addCount() { return addCount; },
    setVisibility(value: 'visible' | 'hidden') {
      doc.visibilityState = value;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('nativeVoiceService: Android foreground service при видимости страницы', () => {
  it('на видимой странице сразу запускает нативную службу один раз', () => {
    // Голос уже подключён на экране: ОС должна получить запрос на foreground-службу сразу.
    const f = fixture();
    f.api.startNativeVoiceService();
    assert.deepEqual(f.calls, ['start'], 'visible start must reach the native bridge once');
    assert.equal(f.listenerCount, 1, 'active voice must subscribe to visibility changes');
  });

  it('скрытый старт ждёт возврата на экран; guard мутант отклоняется тем же контрактом', () => {
    // Android запрещает старт microphone foreground service из скрытого WebView; это главный регрессионный сценарий.
    const f = fixture({ hidden: true });
    f.api.startNativeVoiceService();
    assert.deepEqual(f.calls, [], 'hidden start must not reach the native bridge');
    f.setVisibility('visible');
    assert.deepEqual(f.calls, ['start'], 'becoming visible must start the pending service once');

    const mutant = fixture({ hidden: true, sourceMutation: true });
    mutant.api.startNativeVoiceService();
    assert.deepEqual(mutant.calls, ['start'], 'the in-memory guard mutant incorrectly starts while hidden');
    assert.throws(
      () => assert.deepEqual(mutant.calls, [], 'hidden start must not reach the native bridge'),
      (error: unknown) => error instanceof assert.AssertionError,
      'the hidden-start contract must reject the guard mutant',
    );
  });

  it('каждый возврат на экран повторяет запрос, а скрытие само его не вызывает', () => {
    // После отказа Android служба может подняться только при следующем foreground; повторный resume важен.
    const f = fixture();
    f.api.startNativeVoiceService();
    f.setVisibility('hidden');
    f.setVisibility('visible');
    f.setVisibility('hidden');
    f.setVisibility('visible');
    assert.deepEqual(f.calls, ['start', 'start', 'start'], 'each visible transition while active must retry exactly once');
  });

  it('stop останавливает службу, снимает подписку и не запускает её при дальнейшем возврате', () => {
    // Ушедший из голосового канала клиент не должен воскресить foreground-уведомление при resume.
    const f = fixture();
    f.api.startNativeVoiceService();
    f.api.stopNativeVoiceService();
    assert.deepEqual(f.calls, ['start', 'stop'], 'stop must reach native bridge after the active start');
    assert.equal(f.listenerCount, 0, 'stop must remove the visibility listener');
    f.setVisibility('hidden');
    f.setVisibility('visible');
    assert.deepEqual(f.calls, ['start', 'stop'], 'visibility changes after stop must not restart service');
  });

  it('повторный start не устанавливает несколько обработчиков видимости', () => {
    // Повторное событие подключения не должно умножать вызовы на один resume.
    const f = fixture();
    f.api.startNativeVoiceService();
    f.api.startNativeVoiceService();
    assert.equal(f.listenerCount, 1, 'double start must retain one listener');
    assert.equal(f.addCount, 1, 'double start must register the listener only once');
    f.setVisibility('hidden');
    f.setVisibility('visible');
    assert.deepEqual(f.calls, ['start', 'start', 'start'], 'resume must invoke one request per registered listener');
  });

  it('без Android Tauri-моста или с не-Android UA не трогает мост и не подписывается', () => {
    // Телефонный браузер без Tauri и desktop WebView не должны получать Android-вызовы.
    for (const options of [{ tauri: false }, { android: false }]) {
      const f = fixture(options);
      f.api.startNativeVoiceService();
      f.api.stopNativeVoiceService();
      f.setVisibility('hidden');
      f.setVisibility('visible');
      assert.deepEqual(f.calls, [], 'non-Android runtime must not call native bridge');
      assert.equal(f.listenerCount, 0, 'non-Android runtime must not subscribe');
    }
  });

  it('ошибки Java-моста не пробрасываются из start, visibility handler и stop', () => {
    // @JavascriptInterface может синхронно бросить Java exception; это best-effort интеграция, звонок должен жить.
    const throwing = fixture({ throwingBridge: true });
    assert.doesNotThrow(() => throwing.api.startNativeVoiceService(), 'visible start must swallow bridge exception');
    assert.deepEqual(throwing.calls, ['start'], 'visible start attempts bridge once');
    throwing.setVisibility('hidden');
    assert.doesNotThrow(() => throwing.setVisibility('visible'), 'visibility retry must swallow bridge exception');
    assert.deepEqual(throwing.calls, ['start', 'start'], 'visible transition attempts bridge again');
    assert.doesNotThrow(() => throwing.api.stopNativeVoiceService(), 'stop must swallow bridge exception');
    assert.deepEqual(throwing.calls, ['start', 'start', 'stop'], 'stop reaches bridge even when it throws');
  });
});
