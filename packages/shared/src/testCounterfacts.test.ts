import assert from 'node:assert/strict';
import { it } from 'node:test';
import { counterfact, createCounterfactBudget, CounterfactBudgetError, mutantsEnabled } from '../test/counterfacts.js';

// R373: these test the runner's behaviour, not application source text or generated mutants.
async function withFlag<T>(value: string | undefined, work: () => T | Promise<T>): Promise<T> {
  const old = process.env.GV_MUTANTS;
  if (value === undefined) delete process.env.GV_MUTANTS;
  else process.env.GV_MUTANTS = value;
  try { return await work(); }
  finally {
    if (old === undefined) delete process.env.GV_MUTANTS;
    else process.env.GV_MUTANTS = old;
  }
}

// Ловит запуск мутаций/чтения исходника даже при обычном гейте либо похожем, но неверном флаге.
it('без точного флага тело контрфакта не вызывается и не проверяет его лимиты', async () => {
  let calls = 0;
  for (const value of [undefined, '', '0', 'true', '01']) await withFlag(value, () => {
    assert.equal(mutantsEnabled(), false);
    assert.equal(counterfact(() => { calls++; throw new Error('не должно выполняться'); }, {
      maxSteps: 0, rss: () => { throw new Error('RSS без флага не читается'); },
    }), undefined);
  });
  assert.equal(calls, 0);
});

// Парный позитив не даёт превратить оптимизацию гейта в вечный пропуск ночного прогона.
it('точный флаг выполняет синхронный контрфакт один раз и возвращает его результат', async () => {
  await withFlag('1', () => {
    let calls = 0;
    assert.equal(mutantsEnabled(), true);
    assert.equal(counterfact(budget => { calls++; budget.step(2); return 17; }, { maxSteps: 3 }), 17);
    assert.equal(calls, 1);
  });
});

// Ловит незавершённый Promise, если общий раннер случайно перестал ждать асинхронный сценарий.
it('ночной асинхронный контрфакт завершается и возвращает результат', async () => {
  await withFlag('1', async () => {
    let finished = false;
    const result = await counterfact(async budget => {
      await Promise.resolve(); budget.step(); finished = true; return 42;
    });
    assert.equal(finished, true);
    assert.equal(result, 42);
  });
});

// Ошибка подготовки/проверки должна оставаться собой, а не превращаться в успех контрфакта.
it('ошибка тела не поглощается и сохраняет identity при sync и async', async () => {
  await withFlag('1', async () => {
    const marker = new Error('синтетическая ошибка сценария');
    assert.throws(() => counterfact(() => { throw marker; }), error => error === marker);
    await assert.rejects(async () => counterfact(async () => { throw marker; }), error => error === marker);
  });
});

// Обе стороны границы: ровно N шагов допустимы, N+1 запрещён, перехват не сбрасывает отказ.
it('бюджет разрешает ровно лимит шагов и сохраняет отказ после превышения', () => {
  const budget = createCounterfactBudget({ maxSteps: 2 });
  budget.step(2);
  budget.check();
  assert.throws(() => budget.step(), CounterfactBudgetError);
  assert.throws(() => budget.check(), CounterfactBudgetError);
});

// Поддельные часы доказывают границу без ожидания настоящего таймера и без сети.
it('последняя миллисекунда до срока разрешена, сам срок останавливает сценарий', () => {
  let now = 100;
  const budget = createCounterfactBudget({ timeoutMs: 10, now: () => now });
  now = 109; budget.check();
  now = 110;
  assert.throws(() => budget.check(), error => error instanceof CounterfactBudgetError && error.message.includes('time budget'));
});

// Ловит бюджет, который можно обнулить/сломать NaN и тем самым отключить предохранитель.
it('нулевые, отрицательные и нечисловые лимиты и шаги отклоняются', () => {
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => createCounterfactBudget({ maxSteps: value }), CounterfactBudgetError);
    assert.throws(() => createCounterfactBudget({ timeoutMs: value }), CounterfactBudgetError);
    assert.throws(() => createCounterfactBudget({ maxRssBytes: value }), CounterfactBudgetError);
    assert.throws(() => createCounterfactBudget().step(value), CounterfactBudgetError);
  }
});

// Перехваченная внутри тела ошибка лимита всё равно должна сделать запуск неуспешным.
it('сценарий не может скрыть превышение бюджета локальным catch', async () => {
  await withFlag('1', () => {
    assert.throws(() => counterfact(budget => {
      try { budget.step(2); } catch { /* Внешний check обязан помнить превышение. */ }
    }, { maxSteps: 1 }), CounterfactBudgetError);
  });
});

// R382: PGlite уже может занимать больше гигабайта — ограничиваем только добавленное сценарием.
it('большая исходная память не расходует бюджет, прирост ровно гигабайт допустим', () => {
  const initial = 2 * 1024 ** 3;
  let rss = initial;
  const budget = createCounterfactBudget({ now: () => 0, rss: () => rss });
  budget.step();
  rss = initial + 1024 ** 3;
  budget.check();
  rss++;
  assert.throws(() => budget.check(), error => error instanceof CounterfactBudgetError && error.message === 'Counterfact RSS budget exceeded');
});

// Ловит off-by-one пользовательского предела и попытку спрятать уже замеченный перерасход освобождением памяти.
it('свой предел прироста допускает границу, но отказ после лишнего байта необратим', () => {
  const initial = 2 * 1024 ** 3;
  let rss = initial;
  const budget = createCounterfactBudget({ maxRssBytes: 16, now: () => 0, rss: () => rss });
  rss += 16;
  budget.step();
  rss++;
  let failure: unknown;
  assert.throws(() => budget.check(), error => {
    failure = error;
    return error instanceof CounterfactBudgetError && error.message === 'Counterfact RSS budget exceeded';
  });
  rss = initial - 1;
  assert.throws(() => budget.check(), error => error === failure);
  assert.throws(() => budget.step(), error => error === failure);
});

// База не должна плавать после GC или наследоваться от ранее выполненного контрфакта.
it('снижение RSS не сдвигает базу, а следующий контрфакт начинает с текущей памяти', async () => {
  await withFlag('1', () => {
    const initial = 2 * 1024 ** 3;
    let rss = initial;
    const limits = { maxRssBytes: 100, now: () => 0, rss: () => rss };
    assert.equal(counterfact(budget => {
      rss = initial - 50; budget.check();
      rss = initial + 100; budget.check();
      return 'первый';
    }, limits), 'первый');
    rss = initial + 500;
    assert.equal(counterfact(budget => {
      rss += 100; budget.check();
      return 'второй';
    }, limits), 'второй');
  });
});

// Синхронное тело без step всё равно проверяется на выходе, но не теряет допустимый результат.
it('проверка после синхронного тела замечает рост RSS без явного шага', async () => {
  await withFlag('1', () => {
    for (const growth of [100, 101]) {
      let rss = 2 * 1024 ** 3;
      const run = () => counterfact(() => { rss += growth; return 17; }, {
        maxRssBytes: 100, now: () => 0, rss: () => rss,
      });
      if (growth === 100) assert.equal(run(), 17);
      else assert.throws(run, error => error instanceof CounterfactBudgetError && error.message === 'Counterfact RSS budget exceeded');
    }
  });
});

// Promise не должен вернуть успех, если перерасход произошёл после await; реальную память не выделяем.
it('проверка после асинхронного тела замечает рост RSS после ожидания', async () => {
  await withFlag('1', async () => {
    for (const growth of [100, 101]) {
      let rss = 2 * 1024 ** 3;
      const run = async () => counterfact(async () => {
        await Promise.resolve(); rss += growth; return 42;
      }, { maxRssBytes: 100, now: () => 0, rss: () => rss });
      if (growth === 100) assert.equal(await run(), 42);
      else await assert.rejects(run, error => error instanceof CounterfactBudgetError && error.message === 'Counterfact RSS budget exceeded');
    }
  });
});
