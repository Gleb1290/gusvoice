import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_PERMISSIONS, Permission as P } from '@gusvoice/shared';
import { canInspectChannelAccess, describeChannelAccess } from './channelAccessCheck.js';
import type { MemberContext } from './permissions.js';

const ctx: MemberContext = {
  isOwner: false,
  roleIds: ['writer', 'reader'],
  everyoneRoleId: 'everyone',
  roles: [{ id: 'everyone', isEveryone: true, position: 0, permissions: String(P.VIEW_CHANNEL | P.READ_HISTORY) }],
  serverPermissions: P.VIEW_CHANNEL | P.READ_HISTORY,
};
const overwrite = (targetId: string, allow = 0n, deny = 0n, targetType = 'role') => ({
  targetId, targetType, allow: String(allow), deny: String(deny),
});

test('проверять доступ можно только в видимом канале с правом управления ролями', () => {
  assert.equal(canInspectChannelAccess(P.MANAGE_ROLES), false);
  assert.equal(canInspectChannelAccess(P.VIEW_CHANNEL), false);
  assert.equal(canInspectChannelAccess(P.VIEW_CHANNEL | P.MANAGE_ROLES), true);
  assert.equal(canInspectChannelAccess(P.ADMINISTRATOR), true);
});

test('категория наследуется, роли складываются, запрет канала перекрывает категорию', () => {
  const category = [
    overwrite('everyone', 0n, P.READ_HISTORY),
    overwrite('reader', 0n, P.SEND_MESSAGES),
    overwrite('writer', P.SEND_MESSAGES),
    overwrite('unassigned', P.READ_HISTORY),
  ];
  const [view, read, write] = describeChannelAccess('text', ctx, 'user', category, []);
  assert.deepEqual([view.allowed, read.allowed, write.allowed], [true, false, true]);
  assert.deepEqual(view.checks[0], { permission: 'VIEW_CHANNEL', allowed: true, source: 'roles', roleIds: ['everyone'] });
  assert.equal(read.checks[1].rule, 'everyone');
  assert.deepEqual(write.checks[1], { permission: 'SEND_MESSAGES', allowed: true, source: 'category', rule: 'roles' });
  const [, , denied] = describeChannelAccess('text', ctx, 'user', category, [overwrite('everyone', 0n, P.SEND_MESSAGES)]);
  assert.deepEqual(denied.checks[1], { permission: 'SEND_MESSAGES', allowed: false, source: 'channel', rule: 'everyone' });
});

test('личное исключение восстанавливает видимость и запрет видимости блокирует чтение и запись', () => {
  const category = [overwrite('writer', P.SEND_MESSAGES)];
  const hidden = overwrite('everyone', 0n, P.VIEW_CHANNEL);
  const denied = describeChannelAccess('text', ctx, 'user', category, [hidden]);
  assert.deepEqual(denied.map((item) => item.allowed), [false, false, false]);
  const restored = describeChannelAccess('text', ctx, 'user', category, [
    hidden, overwrite('user', P.VIEW_CHANNEL, 0n, 'member'),
  ]);
  assert.deepEqual(restored.map((item) => item.allowed), [true, true, true]);
  assert.deepEqual(restored[0].checks[0], { permission: 'VIEW_CHANNEL', allowed: true, source: 'channel', rule: 'member' });
});

test('право микрофона требует входа, а доступ владельца и администратора проходит поверх исключений', () => {
  const deny = overwrite('everyone', 0n, P.CONNECT | P.SPEAK);
  const microphone = overwrite('user', P.SPEAK, 0n, 'member');
  const [join, speak] = describeChannelAccess('voice', ctx, 'user', [deny], [microphone]);
  assert.deepEqual([join.allowed, speak.allowed, speak.checks[2].allowed], [false, false, true]);
  const voice = describeChannelAccess('voice', ctx, 'user', [deny], [overwrite('user', P.CONNECT | P.SPEAK, 0n, 'member')]);
  assert.deepEqual(voice.map((item) => item.allowed), [true, true]);
  for (const [member, source] of [
    [{ ...ctx, isOwner: true, serverPermissions: ALL_PERMISSIONS }, 'owner'],
    [{ ...ctx, serverPermissions: P.ADMINISTRATOR }, 'administrator'],
    [null, 'membership'],
  ] as const) {
    const result = describeChannelAccess('voice', member, 'user', [deny], [microphone]);
    assert.ok(result.every((item) => item.allowed === Boolean(member) && item.checks.every((check) => check.source === source)));
  }
});

test('административное исключение не превращает бота в администратора', () => {
  const [view] = describeChannelAccess('text', { ...ctx, isBot: true }, 'user', [
    overwrite('everyone', P.ADMINISTRATOR, P.VIEW_CHANNEL),
  ], []);
  assert.equal(view.allowed, false);
  assert.equal(view.checks[0].source, 'category');
});
