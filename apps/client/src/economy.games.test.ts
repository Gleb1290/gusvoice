import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { EconomySettingsDto, EconomyView, GamesWallet } from './economy';

const source = readFileSync(new URL('./economy.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const games: GamesWallet = { optOut: false, lossLimit: 500, lossLimitRaise: null, lossToday: 70, effectiveLimit: 500 };
function view(patch: Partial<EconomyView> = {}): EconomyView {
  return { wallet: { games }, settings: null, ...patch } as EconomyView;
}
function settings(patch: Partial<EconomySettingsDto>): EconomySettingsDto {
  return patch as EconomySettingsDto;
}
function load(raw: string): typeof import('./economy') {
  const module = { exports: {} };
  // Класс ошибки: проверка копии функции вместо настоящего модуля оставляет регрессию незамеченной.
  const js = ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  runInNewContext(js, { module, exports: module.exports,
    require(id: string) { assert.fail(`R326/подготовка/неожиданный импорт/${id}`); },
  }, { timeout: 2_000 });
  return module.exports as typeof import('./economy');
}
function mutate(needle: string, next: string): string {
  assert.equal(source.split(needle).length, 2, `R326/подготовка/уникальный якорь/${needle}`);
  return source.replace(needle, next);
}
function checkMutation(check: (raw: string) => void, needle: string, next: string, address: string): void {
  check(source);
  counterfact(() => { assert.throws(() => check(mutate(needle, next)), (error: unknown) =>
    error instanceof assert.AssertionError && error.message.split('\n')[0] === address); });
  check(source); // Независимый откат: после мутанта тот же сценарий снова проверяет исходный модуль.
}

describe('R326 gamesView: совместимость и верхние поля снимка', () => {
  it('без wallet.games блок отсутствует, с полным кошельком появляется', () => {
    checkMutation(raw => {
      const { gamesView } = load(raw);
      assert.equal(gamesView(view({ wallet: {} as EconomyView['wallet'], gamesEnabled: true })), null, 'R326/view/no-wallet');
      assert.equal(gamesView(view({ gamesEnabled: true }))?.games, games, 'R326/view/accept-wallet');
    }, 'if (!games || enabled !== true) return null;', 'if (enabled !== true) return null;', 'R326/view/no-wallet');
  });
  it('без флага сервер не обещает игры даже при присланном кошельке', () => {
    checkMutation(raw => {
      const { gamesView } = load(raw);
      assert.equal(gamesView(view()), null, 'R326/view/no-flag');
      assert.equal(gamesView(view({ gamesEnabled: true }))?.games, games);
    }, 'const enabled = view.gamesEnabled ?? view.settings?.gamesEnabled;',
    'const enabled = view.gamesEnabled ?? view.settings?.gamesEnabled ?? true;', 'R326/view/no-flag');
  });
  it('только boolean true включает игры; false, строки, числа и null не включают', () => {
    checkMutation(raw => {
      const { gamesView } = load(raw);
      for (const flag of [false, 'true', 1, 0, null]) {
        assert.equal(gamesView(view({ gamesEnabled: flag as boolean })), null, 'R326/view/strict-true');
      }
      assert.equal(gamesView(view({ gamesEnabled: true }))?.games, games);
    }, 'enabled !== true', '!enabled', 'R326/view/strict-true');
  });
  it('явное верхнее false сильнее старого true в settings, а true сильнее false', () => {
    checkMutation(raw => {
      const { gamesView } = load(raw);
      assert.equal(gamesView(view({ gamesEnabled: false, settings: settings({ gamesEnabled: true }) })), null,
        'R326/view/flag-precedence');
      assert.equal(gamesView(view({ gamesEnabled: true, settings: settings({ gamesEnabled: false }) }))?.games, games);
    }, 'view.gamesEnabled ?? view.settings?.gamesEnabled', 'view.gamesEnabled || view.settings?.gamesEnabled',
    'R326/view/flag-precedence');
  });
  it('при верхних полях settings вообще не читаются; выключенный флаг тоже замыкает чтение', () => {
    checkMutation(raw => {
      const { gamesView } = load(raw);
      for (const flag of [true, false]) {
        let reads = 0;
        const data = view({ gamesEnabled: flag, gamesDailyLossMax: 700 });
        Object.defineProperty(data, 'settings', { get() { reads++; return settings({ gamesEnabled: !flag, gamesDailyLossMax: 123 }); } });
        const seen = gamesView(data);
        assert.equal(reads, 0, 'R326/view/no-settings-read');
        assert.equal(seen?.serverMax ?? null, flag ? 700 : null);
      }
    }, 'const games = view.wallet.games;', 'void view.settings; const games = view.wallet.games;',
    'R326/view/no-settings-read');
  });
  it('старый управляющий может получить флаг и потолок из settings, обычный без них — нет', () => {
    checkMutation(raw => {
      const { gamesView } = load(raw);
      const seen = gamesView(view({ settings: settings({ gamesEnabled: true, gamesDailyLossMax: 800 }) }));
      assert.equal(seen?.serverMax, 800, 'R326/view/settings-fallback');
      assert.equal(seen?.games, games);
      assert.equal(gamesView(view({ canManage: false, settings: null })), null);
    }, 'view.gamesEnabled ?? view.settings?.gamesEnabled', 'view.gamesEnabled', 'R326/view/settings-fallback');
  });
  it('верхний нулевой потолок безлимитен и не заменяется старым потолком settings', () => {
    checkMutation(raw => {
      const { gamesView } = load(raw);
      assert.equal(gamesView(view({ gamesEnabled: true, gamesDailyLossMax: 0,
        settings: settings({ gamesDailyLossMax: 900 }) }))?.serverMax, 0, 'R326/view/zero-max');
      assert.equal(gamesView(view({ gamesEnabled: true, gamesDailyLossMax: 700,
        settings: settings({ gamesDailyLossMax: 900 }) }))?.serverMax, 700);
      assert.equal(gamesView(view({ gamesEnabled: true }))?.serverMax, 0);
    }, 'view.gamesDailyLossMax ?? view.settings?.gamesDailyLossMax ?? 0',
    'view.gamesDailyLossMax || view.settings?.gamesDailyLossMax || 0', 'R326/view/zero-max');
  });
  it('потолок settings сохраняется, если верхнего поля нет', () => {
    checkMutation(raw => {
      const { gamesView } = load(raw);
      assert.equal(gamesView(view({ gamesEnabled: true, settings: settings({ gamesDailyLossMax: 930 }) }))?.serverMax,
        930, 'R326/view/max-fallback');
      assert.equal(gamesView(view({ gamesEnabled: true, gamesDailyLossMax: 700 }))?.serverMax, 700);
    }, 'view.gamesDailyLossMax ?? view.settings?.gamesDailyLossMax ?? 0',
    'view.gamesDailyLossMax ?? 0', 'R326/view/max-fallback');
  });
});

const contract = {
  'wheel.bet': 'Ставка в колесе', 'wheel.win': 'Выигрыш в колесе', 'wheel.refund': 'Возврат ставки (колесо)',
  'wheel.jackpot': 'Джекпот колеса',
  'duel.stake': 'Ставка в дуэли', 'duel.win': 'Выигрыш дуэли', 'duel.refund': 'Возврат ставки (дуэль)',
  'prediction.bet': 'Ставка на прогноз', 'prediction.win': 'Выигрыш прогноза', 'prediction.refund': 'Возврат ставки (прогноз)',
} as const;
describe('R326/R329 журнал: десять причин игр, включая джекпот колеса', () => {
  for (const [reason, label] of Object.entries(contract)) it(`${reason} имеет точную человеческую подпись «${label}»`, () => {
    // Класс ошибки: пропущенная или переименованная причина показывает человеку сырой протокол.
    const address = `R326/reason/${reason}`;
    checkMutation(raw => {
      const actual = load(raw).LEDGER_REASON;
      assert.equal(actual[reason], label, address);
      assert.equal(Object.hasOwn(actual, reason), true);
      assert.equal(actual['unregistered.game'], undefined);
    }, `'${reason}': '${label}'`, `'${reason}': '${reason}'`, address);
  });
  it('игровой словарь не получает одиннадцатую неподдерживаемую причину', () => {
    checkMutation(raw => {
      const keys = Object.keys(load(raw).LEDGER_REASON).filter(key => /^(wheel|duel|prediction)\./.test(key)).sort();
      assert.equal(JSON.stringify(keys), JSON.stringify(Object.keys(contract).sort()), 'R326/reason/exact-ten');
    }, "'wheel.bet': 'Ставка в колесе',", "'wheel.extra': 'Лишняя причина', 'wheel.bet': 'Ставка в колесе',",
    'R326/reason/exact-ten');
  });
});
