import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseGuestSession,
  parseIdentityClaims,
  parseInvitePreview,
  parseMembershipEvent,
  parseRevocationEvent,
  serializeGuestSession,
  serializeIdentityClaims,
  serializeInvitePreview,
  serializeMembershipEvent,
  serializeRevocationEvent,
  type FedGuestSession,
  type FedIdentityClaims,
  type FedInvitePreview,
  type FedMembershipEvent,
  type FedRevocationEvent,
} from './guest.js';

describe('провод федеративного гостя', () => {
  it('токен личности сохраняет ник и отображаемое имя внутри подписанного профиля', () => {
    const claims: FedIdentityClaims = {
      iss: 'home', sub: 'user', aud: 'host', iat: 1, exp: 2, jti: 'once', gen: 3,
      username: 'hidden-user', displayName: 'Скрытый', avatarHash: 'avatar',
    };
    assert.deepEqual(parseIdentityClaims(serializeIdentityClaims(claims)), claims);
  });

  it('без ника токен личности негоден, а пустое отображаемое имя честно заменяется ником', () => {
    const raw = { iss: 'home', sub: 'user', aud: 'host', iat: 1, exp: 2, jti: 'once', gen: 3 };
    assert.equal(parseIdentityClaims(raw), null);
    assert.equal(parseIdentityClaims({ ...raw, username: 'user', display_name: '' })?.displayName, 'user');
  });

  it('идентификатор с путём и длиной 65 символов отвергается', () => {
    // Ловит выход идентификатора соседа в путь хранилища и снятие лимита служебного логина.
    const raw = { iss: 'home', aud: 'host', iat: 1, exp: 2, jti: 'once', gen: 3, username: 'user' };
    assert.equal(parseIdentityClaims({ ...raw, sub: '../secret' }), null);
    assert.equal(parseIdentityClaims({ ...raw, sub: 'a'.repeat(65) }), null);
    assert.equal(parseIdentityClaims({ ...raw, sub: 'a'.repeat(64) })?.sub, 'a'.repeat(64));
  });

  it('слишком длинное или невидимо направленное имя заменяется ником', () => {
    // Ловит протаскивание огромного либо визуально подменённого имени в каждый ростер и сообщение.
    const raw = { iss: 'home', sub: 'user', aud: 'host', iat: 1, exp: 2, jti: 'once', gen: 3, username: 'user' };
    assert.equal(parseIdentityClaims({ ...raw, display_name: 'a'.repeat(65) })?.displayName, 'user');
    assert.equal(parseIdentityClaims({ ...raw, display_name: 'admin\u202eexe' })?.displayName, 'user');
    assert.equal(parseIdentityClaims({ ...raw, display_name: 'a'.repeat(64) })?.displayName, 'a'.repeat(64));
  });

  it('негодный отпечаток аватара убирает аватар, не ломая личность', () => {
    // Ловит использование строки с путём как части ключа объекта изображения.
    const parsed = parseIdentityClaims({
      iss: 'home', sub: 'user', aud: 'host', iat: 1, exp: 2, jti: 'once', gen: 3,
      username: 'user', avatar_hash: '../avatar',
    });
    assert.equal(parsed?.avatarHash, null);
  });

  it('карточка приглашения и гостевая сессия переживают круг по проводу', () => {
    const preview: FedInvitePreview = {
      code: 'Abcd', serverId: 's1', serverName: 'Сервер', iconHash: null, members: 4, expiresAt: 500,
    };
    const session: FedGuestSession = { userId: 'shadow', token: 'token', expiresAt: 700 };
    assert.deepEqual(parseInvitePreview(serializeInvitePreview(preview)), preview);
    assert.deepEqual(parseGuestSession(serializeGuestSession(session)), session);
  });

  it('неизвестное состояние членства безопасно трактуется как снятое', () => {
    const parsed = parseMembershipEvent({
      user_id: 'u', server_id: 's', server_name: 'Сервер', state: 'future-state', at: 10,
    });
    assert.equal(parsed?.state, 'removed');
  });

  it('членство и отзыв сессий сохраняют все поля при сериализации', () => {
    const membership: FedMembershipEvent = {
      userId: 'u', serverId: 's', serverName: 'Сервер', state: 'closed_by_host', method: 'invite',
      invitedBy: 'owner', reason: 'federation_disabled', at: 10,
    };
    const revocation: FedRevocationEvent = { userId: 'u', gen: 4, at: 11 };
    assert.deepEqual(parseMembershipEvent(serializeMembershipEvent(membership)), membership);
    assert.deepEqual(parseRevocationEvent(serializeRevocationEvent(revocation)), revocation);
  });
});
