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

type Rules = typeof actual;
type Mutation = { from: string; to: string };
const source = readFileSync(new URL('./gameWheelRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const naturalGuard = 'if (natural || !flag || poolCents < 100) return { jackpotHit: natural, forced: false };';
const forcedDto = '...(data.forced === true ? { forced: true } : {}),';
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function load(raw: string): Rules {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports,
    require(id: string) {
      if (id === 'node:crypto') return crypto;
      if (id === '@gusvoice/shared') return shared;
      if (id === './gameMoneyRules.js') return money;
      assert.fail(`R343 forced setup: неожиданный импорт ${id}`);
    },
  }, { timeout: 2_000 });
  return module.exports as Rules;
}

function counterfact(check: (rules: Rules) => void, mutations: Mutation | Mutation[]): void {
  check(actual);
  check(load(source));
  for (const { from, to } of Array.isArray(mutations) ? mutations : [mutations]) {
    gatedCounterfact(() => {
assert.equal(source.split(from).length, 2, `R343 forced setup: единственный якорь ${from}`);
    const changed = source.replace(from, to);
    assert.notEqual(changed, source, 'R343 forced setup: мутант действительно меняет модуль');
    assert.throws(() => check(load(changed)), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.startsWith('R343 forced:'),
    'мутант обязан краснеть на адресном утверждении хоста, не на setup/импорте/синтаксисе');
});
    check(load(source));
  }
}

describe('R343 принудительный джекпот не маскируется под честный', () => {
  it('без флага даже миллион сотых не превращает естественный промах в джекпот', () => {
    counterfact(r => {
      assert.deepEqual(normal(r.wheelForcedJackpot(false, false, 1_000_000)), { jackpotHit: false, forced: false },
        'R343 forced: выключенный флаг сохраняет промах');
      assert.deepEqual(normal(r.wheelForcedJackpot(false, true, 1_000_000)), { jackpotHit: true, forced: true },
        'R343 forced: парный включённый флаг навязывает срыв');
    }, { from: naturalGuard, to: 'if (natural || poolCents < 100) return { jackpotHit: natural, forced: false };' });
  });

  it('естественный джекпот при включённом флаге остаётся честным', () => {
    counterfact(r => {
      assert.deepEqual(normal(r.wheelForcedJackpot(true, true, 1_000_000)), { jackpotHit: true, forced: false },
        'R343 forced: честный срыв не помечается принудительным');
      assert.deepEqual(normal(r.wheelForcedJackpot(false, true, 1_000_000)), { jackpotHit: true, forced: true },
        'R343 forced: только навязанный поверх промаха срыв принудительный');
    }, { from: naturalGuard, to: 'if (!flag || poolCents < 100) return { jackpotHit: natural, forced: false };' });
  });

  it('ровно 100 сотых уже достаточно, чтобы навязать джекпот', () => {
    counterfact(r => {
      assert.deepEqual(normal(r.wheelForcedJackpot(false, true, 100)), { jackpotHit: true, forced: true },
        'R343 forced: одна целая монета доступна');
      assert.deepEqual(normal(r.wheelForcedJackpot(false, true, 99)), { jackpotHit: false, forced: false },
        'R343 forced: парные 99 сотых ещё не монета');
    }, { from: naturalGuard, to: 'if (natural || !flag || poolCents <= 100) return { jackpotHit: natural, forced: false };' });
  });

  it('99 сотых не навязывают джекпот, а 100 уже навязывают', () => {
    counterfact(r => {
      assert.deepEqual(normal(r.wheelForcedJackpot(false, true, 99)), { jackpotHit: false, forced: false },
        'R343 forced: сундук без целой монеты не срывается принудительно');
      assert.deepEqual(normal(r.wheelForcedJackpot(false, true, 100)), { jackpotHit: true, forced: true },
        'R343 forced: следующая сотая разрешает срыв');
    }, { from: naturalGuard, to: 'if (natural || !flag || poolCents < 99) return { jackpotHit: natural, forced: false };' });
  });

  it('граница измеряется сотыми, а не монетами: 0/1/98/99 против 100/101/10000', () => {
    counterfact(r => {
      for (const cents of [0, 1, 98, 99]) assert.deepEqual(normal(r.wheelForcedJackpot(false, true, cents)),
        { jackpotHit: false, forced: false }, `R343 forced: недостаточный сундук ${cents}`);
      for (const cents of [100, 101, 10_000]) assert.deepEqual(normal(r.wheelForcedJackpot(false, true, cents)),
        { jackpotHit: true, forced: true }, `R343 forced: достаточный сундук ${cents}`);
    }, { from: naturalGuard, to: 'if (natural || !flag || poolCents < 10_000) return { jackpotHit: natural, forced: false };' });
  });

  it('естественный результат не подавляется пустым сундуком или выключенным dev-флагом', () => {
    counterfact(r => {
      for (const flag of [false, true]) {
        for (const cents of [0, 1, 99, 100, 101, 1_000_000]) {
          assert.deepEqual(normal(r.wheelForcedJackpot(true, flag, cents)), { jackpotHit: true, forced: false },
            `R343 forced: честный срыв flag=${flag} cents=${cents}`);
        }
      }
    }, { from: naturalGuard,
      to: 'if (natural || !flag || poolCents < 100) return { jackpotHit: natural && poolCents >= 100, forced: false };' });
  });
});

const settledAt = new Date('2026-10-29T09:00:00.000Z');
const result = () => ({ id: 'round-forced', state: 'settled', settledAt,
  data: { sector: 0, seed: 'synthetic-public-seed', commit: 'public-commit', jackpotHit: true, jackpotPaid: 7,
    winners: [{ userId: 'member', pick: 'jackpot', payout: 7 }], privateField: 'not-public' } as Record<string, unknown> });

describe('R343 итог колеса сообщает принудительность только явно навязанного раунда', () => {
  it('data.forced=true добавляет forced:true к точному публичному DTO', () => {
    counterfact(r => {
      const row = result();
      row.data.forced = true;
      assert.deepEqual(normal(r.wheelResultDto(row)), {
        id: 'round-forced', sector: 0, seed: 'synthetic-public-seed', commit: 'public-commit', jackpotHit: true, jackpotPaid: 7,
        forced: true, settledAt: settledAt.toISOString(), winners: [{ userId: 'member', pick: 'jackpot', payout: 7 }],
      }, 'R343 forced: точный итог с предупреждением, без произвольных приватных полей');
    }, { from: forcedDto, to: '...{},' });
  });

  it('при отсутствующем и false forced ключа нет вовсе, даже со значением undefined', () => {
    counterfact(r => {
      for (const explicit of [false, true]) {
        const row = result();
        if (explicit) row.data.forced = false;
        const dto = r.wheelResultDto(row);
        assert.ok(dto, 'R343 forced: честный рассчитанный итог существует');
        assert.equal(Object.hasOwn(dto, 'forced'), false, 'R343 forced: честный DTO не содержит даже пустой ключ forced');
        assert.equal(dto.jackpotHit, true, 'R343 forced: честный джекпот не теряется');
      }
      const forced = result();
      forced.data.forced = true;
      assert.equal(r.wheelResultDto(forced)?.forced, true, 'R343 forced: парный навязанный итог всё же помечается');
    }, [
      { from: forcedDto, to: 'forced: data.forced === true,' },
      { from: forcedDto, to: '...(data.forced === true ? { forced: true } : { forced: undefined }),' },
    ]);
  });

  it('строки, числа и объекты в повреждённом data.forced не выдаются за буквальное true', () => {
    counterfact(r => {
      for (const value of ['true', 'false', 1, 0, {}, [], null, undefined]) {
        const row = result();
        row.data.forced = value;
        const dto = r.wheelResultDto(row);
        assert.ok(dto, 'R343 forced: прочие правильные данные остаются читаемыми');
        assert.equal(Object.hasOwn(dto, 'forced'), false, 'R343 forced: только буквальный true добавляет ключ');
      }
      const forced = result();
      forced.data.forced = true;
      assert.equal(r.wheelResultDto(forced)?.forced, true, 'R343 forced: буквальный true принимается');
    }, { from: forcedDto, to: '...(data.forced ? { forced: true } : {}),' });
  });
});
