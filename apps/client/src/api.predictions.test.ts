import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { sourceOf, pairedAsync, snapshot, event, iso, normal, type Edit } from './predictions.harness';

const source = sourceOf('./api.ts'), P = 'R338 API: ';
type Api = typeof import('./api').api;
const SETUP = 'R338 setup: ';
const predictionMethods = ['getPredictions', 'createPrediction', 'betPrediction', 'predictionAction', 'settlePrediction'] as const;
function only<T>(nodes: readonly T[], name: string): T {
  assert.equal(nodes.length, 1, SETUP + 'единственный AST-якорь ' + name);
  return nodes[0];
}

/**
 * Режем только списки членов объектов по AST-границам. Каждая функция, включая транспорт и разбор
 * ошибки, остаётся целой и дословной из api.ts; тела не вырезаются и не заменяются моделью API.
 * Полный api.ts здесь не нужен: JSX-режим общего harness принимал его generic <T> за JSX и ломал emitter.
 */
function predictionSource(raw: string): string {
  const file = ts.createSourceFile('api.ts', raw, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  assert.equal((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0,
    SETUP + 'исходный api.ts синтаксически корректен');
  const functions = file.statements.filter(ts.isFunctionDeclaration);
  const fn = (name: string) => only(functions.filter(node => node.name?.text === name), name);
  const variable = (name: string) => {
    const statement = only(file.statements.filter(ts.isVariableStatement).filter(node =>
      node.declarationList.declarations.some(decl => ts.isIdentifier(decl.name) && decl.name.text === name)), name);
    assert.equal(statement.declarationList.declarations.length, 1, SETUP + 'цельная декларация ' + name);
    return statement;
  };
  const subset = (owner: ts.Node, object: ts.ObjectLiteralExpression, members: readonly ts.ObjectLiteralElementLike[]) =>
    raw.slice(owner.getStart(file), object.getStart(file)) + '{\n' + members.map(member => member.getText(file)).join(',\n')
      + '\n}' + raw.slice(object.end, owner.end);
  const transport = variable('activeTransport');
  const transportObject = transport.declarationList.declarations[0].initializer;
  assert.ok(transportObject && ts.isObjectLiteralExpression(transportObject), SETUP + 'объект activeTransport');
  const request = only(transportObject.properties.filter(ts.isMethodDeclaration).filter(node =>
    ts.isIdentifier(node.name) && node.name.text === 'req'), 'activeTransport.req');
  assert.ok(request.body, SETUP + 'цельный метод activeTransport.req');

  const factory = fn('makeApi');
  assert.ok(factory.body, SETUP + 'цельная функция makeApi');
  const returned = only(factory.body.statements.filter(ts.isReturnStatement), 'makeApi return');
  assert.ok(returned.expression && ts.isObjectLiteralExpression(returned.expression), SETUP + 'объект методов makeApi');
  const properties = returned.expression.properties;
  const methods = predictionMethods.map(name => {
    const property = only(properties.filter(ts.isPropertyAssignment).filter(node =>
      ts.isIdentifier(node.name) && node.name.text === name), 'makeApi.' + name);
    assert.ok(ts.isArrowFunction(property.initializer), SETUP + 'цельная функция ' + name);
    return property;
  });
  const configImport = only(file.statements.filter(ts.isImportDeclaration).filter(node =>
    ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === './config'), 'импорт ./config');
  return [configImport.getText(file), fn('initialToken').getText(file), variable('token').getText(file),
    variable('epoch').getText(file), ...['switchedAway', 'setToken', 'absorbRefresh', 'parseResponse', 'fetchWithin'].map(name => fn(name).getText(file)),
    subset(transport, transportObject, [request]), subset(factory, returned.expression, methods), variable('api').getText(file)].join('\n');
}

function fixture(raw: string, body: unknown, status = 200) {
  const requests: { url: string; init: RequestInit }[] = [];
  const unused = () => assert.fail('R338 setup: посторонняя IO API');
  const dependencies: Record<string, unknown> = {
    './config': { config: { apiUrl: 'https://api.example.test' }, activeInstance: () => null, activeInstanceId: () => null,
      instances: () => [], updateActiveInstance: unused, updateInstance: unused },
  };
  const compiled = ts.transpileModule(predictionSource(raw), { fileName: 'api.predictions.fixture.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
  assert.equal((compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0,
    SETUP + 'AST-срез транспилируется как TypeScript, не JSX');
  const module = { exports: {} as { api: Api } };
  runInNewContext(compiled.outputText, { module, exports: module.exports, URL, Error, TypeError, Response, Headers, AbortSignal,
    localStorage: { getItem: (key: string) => { assert.equal(key, 'gv_token', 'R338 setup: только синтетическая сессия'); return null; }, setItem: unused, removeItem: unused },
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init }); return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    },
    require(id: string) {
      assert.ok(Object.hasOwn(dependencies, id), SETUP + 'закрытый импорт ' + id);
      return dependencies[id];
    },
  }, { timeout: 1_000 });
  return { api: module.exports.api, requests };
}
const draft = { title: 'Матч', lockInSec: null, questions: [{ question: 'Кто?', options: ['Альфа', 'Бета'] }] };
const stake = { questionId: 'q1', optionId: 'o2', amount: 37 };
const winners = { q1: 'o2', q2: null };
const reply = { event: event(), serverNow: iso() };
const cases: Array<{ name: string; call(api: Api): Promise<unknown>; path: string; method: string; body?: unknown; response: unknown; edit: Edit }> = [
  { name: 'getPredictions', call: a => a.getPredictions('s'), path: '/servers/s/predictions', method: 'GET', response: snapshot(),
    edit: ["req<PredictionSnapshotDto>('GET', `/servers/${serverId}/predictions`)", "req<PredictionSnapshotDto>('POST', `/servers/${serverId}/predictions`)"] },
  { name: 'createPrediction', call: a => a.createPrediction('s', draft), path: '/servers/s/predictions', method: 'POST', body: draft, response: reply,
    edit: ["req<{ event: PredictionEventDto; serverNow: string }>('POST', `/servers/${serverId}/predictions`, body)",
      "req<{ event: PredictionEventDto; serverNow: string }>('POST', `/servers/${serverId}/predictions`, {})"] },
  { name: 'betPrediction', call: a => a.betPrediction('s', 'ev', stake), path: '/servers/s/predictions/ev/bets', method: 'POST', body: stake, response: reply,
    edit: ['`/servers/${serverId}/predictions/${eventId}/bets`, body', '`/servers/${serverId}/predictions/${eventId}/bets`, {}'] },
  ...(['close', 'cancel'] as const).map(action => ({ name: `predictionAction ${action}`, call: (a: Api) => a.predictionAction('s', 'ev', action),
    path: `/servers/s/predictions/ev/${action}`, method: 'POST', response: reply,
    edit: ['`/servers/${serverId}/predictions/${eventId}/${action}`', '`/servers/${serverId}/predictions/${eventId}/wrong`'] as Edit })),
  { name: 'settlePrediction', call: a => a.settlePrediction('s', 'ev', winners), path: '/servers/s/predictions/ev/settle', method: 'POST', body: { winners }, response: reply,
    edit: ['`/servers/${serverId}/predictions/${eventId}/settle`, { winners }', '`/servers/${serverId}/predictions/${eventId}/settle`, winners'] },
];
for (const row of cases) it(`R338 API ${row.name}: адрес, метод, точное тело и неизменённый ответ`, () => pairedAsync(source, async raw => {
  const f = fixture(raw, row.response);
  assert.deepEqual(normal(await row.call(f.api)), row.response, P + 'ответ передан без потерь');
  assert.equal(f.requests.length, 1, P + 'один запрос');
  const req = f.requests[0];
  assert.equal(req.url, 'https://api.example.test/api' + row.path, P + 'точный адрес');
  assert.equal(req.init.method, row.method, P + 'точный метод');
  assert.deepEqual(req.init.body === undefined ? undefined : JSON.parse(String(req.init.body)), row.body, P + 'точное тело, включая null');
  assert.equal(new Headers(req.init.headers).has('Authorization'), false, P + 'не используется реальный вход');
}, [row.edit], P));

const FIELD = "if (typeof field === 'string') (err as Error & { field?: string }).field = field;";
it('R338 API отказ bad_draft сохраняет строковое поле с нуля вместе со статусом и reason', () => pairedAsync(source, async raw => {
  const f = fixture(raw, { error: 'bad_draft', reason: 'bad_draft', field: 'q0.o1' }, 400);
  let caught: unknown;
  try { await f.api.createPrediction('s', draft); } catch (e) { caught = e; }
  assert.ok(caught instanceof Error, P + 'отказ остаётся Error');
  const er = caught as Error & { status?: number; reason?: string; field?: string };
  assert.equal(er.status, 400, P + 'статус'); assert.equal(er.reason, 'bad_draft', P + 'машинная причина');
  assert.equal(er.message, 'bad_draft', P + 'машинное сообщение');
  assert.equal(er.field, 'q0.o1', P + 'field дошёл до редактора');
}, [[FIELD, 'void field;']], P));

it('R338 API не принимает произвольный объект за field; строка принимается в парной пробе', () => pairedAsync(source, async raw => {
  for (const field of [null, 42, {}, [], false]) {
    const f = fixture(raw, { error: 'bad_draft', field }, 400);
    let caught: unknown; try { await f.api.createPrediction('s', draft); } catch (e) { caught = e; }
    assert.ok(caught instanceof Error, P + 'отказ остался Error');
    assert.equal(Object.hasOwn(caught, 'field'), false, P + 'нестрочное field отсутствует');
  }
  const f = fixture(raw, { error: 'bad_draft', field: 'title' }, 400);
  let caught: unknown; try { await f.api.createPrediction('s', draft); } catch (e) { caught = e; }
  assert.equal((caught as { field: string }).field, 'title', P + 'строчное field принято');
}, [[FIELD, '(err as Error & { field?: unknown }).field = field;']], P));
