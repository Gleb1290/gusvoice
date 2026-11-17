import { counterfact } from "../../../packages/shared/test/counterfacts.js";
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as economy from './economy.ts';
import type { EconomySettingsDto, EconomyView } from './economy.ts';

const sources = {
  rules: readFileSync(new URL('./economy.ts', import.meta.url), 'utf8'),
  panel: readFileSync(new URL('./components/EconomyPanel.tsx', import.meta.url), 'utf8'),
  wallet: readFileSync(new URL('./components/CoinWalletModal.tsx', import.meta.url), 'utf8'),
};

function settings(patch: Partial<EconomySettingsDto> = {}): EconomySettingsDto {
  return {
    enabled: true, currencyName: 'Монеты', iconUrl: null,
    ratePer5min: 10, alonePercent: 25, companyPercent: 150, dailyCap: 800, aloneCap: 90,
    decayAfterMinutes: 120, decayPercent: 50, mutedPercent: 50, deafenedPercent: 10,
    awayPercent: 25, payoutMinutes: 10, compensateOnRaise: false,
    tipAmount: 5, tipTaxPercent: 0, tipDailyOut: 100, tipDailyIn: 100, tipDailyPair: 100,
    seasonLength: 'quarter', gooseBonus: 5, gooseMinutes: 30, gooseDeafenedBonus: 1,
    streakBonus: 1, retroGrantedAt: null, ...patch,
  };
}
function view(patch: Partial<EconomyView> = {}): EconomyView {
  return {
    enabled: true, currencyName: 'Монеты', iconUrl: null, canManage: true, awayPercent: 25,
    settings: settings(),
    wallet: { balance: 100, earnedTotal: 100, seasonEarned: 100, optedOut: false,
      tipsOptOut: false, aloneEarnedToday: 12 },
    season: { id: 'autumn-2026', name: 'Осень' },
    level: { level: 1, title: 'Новичок', points: 100, nextAt: 200, progress: 0.5 },
    levelStages: [], crown: null, shop: [], ...patch,
  };
}

// Загружаем ВЕСЬ реальный модуль. Подменены только эффекты/внешний ввод; JSX и локальные
// компоненты настоящие. Это статический рендер и обработчик ползунка, не проверка lifecycle.
function load(input: string, fileName: string, imports: Record<string, unknown>): Record<string, unknown> {
  const exports = {};
  const js = ts.transpileModule(input, { fileName, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  runInNewContext(js, { exports, require: (name: string) => {
    assert.ok(Object.hasOwn(imports, name), `R317 незапланированный импорт ${name}`);
    return imports[name];
  } }, { filename: `r317-${fileName}.js`, timeout: 2_000 });
  return exports;
}
function ui(input: string, kind: 'panel' | 'wallet', data: EconomySettingsDto | EconomyView) {
  let hook = 0;
  let changed: EconomySettingsDto | undefined;
  const unexpected = () => { throw new Error('R317 статический рендер не должен выполнять I/O'); };
  const noop = () => {};
  const react = { ...React,
    useState(initial: unknown) {
      const index = hook++;
      const value = kind === 'panel' && index === 0 ? data
        : typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [value, (next: EconomySettingsDto) => { if (kind === 'panel' && index === 0) changed = next; }];
    },
    useEffect: noop,
    useRef: (current: unknown) => ({ current }),
    useCallback: (fn: unknown) => fn,
  };
  const imports = {
    react, 'react/jsx-runtime': jsxRuntime, '../economy': economy,
    '../api': { api: new Proxy({}, { get: () => unexpected }) },
    '../confirm': { alertDialog: unexpected, confirmAction: unexpected },
    './Toggle': { Toggle: () => null },
    './GameTitlesCard': { GameTitlesCard: () => null },
    './GameBoard': { GameBoardSection: () => null, MyGameTitles: () => null },
    '@gusvoice/shared': { AVATAR_RENTAL_MAX_DAYS: 60, avatarRentalExtendFrom: unexpected, pluralDays: unexpected },
    '../benchMock': { isMockEconomy: () => false, mockLeaderboard: unexpected },
    '../store': { useStore: (select: (state: unknown) => unknown) => select({ user: null,
      recaps: {}, openRecap: unexpected, setEconomyWelcomeOpen: unexpected, setAuth: unexpected }) },
    '../economyClient': { ensureEconomy: unexpected },
    '../ledgerCsv': { ledgerCsv: unexpected, ledgerFileName: unexpected },
    '../memberName': { useNameResolver: () => (id: string) => id },
    '../streakView': { streakCaption: unexpected, streakDots: unexpected, streakExplain: unexpected },
    '../toast': { toast: unexpected, toastError: unexpected },
    './Goose': { Goose: () => null }, './Icon': { Icon: () => null },
    './RecountNotice': { RecountNotice: () => null },
  };
  const module = load(input, `${kind}.tsx`, imports);
  const Component = module[kind === 'panel' ? 'EconomyPanel' : 'CoinWalletModal'] as
    (props: Record<string, unknown>) => React.ReactElement;
  const tree = Component({ serverId: 'server', view: data, onViewChange: unexpected, onClose: noop });
  return { tree, html: renderToStaticMarkup(tree), changed: () => changed };
}
function panel(s: EconomySettingsDto, source = sources.panel) { return ui(source, 'panel', s); }
function wallet(v: EconomyView, source = sources.wallet) { return ui(source, 'wallet', v).html; }
function text(html: string): string { return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }
function findSlider(node: React.ReactNode): React.ReactElement<{ label: string; value: number;
  onChange: (v: number) => void }> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const found = findSlider(child); if (found) return found; }
  } else if (React.isValidElement<{ label?: string; children?: React.ReactNode }>(node)) {
    if (node.props.label === 'Порог ожидания одному') return node as ReturnType<typeof findSlider>;
    return findSlider(node.props.children);
  }
  return undefined;
}
function mutate(source: string, anchor: string, replacement: string): string {
  assert.equal(source.split(anchor).length - 1, 1, `R317 уникальный якорь ${anchor}`);
  return source.replace(anchor, replacement);
}
function killed(check: (source: string) => void, source: string, anchor: string, replacement: string,
  marker: string): void {
  check(source);
  counterfact(() => {
    const mutant = mutate(source, anchor, replacement);
    assert.throws(() => check(mutant), (err: unknown) => err instanceof assert.AssertionError
      && err.message.includes(marker) && err.operator === 'strictEqual');
  });
}

describe('R317: часы ожидания одному', () => {
  it('90 монет при ставке 10 и четверти ставки означают три часа', () => {
    assert.equal(economy.aloneCapHours(90, 10, 25), 3);
    assert.equal(economy.aloneCapHours(90, 5, 25), 6);
    assert.equal(economy.aloneCapHours(90, 10, 50), 1.5);
  });
  it('нулевой порог безлимитен, нулевая ставка и множитель не обещают время заработка', () => {
    for (const [cap, rate, percent] of [[0, 10, 25], [90, 0, 25], [90, 10, 0], [-1, 10, 25],
      [90, -1, 25], [90, 10, -1]]) assert.equal(economy.aloneCapHours(cap, rate, percent), null);
  });
  it('положительный маленький порог показывается минимум как полчаса', () => {
    assert.equal(economy.aloneCapHours(1, 10, 25), 0.5);
    assert.equal(economy.aloneCapHours(15, 10, 25), 0.5);
  });
  it('переходы округления к получасам проверены с обеих сторон', () => {
    for (const [cap, hours] of [[22.49, 0.5], [22.5, 1], [37.49, 1], [37.5, 1.5],
      [45, 1.5], [75, 2.5]]) assert.equal(economy.aloneCapHours(cap, 10, 25), hours);
  });
  it('подпись часов использует русскую запятую без лишнего нуля', () => {
    assert.equal(economy.hoursLabel(3), '3 ч');
    assert.equal(economy.hoursLabel(2.5), '2,5 ч');
    assert.equal(economy.hoursLabel(0.5), '0,5 ч');
  });
});

describe('R317: настоящий JSX настроек и кошелька', () => {
  it('старый сервер без aloneCap не рисует ползунок, но остальные настройки остаются', () => {
    const old = settings(); delete old.aloneCap;
    const result = panel(old);
    assert.equal(findSlider(result.tree), undefined);
    assert.ok(text(result.html).includes('Ставка'));
    assert.ok(!text(result.html).includes('Порог ожидания одному'));
  });
  it('положительный порог виден и изменение ползунка сохраняет остальные настройки', () => {
    const original = settings();
    const result = panel(original);
    const slider = findSlider(result.tree);
    assert.ok(slider); assert.equal(slider.props.value, 90);
    assert.ok(text(result.html).includes('≈ 3 ч'));
    slider.props.onChange(120);
    // Нормализуем только прототип объекта из VM; все поля и значения должны сохраниться.
    assert.deepEqual({ ...result.changed() }, { ...original, aloneCap: 120 });
    assert.equal(original.aloneCap, 90);
  });
  it('ноль не прячет ползунок и объясняет отсутствие порога вместо нулевых часов', () => {
    const result = panel(settings({ aloneCap: 0 }));
    assert.equal(findSlider(result.tree)?.props.value, 0);
    assert.ok(text(result.html).includes('Без порога: одному капает весь день'));
  });
  it('нулевая ставка или множитель объясняют отсутствие заработка, а не бесконечные часы', () => {
    for (const patch of [{ ratePer5min: 0 }, { alonePercent: 0 }]) {
      const html = panel(settings(patch)).html;
      assert.ok(text(html).includes('Одному сейчас не капает вовсе'));
      assert.doesNotMatch(html, /Infinity|NaN/);
    }
  });
  it('кошелёк управляющего показывает сегодняшние монеты и часы; нулевой заработок тоже виден', () => {
    assert.ok(text(wallet(view())).includes('За ожидание одному сегодня: 12 из 90 Монеты'));
    assert.ok(text(wallet(view())).includes('≈ 3 ч одному с включённым микрофоном'));
    const zero = view(); zero.wallet.aloneEarnedToday = 0;
    assert.ok(text(wallet(zero)).includes('За ожидание одному сегодня: 0 из 90 Монеты'));
  });
  it('старые ответы без любого из двух полей скрывают только новую строку кошелька', () => {
    const noCap = view(); delete noCap.settings!.aloneCap;
    const noCounter = view(); delete noCounter.wallet.aloneEarnedToday;
    for (const v of [noCap, noCounter, view({ settings: null })]) {
      const html = text(wallet(v));
      assert.ok(!html.includes('За ожидание одному сегодня:'));
      assert.ok(html.includes('Мой кошелёк'));
      assert.ok(html.includes('Баланс100 Монеты'));
    }
  });
  it('обычному участнику и при безлимитном нуле внутренний счётчик не показывается', () => {
    for (const v of [view({ canManage: false }), view({ settings: settings({ aloneCap: 0 }) })])
      assert.ok(!text(wallet(v)).includes('За ожидание одному сегодня:'));
  });
  it('допустимый перелёт последнего среза не рисует больше ста процентов порога', () => {
    const v = view(); v.wallet.aloneEarnedToday = 91;
    assert.ok(text(wallet(v)).includes('За ожидание одному сегодня: 90 из 90 Монеты'));
  });
  it('сохранённый заработок остаётся виден после обнуления ставки, но часы больше не обещаются', () => {
    const html = text(wallet(view({ settings: settings({ ratePer5min: 0 }) })));
    assert.ok(html.includes('За ожидание одному сегодня: 12 из 90 Монеты'));
    assert.ok(!html.includes('порог — это ≈'));
  });
});

describe('R317: original-first контрфакты клиентского правила', () => {
  const rules = (source: string) => load(source, 'economy.ts', {}) as typeof economy;
  it('потеря проверки нуля превращает безлимитный порог в полчаса', () => {
    killed((source) => assert.equal(rules(source).aloneCapHours(0, 10, 25), null, 'R317 ноль без порога'),
      sources.rules, 'if (aloneCap <= 0 || perHour <= 0) return null;',
      'if (perHour <= 0) return null;', 'R317 ноль без порога');
  });
  it('потеря минимальных получаса обнаруживается по нулевому обещанному времени', () => {
    killed((source) => assert.equal(rules(source).aloneCapHours(1, 10, 25), 0.5, 'R317 минимум времени'),
      sources.rules, 'Math.max(0.5, Math.round((aloneCap / perHour) * 2) / 2)',
      'Math.round((aloneCap / perHour) * 2) / 2', 'R317 минимум времени');
  });
  it('округление до целого теряет точные полтора часа', () => {
    killed((source) => assert.equal(rules(source).aloneCapHours(45, 10, 25), 1.5, 'R317 получасы'),
      sources.rules, 'Math.round((aloneCap / perHour) * 2) / 2',
      'Math.round(aloneCap / perHour)', 'R317 получасы');
  });
  it('потеря защиты старого сервера рисует неподдерживаемый ползунок', () => {
    const old = settings(); delete old.aloneCap;
    killed((source) => assert.equal(!!findSlider(panel(old, source).tree), false, 'R317 старый ползунок'),
      sources.panel, 'settings.aloneCap !== undefined && (', 'true && (', 'R317 старый ползунок');
  });
  it('truthy-проверка ошибочно прячет поддерживаемый безлимитный ноль', () => {
    killed((source) => assert.equal(!!findSlider(panel(settings({ aloneCap: 0 }), source).tree), true,
      'R317 ползунок безлимитен'), sources.panel, 'settings.aloneCap !== undefined && (',
      '!!settings.aloneCap && (', 'R317 ползунок безлимитен');
  });
  it('потеря права управляющего раскрывает внутренний счётчик обычному участнику', () => {
    killed((source) => assert.equal(text(wallet(view({ canManage: false }), source))
      .includes('За ожидание одному сегодня:'), false, 'R317 право кошелька'),
      sources.wallet, '!view.canManage || !s ||', '!s ||', 'R317 право кошелька');
  });
  it('потеря защиты старого счётчика рисует пустой или NaN заработок', () => {
    const old = view(); delete old.wallet.aloneEarnedToday;
    killed((source) => assert.equal(text(wallet(old, source)).includes('За ожидание одному сегодня:'),
      false, 'R317 старый счётчик'), sources.wallet, ' || earned === undefined', '', 'R317 старый счётчик');
  });
  it('потеря ограничения отображения показывает перелёт порога как превышение ста процентов', () => {
    const v = view(); v.wallet.aloneEarnedToday = 91;
    killed((source) => assert.equal(text(wallet(v, source)).includes('сегодня: 90 из 90'),
      true, 'R317 потолок отображения'), sources.wallet, 'Math.min(earned, s.aloneCap)',
      'earned', 'R317 потолок отображения');
  });
});
