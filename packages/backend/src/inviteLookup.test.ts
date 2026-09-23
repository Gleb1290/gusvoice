import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { invitePreview, lookupInviteGuarded, type InvitePreviewDeps, type PreviewInvite } from './inviteLookup.js';

function lookup(overrides: Partial<{
  lockRemaining: (userId: string) => Promise<number>;
  recordFailure: (userId: string, ip: string) => Promise<number>;
  findInvite: (code: string) => Promise<{ code: string } | null>;
}> = {}) {
  const calls: string[] = [];
  const deps = {
    lockRemaining: async () => 0,
    recordFailure: async () => { calls.push('failure'); return 0; },
    findInvite: async () => { calls.push('find'); return { code: 'ok' }; },
    ...overrides,
  };
  return { deps, calls };
}

function preview(overrides: Partial<InvitePreviewDeps<PreviewInvite>> = {}) {
  const invite = { serverId: 'server', expiresAt: new Date(2_000), maxUses: null, uses: 0 };
  return {
    lockRemaining: async () => 0,
    recordFailure: async () => 0,
    findInvite: async () => invite,
    findServer: async () => ({ id: 'server', name: 'Сервер Маши', iconUrl: '/icon.png', federatedAccess: true }),
    homeOf: async () => null,
    excludedFor: async () => false,
    now: () => 1_000,
    ...overrides,
  } satisfies InvitePreviewDeps<PreviewInvite>;
}

describe('защищённый поиск приглашения', () => {
  it('действующая блокировка не читает код вообще', async () => {
    // Ловит перебор существующих кодов через маршрут предпросмотра уже заблокированным человеком.
    const h = lookup({ lockRemaining: async () => 90 });
    assert.deepEqual(await lookupInviteGuarded(h.deps, { userId: 'u', ip: '1.2.3.4', code: 'x' }), { kind: 'locked', retryS: 90 });
    assert.deepEqual(h.calls, []);
  });

  it('промах записывается и превращается в locked только при ненулевом сроке', async () => {
    // Ловит как незасчитанный перебор, так и ложную блокировку до достижения порога.
    for (const [seconds, expected] of [[0, { kind: 'missing' }], [120, { kind: 'locked', retryS: 120 }]] as const) {
      const h = lookup({ findInvite: async () => null, recordFailure: async () => seconds });
      assert.deepEqual(await lookupInviteGuarded(h.deps, { userId: 'u', ip: '1.2.3.4', code: 'x' }), expected);
    }
  });

  it('найденный код не записывает промах и не обнуляет защиту', async () => {
    // Ловит обход ступенчатого lockout чередованием неверных кодов со своим верным.
    const h = lookup();
    assert.deepEqual(await lookupInviteGuarded(h.deps, { userId: 'u', ip: '1.2.3.4', code: 'ok' }), { kind: 'found', invite: { code: 'ok' } });
    assert.deepEqual(h.calls, ['find']);
  });
});

describe('предпросмотр приглашения', () => {
  it('различает блокировку, неизвестный и потраченный код', async () => {
    // Ловит смешение защитного 429, обычного 404 и честного истечения 410.
    assert.equal((await invitePreview(preview({ lockRemaining: async () => 61 }), { userId: 'u', ip: 'ip', code: 'x' })).status, 429);
    assert.equal((await invitePreview(preview({ findInvite: async () => null }), { userId: 'u', ip: 'ip', code: 'x' })).status, 404);
    assert.equal((await invitePreview(preview({ now: () => 2_000 }), { userId: 'u', ip: 'ip', code: 'x' })).status, 410);
  });

  it('гостю закрытый, исключённый или бессрочный сервер выглядит ровно как неизвестный код', async () => {
    // Ловит утечку имени и значка локального сервера через валидный, но недоступный гостю код.
    const guest = { homeOf: async () => 'home' };
    const cases = [
      preview({ ...guest, findServer: async () => ({ id: 'server', name: 'Secret', iconUrl: null, federatedAccess: false }) }),
      preview({ ...guest, excludedFor: async () => true }),
      preview({ ...guest, findInvite: async () => ({ serverId: 'server', expiresAt: null, maxUses: null, uses: 0 }) }),
    ];
    for (const deps of cases) {
      assert.deepEqual(await invitePreview(deps, { userId: 'guest', ip: 'ip', code: 'secret' }), {
        status: 404, body: { error: 'invalid invite' },
      });
    }
  });

  it('местный человек видит тот же код, а приглашение без строки сервера теперь даёт 404', async () => {
    // Ловит чрезмерный запрет местным и прежний ложный 200 с несуществующим сервером.
    assert.equal((await invitePreview(preview(), { userId: 'local', ip: 'ip', code: 'ok' })).status, 200);
    assert.deepEqual(await invitePreview(preview({ findServer: async () => null }), { userId: 'local', ip: 'ip', code: 'orphan' }), {
      status: 404, body: { error: 'invalid invite' },
    });
  });
});
