import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as admission from '../src/routes/fedAdmission.js';
import * as core from '../src/federation/peerAuthCore.js';
import * as signature from '../src/federation/httpSignature.js';
import * as identity from '../src/federation/instanceIdentity.js';
import { issueSigningKey, toDocumentKey } from '../src/federation/signingKeys.js';
import type { StoredLink } from '../src/federation/linkService.js';

type Edit = { file: string; from: string; to: string };
function moduleOf<T>(file: string, deps: Record<string, unknown>, edit?: Edit): T {
  let source = readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (edit?.file === file) { assert.equal(source.split(edit.from).length, 2, 'уникальный якорь'); source = source.replace(edit.from, edit.to); }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, Buffer, URL,
      require(id: string) { assert.ok(Object.hasOwn(deps, id), `закрытый импорт ${file}: ${id}`); return deps[id]; } });
  return module.exports as T;
}
async function scenario(edit?: Edit) {
  const now = Date.now();
  const root = generateKeyPairSync('ed25519');
  const rootPublic = root.publicKey.export({ type: 'spki', format: 'der' });
  const peer = identity.instanceIdFrom(rootPublic);
  const key = issueSigningKey(root.privateKey.export({ type: 'pkcs8', format: 'der' }), now - 1000);
  const doc: shared.FedInstanceDocument = { instanceId: peer, name: 'Сосед', iconHash: null, domain: 'peer.invalid',
    clientOrigin: 'https://peer.invalid', apiBase: 'https://peer.invalid/api', protocol: { min: 1, max: 1 },
    features: ['dm3'], appVersion: null, rootKey: rootPublic.toString('base64url'), keys: [toDocumentKey(key)] };
  const link: StoredLink = { instanceId: peer, domain: doc.domain, apiBase: doc.apiBase, clientOrigin: doc.clientOrigin,
    rootKey: doc.rootKey, theirName: doc.name, state: 'active', protocolVersion: 1, features: doc.features };
  const marks = new Set<string>(); let seenCalls = 0; let storms = 0; let ephemeral = 0; let events = 0;
  const apiBase = 'https://self.invalid/api';
  const auth = core.createPeerAuth({ apiBase, now: () => now, getLink: async () => link,
    fetchPeerDocument: async () => ({ ok: true, value: { instanceId: peer, doc, fingerprint: 'fixture', protocolVersion: 1 } }),
    paused: async () => false, markTrustLost: async () => { assert.fail('доверие не теряется'); },
    noteSignatureFailure: () => { storms++; }, seenSignature: async key => { seenCalls++; const seen = marks.has(key); marks.add(key); return seen; } });
  const authDeps = { authenticateLinkedPeer: auth.authenticateLinkedPeer, targetUriOf: auth.targetUriOf, refusalFor: core.refusalFor };
  const fail = () => { throw new Error('неожиданный IO несвязанного маршрута'); };
  const dormant = () => new Proxy({}, { get: (_target, key) => key === '__esModule' ? true : fail });
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/schema.js': schema,
    '../auth.js': { requireAuth: async () => {}, requireSuperAdmin: async () => {} },
    '../env.js': { env: { federation: { dmEnabled: true } } },
    './fedAdmission.js': admission, '../federation/peerAuth.js': authDeps,
    '../federation/httpSignature.js': signature, '../federation/instanceIdentity.js': identity,
    '../federation/guardsRuntime.js': { fedRateBlock: async () => 0, seenSignature: async () => false },
    '../federation/eventStream.js': { receiveEvents: async () => { events++; return { ok: true }; } },
    '../federation/dmEphemeral.js': { acceptEphemeral: async () => { ephemeral++; return { status: 200, body: { ok: true } }; } },
  };
  // Перечень явный: новые IO-зависимости нельзя незаметно протащить в тест.
  for (const path of ['../db/index.js', '../federation/alerts.js', '../federation/instance.js', '../federation/peerClient.js',
    '../federation/links.js', '../federation/auditLog.js', '../federation/linkRules.js', '../authGuard.js', '../guestGuard.js',
    '../federation/directoryFeed.js', '../federation/directoryRules.js', '../federation/directoryCache.js', '../federation/avatars.js',
    '../federation/guestAccess.js', '../federation/guestQuota.js', '../federation/guestHost.js', '../federation/invitePreview.js',
    '../federation/guestRevocation.js', '../federation/convChanges.js', '../federation/convOpen.js', '../federation/guestMembership.js',
    '../federation/instanceBan.js', '../federation/guestHome.js', '../federation/identityToken.js', '../federation/directorySync.js',
    '../federation/syncSchedule.js', '../federation/instanceMeta.js', '../federation/contacts.js', '../federation/keyRevocation.js',
    '../federation/revocation.js']) deps[path] = dormant();
  const fed = moduleOf<typeof import('../src/routes/federation.js')>('routes/federation', deps, edit);
  const eph = moduleOf<typeof import('../src/routes/fedEphemeral.js')>('routes/fedEphemeral', deps, edit);
  const app = Fastify();
  try {
    await app.register(fed.federationRoutes); await app.register(eph.fedEphemeralRoutes); await app.ready();
    for (const path of ['/fed/v1/ephemeral', '/fed/v1/events']) {
      const body = JSON.stringify(path.endsWith('events') ? { instance_id: peer, events: [] }
        : shared.serializeEphemeralWire(peer, { kind: 'typing', user: { instanceId: peer, userId: 'remote' },
          conversationId: 'direct', action: 'voice', until: now + 6000, stop: false }));
      const headers = { 'content-type': 'application/json', ...signature.signRequest({ method: 'POST', targetUri: `${apiBase}${path}`,
        body, keyid: key.kid, privateKeyDer: key.privateKeyDer, nowS: Math.floor(now / 1000) }) };
      const send = () => app.inject({ method: 'POST', url: path, payload: body, headers });
      assert.equal((await send()).statusCode, 200, 'первый запрос принимается');
      const repeated = await send();
      if (path.endsWith('ephemeral')) {
        assert.equal(repeated.statusCode, 200, 'повтор ephemeral принимается'); assert.equal(ephemeral, 2);
        assert.equal(seenCalls, 0, 'ephemeral вообще не ставит подпись');
      } else {
        assert.equal(repeated.statusCode, 401, 'повтор events запрещён до обработчика');
        assert.equal(repeated.json().error, 'expired'); assert.equal(events, 1); assert.equal(seenCalls, 2);
      }
    }
    assert.equal(storms, 0, 'легитимный повтор не создаёт тревогу подписи');
  } finally { await app.close(); }
}
test('R304 настоящие HTTP маршруты: ephemeral 200/200 без отметок, events 200/401 без тревоги', () => scenario());
test('R304 контрфакт: ephemeral потерял replayGuard false', async () => {
  await scenario();
  await assert.rejects(scenario({ file: 'routes/fedEphemeral', from: '{ requireActive: true, replayGuard: false }',
    to: '{ requireActive: true }' }), e => e instanceof assert.AssertionError && e.message.includes('повтор ephemeral принимается'));
});
