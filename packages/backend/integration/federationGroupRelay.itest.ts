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
import * as identityRules from '../src/federation/instanceIdentity.js';
import * as signing from '../src/federation/signingKeys.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = { file: string; from: string; to: string };
type Identity = { instanceId: string; rootPublicKeyDer: Buffer; key: signing.SigningKeyPair };
type Changes = typeof import('../src/federation/convChanges.js');
const cid = 'federated-group-relay';
let t: TestDb, host: Identity, authorHome: Identity, thirdHome: Identity;
function identity(): Identity {
  const root = crypto.generateKeyPairSync('ed25519');
  const publicKey = root.publicKey.export({ type: 'spki', format: 'der' });
  return { instanceId: identityRules.instanceIdFrom(publicKey), rootPublicKeyDer: publicKey,
    key: signing.issueSigningKey(root.privateKey.export({ type: 'pkcs8', format: 'der' }), Date.now()) };
}
before(async () => { host = identity(); authorHome = identity(); thirdHome = identity(); t = await createTestDb(); });
after(async () => { await t.close(); });
const fail = (name: string) => () => { throw new Error(`неописанная IO-граница ${name}`); };
const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function moduleOf<T>(name: string, deps: Record<string, unknown>, mutation?: Mutation): T {
  let raw = source(name);
  if (mutation?.file === name) { assert.equal(raw.split(mutation.from).length, 2, `единственный якорь ${name}`); raw = raw.replace(mutation.from, mutation.to); }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Date, Buffer, URL, Map, Set, Promise, Error,
    console: { warn() {}, log: fail('console.log'), error: fail('console.error') },
    setTimeout: fail('таймер'), setInterval: fail('worker'),
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `явный импорт ${name}:${id}`); return deps[id]; },
  });
  return module.exports as T;
}
// Якорь — целое SQL-выражение из AST, но исполняется всегда целый модуль. SQL тест не пересчитывает.
function sqlMutation(prefix: string, to: string): Mutation {
  const raw = source('federation/convChanges'), ast = ts.createSourceFile('convChanges.ts', raw, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function visit(n: ts.Node) {
    if (ts.isTaggedTemplateExpression(n) && n.getText(ast).startsWith(prefix)) found.push(n.getText(ast));
    ts.forEachChild(n, visit);
  }
  visit(ast); assert.equal(found.length, 1, 'единственное полное SQL-выражение для мутанта');
  return { file: 'federation/convChanges', from: found[0], to };
}
const killed = (message: string) => (error: unknown) => error instanceof assert.AssertionError && error.message.includes(message);
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function fixture(leaf = false, mutation?: Mutation) {
  await truncateAll(t.raw);
  const self = leaf ? thirdHome : host;
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'group_local', displayName: 'Местный', passwordHash: 'fixture' },
    { id: 'author', username: 'group_author', displayName: 'Автор', passwordHash: 'fixture', homeInstanceId: authorHome.instanceId, homeUserId: 'remote-author', homeUsername: 'remote_author' },
    { id: 'remote', username: 'group_remote', displayName: leaf ? 'Хост' : 'Третий дом', passwordHash: 'fixture',
      homeInstanceId: leaf ? host.instanceId : thirdHome.instanceId, homeUserId: leaf ? 'host-person' : 'remote-third', homeUsername: 'remote_person' },
  ]);
  await t.db.insert(schema.federationLinks).values([authorHome, leaf ? host : thirdHome].map((id, i) => ({
    instanceId: id.instanceId, domain: `group${i}.invalid`, apiBase: `https://group${i}.invalid/api`, clientOrigin: `https://group${i}.invalid`,
    rootKey: id.rootPublicKeyDer.toString('base64url'), state: 'active', features: [shared.FED_FEATURES.dm1, shared.FED_FEATURES.dmgroup1],
  })));
  await t.db.insert(schema.conversations).values({ id: cid, kind: 'group', title: 'Группа', groupVersion: 4, originInstanceId: leaf ? host.instanceId : null, createdBy: 'local' });
  await t.db.insert(schema.conversationMembers).values([
    { conversationId: cid, userId: 'local', role: 'owner' }, { conversationId: cid, userId: 'author' }, { conversationId: cid, userId: 'remote' },
  ]);
  const fed = { 'drizzle-orm': orm, '@gusvoice/shared': shared, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const changes = moduleOf<Changes>('federation/convChanges', fed, mutation);
  const c = moduleOf<typeof import('../src/conversations.js')>('conversations', {
    'drizzle-orm': orm, '@gusvoice/shared': shared, './db/index.js': { db: t.db }, './db/schema.js': schema, './convRules.js': rules,
    './dmWriteBarrier.js': { dmWriteBarrier: {} }, './env.js': { env: {} }, './util.js': { uuidv7: crypto.randomUUID },
    './attachments.js': { attachmentLink: fail('ссылка на файл'), attachmentStore: {}, copyForForward: fail('копирование файла'),
      DailyQuotaError: class extends Error {}, discardForwardCopies: fail('удаление копий'), privateAttachmentsReady: fail('готовность файлов'), purgeDeleted: fail('удаление файлов') },
    './serialize.js': { homeInstanceOf: fail('сводка дома'), serializeMessage: fail('DTO для клиента') },
  });
  c.configureFederatedConv({ selfInstanceId: () => self.instanceId, record: changes.recordFedConvChanges });
  const deliveries: unknown[] = [], fanout: unknown[] = [];
  const conv = { ...c, deliver: async (d: unknown) => { if (d) deliveries.push(d); } };
  const groupFor = (id: Identity) => moduleOf<typeof import('../src/federation/convGroup.js')>('federation/convGroup', {
    ...fed, 'node:crypto': crypto, '../conversations.js': conv, '../groupRules.js': groupRules, '../userSearchRules.js': userSearchRules,
    '../convGroups.js': { addGroupMembers: fail('add'), removeGroupMember: fail('remove'), updateGroupInfo: fail('title') },
    './directorySync.js': { refreshCapabilities: fail('визитка') }, './guestHost.js': { ensureShadowUser: fail('новая тень'), shadowUserFor: fail('поиск тени') },
    './instance.js': { federation: { identity: () => id, signingKey: () => id.key } }, './instanceIdentity.js': identityRules,
    './instanceMeta.js': { readInstanceMeta: fail('пауза') }, './linkRules.js': linkRules, './links.js': { getLink: fail('связка') },
    './peerClient.js': { postSignedToPeer: fail('сеть') }, './signingKeys.js': signing,
  });
  const group = groupFor(self), signer = groupFor(authorHome), thirdSigner = groupFor(thirdHome);
  changes.configureFedGroupSigner(group.signOwnMessage);
  const accept = moduleOf<typeof import('../src/federation/convAccept.js')>('federation/convAccept', {
    ...fed, '../conversations.js': conv, '../convRules.js': rules,
    '../convSendFanout.js': { fanOutSend: async (s: unknown) => { fanout.push(s); } },
    './convLink.js': { notePeerAnswer: fail('ответ соседа'), onLinkRestored: fail('восстановление') },
    './eventStream.js': { onFedEvent: fail('event worker'), sendEventTo: fail('doorbell') },
    './instance.js': { federation: { identity: () => self, signingKey: () => self.key } },
    './peerClient.js': { getSignedFromPeer: fail('забор по сети') },
  }, mutation);
  accept.configureFedGroupAccept({ applyConv: group.applyGroupConv, verify: group.verifyMessageSig });
  const record = (items: Parameters<Changes['recordFedConvChanges']>[1]) => t.db.transaction(tx => changes.recordFedConvChanges(tx as never, items));
  const rows = () => t.db.select().from(schema.fedConvChanges).orderBy(orm.asc(schema.fedConvChanges.instanceId), orm.asc(schema.fedConvChanges.seq));
  const message = async (id: string) => (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, id)))[0];
  return { self, changes, accept, group, signer, thirdSigner, record, rows, message, deliveries, fanout };
}
function wire(id = 'signed-copy', home = authorHome.instanceId, user = 'remote-author'): shared.FedConvMessageWire {
  return { id, conversationId: cid, author: { instanceId: home, userId: user }, clientId: null, payloadHash: null,
    createdAt: Date.now(), originSortKey: 10, content: 'Подписанное сообщение', replyToId: null, forwardedFrom: null,
    silent: false, noPreview: false, captionAbove: false, replyQuote: null, sticker: null, service: null,
    attachments: [], editVersion: 0, editedAt: null, deleted: false };
}
function signed(f: Awaited<ReturnType<typeof fixture>>, w: shared.FedConvMessageWire, third = false) {
  const sig = (third ? f.thirdSigner : f.signer).signOwnMessage(w); assert.ok(sig, 'настоящая подпись выпущенным сменным ключом');
  const entity = { ...shared.serializeConvMessageWire(w), sig };
  assert.equal(f.group.verifyMessageSig(w, entity), true, 'фикстура имеет настоящую цепочку корень → сменный ключ → сообщение');
  return entity;
}
const entry = (id: string | null, kind: Parameters<Changes['recordFedConvChanges']>[1][number]['kind'] = shared.FED_CONV_CHANGE.msg) => ({ conversationId: cid, kind, entityId: id });

async function hostJournal(mutation?: Mutation) {
  const f = await fixture(false, mutation);
  const foreign = { ...wire('foreign'), content: 'Копия' }, foreignEntity = signed(f, foreign);
  await t.db.insert(schema.conversationMessages).values([
    { id: 'foreign', conversationId: cid, authorId: 'author', sortKey: 1, originSortKey: foreign.originSortKey,
      createdAt: new Date(foreign.createdAt), content: foreign.content, originSig: foreignEntity.sig },
    { id: 'own', conversationId: cid, authorId: 'local', sortKey: 2, content: 'Хост' },
    { id: 'service', conversationId: cid, authorId: 'author', sortKey: 3, content: 'Вышел', service: { kind: 'group', type: 'leave' } },
  ]);
  await f.record([entry(null, 'conv'), entry('foreign'), entry('own'), entry('service'), entry(null, 'read')]);
  const rows = await f.rows(), ids = (home: string) => rows.filter(r => r.instanceId === home).map(r => r.entityId ?? r.kind).sort();
  assert.deepEqual(ids(authorHome.instanceId), ['conv', 'own', 'service'], 'хост не возвращает обычную копию дому автора');
  assert.deepEqual(ids(thirdHome.instanceId), ['conv', 'foreign', 'own', 'service']);
  const out = await f.changes.changesForPeer(thirdHome.instanceId, 0, 100, f.self.instanceId); assert.ok('items' in out);
  const group = out.items.find(i => i.kind === 'conv')?.entity; assert.ok(group);
  const x = shared.parseConvGroupExtras(group); assert.ok(x); assert.equal(x.version, 4); assert.equal(x.owner?.userId, 'local');
  assert.equal(x.profiles.length, 3); assert.equal(group.kind, 'group');
  const copy = out.items.find(i => i.entityId === 'foreign')?.entity; assert.ok(copy);
  const parsed = shared.parseConvMessageWire(copy); assert.ok(parsed);
  assert.equal(f.group.verifyMessageSig(parsed, copy), true, 'журнал сохраняет настоящую подпись чужого автора');
}
test('R203 хост отдаёт чужое третьему дому, не автору; своё, служебную и состав — обоим', async () => { await hostJournal(); });

test('R203 дом участника пишет только хосту своё сообщение, без conv и копий чужих', async () => {
  const f = await fixture(true);
  const foreign = { ...wire('foreign'), content: 'Чужое' }, foreignEntity = signed(f, foreign);
  await t.db.insert(schema.conversationMessages).values([
    { id: 'own', conversationId: cid, authorId: 'local', sortKey: 1, content: 'Наше' },
    { id: 'foreign', conversationId: cid, authorId: 'author', sortKey: 2, originSortKey: foreign.originSortKey,
      createdAt: new Date(foreign.createdAt), content: foreign.content, originSig: foreignEntity.sig },
    { id: 'host-service', conversationId: cid, authorId: 'remote', sortKey: 3, content: 'Служебная хоста', service: { kind: 'group', type: 'leave' } },
  ]);
  await f.record([entry(null, 'conv'), entry('own'), entry('foreign'), entry('host-service'), entry(null, 'read')]);
  const rows = await f.rows(); assert.deepEqual(rows.map(r => `${r.instanceId}:${r.entityId}`), [`${host.instanceId}:own`]);
});

async function leavingJournal(mutation?: Mutation) {
  const f = await fixture(false, mutation), leaving = identity(), old = identity();
  await t.db.insert(schema.federationLinks).values([leaving, old].map((id, i) => ({
    instanceId: id.instanceId, domain: `leaving${i}.invalid`, apiBase: `https://leaving${i}.invalid/api`, clientOrigin: `https://leaving${i}.invalid`,
    rootKey: id.rootPublicKeyDer.toString('base64url'), state: 'active', features: [shared.FED_FEATURES.dm1, shared.FED_FEATURES.dmgroup1],
  })));
  await t.db.insert(schema.users).values([
    { id: 'leaving', username: 'group_leaving', displayName: 'Уходит', passwordHash: 'fixture', homeInstanceId: leaving.instanceId, homeUserId: 'leaving' },
    { id: 'old', username: 'group_old', displayName: 'Ушёл', passwordHash: 'fixture', homeInstanceId: old.instanceId, homeUserId: 'old' },
  ]);
  await t.db.insert(schema.conversationMembers).values([{ conversationId: cid, userId: 'leaving' }, { conversationId: cid, userId: 'old', leftAt: new Date(0) }]);
  await t.db.transaction(async tx => {
    await tx.update(schema.conversationMembers).set({ leftAt: orm.sql`now()` }).where(orm.eq(schema.conversationMembers.userId, 'leaving'));
    await f.changes.recordFedConvChanges(tx as never, [entry(null, 'conv')]);
  });
  const rows = await f.rows();
  assert.equal(rows.some(r => r.instanceId === leaving.instanceId), true, 'ушедший этой транзакцией получает строку своего ухода');
  assert.equal(rows.some(r => r.instanceId === old.instanceId), false);
  assert.equal(rows.some(r => r.instanceId === authorHome.instanceId), true);
}
test('R203 ушедший в текущей SQL-транзакции получает состав, ушедший раньше — нет', async () => { await leavingJournal(); });

async function departedFeed(mutation?: Mutation) {
  const f = await fixture(false, mutation), at = new Date('2026-10-12T12:00:00.000Z');
  await t.db.update(schema.conversationMembers).set({ leftAt: at }).where(orm.eq(schema.conversationMembers.userId, 'author'));
  await t.db.insert(schema.conversationMessages).values(['before', 'equal', 'after'].map((id, i) => ({ id, conversationId: cid, authorId: 'local', sortKey: i + 1, content: id })));
  await t.db.insert(schema.fedConvSync).values({ instanceId: authorHome.instanceId, seq: 3 });
  await t.db.insert(schema.fedConvChanges).values(['before', 'equal', 'after'].map((id, i) => ({ instanceId: authorHome.instanceId, seq: i + 1, conversationId: cid, kind: 'msg', entityId: id, at: new Date(at.getTime() + i - 1) })));
  const out = await f.changes.changesForPeer(authorHome.instanceId, 0, 100, f.self.instanceId); assert.ok('items' in out);
  assert.deepEqual(normal(out.items.map(i => i.entityId)), ['before', 'equal'], 'после ухода всех людей соседа новые строки не отдаются');
  await t.db.update(schema.conversationMembers).set({ leftAt: null }).where(orm.eq(schema.conversationMembers.userId, 'author'));
  const live = await f.changes.changesForPeer(authorHome.instanceId, 0, 100, f.self.instanceId); assert.ok('items' in live);
  assert.deepEqual(normal(live.items.map(i => i.entityId)), ['before', 'equal', 'after']);
}
test('R203 журнал отдаёт строки до ухода и ровно в уход, после — лишь действующему участнику', async () => { await departedFeed(); });

async function hostFeed(mutation?: Mutation) {
  const f = await fixture(true, mutation);
  await t.db.delete(schema.conversationMembers).where(orm.eq(schema.conversationMembers.userId, 'remote'));
  await t.db.insert(schema.conversationMessages).values({ id: 'to-host', conversationId: cid, authorId: 'local', sortKey: 1, content: 'Хосту' });
  await f.record([entry('to-host')]);
  const out = await f.changes.changesForPeer(host.instanceId, 0, 100, f.self.instanceId); assert.ok('items' in out);
  assert.deepEqual(normal(out.items.map(i => i.entityId)), ['to-host'], 'origin-хост получает группу и без своих людей');
  const entity = out.items[0].entity; assert.ok(entity); const w = shared.parseConvMessageWire(entity); assert.ok(w);
  assert.equal(f.group.verifyMessageSig(w, entity), true, 'материализация подписывает наше групповое сообщение');
  await t.db.update(schema.conversations).set({ originInstanceId: null });
  const alien = await f.changes.changesForPeer(host.instanceId, 0, 100, f.self.instanceId); assert.ok('items' in alien); assert.equal(alien.items.length, 0);
}
test('R203 origin-хост получает подписанное сообщение даже без своих людей, посторонний дом — нет', async () => { await hostFeed(); });

test('R203 третий автор принимается с настоящей подписью только через хоста группы', async () => {
  const f = await fixture(true), w = wire(), entity = signed(f, w);
  await f.accept.applyChange(authorHome.instanceId, f.self.instanceId, 'msg', cid, entity); assert.equal(await f.message(w.id), undefined);
  await f.accept.applyChange(host.instanceId, f.self.instanceId, 'msg', cid, shared.serializeConvMessageWire(w)); assert.equal(await f.message(w.id), undefined);
  await f.accept.applyChange(host.instanceId, f.self.instanceId, 'msg', cid, { ...entity, content: 'Подмена хостом' }); assert.equal(await f.message(w.id), undefined);
  await f.accept.applyChange(host.instanceId, f.self.instanceId, 'msg', cid, entity);
  assert.equal((await f.message(w.id))?.content, w.content); assert.deepEqual((await f.message(w.id))?.originSig, entity.sig);
  assert.equal((await f.rows()).length, 0, 'дом участника не пересылает копию дальше');
});

test('R203 хост отвергает обычное без подписи и третьего автора напрямую, своего соседа с подписью принимает', async () => {
  const f = await fixture(), w = wire();
  await f.accept.applyChange(authorHome.instanceId, f.self.instanceId, 'msg', cid, shared.serializeConvMessageWire(w)); assert.equal(await f.message(w.id), undefined);
  const third = wire('third-direct', thirdHome.instanceId, 'remote-third');
  await f.accept.applyChange(authorHome.instanceId, f.self.instanceId, 'msg', cid, signed(f, third, true)); assert.equal(await f.message(third.id), undefined);
  await f.accept.applyChange(authorHome.instanceId, f.self.instanceId, 'msg', cid, signed(f, w)); assert.equal((await f.message(w.id))?.authorId, 'author');
});

async function relay(mutation?: Mutation) {
  const f = await fixture(false, mutation), w = wire(), entity = signed(f, w);
  await f.accept.applyChange(authorHome.instanceId, f.self.instanceId, 'msg', cid, entity);
  const rows = await f.rows();
  assert.equal(rows.some(r => r.instanceId === thirdHome.instanceId && r.entityId === w.id), true, 'хост записывает принятую копию в журнал третьему дому');
  assert.equal(rows.some(r => r.instanceId === authorHome.instanceId), false);
  const edited = { ...w, content: 'Правка автора', editVersion: 1, editedAt: Date.now() };
  await f.accept.applyChange(authorHome.instanceId, f.self.instanceId, 'msg', cid, signed(f, edited));
  const out = await f.changes.changesForPeer(thirdHome.instanceId, 0, 100, f.self.instanceId); assert.ok('items' in out);
  const copy = out.items.find(i => i.entityId === w.id)?.entity; assert.ok(copy); const parsed = shared.parseConvMessageWire(copy); assert.ok(parsed);
  assert.equal(parsed.content, edited.content); assert.equal(f.group.verifyMessageSig(parsed, copy), true, 'при пересылке сохранена подпись дома автора на правке');
  await f.accept.applyChange(authorHome.instanceId, f.self.instanceId, 'msg', cid, shared.serializeConvMessageWire({ ...edited, deleted: true }));
  assert.ok((await f.message(w.id))?.deletedAt);
  const gone = await f.rows(); assert.equal(gone.some(r => r.instanceId === authorHome.instanceId && r.entityId === w.id), true, 'надгробие возвращается и дому автора');
}
test('R203 хост пересылает создание и подписанную правку третьему дому, надгробие без подписи — обоим', async () => { await relay(); });

test('R203 надгробие и служебная от хоста не требуют подписи; ours создаётся лишь как служебная', async () => {
  const f = await fixture(true), w = wire();
  await f.accept.applyChange(host.instanceId, f.self.instanceId, 'msg', cid, signed(f, w));
  await f.accept.applyChange(host.instanceId, f.self.instanceId, 'msg', cid, shared.serializeConvMessageWire({ ...w, deleted: true }));
  assert.ok((await f.message(w.id))?.deletedAt);
  const service = { ...wire('unsigned-service'), content: '', service: { kind: 'group', type: 'leave' } };
  await f.accept.applyChange(host.instanceId, f.self.instanceId, 'msg', cid, shared.serializeConvMessageWire(service));
  assert.equal((await f.message(service.id))?.service?.kind, 'group');
  const own = wire('ours-normal', f.self.instanceId, 'local');
  await f.accept.applyChange(host.instanceId, f.self.instanceId, 'msg', cid, shared.serializeConvMessageWire(own)); assert.equal(await f.message(own.id), undefined);
  const ownService = { ...own, id: 'ours-service', content: '', service: { kind: 'group', type: 'leave' } };
  await f.accept.applyChange(host.instanceId, f.self.instanceId, 'msg', cid, shared.serializeConvMessageWire(ownService));
  assert.equal((await f.message(ownService.id))?.authorId, 'local'); assert.equal((await f.message(ownService.id))?.service?.kind, 'group');
});

for (const [name, mutation, scenario, failure] of [
  ['эхо дому автора', () => ({ file: 'federation/convChanges', from: 'foreignHome.get(i.entityId) !== home || serviceIds.has(i.entityId)', to: 'true' }), hostJournal, 'хост не возвращает обычную копию дому автора'],
  ['потеря текущего ухода', () => ({ file: 'federation/convChanges', from: '${conversationMembers.leftAt} >= now()', to: '${conversationMembers.leftAt} IS NULL' }), leavingJournal, 'ушедший этой транзакцией получает строку своего ухода'],
  ['снятый left guard', () => sqlMutation('sql`(NOT EXISTS (SELECT 1 FROM conversation_members cl', 'sql`true`'), departedFeed, 'после ухода всех людей соседа новые строки не отдаются'],
  ['потеря origin-хоста', () => sqlMutation('sql`EXISTS (SELECT 1 FROM conversations c WHERE c.id = ${fedConvChanges.conversationId}', 'sql`false`'), hostFeed, 'origin-хост получает группу и без своих людей'],
  ['fed:false при пересылке', () => ({ file: 'federation/convAccept', from: 'const relay = c.group?.host === true;', to: 'const relay = false;' }), relay, 'хост записывает принятую копию в журнал третьему дому'],
] as const) test(`R203 мутант «${name}» пойман адресной проверкой группового журнала`, async () => {
  await scenario(); await assert.rejects(scenario(mutation()), killed(failure));
});
