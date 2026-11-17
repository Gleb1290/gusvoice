import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { gamesView } from '../economy';

const source = readFileSync(new URL('./Activities.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Props = Record<string, unknown>;
type Element = { type: unknown; props: Props };
const jsx = (type: unknown, props: Props): Element => ({ type, props });
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as Element;
  return [element, ...elements(element.props.children)];
}
const launch = { at: '2026-09-29T10:00:00.000Z', gift: 500, mine: 500 };
/** Целый Activities: подменены I/O и React-планировщик, не функция/обработчик из вырезанного текста. */
function fixture(raw: string, phone: boolean, launched: boolean) {
  const events: string[] = [];
  const notices: unknown[] = [];
  const state = {
    activitiesOpen: { serverId: 'server-b', view: 'list' } as { serverId: string; view: string } | null,
    voice: { serverId: 'server-b', channelId: 'channel-b' },
    bootstrap: { server: { id: 'server-a' } },
    economy: { 'server-b': { gamesEnabled: true, wallet: { games: {} }, gamesLaunch: launched ? launch : null } },
    wheel: {}, duels: {}, predictions: {}, predictionToast: null,
    openActivities(value: { serverId: string; view: string } | null) { state.activitiesOpen = value; events.push('close'); },
    setGamesLaunchNotice(value: unknown) { notices.push(value); events.push('notice'); },
  };
  const deps: Record<string, unknown> = {
    react: { lazy: () => ({ kind: 'lazy' }), Suspense: 'test-suspense', useEffect: () => {},
      useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, () => {}] },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'test-fragment' },
    '../duelRules': { duelLive: () => false },
    '../economyClient': { ensureDuel() {}, ensureEconomy() {}, ensurePredictions() {}, ensureWheel() {} },
    '../economy': { gamesView },
    '../phoneLayout': { usePhoneLayout: () => phone },
    '../predictionRules': { predictionLive: () => false, predictionsOpen: () => false },
    '../store': { useStore: (select: (value: typeof state) => unknown) => select(state), voiceIsHere: () => true },
    '../wheelRules': { clockLabel: () => '', wheelLive: () => false, wheelPhase: () => null },
    './BottomSheet': { BottomSheet: 'test-bottom-sheet' },
    './GameBoard': { GameBoardScene: 'test-board' },
    './GamesLimit': { GamesLimit: 'test-games-limit' },
    './Duel': { DuelCard: 'test-duel-card', DuelInvite: 'test-duel-invite', DuelNewCard: 'test-duel-new', GameToastShelf: 'test-toast' },
    './Icon': { Icon: 'test-icon' },
  };
  const module = { exports: {} as { ActivitiesHost: () => unknown } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { module, exports: module.exports, require(id: string) {
    assert.ok(Object.hasOwn(deps, id), `R351/подготовка/activities/import/${id}`); return deps[id];
  } }, { timeout: 2_000 });
  function render() {
    const host = module.exports.ActivitiesHost();
    const card = elements(host).find(element => typeof element.type === 'function' && element.type.name === 'ActivitiesCard');
    assert.ok(card, 'R351/подготовка/activities/card');
    return (card.type as (props: Props) => unknown)(card.props);
  }
  return { state, events, notices, render };
}
function guarded(check: (raw: string) => void, needle: string, next: string, address: string) {
  check(source);
  counterfact(() => {
    assert.equal(source.split(needle).length, 2, 'R351/подготовка/activities/unique');
    assert.throws(() => check(source.replace(needle, next)), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.split('\n')[0] === address);
  });
  check(source);
}

for (const phone of [false, true]) {
  const layout = phone ? 'телефон' : 'ПК';
  // В обеих раскладках кнопка повтора не должна возникать на сервере, где запуск игр ещё не происходил.
  it(`R351 ${layout}: «Что это у нас?» существует только при gamesLaunch`, () => {
    guarded(raw => {
      for (const launched of [false, true]) {
        const f = fixture(raw, phone, launched);
        const buttons = elements(f.render()).filter(element => element.props.className === 'wallet-how act-whats');
        assert.equal(buttons.length, launched ? 1 : 0, 'R351/activities/replay-visible');
        if (launched) assert.equal(buttons[0].props.children, 'Что это у нас?');
      }
    }, 'const whatsThis = launched ? (', 'const whatsThis = true ? (', 'R351/activities/replay-visible');
  });
  // Закрытие предшествует запросу: MainLayout запрещает сцену поверх «Активностей»; подарок повторно не обещается.
  it(`R351 ${layout}: повтор закрывает «Активности» и ставит mine=0, replay=true для сервера карточки`, () => {
    const check = (raw: string) => {
      const f = fixture(raw, phone, true);
      const button = elements(f.render()).find(element => element.props.className === 'wallet-how act-whats');
      assert.ok(button, 'R351/подготовка/activities/replay-button');
      (button.props.onClick as () => void)();
      assert.deepEqual(f.events, ['close', 'notice'], 'R351/activities/replay-order');
      assert.equal(f.state.activitiesOpen, null, 'R351/activities/replay-closed');
      assert.equal(JSON.stringify(f.notices), JSON.stringify([{ serverId: 'server-b', at: launch.at, gift: launch.gift, mine: 0, replay: true }]),
        'R351/activities/replay-payload');
    };
    guarded(check, 'onClose();\n        setLaunchNotice(', 'setLaunchNotice(', 'R351/activities/replay-order');
    guarded(check, 'mine: 0, replay: true', 'mine: launched.mine, replay: true', 'R351/activities/replay-payload');
    guarded(check, 'mine: 0, replay: true', 'mine: 0, replay: false', 'R351/activities/replay-payload');
  });
}
