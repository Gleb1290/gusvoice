import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isInviteSpent } from './inviteRules.js';

describe('исчерпанность приглашения', () => {
  it('приглашение без срока и лимита остаётся действующим', () => {
    // Ловит случайное закрытие бессрочной безлимитной ссылки.
    assert.equal(isInviteSpent({ expiresAt: null, maxUses: null, uses: 10_000 }, 5_000), false);
  });

  it('за миллисекунду до истечения приглашение ещё действует', () => {
    // Ловит преждевременный отказ законному последнему входу до срока.
    assert.equal(isInviteSpent({ expiresAt: new Date(2_000), maxUses: null, uses: 0 }, 1_999), false);
  });

  it('ровно в момент истечения приглашение уже недействительно', () => {
    // Ловит старое расхождение `<` против общего для проекта `<=`.
    assert.equal(isInviteSpent({ expiresAt: new Date(2_000), maxUses: null, uses: 0 }, 2_000), true);
  });

  it('прошедший срок отклоняется независимо от свободных использований', () => {
    // Ловит принятие просроченной ссылки из-за проверки только счётчика uses.
    assert.equal(isInviteSpent({ expiresAt: new Date(2_000), maxUses: 100, uses: 0 }, 2_001), true);
  });

  it('ровно maxUses и превышение лимита считаются исчерпанными', () => {
    // Ловит ошибку `>` вместо `>=` у одноразовых и уже переполненных ссылок.
    assert.equal(isInviteSpent({ expiresAt: null, maxUses: 1, uses: 0 }, 1_000), false);
    assert.equal(isInviteSpent({ expiresAt: null, maxUses: 1, uses: 1 }, 1_000), true);
    assert.equal(isInviteSpent({ expiresAt: null, maxUses: 1, uses: 2 }, 1_000), true);
  });

  it('maxUses null не превращает большой счётчик в лимит', () => {
    // Ловит трактовку null как нуля и закрытие безлимитных приглашений после первого входа.
    assert.equal(isInviteSpent({ expiresAt: null, maxUses: null, uses: Number.MAX_SAFE_INTEGER }, 1_000), false);
  });
});

