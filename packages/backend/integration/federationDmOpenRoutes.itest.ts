import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, beforeEach, test } from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as searchRules from '../src/userSearchRules.js';
import * as dmRules from '../src/dmRules.js';
import * as convRules from '../src/convRules.js';
import * as setupRules from '../src/setupRules.js';
import * as adminRules from '../src/superAdminRules.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as signing from '../src/federation/signingKeys.js';
import * as identity from '../src/federation/instanceIdentity.js';
import * as signature from '../src/federation/httpSignature.js';
import * as admission from '../src/routes/fedAdmission.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
beforeEach(async () => { await truncateAll(t.raw); });
after(async () => { await t.close(); });
const source = readFileSync(new URL('../src/routes/federation.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// Только границы, которые НЕ исполняются в этих запросах. Каждое именованное значение бросает Error,
// а не возвращает false/undefined; новые неизвестные модули отвергаются, Proxy здесь нет.
const unused = new Set(`activity.js authGuard.js permissions.js gateway.js directoryEvents.js realtime.js serialize.js lastSeen.js lastSeenRules.js callPrivacy.js storage.js shopRules.js alerts.js auditLog.js directoryFeed.js directoryRules.js directoryCache.js avatars.js guestAccess.js guestQuota.js invitePreview.js guestRevocation.js convChanges.js guestMembership.js instanceBan.js guestHome.js identityToken.js directorySync.js syncSchedule.js contacts.js guardsRuntime.js keyRevocation.js revocation.js accountDelete.js economyStats.js instanceSettings.js mailer.js settings.js instanceUpdate.js dmReports.js instanceUpdateRules.js att.js stickerCatalog.js blockRules.js blocks.js convSendFanout.js strangerRules.js scheduled.js scheduleRules.js contactRules.js push.js dmFolders.js dmWriteBarrier.js attachments.js util.js safeFetch.js devPeers.js authRules.js guestRules.js eventStream.js`.split(' '));
const url = (path: string) => new URL(`../src/${path}`, import.meta.url);
async function fixture(enabled = true, federationRaw = source) {
  const bound: unknown[][] = [];
  const signatureFailures: string[] = [];
  const root = crypto.generateKeyPairSync('ed25519');
  const rootPrivate = root.privateKey.export({ format: 'der', type: 'pkcs8' });
  const rootPublic = root.publicKey.export({ format: 'der', type: 'spki' });
  const peerId = identity.instanceIdFrom(rootPublic);
  const now = Date.now(); const key = signing.issueSigningKey(rootPrivate, now - 1000);
  const selfId = 'a'.repeat(peerId.length);
  const doc: shared.FedInstanceDocument = { instanceId: peerId, name: 'Сосед', iconHash: null, domain: 'peer.example', clientOrigin: 'https://peer.example', apiBase: 'https://peer.example/api', protocol: { min: 1, max: 1 }, features: ['dm1'], appVersion: null, rootKey: rootPublic.toString('base64url'), keys: [signing.toDocumentKey(key)] };
  const guard = (what: string) => () => { throw new Error(`нежелательный IO/ветка ${what}`); };
  const authorize = async (req: FastifyRequest) => { req.user = { sub: 'me', username: 'local' }; };
  const modules: Record<string, unknown> = {
    'schema.js': schema, 'index.js': { db: t.db }, 'userSearchRules.js': searchRules,
    'dmRules.js': dmRules, 'convRules.js': convRules, 'setupRules.js': setupRules,
    'superAdminRules.js': adminRules, 'linkRules.js': linkRules, 'signingKeys.js': signing,
    'instanceIdentity.js': identity, 'httpSignature.js': signature, 'fedAdmission.js': admission,
    'env.js': { env: { federation: { enabled: true, dmEnabled: enabled, apiBase: 'https://self.example/api' } } },
    'auth.js': { requireAuth: authorize, requireSuperAdmin: authorize, isSuperAdmin: () => false, superAdminId: () => 'me', hashPassword: guard('hashPassword'), signToken: guard('signToken'), bumpTokenGeneration: guard('bumpTokenGeneration') },
    'guestGuard.js': { requireLocalUser: async () => {}, isLocalUser: async () => true },
    'authGuard.js': { rateHit: async () => 0, retryMessage: guard('retryMessage'), messageSendBlock: guard('messageSendBlock'), pushDebounced: guard('pushDebounced') },
    'instance.js': { federation: { identity: () => ({ instanceId: selfId }) } },
    'instanceMeta.js': { readInstanceMeta: async () => ({ paused: false, name: 'Дом' }), checkInstanceName: guard('checkInstanceName'), setFederationPaused: guard('setFederationPaused'), writeInstanceMeta: guard('writeInstanceMeta') },
    'links.js': { getLink: async (id: string) => (await t.db.select().from(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, id)))[0] ?? null,
      listLinks: async () => t.db.select().from(schema.federationLinks), linkService: {}, findCodeBySecret: guard('findCodeBySecret') },
    'guardsRuntime.js': { fedRateBlock: async () => 0, seenSignature: guard('seenSignature'), seenIdentityJti: guard('seenIdentityJti') },
    'trustLoss.js': { markTrustLost: guard('markTrustLost') }, 'alerts.js': { noteSignatureFailure: (id: string) => { signatureFailures.push(id); } },
    'settings.js': { isSmtpConfigured: async () => false, getSmtpConfig: guard('getSmtpConfig'), setSmtpConfig: guard('setSmtpConfig'), smtpSource: guard('smtpSource') },
  };
  const libraries: Record<string, unknown> = { 'drizzle-orm': orm, '@gusvoice/shared': shared, zod: { z }, 'node:crypto': crypto };
  function load<T>(path: string, raw?: string): T {
    const text = raw ?? readFileSync(url(path), 'utf8'); const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const deps: Record<string, unknown> = {};
    for (const node of tree.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.importClause?.isTypeOnly) continue;
      const spec = node.moduleSpecifier.text, name = spec.split('/').at(-1)!;
      if (Object.hasOwn(libraries, spec)) { deps[spec] = libraries[spec]; continue; }
      if (Object.hasOwn(modules, name)) { deps[spec] = modules[name]; continue; }
      if (!unused.has(name)) throw new Error(`неописанный модуль ${path}: ${spec}`);
      const exports: Record<string, unknown> = {};
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) { for (const e of bindings.elements) if (!e.isTypeOnly) exports[e.propertyName?.text ?? e.name.text] = guard(`${spec}.${e.name.text}`); }
      else if (bindings) throw new Error(`неописанный namespace ${spec}`);
      deps[spec] = exports;
    }
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
      { module, exports: module.exports, Date, URL, Buffer, console: { warn: () => {}, log: () => {} },
        process: { env: { FEDERATION_ENABLED: 'true', FEDERATION_DM_ENABLED: enabled ? 'true' : 'false' } }, fetch: guard('fetch'), setTimeout: guard('setTimeout'),
        require: (spec: string) => { if (!Object.hasOwn(deps, spec)) throw new Error(`неописанный require ${spec}`); return deps[spec]; } });
    return module.exports as T;
  }
  const peerClient = load<typeof import('../src/federation/peerClient.js')>('federation/peerClient.ts');
  modules['peerClient.js'] = { ...peerClient, fetchPeerDocument: async () => ({ ok: true, value: { instanceId: peerId, doc } }), postSignedToPeer: guard('postSignedToPeer') };
  const core = load<typeof import('../src/federation/peerAuthCore.js')>('federation/peerAuthCore.ts'); modules['peerAuthCore.js'] = core;
  modules['peerAuth.js'] = load<typeof import('../src/federation/peerAuth.js')>('federation/peerAuth.ts');
  modules['instanceSetup.js'] = load<typeof import('../src/instanceSetup.js')>('instanceSetup.ts');
  modules['peerQueries.js'] = load<typeof import('../src/db/peerQueries.js')>('db/peerQueries.ts');
  modules['conversations.js'] = load<typeof import('../src/conversations.js')>('conversations.ts');
  modules['guestHost.js'] = load<typeof import('../src/federation/guestHost.js')>('federation/guestHost.ts');
  modules['convOpen.js'] = load<typeof import('../src/federation/convOpen.js')>('federation/convOpen.ts');
  const labels = load<typeof import('../src/federation/instanceLabels.js')>('federation/instanceLabels.ts'); modules['instanceLabels.js'] = labels;
  modules['remoteUserSearch.js'] = load<typeof import('../src/federation/remoteUserSearch.js')>('federation/remoteUserSearch.ts');
  modules['userSearch.js'] = load<typeof import('../src/db/userSearch.js')>('db/userSearch.ts');
  const users = load<typeof import('../src/routes/users.js')>('routes/users.ts');
  const conv = load<typeof import('../src/routes/conv.js')>('routes/conv.ts');
  const admin = load<typeof import('../src/routes/admin.js')>('routes/admin.ts');
  const fed = load<typeof import('../src/routes/federation.js')>('routes/federation.ts', federationRaw);
  const app = Fastify(); await app.register(users.userRoutes); await app.register(conv.convRoutes); await app.register(admin.adminRoutes); await app.register(fed.federationRoutes); await app.ready();
  await t.db.insert(schema.users).values({ id: 'me', username: 'local', displayName: 'Местный', passwordHash: 'fixture', verified: true, approvedAt: new Date() });
  await t.db.insert(schema.federationLinks).values({ instanceId: peerId, domain: 'peer.example', apiBase: doc.apiBase, clientOrigin: doc.clientOrigin, rootKey: doc.rootKey, state: 'active', features: ['dm1'] });
  await labels.refreshInstanceLabels();
  return { app, peerId, selfId, key, bound, signatureFailures, configure: conv.configureFedDirect,
    headers: (body: string, path = '/fed/v1/conv/open') => ({ 'content-type': 'application/json', ...signature.signRequest({ method: 'POST', targetUri: `https://self.example/api${path}`, body, keyid: key.kid, privateKeyDer: key.privateKeyDer, nowS: Math.floor(Date.now() / 1000) }) }) };
}
test('R189 поиск @имя@домен возвращает remote из настоящего кеша, пауза и чужой домен не видны', async () => {
  // Класс ошибки: remote поиск смешивает домены или раскрывает недоступную связку.
  const f = await fixture(); try {
    await t.db.insert(schema.federationPeerUsers).values({ instanceId: f.peerId, userId: 'remote-user', username: 'Peer', displayName: 'Сосед', updatedAt: Date.now() });
    const found = await f.app.inject({ method: 'GET', url: '/users/search?q=%40peer%40peer.example' });
    assert.equal(found.statusCode, 200); const body = found.json(); assert.equal(body.users.length, 0); assert.equal(body.remote.length, 1);
    assert.equal(body.remote[0].homeUserId, 'remote-user'); assert.equal(body.remote[0].instanceId, f.peerId); assert.equal(body.remote[0].instance.domain, 'peer.example');
    assert.equal((await f.app.inject('/users/search?q=%40peer%40other.example')).json().remote.length, 0);
    await t.db.update(schema.federationLinks).set({ state: 'paused' });
    assert.equal((await f.app.inject('/users/search?q=%40peer%40peer.example')).json().remote.length, 0);
  } finally { await f.app.close(); }
});
test('R189 без флага remote handle не запускает федеративный поиск', async () => {
  // Класс ошибки: скрытая фича доступна до включения флага.
  const f = await fixture(false); try { const r = await f.app.inject('/users/search?q=%40peer%40peer.example');
    assert.equal(r.statusCode, 400); assert.equal(Object.hasOwn(r.json(), 'remote'), false);
  } finally { await f.app.close(); }
});
test('R189 remote тело direct передаёт пользователя и пару configured hook, без hook прежний отказ', async () => {
  // Класс ошибки: маршрут теряет instanceId/homeUserId или включает федерацию без конфигурации.
  const f = await fixture(); try {
    const payload = { instanceId: f.peerId, homeUserId: 'remote-user' };
    const off = await f.app.inject({ method: 'POST', url: '/conv/direct', payload }); assert.equal(off.statusCode, 403); assert.equal(off.json().error, shared.FED_ERRORS.dmUnavailable);
    f.configure(async (me, target) => { f.bound.push([me, target]); return { ok: false, status: 409, body: { error: 'fixture-opener' } }; });
    const on = await f.app.inject({ method: 'POST', url: '/conv/direct', payload }); assert.equal(on.statusCode, 409); assert.equal(on.json().error, 'fixture-opener');
    assert.equal(JSON.stringify(f.bound), JSON.stringify([['me', payload]]));
    const self = await f.app.inject({ method: 'POST', url: '/conv/direct', payload: { userId: 'me' } }); assert.equal(self.statusCode, 400); assert.equal(self.json().error, 'cannot DM yourself');
    const absent = await f.app.inject({ method: 'POST', url: '/conv/direct', payload: { userId: 'absent' } }); assert.equal(absent.statusCode, 404); assert.equal(f.bound.length, 1);
  } finally { await f.app.close(); }
});
test('R189 местное direct тело сохраняет проверку общего сервера и не вызывает federated hook', async () => {
  // Класс ошибки: обычный local путь ошибочно перенаправляется к соседу.
  const f = await fixture(); try {
    await t.db.insert(schema.users).values({ id: 'other', username: 'other', displayName: 'Другой', passwordHash: 'fixture', verified: true, approvedAt: new Date() });
    f.configure(async () => { throw new Error('local не вызывает remote hook'); });
    const r = await f.app.inject({ method: 'POST', url: '/conv/direct', payload: { userId: 'other' } });
    assert.equal(r.statusCode, 403); assert.equal(r.json().reason, dmRules.DM_OPEN_REASONS.noSharedServer);
    assert.equal((await t.db.select().from(schema.conversations)).length, 0);
    await t.db.insert(schema.conversations).values({ id: 'local-direct', kind: 'direct', directKey: 'me:other', createdBy: 'me' });
    await t.db.insert(schema.conversationMembers).values([{ conversationId: 'local-direct', userId: 'me' }, { conversationId: 'local-direct', userId: 'other' }]);
    const old = await f.app.inject({ method: 'POST', url: '/conv/direct', payload: { userId: 'other' } });
    assert.equal(old.statusCode, 200); assert.equal(old.json().id, 'local-direct'); assert.equal(old.json().otherUser.id, 'other');
    assert.equal((await t.db.select().from(schema.conversations)).length, 1);
  } finally { await f.app.close(); }
});
async function signed(raw = source) {
  await truncateAll(t.raw); const f = await fixture(true, raw); try {
    const body = JSON.stringify(shared.serializeConvOpenRequest({ instanceId: f.peerId, from: { userId: 'remote-user', username: 'peer', displayName: 'Сосед', avatarHash: null }, toUserId: 'absent', conversationId: crypto.randomUUID(), createdAt: Date.now(), sharedServerIds: [] }));
    const accepted = await f.app.inject({ method: 'POST', url: '/fed/v1/conv/open', headers: f.headers(body), payload: body });
    assert.equal(accepted.statusCode, 403, 'подписанный POST прошёл proto admission');
    assert.equal(accepted.json().reason, 'no_user', 'ответ настоящего acceptConvOpen после подписи');
    const changed = await f.app.inject({ method: 'POST', url: '/fed/v1/conv/open', headers: f.headers(body), payload: body.replace('absent', 'changed') });
    assert.equal(changed.statusCode, 401); assert.equal(changed.json().error, 'unknown');
    const wrong = await f.app.inject({ method: 'POST', url: '/fed/v1/conv/open', headers: f.headers(body, '/other-scope'), payload: body }); assert.equal(wrong.statusCode, 401);
    const unsigned = await f.app.inject({ method: 'POST', url: '/fed/v1/conv/open', payload: JSON.parse(body) }); assert.equal(unsigned.statusCode, 401);
    assert.equal(f.signatureFailures.length, 2); assert.equal(f.signatureFailures.every(id => id === f.peerId), true);
  } finally { await f.app.close(); }
}
test('R189 proto принимает настоящую Ed25519 подпись сырого POST, изменение тела адреса или отсутствие подписи даёт 401', async () => {
  // Класс ошибки: подпись проверяется не по байтам rawBody или не защищает адрес.
  await signed();
});
test('R189 маршрут conv open вне proto теряет rawBody и отвергается именно подписью', async () => {
  // Класс ошибки: регистрация подписанного POST вне нужного content-type scope.
  await signed(); const anchor = "proto.post('/fed/v1/conv/open',"; assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(signed(source.replace(anchor, "app.post('/fed/v1/conv/open',")),
    e => e instanceof assert.AssertionError && e.message.includes('подписанный POST прошёл proto admission'));
});
test('R189 conv open без флага не регистрируется, даже с правильной подписью', async () => {
  // Класс ошибки: протокольная ручка доступна до включения Э1.
  const f = await fixture(false); try { const body = JSON.stringify({ instance_id: f.peerId });
    const r = await f.app.inject({ method: 'POST', url: '/fed/v1/conv/open', payload: body, headers: f.headers(body) }); assert.equal(r.statusCode, 404);
  } finally { await f.app.close(); }
});
test('R189 fedDmPolicy отсутствует и не сохраняется без флага, с флагом shared меняется на anyone', async () => {
  // Класс ошибки: админская настройка преждевременно доступна или PUT не пишет действующую политику.
  for (const enabled of [false, true]) {
    await truncateAll(t.raw); const f = await fixture(enabled); try {
      const before = await f.app.inject('/admin/instance'); assert.equal(before.statusCode, 200);
      assert.equal(Object.hasOwn(before.json(), 'fedDmPolicy'), enabled); if (enabled) assert.equal(before.json().fedDmPolicy, 'shared');
      const put = await f.app.inject({ method: 'PUT', url: '/admin/instance', payload: { fedDmPolicy: 'anyone' } }); assert.equal(put.statusCode, 200); assert.equal(put.json().ok, true);
      const rows = await t.db.select().from(schema.instanceSettings).where(orm.eq(schema.instanceSettings.key, 'fed_dm_policy'));
      assert.equal(rows.length, enabled ? 1 : 0); if (enabled) assert.equal((await f.app.inject('/admin/instance')).json().fedDmPolicy, 'anyone');
    } finally { await f.app.close(); }
  }
});
