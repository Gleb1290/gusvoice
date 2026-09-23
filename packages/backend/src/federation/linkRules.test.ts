import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayLinkName, linkVerdict, nextLinkState, sameLooking, type LinkState } from './linkRules.js';

describe('состояния федеративной связки', () => {
  it('потеря доверия и ручная блокировка перебивают любое состояние', () => {
    const states: LinkState[] = ['requested', 'pending', 'active', 'paused', 'blocked', 'trust-lost'];
    for (const state of states) {
      assert.equal(nextLinkState(state, 'trust-broken'), 'trust-lost');
      assert.equal(nextLinkState(state, 'blocked'), 'blocked');
    }
  });

  it('подтверждается только заявка, а blocked и trust-lost открываются лишь разрешённым путём', () => {
    assert.equal(nextLinkState('requested', 'confirmed'), 'active');
    assert.equal(nextLinkState('pending', 'confirmed'), 'active');
    assert.equal(nextLinkState('active', 'confirmed'), null);
    assert.equal(nextLinkState('blocked', 'resumed'), null);
    assert.equal(nextLinkState('trust-lost', 'resumed'), null);
    assert.equal(nextLinkState('trust-lost', 'rebound'), 'active');
  });

  it('pending и blocked снаружи неразличимы, а глобальная пауза сильнее active', () => {
    assert.equal(linkVerdict({ state: 'pending' }, false), 'federation.server_closed');
    assert.equal(linkVerdict({ state: 'blocked' }, false), 'federation.server_closed');
    assert.equal(linkVerdict({ state: 'active' }, true), 'federation.paused');
    assert.equal(linkVerdict({ state: 'active' }, false), null);
  });

  it('регистр, пробелы и похожие латинские с кириллическими буквы требуют показать домен', () => {
    assert.equal(sameLooking(' Alpha ', 'alpha'), true);
    assert.equal(sameLooking('Cap', 'Сар'), true);
    assert.equal(displayLinkName({ theirName: 'Сар', localName: null, domain: 'peer.example', taken: ['Cap'] }), 'Сар (peer.example)');
    assert.equal(displayLinkName({ theirName: 'Unique', localName: null, domain: 'peer.example', taken: ['Other'] }), 'Unique');
  });
});
