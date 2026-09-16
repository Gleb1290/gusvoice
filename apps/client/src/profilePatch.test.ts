import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyUserProfilePatch, type ProfileSlices } from './profilePatch.js';

const ME = 'u-me';
const HIM = 'u-him';

const msg = (id: string, authorId: string) =>
  ({ id, author: { id: authorId, displayName: 'старое', avatarUrl: null } }) as never;

function slices(): ProfileSlices {
  return {
    members: [
      { user: { id: HIM, displayName: 'старое', avatarUrl: null, animatedAvatarUrl: null } },
      { user: { id: 'u-other', displayName: 'Другой', avatarUrl: null, animatedAvatarUrl: null } },
    ] as never,
    messagesByChannel: { c1: [msg('m1', HIM), msg('m2', 'u-other')], c2: [msg('m3', 'u-other')] },
    dmMessages: { d1: [msg('m4', HIM)] },
    dms: [
      { id: 'd1', otherUser: { id: HIM, displayName: 'старое', avatarUrl: null } },
      { id: 'd2', otherUser: { id: 'u-other', displayName: 'Другой', avatarUrl: null } },
    ] as never,
    user: { id: ME, displayName: 'Я', avatarUrl: null, animatedAvatarUrl: null } as never,
  };
}

const patch = {
  userId: HIM,
  displayName: 'Новое имя',
  avatarUrl: 'https://minio/avatars/him-2.png',
  animatedAvatarUrl: 'https://minio/avatars/him-2.gif',
};

describe('разнос смены профиля по копиям', () => {
  it('правится ростер, авторы сообщений, личные и собственный профиль', () => {
    const before = slices();
    const after = applyUserProfilePatch(before, patch);

    assert.equal((after.members[0] as never as { user: { displayName: string } }).user.displayName, 'Новое имя');
    assert.equal((after.messagesByChannel.c1[0] as never as { author: { avatarUrl: string } }).author.avatarUrl, patch.avatarUrl);
    assert.equal((after.dmMessages.d1[0] as never as { author: { avatarUrl: string } }).author.avatarUrl, patch.avatarUrl);
    assert.equal((after.dms[0] as never as { otherUser: { displayName: string } }).otherUser.displayName, 'Новое имя');
  });

  it('🔴 анимация попадает В РОСТЕР — оттуда её читают все поверхности', () => {
    // Ровно этого не было в #129: событие анимацию не несло, и чужая покупка не появлялась ни у
    // кого до полного перезахода на сервер.
    const after = applyUserProfilePatch(slices(), patch);
    const m = after.members[0] as never as { user: { animatedAvatarUrl: string | null } };
    assert.equal(m.user.animatedAvatarUrl, patch.animatedAvatarUrl);
  });

  it('свой профиль правится, когда меняется он же', () => {
    const before = slices();
    const after = applyUserProfilePatch(before, { ...patch, userId: ME });
    assert.equal((after.user as never as { displayName: string }).displayName, 'Новое имя');
    assert.equal((after.user as never as { animatedAvatarUrl: string }).animatedAvatarUrl, patch.animatedAvatarUrl);
  });

  it('чужая смена не трогает мой профиль', () => {
    const before = slices();
    const after = applyUserProfilePatch(before, patch);
    assert.equal(after.user, before.user, 'та же ссылка — перерисовывать нечего');
  });

  it('🔴 нетронутые коллекции возвращаются ТЕМИ ЖЕ ссылками', () => {
    // Иначе любая чужая смена аватара перерисовывала бы всю переписку целиком.
    const before = slices();
    const after = applyUserProfilePatch(before, patch);
    assert.equal(after.messagesByChannel.c2, before.messagesByChannel.c2, 'канал без его сообщений');
  });

  it('в затронутых коллекциях чужие элементы сохраняют свои ссылки', () => {
    // Ловит ненужное клонирование каждого участника, DM и сообщения при одном изменившемся профиле.
    const before = slices();
    const after = applyUserProfilePatch(before, patch);
    assert.equal(after.members[1], before.members[1]);
    assert.equal(after.dms[1], before.dms[1]);
    assert.equal(after.messagesByChannel.c1[1], before.messagesByChannel.c1[1]);
  });

  it('удаление аватаров доезжает до всех поддерживающих их копий', () => {
    // Ловит замену null через `??` старым URL: снятый аватар иначе оставался бы висеть до перезахода.
    const filled = applyUserProfilePatch(slices(), patch);
    const cleared = applyUserProfilePatch(filled, { ...patch, avatarUrl: null, animatedAvatarUrl: null });
    assert.equal(cleared.members[0].user.avatarUrl, null);
    assert.equal(cleared.members[0].user.animatedAvatarUrl, null);
    assert.equal(cleared.messagesByChannel.c1[0].author.avatarUrl, null);
    assert.equal(cleared.dmMessages.d1[0].author.avatarUrl, null);
    assert.equal(cleared.dms[0].otherUser.avatarUrl, null);

    const ownFilled = applyUserProfilePatch(slices(), { ...patch, userId: ME });
    const ownCleared = applyUserProfilePatch(ownFilled, {
      ...patch,
      userId: ME,
      avatarUrl: null,
      animatedAvatarUrl: null,
    });
    assert.equal(ownCleared.user?.avatarUrl, null);
    assert.equal(ownCleared.user?.animatedAvatarUrl, null);
  });

  it('человека нет ни в одной копии — всё осталось прежним', () => {
    const before = slices();
    const after = applyUserProfilePatch(before, { ...patch, userId: 'кого-нет' });
    assert.equal(after.members, before.members);
    assert.equal(after.dms, before.dms);
    assert.equal(after.messagesByChannel, before.messagesByChannel);
    assert.equal(after.dmMessages, before.dmMessages);
    assert.equal(after.user, before.user);
  });

  it('пустое состояние не роняет разнос', () => {
    const empty: ProfileSlices = { members: [], messagesByChannel: {}, dmMessages: {}, dms: [], user: null };
    assert.doesNotThrow(() => applyUserProfilePatch(empty, patch));
  });
});
