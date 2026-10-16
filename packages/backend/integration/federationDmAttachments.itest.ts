import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Mutation = readonly [string, string];
const peer = 'b'.repeat(32), self = 'a'.repeat(32), otherHome = 'c'.repeat(32), cid = 'fed-files';
const aid = '10000000-0000-4000-8000-000000000001';
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t.close(); });
const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function replace(raw: string, mutation: Mutation) {
  assert.equal(raw.split(mutation[0]).length - 1, 1, 'единственный якорь'); return raw.replace(...mutation);
}
function moduleOf<T>(name: string, deps: Record<string, unknown>, mutation?: Mutation): T {
  const raw = mutation ? replace(source(name), mutation) : source(name), imports: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true).statements)
    if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly) {
      const id = (n.moduleSpecifier as ts.StringLiteral).text;
      imports[id] = new Proxy({}, { get: (_t, key) => key === '__esModule' ? true : () => { throw new Error(`запрещённая граница ${id}.${String(key)}`); } });
    }
  Object.assign(imports, deps);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, console,
      require: (id: string) => { assert.equal(Object.hasOwn(imports, id), true, `явный импорт ${id}`); return imports[id]; } });
  return module.exports as T;
}
const ddl = () => readFileSync(new URL('../drizzle/0138_fed_att_quota.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
async function fixture(options: { conv?: Mutation; att?: Mutation; accept?: Mutation; ddl?: Mutation; refreshed?: string[] } = {}) {
  await truncateAll(t.raw); await t.raw.exec(options.ddl ? replace(ddl(), options.ddl) : ddl());
  await t.raw.query(`INSERT INTO users(id,username,display_name,password_hash,verified,approved_at,home_instance_id,home_user_id,home_username)
    VALUES ('local','dmtest_local','Местный','hash',true,now(),NULL,NULL,NULL),
      ('other','dmtest_other','Другой','hash',true,now(),NULL,NULL,NULL),
      ('shadow','dmtest_shadow','Удалённый','hash',true,now(),$1,'remote','dmtest_remote')`, [peer]);
  await t.raw.query(`INSERT INTO federation_links(instance_id,domain,api_base,client_origin,root_key,state,features,used_bytes,quota_bytes)
    VALUES ($1,'peer.invalid','https://peer.invalid/api','https://peer.invalid','fixture-root','active','["dm2"]',0,0)`, [peer]);
  const serialize = moduleOf<typeof import('../src/serialize.js')>('serialize', {
    '@gusvoice/shared': shared, './env.js': { env: {} }, './linkThreats.js': { dangerousLinksOf: () => [] },
    './federation/instanceLabels.js': { instanceLabel: (id: string) => ({ instanceId: id, name: 'Сосед', domain: 'peer.invalid', reports: false }) },
  });
  const purged: string[] = [], deliveries: unknown[] = [], kicks: string[] = [], refreshes: string[] = [];
  const c = moduleOf<typeof import('../src/conversations.js')>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './convRules.js': rules, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './util.js': { uuidv7: randomUUID }, './env.js': { env: {} }, './serialize.js': serialize, './dmWriteBarrier.js': { dmWriteBarrier: {} },
    './attachments.js': { purgeDeleted: async (keys: string[]) => { purged.push(...keys); },
      attachmentLink: (id: string, me: string, generation: number) => `/fixture-att/${id}?viewer=${me}&gen=${generation}` },
  }, options.conv);
  c.configureFederatedConv({ selfInstanceId: () => self, record: null });
  await c.createDirect('local', 'shadow', { id: cid, originInstanceId: self });
  await c.createDirect('local', 'other', { id: 'other-conv', originInstanceId: self });
  await t.raw.query("INSERT INTO conversation_messages(id,conversation_id,author_id,sort_key,content) VALUES ('ours',$1,'local',1,'Наше'),('other-msg','other-conv','local',1,'Другое')", [cid]);
  const att = moduleOf<typeof import('../src/federation/convAtt.js')>('federation/convAtt', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../conversations.js': { ...c, deliver: async (d: unknown) => { if (d) deliveries.push(d); } }, '../convRules.js': rules,
    '../attachmentRules.js': await import('../src/attachmentRules.js'), '../safeFetch.js': { PEER_MAX_ATT_BYTES: 25 * 1024 * 1024 },
    './directorySync.js': { refreshCapabilities: async (link: { instanceId: string; features: string[] }) => { refreshes.push(link.instanceId); return options.refreshed ?? link.features; } },
  }, options.att);
  const accept = moduleOf<typeof import('../src/federation/convAccept.js')>('federation/convAccept', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: t.db }, '../db/schema.js': schema, '../convRules.js': rules,
    '../conversations.js': { ...c, deliver: async (d: unknown) => { if (d) deliveries.push(d); } }, '../convSendFanout.js': { fanOutSend: async () => {} },
  }, options.accept);
  const hooks = { remoteFor: att.remoteAttachmentsFor, kick: (origin: string) => { kicks.push(origin); }, purge: (keys: readonly string[]) => { purged.push(...keys); } };
  accept.configureFedConvAttachments(hooks);
  return { c, att, accept, hooks, purged, deliveries, kicks, refreshes };
}
async function attachment(values: Partial<typeof schema.attachments.$inferInsert> = {}) {
  await t.db.insert(schema.attachments).values({ id: aid, conversationId: cid, ownerId: 'local', messageId: 'ours', storageKey: `dm/${aid}`, name: 'fixture.bin', contentType: 'application/octet-stream', size: 10, state: 'attached', ...values });
}
const fileWire = (id = aid): shared.FedConvAttachmentWire => ({ id, name: 'remote.bin', contentType: 'application/octet-stream', size: 10,
  width: null, height: null, durationMs: null, waveform: null, asFile: false, spoiler: false, sha256: null });
function messageWire(overrides: Partial<shared.FedConvMessageWire> = {}) {
  return shared.serializeConvMessageWire({ id: 'incoming', conversationId: cid, author: { instanceId: peer, userId: 'remote' }, clientId: null, payloadHash: null,
    createdAt: 1, originSortKey: 1, content: '', replyToId: null, forwardedFrom: null, silent: false, noPreview: false, captionAbove: false,
    replyQuote: null, sticker: null, service: null, attachments: [fileWire()], editVersion: 0, editedAt: null, deleted: false, ...overrides });
}
const exportCases = [
  ['не attached', async () => { await t.raw.query("UPDATE attachments SET state='pending' WHERE id=$1", [aid]); }, "eq(attachments.state, 'attached'),", 'undefined,'],
  ['копия чужого', async () => { await t.raw.query('UPDATE attachments SET origin_instance_id=$1 WHERE id=$2', [peer, aid]); }, 'isNull(attachments.originInstanceId),', 'undefined,'],
  ['владелец тень', async () => { await t.raw.query("UPDATE attachments SET owner_id='shadow' WHERE id=$1", [aid]); }, 'isNull(users.homeInstanceId),', 'undefined,'],
  ['другая беседа сообщения', async () => { await t.raw.query("UPDATE attachments SET message_id='other-msg' WHERE id=$1", [aid]); }, 'eq(conversationMessages.conversationId, attachments.conversationId),', 'undefined,'],
  ['надгробие сообщения', async () => { await t.raw.exec("UPDATE conversation_messages SET deleted_at=now() WHERE id='ours'"); }, 'isNull(conversationMessages.deletedAt),', 'undefined,'],
  ['участник другого дома', async () => { await t.raw.query("UPDATE users SET home_instance_id=$1 WHERE id='shadow'", [otherHome]); }, 'pu.home_instance_id = ${peer}', 'pu.home_instance_id IS NOT NULL'],
] as const;
async function exportScenario(changeRow: () => Promise<void>, mutation?: Mutation) {
  const f = await fixture({ att: mutation }); await attachment();
  assert.equal((await f.att.fedAttachmentForPeer(peer, aid))?.id, aid, 'правильный оригинал выдаётся соседу');
  await changeRow();
  assert.equal(await f.att.fedAttachmentForPeer(peer, aid), null, 'несоответствующий файл соседу не выдаётся');
}
for (const [label, changeRow, from, to] of exportCases) test(`R194 отдача файла: ${label} отклоняется, снятие условия обнаруживается реальным SQL`, async () => {
  // Класс ошибки доступа: каждый conjunct нужен самостоятельно, валидный оригинал проходит тем же сценарием.
  await exportScenario(changeRow);
  // Такой же conjunct есть в markCopied: выбираем AST-тело именно отдачи, а не снимаем обе независимые проверки.
  const raw = source('federation/convAtt'), tree = ts.createSourceFile('convAtt.ts', raw, ts.ScriptTarget.Latest, true);
  const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'fedAttachmentForPeer') as ts.FunctionDeclaration;
  assert.ok(fn?.body, 'функция отдачи найдена');
  const body = fn.body.getText(tree);
  assert.equal(body.split(from).length - 1, 1, 'один conjunct в выдаче');
  await assert.rejects(exportScenario(changeRow, [body, body.replace(from, to)]), e => e instanceof assert.AssertionError && e.message.includes('несоответствующий файл'));
});
test('R194 неизвестный файл и отсутствие участника спрашивающего дома не дают оригинал', async () => {
  // Класс ошибки доступа: существующий id и старое членство не заменяют нынешнего собеседника этого дома.
  const f = await fixture(); await attachment();
  assert.equal(await f.att.fedAttachmentForPeer(peer, 'missing'), null);
  assert.equal((await f.att.fedAttachmentForPeer(peer, aid))?.id, aid);
  await t.raw.exec("DELETE FROM conversation_members WHERE conversation_id='fed-files' AND user_id='shadow'");
  assert.equal(await f.att.fedAttachmentForPeer(peer, aid), null);
});
test('R194 снятие EXISTS участника обнаруживается выдачей оригинала после настоящего удаления членства', async () => {
  // Класс ошибки доступа: право спрашивающего дома выводится из нынешнего SQL-членства, не из знания id файла.
  const remove = async () => { await t.raw.exec("DELETE FROM conversation_members WHERE conversation_id='fed-files' AND user_id='shadow'"); };
  await exportScenario(remove);
  await assert.rejects(exportScenario(remove, [
    'sql`EXISTS (SELECT 1 FROM ${conversationMembers} cm JOIN ${users} pu ON pu.id = cm.user_id\n          WHERE cm.conversation_id = ${attachments.conversationId} AND pu.home_instance_id = ${peer})`',
    'sql`true`',
  ]), e => e instanceof assert.AssertionError && e.message.includes('несоответствующий файл'));
});
async function hostGroupCopy(mutation?: Mutation) {
  const f = await fixture({ att: mutation });
  await attachment({ ownerId: 'shadow', originInstanceId: peer });
  await t.db.update(schema.conversationMessages).set({ authorId: 'shadow' }).where(orm.eq(schema.conversationMessages.id, 'ours'));
  assert.equal(await f.att.fedAttachmentForPeer(peer, aid), null, 'личка не отдаёт копию чужого файла');
  await t.db.update(schema.conversations).set({ kind: 'group', directKey: null, originInstanceId: otherHome }).where(orm.eq(schema.conversations.id, cid));
  assert.equal(await f.att.fedAttachmentForPeer(peer, aid), null, 'копия чужой группы не раздаёт файл вместо хоста');
  await t.db.update(schema.conversations).set({ originInstanceId: null }).where(orm.eq(schema.conversations.id, cid));
  const allowed = await f.att.fedAttachmentForPeer(peer, aid);
  assert.equal(allowed?.id, aid, 'наш хост группы отдаёт скопированный файл чужого автора');
  assert.equal(allowed?.originInstanceId, peer); assert.equal(allowed?.ownerId, 'shadow');
  assert.equal(await f.att.fedAttachmentForPeer(otherHome, aid), null, 'знание id без человека спрашивающего дома не открывает файл');
  await t.db.insert(schema.users).values({ id: 'third-shadow', username: 'files_third_shadow', displayName: 'Третий участник',
    passwordHash: 'fixture', homeInstanceId: otherHome, homeUserId: 'third-remote' });
  await t.db.insert(schema.conversationMembers).values({ conversationId: cid, userId: 'third-shadow' });
  assert.equal((await f.att.fedAttachmentForPeer(otherHome, aid))?.id, aid, 'третий дом участника берёт чужую копию у нашего хоста');
  await t.db.update(schema.attachments).set({ state: 'remote' }).where(orm.eq(schema.attachments.id, aid));
  assert.equal(await f.att.fedAttachmentForPeer(peer, aid), null, 'хост не обещает ещё не скопированные байты');
  await t.db.update(schema.attachments).set({ state: 'attached' }).where(orm.eq(schema.attachments.id, aid));
  await t.db.update(schema.conversationMessages).set({ deletedAt: new Date() }).where(orm.eq(schema.conversationMessages.id, 'ours'));
  assert.equal(await f.att.fedAttachmentForPeer(peer, aid), null, 'власть хоста не открывает надгробие сообщения');
}
test('R203 скопированный файл чужого автора раздаёт только наш хост группы, остальные условия доступа сохранены', async () => {
  await hostGroupCopy();
});
test('R203 потеря групповой ветки OR ловится разрешённой копией, а не ошибкой загрузчика', async () => {
  await hostGroupCopy();
  const raw = source('federation/convAtt'), tree = ts.createSourceFile('convAtt.ts', raw, ts.ScriptTarget.Latest, true);
  const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'fedAttachmentForPeer') as ts.FunctionDeclaration;
  assert.ok(fn?.body); const body = fn.body.getText(tree); const choices: ts.CallExpression[] = [];
  function visit(n: ts.Node) { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'or') choices.push(n); ts.forEachChild(n, visit); }
  visit(fn.body); assert.equal(choices.length, 1, 'единственный OR у отдачи файла');
  const branch = choices[0]; assert.equal(branch.arguments.length, 2);
  await assert.rejects(hostGroupCopy([body, body.replace(branch.getText(tree), branch.arguments[0].getText(tree))]),
    e => e instanceof assert.AssertionError && e.message.includes('наш хост группы отдаёт скопированный файл'));
});
for (const mode of ['dm2', 'no-dm2', 'no-hook'] as const) test(`R194 приём вложения ${mode}: ${mode === 'dm2' ? 'создаёт remote без заглушки' : 'сохраняет заглушку без строк файла'}`, async () => {
  // Класс ошибки feature-gate: метаданные файла не означают поддержку отдачи байтов соседом.
  const f = await fixture();
  if (mode === 'no-dm2') await t.raw.exec("UPDATE federation_links SET features='[\"dm1\"]'");
  if (mode === 'no-hook') f.accept.configureFedConvAttachments(null);
  await f.accept.applyChange(peer, self, 'msg', cid, messageWire());
  const msg = (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, 'incoming')))[0];
  const rows = await t.db.select().from(schema.attachments);
  assert.equal(rows.length, mode === 'dm2' ? 1 : 0);
  assert.equal(msg.content, mode === 'dm2' ? '' : f.accept.FED_ATTACHMENTS_LATER_TEXT);
  if (mode === 'dm2') {
    assert.equal(rows[0].state, 'remote'); assert.equal(rows[0].ownerId, 'shadow'); assert.equal(rows[0].originInstanceId, peer);
    assert.equal(msg.attachments[0].fedState, 'copying'); assert.equal(f.kicks.length, 1);
  }
});
async function noCapability(mutation?: Mutation) {
  const f = await fixture({ accept: mutation }); await t.raw.exec("UPDATE federation_links SET features='[\"dm1\"]'");
  await f.accept.applyChange(peer, self, 'msg', cid, messageWire());
  assert.equal((await t.db.select().from(schema.attachments)).length, 0, 'без dm2 строки remote не создаются');
}
async function retryFiles(mutation?: Mutation) {
  const f = await fixture({ accept: mutation }); await t.raw.exec("UPDATE federation_links SET features='[\"dm1\"]'");
  await assert.rejects(() => f.accept.applyChange(peer, self, 'msg', cid, messageWire(), { lastTry: false }),
    e => (e as Error)?.constructor?.name === 'NeedsFilesFeature' && (e as Error).message.includes('нет dm2'),
    'первая попытка удерживает вложение до обновления dm2');
  assert.equal((await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, 'incoming'))).length, 0, 'неудачная попытка не оставляет копию');
  assert.equal((await t.db.select().from(schema.attachments)).length, 0);
  await f.accept.applyChange(peer, self, 'msg', cid, messageWire(), { lastTry: true });
  const [msg] = await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, 'incoming'));
  assert.equal(msg.content, f.accept.FED_ATTACHMENTS_LATER_TEXT); assert.equal(msg.attachments.length, 0);
}
test('R201 вложение без dm2 удерживает курсор на ранней попытке и получает заглушку только на последней', () => {
  // Класс ошибки: кратковременно устаревшие capabilities превращают нормальный файл в вечную текстовую заглушку.
  return retryFiles();
});
test('R201 потеря NeedsFilesFeature обнаруживается копией, созданной слишком рано', async () => {
  await retryFiles();
  await assert.rejects(() => retryFiles([
    'if (!files && !!attHooks && !sticker && !service && w.attachments.length > 0 && !lastTry)', 'if (false)',
  ]), e => e instanceof assert.AssertionError && e.message.includes('первая попытка удерживает вложение'));
});

async function thumbs(mutation?: Mutation) {
  for (const state of [undefined, 'copying', 'remote'] as const) {
    const f = await fixture({ conv: mutation });
    const photo = { id: aid, url: '/fixture-photo', name: 'photo.png', contentType: 'image/png', size: 10, width: 100, height: 100, spoiler: true as const, ...(state ? { fedState: state } : {}) };
    await t.db.update(schema.conversationMessages).set({ attachments: [photo] }).where(orm.eq(schema.conversationMessages.id, 'ours'));
    await t.db.insert(schema.conversationPins).values({ conversationId: cid, userId: 'local', messageId: 'ours', pinnedBy: 'local', forBoth: true });
    const summary = (await f.c.listConversations('local')).conversations.find(c => c.id === cid)!;
    assert.equal(summary !== undefined, true); assert.equal(summary.lastMessage !== null, true);
    const pins = await f.c.listPins('local', cid); assert.equal(pins !== null, true); assert.equal(pins!.pins.length, 1);
    for (const item of [summary.lastMessage!, pins!.pins[0]]) {
      assert.equal(Object.hasOwn(item, 'thumb'), state === undefined, 'copying и remote не получают миниатюру');
      assert.equal(Object.hasOwn(item, 'thumbSpoiler'), state === undefined, 'spoiler миниатюры отсутствует вместе с ней');
      if (state === undefined) assert.equal((item as { thumb?: string }).thumb, `/fixture-att/${aid}?viewer=local&gen=0`);
    }
  }
}
test('R201 список бесед и закрепы скрывают thumb у copying и remote, готовое фото сохраняет подписанную миниатюру', () => {
  // Класс ошибки: клиент открывает заведомо 503-ссылку из превью копии, которая ещё не готова.
  return thumbs();
});
for (const [name, anchor, replacement] of [
  ['lastThumb', 'first.fedState !== undefined', 'false'], ['pinsFor', ' && !first.fedState', ''],
] as const) test(`R201 снятие fedState в ${name} обнаруживается преждевременной миниатюрой`, async () => {
  await thumbs();
  const raw = source('conversations'), tree = ts.createSourceFile('conversations.ts', raw, ts.ScriptTarget.Latest, true);
  const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name) as ts.FunctionDeclaration;
  assert.ok(fn?.body); const body = fn.body.getText(tree); assert.equal(body.split(anchor).length - 1, 1, 'уникальный guard миниатюры');
  await assert.rejects(() => thumbs([body, body.replace(anchor, replacement)]), e => e instanceof assert.AssertionError && e.message.includes('copying и remote не получают'));
});
test('R194 снятие проверки dm2 обнаруживается лишней строкой remote', async () => {
  // Класс ошибки feature-gate: частичный протокол соседа не должен запускать копирование неотдаваемого файла.
  await noCapability();
  await assert.rejects(noCapability(['&& !!peerLink?.features.includes(FED_FEATURES.dm2)', '']), e => e instanceof assert.AssertionError && e.message.includes('без dm2 строки'));
});
test('R194 id вложения, занятый местным оригиналом, не перезаписывается копией', async () => {
  // Класс ошибки коллизии: чужой id не является правом переписать владельца, storageKey или размер.
  const f = await fixture(); await attachment();
  await f.accept.applyChange(peer, self, 'msg', cid, messageWire());
  const rows = await t.db.select().from(schema.attachments);
  assert.equal(rows.length, 1); assert.equal(rows[0].ownerId, 'local'); assert.equal(rows[0].state, 'attached'); assert.equal(rows[0].originInstanceId, null);
  assert.equal((await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, 'incoming')))[0].attachments.length, 0);
});
for (const path of ['tombstone', 'one', 'batch'] as const) {
  async function erase(mutation?: Mutation) {
    const f = await fixture(path === 'tombstone' ? { accept: mutation } : { conv: mutation });
    await f.accept.applyChange(peer, self, 'msg', cid, messageWire({ content: 'Копия' }));
    if (path === 'tombstone') await f.accept.applyChange(peer, self, 'msg', cid, messageWire({ deleted: true }));
    else {
      const access = await f.c.loadAccess(cid, 'local'); assert.equal(!!access, true);
      if (path === 'one') assert.equal((await f.c.deleteMessage('local', access!, 'incoming', 'both', { othersForBoth: true })).kind, 'ok');
      else await f.c.deleteMessages('local', access!, ['incoming'], 'both', { othersForBoth: true });
    }
    assert.equal((await t.db.select().from(schema.attachments))[0].state, 'deleted', 'удаление уводит и remote');
    assert.equal(f.purged.includes(`dm/${aid}`), true);
  }
  test(`R194 ${path} удаляет remote, мутант attached-only оставляет файл и обнаруживается`, async () => {
    // Класс ошибки удаления: ещё не скачанная копия тоже должна утратить доступ после удаления сообщения.
    await erase();
    const from = path === 'tombstone'
      ? "eq(attachments.messageId, messageId), inArray(attachments.state, ['attached', 'remote'])"
      : path === 'one'
        ? ".where(and(eq(attachments.messageId, messageId), inArray(attachments.state, ['attached', 'remote'])))\n      .returning({ key: attachments.storageKey });\n    onPurge"
        : "inArray(attachments.messageId, todoIds), inArray(attachments.state, ['attached', 'remote'])";
    const to = from.replace("inArray(attachments.state, ['attached', 'remote'])", "eq(attachments.state, 'attached')");
    await assert.rejects(erase([from, to]), e => e instanceof assert.AssertionError && e.message.includes('удаление уводит и remote'));
  });
}
async function used() { return Number((await t.db.select().from(schema.federationLinks))[0].usedBytes); }
for (const operation of ['update', 'delete'] as const) test(`R195 триггер 0138: ${operation} attached-копии возвращает ровно size и не ниже нуля`, async () => {
  // Класс ошибки квоты: все SQL-пути удаления должны возвращать место без двойного вычитания.
  await fixture(); await attachment({ originInstanceId: peer, size: 10 });
  await t.raw.exec('UPDATE federation_links SET used_bytes=15');
  if (operation === 'update') await t.raw.query("UPDATE attachments SET state='deleted' WHERE id=$1", [aid]);
  else await t.raw.query('DELETE FROM attachments WHERE id=$1', [aid]);
  assert.equal(await used(), 5);
  if (operation === 'update') { await t.raw.query('DELETE FROM attachments WHERE id=$1', [aid]); assert.equal(await used(), 5); }
  await attachment({ id: 'below-zero', storageKey: 'dm/below-zero', originInstanceId: peer, size: 10 });
  await t.raw.exec("UPDATE attachments SET state='deleted' WHERE id='below-zero'"); assert.equal(await used(), 0);
});
for (const mode of ['dm2', 'no-dm2', 'missing-link'] as const) test(`R194 homesWithoutFiles ${mode} возвращает набор по реальной связке и перечитывает только существующую без dm2`, async () => {
  // Класс ошибки capability: отсутствие визитки и старая визитка различаются возможностью безопасного refresh.
  const f = await fixture();
  if (mode === 'no-dm2') await t.raw.exec("UPDATE federation_links SET features='[\"dm1\"]'");
  if (mode === 'missing-link') await t.raw.exec('DELETE FROM federation_links');
  const homes = await f.att.homesWithoutFiles([peer, peer]);
  assert.equal(homes.has(peer), mode !== 'dm2'); assert.equal(homes.size, mode === 'dm2' ? 0 : 1);
  assert.equal(f.refreshes.length, mode === 'no-dm2' ? 1 : 0);
  assert.equal((await f.att.homesWithoutFiles([])).size, 0);
});
test('R194 fedFilesAllowedFor местного принимает без refresh, у соседа учитывает свежие capabilities и отсутствие связки', async () => {
  // Класс ошибки обновления протокола: новая поддержка dm2 у соседа должна открываться без повторной привязки.
  const f = await fixture({ refreshed: [shared.FED_FEATURES.dm2] });
  assert.equal(await f.att.fedFilesAllowedFor('local'), true); assert.equal(f.refreshes.length, 0);
  assert.equal(await f.att.fedFilesAllowedFor('shadow'), true); assert.equal(f.refreshes.length, 0);
  await t.raw.exec("UPDATE federation_links SET features='[]'");
  assert.equal(await f.att.fedFilesAllowedFor('shadow'), true); assert.equal(f.refreshes.length, 1);
  await t.raw.exec('DELETE FROM federation_links');
  assert.equal(await f.att.fedFilesAllowedFor('shadow'), false); assert.equal(f.refreshes.length, 1);
});
for (const mode of ['remote-attached', 'remote-delete', 'guest-delete'] as const) test(`R195 триггер 0138 не возвращает место повторно для ${mode}`, async () => {
  // Класс ошибки ownership/accounting: remote ещё не занимал копию, гостевой origin-null учитывается другим контрактом.
  await fixture(); await attachment({ state: mode.startsWith('remote') ? 'remote' : 'attached', originInstanceId: mode === 'guest-delete' ? null : peer });
  await t.raw.exec('UPDATE federation_links SET used_bytes=30');
  if (mode === 'remote-attached') await t.raw.query("UPDATE attachments SET state='attached' WHERE id=$1", [aid]);
  else await t.raw.query('DELETE FROM attachments WHERE id=$1', [aid]);
  assert.equal(await used(), 30);
});
async function noOldState(mutation?: Mutation) {
  await fixture({ ddl: mutation }); await attachment({ state: 'remote', originInstanceId: peer });
  await t.raw.exec('UPDATE federation_links SET used_bytes=30'); await t.raw.query('DELETE FROM attachments WHERE id=$1', [aid]);
  assert.equal(await used(), 30, 'remote не возвращает чужое занятое место');
}
test('R195 удаление OLD.state из реального DDL обнаруживается лишним вычитанием при DELETE remote', async () => {
  // Класс ошибки триггера: исходный и мутированный полный SQL применяются лишь к тестовой базе.
  await noOldState();
  await assert.rejects(noOldState(["AND OLD.state = 'attached'", '']), e => e instanceof assert.AssertionError && e.message.includes('remote не возвращает'));
});
async function clamp(mutation?: Mutation) {
  await fixture({ ddl: mutation }); await attachment({ originInstanceId: peer });
  await t.raw.exec('UPDATE federation_links SET used_bytes=5'); await t.raw.query('DELETE FROM attachments WHERE id=$1', [aid]);
  assert.equal(await used(), 0, 'квота не уходит ниже нуля');
}
test('R195 снятие GREATEST из реального DDL обнаруживается отрицательным used_bytes, не ошибкой SQL', async () => {
  // Класс ошибки границы: ручной сброс счётчика между резервом и стиранием не создаёт отрицательную квоту.
  await clamp();
  await assert.rejects(clamp(['GREATEST(used_bytes - OLD.size, 0)', 'used_bytes - OLD.size']), e => e instanceof assert.AssertionError && e.message.includes('квота не уходит'));
});
