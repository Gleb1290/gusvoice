import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { statusFieldsOf } from './statusRules.js';

describe('сериализация presence и кастомного статуса', () => {
  it('все четыре поддерживаемых presence-статуса сохраняются', () => {
    // Ловит случайное схлопывание dnd/away/invisible в online.
    for (const status of ['online', 'dnd', 'away', 'invisible']) {
      assert.equal(statusFieldsOf({ presenceStatus: status }, 1_000).status, status);
    }
  });

  it('мусорное, пустое и отсутствующее значение безопасно становятся online', () => {
    // Ловит передачу клиенту состояния, для которого у него нет визуального варианта.
    assert.equal(statusFieldsOf({ presenceStatus: 'busy' }, 1_000).status, 'online');
    assert.equal(statusFieldsOf({ presenceStatus: '' }, 1_000).status, 'online');
    assert.equal(statusFieldsOf({ presenceStatus: null }, 1_000).status, 'online');
    assert.equal(statusFieldsOf({}, 1_000).status, 'online');
  });

  it('неистёкший emoji+text сериализуется вместе с ISO-сроком', () => {
    // Ловит потерю одного из полей или выдачу Date вместо строкового DTO.
    assert.deepEqual(
      statusFieldsOf(
        {
          presenceStatus: 'away',
          customStatusEmoji: '🌴',
          customStatusText: 'Отдыхаю',
          customStatusExpiresAt: new Date(2_000),
        },
        1_000,
      ),
      {
        status: 'away',
        customStatus: { emoji: '🌴', text: 'Отдыхаю', expiresAt: new Date(2_000).toISOString() },
      },
    );
  });

  it('за миллисекунду до срока статус жив, ровно в срок уже null', () => {
    // Ловит ошибку на включительной границе истечения кастомного статуса.
    const row = { customStatusText: 'Скоро вернусь', customStatusExpiresAt: new Date(2_000) };
    assert.ok(statusFieldsOf(row, 1_999).customStatus);
    assert.equal(statusFieldsOf(row, 2_000).customStatus, null);
  });

  it('пустые emoji и text дают null даже без срока', () => {
    // Ловит отображение пустой строки статуса как отдельной пустой плашки.
    assert.equal(statusFieldsOf({ customStatusEmoji: '', customStatusText: '' }, 1_000).customStatus, null);
    assert.equal(statusFieldsOf({ customStatusEmoji: null, customStatusText: null }, 1_000).customStatus, null);
  });

  it('одного emoji или одного текста достаточно для живого статуса', () => {
    // Ловит чрезмерное требование заполнить обе необязательные части статуса.
    assert.deepEqual(statusFieldsOf({ customStatusEmoji: '🎮' }, 1_000).customStatus, {
      emoji: '🎮',
      text: null,
      expiresAt: null,
    });
    assert.deepEqual(statusFieldsOf({ customStatusText: 'Играю' }, 1_000).customStatus, {
      emoji: null,
      text: 'Играю',
      expiresAt: null,
    });
  });

  it('истечение custom status не меняет основной presence', () => {
    // Ловит случайное превращение dnd в online при очистке просроченного текста.
    assert.deepEqual(
      statusFieldsOf({ presenceStatus: 'dnd', customStatusText: 'Занят', customStatusExpiresAt: new Date(1_000) }, 1_000),
      { status: 'dnd', customStatus: null },
    );
  });
});

