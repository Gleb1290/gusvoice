import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { copyKey, createAvatarCopier, genuineImage, type AvatarCopyDeps } from './avatarsCore.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const GIF = Buffer.from('GIF89a......');
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(overrides: Partial<AvatarCopyDeps> = {}) {
  const calls = { network: 0, reserve: [] as number[], release: [] as number[], put: 0, remove: [] as string[], swap: 0, clear: 0 };
  const deps: AvatarCopyDeps = {
    signer: () => ({ instanceId: 'self', kid: 'k', privateKeyDer: new Uint8Array() }),
    getLink: async () => ({ apiBase: 'https://peer.example' }),
    refetchAllowed: async () => true,
    getSignedFromPeer: async () => {
      calls.network += 1;
      return { ok: true, value: { status: 200, body: '', bytes: PNG, contentType: 'image/png' } };
    },
    putMedia: async () => { calls.put += 1; return '/new.png'; },
    removeOwnMedia: async (url) => { calls.remove.push(url); return url === '/old.png' ? 7 : PNG.length; },
    now: () => 100,
    copySuffix: () => 'unique',
    peer: {
      read: async () => ({ avatarHash: 'new-hash', avatarLocalUrl: '/old.png', avatarCachedHash: 'old-hash' }),
      clear: async () => { calls.clear += 1; return true; },
      swap: async () => { calls.swap += 1; return true; },
      current: async () => '/winner.png',
    },
    guest: {
      read: async () => ({ id: 'shadow', avatarUrl: '/old.png', homeAvatarHash: 'old-hash' }),
      clear: async () => true,
      swap: async () => true,
      current: async () => '/winner.png',
    },
    linkQuota: {
      reserve: async (_owner, bytes) => { calls.reserve.push(bytes); return null; },
      release: async (_owner, bytes) => { calls.release.push(bytes); },
    },
    userQuota: { reserve: async () => null, release: async () => {} },
    ...overrides,
  };
  return { copier: createAvatarCopier(deps), calls };
}

describe('копирование аватаров федерации', () => {
  it('объявленный PNG с GIF или текстом внутри не попадает ни в квоту, ни в хранилище', async () => {
    // Ловит загрузку произвольного публичного файла под доверенным Content-Type соседа.
    assert.equal(genuineImage(GIF, 'image/png'), null);
    assert.equal(genuineImage(Buffer.from('plain text!!'), 'image/png'), null);
    for (const bytes of [GIF, Buffer.from('plain text!!')]) {
      const h = harness({ getSignedFromPeer: async () => ({ ok: true, value: { status: 200, body: '', bytes, contentType: 'image/png' } }) });
      assert.equal(await h.copier.peerAvatarUrl('peer', 'user'), '/old.png');
      assert.deepEqual(h.calls.reserve, []);
      assert.equal(h.calls.put, 0);
    }
  });

  it('отказ квоты не пишет файл', async () => {
    // Ловит обход лимита хранилища записью до резервирования места.
    const h = harness({ linkQuota: { reserve: async (_owner, bytes) => { h.calls.reserve.push(bytes); return 'federation.quota_exceeded'; }, release: async () => {} } });
    assert.equal(await h.copier.peerAvatarUrl('peer', 'user'), '/old.png');
    assert.equal(h.calls.put, 0);
  });

  it('ошибка хранилища возвращает ровно зарезервированные байты', async () => {
    // Ловит вечную утечку квоты при сбое между reserve и put.
    const h = harness({ putMedia: async () => { h.calls.put += 1; throw new Error('storage down'); } });
    assert.equal(await h.copier.peerAvatarUrl('peer', 'user'), '/old.png');
    assert.deepEqual(h.calls.release, [PNG.length]);
  });

  it('проигравший CAS удаляет свой новый файл, возвращает его квоту и показывает победителя', async () => {
    // Ловит сироту и двойное списание места при двух одновременных загрузках лица.
    const h = harness({ peer: {
      read: async () => ({ avatarHash: 'new-hash', avatarLocalUrl: '/old.png', avatarCachedHash: 'old-hash' }),
      clear: async () => false,
      swap: async () => false,
      current: async () => '/winner.png',
    } });
    assert.equal(await h.copier.peerAvatarUrl('peer', 'user'), '/winner.png');
    await tick();
    assert.deepEqual(h.calls.remove, ['/new.png']);
    assert.deepEqual(h.calls.release, [PNG.length]);
  });

  it('успешная замена удаляет старую копию и возвращает именно её размер', async () => {
    // Ловит накопление старых лиц и постепенное ложное исчерпание квоты.
    const h = harness();
    assert.equal(await h.copier.peerAvatarUrl('peer', 'user'), '/new.png');
    await tick();
    assert.deepEqual(h.calls.remove, ['/old.png']);
    assert.deepEqual(h.calls.release, [7]);
  });

  it('снятый дома аватар удаляет прочитанный файл только после успешного clear', async () => {
    // Ловит удаление файла новой гонки по уже устаревшему чтению строки.
    for (const cleared of [false, true]) {
      const h = harness({ peer: {
        read: async () => ({ avatarHash: null, avatarLocalUrl: '/old.png', avatarCachedHash: 'old-hash' }),
        clear: async () => cleared,
        swap: async () => true,
        current: async () => null,
      } });
      assert.equal(await h.copier.peerAvatarUrl('peer', 'user'), null);
      await tick();
      assert.deepEqual(h.calls.remove, cleared ? ['/old.png'] : []);
    }
  });

  it('ожидающий swap служит барьером: результат не выходит до решения CAS', async () => {
    // Ловит ранний возврат ссылки на файл, который ещё не привязан к строке и может быть убран гонкой.
    let release!: (value: boolean) => void;
    const swap = new Promise<boolean>((resolve) => { release = resolve; });
    const h = harness({ peer: {
      read: async () => ({ avatarHash: 'new-hash', avatarLocalUrl: null, avatarCachedHash: null }),
      clear: async () => false,
      swap: async () => swap,
      current: async () => '/winner.png',
    } });
    let settled = false;
    const work = h.copier.peerAvatarUrl('peer', 'user').then((value) => { settled = true; return value; });
    await tick();
    assert.equal(settled, false);
    release(true);
    assert.equal(await work, '/new.png');
  });

  it('отказ частоты останавливает сеть и оставляет прежнюю копию', async () => {
    // Ловит обход лимита перекачки аватаров меняющим отпечатки соседом.
    const h = harness({ refetchAllowed: async () => false });
    assert.equal(await h.copier.peerAvatarUrl('peer', 'user'), '/old.png');
    assert.equal(h.calls.network, 0);
  });

  it('имя каждой копии сохраняет владельцев и уникальный хвост', () => {
    // Ловит совпадение двух загрузок в одну миллисекунду и удаление файла победителя проигравшим.
    assert.equal(copyKey('peer', 'user', 'random-tail'), 'peer-user-random-tail');
  });

  it('forgetCopy возвращает квоту только за реально удалённый файл и глотает сбои уборки', async () => {
    // Ловит возврат неосвобождённых байт и падение фоновой уборки в пользовательский запрос.
    const released: number[] = [];
    for (const removeOwnMedia of [async () => 0, async () => { throw new Error('down'); }]) {
      const h = harness({ removeOwnMedia });
      await h.copier.forgetCopy('/file', async (bytes) => { released.push(bytes); });
    }
    const h = harness({ removeOwnMedia: async () => 9 });
    await h.copier.forgetCopy('/file', async (bytes) => { released.push(bytes); });
    assert.deepEqual(released, [9]);
  });

  it('гостевой аватар без отпечатка удаляет прочитанный файл только после успешного clear', async () => {
    // Ловит удаление уже заменённого лица гостя медленным запросом со старой строкой.
    for (const cleared of [false, true]) {
      const h = harness({ guest: {
        read: async () => ({ id: 'shadow', avatarUrl: '/old.png', homeAvatarHash: 'old-hash' }),
        clear: async () => cleared,
        swap: async () => true,
        current: async () => null,
      } });
      assert.equal(await h.copier.refreshGuestAvatar({ shadowUserId: 'shadow', instanceId: 'peer', homeUserId: 'home-user', avatarHash: null }), null);
      await tick();
      assert.deepEqual(h.calls.remove, cleared ? ['/old.png'] : []);
    }
  });

  it('гостевой предел частоты оставляет прежнее лицо и не обращается к соседу', async () => {
    // Ловит отдельный обход rate-limit через гостевой путь того же домашнего аватара.
    const h = harness({ refetchAllowed: async () => false });
    assert.equal(await h.copier.refreshGuestAvatar({ shadowUserId: 'shadow', instanceId: 'peer', homeUserId: 'home-user', avatarHash: 'new-hash' }), '/old.png');
    assert.equal(h.calls.network, 0);
  });

  it('проигравший гостевой CAS убирает новый файл, возвращает квоту и показывает победителя', async () => {
    // Ловит сироту и возврат старого лица при одновременных обновлениях гостя.
    const released: number[] = [];
    const h = harness({
      guest: {
        read: async () => ({ id: 'shadow', avatarUrl: '/old.png', homeAvatarHash: 'old-hash' }),
        clear: async () => false,
        swap: async () => false,
        current: async () => '/winner.png',
      },
      userQuota: { reserve: async () => null, release: async (_owner, bytes) => { released.push(bytes); } },
    });
    assert.equal(await h.copier.refreshGuestAvatar({ shadowUserId: 'shadow', instanceId: 'peer', homeUserId: 'home-user', avatarHash: 'new-hash' }), '/winner.png');
    await tick();
    assert.deepEqual(h.calls.remove, ['/new.png']);
    assert.deepEqual(released, [PNG.length]);
  });

  it('успешная замена гостевого аватара снимает старый файл и возвращает его размер', async () => {
    // Ловит накопление старых гостевых лиц вне пользовательской квоты.
    const released: number[] = [];
    const h = harness({ userQuota: {
      reserve: async () => null,
      release: async (_owner, bytes) => { released.push(bytes); },
    } });
    assert.equal(await h.copier.refreshGuestAvatar({ shadowUserId: 'shadow', instanceId: 'peer', homeUserId: 'home-user', avatarHash: 'new-hash' }), '/new.png');
    await tick();
    assert.deepEqual(h.calls.remove, ['/old.png']);
    assert.deepEqual(released, [7]);
  });
});
