import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import { createTestDb, type TestDb } from './harness.js';

type Open = typeof import('../src/federation/convOpen.js');
type Mutation = readonly [string, string];
const self = 'a'.repeat(32), peer = 'b'.repeat(32);
const mine = '10000000-0000-4000-8000-000000000001';
const theirs = '20000000-0000-4000-8000-000000000001';
const profile = { username: 'dmtest_remote', displayName: 'Удалённый', avatarHash: null };
const dormantImports = new Set(['@gusvoice/shared', './dmWriteBarrier.js', './attachments.js', './auth.js', './superAdminRules.js',
  './statusRules.js', './shopRules.js', './callRules.js', './lastSeenRules.js', './instance.js', './linkRules.js', './instanceMeta.js',
  './peerAuth.js', './identityToken.js', './guardsRuntime.js', './instanceBan.js', './instanceSetup.js', './mailer.js']);
let unexpectedIo: string[] = [];
function moduleOf<T>(name: string, deps: Record<string, unknown>, mutation?: Mutation): T {
  let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation) {
    assert.equal(source.split(mutation[0]).length - 1, 1, 'единственный якорь мутанта');
    source = source.replace(...mutation);
  }
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const imports: Record<string, unknown> = {};
  for (const n of ast.statements) if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly) {
    const id = (n.moduleSpecifier as ts.StringLiteral).text;
    if (Object.hasOwn(deps, id)) { imports[id] = deps[id]; continue; }
    assert.equal(dormantImports.has(id), true, `закрытый перечень импортов ${name}: ${id}`);
    imports[id] = new Proxy({}, { get: (_t, key) => key === '__esModule' ? true : () => {
      unexpectedIo.push(`${id}.${String(key)}`); throw new Error(`запрещённая граница ${id}.${String(key)}`);
    } });
  }
  Object.assign(imports, deps);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL,
      require: (id: string) => { assert.equal(Object.hasOwn(imports, id), true, `явный импорт ${id}`); return imports[id]; } });
  return module.exports as T;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture(options: { policy?: 'shared' | 'anyone'; post?: (arg: any) => Promise<any>; mutation?: Mutation; holdRate?: boolean; refresh?: (link: unknown, now: number) => Promise<string[]> } = {}) {
  unexpectedIo = [];
  const t = await createTestDb();
  await t.raw.exec("INSERT INTO users(id,username,display_name,password_hash,verified,approved_at) VALUES ('local','dmtest_local','Локальный','hash',true,now()),('other','dmtest_other','Другой','hash',true,now())");
  await t.raw.query(`INSERT INTO federation_links(instance_id,domain,api_base,client_origin,root_key,state,features)
    VALUES ($1,'peer.invalid','https://peer.invalid/api','https://peer.invalid','fixture-root','active',$2::jsonb)`, [peer, JSON.stringify([shared.FED_FEATURES.dm1])]);
  const savedLink = (await t.db.select().from(schema.federationLinks))[0]!;
  assert.equal(savedLink.state, 'active');
  const link = { ...savedLink, state: 'active' as const };
  const getLink = async (id: string) => (await t.db.select().from(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, id)))[0] ?? null;
  const guest = moduleOf<typeof import('../src/federation/guestHost.js')>('federation/guestHost', {
    'node:crypto': { randomUUID }, '@gusvoice/shared': shared, 'drizzle-orm': orm,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../auth.js': { hashPassword: async () => 'unusable-test-hash' },
    '../authRules.js': await import('../src/authRules.js'), './guestRules.js': await import('../src/federation/guestRules.js'),
    './links.js': { getLink }, './avatars.js': { refreshGuestAvatar: async () => {} },
  });
  const serialize = moduleOf<typeof import('../src/serialize.js')>('serialize', {
    '@gusvoice/shared': shared, './env.js': { env: {} }, './linkThreats.js': { dangerousLinksOf: () => [] },
    './federation/instanceLabels.js': { instanceLabel: (id: string) => ({ instanceId: id, name: 'Тестовый сосед', domain: 'peer.invalid', reports: false }) },
  });
  const changes = moduleOf<typeof import('../src/federation/convChanges.js')>('federation/convChanges', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
  });
  const conversations = moduleOf<typeof import('../src/conversations.js')>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './convRules.js': rules, './db/index.js': { db: t.db },
    './db/schema.js': schema, './util.js': { uuidv7: randomUUID }, './env.js': { env: {} }, './serialize.js': serialize,
  });
  conversations.configureFederatedConv({ selfInstanceId: () => self, record: changes.recordFedConvChanges });
  const counters = new Map<string, number>(), expiries = new Map<string, number>();
  const entered = deferred<void>(), release = deferred<void>();
  let hits = 0;
  const auth = moduleOf<typeof import('../src/authGuard.js')>('authGuard', {
    '@gusvoice/shared': shared, './authRules.js': await import('../src/authRules.js'), './pushRules.js': await import('../src/pushRules.js'),
    './realtime.js': { redisPub: {
      incr: async (key: string) => {
        const count = (counters.get(key) ?? 0) + 1; counters.set(key, count); hits++;
        if (options.holdRate && hits === 1) { entered.resolve(); await release.promise; }
        return count;
      },
      expire: async (key: string, seconds: number) => { expiries.set(key, seconds); return 1; },
      ttl: async (key: string) => expiries.get(key) ?? -1,
    } },
  });
  const peers = moduleOf<typeof import('../src/db/peerQueries.js')>('db/peerQueries', { 'drizzle-orm': orm, './index.js': { db: t.db } });
  const blocks = moduleOf<typeof import('../src/blocks.js')>('blocks', {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
  });
  const requests: any[] = [];
  const refreshes: { link: unknown; now: number; opts?: { force?: boolean } }[] = [];
  const secondTargetRead = deferred<void>();
  let targetReads = 0, pairReads = 0;
  // Наблюдаем реальные builders только convOpen: результат каждой SQL-выдачи сохраняется без изменения.
  const openDb = new Proxy(t.db, { get(db, key) {
    if (key !== 'select') { const value = Reflect.get(db, key); return typeof value === 'function' ? value.bind(db) : value; }
    return (...args: unknown[]) => {
      const select = (db.select as (...a: unknown[]) => any).apply(db, args);
      return new Proxy(select, { get(builder, member) {
        if (member !== 'from') { const value = Reflect.get(builder, member); return typeof value === 'function' ? value.bind(builder) : value; }
        return (table: unknown) => {
          if (table === schema.conversations) pairReads++;
          const from = builder.from(table);
          if (table !== schema.users) return from;
          return new Proxy(from, { get(query, prop) {
            if (prop !== 'where') { const value = Reflect.get(query, prop); return typeof value === 'function' ? value.bind(query) : value; }
            return (condition: unknown) => {
              const where = query.where(condition);
              return new Proxy(where, { get(filtered, final) {
                if (final !== 'limit') { const value = Reflect.get(filtered, final); return typeof value === 'function' ? value.bind(filtered) : value; }
                return async (limit: number) => {
                  const rows = await filtered.limit(limit);
                  if (++targetReads === 2) secondTargetRead.resolve();
                  return rows;
                };
              } });
            };
          } });
        };
      } });
    };
  } });
  const open = moduleOf<Open>('federation/convOpen', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../authGuard.js': auth, '../blocks.js': blocks,
    '../conversations.js': { ...conversations, deliver: async () => {} }, '../db/index.js': { db: openDb }, '../db/schema.js': schema,
    '../db/peerQueries.js': peers, '../dmRules.js': await import('../src/dmRules.js'),
    '../instanceSetup.js': { fedDmPolicy: async () => options.policy ?? 'shared' },
    '../userSearchRules.js': await import('../src/userSearchRules.js'), '../util.js': { uuidv7: () => mine },
    './directorySync.js': { refreshCapabilities: (saved: unknown, now: number, opts?: { force?: boolean }) => {
      refreshes.push({ link: saved, now, opts }); return options.refresh ? options.refresh(saved, now) : Promise.resolve(link.features);
    } }, './guestHost.js': guest,
    './instance.js': { federation: { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'fixture', privateKeyDer: new Uint8Array([1]) }) } },
    './links.js': { getLink }, './peerClient.js': { postSignedToPeer: async (arg: any) => {
      requests.push(arg); return options.post ? options.post(arg) : response('ok');
    } },
  }, options.mutation);
  return { t, link, guest, open, conversations, requests, refreshes, counters, expiries, entered, release, secondTargetRead, pairReads: () => pairReads, hits: () => hits };
}
function response(kind: 'ok' | 'exists', id = theirs) {
  return { ok: true, value: { status: 200, body: JSON.stringify(shared.serializeConvOpenResponse({ kind, conversationId: id, to: profile })) } };
}
function request(toUserId = 'local', conversationId = theirs, sharedServerIds: string[] = []) {
  return shared.serializeConvOpenRequest({ instanceId: peer, from: { userId: 'remote', ...profile }, toUserId, conversationId, sharedServerIds, createdAt: 1 });
}
async function count(t: TestDb) { return (await t.db.select().from(schema.conversations)).length; }

test('R189 shared не верит чужому списку серверов, принимает только активное пересечение собственного индекса', async () => {
  // Класс ошибки доверия: сосед не может объявить произвольного получателя общим участником.
  const f = await fixture();
  try {
    assert.equal((await f.open.acceptConvOpen(f.link, request())).body.reason, 'policy');
    await f.t.raw.query("INSERT INTO federation_memberships(instance_id,user_id,server_id,state,updated_at) VALUES ($1,'local','verified','active',1),($1,'local','inactive','removed',1)", [peer]);
    for (const ids of [['invented'], ['inactive']]) assert.equal((await f.open.acceptConvOpen(f.link, request('local', theirs, ids))).body.reason, 'policy');
    assert.equal(await count(f.t), 0);
    const accepted = await f.open.acceptConvOpen(f.link, request('local', theirs, ['verified']));
    assert.equal(accepted.status, 200); assert.equal(accepted.body.ok, true); assert.equal(await count(f.t), 1);
    assert.equal(f.hits(), 0);
  } finally { await f.t.close(); }
});
test('R189 anyone принимает десять новых пар, одиннадцатую отклоняет на часовом счётчике authGuard', async () => {
  // Класс ошибки границы: десятый запрос допустим, следующий не должен создавать SQL-строку.
  const f = await fixture({ policy: 'anyone' });
  try {
    for (let i = 1; i <= 11; i++) {
      await f.t.raw.query('INSERT INTO users(id,username,display_name,password_hash,verified,approved_at) VALUES ($1,$2,$2,\'hash\',true,now())', [`recipient${i}`, `dmtest_${i}`]);
      const answer = await f.open.acceptConvOpen(f.link, request(`recipient${i}`, `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
      assert.equal(answer.status, i <= 10 ? 200 : 403); assert.equal(i <= 10 ? answer.body.ok : answer.body.reason, i <= 10 ? true : 'rate');
    }
    assert.equal(await count(f.t), 10); assert.equal(f.counters.get(`rl:fed-dm-in:${peer}:remote`), 11);
    assert.equal(f.expiries.get(`rl:fed-dm-in:${peer}:remote`), 3600);
  } finally { await f.t.close(); }
});
test('R189 скрытый получатель отклоняется, видимый принимается, повтор возвращает exists и сохраняет pending получателя', async () => {
  // Класс ошибки видимости: пустая входящая беседа не появляется у получателя до первого сообщения.
  const f = await fixture({ policy: 'anyone' });
  try {
    await f.t.raw.exec("UPDATE users SET hidden_from_peers=true WHERE id='local'");
    assert.equal((await f.open.acceptConvOpen(f.link, request())).body.reason, 'hidden'); assert.equal(await count(f.t), 0);
    await f.t.raw.exec("UPDATE users SET hidden_from_peers=false WHERE id='local'");
    assert.equal((await f.open.acceptConvOpen(f.link, request())).body.ok, true);
    assert.equal((await f.open.acceptConvOpen(f.link, request('local', mine))).body.exists, theirs);
    assert.equal(await count(f.t), 1); assert.equal(f.hits(), 1);
    const members = await f.t.db.select().from(schema.conversationMembers);
    assert.equal(members.find(m => m.userId === 'local')?.pending, true);
    assert.equal(members.find(m => m.userId !== 'local')?.pending, false);
    assert.equal((await f.t.db.select().from(schema.userChanges)).every(c => c.userId !== 'local'), true);
  } finally { await f.t.close(); }
});
test('R189 занятый id другой пары даёт 409, свободный id создаёт беседу без изменения чужой', async () => {
  // Класс ошибки идентичности: присланный id не является правом перезаписать другую беседу.
  const f = await fixture({ policy: 'anyone' });
  try {
    const old = await f.conversations.createDirect('local', 'other'); assert.equal(!!old, true);
    const denied = await f.open.acceptConvOpen(f.link, request('local', old!.row.id));
    assert.equal(denied.status, 409); assert.equal(denied.body.error, 'conversation-id-taken'); assert.equal(await count(f.t), 1);
    assert.equal((await f.open.acceptConvOpen(f.link, request())).body.ok, true); assert.equal(await count(f.t), 2);
  } finally { await f.t.close(); }
});
for (const kind of ['ok', 'exists'] as const) test(`R189 ответ ${kind} создаёт беседу с id соседа и профиль to без каталога`, async () => {
  // Класс ошибки проводки: локальный случайный id или потерянный профиль раскалывают пару между домами.
  const f = await fixture({ post: async () => response(kind) });
  try {
    const answer = await f.open.openFederatedDirect('local', { instanceId: peer, homeUserId: 'remote' });
    assert.equal(answer.ok, true, 'профиль to открывает беседу без кеша');
    assert.equal(answer.ok && answer.conversationId, theirs);
    const row = (await f.t.db.select().from(schema.conversations))[0];
    assert.equal(row.id, theirs); assert.equal(row.originInstanceId, kind === 'ok' ? self : peer);
    const shadow = await f.guest.shadowUserFor(peer, 'remote'); assert.equal(shadow?.homeUsername, profile.username); assert.equal(shadow?.displayName, profile.displayName);
    assert.equal(f.requests[0].path, '/api/fed/v1/conv/open'); assert.equal(f.requests[0].payload.to_user_id, 'remote');
    assert.equal(f.requests[0].payload.conversation_id, mine);
    assert.equal((await f.t.db.select().from(schema.fedConvChanges)).length, 1);
  } finally { await f.t.close(); }
});
for (const status of [null, 500, 503, 404] as const) test(`R189 отказ соседа ${status ?? 'без ответа'} не создаёт беседу и возвращает адресную ошибку`, async () => {
  // Класс ошибки отказоустойчивости: неответивший дом не должен оставлять фиктивную локальную переписку.
  const f = await fixture({ post: async () => status === null ? { ok: false } : { ok: true, value: { status, body: '{}' } } });
  try {
    const answer = await f.open.openFederatedDirect('local', { instanceId: peer, homeUserId: 'remote' });
    assert.equal(answer.ok, false);
    assert.equal(!answer.ok && answer.status, status === 404 ? 409 : 503);
    assert.equal(!answer.ok && answer.body.error, status === 404 ? shared.FED_ERRORS.unsupported : shared.FED_ERRORS.peerUnreachable);
    assert.equal(await count(f.t), 0); assert.equal(await f.guest.shadowUserFor(peer, 'remote'), null);
  } finally { await f.t.close(); }
});
test('R189 встречный запрос с большим id получает меньший inFlight id, после ответа создаётся одна беседа', async () => {
  // Класс ошибки встречной гонки: запрос в полёте уже выбирает общий id, не ждёт SQL-вставки.
  const called = deferred<void>(), reply = deferred<any>();
  const f = await fixture({ post: async () => { called.resolve(); return reply.promise; } });
  let work: Promise<unknown> | undefined;
  try {
    work = f.open.openFederatedDirect('local', { instanceId: peer, homeUserId: 'remote' });
    await called.promise;
    const incoming = await f.open.acceptConvOpen(f.link, request());
    assert.equal(incoming.body.exists, mine); assert.equal(await count(f.t), 0);
    reply.resolve(response('ok', mine));
    const answer = await work as Awaited<ReturnType<Open['openFederatedDirect']>>;
    assert.equal(answer.ok && answer.conversationId, mine); assert.equal(await count(f.t), 1);
  } finally { reply.resolve(response('ok', mine)); if (work) await work; await f.t.close(); }
});
async function profileScenario(mutation?: Mutation) {
  const f = await fixture({ mutation });
  try {
    const result = await f.open.openFederatedDirect('local', { instanceId: peer, homeUserId: 'remote' });
    assert.equal(result.ok, true, 'профиль to открывает беседу без кеша');
    assert.equal(await count(f.t), 1);
  } finally { await f.t.close(); }
}
test('R189 потеря to обнаруживается при настоящем создании теневого без профиля в кеше', async () => {
  // Класс ошибки совместимости: успешный ответ соседа обязан передать профиль в ensureShadowUser.
  await profileScenario();
  await assert.rejects(profileScenario(['answer.to ?? null', 'null']), e => e instanceof assert.AssertionError && e.message.includes('профиль to открывает'));
});
async function lockScenario(mutation?: Mutation) {
  const f = await fixture({ policy: 'anyone', holdRate: true, mutation });
  let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
  try {
    first = f.open.acceptConvOpen(f.link, request()); await f.entered.promise;
    second = f.open.acceptConvOpen(f.link, request('local', mine));
    await f.secondTargetRead.promise;
    // После единственного await target SQL до входа fn нет IO: только продолжение accept и prev.catch().then(fn).
    // Восемь microtask turns покрывают эти Promise-продолжения, не скорость PGlite или произвольный sleep.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const readsWhileFirstHeld = f.pairReads();
    f.release.resolve();
    const answers = await Promise.all([first, second]) as Array<{ status: number; body: Record<string, unknown> }>;
    assert.equal(answers.every(a => a.status === 200), true);
    assert.equal(await count(f.t), 1);
    assert.equal(readsWhileFirstHeld, 1, 'замок пары не запускает второе чтение до завершения первого');
    assert.equal(f.hits(), 1, 'замок пары тратит лимит лишь один раз');
    assert.equal(answers.filter(a => a.body.ok === true).length, 1);
    assert.equal(answers.filter(a => typeof a.body.exists === 'string').length, 1);
  } finally { f.release.resolve(); await Promise.allSettled([first, second].filter((p): p is Promise<unknown> => !!p)); await f.t.close(); }
}
test('R189 одновременные входящие запросы одной пары сериализуются и тратят лимит один раз', async () => {
  // Класс ошибки гонки: UNIQUE не заменяет замок политики и счётчика перед записью.
  await lockScenario();
});
test('R189 удаление замка пары запускает второе чтение до завершения первого запроса', async () => {
  // Класс ошибки гонки: мутант исполняется целым модулем и падает адресным AssertionError, не SQL/TypeError.
  await lockScenario();
  await assert.rejects(lockScenario(['const prev = pairLocks.get(key) ?? Promise.resolve();', 'const prev = Promise.resolve();']),
    e => e instanceof assert.AssertionError && e.message.includes('замок пары не запускает второе чтение'));
});

async function acceptRefreshScenario(mutation?: Mutation) {
  const refresh = deferred<string[]>();
  const f = await fixture({ mutation, refresh: () => refresh.promise });
  let work: ReturnType<Open['acceptConvOpen']> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const oldLink = { ...f.link, features: [shared.FED_FEATURES.directory] };
    work = f.open.acceptConvOpen(oldLink, request('missing'));
    const response = await Promise.race([work, new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new assert.AssertionError({ message: 'conv.open не ждёт ответа фонового refresh', actual: 'wait', expected: 'background' })), 5000);
    })]);
    assert.equal(response.status, 403); assert.equal(response.body.reason, 'no_user');
    assert.equal(f.refreshes.length, 1, 'входящий conv.open обновляет возможности связки без dm1');
    assert.equal(f.refreshes[0].link, oldLink); assert.ok(Number.isFinite(f.refreshes[0].now));
    assert.equal(f.refreshes[0].opts?.force, true, 'входящее открытие просит принудительную сверку capabilities');
    assert.equal(await count(f.t), 0);
    refresh.resolve([shared.FED_FEATURES.directory, shared.FED_FEATURES.dm1]);
    await f.open.acceptConvOpen(f.link, request('missing'));
    assert.equal(f.refreshes.length, 1, 'свежая связка с dm1 не требует фонового чтения');
  } finally { if (deadline) clearTimeout(deadline); refresh.resolve([]); if (work) await work; await f.t.close(); }
}
test('R197 входящий conv.open без dm1 обновляет визитку в фоне и не ждёт её ответа', async () => {
  // Незавершённый fake transport не мешает SQL-решению no_user: обновление возможностей — только подсказка.
  await acceptRefreshScenario();
});
test('R197 удалённое фоновое обновление conv.open поймано точным счётчиком capabilities', async () => {
  await acceptRefreshScenario();
  await assert.rejects(acceptRefreshScenario(['void refreshCapabilities(link, Date.now(), { force: true }).catch(() => {});', 'void Promise.resolve();']),
    e => e instanceof assert.AssertionError && e.message.includes('входящий conv.open обновляет возможности'));
});
test('R197 ошибка фонового обновления не превращает корректный conv.open в отказ сервера', async () => {
  for (const fail of ['throw', 'reject'] as const) {
    const f = await fixture({ policy: 'anyone', refresh: () => {
      if (fail === 'throw') throw new Error('fixture-capabilities-unavailable');
      return Promise.reject(new Error('fixture-capabilities-unavailable'));
    } });
    try {
      const accepted = await f.open.acceptConvOpen({ ...f.link, features: [] }, request());
      assert.equal(accepted.status, 200); assert.equal(accepted.body.ok, true); assert.equal(await count(f.t), 1);
      assert.equal(f.refreshes.length, 1);
    } finally { await f.t.close(); }
  }
});

function expectOpened(calls: string[][]) {
  assert.equal(calls.length, 1, 'R235-open-hook: один новый разговор уведомляет присутствие ровно один раз');
  assert.deepEqual(calls, [['local', peer]], 'крючок получает местного человека и дом его собеседника, не тень или свой дом');
  assert.deepEqual(unexpectedIo, [], 'неожиданный IO не спрятан обработчиком фонового отказа');
}
async function outgoingHook(mutation?: Mutation) {
  // Удалённый exists тоже может означать первое создание НАШЕЙ копии; локальный known — уже не создание.
  for (const answer of ['ok', 'exists'] as const) {
    const f = await fixture({ policy: 'anyone', post: async () => response(answer), mutation });
    const calls: string[][] = []; f.open.configureFedConvOpened((...args) => calls.push(args));
    try {
      const first = await f.open.openFederatedDirect('local', { instanceId: peer, homeUserId: 'remote' });
      assert.equal(first.ok && first.created, true); expectOpened(calls);
      const again = await f.open.openFederatedDirect('local', { instanceId: peer, homeUserId: 'remote' });
      assert.equal(again.ok && again.created, false); expectOpened(calls);
      assert.equal(f.requests.length, 1); assert.equal(await count(f.t), 1);
    } finally { await f.t.close(); }
  }
}
test('R235 создание исходящей копии вызывает присутствие один раз, локальный known не повторяет его', () => outgoingHook());
async function incomingHook(mutation?: Mutation) {
  // Повторная доставка conv.open не должна бесконечно переставлять двухсекундный presence.
  const f = await fixture({ policy: 'anyone', mutation }), calls: string[][] = [];
  f.open.configureFedConvOpened((...args) => calls.push(args));
  try {
    assert.equal((await f.open.acceptConvOpen(f.link, request())).body.ok, true); expectOpened(calls);
    assert.equal((await f.open.acceptConvOpen(f.link, request('local', mine))).body.exists, theirs); expectOpened(calls);
    f.open.configureFedConvOpened(null);
    assert.equal((await f.open.acceptConvOpen(f.link, request('other', mine))).body.ok, true); expectOpened(calls);
    assert.equal(await count(f.t), 2);
  } finally { await f.t.close(); }
}
test('R235 входящее создание вызывает крючок для получателя, exists и отключённый крючок не повторяют его', () => incomingHook());
async function rowHook(mutation?: Mutation) {
  // Потерянный ответ на conv.open восстанавливает пару из строки журнала и должен немедленно оживить её присутствие.
  const f = await fixture({ policy: 'anyone', mutation }), calls: string[][] = [];
  f.open.configureFedConvOpened((...args) => calls.push(args));
  const wire = (id: string) => shared.serializeConvWire({ id, kind: 'direct', originInstanceId: peer, createdAt: 1, title: null,
    members: [{ instanceId: self, userId: 'local' }, { instanceId: peer, userId: 'remote' }] });
  try {
    assert.ok(await f.guest.ensureShadowUser(peer, 'remote', profile), 'профиль отправителя заранее получен из каталога соседа');
    assert.equal(await f.open.acceptConvRow(peer, self, theirs, wire(theirs)), true); expectOpened(calls);
    assert.equal(await f.open.acceptConvRow(peer, self, theirs, wire(theirs)), true); expectOpened(calls);
    assert.equal(await f.open.acceptConvRow(peer, self, mine, wire(mine)), false); expectOpened(calls);
    assert.equal(await count(f.t), 1);
  } finally { await f.t.close(); }
}
test('R235 создание из conv-строки уведомляет присутствие, повтор или уже известная пара — нет', () => rowHook());
test('R235 встречный conv.open выигрывает до замка исходящего: raced не повторяет крючок создания', async () => {
  // Настоящая гонка двух публичных операций: первая остановлена на IO rateHit, SQL не подделывается.
  const f = await fixture({ policy: 'anyone', holdRate: true }), calls: string[][] = [];
  f.open.configureFedConvOpened((...args) => calls.push(args));
  const work = f.open.openFederatedDirect('local', { instanceId: peer, homeUserId: 'remote' });
  try {
    await f.entered.promise;
    assert.equal((await f.open.acceptConvOpen(f.link, request())).body.ok, true); expectOpened(calls);
    f.release.resolve(); const result = await work;
    assert.equal(result.ok && result.created, false); assert.equal(result.ok && result.conversationId, theirs); expectOpened(calls);
    assert.equal(f.requests.length, 0); assert.equal(await count(f.t), 1);
  } finally { f.release.resolve(); await work; await f.t.close(); }
});
for (const [label, from, check] of [
  ['исходящий путь', 'convOpened?.(me, target.instanceId);', outgoingHook],
  ['входящий путь', 'convOpened?.(target!.id, link.instanceId);', incomingHook],
  ['восстановление из строки', 'convOpened?.(target.id, peer);', rowHook],
] as const) test(`R235 контрфакт convOpened: забыто уведомление в ${label}`, async () => {
  await check();
  await assert.rejects(() => check([from, '']), e => e instanceof assert.AssertionError && e.message.startsWith('R235-open-hook:')
    && e.operator === 'strictEqual' && e.actual === 0 && e.expected === 1);
});
