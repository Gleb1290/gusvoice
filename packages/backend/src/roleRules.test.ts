import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALL_PERMISSIONS, Permission } from '@gusvoice/shared';
import {
  assignRoleBlock,
  clampGrant,
  planReorder,
  selfAssignBlocked,
  type RoleOrderRow,
} from './roleRules.js';

const roles = (...rows: Array<[string, number, boolean?]>): RoleOrderRow[] =>
  rows.map(([id, position, isEveryone = false]) => ({ id, position, isEveryone }));

describe('ограничение выдаваемых прав', () => {
  it('обычный менеджер может выдать только те биты, которые держит сам', () => {
    // Ловит повышение полномочий через создание роли с чужим permission bit.
    const actor = Permission.MANAGE_ROLES | Permission.SEND_MESSAGES;
    assert.equal(clampGrant(actor | Permission.BAN_MEMBERS, actor), actor);
  });

  it('администратор может выдать все известные, но не будущие неизвестные биты', () => {
    // Ловит сохранение произвольного bigint за пределами объявленной permission-маски.
    // ⚠️ Правил Claude (не Codex): защищённые биты администратору теперь не отдаются — см. блок ниже.
    const unknown = 1n << 62n;
    assert.equal(
      clampGrant(ALL_PERMISSIONS | unknown, Permission.ADMINISTRATOR, true),
      ALL_PERMISSIONS,
    );
  });
});

describe('защищённые права выдаёт только владелец', () => {
  const admin = Permission.ADMINISTRATOR;

  it('администратор не может выдать MOVE_ANYONE сам себе', () => {
    // Ловит главное: без этого «дать право одной группе» обходится любым, у кого есть ADMINISTRATOR.
    assert.equal(clampGrant(Permission.MOVE_ANYONE, admin) & Permission.MOVE_ANYONE, 0n);
  });

  it('обычный держатель MOVE_ANYONE тоже не может раздать его дальше', () => {
    // Ловит обход защиты через «я уже держу бит, значит могу выдать»: адресное право расползлось бы по ролям.
    const actor = Permission.MANAGE_ROLES | Permission.MOVE_ANYONE;
    assert.equal(clampGrant(Permission.MOVE_ANYONE, actor, false, 0n), 0n);
  });

  it('владелец может', () => {
    assert.equal(clampGrant(Permission.MOVE_ANYONE, admin, true) & Permission.MOVE_ANYONE, Permission.MOVE_ANYONE);
  });

  it('администратор не может и СНЯТЬ уже выданное владельцем', () => {
    // Ловит обход с другой стороны: правку соседнего тумблера, которая молча гасит защищённый бит.
    const current = Permission.MOVE_ANYONE | Permission.SEND_MESSAGES;
    const result = clampGrant(Permission.SEND_MESSAGES, admin, false, current);
    assert.equal(result & Permission.MOVE_ANYONE, Permission.MOVE_ANYONE);
  });

  it('защищённый бит сохраняется вместе с обычной правкой роли', () => {
    // Ловит реализацию, которая защищает MOVE_ANYONE ценой потери нового незашищённого permission.
    const current = Permission.MOVE_ANYONE | Permission.SEND_MESSAGES;
    assert.equal(
      clampGrant(Permission.BAN_MEMBERS, admin, false, current),
      Permission.MOVE_ANYONE | Permission.BAN_MEMBERS,
    );
  });

  it('владелец может снять', () => {
    const current = Permission.MOVE_ANYONE | Permission.SEND_MESSAGES;
    assert.equal(clampGrant(Permission.SEND_MESSAGES, admin, true, current) & Permission.MOVE_ANYONE, 0n);
  });
});

describe('план перестановки ролей', () => {
  const all = roles(['everyone', 0, true], ['r1', 3], ['r2', 2], ['r3', 1]);
  const privileged = { privileged: true, highest: 0 };

  it('дубликат id отклоняется даже при правильной длине и известных ролях', () => {
    // Ловит исходный регресс: одну роль обновляли дважды, а другую не обновляли вовсе.
    assert.deepEqual(planReorder(['r1', 'r1', 'r3'], all, privileged), {
      ok: false,
      code: 400,
      error: 'order must list every non-@everyone role exactly once',
    });
  });

  it('неполный порядок отклоняется', () => {
    // Ловит молчаливое сохранение старой позиции роли, которую клиент забыл прислать.
    assert.equal(planReorder(['r1', 'r2'], all, privileged).ok, false);
  });

  it('@everyone нельзя включить в переставляемый порядок', () => {
    // Ловит сдвиг базовой роли с нулевой позиции.
    assert.equal(planReorder(['everyone', 'r1', 'r2'], all, privileged).ok, false);
  });

  it('неизвестный id отклоняется', () => {
    // Ловит запись позиции роли из другого сервера или устаревшего клиента.
    assert.equal(planReorder(['r1', 'r2', 'foreign'], all, privileged).ok, false);
  });

  it('неизменившийся порядок даёт пустой план даже обычному менеджеру', () => {
    // Ловит ложный 403 из-за верхних ролей, которые запрос перечисляет, но не двигает.
    assert.deepEqual(planReorder(['r1', 'r2', 'r3'], all, { privileged: false, highest: 2 }), {
      ok: true,
      updates: [],
    });
  });

  it('позиции назначаются плотно сверху вниз и содержат только изменения', () => {
    // Ловит инверсию порядка, дыры в позициях и лишние записи неизменившейся роли.
    assert.deepEqual(planReorder(['r3', 'r2', 'r1'], all, privileged), {
      ok: true,
      updates: [
        { id: 'r3', position: 3 },
        { id: 'r1', position: 1 },
      ],
    });
  });

  it('владелец или администратор может переставлять роли через любые уровни', () => {
    // Ловит случайное применение обычной иерархии к привилегированному актору.
    assert.equal(planReorder(['r3', 'r2', 'r1'], all, privileged).ok, true);
  });

  it('обычный менеджер не может сдвинуть роль с собственного уровня или выше', () => {
    // Ловит обход иерархии перемещением старшей роли вниз.
    const result = planReorder(['r2', 'r1'], roles(['r1', 2], ['r2', 1]), {
      privileged: false,
      highest: 2,
    });
    assert.deepEqual(result, { ok: false, code: 403, error: 'нельзя двигать роли на своём уровне или выше' });
  });

  it('обычный менеджер не может поднять нижнюю роль до собственного уровня', () => {
    // Ловит проверку только исходной позиции без проверки назначения.
    const result = planReorder(['r1', 'r2'], roles(['r1', 0], ['r2', 1]), {
      privileged: false,
      highest: 2,
    });
    assert.deepEqual(result, { ok: false, code: 403, error: 'нельзя двигать роли на своём уровне или выше' });
  });

  it('нижние роли можно менять местами, не трогая перечисленную верхнюю', () => {
    // Ловит запрет легитимной перестановки из-за самого присутствия старшей роли в полном order.
    assert.deepEqual(planReorder(['high', 'b', 'a'], roles(['high', 3], ['a', 2], ['b', 1]), {
      privileged: false,
      highest: 3,
    }), {
      ok: true,
      updates: [
        { id: 'b', position: 2 },
        { id: 'a', position: 1 },
      ],
    });
  });
});

describe('безопасность самовыдаваемых ролей', () => {
  it('каждое админское право блокирует роль в итоговом состоянии самовыдачи', () => {
    // Ловит патч опасного permission к уже самовыдаваемой роли.
    for (const permission of [Permission.ADMINISTRATOR, Permission.MANAGE_ROLES, Permission.MANAGE_SERVER]) {
      assert.equal(selfAssignBlocked(true, permission), true);
    }
  });

  it('выключенный флаг не блокирует права, а безопасная роль может остаться самовыдаваемой', () => {
    // Ловит проверку старого флага вместо финального и запрет обычной hobby-роли.
    assert.equal(selfAssignBlocked(false, Permission.ADMINISTRATOR), false);
    assert.equal(selfAssignBlocked(true, Permission.SEND_MESSAGES), false);
  });
});

describe('выдача роли участнику', () => {
  it('обычный участник не выдаёт несамовыдаваемую роль', () => {
    // Ловит обход MANAGE_ROLES простым вызовом endpoint.
    assert.equal(assignRoleBlock({
      isManager: false,
      membersCanAssign: false,
      actorHasRole: false,
      rolePosition: 1,
      actorHighest: 0,
    }), 'forbidden');
  });

  it('само наличие роли не помогает, если membersCanAssign выключен', () => {
    // Ловит превращение любой собственной роли в раздаваемую.
    assert.equal(assignRoleBlock({
      isManager: false,
      membersCanAssign: false,
      actorHasRole: true,
      rolePosition: 10,
      actorHighest: 1,
    }), 'forbidden');
  });

  it('осознанная самовыдача обходит иерархию для того, кто уже держит роль', () => {
    // Ловит возврат строгой hierarchy-проверки, ломающей раздачу hobby-роли.
    assert.equal(assignRoleBlock({
      isManager: false,
      membersCanAssign: true,
      actorHasRole: true,
      rolePosition: 10,
      actorHighest: 1,
    }), null);
  });

  it('менеджер может выдать роль строго ниже своей', () => {
    // Ловит отказ штатной выдачи нижестоящей роли.
    assert.equal(assignRoleBlock({
      isManager: true,
      membersCanAssign: false,
      actorHasRole: false,
      rolePosition: 4,
      actorHighest: 5,
    }), null);
  });

  it('менеджер не может выдать роль своего уровня', () => {
    // Ловит повышение другого участника до уровня самого менеджера.
    assert.equal(assignRoleBlock({
      isManager: true,
      membersCanAssign: false,
      actorHasRole: false,
      rolePosition: 5,
      actorHighest: 5,
    }), 'нельзя выдать роль своего уровня или выше');
  });

  it('флаг самовыдачи не обходит иерархию у человека без самой роли', () => {
    // Ловит ошибку `membersCanAssign || actorHasRole`: менеджер иначе выдаст роль на своём уровне.
    assert.equal(assignRoleBlock({
      isManager: true,
      membersCanAssign: true,
      actorHasRole: false,
      rolePosition: 5,
      actorHighest: 5,
    }), 'нельзя выдать роль своего уровня или выше');
    assert.equal(assignRoleBlock({
      isManager: true,
      membersCanAssign: true,
      actorHasRole: false,
      rolePosition: 4,
      actorHighest: 5,
    }), null);
  });
});
