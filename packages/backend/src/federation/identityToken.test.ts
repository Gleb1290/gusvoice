import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { FED_IDENTITY_SKEW_MS, FED_IDENTITY_TTL_MS } from '@gusvoice/shared';
import { issueIdentityToken, peekIdentityToken, verifyIdentityToken } from './identityToken.js';

const keyPair = () => {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }),
  };
};

const claims = { iss: 'home', sub: 'user', aud: 'host', gen: 2, username: 'hidden', displayName: 'Скрытый', avatarHash: null };

describe('подписанный токен личности гостя', () => {
  it('выпущенный Ed25519-токен проверяется и возвращает подписанный профиль', () => {
    const key = keyPair();
    const issued = issueIdentityToken({ claims, kid: 'k1', privateKeyDer: key.privateKey, now: 1_000 });
    const verdict = verifyIdentityToken({ token: issued.token, findKey: () => key.publicKey, now: 1_000 });
    assert.equal(verdict.ok, true);
    if (verdict.ok) {
      assert.equal(verdict.claims.username, 'hidden');
      assert.equal(verdict.claims.displayName, 'Скрытый');
      assert.equal(verdict.claims.exp - verdict.claims.iat, FED_IDENTITY_TTL_MS);
    }
  });

  it('подмена sub при сохранённой подписи отвергается', () => {
    const key = keyPair();
    const issued = issueIdentityToken({ claims, kid: 'k1', privateKeyDer: key.privateKey, now: 1_000 });
    const [payload, sig] = issued.token.split('.');
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    body.sub = 'attacker';
    const tampered = `${Buffer.from(JSON.stringify(body)).toString('base64url')}.${sig}`;
    assert.deepEqual(verifyIdentityToken({ token: tampered, findKey: () => key.publicKey, now: 1_000 }), {
      ok: false, reason: 'bad-signature',
    });
  });

  it('JWT с alg none и тремя частями не принимается за наш двухчастный формат', () => {
    assert.equal(peekIdentityToken('eyJhbGciOiJub25lIn0.e30.'), null);
  });

  it('срок и допуск часов проверяются по обе стороны границы', () => {
    const key = keyPair();
    const issued = issueIdentityToken({ claims, kid: 'k1', privateKeyDer: key.privateKey, now: 1_000 });
    const findKey = () => key.publicKey;
    assert.equal(verifyIdentityToken({ token: issued.token, findKey, now: 1_000 - FED_IDENTITY_SKEW_MS }).ok, true);
    assert.deepEqual(verifyIdentityToken({ token: issued.token, findKey, now: 999 - FED_IDENTITY_SKEW_MS }), { ok: false, reason: 'future' });
    assert.equal(verifyIdentityToken({ token: issued.token, findKey, now: issued.claims.exp + FED_IDENTITY_SKEW_MS - 1 }).ok, true);
    assert.deepEqual(verifyIdentityToken({ token: issued.token, findKey, now: issued.claims.exp + FED_IDENTITY_SKEW_MS }), { ok: false, reason: 'expired' });
    assert.deepEqual(verifyIdentityToken({ token: issued.token, findKey, now: 1_000 + 5 * 60_000 }), { ok: false, reason: 'expired' });
  });

  it('неизвестный kid отличается от неверной подписи без раскрытия содержимого токена', () => {
    const signer = keyPair();
    const foreign = keyPair();
    const issued = issueIdentityToken({ claims, kid: 'k1', privateKeyDer: signer.privateKey, now: 1_000 });
    assert.deepEqual(verifyIdentityToken({ token: issued.token, findKey: () => null, now: 1_000 }), { ok: false, reason: 'unknown-key' });
    assert.deepEqual(verifyIdentityToken({ token: issued.token, findKey: () => foreign.publicKey, now: 1_000 }), { ok: false, reason: 'bad-signature' });
  });
});
