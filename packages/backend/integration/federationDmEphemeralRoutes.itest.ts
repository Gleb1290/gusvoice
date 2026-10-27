import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { generateKeyPairSync } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
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
type Mutation = readonly [string, string];
const path = shared.FED_EPHEMERAL_PATH;
const apiBase = 'https://self.invalid/api';
function moduleOf<T>(name: string, deps: Record<string, unknown>, mutation?: Mutation): T {
  let code = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation) { assert.equal(code.split(mutation[0]).length, 2, 'уникальный якорь маршрута'); code = code.replace(...mutation); }
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
  const peer = identity.instanceIdFrom(rootPublic);
  const key = signing.issueSigningKey(rootPrivate, Date.now() - 1000);
  const doc: shared.FedInstanceDocument = { instanceId: peer, name: 'Сосед', iconHash: null, domain: 'peer.invalid', clientOrigin: 'https://peer.invalid', apiBase: 'https://peer.invalid/api', protocol: { min: 1, max: 1 }, features: ['dm3'], appVersion: null, rootKey: rootPublic.toString('base64url'), keys: [signing.toDocumentKey(key)] };
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: doc.domain, apiBase: doc.apiBase, clientOrigin: doc.clientOrigin, rootKey: doc.rootKey, state: 'active', features: doc.features });
  let emergencyPause = false;
  let replayCalls = 0;
  const auth = moduleOf<typeof import('../src/federation/peerAuth.js')>('federation/peerAuth', {
    './peerClient.js': { fetchPeerDocument: async () => ({ ok: true, value: { instanceId: peer, doc, fingerprint: 'fixture', protocolVersion: 1 } }) },
    './alerts.js': { noteSignatureFailure() {} },
    './links.js': { getLink: async (id: string) => (await t.db.select().from(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, id)).limit(1))[0] as unknown as StoredLink ?? null },
    './instanceMeta.js': { readInstanceMeta: async () => ({ paused: emergencyPause }) },
    './trustLoss.js': { markTrustLost: () => { throw new Error('личность фикстуры не меняется'); } },
    './peerAuthCore.js': core, '../env.js': { env: { federation: { apiBase } } },
    '../realtime.js': { redisPub: { set: async () => { replayCalls++; return null; } } },
  });
  const counters = new Map<string, number>();
  const rates: { key: string; max: number; seconds: number }[] = [];
  const runtime = moduleOf<typeof import('../src/federation/guardsRuntime.js')>('federation/guardsRuntime', {
    '../authGuard.js': { rateHit: async (key: string, max: number, seconds: number) => {
      rates.push({ key, max, seconds }); const count = (counters.get(key) ?? 0) + 1; counters.set(key, count); return count > max ? 17 : 0;
    } },
    '../realtime.js': { redisPub: { set: () => { throw new Error('ephemeral не хранит nonce'); } } }, './guards.js': guards,
  });
  const accepted: { link: StoredLink; body: unknown }[] = [];
  const routes = moduleOf<typeof import('../src/routes/fedEphemeral.js')>('routes/fedEphemeral', {
    '@gusvoice/shared': shared, '../federation/guardsRuntime.js': runtime, '../federation/peerAuth.js': auth, './fedAdmission.js': admission,
    '../federation/dmEphemeral.js': { acceptEphemeral: async (link: StoredLink, body: unknown) => { accepted.push({ link, body }); return { status: 202, body: { ok: true } }; } },
  }, mutation);
  const app = Fastify(); await app.register(routes.fedEphemeralRoutes); await app.ready();
  const payload = JSON.stringify(shared.serializeEphemeralWire(peer, { kind: 'typing', user: { instanceId: peer, userId: 'remote' }, conversationId: 'direct-id', action: 'voice', until: Date.now() + 6000, stop: false }), null, 2);
  const headers = (body = payload) => ({ 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.8',
    ...signature.signRequest({ method: 'POST', targetUri: `${apiBase}${path}`, body, keyid: key.kid, privateKeyDer: key.privateKeyDer, nowS: Math.floor(Date.now() / 1000) }) });
  const send = (body = payload) => app.inject({ method: 'POST', url: path, headers: headers(body), payload: body });
  return { app, peer, payload, headers, send, counters, rates, accepted, get replayCalls() { return replayCalls; }, pause: (value: boolean) => { emergencyPause = value; } };
}

test('R197 ephemeral без подписи отвергается, настоящая подпись сырого форматированного тела проходит, подмена отвергается', async () => {
  const f = await fixture();
  try {
    const unsigned = await f.app.inject({ method: 'POST', url: path, payload: JSON.parse(f.payload) });
    assert.equal(unsigned.statusCode, 401); assert.equal(unsigned.json().error, 'unknown'); assert.equal(f.accepted.length, 0);
    assert.equal(f.rates.length, 1); assert.equal(f.rates[0].key.startsWith('fed:peerAddress:'), true);
    const signed = await f.send(); assert.equal(signed.statusCode, 202); assert.equal(f.accepted.length, 1);
    assert.equal(JSON.stringify(f.accepted[0].body), JSON.stringify(JSON.parse(f.payload)));
    assert.equal(f.accepted[0].link.instanceId, f.peer);
    const changed = await f.app.inject({ method: 'POST', url: path, headers: f.headers(), payload: f.payload.replace('voice', 'sticker') });
    assert.equal(changed.statusCode, 401); assert.equal(f.accepted.length, 1);
    // Повтор подписи допустим у эфемерных записей: nonce-хранилище намеренно запрещено harness'ом.
    assert.equal((await f.send()).statusCode, 202); assert.equal(f.accepted.length, 2);
    assert.equal(f.replayCalls, 0, 'ephemeral не читает и не пишет хранилище подписей');
  } finally { await f.app.close(); }
});
async function activeScenario(mutation?: Mutation) {
  const f = await fixture(mutation);
  try {
    await t.db.update(schema.federationLinks).set({ state: 'paused' });
    const refused = await f.send(); assert.equal(refused.statusCode, 409, 'ephemeral не принимается от неактивной связки');
    assert.equal(refused.json().error, shared.FED_ERRORS.paused); assert.equal(f.accepted.length, 0);
    await t.db.update(schema.federationLinks).set({ state: 'active' });
    assert.equal((await f.send()).statusCode, 202); assert.equal(f.accepted.length, 1);
  } finally { await f.app.close(); }
}
test('R197 ephemeral требует active связку после подписи, её возобновление открывает приём', async () => {
  await activeScenario();
});
test('R197 разрыв, потеря доверия и аварийная пауза не допускают ephemeral', async () => {
  const f = await fixture();
  try {
    for (const state of ['blocked', 'trust-lost', 'pending', 'requested'] as const) {
      await t.db.update(schema.federationLinks).set({ state });
      assert.equal((await f.send()).statusCode, 409);
      assert.equal(f.accepted.length, 0);
    }
    await t.db.update(schema.federationLinks).set({ state: 'active' }); f.pause(true);
    assert.equal((await f.send()).statusCode, 409); assert.equal(f.accepted.length, 0);
    f.pause(false); assert.equal((await f.send()).statusCode, 202); assert.equal(f.accepted.length, 1);
  } finally { await f.app.close(); }
});
async function limitScenario(mutation?: Mutation) {
  const f = await fixture(mutation);
  try {
    f.counters.set(`fed:ephemeral:${f.peer}`, 599);
    assert.equal((await f.send()).statusCode, 202, '600-й ephemeral принимается');
    const overflow = await f.send(); assert.equal(overflow.statusCode, 429, '601-й ephemeral отвергается пределом нужного вида');
    assert.equal(overflow.headers['retry-after'], '17'); assert.equal(overflow.json().error, 'rate-limited');
    assert.equal(f.accepted.length, 1);
    assert.deepEqual(f.rates.filter(r => r.key === `fed:ephemeral:${f.peer}`).map(r => [r.max, r.seconds]), [[600, 60], [600, 60]]);
  } finally { await f.app.close(); }
}
test('R197 admission вызывает именно ephemeral предел 600 в минуту и не допускает 601-й запрос', async () => {
  await limitScenario();
});
test('R197 адресный предел останавливает запрос до криптографии и не расходует квоту чужого instance_id', async () => {
  const f = await fixture();
  try {
    f.counters.set('fed:peerAddress:198.51.100.8', 600);
    const refused = await f.send(); assert.equal(refused.statusCode, 429); assert.equal(f.accepted.length, 0);
    assert.equal(f.counters.has(`fed:ephemeral:${f.peer}`), false);
    f.counters.clear(); assert.equal((await f.send()).statusCode, 202);
    assert.equal(f.counters.get(`fed:ephemeral:${f.peer}`), 1);
  } finally { await f.app.close(); }
});
for (const [name, mutation, check, failure] of [
  ['requireActive false', ['{ requireActive: true, replayGuard: false }', '{ requireActive: false, replayGuard: false }'], activeScenario, 'ephemeral не принимается'],
  ['предел directory вместо ephemeral', ["body.instance_id, 'ephemeral'", "body.instance_id, 'directory'"], limitScenario, '601-й ephemeral отвергается'],
] as [string, Mutation, (mutation?: Mutation) => Promise<void>, string][]) {
  test(`R197 мутант маршрута «${name}» пойман адресным HTTP ответом`, async () => {
    await check(); await truncateAll(t.raw);
    await assert.rejects(check(mutation), e => e instanceof assert.AssertionError && e.message.includes(failure));
  });
}
