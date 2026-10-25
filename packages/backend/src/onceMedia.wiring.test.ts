import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

// Не загружаем ни БД, ни Redis и не заводим настоящий setInterval: проверяется AST целых прод-модулей.
const conversationSource = readFileSync(new URL('./conversations.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const scheduledSource = readFileSync(new URL('./scheduled.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const compact = (n: ts.Node) => n.getText().replace(/\s+/g, '');
function body(raw: string, name: string): ts.Block {
  const file = ts.createSourceFile('once-source.ts', raw, ts.ScriptTarget.Latest, true);
  assert.equal((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0);
  const functions = file.statements.filter(ts.isFunctionDeclaration).filter(n => n.name?.text === name);
  assert.equal(functions.length, 1, `одна настоящая функция ${name}`);
  assert.ok(functions[0].modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
  assert.ok(functions[0].body); return functions[0].body;
}
function startup(raw: string) {
  const worker = body(raw, 'startScheduledWorker');
  assert.equal(compact(worker.statements[0]), 'startOnceSweeper();', 'R262:воркер-запускает-сторож');
}
function timer(raw: string) {
  const sweeper = body(raw, 'startOnceSweeper');
  const declarations = sweeper.statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations]);
  const found = declarations.filter(d => ts.isIdentifier(d.name) && d.name.text === 'timer');
  assert.equal(found.length, 1); assert.ok(found[0].initializer && ts.isCallExpression(found[0].initializer));
  const call = found[0].initializer;
  assert.equal(compact(call.expression), 'setInterval'); assert.equal(call.arguments.length, 2);
  assert.equal(compact(call.arguments[1]), '10_000', 'R262:сторож-каждые-10-секунд');
  const callback = call.arguments[0]; assert.ok(ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  return { sweeper, callback: callback.body, declarations };
}
function busy(raw: string) {
  const { callback, declarations } = timer(raw);
  const initial = declarations.find(d => ts.isIdentifier(d.name) && d.name.text === 'busy');
  assert.ok(initial?.initializer); assert.equal(compact(initial.initializer), 'false');
  assert.equal(compact(callback.statements[0]), 'if(busy)return;', 'R262:сторож-не-перекрывает-такты');
  assert.equal(compact(callback.statements[1]), 'busy=true;');
  assert.equal(compact(callback.statements[2]), 'voidsweepOpenedOnce().catch(()=>{}).finally(()=>{busy=false;});',
    'R262:сторож-снимает-busy-после-успеха-и-ошибки');
  assert.equal(callback.statements.length, 3);
}
function unref(raw: string) {
  const { sweeper } = timer(raw);
  assert.ok(sweeper.statements.some(n => compact(n) === 'timer.unref?.();'), 'R262:таймер-не-держит-процесс');
}

it('R262 запуск планировщика запускает сторож once — иначе проверенный sweep никогда не работает в приложении', () => startup(scheduledSource));
it('R262 сторож установлен на 10 секунд — иначе одноразовое остаётся после исчезновения клиента', () => { timer(conversationSource); });
it('R262 занятый такт пропускается, busy снимается в finally даже после ошибки — иначе перекрытие или вечная остановка', () => busy(conversationSource));
it('R262 таймер сторожа отпущен через unref — иначе фоновая уборка держит процесс при завершении', () => unref(conversationSource));

for (const [label, source, from, to, check, marker] of [
  ['потерян запуск из планировщика', scheduledSource, '  startOnceSweeper();', '', startup, 'R262:воркер-запускает-сторож'],
  ['исчезла защита от перекрытия', conversationSource, '    if (busy) return;', '', busy, 'R262:сторож-не-перекрывает-такты'],
  ['после такта не снимается busy', conversationSource, '        busy = false;', '', busy, 'R262:сторож-снимает-busy-после-успеха-и-ошибки'],
  ['таймер держит процесс', conversationSource, '  timer.unref?.();', '', unref, 'R262:таймер-не-держит-процесс'],
] as const) it(`R262 контрфакт: ${label} ловится адресным AST-утверждением, не синтаксической ошибкой`, () => {
  check(source);
  assert.equal(source.split(from).length - 1, 1, 'одна адресная точка мутации');
  assert.throws(() => check(source.replace(from, to)), error => error instanceof assert.AssertionError && error.message.includes(marker));
});
