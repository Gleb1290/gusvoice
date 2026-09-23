import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dropMediaFiles, planDirectoryBatch } from './directoryCacheCore.js';
import type { FedDirectoryEntry } from '@gusvoice/shared';

const profile = (overrides: Partial<FedDirectoryEntry> = {}): FedDirectoryEntry => ({
  userId: 'user', updatedAt: 10, username: 'masha', displayName: 'Маша', avatarHash: 'hash', ...overrides,
});

describe('план пачки федеративного каталога', () => {
  it('равная версия уже устарела и не перезаписывает строку', () => {
    // Ловит недетерминированный откат профиля при повторе той же страницы или события.
    const plan = planDirectoryBatch([profile()], [{ userId: 'user', updatedAt: 10, avatarLocalUrl: '/face.png' }]);
    assert.deepEqual(plan, { upserts: [], doomed: [], orphaned: [], removed: 0, stale: 1 });
  });

  it('надгробие незнакомого считается принятым удалением, но не выдумывает строку для DELETE', () => {
    // Ловит падение или ложный doomed при штатной доставке удаления раньше первоначального профиля.
    const plan = planDirectoryBatch([profile({ userId: 'missing', removed: 'deleted' })], []);
    assert.equal(plan.removed, 1);
    assert.deepEqual(plan.doomed, []);
    assert.equal(plan.stale, 0);
  });

  it('новый профиль без хеша снимает скачанную копию и помечает один и тот же файл сиротой', () => {
    // Ловит сохранение старого лица после того, как человек снял аватар дома.
    const entry = profile({ avatarHash: null });
    const plan = planDirectoryBatch([entry], [{ userId: 'user', updatedAt: 9, avatarLocalUrl: '/face.png' }]);
    assert.deepEqual(plan.upserts, [{ entry, staleCopy: '/face.png' }]);
    assert.deepEqual(plan.orphaned, ['/face.png']);
  });
});

describe('параллельная уборка копий каталога', () => {
  it('четыре работника с разными задержками возвращают точную сумму без потерянных прибавок', async () => {
    // Ловит гонку `freed += await`, где несколько завершений затирали уже освобождённые байты.
    const sizes = new Map([['a', 3], ['b', 5], ['c', 7], ['d', 11], ['e', 13]]);
    const releases: number[] = [];
    const returned = await dropMediaFiles({
      concurrency: 4, releaseEvery: 99,
      removeOwnMedia: async (url) => {
        await new Promise((resolve) => setTimeout(resolve, url.charCodeAt(0) % 4));
        return sizes.get(url) ?? 0;
      },
      release: async (_owner, bytes) => { releases.push(bytes); },
    }, 'peer', [...sizes.keys()]);
    assert.equal(returned, 39);
    assert.deepEqual(releases, [39]);
  });

  it('после каждой заданной пачки место возвращается отдельно, а не только в самом конце', async () => {
    // Ловит потерю всей квоты большого разрыва связки при перезапуске посреди уборки.
    const releases: number[] = [];
    assert.equal(await dropMediaFiles({
      concurrency: 1, releaseEvery: 2,
      removeOwnMedia: async () => 4,
      release: async (_owner, bytes) => { releases.push(bytes); },
    }, 'peer', ['a', 'b', 'c', 'd', 'e']), 20);
    assert.deepEqual(releases, [8, 8, 4]);
  });

  it('упавший файл не возвращает место, а упавший release глотается и не считается возвращённым', async () => {
    // Ловит завышение свободной квоты для оставшегося файла и срыв всей фоновой уборки из-за базы.
    let releaseCall = 0;
    const returned = await dropMediaFiles({
      concurrency: 1, releaseEvery: 1,
      removeOwnMedia: async (url) => {
        if (url === 'stays') throw new Error('storage down');
        return url === 'first' ? 5 : 7;
      },
      release: async () => { releaseCall += 1; if (releaseCall === 1) throw new Error('db down'); },
    }, 'peer', ['first', 'stays', 'last']);
    assert.equal(returned, 7);
    assert.equal(releaseCall, 2);
  });
});
