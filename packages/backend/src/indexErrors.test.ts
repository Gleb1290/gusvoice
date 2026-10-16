import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

async function routeStatuses(raw = source): Promise<number[]> {
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
  deps.fastify = { __esModule: true, default: () => ({
    register: app.register.bind(app), get: app.get.bind(app), addHook: app.addHook.bind(app),
    setErrorHandler: app.setErrorHandler.bind(app), addContentTypeParser: () => {},
    listen: async () => {}, log: { info: () => {}, warn: () => {}, error: assert.fail },
  }) };
  deps.zod = { ZodError };
  deps['./env.js'] = { env: { port: 0, federation: { enabled: false }, economyEnabled: false, diagEnabled: false } };
  deps['./federation/instance.js'] = { federation: { start: async () => {} },
    startFederationAlerts: () => {}, startFederationKeyRotation: () => {} };
  // Маршруты — лёгкие маркеры регистрации. Проверяется настоящий index.ts и настоящий Fastify,
  // а SQL/авторизация внутри conv отдельно покрыты интеграционными тестами.
  deps['./routes/conv.js'] = { convRoutes: async (api: typeof app) => {
    api.get('/conv', async () => ({ ok: true }));
    api.post('/conv', async () => ({ ok: true }));
    api.post('/conv/:id/messages', async () => ({ ok: true }));
  } };
  deps['./routes/dmFolders.js'] = { dmFolderRoutes: async (api: typeof app) => {
    api.get('/dm-folders', async () => ({ ok: true }));
  } };
  deps['./routes/dm.js'] = { dmRoutes: async (api: typeof app) => {
    for (const url of ['/dm', '/dm/:id/messages']) {
      api.get(url, async () => ({ legacy: true }));
      api.post(url, async () => ({ legacy: true }));
    }
  } };
  const module = { exports: {} };
  try {
    await runInNewContext(`(async () => {\n${ts.transpileModule(raw, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText}\n})()`, { module, exports: module.exports,
      require: (id: string) => { assert.ok(id in deps, `неизвестная зависимость ${id}`); return deps[id]; },
      process: { exit: assert.fail }, console });
    const cases = [
      ['GET', '/api/dm'], ['POST', '/api/dm'], ['GET', '/api/dm/c/messages'], ['POST', '/api/dm/c/messages'],
      ['GET', '/api/conv'], ['POST', '/api/conv'], ['POST', '/api/conv/c/messages'],
      ['GET', '/api/dm-folders'], ['GET', '/health'],
    ] as const;
    const statuses: number[] = [];
    for (const [method, url] of cases) statuses.push((await app.inject({ method, url })).statusCode);
    return statuses;
  } finally { await app.close(); }
}

it('R137 старые ручки ЛС отвечают 404, беседы и папки остаются зарегистрированы', async () => {
  // Универсальный 404 из пустого app не доказывает вывод старого API: новые пути обязаны работать.
  assert.deepEqual(await routeStatuses(), [404, 404, 404, 404, 200, 200, 200, 200, 200]);
});

it('R137 возврат регистрации dmRoutes возвращает старые ручки и отвергается HTTP-проверкой', async () => {
  // Доказательство проходит через ту же регистрацию index и inject, а не поиск названия импорта.
  const verify = async (raw: string) => assert.deepEqual(await routeStatuses(raw),
    [404, 404, 404, 404, 200, 200, 200, 200, 200]);
  await verify(source);
  const anchor = 'await api.register(convRoutes);';
  assert.ok(source.includes(anchor));
  const mutant = "import { dmRoutes } from './routes/dm.js';\n" +
    source.replace(anchor, `${anchor}\n    await api.register(dmRoutes);`);
  await assert.rejects(verify(mutant), assert.AssertionError);
});

function noLegacyTables(files: readonly { path: string; text: string }[]): void {
  assert.ok(files.length > 0, 'проверены исходники, а не пустой список');
  for (const file of files) {
    assert.doesNotMatch(file.text, /\b(?:dm_messages|dm_channels|dm_reads|dm_message_reactions)\b/, file.path);
  }
}

it('R137 сервер вне schema не обращается к старым таблицам ЛС, возвращённый SQL ловится', () => {
  // После DROP даже забытая строка в редком фоне/удалении аккаунта уронит SQL в живой системе.
  const root = new URL('./', import.meta.url);
  const files: { path: string; text: string }[] = [];
  const collect = (dir: URL, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) collect(new URL(`${entry.name}/`, dir), `${path}/`);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && path !== 'db/schema.ts') {
        files.push({ path, text: readFileSync(new URL(entry.name, dir), 'utf8') });
      }
    }
  };
  collect(root);
  noLegacyTables(files);
  for (const table of ['dm_messages', 'dm_channels', 'dm_reads', 'dm_message_reactions']) {
    assert.throws(() => noLegacyTables([...files, { path: 'regression.ts', text: `SELECT * FROM ${table}` }]),
      assert.AssertionError);
  }
});
