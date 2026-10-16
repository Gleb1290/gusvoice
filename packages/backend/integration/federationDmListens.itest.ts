import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
const self = 'a'.repeat(32), peer = 'b'.repeat(32), third = 'c'.repeat(32), cid = 'listen-conv';
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t.close(); });
const raw = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load<T>(name: string, deps: Record<string, unknown>, mutation?: Mutation): T {
  let source = raw(name);
  if (mutation) { assert.equal(source.split(mutation[0]).length - 1, 1, 'единственный якорь whole-module мутанта'); source = source.replace(...mutation); }
  const imports: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true).statements) if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly) {
    const id = (n.moduleSpecifier as ts.StringLiteral).text;
    imports[id] = new Proxy({}, { get: (_obj, key) => key === '__esModule' ? true : () => { throw new Error(`неисполняемая граница ${id}.${String(key)}`); } });
  }
  Object.assign(imports, deps);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, Buffer, URL, Map, Set, Promise,
      require: (id: string) => { assert.ok(Object.hasOwn(imports, id), `явный импорт ${id}`); return imports[id]; } });
  return module.exports as T;
}
function voice(id: string, once = false, round = false): shared.Attachment {
  return { id, name: round ? 'round.mp4' : 'voice.ogg', contentType: round ? 'video/mp4' : 'audio/ogg', size: 10, url: '/fixture',
    durationMs: 1000, ...(round ? { round: true as const, width: 100, height: 100 } : { waveform: [50] }), ...(once ? { once: true as const } : {}) };
}
async function fixture(options: { accept?: Mutation; conv?: Mutation; changes?: Mutation } = {}) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'listen_local', displayName: 'Автор', passwordHash: 'fixture' },
    { id: 'shadow', username: 'listen_shadow', displayName: 'Сосед', passwordHash: 'fixture', homeInstanceId: peer, homeUserId: 'remote' },
    { id: 'alien', username: 'listen_alien', displayName: 'Другой дом', passwordHash: 'fixture', homeInstanceId: third, homeUserId: 'third-user' },
  ]);
  await t.db.insert(schema.conversations).values({ id: cid, kind: 'direct', directKey: `${self}:local|${peer}:remote`, createdBy: 'local' });
  await t.db.insert(schema.conversationMembers).values([{ conversationId: cid, userId: 'local' }, { conversationId: cid, userId: 'shadow' }]);
  await t.db.insert(schema.conversationMessages).values([
    { id: 'mine', conversationId: cid, authorId: 'local', sortKey: 1, content: '', attachments: [voice('mine-att')] },
    { id: 'remote', conversationId: cid, authorId: 'shadow', sortKey: 2, content: '', attachments: [voice('remote-att', true)] },
  ]);
  await t.db.update(schema.conversations).set({ lastSortKey: 2 });
  const deliveries: Array<import('../src/conversations.js').Delivery> = [], purges: string[][] = [], recorded: Array<{ kind: string; entityId: string | null }> = [];
  const changes = load<typeof import('../src/federation/convChanges.js')>('federation/convChanges', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
  }, options.changes);
  const c = load<typeof import('../src/conversations.js')>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema, './convRules.js': rules,
    './util.js': { uuidv7: randomUUID }, './attachments.js': { purgeDeleted: async (keys: string[]) => { purges.push([...keys]); } },
  }, options.conv);
  c.configureFederatedConv({ selfInstanceId: () => self, record: async (tx, items) => {
    recorded.push(...items.map(i => ({ kind: i.kind, entityId: i.entityId }))); await changes.recordFedConvChanges(tx, items);
  } });
  const accept = load<typeof import('../src/federation/convAccept.js')>('federation/convAccept', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: t.db }, '../db/schema.js': schema, '../convRules.js': rules,
    '../conversations.js': { ...c, deliver: async (d: import('../src/conversations.js').Delivery | null) => { if (d) deliveries.push(d); } },
  }, options.accept);
  accept.configureFedConvAttachments({ remoteFor: async () => { throw new Error('неисполняемый при listen remoteFor'); }, kick: () => {}, purge: keys => { purges.push([...keys]); } });
  return { c, changes, accept, deliveries, purges, recorded,
    row: async (id = 'mine') => (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, id)))[0],
    users: async (id = 'mine') => (await t.db.select().from(schema.conversationVoiceListens).where(orm.eq(schema.conversationVoiceListens.messageId, id))).map(x => x.userId).sort(),
    apply: async (id = 'mine', spent = false, listeners: shared.FedPersonRef[] = [{ instanceId: peer, userId: 'remote' }]) =>
      accept.applyChange(peer, self, shared.FED_CONV_CHANGE_E2.listen, cid, shared.serializeConvListenWire({ messageId: id, spent, listeners })),
  };
}
async function attach(f: Awaited<ReturnType<typeof fixture>>, id: string, once: boolean, round = false, state: 'attached' | 'remote' = 'attached') {
  const owner = id === 'mine' ? 'local' : 'shadow';
  await t.db.update(schema.conversationMessages).set({ attachments: [voice(`${id}-att`, once, round)], content: '' }).where(orm.eq(schema.conversationMessages.id, id));
  await t.db.insert(schema.attachments).values({ id: `${id}-att`, conversationId: cid, ownerId: owner, messageId: id,
    storageKey: `${id}-key`, name: 'voice.ogg', contentType: 'audio/ogg', size: 10, state, ...(state === 'remote' ? { originInstanceId: peer } : {}) });
  assert.equal((await f.row(id)).attachments[0].once === true, once);
}
test('R196 listen заменяет только слушателей соседа, автора и чужие ссылки игнорирует; повтор и чужое сообщение без событий', async () => {
  // Класс ошибки: сосед подделывает прослушивание автора или повторно будит уже прочитавшие устройства.
  const f = await fixture();
  await t.db.insert(schema.conversationVoiceListens).values([{ messageId: 'mine', userId: 'local' }, { messageId: 'mine', userId: 'alien' }]);
  await f.apply('mine', false, [{ instanceId: peer, userId: 'remote' }, { instanceId: self, userId: 'local' }, { instanceId: third, userId: 'third-user' }]);
  assert.deepEqual(await f.users(), ['alien', 'local', 'shadow']);
  assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].pts.has('local'), true);
  const before = (await t.db.select().from(schema.userChanges)).length;
  await f.apply(); assert.equal(f.deliveries.length, 1); assert.equal((await t.db.select().from(schema.userChanges)).length, before);
  await f.apply('remote'); assert.deepEqual(await f.users('remote'), []); assert.equal(f.deliveries.length, 1);
  await f.apply('mine', false, []); assert.deepEqual(await f.users(), ['alien', 'local']); assert.equal(f.deliveries.length, 2);
  assert.equal(f.recorded.length, 0, 'приём listen не пишет эхо на связку');
});
test('R196 блокировка автора исключает его из доставки listen, но строка слушателя сохраняется', async () => {
  // Класс ошибки: квитанция реакции будит человека, который заблокировал собеседника.
  const f = await fixture();
  await t.db.insert(schema.userBlocks).values({ blockerId: 'local', blockedId: 'shadow' });
  await f.apply(); assert.deepEqual(await f.users(), ['shadow']);
  assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].pts.has('local'), false); assert.equal(f.deliveries[0].pts.has('shadow'), true);
});
async function spendScenario(once: boolean, spent: boolean, round = false, mutation?: Mutation) {
  const f = await fixture({ accept: mutation }); await attach(f, 'mine', once, round); await f.apply('mine', spent);
  const row = await f.row(), expected = once && spent;
  assert.equal(row.onceSpentAt !== null, expected, 'трата требует spent и once одновременно');
  assert.equal(row.attachments.length, expected ? 0 : 1);
  assert.equal(row.content, expected ? (round ? shared.ROUND_ONCE_SPENT_TEXT : shared.VOICE_ONCE_SPENT_TEXT) : '');
  const att = (await t.db.select().from(schema.attachments))[0];
  assert.equal(att.state, expected ? 'deleted' : 'attached');
  assert.deepEqual(f.purges, expected ? [['mine-key']] : []);
  if (expected) {
    const deliveries = f.deliveries.length, journal = (await t.db.select().from(schema.userChanges)).length;
    await f.apply('mine', true); assert.equal(f.deliveries.length, deliveries); assert.equal((await t.db.select().from(schema.userChanges)).length, journal);
  }
  assert.equal(f.recorded.length, 0, 'приём одноразового не пишет эхо');
}
for (const [once, spent, round] of [[true, true, false], [true, true, true], [true, false, false], [false, true, false]] as const) {
  test(`R196 once=${once} spent=${spent} ${round ? 'кружок' : 'голосовое'} гасится только при двух разрешениях`, async () => {
    // Класс ошибки: квитанция прослушивания обычного файла необратимо удаляет его или забывает одноразовый кружок.
    await spendScenario(once, spent, round);
  });
}
for (const [name, once, spent, anchor, replacement] of [
  ['нет spent', true, false, 'w.spent === true && want.size > 0', 'want.size > 0'],
  ['нет once', false, true, 'a.once === true && isListenable(a)', 'isListenable(a)'],
] as const) test(`R196 контрфакт «${name}» не может тратить оригинал по неполной квитанции`, async () => {
  // Класс ошибки: whole-module мутант обязан падать на денежно-независимом факте удаления, не loader.
  await spendScenario(once, spent);
  await assert.rejects(spendScenario(once, spent, false, [anchor, replacement]), e => e instanceof assert.AssertionError && e.message.includes('трата требует spent и once'));
});
test('R196 отказ чужому дому сохраняется даже при лишней legacy-строке участника 1:1', async () => {
  // Defence-in-depth: намеренно испорченная direct membership, НЕ допустимый пользовательский ЛС из трёх человек.
  async function scenario(mutation?: Mutation) {
    const f = await fixture({ accept: mutation });
    await t.db.insert(schema.conversationMembers).values({ conversationId: cid, userId: 'alien' });
    await f.apply('mine', false, [{ instanceId: third, userId: 'third-user' }]);
    assert.deepEqual(await f.users(), [], 'дом слушателя обязан совпасть с отправителем даже при лишнем участнике');
  }
  await scenario();
  const anchor = 'for (const u of w.listeners) {\n      if (u.instanceId !== peer) continue;';
  await assert.rejects(scenario([anchor, 'for (const u of w.listeners) {']), e => e instanceof assert.AssertionError && e.message.includes('дом слушателя обязан совпасть'));
});
test('R196 fed:true в приёме listen обнаруживается настоящим журналом связки', async () => {
  // Класс ошибки: авторский журнал копии начинает бесконечно переотдавать квитанцию соседу.
  async function scenario(mutation?: Mutation) {
    const f = await fixture({ accept: mutation }); await f.apply();
    assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 0, 'listen от соседа не создаёт эхо');
  }
  await scenario();
  const anchor = 'const pts = await journal(tx, msgEntries(audience, conversationId, m.id), { fed: false });\n    delivery = { conversationId, messageId: m.id, pts };\n  });\n  if (purge.length > 0) attHooks?.purge(purge);';
  await assert.rejects(scenario([anchor, anchor.replace('fed: false', 'fed: true')]), e => e instanceof assert.AssertionError && e.message.includes('listen от соседа не создаёт эхо'));
});
async function localListen(spend: boolean, mutation?: Mutation) {
  const f = await fixture({ conv: mutation }); await attach(f, 'remote', true, false, 'remote');
  const access = (await f.c.loadAccess(cid, 'local'))!;
  const result = spend ? await f.c.spendVoiceOnce('local', access, 'remote') : await f.c.listenVoice('local', access, 'remote', new Set());
  assert.equal(result.kind, 'ok');
  assert.equal(f.recorded.some(r => r.kind === shared.FED_CONV_CHANGE_E2.listen && r.entityId === 'remote'), true, 'своё прослушивание записывает listen для дома автора');
  const count = f.recorded.length;
  if (spend) {
    assert.equal((await t.db.select().from(schema.attachments))[0].state, 'deleted', 'одноразовая remote-копия стирается до скачивания');
    assert.equal((await f.row('remote')).onceSpentAt !== null, true);
    await f.c.spendVoiceOnce('local', access, 'remote');
  } else await f.c.listenVoice('local', access, 'remote', new Set());
  assert.equal(f.recorded.length, count, 'повтор не пишет запись');
}
for (const spend of [false, true]) {
  test(`R196 ${spend ? 'spendVoiceOnce' : 'listenVoice'} пишет listen для соседа, повтор не пишет`, async () => {
    // Класс ошибки: человек слышит голосовое, но автор на другом инстансе не узнаёт о прослушивании.
    await localListen(spend);
  });
  test(`R196 удаление fedRecord из ${spend ? 'траты' : 'прослушивания'} обнаруживается в реальном журнале`, async () => {
    // Класс ошибки: один из путей забывает нужную квитанцию, хотя локальные события остаются.
    await localListen(spend);
    const source = raw('conversations'), name = spend ? 'spendVoiceOnce' : 'listenVoice';
    const tree = ts.createSourceFile('conversations', source, ts.ScriptTarget.Latest, true);
    const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)!;
    const body = fn.getText(tree), guard = 'await fedRecord(tx, [{ conversationId, kind: FED_CONV_CHANGE_E2.listen, entityId: messageId }]);';
    assert.equal(body.split(guard).length - 1, 1);
    await assert.rejects(localListen(spend, [body, body.replace(guard, '// квитанция удалена')]), e => e instanceof assert.AssertionError && e.message.includes('своё прослушивание записывает listen'));
  });
}
test('R196 старый attached-only фильтр не оставляет одноразовую remote-копию доступной', async () => {
  // Класс ошибки: медленный файл продолжает скачиваться после завершённого одноразового просмотра.
  await localListen(true);
  const source = raw('conversations'), tree = ts.createSourceFile('conversations', source, ts.ScriptTarget.Latest, true);
  const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'spendVoiceOnce')!;
  const body = fn.getText(tree), filter = "inArray(attachments.state, ['attached', 'remote'])";
  assert.equal(body.split(filter).length - 1, 1);
  await assert.rejects(localListen(true, [body, body.replace(filter, "eq(attachments.state, 'attached')")]), e => e instanceof assert.AssertionError && e.message.includes('одноразовая remote-копия стирается'));
});

async function collected(mutation?: Mutation) {
  const f = await fixture({ changes: mutation });
  await t.db.insert(schema.conversationVoiceListens).values([
    { messageId: 'mine', userId: 'local' }, { messageId: 'mine', userId: 'shadow' }, { messageId: 'mine', userId: 'alien' },
    { messageId: 'remote', userId: 'local' }, { messageId: 'remote', userId: 'shadow' },
  ]);
  await t.db.update(schema.conversationMessages).set({ onceSpentAt: new Date() }).where(orm.eq(schema.conversationMessages.id, 'remote'));
  await t.db.transaction(tx => f.changes.recordFedConvChanges(tx as never, ['mine', 'remote'].map(id => ({
    conversationId: cid, kind: shared.FED_CONV_CHANGE_E2.listen, entityId: id,
  }))));
  const page = await f.changes.changesForPeer(peer, 0, 100, self);
  assert.ok('items' in page);
  for (const id of ['mine', 'remote']) {
    const entity: Record<string, unknown> | null | undefined = page.items.find(x => x.entityId === id)?.entity;
    const heard = shared.parseConvListenWire(entity);
    assert.ok(heard);
    assert.deepEqual(heard.listeners.map(p => `${p.instanceId}:${p.userId}`), [`${self}:local`], 'сборщик отдаёт только местных слушателей');
    assert.equal(heard.spent === true, id === 'remote', 'spent берётся из once_spent_at, не из наличия слушателей');
    assert.equal(Object.hasOwn(entity!, 'spent'), id === 'remote');
  }
}
test('R196 сборщик listen отдаёт местных людей и spent только потраченной копии', async () => {
  // Класс ошибки владения: квитанции теневых людей не являются состоянием нашего дома.
  await collected();
});
async function listenLinkGate(mutation?: Mutation) {
  const f = await fixture({ changes: mutation });
  await t.db.insert(schema.conversationVoiceListens).values({ messageId: 'mine', userId: 'local' });
  await t.db.transaction(tx => f.changes.recordFedConvChanges(tx as never, [
    { conversationId: cid, kind: shared.FED_CONV_CHANGE.msg, entityId: 'mine' },
    { conversationId: cid, kind: shared.FED_CONV_CHANGE_E2.listen, entityId: 'mine' },
  ]));
  const check = async (expected: boolean, label: string) => {
    const page = await f.changes.changesForPeer(peer, 0, 100, self); assert.ok('items' in page);
    assert.equal(page.items.some(row => row.kind === shared.FED_CONV_CHANGE.msg), true, 'гейт listen не убирает обычное сообщение');
    assert.equal(page.items.some(row => row.kind === shared.FED_CONV_CHANGE_E2.listen), expected, label);
    if (expected) {
      const listen = shared.parseConvListenWire(page.items.find(row => row.kind === shared.FED_CONV_CHANGE_E2.listen)?.entity);
      assert.ok(listen); assert.equal(listen.messageId, 'mine'); assert.equal(listen.listeners[0].userId, 'local');
    }
  };
  await check(true, 'без строки связки прежний сборщик отдаёт listen');
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: 'peer.invalid', apiBase: 'https://peer.invalid/api',
    clientOrigin: 'https://peer.invalid', rootKey: 'fixture-root', state: 'active', features: ['dm1'] });
  await check(false, 'строка связки без dm2once закрывает listen');
  await t.db.update(schema.federationLinks).set({ features: ['dm1', 'dm2once'] });
  await check(true, 'dm2once открывает listen той же строки журнала');
}
test('R203 отсутствие связки сохраняет listen R196, существующая связка требует dm2once с парным принятием', async () => {
  await listenLinkGate();
});
for (const [name, replacement, target] of [
  ['фильтр даже без связки', 'picked = all.filter((r) => !KIND_FEATURE[r.kind] || has.has(KIND_FEATURE[r.kind] as string));', 'без строки связки прежний сборщик отдаёт listen'],
  ['фильтр связки потерян', 'picked = all;', 'строка связки без dm2once закрывает listen'],
] as const) test(`R203 мутант «${name}» ловится одним реальным журналом и сменой признаков связки`, async () => {
  await listenLinkGate();
  await assert.rejects(listenLinkGate([
    'if (link) picked = all.filter((r) => !KIND_FEATURE[r.kind] || has.has(KIND_FEATURE[r.kind] as string));', replacement,
  ]), e => e instanceof assert.AssertionError && e.message.includes(target));
});
for (const [name, anchor, replacement, target] of [
  ['теневые слушатели', 'and(inArray(conversationVoiceListens.messageId, listenIds), isNull(users.homeInstanceId))', 'inArray(conversationVoiceListens.messageId, listenIds)', 'сборщик отдаёт только местных'],
  ['spent всегда true', 'spent: spent.has(r.entityId),', 'spent: true,', 'spent берётся из once_spent_at'],
] as const) test(`R196 контрфакт сборщика «${name}» ловится настоящим SQL-проводом`, async () => {
  // Класс ошибки: сборщик не может присваивать чужие квитанции или объявлять траченным обычный файл.
  await collected();
  await assert.rejects(collected([anchor, replacement]), e => e instanceof assert.AssertionError && e.message.includes(target));
});
async function exportListens(mutation?: Mutation) {
  const f = await fixture({ changes: mutation });
  // Лишняя self-listen строка — legacy/повреждённое состояние; отбор владельца должен оставаться самостоятельным.
  await t.db.insert(schema.conversationVoiceListens).values([
    { messageId: 'mine', userId: 'local' }, { messageId: 'remote', userId: 'local' }, { messageId: 'remote', userId: 'shadow' },
  ]);
  const page = await f.changes.exportForPeer(peer, cid, null, self); assert.ok(page);
  const listens = page.items.filter(x => x.kind === shared.FED_CONV_CHANGE_E2.listen);
  assert.deepEqual([...listens].map(x => x.entityId), ['remote'], 'экспорт listen только сообщения соседа с нашим слушателем');
  for (const id of ['mine', 'remote']) assert.equal(page.items.filter(x => x.entityId === id).length <= 2, true, 'не больше двух строк на сообщение');
  const message = await f.row('remote');
  const wire = f.changes.toWireMessage(message, new Map([['shadow', { id: 'shadow', homeInstanceId: peer, homeUserId: 'remote' }]]), self);
  assert.equal(wire.attachments[0]?.once, true, 'SQL-сериализатор сохраняет once');
  await t.db.delete(schema.conversationVoiceListens).where(orm.eq(schema.conversationVoiceListens.userId, 'local'));
  const empty = await f.changes.exportForPeer(peer, cid, null, self); assert.ok(empty);
  assert.equal(empty.items.some(x => x.kind === shared.FED_CONV_CHANGE_E2.listen), false, 'одни теневые слушатели не рождают экспорт listen');
}
test('R196 экспорт listen только для сообщений соседа с местными слушателями, once и предел двух строк сохранены', async () => {
  // Класс ошибки полного восстановления: собственный msg плюс react плюс listen выходит за предел wire-страницы.
  await exportListens();
});
test('R196 экспорт собственных listen обнаруживается даже при legacy self-listen строке', async () => {
  // Класс ошибки: два независимых отбора владельца нельзя убрать одновременно, иначе экспорт выдаёт третий тип строки.
  await exportListens();
  const source = raw('federation/convChanges'), tree = ts.createSourceFile('convChanges', source, ts.ScriptTarget.Latest, true);
  const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'exportForPeer')!;
  const body = fn.getText(tree);
  const first = 'page.filter((m) => m.home === instanceId && !m.deletedAt && !m.withheld)',
    second = 'if (!m.deletedAt && !m.withheld && m.home === instanceId && heard.has(m.id))';
  assert.equal(body.split(first).length - 1, 1); assert.equal(body.split(second).length - 1, 1);
  const replacement = body.replace(first, 'page.filter((m) => !m.deletedAt && !m.withheld)')
    .replace(second, 'if (!m.deletedAt && !m.withheld && heard.has(m.id))');
  await assert.rejects(exportListens([body, replacement]), e => e instanceof assert.AssertionError && e.message.includes('экспорт listen только сообщения соседа'));
});
