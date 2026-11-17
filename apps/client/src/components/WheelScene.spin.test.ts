import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { edited, type Edit } from '../predictions.harness';

function paired(source: string, check: (raw: string) => void, edits: readonly Edit[], prefix: string): void {
  check(source);
  for (const edit of edits) {
    counterfact(() => {
      const mutant = edited(source, edit);
      assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.startsWith(prefix),
        'контрфакт убит адресным host AssertionError, не setup/import/исключением');
    });
    check(source);
  }
}

const source = readFileSync(new URL('./WheelScene.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const P = 'R354/wheel-wire/';
const parse = (raw: string) => ts.createSourceFile('WheelScene.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes<T extends ts.Node>(root: ts.Node, predicate: (n: ts.Node) => n is T): T[] {
  const result: T[] = [];
  const visit = (n: ts.Node) => { if (predicate(n)) result.push(n); ts.forEachChild(n, visit); };
  visit(root);
  return result;
}
const id = (n: ts.Node | undefined, name: string): boolean => !!n && ts.isIdentifier(n) && n.text === name;
const string = (n: ts.Node | undefined, text: string): boolean => !!n && ts.isStringLiteralLike(n) && n.text === text;
const compact = (n: ts.Node) => n.getText().replace(/\s+/g, '');
function scene(raw: string) {
  const root = parse(raw);
  const found = root.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && id(n.name, 'WheelScene'));
  assert.ok(found?.body, 'R354 setup: настоящая WheelScene');
  return found;
}
function variable(root: ts.Node, name: string) {
  const found = nodes(root, ts.isVariableDeclaration).find(n => id(n.name, name));
  assert.ok(found?.initializer, `R354 setup: переменная ${name}`);
  return found.initializer;
}
function arrow(root: ts.Node, name: string) {
  const found = variable(root, name);
  assert.ok(ts.isArrowFunction(found), `R354 setup: функция ${name}`);
  return found;
}
const calls = (root: ts.Node, name: string) => nodes(root, ts.isCallExpression).filter(n => id(n.expression, name));
const method = (root: ts.Node, name: string) => nodes(root, ts.isCallExpression).filter(n => ts.isPropertyAccessExpression(n.expression) && id(n.expression.name, name));
const assignment = (root: ts.Node, left: string, right: string) => nodes(root, ts.isBinaryExpression).some(n => n.operatorToken.kind === ts.SyntaxKind.EqualsToken
  && compact(n.left) === left && compact(n.right) === right);
function property(object: ts.ObjectLiteralExpression, name: string) {
  return object.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && (id(p.name, name) || string(p.name, name)));
}
function classIs(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) {
  return node.attributes.properties.some(p => ts.isJsxAttribute(p) && id(p.name, 'className') && string(p.initializer, name));
}
function guardedBy(node: ts.Node, flag: string): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const terms = (n: ts.Expression): ts.Expression[] => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ? [...terms(n.left), ...terms(n.right)] : [n];
      if (terms(current.left).some(n => id(n, flag))) return true;
    }
    current = current.parent;
  }
  return false;
}

// WAAPI живёт на общей шкале часов; CSS transition после возврата мог начинать вращение с нуля.
test('R358 колесо и перо вращают две линейные Web Animation, а не transition самого wh-rot', () => paired(source, raw => {
  const root = scene(raw);
  const sync = arrow(root, 'syncSpin');
  const animations = method(sync, 'animate');
  assert.equal(animations.length, 2, P + 'animation/wheel-and-feather');
  for (const [receiver, frameName] of [['el', 's.frames'], ['pen', 's.featherFrames']]) {
    const animation = animations.find(c => ts.isPropertyAccessExpression(c.expression) && id(c.expression.expression, receiver));
    assert.ok(animation, P + 'animation/receiver-' + receiver);
    const [frames, options] = animation.arguments;
    assert.ok(frames && compact(frames) === frameName, P + 'animation/sampled-frames-' + receiver);
    assert.ok(options && ts.isObjectLiteralExpression(options), P + 'animation/options-' + receiver);
    const duration = property(options, 'duration');
    assert.ok(duration && compact(duration.initializer) === 's.dur', P + 'animation/duration-' + receiver);
    assert.ok(string(property(options, 'easing')?.initializer, 'linear'), P + 'animation/linear-' + receiver);
  }
  assert.equal(compact(variable(sync, 'pen')), 'featherRef.current', P + 'animation/feather-ref');
  const rot = nodes(root, ts.isJsxOpeningElement).find(n => classIs(n, 'wh-rot'));
  assert.ok(rot, P + 'animation/rot');
  const style = rot.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && id(p.name, 'style'));
  assert.ok(style?.initializer && ts.isJsxExpression(style.initializer) && style.initializer.expression && ts.isObjectLiteralExpression(style.initializer.expression), P + 'animation/style');
  const props = style.initializer.expression;
  assert.ok(property(props, 'transform'), P + 'animation/final-transform-in-markup');
  assert.equal(property(props, 'transition'), undefined, P + 'animation/no-inline-transition');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1].split(',').some(s => s.trim() === '.wh-rot'));
  assert.ok(rules.length > 0, P + 'animation/css-found');
  assert.ok(rules.every(m => !/(?:^|;)\s*transition(?:-[\w-]+)?\s*:/.test(m[2])), P + 'animation/no-css-transition');
}, [
  ['s.anim = el.animate(', 's.anim = el.getAnimations('],
  ["s.anim = el.animate(s.frames, { duration: s.dur, easing: 'linear' });", 's.anim = el.animate(s.frames, { duration: s.dur, easing: WHEEL_EASE_CSS });'],
], P + 'animation/'));

// Время кадров документа и performance.now могут отличаться: обоим каналам нужен один start.
test('R354 звук и вращение привязаны к одному s.start, не к моменту первого кадра', () => paired(source, raw => {
  const root = scene(raw);
  const sync = arrow(root, 'syncSpin');
  assert.ok(assignment(sync, 's.anim.startTime', 's.start'), P + 'anchor/start-time');
  assert.ok(assignment(sync, 's.feather.startTime', 's.start'), P + 'anchor/feather-start-time');
  assert.equal(compact(variable(sync, 'elapsed')), 'performance.now()-s.start', P + 'anchor/elapsed');
  const progress = calls(sync, 'spinProgress');
  assert.equal(progress.length, 1, P + 'anchor/progress-call');
  assert.deepEqual(progress[0].arguments.map(compact), ['elapsed', 's.dur'], P + 'anchor/progress-input');
  const ticks = calls(arrow(root, 'scheduleRestTicks'), 'scheduleWheelTicks');
  assert.equal(ticks.length, 1, P + 'anchor/sound-call');
  assert.deepEqual(ticks[0].arguments.map(compact), ['s.ticks', 's.start'], P + 'anchor/sound-anchor');
}, [
  ['s.anim.startTime = s.start;', 's.anim.startTime = performance.now();'],
  ['if (s.feather) s.feather.startTime = s.start;', '/* мутант: перо запущено на часах первого кадра */'],
], P + 'anchor/'));

// Возврат вкладки, фокуса и восстановление страницы должны одинаково догонять время и снимать слушателей.
test('R354 возврат через visibilitychange, focus и pageshow синхронизирует фазу и имеет cleanup', () => paired(source, raw => {
  const root = scene(raw);
  const effects = calls(root, 'useEffect').filter(e => method(e.arguments[0], 'addEventListener').some(c => string(c.arguments[0], 'visibilitychange')));
  assert.equal(effects.length, 1, P + 'return/effect');
  const effect = effects[0];
  const callback = effect.arguments[0];
  assert.ok(callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body), P + 'return/callback');
  const back = arrow(callback, 'onBack');
  const gate = nodes(back, ts.isIfStatement).find(n => compact(n.expression) === "document.visibilityState==='visible'");
  assert.ok(gate && calls(gate.thenStatement, 'syncSpin').some(c => c.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword), P + 'return/visible-sync');
  const cleanup = callback.body.statements.find(ts.isReturnStatement)?.expression;
  assert.ok(cleanup && ts.isArrowFunction(cleanup), P + 'return/cleanup');
  for (const [target, event] of [['document', 'visibilitychange'], ['window', 'focus'], ['window', 'pageshow']]) {
    const match = (call: ts.CallExpression) => ts.isPropertyAccessExpression(call.expression) && id(call.expression.expression, target)
      && string(call.arguments[0], event) && id(call.arguments[1], 'onBack');
    assert.equal(method(callback, 'addEventListener').filter(match).length, 1, P + 'return/add-' + event);
    assert.equal(method(cleanup, 'removeEventListener').filter(match).length, 1, P + 'return/remove-' + event);
  }
  const deps = effect.arguments[1];
  assert.ok(deps && ts.isArrayLiteralExpression(deps) && deps.elements.length === 0, P + 'return/one-mount');
}, [
  ["    document.addEventListener('visibilitychange', onBack);", '    /* мутант: нет visibilitychange */'],
  ["    window.addEventListener('focus', onBack);", '    /* мутант: нет focus */'],
  ["    window.addEventListener('pageshow', onBack);", '    /* мутант: нет pageshow */'],
], P + 'return/'));

// Пауза меняет саму Web Animation, а снятие паузы пересчитывает фазу, не перезапускает её.
test('R358 holdFx замораживает обе анимации на одной вычисленной currentTime', () => paired(source, raw => {
  const root = scene(raw);
  assert.ok(assignment(root, 'holdRef.current', 'holdFx'), P + 'hold/ref');
  const effect = calls(root, 'useEffect').find(e => compact(e.arguments[0]) === '()=>syncSpin(!holdFx)');
  assert.ok(effect && compact(effect.arguments[1]) === '[holdFx]', P + 'hold/effect');
  const sync = arrow(root, 'syncSpin');
  const pause = nodes(sync, ts.isIfStatement).find(n => compact(n.expression) === 'holdRef.current');
  assert.ok(pause, P + 'hold/branch');
  for (const animation of ['s.anim', 's.feather']) {
    assert.ok(method(pause.thenStatement, 'pause').some(c => ts.isPropertyAccessExpression(c.expression) && compact(c.expression.expression) === animation), P + 'hold/pauses-' + animation);
    assert.ok(assignment(pause.thenStatement, animation + '.currentTime', 'p.atMs'), P + 'hold/current-phase-' + animation);
  }
  assert.ok(pause.elseStatement && calls(pause.elseStatement, 'scheduleRestTicks').length === 1, P + 'hold/reticks-on-resume');
}, [
  ['useEffect(() => syncSpin(!holdFx), [holdFx]);', 'useEffect(() => {}, [holdFx]);'],
  ['s.feather.pause();', '/* мутант: перо не заморожено */'],
  ['s.feather.currentTime = p.atMs;', 's.feather.currentTime = 0;'],
], P + 'hold/'));

// Снятие перекрывающей анимации сразу оставляет видимым конечный угол из разметки.
test('R354 окончание, поздний возврат и размонтирование снимают анимацию, таймер и состояние вращения', () => paired(source, raw => {
  const root = scene(raw);
  const finish = arrow(root, 'finishSpin');
  assert.ok(method(finish, 'cancel').some(c => ts.isPropertyAccessExpression(c.expression) && compact(c.expression.expression) === 's?.anim'), P + 'finish/cancel');
  assert.ok(method(finish, 'cancel').some(c => ts.isPropertyAccessExpression(c.expression) && compact(c.expression.expression) === 's?.feather'), P + 'finish/cancel-feather');
  assert.ok(assignment(finish, 'spinRef.current', 'null'), P + 'finish/clear-spin');
  assert.ok(assignment(finish, 'endTimer.current', 'null'), P + 'finish/clear-timer');
  assert.equal(calls(finish, 'clearTimeout').length, 1, P + 'finish/cancel-timer');
  assert.ok(calls(finish, 'setSpinning').some(c => c.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword), P + 'finish/stop-state');
  const sync = arrow(root, 'syncSpin');
  const done = nodes(sync, ts.isIfStatement).find(n => compact(n.expression).startsWith('p.done||'));
  assert.ok(done && calls(done.thenStatement, 'finishSpin').length === 1 && nodes(done.thenStatement, ts.isReturnStatement).length === 1, P + 'finish/late-return');
  const onfinish = nodes(sync, ts.isBinaryExpression).find(n => n.operatorToken.kind === ts.SyntaxKind.EqualsToken && compact(n.left) === 's.anim.onfinish');
  assert.ok(onfinish && nodes(onfinish.right, ts.isIfStatement).some(n => compact(n.expression) === 'spinRef.current===s' && calls(n.thenStatement, 'finishSpin').length === 1), P + 'finish/not-old-round');
  assert.ok(calls(root, 'useEffect').some(e => {
    const callback = e.arguments[0];
    return !!callback && ts.isArrowFunction(callback) && ts.isArrowFunction(callback.body) && calls(callback.body, 'finishSpin').length === 1;
  }), P + 'finish/unmount');
}, [
  ['    s?.anim?.cancel();', '    /* мутант: Web Animation осталась поверх угла */'],
  ['    s?.feather?.cancel();', '    /* мутант: перо осталось поверх покоя */'],
], P + 'finish/'));

// Замок и кнопка должны проверять один и тот же административный флаг, а не только скрывать подпись.
test('R354 и замок раунда, и FairCheck находятся под fairVisible', () => paired(source, raw => {
  const root = scene(raw);
  const commit = nodes(root, ts.isJsxOpeningElement).filter(n => classIs(n, 'wh-commit'));
  assert.equal(commit.length, 1, P + 'fair/one-commit');
  assert.ok(guardedBy(commit[0], 'fairVisible'), P + 'fair/commit-gated');
  const check = nodes(root, ts.isJsxSelfClosingElement).filter(n => id(n.tagName, 'FairCheck'));
  assert.equal(check.length, 1, P + 'fair/one-check');
  assert.ok(guardedBy(check[0], 'fairVisible'), P + 'fair/check-gated');
}, [['{fairVisible && round && (', '{round && ('], ['{fairVisible && last && <FairCheck', '{last && <FairCheck']], P + 'fair/'));

// Права открытого другого сервера нельзя случайно перенести на просматриваемое колесо.
test('R354 fairVisible получает права только своего bootstrap, владельца ищет по serverId', () => {
  const root = scene(source);
  const fair = variable(root, 'fairVisible');
  assert.ok(ts.isCallExpression(fair) && id(fair.expression, 'useStore'), P + 'fair-source/store');
  const check = calls(fair, 'wheelFairVisible');
  assert.equal(check.length, 1, P + 'fair-source/rule');
  assert.deepEqual(check[0].arguments.map(compact), ['s.user?.id??null', 's.servers.find((x)=>x.id===serverId)?.ownerId',
    's.bootstrap?.server.id===serverId?permsFromString(s.bootstrap.permissions):null'], P + 'fair-source/scope');
});

// В предупреждение идут только люди из presence; чистый unbetVoiceUsers видит уже отобранные id.
test('R354 боты отсекаются до userId и до предупреждения о не сделавших ставку', () => paired(source, raw => {
  const root = scene(raw);
  const selector = variable(root, 'voiceIds');
  const maps = method(selector, 'map');
  const humanMap = maps.find(call => ts.isPropertyAccessExpression(call.expression) && ts.isCallExpression(call.expression.expression)
    && ts.isPropertyAccessExpression(call.expression.expression.expression) && id(call.expression.expression.expression.name, 'filter'));
  assert.ok(humanMap && ts.isPropertyAccessExpression(humanMap.expression) && ts.isCallExpression(humanMap.expression.expression), P + 'voice/human-map');
  const filter = humanMap.expression.expression;
  assert.equal(compact(filter.arguments[0]), '(p)=>p.bot!==true', P + 'voice/bot-filter');
  assert.equal(compact(humanMap.arguments[0]), '(p)=>p.userId', P + 'voice/user-id');
  const spin = nodes(root, ts.isFunctionDeclaration).find(n => id(n.name, 'spinNow'));
  assert.ok(spin && calls(spin, 'unbetVoiceUsers').some(c => compact(c.arguments[0]) === "voiceIds?voiceIds.split(','):[]"), P + 'voice/filtered-ids-used');
}, [['.filter((p) => p.bot !== true)', '.filter((p) => true)']], P + 'voice/'));

// После первого подтверждения или отказа повторное вращение в сессии не спрашивает снова.
test('R354 подтверждение пропущенных ставок одно на сессию, отказ не запускает API', () => paired(source, raw => {
  const root = scene(raw);
  const spin = nodes(root, ts.isFunctionDeclaration).find(n => id(n.name, 'spinNow'));
  assert.ok(spin?.body, P + 'confirm/function');
  const branches = nodes(spin, ts.isIfStatement).filter(n => calls(n.thenStatement, 'confirmAction').length > 0);
  assert.equal(branches.length, 1, P + 'confirm/one-branch');
  const branch = branches[0];
  assert.equal(compact(branch.expression), 'missing.length>0&&!spinNowAsked()', P + 'confirm/session-gate');
  const mark = calls(branch.thenStatement, 'markSpinNowAsked');
  const confirm = calls(branch.thenStatement, 'confirmAction');
  assert.equal(mark.length, 1, P + 'confirm/mark');
  assert.equal(confirm.length, 1, P + 'confirm/confirm');
  assert.ok(mark[0].pos < confirm[0].pos, P + 'confirm/mark-before-dialog');
  const refused = nodes(branch.thenStatement, ts.isIfStatement).find(n => compact(n.expression) === '!ok');
  assert.ok(refused && ts.isReturnStatement(refused.thenStatement), P + 'confirm/cancel-return');
  const request = method(spin, 'spinWheelNow');
  assert.equal(request.length, 1, P + 'confirm/one-request');
  assert.ok(refused.end < request[0].pos, P + 'confirm/cancel-before-request');
}, [['if (missing.length > 0 && !spinNowAsked()) {', 'if (missing.length > 0) {']], P + 'confirm/'));

// Видимость кнопки и предупреждение должны использовать один актуальный раунд и его остаток.
test('R354 кнопка крутить сейчас берёт правила текущего раунда, себя и фазу open', () => {
  const init = variable(scene(source), 'spinNowShown');
  assert.ok(ts.isCallExpression(init) && id(init.expression, 'canSpinNow'), P + 'spin-button/rule');
  assert.deepEqual(init.arguments.map(compact), ['round', 'meId', "phase?.kind==='open'?phase.leftMs:null"], P + 'spin-button/arguments');
});

// Дробь шанса меняется на сервере, русское «из двухсот» не должно снова стать отдельной константой.
test('R354 подсказка сундука выводит WHEEL_JACKPOT_ODDS вместо зашитого числа', () => paired(source, raw => {
  const root = scene(raw);
  const chest = nodes(root, ts.isJsxOpeningElement).find(n => n.attributes.properties.some(p => ts.isJsxAttribute(p) && id(p.name, 'className')
    && !!p.initializer && ts.isJsxExpression(p.initializer) && p.initializer.getText().includes('wh-chest${')));
  assert.ok(chest, P + 'odds/chest');
  const title = chest.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && id(p.name, 'title'));
  assert.ok(title?.initializer && ts.isJsxExpression(title.initializer) && title.initializer.expression && ts.isTemplateExpression(title.initializer.expression), P + 'odds/template');
  assert.ok(title.initializer.expression.templateSpans.some(span => id(span.expression, 'WHEEL_JACKPOT_ODDS')), P + 'odds/shared-constant');
  const imports = parse(raw).statements.filter(ts.isImportDeclaration).filter(n => string(n.moduleSpecifier, '@gusvoice/shared'));
  assert.ok(imports.some(n => n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)
    && n.importClause.namedBindings.elements.some(e => id(e.name, 'WHEEL_JACKPOT_ODDS'))), P + 'odds/shared-import');
}, [['из ${WHEEL_JACKPOT_ODDS} и делится', 'из двухсот и делится']], P + 'odds/'));
