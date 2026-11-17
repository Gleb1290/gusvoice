import { counterfact as runCounterfact } from '../test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as actual from './gameLaunch.js';

type Rules = typeof actual;
type Mutation = { from: string; to: string };
const source = readFileSync(new URL('./gameLaunch.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function load(raw: string): Rules {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports,
    require(id: string) { assert.fail(`R343 подарок setup: неожиданный импорт ${id}`); },
  }, { timeout: 2_000 });
  return module.exports as Rules;
}

function counterfact(check: (rules: Rules) => void, mutations: Mutation | Mutation[]): void {
  check(actual);
  check(load(source));
  for (const { from, to } of Array.isArray(mutations) ? mutations : [mutations]) {

    runCounterfact(() => {
      assert.equal(source.split(from).length, 2, `R343 подарок setup: единственный якорь ${from}`);
      const changed = source.replace(from, to);
      assert.notEqual(changed, source, 'R343 подарок setup: мутант действительно меняет модуль');
      assert.throws(() => check(load(changed)), (error: unknown) =>
        error instanceof assert.AssertionError && error.message.startsWith('R343 подарок:'),
      'мутант обязан краснеть на адресном утверждении хоста, не на setup/импорте/синтаксисе');
    });
    check(load(source));
  }
}

describe('R343 общие числа и проверка подарка за запуск игр', () => {
  it('ползунок задаёт 0…2000 шагом 50 и безопасное начальное значение 500', () => {
    counterfact(r => {
      assert.deepEqual({ ...r.GAMES_LAUNCH_GIFT }, { min: 0, max: 2000, step: 50, default: 500 },
        'R343 подарок: согласованные числа ползунка');
      assert.equal(r.isGamesLaunchGift(r.GAMES_LAUNCH_GIFT.default), true, 'R343 подарок: начальная сумма допустима');
    }, { from: 'default: 500', to: 'default: 550' });
  });

  it('срок карточки равен ровно семи суткам, а не неделе в секундах', () => {
    counterfact(r => {
      assert.equal(r.GAMES_LAUNCH_RECENT_MS, 604_800_000, 'R343 подарок: семь суток в миллисекундах');
    }, { from: '7 * 24 * 60 * 60 * 1000', to: '7 * 24 * 60 * 60' });
  });

  it('принимаются все 41 положение ползунка, включая 0 и ровно 2000', () => {
    // Подарок 0 всё равно запускает игры: его нельзя отвергать как «пустую» сумму.
    counterfact(r => {
      for (let gift = 0; gift <= 2000; gift += 50) {
        assert.equal(r.isGamesLaunchGift(gift), true, `R343 подарок: разрешённое положение ${gift}`);
      }
    }, [
      { from: 'n >= GAMES_LAUNCH_GIFT.min', to: 'n > GAMES_LAUNCH_GIFT.min' },
      { from: 'n <= GAMES_LAUNCH_GIFT.max', to: 'n < GAMES_LAUNCH_GIFT.max' },
    ]);
  });

  it('по обе стороны диапазона отрицательные и слишком большие суммы отклоняются', () => {
    counterfact(r => {
      for (const gift of [-50, -1, 2001, 2050]) {
        assert.equal(r.isGamesLaunchGift(gift), false, `R343 подарок: вне диапазона ${gift}`);
      }
      for (const gift of [0, 50, 1950, 2000]) {
        assert.equal(r.isGamesLaunchGift(gift), true, `R343 подарок: внутри диапазона ${gift}`);
      }
    }, [
      { from: 'n >= GAMES_LAUNCH_GIFT.min', to: 'true' },
      { from: 'n <= GAMES_LAUNCH_GIFT.max', to: 'true' },
    ]);
  });

  it('между делениями целые и дробные суммы отвергаются, сами деления принимаются', () => {
    counterfact(r => {
      for (const gift of [1, 25, 49, 50.5, 51, 499, 501, 1999, NaN, Infinity, -Infinity]) {
        assert.equal(r.isGamesLaunchGift(gift), false, `R343 подарок: не положение ползунка ${gift}`);
      }
      for (const gift of [0, 50, 500, 2000]) assert.equal(r.isGamesLaunchGift(gift), true, 'R343 подарок: парная допустимая сумма');
    }, [
      { from: 'n % GAMES_LAUNCH_GIFT.step === 0', to: 'true' },
      { from: 'step: 50', to: 'step: 25' },
    ]);
  });

  it('числовые строки, null, булевы значения и объекты не приводятся к сумме', () => {
    counterfact(r => {
      for (const gift of ['0', '50', '2000', '', null, undefined, false, true, 0n, {}, [], [50], new Number(50), Symbol('50')]) {
        assert.equal(r.isGamesLaunchGift(gift), false, 'R343 подарок: принимается только примитив number');
      }
      assert.equal(r.isGamesLaunchGift(50), true, 'R343 подарок: парное настоящее число принимается');
    }, { from: "typeof n === 'number' &&\n    Number.isInteger(n) &&\n    n >= GAMES_LAUNCH_GIFT.min &&\n    n <= GAMES_LAUNCH_GIFT.max &&\n    n % GAMES_LAUNCH_GIFT.step === 0",
      to: "Number.isInteger(Number(n)) &&\n    Number(n) >= GAMES_LAUNCH_GIFT.min &&\n    Number(n) <= GAMES_LAUNCH_GIFT.max &&\n    Number(n) % GAMES_LAUNCH_GIFT.step === 0" });
  });
});
