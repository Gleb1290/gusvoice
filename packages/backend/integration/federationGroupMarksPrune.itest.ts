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
import * as searchRules from '../src/userSearchRules.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as identity from '../src/federation/instanceIdentity.js';
import * as signing from '../src/federation/signingKeys.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Changes = typeof import('../src/federation/convChanges.js');
type Accept = typeof import('../src/federation/convAccept.js');
type Mutation = { from: string; to: string };
type Direction = 'from-host' | 'to-host';
type Request = { path: string; query?: Record<string, unknown> };
type Reply = { ok: true; value: { status: number; body: string; retryAfter: number } };
type Item = shared.FedConvExportPage['items'][number];
const self = 'r217-prune-self', peer = 'r217-prune-peer', third = 'r217-prune-third';
const features = [shared.FED_FEATURES.dm1, shared.FED_FEATURES.dmgroup1, shared.FED_FEATURES.dmgroupmarks1, shared.FED_FEATURES.dm2once];
const live = ['local', 'local2', 'peer', 'peer2', 'third'];
const allPeople = [...live, 'former-peer', 'former-third'];
const voice: shared.Attachment = { id: 'voice', name: 'voice.ogg', contentType: 'audio/ogg', size: 1,
  url: '/not-opened', durationMs: 1000, waveform: [50] };
let t: TestDb, clock = Date.now();
class TestDate extends Date { static override now() { return clock; } }
const source = (file: string) => readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
before(async () => { t = await createTestDb(); });
after(async () => {
  try { await t?.close(); } finally { const { pool } = await import('../src/db/index.js'); await pool.end(); }
});

function inFunction(name: string, replacements: readonly [string, string][]): Mutation {
  const raw = source('federation/convAccept'), ast = ts.createSourceFile('convAccept.ts', raw, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.equal(fn.length, 1, `одна настоящая функция ${name} для контрфакта`);
  const from = fn[0].getText(ast); let to = from;
  for (const [a, b] of replacements) { assert.equal(to.split(a).length, 2, `один смысловой якорь ${name}`); to = to.replace(a, b); }
  return { from, to };
}
function combine(a: Mutation, b: Mutation): Mutation {
  const raw = source('federation/convAccept');
  assert.equal(raw.split(a.from).length, 2); assert.equal(raw.split(b.from).length, 2);
  return { from: raw, to: raw.replace(a.from, a.to).replace(b.from, b.to) };
}
const killed = (prefix: string, actual: unknown, expected: unknown) => (error: unknown) => {
  if (!(error instanceof assert.AssertionError) || error.code !== 'ERR_ASSERTION'
    || !error.message.startsWith(prefix) || error.operator !== 'strictEqual') return false;
  assert.equal(error.actual, actual, 'известный неправильный результат контрфакта');
  assert.equal(error.expected, expected, 'известный нарушенный контракт контрфакта');
  return true;
};

function modules(edit?: Mutation) {
  const errors: string[] = [], warnings: string[] = [], deliveries: unknown[] = [];
  // Ошибка неожиданной ветки остаётся наблюдаемой, даже если production fullPass её поймает и продолжит.
  const fail = (name: string) => () => { errors.push(name); throw new Error(`неописанный путь R217 prune: ${name}`); };
  const load = <T>(file: string, deps: Record<string, unknown>): T => {
    let raw = source(file);
    if (file === 'federation/convAccept' && edit) {
      assert.equal(raw.split(edit.from).length, 2, 'единственный якорь whole-module мутанта R217 prune'); raw = raw.replace(edit.from, edit.to);
    }
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      module, exports: module.exports, Date: TestDate, Buffer, URL, Map, Set, Promise, Error,
      console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')), log: fail('console.log'), error: fail('console.error') },
      setTimeout: fail('фоновый таймер'), setInterval: fail('фоновый worker'),
      require(id: string) { assert.ok(Object.hasOwn(deps, id), `закрытый импорт ${file}:${id}`); return deps[id]; },
    });
    return module.exports as T;
  };
  const fed = { 'drizzle-orm': orm, '@gusvoice/shared': shared, '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const changes = load<Changes>('federation/convChanges', fed);
  const conversations = load<typeof import('../src/conversations.js')>('conversations', {
    'drizzle-orm': orm, '@gusvoice/shared': shared, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './convRules.js': rules, './dmWriteBarrier.js': { dmWriteBarrier: {} }, './env.js': { env: {} }, './util.js': { uuidv7: crypto.randomUUID },
    './serialize.js': { homeInstanceOf: fail('DTO дома'), serializeMessage: fail('клиентский DTO') },
    './attachments.js': { attachmentLink: fail('URL файла'), attachmentStore: {}, copyForForward: fail('копия файла'),
      DailyQuotaError: class extends Error {}, discardForwardCopies: fail('удаление копии'), privateAttachmentsReady: fail('готовность файлов'), purgeDeleted: fail('удаление файлов') },
  });
  conversations.configureFederatedConv({ selfInstanceId: () => self, record: changes.recordFedConvChanges });
  const conv = { ...conversations, deliver: async (delivery: unknown) => { if (delivery) deliveries.push(delivery); } };
  // Настоящие hooks группы и криптография; страницы содержат только отметки уже известных сообщений.
  // Любая неожиданная попытка менять состав/загружать человека не подделывается успешным результатом.
  const federation = { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'synthetic', privateKeyDer: Buffer.alloc(0) }) };
  const group = load<typeof import('../src/federation/convGroup.js')>('federation/convGroup', {
    ...fed, 'node:crypto': crypto, '../conversations.js': conv, '../groupRules.js': groupRules, '../userSearchRules.js': searchRules,
    '../convGroups.js': { addGroupMembers: fail('добавление участника'), removeGroupMember: fail('удаление участника'), updateGroupInfo: fail('правка группы') },
    './directorySync.js': { refreshCapabilities: fail('визитка') }, './guestHost.js': { ensureShadowUser: fail('новый теневой'), shadowUserFor: fail('поиск нового теневого') },
    './instance.js': { federation }, './instanceIdentity.js': identity, './signingKeys.js': signing, './linkRules.js': linkRules,
    './instanceMeta.js': { readInstanceMeta: fail('пауза инстанса') }, './links.js': { getLink: fail('операция состава по связке'), saveVouchedInstance: fail('подпись дома состава') },
    './peerClient.js': { postSignedToPeer: fail('операция группы по сети') },
  });
  const requests: Request[] = [], io = { get: fail('транспорт не подключён') as (r: Request) => Promise<Reply> };
  const accept = load<Accept>('federation/convAccept', {
    ...fed, '../conversations.js': conv, '../convRules.js': rules, '../convSendFanout.js': { fanOutSend: fail('пуш нового сообщения') },
    './convLink.js': { notePeerAnswer: () => {}, onLinkRestored: fail('подписка на связку') },
    './eventStream.js': { onFedEvent: fail('подписка на события'), sendEventTo: fail('звонок по сети') }, './instance.js': { federation },
    './peerClient.js': { getSignedFromPeer: async (r: Request) => { requests.push(normal(r)); return io.get(r); } },
  });
  accept.configureFedGroupAccept({ applyConv: group.applyGroupConv, verify: group.verifyMessageSig });
  return { accept, changes, io, requests, deliveries, clean() {
    assert.deepEqual(errors, [], 'никаких скрытых неожиданных веток');
    assert.deepEqual(warnings.filter(w => !/^\[fed-dm\] полный проход по \d+ из \d+ бесед с /.test(w)
      && !w.includes('ответил 429 на забор журнала — пауза')), [], 'ошибки применения/снятия не спрятаны в предупреждении');
  } };
}
type World = ReturnType<typeof modules> & { direction: Direction; groups: string[] };
const mid = (cid: string, id: string) => `${cid}-${id}`;
const ref = (id: string): shared.FedPersonRef => ({ instanceId: id.startsWith('local') ? self : id.includes('third') ? third : peer,
  userId: id.startsWith('former-') ? id : id === 'peer' ? 'peer-person' : id === 'third' ? 'third-person' : id });
async function fixture(direction: Direction, edit?: Mutation, groups = ['r217-prune-group']): Promise<World> {
  clock = Date.now(); await truncateAll(t.raw);
  await t.db.insert(schema.users).values(allPeople.map(id => ({ id, username: `prune_${id.replaceAll('-', '_')}`,
    displayName: id, passwordHash: 'synthetic-only', ...(id.startsWith('local') ? {} : { homeInstanceId: ref(id).instanceId, homeUserId: ref(id).userId }) })));
  await t.db.insert(schema.federationLinks).values([peer, third].map((id, i) => ({ instanceId: id, domain: `prune${i}.invalid`,
    apiBase: `https://prune${i}.invalid/api`, clientOrigin: `https://prune${i}.invalid`, rootKey: 'synthetic-not-a-key', state: 'active' as const, features })));
  for (const cid of groups) {
    await t.db.insert(schema.conversations).values({ id: cid, kind: 'group', title: 'Снятие отметок', createdBy: 'local',
      originInstanceId: direction === 'from-host' ? peer : null, lastSortKey: 20 });
    await t.db.insert(schema.conversationMembers).values(allPeople.map(id => ({ conversationId: cid, userId: id,
      role: id === 'local' ? 'owner' as const : 'member' as const, lastReadKey: 12,
      leftAt: id.startsWith('former-') ? new Date('2026-10-01T00:00:00Z') : null })));
    await t.db.insert(schema.conversationMessages).values(['gone', 'keep', 'own', 'former', 'deleted', 'hidden', 'third-voice', 'personal'].map((id, i) => ({
      id: mid(cid, id), conversationId: cid, authorId: id === 'third-voice' ? 'third' : 'local', sortKey: i + 1,
      content: '', attachments: [voice], deletedAt: id === 'deleted' ? new Date('2026-10-02T00:00:00Z') : null, withheld: id === 'hidden',
    })));
    const marks: { messageId: string; userId: string }[] = [];
    for (const id of ['gone', 'keep']) for (const userId of ['local2', 'peer', 'third']) marks.push({ messageId: mid(cid, id), userId });
    for (const id of ['deleted', 'hidden']) marks.push({ messageId: mid(cid, id), userId: 'peer' });
    for (const userId of ['former-peer', 'former-third']) marks.push({ messageId: mid(cid, 'former'), userId });
    marks.push({ messageId: mid(cid, 'own'), userId: 'local2' }, { messageId: mid(cid, 'third-voice'), userId: 'peer' });
    await t.db.insert(schema.conversationMessageReactions).values(marks.map(m => ({ ...m, emoji: '👍' })));
    await t.db.insert(schema.conversationVoiceListens).values(marks);
    const pins = ['gone', 'keep', 'own', 'deleted', 'hidden'].flatMap(id => live.map(userId => ({ conversationId: cid,
      messageId: mid(cid, id), userId, pinnedBy: id === 'own' ? 'local2' : direction === 'from-host' && ['gone', 'keep'].includes(id) ? 'third' : 'peer', forBoth: true })));
    pins.push({ conversationId: cid, messageId: mid(cid, 'personal'), userId: 'local', pinnedBy: 'local', forBoth: false });
    await t.db.insert(schema.conversationPins).values(pins);
  }
  await t.db.insert(schema.fedConvCursor).values({ instanceId: peer, since: 7 });
  return { ...modules(edit), direction, groups };
}
function current(cid: string, direction: Direction): Item[] {
  const owners = direction === 'from-host' ? ['peer', 'third'] : ['peer'];
  const common = { seq: 0, conversationId: cid, entityId: mid(cid, 'keep') };
  return [
    { ...common, kind: 'react', entity: shared.serializeConvReactionsWire({ messageId: common.entityId,
      reactions: owners.map(id => ({ user: ref(id), emoji: '👍' })) }) },
    { ...common, kind: 'listen', entity: shared.serializeConvListenWire({ messageId: common.entityId, listeners: owners.map(ref) }) },
    { ...common, kind: 'pin', entity: shared.serializeConvPinWire({ messageId: common.entityId, pinned: true,
      by: ref(direction === 'from-host' ? 'third' : 'peer') }) },
  ];
}
const answer = (body: unknown, status = 200): Reply => ({ ok: true, value: { status, body: JSON.stringify(body), retryAfter: 1 } });
function exportPage(cid: string, items: Item[], next: string | null, complete = true): Reply {
  return answer(shared.serializeConvExportPage({ instanceId: peer, conversationId: cid, items, next, ...(complete ? { marksComplete: true as const } : {}) }));
}
function connect(w: World, pages: (cid: string, after: string | null) => Reply) {
  w.io.get = async r => {
    const q = r.query ?? {};
    assert.equal(q.instance_id, self, 'экспорт запрашивается нашей личностью');
    if (r.path === '/api/fed/v1/conv/changes') return Number(q.since) < 20
      ? answer(shared.serializeConvChangesPage({ instanceId: peer, reset: true, seq: 20 }))
      : answer(shared.serializeConvChangesPage({ instanceId: peer, seq: 20, more: false, items: [] }));
    if (r.path === '/api/fed/v1/conv/groups') return answer(shared.serializeConvGroupsList({ instanceId: peer, groups: w.groups }));
    const found = /^\/api\/fed\/v1\/conv\/([^/]+)\/export$/.exec(r.path);
    assert.ok(found && w.groups.includes(found[1]), 'только известная группа выгрузки');
    return pages(found[1], (q.after as string | null) ?? null);
  };
}
async function people(table: typeof schema.conversationMessageReactions | typeof schema.conversationVoiceListens, messageId: string) {
  return (await t.db.select({ id: table.userId }).from(table).where(orm.eq(table.messageId, messageId))).map(r => r.id).sort();
}
async function hasPeer(cid: string, id = 'gone') { return (await people(schema.conversationMessageReactions, mid(cid, id))).includes('peer'); }
async function hasOwnPin(cid: string) {
  return (await t.db.select().from(schema.conversationPins).where(orm.eq(schema.conversationPins.messageId, mid(cid, 'own')))).length > 0;
}
async function formerPin(edit?: Mutation) {
  for (const direction of ['from-host', 'to-host'] as const) {
    const w = await fixture(direction, edit), cid = w.groups[0], messageId = mid(cid, 'former');
    await t.db.insert(schema.conversationPins).values({ conversationId: cid, messageId, userId: 'local', pinnedBy: 'former-peer', forBoth: true });
    connect(w, id => exportPage(id, current(id, w.direction), null));
    assert.equal(await w.accept.pullConvChanges(peer), 20); w.clean();
    const pins = await t.db.select().from(schema.conversationPins).where(orm.eq(schema.conversationPins.messageId, messageId));
    assert.equal(pins.length, 1, 'R221-former-pin: полный экспорт не снимает общий закреп ушедшего владельца');
    assert.equal(pins[0]!.pinnedBy, 'former-peer'); assert.equal(pins[0]!.userId, 'local'); assert.equal(pins[0]!.forBoth, true);
  }
}
test('R221 полный проход обоими направлениями сохраняет общий закреп бывшего участника', () => formerPin());
test('R221 контрфакт отсутствие бывших в экспорте ошибочно снимает их закреп', async () => {
  await formerPin();
  const edit = inFunction('dropUnsentGroupMarks', [['!seen.pin.has(r.id) && !former.has(r.by)', '!seen.pin.has(r.id)']]);
  await assert.rejects(formerPin(edit), killed('R221-former-pin:', 0, 1));
});
async function snapshot() {
  return {
    react: (await t.db.select().from(schema.conversationMessageReactions)).map(r => `${r.messageId}/${r.userId}/${r.emoji}`).sort(),
    listen: (await t.db.select().from(schema.conversationVoiceListens)).map(r => `${r.messageId}/${r.userId}`).sort(),
    pin: (await t.db.select().from(schema.conversationPins)).map(r => `${r.messageId}/${r.userId}/${r.pinnedBy}/${r.forBoth}`).sort(),
    read: (await t.db.select().from(schema.conversationMembers)).map(r => `${r.conversationId}/${r.userId}/${r.lastReadKey}`).sort(),
    messages: normal(await t.db.select().from(schema.conversationMessages).orderBy(orm.asc(schema.conversationMessages.id))),
  };
}
async function completed(direction: Direction, edit?: Mutation) {
  const w = await fixture(direction, edit), cid = w.groups[0], before = await snapshot();
  connect(w, (id, after) => after === null ? exportPage(id, [], 'page-2') : exportPage(id, current(id, direction), null));
  assert.equal(await w.accept.pullConvChanges(peer), 20, 'завершённый проход устанавливает голову журнала'); w.clean();
  assert.equal(await hasPeer(cid), false, 'полный проход снял отсутствующую реакцию владельца');
  assert.deepEqual(await people(schema.conversationMessageReactions, mid(cid, 'gone')), direction === 'from-host' ? ['local2'] : ['local2', 'third'],
    'на хосте снимаются только владельцы peer, от хоста — все чужие действующие');
  assert.deepEqual(await people(schema.conversationVoiceListens, mid(cid, 'gone')), direction === 'from-host' ? ['local2'] : ['local2', 'third'],
    'прослушивание отсутствующих владельцев снято, своё не затронуто');
  assert.equal((await t.db.select().from(schema.conversationPins).where(orm.eq(schema.conversationPins.messageId, mid(cid, 'gone')))).length, 0,
    'отсутствующий чужой общий закреп снят у всех держателей');
  assert.equal(await hasPeer(cid, 'keep'), true, 'отметка со второй страницы не принята за отсутствующую');
  assert.deepEqual(await people(schema.conversationVoiceListens, mid(cid, 'keep')), ['local2', 'peer', 'third'], 'прослушивание второй страницы сохранено');
  assert.equal((await t.db.select().from(schema.conversationPins).where(orm.eq(schema.conversationPins.messageId, mid(cid, 'keep')))).length, live.length,
    'текущий закреп второй страницы сохранён у всех');
  assert.equal(await hasOwnPin(cid), true, 'свой общий закреп сохранён независимо от выгрузки соседа');
  assert.deepEqual(await people(schema.conversationMessageReactions, mid(cid, 'former')), ['former-peer', 'former-third'], 'бывшие не стали владельцами снятия');
  assert.deepEqual(await people(schema.conversationVoiceListens, mid(cid, 'former')), ['former-peer', 'former-third'], 'прослушивание бывших не затронуто');
  const after = await snapshot();
  assert.deepEqual(after.read, before.read, 'прочитано монотонно и не снимается отсутствием строки');
  assert.deepEqual(after.messages, before.messages, 'снятие отметок не меняет сообщения и надгробия');
  for (const kind of ['react', 'listen', 'pin'] as const) {
    const untouched = (xs: string[]) => xs.filter(s => s.includes('-deleted/') || s.includes('-hidden/') || s.includes('-personal/'));
    assert.deepEqual(untouched(after[kind]), untouched(before[kind]), `${kind}: удалённое, придержанное и личный закреп не тронуты`);
  }
  const localJournal = await t.db.select().from(schema.userChanges).where(orm.eq(schema.userChanges.userId, 'local'));
  assert.equal(localJournal.some(r => r.messageId === mid(cid, 'gone') && r.kind === 'msg'), true, 'местному человеку записана смена реакции/прослушивания');
  assert.equal(w.deliveries.length > 0, true, 'зафиксированные изменения доставляются клиентам');
  const relayed = await t.db.select().from(schema.fedConvChanges).orderBy(orm.asc(schema.fedConvChanges.seq));
  assert.equal(relayed.some(r => r.instanceId === peer), false, 'снятие не возвращается дому-источнику');
  if (direction === 'to-host') {
    assert.deepEqual(relayed.filter(r => r.instanceId === third).map(r => `${r.kind}:${r.entityId}`).sort(),
      [`listen:${mid(cid, 'third-voice')}`, `pin:${mid(cid, 'gone')}`, `react:${mid(cid, 'gone')}`, `react:${mid(cid, 'third-voice')}`].sort(),
      'хост пересылает снятие третьему дому, прослушивание — дому автора');
  } else assert.deepEqual(relayed, [], 'дом участника не пересылает снятие обратно хосту');
  return w;
}

for (const direction of ['from-host', 'to-host'] as const) test(`R217 полный проход ${direction === 'from-host' ? 'от хоста' : 'на хосте'} снимает отсутствующие отметки и сохраняет свои, текущие и бывших`, async () => {
  await completed(direction);
});

async function incomplete(missing: 1 | 2, edit?: Mutation, direction: Direction = 'from-host') {
  const w = await fixture(direction, edit), cid = w.groups[0], before = await snapshot();
  connect(w, (id, after) => after === null ? exportPage(id, [], 'page-2', missing !== 1) : exportPage(id, current(id, w.direction), null, missing !== 2));
  assert.equal(await w.accept.pullConvChanges(peer), 20, 'старый экспорт завершается без снятия'); w.clean();
  assert.equal(await hasPeer(cid), true, 'без признака на любой странице старая реакция сохранена');
  assert.deepEqual(await snapshot(), before, 'неполный экспорт не снимает ни один из трёх видов отметок');
}
for (const missing of [1, 2] as const) test(`R217 отсутствие marksComplete на странице ${missing} запрещает снятие обеими сторонами`, async () => {
  for (const direction of ['from-host', 'to-host'] as const) await incomplete(missing, undefined, direction);
});

async function notEnded(mode: '404' | 'limit', edit?: Mutation, direction: Direction = 'from-host') {
  const w = await fixture(direction, edit), cid = w.groups[0], before = await snapshot(); let n = 0;
  connect(w, id => { n += 1; return mode === '404' && n === 2 ? answer({}, 404) : exportPage(id, [], `next-${n}`); });
  assert.equal(await w.accept.pullConvChanges(peer), 20, 'незавершённая беседа не мешает остальному проходу'); w.clean();
  assert.equal(n, mode === '404' ? 2 : 1000, 'проверена настоящая ветка 404 либо настоящий предел 1000 страниц');
  assert.equal(await hasPeer(cid), true, 'недостигнутый конец не разрешает снять старую реакцию');
  assert.deepEqual(await snapshot(), before, '404 и исчерпание предела не снимают отметок');
}
test('R217 404 после первой полной страницы не означает пустой остаток отметок обеими сторонами', async () => {
  for (const direction of ['from-host', 'to-host'] as const) await notEnded('404', undefined, direction);
});
test('R217 настоящий предел 1000 страниц не считается окончанием выгрузки обеими сторонами', async () => {
  for (const direction of ['from-host', 'to-host'] as const) await notEnded('limit', undefined, direction);
});

async function resume(edit?: Mutation, direction: Direction = 'from-host') {
  const w = await fixture(direction, edit), cid = w.groups[0]; let paused = false;
  connect(w, (id, after) => {
    if (after === null) return exportPage(id, current(id, w.direction), 'page-2');
    if (!paused) { paused = true; return answer({}, 429); }
    return exportPage(id, [], null);
  });
  assert.equal(await w.accept.pullConvChanges(peer), 7, '429 оставляет курсор перед полным проходом');
  assert.equal(await hasPeer(cid), true, 'до продолжения отсутствующие отметки не снимаются');
  const n = w.requests.length;
  assert.equal(await w.accept.pullConvChanges(peer), null, 'до retry-after транспорт не вызывается');
  assert.equal(w.requests.length, n, 'пауза действительно без сетевого запроса');
  clock += 1001;
  assert.equal(await w.accept.pullConvChanges(peer), 20, 'после retry-after проход продолжается и ставит голову'); w.clean();
  assert.equal(await hasPeer(cid, 'keep'), true, 'продолжение помнит отметку уже пройденной страницы');
  assert.equal(await hasPeer(cid), false, 'после продолжения отсутствующая отметка всё же снята');
  assert.deepEqual(w.requests.filter(r => r.path.endsWith('/export')).map(r => r.query?.after), [null, 'page-2', 'page-2'], '429 не начинает группу заново');
}
test('R217 продолжение после 429 помнит prog.seen и не стирает отметки первой страницы обеими сторонами', async () => {
  for (const direction of ['from-host', 'to-host'] as const) await resume(undefined, direction);
});

async function separateConversations(edit?: Mutation) {
  const w = await fixture('from-host', edit, ['r217-a', 'r217-b']); let first: string | null = null;
  connect(w, id => { first ??= id; return exportPage(id, [], null, id !== first); });
  assert.equal(await w.accept.pullConvChanges(peer), 20); w.clean();
  assert.ok(first, 'первая беседа действительно запрошена');
  const second = w.groups.find(g => g !== first)!;
  assert.equal(await hasPeer(first), true, 'неполнота первой беседы защищает её отметки');
  assert.equal(await hasPeer(second), false, 'полнота следующей беседы не заражена seen предыдущей');
}
test('R217 отсутствие признака в одной беседе не запрещает снятие в следующей полной беседе', async () => { await separateConversations(); });

test('R217 контрфакт: снят seen.complete — старый сосед ошибочно стирает живые отметки', async () => {
  await incomplete(2);
  await assert.rejects(() => incomplete(2, inFunction('fullPass', [['if (ended && seen.complete)', 'if (ended)']])),
    killed('без признака на любой странице старая реакция сохранена', false, true));
});
test('R217 контрфакт: ended заменён true — 404 ошибочно превращается в полный пустой хвост', async () => {
  await notEnded('404');
  await assert.rejects(() => notEnded('404', inFunction('fullPass', [['if (ended && seen.complete)', 'if (true && seen.complete)']])),
    killed('недостигнутый конец не разрешает снять старую реакцию', false, true));
});
test('R217 контрфакт: один seen на все беседы переносит неполноту первой на вторую', async () => {
  await separateConversations();
  const edit = inFunction('fullPass', [
    ['for (const cid of todo) {', 'const sharedSeen: SeenMarks = { react: new Set(), pin: new Set(), listen: new Set(), complete: true };\n  for (const cid of todo) {'],
    ['const seen: SeenMarks = prog.cid === cid && prog.seen ? prog.seen : { react: new Set(), pin: new Set(), listen: new Set(), complete: true };', 'const seen: SeenMarks = sharedSeen;'],
  ]);
  await assert.rejects(() => separateConversations(edit), killed('полнота следующей беседы не заражена seen предыдущей', true, false));
});
test('R217 контрфакт: без фильтра pinned_by сосед снимает наш общий закреп', async () => {
  const scenario = async (edit?: Mutation) => {
    const w = await fixture('from-host', edit), cid = w.groups[0];
    connect(w, id => exportPage(id, current(id, w.direction), null));
    assert.equal(await w.accept.pullConvChanges(peer), 20); w.clean();
    assert.equal(await hasOwnPin(cid), true, 'местный pinned_by защищает собственный общий закреп');
  };
  await scenario();
  await assert.rejects(() => scenario(inFunction('dropUnsentGroupMarks', [
    ['fromHost ? sql`${users.homeInstanceId} IS NOT NULL` : eq(users.homeInstanceId, peer),', 'sql`TRUE`,'],
  ])), killed('местный pinned_by защищает собственный общий закреп', false, true));
});
test('R217 контрфакт: перепутанная сторона fromHost оставляет старую реакцию хоста', async () => {
  const scenario = async (edit?: Mutation) => {
    const w = await fixture('from-host', edit), cid = w.groups[0];
    connect(w, id => exportPage(id, current(id, w.direction), null));
    assert.equal(await w.accept.pullConvChanges(peer), 20); w.clean();
    assert.equal(await hasPeer(cid), false, 'сторона хоста выбирает чужих владельцев снятия');
  };
  await scenario();
  await assert.rejects(() => scenario(inFunction('dropUnsentGroupMarks', [['const fromHost = c.origin === peer;', 'const fromHost = c.origin !== peer;']])),
    killed('сторона хоста выбирает чужих владельцев снятия', true, false));
});
test('R217 контрфакт: потерян prog.seen при 429 — текущая отметка первой страницы стёрта', async () => {
  await resume();
  await assert.rejects(() => resume(inFunction('fullPass', [['prog.seen = seen;', '']])),
    killed('продолжение помнит отметку уже пройденной страницы', false, true));
});
test('R217 снятие одного left_at в запросе владельцев эквивалентно: приём ещё раз отбирает действующих', async () => {
  await completed('from-host');
  const edit = inFunction('dropUnsentGroupMarks', [[
    '.where(and(eq(conversationMembers.conversationId, conversationId), isNull(conversationMembers.leftAt)));',
    '.where(eq(conversationMembers.conversationId, conversationId));',
  ]]);
  // Не выдаём отсутствие дополнительного SQL-фильтра за kill: lockFor не даёт менять бывших повторно.
  await completed('from-host', edit);
});
test('R217 контрфакт: сняты оба left_at-стража — бывший ошибочно становится владельцем снятия', async () => {
  const scenario = async (edit?: Mutation) => {
    const w = await fixture('from-host', edit), cid = w.groups[0];
    connect(w, id => exportPage(id, current(id, w.direction), null));
    assert.equal(await w.accept.pullConvChanges(peer), 20); w.clean();
    assert.equal((await people(schema.conversationMessageReactions, mid(cid, 'former'))).includes('former-peer'), true,
      'бывший участник не включается в владельцы снятия');
  };
  await scenario();
  const owners = inFunction('dropUnsentGroupMarks', [[
    '.where(and(eq(conversationMembers.conversationId, conversationId), isNull(conversationMembers.leftAt)));',
    '.where(eq(conversationMembers.conversationId, conversationId));',
  ]]);
  const admission = inFunction('lockFor', [['const live = group ? rows.filter((m) => !m.leftAt) : rows;', 'const live = rows;']]);
  await assert.rejects(() => scenario(combine(owners, admission)), killed('бывший участник не включается в владельцы снятия', false, true));
});

