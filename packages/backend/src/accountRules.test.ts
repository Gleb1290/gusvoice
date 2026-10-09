import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  accountDeleteBlock,
  anonymizedUserFields,
  DELETED_DISPLAY_NAME,
  deletedUsername,
  isReservedUsername,
} from './accountRules.js';
import { anonymizeAccountRows } from './accountRows.js';
import * as dbSchema from './db/schema.js';
import * as drizzle from 'drizzle-orm';
import * as accountRules from './accountRules.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const CLEARED_USER_FK_TABLES = [
  'channel_reads',
  'coin_balances',
  'diag_reports',
  'dm_reads',
  'dm_folders',
  'email_verifications',
  'federation_guest_grants',
  'federation_memberships',
  'member_roles',
  'password_resets',
  'push_devices',
  'push_mutes',
  'push_always',
  'server_members',
  'user_sync',
  'user_sticker_packs',
  'user_faved_stickers',
  'user_recent_stickers',
  'user_saved_gifs',
].sort();

it('удаление аккаунта очищает push_always — исходниковый пропуск tx.delete пойман', async () => {
  const check = async (remove: typeof anonymizeAccountRows) => {
    const deleted: string[] = [];
    const tx = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      delete: (table: never) => ({ where: async () => { deleted.push(getTableConfig(table).name); } }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    };
    await remove(tx as unknown as Parameters<typeof remove>[0], 'user', 'unusable', new Date(0));
    assert.equal(deleted.filter(name => name === 'push_always').length, 1, 'push_always удаляется в транзакции');
  };
  const load = (mutant: boolean) => {
    const source = readFileSync(new URL('./accountRows.ts', import.meta.url), 'utf8');
    const anchor = 'await tx.delete(pushAlways).where(eq(pushAlways.userId, userId));';
    assert.equal(source.split(anchor).length, 2, 'точный якорь tx.delete уникален');
    const changed = mutant ? source.replace(anchor, '/* пропущена очистка */') : source;
    if (mutant) assert.notEqual(changed, source);
    const module = { exports: {} as { anonymizeAccountRows: typeof anonymizeAccountRows } };
    const deps: Record<string, unknown> = { 'drizzle-orm': drizzle, './db/schema.js': dbSchema, './accountRules.js': accountRules };
    runInNewContext(ts.transpileModule(changed, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, require: (id: string) => { assert.ok(id in deps); return deps[id]; } });
    return module.exports.anonymizeAccountRows;
  };
  await check(anonymizeAccountRows); await check(load(false));
  await assert.rejects(() => check(load(true)), (error: unknown) => error instanceof assert.AssertionError && error.message.includes('push_always удаляется'));
});

const RETAINED_USER_FKS = [
  'audit_log.actor_id',
  'bans.banned_by',
  'bans.user_id',
  'channels.general_user_id',
  'coin_ledger.ref_user_id',
  'coin_ledger.user_id',
  'coin_purchases.target_user_id',
  'coin_purchases.user_id',
  'conversation_members.user_id',
  'conversation_message_reactions.user_id',
  'conversation_messages.author_id',
  'conversations.created_by',
  'dm_channels.user_a',
  'dm_channels.user_b',
  'dm_message_reactions.user_id',
  'dm_messages.author_id',
  // Журнал запретов на инстанс (F3, §5.11) переживает уход модератора: решение принимал ИНСТАНС,
  // и «кем поставлен» — подпись в журнале, а не связь с живым аккаунтом.
  'instance_bans.created_by',
  'instance_bans.removed_by',
  'invites.inviter_id',
  'message_reactions.user_id',
  'messages.author_id',
  'poll_votes.user_id',
  'season_results.user_id',
  'server_emojis.created_by',
  'server_members.invited_by',
  'server_soundboard.created_by',
  'sticker_packs.created_by',
  'voice_activity.user_id',
].sort();

const CLEARED_NONSTANDARD_USER_FKS = [
  'last_seen_exceptions.owner_id',
  'last_seen_exceptions.target_id',
  'privacy_exceptions.owner_id',
  'privacy_exceptions.target_id',
  'user_contacts.owner_id',
  'user_contacts.contact_id',
  'user_blocks.blocker_id',
  'user_blocks.blocked_id',
].sort();

describe('удаление аккаунта обезличивает, а не стирает (F0, #139)', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  const fields = anonymizedUserFields('u-1', '$2a$10$unusable', now);

  it('личные данные уходят все', () => {
    // Ловит забытое поле: почта, 2FA, Steam или аватар пережили бы удаление.
    assert.deepEqual(fields, {
      username: 'deleted-u-1',
      email: null,
      verified: false,
      canCreateServers: false,
      displayName: DELETED_DISPLAY_NAME,
      passwordHash: '$2a$10$unusable',
      avatarUrl: null,
      animatedAvatarUrl: null,
      animatedAvatarUnlocked: false,
      animatedAvatarUntil: null,
      economyWelcomeSeenAt: null,
      totpSecret: null,
      totpEnabled: false,
      totpBackupCodes: null,
      presenceStatus: 'invisible',
      presenceAuto: false,
      customStatusEmoji: null,
      customStatusText: null,
      customStatusExpiresAt: null,
      pdConsentAt: null,
      steamId: null,
      steamPersona: null,
      showGameActivity: false,
      lastSeenAt: null,
      lastSeenPrivacy: 'nobody',
      hideReadTime: false,
      notifyView: 'all',
      notifyGroups: true,
      notifyDm: true,
      notifyRepeat: 0,
      approvedAt: null,
      hiddenFromPeers: false,
      directoryUpdatedAt: now,
      homeUsername: null,
      homeAvatarHash: null,
      homeGen: 0,
      deletedAt: now,
    });
  });

  it('каждый столбец users явно обезличивается, сохраняется или инвалидируется отдельно', () => {
    // Ловит новый персональный столбец схемы, для которого при удалении забыли принять решение.
    const schemaColumns = Object.keys(getTableColumns(dbSchema.users)).sort();
    const rowAnonymized = Object.keys(fields);
    // `homeInstanceId`/`homeUserId` сохраняются намеренно (F3, §5.6.2): значок инстанса остаётся у
    // обезличенного гостя, и по этой же паре действует запрет на инстанс.
    // callPrivacy — не идентификатор и сам по себе не раскрывается: удалённая учётка не может инициировать звонок.
    const retained = ['id', 'createdAt', 'homeInstanceId', 'homeUserId', 'callPrivacy'];
    const invalidatedAfterTransaction = ['tokenGeneration'];
    assert.deepEqual(schemaColumns, [...rowAnonymized, ...retained, ...invalidatedAfterTransaction].sort());
  });

  it('логин освобождается, а в интерфейсе — «Удалённый пользователь»', () => {
    // Ловит занятый навсегда логин и прежнее имя в чужих чатах.
    assert.equal(fields.username, deletedUsername('u-1'));
    assert.notEqual(fields.username, 'SuperGoose');
    assert.equal(fields.displayName, DELETED_DISPLAY_NAME);
  });

  it('обезличенный аккаунт не может войти и создавать серверы', () => {
    assert.equal(fields.verified, false);
    assert.equal(fields.canCreateServers, false);
  });

  it('логин с префиксом удалённых зарезервирован в любом регистре', () => {
    // Ловит регистрацию «deleted-кто-то», выдающую себя за удалённый аккаунт.
    assert.equal(isReservedUsername('deleted-abc'), true);
    assert.equal(isReservedUsername('  Deleted-ABC'), true);
    assert.equal(isReservedUsername('undeleted-abc'), false);
    assert.equal(isReservedUsername('deleted'), false);
  });
});

describe('когда удалить аккаунт нельзя', () => {
  it('супер-админа удалить нельзя', () => {
    // Ловит инстанс без супер-админа: права привязаны к id (#140) и сами не переедут.
    assert.equal(accountDeleteBlock({ ownedServers: 0, isSuperAdmin: true, alreadyDeleted: false })?.status, 409);
  });

  it('владельца серверов удалить нельзя, пока не передаст их', () => {
    assert.equal(accountDeleteBlock({ ownedServers: 2, isSuperAdmin: false, alreadyDeleted: false })?.status, 409);
  });

  it('уже удалённый — как не найденный', () => {
    // Ловит повторное обезличивание, которое снова подняло бы поколение токенов и разослало события.
    assert.equal(accountDeleteBlock({ ownedServers: 0, isSuperAdmin: false, alreadyDeleted: true })?.status, 404);
  });

  it('обычный аккаунт без серверов удаляется', () => {
    assert.equal(accountDeleteBlock({ ownedServers: 0, isSuperAdmin: false, alreadyDeleted: false }), null);
  });
});

describe('строки аккаунта в соседних таблицах', () => {
  it('каждая таблица с прямой ссылкой на users имеет явную политику удаления', () => {
    // Ловит новую FK-таблицу с личными данными, которую забыли очистить или сознательно сохранить.
    const actual: string[] = [];
    for (const value of Object.values(dbSchema)) {
      try {
        const config = getTableConfig(value as never);
        for (const fk of config.foreignKeys) {
          const ref = fk.reference();
          if (ref.foreignTable !== dbSchema.users) continue;
          for (const column of ref.columns) actual.push(`${config.name}.${column.name}`);
        }
      } catch {
        // Не каждый экспорт schema.ts — таблица.
      }
    }
    const clearedDirectFks = CLEARED_USER_FK_TABLES
      .filter((name) => name !== 'member_roles')
      .map((name) => `${name}.user_id`);
    const blockedByDeleteRule = ['servers.owner_id'];
    assert.deepEqual(
      actual.sort(),
      [...clearedDirectFks, ...CLEARED_NONSTANDARD_USER_FKS, ...RETAINED_USER_FKS, ...blockedByDeleteRule].sort(),
    );
  });

  it('транзакционная функция удаляет весь очищаемый набор и обезличивает users последним', async () => {
    // Ловит выпадение одной личной таблицы из транзакции и update до очистки зависимых строк.
    const operations: string[] = [];
    let updatedFields: unknown;
    const tx = {
      select: () => ({
        from: () => ({
          where: async () => {
            operations.push('select:server_members');
            return [{ serverId: 'server-a' }, { serverId: 'server-b' }];
          },
        }),
      }),
      delete: (table: never) => ({
        where: async () => {
          operations.push(`delete:${getTableConfig(table).name}`);
        },
      }),
      update: (table: never) => ({
        set: (value: unknown) => ({
          where: async () => {
            updatedFields = value;
            operations.push(`update:${getTableConfig(table).name}`);
          },
        }),
      }),
    };

    const memberOf = await anonymizeAccountRows(
      tx as unknown as Parameters<typeof anonymizeAccountRows>[0],
      'u-1',
      '$2a$10$unusable',
      new Date('2026-09-15T12:00:00Z'),
    );

    assert.deepEqual(memberOf, ['server-a', 'server-b']);
    assert.equal(operations[0], 'select:server_members');
    assert.equal(operations[1], 'update:conversation_messages', 'снимки обезличиваются первой записью транзакции');
    assert.equal(operations[2], 'delete:conversation_scheduled', 'отложенные удаляются второй записью, до остальных таблиц');
    assert.equal(operations.at(-1), 'update:users');
    assert.deepEqual(
      operations.slice(1, -1).sort(),
      [...CLEARED_USER_FK_TABLES.map((name) => `delete:${name}`), 'delete:user_blocks', 'delete:last_seen_exceptions', 'delete:privacy_exceptions', 'delete:user_contacts', 'delete:conversation_scheduled', 'update:attachments', 'update:conversation_messages'].sort(),
    );
    assert.deepEqual(updatedFields, anonymizedUserFields('u-1', '$2a$10$unusable', new Date('2026-09-15T12:00:00Z')));
  });
});
