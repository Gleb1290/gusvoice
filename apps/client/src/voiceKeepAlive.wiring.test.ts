import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const voice = readFileSync(new URL('./components/VoiceConnection.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const keepAlive = readFileSync(new URL('./voiceKeepAlive.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const activity = readFileSync(new URL('../../desktop/src-tauri/gen/android/app/src/main/java/tech/gusik/gusvoice/MainActivity.kt', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const parse = (raw: string) => ts.createSourceFile('module.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes(root: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node) => { out.push(node); ts.forEachChild(node, visit); };
  visit(root); return out;
}
function calls(root: ts.Node, name: string) {
  return nodes(root).filter((node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name);
}
const compact = (node: ts.Node) => node.getText().replace(/\s+/g, '');

function sharedMixer(raw: string) {
  const tree = parse(raw);
  const rooms = nodes(tree).filter((node): node is ts.NewExpression => ts.isNewExpression(node) && node.expression.getText() === 'Room');
  assert.equal(rooms.length, 1, 'R273:single-livekit-room');
  const mix = nodes(rooms[0]!).filter((node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && node.name.getText() === 'webAudioMix');
  assert.equal(mix.length, 1, 'R273:shared-webAudioMix');
  assert.equal(compact(mix[0]!.initializer), 'mixCtx?{audioContext:mixCtx}:true', 'R273:shared-webAudioMix');
  assert.equal(nodes(tree).some((node) => ts.isVariableDeclaration(node) && node.name.getText() === 'mixCtx'
    && node.initializer !== undefined && ts.isCallExpression(node.initializer) && node.initializer.expression.getText() === 'sharedAudioContext'), true, 'R273:shared-webAudioMix');
}

function lifetime(raw: string) {
  const effects = calls(parse(raw), 'useEffect');
  const owner = effects.find((effect) => {
    const callback = effect.arguments[0];
    if (!callback || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body)) return false;
    return callback.body.statements.some((statement) => ts.isExpressionStatement(statement)
      && ts.isCallExpression(statement.expression) && statement.expression.expression.getText() === 'startVoiceKeepAlive');
  });
  assert.equal(owner !== undefined, true, 'R273:effect-start');
  const callback = owner!.arguments[0] as ts.ArrowFunction;
  const returned = (callback.body as ts.Block).statements.find((statement): statement is ts.ReturnStatement => ts.isReturnStatement(statement));
  assert.equal(returned?.expression !== undefined && ts.isArrowFunction(returned.expression)
    && calls(returned.expression.body, 'stopVoiceKeepAlive').length === 1, true, 'R273:effect-stop-cleanup');
  assert.equal(owner!.arguments[1] !== undefined && ts.isArrayLiteralExpression(owner!.arguments[1]!)
    && (owner!.arguments[1] as ts.ArrayLiteralExpression).elements.length === 0, true, 'R273:once-per-mount');
}

function analyzerOwnership(raw: string) {
  const tree = parse(raw);
  const own = nodes(tree).filter((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText() === 'ownCtx');
  assert.equal(own.length, 1, 'R273:analyzer-own-context');
  assert.equal(own[0]!.initializer?.kind, ts.SyntaxKind.FalseKeyword, 'R273:analyzer-own-context');
  const assignments = nodes(tree).filter((node): node is ts.BinaryExpression => ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText() === 'ownCtx');
  assert.equal(assignments.length, 1, 'R273:analyzer-own-context');
  const assignment = assignments[0]!;
  assert.equal(assignment.right.kind, ts.SyntaxKind.TrueKeyword, 'R273:analyzer-own-context');
  const block = assignment.parent.parent;
  assert.equal(ts.isBlock(block) && ts.isIfStatement(block.parent) && compact(block.parent.expression) === '!ctx'
    && nodes(block).some((node) => ts.isNewExpression(node) && node.expression.getText() === 'AudioContext'), true, 'R273:analyzer-own-context');
  assert.equal(nodes(tree).some((node) => ts.isIfStatement(node) && node.expression.getText() === 'ownCtx'
    && /ctx\?\.close\(\)/.test(node.thenStatement.getText())), true, 'R273:analyzer-close-only-own');
}

function eventOnly(raw: string) {
  const tree = parse(raw);
  const timers = nodes(tree).filter((node) => ts.isCallExpression(node)
    && (ts.isIdentifier(node.expression) ? /^(setTimeout|setInterval)$/.test(node.expression.text)
      : ts.isPropertyAccessExpression(node.expression) && /^(setTimeout|setInterval)$/.test(node.expression.name.text)));
  assert.equal(timers.length, 0, 'R273:no-background-timers');
  // Проверяется обработчик целиком, включая вложенные функции, а не совпадение слов в комментарии.
  const stateHandlers = nodes(tree).filter((node): node is ts.BinaryExpression | ts.CallExpression => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
      return /statechange$/i.test(node.left.name.text);
    }
    return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'addEventListener'
      && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0]) && /statechange$/i.test(node.arguments[0].text);
  });
  for (const handler of stateHandlers) {
    assert.equal(nodes(handler).some((node) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'resume'), false, 'R273:no-statechange-resume');
  }
}

function rendererThread(raw: string) {
  // Нативный код не исполняем в JS. Это узкий текстовый страж моста и политики, не доказательство работы Android API.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal(/@JavascriptInterface\s+fun voiceRendererPriority\(on: Boolean\)\s*\{\s*runOnUiThread\s*\{\s*applyVoiceRendererPriority\(on\)\s*\}\s*\}/.test(code), true, 'R273:renderer-main-thread');
  assert.equal(/setRendererPriorityPolicy\(WebView\.RENDERER_PRIORITY_IMPORTANT,\s*false\)/.test(code), true, 'R273:renderer-important');
  assert.equal(/rendererPriorityBeforeVoice\s*=\s*Pair\(wv\.rendererRequestedPriority,\s*wv\.rendererPriorityWaivedWhenNotVisible\)/.test(code), true, 'R273:renderer-saved');
  assert.equal(/setRendererPriorityPolicy\(before\.first,\s*before\.second\)/.test(code), true, 'R273:renderer-restored');
}

const replace = (raw: string, from: string, to: string) => {
  assert.equal(raw.split(from).length, 2, `единственная точка мутации: ${from}`);
  return raw.replace(from, to);
};
for (const [name, raw, check, from, to, marker] of [
  ['LiveKit получает общий контекст, а не свой', voice, sharedMixer, 'webAudioMix: mixCtx ? { audioContext: mixCtx } : true', 'webAudioMix: true', 'R273:shared-webAudioMix'],
  ['очистка эффекта заканчивает keepalive', voice, lifetime, '      stopVoiceKeepAlive();', '', 'R273:effect-stop-cleanup'],
  ['анализатор не присваивает себе общий контекст', voice, analyzerOwnership, 'let ownCtx = false;', 'let ownCtx = true;', 'R273:analyzer-own-context'],
  ['в фоне нет таймера пересборки', keepAlive, eventOnly, 'loopRestarts++;', 'loopRestarts++; setTimeout(() => {}, 1000);', 'R273:no-background-timers'],
  ['statechange не будит контекст', keepAlive, eventOnly, 'a.onconnectionstatechange = () => {', 'a.onconnectionstatechange = () => { void n.ctx.resume();', 'R273:no-statechange-resume'],
  ['нативный приоритет меняется на главном потоке', activity, rendererThread, 'runOnUiThread { applyVoiceRendererPriority(on) }', 'applyVoiceRendererPriority(on)', 'R273:renderer-main-thread'],
] as const) {
  it(`проводка и контрфакт: ${name}`, () => {
    check(raw);
    const mutant = replace(raw, from, to);
    assert.throws(() => check(mutant), (error: unknown) => error instanceof assert.AssertionError && error.message.includes(marker));
  });
}
