import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayLinkName, linkDisplayNames, linkVerdict, nextLinkState, sameLooking, type LinkState } from './linkRules.js';

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

  it('перепривязка сохраняет рабочее и приостановленное состояние, но не оживляет заявки и блокировку', () => {
    // Ловит превращение административной блокировки или незавершённой заявки в рабочую связку.
    assert.equal(nextLinkState('active', 'rebound'), 'active');
    assert.equal(nextLinkState('paused', 'rebound'), 'paused');
    assert.equal(nextLinkState('trust-lost', 'rebound'), 'active');
    for (const state of ['requested', 'pending', 'blocked'] as const) {
      assert.equal(nextLinkState(state, 'rebound'), null, state);
    }
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

  it('карта имён различает одноимённых соседей и собственное имя инстанса', () => {
    // Ловит две визуально одинаковые связки, между которыми держатель не может безопасно выбрать.
    const names = linkDisplayNames([
      { instanceId: 'one', theirName: 'Friends', localName: null, domain: 'one.example' },
      { instanceId: 'two', theirName: 'Frіends', localName: null, domain: 'two.example' },
      { instanceId: 'three', theirName: 'Home', localName: null, domain: 'three.example' },
    ], 'Home');
    assert.equal(names.get('one'), 'Friends (one.example)');
    assert.equal(names.get('two'), 'Frіends (two.example)');
    assert.equal(names.get('three'), 'Home (three.example)');
  });

  it('локальное имя выигрывает у чужого, а пустое честно остаётся без подписи', () => {
    // Ловит возврат недоверенного имени соседа после того, как держатель задал своё или очистил подпись.
    const names = linkDisplayNames([
      { instanceId: 'named', theirName: 'Чужое', localName: '  Моё  ', domain: 'named.example' },
      { instanceId: 'empty', theirName: null, localName: '   ', domain: 'empty.example' },
    ], null);
    assert.equal(names.get('named'), 'Моё');
    assert.equal(names.get('empty'), null);
  });
});
