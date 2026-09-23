import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { parseSignatureInput, signRequest, signatureBase, verifyRequest } from './httpSignature.js';

const pair = () => {
  const key = generateKeyPairSync('ed25519');
  return {
    privateKey: key.privateKey.export({ type: 'pkcs8', format: 'der' }),
    publicKey: key.publicKey.export({ type: 'spki', format: 'der' }),
  };
};

const request = (privateKey: Buffer, nowS = 100) => {
  const body = '{"ok":true}';
  return {
    method: 'POST', targetUri: 'https://peer.example/api/fed/events', body,
    headers: signRequest({ method: 'POST', targetUri: 'https://peer.example/api/fed/events', body, keyid: 'k1', privateKeyDer: privateKey, nowS }),
  };
};

describe('HTTP-подпись федеративного запроса', () => {
  it('подменённое тело отвергается до криптографической проверки', () => {
    const key = pair();
    const signed = request(key.privateKey);
    assert.deepEqual(verifyRequest({ ...signed, body: '{"ok":false}', findKey: () => key.publicKey, nowS: 100 }), {
      ok: false, reason: 'bad-signature',
    });
  });

  it('отправитель не может объявить достаточным один лишь метод', () => {
    const key = pair();
    const signed = request(key.privateKey);
    signed.headers['signature-input'] = signed.headers['signature-input'].replace(
      '"@method" "@target-uri" "content-digest"',
      '"@method"',
    );
    assert.deepEqual(verifyRequest({ ...signed, findKey: () => key.publicKey, nowS: 100 }), {
      ok: false, reason: 'malformed',
    });
  });

  it('параметры подписи остаются последней строкой подписываемой базы', () => {
    const base = signatureBase({ method: 'get', targetUri: 'https://peer.example/x', contentDigest: 'sha-256=:x:', keyid: 'k', created: 1, expires: 2 });
    assert.match(base.split('\n').at(-1) ?? '', /^"@signature-params": /);
  });

  it('подмена метода или адреса ломает подпись', () => {
    const key = pair();
    const signed = request(key.privateKey);
    assert.equal(verifyRequest({ ...signed, method: 'PUT', findKey: () => key.publicKey, nowS: 100 }).ok, false);
    assert.equal(verifyRequest({ ...signed, targetUri: 'https://peer.example/other', findKey: () => key.publicKey, nowS: 100 }).ok, false);
  });

  it('чужой ключ отличается от неизвестного правильными причинами', () => {
    const signer = pair();
    const foreign = pair();
    const signed = request(signer.privateKey);
    assert.deepEqual(verifyRequest({ ...signed, findKey: () => foreign.publicKey, nowS: 100 }), { ok: false, reason: 'bad-signature' });
    assert.deepEqual(verifyRequest({ ...signed, findKey: () => null, nowS: 100 }), { ok: false, reason: 'unknown-key' });
  });

  it('допуск часов включителен, а следующий шаг даёт clock-skew или expired', () => {
    const key = pair();
    const signed = request(key.privateKey, 100);
    assert.equal(verifyRequest({ ...signed, findKey: () => key.publicKey, nowS: 40 }).ok, true);
    assert.deepEqual(verifyRequest({ ...signed, findKey: () => key.publicKey, nowS: 39 }), { ok: false, reason: 'clock-skew', skewS: 61 });
    assert.equal(verifyRequest({ ...signed, findKey: () => key.publicKey, nowS: 220 }).ok, true);
    assert.deepEqual(verifyRequest({ ...signed, findKey: () => key.publicKey, nowS: 221 }), { ok: false, reason: 'expired', skewS: 61 });
  });

  it('просроченная подпись чужим ключом остаётся bad-signature, а верным — expired', () => {
    // Ловит утечку сведений о времени проверки тому, кто не доказал владение ключом соседа.
    const signer = pair();
    const foreign = pair();
    const signed = request(signer.privateKey, 100);
    assert.deepEqual(verifyRequest({ ...signed, findKey: () => foreign.publicKey, nowS: 221 }), {
      ok: false, reason: 'bad-signature',
    });
    assert.deepEqual(verifyRequest({ ...signed, findKey: () => signer.publicKey, nowS: 221 }), {
      ok: false, reason: 'expired', skewS: 61,
    });
  });

  it('чужой алгоритм и мусорные заголовки дают отказ, а не исключение', () => {
    const key = pair();
    const signed = request(key.privateKey);
    assert.equal(parseSignatureInput(signed.headers['signature-input'].replace('ed25519', 'rsa')), null);
    assert.deepEqual(verifyRequest({ ...signed, headers: { ...signed.headers, 'signature-input': 'garbage' }, findKey: () => key.publicKey, nowS: 100 }), {
      ok: false, reason: 'malformed',
    });
  });
});
