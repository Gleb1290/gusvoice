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
import { createFederation } from '../src/federation/state.js';
import { issueSigningKey } from '../src/federation/signingKeys.js';
import { fingerprintFrom, instanceIdFrom } from '../src/federation/instanceIdentity.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Name = 'C' | 'D' | 'E';
type Changes = typeof import('../src/federation/convChanges.js');
type Accept = typeof import('../src/federation/convAccept.js');
type Conversations = typeof import('../src/conversations.js');
type Mutation = { file: string; from: string; to: string; at: Name };
type Inst = { name: Name; t: TestDb; changes: Changes; accept: Accept; conversations: Conversations;
  cursor: Map<Name, number>; deliveries: unknown[]; record(items: readonly import('../src/federation/convChanges.js').FedConvChangeInput[]): Promise<void> };
type World = Record<Name, Inst>;
const names: Name[] = ['C', 'D', 'E'];
const cid = 'r208-group-marks';
const homes = { C: 'group-marks-c', D: 'group-marks-d', E: 'group-marks-e' } as const;
const people = { C: 'c1', D: 'd1', E: 'e1' } as const;
const uid = (at: Name, who: Name) => at === who ? people[who] : `${at.toLowerCase()}:${people[who]}`;
const features = [shared.FED_FEATURES.dm1, shared.FED_FEATURES.dmgroup1, shared.FED_FEATURES.dm2once, shared.FED_FEATURES.dmgroupmarks1];
const oldFeatures = features.filter(x => x !== shared.FED_FEATURES.dmgroupmarks1);
const voice: shared.Attachment = { id: 'r208-voice', name: 'voice.ogg', contentType: 'audio/ogg', size: 10,
  url: '/not-downloaded', durationMs: 1000, waveform: [50] };
const dbs = {} as Record<Name, TestDb>;
const fail = (name: string) => () => { throw new Error(`неописанная IO-граница: ${name}`); };
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const source = (file: string) => readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Целые модули работают с тремя настоящими PostgreSQL-базами; подменены лишь сеть и доставка клиентам.
function moduleOf<T>(file: string, deps: Record<string, unknown>, mutation?: Mutation): T {
  let raw = source(file);
  if (mutation?.file === file) {
    assert.equal(raw.split(mutation.from).length, 2, `единственный якорь мутанта ${file}`);
    raw = raw.replace(mutation.from, mutation.to);
  }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Date, Buffer, URL, Map, Set, Promise, Error,
    console: { warn() {}, log: fail('console.log'), error: fail('console.error') },
    setTimeout: fail('таймер'), setInterval: fail('фоновый worker'),
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `описанный импорт ${file}:${id}`); return deps[id]; },
  });
  return module.exports as T;
}

// Повторяющиеся объявления (например fromHost) привязываем к полной функции из AST, а не к номеру строки.
function mutationIn(file: string, fn: string, from: string, to: string, at: Name): Mutation {
  const raw = source(file), ast = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
  const found = ast.statements.filter((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === fn);
  assert.equal(found.length, 1, `единственная функция ${fn} для контрфакта`);
  const body = found[0].getText(ast);
  assert.equal(body.split(from).length, 2, `единственный смысловой якорь ${fn}`);
  return { file, from: body, to: body.replace(from, to), at };
}

function targeted(message: string, actual: unknown, expected: unknown) {
  return (error: unknown) => {
    if (!(error instanceof assert.AssertionError) || error.code !== 'ERR_ASSERTION' || !error.message.startsWith(message)) return false;
    // Node дописывает диагностический diff к message; actual/expected должны совпасть с конкретным доменным отказом.
    assert.deepEqual(normal(error.actual), normal(actual), 'мутант упал на ожидаемом фактическом результате');
    assert.deepEqual(normal(error.expected), normal(expected), 'мутант упал на ожидаемом контракте');
    return true;
  };
}

before(async () => { for (const n of names) dbs[n] = await createTestDb(); });
after(async () => {
  // harness импортирует db/index ради миграций: закрываем и три WASM-базы, и неиспользуемый PgPool этого процесса.
  // allSettled гарантирует попытку закрыть каждую базу, даже если закрытие одной завершилось ошибкой.
  const closed = await Promise.allSettled(names.filter(n => dbs[n]).map(n => dbs[n].close()));
  const { pool } = await import('../src/db/index.js');
  await pool.end();
  for (const result of closed) assert.equal(result.status, 'fulfilled', 'все три базы закрываются без ошибки');
});

async function fixture(mutation?: Mutation, noHostPeople = false): Promise<World> {
  const world = {} as World;
  for (const name of names) {
    const t = dbs[name]; await truncateAll(t.raw);
    await t.db.insert(schema.users).values(names.map(who => who === name
      ? { id: people[who], username: `local_${who}`, displayName: who, passwordHash: 'integration-only' }
      : { id: uid(name, who), username: `shadow_${name}_${who}`, displayName: who, passwordHash: 'integration-only',
        homeInstanceId: homes[who], homeUserId: people[who], homeUsername: `home_${who}` }));
    const peers: Name[] = name === 'D' ? ['C', 'E'] : ['D'];
    await t.db.insert(schema.federationLinks).values(peers.map(who => ({ instanceId: homes[who], domain: `${who.toLowerCase()}.invalid`,
      apiBase: `https://${who.toLowerCase()}.invalid/api`, clientOrigin: `https://${who.toLowerCase()}.invalid`,
      rootKey: 'not-used-for-mark-rows', state: 'active' as const, features })));
    await t.db.insert(schema.conversations).values({ id: cid, kind: 'group', title: 'C — хост D — E', groupVersion: 2,
      originInstanceId: name === 'D' ? null : homes.D, createdBy: uid(name, 'D') });
    await t.db.insert(schema.conversationMembers).values(names.filter(who => !noHostPeople || who !== 'D')
      .map(who => ({ conversationId: cid, userId: uid(name, who), role: who === 'D' ? 'owner' as const : 'member' as const })));
    await t.db.insert(schema.conversationMessages).values([
      { id: 'm1', conversationId: cid, authorId: uid(name, 'C'), sortKey: 1, content: 'Текст C' },
      { id: 'm2', conversationId: cid, authorId: uid(name, 'D'), sortKey: 2, content: 'Текст D' },
      { id: 'v1', conversationId: cid, authorId: uid(name, 'C'), sortKey: 3, content: '', attachments: [voice] },
      { id: 'm4', conversationId: cid, authorId: uid(name, 'D'), sortKey: 4, content: 'Снова D' },
      { id: 'm5', conversationId: cid, authorId: uid(name, 'E'), sortKey: 5, content: 'Последнее своё E' },
    ]);
    const fed = { 'drizzle-orm': orm, '@gusvoice/shared': shared, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
    const mutate = mutation?.at === name ? mutation : undefined;
    const changes = moduleOf<Changes>('federation/convChanges', fed, mutate);
    const conversations = moduleOf<Conversations>('conversations', {
      'drizzle-orm': orm, '@gusvoice/shared': shared, './db/index.js': { db: t.db }, './db/schema.js': schema, './convRules.js': rules,
      './dmWriteBarrier.js': { dmWriteBarrier: {} }, './env.js': { env: {} }, './util.js': { uuidv7: crypto.randomUUID },
      './attachments.js': { attachmentLink: fail('ссылка файла'), attachmentStore: {}, copyForForward: fail('копирование файла'),
        DailyQuotaError: class extends Error {}, discardForwardCopies: fail('удаление копий'), privateAttachmentsReady: fail('готовность файла'),
        purgeDeleted: fail('удаление объекта') },
      './serialize.js': { homeInstanceOf: fail('DTO дома'), serializeMessage: fail('DTO клиенту') },
    }, mutate);
    conversations.configureFederatedConv({ selfInstanceId: () => homes[name], record: changes.recordFedConvChanges });
    const deliveries: unknown[] = [];
    const accept = moduleOf<Accept>('federation/convAccept', {
      ...fed, '../conversations.js': { ...conversations, deliver: async (delivery: unknown) => { if (delivery) deliveries.push(delivery); } },
      '../convRules.js': rules, '../convSendFanout.js': { fanOutSend: fail('новое сообщение') },
      './convLink.js': { notePeerAnswer: fail('ответ сети'), onLinkRestored: fail('восстановление сети') },
      './eventStream.js': { onFedEvent: fail('подписка worker'), sendEventTo: fail('звонок в дверь') },
      './instance.js': { federation: { identity: () => ({ instanceId: homes[name] }), signingKey: fail('подпись сообщения') } },
      './peerClient.js': { getSignedFromPeer: fail('забор сети') },
    }, mutate);
    accept.configureFedGroupAccept({ applyConv: fail('смена состава'), verify: fail('проверка сообщения') });
    world[name] = { name, t, changes, accept, conversations, deliveries, cursor: new Map(),
      record: items => t.db.transaction(tx => changes.recordFedConvChanges(tx as never, items)) };
  }
  return world;
}
const entry = (kind: 'react' | 'read' | 'pin' | 'listen', entityId: string | null = kind === 'read' ? null : 'm1') => ({ conversationId: cid, kind, entityId });
async function page(from: Inst, to: Name, since = 0) {
  const result = await from.changes.changesForPeer(homes[to], since, 100, homes[from.name]);
  assert.ok('items' in result, 'настоящий журнал доступен соседу без reset');
  return result;
}
async function pull(from: Inst, to: Inst) {
  const result = await page(from, to.name, from.cursor.get(to.name) ?? 0);
  for (const item of result.items) await to.accept.applyChange(homes[from.name], homes[to.name], item.kind, item.conversationId,
    item.entity as Record<string, unknown> | null);
  from.cursor.set(to.name, result.seq);
  return result;
}
async function journal(from: Inst, to: Name) {
  return (await from.t.db.select().from(schema.fedConvChanges).where(orm.eq(schema.fedConvChanges.instanceId, homes[to]))
    .orderBy(orm.asc(schema.fedConvChanges.seq))).map(row => `${row.kind}:${row.entityId ?? ''}`);
}
async function reactions(at: Inst, messageId = 'm1') {
  return (await at.t.db.select().from(schema.conversationMessageReactions).where(orm.eq(schema.conversationMessageReactions.messageId, messageId)))
    .map(row => `${row.userId}:${row.emoji}`).sort();
}
async function addReaction(at: Inst, who: Name, emoji: string, messageId = 'm1') {
  await at.t.db.insert(schema.conversationMessageReactions).values({ messageId, userId: uid(at.name, who), emoji });
}
async function readKey(at: Inst, who: Name) {
  const [row] = await at.t.db.select().from(schema.conversationMembers).where(orm.eq(schema.conversationMembers.userId, uid(at.name, who)));
  return Number(row?.lastReadKey);
}
async function setRead(at: Inst, who: Name, key: number) {
  await at.t.db.update(schema.conversationMembers).set({ lastReadKey: key }).where(orm.eq(schema.conversationMembers.userId, uid(at.name, who)));
}
async function pins(at: Inst) {
  return (await at.t.db.select().from(schema.conversationPins)).map(row => `${row.userId}:${row.pinnedBy}:${row.forBoth}`).sort();
}
async function addPins(at: Inst, forBoth = true) {
  const members = await at.t.db.select({ userId: schema.conversationMembers.userId }).from(schema.conversationMembers);
  await at.t.db.insert(schema.conversationPins).values(members.map(({ userId }) => ({ conversationId: cid, userId,
    messageId: 'm1', pinnedBy: people[at.name], forBoth })));
}
async function listeners(at: Inst) {
  return (await at.t.db.select().from(schema.conversationVoiceListens)).map(row => row.userId).sort();
}
async function setLinkFeatures(at: Inst, peer: Name, values: string[]) {
  await at.t.db.update(schema.federationLinks).set({ features: values }).where(orm.eq(schema.federationLinks.instanceId, homes[peer]));
}

test('R208 четыре вида групповых отметок отделены от сообщений и состава', async () => {
  const { C } = await fixture();
  assert.deepEqual([...C.changes.GROUP_MARK_KINDS].sort(), ['listen', 'pin', 'react', 'read'], 'ровно четыре отметки в контракте группы');
  assert.equal(C.changes.GROUP_MARK_KINDS.has('msg'), false, 'сообщение не становится отметкой');
  assert.equal(C.changes.GROUP_MARK_KINDS.has('conv'), false, 'состав не становится отметкой');
});

async function reactionRelay(mutation?: Mutation) {
  const { C, D, E } = await fixture(mutation);
  await addReaction(C, 'C', '👍'); await C.record([entry('react')]);
  assert.deepEqual(await journal(C, 'D'), ['react:m1'], 'дом участника пишет реакцию хосту');
  await pull(C, D);
  assert.deepEqual(await reactions(D), ['d:c1:👍'], 'хост принимает домашнюю личность автора реакции');
  assert.deepEqual(await journal(D, 'C'), [], 'хост не возвращает реакцию дому её автора');
  await pull(D, E);
  assert.deepEqual(await reactions(E), ['e:c1:👍'], 'реакция C проходит через хоста D в дом E');
  await C.t.db.delete(schema.conversationMessageReactions); await C.record([entry('react')]);
  await pull(C, D); await pull(D, E);
  assert.deepEqual(await reactions(D), [], 'снятие реакции доходит до хоста');
  assert.deepEqual(await reactions(E), [], 'снятие реакции C доходит через хоста до E');
  assert.deepEqual(await reactions(C), [], 'своё снятие не воскресает от хоста');
  assert.deepEqual(await journal(D, 'C'), [], 'дом автора не получает эхо ни добавления, ни снятия');
}
test('R208 реакция C → хост D → E добавляется и снимается без эха автору', async () => { await reactionRelay(); });

test('R208 реакция местного человека хоста приходит в оба дома и не стирает их собственные реакции', async () => {
  const { C, D, E } = await fixture();
  await addReaction(C, 'C', '❤'); await addReaction(E, 'E', '👍'); await addReaction(D, 'D', '🔥');
  await D.record([entry('react')]); await pull(D, C); await pull(D, E);
  assert.deepEqual(await reactions(C), ['c1:❤', 'c:d1:🔥'], 'хост не владеет местной реакцией C');
  assert.deepEqual(await reactions(E), ['e1:👍', 'e:d1:🔥'], 'хост не владеет местной реакцией E');
  assert.deepEqual(await journal(D, 'C'), ['react:m1'], 'свою реакцию хост пишет C');
  assert.deepEqual(await journal(D, 'E'), ['react:m1'], 'свою реакцию хост пишет E');
});

async function readsRelay(mutation?: Mutation) {
  const { C, D, E } = await fixture(mutation);
  const before = await C.conversations.peerReadKeys('c1', [cid], C.t.db as never);
  assert.equal(before.get(cid), 0, 'до чтения E сообщение C ещё не прочитано');
  await setRead(E, 'E', 5); await E.record([entry('read')]);
  const outgoing = await page(E, 'D');
  const sent = shared.parseConvReadsWire(outgoing.items[0]?.entity); assert.ok(sent, 'провод прочитано разбирается настоящим парсером');
  // m5 принадлежит самому E; последняя чужая — m4 от D, а не предыдущее сообщение C или собственная m5.
  assert.deepEqual(sent.reads.map(r => `${r.user.instanceId}:${r.user.userId}:${r.messageId}`), [`${homes.E}:e1:m4`],
    'дом E отдаёт последнее прочитанное сообщение любого чужого автора');
  await pull(E, D);
  assert.equal(await readKey(D, 'E'), 4, 'хост переводит домашний id сообщения в свой порядок');
  assert.deepEqual(await journal(D, 'C'), ['read:'], 'хост пересылает прочитано E дому C');
  assert.deepEqual(await journal(D, 'E'), [], 'прочитано E не возвращается E');
  const towardC = await page(D, 'C');
  const relayed = shared.parseConvReadsWire(towardC.items[0]?.entity); assert.ok(relayed, 'пересланное прочитано имеет корректный провод');
  assert.deepEqual(relayed.reads.map(r => `${r.user.instanceId}:${r.user.userId}:${r.messageId}`), [`${homes.E}:e1:v1`],
    'хост отдаёт C последнее прочитанное сообщение именно автора C');
  await pull(D, C);
  assert.equal(await readKey(C, 'E'), 3, 'прочитано E доходит до местного ключа голосового C');
  const after = await C.conversations.peerReadKeys('c1', [cid], C.t.db as never);
  assert.equal(after.get(cid), 3, 'настоящий peerReadKeys автора C двигается до голосового');
  // Опоздавшая строка не может откатить отметку; ровно повторившийся ключ тоже не создаёт журнал.
  const seq = (await journal(D, 'C')).length;
  for (const messageId of ['m1', 'm4']) await D.accept.applyChange(homes.E, homes.D, 'read', cid,
    shared.serializeConvReadsWire({ reads: [{ user: { instanceId: homes.E, userId: 'e1' }, messageId }] }));
  assert.equal(await readKey(D, 'E'), 4, 'старый и равный ключ прочитано не откатывают хост');
  assert.equal((await journal(D, 'C')).length, seq, 'старый и равный ключ не создают лишнюю пересылку');
}
test('R208 прочитано E доходит до peerReadKeys C с переводом между авторами и без отката ключа', async () => { await readsRelay(); });

async function pinRelay(mutation?: Mutation, noHostPeople = false) {
  const { C, D, E } = await fixture(mutation, noHostPeople);
  await addPins(E); await E.record([entry('pin')]); await pull(E, D); await pull(D, C);
  const wanted = (noHostPeople ? ['c1', 'c:e1'] : ['c1', 'c:d1', 'c:e1']).map(id => `${id}:c:e1:true`).sort();
  assert.deepEqual(await pins(C), wanted, 'закреп E у C для всех и подписан тенью E, не хоста');
  assert.deepEqual(await journal(D, 'E'), [], 'закреп E не возвращается дому E');
  await E.t.db.delete(schema.conversationPins); await E.record([entry('pin')]); await pull(E, D); await pull(D, C);
  assert.deepEqual(await pins(D), [], 'открепление E снимает закреп хоста');
  assert.deepEqual(await pins(C), [], 'открепление E снимает закреп у C');
}
test('R208 закреп E для всех у C хранит pinnedBy тени E; открепление снимает его', async () => { await pinRelay(); });
test('R208 закреп и открепление работают, даже если ни одного человека хоста в группе нет', async () => { await pinRelay(undefined, true); });

test('R208 закреп только себе не поднимается до закрепа для всех через хоста', async () => {
  const { C, D, E } = await fixture();
  await E.t.db.insert(schema.conversationPins).values({ conversationId: cid, userId: 'e1', messageId: 'm1', pinnedBy: 'e1', forBoth: false });
  await E.record([entry('pin')]); const out = await page(E, 'D');
  const pin = shared.parseConvPinWire(out.items[0]?.entity); assert.ok(pin, 'отказ от общего закрепа имеет корректный провод');
  assert.equal(pin.pinned, false, 'личный закреп не объявляется общим'); await pull(E, D); await pull(D, C);
  assert.deepEqual(await pins(D), [], 'личный закреп не создаётся на хосте');
  assert.deepEqual(await pins(C), [], 'личный закреп не показывается C');
});

async function listenRelay(mutation?: Mutation) {
  const { C, D, E } = await fixture(mutation);
  assert.equal(C.conversations.voiceListenedFor('c1', 'c1', new Set()), false, 'автор до прослушивания не видит отметку');
  await E.t.db.insert(schema.conversationVoiceListens).values({ messageId: 'v1', userId: 'e1' });
  await E.record([entry('listen', 'v1')]); await pull(E, D);
  assert.deepEqual(await listeners(D), ['d:e1'], 'хост сохраняет слушателя E на копии голосового C');
  assert.deepEqual(await journal(D, 'E'), [], 'прослушано не возвращается дому слушателя E');
  assert.deepEqual(await journal(D, 'C'), ['listen:v1'], 'хост пересылает прослушано только дому автора C');
  assert.equal(D.deliveries.length, 0, 'на копии хоста нет клиентского события о прослушивании чужого автора');
  const outgoing = await page(D, 'C'), listened = shared.parseConvListenWire(outgoing.items[0]?.entity);
  assert.ok(listened, 'пересланное прослушано имеет корректный провод');
  // spent=false намеренно не сериализуется: на проводе/после parse поле существует лишь при true.
  assert.equal(Object.hasOwn(listened, 'spent'), false, 'в группе прослушано не тратит сообщение один раз');
  await pull(D, C);
  const atC = await listeners(C);
  assert.deepEqual(atC, ['c:e1'], 'дом автора C получает тень слушателя E');
  assert.equal(C.conversations.voiceListenedFor('c1', 'c1', new Set(atC)), true, 'настоящий voiceListenedFor зажигает отметку автору C');
  assert.deepEqual(await journal(C, 'D'), [], 'дом автора не пересылает принятое прослушано обратно хосту');
  await E.t.db.delete(schema.conversationVoiceListens); await E.record([entry('listen', 'v1')]);
  await pull(E, D); await pull(D, C);
  assert.deepEqual(await listeners(C), [], 'замена списка прослушано убирает прежнего слушателя E');
  assert.equal(C.conversations.voiceListenedFor('c1', 'c1', new Set(await listeners(C))), false, 'без слушателей отметка автора гаснет');
}
test('R208 прослушано E горит у автора голосового C, не эхо E и не событие для хоста', async () => { await listenRelay(); });

async function hostedReferences(mutation?: Mutation) {
  const { C } = await fixture(mutation);
  await C.t.db.insert(schema.users).values({ id: 'c:former-e', username: 'former_e', displayName: 'Бывший E', passwordHash: 'integration-only',
    homeInstanceId: homes.E, homeUserId: 'former-e' });
  await C.t.db.insert(schema.conversationMembers).values({ conversationId: cid, userId: 'c:former-e', leftAt: new Date(0) });
  await addReaction(C, 'C', '❤');
  const refs = [
    { user: { instanceId: homes.C, userId: 'c1' }, emoji: '👀' },
    { user: { instanceId: homes.E, userId: 'e1' }, emoji: '👍' },
    { user: { instanceId: homes.E, userId: 'former-e' }, emoji: '👻' },
    { user: { instanceId: homes.E, userId: 'unknown-e' }, emoji: '❓' },
    { user: { instanceId: homes.D, userId: 'd1' }, emoji: '🔥' },
  ];
  await C.accept.applyChange(homes.D, homes.C, 'react', cid, shared.serializeConvReactionsWire({ messageId: 'm1', reactions: refs }));
  assert.deepEqual(await reactions(C), ['c1:❤', 'c:d1:🔥', 'c:e1:👍'], 'хост меняет только действующих чужих, не своих и не бывших');
  const originalSelf = (await C.t.db.select().from(schema.conversationMessageReactions).where(orm.eq(schema.conversationMessageReactions.userId, 'c1')))
    .map(r => r.emoji);
  assert.deepEqual(originalSelf, ['❤'], 'дом C остаётся единственным владельцем своей реакции');
}
test('R208 ссылки хоста на своих и бывших отвергаются, на действующих третьего дома принимаются', async () => { await hostedReferences(); });

test('R208 дом участника не принимает отметки напрямую от третьего дома; хост принимает только действующего участника', async () => {
  const { C, D, E } = await fixture();
  const wire = shared.serializeConvReactionsWire({ messageId: 'm1', reactions: [{ user: { instanceId: homes.E, userId: 'e1' }, emoji: '👍' }] });
  await C.accept.applyChange(homes.E, homes.C, 'react', cid, wire);
  assert.deepEqual(await reactions(C), [], 'не хост E не вправе менять отметки в C');
  await setRead(E, 'E', 5);
  await D.t.db.update(schema.conversationMembers).set({ leftAt: new Date(0) }).where(orm.eq(schema.conversationMembers.userId, 'd:e1'));
  await D.accept.applyChange(homes.E, homes.D, 'react', cid, wire);
  assert.deepEqual(await reactions(D), [], 'бывший участник E не вправе менять отметки на хосте');
  await D.t.db.update(schema.conversationMembers).set({ leftAt: null }).where(orm.eq(schema.conversationMembers.userId, 'd:e1'));
  await D.accept.applyChange(homes.E, homes.D, 'react', cid, wire);
  assert.deepEqual(await reactions(D), ['d:e1:👍'], 'вернувшийся действующий участник E принимается хостом');
  await pull(D, C); assert.deepEqual(await reactions(C), ['c:e1:👍'], 'хост вправе переслать ту же реакцию C');
});

async function hostCapabilities(mutation?: Mutation) {
  const { D } = await fixture(mutation);
  await setLinkFeatures(D, 'E', oldFeatures);
  const all = [entry('react'), entry('read'), entry('pin'), entry('listen', 'v1')];
  await D.record(all);
  assert.deepEqual(await journal(D, 'E'), [], 'хост не пишет четыре отметки старому дому без dmgroupmarks1');
  assert.deepEqual((await journal(D, 'C')).sort(), ['listen:v1', 'pin:m1', 'react:m1', 'read:'], 'сосед C с признаком получает все четыре вида');
  await setLinkFeatures(D, 'E', features); await D.record(all);
  assert.deepEqual((await journal(D, 'E')).sort(), ['pin:m1', 'react:m1', 'read:'], 'после объявления признака E получает все адресованные ему отметки');
}
test('R208 хост отправляет четыре вида только дому с dmgroupmarks1, после обновления отдаёт адресованные отметки', async () => { await hostCapabilities(); });

async function leafCapabilities(mutation?: Mutation) {
  const { D, E } = await fixture(mutation);
  await setLinkFeatures(E, 'D', oldFeatures);
  await addReaction(E, 'E', '👍'); await setRead(E, 'E', 5); await addPins(E);
  await E.t.db.insert(schema.conversationVoiceListens).values({ messageId: 'v1', userId: 'e1' });
  const all = [entry('react'), entry('read'), entry('pin'), entry('listen', 'v1')];
  await E.record(all);
  assert.deepEqual(await journal(E, 'D'), [], 'участник не пишет четыре отметки хосту без dmgroupmarks1');
  await setLinkFeatures(E, 'D', features); await E.record(all);
  assert.deepEqual((await journal(E, 'D')).sort(), ['listen:v1', 'pin:m1', 'react:m1', 'read:'], 'участник пишет четыре отметки поддерживающему хосту');
  await pull(E, D);
  assert.deepEqual(await reactions(D), ['d:e1:👍'], 'объявивший признак хост действительно принимает реакцию');
  assert.equal(await readKey(D, 'E'), 4, 'объявивший признак хост действительно принимает прочитано');
  assert.equal((await pins(D)).length, 3, 'объявивший признак хост действительно принимает общий закреп');
  assert.deepEqual(await listeners(D), ['d:e1'], 'объявивший признак хост действительно принимает прослушано');
}
test('R208 участник не посылает отметки старому хосту, поддерживающему посылает и тот применяет все четыре', async () => { await leafCapabilities(); });

test('R208 dmgroupmarks1 объявляется только при включённых ЛС между инстансами', async () => {
  const now = Date.now(), root = crypto.generateKeyPairSync('ed25519');
  const rootPublicKeyDer = root.publicKey.export({ type: 'spki', format: 'der' });
  const rootPrivateKeyDer = root.privateKey.export({ type: 'pkcs8', format: 'der' });
  const identity = { instanceId: instanceIdFrom(rootPublicKeyDer), fingerprint: fingerprintFrom(rootPublicKeyDer), rootPublicKeyDer, rootPrivateKeyDer };
  const key = issueSigningKey(rootPrivateKeyDer, now);
  for (const dmEnabled of [false, true]) {
    const federation = createFederation({ enabled: true, dmEnabled, now: () => now,
      domain: 'document.invalid', apiBase: 'https://document.invalid/api', clientOrigin: 'https://document.invalid', appVersion: null,
      loadInstanceMeta: async () => ({ name: 'Документ', iconHash: null }), log() {},
      keystore: { dir: 'not-opened', loadOrCreateRoot: async () => ({ identity, created: false }), loadSigningKeys: async () => [key],
        saveSigningKey: fail('запись ключа'), rotateRoot: fail('ротация корня') } });
    await federation.start(); const doc = await federation.document(); assert.ok(doc, 'настоящая федерация выпустила документ без файлового IO');
    assert.equal(doc.features.includes(shared.FED_FEATURES.dmgroupmarks1), dmEnabled,
      dmEnabled ? 'включённые ЛС объявляют рабочую поддержку отметок групп' : 'выключенные ЛС не объявляют отметки групп');
    assert.equal(doc.features.includes(shared.FED_FEATURES.link), true, 'выключение ЛС не выключает остальные возможности федерации');
  }
});

test('R208 контрфакт: снят exceptHome — ловим реальное эхо реакции дому C', async () => {
  await reactionRelay();
  const mutation = mutationIn('federation/convChanges', 'recordFedConvChanges', 'i.exceptHome !== home', 'true', 'D');
  await assert.rejects(() => reactionRelay(mutation), targeted('хост не возвращает реакцию дому её автора', ['react:m1'], []));
});
test('R208 контрфакт: приём от хоста перестал включать третьи дома — реакция C не доходит до E', async () => {
  await reactionRelay();
  const mutation = mutationIn('federation/convAccept', 'applyReactions', 'const fromHost = c.group?.host === false;', 'const fromHost = false;', 'E');
  await assert.rejects(() => reactionRelay(mutation), targeted('реакция C проходит через хоста D в дом E', [], ['e:c1:👍']));
});
test('R208 контрфакт: бывший участник стал допустимым hostedRefs — ловим его реакцию', async () => {
  await hostedReferences();
  const mutation = mutationIn('federation/convAccept', 'hostedRefs', ' && c.memberIds.includes(who.id)', '', 'C');
  await assert.rejects(() => hostedReferences(mutation), targeted('хост меняет только действующих чужих, не своих и не бывших',
    ['c1:❤', 'c:d1:🔥', 'c:e1:👍', 'c:former-e:👻'], ['c1:❤', 'c:d1:🔥', 'c:e1:👍']));
});
test('R208 контрфакт: снятие только self-стража эквивалентно — home !== null всё ещё защищает свои реакции', async () => {
  await hostedReferences();
  // byRef(self) возвращает только home=null, поэтому следующий who.home!==null делает self-страж избыточным.
  // Это честная проверка выжившего мутанта, не ложный kill по другой ошибке загрузчика или realm.
  const mutation = mutationIn('federation/convAccept', 'hostedRefs', ' || ref.instanceId === self', '', 'C');
  await hostedReferences(mutation);
});
test('R208 контрфакт: хост перестал выбирать сообщения автора-адресата в read — ловим m4 вместо v1', async () => {
  await readsRelay();
  const mutation = mutationIn('federation/convChanges', 'groupMarkEntities', 'sql`a.home_instance_id = ${peer}`', 'sql`TRUE`', 'D');
  await assert.rejects(() => readsRelay(mutation), targeted('хост отдаёт C последнее прочитанное сообщение именно автора C',
    [`${homes.E}:e1:m4`], [`${homes.E}:e1:v1`]));
});
test('R208 контрфакт: участник отдаёт своё прочитанное сообщение — ловим m5 вместо чужого m4', async () => {
  await readsRelay();
  const mutation = mutationIn('federation/convChanges', 'groupMarkEntities', 'sql`a.home_instance_id IS NOT NULL`', 'sql`TRUE`', 'E');
  await assert.rejects(() => readsRelay(mutation), targeted('дом E отдаёт последнее прочитанное сообщение любого чужого автора',
    [`${homes.E}:e1:m5`], [`${homes.E}:e1:m4`]));
});
test('R208 контрфакт: applyReads не пишет fedRecordRelay — у C нет пересланного прочитано E', async () => {
  await readsRelay();
  const mutation = mutationIn('federation/convAccept', 'applyReads',
    'if (c.group?.host) await fedRecordRelay(tx, [{ conversationId, kind: FED_CONV_CHANGE.read, entityId: null, exceptHome: peer }]);', '', 'D');
  await assert.rejects(() => readsRelay(mutation), targeted('хост пересылает прочитано E дому C', [], ['read:']));
});
test('R208 контрфакт: pinner потерян — закреп E у C ложно подписан хостом D', async () => {
  await pinRelay();
  const mutation = mutationIn('federation/convAccept', 'applyPin',
    'const pinner = c.group?.host === false && w.by ? (hostedRefs(c, [w.by], peer, self)[0] ?? null) : null;', 'const pinner = null;', 'C');
  await assert.rejects(() => pinRelay(mutation), targeted('закреп E у C для всех и подписан тенью E, не хоста',
    ['c1:c:d1:true', 'c:d1:c:d1:true', 'c:e1:c:d1:true'], ['c1:c:e1:true', 'c:d1:c:e1:true', 'c:e1:c:e1:true']));
});
async function listenRouting(mutation?: Mutation) {
  const { D } = await fixture(mutation);
  // В пересылке E защищён ещё и exceptHome. Собственная запись хоста проверяет именно listenHome, не соседний страж.
  await D.record([entry('listen', 'v1')]);
  assert.deepEqual(await journal(D, 'C'), ['listen:v1'], 'listen записывается дому автора C');
  assert.deepEqual(await journal(D, 'E'), [], 'listen адресуется только дому автора C');
}
test('R208 запись прослушано на хосте адресуется только дому автора, не остальным участникам', async () => { await listenRouting(); });
test('R208 контрфакт: listen рассылается всем домам вместо дома автора — ловим эхо слушателю E', async () => {
  await listenRouting();
  const mutation = mutationIn('federation/convChanges', 'recordFedConvChanges', 'marks.listenHome.get(i.entityId) === home', 'true', 'D');
  await assert.rejects(() => listenRouting(mutation), targeted('listen адресуется только дому автора C', ['listen:v1'], []));
});
test('R208 контрфакт: relayListens не вызван — хост теряет слушателя E на копии голосового C', async () => {
  await listenRelay();
  const mutation = mutationIn('federation/convAccept', 'applyListens',
    'if (m.attachments.some(isListenable)) await relayListens(tx, c, m, w.listeners, peer, conversationId);', '', 'D');
  await assert.rejects(() => listenRelay(mutation), targeted('хост сохраняет слушателя E на копии голосового C', [], ['d:e1']));
});
test('R208 контрфакт: прослушано от хоста не включает третий дом — у автора C исчезает слушатель E', async () => {
  await listenRelay();
  const mutation = mutationIn('federation/convAccept', 'applyListens', 'const fromHost = c.group?.host === false;', 'const fromHost = false;', 'C');
  await assert.rejects(() => listenRelay(mutation), targeted('дом автора C получает тень слушателя E', [], ['c:e1']));
});
test('R208 контрфакт: хост игнорирует marks.homes — четыре отметки попадают старому дому E', async () => {
  await hostCapabilities();
  const mutation = mutationIn('federation/convChanges', 'recordFedConvChanges', 'if (!marks.homes.has(home)) continue;', 'if (false) continue;', 'D');
  await assert.rejects(() => hostCapabilities(mutation), targeted('хост не пишет четыре отметки старому дому без dmgroupmarks1',
    ['react:m1', 'read:', 'pin:m1'], []));
});
test('R208 контрфакт: участник игнорирует marks.homes — четыре отметки отправляются старому хосту', async () => {
  await leafCapabilities();
  const mutation = mutationIn('federation/convChanges', 'recordFedConvChanges', 'if (marks.homes.has(info.origin))', 'if (true)', 'E');
  await assert.rejects(() => leafCapabilities(mutation), targeted('участник не пишет четыре отметки хосту без dmgroupmarks1',
    ['react:m1', 'read:', 'pin:m1', 'listen:v1'], []));
});
