import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./sockets.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const compact = (node: ts.Node) => node.getText().replace(/\s+/g, '');
function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) out.push(node); ts.forEachChild(node, visit); };
  visit(root); return out;
}
function wiring(raw = source) {
  // Только AST целого sockets: без импорта стора, браузера и исполнения вырезанного switch.
  const file = ts.createSourceFile('sockets.ts', raw, ts.ScriptTarget.Latest, true);
  const imports = file.statements.filter(ts.isImportDeclaration).filter(n =>
    ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === './gatewaySubs');
  assert.equal(imports.length, 1);
  const names = imports[0].importClause?.namedBindings; assert.ok(names && ts.isNamedImports(names));
  for (const name of ['onSubRejected', 'onRetryDue']) {
    assert.ok(names.elements.some(n => n.name.text === name && (!n.propertyName || n.propertyName.text === name)),
      `настоящий ${name} подключён без подмены`);
  }
  const connect = file.statements.filter(ts.isFunctionDeclaration).find(n => n.name?.text === 'connectGateway');
  assert.ok(connect);
  const errors = nodes(connect, ts.isCaseClause).filter(n => ts.isStringLiteral(n.expression) && n.expression.text === 'error');
  assert.equal(errors.length, 1);
  const branch = errors[0];
  const calls = nodes(branch, ts.isCallExpression);
  const reject = calls.filter(n => n.expression.getText() === 'onSubRejected'); assert.equal(reject.length, 1);
  assert.deepEqual(reject[0].arguments.map(compact), ['subs', 'serverId', 'msg.message'], 'причина доходит до чистого правила');
  assert.equal(calls.filter(n => n.expression.getText() === 'wantSub').length, 0, 'ошибка не обходит backoff через wantSub');
  const guards = nodes(branch, ts.isIfStatement);
  assert.ok(guards.some(n => compact(n.expression) === '!msg.serverId' && ts.isReturnStatement(n.thenStatement)),
    'неадресная ошибка не назначает повтор');
  const guarded = guards.find(n => compact(n.expression) === 'retry'); assert.ok(guarded);
  const timers = nodes(guarded.thenStatement, ts.isCallExpression).filter(n => n.expression.getText() === 'setTimeout');
  assert.equal(timers.length, 1, 'R264 проводка: временный отказ назначает один таймер');
  const [callback, delay] = timers[0].arguments;
  assert.ok(callback && ts.isArrowFunction(callback)); assert.ok(delay);
  assert.equal(compact(delay), 'retry.delayMs', 'отсрочка берётся из правила, не дублируется в сокете');
  const dues = nodes(callback, ts.isCallExpression).filter(n => n.expression.getText() === 'onRetryDue');
  assert.equal(dues.length, 1);
  assert.deepEqual(dues[0].arguments.map(compact), ['subs', 'serverId', 'retry.gen'], 'таймер сохраняет назначенное поколение');
  const sends = calls.filter(n => n.expression.getText() === 'sendSubscribe');
  assert.equal(sends.length, 1, 'R264 проводка: единственная отправка подписки находится в таймере');
  assert.ok(sends[0].getStart() >= callback.getStart() && sends[0].end <= callback.end,
    'R264 проводка: subscribe отправляется только внутри таймера');
  const loops = nodes(callback, ts.isForOfStatement);
  assert.equal(loops.length, 1);
  assert.equal(compact(loops[0].expression), 'onRetryDue(subs,serverId,retry.gen)');
  assert.equal(compact(loops[0].statement), 'sendSubscribe(id);', 'отправляются только разрешённые onRetryDue серверы');
}

// Класс ошибки: правильное правило остаётся неиспользованным, а error немедленно повторяет subscribe.
it('R264 sockets error передаёт причину правилу и отправляет подписку только по таймеру с его delay и gen', () => wiring());
it('R264 страж проводки ловит немедленный subscribe и потерю таймера после original-first', () => {
  const anchor = 'for (const id of onRetryDue(subs, serverId, retry.gen)) sendSubscribe(id);';
  assert.equal(source.split(anchor).length - 1, 1);
  assert.equal(source.split('if (retry) {').length - 1, 1);
  wiring();
  const immediate = source.replace('if (retry) {', 'if (retry) { sendSubscribe(serverId);');
  // В этом мутанте два send: не принимаем любое падение/парсинг как доказательство.
  assert.throws(() => wiring(immediate),
    e => e instanceof assert.AssertionError && e.message.startsWith('R264 проводка: единственная отправка подписки находится в таймере'));
  const timer = 'setTimeout(() => {\n            for (const id of onRetryDue(subs, serverId, retry.gen)) sendSubscribe(id);\n          }, retry.delayMs);';
  assert.equal(source.split(timer).length - 1, 1);
  wiring();
  assert.throws(() => wiring(source.replace(timer, '/* таймер потерян */')),
    e => e instanceof assert.AssertionError && e.message.startsWith('R264 проводка: временный отказ назначает один таймер'));
});
