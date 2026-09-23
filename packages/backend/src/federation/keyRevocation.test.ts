import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  checkRevocation,
  parseRevocation,
  planRebind,
  revocationPayload,
  serializeRevocation,
  signRevocation,
} from './keyRevocation.js';

const root = () => {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }),
  };
};

describe('отзыв корневого ключа федерации', () => {
  it('отзыв, подписанный старым ключом, принимается, а подписанный чужим — нет', () => {
    const old = root();
    const foreign = root();
    const body = { oldInstanceId: 'old', newInstanceId: 'new', newRootKey: 'new-key', revokedAt: 100 };
    assert.equal(checkRevocation(signRevocation(old.privateKey, body), { knownInstanceId: 'old', knownRootKeyDer: old.publicKey, now: 100 }), null);
    assert.equal(checkRevocation(signRevocation(foreign.privateKey, body), { knownInstanceId: 'old', knownRootKeyDer: old.publicKey, now: 100 }), 'bad-signature');
  });

  it('подмена новой личности или нового корневого ключа ломает старую подпись', () => {
    const old = root();
    const notice = signRevocation(old.privateKey, { oldInstanceId: 'old', newInstanceId: 'new', newRootKey: 'key-a', revokedAt: 100 });
    const ctx = { knownInstanceId: 'old', knownRootKeyDer: old.publicKey, now: 100 };
    assert.equal(checkRevocation({ ...notice, newInstanceId: 'attacker' }, ctx), 'bad-signature');
    assert.equal(checkRevocation({ ...notice, newRootKey: 'key-b' }, ctx), 'bad-signature');
  });

  it('чужая связка, тот же ключ и отзыв из будущего имеют отдельные причины', () => {
    const old = root();
    const future = signRevocation(old.privateKey, { oldInstanceId: 'old', newInstanceId: 'new', newRootKey: 'key', revokedAt: 1_001 });
    assert.equal(checkRevocation(future, { knownInstanceId: 'other', knownRootKeyDer: old.publicKey, now: 1_000 }), 'wrong-instance');
    assert.equal(checkRevocation({ ...future, newInstanceId: 'old' }, { knownInstanceId: 'old', knownRootKeyDer: old.publicKey, now: 1_000 }), 'same-key');
    assert.equal(checkRevocation(future, { knownInstanceId: 'old', knownRootKeyDer: old.publicKey, now: 0, toleranceMs: 1_000 }), 'from-future');
  });

  it('длины полей не дают двум разбиениям одинаковую нагрузку', () => {
    assert.notDeepEqual(
      revocationPayload({ oldInstanceId: 'ab', newInstanceId: 'c', newRootKey: 'k', revokedAt: 1 }),
      revocationPayload({ oldInstanceId: 'a', newInstanceId: 'bc', newRootKey: 'k', revokedAt: 1 }),
    );
  });

  it('провод сохраняет отзыв, а перепривязка сохраняет имя и сбрасывает счётчики', () => {
    const old = root();
    const notice = signRevocation(old.privateKey, { oldInstanceId: 'old', newInstanceId: 'new', newRootKey: 'key', revokedAt: 1 });
    assert.deepEqual(parseRevocation(serializeRevocation(notice)), notice);
    assert.deepEqual(planRebind('old', 'new'), {
      fromInstanceId: 'old', toInstanceId: 'new', keepLocalName: true, resetEventCounters: true,
    });
  });
});
