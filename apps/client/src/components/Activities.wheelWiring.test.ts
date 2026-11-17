import assert from 'node:assert/strict';
import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type Sources = Map<string, string>;
type Mutation = { file: string; change: (source: string) => string };
const root = fileURLToPath(new URL('../', import.meta.url));
const extensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const isProductSource = (name: string) => extensions.has(extname(name)) && !/\.test\.[cm]?[jt]sx?$/.test(name);
function sources(): Sources {
  const result: Sources = new Map();
  const walk = (directory: string, prefix: string) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative + '/');
      else if (entry.isFile() && isProductSource(relative)) {
        result.set(relative, readFileSync(join(directory, entry.name), 'utf8').replace(/\r\n/g, '\n'));
      }
    }
  };
  walk(root, '');
  return result;
}
const ast = (file: string, source: string) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
  /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
function nodes<T extends ts.Node>(node: ts.Node, predicate: (child: ts.Node) => child is T): T[] {
  const result: T[] = [];
  const visit = (child: ts.Node) => { if (predicate(child)) result.push(child); ts.forEachChild(child, visit); };
  visit(node);
  return result;
}
const identifier = (node: ts.Node | undefined, name: string) => !!node && ts.isIdentifier(node) && node.text === name;
const literal = (node: ts.Node | undefined, text: string) => !!node && ts.isStringLiteralLike(node) && node.text === text;
function unwrap(node: ts.Expression): ts.Expression { return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node; }
function fn(file: ts.SourceFile, name: string, prefix: string) {
  const found = file.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(found?.body, `${prefix} настоящая функция ${name} найдена`);
  return found;
}
function imported(file: ts.SourceFile, name: string, module: string) {
  return file.statements.some(node => ts.isImportDeclaration(node) && literal(node.moduleSpecifier, module)
    && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(binding => binding.name.text === name && (!binding.propertyName || binding.propertyName.text === name)));
}
const jsx = (node: ts.Node, name: string) => nodes(node, ts.isJsxSelfClosingElement).filter(child => identifier(child.tagName, name));
const renderedVariable = (node: ts.Node, name: string) => nodes(node, ts.isJsxExpression).filter(child => identifier(child.expression, name)
  && (ts.isJsxElement(child.parent) || ts.isJsxFragment(child.parent)));
function returnOf(declaration: ts.FunctionDeclaration, prefix: string) {
  const statement = declaration.body!.statements.find(ts.isReturnStatement);
  assert.ok(statement?.expression, `${prefix} компонент возвращает JSX`);
  return statement.expression;
}
function controlsGuard(all: Sources) {
  const prefix = 'R329 кнопки:';
  const controls = ast('VoiceControls.tsx', all.get('components/VoiceControls.tsx')!);
  assert.ok(imported(controls, 'ActivitiesButton', './Activities'), `${prefix} док использует настоящую ActivitiesButton`);
  const voice = fn(controls, 'VoiceControls', prefix);
  assert.ok(voice.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword), `${prefix} проверяется экспортированный VoiceControls`);
  const declaration = voice.body!.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
    .find(binding => identifier(binding.name, 'activitiesButton'));
  assert.ok(declaration?.initializer && ts.isJsxSelfClosingElement(unwrap(declaration.initializer))
    && identifier((unwrap(declaration.initializer) as ts.JsxSelfClosingElement).tagName, 'ActivitiesButton'),
  `${prefix} activitiesButton действительно создаёт компонент, а не заглушку`);
  const branches = nodes(returnOf(voice, prefix), ts.isConditionalExpression).filter(node => ts.isBinaryExpression(node.condition)
    && node.condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    && identifier(node.condition.left, 'wide') && identifier(node.condition.right, 'sharing'));
  assert.equal(branches.length, 1, `${prefix} найдены обе реальные ветки обычного дока и показа`);
  assert.equal(renderedVariable(branches[0].whenTrue, 'activitiesButton').length, 1, `${prefix} кнопка остаётся во время показа`);
  assert.equal(renderedVariable(branches[0].whenFalse, 'activitiesButton').length, 1, `${prefix} кнопка остаётся в обычном доке`);
  const channel = ast('VoiceChannelView.tsx', all.get('components/VoiceChannelView.tsx')!);
  assert.ok(imported(channel, 'ActivitiesButton', './Activities'), `${prefix} телефон использует настоящую ActivitiesButton`);
  const mobile = fn(channel, 'MobileCallBar', prefix);
  const buttons = jsx(returnOf(mobile, prefix), 'ActivitiesButton');
  assert.equal(buttons.length, 1, `${prefix} телефонная панель действительно рисует ActivitiesButton`);
  assert.ok(buttons[0].attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && identifier(attribute.name, 'variant')
    && literal(attribute.initializer, 'call')), `${prefix} телефонная кнопка использует вариант call`);
}
function lazyGuard(all: Sources) {
  const prefix = 'R329 lazy:';
  const file = ast('Activities.tsx', all.get('components/Activities.tsx')!);
  assert.ok(imported(file, 'lazy', 'react') && imported(file, 'Suspense', 'react'), `${prefix} используются настоящие lazy и Suspense`);
  assert.ok(!file.statements.some(node => (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    && literal(node.moduleSpecifier, './WheelScene')), `${prefix} WheelScene не втягивается статическим import/export`);
  const declaration = file.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
    .find(binding => identifier(binding.name, 'WheelScene'));
  const lazy = declaration?.initializer;
  assert.ok(lazy && ts.isCallExpression(lazy) && identifier(lazy.expression, 'lazy') && lazy.arguments.length === 1,
    `${prefix} WheelScene объявлена через lazy`);
  const loader = lazy.arguments[0];
  assert.ok(ts.isArrowFunction(loader) && ts.isCallExpression(loader.body) && loader.body.expression.kind === ts.SyntaxKind.ImportKeyword
    && loader.body.arguments.length === 1 && literal(loader.body.arguments[0], './WheelScene'), `${prefix} lazy действительно загружает модуль сцены`);
  const host = fn(file, 'ActivitiesHost', prefix);
  const branch = host.body!.statements.filter(ts.isIfStatement).find(statement => ts.isBinaryExpression(statement.expression)
    && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && ts.isPropertyAccessExpression(statement.expression.left) && identifier(statement.expression.left.expression, 'act')
    && statement.expression.left.name.text === 'view' && literal(statement.expression.right, 'wheel'));
  assert.ok(branch, `${prefix} сцена подключена к ветке act.view=wheel настоящего ActivitiesHost`);
  const assignments = nodes(branch.thenStatement, ts.isBinaryExpression).filter(node => node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && identifier(node.left, 'main'));
  assert.equal(assignments.length, 1, `${prefix} ветка колеса формирует основной экран`);
  const rendered = jsx(assignments[0].right, 'WheelScene');
  assert.equal(rendered.length, 1, `${prefix} ветка действительно рисует ленивую WheelScene`);
  let parent: ts.Node | undefined = rendered[0].parent;
  while (parent && parent !== assignments[0] && !(ts.isJsxElement(parent) && identifier(parent.openingElement.tagName, 'Suspense'))) parent = parent.parent;
  assert.ok(parent && ts.isJsxElement(parent) && identifier(parent.openingElement.tagName, 'Suspense'), `${prefix} WheelScene находится под Suspense`);
  const returned = host.body!.statements.filter(ts.isReturnStatement).at(-1);
  assert.ok(returned?.expression && renderedVariable(returned.expression, 'main').length === 1, `${prefix} ActivitiesHost действительно возвращает выбранный экран`);
}

type AssetUse = { node: ts.Node; specifier: string; dynamic: boolean };
function wheelAssets(file: ts.SourceFile, name: string): AssetUse[] {
  const uses: AssetUse[] = [];
  const record = (node: ts.Node, argument: ts.Node | undefined, dynamic: boolean) => {
    if (!argument || !ts.isStringLiteralLike(argument)) return;
    const resolved = posix.normalize(posix.join(posix.dirname(name), argument.text.split(/[?#]/)[0]));
    const assetAt = resolved.indexOf('assets/wheel/');
    if (assetAt === 0 || (assetAt > 0 && resolved[assetAt - 1] === '/')) {
      uses.push({ node, specifier: resolved.slice(assetAt), dynamic });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) record(node, node.moduleSpecifier, false);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) record(node, node.moduleReference.expression, false);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || identifier(node.expression, 'require'))) {
      record(node, node.arguments[0], node.expression.kind === ts.SyntaxKind.ImportKeyword);
    } else if (ts.isNewExpression(node) && identifier(node.expression, 'URL')) record(node, node.arguments?.[0], false);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return uses;
}
function thumbnailEffect(use: AssetUse, file: ts.SourceFile) {
  if (!use.dynamic || use.specifier !== 'assets/wheel/captain.png') return false;
  let parent: ts.Node | undefined = use.node.parent;
  while (parent && !ts.isArrowFunction(parent)) parent = parent.parent;
  if (!parent || !ts.isCallExpression(parent.parent) || !identifier(parent.parent.expression, 'useEffect')
    || parent.parent.arguments[0] !== parent || parent.parent.arguments.length !== 2
    || !ts.isArrayLiteralExpression(parent.parent.arguments[1]) || parent.parent.arguments[1].elements.length !== 0) return false;
  let owner: ts.Node | undefined = parent.parent.parent;
  while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
  return !!owner && owner.parent === file && identifier(owner.name, 'ActivitiesCard') && imported(file, 'useEffect', 'react');
}
function sceneLoads(file: ts.SourceFile, name: string): ts.Node[] {
  const loads: ts.Node[] = [];
  const record = (node: ts.Node, argument: ts.Node | undefined) => {
    if (!argument || !ts.isStringLiteralLike(argument)) return;
    const resolved = posix.normalize(posix.join(posix.dirname(name), argument.text.split(/[?#]/)[0]))
      .replace(/\.[cm]?[jt]sx?$/, '');
    if (resolved === 'components/WheelScene') loads.push(node);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) record(node, node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) record(node, node.moduleReference.expression);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || identifier(node.expression, 'require'))) record(node, node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return loads;
}
function isSceneLoader(node: ts.Node, file: ts.SourceFile) {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return false;
  const arrow = node.parent;
  if (!ts.isArrowFunction(arrow) || arrow.body !== node) return false;
  const call = arrow.parent;
  if (!ts.isCallExpression(call) || !identifier(call.expression, 'lazy') || call.arguments[0] !== arrow) return false;
  const declaration = call.parent;
  return ts.isVariableDeclaration(declaration) && identifier(declaration.name, 'WheelScene')
    && declaration.initializer === call && ts.isVariableDeclarationList(declaration.parent)
    && ts.isVariableStatement(declaration.parent.parent) && declaration.parent.parent.parent === file;
}
function assetGuard(all: Sources) {
  const prefix = 'R329 assets:';
  let thumbnails = 0;
  let loaders = 0;
  let scene: AssetUse[] = [];
  for (const [name, source] of all) {
    // Тест читает PNG для проверки арта, но не входит в product-tree/бандл.
    // Та же граница нужна для in-memory Sources, не только для обхода файлов на диске.
    if (!isProductSource(name)) continue;
    const file = ast(name, source);
    for (const load of sceneLoads(file, name)) {
      assert.ok(name === 'components/Activities.tsx' && isSceneLoader(load, file),
        `${prefix} ${name} не загружает всю WheelScene в обход единственного lazy-loader`);
      loaders++;
    }
    const uses = wheelAssets(file, name);
    if (name === 'components/WheelScene.tsx') { scene = uses; continue; }
    for (const use of uses) {
      assert.ok(name === 'components/Activities.tsx' && thumbnailEffect(use, file),
        `${prefix} ${name} не втягивает арт колеса вне lazy-сцены; исключение только dynamic captain в effect ActivitiesCard`);
      thumbnails++;
    }
  }
  assert.equal(loaders, 1, `${prefix} ровно один реальный lazy-loader сцены`);
  assert.equal(thumbnails, 1, `${prefix} единственный thumbnail капитана действительно грузится только из effect`);
  assert.deepEqual(scene.filter(use => !use.dynamic).map(use => use.specifier).sort(),
    ['captain', 'face', 'hub', 'pointer', 'rim'].map(name => `assets/wheel/${name}.png`), `${prefix} все пять настоящих слоёв арта подключены внутри WheelScene`);
}

function replaceNode(source: string, node: ts.Node, replacement: string) {
  return source.slice(0, node.getStart()) + replacement + source.slice(node.end);
}
function proof(prefix: string, guard: (all: Sources) => void, mutations: Mutation[]) {
  guard(sources());
  counterfact(() => {
  for (const mutation of mutations) {
    const original = sources();
    guard(original);
    const changed = mutation.change(original.get(mutation.file)!);
    assert.notEqual(changed, original.get(mutation.file), 'R329 wiring setup: whole-source мутант действительно изменён');
    const mutant = new Map(original);
    mutant.set(mutation.file, changed);
    assert.throws(() => guard(mutant), error => error instanceof assert.AssertionError && error.message.startsWith(prefix));
    const fresh = sources();
    assert.equal(fresh.get(mutation.file), original.get(mutation.file), 'R329 wiring setup: приложение на диске не менялось');
    guard(fresh);
  }
  });
}

test('R329 «Активности» доступны в обеих раскладках VoiceControls и в настоящей телефонной MobileCallBar', () => proof('R329 кнопки:', controlsGuard, [
  ...[0, 1].map(index => ({ file: 'components/VoiceControls.tsx', change(source: string) {
    const file = ast('VoiceControls.tsx', source);
    const references = renderedVariable(returnOf(fn(file, 'VoiceControls', 'R329 wiring setup:'), 'R329 wiring setup:'), 'activitiesButton');
    assert.equal(references.length, 2, 'R329 wiring setup: два адресных места кнопки');
    return replaceNode(source, references[index], '{null}');
  } })),
  { file: 'components/VoiceChannelView.tsx', change(source) {
    const file = ast('VoiceChannelView.tsx', source);
    const buttons = jsx(returnOf(fn(file, 'MobileCallBar', 'R329 wiring setup:'), 'R329 wiring setup:'), 'ActivitiesButton');
    assert.equal(buttons.length, 1);
    return replaceNode(source, buttons[0], '<span />');
  } },
]));

test('R329 ActivitiesHost действительно возвращает WheelScene из lazy import под Suspense, без eager-модуля', () => proof('R329 lazy:', lazyGuard, [
  { file: 'components/Activities.tsx', change: source => `import EagerWheel from './WheelScene';\n${source}` },
  { file: 'components/Activities.tsx', change(source) {
    const file = ast('Activities.tsx', source);
    const buttons = jsx(fn(file, 'ActivitiesHost', 'R329 wiring setup:'), 'WheelScene');
    assert.equal(buttons.length, 1);
    return replaceNode(source, buttons[0], '<span />');
  } },
]));

test('R329 арт колеса изолирован lazy-сценой; только thumbnail капитана допустим динамически внутри effect карточки', () => {
  proof('R329 assets:', assetGuard, [
  { file: 'economy.ts', change: source => `import './components/WheelScene';\n${source}` },
  { file: 'components/Activities.tsx', change: source => `import eagerCaptain from '../assets/wheel/captain.png';\n${source}` },
  { file: 'economy.ts', change: source => `${source}\nvoid import('./assets/wheel/face.png');` },
  { file: 'economy.ts', change: source => `${source}\nconst eagerArt = new URL('./assets/wheel/face.png', import.meta.url);` },
  { file: 'components/Activities.tsx', change(source) {
    const file = ast('Activities.tsx', source);
    const thumbnail = wheelAssets(file, 'components/Activities.tsx');
    assert.equal(thumbnail.length, 1);
    return replaceNode(source, thumbnail[0].node, 'Promise.resolve({ default: "" })') + "\nvoid import('../assets/wheel/captain.png');";
  } },
  { file: 'components/WheelScene.tsx', change(source) {
    const file = ast('WheelScene.tsx', source);
    const face = wheelAssets(file, 'components/WheelScene.tsx').find(use => use.specifier === 'assets/wheel/face.png');
    assert.ok(face);
    return replaceNode(source, face.node, '');
  } },
  ]);
  const original = sources(), withTests = new Map(original);
  const references = [
    "import wheelArt from './assets/wheel/rim.png';",
    "void import('./assets/wheel/rim.png');",
    "const wheelArt = new URL('./assets/wheel/rim.png', import.meta.url);",
  ];
  for (const extension of ['ts', 'tsx']) for (const [index, reference] of references.entries()) {
    const product = `r359-wheel-art-control-${index}.${extension}`;
    // Сначала синтетический продукт: ошибка обязана адресно указывать на него, а не на счётчики в конце стража.
    counterfact(() => {
    const leaking = new Map([[product, reference], ...original]);
    assert.throws(() => assetGuard(leaking), error => error instanceof assert.AssertionError
      && error.message.startsWith(`R329 assets: ${product} не втягивает арт колеса вне lazy-сцены;`),
    'R359 продукт: обычный import/dynamic import/URL арта всё ещё запрещён');
    });
    withTests.set(`r359-wheel-art-control-${index}.test.${extension}`, reference);
  }
  // Те же шесть ссылок разрешены ТОЛЬКО под суффиксом .test.ts/.test.tsx, без исключения для обычных модулей.
  assetGuard(withTests);
  assetGuard(original);
});
