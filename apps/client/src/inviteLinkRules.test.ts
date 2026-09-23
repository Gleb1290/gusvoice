import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inviteCodeFromPath, inviteLink, parseInviteParam, stripInviteParam } from './inviteLinkRules.js';

describe('ссылки приглашения веб-клиента', () => {
  it('код длиной ровно 4 и 64 символа принимается, соседние границы отвергаются', () => {
    // Ловит ошибку на границах формата кода, которым обмениваются мастер и регистрация.
    assert.equal(parseInviteParam('?invite=Ab12'), 'Ab12');
    assert.equal(parseInviteParam(`?invite=${'a'.repeat(64)}`), 'a'.repeat(64));
    assert.equal(parseInviteParam('?invite=abc'), null);
    assert.equal(parseInviteParam(`?invite=${'a'.repeat(65)}`), null);
  });

  it('пробелы вокруг кода обрезаются, а знаки пунктуации отвергаются', () => {
    // Ловит как отказ скопированному коду, так и пропуск чужого текста внутрь API.
    assert.equal(parseInviteParam('?invite=%20Ab12%20'), 'Ab12');
    assert.equal(parseInviteParam('?invite=Ab-12'), null);
  });

  it('удаление invite сохраняет остальные параметры и удаляет все повторы', () => {
    // Ловит утечку кода в историю адреса после автоматического входа.
    assert.equal(stripInviteParam('?x=1&invite=Ab12&invite=Cd34&y=2'), '?x=1&y=2');
    assert.equal(stripInviteParam('?invite=Ab12'), '');
  });

  it('сборка ссылки убирает лишние слеши и кодирует код', () => {
    // Ловит двойной слеш и повреждение специальных символов при копировании ссылки.
    assert.equal(inviteLink('https://voice.example///', 'A B'), 'https://voice.example/?invite=A%20B');
  });

  it('путь принимает только сегмент /i/ с теми же границами кода', () => {
    // Ловит расхождение двух дверей одного приглашения: query и публичной страницы.
    assert.equal(inviteCodeFromPath('/i/Ab12'), 'Ab12');
    assert.equal(inviteCodeFromPath('/x/Ab12'), null);
    assert.equal(inviteCodeFromPath('/i/abc'), null);
  });
});
