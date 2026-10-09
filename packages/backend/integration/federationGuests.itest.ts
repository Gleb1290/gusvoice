import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, beforeEach, test } from 'node:test';
import ts from 'typescript';
import {
  FED_ERRORS,
  FED_EVENTS,
  Permission,
  serializeFedEvent,
  serializeMembershipEvent,
} from '@gusvoice/shared';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
let preview: typeof import('../src/federation/invitePreview.js');
let quota: typeof import('../src/federation/guestQuota.js');
let revocation: typeof import('../src/federation/guestRevocation.js');
let profile: typeof import('../src/federation/guestProfile.js');
let bans: typeof import('../src/federation/instanceBan.js');
let permissions: typeof import('../src/permissions.js');
let avatars: typeof import('../src/federation/avatars.js');
let membership: typeof import('../src/federation/guestMembership.js');
let guestPush: typeof import('../src/federation/guestPush.js');
let guestHome: typeof import('../src/federation/guestHome.js');
let guestAccess: typeof import('../src/federation/guestAccess.js');
let receiveEvents: typeof import('../src/federation/eventStream.js').receiveEvents;
let resolveMentionedMembers: typeof import('../src/push.js').resolveMentionedMembers;

before(async () => {
  // Нужна реальная запись события в исходящую очередь для проверки payload жалобы.
  process.env.FEDERATION_ENABLED = 'true';
  t = await createTestDb();
  preview = await import('../src/federation/invitePreview.js');
  quota = await import('../src/federation/guestQuota.js');
  revocation = await import('../src/federation/guestRevocation.js');
  profile = await import('../src/federation/guestProfile.js');
  bans = await import('../src/federation/instanceBan.js');
  permissions = await import('../src/permissions.js');
  avatars = await import('../src/federation/avatars.js');
  membership = await import('../src/federation/guestMembership.js');
  guestPush = await import('../src/federation/guestPush.js');
  guestHome = await import('../src/federation/guestHome.js');
  guestAccess = await import('../src/federation/guestAccess.js');
  ({ receiveEvents } = await import('../src/federation/eventStream.js'));
  ({ resolveMentionedMembers } = await import('../src/push.js'));
  membership.registerMembershipHandlers();
  bans.registerReportHandlers();
});
beforeEach(async () => truncateAll(t.raw));
after(async () => {
  (await import('../src/realtime.js')).redisPub.disconnect();
  await t.close();
});

async function seedServer(): Promise<void> {
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash)
    VALUES ('owner', 'owner', 'Owner', 'hash'), ('local', 'local', 'Local', 'hash');
    INSERT INTO servers (id, name, owner_id, federated_access)
    VALUES ('server', 'Стая', 'owner', true);
    INSERT INTO server_members (server_id, user_id) VALUES ('server', 'owner'), ('server', 'local')
  `);
}

async function seedLink(instanceId: string, usedBytes = 0, quotaBytes = 100): Promise<void> {
  await t.raw.exec(`
    INSERT INTO federation_links
      (instance_id, domain, api_base, client_origin, root_key, state, used_bytes, quota_bytes)
    VALUES
      ('${instanceId}', '${instanceId}.example', 'https://${instanceId}.example/api',
       'https://${instanceId}.example', 'root', 'active', ${usedBytes}, ${quotaBytes})
  `);
}

test('предпросмотр отдаёт полную карточку действующей ссылки, а отказ — только код без данных сервера', async () => {
  // Ловит превращение перебора шестизначных кодов в разведку имён закрытых серверов.
  await seedServer();
  await t.raw.exec(`
    INSERT INTO invites (code, server_id, inviter_id, expires_at)
    VALUES
      ('OPEN01', 'server', 'owner', '2030-01-01T00:00:00Z'),
      ('FOREVER', 'server', 'owner', NULL)
  `);
  const ok = await preview.previewForPeer({ code: 'OPEN01', peerInstanceId: 'peer', now: 1_800_000_000_000 });
  assert.deepEqual(ok, {
    ok: true,
    preview: {
      code: 'OPEN01', serverId: 'server', serverName: 'Стая', iconHash: null, members: 2,
      expiresAt: Date.parse('2030-01-01T00:00:00Z'),
    },
  });
  assert.deepEqual(
    await preview.previewForPeer({ code: 'FOREVER', peerInstanceId: 'peer', now: 1_800_000_000_000 }),
    { ok: false, problem: FED_ERRORS.inviteNoExpiry },
  );
});

test('исключение закрывает одну и ту же ссылку только для указанной связки', async () => {
  // Ловит применение посерверного исключения ко всем соседям вместо одного.
  await seedServer();
  await t.raw.exec(`
    INSERT INTO invites (code, server_id, inviter_id, expires_at)
    VALUES ('INVITE', 'server', 'owner', '2030-01-01T00:00:00Z');
    INSERT INTO server_federation_exclusions (server_id, instance_id) VALUES ('server', 'peer-a')
  `);
  assert.deepEqual(
    await preview.previewForPeer({ code: 'INVITE', peerInstanceId: 'peer-a', now: 1_800_000_000_000 }),
    { ok: false, problem: FED_ERRORS.serverClosed },
  );
  assert.equal((await preview.previewForPeer({ code: 'INVITE', peerInstanceId: 'peer-b', now: 1_800_000_000_000 })).ok, true);
});

test('квота гостя из одной связки не касается местного и гостя другой связки', async () => {
  // Ловит общий счётчик хранилища, из-за которого один сосед блокировал бы загрузки всех остальных.
  await seedServer();
  await seedLink('peer-a', 90, 100);
  await seedLink('peer-b', 0, 0);
  await t.raw.exec(`
    INSERT INTO users
      (id, username, display_name, password_hash, home_instance_id, home_user_id)
    VALUES
      ('guest-a', 'a@peer-a', 'A', 'hash', 'peer-a', 'a'),
      ('guest-b', 'b@peer-b', 'B', 'hash', 'peer-b', 'b')
  `);
  // Проверка и занятие места слились в одну операцию (`reserveQuota`) — см. FROM-CLAUDE.md 16.09:
  // раздельные «проверить» и «прибавить» обходились двумя одновременными загрузками.
  assert.equal(await quota.reserveQuota('local', 1_000_000), null);
  // Не влезло — и место при этом НЕ занято: следующий вызов ровно на предел обязан пройти.
  assert.equal(await quota.reserveQuota('guest-a', 11), FED_ERRORS.quotaExceeded);
  assert.equal(await quota.reserveQuota('guest-a', 10), null);
  assert.equal(await quota.reserveQuota('guest-b', 1_000_000), null);
  await quota.releaseQuota('guest-a', 3);
  const rows = await t.raw.query<{ instance_id: string; used_bytes: number }>(
    `SELECT instance_id, used_bytes FROM federation_links ORDER BY instance_id`,
  );
  assert.deepEqual(rows.rows, [
    { instance_id: 'peer-a', used_bytes: 97 },
    { instance_id: 'peer-b', used_bytes: 1_000_000 },
  ]);
});

test('закрытое членство не даёт контекст, а роль «Гости» заменяет права everyone', async () => {
  // Ловит доступ закрытого гостя через забытый маршрут и невозможность сузить гостевые права.
  await seedServer();
  await t.raw.exec(`
    INSERT INTO users
      (id, username, display_name, password_hash, home_instance_id, home_user_id)
    VALUES
      ('guest-open', 'open@peer', 'Open', 'hash', 'peer', 'open'),
      ('guest-closed', 'closed@peer', 'Closed', 'hash', 'peer', 'closed');
    INSERT INTO server_members (server_id, user_id, state)
    VALUES ('server', 'guest-open', 'active'), ('server', 'guest-closed', 'closed_by_host');
    INSERT INTO roles (id, server_id, name, permissions, is_everyone)
    VALUES ('everyone', 'server', 'everyone', '${Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES}', true);
    INSERT INTO roles (id, server_id, name, permissions, is_guests)
    VALUES ('guests', 'server', 'guests', '${Permission.VIEW_CHANNEL}', true)
  `);
  const local = await permissions.getMemberContext('server', 'local');
  const guest = await permissions.getMemberContext('server', 'guest-open');
  assert.equal(local?.serverPermissions, Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES);
  assert.equal(guest?.serverPermissions, Permission.VIEW_CHANNEL);
  assert.deepEqual(guest?.roleIds, ['guests']);
  assert.equal(await permissions.getMemberContext('server', 'guest-closed'), null);
});

test('закрытый и удалённый гость не попадают в адресную аудиторию канала', async () => {
  // Ловит рассылку тела сообщения по сокету тем, кого REST уже считает вышедшими с сервера.
  await seedServer();
  await seedLink('peer');
  await t.raw.exec(`
    INSERT INTO users
      (id, username, display_name, password_hash, home_instance_id, home_user_id)
    VALUES
      ('guest-open', 'open@peer', 'Open', 'hash', 'peer', 'open'),
      ('guest-closed', 'closed@peer', 'Closed', 'hash', 'peer', 'closed'),
      ('guest-removed', 'removed@peer', 'Removed', 'hash', 'peer', 'removed');
    INSERT INTO server_members (server_id, user_id, state) VALUES
      ('server', 'guest-open', 'active'),
      ('server', 'guest-closed', 'closed_by_host'),
      ('server', 'guest-removed', 'removed');
    INSERT INTO roles (id, server_id, name, permissions, is_everyone)
    VALUES ('everyone', 'server', 'everyone', '${Permission.VIEW_CHANNEL}', true);
    INSERT INTO roles (id, server_id, name, permissions, is_guests)
    VALUES ('guests', 'server', 'guests', '${Permission.VIEW_CHANNEL}', true);
    INSERT INTO channels (id, server_id, name, type) VALUES ('channel', 'server', 'chat', 'text')
  `);
  const result = await permissions.getChannelAudience('channel');
  assert.equal(result?.serverId, 'server');
  assert.deepEqual(result?.userIds.sort(), ['guest-open', 'local', 'owner']);
});

test('@everyone будит только видящих канал участников, а @here и вызов без канала — никого', async () => {
  // Ловит пустой @everyone, пуш автору и пробуждение человека, которому канал закрыт правами.
  await seedServer();
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES
      ('visible', 'visible', 'Visible', 'hash'),
      ('hidden', 'hidden', 'Hidden', 'hash');
    INSERT INTO server_members (server_id, user_id) VALUES
      ('server', 'visible'), ('server', 'hidden');
    INSERT INTO roles (id, server_id, name, permissions, is_everyone)
    VALUES ('everyone', 'server', 'everyone', '${Permission.VIEW_CHANNEL}', true);
    INSERT INTO channels (id, server_id, name, type) VALUES ('channel', 'server', 'chat', 'text');
    INSERT INTO channel_overwrites (channel_id, target_id, target_type, deny)
    VALUES ('channel', 'hidden', 'member', '${Permission.VIEW_CHANNEL}')
  `);
  assert.deepEqual(
    (await resolveMentionedMembers('@everyone', 'server', 'owner', 'channel')).sort(),
    ['local', 'visible'],
  );
  assert.deepEqual(await resolveMentionedMembers('@here', 'server', 'owner', 'channel'), []);
  assert.deepEqual(await resolveMentionedMembers('@everyone', 'server', 'owner'), []);
});

test('приём останавливается на двадцати жалобах одной связки за сутки', async () => {
  // Ловит неограниченный поток писем и строк аудита от одного соседа.
  await seedLink('peer');
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash)
    SELECT 'reported-' || i, 'reported-' || i, 'Reported', 'hash' FROM generate_series(1, 21) AS i
  `);
  const events = Array.from({ length: 21 }, (_, i) => serializeFedEvent({
    eventId: `report-${i + 1}`,
    seq: i + 1,
    kind: FED_EVENTS.reportCreate,
    createdAt: 10_000 + i,
    payload: {
      report_id: `r-${i + 1}`,
      reported_user_id: `reported-${i + 1}`,
      action: 'server_ban',
      evidence: [],
    },
  }));
  await receiveEvents('peer', events);
  const count = await t.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM federation_reports WHERE direction = 'in'");
  assert.equal(count.rows[0]?.n, 20);
});

test('повтор report_id дополняет ту же жалобу без дублей и не больше пяти улик', async () => {
  // Ловит вторую строку от повторной доставки и бесконечное разрастание массива доказательств.
  await seedLink('peer');
  await t.raw.exec("INSERT INTO users (id, username, display_name, password_hash) VALUES ('reported', 'reported', 'Reported', 'hash')");
  const payload = (reason: string, evidence: { text: string; at: number; channel: string }[]) => ({
    report_id: 'same-report', reported_user_id: 'reported', action: 'server_ban', reason, evidence,
  });
  await receiveEvents('peer', [
    serializeFedEvent({ eventId: 'report-first', seq: 1, kind: FED_EVENTS.reportCreate, createdAt: 1,
      payload: payload('first', [1, 2, 3, 4].map((n) => ({ text: `e${n}`, at: n, channel: 'chat' }))) }),
    serializeFedEvent({ eventId: 'report-more', seq: 2, kind: FED_EVENTS.reportCreate, createdAt: 2,
      payload: payload('updated', [3, 4, 5, 6].map((n) => ({ text: `e${n}`, at: n, channel: 'chat' }))) }),
  ]);
  const rows = await t.raw.query<{ report_id: string; reason: string; evidence: { text: string }[] }>(
    "SELECT report_id, reason, evidence FROM federation_reports WHERE direction = 'in'",
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0]?.report_id, 'same-report');
  assert.equal(rows.rows[0]?.reason, 'updated');
  assert.deepEqual(rows.rows[0]?.evidence.map((e) => e.text), ['e1', 'e2', 'e3', 'e4', 'e5']);
});

test('две исходящие жалобы на человека склеивают причину и в строке, и в событии соседу', async () => {
  // Без проверки payload локальная запись могла бы выглядеть правильно, а держатель соседнего сервера видел бы только вторую причину.
  await seedLink('peer');
  const sender = await import('../src/federation/instanceBan.js');
  const now = Date.now();
  const first = await sender.sendReport({ instanceId: 'peer', reportedUserId: 'guest', action: 'server_ban', serverName: 'Стая', reason: 'r1', evidence: [], now });
  assert.equal(first.ok, true);
  const second = await sender.sendReport({ instanceId: 'peer', reportedUserId: 'guest', action: 'server_ban', serverName: 'Стая', reason: 'r2', evidence: [], now: now + 1 });
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) assert.fail('обе жалобы должны быть приняты');
  assert.equal(first.reportId, second.reportId, 'повтор должен приклеиться к исходной жалобе');
  const out = await t.raw.query<{ report_id: string; reason: string }>("SELECT report_id, reason FROM federation_reports WHERE direction = 'out'");
  assert.deepEqual(out.rows, [{ report_id: first.reportId, reason: 'r1\nr2' }]);
  const events = await t.raw.query<{ kind: string; payload: { report_id: string; reason: string } }>(
    "SELECT kind, payload FROM federation_outbox WHERE instance_id = 'peer' ORDER BY seq",
  );
  assert.equal(events.rows.length, 2, 'обе отправки отражены в очереди событий');
  assert.deepEqual(events.rows.map((row) => [row.kind, row.payload.report_id, row.payload.reason]), [
    [FED_EVENTS.reportCreate, first.reportId, 'r1'],
    [FED_EVENTS.reportCreate, first.reportId, 'r1\nr2'],
  ]);

  // Мутант прежнего поведения (`input.reason ?? existing.reason`) обязан терять r1 и провалить ту же проверку.
  await seedLink('peer-mutant');
  const instanceBanSource = readFileSync(new URL('../src/federation/instanceBan.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const mutatedSource = instanceBanSource.replace(
    'const reason = mergeReportReason(existing.reason, input.reason);',
    'const reason = input.reason ?? existing.reason;',
  );
  assert.notEqual(mutatedSource, instanceBanSource, 'мутант заменил склейку на прежнее затирание');
  const deps: Record<string, unknown> = {
    'node:crypto': await import('node:crypto'), 'drizzle-orm': await import('drizzle-orm'),
    '@gusvoice/shared': await import('@gusvoice/shared'), '../db/index.js': await import('../src/db/index.js'),
    '../db/schema.js': await import('../src/db/schema.js'), '../env.js': await import('../src/env.js'),
    '../auth.js': await import('../src/auth.js'), '../livekit.js': await import('../src/livekit.js'),
    '../realtime.js': await import('../src/realtime.js'), './guestRules.js': await import('../src/federation/guestRules.js'),
    './guestMembership.js': await import('../src/federation/guestMembership.js'), './eventStream.js': await import('../src/federation/eventStream.js'),
    './guestAccess.js': await import('../src/federation/guestAccess.js'),
  };
  const mutantModule = { exports: {} as Record<string, unknown> };
  const mutantCode = ts.transpileModule(mutatedSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(mutantCode, { module: mutantModule, exports: mutantModule.exports, Date, Map, Set, Buffer, Promise,
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `добавлена зависимость мутанта ${id}`); return deps[id]; } });
  const mutantSender = mutantModule.exports as unknown as typeof sender;
  const mutantNow = Date.now();
  await mutantSender.sendReport({ instanceId: 'peer-mutant', reportedUserId: 'guest-mutant', action: 'server_ban', serverName: 'Стая', reason: 'm1', evidence: [], now: mutantNow });
  await mutantSender.sendReport({ instanceId: 'peer-mutant', reportedUserId: 'guest-mutant', action: 'server_ban', serverName: 'Стая', reason: 'm2', evidence: [], now: mutantNow + 1 });
  const mutantRow = await t.raw.query<{ reason: string }>("SELECT reason FROM federation_reports WHERE direction = 'out' AND instance_id = 'peer-mutant'");
  assert.throws(() => assert.deepEqual(mutantRow.rows[0]?.reason, 'm1\nm2'), assert.AssertionError,
    'мутант затирает m1 и должен провалить ожидание склейки');
});

test('разные входящие report_id одного человека добавляют причины, а не затирают первую', async () => {
  // Разные ID — это отдельные жалобы соседа на того же человека; в журнале держателя должны сохраниться обе причины.
  await seedLink('peer');
  await t.raw.exec("INSERT INTO users (id, username, display_name, password_hash) VALUES ('reported', 'reported', 'Reported', 'hash')");
  const incoming = (eventId: string, seq: number, reportId: string, reason: string) => serializeFedEvent({
    eventId, seq, kind: FED_EVENTS.reportCreate, createdAt: 10_000 + seq,
    payload: { report_id: reportId, reported_user_id: 'reported', action: 'server_ban', reason, evidence: [] },
  });
  await receiveEvents('peer', [incoming('different-a', 1, 'report-A', 'A'), incoming('different-b', 2, 'report-B', 'B')]);
  const rows = await t.raw.query<{ report_id: string; reason: string }>(
    "SELECT report_id, reason FROM federation_reports WHERE direction = 'in' AND instance_id = 'peer'",
  );
  assert.equal(rows.rows.length, 1, 'разные ID склеиваются в одну запись для человека');
  assert.deepEqual(rows.rows[0], { report_id: 'report-A', reason: 'A\nB' });
});

test('событие членства принимается только после нашего поручительства и соблюдает предел индекса', async () => {
  // Ловит возможность соседа объявить гостем любого нашего человека и бесконечно растить его индекс.
  await seedServer();
  await seedLink('peer');
  assert.equal(t.appliedMigrations.includes('0070_federation_guest_grants.sql'), true);
  const rawEvent = (seq: number, serverId: string, serverName: string) => serializeFedEvent({
    eventId: `membership-${seq}`,
    seq,
    kind: FED_EVENTS.membershipChanged,
    createdAt: 1_000 + seq,
    payload: serializeMembershipEvent({
      userId: 'local', serverId, serverName, state: 'active', method: null, invitedBy: null, reason: null, at: 1_000 + seq,
    }),
  });

  await receiveEvents('peer', [rawEvent(1, 'forged', 'Подсунутый сервер')]);
  assert.deepEqual(await membership.guestMembershipsOf('local'), []);

  await t.raw.exec(`INSERT INTO federation_guest_grants (user_id, instance_id) VALUES ('local', 'peer')`);
  await receiveEvents('peer', [rawEvent(2, 'real', 'Я'.repeat(5_000))]);
  const accepted = await membership.guestMembershipsOf('local');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]?.serverName.length, 100);

  const values = Array.from({ length: 199 }, (_, index) =>
    `('peer', 'local', 'seed-${index}', 'Seed', 'active', ${2_000 + index})`,
  ).join(',');
  await t.raw.exec(`
    INSERT INTO federation_memberships
      (instance_id, user_id, server_id, server_name, state, updated_at)
    VALUES ${values}
  `);
  await receiveEvents('peer', [rawEvent(3, 'over-limit', 'Лишний')]);
  const rows = await t.raw.query<{ server_id: string }>(
    `SELECT server_id FROM federation_memberships WHERE instance_id = 'peer' AND user_id = 'local'`,
  );
  assert.equal(rows.rows.length, 200);
  assert.equal(rows.rows.some((row) => row.server_id === 'over-limit'), false);
});

test('полная сверка не обходит поручительство, а удаление аккаунта стирает его', async () => {
  // Ловит второй путь подложного членства и осиротевшее разрешение после удаления человека.
  await seedServer();
  await seedLink('peer');
  assert.deepEqual(await membership.reconcileMemberships('peer', [{
    userId: 'local', serverId: 'forged', serverName: 'Подсунутый', state: 'active', method: null, invitedBy: null,
  }], 5_000), { added: 0, removed: 0 });
  assert.deepEqual(await membership.guestMembershipsOf('local'), []);

  await t.raw.exec(`INSERT INTO federation_guest_grants (user_id, instance_id) VALUES ('local', 'peer')`);
  assert.deepEqual(await membership.reconcileMemberships('peer', [{
    userId: 'local', serverId: 'real', serverName: 'Настоящий', state: 'active', method: null, invitedBy: null,
  }], 6_000), { added: 1, removed: 0 });
  assert.equal((await membership.guestMembershipsOf('local')).length, 1);

  await t.raw.exec(`DELETE FROM users WHERE id = 'local'`);
  const grants = await t.raw.query(`SELECT 1 FROM federation_guest_grants WHERE user_id = 'local'`);
  assert.equal(grants.rows.length, 0);
});

test('журнал отзывов выдаёт только записи строго новее курсора и держит стабильный порядок', async () => {
  // Ловит повтор старого отзыва либо пропуск двух отзывов с одинаковыми часами.
  await t.raw.exec(`
    INSERT INTO federation_revocations (id, user_id, kind, gen, created_at) VALUES
      ('b', 'u', 'sessions', 2, 1000),
      ('a', 'u', 'sessions', 1, 1000),
      ('c', 'u', 'revoked', NULL, 1001)
  `);
  assert.deepEqual((await revocation.revocationsSince(1000)).map((row) => row.id), ['c']);
  assert.deepEqual((await revocation.revocationsSince(null, null, 2)).map((row) => row.id), ['a', 'b']);
});

test('скрытие в каталоге не трогает гостя, а переименование обновляет ту же теневую строку', async () => {
  // Ловит обезличивание законного гостя по административному скрытию из каталога.
  await t.raw.exec(`
    INSERT INTO users
      (id, username, display_name, password_hash, home_instance_id, home_user_id, home_username)
    VALUES ('shadow', 'old@peer', 'Старое имя', 'hash', 'peer', 'home-u', 'old')
  `);
  assert.equal(await profile.applyGuestProfile('peer', {
    userId: 'home-u', updatedAt: 10, removed: 'hidden',
  }), false);
  assert.equal(await profile.applyGuestProfile('peer', {
    userId: 'home-u', updatedAt: 11, username: 'new', displayName: 'Новое имя', avatarHash: null,
  }), true);
  const row = await t.raw.query<{ id: string; display_name: string; home_username: string; deleted_at: Date | null }>(
    `SELECT id, display_name, home_username, deleted_at FROM users WHERE id = 'shadow'`,
  );
  assert.deepEqual(row.rows[0], {
    id: 'shadow', display_name: 'Новое имя', home_username: 'new', deleted_at: null,
  });
});

test('устаревшее поколение и незнакомый отзыв ничего не меняют', async () => {
  // Ловит оживление старых сессий после отката дома и создание теневой строки из одного отзыва.
  await t.raw.exec(`
    INSERT INTO users
      (id, username, display_name, password_hash, home_instance_id, home_user_id, home_gen, token_generation)
    VALUES ('shadow', 'u@peer', 'Guest', 'hash', 'peer', 'u', 7, 3)
  `);
  assert.equal(await revocation.applyRevocation({ instanceId: 'peer', homeUserId: 'u', gen: 6, account: false }), false);
  assert.equal(await revocation.applyRevocation({ instanceId: 'peer', homeUserId: 'missing', gen: 8, account: false }), false);
  const row = await t.raw.query<{ home_gen: number; token_generation: number }>(
    `SELECT home_gen, token_generation FROM users WHERE id = 'shadow'`,
  );
  assert.deepEqual(row.rows[0], { home_gen: 7, token_generation: 3 });
});

test('аватар теневого гостя не выдаётся соседям через наш инстанс', async () => {
  // Ловит ретрансляцию лица человека третьего инстанса через хост, где он всего лишь гость.
  await t.raw.exec(`
    INSERT INTO users
      (id, username, display_name, password_hash, avatar_url, verified, approved_at,
       home_instance_id, home_user_id)
    VALUES
      ('shadow', 'u@peer', 'Guest', 'hash', '/media/secret.png', true, now(), 'peer', 'u')
  `);
  assert.equal(await avatars.ownAvatarFor('shadow'), null);
});

test('запрет можно поставить до первого входа, а снятие оставляет журнал и повторный запрет его переиспользует', async () => {
  // Ловит привязку запрета к существованию теневой строки, которую повторный вход мог бы обойти.
  await t.raw.exec(`INSERT INTO users (id, username, display_name, password_hash) VALUES ('mod', 'mod', 'Mod', 'hash')`);
  assert.deepEqual(await bans.banInstanceUser({
    homeInstanceId: 'peer', homeUserId: 'never-seen', reason: 'spam', expiresAt: null, createdBy: 'mod',
  }), { servers: [] });
  assert.equal(await bans.instanceBanFor('peer', 'never-seen'), true);
  assert.equal(await bans.unbanInstanceUser('peer', 'never-seen', 'mod'), true);
  assert.equal(await bans.instanceBanFor('peer', 'never-seen'), false);
  await bans.banInstanceUser({
    homeInstanceId: 'peer', homeUserId: 'never-seen', reason: 'again', expiresAt: null, createdBy: 'mod',
  });
  const rows = await t.raw.query<{ reason: string; removed_at: Date | null }>(
    `SELECT reason, removed_at FROM instance_bans WHERE home_instance_id = 'peer' AND home_user_id = 'never-seen'`,
  );
  assert.deepEqual(rows.rows, [{ reason: 'again', removed_at: null }]);
});

test('удаление дома обезличивает гостя и снимает членства, но сохраняет строку и происхождение', async () => {
  // Ловит каскадное удаление истории либо потерю значка домашнего инстанса у старых сообщений.
  await seedServer();
  await t.raw.exec(`
    INSERT INTO users
      (id, username, email, display_name, password_hash, avatar_url, verified, approved_at,
       home_instance_id, home_user_id, home_username, home_gen, token_generation)
    VALUES
      ('shadow', 'u@peer', 'guest@example.test', 'Guest', 'hash', '/old.png', true, now(),
       'peer', 'home-u', 'u', 9, 4);
    INSERT INTO server_members (server_id, user_id, state) VALUES ('server', 'shadow', 'active')
  `);
  // Отказ внешнего Redis не должен оставлять publish в вечной offline-очереди при reconnecting.
  (await import('../src/realtime.js')).redisPub.options.enableOfflineQueue = false;
  assert.equal(await profile.applyGuestProfile('peer', {
    userId: 'home-u', updatedAt: 12, removed: 'deleted',
  }), true);
  const row = await t.raw.query<{
    id: string; email: string | null; avatar_url: string | null; deleted_at: Date | null;
    home_instance_id: string | null; home_user_id: string | null; token_generation: number;
  }>(`
    SELECT id, email, avatar_url, deleted_at, home_instance_id, home_user_id, token_generation
    FROM users WHERE id = 'shadow'
  `);
  assert.equal(row.rows[0]?.id, 'shadow');
  assert.equal(row.rows[0]?.email, null);
  assert.equal(row.rows[0]?.avatar_url, null);
  assert.ok(row.rows[0]?.deleted_at);
  assert.equal(row.rows[0]?.home_instance_id, 'peer');
  assert.equal(row.rows[0]?.home_user_id, 'home-u');
  assert.equal(row.rows[0]?.token_generation, 5);
  const member = await t.raw.query<{ state: string }>(
    `SELECT state FROM server_members WHERE server_id = 'server' AND user_id = 'shadow'`,
  );
  assert.deepEqual(member.rows, [{ state: 'removed' }]);
});

test('дом будит только своего действующего гостя, с доверенным именем и одним rate-key', async () => {
  // Ловит пуш по подложному членству, текст из чужой нагрузки и обход окна через другой ключ счётчика.
  await seedServer();
  await t.raw.exec(`
    INSERT INTO federation_guest_grants (user_id, instance_id) VALUES ('local', 'peer');
    INSERT INTO federation_memberships
      (instance_id, user_id, server_id, server_name, state, updated_at)
    VALUES ('peer', 'local', 'remote-server', 'Доверенная стая', 'active', 1)
  `);
  const rates: [string, number, number][] = [];
  const pushes: unknown[] = [];
  const handler = guestPush.createGuestPushHandler({
    async rateHit(key, max, windowS) { rates.push([key, max, windowS]); return 0; },
    async sendPushToUsers(ids, payload) { pushes.push([ids, payload]); },
  });
  await handler({ instanceId: 'peer', event: {
    eventId: 'notify', seq: 1, kind: FED_EVENTS.guestNotify, createdAt: 1,
    payload: { user_id: 'local', kind: 'mention', server_id: 'remote-server', channel_id: 'chat', server_name: 'Подделка' },
  } });
  assert.deepEqual(rates, [['fed:gnotify:peer:local', 1, guestPush.GUEST_PUSH_WINDOW_S]]);
  assert.deepEqual(pushes, [[['local'], {
    type: 'mention', title: 'GusVoice', body: 'Вас упомянули на сервере «Доверенная стая»',
    serverId: 'remote-server', channelId: 'chat', instanceId: 'peer',
  }]]);
});

test('лимит или отказ Redis гасит гостевой пуш, а закрытое членство не даёт будить человека', async () => {
  // Ловит fail-open рассылку без счётчика и право бывшего хоста продолжать будить телефон.
  await seedServer();
  await t.raw.exec(`
    INSERT INTO federation_guest_grants (user_id, instance_id) VALUES ('local', 'peer');
    INSERT INTO federation_memberships
      (instance_id, user_id, server_id, server_name, state, updated_at)
    VALUES ('peer', 'local', 'remote-server', 'Стая', 'closed_by_host', 1)
  `);
  let pushes = 0;
  const event = { eventId: 'notify', seq: 1, kind: FED_EVENTS.guestNotify, createdAt: 1, payload: { user_id: 'local' } };
  await guestPush.createGuestPushHandler({
    async rateHit() { throw new Error('redis down'); }, async sendPushToUsers() { pushes++; },
  })({ instanceId: 'peer', event });
  assert.equal(pushes, 0);
  await t.raw.exec(`UPDATE federation_memberships SET state = 'active'`);
  await guestPush.createGuestPushHandler({
    async rateHit() { return 1; }, async sendPushToUsers() { pushes++; },
  })({ instanceId: 'peer', event });
  assert.equal(pushes, 0);
});

test('поручительство записывается до выпуска токена и повтор обновляет last_issued_at', async () => {
  // Ловит выданный токен без следа на доме и повторный выпуск, который не освежает адресный журнал.
  await seedServer();
  await t.raw.exec(`UPDATE users SET verified = true, approved_at = now(), token_generation = 4 WHERE id = 'local'`);
  const link = {
    instanceId: 'peer', domain: 'peer.example', apiBase: 'https://peer.example/api',
    clientOrigin: 'https://peer.example', rootKey: 'root', theirName: 'Peer', state: 'active' as const,
    protocolVersion: 1, features: ['guests'],
  };
  const deps = {
    identity: () => ({ instanceId: 'home' }),
    signingKey: () => ({ kid: 'kid', privateKeyDer: Buffer.from([1]) }),
    getLink: async () => link,
    readMeta: async () => ({ paused: false }),
    issueIdentityToken: (() => { throw new Error('sign failed'); }) as never,
  };
  const issue = guestHome.createIssueIdentityFor(deps);
  await assert.rejects(issue({ userId: 'local', hostInstanceId: 'peer', now: 10_000 }), /sign failed/);
  let rows = await t.raw.query<{ last_issued_at: Date }>(
    `SELECT last_issued_at FROM federation_guest_grants WHERE user_id = 'local' AND instance_id = 'peer'`,
  );
  assert.equal(rows.rows.length, 1);

  deps.issueIdentityToken = ((input: { now: number }) => ({ token: 'token', claims: { exp: input.now + 120_000 } })) as never;
  const result = await issue({ userId: 'local', hostInstanceId: 'peer', now: 20_000 });
  assert.deepEqual(result, { ok: true, token: 'token', expiresAt: 140_000 });
  rows = await t.raw.query<{ last_issued_at: Date }>(
    `SELECT last_issued_at FROM federation_guest_grants WHERE user_id = 'local' AND instance_id = 'peer'`,
  );
  assert.equal(new Date(rows.rows[0]!.last_issued_at).getTime(), 20_000);
});

test('закрытие гостевого доступа сначала инвалидирует сервер и адресно объясняет причину', async () => {
  // Ловит сокет, который продолжает получать сервер после закрытия, и рассылку личного окна всем участникам.
  await seedServer();
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash, home_instance_id, home_user_id)
    VALUES ('shadow', 'u@peer', 'Guest', 'hash', 'peer', 'u');
    INSERT INTO server_members (server_id, user_id, state) VALUES ('server', 'shadow', 'active')
  `);
  const calls: unknown[] = [];
  const count = await guestAccess.closeServerForGuests(
    { serverId: 'server', instanceId: 'peer', reason: guestAccess.CLOSE_REASONS.federationDisabled },
    {
      publish: async (serverId, event) => { calls.push(['server', serverId, event]); },
      publishToUser: async (userId, event) => { calls.push(['user', userId, event]); },
    },
  );
  assert.equal(count, 1);
  assert.deepEqual(calls[0], ['server', 'server', { t: 'server.invalidate', serverId: 'server' }]);
  assert.deepEqual(calls[1], ['user', 'shadow', {
    t: 'server.access_closed', serverId: 'server', reason: guestAccess.CLOSE_REASONS.federationDisabled, contacts: [],
  }]);
  const state = await t.raw.query<{ state: string }>(`SELECT state FROM server_members WHERE user_id = 'shadow'`);
  assert.deepEqual(state.rows, [{ state: 'closed_by_host' }]);
});
