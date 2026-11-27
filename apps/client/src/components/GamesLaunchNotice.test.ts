import assert from 'node:assert/strict';
import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as economy from '../economy';
import type { GamesLaunchNotice } from '../gamesLaunchRules';

const source = readFileSync(new URL('./GamesLaunchNotice.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Props = Record<string, unknown>;
type Element = { type: unknown; props: Props };
const jsx = (type: unknown, props: Props): Element => ({ type, props });
const parse = (raw: string) => ts.createSourceFile('GamesLaunchNotice.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return found;
}
const notice: GamesLaunchNotice = { serverId: 'server-a', at: '2026-10-29T10:00:00.000Z', gift: 500, mine: 500 };
interface View { enabled: boolean; gamesEnabled: boolean; gamesLaunch: Omit<GamesLaunchNotice, 'serverId'> | null;
  currencyName: string; iconUrl: string | null }
const view = (patch: Partial<View> = {}): View => ({ enabled: true, gamesEnabled: true,
  gamesLaunch: { at: notice.at, gift: notice.gift, mine: notice.mine }, currencyName: 'Перья', iconUrl: null, ...patch });
interface Options { requested?: GamesLaunchNotice | null; currentId?: string | null; view?: View; deafened?: boolean;
  brokenStorage?: boolean; hornFiles?: Record<string, string>; artFiles?: Record<string, string> }

function assetCalls(raw: string) {
  const file = parse(raw);
  return { file, calls: nodes(file, ts.isCallExpression).filter(node => ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'glob' && ts.isMetaProperty(node.expression.expression)
    && node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword) };
}
/** Подменяется только Vite I/O; исполняется целый модуль хоста, без вырезания функций из исходника. */
function withoutAssetIo(raw: string, options: Options): string {
  const { file, calls } = assetCalls(raw);
  assert.equal(calls.length, 2, 'R351/подготовка/host/glob-count');
  for (const call of calls.reverse()) {
    assert.ok(ts.isStringLiteral(call.arguments[0]!), 'R351/подготовка/host/glob-path');
    const path = (call.arguments[0] as ts.StringLiteral).text;
    const value = path.includes('/sounds/') ? options.hornFiles ?? {} : options.artFiles ?? {};
    raw = raw.slice(0, call.getStart(file)) + JSON.stringify(value) + raw.slice(call.end);
  }
  return raw;
}
function fixture(raw: string, options: Options = {}) {
  const seen = new Map<string, string>();
  const events: string[] = [];
  const registrations: Array<[string, string]> = [];
  const activities: unknown[] = [];
  const lazyScene = { kind: 'lazy-scene' };
  const storage = { getItem: (key: string) => seen.get(key) ?? null,
    setItem(key: string, value: string) { seen.set(key, value); events.push(`seen:${key}`); } };
  const state = {
    gamesLaunchNotice: options.requested === undefined ? notice : options.requested,
    setGamesLaunchNotice(next: GamesLaunchNotice | null) { events.push('clear-request'); state.gamesLaunchNotice = next; },
    bootstrap: (options.currentId === null ? null : { server: { id: options.currentId ?? 'server-a' } }),
    economy: { 'server-a': options.view ?? view() } as Record<string, View>,
    selfDeafened: options.deafened ?? false,
    openActivities(value: unknown) { activities.push(value); events.push('activities'); },
  };
  const deps: Record<string, unknown> = {
    react: { lazy: () => lazyScene, Suspense: 'test-suspense' },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../economy': { ...economy, launchStorage: () => options.brokenStorage ? null : storage },
    '../sounds': { registerBuiltinSound(name: string, url: string) { registrations.push([name, url]); } },
    '../store': { useStore: (select: (value: typeof state) => unknown) => select(state) },
  };
  const module = { exports: {} as { default: () => unknown } };
  runInNewContext(ts.transpileModule(withoutAssetIo(raw, options), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { module, exports: module.exports, require(id: string) {
    assert.ok(Object.hasOwn(deps, id), `R351/подготовка/host/import/${id}`); return deps[id];
  } }, { timeout: 2_000 });
  function render(): Element | null {
    const card = module.exports.default() as Element | null;
    if (!card) return null;
    assert.equal(typeof card.type, 'function', 'R351/подготовка/host/card');
    return (card.type as (props: Props) => Element)(card.props);
  }
  function scene(tree: Element | null): Element {
    assert.ok(tree, 'R351/подготовка/host/tree');
    assert.equal(tree.type, 'test-suspense', 'R351/подготовка/host/suspense');
    const child = tree.props.children as Element;
    assert.equal(child.type, lazyScene, 'R351/подготовка/host/lazy-scene');
    return child;
  }
  function fallback(tree: Element | null): Element {
    assert.ok(tree, 'R351/подготовка/host/loading-tree');
    const loading = tree.props.fallback as Element;
    assert.equal(typeof loading.type, 'function', 'R351/подготовка/host/loading');
    return (loading.type as (props: Props) => Element)(loading.props);
  }
  return { state, seen, events, registrations, activities, render, scene, fallback };
}
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as Element;
  return [node, ...elements(node.props.children)];
}
function guarded(check: (raw: string) => void, needle: string, next: string, address: string) {
  check(source);
  counterfact(() => {
    assert.equal(source.split(needle).length, 2, 'R351/подготовка/host/unique');
    assert.throws(() => check(source.replace(needle, next)), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.split('\n')[0] === address);
  });
  check(source);
}

// Ловит незаметное втягивание дополнительных ассетов/неправильный путь при сохранении работающего хоста.
it('R351 хост содержит ровно два glob: корабль и горн, оба получают готовые URL', () => {
  const check = (raw: string) => {
    const { file, calls } = assetCalls(raw);
    assert.equal(calls.length, 2, 'R351/host/glob-count');
    assert.deepEqual(calls.map(call => (call.arguments[0] as ts.StringLiteral).text), [
      '../assets/launch/ship.{png,webp,svg}', '../assets/sounds/games-launch.{mp3,ogg}',
    ], 'R351/host/glob-paths');
    for (const call of calls) assert.match(call.arguments[1]!.getText(file), /eager:\s*true[\s\S]*import:\s*'default'[\s\S]*query:\s*'\?url'/,
      'R351/host/glob-url');
  };
  guarded(check, '../assets/launch/ship.{png,webp,svg}', '../assets/launch/missing.{png,webp,svg}', 'R351/host/glob-paths');
});
it('вход из чистого браузера не показывает сцену ни получателю старого подарка, ни опоздавшему', () => {
  for (const mine of [1000, 0]) {
    const f = fixture(source, { requested: null, view: view({ gamesLaunch: { at: notice.at, gift: 1000, mine } }) });
    assert.equal(f.render(), null);
  }
});

it('живое событие показывает долю и значок своего сервера даже без открытого сервера', () => {
  for (const mine of [50, 0]) {
    const f = fixture(source, { requested: { ...notice, serverId: 'server-b', mine }, currentId: null });
    f.state.economy['server-b'] = view({ iconUrl: 'shell.svg' });
    const scene = f.scene(f.render());
    assert.equal(scene.props.mine, mine);
    assert.equal(scene.props.iconUrl, 'shell.svg');
  }
});

it('повторная доставка события после просмотра не открывает сцену', () => {
  const f = fixture(source);
  f.seen.set('gv_games_launch_seen:server-a', '1');
  assert.equal(f.render(), null);
});
// Ручной повтор обязан обходить «видел», но не обещать повторную выдачу настоящего подарка.
it('R351 replay показывается видевшему сцену, но всегда передаёт mine=0', () => {
  const check = (raw: string) => {
    const f = fixture(raw, { requested: { ...notice, replay: true } });
    f.seen.set('gv_games_launch_seen:server-a', '1');
    const tree = f.render();
    assert.notEqual(tree, null, 'R351/host/replay-seen');
    assert.equal(f.scene(tree).props.mine, 0, 'R351/host/replay-no-gift');
  };
  guarded(check, 'requested.replay || ', '', 'R351/host/replay-seen');
  guarded(check, 'mine={notice.replay ? 0 : notice.mine}', 'mine={notice.mine}', 'R351/host/replay-no-gift');
});
// При запрете localStorage повторная доставка в той же сессии тоже подавляется.
it('R351 сломанное хранилище не повторяет закрытый сервер в сессии, но другой сервер и replay доступны', () => {
  guarded(raw => {
    const f = fixture(raw, { brokenStorage: true });
    (f.scene(f.render()).props.onClose as () => void)();
    assert.equal(f.render(), null, 'R351/host/session-fallback');
    f.state.gamesLaunchNotice = notice;
    assert.equal(f.render(), null, 'R351/host/session-fallback');
    f.state.gamesLaunchNotice = { ...notice, serverId: 'server-b' };
    assert.notEqual(f.render(), null, 'R351/host/session-other-server');
    f.state.gamesLaunchNotice = { ...notice, replay: true };
    assert.equal(f.scene(f.render()).props.mine, 0, 'R351/host/session-replay');
  }, 'sessionSkipped.add(notice.serverId);', 'void notice.serverId;', 'R351/host/session-fallback');
});
// Отсутствие mp3 не должно заглушить доступный ogg; при обоих файлах выбор детерминирован.
it('R351 файловый горн регистрируется из mp3 либо ogg, предпочитает mp3 и не регистрируется без файла', () => {
  guarded(raw => {
    const mp3 = '../assets/sounds/games-launch.mp3';
    const ogg = '../assets/sounds/games-launch.ogg';
    const cases: Array<[Record<string, string>, Array<[string, string]>]> = [
      [{ [mp3]: '/assets/horn.mp3' }, [['gamesLaunch', '/assets/horn.mp3']]],
      [{ [ogg]: '/assets/horn.ogg' }, [['gamesLaunch', '/assets/horn.ogg']]],
      [{ [mp3]: '/assets/horn.mp3', [ogg]: '/assets/horn.ogg' }, [['gamesLaunch', '/assets/horn.mp3']]],
      [{}, []],
    ];
    for (const [hornFiles, expected] of cases) assert.deepEqual(fixture(raw, { hornFiles }).registrations, expected, 'R351/host/horn-registration');
  }, "if (hornFile) registerBuiltinSound('gamesLaunch', hornFile);", 'void hornFile;', 'R351/host/horn-registration');
});
// Проверяется настоящий import() в lazy, а не слово в комментарии; иначе полмегабайта попадает в основной бандл.
it('R351 сцена загружается через lazy import и Suspense показывает рабочий запасной экран', () => {
  const check = (raw: string) => {
    const file = parse(raw);
    assert.equal(file.statements.some(node => (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text === './GamesLaunchScene'), false,
    'R351/host/no-static-scene');
    const binding = nodes(file, ts.isVariableDeclaration).find(node => ts.isIdentifier(node.name) && node.name.text === 'GamesLaunchScene');
    const call = binding?.initializer;
    assert.ok(call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'lazy', 'R351/host/lazy');
    const loader = call.arguments[0];
    assert.ok(loader && ts.isArrowFunction(loader) && ts.isCallExpression(loader.body)
      && loader.body.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteralLike(loader.body.arguments[0]!)
      && (loader.body.arguments[0] as ts.StringLiteralLike).text === './GamesLaunchScene', 'R351/host/lazy-import');
    const f = fixture(raw, { artFiles: { '../assets/launch/ship.png': 'ship.png' } });
    const tree = f.render();
    f.scene(tree);
    const fallback = f.fallback(tree);
    assert.equal(fallback.props.role, 'dialog', 'R351/host/loading-dialog');
    assert.equal(elements(fallback).find(node => node.props.className === 'boom-loading-ship')?.props.src, 'ship.png', 'R351/host/loading-ship');
    assert.equal(typeof elements(fallback).find(node => node.props.className === 'boom-skip on')?.props.onClick, 'function', 'R351/host/loading-close');
  };
  guarded(check, "const GamesLaunchScene = lazy(() => import('./GamesLaunchScene'));", "import GamesLaunchScene from './GamesLaunchScene';", 'R351/host/no-static-scene');
});
// Закрытие во время медленной загрузки должно фиксировать просмотр так же, как уже загруженная сцена.
it('R351 «Пропустить» запасного экрана отмечает просмотр до снятия запроса', () => {
  guarded(raw => {
    const f = fixture(raw);
    const button = elements(f.fallback(f.render())).find(node => node.props.className === 'boom-skip on');
    assert.ok(button, 'R351/подготовка/host/loading-button');
    (button.props.onClick as () => void)();
    assert.deepEqual(f.events, ['seen:gv_games_launch_seen:server-a', 'clear-request'], 'R351/host/loading-close-order');
    assert.equal(f.render(), null, 'R351/host/loading-hidden');
  }, 'fallback={<LaunchLoading onClose={close} />}', 'fallback={<LaunchLoading onClose={() => {}} />}', 'R351/host/loading-close-order');
});
// Сцена получает именно обёртку close: голый onClose потерял бы постоянную отметку «видел».
it('R351 закрытие сцены записывает «видел» и снимает запрос один раз', () => {
  guarded(raw => {
    const f = fixture(raw);
    (f.scene(f.render()).props.onClose as () => void)();
    assert.deepEqual(f.events, ['seen:gv_games_launch_seen:server-a', 'clear-request'], 'R351/host/scene-close-order');
    assert.equal(f.render(), null);
    assert.deepEqual(f.activities, []);
  }, 'onClose={close}\n        onLaunch={launch}', 'onClose={onClose}\n        onLaunch={launch}', 'R351/host/scene-close-order');
});
// Запуск направляется к серверу сцены, а не к открытому в фоне серверу или прямо к отдельной игре.
it('R351 «Запустить» отмечает просмотр, снимает запрос и открывает список активностей сервера сцены', () => {
  guarded(raw => {
    const f = fixture(raw, { requested: { ...notice, serverId: 'server-b' } });
    (f.scene(f.render()).props.onLaunch as () => void)();
    assert.deepEqual(f.events, ['seen:gv_games_launch_seen:server-b', 'clear-request', 'activities'], 'R351/host/launch-order');
    assert.equal(JSON.stringify(f.activities), JSON.stringify([{ serverId: 'server-b', view: 'list' }]), 'R351/host/launch-target');
  }, "openActivities({ serverId: notice.serverId, view: 'list' });", "openActivities({ serverId: notice.serverId, view: 'wheel' });", 'R351/host/launch-target');
});
// При смене самозаглушения хост передаёт сцене актуальное разрешение звука, не играет горн самостоятельно.
it('R351 заглушённому пользователю сцена получает sound=false, остальным sound=true', () => {
  guarded(raw => {
    for (const deafened of [false, true]) {
      const f = fixture(raw, { deafened });
      assert.equal(f.scene(f.render()).props.sound, !deafened, 'R351/host/deafened');
      f.state.selfDeafened = !deafened;
      // Мутант sound=true может впервые проявиться и после смены деафена: это те же ворота звука.
      assert.equal(f.scene(f.render()).props.sound, deafened, 'R351/host/deafened');
    }
  }, 'sound={!deafened}', 'sound={true}', 'R351/host/deafened');
});
