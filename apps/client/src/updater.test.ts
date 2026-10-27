import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { SPLASH_TIMING } from './splashFlow.js';
import { useUpdate } from './updateStore.js';

const stored = new Map<string, string>();
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => { stored.set(k, v); },
    removeItem: (k: string) => { stored.delete(k); },
  },
});

const { downloadAndInstall, endShareBeforeExit, relaunchApp, runLaunchUpdate } = await import('./updater.js');

function fakePace() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    advance: (ms: number) => { time += ms; },
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; },
  };
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

function setDesktopBridge(invoke: (command: string) => Promise<unknown>): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke } },
  });
}

const updaterSource = readFileSync(new URL('./updater.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

type WholeUpdaterOptions = {
  update?: (UpdateFixture & { available?: boolean; body?: string }) | null;
  splash?: boolean;
  splashThrows?: boolean;
  noBridge?: boolean;
  calls?: string[];
  now?: number;
  observe?: (event: string, stored: Map<string, string>) => void;
};

function loadWholeUpdater(source: string, options: WholeUpdaterOptions = {}) {
  const module = { exports: {} as Record<string, unknown> };
  const stored = new Map<string, string>();
  const state: Record<string, unknown> = {
    phase: 'idle', version: null, notes: null, downloaded: 0, total: 0, startedAt: 0, dlDone: false,
    viaSplash: false, error: null,
    set: (patch: Record<string, unknown>) => Object.assign(state, patch),
  };
  let updateChecks = 0;
  let virtualNow = options.now ?? 0;
  let pollCallback: (() => void) | null = null;
  let splashChecks = 0;
  const calls = options.calls ?? [];
  const unexpected: string[] = [];
  const deps: Record<string, unknown> = {
    './hotkeys': { isDesktop: () => true },
    './toast': { toast: () => {} },
    './updateStore': { useUpdate: { getState: () => state } },
    './splashFlow': { SPLASH_TIMING },
    './nativeShareSession': { stopNativeShareIfActive: async () => { calls.push('stop'); options.observe?.('stop', stored); } },
    '@tauri-apps/plugin-process': { relaunch: async () => { calls.push('restart'); options.observe?.('restart', stored); } },
    '@tauri-apps/plugin-updater': {
      check: async () => { updateChecks++; return options.update ?? null; },
    },
  };
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (id: string) => {
      if (!Object.hasOwn(deps, id)) unexpected.push(id);
      assert.ok(Object.hasOwn(deps, id), `R240: разрешённая зависимость полного updater: ${id}`);
      return deps[id];
    },
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    },
    window: options.noBridge ? {} : {
      __TAURI__: { core: { invoke: async (command: string) => {
        if (command !== 'gv_launch_splash') {
          unexpected.push(command);
          throw new Error(`unexpected splash command: ${command}`);
        }
        splashChecks++;
        if (options.splashThrows) throw new Error('bridge unavailable');
        return options.splash ?? false;
      } } },
    },
    Date: { now: () => virtualNow },
    console: { warn: () => {} },
    setTimeout: (callback: () => void, ms = 0) => { virtualNow += ms; callback(); return 0; },
    setInterval: (callback: () => void) => { pollCallback = callback; return 1; },
  });
  return {
    api: module.exports as Record<string, (...args: never[]) => unknown>, stored, state, calls,
    splashChecks: () => splashChecks,
    updateChecks: () => updateChecks,
    firePoll: async () => {
      assert.ok(pollCallback, 'R244 фоновый таймер захвачен');
      try {
        pollCallback();
        await new Promise<void>(resolve => setImmediate(resolve));
      } finally {
        assert.deepEqual(unexpected, [], 'R244 фоновая ошибка не скрывает неизвестный импорт/IPC');
      }
    },
    checkIO: () => assert.deepEqual(unexpected, [], 'R240 updater-io: catch приложения не скрывает неизвестный импорт'),
  };
}

function replaceOnce(source: string, original: string, replacement: string): string {
  assert.notEqual(source.indexOf(original), -1, 'мутант должен найти исходный участок целого модуля');
  assert.equal(source.indexOf(original), source.lastIndexOf(original), 'якорь мутации должен быть однозначным');
  return source.replace(original, replacement);
}

function assertAssertionShape(error: unknown, operator: string, actual: unknown, expected: unknown, label: string): void {
  assert.ok(error instanceof assert.AssertionError, `${label}: именно host AssertionError, не похожая ошибка`);
  assert.ok(error.message.startsWith(label), `${label}: точный маркер поведенческой проверки`);
  const assertion = error as Error & { operator?: string; actual?: unknown; expected?: unknown; message: string };
  assert.equal(assertion.operator, operator, `${label}: оператор`);
  if (operator === 'deepStrictEqual') {
    assert.deepStrictEqual(assertion.actual, actual, `${label}: actual`);
    assert.deepStrictEqual(assertion.expected, expected, `${label}: expected`);
  } else {
    assert.equal(assertion.actual, actual, `${label}: actual`);
    assert.equal(assertion.expected, expected, `${label}: expected`);
  }
}

function assertMutationAssertion(error: unknown, operator: string, actual: unknown, expected: unknown, label: string): true {
  assert.ok(error instanceof assert.AssertionError, `${label}: именно host AssertionError`);
  const assertion = error as Error & { code?: string; actual?: unknown; expected?: unknown; operator?: string };
  assert.equal(assertion.code, 'ERR_ASSERTION', `${label}: code`);
  assert.equal(assertion.message.split(/\r?\n/, 1)[0], label, `${label}: первая строка message`);
  assert.equal(assertion.operator, operator, `${label}: operator`);
  if (operator === 'deepStrictEqual') {
    assert.deepStrictEqual(assertion.actual, actual, `${label}: actual`);
    assert.deepStrictEqual(assertion.expected, expected, `${label}: expected`);
  } else {
    assert.equal(assertion.actual, actual, `${label}: actual`);
    assert.equal(assertion.expected, expected, `${label}: expected`);
  }
  return true;
}

type UpdateFixture = { version: string; download: () => Promise<void>; install: () => Promise<void> };
type PaceFixture = ReturnType<typeof fakePace>;
type WholeUpdater = ReturnType<typeof loadWholeUpdater>;

function runWholeDownload(harness: WholeUpdater, update: UpdateFixture, stop: () => Promise<void>, pace: PaceFixture) {
  const run = harness.api.downloadAndInstall as (u: UpdateFixture, s: () => Promise<void>, p: PaceFixture) => Promise<void>;
  return run(update, stop, pace).finally(harness.checkIO);
}

function runWholeLaunch(harness: WholeUpdater, hadSplash: () => Promise<boolean>) {
  const run = harness.api.runLaunchUpdate as (s: () => Promise<boolean>) => Promise<void>;
  return run(hadSplash).finally(harness.checkIO);
}

describe('штатная остановка показа перед выходом процесса', () => {
  it('настоящий updateStore начинает без предположения о заставке', () => {
    assert.equal(useUpdate.getState().viaSplash, false);
  });

  it('ошибка остановки не срывает продолжение операции', async () => {
    // Ловит зависшее обновление из-за уже закрытой или сломанной сессии показа.
    await assert.doesNotReject(endShareBeforeExit(async () => { throw new Error('already stopped'); }));
  });

  it('обновление делает download → stop → install, выдерживает этапы и ставит метку до install', async () => {
    // Ловит ложную crash-метку, если установщик закрывает процесс раньше штатной остановки показа.
    const calls: string[] = [];
    const pace = fakePace();
    const update = {
      version: '9.9.9',
      download: async () => { calls.push('download'); },
      install: async () => { calls.push('install'); assert.equal(stored.get('gv:just-updated'), '9.9.9'); },
    };
    stored.delete('gv:just-updated');
    await downloadAndInstall(update, async () => { calls.push('stop'); throw new Error('busy'); }, pace);
    assert.deepEqual(calls, ['download', 'stop', 'install']);
    assert.equal(stored.get('gv:just-updated'), '9.9.9');
    assert.ok(pace.sleeps[0] >= SPLASH_TIMING.downloadMinMs, 'быстрый download не должен исчезать до показа этапа');
    assert.ok(pace.sleeps[1] >= SPLASH_TIMING.installMinMs, 'установщик запускается только после видимой стадии установки');
    assert.equal(pace.sleeps.length, 2);
  });

  it('ошибка install снимает метку и пробрасывается без подмены', async () => {
    const failure = new Error('installer failed');
    const pace = fakePace();
    stored.delete('gv:just-updated');
    const update = {
      version: '9.9.10',
      download: async () => {},
      install: async () => { assert.equal(stored.get('gv:just-updated'), '9.9.10'); throw failure; },
    };
    await assert.rejects(
      downloadAndInstall(update, async () => {}, pace),
      (error: unknown) => { assert.equal(error, failure); return true; },
    );
    assert.equal(stored.has('gv:just-updated'), false);
    assert.ok(pace.sleeps[0] >= SPLASH_TIMING.downloadMinMs);
    assert.ok(pace.sleeps[1] >= SPLASH_TIMING.installMinMs);
  });

  it('медленная загрузка и длинная остановка показа уже закрывают обе минимальные паузы', async () => {
    const pace = fakePace();
    await downloadAndInstall(
      { version: '9.9.11', download: async () => { pace.advance(SPLASH_TIMING.downloadMinMs); }, install: async () => {} },
      async () => { pace.advance(SPLASH_TIMING.installMinMs); },
      pace,
    );
    assert.deepEqual(pace.sleeps, [], 'не добавлять вторую полную паузу после уже прошедшего времени');
    assert.equal(pace.now(), SPLASH_TIMING.downloadMinMs + SPLASH_TIMING.installMinMs);
  });

  it('перезапуск останавливает показ раньше relaunch даже при ошибке остановки', async () => {
    // Ловит переставленные шаги, после которых следующий показ ошибочно считается аварийным.
    const calls: string[] = [];
    await relaunchApp(
      async () => { calls.push('stop'); throw new Error('busy'); },
      async () => { calls.push('relaunch'); },
    );
    assert.deepEqual(calls, ['stop', 'relaunch']);
  });
});

describe('R240 контрфакты полного updater-модуля', () => {
  it('мутант «метка после install» падает именно на метке, проверенной внутри install', async () => {
    const markerCheck = (harness: WholeUpdater) => runWholeDownload(harness, {
      version: '8.0.0', download: async () => {},
      install: async () => assert.strictEqual(harness.stored.get('gv:just-updated') ?? null, '8.0.0', 'R240-marker-at-install'),
    }, async () => {}, fakePace());

    const original = loadWholeUpdater(updaterSource);
    assert.equal(await markerCheck(original).then(() => null, error => error), null, 'исходный целый модуль проходит');
    const mutantSource = replaceOnce(updaterSource,
      '  markJustUpdated(update.version);\n  try {\n    await update.install();',
      '  try {\n    await update.install();\n    markJustUpdated(update.version);');
    const error = await markerCheck(loadWholeUpdater(mutantSource)).then(() => null, caught => caught);
    assertAssertionShape(error, 'strictEqual', null, '8.0.0', 'R240-marker-at-install');
  });

  it('мутант «не снимать метку при сбое install» ловится точной ошибкой состояния', async () => {
    const installFailure = async (harness: WholeUpdater) => {
      const update = { version: '8.0.1', download: async () => {}, install: async () => { throw new Error('install failed'); } };
      await runWholeDownload(harness, update, async () => {}, fakePace()).catch(() => {});
      assert.strictEqual(harness.stored.has('gv:just-updated'), false, 'R240-failure-clears-marker');
    };

    const original = loadWholeUpdater(updaterSource);
    await installFailure(original);
    const mutantSource = replaceOnce(updaterSource, '    unmarkJustUpdated();\n    throw e;', '    throw e;');
    const error = await installFailure(loadWholeUpdater(mutantSource)).then(() => null, caught => caught);
    assertAssertionShape(error, 'strictEqual', true, false, 'R240-failure-clears-marker');
  });

  it('мутант «игнорировать pace» ловится пропавшими виртуальными паузами без таймеров', async () => {
    const runWithPace = async (harness: WholeUpdater) => {
      const pace = fakePace();
      await runWholeDownload(harness, { version: '8.0.2', download: async () => {}, install: async () => {} }, async () => {}, pace);
      assert.deepStrictEqual(pace.sleeps, [SPLASH_TIMING.downloadMinMs, SPLASH_TIMING.installMinMs], 'R240-pace-is-used');
    };

    await runWithPace(loadWholeUpdater(updaterSource));
    const mutantSource = replaceOnce(
      replaceOnce(updaterSource, 'await pace.sleep(dlLeft)', 'await realPace.sleep(dlLeft)'),
      'await pace.sleep(instLeft)', 'await realPace.sleep(instLeft)',
    );
    const error = await runWithPace(loadWholeUpdater(mutantSource)).then(() => null, caught => caught);
    assertAssertionShape(error, 'deepStrictEqual', [], [SPLASH_TIMING.downloadMinMs, SPLASH_TIMING.installMinMs], 'R240-pace-is-used');
  });

  it('мутант «игнорировать hadSplash» ловится лишним вызовом check', async () => {
    const noSecondCheck = async (source: string) => {
      const harness = loadWholeUpdater(source);
      await runWholeLaunch(harness, async () => true);
      assert.strictEqual(harness.updateChecks(), 0, 'R240-had-splash-skips-main-check');
    };

    await noSecondCheck(updaterSource);
    const mutantSource = replaceOnce(updaterSource,
      '  if (!splash) await runDesktopUpdateCheck();',
      '  await runDesktopUpdateCheck();');
    const error = await noSecondCheck(mutantSource).then(() => null, caught => caught);
    assertAssertionShape(error, 'strictEqual', 1, 0, 'R240-had-splash-skips-main-check');
  });
});

describe('проверка обновления при запуске с учётом заставки', () => {
  it('при hadSplash=true не запускает вторую проверку в главном окне', async () => {
    const commands: string[] = [];
    setDesktopBridge(async (command) => { commands.push(command); return null; });
    await runLaunchUpdate(async () => true);
    assert.deepEqual(commands, []);
  });

  it('при hadSplash=false или ошибке вызывает проверку главного окна', async () => {
    const commands: string[] = [];
    setDesktopBridge(async (command) => {
      commands.push(command);
      if (command !== 'plugin:updater|check') throw new Error(`unexpected IPC: ${command}`);
      throw new Error('offline');
    });
    await runLaunchUpdate(async () => false);
    assert.deepEqual(commands, ['plugin:updater|check']);
    await runLaunchUpdate(async () => { throw new Error('splash probe failed'); });
    assert.deepEqual(commands, ['plugin:updater|check', 'plugin:updater|check']);
  });
});

describe('R244 обновление, которое ставится заставкой после перезапуска', () => {
  const apiCall = async (harness: WholeUpdater, name: string, ...args: unknown[]) => {
    try {
      await (harness.api[name] as (...values: unknown[]) => unknown)(...args);
    } finally {
      harness.checkIO();
    }
  };

  function assertOffer(harness: WholeUpdater, viaSplash: boolean, label: string): void {
    assert.equal(harness.state.phase, 'available', `${label}: этап предложения`);
    assert.equal(harness.state.version, '9.9.244', `${label}: версия`);
    assert.equal(harness.state.notes, 'release notes', `${label}: примечания`);
    assert.equal(harness.state.viaSplash, viaSplash, `${label}: маршрут`);
  }

  function updateFixture(calls: string[]): UpdateFixture & { available: boolean; body: string } {
    return {
      available: true,
      version: '9.9.244',
      body: 'release notes',
      download: async () => { calls.push('download'); },
      install: async () => { calls.push('install'); },
    };
  }

  it('предложение в режиме заставки ведёт только к перезапуску, без предложения — ничего не делает', async () => {
    const calls: string[] = [];
    const withSplash = loadWholeUpdater(updaterSource, { update: updateFixture(calls), splash: true });
    await apiCall(withSplash, 'manualUpdateCheck');
    assert.equal(withSplash.state.viaSplash, true, 'R244-apply-via-splash-offer');
    await apiCall(withSplash, 'applyPendingUpdate');
    assert.deepEqual(withSplash.calls, ['stop', 'restart'], 'R244-apply-stops-share-then-restarts');
    assert.deepEqual(calls, [], 'R244-apply-does-not-download-or-install');
    assert.equal(withSplash.stored.has('gv:just-updated'), false, 'R244-apply-does-not-mark-before-splash');
    withSplash.checkIO();

    const empty = loadWholeUpdater(updaterSource, { splash: true });
    await apiCall(empty, 'applyPendingUpdate');
    assert.deepEqual(empty.calls, [], 'R244-no-pending-update-is-no-op');
    assert.equal(empty.updateChecks(), 0);
    assert.equal(empty.splashChecks(), 0, 'R244 без pending не спрашивает bridge');
    empty.checkIO();

    const injected = loadWholeUpdater(updaterSource, { update: updateFixture([]), splash: false });
    await apiCall(injected, 'manualUpdateCheck');
    const checksBeforeApply = injected.splashChecks();
    const injectedCalls: string[] = [];
    await apiCall(injected, 'applyPendingUpdate', async () => true, async () => { injectedCalls.push('restart'); });
    assert.deepEqual(injectedCalls, ['restart'], 'R244 инъецированные hadSplash/restart используются');
    assert.equal(injected.splashChecks(), checksBeforeApply, 'R244 injection не вызывает bridge повторно');
  });

  it('без заставки применяет предложение в порядке download → stop → install', async () => {
    const updateCalls: string[] = [];
    const harness = loadWholeUpdater(updaterSource, { update: updateFixture(updateCalls), splash: false, calls: updateCalls });
    harness.state.viaSplash = true;
    await apiCall(harness, 'manualUpdateCheck');
    assert.equal(harness.state.viaSplash, false, 'R244-apply-plain-offer');
    await apiCall(harness, 'applyPendingUpdate');
    assert.deepEqual(updateCalls, ['download', 'stop', 'install'], 'R244-apply-order');
    assert.equal(harness.stored.get('gv:just-updated'), '9.9.244');
    harness.checkIO();

    const throwCalls: string[] = [];
    const throws = loadWholeUpdater(updaterSource, {
      update: updateFixture(throwCalls), splashThrows: true, calls: throwCalls,
    });
    throws.state.viaSplash = true;
    await apiCall(throws, 'manualUpdateCheck');
    assertOffer(throws, false, 'R244 bridge error');
    await apiCall(throws, 'applyPendingUpdate');
    assert.deepEqual(throwCalls, ['download', 'stop', 'install'], 'R244-real-hadSplashSafe-error-falls-back-to-download-path');
    assert.equal(throws.stored.get('gv:just-updated'), '9.9.244');
    throws.checkIO();
  });

  it('manual и фоновое предложения сохраняют viaSplash; ошибка и отсутствие bridge дают false', async () => {
    for (const splash of [true, false]) {
      const manual = loadWholeUpdater(updaterSource, { update: updateFixture([]), splash });
      manual.state.viaSplash = !splash;
      await apiCall(manual, 'manualUpdateCheck');
      assertOffer(manual, splash, `R244 manual ${splash}`);
      manual.checkIO();

      const background = loadWholeUpdater(updaterSource, { update: updateFixture([]), splash });
      background.state.viaSplash = !splash;
      await apiCall(background, 'startUpdatePolling');
      await background.firePoll();
      assertOffer(background, splash, `R244 background ${splash}`);
      background.checkIO();
    }

    for (const options of [{ splashThrows: true }, { noBridge: true }]) {
      const manual = loadWholeUpdater(updaterSource, { update: updateFixture([]), ...options });
      manual.state.viaSplash = true;
      await apiCall(manual, 'manualUpdateCheck');
      assertOffer(manual, false, 'R244 manual error/no bridge');
      manual.checkIO();

      const background = loadWholeUpdater(updaterSource, { update: updateFixture([]), ...options });
      background.state.viaSplash = true;
      await apiCall(background, 'startUpdatePolling');
      await background.firePoll();
      assertOffer(background, false, 'R244 background error/no bridge');
      background.checkIO();
    }
  });

  it('whole-модуль: исходник проходит, а удалённая/перепутанная ветка и пропуск viaSplash падают', async () => {
    const branchScenario = async (source: string, splash: boolean) => {
      const updateCalls: string[] = [];
      const harness = loadWholeUpdater(source, { update: updateFixture(updateCalls), splash, calls: updateCalls });
      await apiCall(harness, 'manualUpdateCheck');
      await apiCall(harness, 'applyPendingUpdate');
      assert.deepEqual(updateCalls, splash ? ['stop', 'restart'] : ['download', 'stop', 'install'], 'R244-whole-apply-branch-and-order');
      harness.checkIO();
    };
    await branchScenario(updaterSource, true);
    await branchScenario(updaterSource, false);

    const branch = '  if (await hadSplash()) {\n    await restart();\n    return;\n  }';
    for (const replacement of [
      '  if (false) {\n    await restart();\n    return;\n  }',
      '  if (!(await hadSplash())) {\n    await restart();\n    return;\n  }',
    ]) {
      const mutant = replaceOnce(updaterSource, branch, replacement);
      await assert.rejects(branchScenario(mutant, true), (error: unknown) => {
        assertAssertionShape(error, 'deepStrictEqual', ['download', 'stop', 'install'], ['stop', 'restart'], 'R244-whole-apply-branch-and-order');
        return true;
      });
    }

    const manualOffer = async (source: string) => {
      const harness = loadWholeUpdater(source, { update: updateFixture([]), splash: true });
      await apiCall(harness, 'manualUpdateCheck');
      assertOffer(harness, true, 'R244-manual-viaSplash-mutation');
      harness.checkIO();
    };
    await manualOffer(updaterSource);
    const manualMutant = replaceOnce(updaterSource,
      "viaSplash: await hadSplashSafe() });\n  } catch (e) {\n    console.warn('[updater] manual check failed:'",
      " });\n  } catch (e) {\n    console.warn('[updater] manual check failed:'");
    await assert.rejects(manualOffer(manualMutant), (error: unknown) => {
      assertAssertionShape(error, 'strictEqual', false, true, 'R244-manual-viaSplash-mutation: маршрут');
      return true;
    });

    const backgroundOffer = async (source: string) => {
      const harness = loadWholeUpdater(source, { update: updateFixture([]), splash: true });
      await apiCall(harness, 'startUpdatePolling');
      await harness.firePoll();
      assertOffer(harness, true, 'R244-background-viaSplash-mutation');
      harness.checkIO();
    };
    await backgroundOffer(updaterSource);
    const backgroundMutant = replaceOnce(updaterSource,
      "viaSplash: await hadSplashSafe() });\n  } catch (e) {\n    console.warn('[updater] background check failed:'",
      " });\n  } catch (e) {\n    console.warn('[updater] background check failed:'");
    await assert.rejects(backgroundOffer(backgroundMutant), (error: unknown) => {
      assertAssertionShape(error, 'strictEqual', false, true, 'R244-background-viaSplash-mutation: маршрут');
      return true;
    });
  });
});

describe('R295 метки одного прохода обновления', () => {
  function callSync(harness: WholeUpdater, name: string, ...args: unknown[]): void {
    (harness.api[name] as (...values: unknown[]) => void)(...args);
    harness.checkIO();
  }

  it('markJustUpdated ставит обе версии меток, а unmark снимает обе; мутант пропускает installed', async () => {
    const verify = async (source: string) => {
      const harness = loadWholeUpdater(source);
      callSync(harness, 'markJustUpdated', '9.9.295');
      assert.deepStrictEqual(Array.from(harness.stored.entries()), [
        ['gv:just-updated', '9.9.295'],
        ['gv:installed-update', '9.9.295'],
      ], 'R295-mark-sets-both');
      callSync(harness, 'unmarkJustUpdated');
      assert.deepStrictEqual(Array.from(harness.stored.entries()), [], 'R295-unmark-clears-both');
    };

    await verify(updaterSource);
    const mutant = replaceOnce(updaterSource,
      '    localStorage.setItem(INSTALLED_KEY, version);\n', '');
    await assert.rejects(verify(mutant), (error: unknown) =>
      assertMutationAssertion(error, 'deepStrictEqual', [['gv:just-updated', '9.9.295']], [
        ['gv:just-updated', '9.9.295'], ['gv:installed-update', '9.9.295'],
      ], 'R295-mark-sets-both'));
  });

  it('peek сохраняет метки и отдаёт installed с приоритетом, take снимает только свои метки', async () => {
    const verify = async (source: string) => {
      const harness = loadWholeUpdater(source);
      harness.stored.set('gv:just-updated', 'legacy-version');
      harness.stored.set('gv:installed-update', 'installed-version');
      harness.stored.set('gv:update-on-relaunch', '{"version":"target-version","at":123}');
      const peek = harness.api.peekSplashMarkers as () => { relaunch: string | null; installed: string | null };
      const preferred = peek();
      assert.equal(preferred.relaunch, '{"version":"target-version","at":123}', 'R295-peek-relaunch');
      assert.equal(preferred.installed, 'installed-version', 'R295-peek-prioritizes-installed');
      assert.equal(harness.stored.has('gv:installed-update'), true, 'R295-peek-does-not-consume-installed');
      assert.equal(harness.stored.has('gv:update-on-relaunch'), true, 'R295-peek-does-not-consume-relaunch');
      assert.equal(harness.stored.has('gv:just-updated'), true, 'R295-peek-does-not-consume-toast-marker');

      harness.stored.delete('gv:installed-update');
      assert.equal(peek().installed, 'legacy-version', 'R295-peek-falls-back-to-toast-marker');
      harness.stored.set('gv:installed-update', 'installed-version');
      const take = harness.api.takeSplashMarkers as () => { relaunch: string | null; installed: string | null };
      const consumed = take();
      assert.equal(consumed.relaunch, '{"version":"target-version","at":123}', 'R295-take-returns-relaunch');
      assert.equal(consumed.installed, 'installed-version', 'R295-take-returns-installed');
      assert.equal(harness.stored.has('gv:update-on-relaunch'), false, 'R295-take-clears-relaunch');
      assert.equal(harness.stored.has('gv:installed-update'), false, 'R295-take-clears-installed');
      assert.equal(harness.stored.has('gv:just-updated'), true, 'R295-take-preserves-toast-marker');
      harness.checkIO();
    };

    await verify(updaterSource);
    const mutant = replaceOnce(updaterSource,
      '  clearSplashMarkers();\n  return m;',
      '  clearSplashMarkers();\n  localStorage.removeItem(UPDATED_KEY);\n  return m;');
    await assert.rejects(verify(mutant), (error: unknown) =>
      assertMutationAssertion(error, 'strictEqual', false, true, 'R295-take-preserves-toast-marker'));
  });

  it('apply с заставкой использует настоящий default restart и пишет JSON до stop; без заставки метки нет', async () => {
    const verifySplash = async (source: string) => {
      const events: Array<{ name: string; marker: string | null }> = [];
      const harness = loadWholeUpdater(source, {
        update: { available: true, version: '9.9.295', body: 'notes', download: async () => {}, install: async () => {} },
        splash: true,
        now: 123456,
        observe: (name, local) => events.push({ name, marker: local.get('gv:update-on-relaunch') ?? null }),
      });
      await (harness.api.manualUpdateCheck as () => Promise<void>)();
      await (harness.api.applyPendingUpdate as () => Promise<void>)(); // deliberately no injected defaults
      harness.checkIO();
      const marker = JSON.stringify({ version: '9.9.295', at: 123456 });
      assert.deepStrictEqual(harness.calls, ['stop', 'restart'], 'R295-default-restart-order');
      assert.deepStrictEqual(events, [
        { name: 'stop', marker },
        { name: 'restart', marker },
      ], 'R295-relaunch-marker-before-stop-and-restart');
      assert.equal(harness.stored.get('gv:update-on-relaunch'), marker, 'R295-relaunch-json');
    };

    await verifySplash(updaterSource);
    const mutant = replaceOnce(updaterSource,
      'restart: () => Promise<void> = relaunchForSplashUpdate,',
      'restart: () => Promise<void> = relaunchApp,');
    await assert.rejects(verifySplash(mutant), (error: unknown) =>
      assertMutationAssertion(error, 'deepStrictEqual', [
        { name: 'stop', marker: null }, { name: 'restart', marker: null },
      ], [
        { name: 'stop', marker: '{"version":"9.9.295","at":123456}' },
        { name: 'restart', marker: '{"version":"9.9.295","at":123456}' },
      ], 'R295-relaunch-marker-before-stop-and-restart'));

    const plain = loadWholeUpdater(updaterSource, {
      update: { available: true, version: '9.9.295', body: 'notes', download: async () => {}, install: async () => {} },
      splash: false,
    });
    await (plain.api.manualUpdateCheck as () => Promise<void>)();
    await (plain.api.applyPendingUpdate as () => Promise<void>)();
    assert.equal(plain.stored.has('gv:update-on-relaunch'), false, 'R295-no-relaunch-marker-without-splash');
    plain.checkIO();
  });

  it('runLaunchUpdate без заставки снимает её метки, с заставкой сохраняет; мутант оставляет stale-маркер', async () => {
    const verify = async (source: string) => {
      const withoutSplash = loadWholeUpdater(source);
      withoutSplash.stored.set('gv:installed-update', '9.9.295');
      withoutSplash.stored.set('gv:update-on-relaunch', '{"version":"9.9.295","at":0}');
      withoutSplash.stored.set('gv:just-updated', '9.9.295');
      await runWholeLaunch(withoutSplash, async () => false);
      assert.equal(withoutSplash.stored.has('gv:installed-update'), false, 'R295-no-splash-clears-installed');
      assert.equal(withoutSplash.stored.has('gv:update-on-relaunch'), false, 'R295-no-splash-clears-relaunch');
      assert.equal(withoutSplash.stored.get('gv:just-updated'), '9.9.295', 'R295-no-splash-preserves-toast-marker');

      const withSplash = loadWholeUpdater(source);
      withSplash.stored.set('gv:installed-update', '9.9.295');
      withSplash.stored.set('gv:update-on-relaunch', '{"version":"9.9.295","at":0}');
      await runWholeLaunch(withSplash, async () => true);
      assert.equal(withSplash.stored.get('gv:installed-update'), '9.9.295', 'R295-splash-preserves-installed');
      assert.equal(withSplash.stored.get('gv:update-on-relaunch'), '{"version":"9.9.295","at":0}', 'R295-splash-preserves-relaunch');
    };

    await verify(updaterSource);
    const mutant = replaceOnce(updaterSource,
      '  if (!splash) clearSplashMarkers();\n', '');
    await assert.rejects(verify(mutant), (error: unknown) =>
      assertMutationAssertion(error, 'strictEqual', true, false, 'R295-no-splash-clears-installed'));
  });
});
