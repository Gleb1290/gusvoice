import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { generateKeyPairSync } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import { z } from 'zod';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as dmRules from '../src/dmRules.js';
import * as admission from '../src/routes/fedAdmission.js';
import * as guards from '../src/federation/guards.js';
import * as core from '../src/federation/peerAuthCore.js';
import * as signing from '../src/federation/signingKeys.js';
import * as identity from '../src/federation/instanceIdentity.js';
import * as signature from '../src/federation/httpSignature.js';
import type { StoredLink } from '../src/federation/linkService.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
beforeEach(async () => { await truncateAll(t.raw); });
after(async () => { await t.close(); });
type Mutation = { file: string; from: string; to: string };
const path = shared.FED_CALL_INVITE_PATH, apiBase = 'https://self.invalid/api';
function moduleOf<T>(name: string, deps: Record<string, unknown>, mutation?: Mutation): T {
  let code = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation?.file === name) { assert.equal(code.split(mutation.from).length, 2, 'уникальный якорь calls routes'); code = code.replace(mutation.from, mutation.to); }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    module, exports: module.exports, Date, Buffer,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `явный импорт ${id}`); return deps[id]; },
  });
  return module.exports as T;
}
async function fixture(mutation?: Mutation) {
  const root = generateKeyPairSync('ed25519');
  const rootPrivate = root.privateKey.export({ format: 'der', type: 'pkcs8' });
  const rootPublic = root.publicKey.export({ format: 'der', type: 'spki' });
  const peer = identity.instanceIdFrom(rootPublic); const key = signing.issueSigningKey(rootPrivate, Date.now() - 1000);
  const doc: shared.FedInstanceDocument = { instanceId: peer, name: 'Сосед', iconHash: null, domain: 'peer.invalid', clientOrigin: 'https://peer.invalid', apiBase: 'https://peer.invalid/api', protocol: { min: 1, max: 1 }, features: ['dmcall1'], appVersion: null, rootKey: rootPublic.toString('base64url'), keys: [signing.toDocumentKey(key)] };
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: doc.domain, apiBase: doc.apiBase, clientOrigin: doc.clientOrigin, rootKey: doc.rootKey, state: 'active', features: doc.features });
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'route_call_local', displayName: 'Местный', passwordHash: 'fixture' },
    { id: 'shadow', username: 'route_call_shadow', displayName: 'Сосед', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'remote' },
  ]);
  const auth = moduleOf<typeof import('../src/federation/peerAuth.js')>('federation/peerAuth', {
    './peerClient.js': { fetchPeerDocument: async () => ({ ok: true, value: { instanceId: peer, doc, fingerprint: 'fixture', protocolVersion: 1 } }) },
    './alerts.js': { noteSignatureFailure() {} },
    './links.js': { getLink: async (id: string) => (await t.db.select().from(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, id)).limit(1))[0] as unknown as StoredLink ?? null },
    './instanceMeta.js': { readInstanceMeta: async () => ({ paused: false }) }, './trustLoss.js': { markTrustLost: async () => {} },
    './peerAuthCore.js': core, '../env.js': { env: { federation: { apiBase } } },
  });
  const counters = new Map<string, number>(), rates: { key: string; max: number; seconds: number }[] = [];
  const runtime = moduleOf<typeof import('../src/federation/guardsRuntime.js')>('federation/guardsRuntime', {
    '../authGuard.js': { rateHit: async (key: string, max: number, seconds: number) => { rates.push({ key, max, seconds }); const count = (counters.get(key) ?? 0) + 1; counters.set(key, count); return count > max ? 23 : 0; } },
    '../realtime.js': { redisPub: { set: () => { throw new Error('call invite не хранит nonce'); } } }, './guards.js': guards,
  });
  const accepted: unknown[] = [];
  const fed = moduleOf<typeof import('../src/routes/fedCalls.js')>('routes/fedCalls', {
    '@gusvoice/shared': shared, '../federation/dmCalls.js': { acceptCallInvite: async (_link: unknown, body: unknown) => { accepted.push(body); return { status: 200, body: { ok: true } }; } },
    '../federation/guardsRuntime.js': runtime, '../federation/peerAuth.js': auth, './fedAdmission.js': admission,
  }, mutation);
  let refusal = { status: 503, error: shared.FED_ERRORS.peerUnreachable as string };
  const call: shared.DmCall = { id: 'remote-active', conversationId: 'direct', callerId: 'shadow', calleeId: 'local', phase: 'ringing', createdAt: new Date().toISOString(), callerDevice: 'remote', host: { instanceId: peer, apiBase: doc.apiBase } };
  const probes: unknown[][] = [];
  const local = moduleOf<typeof import('../src/routes/calls.js')>('routes/calls', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: { z },
    '../auth.js': { requireAuth: async (req: any) => { req.user = { sub: 'local' }; } }, '../authGuard.js': { rateHit: async () => 0 },
    '../blocks.js': { isBlockedBy: async () => false }, '../callPrivacy.js': { callAllowedFor: async () => true },
    '../calls.js': {
      act: async () => ({ kind: 'gone' }), callById: () => null,
      callJoin: async (current: unknown) => ({ call: current, room: 'fixture-room', url: 'wss://fixture.invalid', token: 'fixture' }),
      callOf: (user: string, withRemote = false) => { probes.push([user, withRemote]); return user === 'local' && withRemote ? call : null; },
      ping: () => false, startCall: async () => ({ kind: 'refused', ...refusal }),
    },
    '../conversations.js': { loadAccess: async () => ({ conversationId: 'direct', kind: 'direct', saved: false, peerId: 'shadow' }) },
    '../db/index.js': { db: t.db }, '../db/schema.js': schema, '../dmRules.js': dmRules,
  }, mutation);
  const app = Fastify(); await app.register(fed.fedCallRoutes); await app.register(local.callRoutes); await app.ready();
  const payload = JSON.stringify(shared.serializeCallInvite({ instanceId: peer, callId: 'call-id', conversationId: 'direct', fromUserId: 'remote', toUserId: 'local', video: false, createdAt: Date.now(), expiresAt: Date.now() + 90_000 }), null, 2);
  const headers = (body = payload) => ({ 'content-type': 'application/json', ...signature.signRequest({ method: 'POST', targetUri: `${apiBase}${path}`, body, keyid: key.kid, privateKeyDer: key.privateKeyDer, nowS: Math.floor(Date.now() / 1000) }) });
  const send = () => app.inject({ method: 'POST', url: path, headers: headers(), payload });
  return { app, peer, payload, headers, send, counters, rates, accepted, probes, refusal: (value: typeof refusal) => { refusal = value; } };
}
test('R200 call invite проверяет подпись сырого тела, чужая подпись или подмена не звонят, повтор допустим', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ method: 'POST', url: path, payload: JSON.parse(f.payload) })).statusCode, 401); assert.equal(f.accepted.length, 0);
    assert.equal((await f.send()).statusCode, 200); assert.equal(f.accepted.length, 1);
    const changed = await f.app.inject({ method: 'POST', url: path, headers: f.headers(), payload: f.payload.replace('call-id', 'other-id') });
    assert.equal(changed.statusCode, 401); assert.equal(f.accepted.length, 1);
    assert.equal((await f.send()).statusCode, 200); assert.equal(f.accepted.length, 2);
    assert.equal(JSON.stringify(f.accepted[0]), JSON.stringify(JSON.parse(f.payload)));
  } finally { await f.app.close(); }
});
async function activeScenario(mutation?: Mutation) {
  const f = await fixture(mutation);
  try {
    await t.db.update(schema.federationLinks).set({ state: 'paused' });
    assert.equal((await f.send()).statusCode, 409, 'приглашение не принимается от paused связки'); assert.equal(f.accepted.length, 0);
    await t.db.update(schema.federationLinks).set({ state: 'active' }); assert.equal((await f.send()).statusCode, 200); assert.equal(f.accepted.length, 1);
  } finally { await f.app.close(); }
}
test('R200 приглашение требует active связку и снова проходит после возобновления', async () => { await activeScenario(); });
async function limitScenario(mutation?: Mutation) {
  const f = await fixture(mutation);
  try {
    f.counters.set(`fed:call:${f.peer}`, 119);
    assert.equal((await f.send()).statusCode, 200);
    const denied = await f.send(); assert.equal(denied.statusCode, 429, '121-й invite отвергается call пределом');
    assert.equal(denied.headers['retry-after'], '23'); assert.equal(f.accepted.length, 1);
    assert.deepEqual(f.rates.filter(r => r.key === `fed:call:${f.peer}`).map(r => [r.max, r.seconds]), [[120, 60], [120, 60]]);
  } finally { await f.app.close(); }
}
test('R200 call admission принимает 120-й запрос и отклоняет 121-й без вызова accept', async () => { await limitScenario(); });
async function refusalScenario(mutation?: Mutation) {
  const f = await fixture(mutation);
  try {
    for (const [status, error] of [[409, shared.CALL_BUSY_ERROR], [403, shared.CALL_PRIVACY_ERROR], [503, shared.FED_ERRORS.peerUnreachable], [409, shared.FED_ERRORS.unsupported]] as const) {
      f.refusal({ status, error }); const response = await f.app.inject({ method: 'POST', url: '/conv/direct/call', payload: { device: 'pc' } });
      assert.equal(response.statusCode, status, 'refused сохраняет статус дома'); assert.equal(response.json().error, error);
    }
  } finally { await f.app.close(); }
}
test('R200 refused из startCall проходит маршрут с тем же статусом и кодом', async () => { await refusalScenario(); });
async function queryScenario(mutation?: Mutation) {
  const f = await fixture(mutation);
  try {
    assert.equal((await f.app.inject('/calls/active')).json().call, null, 'старый active без fed не показывает удалённый звонок');
    assert.equal((await f.app.inject('/calls/active?fed=0')).json().call, null);
    assert.equal((await f.app.inject('/calls/active?fed=1')).json().call.id, 'remote-active');
    assert.equal(JSON.stringify(f.probes), JSON.stringify([['local', false], ['local', false], ['local', true]]));
  } finally { await f.app.close(); }
}
test('R200 active возвращает удалённое только при явном fed=1', async () => { await queryScenario(); });
for (const [name, mutation, check, failure] of [
  ['requireActive false', { file: 'routes/fedCalls', from: '{ requireActive: true }', to: '{ requireActive: false }' }, activeScenario, 'не принимается от paused'],
  ['directory вместо call', { file: 'routes/fedCalls', from: "body.instance_id, 'call'", to: "body.instance_id, 'directory'" }, limitScenario, '121-й invite'],
  ['снят refused', { file: 'routes/calls', from: "if (res.kind === 'refused') return reply.code(res.status).send({ error: res.error });", to: '// refused branch removed' }, refusalScenario, 'refused сохраняет статус'],
  ['fed по умолчанию', { file: 'routes/calls', from: "(req.query as { fed?: unknown } | undefined)?.fed === '1'", to: 'true' }, queryScenario, 'старый active без fed'],
] as [string, Mutation, (mutation?: Mutation) => Promise<void>, string][]) {
  test(`R200 мутант routes «${name}» пойман адресным ответом ручки`, async () => {
    await check(); await truncateAll(t.raw); await assert.rejects(check(mutation), e => e instanceof assert.AssertionError && e.message.includes(failure));
  });
}
