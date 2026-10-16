import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, test } from 'node:test';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as groupRules from '../src/groupRules.js';
import * as userSearchRules from '../src/userSearchRules.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as linkCode from '../src/federation/linkCode.js';
import * as linkService from '../src/federation/linkService.js';
import * as guestRules from '../src/federation/guestRules.js';
import * as identityToken from '../src/federation/identityToken.js';
import * as identityRules from '../src/federation/instanceIdentity.js';
import * as signing from '../src/federation/signingKeys.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Name = 'C' | 'D' | 'E';
type Identity = { instanceId: string; rootPublicKeyDer: Buffer; key: signing.SigningKeyPair };
type Mutation = { from: string; to: string };
type Changes = typeof import('../src/federation/convChanges.js');
const names: Name[] = ['C', 'D', 'E'];
const people: Record<Name, string> = { C: 'c1', D: 'd1', E: 'e1' };
const cid = 'export-marks-group';
const features = [shared.FED_FEATURES.dm1, shared.FED_FEATURES.dmgroup1, shared.FED_FEATURES.dm2once, shared.FED_FEATURES.dmgroupmarks1];
const noMarks = features.filter(f => f !== shared.FED_FEATURES.dmgroupmarks1);
const voice: shared.Attachment = { id: 'export-voice', name: 'voice.ogg', contentType: 'audio/ogg', size: 10, url: '/fixture', durationMs: 1000, waveform: [50] };
const uid = (at: Name, who: Name) => at === who ? people[who] : `${at.toLowerCase()}:${people[who]}`;
const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;
const fail = (name: string) => () => { throw new Error(`неописанный путь: ${name}`); };
let dbs: Record<Name, TestDb>;
let identities: Record<Name, Identity>;
let now: number;

function identity(): Identity {
  const root = crypto.generateKeyPairSync('ed25519');
  const publicKey = root.publicKey.export({ type: 'spki', format: 'der' });
  return { instanceId: identityRules.instanceIdFrom(publicKey), rootPublicKeyDer: publicKey,
    key: signing.issueSigningKey(root.privateKey.export({ type: 'pkcs8', format: 'der' }), Date.now()) };
}
before(async () => {
  identities = { C: identity(), D: identity(), E: identity() };
  dbs = {} as Record<Name, TestDb>;
  for (const name of names) dbs[name] = await createTestDb();
});
after(async () => {
  let closed: PromiseSettledResult<void>[] = [];
  try {
    // Каждая база должна получить close, даже если другая завершила его ошибкой.
    closed = await Promise.allSettled(names.filter(name => dbs?.[name]).map(name => dbs[name].close()));
  } finally {
    // Harness импортирует исходное соединение приложения, хотя запросы идут только в PGlite.
    const { pool } = await import('../src/db/index.js');
    await pool.end();
  }
  for (const result of closed) assert.equal(result.status, 'fulfilled', 'все базы PGlite закрыты');
});

/** Целые production-модули, отдельное соединение на дом. Неизвестный импорт/таймер — ошибка фикстуры, не убитый мутант. */
function moduleOf<T>(name: string, deps: Record<string, unknown>, mutation?: Mutation, cap60 = false): T {
  let raw = source(name);
  if (name === 'federation/convChanges') {
    if (cap60) {
      const anchor = 'const GROUP_EXPORT_ITEMS = FED_CONV_EXPORT_MESSAGES * 4;';
      assert.equal(raw.split(anchor).length, 2, 'единственный якорь искусственного предела');
      raw = raw.replace(anchor, 'const GROUP_EXPORT_ITEMS = 60;');
    }
    if (mutation) {
      assert.equal(raw.split(mutation.from).length, 2, 'единственный якорь мутанта R209');
      raw = raw.replace(mutation.from, mutation.to);
    }
  }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Date, Buffer, URL, Map, Set, Promise, Error,
    console: { warn() {}, log: fail('console.log'), error: fail('console.error') },
    setTimeout: fail('таймер'), setInterval: fail('worker'),
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `явный импорт ${name}:${id}`); return deps[id]; },
  });
  return module.exports as T;
}

type Inst = ReturnType<typeof instanceModules>;
function instanceModules(self: Name, mutation?: Mutation, cap60 = false) {
  const t = dbs[self], ident = identities[self];
  const fed = { 'drizzle-orm': orm, '@gusvoice/shared': shared, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const instance = { federation: { identity: () => ident, signingKey: () => ident.key }, domainFromOrigin: fail('домен своей визитки') };
  // getLink/saveVouchedInstance и shadowUserFor/ensureShadowUser настоящие: состав возвращается реальным applyGroupConv.
  const links = moduleOf<typeof import('../src/federation/links.js')>('federation/links', {
    ...fed, 'node:crypto': crypto, './linkCode.js': linkCode, './linkService.js': linkService, './instance.js': instance,
    './peerClient.js': { fetchPeerDocument: fail('визитка по сети'), postSignedToPeer: fail('рукопожатие'), proveDomain: fail('домен по сети') },
    './revocation.js': { isRevoked: fail('отзыв'), rebindLink: fail('перепривязка') }, './auditLog.js': { fedAudit: fail('аудит') },
    './outbox.js': { queueDepth: fail('очередь') }, './directoryCache.js': { forgetPeerCache: fail('кеш каталога') },
    './peerAuth.js': { forgetPeerDocument: fail('кеш визитки') }, './guestAccess.js': { freezeGuestsOf: fail('заморозка'), thawGuestsOf: fail('разморозка') },
    '../env.js': { env: {} }, '../auth.js': { superAdminId: fail('администратор') }, '../realtime.js': { publishToUser: fail('Redis') },
    '../corsOrigins.js': { refreshPeerOrigins: fail('CORS') }, './instanceMeta.js': { readInstanceMeta: fail('пауза') },
  });
  const guest = moduleOf<typeof import('../src/federation/guestHost.js')>('federation/guestHost', {
    ...fed, 'node:crypto': crypto, './instance.js': instance, './links.js': links, './linkRules.js': linkRules,
    './guestRules.js': guestRules, './identityToken.js': identityToken,
    '../auth.js': { hashPassword: fail('новый теневой пароль'), bumpTokenGeneration: fail('поколение'), signToken: fail('сессия') },
    '../authRules.js': { TOKEN_TTL_S: 3600 }, './instanceMeta.js': { readInstanceMeta: fail('пауза') },
    './peerAuth.js': { peerPublicKey: fail('ключ из сети') }, './guardsRuntime.js': { fedRateBlock: fail('Redis'), seenIdentityJti: fail('Redis') },
    './instanceBan.js': { instanceBanFor: fail('бан') }, './avatars.js': { refreshGuestAvatar: fail('картинка по сети') },
  });
  const changes = moduleOf<Changes>('federation/convChanges', fed, mutation, cap60);
  const c = moduleOf<typeof import('../src/conversations.js')>('conversations', {
    'drizzle-orm': orm, '@gusvoice/shared': shared, './db/index.js': { db: t.db }, './db/schema.js': schema, './convRules.js': rules,
    './dmWriteBarrier.js': { dmWriteBarrier: {} }, './env.js': { env: {} }, './util.js': { uuidv7: crypto.randomUUID },
    './attachments.js': { attachmentLink: fail('URL файла'), attachmentStore: {}, copyForForward: fail('пересылка файла'),
      DailyQuotaError: class extends Error {}, discardForwardCopies: fail('удаление копий'), privateAttachmentsReady: fail('готовность файлов'), purgeDeleted: fail('удаление файлов') },
    './serialize.js': { homeInstanceOf: fail('дом для DTO'), serializeMessage: fail('клиентский DTO') },
  });
  c.configureFederatedConv({ selfInstanceId: () => ident.instanceId, record: changes.recordFedConvChanges });
  const deliveries: unknown[] = [];
  const conv = { ...c, deliver: async (delivery: unknown) => { deliveries.push(delivery); } };
  const group = moduleOf<typeof import('../src/federation/convGroup.js')>('federation/convGroup', {
    ...fed, 'node:crypto': crypto, '../conversations.js': conv, '../groupRules.js': groupRules, '../userSearchRules.js': userSearchRules,
    '../convGroups.js': { addGroupMembers: fail('операция add'), removeGroupMember: fail('операция remove'), updateGroupInfo: fail('операция title') },
    './directorySync.js': { refreshCapabilities: fail('визитка по сети') }, './guestHost.js': guest, './instance.js': instance,
    './instanceIdentity.js': identityRules, './instanceMeta.js': { readInstanceMeta: fail('пауза') }, './linkRules.js': linkRules,
    './links.js': links, './peerClient.js': { postSignedToPeer: fail('операция по сети') }, './signingKeys.js': signing,
  });
  changes.configureFedGroupSigner(group.signOwnMessage);
  const paths: { path: string; after: unknown }[] = [];
  const io = { get: fail('несоединённый транспорт') as (request: { path: string; query?: Record<string, unknown> }) => Promise<unknown> };
  const accept = moduleOf<typeof import('../src/federation/convAccept.js')>('federation/convAccept', {
    ...fed, '../conversations.js': conv, '../convRules.js': rules, '../convSendFanout.js': { fanOutSend: async () => {} },
    './convLink.js': { notePeerAnswer: () => {}, onLinkRestored: fail('подписка') },
    './eventStream.js': { onFedEvent: fail('worker'), sendEventTo: fail('звонок по сети') }, './instance.js': instance,
    './peerClient.js': { getSignedFromPeer: async (request: { path: string; query?: Record<string, unknown> }) => {
      paths.push({ path: request.path, after: request.query?.after }); return io.get(request);
    } },
  });
  accept.configureFedGroupAccept({ applyConv: group.applyGroupConv, verify: group.verifyMessageSig });
  accept.configureFedConvRow(async (...args) => (await group.acceptGroupConvRow(...args)) === true);
  const record = (items: Parameters<Changes['recordFedConvChanges']>[1]) => t.db.transaction(tx => changes.recordFedConvChanges(tx as never, items));
  return { self, ident, t, changes, c, group, accept, io, paths, record, deliveries };
}

async function fixture(mutation?: Mutation, options: { cap60?: boolean; noEMarks?: boolean } = {}) {
  now = Date.now();
  for (const self of names) {
    const t = dbs[self]; await truncateAll(t.raw);
    await t.db.insert(schema.users).values(names.map(who => ({ id: uid(self, who), username: `fixture_${self}_${who}`,
      displayName: `Участник ${who}`, passwordHash: 'synthetic-fixture',
      ...(self === who ? {} : { homeInstanceId: identities[who].instanceId, homeUserId: people[who], homeUsername: `fixture_${who}` }) })));
    const peers = self === 'D' ? ['C', 'E'] as Name[] : ['D'] as Name[];
    await t.db.insert(schema.federationLinks).values(peers.map(peer => ({
      instanceId: identities[peer].instanceId, domain: `${peer.toLowerCase()}.invalid`, apiBase: `https://${peer.toLowerCase()}.invalid/api`,
      clientOrigin: `https://${peer.toLowerCase()}.invalid`, rootKey: identities[peer].rootPublicKeyDer.toString('base64url'), state: 'active' as const,
      features: self === 'D' && peer === 'E' && options.noEMarks ? noMarks : features,
    })));
    await t.db.insert(schema.conversations).values({ id: cid, kind: 'group', title: 'Синтетическая группа', groupVersion: 2,
      originInstanceId: self === 'D' ? null : identities.D.instanceId, createdBy: uid(self, 'D') });
    await t.db.insert(schema.conversationMembers).values(names.map(who => ({ conversationId: cid, userId: uid(self, who),
      role: who === 'D' ? 'owner' as const : 'member' as const })));
    await t.db.insert(schema.conversationMessages).values([
      { id: 'm1', conversationId: cid, authorId: uid(self, 'C'), sortKey: 1, content: 'Текст C', createdAt: new Date(now - 60000) },
      { id: 'm2', conversationId: cid, authorId: uid(self, 'D'), sortKey: 2, content: 'Текст D', createdAt: new Date(now - 59000) },
      { id: 'v1', conversationId: cid, authorId: uid(self, 'E'), sortKey: 3, content: '', attachments: [voice], createdAt: new Date(now - 58000) },
    ]);
  }
  const all = { C: instanceModules('C', mutation, options.cap60), D: instanceModules('D', mutation, options.cap60), E: instanceModules('E', mutation, options.cap60) };
  // Копии C/E у хоста имеют настоящую подпись автора. Приём не разрешён искусственным verify: true.
  for (const author of ['C', 'E'] as Name[]) {
    const id = author === 'C' ? 'm1' : 'v1';
    const [message] = await all[author].t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, id));
    const users = await all[author].t.db.select().from(schema.users);
    const wire = all[author].changes.toWireMessage(message, new Map(users.map(u => [u.id, u])), identities[author].instanceId);
    const sig = all[author].group.signOwnMessage(wire); assert.ok(sig, 'настоящая подпись синтетического автора');
    assert.equal(all.D.group.verifyMessageSig(wire, { sig }), true, 'фикстура проходит настоящую проверку подписи');
    for (const peer of names.filter(n => n !== author)) {
      await all[peer].t.db.update(schema.conversationMessages).set({ originSig: sig }).where(orm.eq(schema.conversationMessages.id, id));
    }
  }
  return all;
}
const labels = (page: shared.FedConvExportPage | null) => page?.items.map(i => `${i.kind}:${i.entityId ?? ''}`);
const response = (body: unknown, status = 200) => ({ ok: true, value: { status, contentType: 'application/json', body: JSON.stringify(body), retryAfter: null } });

/** Подменён только транспорт. Список, экспорт, журнал, парсеры и приём — production. */
function connect(peer: Inst, host: Inst, pages: shared.FedConvExportPage[]) {
  peer.io.get = async request => {
    const query = request.query ?? {};
    if (request.path === '/api/fed/v1/conv/changes') {
      return response(shared.serializeConvChangesPage(await host.changes.changesForPeer(peer.ident.instanceId, Number(query.since), 100, host.ident.instanceId)));
    }
    if (request.path === '/api/fed/v1/conv/groups') {
      const groups = await host.changes.groupsForPeer(peer.ident.instanceId);
      return groups ? response(shared.serializeConvGroupsList({ instanceId: host.ident.instanceId, groups })) : response({}, 404);
    }
    assert.equal(request.path, `/api/fed/v1/conv/${cid}/export`, 'единственный допустимый путь экспорта');
    const page = await host.changes.exportForPeer(peer.ident.instanceId, cid, (query.after as string | null) ?? null, host.ident.instanceId);
    if (page) pages.push(page);
    return page ? response(shared.serializeConvExportPage(page)) : response({}, 404);
  };
}
async function hostMarks(D: Inst) {
  await D.t.db.insert(schema.conversationMessageReactions).values([
    { messageId: 'm2', userId: uid('D', 'C'), emoji: '❤' }, { messageId: 'm1', userId: uid('D', 'E'), emoji: '👍' },
  ]);
  await D.t.db.insert(schema.conversationPins).values(names.map(who => ({ conversationId: cid, userId: uid('D', who),
    messageId: 'm1', pinnedBy: uid('D', 'C'), forBoth: true })));
  await D.t.db.update(schema.conversationMembers).set({ lastReadKey: 3 }).where(orm.eq(schema.conversationMembers.userId, uid('D', 'C')));
  await D.t.db.insert(schema.conversationVoiceListens).values({ messageId: 'v1', userId: uid('D', 'C') });
}
async function reactions(inst: Inst) {
  return (await inst.t.db.select().from(schema.conversationMessageReactions)).map(r => `${r.messageId}:${r.userId}:${r.emoji}`).sort();
}
async function resetScene(mutation?: Mutation) {
  const { C, D, E } = await fixture(mutation); await hostMarks(D);
  await E.t.db.insert(schema.conversationMessageReactions).values({ messageId: 'm1', userId: 'e1', emoji: '👍' });
  await D.t.db.insert(schema.fedConvSync).values({ instanceId: E.ident.instanceId, seq: 20, minSeq: 15 });
  await E.t.db.insert(schema.fedConvCursor).values({ instanceId: D.ident.instanceId, since: 7 });
  assert.equal((await E.c.peerReadKeys('e1', [cid], E.t.db as never)).get(cid) ?? 0, 0, 'R209 reset: до прохода прочитанного нет');
  const pages: shared.FedConvExportPage[] = []; connect(E, D, pages);
  assert.equal(await E.accept.pullConvChanges(D.ident.instanceId), 20, 'R209 reset: курсор принимает голову журнала');
  assert.deepEqual(normal(pages.map(labels)), [['conv:', 'msg:m1', 'pin:m1', 'msg:m2', 'react:m2', 'listen:v1', 'read:']], 'R209 reset: точный порядок страницы');
  assert.deepEqual(await reactions(E), ['m1:e1:👍', 'm2:e:c1:❤'], 'R209 reset: C принят, своя реакция E не удвоена');
  assert.equal(Number((await E.c.peerReadKeys('e1', [cid], E.t.db as never)).get(cid)), 3, 'R209 reset: C прочитал голосовое E');
  assert.deepEqual((await E.t.db.select().from(schema.conversationPins)).map(p => `${p.messageId}:${p.userId}:${p.pinnedBy}:${p.forBoth}`).sort(),
    ['m1:e1:e:c1:true', 'm1:e:c1:e:c1:true', 'm1:e:d1:e:c1:true'], 'R209 reset: закреп для всех сохраняет третьего закрепившего');
  const listened = await E.t.db.select().from(schema.conversationVoiceListens);
  assert.deepEqual(listened.map(l => `${l.messageId}:${l.userId}`), ['v1:e:c1'], 'R209 reset: настоящий SQL хранит прослушивание C');
  assert.equal(E.c.voiceListenedFor('e1', 'e1', new Set(listened.map(l => l.userId))), true, 'R209 reset: голосовое E прослушано другим');
  assert.equal((await C.t.db.select().from(schema.conversationMessageReactions)).length, 0, 'R209 reset: третий дом не изменён чужим проходом');
  return { C, D, E };
}

async function reverseScene(mutation?: Mutation) {
  const { D, E } = await fixture(mutation);
  for (const inst of [D, E]) await inst.t.db.update(schema.conversationMessages).set({ attachments: [{ ...voice, id: 'voice-c' }] }).where(orm.eq(schema.conversationMessages.id, 'm1'));
  await E.t.db.insert(schema.conversationMessageReactions).values([
    { messageId: 'm1', userId: 'e1', emoji: '👍' }, { messageId: 'm2', userId: uid('E', 'C'), emoji: '❤' },
  ]);
  await E.t.db.insert(schema.conversationPins).values({ conversationId: cid, userId: 'e1', messageId: 'm1', pinnedBy: 'e1', forBoth: true });
  await E.t.db.update(schema.conversationMembers).set({ lastReadKey: 3 }).where(orm.eq(schema.conversationMembers.userId, 'e1'));
  // Даже загрязнённая SQL-копия «прослушал своё» не должна уходить хосту.
  await E.t.db.insert(schema.conversationVoiceListens).values([{ messageId: 'm1', userId: 'e1' }, { messageId: 'v1', userId: 'e1' }]);
  const back = await E.changes.exportForPeer(D.ident.instanceId, cid, null, E.ident.instanceId);
  assert.deepEqual(normal(labels(back)), ['react:m1', 'pin:m1', 'listen:m1', 'msg:v1', 'read:'], 'R209 обратно: только свои акторы и прослушивание чужого');
  const react = shared.parseConvReactionsWire(back!.items.find(i => i.kind === 'react')!.entity);
  assert.deepEqual(normal(react?.reactions), [{ user: { instanceId: E.ident.instanceId, userId: 'e1' }, emoji: '👍' }], 'R209 обратно: реакция принадлежит только E');
  const read = shared.parseConvReadsWire(back!.items.find(i => i.kind === 'read')!.entity);
  assert.deepEqual(normal(read?.reads), [{ user: { instanceId: E.ident.instanceId, userId: 'e1' }, messageId: 'm2' }], 'R209 обратно: прочитано до чужого, не до своего v1');
  const pin = shared.parseConvPinWire(back!.items.find(i => i.kind === 'pin')!.entity);
  assert.deepEqual(normal(pin), { messageId: 'm1', pinned: true, by: { instanceId: E.ident.instanceId, userId: 'e1' } }, 'R209 обратно: общий закреп принадлежит E');
  for (const item of back!.items) await D.accept.applyChange(E.ident.instanceId, D.ident.instanceId, item.kind, cid, item.entity);
  assert.deepEqual(await reactions(D), ['m1:d:e1:👍'], 'R209 обратно: приём хоста не приписывает E реакцию C');
  assert.equal(Number((await D.t.db.select().from(schema.conversationMembers).where(orm.eq(schema.conversationMembers.userId, uid('D', 'E'))))[0].lastReadKey), 2,
    'R209 обратно: SQL хоста хранит read по собственному порядку');
  assert.deepEqual((await D.t.db.select().from(schema.conversationVoiceListens)).map(l => `${l.messageId}:${l.userId}`), ['m1:d:e1'], 'R209 обратно: хост принял только чужое прослушивание');
}

async function returnScene(mutation?: Mutation) {
  const { D, E } = await fixture(mutation); await hostMarks(D);
  const left = new Date(now - 30000);
  for (const inst of [D, E]) await inst.t.db.update(schema.conversationMembers).set({ leftAt: left }).where(orm.eq(schema.conversationMembers.userId, uid(inst.self, 'E')));
  await D.t.db.insert(schema.conversationMessages).values({ id: 'm3', conversationId: cid, authorId: uid('D', 'C'), sortKey: 4, content: 'Пропущено после ухода', createdAt: new Date(now - 20000) });
  const [m3] = await D.t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, 'm3'));
  const users = await D.t.db.select().from(schema.users);
  const wire = D.changes.toWireMessage(m3, new Map(users.map(u => [u.id, u])), D.ident.instanceId);
  const signer = instanceModules('C'); const sig = signer.group.signOwnMessage(wire); assert.ok(sig);
  await D.t.db.update(schema.conversationMessages).set({ originSig: sig }).where(orm.eq(schema.conversationMessages.id, 'm3'));
  await D.t.db.insert(schema.conversationMessageReactions).values({ messageId: 'm3', userId: 'd1', emoji: '🔥' });
  const former = await D.changes.exportForPeer(E.ident.instanceId, cid, null, D.ident.instanceId);
  assert.deepEqual(normal(labels(former)), ['conv:', 'msg:m1', 'msg:m2'], 'R209 бывший: отметки и сообщение после ухода не раскрываются');
  await D.t.db.update(schema.conversationMembers).set({ leftAt: null }).where(orm.eq(schema.conversationMembers.userId, uid('D', 'E')));
  await D.t.db.update(schema.conversations).set({ groupVersion: 3 }).where(orm.eq(schema.conversations.id, cid));
  await D.record([{ conversationId: cid, kind: 'conv', entityId: null }]);
  const pages: shared.FedConvExportPage[] = []; connect(E, D, pages);
  assert.ok((await E.accept.pullConvChanges(D.ident.instanceId))! > 0, 'R209 возврат: журнал принят');
  assert.deepEqual(normal(pages.map(labels)), [['msg:m3', 'react:m3', 'read:']], 'R209 возврат: догонка несёт сообщение, реакцию, прочитано');
  assert.equal(E.paths.find(p => p.path.endsWith('/export'))?.after, 'v1', 'R209 возврат: курсор начинается за последним известным сообщением');
  assert.equal((await E.t.db.select().from(schema.conversationMembers).where(orm.eq(schema.conversationMembers.userId, 'e1')))[0].leftAt, null, 'R209 возврат: настоящий applyGroupConv вернул участника');
  assert.equal((await E.t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, 'm3')))[0]?.content, 'Пропущено после ухода', 'R209 возврат: подписанная копия реально вставлена');
  assert.deepEqual(await reactions(E), ['m3:e:d1:🔥'], 'R209 возврат: отметка вставлена рядом с догнанной копией');
  assert.equal(Number((await E.c.peerReadKeys('e1', [cid], E.t.db as never)).get(cid)), 3, 'R209 возврат: прочитано восстановлено в SQL');
}

async function featureScene(mutation?: Mutation) {
  const { C, D, E } = await fixture(mutation, { noEMarks: true }); await hostMarks(D);
  const old = await D.changes.exportForPeer(E.ident.instanceId, cid, null, D.ident.instanceId);
  assert.deepEqual(normal(labels(old)), ['conv:', 'msg:m1', 'msg:m2'], 'R209 признак: dmgroup1 недостаточно для отметок');
  const capable = await D.changes.exportForPeer(C.ident.instanceId, cid, null, D.ident.instanceId);
  assert.deepEqual(normal(labels(capable)), ['conv:', 'react:m1', 'pin:m1', 'msg:m2', 'msg:v1', 'read:'], 'R209 признак: C с dmgroupmarks1 принимает реакцию E, общий закреп и read');
  const pin = shared.parseConvPinWire(capable!.items.find(i => i.kind === 'pin')!.entity);
  assert.equal(pin?.pinned, true, 'R209 признак: общий закреп не исчез при наличии признака');
}

async function largeScene(mutation?: Mutation, cap60 = false) {
  const { D, E } = await fixture(mutation, { cap60 });
  const many = Array.from({ length: 150 }, (_, i) => `x${String(i).padStart(3, '0')}`);
  await D.t.db.insert(schema.conversationMessages).values(many.map((id, i) => ({ id, conversationId: cid, authorId: 'd1', sortKey: 10 + i, content: id })));
  await D.t.db.insert(schema.conversationMessageReactions).values(many.map(id => ({ messageId: id, userId: uid('D', 'C'), emoji: '❤' })));
  const p1 = await D.changes.exportForPeer(E.ident.instanceId, cid, null, D.ident.instanceId);
  assert.ok(p1, 'страница больших данных существует');
  if (cap60) {
    assert.equal(p1.items.length, 59, 'R209 предел: непоместившееся сообщение полностью откачено');
    assert.equal(p1.next, 'x027', 'R209 предел: next указывает последнее полностью поместившееся');
    assert.deepEqual(normal(labels(p1)?.slice(-2)), ['msg:x027', 'react:x027'], 'R209 предел: нет половины следующего сообщения');
    const p2 = await D.changes.exportForPeer(E.ident.instanceId, cid, p1.next, D.ident.instanceId);
    assert.deepEqual(normal(labels(p2)?.slice(0, 2)), ['msg:x028', 'react:x028'], 'R209 предел: следующая страница не теряет остаток');
    return;
  }
  assert.equal(p1.next, 'x096', 'R209 страницы: next — сотое сообщение, включая три исходных');
  assert.equal(p1.items.some(i => i.kind === 'read'), false, 'R209 страницы: read не появляется до последней страницы');
  const p2 = await D.changes.exportForPeer(E.ident.instanceId, cid, p1.next, D.ident.instanceId); assert.ok(p2);
  assert.equal(p2.next, null, 'R209 страницы: вторая страница завершает проход');
  assert.equal(p2.items.at(-1)?.kind, 'read', 'R209 страницы: read завершает последнюю страницу');
  assert.equal(p2.items.filter(i => i.kind === 'read').length, 1, 'R209 страницы: последняя страница содержит ровно один read');
  assert.equal(p2.items.filter(i => i.kind === 'react').length, 53, 'R209 страницы: все оставшиеся реакции сохранены');
  const messages = [p1, p2].flatMap(p => p.items.filter(i => i.kind === 'msg').map(i => i.entityId));
  assert.deepEqual(normal(messages), ['m1', 'm2', ...many], 'R209 страницы: сообщения без дыр и дублей');
  for (const page of [p1, p2]) {
    assert.ok(page.items.length <= 401, 'R209 страницы: предел протокола не превышен');
    const parsed = shared.parseConvExportPage(shared.serializeConvExportPage(page));
    assert.deepEqual(normal(parsed), normal(page), 'R209 страницы: обе страницы целиком проходят настоящий parser');
  }
}

async function deletedScene(mutation?: Mutation) {
  const { D, E } = await fixture(mutation);
  await D.t.db.update(schema.conversationMessages).set({ deletedAt: new Date(now) }).where(orm.eq(schema.conversationMessages.id, 'm1'));
  await D.t.db.insert(schema.conversationMessageReactions).values([{ messageId: 'm1', userId: 'd1', emoji: '👍' }, { messageId: 'm2', userId: 'd1', emoji: '❤' }]);
  const page = await D.changes.exportForPeer(E.ident.instanceId, cid, null, D.ident.instanceId);
  assert.deepEqual(normal(labels(page)), ['conv:', 'msg:m1', 'msg:m2', 'react:m2', 'read:'], 'R209 удалено: старая реакция не выходит, живая выходит');
  assert.equal(shared.parseConvMessageWire(page!.items.find(i => i.entityId === 'm1')!.entity)?.deleted, true, 'R209 удалено: надгробие сохраняется');
}

async function personalPinScene(mutation?: Mutation) {
  const { D, E } = await fixture(mutation);
  await D.t.db.insert(schema.conversationPins).values([
    { conversationId: cid, messageId: 'm1', userId: 'd1', pinnedBy: 'd1', forBoth: false },
    { conversationId: cid, messageId: 'm2', userId: 'd1', pinnedBy: 'd1', forBoth: true },
  ]);
  const page = await D.changes.exportForPeer(E.ident.instanceId, cid, null, D.ident.instanceId);
  assert.deepEqual(normal(labels(page)), ['conv:', 'msg:m1', 'msg:m2', 'pin:m2', 'read:'], 'R209 личный закреп: для себя не выходит, для всех выходит');
  assert.equal(shared.parseConvPinWire(page!.items.find(i => i.kind === 'pin')!.entity)?.pinned, true, 'R209 личный закреп: общий закреп принят');
}

test('R209 reset у E восстанавливает реакцию C, общий закреп, прослушивание и прочитано без эха своей реакции', async () => { await resetScene(); });
test('R209 обратно E отдаёт хосту только своих акторов и прослушивание чужих сообщений', async () => { await reverseScene(); });
test('R209 бывший не получает отметок, возвращённый догоняет подписанное сообщение с реакцией и read', async () => { await returnScene(); });
test('R209 без dmgroupmarks1 отметки не отдаются, дом C с признаком принимает их', async () => { await featureScene(); });
test('R209 150 сообщений с реакциями: курсор по сотому сообщению, read на последней странице и настоящий parser', async () => { await largeScene(); });
test('R209 отметка удалённого не отдается, реакция живого сообщения сохраняется', async () => { await deletedScene(); });
test('R209 личный закреп не отдается, общий закреп проходит', async () => { await personalPinScene(); });

/** Адресный host AssertionError с actual/expected: SQL/loader/таймер/другой realm не считаются доказательством kill. */
const killed = (label: string, expected: unknown, actual: unknown) => (error: unknown) => error instanceof assert.AssertionError
  && error.message.startsWith(label) && Object.hasOwn(error, 'actual') && Object.hasOwn(error, 'expected')
  && JSON.stringify(error.expected) === JSON.stringify(expected) && JSON.stringify(error.actual) === JSON.stringify(actual);
const resetLabels = ['conv:', 'msg:m1', 'pin:m1', 'msg:m2', 'react:m2', 'listen:v1', 'read:'];
const reverseLabels = ['react:m1', 'pin:m1', 'listen:m1', 'msg:v1', 'read:'];
const mutations: { title: string; mutation: Mutation; scene: (m?: Mutation) => Promise<unknown>; label: string; expected: unknown; actual: unknown }[] = [
  { title: 'снято окно бывшего', mutation: { from: 'window === null && (await peerKnowsGroupMarks(instanceId))', to: '(await peerKnowsGroupMarks(instanceId))' }, scene: returnScene,
    label: 'R209 бывший: отметки и сообщение после ухода не раскрываются', expected: ['conv:', 'msg:m1', 'msg:m2'], actual: resetLabels },
  { title: 'dmgroup1 подменяет dmgroupmarks1', mutation: { from: 'return !!link?.features.includes(FED_FEATURES.dmgroupmarks1);', to: 'return !!link?.features.includes(FED_FEATURES.dmgroup1);' }, scene: featureScene,
    label: 'R209 признак: dmgroup1 недостаточно для отметок', expected: ['conv:', 'msg:m1', 'msg:m2'], actual: resetLabels },
  { title: 'участник выбирает также третьих акторов', mutation: { from: '(hosting ? m.home !== peer : m.home === null)', to: '(m.home !== peer)' }, scene: reverseScene,
    label: 'R209 обратно: только свои акторы и прослушивание чужого', expected: reverseLabels, actual: ['react:m1', 'pin:m1', 'listen:m1', 'react:m2', 'msg:v1', 'read:'] },
  { title: 'прослушивание своего сообщения отдаётся хосту', mutation: { from: '(hosting ? m.home === instanceId : m.home !== null)', to: 'true' }, scene: reverseScene,
    label: 'R209 обратно: только свои акторы и прослушивание чужого', expected: reverseLabels, actual: ['react:m1', 'pin:m1', 'listen:m1', 'msg:v1', 'listen:v1', 'read:'] },
  { title: 'read добавлен до последней страницы', mutation: { from: 'if (marks && !more) picked.push(row(FED_CONV_CHANGE.read, null));', to: 'if (marks) picked.push(row(FED_CONV_CHANGE.read, null));' }, scene: largeScene,
    label: 'R209 страницы: read не появляется до последней страницы', expected: false, actual: true },
  { title: 'реакция удалённого экспортируется', mutation: { from: 'if (!marks || m.deletedAt || m.withheld) continue;', to: 'if (!marks) continue;' }, scene: deletedScene,
    label: 'R209 удалено: старая реакция не выходит, живая выходит', expected: ['conv:', 'msg:m1', 'msg:m2', 'react:m2', 'read:'], actual: ['conv:', 'msg:m1', 'react:m1', 'msg:m2', 'react:m2', 'read:'] },
  { title: 'личный закреп попадает в экспорт', mutation: {
    from: 'inArray(conversationPins.messageId, ids),\n        eq(conversationPins.forBoth, true),\n        inArray(conversationPins.userId, who),',
    to: 'inArray(conversationPins.messageId, ids),\n        inArray(conversationPins.userId, who),',
  }, scene: personalPinScene, label: 'R209 личный закреп: для себя не выходит, для всех выходит',
    expected: ['conv:', 'msg:m1', 'msg:m2', 'pin:m2', 'read:'], actual: ['conv:', 'msg:m1', 'pin:m1', 'msg:m2', 'pin:m2', 'read:'] },
];
for (const m of mutations) test(`R209 контрфакт: ${m.title} ломает адресное поведение`, async () => {
  await m.scene();
  await assert.rejects(() => m.scene(m.mutation), killed(m.label, m.expected, m.actual));
});
test('R209 контрфакт: без отката непоместившегося сообщения предел 60 оставляет лишние строки и неверный next', async () => {
  await largeScene(undefined, true);
  await assert.rejects(() => largeScene({ from: 'picked.length = start;', to: '/* откат потерян */' }, true),
    killed('R209 предел: непоместившееся сообщение полностью откачено', 59, 61));
});
