import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  base32Lower,
  fingerprintFrom,
  instanceIdFrom,
  isInstanceId,
  shortFingerprint,
  shortInstanceId,
} from './instanceIdentity.js';

const publicDer = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });

describe('личность федеративного инстанса', () => {
  it('один корневой ключ даёт устойчивый id, а другой — другую личность', () => {
    const first = publicDer();
    const second = publicDer();
    assert.equal(instanceIdFrom(first), instanceIdFrom(first));
    assert.notEqual(instanceIdFrom(first), instanceIdFrom(second));
    assert.equal(isInstanceId(instanceIdFrom(first)), true);
  });

  it('страж id отсекает неверную длину, регистр и символы пути', () => {
    const valid = instanceIdFrom(publicDer());
    for (const value of ['', null, valid.toUpperCase(), `${valid}/`, `.${valid}`, valid.slice(1), `${valid}a`]) {
      assert.equal(isInstanceId(value), false, String(value));
    }
  });

  it('base32 совпадает с известными векторами RFC и не добавляет выравнивание', () => {
    assert.equal(base32Lower(Buffer.from('f')), 'my');
    assert.equal(base32Lower(Buffer.from('foo')), 'mzxw6');
    assert.equal(base32Lower(Buffer.from('foobar')), 'mzxw6ytboi');
    assert.equal(base32Lower(Buffer.from('foobar')).includes('='), false);
  });

  it('отпечаток группируется по четыре, а короткие значения не выдумывают многоточие', () => {
    const fingerprint = fingerprintFrom(publicDer());
    assert.match(fingerprint, /^(?:[0-9A-F]{4}-){15}[0-9A-F]{4}$/);
    assert.equal(shortFingerprint('AAAA-BBBB', 4), 'AAAA-BBBB');
    assert.equal(shortInstanceId('abcdef', 4, 2), 'abcdef');
    assert.equal(shortFingerprint(fingerprint, 2), `${fingerprint.split('-').slice(0, 2).join('-')}-…`);
  });
});
