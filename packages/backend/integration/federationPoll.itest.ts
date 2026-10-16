import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, test } from 'node:test';
import ts from 'typescript';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as authRules from '../src/authRules.js';
import * as superAdminRules from '../src/superAdminRules.js';
import * as statusRules from '../src/statusRules.js';
import * as shopRules from '../src/shopRules.js';
import * as callRules from '../src/callRules.js';
import * as seenRules from '../src/lastSeenRules.js';
import * as threatRules from '../src/linkThreatsRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Changes = typeof import('../src/federation/convChanges.js');
type Accept = typeof import('../src/federation/convAccept.js');
type Mutation = { file: string; from: string; to: string };
type Direction = 'direct' | 'host' | 'member';
const self = 'r222-self', peer = 'r222-peer', third = 'r222-third', cid = 'r222-conversation', mid = 'r222-message';
const base = [shared.FED_FEATURES.dm1, shared.FED_FEATURES.dmgroup1, shared.FED_FEATURES.dmgroupmarks1, shared.FED_FEATURES.dm2once, shared.FED_FEATURES.dmmedia1];
const features = [...base, shared.FED_FEATURES.dmpoll1];
const people = ['local', 'peer', 'third', 'former'];
const normal = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const source = (file: string) => readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { try { await t?.close(); } finally { const { pool } = await import('../src/db/index.js'); await pool.end(); } });
function mutation(file: string, fn: string, from: string, to: string): Mutation {
  const raw = source(file), ast = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
  const found = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === fn);
  assert.equal(found.length, 1, `одна настоящая функция ${fn}`);
  const body = found[0].getText(ast); assert.equal(body.split(from).length, 2, `один смысловой якорь ${fn}`);
  return { file, from: body, to: body.replace(from, to) };
}
const killed = (prefix: string, actual: unknown, expected: unknown) => (e: unknown) => {
  if (!(e instanceof assert.AssertionError) || e.code !== 'ERR_ASSERTION' || !e.message.startsWith(prefix) || e.operator !== 'strictEqual') return false;
  assert.equal(e.actual, actual); assert.equal(e.expected, expected); return true;
};
function modules(edit?: Mutation) {
  const errors: string[] = [], warnings: string[] = [], expectedWarnings: string[] = [], deliveries: { user: string; body: shared.GatewayServerMessage }[] = [];
  const fail = (name: string) => () => { errors.push(name); throw new Error(`неописанная граница R222: ${name}`); };
  function load<T>(file: string, deps: Record<string, unknown>): T {
    let raw = source(file);
    if (edit?.file === file) { assert.equal(raw.split(edit.from).length, 2, `единственный whole-module якорь ${file}`); raw = raw.replace(edit.from, edit.to); }
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, Date, Buffer, URL, Map, Set, Promise, Error,
        console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')), log: fail('console.log'), error: fail('console.error') },
        setTimeout: fail('таймер'), setInterval: fail('worker'),
        require(id: string) { assert.ok(Object.hasOwn(deps, id), `закрытый импорт ${file}:${id}`); return deps[id]; } });
    return module.exports as T;
  }
  const fed = { '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const changes = load<Changes>('federation/convChanges', fed);
  const common = { '@gusvoice/shared': shared, 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema };
  const env = { jwtSecret: 'not-a-secret-used-only-by-integration-tests', linkThreats: { enabled: false } };
  const auth = load<typeof import('../src/auth.js')>('auth', { ...common, bcryptjs: bcrypt, jsonwebtoken: jwt,
    './authRules.js': authRules, './superAdminRules.js': superAdminRules, './env.js': { env } });
  const threats = load<typeof import('../src/linkThreats.js')>('linkThreats', { 'node:fs/promises': fs, './env.js': { env }, './linkThreatsRules.js': threatRules });
  const serialize = load<typeof import('../src/serialize.js')>('serialize', { '@gusvoice/shared': shared, './auth.js': auth,
    './superAdminRules.js': superAdminRules, './env.js': { env }, './statusRules.js': statusRules, './shopRules.js': shopRules,
    './callRules.js': callRules, './lastSeenRules.js': seenRules, './linkThreats.js': threats,
    './federation/instanceLabels.js': { instanceLabel: (instanceId: string) => ({ instanceId, name: 'Сосед', domain: 'r222.invalid', reports: false }) } });
  const realtime = { publishToUser: async (user: string, body: shared.GatewayServerMessage) => { deliveries.push({ user, body: normal(body) }); } };
  const conv = load<typeof import('../src/conversations.js')>('conversations', { ...common,
    './convRules.js': rules, './dmWriteBarrier.js': { dmWriteBarrier: {} }, './realtime.js': realtime,
    './env.js': { env }, './util.js': { uuidv7: randomUUID }, './serialize.js': serialize,
    './attachments.js': { attachmentLink: fail('URL файла'), attachmentStore: {}, copyForForward: fail('копия файла'), DailyQuotaError: class extends Error {},
      discardForwardCopies: fail('отброс копий'), privateAttachmentsReady: fail('готовность файла'), purgeDeleted: fail('стирание файла') } });
  conv.configureFederatedConv({ selfInstanceId: () => self, record: changes.recordFedConvChanges });
  const polls = load<typeof import('../src/convPolls.js')>('convPolls', { '@gusvoice/shared': shared, 'drizzle-orm': orm,
    './db/index.js': { db: t.db }, './db/schema.js': schema, './conversations.js': conv, './convRules.js': rules });
  const io = { get: fail('транспорт не подключён') as (r: any) => Promise<any> };
  const accept = load<Accept>('federation/convAccept', { ...fed, '../convRules.js': rules,
    '../conversations.js': conv,
    '../convSendFanout.js': { fanOutSend: fail('пуш нового сообщения') },
    './convLink.js': { notePeerAnswer: () => {}, onLinkRestored: fail('worker связки') },
    './eventStream.js': { onFedEvent: fail('подписка'), sendEventTo: fail('звонок') },
    './instance.js': { federation: { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'synthetic', privateKeyDer: Buffer.alloc(0) }) } },
    './peerClient.js': { getSignedFromPeer: (r: unknown) => io.get(r) } });
  // Здесь не принимаются новые группы или сообщения: проверяем только отметки существующего состава.
  accept.configureFedGroupAccept({ applyConv: fail('новая группа'), verify: fail('новая подпись') });
  return { changes, accept, conv, polls, io, deliveries, expectedWarnings, clean() {
    assert.deepEqual(errors, [], 'неописанные зависимости не исполнены');
    assert.deepEqual(warnings, expectedWarnings, 'только точные ожидаемые строки прогресса, ошибки применения не скрыты');
  } };
}
const ref = (id: string): shared.FedPersonRef => ({ instanceId: id === 'local' ? self : id === 'peer' ? peer : third, userId: id === 'local' ? id : `${id}-home` });
function poll(multi = false): shared.ConvPollMedia {
  return { kind: 'poll', question: 'Куда?', options: [{ id: '0', text: 'Домой', votes: 0 }, { id: '1', text: 'В гости', votes: 0 }],
    anonymous: false, multi, quiz: false, closed: false, revealed: false, my: [], voters: 0 };
}
async function fixture(direction: Direction = 'direct', edit?: Mutation, withPolls = true, multi = false) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(people.map(id => ({ id, username: `r222_${id}`, displayName: id, passwordHash: 'synthetic-only',
    ...(id === 'local' ? {} : { homeInstanceId: ref(id).instanceId, homeUserId: ref(id).userId }) })));
  await t.db.insert(schema.federationLinks).values([peer, third].map((id, i) => ({ instanceId: id, domain: `r222-${i}.invalid`,
    apiBase: `https://r222-${i}.invalid/api`, clientOrigin: `https://r222-${i}.invalid`, rootKey: 'synthetic-only', state: 'active' as const,
    features: withPolls ? features : base })));
  await t.db.insert(schema.conversations).values({ id: cid, kind: direction === 'direct' ? 'direct' : 'group',
    directKey: direction === 'direct' ? 'r222-local-peer' : null, originInstanceId: direction === 'member' ? peer : null, lastSortKey: 2 });
  await t.db.insert(schema.conversationMembers).values((direction === 'direct' ? ['local', 'peer'] : people).map(userId => ({ conversationId: cid,
    userId, role: userId === 'local' ? 'owner' as const : 'member' as const, leftAt: userId === 'former' ? new Date('2026-10-01T00:00:00Z') : null })));
  await t.db.insert(schema.conversationMessages).values([
    { id: mid, conversationId: cid, authorId: 'local', sortKey: 1, content: '📊 Опрос: Куда?', media: poll(multi), noPreview: true },
    { id: `${mid}-remote`, conversationId: cid, authorId: 'peer', sortKey: 2, content: '📊 Опрос: Куда?', media: poll(multi), originInstanceId: peer, originSortKey: 9 },
  ]);
  return modules(edit);
}
async function rows(messageId = mid) {
  return (await t.db.select().from(schema.convPollVotes).where(orm.eq(schema.convPollVotes.messageId, messageId)))
    .map(v => `${v.userId}:${v.optionId}`).sort();
}
async function vote(w: ReturnType<typeof modules>, voters: shared.FedConvPollVotesWire['voters'], messageId = mid) {
  await w.accept.applyChange(peer, self, 'pollvote', cid, shared.serializeConvPollVotesWire({ messageId, voters })); w.clean();
}
async function gateExport(edit?: Mutation) {
  const w = await fixture('direct', edit, false);
  await t.db.insert(schema.convPollVotes).values({ messageId: mid, userId: 'local', optionId: '0' });
  await t.db.transaction(tx => w.changes.recordFedConvChanges(tx as unknown as Parameters<Changes['recordFedConvChanges']>[0], [{ conversationId: cid, kind: 'msg', entityId: mid }, { conversationId: cid, kind: 'pollvote', entityId: mid }]));
  const page = await w.changes.changesForPeer(peer, 0, 200, self); assert.ok('items' in page);
  assert.equal(page.items.some(i => i.kind === 'pollvote'), false, 'старому дому не уходит строка голосов');
  assert.equal(Object.hasOwn(page.items.find(i => i.kind === 'msg')!.entity!, 'media'), false, 'старому дому не уходит media опроса');
  assert.equal(page.items.find(i => i.kind === 'msg')!.entity!.content, '📊 Опрос: Куда?');
  assert.equal(page.seq, 2, 'курсор проходит отрезанную строку голосов');
  assert.equal((await w.changes.changesForPeer(peer, page.seq, 200, self) as shared.FedConvChangesPage & { items: unknown[] }).items.length, 0);
  const oldExport = await w.changes.exportForPeer(peer, cid, null, self); assert.ok(oldExport);
  assert.equal(oldExport.items.some(i => i.kind === 'pollvote'), false, 'полный экспорт старому дому тоже не раскрывает голоса');
  assert.equal(oldExport.items.some(i => i.kind === 'msg' && i.entity?.media), false, 'полный экспорт старому дому оставляет только текст');
  await t.db.update(schema.federationLinks).set({ features }).where(orm.eq(schema.federationLinks.instanceId, peer));
  const modern = await w.changes.changesForPeer(peer, 0, 200, self); assert.ok('items' in modern);
  assert.equal(modern.items.some(i => i.kind === 'pollvote'), true, 'новый дом получает голоса');
  assert.equal((modern.items.find(i => i.kind === 'msg')!.entity!.media as shared.FedConvPollWire)?.kind, 'poll');
  const exported = await w.changes.exportForPeer(peer, cid, null, self); assert.ok(exported);
  assert.deepEqual(normal(exported.items.filter(i => i.kind === 'pollvote').map(i => i.entityId).sort()), [mid, `${mid}-remote`].sort(), 'полный экспорт содержит голоса на каждый опрос');
  w.clean();
}
test('R222 dmmedia1 без dmpoll1 получает запасной текст и движущийся курсор; новый дом получает media и голоса', async () => { await gateExport(); });
test('R222 контрфакт: удалён KIND_FEATURE[vote] — старому дому ошибочно ушли голоса', async () => {
  await gateExport();
  const file = 'federation/convChanges', from = '  [FED_CONV_CHANGE_E2.vote]: FED_FEATURES.dmpoll1,';
  assert.equal(source(file).split(from).length, 2);
  await assert.rejects(() => gateExport({ file, from, to: '' }), killed('старому дому не уходит строка голосов', true, false));
});
test('R222 контрфакт: pollOk=true — старому дому ошибочно ушёл опрос вместо текста', async () => {
  await gateExport();
  await assert.rejects(() => gateExport(mutation('federation/convChanges', 'materialize', 'const pollOk = await peerKnowsPolls(msgs, instanceId);', 'const pollOk = true;')),
    killed('старому дому не уходит media опроса', true, false));
});
test('R222 местный голос журналируется как pollvote, а не msg', async () => {
  const w = await fixture();
  const access = await w.conv.loadAccess(cid, 'local'); assert.ok(access);
  assert.equal((await w.polls.voteConvPoll('local', access, mid, ['0'])).kind, 'ok');
  const changes = await t.db.select().from(schema.fedConvChanges);
  assert.deepEqual(changes.map(c => c.kind), ['pollvote']); w.clean();
});
async function admission(edit?: Mutation) {
  const w = await fixture('direct', edit);
  await t.db.insert(schema.convPollVotes).values({ messageId: mid, userId: 'local', optionId: '1' });
  await vote(w, [{ user: ref('peer'), options: ['bad', '0', '1'] }, { user: ref('local'), options: ['0'] }, { user: ref('third'), options: ['1'] }]);
  const delivered = w.deliveries.filter(d => d.body.t === 'conv.change');
  assert.deepEqual(delivered.map(d => d.user).sort(), ['local', 'peer'], 'настоящая доставка публикует вид обоим участникам');
  assert.equal((await rows()).includes('local:1'), true, 'сосед не снимает местный голос');
  assert.equal((await rows()).includes('local:0'), false, 'сосед не добавляет местный голос');
  assert.equal((await rows()).filter(r => r.startsWith('peer:')).length, 1, 'single принимает один известный вариант');
  assert.deepEqual(await rows(), ['local:1', 'peer:0']);
  await vote(w, []); assert.deepEqual(await rows(), ['local:1'], 'пустой список снимает только голос соседа');
}
test('R222 зеркало принимает известный одиночный вариант соседа, не меняет свой и снимает пустым списком', async () => { await admission(); });
test('R222 multi сохраняет два известных варианта одного человека без дублей и чужих вариантов', async () => {
  const w = await fixture('direct', undefined, true, true);
  await vote(w, [{ user: ref('peer'), options: ['0', '1', '0', 'bad'] }]); assert.deepEqual(await rows(), ['peer:0', 'peer:1']);
});
test('R222 контрфакт: theirs без фильтра дома стирает местный голос', async () => {
  await admission();
  await assert.rejects(() => admission(mutation('federation/convAccept', 'applyPollVotes', 'c.members.filter((x) => (fromHost ? x.home !== null : x.home === peer))', 'c.members')),
    killed('сосед не снимает местный голос', false, true));
});
test('R222 контрфакт: single без slice принимает лишний вариант', async () => {
  await admission();
  await assert.rejects(() => admission(mutation('federation/convAccept', 'applyPollVotes', 'poll.multi ? opts : opts.slice(0, 1)', 'opts')),
    killed('single принимает один известный вариант', 2, 1));
});
async function relay(edit?: Mutation) {
  const w = await fixture('host', edit);
  await vote(w, [{ user: ref('peer'), options: ['0'] }]);
  assert.deepEqual(await rows(), ['peer:0']);
  const changes = await t.db.select().from(schema.fedConvChanges);
  assert.equal(changes.some(c => c.instanceId === peer), false, 'хост не возвращает голос дому автора');
  assert.deepEqual(changes.map(c => `${c.instanceId}:${c.kind}`), [`${third}:pollvote`]);
}
test('R222 хост пересылает голос третьему дому, но не дому голосующего', async () => { await relay(); });
test('R222 контрфакт: снят exceptHome — голос возвращается дому автора', async () => {
  await relay();
  await assert.rejects(() => relay(mutation('federation/convAccept', 'applyPollVotes', ', exceptHome: peer', '')),
    killed('хост не возвращает голос дому автора', true, false));
});
test('R222 от хоста принимаются действующие люди третьего дома, но не свои и не бывшие', async () => {
  const w = await fixture('member');
  await t.db.insert(schema.convPollVotes).values({ messageId: mid, userId: 'local', optionId: '1' });
  await vote(w, ['peer', 'third', 'former', 'local'].map(id => ({ user: ref(id), options: ['0'] })));
  assert.deepEqual(await rows(), ['local:1', 'peer:0', 'third:0']);
  assert.deepEqual(await t.db.select().from(schema.fedConvChanges), [], 'дом участника не делает relay от хоста');
});
async function closeMessage(w: ReturnType<typeof modules>, mine: boolean, closed: boolean, version = 0) {
  const id = mine ? mid : `${mid}-remote`;
  const [row] = await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, id));
  const media = shared.convMediaToWire({ ...poll(), closed }, self)!;
  const entity = shared.serializeConvMessageWire({ id, conversationId: cid, author: ref(mine ? 'local' : 'peer'), clientId: null,
    payloadHash: null, createdAt: row.createdAt.getTime(), originSortKey: row.originSortKey ?? row.sortKey, content: row.content,
    replyToId: null, forwardedFrom: null, silent: false, noPreview: true, captionAbove: false, replyQuote: null,
    sticker: null, service: null, attachments: [], editVersion: version, editedAt: null, deleted: false, media });
  await w.accept.applyChange(peer, self, 'msg', cid, entity); w.clean();
  return (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, id)))[0];
}
test('R222 closed той же версии закрывает копию без editedAt, новая открытая версия её не открывает; свой опрос не закрывается', async () => {
  const w = await fixture();
  const closed = await closeMessage(w, false, true);
  assert.equal(closed.media?.kind === 'poll' && closed.media.closed, true); assert.equal(closed.editedAt, null); assert.equal(closed.editVersion, 0);
  const newer = await closeMessage(w, false, false, 1); assert.equal(newer.media?.kind === 'poll' && newer.media.closed, true);
  const own = await closeMessage(w, true, true, 9); assert.equal(own.media?.kind === 'poll' && own.media.closed, false);
});
const answer = (body: unknown) => ({ ok: true, value: { status: 200, body: JSON.stringify(body), retryAfter: 0 } });
async function fullPass(withPolls: boolean, include: boolean, edit?: Mutation) {
  const w = await fixture('host', edit, withPolls);
  await t.db.insert(schema.convPollVotes).values([mid, `${mid}-remote`].map(messageId => ({ messageId, userId: 'peer', optionId: '0' })));
  await t.db.insert(schema.fedConvCursor).values({ instanceId: peer, since: 7 });
  w.io.get = async r => {
    if (r.path.endsWith('/changes')) return Number(r.query?.since) < 20
      ? answer(shared.serializeConvChangesPage({ instanceId: peer, reset: true, seq: 20 }))
      : answer(shared.serializeConvChangesPage({ instanceId: peer, seq: 20, more: false, items: [] }));
    if (r.path.endsWith('/groups')) return answer(shared.serializeConvGroupsList({ instanceId: peer, groups: [cid] }));
    assert.equal(r.path, `/api/fed/v1/conv/${cid}/export`);
    return answer(shared.serializeConvExportPage({ instanceId: peer, conversationId: cid, next: null, marksComplete: true,
      items: include ? [{ seq: 0, kind: 'pollvote', conversationId: cid, entityId: mid,
        entity: shared.serializeConvPollVotesWire({ messageId: mid, voters: [{ user: ref('peer'), options: ['0'] }] }) }] : [] }));
  };
  w.expectedWarnings.push(`[fed-dm] полный проход по 1 из 1 бесед с ${peer}`);
  assert.equal(await w.accept.pullConvChanges(peer), 20); w.clean();
  assert.equal((await rows()).includes('peer:0'), include || !withPolls, 'полный проход сохраняет присланный голос и не стирает голоса старого дома');
  assert.equal((await rows(`${mid}-remote`)).includes('peer:0'), !withPolls, 'неприсланный голос снимается только от дома с dmpoll1');
}
test('R222 полный проход учитывает pollvote в seen, отсутствующий голос снимает, от старого дома сохраняет', async () => {
  await fullPass(true, true); await fullPass(true, false); await fullPass(false, false);
});
test('R222 контрфакт: забытая pollvote в seen стирает присланный голос', async () => {
  await fullPass(true, true);
  await assert.rejects(() => fullPass(true, true, mutation('federation/convAccept', 'noteSeenMark',
    'else if (item.kind === FED_CONV_CHANGE_E2.vote) (seen.vote ??= new Set()).add(id);', '')),
    killed('полный проход сохраняет присланный голос и не стирает голоса старого дома', false, true));
});
test('R222 контрфакт: снят признак dmpoll1 при снятии неприсланных голосов — старый дом стирает зеркало', async () => {
  await fullPass(false, false);
  await assert.rejects(() => fullPass(false, false, mutation('federation/convAccept', 'dropUnsentGroupMarks',
    'if (link?.features.includes(FED_FEATURES.dmpoll1)) {', 'if (true) {')),
    killed('полный проход сохраняет присланный голос и не стирает голоса старого дома', false, true));
});
test('R222 marksComplete группы сохраняется для дома без dmpoll1, но pollvote не отдаётся', async () => {
  const w = await fixture('host', undefined, false);
  await t.db.insert(schema.convPollVotes).values({ messageId: mid, userId: 'local', optionId: '0' });
  const exported = await w.changes.exportForPeer(peer, cid, null, self); assert.ok(exported);
  assert.equal(exported.marksComplete, true); assert.equal(exported.items.some(i => i.kind === 'pollvote'), false); w.clean();
});
test('R222 незнакомую pollvote старый приёмник пропускает и сохраняет SQL-курсор головы', async () => {
  const file = 'federation/convAccept', from = '  if (kind === FED_CONV_CHANGE_E2.vote) return applyPollVotes(peer, self, conversationId, entity);';
  assert.equal(source(file).split(from).length, 2);
  for (const edit of [undefined, { file, from, to: '' }]) {
    const w = await fixture('direct', edit);
    w.io.get = async () => answer(shared.serializeConvChangesPage({ instanceId: peer, seq: 8, more: false,
      items: [{ seq: 8, kind: 'pollvote', conversationId: cid, entityId: mid, entity: shared.serializeConvPollVotesWire({ messageId: mid,
        voters: [{ user: ref('peer'), options: ['0'] }] }) }] }));
    assert.equal(await w.accept.pullConvChanges(peer), 8);
    assert.equal(Number((await t.db.select().from(schema.fedConvCursor))[0]?.since), 8);
    assert.deepEqual(await rows(), edit ? [] : ['peer:0']); w.clean();
  }
});
