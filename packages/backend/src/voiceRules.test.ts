import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Permission } from '@gusvoice/shared';
import type { MemberContext } from './permissions.js';
import { movesAnyone, voiceHierarchyDecision, voiceRank } from './voiceRules.js';

interface ContextOptions {
  owner?: boolean;
  admin?: boolean;
  permissions?: bigint;
  roles?: Array<{ position: number; everyone?: boolean }>;
}

function context(options: ContextOptions = {}): MemberContext {
  const roles = (options.roles ?? []).map((role, index) => ({
    id: role.everyone ? 'everyone' : `role-${index}`,
    isEveryone: role.everyone ?? false,
    permissions: '0',
    position: role.position,
  }));
  return {
    isOwner: options.owner ?? false,
    roleIds: roles.filter((role) => !role.isEveryone).map((role) => role.id),
    roles,
    everyoneRoleId: roles.some((role) => role.isEveryone) ? 'everyone' : null,
    serverPermissions: options.permissions ?? (options.admin ? Permission.ADMINISTRATOR : 0n),
  };
}

describe('ранг голосовой модерации', () => {
  it('владелец строго выше администратора', () => {
    // Ловит право администратора мутить или перемещать владельца при сравнении Infinity с Infinity.
    assert.ok(voiceRank(context({ owner: true })) > voiceRank(context({ admin: true })));
  });

  it('два администратора имеют одинаковый ранг', () => {
    // Ловит случайный запрет голосовой модерации между равными администраторами.
    assert.equal(voiceRank(context({ admin: true })), voiceRank(context({ admin: true, roles: [{ position: 50 }] })));
  });

  it('одинаковые позиции ролей дают одинаковый ранг', () => {
    // Ловит возврат строгой иерархии kick/ban, где равного намеренно нельзя модерировать.
    assert.equal(voiceRank(context({ roles: [{ position: 5 }] })), voiceRank(context({ roles: [{ position: 5 }] })));
  });

  it('роль позиции 5 остаётся выше роли позиции 3', () => {
    // Ловит инверсию сравнения, позволяющую младшему голосовому модератору тронуть старшего.
    assert.ok(voiceRank(context({ roles: [{ position: 5 }] })) > voiceRank(context({ roles: [{ position: 3 }] })));
  });

  it('отсутствие назначенных ролей и один @everyone дают нулевой ранг', () => {
    // Ловит искусственное повышение обычного участника базовой ролью сервера.
    assert.equal(voiceRank(context()), 0);
    assert.equal(voiceRank(context({ roles: [{ position: 0, everyone: true }] })), 0);
  });

  it('владелец с низкой ролью всё равно остаётся бесконечно выше остальных', () => {
    // Ловит вычисление по ролям раньше isOwner, которое понижает владельца до позиции 1.
    assert.equal(voiceRank(context({ owner: true, roles: [{ position: 1 }] })), Number.POSITIVE_INFINITY);
  });
});

describe('обход иерархии при перемещении', () => {
  it('явный MOVE_ANYONE снимает щит старшей цели', () => {
    // Ловит проверку не того permission bit, из-за которой выданное владельцем право не работает.
    assert.equal(movesAnyone(context({ permissions: Permission.MOVE_ANYONE })), true);
  });

  it('ADMINISTRATOR без MOVE_ANYONE не получает адресное право автоматически', () => {
    // Ловит обычный admin-bypass, который сделал бы защищённое право бессмысленным.
    assert.equal(movesAnyone(context({ permissions: Permission.ADMINISTRATOR })), false);
  });
});

describe('решение голосовой иерархии', () => {
  const blocked = 'нельзя модерировать того, чья роль выше твоей';

  it('MOVE_ANYONE снимает щит старшей цели только при перемещении', () => {
    // Ловит расширение адресного права на мут и отключение владельца — весь смысл ограничения #98.
    const actor = context({ permissions: Permission.MOVE_ANYONE, roles: [{ position: 1 }] });
    const owner = context({ owner: true });
    assert.equal(voiceHierarchyDecision(actor, owner, true), null);
    assert.equal(voiceHierarchyDecision(actor, owner, false), blocked);
  });

  it('флаг перемещения без MOVE_ANYONE не обходит старшую роль', () => {
    // Ловит проверку одного isMove без обязательного защищённого permission bit.
    assert.equal(
      voiceHierarchyDecision(context({ roles: [{ position: 1 }] }), context({ roles: [{ position: 2 }] }), true),
      blocked,
    );
  });

  it('равные ранги допускаются и для перемещения, и для остальных действий', () => {
    // Регрессия #86: возврат сравнения >= снова запретил бы людям с одной ролью модерировать друг друга.
    const actor = context({ roles: [{ position: 5 }] });
    const target = context({ roles: [{ position: 5 }] });
    assert.equal(voiceHierarchyDecision(actor, target, true), null);
    assert.equal(voiceHierarchyDecision(actor, target, false), null);
  });

  it('младшая цель проходит без специального права', () => {
    // Парный успешный путь ловит случайный запрет обычной модерации сверху вниз.
    assert.equal(
      voiceHierarchyDecision(context({ roles: [{ position: 3 }] }), context({ roles: [{ position: 2 }] }), false),
      null,
    );
  });

  it('отсутствующий актор или цель не подменяют более ранний отказ по допуску', () => {
    // Ловит ложную ошибку иерархии вместо причины, которую route уже определил по правам канала.
    const member = context({ roles: [{ position: 1 }] });
    assert.equal(voiceHierarchyDecision(null, member, false), null);
    assert.equal(voiceHierarchyDecision(member, null, false), null);
  });
});
