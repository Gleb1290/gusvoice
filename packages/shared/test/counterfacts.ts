import { it, type TestContext, type TestOptions } from 'node:test';
import { performance } from 'node:perf_hooks';
import { setTimeout, clearTimeout } from 'node:timers';

/** Test-only support: not exported by the application's shared entrypoint. */
export function mutantsEnabled(): boolean { return process.env.GV_MUTANTS === '1'; }

export class CounterfactBudgetError extends Error {
  constructor(message: string) { super(message); this.name = 'CounterfactBudgetError'; }
}
export type CounterfactLimits = {
  maxSteps?: number;
  timeoutMs?: number;
  /** Maximum RSS growth from budget creation, not the process's total RSS. */
  maxRssBytes?: number;
  /** Deterministic resource readings for tests of the helper itself. */
  now?: () => number;
  rss?: () => number;
};
export type CounterfactBudget = { step(count?: number): void; check(): void };
type CounterfactTestFn = (context: TestContext) => unknown;

/** Cooperative limit: synchronous loops/React renders must call step; VM timeouts remain mandatory. */
export function createCounterfactBudget(limits: CounterfactLimits = {}): CounterfactBudget {
  const maxSteps = limits.maxSteps ?? 1000, timeoutMs = limits.timeoutMs ?? 30_000;
  const maxRssBytes = limits.maxRssBytes ?? 1024 ** 3, now = limits.now ?? (() => performance.now());
  const rss = limits.rss ?? (() => process.memoryUsage().rss);
  for (const [name, value] of Object.entries({ maxSteps, timeoutMs, maxRssBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new CounterfactBudgetError(`Invalid counterfact limit: ${name}`);
  }
  const deadline = now() + timeoutMs;
  const initialRss = rss();
  let steps = 0, failure: CounterfactBudgetError | undefined;
  function fail(message: string): never { failure ??= new CounterfactBudgetError(message); throw failure; }
  function check() {
    if (failure) throw failure;
    if (now() >= deadline) fail('Counterfact time budget exceeded');
    if (rss() - initialRss > maxRssBytes) fail('Counterfact RSS budget exceeded');
  }
  return {
    step(count = 1) {
      if (!Number.isSafeInteger(count) || count <= 0) fail('Counterfact step must be a positive integer');
      steps += count;
      if (steps > maxSteps) fail('Counterfact step budget exceeded');
      check();
    },
    check,
  };
}

/** Lazy boundary: no callback, source replacement, VM or mutation loop is entered in the ordinary gate. */
export function counterfact<T>(work: (budget: CounterfactBudget) => T, limits: CounterfactLimits = {}): T | undefined {
  if (!mutantsEnabled()) return undefined;
  const budget = createCounterfactBudget(limits);
  budget.step();
  const result = work(budget);
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CounterfactBudgetError('Counterfact async time budget exceeded')), limits.timeoutMs ?? 30_000);
    });
    return Promise.race([Promise.resolve(result), watchdog])
      .then(value => { budget.check(); return value; })
      .finally(() => { if (timer !== undefined) clearTimeout(timer); }) as T;
  }
  budget.check();
  return result;
}

/** Keep every registration (including loops) while marking mutation-only leaves as skipped by default. */
export function mutantTest(name: string, fn: CounterfactTestFn): ReturnType<typeof it>;
export function mutantTest(name: string, options: TestOptions, fn: CounterfactTestFn): ReturnType<typeof it>;
export function mutantTest(name: string, optionsOrFn: TestOptions | CounterfactTestFn, fn?: CounterfactTestFn): ReturnType<typeof it> {
  const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
  const scenario = typeof optionsOrFn === 'function' ? optionsOrFn : fn;
  if (!scenario) throw new TypeError('A counterfact test needs a callback');
  return it(name, { ...options, skip: options.skip || (!mutantsEnabled() && 'Requires GV_MUTANTS=1'),
    timeout: options.timeout ?? 30_000 }, async (context: TestContext) => {
      await counterfact(() => scenario(context), { timeoutMs: options.timeout ?? 30_000 });
    });
}

/** Explicit nightly-only diagnostics; never wrap original-code baselines (R375): use it + counterfact. */
export const nightlyTest: typeof mutantTest = mutantTest;
