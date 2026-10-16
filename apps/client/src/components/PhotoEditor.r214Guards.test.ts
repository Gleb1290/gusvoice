import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const editor = readFileSync(new URL('./PhotoEditor.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const viewer = readFileSync(new URL('./Lightbox.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function all<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  function walk(node: ts.Node) { if (predicate(node)) result.push(node); ts.forEachChild(node, walk); }
  walk(root); return result;
}
function ref(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) return ref(node.expression);
  if (ts.isPropertyAccessExpression(node)) { const base = ref(node.expression); return base ? `${base}.${node.name.text}` : null; }
  return null;
}
function call(node: ts.Node | undefined, name: string, args?: readonly string[]): node is ts.CallExpression {
  return !!node && ts.isCallExpression(node) && ref(node.expression) === name && (!args || node.arguments.length === args.length && args.every((arg, i) => ref(node.arguments[i]) === arg));
}
function numeric(node: ts.Node | undefined, value: number) { return !!node && ts.isNumericLiteral(node) && Number(node.text) === value; }
function body(raw: string, name: string) {
  const file = ts.createSourceFile(`${name}.tsx`, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = file.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(!!component?.body, true, `полный компонент ${name} существует`); return { file, component: component!, block: component!.body! };
}
function declaration(block: ts.Block, name: string) {
  const candidates = block.statements.flatMap(statement => ts.isVariableStatement(statement) ? Array.from(statement.declarationList.declarations).filter(node => ref(node.name) === name) : []);
  assert.equal(candidates.length, 1, `единственное объявление ${name} в собственном блоке`); return candidates[0]!;
}
function done(raw: string) {
  const { file, block } = body(raw, 'PhotoEditor'), arrow = declaration(block, 'done').initializer;
  assert.equal(!!arrow && ts.isArrowFunction(arrow) && ts.isBlock(arrow.body), true, 'done — настоящая стрелка в компоненте');
  return { file, block: (arrow as ts.ArrowFunction).body as ts.Block };
}
function prune(raw: string) {
  const { file, block } = done(raw), fin = declaration(block, 'fin').initializer;
  assert.equal(!!fin && ts.isObjectLiteralExpression(fin), true, 'финальная правка создаётся объектом');
  const fields = (fin as ts.ObjectLiteralExpression).properties;
  assert.equal(fields.some(field => ts.isSpreadAssignment(field) && ref(field.expression) === 'edit'), true, 'готовая правка сохраняет исходное состояние редактора');
  const marks = fields.filter((field): field is ts.PropertyAssignment => ts.isPropertyAssignment(field) && ref(field.name) === 'marks');
  assert.equal(marks.length, 1);
  const value = marks[0]!.initializer;
  assert.equal(call(value, 'pruneMarks') && value.arguments.length === 1, true, 'done вычищает пустые метки настоящим pruneMarks');
  const argument = (value as ts.CallExpression).arguments[0]!;
  assert.equal(ts.isBinaryExpression(argument) && argument.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && ref(argument.left) === 'edit.marks'
    && ts.isArrayLiteralExpression(argument.right) && argument.right.elements.length === 0, true, 'отсутствующие метки очищаются как пустой список');
  const imports = file.statements.filter((node): node is ts.ImportDeclaration => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '../photoDrawRules');
  assert.equal(imports.length, 1); const bindings = imports[0]!.importClause?.namedBindings;
  assert.equal(!!bindings && ts.isNamedImports(bindings) && bindings.elements.some(binding => binding.name.text === 'pruneMarks'), true);
}
function originalFile(raw: string) {
  prune(raw);
  const { block } = done(raw), fin = declaration(block, 'fin');
  const clear = block.statements.filter((statement): statement is ts.IfStatement => ts.isIfStatement(statement) && ts.isBinaryExpression(statement.expression)
    && ref(statement.expression.left) === 'fin.marks.length' && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && numeric(statement.expression.right, 0));
  assert.equal(clear.length, 1, 'пустой список меток убирается до решения о перекодировании');
  const clearStatement = clear[0]!.thenStatement;
  assert.equal(ts.isExpressionStatement(clearStatement) && ts.isDeleteExpression(clearStatement.expression) && ref(clearStatement.expression.expression) === 'fin.marks', true,
    'после очистки пустое поле marks удаляется');
  const early = block.statements.filter((statement): statement is ts.IfStatement => ts.isIfStatement(statement) && ts.isBinaryExpression(statement.expression)
    && call(statement.expression.left, 'editIsPristine', ['fin']));
  assert.equal(early.length, 1, 'done отдельно проверяет нетронутую финальную правку');
  const condition = early[0]!.expression as ts.BinaryExpression;
  assert.equal(condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && ts.isPrefixUnaryExpression(condition.right)
    && condition.right.operator === ts.SyntaxKind.ExclamationToken && ref(condition.right.operand) === 'fin.marks', true,
    'нетронутый файл возвращается только без содержательных меток');
  const result = early[0]!.thenStatement;
  assert.equal(ts.isReturnStatement(result) && call(result.expression, 'onDone', ['file', 'PRISTINE_EDIT']), true,
    'без меток и правок возвращается именно исходный file без renderEdit');
  const rendered = all(block, ts.isCallExpression).filter(node => ref(node.expression) === 'renderEdit');
  assert.equal(rendered.length, 1); assert.equal(call(rendered[0], 'renderEdit', ['file', 'bmp', 'fin']), true);
  assert.equal(fin.pos < clear[0]!.pos && clear[0]!.pos < early[0]!.pos && early[0]!.end < rendered[0]!.pos, true, 'ранний возврат идёт после очистки и до перекодирования');
}
function dimFloor(raw: string) {
  const { block } = body(raw, 'Lightbox'), rootStyle = declaration(block, 'rootStyle').initializer;
  assert.equal(!!rootStyle && ts.isConditionalExpression(rootStyle), true);
  const conditional = rootStyle as ts.ConditionalExpression;
  assert.equal(ts.isBinaryExpression(conditional.condition) && ref(conditional.condition.left) === 'dim' && conditional.condition.operatorToken.kind === ts.SyntaxKind.LessThanToken
    && numeric(conditional.condition.right, 1) && ref(conditional.whenFalse) === 'undefined', true, 'фон жеста задаётся только во время затемнения');
  assert.equal(ts.isObjectLiteralExpression(conditional.whenTrue), true);
  const backgrounds = (conditional.whenTrue as ts.ObjectLiteralExpression).properties.filter((node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && ref(node.name) === 'backgroundColor');
  assert.equal(backgrounds.length, 1); const template = backgrounds[0]!.initializer;
  assert.equal(ts.isTemplateExpression(template) && template.head.text === 'rgba(0, 0, 0, ' && template.templateSpans.length === 1 && template.templateSpans[0]!.literal.text === ')', true,
    'фон смахивания остаётся чёрным RGBA');
  const expression = (template as ts.TemplateExpression).templateSpans[0]!.expression;
  assert.equal(ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === 'toFixed' && expression.arguments.length === 1
    && numeric(expression.arguments[0], 3), true);
  const clamp = (expression as ts.CallExpression).expression as ts.PropertyAccessExpression;
  assert.equal(call(clamp.expression, 'Math.max') && clamp.expression.arguments.length === 2 && ref(clamp.expression.arguments[1]) === 'dim', true,
    'смахивание ограничивает прозрачность через Math.max');
  assert.equal(Number(((clamp.expression as ts.CallExpression).arguments[0] as ts.NumericLiteral).text), 0.5, 'нижняя граница непрозрачности равна половине');
  const wired = all(block, ts.isJsxAttribute).filter(attribute => ref(attribute.name) === 'style' && !!attribute.initializer && ts.isJsxExpression(attribute.initializer) && ref(attribute.initializer.expression) === 'rootStyle');
  assert.equal(wired.length, 1, 'вычисленный фон подключён к JSX-корню просмотрщика');
  const opening = wired[0]!.parent.parent;
  assert.equal(ts.isJsxOpeningElement(opening) && ref(opening.tagName) === 'div' && opening.attributes.properties.some(attribute => {
    if (!ts.isJsxAttribute(attribute) || ref(attribute.name) !== 'className' || !attribute.initializer || !ts.isJsxExpression(attribute.initializer)) return false;
    const classes = attribute.initializer.expression;
    return !!classes && ts.isConditionalExpression(classes) && ts.isStringLiteral(classes.whenTrue) && classes.whenTrue.text === 'lightbox lb-bare'
      && ts.isStringLiteral(classes.whenFalse) && classes.whenFalse.text === 'lightbox';
  }), true, 'фон жеста применяется к самому div.lightbox, не к внутренней картинке');
}
function lightboxRule(raw: string) {
  // Точный базовый селектор, не .lightbox-descendant и не комментарий с обещанием непрозрачности.
  const uncommented = raw.replace(/\/\*[\s\S]*?\*\//g, ''), matches = [...uncommented.matchAll(/(?:^|\n)\s*\.lightbox\s*\{([^{}]*)\}/g)];
  assert.equal(matches.length, 1, 'один базовый CSS-блок .lightbox'); return matches[0]!;
}
function opaque(raw: string) {
  const declarations = lightboxRule(raw)[1]!.split(';').map(value => value.trim()).filter(Boolean);
  const background = declarations.filter(value => /^background\s*:/.test(value)).map(value => value.slice(value.indexOf(':') + 1).trim());
  assert.equal(background.length, 1); assert.equal(background[0], '#000', 'базовый просмотрщик не просвечивает лентой');
}
// Стражи анализируют целые исходники: не исполняют вырезанные done/rootStyle и не измеряют синтетический layout.
it('R214 AST PhotoEditor.done очищает метки перед созданием результата', () => prune(editor));
it('R214 AST PhotoEditor.done после очистки возвращает исходный файл только без рисунка и геометрических правок', () => originalFile(editor));
it('R214 CSS базового просмотрщика имеет непрозрачный чёрный фон', () => opaque(styles));
it('R214 AST смахивания не допускает непрозрачность ниже половины и подключает фон к корню', () => dimFloor(viewer));

function change(raw: string, anchor: string, replacement: string) { assert.equal(raw.split(anchor).length - 1, 1, 'единственный якорь R214 source-мутанта'); return raw.replace(anchor, replacement); }
function killed(raw: string, anchor: string, replacement: string, scenario: (raw: string) => void, prefix: string, actual: unknown, expected: unknown) {
  scenario(raw);
  assert.throws(() => scenario(change(raw, anchor, replacement)), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
}
it('R214 контрфакт done обходит очистку пустых меток', () => killed(editor, 'marks: pruneMarks(edit.marks ?? [])', 'marks: edit.marks ?? []', prune,
  'done вычищает пустые метки настоящим pruneMarks', false, true));
it('R214 контрфакт раннего возврата теряет проверку содержательных меток', () => killed(editor, 'editIsPristine(fin) && !fin.marks', 'editIsPristine(fin) && true', originalFile,
  'нетронутый файл возвращается только без содержательных меток', false, true));
it('R214 контрфакт смахивания убирает Math.max и раскрывает ленту', () => killed(viewer, 'Math.max(0.5, dim).toFixed(3)', 'dim.toFixed(3)', dimFloor,
  'смахивание ограничивает прозрачность через Math.max', false, true));
it('R214 контрфакт смахивания снижает нижнюю границу непрозрачности до нуля', () => killed(viewer, 'Math.max(0.5, dim).toFixed(3)', 'Math.max(0, dim).toFixed(3)', dimFloor,
  'нижняя граница непрозрачности равна половине', 0, 0.5));
it('R214 контрфакт CSS возвращает полупрозрачный основной фон', () => {
  opaque(styles);
  const base = /(?:^|\n)\.lightbox\s*\{[\s\S]*?\n\}/.exec(styles); assert.equal(!!base, true);
  const changed = change(styles, base![0], change(base![0], 'background: #000;', 'background: #000000ed;'));
  assert.throws(() => opaque(changed), e => e instanceof assert.AssertionError && e.message.startsWith('базовый просмотрщик не просвечивает лентой')
    && e.operator === 'strictEqual' && e.actual === '#000000ed' && e.expected === '#000');
});
