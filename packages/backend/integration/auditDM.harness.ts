import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as groupRules from '../src/groupRules.js';
import type { TestDb } from './harness.js';

export type AuditEdit = { file: string; from: string; to: string };
// Ручной список: новый импорт не разрешается автоматически по исходнику.
const imports: Record<string, readonly string[]> = {
  conversations: ['@gusvoice/shared', 'drizzle-orm', './convRules.js', './db/index.js', './db/schema.js', './dmWriteBarrier.js', './attachments.js', './env.js', './serialize.js', './util.js'],
  serialize: ['@gusvoice/shared', './auth.js', './superAdminRules.js', './env.js', './federation/instanceLabels.js', './statusRules.js', './shopRules.js', './callRules.js', './lastSeenRules.js', './linkThreats.js'],
  convGroups: ['drizzle-orm', './bigUploads.js', './conversations.js', './db/index.js', './db/schema.js', './groupRules.js', './util.js'],
  'routes/conv': ['@gusvoice/shared', 'drizzle-orm', 'zod', '../auth.js', '../authGuard.js', '../guestGuard.js', './att.js', '../stickerCatalog.js', '../blockRules.js', '../blocks.js', '../conversations.js', '../convSendFanout.js', '../dmReports.js', '../strangerRules.js', '../scheduled.js', '../scheduleRules.js', '../convRules.js', '../contacts.js', '../contactRules.js', '../db/index.js', '../realtime.js', './dmFolders.js', '../db/peerQueries.js', '../lastSeen.js', '../db/schema.js', '../dmRules.js', '../instanceSetup.js', '../userSearchRules.js', '../push.js', '../superAdminRules.js'],
  'routes/att': ['@gusvoice/shared', 'drizzle-orm', 'zod', '../attachmentRules.js', '../attachments.js', '../auth.js', '../authGuard.js', '../convRules.js', '../conversations.js', '../db/index.js', '../db/schema.js', '../storage.js'],
  'routes/convGroups': ['@gusvoice/shared', 'drizzle-orm', 'zod', '../auth.js', '../authGuard.js', '../blocks.js', '../convGroups.js', '../conversations.js', '../db/index.js', '../db/peerQueries.js', '../db/schema.js', '../dmRules.js', '../groupRules.js', '../guestGuard.js', '../instanceSetup.js', '../push.js', '../storage.js', '../superAdminRules.js', '../userSearchRules.js'],
};

export function auditModules(t: TestDb, edit?: AuditEdit) {
  let summaryReads = 0;
  const dialect = new PgDialect();
  // Наблюдение настоящего SQL на IO границе, без подмены запроса, результата или summariesFor.
  const db = new Proxy(t.db, { get(target, key) {
    if (key === 'execute') return (query: orm.SQL) => {
      if (dialect.sqlToQuery(query).sql.includes('AS conv_last_at')) summaryReads++;
      return target.execute(query);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const violations: string[] = [];
  function forbidden(name: string): never { violations.push(name); throw new Error(`R304 запрещённый IO: ${name}`); }
  function assertIo() { assert.deepEqual(violations, [], 'R304 неожиданный IO не спрятан catch приложения'); }
  const dormant = (name: string) => new Proxy({}, { get: (_target, key) => key === '__esModule' ? true : forbidden(`${name}.${String(key)}`) });
  function load<T>(file: string, values: Record<string, unknown>): T {
    let source = readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    if (edit?.file === file) {
      assert.equal(source.split(edit.from).length - 1, 1, `R304 единственный якорь ${file}`);
      source = source.replace(edit.from, edit.to);
    }
    const deps: Record<string, unknown> = {};
    for (const node of ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true).statements) {
      if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
      const id = (node.moduleSpecifier as ts.StringLiteral).text;
      assert.equal(imports[file]?.includes(id), true, `R304 закрытый импорт ${file}:${id}`);
      deps[id] = dormant(`${file}:${id}`);
    }
    Object.assign(deps, values);
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, Error,
      setTimeout: () => forbidden('таймер'), setInterval: () => forbidden('worker'), fetch: () => forbidden('fetch'),
      console: { log: () => forbidden('console.log'), warn: () => forbidden('console.warn'), error: () => forbidden('console.error') },
      require: (id: string) => { if (!Object.hasOwn(deps, id)) forbidden(`${file}:${id}`); return deps[id]; },
    });
    return module.exports as T;
  }
  const common = { '@gusvoice/shared': shared, 'drizzle-orm': orm };
  const serialize = load<typeof import('../src/serialize.js')>('serialize', { ...common,
    './env.js': { env: {} }, './linkThreats.js': { dangerousLinksOf: () => [] } });
  const events: { user: string; value: unknown }[] = [];
  const c = load<typeof import('../src/conversations.js')>('conversations', { ...common,
    './convRules.js': rules, './db/index.js': { db }, './db/schema.js': schema,
    './env.js': { env: {} }, './serialize.js': serialize, './util.js': { uuidv7: randomUUID },
    './dmWriteBarrier.js': { dmWriteBarrier: {} },
    './attachments.js': { attachmentLink: (id: string, viewer: string, gen: number) => `/fixture/${viewer}/${gen}/${id}` },
    './realtime.js': { publishToUser: async (user: string, value: unknown) => { events.push({ user, value }); } },
  });
  const groups = load<typeof import('../src/convGroups.js')>('convGroups', { ...common,
    './db/index.js': { db: t.db }, './db/schema.js': schema, './conversations.js': c,
    './groupRules.js': groupRules, './util.js': { uuidv7: randomUUID },
  });
  return { c, groups, load, common, events, forbidden, assertIo,
    summaryReads: () => summaryReads, resetSummaryReads() { summaryReads = 0; } };
}
