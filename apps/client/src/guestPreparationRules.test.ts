import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as configRules from './configRules.js';
import type { Instance } from './configRules.js';
import * as preparationRules from './guestPreparationRules.js';
import type { InvitePreviewView } from '@gusvoice/shared';
import { canPrepareGuestInvite, guestTokenExpiry, verifiedGuestServer } from './guestPreparationRules.js';

const link = 'https://voice.example.org/i/Valid123';
const preview: InvitePreviewView = {
  scope: 'peer',
  code: 'Valid123',
  instance: { instanceId: 'peer', name: 'Сосед', domain: 'voice.example.org' },
  server: { serverId: 'server', name: 'Гостиная', iconHash: null, members: 12, expiresAt: 2000 },
  problem: null,
  alreadyMember: false,
  contacts: [],
};

it('действующая ссылка соседа допускает подтверждение, в том числе для участника', () => {
  assert.equal(canPrepareGuestInvite(link, preview, 1999), true);
  assert.equal(canPrepareGuestInvite(link, { ...preview, alreadyMember: true }, 1999), true);
});

it('короткий код и приглашение своего инстанса не допускают подготовку', () => {
  assert.equal(canPrepareGuestInvite('Valid123', preview, 1999), false);
  assert.equal(canPrepareGuestInvite(link, { ...preview, scope: 'local' }, 1999), false);
});

it('до ответа дома, после замены кода и при отказе подтверждение недоступно', () => {
  assert.equal(canPrepareGuestInvite(link, null, 1999), false);
  assert.equal(canPrepareGuestInvite('https://voice.example.org/i/Other123', preview, 1999), false);
  assert.equal(canPrepareGuestInvite(link, { ...preview, problem: 'unreachable' }, 1999), false);
});

it('приглашение отклоняется в момент истечения, а бессрочное зависит от ответа хоста', () => {
  assert.equal(canPrepareGuestInvite(link, preview, 2000), false);
  const unlimited = { ...preview, server: { ...preview.server!, expiresAt: null } };
  assert.equal(canPrepareGuestInvite(link, unlimited, 1999), true);
  assert.equal(canPrepareGuestInvite(link, { ...unlimited, problem: 'federation.invite_no_expiry' }, 1999), false);
});

it('успех проверки требует карточки именно запрошенного сервера от хоста', () => {
  const other = { id: 'other', name: 'Чужой сервер' };
  assert.equal(verifiedGuestServer({ server: other }, 'server'), null);
  assert.equal(verifiedGuestServer({}, 'server'), null);
  const server = { id: 'server', name: 'Гостиная', iconUrl: null };
  assert.deepEqual(verifiedGuestServer({ server }, 'server'), server);
});

it('срок гостевого токена переводится в миллисекунды, отсутствующий или битый срок остаётся неизвестен', () => {
  const token = (payload: unknown) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
  assert.equal(guestTokenExpiry(token({ exp: 12345 })), 12345000);
  assert.equal(guestTokenExpiry(token({})), null);
  assert.equal(guestTokenExpiry(token({ exp: '12345' })), null);
  assert.equal(guestTokenExpiry('header.?.signature'), null);
});

// Изолируем I/O. В VM работает тот же гостевой маршрут, который вызывает окно настроек.
const compiledJoin = ts.transpileModule(readFileSync(new URL('./guestJoin.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const future = Math.floor(Date.now() / 1000) + 3600;
const guestJwt = (version: string, exp = future) =>
  `header.${Buffer.from(JSON.stringify({ exp, version })).toString('base64url')}.signature`;
const home: Instance = { id: 'home', name: 'Дом', userId: 'owner', apiUrl: 'https://home.example.org', presenceWs: '', order: 0, token: 'home-token' };
const place = { ...preview.instance!, clientOrigin: 'https://voice.example.org' };
const guest: Instance = { id: 'guest', name: 'Сосед', guestOf: home.id, apiUrl: 'https://api.example.org',
  domain: place.domain, federationInstanceId: place.instanceId, presenceWs: '', order: 1, token: guestJwt('old') };
const server = { id: 'server', name: 'Гостиная' };

function guestFixture(initial: Instance[], respond: (path: string, token: string | null) => Response) {
  let registry = [home, ...initial];
  const calls: string[] = [];
  const updateInstance = (id: string, patch: Partial<Instance>) => {
    registry = registry.map((entry) => entry.id === id ? { ...entry, ...patch } : entry);
  };
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared,
    './api': { api: { async fedIdentityToken() { calls.push('identity'); return { token: 'identity-ticket' }; } } },
    './config': {
      activeInstance: () => home,
      instances: () => registry,
      fetchDiscovery: async () => ({ apiUrl: guest.apiUrl, presenceWs: '' }),
      addInstance: () => {
        const entry = { ...guest, guestOf: undefined, federationInstanceId: undefined, domain: undefined, token: null };
        registry = [...registry, entry];
        return entry;
      },
      updateInstance,
    },
    './configRules': configRules,
    './instanceSwitch': {},
    './guestPreparationRules': preparationRules,
    './store': { useStore: { getState: () => ({ bumpGuestLinksRev() { calls.push('saved'); } }) } },
    './guestGone': {},
  };
  const module = { exports: {} };
  runInNewContext(compiledJoin, {
    module, exports: module.exports,
    require: (id: string) => deps[id],
    fetch: async (url: string, init: RequestInit) => {
      assert.equal(new URL(url).origin, guest.apiUrl);
      const path = new URL(url).pathname;
      calls.push(`${init.method} ${path}`);
      if (init.method === 'GET' && path.startsWith('/api/servers/')) assert.equal(init.cache, 'no-store');
      return respond(path, new Headers(init.headers).get('authorization')?.slice('Bearer '.length) ?? null);
    },
  });
  return {
    prepare: (module.exports as typeof import('./guestJoin')).prepareGuestAccess,
    calls,
    registry: () => registry,
  };
}

it('подтверждённое приглашение сохраняет одну гостевую запись после проверки точного сервера', async () => {
  const token = guestJwt('minted');
  const foreign = { ...guest, id: 'foreign', guestOf: 'other-home', token: guestJwt('foreign') };
  const f = guestFixture([foreign], (path, sent) => {
    if (path === '/api/fed/v1/instance') return Response.json({ instance_id: place.instanceId });
    if (path === '/api/fed/v1/session') return Response.json({ token, user_id: 'shadow' });
    assert.equal(sent, token);
    return Response.json({ server });
  });
  const result = await f.prepare(place, server.id, preview);
  assert.deepEqual(f.calls, ['GET /api/fed/v1/instance', 'identity', 'POST /api/fed/v1/session',
    'POST /api/invites/Valid123', 'GET /api/servers/server', 'saved']);
  const [saved] = f.registry().filter((entry) => entry.guestOf === home.id);
  assert.equal(f.registry().length, 3);
  assert.equal(f.registry().find((entry) => entry.id === foreign.id)?.token, foreign.token);
  assert.equal(saved?.token, token);
  assert.equal(saved?.servers?.[0]?.id, server.id);
  assert.equal(result.expiresAt, future * 1000);
});

it('ротация проверяет новый JWT и заменяет только запись подходящей пары хост и дом', async () => {
  const rotated = guestJwt('rotated', future + 120);
  const foreign = { ...guest, id: 'foreign', guestOf: 'other-home', order: 3, token: guestJwt('foreign') };
  const duplicate = { ...guest, id: 'older', order: 0, token: guestJwt('older') };
  const f = guestFixture([duplicate, guest, foreign], (_path, sent) => {
    if (sent === guest.token) return Response.json({ server }, { headers: { 'x-refresh-token': rotated } });
    assert.equal(sent, rotated);
    return Response.json({ server });
  });
  const result = await f.prepare(place, server.id, { ...preview, alreadyMember: true });
  assert.deepEqual(f.calls, ['GET /api/servers/server', 'GET /api/servers/server', 'saved']);
  assert.equal(f.registry().find((entry) => entry.id === guest.id)?.token, rotated);
  assert.equal(f.registry().find((entry) => entry.id === foreign.id)?.token, foreign.token);
  assert.equal(f.registry().find((entry) => entry.id === duplicate.id)?.token, duplicate.token);
  assert.equal(f.registry().length, 4);
  assert.equal(result.expiresAt, (future + 120) * 1000);

  const rejected = guestFixture([guest], (_path, sent) => sent === guest.token
    ? Response.json({ server }, { headers: { 'x-refresh-token': rotated } })
    : Response.json({ error: 'invalid token' }, { status: 401 }));
  await assert.rejects(rejected.prepare(place, server.id), { code: 'invalid token' });
  assert.deepEqual(rejected.calls, ['GET /api/servers/server', 'GET /api/servers/server']);
  assert.equal(rejected.registry()[1]?.token, guest.token);
});

it('старый отозванный JWT заменяется один раз в существующей записи по домену', async () => {
  const replacement = guestJwt('replacement');
  const legacy = { ...guest, federationInstanceId: undefined };
  const f = guestFixture([legacy], (path, sent) => {
    if (path === '/api/fed/v1/session') return Response.json({ token: replacement, user_id: 'shadow' });
    if (sent === guest.token) return Response.json({ error: 'invalid token' }, { status: 401 });
    assert.equal(sent, replacement);
    return Response.json({ server });
  });
  await f.prepare(place, server.id);
  assert.deepEqual(f.calls, ['GET /api/servers/server', 'identity', 'POST /api/fed/v1/session', 'GET /api/servers/server', 'saved']);
  assert.equal(f.registry().length, 2);
  assert.equal(f.registry()[1]?.federationInstanceId, place.instanceId);
  assert.equal(f.registry()[1]?.token, replacement);
});

it('отказ в членстве не подменяется свежей сессией или успехом из локального снимка', async () => {
  const f = guestFixture([{ ...guest, servers: [server] }], () =>
    Response.json({ error: 'not found or not a member' }, { status: 404 }));
  await assert.rejects(f.prepare(place, server.id), { code: 'not found or not a member' });
  assert.deepEqual(f.calls, ['GET /api/servers/server']);
});
