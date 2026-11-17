import { counterfact as gatedCounterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as money from './gameMoneyRules.js';
import * as actual from './gameWheelRules.js';
import type { StakeBlock } from './gameMoneyRules.js';
import type { WheelBetRefusal, WheelStakeRow } from './gameWheelRules.js';

type Rules = typeof actual;
type Mutation = { from: string; to: string };
const source = readFileSync(new URL('./gameWheelRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function load(raw: string): Rules {
  const module = { exports: {} };
  // Настоящий модуль целиком и настоящие чистые зависимости; ни базы, ни браузера, ни правок приложения.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports,
    require(id: string) {
      if (id === 'node:crypto') return crypto;
      if (id === '@gusvoice/shared') return shared;
      if (id === './gameMoneyRules.js') return money;
      assert.fail(`R328 подготовка: неожиданный импорт ${id}`);
    },
  }, { timeout: 2_000 });
  return module.exports as Rules;
}

function counterfact(check: (rules: Rules) => void, mutations: Mutation | Mutation[]): void {
  check(actual);
  check(load(source));
  for (const { from, to } of Array.isArray(mutations) ? mutations : [mutations]) {
    gatedCounterfact(() => {
assert.equal(source.split(from).length, 2, `R328 подготовка: единственный якорь ${from}`);
    const changed = source.replace(from, to);
    assert.notEqual(changed, source, 'R328 подготовка: мутант действительно меняет модуль');
    assert.throws(() => check(load(changed)), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.startsWith('R328 проверка:'),
    'мутант обязан краснеть на адресной проверке поведения, не на импорте или синтаксисе');
});
    check(load(source)); // После каждого мутанта независимо поднимается новый исходный модуль.
  }
}

const seed = '0123456789abcdef'.repeat(4); // Синтетическое публичное зерно, не секрет живого раунда.
const lockAt = new Date('2026-10-28T16:00:30.000Z');
const settleAt = new Date('2026-10-28T16:00:36.000Z');
const settledAt = new Date('2026-10-28T16:00:37.000Z');
const bets: WheelStakeRow[] = [{ userId: 'a', pick: '5', amount: 7 }];
const live = (state = 'open') => ({ id: 'round', state, lockAt, settleAt: null as Date | null,
  data: { commit: 'public-commit', seed, sector: 0, jackpotHit: true, privateFuture: 'not-public' } as Record<string, unknown> });
const result = () => ({ id: 'round', state: 'settled', settledAt: settledAt as Date | null,
  data: { sector: 0, seed, commit: 'public-commit', jackpotHit: true, jackpotPaid: 3,
    winners: [{ userId: 'a', pick: 5, payout: 40 }], privateFuture: 'not-public' } as Record<string, unknown> });
const digest = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest();

describe('R328 зерно проверяется настоящими байтами SHA256', () => {
  it('обещание — точный hex SHA256 своего домена с идентификатором и зерном', () => {
    // Нелатинский roundId различает UTF-8 и ошибочную однобайтовую кодировку.
    counterfact(r => {
      for (const round of ['round', 'раунд-🪿', 'another-round']) {
        for (const value of [seed, 'abcdef0123456789'.repeat(4)]) {
          const expected = digest(`gv-wheel-commit:${round}:${value}`).toString('hex');
          assert.equal(r.wheelCommit(round, value), expected, 'R328 проверка: точное обещание SHA256');
          assert.match(r.wheelCommit(round, value), /^[0-9a-f]{64}$/, 'R328 проверка: нижний hex без потери байтов');
        }
      }
    }, [
      { from: 'sha256(wheelCommitInput(roundId, seedHex))', to: 'sha256(wheelSectorInput(roundId, seedHex))' },
      { from: ".update(text, 'utf8')", to: ".update(text, 'latin1')" },
    ]);
  });

  it('сектор берётся из байтов отдельного секторного домена, не из обещания', () => {
    counterfact(r => {
      for (let i = 0; i < 64; i++) {
        const id = `sector-${i}`;
        const bytes = digest(`gv-wheel-sector:${id}:${seed}`);
        assert.equal(r.wheelOutcome(id, seed).sector, shared.sectorFromHash(bytes), 'R328 проверка: сектор из настоящих байтов');
      }
    }, { from: 'sha256(wheelSectorInput(roundId, seedHex))', to: 'sha256(wheelCommitInput(roundId, seedHex))' });
  });

  it('срыв сундука и отсутствие срыва воспроизводятся по своему домену, независимо от сектора', () => {
    // Фиксированный поиск гарантирует проверку true и false, а не только частого отсутствия джекпота.
    const ids = Array.from({ length: 4_000 }, (_, i) => `jackpot-${i}`);
    const hit = ids.find(id => shared.jackpotFromHash(digest(`gv-wheel-jackpot:${id}:${seed}`))
      && !shared.jackpotFromHash(digest(`gv-wheel-sector:${id}:${seed}`)));
    const miss = ids.find(id => !shared.jackpotFromHash(digest(`gv-wheel-jackpot:${id}:${seed}`)));
    assert.ok(hit && miss, 'R328 подготовка: корпус содержит оба исхода и различает домены');
    counterfact(r => {
      for (const id of [hit, miss, ...ids.slice(0, 100)]) {
        assert.equal(r.wheelOutcome(id, seed).jackpotHit, shared.jackpotFromHash(digest(`gv-wheel-jackpot:${id}:${seed}`)),
          'R328 проверка: джекпот из собственного SHA256');
      }
    }, [
      { from: 'sha256(wheelJackpotInput(roundId, seedHex))', to: 'sha256(wheelSectorInput(roundId, seedHex))' },
      { from: 'jackpotHit: jackpotFromHash(new Uint8Array(sha256(wheelJackpotInput(roundId, seedHex))))', to: 'jackpotHit: false' },
    ]);
  });
});

describe('R328 живое колесо раскрывает только согласованный DTO', () => {
  for (const state of ['open', 'locked']) it(`${state}: точный белый список не выпускает зерно и data целиком`, () => {
    // Новое приватное поле data тоже не должно автоматически стать частью публичного протокола.
    counterfact(r => {
      const row = live(state);
      if (state === 'locked') row.settleAt = settleAt;
      const dto = r.wheelRoundDto(row, bets);
      assert.deepEqual(normal(dto), { id: 'round', state, lockAt: lockAt.toISOString(),
        settleAt: state === 'locked' ? settleAt.toISOString() : null, commit: 'public-commit',
        sector: state === 'locked' ? 0 : null, bets: [{ userId: 'a', pick: 5, amount: 7 }] },
      'R328 проверка: точный безопасный живой DTO');
      assert.equal(JSON.stringify(dto).includes(seed), false, 'R328 проверка: зерно отсутствует во всём JSON');
    }, [
      { from: '    bets: wheelBets(stakes),', to: '    bets: wheelBets(stakes), data: row.data,' },
      { from: '    bets: wheelBets(stakes),', to: '    bets: wheelBets(stakes), seed: data.seed,' },
    ]);
  });

  it('сектор скрыт до блокировки даже при уже записанном значении в data', () => {
    counterfact(r => {
      assert.equal(r.wheelRoundDto(live(), [])?.sector, null, 'R328 проверка: open не раскрывает сектор');
      assert.equal(r.wheelRoundDto(live('locked'), [])?.sector, 0, 'R328 проверка: locked раскрывает нулевой сектор');
    }, { from: "row.state === 'locked' && typeof data.sector === 'number'", to: "typeof data.sector === 'number'" });
  });

  it('завершённые, отменённые и неизвестные состояния не маскируются под живое колесо', () => {
    counterfact(r => {
      for (const state of ['settled', 'cancelled', 'unknown', '']) {
        assert.equal(r.wheelRoundDto(live(state), []), null, 'R328 проверка: только open и locked живые');
      }
      assert.ok(r.wheelRoundDto(live(), []), 'R328 проверка: настоящий open принят');
    }, { from: "(row.state !== 'open' && row.state !== 'locked')", to: 'false' });
  });

  it('без времени блокировки DTO отклоняется, но нулевой сектор не считается пропавшим', () => {
    counterfact(r => {
      assert.equal(r.wheelRoundDto({ ...live(), lockAt: null }, []), null, 'R328 проверка: нет обязательного lockAt');
      assert.equal(r.wheelRoundDto(live('locked'), [])?.sector, 0, 'R328 проверка: сектор ноль полноценный');
    }, { from: "if ((row.state !== 'open' && row.state !== 'locked') || !row.lockAt) return null;",
      to: "if ((row.state !== 'open' && row.state !== 'locked') || !row.lockAt || row.data.sector === 0) return null;" });
  });

  it('неверные необязательные commit и sector заменяются безопасными значениями', () => {
    counterfact(r => {
      const row = { ...live('locked'), data: { seed, commit: 17, sector: '0' } };
      assert.equal(r.wheelRoundDto(row, [])?.commit, '', 'R328 проверка: нестроковое обещание не уходит в провод');
      assert.equal(r.wheelRoundDto(row, [])?.sector, null, 'R328 проверка: строковый сектор не число');
      assert.equal(r.wheelRoundDto(live('locked'), [])?.commit, 'public-commit', 'R328 проверка: строковое обещание сохранено');
    }, { from: "sector: row.state === 'locked' && typeof data.sector === 'number' ? data.sector : null,",
      to: "sector: row.state === 'locked' ? data.sector : null," });
  });
});

describe('R328 итог раскрывает зерно только рассчитанного раунда', () => {
  it('итог выдаёт точные публичные поля с зерном и победителями, но без служебного data', () => {
    counterfact(r => {
      assert.deepEqual(normal(r.wheelResultDto(result())), { id: 'round', sector: 0, seed, commit: 'public-commit',
        jackpotHit: true, jackpotPaid: 3, settledAt: settledAt.toISOString(), winners: [{ userId: 'a', pick: 5, payout: 40 }] },
      'R328 проверка: полный белый список итога с раскрытым зерном');
    }, [
      { from: '    seed: data.seed,', to: "    seed: ''," },
      { from: '    seed: data.seed,', to: '    seed: data.seed, data: row.data,' },
    ]);
  });

  it('до settled, без settledAt, без числового сектора или строкового зерна результата нет', () => {
    counterfact(r => {
      for (const state of ['open', 'locked', 'cancelled']) {
        assert.equal(r.wheelResultDto({ ...result(), state }), null, 'R328 проверка: ещё не рассчитанный раунд скрыт');
      }
      assert.equal(r.wheelResultDto({ ...result(), settledAt: null }), null, 'R328 проверка: нет времени итога');
      for (const data of [{ seed, sector: '0' }, { seed, sector: undefined }, { sector: 0, seed: 17 }, { sector: 0 }]) {
        assert.equal(r.wheelResultDto({ ...result(), data }), null, 'R328 проверка: обязательные данные итога проверены');
      }
      assert.ok(r.wheelResultDto(result()), 'R328 проверка: полноценный итог принят');
    }, [
      { from: "row.state !== 'settled' || ", to: '' },
      { from: " || typeof data.sector !== 'number'", to: '' },
      { from: " || typeof data.seed !== 'string'", to: '' },
    ]);
  });

  it('старый итог без необязательных полей даёт нулевую выплату, пустых победителей и строгий boolean', () => {
    counterfact(r => {
      const dto = r.wheelResultDto({ ...result(), data: { sector: 0, seed, commit: 1, jackpotHit: 'true', jackpotPaid: '3', winners: {} } });
      assert.deepEqual(normal(dto), { id: 'round', sector: 0, seed, commit: '', jackpotHit: false, jackpotPaid: 0,
        settledAt: settledAt.toISOString(), winners: [] }, 'R328 проверка: безопасные значения отсутствующего итога');
    }, [
      { from: 'jackpotHit: data.jackpotHit === true,', to: 'jackpotHit: Boolean(data.jackpotHit),' },
      { from: "jackpotPaid: typeof data.jackpotPaid === 'number' ? data.jackpotPaid : 0,", to: 'jackpotPaid: data.jackpotPaid,' },
      { from: 'winners: Array.isArray(data.winners) ? data.winners : [],', to: 'winners: data.winners ?? [],' },
    ]);
  });
});

describe('R328 список ставок безопасно преобразует хранимый выбор', () => {
  it('все пять разрешённых строковых чисел превращаются в числа с точным белым списком полей', () => {
    counterfact(r => {
      const rows = shared.WHEEL_PICKS.map((pick, i) => ({ userId: `u${i}`, pick: String(pick), amount: i + 1, privateExtra: seed }));
      assert.deepEqual(normal(r.wheelBets(rows)), shared.WHEEL_PICKS.map((pick, i) => ({ userId: `u${i}`, pick, amount: i + 1 })),
        'R328 проверка: публичные ставки и числовой выбор');
    }, { from: 'out.push({ userId: s.userId, pick, amount: s.amount });', to: 'out.push({ ...s, pick });' });
  });

  it('возвращённая ставка исчезает, незаполненный и null refundedAt не скрывают настоящую', () => {
    counterfact(r => {
      assert.deepEqual(normal(r.wheelBets([{ ...bets[0], refundedAt: settledAt }, bets[0], { ...bets[0], userId: 'b', refundedAt: null }])),
        [{ userId: 'a', pick: 5, amount: 7 }, { userId: 'b', pick: 5, amount: 7 }], 'R328 проверка: возвращённая ставка не показывается');
    }, { from: 's.refundedAt || !isWheelPick(pick)', to: '!isWheelPick(pick)' });
  });

  it('пустой, дробный и неизвестный выбор не попадают в список рядом с корректной ставкой', () => {
    counterfact(r => {
      const invalid = ['', '0', '-1', '2', '1.5', '21', 'NaN', 'Infinity', 'jackpot'];
      assert.deepEqual(normal(r.wheelBets([...invalid.map(pick => ({ userId: 'bad', pick, amount: 1 })), ...bets])),
        [{ userId: 'a', pick: 5, amount: 7 }], 'R328 проверка: только разрешённый выбор');
    }, { from: 's.refundedAt || !isWheelPick(pick)', to: 's.refundedAt' });
  });
});

describe('R328 план расчёта сохраняет деньги и доли всех участников', () => {
  it('выплата каждой ставки в исходном порядке равна общему wheelPayout для всех секторов', () => {
    counterfact(r => {
      const rows = shared.WHEEL_PICKS.flatMap(pick => [1, 3, 7, 13].map(amount => ({ userId: `${pick}-${amount}`, pick: String(pick), amount })));
      rows.push({ userId: 'bad', pick: '2', amount: 1 });
      for (let sector = 0; sector < 25; sector++) {
        const plan = r.wheelSettlePlan(rows, sector, false, 0);
        assert.deepEqual(Array.from(plan.payouts), rows.map(s => shared.isWheelPick(Number(s.pick))
          ? shared.wheelPayout(Number(s.pick) as shared.WheelPick, s.amount, sector) : 0), 'R328 проверка: общие выплаты без перестановки');
      }
    }, { from: 'wheelPayout(pick, s.amount, sector)', to: 'wheelPayout(pick, s.amount, (sector + 1) % 25)' });
  });

  it('джекпот делится по сумме разных ставок человека, включая полностью проигравшего', () => {
    const rows = [{ userId: 'a', pick: '5', amount: 1 }, { userId: 'a', pick: '20', amount: 2 },
      { userId: 'b', pick: '1', amount: 3 }, { userId: 'c', pick: '3', amount: 6 }];
    counterfact(r => {
      const plan = r.wheelSettlePlan(rows, 0, true, 1200);
      assert.deepEqual(normal(plan.jackpotShares), [{ userId: 'a', coins: 3 }, { userId: 'b', coins: 3 }, { userId: 'c', coins: 6 }],
        'R328 проверка: все участники и сумма их ставок, а не только победители');
      assert.equal(plan.jackpotPaid, 12, 'R328 проверка: все целые доли суммированы');
    }, [
      { from: 'for (const s of stakes) totals.set(s.userId, (totals.get(s.userId) ?? 0) + s.amount);',
        to: 'for (const [i, s] of stakes.entries()) if (payouts[i] > 0) totals.set(s.userId, (totals.get(s.userId) ?? 0) + s.amount);' },
      { from: '(totals.get(s.userId) ?? 0) + s.amount', to: 's.amount' },
    ]);
  });

  it('порядок долей стабилен по userId, а не зависит от порядка поступления ставок', () => {
    counterfact(r => {
      const rows = [{ userId: 'z', pick: '1', amount: 1 }, { userId: 'a', pick: '3', amount: 1 }];
      assert.deepEqual(normal(r.wheelSettlePlan(rows, 0, true, 400).jackpotShares), [{ userId: 'a', coins: 2 }, { userId: 'z', coins: 2 }],
        'R328 проверка: стабильный порядок получателей');
    }, { from: '.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))', to: '' });
  });

  it('без срыва весь сундук остаётся на месте, даже если есть выигравшая ставка', () => {
    counterfact(r => {
      const plan = r.wheelSettlePlan(bets, 0, false, 1001);
      assert.deepEqual(normal(plan.jackpotShares), [], 'R328 проверка: без срыва нет долей');
      assert.equal(plan.jackpotPaid, 0, 'R328 проверка: без срыва нет выплаты');
      assert.equal(plan.leftCents, 1001, 'R328 проверка: весь сундук сохраняется');
    }, { from: 'const split = jackpotHit', to: 'const split = true' });
  });

  it('дробные доли вниз оставляют точный остаток в сотых, а не в монетах', () => {
    counterfact(r => {
      const rows = [{ userId: 'a', pick: '1', amount: 1 }, { userId: 'b', pick: '3', amount: 2 }];
      const plan = r.wheelSettlePlan(rows, 0, true, 1001);
      assert.deepEqual(normal(plan.jackpotShares), [{ userId: 'a', coins: 3 }, { userId: 'b', coins: 6 }], 'R328 проверка: доли вниз');
      assert.equal(plan.leftCents, 101, 'R328 проверка: 101 сотая остаётся в сундуке');
      assert.equal(plan.jackpotPaid * 100 + plan.leftCents, 1001, 'R328 проверка: сохранение сундука');
    }, { from: 'leftCents: split.leftCents,', to: 'leftCents: Math.floor(split.leftCents / 100),' });
  });

  for (const winning of [false, true]) it(`${winning ? 'отрицательная' : 'положительная'} доля дома учитывает взнос без лишнего удержания с игроков`, () => {
    // Крупный выигрыш оплачивает дом: отрицательную fee нельзя обрезать до нуля.
    counterfact(r => {
      const plan = r.wheelSettlePlan([{ userId: 'a', pick: winning ? '20' : '1', amount: 100 }], 2, false, 150);
      assert.equal(plan.pool, 100, 'R328 проверка: банк равен ставкам');
      assert.equal(plan.paid, winning ? 2300 : 0, 'R328 проверка: итог ставок');
      assert.equal(plan.jackpotCents, 150, 'R328 проверка: взнос из доли дома');
      assert.equal(plan.fee, winning ? -2201.5 : 98.5, 'R328 проверка: точная знаковая доля дома');
      assert.equal(plan.pool * 100, plan.paid * 100 + plan.jackpotCents + Math.round(plan.fee * 100),
        'R328 проверка: банк распределён без создания монет');
    }, winning
      ? { from: 'fee: (pool * 100 - paid * 100 - jackpotCents) / 100,', to: 'fee: Math.max(0, (pool * 100 - paid * 100 - jackpotCents) / 100),' }
      : { from: 'fee: (pool * 100 - paid * 100 - jackpotCents) / 100,', to: 'fee: (pool * 100 - paid * 100) / 100,' });
  });

  it('взнос округляется на каждой ставке, а не один раз на суммарном банке', () => {
    counterfact(r => {
      const rows = [{ userId: 'a', pick: '1', amount: 1 }, { userId: 'b', pick: '3', amount: 1 }];
      const plan = r.wheelSettlePlan(rows, 0, false, 2);
      assert.equal(plan.pool, 2, 'R328 проверка: полный банк');
      assert.equal(plan.jackpotCents, 2, 'R328 проверка: два взноса по одной сотой');
      assert.equal(plan.fee, 1.98, 'R328 проверка: взнос не округляется повторно');
    }, { from: 'stakes.reduce((sum, s) => sum + jackpotCentsOf(s.amount), 0)', to: 'jackpotCentsOf(pool)' });
  });

  it('список победителей содержит положительные выплаты ставок и отдельные доли джекпота', () => {
    counterfact(r => {
      const rows = [{ userId: 'a', pick: '5', amount: 1 }, { userId: 'b', pick: '1', amount: 1 }];
      assert.deepEqual(normal(r.wheelSettlePlan(rows, 0, true, 400).winners), [
        { userId: 'a', pick: 5, payout: 5 }, { userId: 'a', pick: 'jackpot', payout: 2 }, { userId: 'b', pick: 'jackpot', payout: 2 },
      ], 'R328 проверка: победители по ставкам и сундуку без нулевых проигрышей');
    }, [
      { from: 'if (payouts[i] > 0)', to: 'if (payouts[i] >= 0)' },
      { from: "for (const x of split.shares) winners.push({ userId: x.userId, pick: 'jackpot', payout: x.coins });", to: '' },
    ]);
  });

  it('пустой раунд не платит и сохраняет весь сундук даже при срыве', () => {
    counterfact(r => {
      for (const hit of [false, true]) assert.deepEqual(normal(r.wheelSettlePlan([], 0, hit, 1001)), {
        payouts: [], jackpotShares: [], leftCents: 1001, pool: 0, paid: 0, jackpotPaid: 0, jackpotCents: 0, fee: 0, winners: [],
      }, 'R328 проверка: без участников нет выплат и потерь сундука');
    }, { from: 'leftCents: split.leftCents,', to: 'leftCents: stakes.length ? split.leftCents : 0,' });
  });

  it('отрицательный сундук не превращается в долг участников при отсутствии срыва', () => {
    counterfact(r => {
      const plan = r.wheelSettlePlan(bets, 0, false, -1);
      assert.equal(plan.leftCents, 0, 'R328 проверка: остаток сундука не отрицательный');
      assert.equal(plan.jackpotPaid, 0, 'R328 проверка: пустой сундук ничего не платит');
    }, { from: ': { shares: [], leftCents: Math.max(0, poolCents) };', to: ': { shares: [], leftCents: poolCents };' });
  });
});

describe('R328 отказы сохраняют каждый код и нужный HTTP-статус', () => {
  const mappings: Array<[StakeBlock, WheelBetRefusal]> = [
    ['games-off', 'games-off'], ['bot', 'bot'], ['opted-out', 'opted-out'], ['games-opted-out', 'games-opted-out'],
    ['bad-amount', 'bad-amount'], ['bad-pick', 'bad-pick'], ['over-bet-max', 'over-bet-max'], ['poor', 'poor'],
    ['loss-limit', 'loss-limit'], ['round-closed', 'round_locked'], ['duplicate', 'duplicate_pick'],
  ];
  for (const [input, expected] of mappings) it(`отказ ${input} передаётся клиенту как ${expected}`, () => {
    counterfact(r => {
      assert.equal(r.wheelRefusalOf(input), expected, 'R328 проверка: адресное соответствие кода отказа');
      assert.equal(typeof r.WHEEL_REFUSAL_TEXT[expected], 'string', 'R328 проверка: есть запасной текст отказа');
      assert.ok(r.WHEEL_REFUSAL_TEXT[expected].length > 0, 'R328 проверка: текст не пустой');
    }, input === 'round-closed'
      ? { from: "if (block === 'round-closed') return 'round_locked';", to: "if (block === 'round-closed') return 'round-closed';" }
      : input === 'duplicate'
        ? { from: "if (block === 'duplicate') return 'duplicate_pick';", to: "if (block === 'duplicate') return 'duplicate';" }
        : { from: '  return block;', to: `  return block === '${input}' ? 'busy' : block;` });
  });

  const statuses: Array<[WheelBetRefusal, number]> = [
    ['bad-amount', 400], ['bad-pick', 400], ['games-off', 403], ['not_in_voice', 403], ['bot', 403],
    ['opted-out', 403], ['games-opted-out', 403], ['busy', 429], ['cooldown', 409], ['round_locked', 409],
    ['duplicate_pick', 409], ['over-bet-max', 409], ['poor', 409], ['loss-limit', 409], ['round-closed', 409], ['duplicate', 409],
  ];
  for (const [code, expected] of statuses) it(`код ${code} имеет HTTP ${expected}`, () => {
    counterfact(r => {
      assert.equal(r.wheelRefusalStatus(code), expected, 'R328 проверка: адресный HTTP-статус');
      assert.ok(r.WHEEL_REFUSAL_TEXT[code].length > 0, 'R328 проверка: клиент получит человеческий текст');
    }, { from: 'export function wheelRefusalStatus(code: WheelBetRefusal): number {',
      to: `export function wheelRefusalStatus(code: WheelBetRefusal): number {\n  if (code === '${code}') return ${expected === 400 ? 409 : 400};` });
  });
});

describe('R328 пауза и сумма сундука на границах', () => {
  it('за миллисекунду до конца паузы новый раунд ещё запрещён, ровно в срок и после разрешён', () => {
    counterfact(r => {
      const until = settledAt.getTime() + 10_000;
      assert.equal(shared.WHEEL_COOLDOWN_MS, 10_000, 'R328 проверка: договорная пауза десять секунд');
      assert.equal(r.wheelCooldownUntil(settledAt, new Date(until - 1))?.toISOString(), new Date(until).toISOString(),
        'R328 проверка: последняя запрещённая миллисекунда');
      assert.equal(r.wheelCooldownUntil(settledAt, new Date(until)), null, 'R328 проверка: ровно в срок можно');
      assert.equal(r.wheelCooldownUntil(settledAt, new Date(until + 1)), null, 'R328 проверка: после срока можно');
      assert.equal(settledAt.toISOString(), '2026-10-28T16:00:37.000Z', 'R328 проверка: входная дата не изменена');
    }, [
      { from: 'until > now.getTime()', to: 'until >= now.getTime()' },
      { from: 'lastSettledAt.getTime() + WHEEL_COOLDOWN_MS', to: 'lastSettledAt.getTime() + WHEEL_COOLDOWN_MS - 1' },
    ]);
  });

  it('без прошлого итога паузы нет даже в самом начале времени', () => {
    counterfact(r => {
      assert.equal(r.wheelCooldownUntil(null, new Date(0)), null, 'R328 проверка: первое колесо не ждёт');
      assert.ok(r.wheelCooldownUntil(settledAt, settledAt), 'R328 проверка: сразу после итога пауза есть');
    }, { from: 'if (!lastSettledAt) return null;', to: 'if (!lastSettledAt) return new Date(now.getTime() + WHEEL_COOLDOWN_MS);' });
  });

  it('сундук показывает целые монеты вниз на 99/100/101 и не показывает отрицательный долг', () => {
    counterfact(r => {
      for (const [cents, coins] of [[-101, 0], [-1, 0], [0, 0], [1, 0], [99, 0], [100, 1], [101, 1], [199, 1], [200, 2]]) {
        assert.equal(r.wheelJackpotCoins(cents), coins, 'R328 проверка: целые неотрицательные монеты сундука');
      }
    }, [
      { from: 'return Math.max(0, Math.floor(cents / 100));', to: 'return Math.max(0, Math.ceil(cents / 100));' },
      { from: 'return Math.max(0, Math.floor(cents / 100));', to: 'return Math.floor(cents / 100);' },
    ]);
  });
});
