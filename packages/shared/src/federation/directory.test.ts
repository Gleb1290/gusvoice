import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseDirectoryEntry,
  parseDirectoryPage,
  parseServerEntry,
  parseServerPage,
  serializeDirectoryEntry,
  serializeDirectoryPage,
  serializeServerEntry,
  serializeServerPage,
  type FedDirectoryEntry,
  type FedDirectoryPage,
  type FedServerEntry,
  type FedServerPage,
} from './directory.js';

describe('провод федеративного каталога', () => {
  it('надгробие разбирается без имени и не протаскивает профиль скрытого человека', () => {
    assert.deepEqual(
      parseDirectoryEntry({ user_id: 'u1', updated_at: 10, removed: true, reason: 'hidden', username: 'secret' }),
      { userId: 'u1', updatedAt: 10, removed: 'hidden' },
    );
  });

  it('неизвестная причина всё равно удаляет запись у старого соседа', () => {
    assert.deepEqual(parseDirectoryEntry({ user_id: 'u1', updated_at: 10, removed: true, reason: 'future' }), {
      userId: 'u1',
      updatedAt: 10,
      removed: 'deleted',
    });
  });

  it('живая запись без ника не превращается в пустую строку каталога', () => {
    assert.equal(parseDirectoryEntry({ user_id: 'u1', updated_at: 10, display_name: 'Имя' }), null);
    assert.equal(parseDirectoryEntry({ user_id: 'u1', updated_at: 10, username: 'user' })?.displayName, 'user');
  });

  it('каталог применяет к id, имени и аватару те же границы, что токен личности', () => {
    // Ловит расхождение двух входов одной и той же чужой личности в локальный кеш.
    assert.equal(parseDirectoryEntry({ user_id: '../u', updated_at: 10, username: 'user' }), null);
    const long = parseDirectoryEntry({
      user_id: 'u1', updated_at: 10, username: 'user', display_name: 'x'.repeat(65), avatar_hash: '../img',
    });
    assert.equal(long?.displayName, 'user');
    assert.equal(long?.avatarHash, null);
    const hidden = parseDirectoryEntry({
      user_id: 'u1', updated_at: 10, username: 'user', display_name: 'boss\u2066fake',
    });
    assert.equal(hidden?.displayName, 'user');
  });

  it('название сервера ровно 100 знаков принимается, а 101 и скрытая метка отвергаются', () => {
    // Ловит ошибку на границе и визуальную подмену названия сервера соседом.
    const base = { server_id: 's1', updated_at: 10, members: 1 };
    assert.equal(parseServerEntry({ ...base, name: 'x'.repeat(100) })?.name, 'x'.repeat(100));
    assert.equal(parseServerEntry({ ...base, name: 'x'.repeat(101) }), null);
    assert.equal(parseServerEntry({ ...base, name: 'server\u202efake' }), null);
  });

  it('негодная запись выбрасывается отдельно, а негодный конверт отвергается целиком', () => {
    const page = parseDirectoryPage({
      instance_id: 'i1',
      now: 20,
      entries: [{ user_id: 'bad' }, { user_id: 'u1', updated_at: 10, username: 'user' }],
    });
    assert.equal(page?.entries.length, 1);
    assert.equal(parseDirectoryPage({ instance_id: 'i1', now: 20 }), null);
    assert.equal(parseDirectoryPage({ now: 20, entries: [] }), null);
  });

  it('страница серверов различает битую запись и битый конверт тем же правилом', () => {
    const page = parseServerPage({
      instance_id: 'i1',
      now: 20,
      servers: [{ server_id: 'bad' }, { server_id: 's1', updated_at: 10, name: 'Сервер', members: 2 }],
    });
    assert.equal(page?.servers.length, 1);
    assert.equal(parseServerPage({ instance_id: 'i1', now: 20 }), null);
  });

  it('профиль и оба вида надгробий переживают сериализацию и разбор', () => {
    const entries: FedDirectoryEntry[] = [
      { userId: 'u1', updatedAt: 1, username: 'user', displayName: 'Имя', avatarHash: 'hash' },
      { userId: 'u2', updatedAt: 2, removed: 'hidden' },
      { userId: 'u3', updatedAt: 3, removed: 'deleted' },
    ];
    for (const entry of entries) assert.deepEqual(parseDirectoryEntry(serializeDirectoryEntry(entry)), entry);
  });

  it('живой и удалённый сервер, а также обе страницы переживают круг по проводу', () => {
    const servers: FedServerEntry[] = [
      { serverId: 's1', updatedAt: 1, name: 'Сервер', iconHash: 'hash', members: 3 },
      { serverId: 's2', updatedAt: 2, removed: true },
    ];
    for (const server of servers) assert.deepEqual(
      parseServerPage({ instance_id: 'i', now: 3, servers: [serializeServerEntry(server)] })?.servers[0],
      server,
    );
    const people: FedDirectoryPage = { instanceId: 'i', entries: [], nextCursor: null, full: true, now: 3 };
    const serverPage: FedServerPage = { instanceId: 'i', servers, nextCursor: 'next', full: false, now: 3 };
    assert.deepEqual(parseDirectoryPage(serializeDirectoryPage(people)), people);
    assert.deepEqual(parseServerPage(serializeServerPage(serverPage)), serverPage);
  });
});
