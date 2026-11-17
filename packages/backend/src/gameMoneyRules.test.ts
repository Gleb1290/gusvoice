import { counterfact as gatedCounterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as coinRules from './coinRules.js';
import * as actualRules from './gameMoneyRules.js';
import type { LossLimitState, PotStake, StakeCheck } from './gameMoneyRules.js';

type Rules = typeof actualRules;
const source = readFileSync(new URL('./gameMoneyRules.ts', import.meta.url), 'utf8');

// Каждый контрфакт исполняет НАСТОЯЩИЙ модуль целиком: приложение на диске не переписывается.
function load(raw: string): Rules {
  const module = { exports: {} as Rules };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    module, exports: module.exports,
    require: (id: string) => {
      assert.equal(id, './coinRules.js', 'закрытый импорт правил игр');
      return coinRules;
    },
  });
  return module.exports;
}

function counterfact(check: (rules: Rules) => void, anchor: string, replacement: string): void {
  check(actualRules);
  check(load(source));
  gatedCounterfact(() => {
assert.equal(source.split(anchor).length, 2, `единственный якорь мутанта: ${anchor}`);
const changed = source.replace(anchor, replacement);
assert.notEqual(changed, source);
assert.throws(() => check(load(changed)), (error: unknown) => error instanceof assert.AssertionError,
    'тот же поведенческий сценарий обязан отвергнуть мутант');
});
  // Независимый откат: после мутанта заново загружается неизменённый исходный модуль.
  check(load(source));
}

const good: StakeCheck = {
  economyEnabled: true, gamesEnabled: true, isBot: false, optedOut: false, gamesOptOut: false,
  amount: 10, pick: 'red', betMax: 300, balance: 1000, lossToday: 0, effectiveLimit: 3000,
};
const now = new Date('2026-10-28T18:25:00.000Z');
const midnight = '2026-10-28T21:00:00.000Z';
const state = (lossLimit: number | null, raise: number | null = null, raiseAt: Date | null = null): LossLimitState =>
  ({ lossLimit, raise, raiseAt });

function expectState(result: LossLimitState, limit: number | null, raise: number | null, at: string | null): void {
  assert.equal(result.lossLimit, limit, 'действующий личный предел');
  assert.equal(result.raise, raise, 'значение ждущего повышения');
  assert.equal(result.raiseAt?.toISOString() ?? null, at, 'срок ждущего повышения');
}

describe('R326 журнал игр: проигрыш не превращается в заработок', () => {
  it('отрицательный итог журнала даёт проигрыш, нулевой и положительный — ноль', () => {
    // Выигрыш сверх ставок не должен давать отрицательный проигрыш и расширять дневной предел.
    counterfact(r => {
      assert.equal(r.lossTodayFrom(-1), 1);
      assert.equal(r.lossTodayFrom(1), 0, 'прибыль не становится отрицательным проигрышем');
      assert.equal(r.lossTodayFrom(0), 0);
      assert.equal(r.lossTodayFrom(-750), 750);
      assert.equal(r.lossTodayFrom(750), 0);
    }, 'return sumOfGameRowsToday < 0 ? 0 - sumOfGameRowsToday : 0;', 'return -sumOfGameRowsToday;');
  });

  it('три игры имеют ровно девять договорённых причин, и ни одна не считается заработком', () => {
    // R6: игровые деньги не растят заработок и сезон; duel.stake не является duel.bet.
    const expected = {
      wheel: { stake: 'wheel.bet', win: 'wheel.win', refund: 'wheel.refund' },
      duel: { stake: 'duel.stake', win: 'duel.win', refund: 'duel.refund' },
      prediction: { stake: 'prediction.bet', win: 'prediction.win', refund: 'prediction.refund' },
    };
    counterfact(r => {
      const earned: readonly string[] = coinRules.EARNED_REASONS;
      for (const reason of r.GAME_LEDGER_REASONS) assert.equal(earned.includes(reason), false, `${reason} не заработок`);
      assert.equal(JSON.stringify(r.GAME_KINDS), JSON.stringify(Object.keys(expected)));
      const reasons = Object.values(expected).flatMap(x => [x.stake, x.win, x.refund]);
      assert.equal(JSON.stringify(r.GAME_LEDGER_REASONS), JSON.stringify(reasons));
      assert.equal(new Set(r.GAME_LEDGER_REASONS).size, 9);
      for (const kind of ['wheel', 'duel', 'prediction'] as const) {
        assert.equal(JSON.stringify(r.gameReasons(kind)), JSON.stringify(expected[kind]));
      }
    }, "wheel: { stake: 'wheel.bet',", "wheel: { stake: 'voice',");
  });
});

describe('R326 ставка: общая причина отказа важнее следующей', () => {
  const cases: Array<{ title: string; bad: Partial<StakeCheck>; reason: string; anchor: string }> = [
    { title: 'выключенная экономика важнее бота и игр', bad: { economyEnabled: false, isBot: true }, reason: 'games-off',
      anchor: '!c.economyEnabled || !c.gamesEnabled' },
    { title: 'выключенные игры важнее бота', bad: { gamesEnabled: false, isBot: true }, reason: 'games-off',
      anchor: '!c.economyEnabled || !c.gamesEnabled' },
    { title: 'бот не играет даже при одновременном отказе от экономики', bad: { isBot: true, optedOut: true }, reason: 'bot',
      anchor: 'c.isBot' },
    { title: 'отказ от экономики важнее отказа только от игр', bad: { optedOut: true, gamesOptOut: true }, reason: 'opted-out',
      anchor: 'c.optedOut' },
    { title: 'отказ от игр важнее неверной суммы', bad: { gamesOptOut: true, amount: 0 }, reason: 'games-opted-out',
      anchor: 'c.gamesOptOut' },
    { title: 'неверная сумма важнее пустого выбора', bad: { amount: 0, pick: '' }, reason: 'bad-amount',
      anchor: '!Number.isInteger(c.amount) || c.amount <= 0' },
    { title: 'пустой выбор важнее превышения ставки', bad: { pick: '', amount: 301 }, reason: 'bad-pick',
      anchor: 'c.pick.length === 0 || c.pick.length > PICK_MAX_LENGTH' },
    { title: 'превышение ставки важнее пустого кошелька', bad: { amount: 301, balance: 0 }, reason: 'over-bet-max',
      anchor: 'c.amount > c.betMax' },
    { title: 'пустой кошелёк важнее исчерпанного предела', bad: { balance: 0, effectiveLimit: 0 }, reason: 'poor',
      anchor: 'c.amount > c.balance' },
    { title: 'проигрыш отклоняет ставку после всех прочих проверок', bad: { effectiveLimit: 9 }, reason: 'loss-limit',
      anchor: 'c.effectiveLimit !== null && c.lossToday + c.amount > c.effectiveLimit' },
  ];
  for (const c of cases) it(c.title, () => {
    // Иначе человек увидит частную денежную ошибку вместо причины, действительно закрывающей игры.
    counterfact(r => {
      assert.equal(r.stakeBlock(good), null, 'обычный участник может поставить');
      assert.equal(r.stakeBlock({ ...good, ...c.bad }), c.reason, 'приоритет причины отказа');
    }, c.anchor, 'false');
  });
});

describe('R326 ставка: обе стороны денежных и структурных границ', () => {
  it('ставка betMax−1 и betMax разрешена, betMax+1 запрещена', () => {
    // Ровно разрешённую сервером сумму нельзя случайно запретить строгим сравнением.
    counterfact(r => {
      for (const amount of [299, 300]) assert.equal(r.stakeBlock({ ...good, amount }), null);
      assert.equal(r.stakeBlock({ ...good, amount: 301 }), 'over-bet-max');
    }, 'c.amount > c.betMax', 'c.amount >= c.betMax');
  });

  it('проигрыш до предела и ровно в предел проходит, на монету больше — нет', () => {
    // Последняя разрешённая монета ещё принадлежит человеку, а не ошибке на единицу.
    counterfact(r => {
      for (const lossToday of [89, 90]) assert.equal(r.stakeBlock({ ...good, lossToday, effectiveLimit: 100 }), null);
      assert.equal(r.stakeBlock({ ...good, lossToday: 91, effectiveLimit: 100 }), 'loss-limit');
    }, 'c.lossToday + c.amount > c.effectiveLimit', 'c.lossToday + c.amount >= c.effectiveLimit');
  });

  it('нулевой серверный потолок и null снимают только предел проигрыша', () => {
    // Ноль в настройках означает отсутствие потолка, но не бесплатные ставки без проверки кошелька.
    counterfact(r => {
      const effectiveLimit = r.effectiveLossLimit(null, 0);
      assert.equal(effectiveLimit, null);
      assert.equal(r.stakeBlock({ ...good, effectiveLimit, lossToday: 1_000_000 }), null);
      assert.equal(r.stakeBlock({ ...good, effectiveLimit, balance: 9 }), 'poor');
      assert.equal(r.stakeBlock({ ...good, effectiveLimit: 0 }), 'loss-limit');
    }, 'c.effectiveLimit !== null', 'true');
  });

  it('целая положительная сумма нужна даже при богатом кошельке', () => {
    // NaN, бесконечность и дробь не должны доходить до целочисленных денежных проводок.
    counterfact(r => {
      for (const amount of [-1, 0, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(r.stakeBlock({ ...good, amount }), 'bad-amount');
      }
      assert.equal(r.stakeBlock({ ...good, amount: 1 }), null);
    }, '!Number.isInteger(c.amount) || c.amount <= 0', 'c.amount <= 0');
  });

  it('выбор длиной 63 и 64 символа принимается, пустой и 65 — нет', () => {
    // Последний допустимый символ не должен отнимать у человека корректный исход.
    counterfact(r => {
      for (const length of [63, 64]) assert.equal(r.stakeBlock({ ...good, pick: 'x'.repeat(length) }), null);
      for (const length of [0, 65]) assert.equal(r.stakeBlock({ ...good, pick: 'x'.repeat(length) }), 'bad-pick');
    }, 'c.pick.length > PICK_MAX_LENGTH', 'c.pick.length >= PICK_MAX_LENGTH');
  });

  it('баланс ровно в ставку достаточен, на монету меньше — нет', () => {
    // Нулевой остаток допустим: нельзя требовать лишнюю монету сверх ставки.
    counterfact(r => {
      for (const balance of [10, 11]) assert.equal(r.stakeBlock({ ...good, balance }), null);
      assert.equal(r.stakeBlock({ ...good, balance: 9 }), 'poor');
    }, 'c.amount > c.balance', 'c.amount >= c.balance');
  });
});

describe('R326 личный предел и отложенное повышение', () => {
  it('действует меньший предел: личный, серверный или ноль пользователя', () => {
    // Высокий личный предел не отменяет серверный, а личный ноль не означает бесконечность.
    counterfact(r => {
      for (const [personal, expected] of [[499, 499], [500, 500], [501, 500], [0, 0]]) {
        assert.equal(r.effectiveLossLimit(personal, 500), expected);
      }
      assert.equal(r.effectiveLossLimit(null, 500), 500);
      assert.equal(r.effectiveLossLimit(20, 0), 20);
      assert.equal(r.effectiveLossLimit(null, 0), null);
    }, 'Math.min(personal, server)', 'Math.max(personal, server)');
  });

  it('понижение сразу действует и отменяет ждущее повышение', () => {
    // Иначе прежнее повышение незаметно снимет только что выставленное самоограничение.
    counterfact(r => {
      expectState(r.planLossLimit(state(500, 800, new Date(midnight)), 499, 3000, now), 499, null, null);
    }, 'if (after <= before)', 'if (false)');
  });

  it('тот же предел применяется сразу и тоже отменяет повышение', () => {
    // Мутант <= → < оставил бы человеку активное повышение вместо отмены.
    counterfact(r => {
      expectState(r.planLossLimit(state(500, 800, new Date(midnight)), 500, 3000, now), 500, null, null);
    }, 'if (after <= before)', 'if (after < before)');
  });

  it('повышение на монету ждёт следующей полуночи МСК', () => {
    // Немедленное повышение делает добровольное ограничение бессмысленным в тот же вечер.
    counterfact(r => {
      expectState(r.planLossLimit(state(500), 501, 3000, now), 500, 501, midnight);
    }, 'return { lossLimit: cur.lossLimit, raise: requested, raiseAt: nextDayStart(now) };',
    'return { lossLimit: requested, raise: null, raiseAt: null };');
  });

  it('возврат к серверному пределу с меньшего личного — отложенный null', () => {
    // null — содержательное будущее значение, а не отсутствие ожидающего повышения.
    counterfact(r => {
      const planned = r.planLossLimit(state(500), null, 3000, now);
      expectState(planned, 500, null, midnight);
      const view = r.gamesView({ gamesOptOut: false, limit: planned, serverMax: 3000, lossToday: 12, now });
      assert.equal(view.lossLimitRaise?.value, null);
      assert.equal(view.lossLimitRaise?.from, midnight);
      assert.equal(view.effectiveLimit, 500);
    }, 'return { lossLimit: cur.lossLimit, raise: requested, raiseAt: nextDayStart(now) };',
    'return { lossLimit: requested, raise: null, raiseAt: null };');
  });

  it('одинаковый эффективный серверный потолок не откладывает смену личной записи', () => {
    // Сравнение сырых null и 4000 ошибочно сочло бы это настоящим повышением.
    counterfact(r => {
      expectState(r.planLossLimit(state(4000), null, 3000, now), null, null, null);
      expectState(r.planLossLimit(state(null), 4000, 3000, now), 4000, null, null);
    }, 'const after = asNumber(effectiveLossLimit(requested, serverMax));', 'const after = asNumber(requested);');
  });

  it('без серверного потолка снятие личного предела всё равно ждёт сутки', () => {
    // Безлимитный сервер не должен позволять немедленно снимать личное самоограничение.
    counterfact(r => {
      expectState(r.planLossLimit(state(500), null, 0, now), 500, null, midnight);
      expectState(r.planLossLimit(state(null), 500, 0, now), 500, null, null);
    }, 'const asNumber = (v: number | null) => v ?? Number.POSITIVE_INFINITY;',
    'const asNumber = (v: number | null) => v ?? 0;');
  });

  it('за миллисекунду до срока старый предел, ровно в срок и после — новый', () => {
    // Повышение не должно включаться раньше либо задерживаться до следующего чтения после полуночи.
    counterfact(r => {
      const pending = state(500, 600, new Date(midnight));
      expectState(r.resolveLossLimit(pending, new Date('2026-10-28T20:59:59.999Z')), 500, 600, midnight);
      for (const at of [midnight, '2026-10-28T21:00:00.001Z']) expectState(r.resolveLossLimit(pending, new Date(at)), 600, null, null);
      expectState(r.resolveLossLimit(state(500), new Date(midnight)), 500, null, null);
    }, 'now.getTime() >= s.raiseAt.getTime()', 'now.getTime() > s.raiseAt.getTime()');
  });

  it('наступивший null применяется и очищает обе отметки повышения', () => {
    // Проверка истинности raise потеряла бы отложенный переход к серверному пределу.
    counterfact(r => {
      expectState(r.resolveLossLimit(state(500, null, new Date(midnight)), new Date(midnight)), null, null, null);
    }, 'if (s.raiseAt && now.getTime()', 'if (s.raise !== null && s.raiseAt && now.getTime()');
  });

  it('новая просьба сравнивается с уже наступившим повышением', () => {
    // После полуночи 550 — понижение с 600, а не новое повышение с устаревших 500.
    counterfact(r => {
      expectState(r.planLossLimit(state(500, 600, new Date(midnight)), 550, 3000, new Date(midnight)), 550, null, null);
    }, 'const cur = resolveLossLimit(current, now);', 'const cur = current;');
  });

  it('следующий день перескакивает в полночь МСК, а не UTC', () => {
    // В 00:00 уже начались новые сутки: отсрочка должна идти до следующей, а не текущей полуночи.
    counterfact(r => {
      assert.equal(r.nextDayStart(new Date('2026-10-28T20:59:59.999Z')).toISOString(), midnight);
      assert.equal(r.nextDayStart(new Date(midnight)).toISOString(), '2026-10-29T21:00:00.000Z');
    }, 'dayStart(now).getTime() + 24 * 60 * 60 * 1000', 'dayStart(now).getTime()');
  });
});

function expectPot(r: Rules, stakes: PotStake[], percent: number, expected: number[], fee: number, refund: boolean): void {
  const result = r.splitPot(stakes, percent);
  assert.deepEqual(stakes.map(x => result.payouts.get(x.key)), expected, 'выплаты каждому участнику');
  assert.equal(result.payouts.size, stakes.length, 'все ставки присутствуют в результате');
  assert.equal(result.fee, fee, 'комиссия вместе с неразделившимся остатком');
  assert.equal(result.refundAll, refund, 'возврат отличается от выигрыша');
  assert.equal([...result.payouts.values()].reduce((a, b) => a + b, 0) + result.fee,
    stakes.reduce((a, b) => a + b.amount, 0), 'выплаты плюс сгорание равны банку');
  for (const value of result.payouts.values()) assert.ok(Number.isInteger(value) && value >= 0, 'целые неотрицательные выплаты');
}

describe('R326 банк: округление не создаёт и не прячет монеты', () => {
  it('комиссия округляется вниз до раздела банка', () => {
    // При банке 11 комиссия 10% — одна монета, ceil отнимет у единственного победителя лишнюю.
    counterfact(r => {
      expectPot(r, [{ key: 'w', amount: 2, winner: true }, { key: 'l', amount: 9, winner: false }], 10, [10, 0], 1, false);
    }, 'Math.floor((pot * pct) / 100)', 'Math.ceil((pot * pct) / 100)');
  });

  it('дробные пропорциональные выплаты округляются вниз, остаток сгорает', () => {
    // Нулевая ставка комиссии не делает неделимую монету общей выплатой сразу двум людям.
    counterfact(r => {
      expectPot(r, [{ key: 'w2', amount: 2, winner: true }, { key: 'w1', amount: 1, winner: true },
        { key: 'l', amount: 7, winner: false }], 0, [6, 3, 0], 1, false);
    }, 'Math.floor((distributable * x.amount) / winStake)', 'Math.ceil((distributable * x.amount) / winStake)');
  });

  it('нулевая комиссия выплачивает целый банк, 50% сжигают ровно половину', () => {
    // Оба разрешённых края настройки должны дойти до арифметики, а не замениться умолчанием 10%.
    counterfact(r => {
      const stakes = [{ key: 'w', amount: 3, winner: true }, { key: 'l', amount: 7, winner: false }];
      expectPot(r, stakes, 0, [10, 0], 0, false);
      expectPot(r, stakes, 50, [5, 0], 5, false);
    }, 'const distributable = pot - Math.floor((pot * pct) / 100);', 'const distributable = pot;');
  });

  it('если никто не угадал, всем возвращается своя ставка без комиссии', () => {
    // Неугаданный исход не даёт серверу права сжечь весь банк.
    counterfact(r => {
      expectPot(r, [{ key: 'a', amount: 3, winner: false }, { key: 'b', amount: 7, winner: false }], 50, [3, 7], 0, true);
      expectPot(r, [], 50, [], 0, true);
    }, 'winners.length === 0 || winners.length === stakes.length || winStake <= 0', 'false');
  });

  it('если никто не проиграл, комиссия не берётся и всем возвращаются ставки', () => {
    // Все на одном исходе ничего не выиграли друг у друга, поэтому платить комиссию не за что.
    counterfact(r => {
      expectPot(r, [{ key: 'a', amount: 3, winner: true }, { key: 'b', amount: 7, winner: true }], 50, [3, 7], 0, true);
    }, 'winners.length === 0 || winners.length === stakes.length || winStake <= 0', 'winners.length === 0 || winStake <= 0');
  });
});
