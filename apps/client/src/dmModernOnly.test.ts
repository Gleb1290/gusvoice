import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createStore } from 'zustand/vanilla';
import * as convSyncRules from './convSyncRules';
import * as streamAudioRules from './streamAudioRules';

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const parse = (name: string, text = source(name)) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

it('R135 последний Esc закрывает беседу на ПК без фокуса поиска, телефон возвращается к списку', () => {
  // Проверяем исполняемые узлы AST: упоминание прежнего focus в комментарии не считается вызовом.
  const name = 'components/DmChatView.tsx';
  const original = source(name);
  function callback(text: string) {
    const ast = parse(name, text);
    const props = nodes(ast, ts.isJsxAttribute).filter(n => n.name.getText(ast) === 'onEscapeClose');
    assert.equal(props.length, 1, 'один обработчик последнего Esc');
    const init = props[0]!.initializer;
    assert.ok(init && ts.isJsxExpression(init) && init.expression && ts.isArrowFunction(init.expression));
    const body = init.expression.body;
    assert.ok(ts.isBlock(body));
    return { ast, body };
  }
  function check(text: string) {
    const { ast, body } = callback(text);
    const phone = body.statements.find(n => ts.isIfStatement(n) && n.expression.getText(ast) === 'phone');
    assert.ok(phone && ts.isIfStatement(phone), 'телефон имеет отдельную ветку');
    assert.ok(ts.isReturnStatement(phone.thenStatement) && phone.thenStatement.expression,
      'возврат к списку не проваливается в закрытие ПК');
    assert.equal(phone.thenStatement.expression.getText(ast), "s.setMobilePane('list')");
    const desktop = body.statements.slice(body.statements.indexOf(phone) + 1);
    const close = desktop.flatMap(n => nodes(n, ts.isCallExpression)).find(n => n.expression.getText(ast) === 'useStore.setState');
    assert.ok(close && close.arguments.length === 1 && ts.isObjectLiteralExpression(close.arguments[0]!));
    const current = close.arguments[0].properties.find(n => ts.isPropertyAssignment(n) && n.name.getText(ast) === 'currentDmId');
    assert.ok(current && ts.isPropertyAssignment(current) && current.initializer.kind === ts.SyntaxKind.NullKeyword,
      'ПК закрывает выбранную беседу');
    const calls = desktop.flatMap(n => nodes(n, ts.isCallExpression));
    assert.ok(!calls.some(n => ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'focus'),
      'последний Esc не фокусирует поиск');
    const strings = desktop.flatMap(n => nodes(n, ts.isStringLiteral));
    assert.ok(!strings.some(n => n.text.includes('.dm-find')), 'поиск не участвует в закрытии беседы');
  }
  check(original);
  const close = 'useStore.setState({ currentDmId: null });';
  assert.equal(original.split(close).length - 1, 1);
  const { ast, body } = callback(original);
  const phone = body.statements.find(n => ts.isIfStatement(n) && n.expression.getText(ast) === 'phone')!;
  const mutants = [
    original.replace(close, close + " requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.dm-find input')?.focus());"),
    original.replace(close, 'useStore.setState({});'),
    original.slice(0, phone.getStart(ast)) + original.slice(phone.end),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, original);
    assert.throws(() => check(mutant), assert.AssertionError);
  }
});

function nodes<T extends ts.Node>(root: ts.Node, guard: (n: ts.Node) => n is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => { if (guard(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return found;
}
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
}
function hasTerm(node: ts.Expression, term: string, ast: ts.SourceFile): boolean {
  node = unwrap(node);
  return node.getText(ast) === term || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && (hasTerm(node.left, term, ast) || hasTerm(node.right, term, ast)));
}
// Это проверка доминирующей ветви JSX, не поиск слов в комментариях: кнопка должна находиться
// внутри !dmOff && … либо в false-ветви dmOff ? … : … . Полные компоненты тянут голос/браузер.
function guarded(node: ts.Node, term: string, ast: ts.SourceFile): boolean {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isBinaryExpression(parent) && parent.right === child && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && hasTerm(parent.left, term, ast)) return true;
    if (ts.isConditionalExpression(parent) && parent.condition.getText(ast) === 'dmOff') {
      if (term === 'dmOff' && parent.whenTrue === child) return true;
      if (term === '!dmOff' && parent.whenFalse === child) return true;
    }
  }
  return false;
}
function checkUi(name: string, text = source(name)) {
  const ast = parse(name, text);
  const dmOff = nodes(ast, ts.isVariableDeclaration).find((n) => n.name.getText(ast) === 'dmOff');
  assert.ok(dmOff?.initializer);
  assert.match(dmOff.initializer.getText(ast), /^useStore\(\(s\) => dmNeedsServerUpdate\(s\.serverFeatures\)\)$/);
  const captions = nodes(ast, ts.isJsxExpression).filter((n) => n.expression?.getText(ast) === 'DM_SERVER_UPDATE_TEXT');
  assert.equal(captions.length, 1, `${name}: одна заглушка`);
  assert.ok(guarded(captions[0], 'dmOff', ast), `${name}: заглушка только при несовместимом сервере`);
  const buttons = nodes(ast, ts.isJsxElement).filter((n) => n.openingElement.tagName.getText(ast) === 'button' && (
    n.children.some((c) => ts.isJsxText(c) && c.text.trim() === 'Написать') ||
    n.openingElement.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText(ast) === 'aria-label' && a.initializer && ts.isStringLiteral(a.initializer) && a.initializer.text === 'Написать')
  ));
  assert.equal(buttons.length, name.includes('MainLayout') ? 1 : 2, `${name}: найдены все точки начала ЛС`);
  for (const button of buttons) assert.ok(guarded(button, '!dmOff', ast), `${name}: «Написать» защищено !dmOff`);
  if (name.includes('MainLayout')) {
    const chats = nodes(ast, ts.isJsxSelfClosingElement).filter((n) => n.tagName.getText(ast) === 'DmChatView');
    assert.equal(chats.length, 1);
    assert.ok(guarded(chats[0], '!dmOff', ast), 'несовместимый сервер не получает живую ленту');
  }
}

it('главная область показывает заглушку при dmOff, а лента и «Написать» остаются в совместимой ветви', () => {
  checkUi('components/MainLayout.tsx');
});
it('список ЛС показывает заглушку на телефоне и прячет обе кнопки «Написать» при dmOff', () => {
  checkUi('components/DmSidebar.tsx');
});
it('убранный !dmOff у любой из двух кнопок списка обнаруживается независимо', () => {
  const name = 'components/DmSidebar.tsx';
  for (const before of ['!phone && !dmOff && (', 'phone && !dmOff && !selecting']) {
    const original = source(name);
    checkUi(name, original);
    assert.ok(original.includes(before));
    const changed = original.replace(before, before.replace('!dmOff && ', ''));
    assert.throws(() => checkUi(name, changed), assert.AssertionError);
  }
});
it('заглушка главной области не может стать постоянной или исчезнуть из-за инверсии dmOff', () => {
  const name = 'components/MainLayout.tsx';
  const original = source(name);
  checkUi(name, original);
  assert.ok(original.includes('{dmOff ? ('));
  for (const replacement of ['{!dmOff ? (', '{true ? (', '{false ? (']) {
    assert.throws(() => checkUi(name, original.replace('{dmOff ? (', replacement)), assert.AssertionError);
  }
});

function storeFixture(mutate?: (s: string) => string) {
  const calls: string[] = [];
  const api = new Proxy({}, { get: (_target, key) => async () => { calls.push(`api:${String(key)}`); return { id: 'c' }; } });
  const deps: Record<string, unknown> = {
    zustand: { create: createStore }, './api': { api, apiFor: () => api, getToken: () => null },
    './config': { activeInstanceId: () => null, config: { apiUrl: 'https://example.test' } },
    './convSyncRules': convSyncRules, './streamAudioRules': streamAudioRules,
    './convStore': { createConvActions: () => ({}) }, './convCacheRules': {}, './dmListRules': {},
    './convCache': {}, './channelRules': {}, './historyPage': {}, './channelPrefs': {}, './lastPlace': {},
    './tabSync': {}, './hotkeys': { isMobile: () => false }, './sounds': {}, './nativeUnifiedPush': {},
    './tipHints': {}, './toastRules': {}, './profilePatch': {}, './voiceCueRules': {}, './voiceSession': {},
    './instanceScope': { scopedGetItem: () => null },
  };
  const original = source('store.ts');
  const module = { exports: {} };
  // Выполняем весь production-модуль, а не извлечённую функцию: store-замыкания и Zustand настоящие.
  runInNewContext(ts.transpileModule(mutate ? mutate(original) : original, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    module, exports: module.exports, console, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: () => { calls.push('fetch'); throw new Error('Неожиданный сетевой вызов'); },
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `не подменён импорт ${id}`); return deps[id]; },
  }, { filename: 'store.ts' });
  const store = (module.exports as typeof import('./store')).useStore;
  store.setState({
    convEnsureList: async () => { calls.push('conv:list'); },
    convOpenWith: async (id) => { calls.push(`conv:open:${id}`); return 'c'; },
    selectDm: async (id) => { calls.push(`select:${id}`); },
  });
  return { store, calls };
}
async function disabledScenario(mutate?: (s: string) => string) {
  const { store, calls } = storeFixture(mutate);
  store.setState({ convActive: false, view: 'server', currentDmId: 'old', mobilePane: 'content' });
  await store.getState().loadDms();
  assert.deepEqual(calls, [], 'loadDms не обращается ни к API, ни к conv');
  await store.getState().openDmWith('peer');
  assert.deepEqual(calls, [], 'openDmWith не обращается ни к API, ни к conv');
  const state = store.getState();
  assert.equal(state.view, 'dm');
  assert.equal(state.currentDmId, null);
  assert.equal(state.mobilePane, 'list');
}
it('без бесед loadDms не ходит в сеть, openDmWith открывает список с заглушкой без запроса', async () => {
  await disabledScenario();
});
it('при поддержке бесед loadDms грузит список, openDmWith открывает и выбирает настоящую беседу', async () => {
  const { store, calls } = storeFixture();
  store.setState({ convActive: true });
  await store.getState().loadDms();
  await store.getState().openDmWith('peer');
  assert.deepEqual(calls, ['conv:list', 'conv:open:peer', 'select:c']);
});
it('снятие гейта с загрузки или открытия ЛС обнаруживается на полном модуле стора', async () => {
  await disabledScenario();
  for (const name of ['loadDms', 'openDmWith']) {
    await assert.rejects(() => disabledScenario((text) => {
      const ast = parse('store.ts', text);
      const action = nodes(ast, ts.isPropertyAssignment).find((n) => n.name.getText(ast) === name);
      assert.ok(action);
      const old = action.getText(ast);
      const changed = old.replace('if (get().convActive)', 'if (true)');
      assert.notEqual(changed, old);
      return text.slice(0, action.getStart(ast)) + changed + text.slice(action.end);
    }), assert.AssertionError);
  }
});

it('клиент не вызывает старые /dm API, а шлюз не обрабатывает dm.* и read.dm', () => {
  const sockets = parse('sockets.ts');
  const cases = nodes(sockets, ts.isCaseClause).map((n) => n.expression).filter(ts.isStringLiteral).map((n) => n.text);
  assert.ok(cases.includes('conv.change'), 'живой путь бесед остаётся');
  assert.ok(cases.includes('message.create'), 'каналы остаются');
  assert.deepEqual(cases.filter((name) => name.startsWith('dm.') || name === 'read.dm'), []);
  const api = parse('api.ts');
  const paths = nodes(api, (n): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateHead => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)).map((n) => n.text);
  assert.ok(paths.some((path) => /^\/(?:api\/)?conv(?:\/|$)/.test(path)), 'новые ручки есть');
  assert.deepEqual(paths.filter((path) => /^\/(?:api\/)?dm(?:s)?(?:\/|$|\?)/.test(path)), []);
});
