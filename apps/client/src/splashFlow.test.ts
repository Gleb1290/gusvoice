import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runSplashFlow, shownDownloadFraction, SPLASH_TIMING, type SplashDeps, type SplashUpdate, type SplashView } from './splashFlow.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(HERE, 'splashFlow.ts'), 'utf8').replace(/\r\n/g, '\n');

class FakeClock {
  time = 0;
  private sleepers: Array<{ due: number; resolve: () => void }> = [];

  now = () => this.time;

  sleep = (ms: number) => new Promise<void>((resolveSleep) => {
    this.sleepers.push({ due: this.time + ms, resolve: resolveSleep });
  });

  async advanceNext(): Promise<void> {
    assert.ok(this.sleepers.length > 0, 'ход заставки должен ждать на управляемом таймере');
    const due = Math.min(...this.sleepers.map((s) => s.due));
    this.time = due;
    const ready = this.sleepers.filter((s) => s.due <= this.time);
    this.sleepers = this.sleepers.filter((s) => s.due > this.time);
    ready.forEach((s) => s.resolve());
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function driveUntil(clock: FakeClock, isDone: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    await flushMicrotasks();
    if (isDone()) return;
    await clock.advanceNext();
    await flushMicrotasks();
    if (isDone()) return;
  }
  assert.ok(isDone(), 'сценарий должен завершиться в пределах 1000 таймеров');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const fastTiming = { checkMinMs: 7, checkTimeoutMs: 40, startMinMs: 4, downloadMinMs: 12, installMinMs: 8, stallMs: 15, tickMs: 2 };

function basicDeps(clock: FakeClock, check: SplashDeps['check'], overrides: Partial<SplashDeps> = {}) {
  const views: Array<{ at: number; view: SplashView }> = [];
  const calls: Array<{ at: number; name: string; version?: string }> = [];
  let doneCount = 0;
  const deps: SplashDeps = {
    check,
    now: clock.now,
    sleep: clock.sleep,
    show: (view) => views.push({ at: clock.now(), view }),
    ping: () => calls.push({ at: clock.now(), name: 'ping' }),
    beforeInstall: async (version) => { calls.push({ at: clock.now(), name: 'beforeInstall', version }); },
    installFailed: () => calls.push({ at: clock.now(), name: 'installFailed' }),
    done: () => { doneCount++; calls.push({ at: clock.now(), name: 'done' }); },
    timing: fastTiming,
    ...overrides,
  };
  return { deps, views, calls, get doneCount() { return doneCount; } };
}

function loadWholeModule(source: string) {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(js, { module, exports: module.exports, console: { warn: () => undefined } });
  return module.exports as {
    runSplashFlow: typeof runSplashFlow;
    shownDownloadFraction: typeof shownDownloadFraction;
  };
}

function replaceOnce(source: string, from: string, to: string): string {
  assert.equal(source.split(from).length - 1, 1, `мутант должен менять ровно один найденный фрагмент: ${from}`);
  return source.replace(from, to);
}

function isFailedOkAssertion(error: unknown, message: string): boolean {
  return error instanceof assert.AssertionError && error.message === message
    && error.operator === '==' && error.actual === false && error.expected === true;
}

describe('runSplashFlow — поведение заставки на поддельных часах', () => {
  // Иначе подстройка ожиданий и подмен под те же константы скроет случайное обнуление пауз.
  it('R242 минимумы этапов равны 1200/2000/1200/400 мс, таймауты и шаг не изменились', () => {
    assert.deepEqual(SPLASH_TIMING, {
      checkMinMs: 1200,
      checkTimeoutMs: 4000,
      startMinMs: 400,
      downloadMinMs: 2000,
      installMinMs: 1200,
      stallMs: 45000,
      tickMs: 50,
    });
  });

  it('значения времени по умолчанию сохраняют видимость этапов без переопределения timing', async () => {
    const clock = new FakeClock();
    const h = basicDeps(clock, async () => null, { timing: undefined });
    let settled = false;
    const flow = runSplashFlow(h.deps).then((value) => { settled = true; return value; });
    await driveUntil(clock, () => settled);
    assert.equal(await flow, 'started');
    assert.equal(h.views.find((x) => x.view.stage === 'checking')!.at, 0);
    assert.equal(h.views.find((x) => x.view.stage === 'starting')!.at, SPLASH_TIMING.checkMinMs);
    assert.equal(h.calls.find((x) => x.name === 'done')!.at, SPLASH_TIMING.checkMinMs + SPLASH_TIMING.startMinMs);
    assert.equal(h.doneCount, 1);

    // Мгновенная сеть тоже обязана показать скачивание и установку на настоящих, не fastTiming, паузах.
    const updateClock = new FakeClock();
    const installs: number[] = [];
    const update: SplashUpdate = {
      version: '9.8.7',
      download: async (emit) => { emit({ event: 'Finished' }); },
      install: async () => { installs.push(updateClock.now()); },
    };
    const updating = basicDeps(updateClock, async () => update, { timing: undefined });
    let updated = false;
    const updateFlow = runSplashFlow(updating.deps).then((value) => { updated = true; return value; });
    await driveUntil(updateClock, () => updated);
    assert.equal(await updateFlow, 'installing');
    const downloadStart = SPLASH_TIMING.checkMinMs;
    const installStart = downloadStart + SPLASH_TIMING.downloadMinMs;
    const installEnd = installStart + SPLASH_TIMING.installMinMs;
    const downloading = updating.views.filter((x) => x.view.stage === 'downloading');
    assert.equal(downloading[0]!.at, downloadStart);
    assert.equal(downloading.find((x) => x.view.progress === 1)!.at, installStart, '100% ровно на границе downloadMin');
    const beforeEnd = downloading.find((x) => x.at === installStart - SPLASH_TIMING.tickMs);
    assert.equal(beforeEnd?.view.progress, (SPLASH_TIMING.downloadMinMs - SPLASH_TIMING.tickMs) / SPLASH_TIMING.downloadMinMs,
      'за тик до downloadMin мгновенный файл ещё не показывает 100%');
    assert.equal(updating.views.find((x) => x.view.stage === 'installing')!.at, installStart);
    assert.equal(updating.calls.find((x) => x.name === 'beforeInstall')!.at, installStart);
    assert.deepEqual(installs, [installEnd], 'install вызывается ровно после полного installMin');
    assert.equal(updating.calls.find((x) => x.name === 'done')!.at, installEnd);
    assert.equal(updating.doneCount, 1);
  });

  it('без обновления показывает checking и starting минимум по времени, затем вызывает done ровно один раз', async () => {
    const clock = new FakeClock();
    const h = basicDeps(clock, async () => null);
    let settled = false;
    const flow = runSplashFlow(h.deps).then((value) => { settled = true; return value; });
    await driveUntil(clock, () => settled);
    assert.equal(await flow, 'started');
    const checking = h.views.find((x) => x.view.stage === 'checking');
    const starting = h.views.find((x) => x.view.stage === 'starting');
    assert.ok(checking && starting);
    assert.equal(checking.at, 0);
    assert.equal(starting.at, 7, 'checking держится до точного минимума');
    assert.equal(h.calls.find((x) => x.name === 'done')!.at, 11, 'starting держится до точного минимума');
    assert.equal(h.doneCount, 1);
    assert.deepEqual(h.views.filter((x) => x.view.stage === 'checking' || x.view.stage === 'starting').map((x) => x.view.stage), ['checking', 'starting']);
  });

  it('зависшая проверка заканчивается по таймауту и всё равно запускает приложение', async () => {
    const clock = new FakeClock();
    const h = basicDeps(clock, () => new Promise<SplashUpdate | null>(() => undefined));
    let settled = false;
    const flow = runSplashFlow(h.deps).then((v) => { settled = true; return v; });
    await driveUntil(clock, () => settled);
    assert.equal(await flow, 'started');
    assert.equal(h.views.find((x) => x.view.stage === 'starting')!.at, fastTiming.checkTimeoutMs);
    assert.equal(h.calls.find((x) => x.name === 'done')!.at, 44);
    assert.equal(h.doneCount, 1);
  });

  it('бросок проверки не блокирует запуск и выдерживает минимумы обоих этапов', async () => {
    const clock = new FakeClock();
    const h = basicDeps(clock, async () => { throw new Error('offline'); });
    let settled = false;
    const flow = runSplashFlow(h.deps).then((v) => { settled = true; return v; });
    await driveUntil(clock, () => settled);
    assert.equal(await flow, 'started');
    assert.equal(h.views.find((x) => x.view.stage === 'checking')!.at, 0);
    assert.equal(h.views.find((x) => x.view.stage === 'starting')!.at, 7);
    assert.equal(h.calls.find((x) => x.name === 'done')!.at, 11);
    assert.equal(h.doneCount, 1);
  });

  it('скачивание ведёт монотонную полосу не быстрее времени и ставит обновление только после beforeInstall', async () => {
    const clock = new FakeClock();
    const download = deferred<void>();
    let emit!: Parameters<SplashUpdate['download']>[0];
    const update: SplashUpdate = {
      version: '9.8.7',
      download: (onEvent) => {
        emit = (event) => {
          if (event.event === 'Started') total = event.data.contentLength ?? 0;
          else if (event.event === 'Progress') got += event.data.chunkLength;
          else if (event.event === 'Finished') finished = true;
          onEvent(event);
        };
        return download.promise;
      },
      install: async () => { h.calls.push({ at: clock.now(), name: 'install' }); },
    };
    let total = 0;
    let got = 0;
    let finished = false;
    const observed: Array<{ at: number; progress: number; real: number | null }> = [];
    const h = basicDeps(clock, async () => update);
    h.deps.show = (view) => {
        h.views.push({ at: clock.now(), view });
        if (view.stage === 'downloading') observed.push({ at: clock.now(), progress: view.progress!, real: finished ? 1 : total > 0 ? Math.min(1, got / total) : null });
    };
    let settled = false;
    const flow = runSplashFlow(h.deps).then((v) => { settled = true; return v; });
    for (let i = 0; i < 100 && !emit; i++) {
      await flushMicrotasks();
      if (!emit) await clock.advanceNext();
    }
    assert.equal(typeof emit, 'function', 'download начинается после checking');
    emit({ event: 'Started', data: { contentLength: 100 } });
    emit({ event: 'Progress', data: { chunkLength: 35 } });
    await flushMicrotasks();
    for (let i = 0; i < 3; i++) await clock.advanceNext();
    emit({ event: 'Progress', data: { chunkLength: 65 } });
    emit({ event: 'Finished' });
    download.resolve();
    await flushMicrotasks();
    await driveUntil(clock, () => settled);
    assert.equal(await flow, 'installing');

    let previous = 0;
    for (const item of observed) {
      const progress = item.progress;
      assert.ok(progress >= previous, 'показанная доля не убывает');
      assert.ok(progress <= 1, 'показанная доля не выше единицы');
      const elapsed = item.at - observed[0]!.at;
      assert.ok(progress <= Math.min(1, elapsed / fastTiming.downloadMinMs), 'полоса не обгоняет временную огибающую');
      assert.ok(progress <= (item.real ?? 0.9), 'показанная доля не обгоняет реальные байты (или потолок неизвестного размера)');
      previous = progress;
    }
    const allDone = observed.filter((x) => x.progress === 1);
    assert.ok(allDone.every((x) => x.at - observed[0]!.at >= fastTiming.downloadMinMs), '100% не раньше downloadMin');
    const installView = h.views.find((x) => x.view.stage === 'installing')!;
    const before = h.calls.find((x) => x.name === 'beforeInstall')!;
    const install = h.calls.find((x) => x.name === 'install')!;
    assert.ok(installView.at <= before.at && before.at < install.at, 'метка beforeInstall записывается до установки');
    assert.ok(install.at - installView.at >= fastTiming.installMinMs, 'Устанавливаю… виден минимум до install');
    assert.equal(h.doneCount, 1);
  });

  it('ошибка install снимает метку и возвращается к запуску с одним done', async () => {
    const clock = new FakeClock();
    const calls: string[] = [];
    const update: SplashUpdate = {
      version: '2.0',
      download: (emit) => { emit({ event: 'Finished' }); return Promise.resolve(); },
      install: async () => { calls.push('install'); throw new Error('installer'); },
    };
    const h = basicDeps(clock, async () => update, {
      beforeInstall: async () => { calls.push('beforeInstall'); },
      installFailed: () => { calls.push('installFailed'); },
    });
    let settled = false;
    const flow = runSplashFlow(h.deps).then((v) => { settled = true; return v; });
    await flushMicrotasks();
    await driveUntil(clock, () => settled);
    assert.equal(await flow, 'started');
    assert.deepEqual(calls, ['beforeInstall', 'install', 'installFailed']);
    assert.deepEqual(h.views.filter((x) => x.view.stage === 'starting').length, 1);
    assert.equal(h.doneCount, 1);
  });

  it('отклонённое скачивание запускает текущую версию без installFailed', async () => {
    const clock = new FakeClock();
    const update: SplashUpdate = {
      version: '2.0',
      download: () => Promise.reject(new Error('network')),
      install: async () => assert.fail('при неудачной загрузке установка не начинается'),
    };
    const h = basicDeps(clock, async () => update);
    let settled = false;
    const flow = runSplashFlow(h.deps).then((v) => { settled = true; return v; });
    await flushMicrotasks();
    await driveUntil(clock, () => settled);
    assert.equal(await flow, 'started');
    assert.equal(h.calls.filter((x) => x.name === 'installFailed').length, 0);
    assert.equal(h.doneCount, 1);
  });

  it('строгое превышение stallMs, а не равенство, переводит заставку к запуску', async () => {
    const clock = new FakeClock();
    const update: SplashUpdate = { version: '2', download: () => new Promise<void>(() => undefined), install: async () => undefined };
    const h = basicDeps(clock, async () => update, { timing: { ...fastTiming, stallMs: 5, tickMs: 1 } });
    let settled = false;
    const flow = runSplashFlow(h.deps).then((v) => { settled = true; return v; });
    await flushMicrotasks();
    while (!h.views.some((x) => x.view.stage === 'downloading')) {
      await flushMicrotasks();
      if (!h.views.some((x) => x.view.stage === 'downloading')) await clock.advanceNext();
    }
    const dlStart = h.views.find((x) => x.view.stage === 'downloading')!.at;
    while (clock.now() < dlStart + 5) await clock.advanceNext();
    assert.equal(h.views.filter((x) => x.view.stage === 'starting').length, 0, 'ровно stallMs ещё не считается застоем');
    await clock.advanceNext();
    assert.equal(h.views.find((x) => x.view.stage === 'starting')!.at, dlStart + 6, 'провал — на первом тике строго после stallMs');
    await driveUntil(clock, () => settled);
    assert.equal(await flow, 'started');
    assert.equal(h.calls.filter((x) => x.name === 'beforeInstall' || x.name === 'install' || x.name === 'installFailed').length, 0);
    assert.equal(h.doneCount, 1);
  });
});

describe('shownDownloadFraction — границы полосы', () => {
  it('неизвестный размер едет по времени только до 0.9, пока загрузка не завершена', () => {
    assert.equal(shownDownloadFraction(null, 0, 12, false), 0);
    assert.equal(shownDownloadFraction(null, -1, 12, false), 0, 'отрицательное прошедшее время не двигает полосу назад');
    assert.equal(shownDownloadFraction(null, 12, 12, false), 0.9);
    assert.equal(shownDownloadFraction(null, 40, 12, false), 0.9);
    assert.equal(shownDownloadFraction(null, 0, 0, false), 0.9, 'нулевой минимум не делает неизвестный файл завершённым');
    assert.equal(shownDownloadFraction(null, 0, 0, true), 1, 'явное завершение снимает потолок неизвестного размера');
  });

  it('после завершения достигает 1 не раньше минимума, а нулевой минимум использует реальную долю', () => {
    const minMs = SPLASH_TIMING.downloadMinMs;
    assert.equal(shownDownloadFraction(0, minMs, minMs, false), 0, 'известный нулевой прогресс не маскируется временем');
    assert.equal(shownDownloadFraction(1, 0, minMs, false), 0, 'фактические 100% ждут временную огибающую');
    assert.equal(shownDownloadFraction(-0.5, minMs, minMs, false), 0, 'отрицательная доля зажимается снизу');
    assert.equal(shownDownloadFraction(1.5, minMs, minMs, false), 1, 'доля выше единицы зажимается сверху');
    assert.equal(shownDownloadFraction(0.4, -1, 0, false), 0.4, 'при нулевом минимуме используется фактическая доля');
    assert.equal(shownDownloadFraction(null, 0, 0, false), 0.9);
    assert.equal(shownDownloadFraction(0.7, minMs - 1, minMs, true), (minMs - 1) / minMs);
    assert.equal(shownDownloadFraction(0.7, minMs, minMs, true), 1);
    assert.equal(shownDownloadFraction(0.4, 0, 0, false), 0.4);
  });
});

describe('контрфакты: поведенческие сценарии ловят регрессии модуля', () => {
  it('оригинал проходит, а удаление holdUntil нарушает минимум этапа checking', async () => {
    const original = loadWholeModule(SOURCE);
    const mutantSource = replaceOnce(SOURCE, 'if (left > 0) await deps.sleep(left);', '/* ожидание удалено */');
    const mutant = loadWholeModule(mutantSource);
    const scenario = async (api: typeof original) => {
      const clock = new FakeClock();
      const h = basicDeps(clock, async () => null);
      let settled = false;
      const flow = api.runSplashFlow(h.deps).then(() => { settled = true; });
      try {
        while (!h.views.some((x) => x.view.stage === 'starting')) {
          await flushMicrotasks();
          if (!h.views.some((x) => x.view.stage === 'starting')) await clock.advanceNext();
        }
        assert.ok(h.views.find((x) => x.view.stage === 'starting')!.at >= fastTiming.checkMinMs, 'checking выдерживает минимум');
      } finally {
        await driveUntil(clock, () => settled);
        await flow;
      }
    };
    await scenario(original);
    await assert.rejects(scenario(mutant), (e: unknown) => isFailedOkAssertion(e, 'checking выдерживает минимум'));
  });

  it('оригинал проходит, а игнорирование byTime даёт 100% раньше downloadMin', async () => {
    const original = loadWholeModule(SOURCE);
    const mutantSource = replaceOnce(SOURCE, 'Math.min(1, byTime, realPart)', 'Math.min(1, realPart)');
    const mutant = loadWholeModule(mutantSource);
    const scenario = async (api: typeof original) => {
      const clock = new FakeClock();
      const update: SplashUpdate = { version: 'v', download: (emit) => { emit({ event: 'Finished' }); return Promise.resolve(); }, install: async () => undefined };
      const h = basicDeps(clock, async () => update);
      let settled = false;
      const flow = api.runSplashFlow(h.deps).then(() => { settled = true; });
      await flushMicrotasks();
      await driveUntil(clock, () => settled);
      await flow;
      const dl = h.views.filter((x) => x.view.stage === 'downloading');
      const one = dl.find((x) => x.view.progress === 1);
      assert.ok(one && one.at - dl[0]!.at >= fastTiming.downloadMinMs, '100% только после downloadMin');
    };
    await scenario(original);
    await assert.rejects(scenario(mutant), (e: unknown) => isFailedOkAssertion(e, '100% только после downloadMin'));
  });

  it('оригинал проходит, а перестановка install перед beforeInstall ломает порядок', async () => {
    const original = loadWholeModule(SOURCE);
    const mutantSource = replaceOnce(SOURCE, 'await deps.beforeInstall(version);\n    marked = true;\n    await holdUntil(t2 + t.installMinMs);\n    deps.ping();\n    await update.install();', 'await update.install();\n    await deps.beforeInstall(version);\n    marked = true;\n    await holdUntil(t2 + t.installMinMs);\n    deps.ping();');
    const mutant = loadWholeModule(mutantSource);
    const scenario = async (api: typeof original) => {
      const clock = new FakeClock();
      const order: string[] = [];
      const update: SplashUpdate = { version: 'v', download: (emit) => { emit({ event: 'Finished' }); return Promise.resolve(); }, install: async () => { order.push('install'); } };
      const h = basicDeps(clock, async () => update, { beforeInstall: async () => { order.push('beforeInstall'); } });
      let settled = false;
      const flow = api.runSplashFlow(h.deps).then(() => { settled = true; });
      await flushMicrotasks();
      await driveUntil(clock, () => settled);
      await flow;
      assert.deepEqual(order.slice(0, 2), ['beforeInstall', 'install'], 'метка предшествует install');
    };
    await scenario(original);
    await assert.rejects(scenario(mutant), (e: unknown) => e instanceof assert.AssertionError
      && e.message.includes('метка предшествует install') && e.operator === 'deepStrictEqual'
      && JSON.stringify(e.actual) === JSON.stringify(['install', 'beforeInstall'])
      && JSON.stringify(e.expected) === JSON.stringify(['beforeInstall', 'install']));
  });

  it('оригинал проходит, а пропуск done после ошибки обновления оставляет окно без завершения', async () => {
    const original = loadWholeModule(SOURCE);
    const mutantSource = replaceOnce(SOURCE, 'await deps.done();\n    return \'started\';', 'return \'started\';');
    const mutant = loadWholeModule(mutantSource);
    const scenario = async (api: typeof original) => {
      const clock = new FakeClock();
      const update: SplashUpdate = { version: 'v', download: () => Promise.reject(new Error('network')), install: async () => undefined };
      const h = basicDeps(clock, async () => update);
      let settled = false;
      const flow = api.runSplashFlow(h.deps).then(() => { settled = true; });
      await flushMicrotasks();
      await driveUntil(clock, () => settled);
      await flow;
      assert.equal(h.doneCount, 1, 'ошибка обновления всё равно открывает главное окно');
    };
    await scenario(original);
    await assert.rejects(scenario(mutant), (e: unknown) => e instanceof assert.AssertionError
      && e.message.startsWith('ошибка обновления всё равно открывает главное окно')
      && e.operator === 'strictEqual' && e.actual === 0 && e.expected === 1);
  });
});
