import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import * as zod from 'zod';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../db/schema.js';
import * as convRules from '../convRules.js';
import * as webhookRules from '../webhookRules.js';
import * as rules from './botRules.js';
import * as wire from './botWire.js';
import * as spec from './botSpec.js';
import * as openapi from './botOpenApi.js';

export const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
export const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export type Edit = { from: string; to: string };
export function edited(raw: string, edit?: Edit): string {
  if (!edit) return raw;
  assert.equal(raw.split(edit.from).length - 1, 1, 'R307 уникальный якорь мутанта');
  return raw.replace(edit.from, edit.to);
}
export function compile<T>(raw: string, deps: Record<string, unknown>, faults: string[] = []): T {
  const module = { exports: {} };
  const forbidden = (name: string) => (..._args: unknown[]): never => { faults.push(name); throw new Error(`R307 запрещён IO: ${name}`); };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, { module, exports: module.exports, Buffer, Date, Error, Map, Set, URL, URLSearchParams, AbortController,
    setTimeout: forbidden('setTimeout'), setInterval: forbidden('setInterval'),
    clearTimeout: forbidden('clearTimeout'), clearInterval: forbidden('clearInterval'),
    console: { warn: forbidden('console.warn'), error: forbidden('console.error') },
    require(id: string) {
      if (!Object.hasOwn(deps, id)) { faults.push(`import:${id}`); throw new Error(`R307 неописанный импорт ${id}`); }
      return deps[id];
    },
  });
  return module.exports as T;
}
export const loadWire = (edit?: Edit) => compile<typeof wire>(edited(source('./botWire.ts'), edit), {
  zod, '@gusvoice/shared': shared, '../convRules.js': convRules, '../webhookRules.js': webhookRules, './botRules.js': rules,
});
export const loadSpec = (edit?: Edit, w = wire) => compile<typeof spec>(edited(source('./botSpec.ts'), edit), { zod, './botWire.js': w });
export const loadOpenApi = (edit?: Edit, s = spec, w = wire) => compile<typeof openapi>(edited(source('./botOpenApi.ts'), edit), {
  zod, './botRules.js': rules, './botSpec.js': s, './botWire.js': w, '../webhookRules.js': webhookRules,
});
export function loadRoute(edit?: Edit) {
  let builds = 0;
  const mod = compile<typeof import('./botOpenApiRoute.js')>(edited(source('./botOpenApiRoute.ts'), edit), {
    'node:crypto': crypto, './botOpenApi.js': { buildBotOpenApi: () => { builds++; return openapi.buildBotOpenApi(); } },
  });
  return { mod, builds: () => builds };
}

/** Целиком настоящий botApi; база/Redis/доставка недоступны даже через проглоченный catch. */
export function loadApi(edit?: Edit) {
  const faults: string[] = [], rates: string[] = [], lookups: string[] = [], hooks: string[] = [];
  const forbidden = (name: string) => (..._args: unknown[]): never => { faults.push(name); throw new Error(`R307 запрещён IO: ${name}`); };
  const dormant = (name: string) => new Proxy({}, { get: (_target, key) => forbidden(`${name}.${String(key)}`) });
  const token = `gvb_${'A'.repeat(43)}`;
  const ctx = { bot: { userId: 'bot', disabledAt: null, description: '', about: '', public: true, droppedUpdateCount: 0 },
    user: { id: 'bot', username: 'examplebot', displayName: 'Пример', avatarUrl: null, bot: true } };
  const deps: Record<string, unknown> = {
    zod, 'drizzle-orm': orm, '../db/schema.js': schema, '../db/index.js': { db: dormant('db') },
    '../authGuard.js': { clientIp: () => '192.0.2.1', rateHit: async (key: string) => { rates.push(key); return 0; }, attachmentUploadBlock: forbidden('upload') },
    '../bots/botRules.js': rules, '../bots/botWire.js': wire,
    '../bots/botStore.js': new Proxy({
      botByToken: async (value: string) => { lookups.push(value); return value === token ? ctx : null; },
      readBotSettings: async () => ({ enabled: true, allowInternalWebhooks: false }),
    }, { get: (target, key) => Object.hasOwn(target, key) ? target[key as keyof typeof target] : forbidden(`store.${String(key)}`) }),
    '../conversations.js': { configureBotConv: () => { hooks.push('conv'); } },
    '../channelEvents.js': { configureChannelBots: () => { hooks.push('channel'); } },
    '../memberEvents.js': { configureMemberBots: () => { hooks.push('member'); } },
    // Ленивый import участвует в Promise.all: Proxy с произвольным then стал бы ложным thenable.
    '../bots/botChannel.js': { recordChannelBotUpdates: forbidden('recordChannelBotUpdates'), memberBotUpdates: forbidden('memberBotUpdates') },
  };
  for (const id of ['../attachmentRules.js', '../attachments.js', '../blocks.js', '../bots/botRead.js', '../bots/botUpdates.js',
    '../bots/webhookDelivery.js', '../convSendFanout.js', '../gateway.js', '../safeFetch.js', '../storage.js', '../webhookRules.js']) deps[id] = dormant(id);
  const api = compile<typeof import('../routes/botApi.js')>(edited(source('../routes/botApi.ts'), edit), deps, faults);
  return { api, token, rates, lookups, hooks, clean: () => assert.deepEqual(faults, [], 'R307 нет скрытого IO') };
}

export function assertion(marker: string, actual?: unknown, expected?: unknown) {
  return (error: unknown) => error instanceof assert.AssertionError && error.code === 'ERR_ASSERTION'
    && error.message.startsWith(marker) && (arguments.length < 2 || error.actual === actual)
    && (arguments.length < 3 || error.expected === expected);
}

/** Только строковые литералы уже существующих исторических образцов, без импорта файла с тестами. */
export function historical(): Record<string, unknown> {
  const raw = source('./botWire.test.ts');
  const file = ts.createSourceFile('botWire.test.ts', raw, ts.ScriptTarget.Latest, true);
  let value: ts.ObjectLiteralExpression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'frozen' && node.initializer) {
      const init = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      assert.ok(ts.isObjectLiteralExpression(init)); value = init;
    }
    ts.forEachChild(node, visit);
  }
  visit(file); assert.ok(value, 'исторические образцы найдены');
  return Object.fromEntries(value.properties.map(property => {
    assert.ok(ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer));
    return [property.name.getText(file), JSON.parse(property.initializer.text)];
  }));
}
