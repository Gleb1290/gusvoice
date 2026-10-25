import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as shared from '@gusvoice/shared';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { z } from 'zod';
import ts from 'typescript';
import * as searchRules from '../userSearchRules.js';
import * as seenRules from '../lastSeenRules.js';
import * as shopRules from '../shopRules.js';

const usersSource = readFileSync(new URL('./users.ts', import.meta.url), 'utf8');
type RemoteQuery = Parameters<typeof import('../federation/remoteUserSearch.js').searchRemoteUsers>[0];
type Exports = Record<string, unknown>;
const me = 'r291-local-searcher';
const localHits: shared.UserSearchHit[] = [
  { id: 'r291-bob', username: 'bob', displayName: 'Боб рядом', avatarUrl: '/local-bob.png' },
  { id: 'r291-bobby', username: 'bobby', displayName: 'Ещё один свой', avatarUrl: null },
];
const remoteHits: shared.RemoteUserHit[] = [{
  instanceId: 'r291-peer', homeUserId: 'r291-home-bob', username: 'bob',
  displayName: 'Боб у соседей', avatarUrl: '/cached-peer-bob.png',
  instance: { name: 'Соседи', domain: 'peers.example:8443' },
}];
const invalidQuery = { error: 'Введите логин: от 3 до 32 знаков, латиница, цифры и . _ -' };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function load(source: string, deps: Record<string, unknown>): Exports {
  const module: { exports: Exports } = { exports: {} };
  // Целый production-модуль, включая регистрацию ВСЕХ маршрутов. Ни реальное окружение,
  // ни env.ts, ни транзитивные DB/Redis/LiveKit/хранилище сюда попасть не могут.
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    module, exports: module.exports, process: { env: Object.freeze({}) },
    require: (id: string) => {
      assert.ok(Object.hasOwn(deps, id), `закрытый импорт R291 routes/users: ${id}`);
      return deps[id];
    },
  }, { filename: 'routes/users.ts' });
  return module.exports;
}

async function fixture(source: string) {
  const env = { federation: { dmEnabled: false } };
  const remoteQueries: RemoteQuery[] = [];
  const localQueries: Array<{ user: string; q: string }> = [];
  const rateCalls: unknown[][] = [];
  const unexpected: string[] = [];
  let authenticated = 0;
  let localGuards = 0;
  const dormant = (id: string): Exports => new Proxy({}, { get: (_target, key) => () => {
    const path = `${id}.${String(key)}`;
    unexpected.push(path);
    throw new Error(`неожиданная граница R291 ${path}`);
  } });
  // Замыкаем лишь внешние границы и неиспользуемые IO других обработчиков. Два правила
  // разбора (shared.parseRemoteHandle и normalizeUserQuery) исполняются настоящие.
  const deps: Record<string, unknown> = Object.fromEntries([
    '../activity.js', '../db/index.js', '../db/schema.js', '../gateway.js',
    '../federation/directoryEvents.js', '../permissions.js', '../realtime.js',
    '../serialize.js', '../lastSeen.js', '../callPrivacy.js', '../contacts.js', '../storage.js',
  ].map(id => [id, dormant(id)]));
  Object.assign(deps, {
    '@gusvoice/shared': shared, 'drizzle-orm': { eq }, zod: { z },
    '../env.js': { env }, '../userSearchRules.js': searchRules,
    '../lastSeenRules.js': seenRules, '../shopRules.js': shopRules,
    '../auth.js': { requireAuth: async (req: { user?: unknown }) => {
      authenticated++;
      req.user = { sub: me };
    } },
    '../guestGuard.js': { ...dormant('../guestGuard.js'), requireLocalUser: async (req: { user?: { sub: string } }) => {
      assert.equal(req.user?.sub, me, 'локальный preHandler получает авторизованного человека');
      localGuards++;
    } },
    '../authGuard.js': { ...dormant('../authGuard.js'), rateHit: async (...args: unknown[]) => {
      rateCalls.push(args);
      return 0;
    } },
    '../db/userSearch.js': { searchLocalUsers: async (user: string, q: string) => {
      localQueries.push({ user, q });
      return q === 'bob' ? localHits : [localHits[1]!];
    } },
    '../federation/remoteUserSearch.js': { searchRemoteUsers: async (query: RemoteQuery) => {
      remoteQueries.push(copy(query));
      const name = 'prefix' in query ? query.prefix : query.username;
      return name === 'bob' ? remoteHits : [];
    } },
  });
  const routes = load(source, deps);
  const app = Fastify();
  try {
    await (routes.userRoutes as (app: unknown) => Promise<void>)(app);
    await app.ready();
  } catch (error) { await app.close(); throw error; }
  let requests = 0;
  return {
    app, env, remoteQueries, localQueries, rateCalls,
    async request(q: string) {
      const reply = await app.inject({ method: 'GET', url: `/users/search?q=${encodeURIComponent(q)}` });
      requests++;
      assert.equal(authenticated, requests, 'каждый inject действительно проходит общий requireAuth');
      assert.equal(localGuards, requests, 'каждый inject действительно проходит requireLocalUser');
      assert.deepEqual(unexpected, [], 'нет скрытого вызова посторонней IO-границы');
      for (const args of rateCalls) assert.deepEqual(args, [
        `usearch:${me}`, searchRules.USER_SEARCH_RATE.max, searchRules.USER_SEARCH_RATE.windowS,
      ], 'применяется настоящий ключ и предел поиска, а не чужая квота');
      return reply;
    },
  };
}

// Адресный маркер HTTP-наблюдения: Node может дописать diff даже к явно заданному message.
// Контрфакт проверяет первую строку и actual/expected, не принимая ошибку VM/фикстуры.
function observed(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new assert.AssertionError({ actual, expected, message, operator: 'strictEqual' });
}
const handleMarker = 'R291 handle: включение runtime-флага даёт успешный удалённый поиск';
const prefixMarker = 'R291 prefix: включение runtime-флага вызывает удалённый поиск';

async function checkHandles(source = usersSource): Promise<void> {
  const f = await fixture(source);
  try {
    for (const enabled of [false, true, false]) {
      f.env.federation.dmEnabled = enabled;
      const remoteBefore = f.remoteQueries.length;
      const rateBefore = f.rateCalls.length;
      const reply = await f.request(' @BoB@Peers.Example:8443 ');
      if (enabled) {
        observed(reply.statusCode, 200, handleMarker);
        assert.deepEqual(f.remoteQueries.slice(remoteBefore), [{ username: 'bob', domain: 'peers.example:8443' }],
          'на границу приходит настоящий разобранный handle с нижним регистром и портом');
        assert.deepEqual(reply.json(), { users: [], remote: remoteHits }, 'явный адрес не смешивает локальных людей с соседями');
        assert.equal(f.rateCalls.length, rateBefore + 1);
        const empty = await f.request('@Nobody@Peers.Example:8443');
        assert.equal(empty.statusCode, 200, 'ненайденный человек не превращает успешный поиск в ошибку');
        assert.deepEqual(empty.json(), { users: [], remote: [] }, 'пустой remote остаётся массивом, не пропадает');
        assert.deepEqual(f.remoteQueries.at(-1), { username: 'nobody', domain: 'peers.example:8443' });
      } else {
        // При выключенном fedDm это обычная локальная валидация: вторая @ не является логином.
        assert.equal(reply.statusCode, 400, 'выключенный handle проверяется локальным правилом логина');
        assert.deepEqual(reply.json(), invalidQuery);
        assert.equal(Object.hasOwn(reply.json(), 'remote'), false);
        assert.equal(f.remoteQueries.length, remoteBefore, 'при false, в том числе после true, соседей не спрашивают');
        assert.equal(f.rateCalls.length, rateBefore, 'невалидный локальный логин не тратит квоту поиска');
      }
      assert.deepEqual(f.localQueries, [], 'явный адрес не отправляется в SQL локального поиска');
    }
  } finally { await f.app.close(); }
}

async function checkPrefixes(source = usersSource): Promise<void> {
  const f = await fixture(source);
  try {
    for (const enabled of [false, true, false]) {
      f.env.federation.dmEnabled = enabled;
      for (const q of ['bob', 'bobby']) {
        const localBefore = f.localQueries.length;
        const remoteBefore = f.remoteQueries.length;
        const rateBefore = f.rateCalls.length;
        const reply = await f.request(` @${q.toUpperCase()} `);
        assert.equal(reply.statusCode, 200, 'обычный поиск работает при каждом положении тумблера');
        assert.deepEqual(f.localQueries.slice(localBefore), [{ user: me, q }], 'локальный поиск получает caller и настоящий нормализованный логин');
        assert.equal(f.rateCalls.length, rateBefore + 1, 'один поиск, а не отдельная квота для каждой части ответа');
        const users = q === 'bob' ? localHits : [localHits[1]!];
        if (enabled) {
          observed(f.remoteQueries.length - remoteBefore, 1, prefixMarker);
          assert.deepEqual(f.remoteQueries.slice(remoteBefore), [{ prefix: q }], 'поиск по началу передаёт prefix, не handle');
          assert.deepEqual(reply.json(), { users, remote: q === 'bob' ? remoteHits : [] },
            'добавление remote, включая пустой, не теряет локальных людей и их поля');
        } else {
          assert.equal(f.remoteQueries.length, remoteBefore, 'false до и после включения не вызывает remote boundary');
          assert.deepEqual(reply.json(), { users }, 'локальная выдача сохраняется, поле remote отсутствует, а не равно []');
          assert.equal(Object.hasOwn(reply.json(), 'remote'), false);
        }
      }
    }
  } finally { await f.app.close(); }
}

function replaceOnce(source: string, from: string, to: string): string {
  assert.equal(source.split(from).length - 1, 1, `один адресный якорь R291: ${from}`);
  return source.replace(from, to);
}

function preciseFailure(message: string, actual: number, expected: number) {
  return (error: unknown): boolean => error instanceof assert.AssertionError
    && error.code === 'ERR_ASSERTION' && error.message.split(/\r?\n/, 1)[0] === message
    && error.operator === 'strictEqual'
    && error.actual === actual && error.expected === expected;
}

it('R291 явный адрес: один загруженный маршрут видит false → true → false и сохраняет пустую удалённую выдачу', async () => {
  await checkHandles();
});

it('R291 поиск по началу: текущий флаг добавляет и убирает remote, не теряя локальных людей даже при пустом remote', async () => {
  await checkPrefixes();
});

it('R291 контрфакт: process.env вместо общего runtime-флага ломает именно включённый поиск по явному адресу', async () => {
  await checkHandles();
  const mutant = `import { fedDmEnabledFromEnv } from '@gusvoice/shared';\n${replaceOnce(usersSource,
    'const fedDm = env.federation.dmEnabled;', 'const fedDm = fedDmEnabledFromEnv(process.env);')}`;
  await assert.rejects(() => checkHandles(mutant), preciseFailure(handleMarker, 400, 200));
});

it('R291 контрфакт: то же чтение пустого process.env отдельно ловится реальным prefix-поиском', async () => {
  await checkPrefixes();
  const mutant = `import { fedDmEnabledFromEnv } from '@gusvoice/shared';\n${replaceOnce(usersSource,
    'const fedDm = env.federation.dmEnabled;', 'const fedDm = fedDmEnabledFromEnv(process.env);')}`;
  await assert.rejects(() => checkPrefixes(mutant), preciseFailure(prefixMarker, 0, 1));
});

it('R291 контрфакт: кеширование общего флага при регистрации ломает оба пути после включения без restart', async () => {
  await checkHandles();
  await checkPrefixes();
  const cached = replaceOnce(usersSource,
    'export async function userRoutes(app: FastifyInstance): Promise<void> {',
    'export async function userRoutes(app: FastifyInstance): Promise<void> {\n  const cachedFedDm = env.federation.dmEnabled;');
  const mutant = replaceOnce(cached, 'const fedDm = env.federation.dmEnabled;', 'const fedDm = cachedFedDm;');
  await assert.rejects(() => checkHandles(mutant), preciseFailure(handleMarker, 400, 200));
  await assert.rejects(() => checkPrefixes(mutant), preciseFailure(prefixMarker, 0, 1));
});
