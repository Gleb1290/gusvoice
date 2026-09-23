import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkLinkCode, decodeLinkCode, encodeLinkCode, hashLinkSecret, linkSecretMatches, type LinkCodePayload } from './linkCode.js';

const code: LinkCodePayload = {
  domain: 'voice.example', fingerprint: 'AAAA-BBBB', secret: 'secret', expiresAt: 200, purpose: 'link',
};

describe('одноразовый код федеративной связки', () => {
  it('код переживает круг и разбирается из человеческой обёртки', () => {
    const encoded = encodeLinkCode(code);
    assert.deepEqual(decodeLinkCode(`\nВот код: ${encoded}\nСпасибо`), code);
  });

  it('код с отсутствующим обязательным полем не превращается в объект с дыркой', () => {
    const broken = `GVLINK1:${Buffer.from(JSON.stringify({ d: code.domain, f: code.fingerprint, e: code.expiresAt, p: 'link' })).toString('base64url')}`;
    assert.equal(decodeLinkCode(broken), null);
  });

  it('секрет совпадает только со своим хешем и другая длина не бросает', () => {
    const hash = hashLinkSecret('right');
    assert.equal(linkSecretMatches('right', hash), true);
    assert.equal(linkSecretMatches('wrong', hash), false);
    assert.doesNotThrow(() => linkSecretMatches('right', 'short'));
  });

  it('просрочка, связка с собой и подмена отпечатка различаются', () => {
    const ctx = { now: 100, myInstanceId: 'me', theirFingerprint: code.fingerprint, theirInstanceId: 'them' };
    assert.equal(checkLinkCode({ ...code, expiresAt: 100 }, ctx), 'expired');
    assert.equal(checkLinkCode(code, { ...ctx, theirInstanceId: 'me' }), 'self');
    assert.equal(checkLinkCode(code, { ...ctx, theirFingerprint: 'FOREIGN' }), 'fingerprint-mismatch');
    assert.equal(checkLinkCode(code, ctx), null);
  });
});
