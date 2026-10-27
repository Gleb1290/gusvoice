import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { Window } from 'happy-dom';
import ts from 'typescript';

const source = readFileSync(new URL('./MessagePane.tsx', import.meta.url), 'utf8');
const pickers = ['EmojiPicker', 'StickerPicker', 'GifPicker'] as const;

function nodes<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  function visit(node: ts.Node) {
    if (guard(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function parse(text: string, name: string) {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function hoverOptions(text: string) {
  const file = parse(text, 'MessagePane.tsx');
  const declarations = nodes(file, ts.isVariableDeclaration).filter((node) =>
    ts.isIdentifier(node.name) && node.name.text === 'emojiHover');
  assert.equal(declarations.length, 1, 'единственная декларация emojiHover');
  const call = declarations[0].initializer;
  assert.ok(call && ts.isCallExpression(call) && ts.isIdentifier(call.expression)
    && call.expression.text === 'useHoverPanel', 'emojiHover действительно вызывает useHoverPanel');
  assert.equal(call.arguments.length, 1);
  const options = call.arguments[0];
  assert.ok(ts.isObjectLiteralExpression(options), 'настройки настоящего вызова — объект');
  return { file, options };
}

function selector(text: string, key: 'panel' | 'trigger') {
  const { file, options } = hoverOptions(text);
  const props = options.properties.filter((prop): prop is ts.PropertyAssignment =>
    ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
    && prop.name.text === key);
  assert.equal(props.length, 1, `единственное свойство ${key} у emojiHover`);
  const value = props[0].initializer;
  assert.ok(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value),
    `${key} задан статической строкой, не исполняем исходник`);
  return { text: value.text, start: value.getStart(file), end: value.end };
}

function rootClasses(name: typeof pickers[number]): string {
  const file = parse(readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8'), `${name}.tsx`);
  const components = nodes(file, ts.isFunctionDeclaration).filter((node) => node.name?.text === name);
  assert.equal(components.length, 1, `найден настоящий компонент ${name}`);
  const roots = nodes(components[0], ts.isJsxOpeningElement).filter((node) =>
    node.attributes.properties.some((attr) => ts.isJsxAttribute(attr) && attr.name.getText(file) === 'ref'
      && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression
      && ts.isIdentifier(attr.initializer.expression) && attr.initializer.expression.text === 'popRef'));
  assert.equal(roots.length, 1, `${name}: проверяется корень ref={popRef}, не вложенная плитка`);
  const classes = roots[0].attributes.properties.filter((attr): attr is ts.JsxAttribute =>
    ts.isJsxAttribute(attr) && attr.name.getText(file) === 'className');
  assert.equal(classes.length, 1, `${name}: класс именно корня`);
  const init = classes[0].initializer;
  assert.ok(init, `${name}: корень имеет className`);
  if (ts.isStringLiteral(init)) return init.text;
  assert.ok(ts.isJsxExpression(init) && init.expression, `${name}: className — JSX-выражение`);
  const value = init.expression;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  assert.ok(ts.isTemplateExpression(value), `${name}: читаем только статический префикс шаблона`);
  // Условные хвосты добавляют expr/docked; обязательный класс корня лежит ДО первой подстановки.
  assert.ok(value.head.text.trim().length > 0, `${name}: непустые обязательные классы корня`);
  return value.head.text;
}

function checkWiring(text: string) {
  const panel = selector(text, 'panel').text;
  const trigger = selector(text, 'trigger').text;
  const window = new Window();
  try {
    const composer = window.document.createElement('div');
    composer.className = 'composer';
    const button = window.document.createElement('button');
    button.className = 'att-btn emoji';
    composer.append(button);
    window.document.body.append(composer);
    assert.equal(button.matches(trigger), true, 'R293:trigger-композера');
    const outside = window.document.createElement('button');
    outside.className = button.className;
    window.document.body.append(outside);
    assert.equal(outside.matches(trigger), false, 'R293:trigger-не-вне-композера');
    for (const name of pickers) {
      const root = window.document.createElement('div');
      root.className = rootClasses(name);
      assert.equal(root.matches(panel), true, `R293:panel-корень-${name}`);
    }
  } finally {
    window.close();
  }
}

function replacePanel(text: string, replacement: string) {
  const target = selector(text, 'panel');
  assert.notEqual(target.text, replacement, 'адресный мутант меняет значение panel');
  return text.slice(0, target.start) + JSON.stringify(replacement) + text.slice(target.end);
}

function caughtStickerMismatch(error: unknown): boolean {
  return error instanceof assert.AssertionError
    && error.code === 'ERR_ASSERTION'
    && error.message.split(/\r?\n/, 1)[0] === 'R293:panel-корень-StickerPicker'
    && error.operator === 'strictEqual' && error.actual === false && error.expected === true;
}

it('R293: селектор emojiHover удерживает корни всех трёх пикеров и адресует кнопку только в композере', () => {
  checkWiring(source);
});

it('R293: контрфакт: возврат к одному emoji-pop теряет настоящий корень стикеров', () => {
  checkWiring(source);
  assert.throws(() => checkWiring(replacePanel(source, '.emoji-pop')), caughtStickerMismatch);
});

it('R293: контрфакт: gif-pop вместо sticker-pop удерживает GIF, но теряет вкладку стикеров', () => {
  checkWiring(source);
  const current = selector(source, 'panel').text;
  assert.equal(current.split('.sticker-pop').length, 2, 'ровно один адресный класс стикеров');
  const changed = replacePanel(source, current.replace('.sticker-pop', '.gif-pop'));
  const panel = selector(changed, 'panel').text;
  const window = new Window();
  try {
    for (const name of ['EmojiPicker', 'GifPicker'] as const) {
      const root = window.document.createElement('div');
      root.className = rootClasses(name);
      assert.equal(root.matches(panel), true, `R293:gif-мутант-сохраняет-${name}`);
    }
  } finally {
    window.close();
  }
  assert.throws(() => checkWiring(changed), caughtStickerMismatch);
});
