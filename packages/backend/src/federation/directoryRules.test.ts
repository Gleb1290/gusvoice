import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DIRECTORY_PAGE_MAX,
  decodeCursor,
  directoryEntryOf,
  encodeCursor,
  mediaHashOf,
  nextCursorOf,
  parseDirectoryQuery,
  type DirectorySource,
} from './directoryRules.js';

const person = (patch: Partial<DirectorySource> = {}): DirectorySource => ({
  userId: 'u1', username: 'user', displayName: 'Имя', avatarUrl: 'https://media/avatar-1.png',
  verified: true, approvedAt: new Date(1), deletedAt: null, hiddenFromPeers: false,
  homeInstanceId: null, directoryUpdatedAt: 100,
  ...patch,
});

describe('правила выдачи федеративного каталога', () => {
  it('обычный профиль виден, скрытый и удалённый становятся надгробиями без имени', () => {
    assert.deepEqual(directoryEntryOf(person()), {
      userId: 'u1', updatedAt: 100, username: 'user', displayName: 'Имя', avatarHash: mediaHashOf('https://media/avatar-1.png'),
    });
    assert.deepEqual(directoryEntryOf(person({ hiddenFromPeers: true })), { userId: 'u1', updatedAt: 100, removed: 'hidden' });
    assert.deepEqual(directoryEntryOf(person({ deletedAt: new Date(2) })), { userId: 'u1', updatedAt: 100, removed: 'deleted' });
  });

  it('неподтверждённый, неодобренный и гость третьего инстанса наружу не попадают', () => {
    assert.equal(directoryEntryOf(person({ verified: false })), null);
    assert.equal(directoryEntryOf(person({ approvedAt: null })), null);
    assert.equal(directoryEntryOf(person({ homeInstanceId: 'third' })), null);
  });

  it('удаление сильнее скрытия', () => {
    assert.equal(directoryEntryOf(person({ hiddenFromPeers: true, deletedAt: new Date(2) }))?.removed, 'deleted');
  });

  it('битый курсор, нулевой и дробный limit и отрицательный since дают явный отказ', () => {
    assert.deepEqual(parseDirectoryQuery({ cursor: 'broken' }), { ok: false, problem: 'bad-cursor' });
    assert.deepEqual(parseDirectoryQuery({ limit: '0' }), { ok: false, problem: 'bad-limit' });
    assert.deepEqual(parseDirectoryQuery({ limit: '1.5' }), { ok: false, problem: 'bad-limit' });
    assert.deepEqual(parseDirectoryQuery({ since: '-1' }), { ok: false, problem: 'bad-since' });
    assert.equal((parseDirectoryQuery({ limit: String(DIRECTORY_PAGE_MAX + 1) }) as { ok: true; value: { limit: number } }).value.limit, DIRECTORY_PAGE_MAX);
  });

  it('курсор переживает круг с base64url-символами в идентификаторе', () => {
    assert.deepEqual(decodeCursor(encodeCursor(123, 'id-with-_')), { updatedAt: 123, id: 'id-with-_' });
  });

  it('следующий курсор считается по строкам базы, а не по отданным профилям', () => {
    const rows = [{ at: 1, id: 'a', visible: true }, { at: 2, id: 'b', visible: false }];
    assert.equal(nextCursorOf(rows, 2, (row) => ({ updatedAt: row.at, id: row.id })), encodeCursor(2, 'b'));
    assert.equal(nextCursorOf(rows.slice(0, 1), 2, (row) => ({ updatedAt: row.at, id: row.id })), null);
  });

  it('отпечаток адреса устойчив, различает адреса и сохраняет отсутствие аватара', () => {
    assert.equal(mediaHashOf(null), null);
    assert.equal(mediaHashOf('https://a/x'), mediaHashOf('https://a/x'));
    assert.notEqual(mediaHashOf('https://a/x'), mediaHashOf('https://a/y'));
  });
});
