import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { extractInvite, offerInviteLink, takeInviteLink } from './deepLinkInvite.js';

afterEach(() => { takeInviteLink(); });

describe('внешняя ссылка приглашения', () => {
  it('обычная http(s)-ссылка /i/ принимается без автоматического входа', () => {
    // Ловит потерю основной двери из браузера в окно проверки приглашения.
    const link = 'https://voice.example/i/Ab12';
    assert.equal(extractInvite(link), link);
    assert.equal(offerInviteLink(link), true);
    assert.equal(takeInviteLink(), link);
  });

  it('схема gusvoice принимает только действие join с вложенной ссылкой', () => {
    // Ловит выполнение угаданного постороннего действия собственной схемы приложения.
    const invite = 'https://voice.example/i/Ab12';
    assert.equal(extractInvite(`gusvoice://join?invite=${encodeURIComponent(invite)}`), invite);
    assert.equal(extractInvite(`gusvoice://open?invite=${encodeURIComponent(invite)}`), null);
  });

  it('javascript, data и ссылка без /i/ отвергаются', () => {
    // Ловит запуск небезопасной схемы и принятие обычного адреса за приглашение.
    assert.equal(extractInvite('javascript:alert(1)'), null);
    assert.equal(extractInvite('data:text/plain,Ab12'), null);
    assert.equal(extractInvite('https://voice.example/Ab12'), null);
  });

  it('взятие намерения очищает его ровно один раз', () => {
    // Ловит повторное открытие уже обработанного приглашения при следующей отрисовке.
    const link = 'https://voice.example/i/Ab12';
    offerInviteLink(link);
    assert.equal(takeInviteLink(), link);
    assert.equal(takeInviteLink(), null);
  });
});
