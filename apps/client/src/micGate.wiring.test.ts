import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const processorSource = readFileSync(new URL('./micProcessor.ts', import.meta.url), 'utf8');
const voiceSource = readFileSync(new URL('./components/VoiceConnection.tsx', import.meta.url), 'utf8');
const compact = (n: ts.Node) => n.getText().replace(/\s+/g, '');

function descendants(n: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  function visit(node: ts.Node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(n);
  return found;
}
function parse(raw: string, name: string, kind: ts.ScriptKind) {
  const file = ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true, kind);
  assert.equal((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0, 'исходник синтаксически корректен');
  return file;
}
function variable(scope: ts.Node, name: string): ts.Expression {
  const matches = descendants(scope, n => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) as ts.VariableDeclaration[];
  assert.equal(matches.length, 1, `одна настоящая переменная ${name}`);
  assert.ok(matches[0].initializer);
  return matches[0].initializer;
}
function processor(raw: string) {
  const file = parse(raw, 'micProcessor.ts', ts.ScriptKind.TS);
  const funcs = file.statements.filter(ts.isFunctionDeclaration).filter(n => n.name?.text === 'createMicProcessor');
  assert.equal(funcs.length, 1); assert.ok(funcs[0].body);
  return funcs[0].body;
}
function tick(raw: string) {
  const file = parse(raw, 'VoiceConnection.tsx', ts.ScriptKind.TSX);
  const components = file.statements.filter(ts.isFunctionDeclaration).filter(n => n.name?.text === 'VoiceConnection');
  assert.equal(components.length, 1); assert.ok(components[0].body);
  const callback = variable(components[0].body, 'tick');
  assert.ok(ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  return callback.body;
}

it('R260 настоящий порт гейта принимает только boolean open и пишет состояние — иначе чужой кадр закрывает обводку', () => {
  const body = processor(processorSource);
  const assignments = descendants(body, n => ts.isBinaryExpression(n) && compact(n.left) === 'gateNode.port.onmessage') as ts.BinaryExpression[];
  assert.equal(assignments.length, 1);
  const handler = assignments[0].right;
  assert.ok(ts.isArrowFunction(handler) && ts.isBlock(handler.body));
  assert.equal(handler.body.statements.length, 1);
  const guard = handler.body.statements[0]; assert.ok(ts.isIfStatement(guard));
  assert.equal(compact(guard.expression), "e.data&&typeofe.data.open==='boolean'");
  assert.equal(compact(guard.thenStatement), 'setMicGateOpen(e.data.open);');
  assert.equal(guard.elseStatement, undefined);
});

it('R260 teardown сбрасывает гейт в null и вызывается при destroy и restart — иначе новая цепь наследует закрытое состояние', () => {
  const body = processor(processorSource), cleanup = variable(body, 'teardown');
  assert.ok(ts.isArrowFunction(cleanup) && ts.isBlock(cleanup.body));
  assert.ok(cleanup.body.statements.some(n => ts.isExpressionStatement(n) && compact(n.expression) === 'setMicGateOpen(null)'));
  const object = variable(body, 'processor'); assert.ok(ts.isObjectLiteralExpression(object));
  for (const methodName of ['destroy', 'restart']) {
    const methods: ts.MethodDeclaration[] = object.properties.filter(ts.isMethodDeclaration).filter(n => compact(n.name) === methodName);
    assert.equal(methods.length, 1); assert.ok(methods[0].body);
    assert.equal(compact(methods[0].body.statements[0]), 'teardown();');
  }
});

it('R260 pushParams немедленно открывает индикацию при рации или пороге ноль только с существующим гейтом — иначе ждёт несуществующий порт', () => {
  const body = processor(processorSource), push = variable(body, 'pushParams');
  assert.ok(ts.isArrowFunction(push) && ts.isBlock(push.body));
  assert.equal(compact(variable(push.body, 'threshold')), 's.pushToTalk?0:Math.max(0,Math.min(1,s.vadThreshold))');
  assert.ok(push.body.statements.some(n => ts.isExpressionStatement(n) && compact(n.expression) === 'gateNode?.port.postMessage({threshold})'));
  const guards = push.body.statements.filter(ts.isIfStatement).filter(n => compact(n.expression) === 'gateNode&&threshold<=0');
  assert.equal(guards.length, 1);
  assert.equal(compact(guards[0].thenStatement), 'setMicGateOpen(true);');
});

function rebind(raw: string) {
  const body = tick(raw);
  const loops = body.statements.filter(ts.isForOfStatement);
  assert.equal(loops.length, 1); assert.ok(ts.isBlock(loops[0].statement));
  const loop = loops[0].statement;
  assert.equal(compact(loops[0].expression), '[room.localParticipant,...room.remoteParticipants.values()]');
  assert.equal(compact(variable(loop, 'isSelf')), 'p===room.localParticipant');
  assert.equal(compact(variable(loop, 'micOn')), 'p.isMicrophoneEnabled');
  const guards = loop.statements.filter(ts.isIfStatement).filter(n => compact(n.expression) === 'isSelf&&micOn');
  assert.equal(guards.length, 1, 'R260:tick-перепривязывает-свой-трек');
  assert.ok(ts.isBlock(guards[0].thenStatement));
  const own = guards[0].thenStatement;
  assert.equal(compact(variable(own, 'cur')), 'p.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack??null');
  const changed = own.statements.filter(ts.isIfStatement);
  assert.equal(changed.length, 1);
  assert.equal(compact(changed[0].expression), 'cur&&mons.get(p.identity)?.track!==cur');
  assert.equal(compact(changed[0].thenStatement), 'attach(p.identity,cur,true);');
  const monitor = loop.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'm'));
  assert.ok(monitor);
  assert.ok(loop.statements.indexOf(guards[0]) < loop.statements.indexOf(monitor), 'перепривязка до чтения анализатора');
}

it('R260 tick заново получает обработанный собственный трек и перепривязывает только изменившийся — иначе анализирует сырой микрофон', () => rebind(voiceSource));

it('R260 гейт влияет только на свою обводку, чужая остаётся по VAD — иначе мой закрытый микрофон гасит друзей', () => {
  const body = tick(voiceSource);
  const assignments = descendants(body, n => ts.isBinaryExpression(n) && compact(n.left) === 'speaking'
    && ts.isConditionalExpression(n.right)) as ts.BinaryExpression[];
  assert.equal(assignments.length, 1);
  const value = assignments[0].right; assert.ok(ts.isConditionalExpression(value));
  assert.equal(compact(value.condition), 'isSelf');
  assert.equal(compact(value.whenTrue), 'ownRingSpeaking(step.speaking,getMicGateOpen())');
  assert.equal(compact(value.whenFalse), 'step.speaking');
});

it('R260 контрфакт: удаление перепривязки замечается адресно, даже если sync продолжает существовать', () => {
  rebind(voiceSource);
  const body = tick(voiceSource);
  const matches = descendants(body, n => ts.isIfStatement(n) && compact(n.expression) === 'isSelf&&micOn');
  assert.equal(matches.length, 1);
  const removed = matches[0];
  const changed = voiceSource.slice(0, removed.getStart()) + voiceSource.slice(removed.getEnd());
  assert.throws(() => rebind(changed), error => error instanceof assert.AssertionError
    && error.message.includes('R260:tick-перепривязывает-свой-трек'));
});
