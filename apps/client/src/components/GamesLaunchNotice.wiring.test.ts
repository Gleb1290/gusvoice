import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./MainLayout.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const parse = (raw: string) => ts.createSourceFile('MainLayout.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes(file: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  function visit(node: ts.Node) { found.push(node); ts.forEachChild(node, visit); }
  visit(file); return found;
}
function variable(file: ts.SourceFile, name: string): ts.VariableDeclaration {
  const found = nodes(file).filter((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(found.length, 1, `R343/подготовка/wiring/variable/${name}`);
  assert.ok(found[0]!.initializer, `R343/подготовка/wiring/initializer/${name}`);
  return found[0]!;
}
const compact = (node: ts.Node, file: ts.SourceFile) => node.getText(file).replace(/\s+/g, '');
function terms(node: ts.Expression, file: ts.SourceFile): string[] {
  if (ts.isParenthesizedExpression(node)) return terms(node.expression, file);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return [...terms(node.left, file), ...terms(node.right, file)];
  return [compact(node, file)];
}
/** Мутируется AST-адрес целого исходного модуля; тела/условия не исполняются отдельно через eval. */
function replaceInitializer(raw: string, name: string, replace: (text: string) => string): string {
  const file = parse(raw);
  const initial = variable(file, name).initializer!;
  const previous = initial.getText(file);
  const next = replace(previous);
  assert.notEqual(next, previous, 'R343/подготовка/wiring/mutant-change');
  return raw.slice(0, initial.getStart(file)) + next + raw.slice(initial.end);
}
function guarded(check: (file: ts.SourceFile) => void, mutate: (raw: string) => string, address: string) {
  check(parse(source));
  counterfact(() => {
    assert.throws(() => check(parse(mutate(source))), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.split('\n')[0] === address);
  });
  check(parse(source));
}

it('R343 MainLayout загружает карточку только через React.lazy, не добавляя статический импорт', () => {
  guarded(file => {
    const initial = variable(file, 'GamesLaunchHost').initializer!;
    assert.equal(compact(initial, file), "lazy(()=>import('./GamesLaunchNotice'))", 'R343/wiring/lazy');
    const staticImports = file.statements.filter(ts.isImportDeclaration)
      .filter(node => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === './GamesLaunchNotice');
    assert.equal(staticImports.length, 0, 'R343/wiring/no-static-import');
  }, raw => replaceInitializer(raw, 'GamesLaunchHost', () => "() => import('./GamesLaunchNotice')"), 'R343/wiring/lazy');
});
it('R343 MainLayout связывает хост с общими воротами окон и не показывает поверх ручных либо автоматических итогов', () => {
  guarded(file => {
    assert.deepEqual(terms(variable(file, 'launchHosted').initializer!, file), ['!!launchRequested', 'recapAutoAllowed', '!recapShown'], 'R343/wiring/launch-gates');
  }, raw => replaceInitializer(raw, 'launchHosted', text => text.replace(' && !recapShown', '')), 'R343/wiring/launch-gates');
});
for (const [name, blocker] of [
  ['перерасчёт', 'recount'], ['приветствие', 'welcomeOpen'], ['настройки', 'settingsOpen'], ['админка', 'adminOpen'],
  ['шпаргалка', 'cheatOpen'], ['стенд', 'benchOpen'], ['входящий тык', 'incomingPoke'], ['активности', 'activitiesOpen'],
] as const) it(`R343 MainLayout: ${name} закрывает ворота объявления запуска`, () => {
  const address = `R343/wiring/blocker/${blocker}`;
  guarded(file => {
    const gates = terms(variable(file, 'recapAutoAllowed').initializer!, file);
    assert.equal(gates.includes(`!${blocker}`), true, address);
    assert.equal(terms(variable(file, 'launchHosted').initializer!, file).includes('recapAutoAllowed'), true, address);
  }, raw => replaceInitializer(raw, 'recapAutoAllowed', text => text.replace(`!${blocker}`, 'true')), address);
});
it('R343 MainLayout монтирует ровно один хост внутри Suspense только под launchHosted', () => {
  guarded(file => {
    const hosts = nodes(file).filter((node): node is ts.JsxSelfClosingElement => ts.isJsxSelfClosingElement(node)
      && ts.isIdentifier(node.tagName) && node.tagName.text === 'GamesLaunchHost');
    assert.equal(hosts.length, 1, 'R343/wiring/host-count');
    const suspense = hosts[0]!.parent;
    assert.equal(ts.isJsxElement(suspense) && compact(suspense.openingElement.tagName, file) === 'Suspense', true, 'R343/wiring/suspense');
    let parent: ts.Node | undefined = suspense.parent;
    while (parent && !ts.isJsxExpression(parent)) parent = parent.parent;
    assert.ok(parent && ts.isJsxExpression(parent), 'R343/подготовка/wiring/jsx-condition');
    const expression = parent.expression;
    assert.equal(!!expression && ts.isBinaryExpression(expression)
      && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      && compact(expression.left, file) === 'launchHosted', true, 'R343/wiring/mount-gate');
  }, raw => {
    assert.equal(raw.split('{launchHosted && (').length, 2, 'R343/подготовка/wiring/mount-anchor');
    return raw.replace('{launchHosted && (', '{launchRequested && (');
  }, 'R343/wiring/mount-gate');
});
it('R343 MainLayout не разрешает бонусному гусю выглядывать одновременно с событием запуска', () => {
  guarded(file => {
    assert.equal(terms(variable(file, 'goosePresentationAllowed').initializer!, file).includes('!launchRequested'), true, 'R343/wiring/goose');
  }, raw => replaceInitializer(raw, 'goosePresentationAllowed', text => text.replace('!launchRequested', 'true')), 'R343/wiring/goose');
});
