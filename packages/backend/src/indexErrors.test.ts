import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import ts from 'typescript';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

async function response(error: Error, raw = source) {
  const app = Fastify();
  const deps: Record<string, unknown> = {};
  const tree = ts.createSourceFile('index.ts', raw, ts.ScriptTarget.Latest, true);
  for (const node of tree.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !node.importClause) continue;
    const exports: Record<string, unknown> = {};
    if (node.importClause.name) exports.default = async () => {};
    const binding = node.importClause.namedBindings;
    if (binding && ts.isNamedImports(binding)) {
      for (const item of binding.elements) exports[(item.propertyName ?? item.name).text] = async () => {};
    }
    deps[node.moduleSpecifier.text] = { __esModule: true, ...exports };
  }
  let registered = 0;
  deps.fastify = { __esModule: true, default: () => ({
    register: async () => {}, addContentTypeParser: () => {}, addHook: () => {}, get: () => {},
    listen: async () => {}, log: { info: () => {}, warn: () => {}, error: assert.fail },
    setErrorHandler: (handler: Parameters<typeof app.setErrorHandler>[0]) => {
      registered++; app.setErrorHandler(handler);
    },
  }) };
  deps.zod = { ZodError };
  deps['./env.js'] = { env: { port: 0, federation: { enabled: false }, economyEnabled: false, diagEnabled: false } };
  deps['./federation/instance.js'] = { federation: { start: async () => {} },
    startFederationAlerts: () => {}, startFederationKeyRotation: () => {} };
  const module = { exports: {} };
  try {
    // Исполняется ВЕСЬ index.ts в async-обёртке для top-level await, не вырезка обработчика.
    // Бутстрап/воркеры/окружение — явные заглушки; настоящий Fastify получает зарегистрированный обработчик.
    await runInNewContext(`(async () => {\n${ts.transpileModule(raw, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText}\n})()`, { module, exports: module.exports,
      require: (id: string) => { assert.ok(id in deps, `неизвестная зависимость ${id}`); return deps[id]; },
      process: { exit: assert.fail }, console });
    assert.equal(registered, 1, 'Fastify получил единственный настоящий глобальный обработчик');
    app.get('/test-error', async () => { throw error; });
    const reply = await app.inject({ method: 'GET', url: '/test-error' });
    return { status: reply.statusCode, data: reply.json() as { error: string; details?: unknown[] } };
  } finally { await app.close(); }
}

it('R131 непредвиденная SQL-ошибка и явно заданная 500 скрывают подробности от клиента', async () => {
  // Текст внутренних ошибок не должен утекать через общий catch независимо от наличия statusCode=500.
  for (const error of [new Error('SQL: relation example_table is unavailable'),
    Object.assign(new Error('SQL: unexpected query failure'), { statusCode: 500 })]) {
    assert.deepEqual(await response(error), { status: 500, data: { error: 'internal error' } });
  }
});

it('R131 явные 429, 502 и 503 сохраняют предназначенное человеку объяснение', async () => {
  // Защита внутренних подробностей не должна маскировать штатную квоту или отказ внешнего сервиса.
  for (const statusCode of [429, 502, 503]) {
    const error = Object.assign(new Error(`Объяснение отказа ${statusCode}`), { statusCode });
    assert.deepEqual(await response(error), { status: statusCode, data: { error: error.message } });
    assert.deepEqual(await response(Object.assign(new Error(''), { statusCode })),
      { status: statusCode, data: { error: 'internal error' } });
  }
});

it('R131 ZodError отдаёт 400, первое объяснение и детали, пустой список получает понятный fallback', async () => {
  // Глобальный отказ не должен превращать корректируемый ввод в 500 или потерять конкретное поле ошибки.
  const error = new ZodError([{ code: 'custom', path: ['size'], message: 'Размер не подходит' },
    { code: 'custom', path: ['name'], message: 'Имя не подходит' }]);
  assert.deepEqual(await response(error), { status: 400, data: { error: 'Размер не подходит', details: error.errors } });
  assert.deepEqual(await response(new ZodError([])),
    { status: 400, data: { error: 'Проверьте введённые данные', details: [] } });
});

it('R131 мутант возврата e.message для внутренней ошибки отвергается настоящим inject', async () => {
  // Проверяется отказ клиенту на HTTP-границе, а не наличие защитного текста в исходнике.
  const check = async (raw: string) => assert.deepEqual(await response(new Error('SQL: internal query failure'), raw),
    { status: 500, data: { error: 'internal error' } });
  await check(source);
  const mutant = source.replace("error: expose ? e.message : 'internal error'", 'error: e.message');
  assert.notEqual(mutant, source);
  await assert.rejects(check(mutant), assert.AssertionError);
});
