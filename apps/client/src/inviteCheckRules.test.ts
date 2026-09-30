import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { refusalOrMessage } from './inviteCheckRules.js';

describe('текст отказа приглашения', () => {
  it('обычные отказы ссылки переводятся, а неизвестная ошибка остаётся без выдуманной причины', () => {
    // Ловит возврат английского invalid invite в окно и потерю полезного текста новой ошибки.
    assert.notEqual(refusalOrMessage(new Error('invalid invite'), null), 'invalid invite');
    assert.notEqual(refusalOrMessage(new Error('invite expired'), null), 'invite expired');
    assert.equal(refusalOrMessage(new Error('сосед новее'), null), 'сосед новее');
  });

  it('код федерации превращается в человеческий текст с именем соседа', () => {
    // Ловит показ внутреннего протокольного кода вместо объяснения человеку.
    const text = refusalOrMessage(new Error('federation.guest_forbidden'), 'Сосед');
    assert.notEqual(text, 'federation.guest_forbidden');
    assert.ok(text.length > 0);
  });
});
