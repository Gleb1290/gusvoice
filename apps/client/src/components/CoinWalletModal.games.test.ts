import assert from 'node:assert/strict';
import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import * as economy from '../economy';
import type { EconomyView, GamesWallet, LedgerEntry } from '../economy';

const source = readFileSync(new URL('./CoinWalletModal.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Props = Record<string, unknown> & { children?: React.ReactNode };
type Element = React.ReactElement<Props>;
type Component = (props: Props) => React.ReactNode;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function text(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join('');
  if (React.isValidElement<Props>(node)) return text(node.props.children);
  return String(node);
}
function game(patch: Partial<GamesWallet> = {}): GamesWallet {
  return { optOut: false, lossLimit: 1000, lossLimitRaise: null, lossToday: 120, effectiveLimit: 600, ...patch };
}
function view(patch: Partial<EconomyView> = {}): EconomyView {
  return { enabled: true, currencyName: 'Монеты', iconUrl: null, canManage: false, awayPercent: 25, settings: null,
    wallet: { balance: 900, earnedTotal: 100, seasonEarned: 50, optedOut: false, tipsOptOut: false, games: game() },
    season: { id: 'autumn', name: 'Осень' }, level: { level: 1, title: 'Новичок', points: 100, nextAt: 200, progress: 0.5 },
    levelStages: [], crown: null, shop: [], gamesEnabled: true, gamesDailyLossMax: 3000, ...patch };
}
type Reply = { optedOut: boolean; tipsOptOut: boolean; games?: GamesWallet };
const unused = () => { throw new Error('R326/подготовка/непредметный I/O'); };
function fixture(raw: string, reply: Reply = { optedOut: false, tipsOptOut: false }) {
  let cursor = 0;
  const states: unknown[] = [];
  const calls: Array<{ serverId: string; patch: Record<string, unknown> }> = [];
  const changes: EconomyView[] = [];
  const deps: Record<string, unknown> = {
    react: { ...React, useEffect() {}, useState(value: unknown) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof value === 'function' ? (value as () => unknown)() : value;
      return [states[index], (next: unknown) => { states[index] = next; }];
    } }, 'react/jsx-runtime': jsxRuntime, '../economy': economy,
    '../api': { api: { async setEconomyOptOut(serverId: string, patch: Record<string, unknown>) {
      calls.push({ serverId, patch: JSON.parse(JSON.stringify(patch)) }); return reply;
    } } },
    '@gusvoice/shared': { AVATAR_RENTAL_MAX_DAYS: 60, avatarRentalExtendFrom: unused, pluralDays: unused },
    '../benchMock': { isMockEconomy: () => false, mockLeaderboard: unused },
    '../store': { useStore: (select: (state: unknown) => unknown) => select({ user: null,
      recaps: {}, openRecap: unused, setEconomyWelcomeOpen: unused }) },
    '../economyClient': { ensureEconomy: unused }, '../ledgerCsv': { ledgerCsv: unused, ledgerFileName: unused },
    '../memberName': { useNameResolver: () => (id: string) => id },
    '../streakView': { streakCaption: unused, streakDots: unused, streakExplain: unused },
    '../toast': { toast: unused, toastError: unused },
    './GameBoard': { GameBoardSection: () => null, MyGameTitles: () => null },
    './Goose': { Goose: () => null }, './Icon': { Icon: () => null }, './RecountNotice': { RecountNotice: () => null },
  };
  const module = { exports: {} as { CoinWalletModal: Component; __games: Component;
    __ledgerText: (entry: LedgerEntry, resolve: (id: string, fallback: string) => string) => string } };
  // Класс ошибки: проверка копии GamesBlock/ledgerText не видит изменений настоящего модуля и JSX.
  const code = ts.transpileModule(`${raw}\nexport const __games = GamesBlock;\nexport const __ledgerText = ledgerText;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(code, { module, exports: module.exports,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `R326/подготовка/импорт/${id}`); return deps[id]; },
  }, { timeout: 2_000 });
  return { calls, changes, ledgerText: module.exports.__ledgerText,
    render(data: EconomyView, kind: 'games' | 'wallet' = 'games') {
      cursor = 0;
      const C = kind === 'games' ? module.exports.__games : module.exports.CoinWalletModal;
      // createElement сохраняет настоящие React props; хуки исполняются детерминированно без браузера.
      const element = React.createElement(C, { serverId: 'server-games', view: data,
        onViewChange: (next: EconomyView) => changes.push(next), onClose() {} });
      return C(element.props);
    },
  };
}
function input(tree: React.ReactNode, type: 'checkbox' | 'range'): Element | undefined {
  return elements(tree).find(node => node.type === 'input' && node.props.type === type);
}
function button(tree: React.ReactNode, label: string): Element | undefined {
  return elements(tree).find(node => node.type === 'button' && text(node) === label);
}
function change(node: Element | undefined, value: string | boolean) {
  assert.ok(node, 'R326/подготовка/input');
  (node.props.onChange as (event: { target: { value?: string; checked?: boolean } }) => void)({ target:
    typeof value === 'string' ? { value } : { checked: value } });
}
async function settled() { await Promise.resolve(); await Promise.resolve(); }
function mutate(needle: string, next: string): string {
  assert.equal(source.split(needle).length, 2, `R326/подготовка/уникальный якорь/${needle}`);
  return source.replace(needle, next);
}
async function guarded(check: (raw: string) => void | Promise<void>, needle: string, next: string, address: string) {
  await check(source);
  await counterfact(async () => {
    await assert.rejects(async () => check(mutate(needle, next)), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.split('\n')[0] === address);
  });
  await check(source); // Исходник повторно зелёный после in-memory мутанта; production-файл не менялся.
}

describe('R326 GamesBlock: видимость, самоотказ и показ серверного состояния', () => {
  it('старый сервер без новых полей не рисует блок, новый включённый — рисует', async () => {
    await guarded(raw => {
      const old = view(); delete old.gamesEnabled; delete old.gamesDailyLossMax; delete old.wallet.games;
      assert.equal(text(fixture(raw).render(old)).includes('Не показывать мне игры'), false, 'R326/wallet/old');
      assert.equal(text(fixture(raw).render(view())).includes('Не показывать мне игры'), true);
    }, 'const seen = gamesView(view);',
    'const seen = { games: view.wallet.games ?? { optOut: false, lossLimit: null, lossLimitRaise: null, lossToday: 0, effectiveLimit: null }, serverMax: 3000 };',
    'R326/wallet/old');
  });
  it('выключенный сервер скрывает игры, включённый показывает без управляющих settings', async () => {
    await guarded(raw => {
      assert.equal(text(fixture(raw).render(view({ gamesEnabled: false }))).includes('Не показывать мне игры'), false,
        'R326/wallet/server-off');
      assert.equal(!!input(fixture(raw).render(view({ canManage: false, settings: null })), 'checkbox'), true);
    }, 'const seen = gamesView(view);', 'const seen = gamesView({ ...view, gamesEnabled: true });', 'R326/wallet/server-off');
  });
  it('неуправляющий без верхних полей не видит блок, с верхними видит', async () => {
    await guarded(raw => {
      const old = view({ canManage: false, settings: null }); delete old.gamesEnabled; delete old.gamesDailyLossMax;
      assert.equal(!!input(fixture(raw).render(old), 'checkbox'), false, 'R326/wallet/nonmanager-no-fields');
      assert.equal(!!input(fixture(raw).render(view()), 'checkbox'), true);
    }, 'const seen = gamesView(view);', 'const seen = gamesView({ ...view, gamesEnabled: true });', 'R326/wallet/nonmanager-no-fields');
  });
  it('отказ от экономики делает чекбокс игр отмеченным и серым, а сводку убирает', async () => {
    await guarded(raw => {
      const off = view(); off.wallet.optedOut = true;
      const tree = fixture(raw).render(off);
      assert.equal(input(tree, 'checkbox')?.props.disabled, true, 'R326/wallet/economy-off');
      assert.equal(input(tree, 'checkbox')?.props.checked, true);
      assert.equal(text(tree).includes('Сегодня проиграно:'), false);
      assert.equal(input(fixture(raw).render(view()), 'checkbox')?.props.disabled, false);
      assert.equal(text(fixture(raw).render(view())).includes('Сегодня проиграно:'), true);
    }, 'const off = view.wallet.optedOut;', 'const off = false;', 'R326/wallet/economy-off');
  });
  it('личный отказ от игр прячет сводку, но оставляет доступный отмеченный чекбокс возврата', async () => {
    await guarded(raw => {
      const off = view(); off.wallet.games = game({ optOut: true });
      const tree = fixture(raw).render(off);
      assert.equal(text(tree).includes('Сегодня проиграно:'), false, 'R326/wallet/games-opt-out');
      assert.equal(input(tree, 'checkbox')?.props.checked, true);
      assert.equal(input(tree, 'checkbox')?.props.disabled, false);
      assert.equal(text(fixture(raw).render(view())).includes('Сегодня проиграно:'), true);
    }, '!games.optOut && !off && (', '!off && (', 'R326/wallet/games-opt-out');
  });
  it('«из M» берёт effectiveLimit, а не личный или серверный потолок', async () => {
    await guarded(raw => {
      const tree = fixture(raw).render(view());
      assert.equal(text(tree).includes('Сегодня проиграно: 120 из 600 Монеты'), true, 'R326/wallet/effective-limit');
      assert.equal(text(tree).includes('Сегодня проиграно: 120 из 1000'), false);
    }, '` из ${games.effectiveLimit}`', '` из ${games.lossLimit}`', 'R326/wallet/effective-limit');
  });
  it('effectiveLimit null показывает «(без предела)», а числовой ноль остаётся числом', async () => {
    await guarded(raw => {
      const unlimited = view(); unlimited.wallet.games = game({ effectiveLimit: null });
      assert.equal(text(fixture(raw).render(unlimited)).includes('Сегодня проиграно: 120 (без предела) Монеты'), true,
        'R326/wallet/unlimited');
      const zero = view(); zero.wallet.games = game({ effectiveLimit: 0 });
      assert.equal(text(fixture(raw).render(zero)).includes('Сегодня проиграно: 120 из 0 Монеты'), true);
    }, 'games.effectiveLimit !== null ? ` из ${games.effectiveLimit}`', 'true ? ` из ${games.effectiveLimit}`', 'R326/wallet/unlimited');
  });
  it('R358 сводка направляет за своим пределом в «Активности», а управление суммой из кошелька убрано', async () => {
    const check = (raw: string) => {
      // Отложенное повышение/снятие тоже не должно возвращать старый редактор только для части кошельков.
      for (const lossLimitRaise of [null, { value: 1500, from: '2026-10-30T00:00:00Z' }, { value: null, from: '2026-10-30T00:00:00Z' }]) {
        const data = view(); data.wallet.games = game({ lossLimitRaise });
        const tree = fixture(raw).render(data);
        assert.equal(/Свой предел — в\s*«Активностях» голосового канала/.test(text(tree)), true, 'R358/wallet/activities');
        assert.equal(input(tree, 'range'), undefined);
        assert.equal(button(tree, 'Сохранить предел'), undefined);
        assert.equal(button(tree, 'Как на сервере'), undefined);
        assert.equal(elements(tree).some(node => node.props.role === 'status'), false, 'R358/wallet/no-status');
      }
    };
    await guarded(check, '«Активностях» голосового канала', '«Кошельке» сервера', 'R358/wallet/activities');
    await guarded(check, '{error && <div className="error">Не удалось изменить настройки игр: {error}</div>}',
      '{games.lossLimitRaise && <div role="status">Старое управление пределом</div>}{error && <div className="error">Не удалось изменить настройки игр: {error}</div>}',
      'R358/wallet/no-status');
  });
});

describe('R326 GamesBlock: реальные обработчики и ответы PATCH me', () => {
  it('чекбокс отправляет свой gamesOptOut в обе стороны, не меняя другие отказы', async () => {
    await guarded(async raw => {
      for (const value of [true, false]) {
        const data = view(); data.wallet.games = game({ optOut: !value });
        const f = fixture(raw);
        change(input(f.render(data), 'checkbox'), value);
        await settled();
        assert.equal(JSON.stringify(f.calls), JSON.stringify([{ serverId: 'server-games', patch: { gamesOptOut: value } }]),
          'R326/wallet/patch-opt-out');
      }
    }, 'save({ gamesOptOut: e.target.checked })', 'save({ gamesLossLimit: e.target.checked as unknown as number })',
    'R326/wallet/patch-opt-out');
  });
  it('R358 пока PATCH не завершён, чекбокс неактивен; после ответа снова доступен', async () => {
    await guarded(async raw => {
      const f = fixture(raw); const data = view();
      change(input(f.render(data), 'checkbox'), true);
      const pending = f.render(data);
      assert.equal(input(pending, 'checkbox')?.props.disabled, true, 'R358/wallet/busy');
      await settled();
      assert.equal(input(f.render(data), 'checkbox')?.props.disabled, false);
    }, 'disabled={busy || off}', 'disabled={off}', 'R358/wallet/busy');
  });
  it('GamesBlock принимает новый games, а ответ старого сервера без games не стирает прежний', async () => {
    await guarded(async raw => {
      const data = view();
      const old = fixture(raw);
      change(input(old.render(data), 'checkbox'), true); await settled();
      assert.equal(old.changes.length, 0, 'R326/wallet/old-reply');
      assert.equal(data.wallet.games?.lossLimit, 1000);
      const nextGames = game({ lossLimit: 750, effectiveLimit: 750 });
      const modern = fixture(raw, { optedOut: false, tipsOptOut: false, games: nextGames });
      change(input(modern.render(data), 'checkbox'), true); await settled();
      assert.equal(modern.changes.length, 1);
      assert.equal(modern.changes[0].wallet.games, nextGames);
      assert.equal(modern.changes[0].wallet.balance, data.wallet.balance);
    }, 'if (result.games) onViewChange', 'onViewChange', 'R326/wallet/old-reply');
  });
  it('отказы основного кошелька также сохраняют games при старом ответе и принимают новый', async () => {
    await guarded(async raw => {
      for (const modern of [false, true]) {
        const data = view(); const nextGames = game({ optOut: true });
        const f = fixture(raw, { optedOut: true, tipsOptOut: false, ...(modern ? { games: nextGames } : {}) });
        const label = elements(f.render(data, 'wallet')).find(node => node.type === 'label'
          && text(node).includes('Не участвовать в экономике'));
        assert.ok(label, 'R326/подготовка/отказ экономики');
        change(input(label, 'checkbox'), true); await settled();
        assert.equal(f.changes.length, 1);
        assert.equal(f.changes[0].wallet.games, modern ? nextGames : data.wallet.games, 'R326/wallet/parent-old-reply');
        assert.equal(f.changes[0].wallet.optedOut, true);
        assert.equal(f.changes[0].wallet.balance, 900);
      }
    }, '...(result.games ? { games: result.games } : {})', 'games: result.games', 'R326/wallet/parent-old-reply');
  });
});

describe('R326 журнал кошелька: реальное ledgerText', () => {
  it('duel.win с refUserId дописывает имя соперника через общий resolver', async () => {
    await guarded(raw => {
      const f = fixture(raw); const calls: Array<[string, string]> = [];
      const entry = { reason: 'duel.win', refUserId: 'opponent', amount: 400, data: {} } as LedgerEntry;
      const actual = f.ledgerText(entry, (id, fallback) => { calls.push([id, fallback]); return 'Соперник'; });
      assert.equal(actual, 'Выигрыш дуэли · Соперник', 'R326/wallet/duel-name');
      assert.deepEqual(calls, [['opponent', 'Участник']]);
    }, 'if (!entry.refUserId) return reason;', "if (!entry.refUserId || entry.reason === 'duel.win') return reason;",
    'R326/wallet/duel-name');
  });
  it('duel.win без refUserId не придумывает имя и не вызывает resolver', async () => {
    await guarded(raw => {
      const f = fixture(raw); let calls = 0;
      const actual = f.ledgerText({ reason: 'duel.win', refUserId: null, amount: 400, data: {} } as LedgerEntry,
        () => { calls++; return 'Участник'; });
      assert.equal(actual, 'Выигрыш дуэли', 'R326/wallet/duel-no-name');
      assert.equal(calls, 0);
    }, 'if (!entry.refUserId) return reason;', 'if (false) return reason;', 'R326/wallet/duel-no-name');
  });
});
