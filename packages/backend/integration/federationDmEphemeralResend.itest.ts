import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, beforeEach, test } from 'node:test';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as lastSeenRules from '../src/lastSeenRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
beforeEach(async () => { await truncateAll(t.raw); });
after(async () => { await t.close(); });

type Mutation = readonly [string, string];
type Ephemeral = typeof import('../src/federation/dmEphemeral.js') & {
  testFlushPresence(user: string, alive: boolean, opts?: { onlyHome?: string; fromDb?: boolean }): Promise<void>;
};
type User = typeof schema.users.$inferInsert;
type Conversation = typeof schema.conversations.$inferInsert;
type Member = typeof schema.conversationMembers.$inferInsert;
interface WireView {
  user: { instance_id: string; user_id: string };
  last_seen: number | null;
  approx?: shared.LastSeenApprox;
}
interface PresenceBody {
  instance_id: string;
  kind: 'presence';
  user: { instance_id: string; user_id: string };
  online: boolean;
  at: number;
  views: WireView[];
}
interface Request {
  apiBase: string;
  path: string;
  payload: PresenceBody;
  allowHosts: Set<string>;
  now: number;
}
const SELF = 'a'.repeat(32), PEER = 'b'.repeat(32), OTHER = 'c'.repeat(32), ALIEN = 'd'.repeat(32);
const NOW = 2_000_000_000_000, SEEN = NOW - 600_000;

function moduleOf<T>(name: string, deps: Record<string, unknown>, globals: Record<string, unknown> = {}, mutations: readonly Mutation[] = [], expose = ''): T {
  let code = readFileSync(new URL('../src/' + name + '.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  for (const [from, to] of mutations) {
    assert.equal(code.split(from).length, 2, 'единственный якорь ' + from);
    code = code.replace(from, to);
  }
  // Загружается ВЕСЬ модуль. Добавляем только ссылку на настоящую private-функцию, не исполняемые вырезки.
  code += expose;
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    module, exports: module.exports, Date, URL, Buffer, ...globals,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), 'явный импорт ' + id); return deps[id]; },
  });
  return module.exports as T;
}

function local(id: string, extra: Partial<User> = {}): User {
  return { id, username: 'resend_' + id, displayName: id, passwordHash: 'fixture',
    verified: true, approvedAt: new Date(NOW), lastSeenAt: new Date(SEEN),
    lastSeenPrivacy: 'everyone', presenceStatus: 'invisible', ...extra };
}
function shadow(id: string, home = PEER): User {
  return { id, username: 'resend_' + id, displayName: id, passwordHash: 'fixture',
    homeInstanceId: home, homeUserId: 'home-' + id };
}
async function addUsers(rows: User[]) {
  for (let offset = 0; offset < rows.length; offset += 100) {
    await t.db.insert(schema.users).values(rows.slice(offset, offset + 100));
  }
}
async function addConversations(rows: { id: string; users: string[]; kind?: 'direct' | 'group' }[]) {
  const conversations: Conversation[] = rows.map(r => ({ id: r.id, kind: r.kind ?? 'direct',
    createdBy: r.users[0], directKey: r.kind === 'group' ? null : [...r.users].sort().join(':') }));
  const members: Member[] = rows.flatMap(r => r.users.map(userId => ({ conversationId: r.id, userId })));
  for (let offset = 0; offset < conversations.length; offset += 100) {
    await t.db.insert(schema.conversations).values(conversations.slice(offset, offset + 100));
  }
  for (let offset = 0; offset < members.length; offset += 200) {
    await t.db.insert(schema.conversationMembers).values(members.slice(offset, offset + 200));
  }
}

async function fixture(mutations: readonly Mutation[] = [], seedBase = true) {
  if (seedBase) {
    await addUsers([local('local'), shadow('shadow')]);
    await addConversations([{ id: 'base', users: ['local', 'shadow'] }]);
  }
  await t.db.insert(schema.federationLinks).values([
    { instanceId: PEER, domain: 'peer.invalid', apiBase: 'https://peer.invalid/api',
      clientOrigin: 'https://peer.invalid', rootKey: 'fixture', state: 'active', features: ['dm1', 'dm3'] },
    { instanceId: OTHER, domain: 'other.invalid', apiBase: 'https://other.invalid/api',
      clientOrigin: 'https://other.invalid', rootKey: 'fixture', state: 'active', features: ['dm1', 'dm3'] },
  ]);
  const blocks = moduleOf<typeof import('../src/blocks.js')>('blocks', {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
  });
  const online = new Set<string>(), requests: Request[] = [], selectedUsers: string[][] = [];
  const timeouts = new Map<object, { fn: () => void; ms: number }>();
  const intervals: { fn: () => void; ms: number }[] = [];
  const reads: Promise<unknown>[] = [];
  let now = NOW;
  class ClockDate extends Date {
    constructor(value?: number | string) { super(value ?? now); }
    static now() { return now; }
  }
  const ioFailures: string[] = [];
  const unexpected = (boundary: string) => { ioFailures.push(boundary); throw new Error('resend не должен вызывать ' + boundary); };
  const observedDb = {
    // Прозрачное наблюдение: настоящие SQL и строки Drizzle/PGlite, ни SELECT, ни LIMIT не подделываются.
    async execute(query: Parameters<typeof t.db.execute>[0]) {
      const result = await t.db.execute(query);
      if (result.fields.some(field => field.name === 'uid')) {
        selectedUsers.push(result.rows.map(row => String(row.uid)));
      }
      return result;
    },
    select(fields?: Record<string, unknown>) {
      const selected = Reflect.apply(t.db.select, t.db, fields === undefined ? [] : [fields]);
      // startDmEphemeral запускает этот реальный SELECT без await; дожидаемся его перед очисткой базы.
      if (!fields || Object.keys(fields).length !== 1 || fields.id !== schema.users.id) return selected;
      return { from(table: unknown) {
        const from = selected.from(table);
        return { where(condition: unknown) {
          const query = from.where(condition);
          return { then(resolve?: (rows: unknown) => unknown, reject?: (error: unknown) => unknown) {
            const work: Promise<unknown> = Promise.resolve(query);
            reads.push(work);
            return work.then(resolve, reject);
          } };
        } };
      } };
    },
  };
  const ephemeral = moduleOf<Ephemeral>('federation/dmEphemeral', {
    'drizzle-orm': orm, '@gusvoice/shared': shared, '../blocks.js': blocks,
    '../db/index.js': { db: observedDb }, '../db/schema.js': schema,
    '../gateway.js': {
      isUserDmPresent: (id: string) => online.has(id),
      relayFedTyping: () => unexpected('relayFedTyping'),
      setRemoteDmPresence: () => unexpected('setRemoteDmPresence'),
    },
    '../lastSeenRules.js': lastSeenRules,
    './directorySync.js': { refreshCapabilities: () => unexpected('refreshCapabilities') },
    './guestHost.js': { shadowUserFor: () => unexpected('shadowUserFor') },
    // Синтетическая личность загрузочного окружения; подпись/сеть заканчиваются на postSignedToPeer.
    './instance.js': { federation: {
      identity: () => ({ instanceId: SELF }),
      signingKey: () => ({ kid: 'fixture', privateKeyDer: new Uint8Array([1]) }),
    } },
    './peerClient.js': { postSignedToPeer: async (request: Request) => {
      requests.push(request);
      return { ok: true, value: { status: 202 } };
    } },
  }, {
    Date: ClockDate,
    setTimeout: (fn: () => void, ms: number) => {
      const handle = { unref() {} }; timeouts.set(handle, { fn, ms }); return handle;
    },
    clearTimeout: (handle: object) => { timeouts.delete(handle); },
    setInterval: (fn: () => void, ms: number) => { intervals.push({ fn, ms }); return { unref() {} }; },
  }, mutations, '\nexport { flushPresence as testFlushPresence };\n');
  return { ephemeral, online, requests, selectedUsers, blocks, timeouts, intervals, advance: (ms: number) => { now += ms; },
    checkIo: () => assert.deepEqual(ioFailures, [], 'непредметный IO не скрыт best-effort catch'),
    async finishReads() { await Promise.resolve(); await Promise.all(reads); await Promise.resolve(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function bodyOf(f: Fixture, userId = 'local', apiBase = 'https://peer.invalid/api'): PresenceBody {
  const matches = f.requests.filter(r => r.payload.user.user_id === userId && r.apiBase === apiBase);
  assert.equal(matches.length, 1, 'одна запись на человека и дом');
  return matches[0]!.payload;
}
function viewOf(body: PresenceBody, id = 'shadow'): WireView {
  const view = body.views.find(v => v.user.user_id === 'home-' + id);
  assert.ok(view, 'зритель есть в записи: ' + id);
  return view;
}
function decisions(f: Fixture) {
  return f.requests.map(r => ({ home: r.apiBase, online: r.payload.online,
    views: [...r.payload.views].map(v => ({ id: v.user.user_id, exact: v.last_seen !== null, approx: v.approx ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)) })).sort((a, b) => a.home.localeCompare(b.home));
}

async function offlineScenario(mutations: readonly Mutation[] = []) {
  const f = await fixture(mutations);
  await f.ephemeral.resendPresence();
  const body = bodyOf(f);
  assert.equal(viewOf(body).last_seen, SEEN, 'offline resend берёт сохранённое время, не время повторной рассылки');
  assert.equal(body.online, false); assert.equal(body.at, NOW);
  assert.equal(body.user.instance_id, SELF); assert.equal(body.instance_id, SELF);
  assert.equal(body.views.length, 1); assert.equal(viewOf(body).approx, undefined);
  assert.equal(viewOf(body).user.instance_id, PEER);
  assert.deepEqual(f.selectedUsers, [['local']]);
  assert.equal(f.requests[0]!.path, '/api/fed/v1/ephemeral');
  assert.equal(f.requests[0]!.now, NOW);
  assert.deepEqual([...f.requests[0]!.allowHosts], ['peer.invalid']);
}
test('R204 offline повторяет одну запись с временем ухода из users, а не временем перезапуска', async () => {
  await offlineScenario();
});
test('R204 online повторяет текущее время даже при старой или отсутствующей отметке в users', async () => {
  const f = await fixture(); f.online.add('local');
  for (const lastSeenAt of [new Date(SEEN), null]) {
    await t.db.update(schema.users).set({ lastSeenAt }).where(orm.eq(schema.users.id, 'local'));
    f.requests.length = 0;
    await f.ephemeral.resendPresence();
    const body = bodyOf(f);
    assert.equal(body.online, true); assert.equal(body.at, NOW); assert.equal(viewOf(body).last_seen, NOW);
  }
});
async function nullScenario(mutations: readonly Mutation[] = []) {
  const f = await fixture(mutations);
  await t.db.update(schema.users).set({ lastSeenAt: null }).where(orm.eq(schema.users.id, 'local'));
  // Публичный resend глотает сбои flush: поэтому отдельно проверяем, что guard завершает сам flush без null.getTime().
  await assert.doesNotReject(f.ephemeral.testFlushPresence('local', false, { fromDb: true }),
    'null-guard завершает настоящий flush без getTime на отсутствующей отметке');
  await f.ephemeral.resendPresence();
  assert.deepEqual(f.selectedUsers, [['local']], 'человек выбран настоящим SQL, отсутствие отправки не спрятано выборкой');
  assert.equal(f.requests.length, 0, 'offline без отметки не придумывает время и не посылает presence');
  await t.db.update(schema.users).set({ lastSeenAt: new Date(SEEN) }).where(orm.eq(schema.users.id, 'local'));
  await f.ephemeral.resendPresence();
  assert.equal(viewOf(bodyOf(f)).last_seen, SEEN, 'тот же offline с отметкой отправляется');
}
test('R204 offline без last_seen_at молчит, заполненная отметка разрешает повтор', async () => {
  await nullScenario();
});
test('R204 ошибочное будущее в users.last_seen_at ограничено временем повторной рассылки', async () => {
  const f = await fixture();
  await t.db.update(schema.users).set({ lastSeenAt: new Date(NOW + 1) }).where(orm.eq(schema.users.id, 'local'));
  await f.ephemeral.resendPresence();
  assert.equal(viewOf(bodyOf(f)).last_seen, NOW);
});

async function mixedHomes(f: Fixture) {
  await addUsers([
    local('second'), local('other-only'), local('local-only'), local('local-peer'),
    local('group-only'), local('deleted', { deletedAt: new Date(NOW - 1) }),
    shadow('shadow2'), shadow('other-shadow', OTHER), shadow('other-shadow2', OTHER),
  ]);
  await addConversations([
    { id: 'local-second-peer', users: ['local', 'shadow2'] },
    { id: 'local-other', users: ['local', 'other-shadow'] },
    { id: 'second-peer', users: ['second', 'shadow'] },
    { id: 'second-other', users: ['second', 'other-shadow2'] },
    { id: 'other-only', users: ['other-only', 'other-shadow'] },
    { id: 'local-only', users: ['local-only', 'local-peer'] },
    { id: 'group-only', users: ['group-only', 'shadow'], kind: 'group' },
    { id: 'deleted', users: ['deleted', 'shadow'] },
    { id: 'shadows-only', users: ['shadow', 'shadow2'] },
  ]);
  assert.equal(f.requests.length, 0);
}
async function onlyHomeScenario(mutations: readonly Mutation[] = []) {
  const f = await fixture(mutations); await mixedHomes(f);
  await f.ephemeral.resendPresence(PEER);
  assert.deepEqual([...(f.selectedUsers[0] ?? [])].sort(), ['local', 'second'],
    'onlyHome SQL выбирает только местных с 1:1 этого дома');
  assert.equal(f.requests.length, 2, 'onlyHome flush не отправляет второму дому у тех же местных');
  assert.ok(f.requests.every(r => r.apiBase === 'https://peer.invalid/api'), 'все запросы адресованы onlyHome');
  assert.deepEqual([...bodyOf(f).views].map(v => v.user.user_id).sort(), ['home-shadow', 'home-shadow2']);
  assert.equal(bodyOf(f, 'second').views.length, 1);
  f.requests.length = 0; f.selectedUsers.length = 0;
  await f.ephemeral.resendPresence(OTHER);
  assert.deepEqual([...(f.selectedUsers[0] ?? [])].sort(), ['local', 'other-only', 'second']);
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests.every(r => r.apiBase === 'https://other.invalid/api'));
  f.requests.length = 0; f.selectedUsers.length = 0;
  await f.ephemeral.resendPresence(ALIEN);
  assert.deepEqual(f.selectedUsers, [[]]); assert.equal(f.requests.length, 0, 'чужому дому без собеседников ничего');
  await f.ephemeral.resendPresence();
  assert.equal(f.requests.length, 5, 'без onlyHome отправляются оба дома каждого местного, а не только первый');
  assert.equal(bodyOf(f).views.length, 2);
  assert.equal(bodyOf(f, 'local', 'https://other.invalid/api').views.length, 1);
  assert.equal(bodyOf(f, 'second', 'https://other.invalid/api').views.length, 1);
  assert.equal(bodyOf(f, 'other-only', 'https://other.invalid/api').views.length, 1);
}
test('R204 onlyHome изолирует SQL и отправку: два местных с двумя домами, чужой дом молчит', async () => {
  await onlyHomeScenario();
});

test('R204 resend соблюдает блок, Никто, always и never так же, как обычный flush', async () => {
  const f = await fixture();
  await addUsers([shadow('shadow2'), shadow('shadow3'), shadow('other-shadow', OTHER)]);
  await addConversations([
    { id: 'privacy2', users: ['local', 'shadow2'] }, { id: 'privacy3', users: ['local', 'shadow3'] },
    { id: 'privacy-other', users: ['local', 'other-shadow'] },
  ]);
  await f.blocks.blockUser('local', 'shadow');
  await t.db.insert(schema.lastSeenExceptions).values([
    { ownerId: 'local', targetId: 'shadow3', kind: 'never' },
    { ownerId: 'local', targetId: 'other-shadow', kind: 'always' },
  ]);
  for (const privacy of ['everyone', 'peers', 'nobody']) {
    await t.db.update(schema.users).set({ lastSeenPrivacy: privacy }).where(orm.eq(schema.users.id, 'local'));
    f.requests.length = 0;
    await f.ephemeral.resendPresence();
    const resent = decisions(f), body = bodyOf(f);
    assert.equal(body.views.length, 2, 'заблокированный отсутствует, остальные зрители не исчезают');
    assert.equal(body.views.some(v => v.user.user_id === 'home-shadow'), false);
    assert.equal(viewOf(body, 'shadow2').last_seen, privacy === 'nobody' ? null : SEEN);
    assert.equal(viewOf(body, 'shadow3').last_seen, null); assert.equal(viewOf(body, 'shadow3').approx, 'recently');
    assert.equal(viewOf(bodyOf(f, 'local', 'https://other.invalid/api'), 'other-shadow').last_seen, SEEN);
    f.requests.length = 0;
    await f.ephemeral.testFlushPresence('local', false);
    assert.deepEqual(decisions(f), resent, 'resend не обходит правила обычного flush для каждого зрителя');
  }
  await f.blocks.unblockUser('local', 'shadow');
  await t.db.delete(schema.lastSeenExceptions);
  await t.db.update(schema.users).set({ lastSeenPrivacy: 'everyone' }).where(orm.eq(schema.users.id, 'local'));
  f.requests.length = 0; await f.ephemeral.resendPresence();
  assert.equal(bodyOf(f).views.length, 3, 'разблокированный снова получает presence');
  for (const r of f.requests) for (const v of r.payload.views) {
    assert.equal(v.last_seen, SEEN, 'без запрещающих исключений все зрители видят время');
  }
});

async function settleScenario(mutations: readonly Mutation[] = []) {
  const f = await fixture(mutations);
  await addUsers([local('second')]);
  await addConversations([{ id: 'settle-second', users: ['second', 'shadow'] }]);
  f.ephemeral.fedPresence('local', false);
  assert.equal(f.timeouts.size, 1); assert.equal([...f.timeouts.values()][0]!.ms, 2000);
  await f.ephemeral.resendPresence();
  assert.deepEqual([...(f.selectedUsers[0] ?? [])].sort(), ['local', 'second']);
  assert.deepEqual(f.requests.map(r => r.payload.user.user_id), ['second'],
    'resend пропускает pending settle, но не пропускает готового соседа');
  assert.equal(viewOf(bodyOf(f, 'second')).last_seen, SEEN);
  assert.equal(f.timeouts.size, 1, 'resend не отменяет ожидающую смену состояния');
  assert.equal(f.intervals.length, 0, 'resend не создаёт новый таймер');
}
test('R204 pending settle пропускается, другой местный отправляется без отмены или добавления таймеров', async () => {
  await settleScenario();
});
test('R204 повторная рассылка не добавляет третий интервал и повторный старт не дублирует два штатных', async () => {
  const f = await fixture();
  try {
    f.ephemeral.startDmEphemeral(); f.ephemeral.startDmEphemeral();
    await f.finishReads();
    await f.ephemeral.resendPresence(); await f.ephemeral.resendPresence(PEER);
    assert.deepEqual(f.intervals.map(job => job.ms).sort((a, b) => a - b), [30_000, shared.FED_PRESENCE_ALIVE_MS]);
    assert.equal(f.timeouts.size, 0);
    assert.equal(f.requests.length, 2);
  } finally { await f.finishReads(); }
});

async function capacityScenario(count: number, mutations: readonly Mutation[] = []) {
  const f = await fixture(mutations, false);
  const ids = Array.from({ length: count }, (_, i) => 'capacity-' + i);
  await addUsers([...ids.map(id => local(id)), shadow('p-one'), shadow('p-two'), shadow('o-one', OTHER)]);
  await addConversations(ids.flatMap(id => ['p-one', 'p-two', 'o-one'].map(remote => ({
    id: 'conv-' + id + '-' + remote, users: [id, remote],
  }))));
  const [actual] = await t.db.select({ count: orm.count() }).from(schema.users).where(orm.isNull(schema.users.homeInstanceId));
  assert.equal(actual!.count, count, 'в базе действительно 400 или 401 местных, а не подставленный размер SELECT');
  await f.ephemeral.resendPresence();
  const selected = f.selectedUsers[0] ?? [];
  assert.equal(selected.length, 400, 'реальный SQL ограничивает resend ровно 400 людьми');
  assert.equal(new Set(selected).size, 400, 'DISTINCT считает людей, не три беседы каждого человека');
  assert.ok(selected.every(id => ids.includes(id)), 'выбраны только настоящие местные');
  assert.equal(f.requests.length, 800, 'каждый из выбранных 400 получает по одной записи в каждый из двух домов');
  assert.equal(new Set(f.requests.map(r => r.payload.user.user_id)).size, 400);
  for (const id of selected) {
    const first = bodyOf(f, id), second = bodyOf(f, id, 'https://other.invalid/api');
    assert.equal(first.views.length, 2); assert.equal(second.views.length, 1);
    assert.ok([...first.views, ...second.views].every(v => v.last_seen === SEEN));
  }
}
for (const count of [400, 401]) {
  test('R204 предел 400 на настоящем SQL: ' + count + ' местных с тремя беседами и двумя домами', async () => {
    await capacityScenario(count);
  });
}

async function killed(scenario: (mutations?: readonly Mutation[]) => Promise<void>, mutations: readonly Mutation[], message: string) {
  await scenario(); await truncateAll(t.raw);
  await assert.rejects(scenario(mutations),
    error => error instanceof assert.AssertionError && error.message.includes(message));
}
test('R204 потеря fromDb обнаруживается старым временем offline в фактическом payload', async () => {
  await killed(offlineScenario, [['{ onlyHome, fromDb: true }', '{ onlyHome }']],
    'offline resend берёт сохранённое время');
});
test('R204 снятый onlyHome в SQL пойман реальными лишними uid даже при сохранённом фильтре flush', async () => {
  await killed(onlyHomeScenario, [['onlyHome ? sql', 'false ? sql']], 'onlyHome SQL выбирает только местных');
});
test('R204 снятый onlyHome внутри flush пойман утечкой во второй дом тех же местных', async () => {
  await killed(onlyHomeScenario, [
    ['(await fedPeersOf(userId)).filter((p) => !opts.onlyHome || p.home === opts.onlyHome)', '(await fedPeersOf(userId))'],
  ], 'onlyHome flush не отправляет второму дому');
});
test('R204 потеря передачи onlyHome из resend в flush поймана адресами реальных post', async () => {
  await killed(onlyHomeScenario, [['{ onlyHome, fromDb: true }', '{ fromDb: true }']],
    'onlyHome flush не отправляет второму дому');
});
test('R204 обход null-guard обнаруживается лишней presence, а не проглоченным getTime TypeError', async () => {
  // Простое удаление return даёт null.getTime(), который resend глотает: «нет post» всё ещё верно.
  // Работоспособный мутант удаляет отказ и задаёт fallback-now, поэтому нарушает именно молчание offline без отметки.
  await killed(nullScenario, [
    ['if (!me.lastSeenAt) return; // не заходил — сказать нечего', 'if (!me.lastSeenAt) me.lastSeenAt = new Date(now);'],
  ], 'offline без отметки не придумывает время');
});
test('R204 буквальная потеря null-guard поймана адресным doesNotReject настоящего flush, не ошибкой загрузки', async () => {
  await nullScenario(); await truncateAll(t.raw);
  await assert.rejects(nullScenario([
    ['if (!me.lastSeenAt) return; // не заходил — сказать нечего', '// мутант: отказ на отсутствующей отметке удалён'],
  ]), error => {
    if (!(error instanceof assert.AssertionError) || !error.message.includes('null-guard завершает настоящий flush')) return false;
    // Error из vm имеет другой prototype: проверяем actual у host AssertionError, имя и конкретное чтение getTime.
    const actual = error.actual as Error | undefined;
    return actual?.name === 'TypeError' && actual.message.includes('getTime');
  });
});
test('R204 потеря settle-пропуска обнаруживается лишним post, а не ожиданием таймера', async () => {
  await killed(settleScenario, [
    ['if (settleTimers.has(r.uid)) continue; // смена уже в пути — она и скажет', '// мутант: ожидающая смена больше не пропускается'],
  ], 'resend пропускает pending settle');
});
test('R204 предел 401 вместо 400 обнаруживается реальной выборкой поверх 401 местного', async () => {
  const scenario = (mutations: readonly Mutation[] = []) => capacityScenario(401, mutations);
  await killed(scenario, [['const RESEND_USERS_MAX = 400;', 'const RESEND_USERS_MAX = 401;']],
    'реальный SQL ограничивает resend ровно 400 людьми');
});

async function peerAddedFixture(mutations: readonly Mutation[] = []) {
  const f = await fixture(mutations, false);
  await addUsers([local('local')]); f.online.add('local');
  await f.ephemeral.testFlushPresence('local', true); // Реально заполняет десятиминутную память «нет собеседников».
  assert.equal(f.requests.length, 0);
  await addUsers([shadow('shadow'), shadow('second', OTHER)]);
  await addConversations([{ id: 'added-peer', users: ['local', 'shadow'] }, { id: 'added-other', users: ['local', 'second'] }]);
  return f;
}
async function finishAddedTimer(f: Fixture) {
  assert.equal(f.timeouts.size, 1);
  const [handle, timer] = [...f.timeouts][0]!;
  assert.equal(timer.ms, 2000); f.advance(1999);
  assert.equal(f.requests.length, 0, 'до успокоения presence не отправляется');
  f.advance(1); f.timeouts.delete(handle); timer.fn();
  // В этом сценарии конечная цепочка flush содержит менее десяти SQL-запросов. Барьеры дренируют её без sleep/повторного flush.
  for (let i = 0; i < 20; i++) { await t.raw.query('SELECT 1'); await new Promise<void>(resolve => setImmediate(resolve)); }
}
async function addedPresence(online: boolean, mutations: readonly Mutation[] = []) {
  const f = await peerAddedFixture(mutations);
  if (!online) f.online.clear();
  f.ephemeral.fedPeerAdded('local', PEER); await finishAddedTimer(f);
  assert.equal(f.requests.length, 1, 'R235-added-home: появление беседы будит только дом нового собеседника');
  const request = f.requests[0]!;
  assert.equal(request.apiBase, 'https://peer.invalid/api');
  assert.equal(request.path, '/api/fed/v1/ephemeral');
  assert.equal(request.payload.online, online); assert.equal(request.payload.at, NOW + 2000);
  assert.equal(viewOf(request.payload).last_seen, online ? NOW + 2000 : SEEN,
    'R235-added-seen: offline берёт сохранённое время ухода, online — текущее');
  assert.equal(request.payload.views.length, 1); assert.equal(f.timeouts.size, 0);
  f.checkIo();
}
test('R235 новая беседа после пустого flush через две секунды сообщает online только нужному дому', () => addedPresence(true));
test('R235 fedPeerAdded у offline человека сообщает настоящее users.last_seen_at, не время новой беседы', () => addedPresence(false));
async function forgetEmptyCache(mutations: readonly Mutation[] = []) {
  const f = await peerAddedFixture(mutations);
  f.ephemeral.fedPeerAdded('local', PEER);
  await f.ephemeral.testFlushPresence('local', true); // Минутный «жив» успел раньше отложенного сообщения новой беседы.
  assert.equal(f.requests.length, 2, 'R235-added-cache: память о пустом наборе забыта сразу, не через десять минут');
  assert.equal(new Set(f.requests.map(r => r.apiBase)).size, 2);
  f.timeouts.clear();
  f.checkIo();
}
test('R235 fedPeerAdded сразу инвалидирует десятиминутный пустой кеш для ближайшего «жив»', () => forgetEmptyCache());
for (const [label, from, to, check, prefix, actual, expected] of [
  ['не забыт пустой кеш', 'export function fedPeerAdded(userId: string, home: string): void {\n  noFedPeersUntil.delete(userId);',
    'export function fedPeerAdded(userId: string, home: string): void {', forgetEmptyCache, 'R235-added-cache:', 0, 2],
  ['offline притворяется свежим', '{ onlyHome: home, fromDb: true }', '{ onlyHome: home, fromDb: false }',
    (m: readonly Mutation[]) => addedPresence(false, m), 'R235-added-seen:', NOW, SEEN],
  ['presence уходит постороннему дому', '{ onlyHome: home, fromDb: true }', '{ fromDb: true }',
    (m: readonly Mutation[]) => addedPresence(true, m), 'R235-added-home:', 2, 1],
] as const) test(`R235 контрфакт fedPeerAdded: ${label}`, async () => {
  await check([]); await truncateAll(t.raw);
  await assert.rejects(() => check([[from, to]]), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
});
