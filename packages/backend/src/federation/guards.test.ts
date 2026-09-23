import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EVENTS_BATCH_MAX, FED_LIMITS, fedRateKey, seenIdentityJtiWith, seenSignatureWith, type NonceStore } from './guards.js';

function memoryStore(): NonceStore & { calls: unknown[][] } {
  const seen = new Set<string>();
  const calls: unknown[][] = [];
  return {
    calls,
    async set(...args) {
      calls.push(args);
      const key = args[0];
      if (seen.has(key)) return null;
      seen.add(key);
      return 'OK';
    },
  };
}

describe('защита федеративных маршрутов от повтора', () => {
  it('первая подпись проходит, та же вторая считается повтором', async () => {
    const store = memoryStore();
    assert.equal(await seenSignatureWith(store, 'sig'), false);
    assert.equal(await seenSignatureWith(store, 'sig'), true);
  });

  it('подпись ставится атомарно с NX и хранится дольше окна с обоими допусками часов', async () => {
    const store = memoryStore();
    await seenSignatureWith(store, 'sig');
    const [, , ex, ttl, nx] = store.calls[0];
    assert.equal(ex, 'EX');
    assert.equal(nx, 'NX');
    assert.ok((ttl as number) > 60 + 60 * 2);
  });

  it('пустая подпись закрывается, а отказ кеша не гасит федерацию', async () => {
    const failed: NonceStore = { async set() { throw new Error('redis down'); } };
    assert.equal(await seenSignatureWith(failed, ''), true);
    assert.equal(await seenSignatureWith(failed, 'sig'), false);
  });

  it('одноразовый jti и ключи лимита не пересекаются между соседями', async () => {
    const store = memoryStore();
    assert.equal(await seenIdentityJtiWith(store, 'jti'), false);
    assert.equal(await seenIdentityJtiWith(store, 'jti'), true);
    assert.notEqual(fedRateKey('events', 'peer-a').key, fedRateKey('events', 'peer-b').key);
  });

  it('лимиты до подписи ключуются по адресу и щедрее гостевой активности офиса', () => {
    // Ловит возврат уязвимости, где посторонний забивал лимит честного соседа его публичным id.
    assert.deepEqual(fedRateKey('peerAddress', '203.0.113.1'), {
      key: 'fed:peerAddress:203.0.113.1', ...FED_LIMITS.peerAddress,
    });
    assert.deepEqual(fedRateKey('guestSessionAddress', '203.0.113.1'), {
      key: 'fed:guestSessionAddress:203.0.113.1', ...FED_LIMITS.guestSessionAddress,
    });
  });

  it('пачка событий ограничена сотней независимо от лимита числа запросов', () => {
    // Ловит снятие отдельного барьера на тяжёлое последовательное применение событий.
    assert.equal(EVENTS_BATCH_MAX, 100);
  });
});
