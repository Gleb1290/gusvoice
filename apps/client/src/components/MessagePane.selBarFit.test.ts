import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const raw = readFileSync(new URL('./MessagePane.tsx', import.meta.url), 'utf8');

function nodes<T extends ts.Node>(root: ts.Node, is: (n: ts.Node) => n is T): T[] {
  const found: T[] = [];
  function visit(n: ts.Node) {
    if (is(n)) found.push(n);
    ts.forEachChild(n, visit);
  }
  visit(root);
  return found;
}

function wiring(source: string) {
  const ast = ts.createSourceFile('MessagePane.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function imported(module: string, exported: string) {
    const matches = nodes(ast, ts.isImportDeclaration).filter(n =>
      ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === module);
    const imports = matches.flatMap(n => {
      const bindings = n.importClause?.namedBindings;
      return bindings && ts.isNamedImports(bindings) ? [...bindings.elements] : [];
    }).filter(n => (n.propertyName?.text ?? n.name.text) === exported && !n.isTypeOnly);
    assert.equal(imports.length, 1, `${exported} импортирован из настоящего ${module}`);
    return imports[0]!.name.text;
  }
  const hookName = imported('../useSelBarFit', 'useSelBarFit');
  const refName = imported('react', 'useRef');
  const calls = nodes(ast, ts.isCallExpression).filter(n =>
    ts.isIdentifier(n.expression) && n.expression.text === hookName);
  assert.equal(calls.length, 1, 'панель использует один настоящий хук замера');
  const call = calls[0]!;
  const bars = nodes(ast, ts.isJsxOpeningElement).filter(n => n.attributes.properties.some(a =>
    ts.isJsxAttribute(a) && a.name.getText(ast) === 'className' &&
    a.initializer && ts.isStringLiteral(a.initializer) &&
    ['composer', 'sel-bar'].every(c => a.initializer!.getText(ast).slice(1, -1).split(/\s+/).includes(c))));
  assert.equal(bars.length, 1, 'проверяется реальная панель выбора, не соседнее поле');
  return { ast, call, bar: bars[0]!, refName };
}

function counterfacts(check: (source: string) => void, replacements: [string, string][]) {
  check(raw);
  for (const [from, to] of replacements) {
    assert.equal(raw.split(from).length - 1, 1, `однозначный якорь мутанта: ${from}`);
    assert.throws(() => check(raw.replace(from, to)), assert.AssertionError);
  }
}

it('R123 панель выбора отдаёт хуку свой DOM ref, а не ссылку на соседнее поле', () => {
  // Без ref измерение не видит переполнение даже при работающих ResizeObserver и CSS.
  counterfacts(source => {
    const { ast, call, bar } = wiring(source);
    const refs = bar.attributes.properties.filter(a => ts.isJsxAttribute(a) && a.name.getText(ast) === 'ref');
    assert.equal(refs.length, 1, 'DOM панели подключён к ref');
    const attr = refs[0] as ts.JsxAttribute;
    assert.ok(attr.initializer && ts.isJsxExpression(attr.initializer));
    const expression = attr.initializer.expression;
    assert.ok(expression && ts.isIdentifier(expression));
    assert.ok(call.arguments[0] && ts.isIdentifier(call.arguments[0]));
    assert.equal(expression.text, call.arguments[0].text, 'хук измеряет именно DOM панели');
  }, [
    ['className="composer sel-bar" ref={selBarRef}', 'className="composer sel-bar"'],
    ['className="composer sel-bar" ref={selBarRef}', 'className="composer sel-bar" ref={composerRef}'],
  ]);
});

it('R123 ссылка панели стабильна между рендерами и начинается без DOM до монтажа', () => {
  // Новый объект на каждом рендере рассоединяет хук и реальный элемент при изменении выбора.
  counterfacts(source => {
    const { ast, call, refName } = wiring(source);
    assert.ok(call.arguments[0] && ts.isIdentifier(call.arguments[0]));
    const name = call.arguments[0].text;
    const declarations = nodes(ast, ts.isVariableDeclaration).filter(n => ts.isIdentifier(n.name) && n.name.text === name);
    assert.equal(declarations.length, 1);
    const init = declarations[0]!.initializer;
    assert.ok(init && ts.isCallExpression(init));
    assert.ok(ts.isIdentifier(init.expression));
    assert.equal(init.expression.text, refName, 'ссылка создана React useRef');
    assert.equal(init.arguments.length, 1);
    assert.equal(init.arguments[0]!.kind, ts.SyntaxKind.NullKeyword);
  }, [
    ['const selBarRef = useRef<HTMLDivElement>(null);', 'const selBarRef = { current: null };'],
  ]);
});

it('R123 смена числа выбранных сообщений меняет ключ повторного замера подписей', () => {
  // Переход 9 → 10 расширяет подпись без изменения ширины контейнера: одного ResizeObserver мало.
  counterfacts(source => {
    const { call } = wiring(source);
    assert.equal(call.arguments.length, 2, 'хук получает ключ повторного замера');
    const key = call.arguments[1]!;
    const counts = nodes(key, ts.isPropertyAccessExpression).filter(n =>
      ts.isIdentifier(n.expression) && n.expression.text === 'pickedIds' && n.name.text === 'length');
    assert.equal(counts.length, 1, 'ключ включает число сообщений, показанное рядом с Переслать');
  }, [
    ['useSelBarFit(selBarRef, `${selecting ? 1 : 0}|${pickedIds.length}|${pickedOne && !composerReplacement ? 1 : 0}`);', 'useSelBarFit(selBarRef);'],
    ['useSelBarFit(selBarRef, `${selecting ? 1 : 0}|${pickedIds.length}|${pickedOne && !composerReplacement ? 1 : 0}`);', 'useSelBarFit(selBarRef, `${selecting ? 1 : 0}|${0}|${pickedOne && !composerReplacement ? 1 : 0}`);'],
  ]);
});

it('R123 показ панели и появление кнопки Ответить также вызывают повторный замер', () => {
  // После снятия выбора ref пуст; новый показ и смена набора действий требуют замера даже при той же ширине.
  counterfacts(source => {
    const { call } = wiring(source);
    assert.equal(call.arguments.length, 2);
    const ids = nodes(call.arguments[1]!, ts.isIdentifier).map(n => n.text);
    for (const name of ['selecting', 'pickedOne', 'composerReplacement']) assert.ok(ids.includes(name), `ключ учитывает ${name}`);
  }, [
    ['useSelBarFit(selBarRef, `${selecting ? 1 : 0}|${pickedIds.length}|${pickedOne && !composerReplacement ? 1 : 0}`);', 'useSelBarFit(selBarRef, `${0}|${pickedIds.length}|${pickedOne && !composerReplacement ? 1 : 0}`);'],
    ['useSelBarFit(selBarRef, `${selecting ? 1 : 0}|${pickedIds.length}|${pickedOne && !composerReplacement ? 1 : 0}`);', 'useSelBarFit(selBarRef, `${selecting ? 1 : 0}|${pickedIds.length}|${0}`);'],
  ]);
});
