import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inviteLinkFor, parseInviteInput, sameOrigin } from './inviteLink.js';

describe('ссылка федеративного приглашения', () => {
  it('короткий код остаётся локальным приглашением', () => {
    assert.deepEqual(parseInviteInput('  Ab_cd-12  '), { code: 'Ab_cd-12', origin: null });
  });

  it('ссылка с query и хвостом мессенджера отдаёт origin и чистый код', () => {
    assert.deepEqual(parseInviteInput('https://voice.example/i/Abcd/trailing/?utm_source=chat'), {
      code: 'Abcd',
      origin: 'https://voice.example',
    });
    assert.equal(inviteLinkFor('https://voice.example///', 'Abcd'), 'https://voice.example/i/Abcd');
  });

  it('исполняемые схемы не проходят как приглашения', () => {
    assert.equal(parseInviteInput('javascript:alert(1)/i/Abcd'), null);
    assert.equal(parseInviteInput('data:text/plain,/i/Abcd'), null);
  });

  it('одинаковый домен по http и https — разные инстансы', () => {
    assert.equal(sameOrigin('https://voice.example/', 'https://voice.example'), true);
    assert.equal(sameOrigin('https://voice.example', 'http://voice.example'), false);
    assert.equal(sameOrigin('https://voice.example', 'https://voice.example:8443'), false);
  });
});
