import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { createContext, Script } from 'node:vm';
import ts from 'typescript';
import * as zustand from 'zustand';
import * as fedErrorText from './fedErrorText.js';
import * as longTextRules from './longTextRules.js';
import * as splashFlow from './splashFlow.js';
import type { Toast } from './toast.js';

const updaterSource = readFileSync(new URL('./updater.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const toastSource = readFileSync(new URL('./toast.ts', import.meta.url), 'utf8');
const updateStoreSource = readFileSync(new URL('./updateStore.ts', import.meta.url), 'utf8');
const VM_TIMEOUT_MS = 500;
const STEP_LIMIT = 200;
const SUCCESS_TITLE = 'У вас последняя версия';
const SUCCESS_SUBTITLE = 'Обновлений не найдено';
const ERROR_TITLE = 'Не удалось проверить обновления';
const ERROR_SUBTITLE = 'Проверьте интернет-соединение';

type ToastModule = typeof import('./toast.js');
type UpdateModule = typeof import('./updateStore.js');
type Outcome = { done: boolean; error?: unknown };
type Reply = { kind: 'none' | 'error' } | { kind: 'pending'; promise: unknown };
class HarnessBudgetError extends Error {}
class HarnessSetupError extends Error {}

function fixture(source = updaterSource) {
  let steps = 0, checks = 0;
  let exhausted = false;
  const replies: Reply[] = [];
  const unrelated: string[] = [];
  function step() {
    if (++steps > STEP_LIMIT) {
      exhausted = true;
      throw new HarnessBudgetError('R368: превышен бюджет 200 вызовов/шагов');
    }
  }
  function checkHarness() {
    // Catch приложения не вправе превратить ошибку подготовки/бюджета в успешный counterfact.
    if (exhausted) throw new HarnessBudgetError('R368: превышен бюджет 200 вызовов/шагов');
    if (unrelated.length) throw new HarnessSetupError(`R368: непредметный I/O ${unrelated.join(', ')}`);
  }
  function unexpected(name: string): never {
    unrelated.push(name);
    throw new HarnessSetupError(`R368: непредметный I/O ${name}`);
  }
  const deps: Record<string, unknown> = {
    zustand,
    './fedErrorText': fedErrorText,
    './longTextRules': longTextRules,
    './splashFlow': splashFlow,
    './hotkeys': { isDesktop: () => { step(); return true; } },
    '@tauri-apps/plugin-updater': {
      check() {
        step(); checks++;
        const reply = replies.shift();
        if (!reply) return unexpected('check без подготовленного ответа');
        if (reply.kind === 'error') throw new Error('offline — фиктивный отказ проверки');
        // await принимает и immediate null, и настоящий deferred VM Promise. Сам updater не подменён.
        return reply.kind === 'pending' ? reply.promise : null;
      },
    },
  };
  const context = createContext({
    window: {},
    console: { warn() { step(); } },
    setTimeout: () => unexpected('setTimeout'),
    setInterval: () => unexpected('setInterval'),
    require(id: string) {
      step();
      if (!Object.hasOwn(deps, id)) return unexpected(`require ${id}`);
      return deps[id];
    },
  }, { microtaskMode: 'afterEvaluate' });
  function run(code: string, filename = 'updater.manualToast.harness.js') {
    step();
    try {
      new Script(code, { filename }).runInContext(context, { timeout: VM_TIMEOUT_MS });
    } finally {
      checkHarness();
    }
  }
  function load(body: string, filename: string): Record<string, unknown> {
    const module = { exports: {} as Record<string, unknown> };
    context.__module = module;
    const compiled = ts.transpileModule(body, {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    if (compiled.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
      throw new HarnessSetupError(`R368: не скомпилирован ${filename}`);
    }
    // ЦЕЛЫЕ toast.ts, updateStore.ts и updater.ts, обычная CommonJS-обёртка вместо eval вырезок.
    run(`(function(module, exports, require) {\n${compiled.outputText}\n})(__module, __module.exports, require);`, filename);
    return module.exports;
  }
  const toastModule = load(toastSource, 'toast.ts') as unknown as ToastModule;
  const updateModule = load(updateStoreSource, 'updateStore.ts') as unknown as UpdateModule;
  if (typeof toastModule.toast !== 'function' || typeof toastModule.useToasts?.subscribe !== 'function'
    || typeof updateModule.useUpdate?.subscribe !== 'function') {
    throw new HarnessSetupError('R368: не загружены настоящие Zustand stores');
  }
  deps['./toast'] = toastModule;
  deps['./updateStore'] = updateModule;
  // Настоящие create/set/getState/push/dismiss: массив тостов не моделируется. Подписки только
  // ограничивают число записей; зациклившийся мутант остановится и при проглоченном исключении.
  const unsubscribeToasts = toastModule.useToasts.subscribe(() => step());
  const unsubscribeUpdate = updateModule.useUpdate.subscribe(() => step());
  context.__updater = load(source, 'updater.ts');
  if (typeof context.__updater.manualUpdateCheck !== 'function') throw new HarnessSetupError('R368: нет manualUpdateCheck');

  function start(): Outcome {
    step();
    const outcome: Outcome = { done: false };
    context.__complete = (error?: unknown) => { step(); outcome.done = true; outcome.error = error; };
    // complete захвачен отдельно для КАЖДОГО вызова: второй вызов не крадёт окончание первого.
    run('((complete) => { Promise.resolve(__updater.manualUpdateCheck()).then(() => complete(), error => complete(error)); })(__complete);');
    return outcome;
  }
  async function finish(outcome: Outcome) {
    // afterEvaluate держит VM-microtasks под timeout; host-turn/pump нужен только для межмодульных
    // Promise. Никаких waitFor/действительных таймеров или неограниченных циклов ожидания.
    for (let tick = 0; !outcome.done && tick < STEP_LIMIT; tick++) {
      step(); await Promise.resolve(); run('');
    }
    checkHarness();
    if (!outcome.done) throw new HarnessBudgetError('R368: вызов не завершён за 200 шагов');
    if (outcome.error !== undefined) throw outcome.error;
  }
  function view(): readonly Toast[] {
    step(); checkHarness();
    return toastModule.useToasts.getState().toasts;
  }
  return {
    start, finish, view,
    phase: () => { step(); checkHarness(); return updateModule.useUpdate.getState().phase; },
    checks: () => { checkHarness(); return checks; },
    reply(kind: 'none' | 'error') { step(); replies.push({ kind }); },
    deferred() {
      step();
      run('__deferred = new Promise(resolve => { __resolveDeferred = resolve; });');
      replies.push({ kind: 'pending', promise: context.__deferred });
      const resolveDeferred = context.__resolveDeferred;
      let resolved = false;
      return () => {
        if (resolved) return;
        resolved = true;
        context.__resolveNow = resolveDeferred;
        run('__resolveNow(null)');
      };
    },
    other(type: 'info' | 'warn', title: string): number {
      context.__other = () => toastModule.toast(type, title, 'Тост другой операции', { sticky: true });
      run('__otherId = __other()');
      return context.__otherId as number;
    },
    dispose() { unsubscribeToasts(); unsubscribeUpdate(); },
  };
}

type Fixture = ReturnType<typeof fixture>;
async function answer(f: Fixture, kind: 'none' | 'error') {
  f.reply(kind);
  await f.finish(f.start());
}
function current(f: Fixture, type: 'success' | 'error', countAddress: string): Toast {
  const toasts = f.view();
  assert.equal(toasts.length, 1, countAddress);
  const toast = toasts[0];
  assert.equal(toast.type, type);
  assert.equal(toast.title, type === 'success' ? SUCCESS_TITLE : ERROR_TITLE);
  assert.equal(toast.subtitle, type === 'success' ? SUCCESS_SUBTITLE : ERROR_SUBTITLE);
  return toast;
}
function replaceOnce(needle: string): string {
  if (updaterSource.split(needle).length - 1 !== 1) throw new HarnessSetupError(`R368: неединственный якорь ${needle}`);
  return updaterSource.replace(needle, '');
}
function targetedCount(address: string, actual: number, expected: number) {
  return (error: unknown) => error instanceof assert.AssertionError
    && error.message.split('\n')[0] === address
    && error.operator === 'strictEqual'
    && error.actual === actual && error.expected === expected;
}

async function twoSuccesses(f: Fixture) {
  const address = 'R368/toasts/one-fresh-success';
  try {
    assert.equal(f.view().length, 0);
    await answer(f, 'none');
    const firstId = current(f, 'success', address).id;
    assert.equal(f.phase(), 'idle');
    await answer(f, 'none');
    const secondId = current(f, 'success', address).id;
    assert.equal(secondId > firstId, true, 'R368: ответ заменён свежим тостом, не подавлен');
    assert.equal(f.view().some((toast) => toast.id === firstId), false);
    assert.equal(f.checks(), 2);
    assert.equal(f.phase(), 'idle');
  } finally { f.dispose(); }
}

it('R368 два последовательных none дают один свежий success в настоящем toast store; без dismiss остаётся стопка', async () => {
  await twoSuccesses(fixture());
  await counterfact(async () => {
    const mutant = fixture(replaceOnce('  if (manualToastId !== null) useToasts.getState().dismiss(manualToastId);\n'));
    // Загрузка снаружи rejects; только 2 вместо 1, а не setup/VM/budget, считается убитым мутантом.
    await assert.rejects(() => twoSuccesses(mutant), targetedCount('R368/toasts/one-fresh-success', 2, 1));
  });
});

it('R368 ошибка заменяет прежний success одним error с нужным текстом, следующий успех снова заменяет ошибку', async () => {
  const f = fixture();
  try {
    await answer(f, 'none');
    const successId = current(f, 'success', 'R368/toasts/success-before-error').id;
    await answer(f, 'error');
    const errorId = current(f, 'error', 'R368/toasts/error-replaces-success').id;
    assert.equal(errorId > successId, true);
    assert.equal(f.view().some((toast) => toast.id === successId), false);
    assert.equal(f.phase(), 'idle');
    await answer(f, 'none');
    const recoveredId = current(f, 'success', 'R368/toasts/success-after-error').id;
    assert.equal(recoveredId > errorId, true);
    assert.equal(f.view().some((toast) => toast.id === errorId), false);
    assert.equal(f.checks(), 3);
  } finally { f.dispose(); }
});

async function pendingCheck(f: Fixture) {
  const resolvePending = f.deferred();
  // Второй ответ предназначен для первого разрешённого вызова ПОСЛЕ окончания pending.
  // Мутант без guard потратит его раньше: проверяем счётчик до завершения первого запроса.
  f.reply('none');
  const first = f.start();
  try {
    assert.equal(first.done, false, 'R368/подготовка/deferred действительно удерживает check');
    assert.equal(f.phase(), 'checking');
    assert.equal(f.checks(), 1);
    assert.equal(f.view().length, 0);
    const repeated = f.start();
    await f.finish(repeated);
    assert.equal(f.checks(), 1, 'R368/checking/no-second-check');
    assert.equal(f.view().length, 0, 'R368/checking/no-response-toast');
    assert.equal(first.done, false);
    assert.equal(f.phase(), 'checking');
    resolvePending();
    await f.finish(first);
    const firstId = current(f, 'success', 'R368/checking/completed-success').id;
    assert.equal(f.phase(), 'idle');
    await f.finish(f.start());
    const nextId = current(f, 'success', 'R368/checking/next-call-works').id;
    assert.equal(nextId > firstId, true);
    assert.equal(f.checks(), 2);
  } finally {
    // Даже адресно упавший контрфакт не оставляет висящую операцию и подписки.
    try { resolvePending(); await f.finish(first); } finally { f.dispose(); }
  }
}

it('R368 pending check подавляет повторный запрос и тост, после ответа снова принимает проверку; guard нужен', async () => {
  await pendingCheck(fixture());
  await counterfact(async () => {
    const mutant = fixture(replaceOnce("  if (phase === 'checking') return; // проверка уже идёт — второй запрос не нужен\n"));
    await assert.rejects(() => pendingCheck(mutant), targetedCount('R368/checking/no-second-check', 2, 1));
  });
});

it('R368 замена ответа ручной проверки сохраняет чужие sticky-тосты до и между проверками', async () => {
  const f = fixture();
  try {
    const earlier = f.other('info', 'Настройки сохранены');
    await answer(f, 'none');
    const firstManual = f.view().find((toast) => toast.type === 'success')!.id;
    const later = f.other('warn', 'Сообщение другой операции');
    await answer(f, 'none');
    await answer(f, 'error');
    const toasts = f.view();
    assert.equal(toasts.length, 3);
    for (const id of [earlier, later]) {
      assert.equal(toasts.some((toast) => toast.id === id && toast.sticky === true), true);
    }
    assert.equal(toasts.some((toast) => toast.id === firstManual), false);
    assert.equal(toasts.filter((toast) => toast.type === 'success').length, 0);
    const errors = toasts.filter((toast) => toast.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].title, ERROR_TITLE);
    assert.equal(errors[0].subtitle, ERROR_SUBTITLE);
  } finally { f.dispose(); }
});
