import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, beforeEach, test } from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import * as orm from 'drizzle-orm';
import * as ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as convRules from '../src/convRules.js';
import * as dmRules from '../src/dmRules.js';
import * as blockRules from '../src/blockRules.js';
import * as strangerRules from '../src/strangerRules.js';
import * as contactRules from '../src/contactRules.js';
import * as groupRules from '../src/groupRules.js';
import * as accountRules from '../src/accountRules.js';
import * as guestRules from '../src/federation/guestRules.js';
import * as scheduleRules from '../src/scheduleRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
beforeEach(async () => { await truncateAll(t.raw); });
after(async () => { await t.close(); });

type Mutation = readonly [string, string];
const fail = (name: string) => () => { throw new Error(`неожиданный вызов неявного IO ${name}`); };

/** Весь исходный модуль компилируется, а каждую runtime-зависимость нужно объявить явно. */
function moduleOf<T>(path: string, explicit: Record<string, unknown>, mutation?: Mutation): T {
  let source = readFileSync(new URL(`../src/${path}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation) {
    assert.equal(source.split(mutation[0]).length - 1, 1, `единственный якорь мутанта ${path}`);
    source = source.replace(...mutation);
  }
  const dependencies: Record<string, unknown> = {};
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const specifier = node.moduleSpecifier.text;
    if (Object.hasOwn(explicit, specifier)) {
      dependencies[specifier] = explicit[specifier];
      continue;
    }
    const exports: Record<string, unknown> = {};
    const bindings = node.importClause?.namedBindings;
    assert.ok(!bindings || ts.isNamedImports(bindings), `неописанный namespace-импорт ${path}:${specifier}`);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) {
        if (!item.isTypeOnly) exports[item.propertyName?.text ?? item.name.text] = fail(`${specifier}.${item.name.text}`);
      }
    }
    dependencies[specifier] = exports;
  }
  const module = { exports: {} as Record<string, unknown> };
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(output, {
    module,
    exports: module.exports,
    Date,
    Map,
    Set,
    Promise,
    Buffer,
    console,
    require: (specifier: string) => {
      assert.ok(Object.hasOwn(dependencies, specifier), `неописанный require ${path}:${specifier}`);
      return dependencies[specifier];
    },
  });
  return module.exports as T;
}

async function seedPair(features: string[] = ['reports']) {
  await t.db.insert(schema.users).values([
    { id: 'reporter', username: 'reporter', displayName: 'Автор', passwordHash: 'fixture', verified: true },
    { id: 'shadow', username: 'shadow@home-a', displayName: 'Собеседник', passwordHash: 'fixture', verified: true,
      homeInstanceId: 'home-a', homeUserId: 'home-user', homeUsername: 'home-user' },
  ]);
  await t.db.insert(schema.conversations).values({ id: 'dm', kind: 'direct', directKey: 'reporter:shadow', createdBy: 'reporter' });
  await t.db.insert(schema.conversationMembers).values([
    { conversationId: 'dm', userId: 'reporter' },
    { conversationId: 'dm', userId: 'shadow' },
  ]);
  await t.db.insert(schema.federationLinks).values({
    instanceId: 'home-a', domain: 'home-a.example', apiBase: 'https://home-a.example', clientOrigin: 'https://home-a.example',
    rootKey: 'fixture-public-key', state: 'active', features,
  });
}

function conversations() {
  return moduleOf<typeof import('../src/conversations.js')>('conversations', {
    '@gusvoice/shared': shared,
    'drizzle-orm': orm,
    './db/index.js': { db: t.db },
    './db/schema.js': schema,
    './convRules.js': convRules,
    './realtime.js': { publishToUser: async () => {} },
  });
}

function revocationModule(events: unknown[][], mutation?: Mutation) {
  return moduleOf<typeof import('../src/federation/guestRevocation.js')>('federation/guestRevocation', {
    'node:crypto': { randomUUID },
    'drizzle-orm': orm,
    '@gusvoice/shared': shared,
    '../db/index.js': { db: t.db },
    '../db/schema.js': schema,
    '../memberEvents.js': { memberChanged: fail('отправка отзыва не меняет местное членство') },
    '../env.js': { env: { federation: { enabled: true } } },
    '../auth.js': { bumpTokenGeneration: async () => 1 },
    '../livekit.js': { removeFromOtherRooms: async () => {} },
    '../realtime.js': { publishToUser: async () => {} },
    './eventStream.js': { onFedEvent: fail('onFedEvent'), queueEventTo: async (...args: unknown[]) => { events.push(args); } },
    // Здесь проверяется именно поиск ЛС-хоста; гостевые членства и поручительства отсутствуют в фикстуре.
    './guestMembership.js': { grantHostsOf: async () => [], hostsOf: async () => [] },
    './instance.js': { federation: {} },
    './peerClient.js': { getSignedFromPeer: fail('getSignedFromPeer') },
  }, mutation);
}

async function revokeScenario(mutation?: Mutation) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    { id: 'owner', username: 'owner', displayName: 'Автор', passwordHash: 'fixture', verified: true },
    { id: 'shadow', username: 'shadow@home-a', displayName: 'Сосед', passwordHash: 'fixture', verified: true,
      homeInstanceId: 'home-a', homeUserId: 'home-user', homeUsername: 'home-user' },
  ]);
  await t.db.insert(schema.conversations).values({ id: 'dm', kind: 'direct', directKey: 'owner:shadow', createdBy: 'owner' });
  await t.db.insert(schema.conversationMembers).values([
    { conversationId: 'dm', userId: 'owner' }, { conversationId: 'dm', userId: 'shadow' },
  ]);
  const events: unknown[][] = [];
  const module = revocationModule(events, mutation);
  const hosts = await module.revokeAccountEverywhere({ userId: 'owner', now: 1_760_270_600_000 });
  assert.deepEqual([...hosts], ['home-a'], 'только дом собеседника из личной беседы должен получить отзыв аккаунта');
  const rows = await t.db.select().from(schema.federationRevocations);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.instanceId, 'home-a');
  assert.equal(rows[0]?.kind, 'revoked');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.[0], 'home-a');
}

test('R191 удаление автора лички адресует отзыв дому peer даже без гостевой сессии', async () => {
  // Класс ошибки: расчёт только по чужим сессиям оставляет теневую копию собеседника действующей.
  const mutant: Mutation = [
    "...(input.kind === 'revoked' ? await dmHostsOf(input.userId) : []),",
    "...(input.kind === 'sessions' ? await dmHostsOf(input.userId) : []),",
  ];
  await revokeScenario();
  await assert.rejects(revokeScenario(mutant), (error: unknown) =>
    error instanceof assert.AssertionError && error.message.includes('только дом собеседника из личной беседы'),
  );
});

function profileModule(revocation: typeof import('../src/federation/guestRevocation.js'), io: { hashes: number; broadcasts: unknown[][] }) {
  return moduleOf<typeof import('../src/federation/guestProfile.js')>('federation/guestProfile', {
    'node:crypto': { randomBytes: () => Buffer.from([1, 2, 3]) },
    'drizzle-orm': orm,
    '@gusvoice/shared': shared,
    '../db/index.js': { db: t.db },
    '../db/schema.js': schema,
    '../accountRules.js': accountRules,
    '../auth.js': {
      hashPassword: async () => { io.hashes += 1; return 'fixture-unusable-password-hash'; },
      forgetTokenGeneration: () => {},
    },
    '../gateway.js': { broadcastUserProfile: async (...args: unknown[]) => { io.broadcasts.push(args); } },
    './avatars.js': { refreshGuestAvatar: fail('refreshGuestAvatar') },
    './guestRevocation.js': revocation,
  });
}

test('R191 отзыв аккаунта обезличивает теневую строку, а повтор не запускает профильный hook снова', async () => {
  // Класс ошибки: повторная доставка отзыва затирает уже установленное надгробие или повторно рассылает профиль.
  await t.db.insert(schema.users).values({
    id: 'shadow', username: 'shadow@home-a', displayName: 'Собеседник', passwordHash: 'fixture', verified: true,
    homeInstanceId: 'home-a', homeUserId: 'home-user', homeUsername: 'home-user',
  });
  await t.db.insert(schema.users).values({ id: 'owner', username: 'owner', displayName: 'Владелец', passwordHash: 'fixture' });
  await t.db.insert(schema.servers).values([
    { id: 'active', name: 'Активный', ownerId: 'owner' },
    { id: 'closed', name: 'Уже закрытый', ownerId: 'owner' },
  ]);
  await t.db.insert(schema.serverMembers).values([
    { serverId: 'active', userId: 'shadow', state: 'active' },
    { serverId: 'closed', userId: 'shadow', state: 'closed_by_host' },
    { serverId: 'active', userId: 'owner', state: 'active' },
  ]);
  const io = { hashes: 0, broadcasts: [] as unknown[][], tokenBumps: [] as string[],
    memberChanges: [] as import('../src/memberEvents.js').MemberChange[] };
  const memberEvents = moduleOf<typeof import('../src/memberEvents.js')>('memberEvents', {});
  memberEvents.configureMemberBots({ changed: async change => { io.memberChanges.push({ ...change }); } });
  // Обе сессии и голос — реальные side effects не нужны; фикстура изолирует DB-запись и профильный hook.
  const revocation = moduleOf<typeof import('../src/federation/guestRevocation.js')>('federation/guestRevocation', {
    'node:crypto': { randomUUID }, 'drizzle-orm': orm, '@gusvoice/shared': shared,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../memberEvents.js': memberEvents,
    '../env.js': { env: { federation: { enabled: true } } },
    '../auth.js': { bumpTokenGeneration: async (id: string) => { io.tokenBumps.push(id); return io.tokenBumps.length; } },
    '../livekit.js': { removeFromOtherRooms: async () => {} }, '../realtime.js': { publishToUser: async () => {} },
    './eventStream.js': { onFedEvent: fail('onFedEvent'), queueEventTo: fail('queueEventTo') },
    './guestMembership.js': { grantHostsOf: async () => [], hostsOf: async () => [] },
    './instance.js': { federation: {} }, './peerClient.js': { getSignedFromPeer: fail('getSignedFromPeer') },
  });
  const profile = profileModule(revocation, io);
  revocation.configureShadowGone(profile.anonymizeShadow);
  const input = { instanceId: 'home-a', homeUserId: 'home-user', gen: null, account: true } as const;
  assert.equal(await revocation.applyRevocation(input), true);
  const [first] = await t.db.select().from(schema.users).where(orm.eq(schema.users.id, 'shadow'));
  assert.ok(first?.deletedAt instanceof Date);
  assert.equal(first.displayName, 'Удалённый пользователь');
  assert.equal(first.homeUsername, null);
  const deletedAt = first.deletedAt.getTime();
  assert.equal(io.hashes, 1);
  assert.equal(io.broadcasts.length, 1);
  assert.deepEqual(io.memberChanges, [{ serverId: 'active', userId: 'shadow', actorId: null, from: 'member', to: 'left' }],
    'событие отзыва касается только прежде активного членства гостя');
  const memberships = await t.db.select().from(schema.serverMembers).orderBy(schema.serverMembers.serverId, schema.serverMembers.userId);
  assert.deepEqual(memberships.map(row => [row.serverId, row.userId, row.state]), [
    ['active', 'owner', 'active'], ['active', 'shadow', 'removed'], ['closed', 'shadow', 'removed'],
  ], 'отзыв снимает все членства гостя, но не трогает другого участника');

  assert.equal(await revocation.applyRevocation(input), true);
  const [again] = await t.db.select().from(schema.users).where(orm.eq(schema.users.id, 'shadow'));
  assert.equal(again?.deletedAt?.getTime(), deletedAt);
  assert.equal(again?.displayName, 'Удалённый пользователь');
  assert.equal(io.hashes, 1);
  assert.equal(io.broadcasts.length, 1);
  assert.equal(io.memberChanges.length, 1, 'повтор отзыва не создаёт второе событие выхода');
});

function reportModules(eventCalls: unknown[][], deliveryCalls: unknown[][]) {
  const conv = conversations();
  const realReportAccess = { lockConversation: conv.lockConversation, journal: conv.journal };
  const dmReports = moduleOf<typeof import('../src/dmReports.js')>('dmReports', {
    './conversations.js': realReportAccess,
    'drizzle-orm': orm,
    './db/index.js': { db: t.db }, './db/schema.js': schema,
    './strangerRules.js': strangerRules,
    './util.js': { uuidv7: randomUUID },
  });
  const instanceBan = moduleOf<typeof import('../src/federation/instanceBan.js')>('federation/instanceBan', {
    'node:crypto': { randomUUID }, 'drizzle-orm': orm, '@gusvoice/shared': shared,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../env.js': { env: { federation: { enabled: true } } },
    '../auth.js': { bumpTokenGeneration: fail('bumpTokenGeneration') },
    '../livekit.js': { removeFromOtherRooms: fail('removeFromOtherRooms') },
    '../realtime.js': { publishToUser: fail('publishToUser') },
    './guestRules.js': guestRules,
    './guestMembership.js': { announceMembership: fail('announceMembership') },
    './eventStream.js': { onFedEvent: fail('onFedEvent'), queueEventTo: async (...args: unknown[]) => { eventCalls.push(args); } },
    './guestAccess.js': { CLOSE_REASONS: {} },
  });
  const convLink = moduleOf<typeof import('../src/federation/convLink.js')>('federation/convLink', {
    'drizzle-orm': orm, '@gusvoice/shared': shared,
    '../conversations.js': realReportAccess,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    './instanceMeta.js': { readInstanceMeta: fail('readInstanceMeta') },
    './instanceBan.js': { sendReport: instanceBan.sendReport },
  });
  const routeConv = moduleOf<typeof import('../src/routes/conv.js')>('routes/conv', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: { z },
    '../auth.js': { requireAuth: async (req: FastifyRequest) => { req.user = { sub: 'reporter', username: 'reporter' }; }, isSuperAdmin: () => false },
    '../authGuard.js': { messageSendBlock: async () => 0, pushDebounced: fail('pushDebounced'), rateHit: async () => 0, retryMessage: fail('retryMessage') },
    '../guestGuard.js': { requireLocalUser: async () => {} },
    './att.js': { acceptDmUpload: fail('acceptDmUpload'), convAttachmentRefsSchema: z.array(z.unknown()) },
    '../stickerCatalog.js': { catalogSticker: fail('catalogSticker') },
    '../blockRules.js': blockRules,
    '../blocks.js': { blockedBy: fail('blockedBy'), isBlockedBy: fail('isBlockedBy') },
    '../conversations.js': {
      loadAccess: conv.loadAccess,
      deliver: async (...args: unknown[]) => { deliveryCalls.push(args); },
    },
    '../convSendFanout.js': { fanOutSend: fail('fanOutSend'), pushGroupPack: fail('pushGroupPack') },
    '../dmReports.js': dmReports,
    '../strangerRules.js': strangerRules,
    '../scheduled.js': {
      createScheduled: fail('createScheduled'), deleteScheduled: fail('deleteScheduled'),
      editScheduled: fail('editScheduled'), sendScheduledNow: fail('sendScheduledNow'),
    },
    '../scheduleRules.js': scheduleRules,
    '../convRules.js': convRules,
    '../contacts.js': { contactNamesFor: fail('contactNamesFor') },
    '../contactRules.js': contactRules,
    '../db/index.js': { db: t.db }, '../realtime.js': { publishToUser: fail('publishToUser') },
    './dmFolders.js': { publishDmFolders: fail('publishDmFolders') },
    '../db/peerQueries.js': { shareServer: fail('shareServer') },
    '../lastSeen.js': { canScheduleUntilOnline: fail('canScheduleUntilOnline'), readAtFor: fail('readAtFor') },
    '../db/schema.js': schema,
    '../dmRules.js': dmRules,
    '../instanceSetup.js': { dmPolicy: fail('dmPolicy') },
    '../userSearchRules.js': { reachableUser: fail('reachableUser') },
    '../push.js': {
      forwardPreview: fail('forwardPreview'), pushThrottleSource: fail('pushThrottleSource'),
      sendPushToUsers: fail('sendPushToUsers'), sendReadSyncPush: fail('sendReadSyncPush'), withSilent: fail('withSilent'),
    },
    '../superAdminRules.js': { asUserId: fail('asUserId') },
  });
  routeConv.configureFedDmReport(convLink.reportFedDmPeer);
  const app = Fastify();
  return { app, register: routeConv.convRoutes, dmReports, eventCalls, deliveryCalls };
}

async function reportScenario(features: string[]) {
  await truncateAll(t.raw);
  await seedPair(features);
  const eventCalls: unknown[][] = [], deliveryCalls: unknown[][] = [];
  const f = reportModules(eventCalls, deliveryCalls);
  await f.app.register(f.register); await f.app.ready();
  try {
    const response = await f.app.inject({ method: 'POST', url: '/conv/dm/report', payload: { reason: 'spam', comment: 'лишняя реклама' } });
    assert.equal(response.statusCode, 200, 'местная жалоба сохраняется независимо от признака соседа');
    const localRows = await t.db.select().from(schema.dmReports);
    assert.equal(localRows.length, 1);
    assert.equal(localRows[0]?.reportedId, 'shadow');
    assert.equal(localRows[0]?.reason, 'spam');
    const outgoing = await t.db.select().from(schema.federationReports);
    assert.equal(outgoing.length, features.includes('reports') ? 1 : 0,
      'исходящая жалоба существует только при поддержке reports у активной связки');
    if (features.includes('reports')) {
      assert.equal(outgoing[0]?.direction, 'out');
      assert.equal(outgoing[0]?.instanceId, 'home-a');
      assert.equal(outgoing[0]?.action, 'dm_report');
      assert.equal(outgoing[0]?.reportedUserId, 'home-user');
      assert.equal(outgoing[0]?.reason, 'spam: лишняя реклама');
      assert.equal(eventCalls.length, 1);
      assert.equal(eventCalls[0]?.[0], 'home-a');
      assert.equal(eventCalls[0]?.[1], shared.FED_EVENTS.reportCreate);
      const wire = eventCalls[0]?.[2] as Record<string, unknown>;
      const event = shared.parseFedEvent({ event_id: randomUUID(), seq: 1, kind: shared.FED_EVENTS.reportCreate,
        created_at: wire.created_at, payload: wire });
      assert.equal(event?.payload.action, 'dm_report');
      assert.equal(event?.payload.reported_user_id, 'home-user');

      const fixture = JSON.parse(readFileSync(new URL('../../shared/src/federation/fixtures/v1/event-report-create-dm.json', import.meta.url), 'utf8')) as { events: Record<string, unknown>[] };
      const historical = shared.parseFedEvent(fixture.events[0]);
      assert.equal(historical?.payload.action, 'dm_report');
      assert.equal(historical?.payload.server_name, null);
    } else {
      assert.equal(eventCalls.length, 0);
    }
    assert.equal(deliveryCalls.length, 1, 'местное уведомление о жалобе не зависит от пересылки соседу');
  } finally { await f.app.close(); }
}

test('R191 жалоба в личке уходит дому гостя как out/dm_report, а без reports остаётся только местной', async () => {
  // Класс ошибки: жалоба не достигает владельца дома либо отсутствие функции соседа стирает местную жалобу.
  await reportScenario(['reports']);
  await reportScenario([]);
});
