import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import Fastify from 'fastify';
import { z } from 'zod';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as schema from '../db/schema.js';
import * as setupRules from '../setupRules.js';
import * as superRules from '../superAdminRules.js';
import * as linkRules from '../federation/linkRules.js';

const source = readFileSync(new URL('./setup.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const forbidden = (name: string) => () => { throw new Error(`незадействованная IO-граница ${name}`); };
async function instance(status: string, name: string | null, raw = source) {
  const dependencies: Record<string, unknown> = {};
  for (const n of ts.createSourceFile('setup.ts', raw, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly) continue;
    const path = (n.moduleSpecifier as ts.StringLiteral).text, exports: Record<string, unknown> = {};
    if (n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings))
      for (const item of n.importClause.namedBindings.elements) if (!item.isTypeOnly)
        exports[item.propertyName?.text ?? item.name.text] = forbidden(`${path}.${item.name.text}`);
    dependencies[path] = exports;
  }
  let fedMetaCalls = 0;
  Object.assign(dependencies, {
    'node:crypto': { randomUUID }, 'drizzle-orm': orm, zod: { z }, '../db/schema.js': schema,
    '../env.js': { env: { federation: { enabled: true } } },
    '../federation/instance.js': { federation: { status: () => status } },
    '../federation/linkRules.js': linkRules,
    '../federation/instanceMeta.js': { readInstanceMeta: async () => { fedMetaCalls++; return { name }; } },
    '../instanceSetup.js': { instanceMeta: async () => ({ name: 'Вкладка', iconUrl: null }), registrationPolicy: async () => 'invite' },
    '../setupRules.js': setupRules, '../superAdminRules.js': superRules,
    // Эта схема регистрируется, но /setup/admin не вызывается: тест не имитирует правила создания аккаунта.
    './auth.js': { registerBody: z.object({}) },
  });
  const module = { exports: {} as typeof import('./setup.js') };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `явный импорт ${id}`); return dependencies[id]; } });
  const app = Fastify();
  try {
    await app.register(module.exports.setupRoutes); await app.ready();
    const reply = await app.inject({ method: 'GET', url: '/instance' });
    assert.equal(reply.statusCode, 200, 'публичные сведения не требуют входа');
    const value = reply.json(); const ready = status === 'ready';
    assert.equal(value.fedName, ready ? name : null, 'публичная подпись федерации выдаётся только готовому инстансу');
    assert.equal(value.federation, ready); assert.equal(value.name, 'Вкладка');
    assert.equal(value.iconUrl, null); assert.equal(value.registration, 'invite');
    assert.equal(fedMetaCalls, ready ? 1 : 0, 'неработающая федерация не читает визитку');
  } finally { await app.close(); }
}
// Настроенное enabled не означает готовую федерацию: иначе key-error обещает соседям неработающие маршруты.
it('R210 GET instance отдаёт fedName готовой федерации и null без имени или при выключении и ошибке ключа', async () => {
  for (const status of ['ready', 'disabled', 'key-error', 'starting'])
    for (const name of ['Для соседей', null]) await instance(status, name);
});
// Удалённый gate не должен раскрывать подпись выключенной федерации и нарушать парный успешный ответ.
it('R210 снятие ready-проверки fedName обнаруживается настоящим ответом GET instance', async () => {
  await instance('disabled', 'Для соседей'); await instance('ready', 'Для соседей');
  const anchor = 'fed ? (await readInstanceMeta()).name : null'; assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(instance('disabled', 'Для соседей', source.replace(anchor, '(await readInstanceMeta()).name')),
    e => e instanceof assert.AssertionError && e.message.startsWith('публичная подпись федерации выдаётся только готовому инстансу')
      && e.operator === 'strictEqual' && e.actual === 'Для соседей' && e.expected === null);
});
