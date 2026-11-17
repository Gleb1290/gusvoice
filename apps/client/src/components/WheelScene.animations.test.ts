import { counterfact, mutantTest } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./WheelScene.tsx', import.meta.url), 'utf8');
const parse = (text: string) => ts.createSourceFile('WheelScene.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return result;
}
const id = (node: ts.Node | undefined, name: string): boolean => !!node && ts.isIdentifier(node) && node.text === name;
const str = (node: ts.Node | undefined, value: string): boolean => !!node && ts.isStringLiteralLike(node) && node.text === value;
function fn(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = file.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && id(node.name, name));
  assert.ok(found?.body, `R351 найдена настоящая функция ${name}`);
  return found;
}
function called(root: ts.Node, name: string): ts.CallExpression[] {
  return nodes(root, ts.isCallExpression).filter(node => id(node.expression, name));
}
function method(root: ts.Node, object: string, name: string): ts.CallExpression[] {
  return nodes(root, ts.isCallExpression).filter(node => ts.isPropertyAccessExpression(node.expression)
    && id(node.expression.expression, object) && id(node.expression.name, name));
}
function declaration(root: ts.Node, name: string): ts.VariableDeclaration {
  const found = nodes(root, ts.isVariableDeclaration).find(node => id(node.name, name));
  assert.ok(found?.initializer, `R351 найдено объявление ${name} с настоящим значением`);
  return found;
}
const unwrap = (node: ts.Expression): ts.Expression => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;

function lifetimeGuard(text: string) {
  const scene = fn(parse(text), 'WheelScene');
  const creations = nodes(scene, ts.isNewExpression).filter(node => id(node.expression, 'FxLoop'));
  assert.equal(creations.length, 1, 'R351 на сцену создаётся ровно один FxLoop');
  const effects = called(scene, 'useEffect').filter(effect => nodes(effect, ts.isNewExpression).includes(creations[0]));
  assert.equal(effects.length, 1, 'R351 цикл создан внутри useEffect');
  const effect = effects[0];
  const callback = effect.arguments[0];
  assert.ok(callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  const deps = effect.arguments[1];
  assert.ok(deps && ts.isArrayLiteralExpression(deps) && deps.elements.length === 0, 'R351 цикл создаётся один раз на монтирование');
  const binding = creations[0].parent;
  assert.ok(ts.isVariableDeclaration(binding) && ts.isIdentifier(binding.name), 'R351 цикл сохранён в переменной');
  const bindingName = binding.name.text;
  const cleanup = callback.body.statements.find(ts.isReturnStatement)?.expression;
  assert.ok(cleanup && ts.isArrowFunction(cleanup), 'R351 эффект возвращает снятие цикла');
  assert.equal(method(cleanup, bindingName, 'dispose').length, 1,
    'R351 cleanup вызывает dispose именно созданного цикла');
  const assignments = nodes(callback.body, ts.isBinaryExpression).filter(node => node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(node.left) && id(node.left.expression, 'loopRef') && id(node.left.name, 'current'));
  assert.ok(assignments.some(node => id(node.right, bindingName)), 'R351 созданный цикл действительно передан дорожкам через loopRef');
  assert.ok(assignments.some(node => node.right.kind === ts.SyntaxKind.NullKeyword && nodes(cleanup, ts.isBinaryExpression).includes(node)),
    'R351 cleanup убирает ссылку на уничтоженный цикл');
}

function reducedGuard(text: string) {
  const file = parse(text);
  const scene = fn(file, 'WheelScene');
  const effects = called(scene, 'useEffect').filter(effect => called(effect, 'setFx').length > 0);
  assert.equal(effects.length, 1, 'R351 найден эффект запуска анимации нового итога');
  const branches = nodes(effects[0], ts.isIfStatement).filter(branch => called(branch.thenStatement, 'setFx').length > 0);
  assert.equal(branches.length, 1, 'R351 запуск анимации принадлежит условной ветке');
  const gate = branches[0].expression;
  const isNegativeReduced = (node: ts.Expression): boolean => ts.isPrefixUnaryExpression(node)
    && node.operator === ts.SyntaxKind.ExclamationToken && ts.isCallExpression(node.operand) && id(node.operand.expression, 'reducedMotion');
  const andTerms = (node: ts.Expression): ts.Expression[] => {
    const value = unwrap(node);
    return ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ? [...andTerms(value.left), ...andTerms(value.right)] : [value];
  };
  assert.ok(andTerms(gate).some(isNegativeReduced), 'R351 анимация запускается только при !reducedMotion()');
  const reduced = fn(file, 'reducedMotion');
  assert.ok(nodes(reduced, ts.isCallExpression).some(node => ts.isPropertyAccessExpression(node.expression)
    && id(node.expression.expression, 'window') && id(node.expression.name, 'matchMedia')
    && str(node.arguments[0], '(prefers-reduced-motion: reduce)')), 'R351 reducedMotion читает настоящую настройку системы');
}

test('R351 13 кадров ядра и 8 кадров попугая грузятся лениво, статические слои колеса остаются пятью', () => {
  const file = parse(source);
  const art = fn(file, 'useWheelArt');
  const imports = nodes(art, ts.isCallExpression).filter(node => node.expression.kind === ts.SyntaxKind.ImportKeyword);
  const paths = imports.map(node => node.arguments[0]).map(node => ts.isStringLiteralLike(node) ? node.text : '');
  const core = [
    '../assets/wheel/captain-sad.png', '../assets/wheel/captain-idle.png', '../assets/wheel/captain-dance-1.png',
    '../assets/wheel/captain-dance-2.png', '../assets/wheel/captain-peak.png', '../assets/wheel/captain-helm.png',
    '../assets/wheel/chest-closed.png', '../assets/wheel/chest-crack.png', '../assets/wheel/chest-half.png',
    '../assets/wheel/chest-open.png', '../assets/wheel/chest-burst.png', '../assets/wheel/chest-rays.png', '../assets/wheel/coin-spin.png',
  ];
  const parrot = ['sit-1', 'sit-2', 'sit-3', 'watch', 'cheer', 'sad', 'jackpot-1', 'jackpot-2']
    .map(name => `../assets/wheel/red-${name}.png`);
  // R350 уже добавил попугая: контракт R351 о 13 кадрах относится к ядру, не запрещает эти восемь кадров.
  assert.equal(core.length, 13);
  assert.equal(parrot.length, 8);
  assert.deepEqual(paths, [...core, ...parrot]);
  const staticPaths = file.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier)
    .filter(ts.isStringLiteralLike).map(node => node.text).filter(path => path.includes('/assets/wheel/')).sort();
  assert.deepEqual(staticPaths, ['captain', 'face', 'hub', 'pointer', 'rim'].map(name => `../assets/wheel/${name}.png`).sort(),
    'R351 раскадровка не стала статической нагрузкой основного чанка');
  const allDynamic = nodes(file, ts.isCallExpression).filter(node => node.expression.kind === ts.SyntaxKind.ImportKeyword
    && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text.includes('/assets/wheel/'));
  assert.equal(allDynamic.length, 21, 'R351 ровно 13 кадров ядра + 8 попугая, скрытого загрузчика нет');
});

test('R351 единственный FxLoop создаётся и уничтожается одним эффектом без зависимостей', () => {
  lifetimeGuard(source);
});

test('R351 накрытое окно всегда ставит цикл на паузу, игра впереди — только в lite', () => {
  const scene = fn(parse(source), 'WheelScene');
  const motion = declaration(scene, 'motion').initializer!;
  const lite = declaration(scene, 'lite').initializer!;
  assert.ok(ts.isCallExpression(motion) && id(motion.expression, 'useWindowMotion'));
  assert.ok(ts.isCallExpression(lite) && id(lite.expression, 'useLiteMode'));
  const hold = unwrap(declaration(scene, 'holdFx').initializer!);
  assert.ok(ts.isBinaryExpression(hold) && hold.operatorToken.kind === ts.SyntaxKind.BarBarToken);
  const prop = (node: ts.Node, object: string, name: string) => ts.isPropertyAccessExpression(node) && id(node.expression, object) && id(node.name, name);
  assert.ok(prop(hold.left, 'motion', 'covered'), 'R351 covered сам достаточен для паузы');
  const foreground = unwrap(hold.right);
  assert.ok(ts.isBinaryExpression(foreground) && foreground.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    && prop(foreground.left, 'motion', 'gameFg') && id(foreground.right, 'lite'), 'R351 gameFg требует одновременно lite');
  const loopPause = (call: ts.CallExpression) => ts.isPropertyAccessExpression(call.expression)
    && id(call.expression.name, 'setPaused') && ts.isPropertyAccessExpression(call.expression.expression)
    && prop(call.expression.expression, 'loopRef', 'current');
  const effects = called(scene, 'useEffect').filter(effect => nodes(effect.arguments[0], ts.isCallExpression).some(loopPause));
  assert.equal(effects.length, 1);
  const pause = nodes(effects[0].arguments[0], ts.isCallExpression).find(loopPause)!;
  assert.ok(ts.isPropertyAccessExpression(pause.expression) && ts.isPropertyAccessExpression(pause.expression.expression)
    && prop(pause.expression.expression, 'loopRef', 'current') && id(pause.arguments[0], 'holdFx'), 'R351 holdFx передан именно живому loopRef');
  const deps = effects[0].arguments[1];
  assert.ok(deps && ts.isArrayLiteralExpression(deps) && deps.elements.length === 1 && id(deps.elements[0], 'holdFx'),
    'R351 пауза обновляется при изменении holdFx');
});

test('R351 уменьшенное движение блокирует запуск раскадровки, а не только CSS', () => {
  reducedGuard(source);
});

test('R351 выстрел анимированного джекпота ждёт CHEST_BURST_MS внутри того же цикла', () => {
  const scene = fn(parse(source), 'WheelScene');
  const layout = called(scene, 'useLayoutEffect').filter(effect => method(effect, 'loop', 'at')
    .some(call => id(call.arguments[0], 'CHEST_BURST_MS')));
  assert.equal(layout.length, 1);
  const loop = declaration(layout[0], 'loop').initializer!;
  assert.ok(ts.isPropertyAccessExpression(loop) && id(loop.expression, 'loopRef') && id(loop.name, 'current'),
    'R351 задержку выстрела ведёт именно созданный FxLoop, не цикл попугая');
  const bursts = method(layout[0], 'loop', 'at').filter(call => id(call.arguments[0], 'CHEST_BURST_MS'));
  assert.equal(bursts.length, 1);
  const callback = bursts[0].arguments[1];
  assert.ok(callback && ts.isArrowFunction(callback));
  const play = method(scene, 'burstSound', 'current');
  assert.equal(play.length, 1, 'R351 отложенный выстрел не дублируется немедленным вызовом');
  assert.ok(nodes(callback, ts.isCallExpression).includes(play[0]), 'R351 звук находится внутри callback нужного at');
  const gate = nodes(scene, ts.isIfStatement).find(branch => called(branch.thenStatement, 'setFx').length > 0)!;
  assert.ok(nodes(gate.thenStatement, ts.isBinaryExpression).some(node => node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(node.left) && id(node.left.expression, 'burstSound') && id(node.left.name, 'current')
    && ts.isConditionalExpression(node.right) && ts.isBinaryExpression(node.right.condition)
    && id(node.right.condition.left, 'kind') && str(node.right.condition.right, 'jackpot') && id(node.right.whenTrue, 'sound')),
    'R351 отложенный выстрел вооружается звуком джекпота, а не произвольной заглушкой');
});

function changed(before: string, after: string): string {
  assert.equal(source.split(before).length - 1, 1, 'R351 якорь контрфакта единственный');
  return source.replace(before, after);
}

mutantTest('R351 контрфакт: удалённый dispose адресно ломает страж снятия цикла', () => {
  assert.throws(() => lifetimeGuard(changed('loop.dispose();', '')),
    /R351 cleanup вызывает dispose именно созданного цикла/);
});

mutantTest('R351 контрфакт: запуск при reducedMotion адресно ломает страж доступности', () => {
  assert.throws(() => reducedGuard(changed('if (kind && artRef.current && loopRef.current && !reducedMotion()) {',
    'if (kind && artRef.current && loopRef.current && true) {')),
    /R351 анимация запускается только при !reducedMotion\(\)/);
});

function redArtGuard(raw: string) {
  const file = parse(raw);
  const redPath = (node: ts.Node | undefined) => !!node && ts.isStringLiteralLike(node)
    && /\/assets\/wheel\/red-[^/]+\.png$/.test(node.text);
  assert.equal(file.statements.filter(ts.isImportDeclaration).filter(node => redPath(node.moduleSpecifier)).length,
    0, 'R352/parrot/no-static-art');
  const all = nodes(file, ts.isCallExpression).filter(call => call.expression.kind === ts.SyntaxKind.ImportKeyword && redPath(call.arguments[0]));
  const inside = nodes(fn(file, 'useWheelArt'), ts.isCallExpression);
  assert.equal(all.length, 8, 'R352/parrot/eight-frames');
  assert.ok(all.every(call => inside.includes(call)), 'R352/parrot/art-lazy-boundary');
  assert.deepEqual(all.map(call => (call.arguments[0] as ts.StringLiteralLike).text),
    ['sit-1', 'sit-2', 'sit-3', 'watch', 'cheer', 'sad', 'jackpot-1', 'jackpot-2'].map(name => `../assets/wheel/red-${name}.png`),
    'R352/parrot/frame-paths');
}
function refCall(node: ts.CallExpression, ref: string, methodName: string) {
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee) && id(callee.name, methodName)
    && ts.isPropertyAccessExpression(callee.expression) && id(callee.expression.expression, ref) && id(callee.expression.name, 'current');
}
function parrotLifetimeGuard(raw: string) {
  const scene = fn(parse(raw), 'WheelScene');
  const creations = nodes(scene, ts.isNewExpression).filter(node => id(node.expression, 'ParrotIdle'));
  assert.equal(creations.length, 1, 'R352/parrot/one-idle');
  const effects = called(scene, 'useLayoutEffect').filter(effect => nodes(effect, ts.isNewExpression).includes(creations[0]));
  assert.equal(effects.length, 1, 'R352/parrot/idle-effect');
  const effect = effects[0];
  const deps = effect.arguments[1];
  assert.ok(deps && ts.isArrayLiteralExpression(deps) && deps.elements.length === 0, 'R352/parrot/one-mount');
  const callback = effect.arguments[0];
  assert.ok(callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  const binding = creations[0].parent;
  assert.ok(ts.isVariableDeclaration(binding) && ts.isIdentifier(binding.name));
  const variable = binding.name.text;
  const writes = nodes(callback.body, ts.isBinaryExpression).filter(node => node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(node.left) && id(node.left.expression, 'idleRef') && id(node.left.name, 'current'));
  assert.ok(writes.some(node => id(node.right, variable)), 'R352/parrot/stored-idle');
  const cleanup = callback.body.statements.find(ts.isReturnStatement)?.expression;
  assert.ok(cleanup && ts.isArrowFunction(cleanup));
  assert.equal(method(cleanup, variable, 'dispose').length, 1, 'R352/parrot/dispose');
  assert.ok(writes.some(node => node.right.kind === ts.SyntaxKind.NullKeyword && nodes(cleanup, ts.isBinaryExpression).includes(node)),
    'R352/parrot/cleared-ref');
}
function parrotPauseGuard(raw: string) {
  const scene = fn(parse(raw), 'WheelScene');
  const effects = called(scene, 'useEffect').filter(effect => nodes(effect.arguments[0], ts.isCallExpression)
    .some(call => refCall(call, 'idleRef', 'setPaused')));
  assert.equal(effects.length, 1, 'R352/parrot/pause-effect');
  const calls = nodes(effects[0].arguments[0], ts.isCallExpression).filter(call => refCall(call, 'idleRef', 'setPaused'));
  assert.equal(calls.length, 1);
  assert.ok(id(calls[0].arguments[0], 'holdFx'), 'R352/parrot/pause-value');
  const deps = effects[0].arguments[1];
  assert.ok(deps && ts.isArrayLiteralExpression(deps) && deps.elements.length === 1 && id(deps.elements[0], 'holdFx'),
    'R352/parrot/pause-deps');
}
function parrotReducedGuard(raw: string) {
  const file = parse(raw), scene = fn(file, 'WheelScene');
  const terms = (node: ts.Expression): ts.Expression[] => {
    const value = unwrap(node);
    return ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ? [...terms(value.left), ...terms(value.right)] : [value];
  };
  const conditions = terms(declaration(scene, 'parrotIdle').initializer!);
  assert.ok(conditions.some(node => ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken
    && ts.isCallExpression(node.operand) && id(node.operand.expression, 'reducedMotion')), 'R352/parrot/reduced-gate');
  assert.ok(conditions.some(node => ts.isBinaryExpression(node) && id(node.left, 'parrotFrame')
    && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && node.right.kind === ts.SyntaxKind.NullKeyword),
    'R352/parrot/idle-only');
  const effects = called(scene, 'useLayoutEffect').filter(effect => nodes(effect.arguments[0], ts.isCallExpression)
    .some(call => refCall(call, 'idleRef', 'setActive')));
  assert.equal(effects.length, 1);
  const activate = nodes(effects[0].arguments[0], ts.isCallExpression).find(call => refCall(call, 'idleRef', 'setActive'))!;
  assert.ok(id(activate.arguments[0], 'parrotIdle'), 'R352/parrot/active-value');
  const deps = effects[0].arguments[1];
  assert.ok(deps && ts.isArrayLiteralExpression(deps) && deps.elements.length === 1 && id(deps.elements[0], 'parrotIdle'));
  const layer = nodes(scene, ts.isJsxOpeningElement).find(node => node.attributes.properties.some(prop => ts.isJsxAttribute(prop)
    && id(prop.name, 'className') && str(prop.initializer, 'wh-parrot')));
  assert.ok(layer, 'R352/parrot/visible-layer');
  const frame = layer.attributes.properties.find((prop): prop is ts.JsxAttribute => ts.isJsxAttribute(prop) && prop.name.getText(file) === 'data-frame');
  assert.ok(frame?.initializer && ts.isJsxExpression(frame.initializer) && frame.initializer.expression
    && ts.isConditionalExpression(frame.initializer.expression));
  const value = frame.initializer.expression;
  assert.ok(id(value.condition, 'parrotIdle') && id(value.whenTrue, 'undefined'), 'R352/parrot/idle-data-frame');
  const fallback = unwrap(value.whenFalse);
  assert.ok(ts.isBinaryExpression(fallback) && fallback.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    && id(fallback.left, 'parrotFrame') && str(fallback.right, 'sit1'), 'R352/parrot/static-sit1');
}
function addressed(check: (raw: string) => void, mutant: () => string, address: string) {
  check(source);
  counterfact(() => {
    assert.throws(() => check(mutant()), (error: unknown) => error instanceof assert.AssertionError && error.message.split('\n')[0] === address);
  });
  check(source);
}

test('R352 все восемь кадров попугая остаются внутри ленивого useWheelArt, статический импорт запрещён', () => {
  // Даже дублирующий статический импорт тихо увеличит основной чанк при сохранении рабочих lazy-кадров.
  addressed(redArtGuard, () => "import redStill from '../assets/wheel/red-sit-1.png';\n" + source, 'R352/parrot/no-static-art');
});
test('R352 один таймер попугая принадлежит эффекту сцены и уничтожается при размонтировании', () => {
  // Нельзя оставить смену data-frame у закрытой сцены или завести второй независимый цикл.
  addressed(parrotLifetimeGuard, () => changed('idle.dispose();', 'void idle;'), 'R352/parrot/dispose');
});
test('R352 holdFx ставит на паузу именно ParrotIdle, а не только общий FxLoop', () => {
  // Без этой связи монета у попугая продолжала бы подбрасываться в накрытом окне.
  addressed(parrotPauseGuard, () => changed('idleRef.current?.setPaused(holdFx)', 'idleRef.current?.setPaused(false)'), 'R352/parrot/pause-value');
});
test('R352 уменьшенное движение запрещает цикл попугая и оставляет статичный sit1', () => {
  // Настройка доступности обязана остановить таймер, не только CSS-переходы.
  addressed(parrotReducedGuard, () => changed('const parrotIdle = parrotFrame === null && !!art && !reducedMotion();',
    'const parrotIdle = parrotFrame === null && !!art && true;'), 'R352/parrot/reduced-gate');
});
