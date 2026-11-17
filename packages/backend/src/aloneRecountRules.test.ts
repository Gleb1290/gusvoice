import assert from 'node:assert/strict';
import { counterfact } from '../../shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { AccrualSample, AccrualState, EconomySettings, ReplaySample } from './coinRules.js';

type Coins = typeof import('./coinRules.js');
type Recount = typeof import('./aloneRecountRules.js');
type Rules = { coins: Coins; recount: Recount };
const coinSource = readFileSync(new URL('./coinRules.ts', import.meta.url), 'utf8');
const recountSource = readFileSync(new URL('./aloneRecountRules.ts', import.meta.url), 'utf8');

// Два настоящих модуля целиком. Единственная разрешённая зависимость перерасчёта — настоящая
// арифметика; ни БД, ни окружение сервера, ни переписанная в тесте формула сюда не попадают.
// Type-only импорты позволяют также прогнать этот файл native Node 24 без цепочки .js → .ts.
function load(coinsInput = coinSource, recountInput = recountSource): Rules {
  function module<T>(input: string, filename: string, dependencies: Record<string, unknown>): T {
    const exports: Record<string, unknown> = {};
    const js = ts.transpileModule(input, { fileName: filename, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    runInNewContext(js, { exports, require: (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `Неописанный импорт R318: ${id}`);
      return dependencies[id];
    } }, { filename: `${filename}.r318.vm.js`, timeout: 2_000 });
    return exports as T;
  }
  const coins = module<Coins>(coinsInput, 'coinRules.ts', {});
  return { coins, recount: module<Recount>(recountInput, 'aloneRecountRules.ts', { './coinRules.js': coins }) };
}
const api = load();
const settings = (patch: Partial<EconomySettings> = {}): EconomySettings => ({
  ratePer5min: 20, alonePercent: 50, companyPercent: 150, dailyCap: 0, aloneCap: 0,
  decayAfterMinutes: 5, decayPercent: 50, mutedPercent: 100, deafenedPercent: 50,
  awayPercent: 25, payoutMinutes: 5, compensateOnRaise: false, ...patch,
});
const sample = (patch: Partial<AccrualSample> = {}): AccrualSample => ({
  seconds: 300, peers: 0, muted: false, deafened: false, away: false, ...patch,
});
const state = (patch: Partial<AccrualState> = {}): AccrualState => ({
  pendingMilli: 0, pendingSeconds: 0, baseMilli: 0, deltaPresenceMilli: 0,
  deltaCompanyMilli: 0, deltaDecayMilli: 0, secondsToday: 0, earnedToday: 0,
  aloneEarnedMilli: 0, ...patch,
});
const cutoff = new Date('2026-10-28T12:00:00Z');
const autumnFrom = '2026-08-31T21:00:00.000Z';
const since = new Date('2026-10-02T10:00:00Z');
const history = (userId = 'waiter', peers = [0, 0, 1], patch: Partial<AccrualSample> = {}): ReplaySample[] =>
  peers.map((n, i) => ({ ...sample({ peers: n, ...patch }), userId,
    at: new Date(Date.UTC(2026, 9, 27, 9, i * 5)) }));
// У VM свои прототипы Array/Object; сравниваем DTO, а не происхождение их прототипа.
const dto = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('R318: окно перерасчёта ограничено реально оплаченной частью сезона', () => {
  it('экономику ещё не включали — нет окна ни с null, ни без отметки', () => {
    assert.equal(api.recount.recountWindow(cutoff, 'quarter', null), null);
    assert.equal(api.recount.recountWindow(cutoff, 'quarter', undefined), null);
  });

  it('включение до сезона не открывает доступ к прошлому сезону', () => {
    const w = api.recount.recountWindow(cutoff, 'quarter', new Date('2026-06-01T00:00:00Z'));
    assert.ok(w);
    assert.equal(w.from.toISOString(), autumnFrom);
    assert.equal(w.to.getTime(), cutoff.getTime());
    assert.equal(w.seasonId, 'autumn-2026');
  });

  it('включение внутри сезона обрезает начало, но не сдвигает cutoff на сейчас', () => {
    const w = api.recount.recountWindow(cutoff, 'quarter', since);
    assert.ok(w);
    assert.equal(w.from.getTime(), since.getTime());
    assert.equal(w.to.getTime(), cutoff.getTime());
  });

  it('включение ровно на старте сезона сохраняет полное окно', () => {
    const w = api.recount.recountWindow(cutoff, 'quarter', new Date(autumnFrom));
    assert.ok(w);
    assert.equal(w.from.toISOString(), autumnFrom);
  });

  it('включение за миллисекунду до cutoff ещё даёт непустое окно', () => {
    const w = api.recount.recountWindow(cutoff, 'quarter', new Date(cutoff.getTime() - 1));
    assert.ok(w);
    assert.equal(w.to.getTime() - w.from.getTime(), 1);
  });

  it('включение ровно в cutoff и после него не создаёт пустую или обратную доплату', () => {
    assert.equal(api.recount.recountWindow(cutoff, 'quarter', cutoff), null);
    assert.equal(api.recount.recountWindow(cutoff, 'quarter', new Date(cutoff.getTime() + 1)), null);
  });

  it('помесячный сезон начинается в московскую полночь, а не в квартале', () => {
    const w = api.recount.recountWindow(cutoff, 'month', new Date(autumnFrom));
    assert.ok(w);
    assert.equal(w.from.toISOString(), '2026-09-30T21:00:00.000Z');
    assert.equal(w.seasonId, 'm2026-10');
    assert.equal(w.to.getTime(), cutoff.getTime());
  });

  it('по обе стороны московской границы месяца окно относится к правильному месяцу', () => {
    const old = api.recount.recountWindow(new Date('2026-10-31T20:59:59.999Z'), 'month', since);
    assert.ok(old);
    assert.equal(old.seasonId, 'm2026-10');
    // Ровно в полночь новый сезон ещё пуст, за миллисекунду после — уже нет.
    assert.equal(api.recount.recountWindow(new Date('2026-10-31T21:00:00Z'), 'month', since), null);
    const next = api.recount.recountWindow(new Date('2026-10-31T21:00:00.001Z'), 'month', since);
    assert.ok(next);
    assert.equal(next.seasonId, 'm2026-11');
    assert.equal(next.from.toISOString(), '2026-10-31T21:00:00.000Z');
  });

  it('московская граница зимы переключает и сезон, и нижнюю границу', () => {
    const before = api.recount.recountWindow(new Date('2026-11-30T20:59:59.999Z'), 'quarter', since);
    assert.ok(before);
    assert.equal(before.seasonId, 'autumn-2026');
    assert.equal(api.recount.recountWindow(new Date('2026-11-30T21:00:00Z'), 'quarter', since), null);
    const winter = api.recount.recountWindow(new Date('2026-11-30T21:00:00.001Z'), 'quarter', since);
    assert.ok(winter);
    assert.equal(winter.seasonId, 'winter-2027');
    assert.equal(winter.from.toISOString(), '2026-11-30T21:00:00.000Z');
  });
});

describe('R318: доплата — положительная разница двух настоящих replay', () => {
  it('ожидание одному перед компанией возвращает только разницу, не всю новую выплату', () => {
    assert.deepEqual(dto(api.recount.recountDiffs(history(), settings())), [
      { userId: 'waiter', amount: 20, coinsNew: 40, coinsOld: 20 },
    ]);
  });

  it('пришедший сразу в компанию получает нулевую разницу и не попадает в доплату', () => {
    assert.equal(api.coins.replay(history('company', [1, 1, 1]), settings(), 'legacy')[0].coins, 35);
    assert.equal(api.coins.replay(history('company', [1, 1, 1]), settings(), 'v2')[0].coins, 35);
    assert.deepEqual(dto(api.recount.recountDiffs(history('company', [1, 1, 1]), settings())), []);
  });

  it('ожидание одному с «не слышу» не превращается в положительную доплату', () => {
    const samples = history('deaf', [0, 0], { deafened: true });
    assert.equal(api.coins.replay(samples, settings(), 'legacy')[0].coins, 7);
    assert.equal(api.coins.replay(samples, settings(), 'v2')[0].coins, 0);
    assert.deepEqual(dto(api.recount.recountDiffs(samples, settings())), []);
  });

  it('новый одиночный порог может уменьшить итог, но из кошелька ничего не забирают', () => {
    const s = settings({ aloneCap: 1 });
    const samples = history('capped', [0, 0]);
    assert.equal(api.coins.replay(samples, s, 'v2')[0].coins, 10);
    assert.equal(api.coins.replay(samples, s, 'legacy')[0].coins, 15);
    assert.deepEqual(dto(api.recount.recountDiffs(samples, s)), []);
  });

  it('без истории никто не получает подарочную строку', () => {
    assert.deepEqual(dto(api.recount.recountDiffs([], settings())), []);
  });

  it('доплаты сортируются по сумме, а равные — по пользователю, не по порядку входа', () => {
    const samples = [...history('b'), ...history('a'), ...history('z', [0, 1])]
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    assert.deepEqual(dto(api.recount.recountDiffs(samples, settings())), [
      { userId: 'a', amount: 20, coinsNew: 40, coinsOld: 20 },
      { userId: 'b', amount: 20, coinsNew: 40, coinsOld: 20 },
      { userId: 'z', amount: 10, coinsNew: 30, coinsOld: 20 },
    ]);
  });

  it('источник перерасчёта учитывается как заработок и отдельно виден в эмиссии', () => {
    assert.equal(api.recount.ALONE_RECOUNT_KIND, 'alone-2026-10');
    assert.equal(api.coins.EARNED_REASONS.includes('recount'), true);
    const totals = api.coins.economyTotals([{ reason: 'recount', total: 20, count: 1 }]);
    assert.equal(totals.recount, 20);
    assert.equal(totals.minted, 20);
    assert.equal(totals.accrued, 0);
    assert.equal(api.coins.economyTotals([]).recount, 0);
  });
});

describe('R318: legacy сохраняет прежнее правило только для перерасчёта', () => {
  it('одиночный срез тратит затухание и получает штраф на точной границе ступени', () => {
    const before = api.coins.accrue(sample(), state({ secondsToday: 299 }), settings(), 'legacy');
    const at = api.coins.accrue(sample(), state({ secondsToday: 300 }), settings(), 'legacy');
    assert.equal(before.coins, 10);
    assert.equal(at.coins, 5);
    assert.equal(before.next.secondsToday, 599);
    assert.equal(at.next.secondsToday, 600);
    assert.equal(at.breakdown?.decayMilli, -5_000);
  });

  it('даже неоплаченный одиночный срез увеличивает прежний счётчик секунд', () => {
    const r = api.coins.accrue(sample(), state({ secondsToday: 300 }), settings({ alonePercent: 0 }), 'legacy');
    assert.equal(r.coins, 0);
    assert.equal(r.next.secondsToday, 600);
    assert.equal(r.next.pendingSeconds, 300);
    assert.equal(r.next.pendingMilli, 0);
  });

  it('legacy игнорирует выбранный aloneCap, v2 останавливается ровно на пороге', () => {
    const wallet = state({ aloneEarnedMilli: 1_000 });
    const s = settings({ aloneCap: 1 });
    assert.equal(api.coins.accrue(sample(), wallet, s, 'legacy').coins, 10);
    assert.equal(api.coins.accrue(sample(), wallet, s, 'v2').coins, 0);
    assert.equal(api.coins.accrue(sample(), state({ aloneEarnedMilli: 999 }), s, 'v2').coins, 10);
    assert.equal(api.coins.accrue(sample(), wallet, settings({ aloneCap: 0 }), 'v2').coins, 10);
  });

  it('legacy оплачивает одному «не слышу» процентом, а не новым запретом', () => {
    const r = api.coins.accrue(sample({ deafened: true }), state(), settings(), 'legacy');
    assert.equal(r.coins, 5);
    assert.equal(r.next.secondsToday, 300);
    assert.equal(api.coins.accrue(sample({ deafened: true }), state(), settings(), 'v2').coins, 0);
    assert.equal(api.coins.accrue(sample({ deafened: false }), state(), settings(), 'v2').coins, 10);
  });

  it('replay передаёт выбранное правило во все срезы, а не только первый', () => {
    assert.deepEqual(dto(api.coins.replay(history(), settings(), 'legacy')), [
      { userId: 'waiter', coins: 20, seconds: 900 },
    ]);
    assert.deepEqual(dto(api.coins.replay(history(), settings(), 'v2')), [
      { userId: 'waiter', coins: 40, seconds: 900 },
    ]);
  });

  it('новые сутки по МСК сбрасывают одиночное затухание legacy, не только v2', () => {
    const samples = history('night', [0, 0]);
    samples[0].at = new Date('2026-10-27T20:59:59.999Z');
    samples[1].at = new Date('2026-10-27T21:00:00Z');
    assert.equal(api.coins.replay(samples, settings(), 'legacy')[0].coins, 20);
    assert.equal(api.coins.replay(history('day', [0, 0]), settings(), 'legacy')[0].coins, 15);
  });

  it('обычный вызов accrue и replay остаётся v2, legacy надо выбрать явно', () => {
    const wallet = state({ secondsToday: 300 });
    assert.equal(api.coins.accrue(sample(), wallet, settings()).coins, 10);
    assert.deepEqual(dto(api.coins.accrue(sample(), wallet, settings())),
      dto(api.coins.accrue(sample(), wallet, settings(), 'v2')));
    assert.equal(api.coins.replay(history(), settings())[0].coins, 40);
    assert.deepEqual(dto(api.coins.replay(history(), settings())), dto(api.coins.replay(history(), settings(), 'v2')));
  });
});

function killed(target: 'coins' | 'recount', anchor: string, replacement: string,
  check: (rules: Rules) => void, marker: string, actual: number, expected: number): void {
  check(load()); // Без зелёного оригинала отказ мутанта ничего не доказывает.
  counterfact(() => {
  const source = target === 'coins' ? coinSource : recountSource;
  assert.equal(source.split(anchor).length - 1, 1, `Уникальный якорь R318: ${anchor}`);
  const changed = source.replace(anchor, replacement);
  const mutant = target === 'coins' ? load(changed) : load(coinSource, changed);
  // Загрузка за пределами assert.throws: поломка require/синтаксиса не убивает мутанта.
  assert.throws(() => check(mutant), (err: unknown) => err instanceof assert.AssertionError
    && err.message.includes(marker) && err.actual === actual && err.expected === expected);
  });
}

describe('R318: original-first мутанты полного модуля падают на точных денежных и оконных проверках', () => {
  it('нулевая разница не должна стать строкой доплаты из-за >=', () => {
    killed('recount', 'if (amount > 0)', 'if (amount >= 0)', (rules) => {
      assert.equal(rules.recount.recountDiffs(history('company', [1]), settings()).length,
        0, 'R318 нулевой плюс');
    }, 'R318 нулевой плюс', 1, 0);
  });

  it('потеря rule при вызове accrue внутри replay обнаруживается по старой выплате', () => {
    killed('coins', 'accrue(sample, acc, s, rule)', 'accrue(sample, acc, s)', (rules) => {
      assert.equal(rules.coins.replay(history(), settings(), 'legacy')[0].coins,
        20, 'R318 передача legacy');
    }, 'R318 передача legacy', 40, 20);
  });

  it('инверсия выбора legacy не должна включить одиночное исключение в старом правиле', () => {
    killed('coins', "const alone = rule === 'v2' && sample.peers <= 0;",
      "const alone = rule === 'legacy' && sample.peers <= 0;", (rules) => {
        assert.equal(rules.coins.accrue(sample(), state({ secondsToday: 300 }), settings(), 'legacy').coins,
          5, 'R318 старое затухание');
      }, 'R318 старое затухание', 10, 5);
  });

  it('два одинаковых новых replay вместо старого и нового не должны стереть доплату', () => {
    killed('recount', "replay(samples, s, 'legacy')", "replay(samples, s, 'v2')", (rules) => {
      assert.equal(rules.recount.recountDiffs(history(), settings()).length,
        1, 'R318 две разные истории');
    }, 'R318 две разные истории', 0, 1);
  });

  it('min вместо max не должен включить неоплаченное время до запуска экономики', () => {
    killed('recount', 'accrualSince > seasonFrom ? accrualSince : seasonFrom',
      'accrualSince < seasonFrom ? accrualSince : seasonFrom', (rules) => {
        const w = rules.recount.recountWindow(cutoff, 'quarter', since);
        assert.ok(w);
        assert.equal(w.from.getTime(), since.getTime(), 'R318 позднее включение');
      }, 'R318 позднее включение', new Date(autumnFrom).getTime(), since.getTime());
  });

  it('строгое > вместо >= не должно разрешить пустое окно на cutoff', () => {
    killed('recount', 'if (from >= cutoff)', 'if (from > cutoff)', (rules) => {
      assert.equal(Number(rules.recount.recountWindow(cutoff, 'quarter', cutoff) === null),
        1, 'R318 пустое окно');
    }, 'R318 пустое окно', 0, 1);
  });

  it('сброс помесячной настройки на квартал обнаруживается по московскому началу октября', () => {
    killed('recount', 'seasonId(cutoff, length)', "seasonId(cutoff, 'quarter')", (rules) => {
      const w = rules.recount.recountWindow(cutoff, 'month', new Date(autumnFrom));
      assert.ok(w);
      assert.equal(w.from.getTime(), new Date('2026-09-30T21:00:00Z').getTime(), 'R318 месяц не квартал');
    }, 'R318 месяц не квартал', new Date(autumnFrom).getTime(), new Date('2026-09-30T21:00:00Z').getTime());
  });
});
