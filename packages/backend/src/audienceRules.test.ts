import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Permission } from '@gusvoice/shared';
import {
  channelAudience,
  type AudienceMember,
  type AudienceRole,
  type OverwriteRow,
} from './audienceRules.js';

function role(id: string, permissions = 0n, isEveryone = false): AudienceRole {
  return { id, isEveryone, permissions: permissions.toString() };
}

function member(userId: string, roleIds: string[] = [], privileged = false): AudienceMember {
  return { userId, roleIds, privileged };
}

function overwrite(targetType: 'role' | 'member', targetId: string, allow = 0n, deny = 0n): OverwriteRow {
  return { targetType, targetId, allow: allow.toString(), deny: deny.toString() };
}

function audience(p: {
  members: AudienceMember[];
  roles?: AudienceRole[];
  categoryOverwrites?: OverwriteRow[];
  channelOverwrites?: OverwriteRow[];
  everyoneRoleId?: string | null;
}): string[] {
  return channelAudience({
    members: p.members,
    roles: p.roles ?? [role('everyone', Permission.VIEW_CHANNEL, true)],
    everyoneRoleId: p.everyoneRoleId === undefined ? 'everyone' : p.everyoneRoleId,
    categoryOverwrites: p.categoryOverwrites ?? [],
    channelOverwrites: p.channelOverwrites ?? [],
  });
}

describe('аудитория событий канала', () => {
  it('публичный канал включает всех участников', () => {
    // Ловит недоставку обычных сообщений участникам без дополнительных ролей.
    assert.deepEqual(audience({ members: [member('anna'), member('boris')] }), ['anna', 'boris']);
  });

  it('пустой сервер даёт пустую аудиторию', () => {
    // Ловит появление фиктивного получателя на предельном входе без участников.
    assert.deepEqual(audience({ members: [] }), []);
  });

  it('канальный запрет для @everyone снимает серверное право роли', () => {
    // Ловит исходную утечку #91: серверный VIEW не должен перебивать более близкий deny канала.
    assert.deepEqual(
      audience({
        members: [member('reader', ['reader-role'])],
        roles: [role('everyone', 0n, true), role('reader-role', Permission.VIEW_CHANNEL)],
        channelOverwrites: [overwrite('role', 'everyone', 0n, Permission.VIEW_CHANNEL)],
      }),
      [],
    );
  });

  it('владелец и супер-админ проходят даже полный запрет', () => {
    // Ловит применение обычных оверрайдов к двум привилегированным путям доступа.
    assert.deepEqual(
      audience({
        members: [member('owner', [], true), member('super', [], true), member('ordinary')],
        roles: [role('everyone', 0n, true)],
        channelOverwrites: [overwrite('role', 'everyone', 0n, Permission.VIEW_CHANNEL)],
      }),
      ['owner', 'super'],
    );
  });

  it('роль ADMINISTRATOR игнорирует запреты без privileged-флага', () => {
    // Ловит потерю Discord-семантики администратора при построении адресного списка.
    assert.deepEqual(
      audience({
        members: [member('admin', ['admin-role'])],
        roles: [role('everyone', 0n, true), role('admin-role', Permission.ADMINISTRATOR)],
        channelOverwrites: [
          overwrite('role', 'everyone', 0n, Permission.VIEW_CHANNEL),
          overwrite('member', 'admin', 0n, Permission.VIEW_CHANNEL),
        ],
      }),
      ['admin'],
    );
  });

  it('персональное разрешение открывает закрытый канал только одному участнику', () => {
    // Ловит как потерю законного адресата, так и ошибочную выдачу доступа его соседу.
    assert.deepEqual(
      audience({
        members: [member('allowed'), member('blocked')],
        channelOverwrites: [
          overwrite('role', 'everyone', 0n, Permission.VIEW_CHANNEL),
          overwrite('member', 'allowed', Permission.VIEW_CHANNEL),
        ],
      }),
      ['allowed'],
    );
  });

  it('разрешение назначенной роли перебивает запрет @everyone', () => {
    // Ловит применение role-overwrite до everyone-overwrite вместо объявленного порядка.
    assert.deepEqual(
      audience({
        members: [member('moderator', ['moderator-role']), member('guest')],
        roles: [role('everyone', Permission.VIEW_CHANNEL, true), role('moderator-role')],
        channelOverwrites: [
          overwrite('role', 'everyone', 0n, Permission.VIEW_CHANNEL),
          overwrite('role', 'moderator-role', Permission.VIEW_CHANNEL),
        ],
      }),
      ['moderator'],
    );
  });

  it('канал может открыть доступ, запрещённый категорией', () => {
    // Ловит инверсию слоёв, при которой категория ошибочно оказывается сильнее канала.
    assert.deepEqual(
      audience({
        members: [member('reader')],
        categoryOverwrites: [overwrite('role', 'everyone', 0n, Permission.VIEW_CHANNEL)],
        channelOverwrites: [overwrite('role', 'everyone', Permission.VIEW_CHANNEL)],
      }),
      ['reader'],
    );
  });

  it('канал может закрыть доступ, разрешённый категорией', () => {
    // Ловит утечку при слиянии слоёв через общий OR вместо последовательного применения.
    assert.deepEqual(
      audience({
        members: [member('reader')],
        roles: [role('everyone', 0n, true)],
        categoryOverwrites: [overwrite('role', 'everyone', Permission.VIEW_CHANNEL)],
        channelOverwrites: [overwrite('role', 'everyone', 0n, Permission.VIEW_CHANNEL)],
      }),
      [],
    );
  });

  it('висячая назначенная роль не даёт базовых прав и не роняет расчёт', () => {
    // Ловит доверие к member_roles без соответствующей живой роли в таблице roles.
    assert.deepEqual(
      audience({
        members: [member('stale', ['deleted-role'])],
        roles: [role('everyone', 0n, true)],
      }),
      [],
    );
  });

  it('оверрайд висячей роли тоже не возвращает ей доступ', () => {
    // Ловит половинчатый фильтр: base чистый, но сырой roleId снова срабатывает в channel-overwrite.
    assert.deepEqual(
      audience({
        members: [member('stale', ['deleted-role'])],
        roles: [role('everyone', 0n, true)],
        channelOverwrites: [overwrite('role', 'deleted-role', Permission.VIEW_CHANNEL)],
      }),
      [],
    );
  });

  it('существующая назначенная роль даёт право только своему участнику', () => {
    // Ловит чрезмерную fail-closed фильтрацию, которая вместе с висячими ролями отбрасывает живые.
    assert.deepEqual(
      audience({
        members: [member('reader', ['reader-role']), member('guest')],
        roles: [role('everyone', 0n, true), role('reader-role', Permission.VIEW_CHANNEL)],
      }),
      ['reader'],
    );
  });
});
