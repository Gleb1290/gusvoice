import { counterfact as gatedCounterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as coins from './coinRules.js';
import * as actual from './gameMoneyRules.js';
import type { GamesLaunchRefusal } from './gameMoneyRules.js';

type Rules = typeof actual;
type Mutation = { from: string; to: string };
const source = readFileSync(new URL('./gameMoneyRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function load(raw: string): Rules {
  const module = { exports: {} };
  // Целый модуль и настоящая чистая зависимость: ни env, ни транзакций, ни копии проверяемого алгоритма.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports,
    require(id: string) {
      if (id === './coinRules.js') return coins;
      assert.fail(`R343 запуск setup: неожиданный импорт ${id}`);
    },
  }, { timeout: 2_000 });
  return module.exports as Rules;
}

function counterfact(check: (rules: Rules) => void, mutations: Mutation | Mutation[]): void {
  check(actual);
  check(load(source));
  for (const { from, to } of Array.isArray(mutations) ? mutations : [mutations]) {
    gatedCounterfact(() => {
assert.equal(source.split(from).length, 2, `R343 запуск setup: единственный якорь ${from}`);
    const changed = source.replace(from, to);
    assert.notEqual(changed, source, 'R343 запуск setup: мутант действительно меняет модуль');
    assert.throws(() => check(load(changed)), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.startsWith('R343 запуск:'),
    'мутант обязан краснеть на адресном утверждении хоста, не на setup/импорте/синтаксисе');
});
    check(load(source));
  }
}

describe('R343 замок игр защищает включение, а не сохранение настроек', () => {
  it('все четыре сочетания флага и супер-админа закрывают игры только обычному человеку при закрытом флаге', () => {
    counterfact(r => {
      const cases = [
        { gamesOpen: false, superAdmin: false, locked: true },
        { gamesOpen: false, superAdmin: true, locked: false },
        { gamesOpen: true, superAdmin: false, locked: false },
        { gamesOpen: true, superAdmin: true, locked: false },
      ];
      for (const c of cases) assert.equal(r.gamesLockedFor(c.gamesOpen, c.superAdmin), c.locked,
        `R343 запуск: замок gamesOpen=${c.gamesOpen} superAdmin=${c.superAdmin}`);
    }, [
      { from: 'return !gamesOpen && !superAdmin;', to: 'return !gamesOpen || !superAdmin;' },
      { from: 'return !gamesOpen && !superAdmin;', to: 'return !gamesOpen;' },
      { from: 'return !gamesOpen && !superAdmin;', to: 'return !superAdmin;' },
    ]);
  });

  it('все 12 состояний переключателя запрещают лишь новое включение под замком', () => {
    // Панель шлёт все настройки целиком: уже включённые игры не должны запрещать смену названия валюты.
    counterfact(r => {
      const cases = [
        { locked: true, wasEnabled: false, want: true, refuse: true },
        { locked: true, wasEnabled: false, want: false, refuse: false },
        { locked: true, wasEnabled: false, want: undefined, refuse: false },
        { locked: true, wasEnabled: true, want: true, refuse: false },
        { locked: true, wasEnabled: true, want: false, refuse: false },
        { locked: true, wasEnabled: true, want: undefined, refuse: false },
        { locked: false, wasEnabled: false, want: true, refuse: false },
        { locked: false, wasEnabled: false, want: false, refuse: false },
        { locked: false, wasEnabled: false, want: undefined, refuse: false },
        { locked: false, wasEnabled: true, want: true, refuse: false },
        { locked: false, wasEnabled: true, want: false, refuse: false },
        { locked: false, wasEnabled: true, want: undefined, refuse: false },
      ];
      for (const c of cases) assert.equal(r.refuseGamesToggle(c), c.refuse,
        `R343 запуск: переключатель locked=${c.locked} was=${c.wasEnabled} want=${c.want}`);
    }, [
      { from: 'return c.locked && c.want === true && !c.wasEnabled;', to: 'return c.want === true && !c.wasEnabled;' },
      { from: 'return c.locked && c.want === true && !c.wasEnabled;', to: 'return c.locked && c.want === true;' },
      { from: 'return c.locked && c.want === true && !c.wasEnabled;', to: 'return c.locked && c.want !== false && !c.wasEnabled;' },
      { from: 'return c.locked && c.want === true && !c.wasEnabled;', to: 'return c.locked && c.want === false && !c.wasEnabled;' },
    ]);
  });

  it('восемь состояний запуска сохраняют приоритет замок → право → включённая экономика', () => {
    counterfact(r => {
      const cases: Array<{ locked: boolean; canManage: boolean; economyEnabled: boolean; reason: GamesLaunchRefusal | null }> = [
        { locked: true, canManage: false, economyEnabled: false, reason: 'games-locked' },
        { locked: true, canManage: false, economyEnabled: true, reason: 'games-locked' },
        { locked: true, canManage: true, economyEnabled: false, reason: 'games-locked' },
        { locked: true, canManage: true, economyEnabled: true, reason: 'games-locked' },
        { locked: false, canManage: false, economyEnabled: false, reason: 'forbidden' },
        { locked: false, canManage: false, economyEnabled: true, reason: 'forbidden' },
        { locked: false, canManage: true, economyEnabled: false, reason: 'economy-off' },
        { locked: false, canManage: true, economyEnabled: true, reason: null },
      ];
      for (const c of cases) assert.equal(r.launchRefusal(c), c.reason,
        `R343 запуск: отказ locked=${c.locked} manage=${c.canManage} economy=${c.economyEnabled}`);
    }, [
      { from: "if (c.locked) return 'games-locked';", to: "if (false) return 'games-locked';" },
      { from: "if (!c.canManage) return 'forbidden';", to: "if (false) return 'forbidden';" },
      { from: "if (!c.economyEnabled) return 'economy-off';", to: "if (false) return 'economy-off';" },
      { from: "if (c.locked) return 'games-locked';\n  if (!c.canManage) return 'forbidden';",
        to: "if (!c.canManage) return 'forbidden';\n  if (c.locked) return 'games-locked';" },
      { from: "if (!c.canManage) return 'forbidden';\n  if (!c.economyEnabled) return 'economy-off';",
        to: "if (!c.economyEnabled) return 'economy-off';\n  if (!c.canManage) return 'forbidden';" },
    ]);
  });

  it('все пять отказов запуска имеют стабильные HTTP-коды и непустое объяснение', () => {
    counterfact(r => {
      const expected: Record<GamesLaunchRefusal, number> = {
        'games-locked': 403, forbidden: 403, 'economy-off': 409, 'already-launched': 409, 'bad-gift': 400,
      };
      assert.deepEqual(Object.keys(r.GAMES_LAUNCH_REFUSAL_TEXT).sort(), Object.keys(expected).sort(), 'R343 запуск: полный перечень отказов');
      for (const [reason, status] of Object.entries(expected)) {
        const code = reason as GamesLaunchRefusal;
        assert.equal(r.gamesLaunchRefusalStatus(code), status, `R343 запуск: HTTP-код ${code}`);
        assert.ok(r.GAMES_LAUNCH_REFUSAL_TEXT[code].trim().length > 0, `R343 запуск: объяснение ${code}`);
      }
    }, [
      { from: "if (code === 'bad-gift') return 400;", to: "if (code === 'bad-gift') return 403;" },
      { from: "if (code === 'games-locked' || code === 'forbidden') return 403;", to: "if (code === 'games-locked') return 403;" },
      { from: "if (code === 'games-locked' || code === 'forbidden') return 403;\n  return 409;",
        to: "if (code === 'games-locked' || code === 'forbidden') return 403;\n  return 400;" },
    ]);
  });
});

describe('R343 подарок получает каждый подходящий участник голоса ровно один раз', () => {
  it('неподходящие исключаются, подходящие принимаются; пустой голос и полный отказ дают пустой список', () => {
    counterfact(r => {
      // Принадлежность серверу, бот и оба отказа вычисляются вызывающим; здесь проверяется применение его eligible.
      const voice = ['member-b', 'bot', 'outsider', 'economy-out', 'games-out', 'member-a'];
      const allowed = new Set(['member-a', 'member-b']);
      const input = Object.freeze([...voice]);
      assert.deepEqual(Array.from(r.launchRecipients(input, id => allowed.has(id))), ['member-a', 'member-b'],
        'R343 запуск: остаются только подходящие участники');
      assert.deepEqual(Array.from(r.launchRecipients(input, () => false)), [], 'R343 запуск: ни один не прошёл');
      assert.deepEqual(Array.from(r.launchRecipients([], () => true)), [], 'R343 запуск: пустой голос не создаёт получателей');
      assert.deepEqual(Array.from(input), voice, 'R343 запуск: снимок presence не меняется');
    }, { from: 'return [...new Set(inVoice)].filter(eligible).sort();', to: 'return [...new Set(inVoice)].sort();' });
  });

  it('повторы в снимке голоса не дублируют подарок и проверку пригодности', () => {
    counterfact(r => {
      const checked: string[] = [];
      const ids = r.launchRecipients(['b', 'a', 'b', 'a', 'c', 'c'], id => { checked.push(id); return id !== 'c'; });
      assert.deepEqual(Array.from(ids), ['a', 'b'], 'R343 запуск: подарок каждому один раз');
      assert.deepEqual(checked, ['b', 'a', 'c'], 'R343 запуск: повторы убраны до проверки пригодности');
    }, { from: 'return [...new Set(inVoice)].filter(eligible).sort();', to: 'return [...inVoice].filter(eligible).sort();' });
  });

  it('получатели упорядочены независимо от порядка presence, исходный список не сортируется', () => {
    counterfact(r => {
      const first = ['z', 'b', 'a'];
      const second = ['b', 'a', 'z'];
      assert.deepEqual(Array.from(r.launchRecipients(first, () => true)), ['a', 'b', 'z'], 'R343 запуск: канонический порядок первого снимка');
      assert.deepEqual(Array.from(r.launchRecipients(second, () => true)), ['a', 'b', 'z'], 'R343 запуск: канонический порядок второго снимка');
      assert.deepEqual(first, ['z', 'b', 'a'], 'R343 запуск: первый снимок не отсортирован на месте');
      assert.deepEqual(second, ['b', 'a', 'z'], 'R343 запуск: второй снимок не отсортирован на месте');
    }, { from: 'return [...new Set(inVoice)].filter(eligible).sort();', to: 'return [...new Set(inVoice)].filter(eligible);' });
  });

  it('games.launch — отдельная эмиссия, не заработок и не игровой проигрыш', () => {
    counterfact(r => {
      assert.equal(r.GAMES_LAUNCH_REASON, 'games.launch', 'R343 запуск: согласованная причина журнала');
      assert.equal((coins.EARNED_REASONS as readonly string[]).includes(r.GAMES_LAUNCH_REASON), false, 'R343 запуск: подарок не заработок');
      assert.equal(r.GAME_LEDGER_REASONS.includes(r.GAMES_LAUNCH_REASON), false, 'R343 запуск: подарок не ставка и не выигрыш');
      assert.equal(r.GAME_LOSS_REASONS.includes(r.GAMES_LAUNCH_REASON), false, 'R343 запуск: подарок не расширяет предел проигрыша');
    }, { from: "GAMES_LAUNCH_REASON = 'games.launch'", to: "GAMES_LAUNCH_REASON = 'voice'" });
  });
});
