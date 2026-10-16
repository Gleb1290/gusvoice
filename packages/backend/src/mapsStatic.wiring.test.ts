import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as stream from 'node:stream';
import { isIP } from 'node:net';
import Fastify from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from './db/schema.js';
import * as rules from './mapsStaticRules.js';
import * as authRules from './authRules.js';
import * as pushRules from './pushRules.js';
import * as superAdminRules from './superAdminRules.js';
import * as threats from './linkThreatsRules.js';
import * as peers from './federation/devPeers.js';
import * as safeFetch from './safeFetch.js';

const read = (name: string) => readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load<T>(name: string, deps: Record<string, unknown>, globals: Record<string, unknown> = {}, raw = read(name)): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
    { module, exports: module.exports, URL, Buffer, AbortSignal, Response, console: { warn() {}, log() {} },
      require(id: string) { assert.equal(Object.hasOwn(deps, id), true, `явный импорт карты ${name}:${id}`); return deps[id]; }, ...globals });
  return module.exports as T;
}
const key = 'synthetic-yandex-test-key';
function environment(overrides: Record<string, string | undefined> = {}) {
  return load<typeof import('./env.js')>('env', { '@gusvoice/shared': shared, 'node:net': { isIP }, './linkThreatsRules.js': threats,
    './federation/devPeers.js': peers, './safeFetch.js': safeFetch }, { process: { env: {
      DATABASE_URL: 'postgres://fixture.invalid/test', JWT_SECRET: 'not-a-secret-used-only-in-map-tests', LIVEKIT_API_KEY: 'fixture',
      LIVEKIT_API_SECRET: 'not-a-secret-used-only-in-map-tests', LIVEKIT_URL_EXTERNAL: 'wss://fixture.invalid', ...overrides,
    } } }).env;
}
function features(value?: string, raw?: string) {
  return load<typeof import('./instanceFeatures.js')>('instanceFeatures', { '@gusvoice/shared': shared, './linkThreatsRules.js': threats },
    { process: { env: { YANDEX_MAPS_STATIC_KEY: value } } }, raw).INSTANCE_FEATURES.filter(feature => feature === 'yamap1').length;
}
it('R220 yamap1 объявляется ровно один раз только с непустым ключом, env обрезает пробелы', () => {
  for (const value of [undefined, '', ' \t ']) { assert.equal(features(value), 0); assert.equal(environment({ YANDEX_MAPS_STATIC_KEY: value }).yandexMapsStaticKey, ''); }
  for (const value of [key, ` ${key} `]) { assert.equal(features(value), 1); assert.equal(environment({ YANDEX_MAPS_STATIC_KEY: value }).yandexMapsStaticKey, key); }
});
it('R220 суточный потолок по умолчанию сто, явный ноль снимает лимит, некорректная конфигурация не снимает его', () => {
  assert.equal(environment().yandexMapsStaticDailyMax, 100);
  for (const raw of ['', ' ', 'trash', '-1', '1.5', '10000000']) assert.equal(environment({ YANDEX_MAPS_STATIC_DAILY_MAX: raw }).yandexMapsStaticDailyMax, 100);
  assert.equal(environment({ YANDEX_MAPS_STATIC_DAILY_MAX: '0' }).yandexMapsStaticDailyMax, 0);
  assert.equal(environment({ YANDEX_MAPS_STATIC_DAILY_MAX: ' 12 ' }).yandexMapsStaticDailyMax, 12);
});
type Options = { key?: string; daily?: number; blocked?: 'user' | 'day'; upstream?: () => Promise<Response>; raw?: string };
async function http(options: Options = {}) {
  const counts = new Map<string, number>(), windows = new Map<string, number>(), rateKeys: string[] = [], fetches: { url: string; options: RequestInit }[] = [];
  if (options.blocked === 'user') { counts.set('rl:maps:map-user', 90); windows.set('rl:maps:map-user', 60); }
  if (options.blocked === 'day') { counts.set('rl:maps:all', options.daily ?? 100); windows.set('rl:maps:all', 86400); }
  const env = environment({ YANDEX_MAPS_STATIC_KEY: options.key ?? key, YANDEX_MAPS_STATIC_DAILY_MAX: String(options.daily ?? 100) });
  const redis = { async incr(id: string) { rateKeys.push(id); const n = (counts.get(id) ?? 0) + 1; counts.set(id, n); return n; },
    async expire(id: string, seconds: number) { windows.set(id, seconds); }, async ttl(id: string) { return windows.get(id) ?? 60; } };
  const guard = load<typeof import('./authGuard.js')>('authGuard', { './authRules.js': authRules, '@gusvoice/shared': shared, './pushRules.js': pushRules,
    './instanceSetup.js': {}, './mailer.js': {}, './realtime.js': { redisPub: redis } });
  const auth = load<typeof import('./auth.js')>('auth', { bcryptjs: bcrypt, jsonwebtoken: jwt, 'drizzle-orm': orm,
    './authRules.js': authRules, './superAdminRules.js': superAdminRules, './env.js': { env }, './db/schema.js': schema,
    './db/index.js': { db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ gen: 0, deletedAt: null }] }) }) }) } } });
  const routes = load<typeof import('./routes/mapsStatic.js')>('routes/mapsStatic', { '@gusvoice/shared': shared, 'node:stream': stream,
    '../auth.js': auth, '../authGuard.js': guard, '../env.js': { env }, '../mapsStaticRules.js': rules }, {
    fetch: async (url: string, init: RequestInit) => { fetches.push({ url, options: init }); return argumentsForResponse(); },
  }, options.raw);
  function argumentsForResponse() { return options.upstream ? options.upstream() : Promise.resolve(new Response('fixture-map', { status: 200, headers: { 'content-type': 'image/png', 'content-length': '11' } })); }
  const app = Fastify(); await app.register(routes.mapsStaticRoutes); await app.ready();
  const token = auth.signToken({ sub: 'map-user', username: 'fixture', gen: 0 });
  const inject = (query = 'lat=10&lon=20&w=560&h=320&theme=dark', signed = true) => app.inject({ method: 'GET', url: `/maps/static?${query}`, headers: signed ? { authorization: `Bearer ${token}` } : {} });
  return { app, inject, fetches, rateKeys };
}
it('R220 настоящий preHandler требует вход, выключенная карта возвращает 404, плохой запрос 400 до Redis и fetch', async () => {
  for (const mode of ['auth', 'disabled', 'query'] as const) {
    const f = await http({ key: mode === 'disabled' ? '' : key });
    try {
      const response = await f.inject(mode === 'query' ? 'lat=91&lon=20&w=560&h=320' : undefined, mode !== 'auth');
      assert.equal(response.statusCode, mode === 'auth' ? 401 : mode === 'disabled' ? 404 : 400);
      assert.equal(f.fetches.length, 0); assert.deepEqual(f.rateKeys, []); assert.equal(response.body.includes(key), false);
    } finally { await f.app.close(); }
  }
});
it('R220 Redis-порог пользователя и суточный предел дают 429 с Retry-After, ноль не расходует суточный счётчик', async () => {
  for (const blocked of ['user', 'day'] as const) {
    const f = await http({ blocked });
    try { const response = await f.inject(); assert.equal(response.statusCode, 429); assert.equal(response.headers['retry-after'], blocked === 'user' ? '60' : '86400'); assert.equal(f.fetches.length, 0); }
    finally { await f.app.close(); }
  }
  const f = await http({ daily: 0 });
  try { assert.equal((await f.inject()).statusCode, 200); assert.deepEqual(f.rateKeys, ['rl:maps:map-user']); }
  finally { await f.app.close(); }
});
it('R220 HTML, upstream не 200, слишком большая длина и сеть превращаются в 502 без адреса с ключом', async () => {
  for (const upstream of [
    async () => new Response('<html>bad</html>', { headers: { 'content-type': 'text/html' } }),
    async () => new Response('bad', { status: 503, headers: { 'content-type': 'image/png' } }),
    async () => new Response('big', { headers: { 'content-type': 'image/png', 'content-length': String(2 * 1024 ** 2 + 1) } }),
    async () => { throw new Error('fixture transport error'); },
  ]) {
    const f = await http({ upstream });
    try { const response = await f.inject(); assert.equal(response.statusCode, 502); assert.deepEqual(response.json(), { error: 'map unavailable' }); assert.equal(response.body.includes(key), false); }
    finally { await f.app.close(); }
  }
});
it('R220 картинка проходит настоящим потоком с приватным кешем без ключа, fetch запрещает редиректы', async () => {
  const f = await http();
  try {
    const response = await f.inject(); assert.equal(response.statusCode, 200); assert.equal(response.body, 'fixture-map');
    assert.equal(response.headers['cache-control'], 'private, max-age=3600'); assert.equal(response.headers['content-type'], 'image/png'); assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(JSON.stringify(response.headers).includes(key), false); assert.equal(response.body.includes(key), false);
    assert.equal(new URL(f.fetches[0]!.url).searchParams.get('apikey'), key); assert.equal(f.fetches[0]!.options.redirect, 'error'); assert.ok(f.fetches[0]!.options.signal);
    assert.deepEqual(f.rateKeys, ['rl:maps:map-user', 'rl:maps:all']);
  } finally { await f.app.close(); }
});
it('R220 AST маршрут не подключает постоянные хранилища, index регистрирует его под env ключом', () => {
  const route = ts.createSourceFile('mapsStatic.ts', read('routes/mapsStatic'), ts.ScriptTarget.Latest, true);
  const imports = route.statements.filter(ts.isImportDeclaration).map(node => (node.moduleSpecifier as ts.StringLiteral).text);
  assert.equal(imports.some(id => /(?:^|\/)(?:storage|attachments|db)(?:\.|\/|$)/.test(id)), false);
  const index = ts.createSourceFile('index.ts', read('index'), ts.ScriptTarget.Latest, true); const gates: ts.IfStatement[] = [];
  function walk(node: ts.Node) { if (ts.isIfStatement(node) && node.expression.getText(index) === 'env.yandexMapsStaticKey') gates.push(node); ts.forEachChild(node, walk); }
  walk(index); assert.equal(gates.length, 1); const calls: ts.CallExpression[] = [];
  function collect(node: ts.Node) { if (ts.isCallExpression(node) && node.expression.getText(index) === 'api.register' && node.arguments[0]?.getText(index) === 'mapsStaticRoutes') calls.push(node); ts.forEachChild(node, collect); }
  collect(gates[0]!.thenStatement); assert.equal(calls.length, 1);
});
it('R220 контрфакт признак включается от одних пробелов в ключе', () => {
  const raw = read('instanceFeatures'), from = 'process.env.YANDEX_MAPS_STATIC_KEY?.trim()';
  assert.equal(features('   ', raw), 0); assert.equal(raw.split(from).length - 1, 1);
  assert.throws(() => assert.equal(features('   ', raw.replace(from, 'process.env.YANDEX_MAPS_STATIC_KEY')), 0, 'R220-yamap-key: пробелы не ключ'),
    e => e instanceof assert.AssertionError && e.message.startsWith('R220-yamap-key:') && e.operator === 'strictEqual' && e.actual === 1 && e.expected === 0);
});
