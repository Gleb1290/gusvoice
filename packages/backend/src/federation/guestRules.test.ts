import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import ts from 'typescript';
import type { FedIdentityClaims } from '@gusvoice/shared';
import {
  banActive,
  baseRoleFor,
  guestGenVerdict,
  identityRefusal,
  inviteRefusalForGuest,
  mergeReportReason,
  shadowUsername,
  storageQuotaRefusal,
} from './guestRules.js';

const future = new Date(2_000);

describe('правила допуска федеративного гостя', () => {
  it('отсутствующая ссылка негодна, а истёкшая и исчерпанная одинаково просрочены', () => {
    const server = { federatedAccess: true };
    assert.equal(inviteRefusalForGuest({ invite: null, server, excludedForLink: false, now: 1_000 }), 'federation.invite_invalid');
    assert.equal(inviteRefusalForGuest({ invite: { expiresAt: new Date(1_000), maxUses: null, uses: 0 }, server, excludedForLink: false, now: 1_000 }), 'federation.invite_expired');
    assert.equal(inviteRefusalForGuest({ invite: { expiresAt: future, maxUses: 2, uses: 2 }, server, excludedForLink: false, now: 1_000 }), 'federation.invite_expired');
  });

  it('бессрочная ссылка запрещена даже на открытом сервере, а закрытие и исключение дают server_closed', () => {
    assert.equal(inviteRefusalForGuest({ invite: { expiresAt: null, maxUses: null, uses: 0 }, server: { federatedAccess: true }, excludedForLink: false, now: 1_000 }), 'federation.invite_no_expiry');
    assert.equal(inviteRefusalForGuest({ invite: { expiresAt: future, maxUses: null, uses: 0 }, server: { federatedAccess: false }, excludedForLink: false, now: 1_000 }), 'federation.server_closed');
    assert.equal(inviteRefusalForGuest({ invite: { expiresAt: future, maxUses: null, uses: 0 }, server: { federatedAccess: true }, excludedForLink: true, now: 1_000 }), 'federation.server_closed');
    assert.equal(inviteRefusalForGuest({ invite: { expiresAt: future, maxUses: null, uses: 0 }, server: { federatedAccess: true }, excludedForLink: false, now: 1_000 }), null);
  });

  it('подписавший обязан совпадать с iss, а аудитория и часы проверяются отдельно', () => {
    const claims: FedIdentityClaims = {
      iss: 'home', sub: 'u', aud: 'host', iat: 1_000, exp: 2_000, jti: 'j', gen: 1,
      username: 'user', displayName: 'Имя', avatarHash: null,
    };
    const base = { claims, selfInstanceId: 'host', signedBy: 'home', now: 1_000, skewMs: 60 };
    assert.equal(identityRefusal({ ...base, signedBy: 'other' }), 'issuer-mismatch');
    assert.equal(identityRefusal({ ...base, selfInstanceId: 'other' }), 'wrong-audience');
    assert.equal(identityRefusal(base), null);
  });

  it('поколение различает обычный вход, немедленный bump и откат дома', () => {
    assert.equal(guestGenVerdict(3, 3), 'ok');
    assert.equal(guestGenVerdict(4, 3), 'bumped');
    assert.equal(guestGenVerdict(2, 3), 'stale');
  });

  it('служебный логин невозможно занять локальной регистрацией, а запрет учитывает срок и снятие', () => {
    assert.match(shadowUsername('home', 'user'), /@/);
    assert.equal(banActive({ expiresAt: null }, 1_000), true);
    assert.equal(banActive({ expiresAt: new Date(1_000) }, 1_000), false);
    assert.equal(banActive({ expiresAt: future, removedAt: new Date(500) }, 1_000), false);
  });

  it('нулевая квота безгранична, ровно предел проходит, следующий байт отклоняется', () => {
    assert.equal(storageQuotaRefusal({ usedBytes: 100, addBytes: 1_000, quotaBytes: 0 }), null);
    assert.equal(storageQuotaRefusal({ usedBytes: 80, addBytes: 20, quotaBytes: 100 }), null);
    assert.equal(storageQuotaRefusal({ usedBytes: 80, addBytes: 21, quotaBytes: 100 }), 'federation.quota_exceeded');
  });

  it('гостю базой служит роль Гости, а при её отсутствии остаётся everyone', () => {
    assert.equal(baseRoleFor({ isGuest: true, everyoneRoleId: 'everyone', guestsRoleId: 'guests' }), 'guests');
    assert.equal(baseRoleFor({ isGuest: true, everyoneRoleId: 'everyone', guestsRoleId: null }), 'everyone');
    assert.equal(baseRoleFor({ isGuest: false, everyoneRoleId: 'everyone', guestsRoleId: 'guests' }), 'everyone');
  });

  it('повторные причины жалобы склеиваются без дублей, с приоритетом полной фразы и лимитом', () => {
    // При дополнении одной жалобы нельзя терять прежнюю причину или повторять уже включённый текст.
    assert.equal(mergeReportReason(null, ' a '), 'a');
    assert.equal(mergeReportReason('a', null), 'a');
    assert.equal(mergeReportReason('a', 'a'), 'a');
    assert.equal(mergeReportReason('a', 'a b'), 'a b');
    assert.equal(mergeReportReason('a b', 'a'), 'a b');
    assert.equal(mergeReportReason('a', 'b'), 'a\nb');
    assert.equal(mergeReportReason('first', 'second', 8), 'first\nse');
    const original = readFileSync(new URL('./guestRules.ts', import.meta.url), 'utf8');
    const changed = original.replace('return `${a}\\n${b}`.slice(0, max);', 'return b.slice(0, max);');
    assert.notEqual(changed, original, 'реальный модуль соединяет две разные причины');
    const mod = { exports: {} as Record<string, unknown> };
    runInNewContext(ts.transpileModule(changed, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module: mod, exports: mod.exports, require: (id: string) => { assert.equal(id, '@gusvoice/shared'); return {}; } });
    const mutant = mod.exports as typeof import('./guestRules.js');
    assert.throws(() => assert.equal(mutant.mergeReportReason('a', 'b'), 'a\nb'), assert.AssertionError,
      'мутант заменяет первую причину новой и должен быть пойман');
  });
});
