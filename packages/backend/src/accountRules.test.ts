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

const CLEARED_USER_FK_TABLES = [
  'channel_reads',
  'coin_balances',
  'diag_reports',
  'dm_reads',
  'email_verifications',
  'member_roles',
  'password_resets',
  'push_devices',
  'push_mutes',
  'server_members',
].sort();

const RETAINED_USER_FKS = [
  'audit_log.actor_id',
  'bans.banned_by',
  'bans.user_id',
  'channels.general_user_id',
  'coin_ledger.ref_user_id',
  'coin_ledger.user_id',
  'coin_purchases.target_user_id',
  'coin_purchases.user_id',
  'dm_channels.user_a',
  'dm_channels.user_b',
  'dm_message_reactions.user_id',
  'dm_messages.author_id',
  'invites.inviter_id',
  'message_reactions.user_id',
  'messages.author_id',
  'poll_votes.user_id',
  'season_results.user_id',
  'server_emojis.created_by',
  'server_soundboard.created_by',
  'sticker_packs.created_by',
  'voice_activity.user_id',
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
      approvedAt: null,
      deletedAt: now,
    });
  });

  it('каждый столбец users явно обезличивается, сохраняется или инвалидируется отдельно', () => {
    // Ловит новый персональный столбец схемы, для которого при удалении забыли принять решение.
    const schemaColumns = Object.keys(getTableColumns(dbSchema.users)).sort();
    const rowAnonymized = Object.keys(fields);
    const retained = ['id', 'createdAt'];
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
    assert.deepEqual(actual.sort(), [...clearedDirectFks, ...RETAINED_USER_FKS, ...blockedByDeleteRule].sort());
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
    assert.equal(operations.at(-1), 'update:users');
    assert.deepEqual(
      operations.slice(1, -1).sort(),
      CLEARED_USER_FK_TABLES.map((name) => `delete:${name}`).sort(),
    );
    assert.deepEqual(updatedFields, anonymizedUserFields('u-1', '$2a$10$unusable', new Date('2026-09-15T12:00:00Z')));
  });
});
