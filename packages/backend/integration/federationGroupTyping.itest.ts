import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, it } from 'node:test';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as lastSeenRules from '../src/lastSeenRules.js';
import * as blockRules from '../src/blockRules.js';
import * as gatewayRules from '../src/gatewayRules.js';
import type { StoredLink } from '../src/federation/linkService.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
type Group = typeof import('../src/federation/dmGroupTyping.js') & {
  testSendGroupTyping(dm: string, sender: string, action: string): Promise<void>;
};
type Ephemeral = typeof import('../src/federation/dmEphemeral.js');
type Gateway = typeof import('../src/gatewayTyping.js');
const H = 'a'.repeat(32), M = 'b'.repeat(32), E = 'c'.repeat(32);
const cid = 'group-typing', NOW = 2_000_000_000_000;
const F = shared.FED_FEATURES;
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => {
  try { await t.close(); }
  finally {
    // harness импортирует db/index ради миграций: неиспользуемый PgPool тоже закрываем, даже при ошибке PGlite.
    const { pool } = await import('../src/db/index.js');
    await pool.end();
  }
});
const forbidden = (name: string) => () => { throw new Error(`неописанная IO-граница ${name}`); };

/** Исполняем модуль целиком: подменяются только транспорт, часы и несработавшие IO-границы. */
function moduleOf<T>(name: string, explicit: Record<string, unknown>, mutation?: Mutation, globals: Record<string, unknown> = {}, expose = ''): T {
  let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation) {
    assert.equal(source.split(mutation[0]).length - 1, 1, `единственный якорь ${name}`);
    source = source.replace(...mutation);
  }
  const deps: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly) continue;
    const id = (n.moduleSpecifier as ts.StringLiteral).text, out: Record<string, unknown> = {};
    const names = n.importClause?.namedBindings;
    if (names && ts.isNamedImports(names)) for (const item of names.elements) {
      if (!item.isTypeOnly) out[item.propertyName?.text ?? item.name.text] = forbidden(`${id}.${item.name.text}`);
    }
    deps[id] = out;
  }
  Object.assign(deps, explicit);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source + expose, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Date, Buffer, URL, Map, Set, Promise, Error,
    console: { warn: () => {} }, setTimeout: forbidden('таймер'), setInterval: forbidden('worker'), ...globals,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `явный импорт ${name}:${id}`); return deps[id]; },
  });
  return module.exports as T;
}

async function fixture(options: { self?: string; origin?: string | null; features?: string[]; group?: Mutation; ephemeral?: Mutation } = {}) {
  await truncateAll(t.raw);
  const self = options.self ?? H, origin = options.origin ?? null;
  let now = NOW;
  class ClockDate extends Date { constructor(value?: number | string) { super(value ?? now); } static now() { return now; } }
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'group_typing_local', displayName: 'Местный', passwordHash: 'fixture' },
    { id: 'm', username: 'group_typing_m', displayName: 'Дом М', passwordHash: 'fixture', homeInstanceId: M, homeUserId: 'm-user' },
    { id: 'm2', username: 'group_typing_m2', displayName: 'Второй М', passwordHash: 'fixture', homeInstanceId: M, homeUserId: 'm2-user' },
    { id: 'e', username: 'group_typing_e', displayName: 'Дом Е', passwordHash: 'fixture', homeInstanceId: E, homeUserId: 'e-user' },
    { id: 'h', username: 'group_typing_h', displayName: 'Хост', passwordHash: 'fixture', homeInstanceId: H, homeUserId: 'h-user' },
  ]);
  for (const [id, domain] of [[H, 'h.invalid'], [M, 'm.invalid'], [E, 'e.invalid']]) {
    if (id === self) continue;
    await t.db.insert(schema.federationLinks).values({ instanceId: id!, domain: domain!, apiBase: `https://${domain}`, clientOrigin: `https://${domain}`,
      rootKey: 'fixture-public-key', state: 'active', features: options.features ?? [F.dm3, F.dmgroup1, F.dmgroup2] });
  }
  await t.db.insert(schema.conversations).values([{ id: cid, kind: 'group', title: 'Группа', createdBy: 'local', originInstanceId: origin },
    { id: 'typing-direct', kind: 'direct', directKey: 'local:e', createdBy: 'local' }]);
  await t.db.insert(schema.conversationMembers).values([
    ...['local', 'm', 'm2', 'e', ...(origin ? ['h'] : [])].map(userId => ({ conversationId: cid, userId })),
    { conversationId: 'typing-direct', userId: 'local' }, { conversationId: 'typing-direct', userId: 'e' },
  ]);
  const common = { 'drizzle-orm': orm, '@gusvoice/shared': shared };
  const fed = { ...common, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const guest = moduleOf<typeof import('../src/federation/guestHost.js')>('federation/guestHost', { ...fed, 'node:crypto': crypto });
  const blocks = moduleOf<typeof import('../src/blocks.js')>('blocks', { ...common, './db/index.js': { db: t.db }, './db/schema.js': schema });
  const relayed: string[][] = [], posts: Array<{ apiBase: string; path: string; payload: Record<string, any>; allowHosts: Set<string>; now: number }> = [];
  const federation = { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'fixture-key', privateKeyDer: new Uint8Array([1]) }) };
  const gateway = { relayFedTyping: async (...args: string[]) => { relayed.push(args); }, isUserDmPresent: () => false, setRemoteDmPresence: forbidden('presence') };
  const io = { ...fed, '../gateway.js': gateway, './guestHost.js': guest, './instance.js': { federation },
    './directorySync.js': { refreshCapabilities: async (row: { features: string[] }) => row.features },
    './peerClient.js': { postSignedToPeer: async (request: typeof posts[number]) => { posts.push(request); return { ok: true, value: { status: 202 } }; } } };
  const group = moduleOf<Group>('federation/dmGroupTyping', io, options.group, { Date: ClockDate }, '\nexport { sendGroupTyping as testSendGroupTyping };\n');
  const ephemeral = moduleOf<Ephemeral>('federation/dmEphemeral', { ...io, '../blocks.js': blocks, '../lastSeenRules.js': lastSeenRules }, options.ephemeral, { Date: ClockDate });
  const forwarding: Promise<void>[] = [];
  const configure = () => ephemeral.configureGroupTyping({ accept: group.acceptHostedTyping, forward: (link, e, id) => {
    const work = group.forwardGroupTyping(link, e, id); forwarding.push(work); return work;
  } });
  const link = async (id: string): Promise<StoredLink> => {
    const row = (await t.db.select().from(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, id)))[0];
    assert.ok(row && row.state === 'active'); return { ...row, state: 'active' };
  };
  return { group, ephemeral, posts, relayed, link, configure, settle: () => Promise.all(forwarding), advance: (ms: number) => { now += ms; } };
}
const wire = (home = M, user = 'm-user', conversationId = cid, action: shared.TypingAction = 'typing', until = NOW + shared.FED_TYPING_TTL_MS, stop = false): shared.FedTypingWire => ({
  kind: 'typing', conversationId, user: { instanceId: home, userId: user }, action, until, stop,
});
const hosts = (f: Awaited<ReturnType<typeof fixture>>) => f.posts.map(p => new URL(p.apiBase).hostname).sort();

async function hostSend(mutation?: Mutation) {
  const f = await fixture({ group: mutation });
  await f.group.testSendGroupTyping(cid, 'local', 'voice');
  assert.deepEqual(hosts(f), ['e.invalid', 'm.invalid'], 'C: хост отправляет один раз каждому дому');
  for (const p of f.posts) {
    assert.equal(p.path, `/api${shared.FED_EPHEMERAL_PATH}`);
    assert.deepEqual(shared.parseEphemeralWire(p.payload), { ...wire(H, 'local', cid, 'voice'), user: { instanceId: H, userId: 'local' } });
    assert.deepEqual([...p.allowHosts], [new URL(p.apiBase).host]);
  }
  await f.group.testSendGroupTyping(cid, 'local', 'voice');
  assert.equal(f.posts.length, 2, 'C: повтор до трёх секунд подавлен');
  f.advance(shared.FED_TYPING_RESEND_MS - 1);
  await f.group.testSendGroupTyping(cid, 'local', 'voice');
  assert.equal(f.posts.length, 2, 'C: лимит минус один ещё подавлен');
  f.advance(1); await f.group.testSendGroupTyping(cid, 'local', 'voice');
  assert.equal(f.posts.length, 4, 'C: ровно три секунды пропускают повтор');
}
it('R208 хост шлёт по одному дому, сохраняет автора и действие; повтор проходит ровно через 3 с', async () => { await hostSend(); });

async function hostFeatures(mutation?: Mutation) {
  const f = await fixture({ features: [F.dm3, F.dmgroup1], group: mutation });
  await f.group.testSendGroupTyping(cid, 'local', 'typing');
  assert.equal(f.posts.length, 0, 'C: хосту для рассылки нужен dmgroup2');
}
it('R208 хост не шлёт старому соседу с dm3 и dmgroup1 без dmgroup2', async () => { await hostFeatures(); });
it('R208 один dmgroup2 без dm3 не открывает мгновенный канал хоста', async () => {
  const f = await fixture({ features: [F.dmgroup2] }); await f.group.testSendGroupTyping(cid, 'local', 'typing');
  assert.equal(f.posts.length, 0);
});

async function participantSend(mutation?: Mutation) {
  const f = await fixture({ self: M, origin: H, features: [F.dm3, F.dmgroup1], group: mutation });
  await f.group.testSendGroupTyping(cid, 'local', 'round');
  assert.deepEqual(hosts(f), ['h.invalid'], 'C: участник отправляет только хосту');
  assert.equal(f.posts[0]!.payload.action, 'round');
}
it('R208 участник чужой группы шлёт только хосту: dm3 и dmgroup1 достаточны без dmgroup2', async () => { await participantSend(); });
it('R208 участник не шлёт хосту без dm3 или без dmgroup1', async () => {
  for (const features of [[F.dm3], [F.dmgroup1], [F.dmgroup2]]) {
    const f = await fixture({ self: M, origin: H, features }); await f.group.testSendGroupTyping(cid, 'local', 'typing');
    assert.equal(f.posts.length, 0);
  }
});
it('R208 теневой, ушедший и посторонний не говорят от имени нашего дома; не-группа тоже молчит', async () => {
  const f = await fixture();
  await t.db.update(schema.conversationMembers).set({ leftAt: new Date(NOW) }).where(orm.eq(schema.conversationMembers.userId, 'local'));
  for (const id of ['local', 'm', 'nobody']) await f.group.testSendGroupTyping(cid, id, 'typing');
  await f.group.testSendGroupTyping('typing-direct', 'local', 'typing');
  await f.group.testSendGroupTyping('missing-group', 'local', 'typing');
  assert.equal(f.posts.length, 0);
});
async function departedSender(mutation?: Mutation) {
  const f = await fixture({ group: mutation });
  await t.db.update(schema.conversationMembers).set({ leftAt: new Date(NOW) }).where(orm.eq(schema.conversationMembers.userId, 'local'));
  await f.group.testSendGroupTyping(cid, 'local', 'typing');
  assert.equal(f.posts.length, 0, 'C: вышедший не рассылает от нашего дома');
}

async function forward(mutation?: Mutation) {
  const f = await fixture({ group: mutation });
  await f.group.forwardGroupTyping(await f.link(M), wire(), 'm');
  assert.deepEqual(hosts(f), ['e.invalid'], 'C: пересылка исключает дом печатающего');
  assert.equal(f.posts[0]!.payload.user.instance_id, M);
  assert.equal(f.posts[0]!.payload.user.user_id, 'm-user');
  await f.group.forwardGroupTyping(await f.link(M), wire(), 'm');
  assert.equal(f.posts.length, 1, 'C: частая пересылка подавлена');
  f.advance(shared.FED_TYPING_RESEND_MS - 501);
  await f.group.forwardGroupTyping(await f.link(M), wire(), 'm');
  assert.equal(f.posts.length, 1, 'C: граница пересылки минус один подавлена');
  f.advance(1); await f.group.forwardGroupTyping(await f.link(M), wire(), 'm');
  assert.equal(f.posts.length, 2, 'C: ровно 2.5 секунды допускают пересылку');
}
it('R208 пересылка хоста идёт только третьему дому с исходным автором и отдельной границей 2.5 с', async () => { await forward(); });
async function forwardMembership(mutation?: Mutation) {
  const f = await fixture({ group: mutation });
  await t.db.delete(schema.conversationMembers).where(orm.eq(schema.conversationMembers.userId, 'm'));
  await f.group.forwardGroupTyping(await f.link(M), wire(), 'm');
  assert.equal(f.posts.length, 0, 'C: посторонний не пересылается');
}
it('R208 хост не пересылает постороннего и вышедшего участника', async () => {
  await forwardMembership();
  const f = await fixture(); await t.db.update(schema.conversationMembers).set({ leftAt: new Date(NOW) }).where(orm.eq(schema.conversationMembers.userId, 'm'));
  await f.group.forwardGroupTyping(await f.link(M), wire(), 'm'); assert.equal(f.posts.length, 0);
});
async function forwardHost(mutation?: Mutation) {
  const f = await fixture({ origin: E, group: mutation });
  await f.group.forwardGroupTyping(await f.link(M), wire(), 'm');
  assert.equal(f.posts.length, 0, 'C: чужая группа не пересылается этим домом');
}
it('R208 участник чужого хоста не становится промежуточным хостом пересылки', async () => { await forwardHost(); });
it('R208 пересылка не идёт дому без dmgroup2 или dm3', async () => {
  for (const features of [[F.dm3, F.dmgroup1], [F.dmgroup2]]) {
    const f = await fixture({ features }); await f.group.forwardGroupTyping(await f.link(M), wire(), 'm'); assert.equal(f.posts.length, 0);
  }
});
async function forwardFeature(mutation?: Mutation) {
  const f = await fixture({ features: [F.dm3, F.dmgroup1], group: mutation });
  await f.group.forwardGroupTyping(await f.link(M), wire(), 'm');
  assert.equal(f.posts.length, 0, 'C: пересылка хоста требует dmgroup2 адресата');
}

async function admission(mutation?: Mutation) {
  const f = await fixture({ self: M, origin: H, group: mutation });
  assert.equal((await f.group.acceptHostedTyping(await f.link(H), wire(E, 'e-user'))).status, 202);
  assert.deepEqual(f.relayed, [['e', cid, 'typing']]);
  assert.equal((await f.group.acceptHostedTyping(await f.link(E), wire(H, 'h-user'))).status, 403, 'C: третий дом принимает только хост');
  assert.equal((await f.group.acceptHostedTyping(await f.link(H), wire(E, 'e-user', 'typing-direct'))).status, 403, 'C: 1:1 не принимает третьего автора');
}
it('R208 дом участника принимает третьего автора только от хоста группы; сосед и 1:1 получают 403', async () => { await admission(); });
it('R208 эхо своего человека, неизвестная и удалённая тени не создают событие', async () => {
  const f = await fixture({ self: M, origin: H });
  for (const e of [wire(M, 'local'), wire(E, 'unknown')]) assert.equal((await f.group.acceptHostedTyping(await f.link(H), e)).body.ignored, true);
  await t.db.update(schema.users).set({ deletedAt: new Date(NOW) }).where(orm.eq(schema.users.id, 'e'));
  assert.equal((await f.group.acceptHostedTyping(await f.link(H), wire(E, 'e-user'))).body.ignored, true);
  assert.deepEqual(f.relayed, []);
});
async function echo(mutation?: Mutation) {
  const f = await fixture({ self: M, origin: H, group: mutation });
  // Теневая строка с нашим home здесь намеренно существует: отсутствие строки не должно маскировать потерю отсечки эха.
  const answer = await f.group.acceptHostedTyping(await f.link(H), wire(M, 'm-user'));
  assert.equal(answer.body.ignored, true, 'C: свой дом игнорирует хостовое эхо');
  assert.equal(f.relayed.length, 0);
}
it('R208 stop и опоздание ровно на 30 с не оживляют набор, 29 999 мс ещё проходят', async () => {
  const f = await fixture({ self: M, origin: H }); const link = await f.link(H);
  await f.group.acceptHostedTyping(link, wire(E, 'e-user', cid, 'typing', NOW - 30_000));
  await f.group.acceptHostedTyping(link, wire(E, 'e-user', cid, 'typing', NOW + 6000, true));
  assert.equal(f.relayed.length, 0);
  await f.group.acceptHostedTyping(link, wire(E, 'e-user', cid, 'voice', NOW - 29_999));
  assert.deepEqual(f.relayed, [['e', cid, 'voice']]);
});

async function ephemeralAccept(mutation?: Mutation) {
  const f = await fixture({ self: M, origin: H, ephemeral: mutation }); const link = await f.link(H);
  const raw = shared.serializeEphemeralWire(H, wire(E, 'e-user'));
  assert.equal((await f.ephemeral.acceptEphemeral(link, raw)).status, 403);
  f.configure();
  assert.equal((await f.ephemeral.acceptEphemeral(link, raw)).status, 202, 'C: крючок принимает третьего автора от хоста');
  assert.deepEqual(f.relayed, [['e', cid, 'typing']]);
  f.ephemeral.configureGroupTyping(null);
  assert.equal((await f.ephemeral.acceptEphemeral(link, raw)).status, 403);
}
it('R208 acceptEphemeral без крючка не доверяет третьему автору, с крючком доверяет только хосту', async () => { await ephemeralAccept(); });
async function ephemeralForward(mutation?: Mutation) {
  const f = await fixture({ ephemeral: mutation }); f.configure();
  assert.equal((await f.ephemeral.acceptEphemeral(await f.link(M), shared.serializeEphemeralWire(M, wire()))).status, 202);
  await f.settle();
  assert.deepEqual(f.relayed, [['m', cid, 'typing']]);
  assert.deepEqual(hosts(f), ['e.invalid'], 'C: приём своего соседа зовёт пересылку');
}
it('R208 acceptEphemeral показывает своего соседа и передаёт хостовую пересылку третьему дому', async () => { await ephemeralForward(); });
it('R208 крючок не разрешает presence третьего дома; неизвестный вид игнорируется без события', async () => {
  const f = await fixture({ self: M, origin: H }); f.configure();
  const p = shared.serializeEphemeralWire(H, { kind: 'presence', user: { instanceId: E, userId: 'e-user' }, at: NOW, online: true, views: [] });
  assert.equal((await f.ephemeral.acceptEphemeral(await f.link(H), p)).status, 403);
  assert.equal((await f.ephemeral.acceptEphemeral(await f.link(H), { kind: 'unknown' })).body.ignored, true);
  assert.deepEqual(f.relayed, []); assert.deepEqual(f.posts, []);
});

async function gatewayScenario(mutation?: Mutation, remote = false) {
  const gateway = moduleOf<Gateway>('gatewayTyping', { '@gusvoice/shared': shared, './gatewayRules.js': gatewayRules, './blockRules.js': blockRules }, mutation);
  const sent: Array<{ socket: string; message: unknown }> = [], remoteCalls: unknown[][] = [];
  const deps: import('../src/gatewayTyping.js').TypingDeps<string> = {
    rateHit: async () => 0, dmPeerOf: async () => null, groupPeersOf: async () => ['one', 'two', 'offline', 'blocked'],
    isBlockedBy: async (id) => id === 'blocked', isRemote: () => remote,
    connsOf: (id) => id === 'offline' ? [] : [{ socket: id, caps: new Set(['typing2']) }, { socket: `${id}-old` }],
    send: (socket, message) => { sent.push({ socket, message }); }, remoteTyping: forbidden('ветка 1:1'),
    remoteGroupTyping: (...args) => { remoteCalls.push(args); }, getChannelAudience: forbidden('канал'), publishToChannel: forbidden('канал'),
  };
  await gateway.relayTyping(deps, { userId: 'local', servers: new Set() }, { dmId: cid, action: 'round' });
  assert.equal(sent.length, 4);
  assert.deepEqual(sent.map(s => (s.message as { action: string }).action), ['round', 'voice', 'round', 'voice']);
  assert.equal(remoteCalls.length, remote ? 0 : 1, remote ? 'C: тень не зовёт удалённую группу' : 'C: шлюз зовёт удалённую группу ровно раз');
  if (!remote) assert.deepEqual(remoteCalls[0], [cid, 'local', 'round']);
  deps.groupPeersOf = async () => null;
  await gateway.relayTyping(deps, { userId: 'local', servers: new Set() }, { dmId: cid });
  assert.equal(remoteCalls.length, remote ? 0 : 1, 'не участник не запускает удалённую рассылку');
}
it('R208 настоящий relayTyping зовёт remoteGroupTyping ровно раз, а не на сокет или участника', async () => { await gatewayScenario(); });
it('R208 гостевые сокеты теневого отправителя не запускают remoteGroupTyping', async () => { await gatewayScenario(undefined, true); });

/** Падение другого класса (в том числе VM/таймер/загрузка) не доказывает обнаружение регрессии. */
async function killed(run: (mutation?: Mutation) => Promise<void>, mutation: Mutation, label: string, actual: unknown, expected: unknown) {
  await run();
  await assert.rejects(() => run(mutation), (err: unknown) => err instanceof assert.AssertionError && err.message.startsWith(label)
    && JSON.stringify(err.actual) === JSON.stringify(actual) && JSON.stringify(err.expected) === JSON.stringify(expected));
}
it('R208 контрфакт: dmgroup1 не заменяет dmgroup2 у получателя хостовой рассылки', async () => {
  await killed(hostFeatures, ['[FED_FEATURES.dm3, FED_FEATURES.dmgroup2]);\n    if (link) await post(link, wire);', '[FED_FEATURES.dm3, FED_FEATURES.dmgroup1]);\n    if (link) await post(link, wire);'], 'C: хосту для рассылки нужен dmgroup2', 2, 0);
});
it('R208 контрфакт: отправка хоста сохраняет свой предел частоты', async () => {
  await killed(hostSend, ['if (throttled(`${dmId}:${senderId}:${action}`, FED_TYPING_RESEND_MS, Date.now())) return;', ''], 'C: повтор до трёх секунд подавлен', 4, 2);
});
it('R208 контрфакт: вышедшие участники исключаются SQL до отправки', async () => {
  await killed(departedSender, ['and(eq(conversationMembers.conversationId, conversationId), isNull(conversationMembers.leftAt))', 'eq(conversationMembers.conversationId, conversationId)'], 'C: вышедший не рассылает от нашего дома', 2, 0);
});
it('R208 контрфакт: участник не обязан иметь dmgroup2 на хосте, dmgroup1 достаточен', async () => {
  await killed(participantSend, ['info.origin !== null ? [FED_FEATURES.dm3, FED_FEATURES.dmgroup1] :', 'info.origin !== null ? [FED_FEATURES.dm3, FED_FEATURES.dmgroup2] :'], 'C: участник отправляет только хосту', [], ['h.invalid']);
});
it('R208 контрфакт: удаление exceptHome возвращает эхо дому печатающего', async () => {
  await killed(forward, ['!!h && h !== from.instanceId', '!!h'], 'C: пересылка исключает дом печатающего', ['e.invalid', 'm.invalid'], ['e.invalid']);
});
it('R208 контрфакт: пересылка хоста не заменяет dmgroup2 старым dmgroup1', async () => {
  await killed(forwardFeature, ['const link = await linkWith(home, [FED_FEATURES.dm3, FED_FEATURES.dmgroup2]);', 'const link = await linkWith(home, [FED_FEATURES.dm3, FED_FEATURES.dmgroup1]);'], 'C: пересылка хоста требует dmgroup2 адресата', 1, 0);
});
it('R208 контрфакт: удаление лимита хостовой пересылки пропускает повтор', async () => {
  await killed(forward, ['if (throttled(`fwd:${e.conversationId}:${shadowId}:${e.action}`, FORWARD_RESEND_MS, Date.now())) return;', ''], 'C: частая пересылка подавлена', 2, 1);
});
it('R208 контрфакт: пересылка требует действующего участника', async () => {
  await killed(forwardMembership, ['if (!members.some((m) => m.userId === shadowId)) return;', ''], 'C: посторонний не пересылается', 1, 0);
});
it('R208 контрфакт: дом участника не пересылает события вместо чужого хоста', async () => {
  await killed(forwardHost, ['if (!info || info.origin !== null) return;', 'if (!info) return;'], 'C: чужая группа не пересылается этим домом', 1, 0);
});
it('R208 контрфакт: приём третьего автора требует именно хоста этой группы', async () => {
  await killed(admission, ['if (!info || info.origin !== link.instanceId) return', 'if (!info) return'], 'C: третий дом принимает только хост', 202, 403);
});
it('R208 контрфакт: хостовое эхо не выдаёт нашему дому его собственный набор', async () => {
  await killed(echo, ['if (!self || e.user.instanceId === self.instanceId) return', 'if (!self) return'], 'C: свой дом игнорирует хостовое эхо', undefined, true);
});
it('R208 контрфакт: входной ephemeral не теряет крючок приёма третьего автора', async () => {
  await killed(ephemeralAccept, ['if (e.kind === \'typing\' && e.user.instanceId !== link.instanceId && groupTyping) return groupTyping.accept(link, e);', ''], 'C: крючок принимает третьего автора от хоста', 403, 202);
});
it('R208 контрфакт: входной ephemeral не теряет пересылку хоста', async () => {
  await killed(ephemeralForward, ['if (!e.stop && e.until > now - TYPING_LATE_MS) void groupTyping?.forward(link, e, shadow.id).catch(() => {});', ''], 'C: приём своего соседа зовёт пересылку', [], ['e.invalid']);
});
it('R208 контрфакт: шлюз не теряет групповой удалённый крючок', async () => {
  await killed(gatewayScenario, ['if (!deps.isRemote?.(uid)) deps.remoteGroupTyping?.(msg.dmId, uid, extra.action ?? \'typing\');', ''], 'C: шлюз зовёт удалённую группу ровно раз', 0, 1);
});
it('R208 контрфакт: шлюз не дублирует один удалённый групповой набор', async () => {
  const hook = "if (!deps.isRemote?.(uid)) deps.remoteGroupTyping?.(msg.dmId, uid, extra.action ?? 'typing');";
  await killed(gatewayScenario, [hook, `${hook}\n    ${hook}`], 'C: шлюз зовёт удалённую группу ровно раз', 2, 1);
});
it('R208 контрфакт: шлюз не шлёт от чужой теневой строки', async () => {
  await killed((m) => gatewayScenario(m, true), ['if (!deps.isRemote?.(uid)) deps.remoteGroupTyping?.(msg.dmId, uid, extra.action ?? \'typing\');', 'deps.remoteGroupTyping?.(msg.dmId, uid, extra.action ?? \'typing\');'], 'C: тень не зовёт удалённую группу', 1, 0);
});
