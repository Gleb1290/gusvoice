import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import * as rules from './lastSeenRules.js';
import type { RemoteLastSeen } from './lastSeen.js';

type Seen = typeof import('./lastSeen.js');
type Mutation = readonly [string, string];
const NOW = 2_000_000_000_000;
const HOME_AT = NOW - 4 * 86_400_000;
const source = readFileSync(new URL('./lastSeen.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function fixture(mutation?: Mutation) {
  const users = {};
  const exceptions = {};
  let viewerPrivacy: 'everyone' | 'nobody' = 'everyone';
  let exceptionRows: { owner: string; target: string; kind: 'always' | 'never' }[] = [];
  const calls: string[][] = [];
  let connected = false;
  let shadowHome: string | null = 'b'.repeat(32);
  let shadowPrivacy: 'everyone' | 'nobody' = 'nobody';
  let shadowAt = new Date(0);
  const db = { select: () => ({ from: (table: unknown) => ({ where: async () => table === users ? [
    { id: 'viewer', privacy: viewerPrivacy, lastSeenAt: new Date(NOW), presence: 'online', hideReadTime: false, deletedAt: null },
    // Старая строка тени и её местное исключение не имеют права перекрыть свежий итог правил дома.
    { id: 'shadow', privacy: shadowPrivacy, lastSeenAt: shadowAt, presence: 'online', hideReadTime: false, deletedAt: null, home: shadowHome },
  ] : exceptionRows }) }) };
  const deps: Record<string, unknown> = {
    'drizzle-orm': { eq: () => ({}), and: () => ({}), or: () => ({}), inArray: () => ({}) },
    './conversations.js': { peerReadKeys: () => { throw new Error('время прочтения не в этой сцене'); } },
    './blocks.js': { isBlockedBy: async () => false }, './db/index.js': { db },
    './db/peerQueries.js': { arePeers: async () => true, loadPeers: async () => new Set(['shadow']) },
    './db/schema.js': { users, lastSeenExceptions: exceptions, conversationMessages: {} },
    './gateway.js': { isUserDmPresent: () => connected }, './lastSeenRules.js': rules,
  };
  let code = source;
  if (mutation) {
    assert.equal(code.split(mutation[0]).length, 2, 'уникальный якорь lastSeen');
    code = code.replace(...mutation);
  }
  const module = { exports: {} };
  class ClockDate extends Date { static now() { return NOW; } }
  runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Date: ClockDate,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `явный импорт ${id}`); return deps[id]; },
  });
  const seen = module.exports as Seen;
  let remote: ReturnType<RemoteLastSeen> = { shares: true, lastSeenAt: new Date(HOME_AT) };
  seen.configureRemoteLastSeen((subject, viewer) => { calls.push([subject, viewer]); return remote; });
  return { seen, calls, setRemote: (value: typeof remote) => { remote = value; },
    setPrivacy: (value: typeof viewerPrivacy) => { viewerPrivacy = value; },
    setExceptions: (value: typeof exceptionRows) => { exceptionRows = value; },
    connect: () => { connected = true; }, stored: (privacy: typeof shadowPrivacy, at: Date, home: typeof shadowHome) => { shadowPrivacy = privacy; shadowAt = at; shadowHome = home; } };
}

async function remoteScenario(mutation?: Mutation) {
  const f = fixture(mutation);
  f.setExceptions([{ owner: 'shadow', target: 'viewer', kind: 'never' }]);
  for (const batch of [false, true]) {
    const v = batch ? (await f.seen.lastSeenForMany('viewer', ['shadow']))[0] : await f.seen.lastSeenFor('viewer', 'shadow');
    assert.ok(v);
    assert.equal(v.exact, true, 'итог дома разрешает точное время поверх старой строки тени');
    assert.equal(v.at, new Date(HOME_AT).toISOString(), 'оба входа возвращают отметку дома, а не старую SQL-строку');
    assert.equal(v.approx, null);
  }
  assert.deepEqual(f.calls, [['shadow', 'viewer'], ['shadow', 'viewer']]);
  assert.equal(await f.seen.canScheduleUntilOnline('viewer', 'shadow'), true);
}
test('R197 точное время дома приходит одиночному и пакетному зрителю поверх старой строки и исключений тени', async () => {
  await remoteScenario();
});

async function hiddenScenario(mutation?: Mutation) {
  const f = fixture(mutation); f.setRemote({ shares: false, lastSeenAt: new Date(HOME_AT) });
  for (const batch of [false, true]) {
    const v = batch ? (await f.seen.lastSeenForMany('viewer', ['shadow']))[0] : await f.seen.lastSeenFor('viewer', 'shadow');
    assert.ok(v); assert.equal(v.at, null, 'дом скрыл время: точная отметка наружу не уходит');
    assert.equal(v.exact, false, 'shares false не превращается в everyone');
    assert.equal(v.approx, 'week'); assert.equal(v.byMe, false);
  }
  assert.equal(await f.seen.canScheduleUntilOnline('viewer', 'shadow'), false);
  f.setRemote({ shares: true, lastSeenAt: new Date(HOME_AT) });
  assert.equal((await f.seen.lastSeenFor('viewer', 'shadow'))?.exact, true);
}
test('R197 shares false сохраняет примерную категорию дома без утечки at и запрета после shares true', async () => {
  await hiddenScenario();
});

test('R197 взаимность зрителя и его never исключение сохраняются поверх shares true дома', async () => {
  const f = fixture(); f.setPrivacy('nobody');
  for (const batch of [false, true]) {
    const v = batch ? (await f.seen.lastSeenForMany('viewer', ['shadow']))[0] : await f.seen.lastSeenFor('viewer', 'shadow');
    assert.ok(v); assert.equal(v.at, null); assert.equal(v.exact, false); assert.equal(v.byMe, true); assert.equal(v.approx, 'week');
  }
  f.setPrivacy('everyone'); f.setExceptions([{ owner: 'viewer', target: 'shadow', kind: 'never' }]);
  assert.equal((await f.seen.lastSeenFor('viewer', 'shadow'))?.byMe, true);
  f.setExceptions([{ owner: 'viewer', target: 'shadow', kind: 'always' }]);
  assert.equal((await f.seen.lastSeenFor('viewer', 'shadow'))?.at, new Date(HOME_AT).toISOString());
});

test('R197 пустой или отключённый крючок тени оставляет неизвестную категорию, подключённому не выдаёт время входа', async () => {
  const f = fixture(); f.setRemote(null);
  const stored = await f.seen.lastSeenFor('viewer', 'shadow');
  assert.equal(stored?.exact, false); assert.equal(stored?.approx, 'long');
  f.setRemote({ shares: true, lastSeenAt: new Date(HOME_AT) }); f.connect();
  const online = await f.seen.lastSeenFor('viewer', 'shadow');
  assert.equal(online?.online, true); assert.equal(online?.at, null); assert.equal(online?.exact, true);
  f.seen.configureRemoteLastSeen(null);
  assert.equal((await f.seen.lastSeenFor('viewer', 'shadow'))?.exact, false);
});

async function unknownHomeScenario(mutation?: Mutation) {
  const f = fixture(mutation); f.setRemote(null); f.stored('everyone', new Date(NOW - 1000), 'b'.repeat(32));
  for (const batch of [false, true]) {
    const v = batch ? (await f.seen.lastSeenForMany('viewer', ['shadow']))[0] : await f.seen.lastSeenFor('viewer', 'shadow');
    assert.equal(v?.at, null, 'без данных дома гостевой заход не выдаёт точное время');
    assert.equal(v?.exact, false); assert.equal(v?.approx, 'long');
  }
  f.stored('everyone', new Date(NOW - 1000), null);
  assert.equal((await f.seen.lastSeenFor('viewer', 'shadow'))?.at, new Date(NOW - 1000).toISOString(), 'местный без remote данных использует свою строку');
}
test('R201 тень без данных дома не раскрывает гостевой заход, местный без крючка сохраняет SQL время', async () => { await unknownHomeScenario(); });
test('R201 мутант SQL времени тени без home данных пойман парным местным сценарием', async () => {
  await unknownHomeScenario();
  await assert.rejects(unknownHomeScenario(["if (!r) return subject.remote ? { ...subject, lastSeenAt: null, privacy: 'nobody', exceptions: undefined } : subject;", 'if (!r) return subject;']),
    e => e instanceof assert.AssertionError && e.message.includes('без данных дома гостевой заход'));
});

for (const [name, mutation, check, failure] of [
  ['shares false раскрывает время', ["privacy: r.shares ? 'everyone' : 'nobody'", "privacy: 'everyone'"], hiddenScenario, 'дом скрыл время'],
  ['пакет игнорирует дом', ['const subject = withRemote(stored, viewerId);\n    out.push', 'const subject = stored;\n    out.push'], remoteScenario, 'итог дома разрешает'],
] as [string, Mutation, (mutation?: Mutation) => Promise<void>, string][]) {
  test(`R197 мутант lastSeen «${name}» пойман обеими сторонами privacy`, async () => {
    await check();
    await assert.rejects(check(mutation), e => e instanceof assert.AssertionError && e.message.includes(failure));
  });
}
