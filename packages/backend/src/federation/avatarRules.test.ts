import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { avatarUrlForPeer } from './avatarRules.js';

const row = (patch: Record<string, unknown> = {}) => ({
  id: 'u1', username: 'user', displayName: 'Имя', avatarUrl: 'https://media/avatar.png',
  verified: true, approvedAt: new Date(1), deletedAt: null, hiddenFromPeers: false,
  homeInstanceId: null, directoryUpdatedAt: new Date(2), ...patch,
});

describe('выдача аватара соседнему инстансу', () => {
  it('видимый подтверждённый местный человек отдаёт свой аватар', () => {
    // Ловит чрезмерный запрет обычного публичного профиля каталога.
    assert.equal(avatarUrlForPeer(row()), 'https://media/avatar.png');
  });

  it('скрытый и удалённый человек не отдают лицо через прямой маршрут', () => {
    // Ловит обход скрытия и удаления запросом картинки мимо каталога.
    assert.equal(avatarUrlForPeer(row({ hiddenFromPeers: true })), null);
    assert.equal(avatarUrlForPeer(row({ deletedAt: new Date(3) })), null);
  });

  it('неподтверждённый и неодобренный человек не отдают аватар', () => {
    // Ловит публикацию лица аккаунта, ещё не допущенного в каталог.
    assert.equal(avatarUrlForPeer(row({ verified: false })), null);
    assert.equal(avatarUrlForPeer(row({ approvedAt: null })), null);
  });

  it('теневой гость третьего инстанса никогда не ретранслируется', () => {
    // Ловит утечку фотографии человека инстанса C соседу B через наш инстанс.
    assert.equal(avatarUrlForPeer(row({ homeInstanceId: 'third' })), null);
  });

  it('отсутствие аватара остаётся отсутствием', () => {
    // Ловит выдуманный адрес или строку null у видимого профиля без картинки.
    assert.equal(avatarUrlForPeer(row({ avatarUrl: null })), null);
  });
});
