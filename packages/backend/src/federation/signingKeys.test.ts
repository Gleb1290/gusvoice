import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  issueSigningKey,
  keyForSigning,
  needsRotation,
  pruneKeys,
  publishedKeys,
  signingKeyPayload,
  toDocumentKey,
  verifySigningKey,
  type SigningKeyPair,
} from './signingKeys.js';

const root = () => {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }),
  };
};

describe('сменные ключи федерации', () => {
  it('свой корень подтверждает выпуск, чужой — нет', () => {
    const ours = root();
    const foreign = root();
    const key = toDocumentKey(issueSigningKey(ours.privateKey, 100));
    assert.equal(verifySigningKey(ours.publicKey, key), true);
    assert.equal(verifySigningKey(foreign.publicKey, key), false);
  });

  it('два выпуска имеют разные kid, несмотря на общий DER-префикс Ed25519', () => {
    const ours = root();
    assert.notEqual(issueSigningKey(ours.privateKey, 100).kid, issueSigningKey(ours.privateKey, 100).kid);
  });

  it('длины полей не дают двум разбиениям одну подписываемую строку', () => {
    const a = signingKeyPayload({ kid: 'ab', publicKey: 'c', notBefore: 1, notAfter: 2 });
    const b = signingKeyPayload({ kid: 'a', publicKey: 'bc', notBefore: 1, notAfter: 2 });
    assert.notDeepEqual(a, b);
  });

  it('в перекрытии выбирается самый свежий действующий ключ, а после срока — null', () => {
    const ours = root();
    const old = issueSigningKey(ours.privateKey, 100, 100);
    const fresh = issueSigningKey(ours.privateKey, 150, 100);
    assert.equal(keyForSigning([old, fresh], 175)?.kid, fresh.kid);
    assert.equal(keyForSigning([old, fresh], 251), null);
  });

  it('ротация начинается в окне перекрытия, публикация и очистка сохраняют только нужную историю', () => {
    const ours = root();
    const fresh = issueSigningKey(ours.privateKey, 100, 100);
    const expired = issueSigningKey(ours.privateKey, 0, 50);
    const ancient = issueSigningKey(ours.privateKey, -200, 50);
    assert.equal(needsRotation([fresh], 120, 20), false);
    assert.equal(needsRotation([fresh], 180, 20), true);
    assert.deepEqual(publishedKeys([fresh, expired, ancient], 120, 100).map((k) => k.kid), [fresh.kid, expired.kid]);
    assert.deepEqual(pruneKeys([fresh, expired, ancient], 120, 100).map((k) => k.kid), [fresh.kid, expired.kid]);
    assert.equal((fresh satisfies SigningKeyPair).kid, fresh.kid);
  });
});
