import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import { createTestDb } from './harness.js';

type Accept = typeof import('../src/federation/convAccept.js');
type Mutation = readonly [string, string];
const self = 'a'.repeat(32), peer = 'b'.repeat(32), third = 'c'.repeat(32);
const cid = 'fed-direct';
const remote = { instanceId: peer, userId: 'remote' }, local = { instanceId: self, userId: 'local' };
function moduleOf<T>(name: string, deps: Record<string, unknown>, mutation?: Mutation): T {
  let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (mutation) { assert.equal(source.split(mutation[0]).length - 1, 1, 'единственный якорь'); source = source.replace(...mutation); }
  const imports: Record<string, unknown> = {};
  for (const n of ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true).statements)
    if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly) {
      const id = (n.moduleSpecifier as ts.StringLiteral).text;
      imports[id] = new Proxy({}, { get: (_t, key) => key === '__esModule' ? true : () => { throw new Error(`запрещённая граница ${id}.${String(key)}`); } });
    }
  Object.assign(imports, deps);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date, Map, Set, Promise, Buffer, URL, console,
      require: (id: string) => { assert.equal(Object.hasOwn(imports, id), true, `явный импорт ${id}`); return imports[id]; } });
  return module.exports as T;
}
function wire(overrides: Partial<shared.FedConvMessageWire> = {}) {
  return shared.serializeConvMessageWire({ id: 'remote-msg', conversationId: cid, author: remote,
    clientId: null, payloadHash: null, createdAt: Date.now(), originSortKey: 9000, content: 'Исходный',
    replyToId: null, forwardedFrom: null, silent: false, noPreview: false, captionAbove: false,
    replyQuote: null, sticker: null, service: null, attachments: [], editVersion: 2, editedAt: null, deleted: false, ...overrides });
}
async function fixture(mutation?: Mutation) {
  const t = await createTestDb();
  await t.raw.query(`INSERT INTO users(id,username,display_name,password_hash,verified,approved_at,home_instance_id,home_user_id,home_username)
    VALUES ('local','dmtest_local','Локальный','hash',true,now(),NULL,NULL,NULL),
      ('shadow','dmtest_shadow','Удалённый','hash',true,now(),$1,'remote','dmtest_remote')`, [peer]);
  const deliveries: any[] = [], pushes: string[][] = [];
  const pushWork: Promise<void>[] = [], pushDone: Array<() => void> = [];
  const deliver = async (d: unknown) => { if (d) deliveries.push(d); };
  const serialize = moduleOf<typeof import('../src/serialize.js')>('serialize', {
    '@gusvoice/shared': shared, './env.js': { env: {} }, './linkThreats.js': { dangerousLinksOf: () => [] },
    './federation/instanceLabels.js': { instanceLabel: (id: string) => ({ instanceId: id, name: 'Сосед', domain: 'peer.invalid', reports: false }) },
  });
  const c = moduleOf<typeof import('../src/conversations.js')>('conversations', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, './convRules.js': rules,
    './db/index.js': { db: t.db }, './db/schema.js': schema, './util.js': { uuidv7: randomUUID }, './env.js': { env: {} }, './serialize.js': serialize,
  });
  c.configureFederatedConv({ selfInstanceId: () => self, record: null });
  await c.createDirect('shadow', 'local', { id: cid, originInstanceId: peer });
  const fan = moduleOf<typeof import('../src/convSendFanout.js')>('convSendFanout', {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
    './conversations.js': { ...c, deliver }, './authGuard.js': { pushBurst: async () => {
      pushWork.push(new Promise<void>(resolve => { pushDone.push(resolve); }));
      return 'loud';
    } },
    './contacts.js': { contactNamesFor: async () => new Map() }, './contactRules.js': await import('../src/contactRules.js'),
    './groupRules.js': await import('../src/groupRules.js'),
    './push.js': { contentPreview: (s: string) => s, pushThrottleSource: (id: string) => id,
      withSilent: (payload: unknown) => payload, stickerPushText: () => 'Стикер',
      sendPushToUsers: async (ids: string[]) => { pushes.push([...ids]); pushDone.shift()?.(); } },
  });
  const a = moduleOf<Accept>('federation/convAccept', {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../convRules.js': rules,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema, '../conversations.js': { ...c, deliver },
    '../convSendFanout.js': fan,
    './convLink.js': { notePeerAnswer: () => {} },
    './instance.js': { federation: { identity: () => ({ instanceId: self }), signingKey: () => ({ kid: 'fixture', privateKeyDer: Buffer.from([1]) }) } },
  }, mutation);
  async function apply(kind: string, entity: Record<string, unknown>, conversationId = cid) {
    await a.applyChange(peer, self, kind, conversationId, entity);
    // pushBurst вызывается синхронно при старте фоновой IIFE: ждём конкретный sendPush, не произвольное число turns.
    if (pushWork.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const drained = await Promise.race([Promise.all(pushWork).then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
        assert.equal(drained, true, 'фоновый push дошёл до явной IO-границы');
      } finally { if (timer) clearTimeout(timer); }
    }
  }
  const row = async (id = 'remote-msg') => (await t.db.select().from(schema.conversationMessages).where(orm.eq(schema.conversationMessages.id, id)))[0];
  const journalCount = async () => (await t.db.select().from(schema.userChanges)).length;
  return { t, c, a, apply, row, journalCount, deliveries, pushes };
}

test('R190 копии получают местный порядок прихода, сохраняют порядок автора и будят только местного получателя', async () => {
  // Класс ошибки порядка и маршрутизации: origin-key не сортирует нашу ленту, тень не получает push через чужой дом.
  const f = await fixture();
  try {
    await f.apply('msg', wire({ id: 'first', originSortKey: 9000 }));
    await f.apply('msg', wire({ id: 'second', originSortKey: 1000 }));
    const one = await f.row('first'), two = await f.row('second');
    assert.equal(one.originSortKey, 9000); assert.equal(two.originSortKey, 1000);
    assert.equal(one.sortKey < two.sortKey, true); assert.equal(one.sortKey !== one.originSortKey, true);
    assert.equal(f.pushes.length, 2); assert.equal(f.pushes.every(ids => ids.length === 1 && ids[0] === 'local'), true);
    const n = await f.journalCount(), events = f.deliveries.length;
    await f.apply('msg', wire({ id: 'first', originSortKey: 9000 }));
    assert.equal(await f.journalCount(), n); assert.equal(f.deliveries.length, events); assert.equal(f.pushes.length, 2);
  } finally { await f.t.close(); }
});
test('R190 тот же id другого автора и новое местное сообщение от соседа пропускаются', async () => {
  // Класс ошибки подмены: сосед не редактирует чужое по одному глобальному id и не создаёт сообщения нашего человека.
  const f = await fixture();
  try {
    await f.apply('msg', wire()); const n = await f.journalCount();
    await f.apply('msg', wire({ author: local, editVersion: 8, content: 'Подмена' }));
    await f.apply('msg', wire({ id: 'ours-new', author: local }));
    await f.apply('msg', wire({ id: 'third-new', author: { instanceId: third, userId: 'remote' } }));
    assert.equal((await f.row()).content, 'Исходный'); assert.equal(!!await f.row('ours-new'), false); assert.equal(!!await f.row('third-new'), false);
    assert.equal(await f.journalCount(), n);
  } finally { await f.t.close(); }
});
for (const version of [1, 2, 3]) test(`R190 версия правки ${version} относительно сохранённой 2 ${version > 2 ? 'побеждает' : 'не меняет сообщение'}`, async () => {
  // Класс ошибки границы версии: равный повтор не является новой правкой, версия +1 является.
  const f = await fixture();
  try {
    await f.apply('msg', wire()); const n = await f.journalCount();
    await f.apply('msg', wire({ editVersion: version, content: 'Правка', editedAt: 1234 }));
    assert.equal((await f.row()).content, version > 2 ? 'Правка' : 'Исходный');
    assert.equal((await f.row()).editVersion, Math.max(version, 2));
    assert.equal(await f.journalCount() > n, version > 2);
  } finally { await f.t.close(); }
});
async function equalVersion(mutation?: Mutation) {
  const f = await fixture(mutation);
  try {
    await f.apply('msg', wire()); const n = await f.journalCount();
    await f.apply('msg', wire({ content: 'Равная подмена', editedAt: 2000 }));
    assert.equal((await f.row()).content, 'Исходный', 'равная версия не переписывает текст');
    assert.equal(await f.journalCount(), n);
  } finally { await f.t.close(); }
}
test('R190 допуск равной версии обнаруживается изменением настоящей SQL-строки', async () => {
  // Класс ошибки идемпотентности: > вместо >= в условии отказа принимает равный повтор.
  await equalVersion();
  await assert.rejects(equalVersion(['w.editVersion <= row.editVersion', 'w.editVersion < row.editVersion']),
    e => e instanceof assert.AssertionError && e.message.includes('равная версия не переписывает'));
});
async function monotonic(mutation?: Mutation) {
  const f = await fixture(mutation);
  try {
    await f.apply('msg', wire()); await f.apply('msg', wire({ deleted: true, content: '' }));
    const n = await f.journalCount(), deleted = (await f.row()).deletedAt?.getTime();
    assert.equal(typeof deleted, 'number');
    await f.apply('msg', wire({ content: 'Воскресить', editVersion: 99 }));
    assert.equal((await f.row()).content, '', 'надгробие не возвращает текст');
    assert.equal((await f.row()).deletedAt?.getTime(), deleted); assert.equal(await f.journalCount(), n);
    await f.apply('msg', wire({ deleted: true })); assert.equal(await f.journalCount(), n);
  } finally { await f.t.close(); }
}
test('R190 надгробие монотонно, снятие deleted guard обнаруживается возвращением текста', async () => {
  // Класс ошибки монотонности: даже большая версия не оживляет удалённую копию.
  await monotonic();
  await assert.rejects(monotonic(['if (row.deletedAt) return; // надгробие монотонно: воскресить нельзя', '// guard удалён']),
    e => e instanceof assert.AssertionError && e.message.includes('надгробие не возвращает текст'));
});
for (const kind of ['direct', 'group'] as const) test(`R190 надгробие своего сообщения Ф8 ${kind === 'direct' ? 'применяется в 1:1' : 'не принимается в группе'}`, async () => {
  // Класс ошибки области полномочий: исключение для удаления у обоих не распространяется на группы.
  const f = await fixture();
  try {
    if (kind === 'group') await f.t.raw.query('UPDATE conversations SET kind=$1,direct_key=NULL WHERE id=$2', [kind, cid]);
    await f.t.raw.query("INSERT INTO conversation_messages(id,conversation_id,author_id,sort_key,content) VALUES ('ours',$1,'local',1,'Наш текст')", [cid]);
    await f.apply('msg', wire({ id: 'ours', author: local, content: 'Чужая правка', editVersion: 8 }));
    assert.equal((await f.row('ours')).content, 'Наш текст');
    await f.apply('msg', wire({ id: 'ours', author: local, deleted: true, content: '' }));
    assert.equal(!!(await f.row('ours')).deletedAt, kind === 'direct');
    assert.equal((await f.row('ours')).content, kind === 'direct' ? '' : 'Наш текст');
  } finally { await f.t.close(); }
});
async function reactions(mutation?: Mutation) {
  const f = await fixture(mutation);
  try {
    await f.apply('msg', wire());
    await f.t.db.insert(schema.conversationMessageReactions).values([
      { messageId: 'remote-msg', userId: 'local', emoji: '❤' },
      { messageId: 'remote-msg', userId: 'shadow', emoji: '👎' },
    ]);
    await f.apply('react', shared.serializeConvReactionsWire({ messageId: 'remote-msg', reactions: [
      { user: remote, emoji: '👍' }, { user: local, emoji: '🔥' }, { user: { instanceId: third, userId: 'remote' }, emoji: '😎' },
    ] }));
    const rows = await f.t.db.select().from(schema.conversationMessageReactions);
    assert.equal(rows.some(r => r.userId === 'local' && r.emoji === '🔥'), false, 'реакция местного не подделывается соседом');
    assert.equal(rows.some(r => r.userId === 'local' && r.emoji === '❤'), true);
    assert.equal(rows.some(r => r.userId === 'shadow' && r.emoji === '👍'), true); assert.equal(rows.some(r => r.emoji === '👎'), false);
    await f.apply('react', shared.serializeConvReactionsWire({ messageId: 'remote-msg', reactions: [] }));
    const cleared = await f.t.db.select().from(schema.conversationMessageReactions);
    assert.equal(cleared.length, 1); assert.equal(cleared[0].userId, 'local');
  } finally { await f.t.close(); }
}

async function auditReactions(mutation?: Mutation) {
  const f = await fixture(mutation);
  try {
    await f.apply('msg', wire());
    await f.apply('react', shared.serializeConvReactionsWire({ messageId: 'remote-msg', reactions:
      ['lol', '👍', '👍', '❤', 'custom:peer-emoji', '🔥'].map(emoji => ({ user: remote, emoji })) }));
    const rows = await f.t.db.select().from(schema.conversationMessageReactions);
    assert.deepEqual(rows.map(r => r.emoji).sort(), ['👍', '❤', 'custom:peer-emoji'].sort(),
      'R304 сосед: только три разных допустимых эмодзи');
    assert.equal(rows.every(r => r.userId === 'shadow'), true);
  } finally { await f.t.close(); }
}
test('R304 сосед: текст не расходует лимит, повтор не расходует место, четвёртая реакция отбрасывается', () => auditReactions());
for (const [name, from, to] of [
  ['текст', 'if (!isReactionEmoji(emoji)) return;', '// фильтр снят'],
  ['четвёртая', 'if (n >= REACTIONS_PER_USER_MAX) return;', '// потолок снят'],
] as const) test(`R304 контрфакт приёма реакций: ${name} не попадает в SQL`, async () => {
  await auditReactions();
  await assert.rejects(auditReactions([from, to]), e => e instanceof assert.AssertionError &&
    e.operator === 'deepStrictEqual' && e.message.startsWith('R304 сосед: только три разных допустимых эмодзи'));
});

test('R304 пересылка от нашего человека привязывается только к существующему оригиналу с тем же текстом и временем', async () => {
  const f = await fixture();
  try {
    const at = Date.now() - 60_000;
    const forwardedFrom = { author: local, name: 'Локальный', at };
    await f.apply('msg', wire({ id: 'unverified', content: 'Наш оригинал', forwardedFrom }));
    assert.equal((await f.row('unverified')).forwardedFrom?.userId, '');
    assert.equal((await f.row('unverified')).forwardedFrom?.unverified, true);
    await f.t.db.insert(schema.conversationMessages).values({ id: 'original', conversationId: cid,
      authorId: 'local', sortKey: 100, content: 'Наш оригинал', createdAt: new Date(at),
      attachments: [{ name: 'photo.png', contentType: 'image/png', size: 1, url: 'https://fixture.invalid/photo.png' }] });
    await f.apply('msg', wire({ id: 'verified', content: 'Наш оригинал', forwardedFrom }));
    assert.equal((await f.row('verified')).forwardedFrom?.userId, 'local');
    assert.equal((await f.row('verified')).forwardedFrom?.unverified, undefined);
    await f.apply('msg', wire({ id: 'wrong-text', content: 'Подмена', forwardedFrom }));
    assert.equal((await f.row('wrong-text')).forwardedFrom?.unverified, true);
    await f.apply('msg', wire({ id: 'wrong-time', content: 'Наш оригинал', forwardedFrom: { ...forwardedFrom, at: at + 1 } }));
    assert.equal((await f.row('wrong-time')).forwardedFrom?.unverified, true);
    // hideCaptions очищает только подпись к вложению (forwardMessages), не текстовое сообщение.
    // Без вложения это пустой пузырь: applyMessage правильно отказывает ДО INSERT независимо от автора пересылки.
    // Крючок копирования файлов здесь не подключён: настоящий приём сохраняет запасной текст Э2,
    // но ourForwardOriginal должен проверить исходный пустой w.content, а не этот запасной текст.
    await f.apply('msg', wire({ id: 'without-caption', content: '', forwardedFrom, attachments: [{
      id: 'captionless-file', name: 'photo.png', contentType: 'image/png', size: 1,
      width: 1, height: 1, durationMs: null, waveform: null, asFile: false, spoiler: false, sha256: null,
    }] }));
    const withoutCaption = await f.row('without-caption');
    assert.ok(withoutCaption, 'пересылка вложения без подписи сохраняется под id провода');
    assert.equal(withoutCaption.content, f.a.FED_ATTACHMENTS_LATER_TEXT);
    assert.equal(withoutCaption.forwardedFrom?.userId, 'local');
    assert.equal(withoutCaption.forwardedFrom?.unverified, undefined);
  } finally { await f.t.close(); }
});

async function auditQuote(mutation?: Mutation) {
  const f = await fixture(mutation);
  try {
    await f.apply('msg', wire({ id: 'parent', content: 'Настоящий текст' }));
    await f.apply('msg', wire({ id: 'quote', replyToId: 'parent', replyQuote: { text: 'Поддельный текст', offset: 0 } }));
    assert.equal((await f.row('quote')).replyQuote, null, 'R304 цитата не подделывает нашу копию родителя');
    await f.apply('msg', wire({ id: 'auto', replyToId: 'parent', replyQuote: { text: 'Поддельный текст', offset: 0, auto: true } }));
    assert.equal((await f.row('auto')).replyQuote?.text, 'Настоящий текст');
    await f.apply('msg', wire({ id: 'exact', replyToId: 'parent', replyQuote: { text: 'текст', offset: 10 } }));
    assert.equal((await f.row('exact')).replyQuote?.text, 'текст');
    await f.apply('msg', wire({ id: 'absent', replyToId: 'absent-parent', replyQuote: { text: 'текст', offset: 0 } }));
    assert.equal((await f.row('absent')).replyQuote, null);
  } finally { await f.t.close(); }
}
test('R304 фед-приём пересчитывает auto, принимает точную цитату и убирает поддельную или без родителя', () => auditQuote());
test('R304 контрфакт цитаты провода как есть меняет настоящую строку сообщения', async () => {
  await auditQuote();
  await assert.rejects(auditQuote(['const replyQuote = fedReplyQuote(parentContent, w.replyQuote);', 'const replyQuote = w.replyQuote;']),
    e => e instanceof assert.AssertionError && e.message.startsWith('R304 цитата не подделывает нашу копию родителя'));
});
test('R304 дата 2099 заменяется временем приёма, близкая дата автора сохраняется до миллисекунды', async () => {
  const f = await fixture();
  try {
    const start = Date.now();
    await f.apply('msg', wire({ id: 'future', createdAt: Date.UTC(2099, 0, 1) }));
    const stored = (await f.row('future')).createdAt.getTime();
    assert.ok(stored >= start && stored <= Date.now());
    await f.apply('msg', wire({ id: 'near', createdAt: start - 1000 }));
    assert.equal((await f.row('near')).createdAt.getTime(), start - 1000);
  } finally { await f.t.close(); }
});
test('R190 реакции заменяются только у людей соседа, удаление peer guard допускает подделку местного', async () => {
  // Класс ошибки владельца состояния: итог соседа не имеет права менять реакцию нашего человека.
  await reactions();
  await assert.rejects(reactions(['if (r.user.instanceId !== peer) continue;\n      const who', 'const who']),
    e => e instanceof assert.AssertionError && e.message.includes('реакция местного не подделывается'));
});
test('R190 прочитано движется вперёд, readAt впервые покрытых чужих сообщений сохраняется при откате и повторе', async () => {
  // Класс ошибки монотонности курсора: старый read не снимает ✓✓ и не переписывает момент чтения.
  const f = await fixture();
  try {
    await f.t.raw.query("INSERT INTO conversation_messages(id,conversation_id,author_id,sort_key,content) VALUES ('read1',$1,'local',10,'Первое'),('read2',$1,'local',20,'Второе'),('ownread',$1,'shadow',15,'Своё')", [cid]);
    const read = (messageId: string, user = remote) => shared.serializeConvReadsWire({ reads: [{ user, messageId }] });
    await f.apply('read', read('read2')); const first = await f.row('read1'), second = await f.row('read2');
    assert.equal(!!first.readAt, true); assert.equal(!!second.readAt, true); assert.equal((await f.row('ownread')).readAt, null);
    const n = await f.journalCount();
    await f.apply('read', read('read1')); await f.apply('read', read('read2')); await f.apply('read', read('read2', local));
    const members = await f.t.db.select().from(schema.conversationMembers);
    assert.equal(members.find(m => m.userId === 'shadow')?.lastReadKey, 20); assert.equal(members.find(m => m.userId === 'local')?.lastReadKey, 0);
    assert.equal((await f.row('read1')).readAt?.getTime(), first.readAt?.getTime()); assert.equal(await f.journalCount(), n);
  } finally { await f.t.close(); }
});
test('R190 закреп у обоих ставится и снимается, личный закреп сохраняется и повторы не пишут журнал', async () => {
  // Класс ошибки области закрепа: снятие общего не удаляет отдельный личный закреп.
  const f = await fixture();
  try {
    await f.apply('msg', wire());
    const pin = (pinned: boolean) => shared.serializeConvPinWire({ messageId: 'remote-msg', pinned, by: pinned ? remote : null });
    await f.apply('pin', pin(true)); const pins = await f.t.db.select().from(schema.conversationPins);
    assert.equal(pins.length, 2); assert.equal(pins.every(p => p.forBoth && p.pinnedBy === 'shadow'), true);
    const n = await f.journalCount(); await f.apply('pin', pin(true)); assert.equal(await f.journalCount(), n);
    await f.apply('pin', pin(false)); assert.equal((await f.t.db.select().from(schema.conversationPins)).length, 0);
    await f.t.db.insert(schema.conversationPins).values({ conversationId: cid, messageId: 'remote-msg', userId: 'local', pinnedBy: 'local', forBoth: false });
    const before = await f.journalCount(); await f.apply('pin', pin(false));
    assert.equal((await f.t.db.select().from(schema.conversationPins)).length, 1); assert.equal(await f.journalCount(), before);
  } finally { await f.t.close(); }
});
for (const delay of [299999, 300000, 300001]) test(`R190 задержка ${delay} мс ${delay > 300000 ? 'получает' : 'не получает'} deliveredAt в настоящем DTO`, async () => {
  // Класс ошибки порога: ровно пять минут ещё не «доставлено позже», +1 мс уже да.
  const f = await fixture();
  try {
    await f.apply('msg', wire()); const saved = await f.row(); const arrived = Math.floor(saved.sortKey / 1000);
    await f.t.db.update(schema.conversationMessages).set({ createdAt: new Date(arrived - delay) }).where(orm.eq(schema.conversationMessages.id, saved.id));
    const view = await f.c.messageFor(saved.id, 'local');
    assert.equal(!!view && 'deliveredAt' in view, delay > 300000);
    if (view && 'deliveredAt' in view) assert.equal(view.deliveredAt, new Date(arrived).toISOString());
    await f.t.db.update(schema.conversationMessages).set({ originSortKey: null }).where(orm.eq(schema.conversationMessages.id, saved.id));
    assert.equal('deliveredAt' in (await f.c.messageFor(saved.id, 'local'))!, false);
  } finally { await f.t.close(); }
});

async function blockedReaction(mutation?: Mutation) {
  const f = await fixture(mutation);
  try {
    await f.apply('msg', wire());
    const ownMessages = async () => (await f.t.db.select().from(schema.userChanges)
      .where(orm.and(orm.eq(schema.userChanges.userId, 'local'), orm.eq(schema.userChanges.kind, 'msg')))).length;
    const before = await ownMessages();
    await f.t.db.insert(schema.userBlocks).values({ blockerId: 'local', blockedId: 'shadow' });
    await f.apply('react', shared.serializeConvReactionsWire({ messageId: 'remote-msg', reactions: [{ user: remote, emoji: '👍' }] }));
    assert.equal(await ownMessages(), before, 'заблокировавшему не пишется msg о чужой реакции');
    assert.equal((await f.t.db.select().from(schema.conversationMessageReactions)).length, 1, 'состояние владельца сохраняется отдельно от доставки');
    await f.t.db.delete(schema.userBlocks);
    await f.apply('react', shared.serializeConvReactionsWire({ messageId: 'remote-msg', reactions: [{ user: remote, emoji: '🔥' }] }));
    assert.equal(await ownMessages(), before + 1, 'без блока местный получает изменение реакции');
  } finally { await f.t.close(); }
}
test('R191 блокировка исключает местного из журнала чужой реакции, без блока изменение доставляется', async () => {
  // Класс ошибки приватности доставки: состояние соседа применено, но блокирующему не должен идти msg этой реакции.
  await blockedReaction();
  const anchor = "const audience = changeAudience({ action: 'react', actorId: theirs[0], memberIds: c.memberIds, withheld: m.withheld, blockedActor });";
  await assert.rejects(blockedReaction([anchor, anchor.replace('blockedActor });', 'blockedActor: new Set() });')]),
    e => e instanceof assert.AssertionError && e.message.includes('заблокировавшему не пишется msg'));
});

test('R191 общий закреп от заблокированного не ложится местному и не снимает его ранее полученный закреп', async () => {
  // Класс ошибки области блока: закреп или его снятие не имеют права изменить личный список заблокировавшего.
  const f = await fixture();
  try {
    await f.apply('msg', wire());
    const pin = (pinned: boolean) => shared.serializeConvPinWire({ messageId: 'remote-msg', pinned, by: pinned ? remote : null });
    await f.t.db.insert(schema.userBlocks).values({ blockerId: 'local', blockedId: 'shadow' });
    await f.apply('pin', pin(true));
    const denied = await f.t.db.select().from(schema.conversationPins);
    assert.equal(denied.some(p => p.userId === 'local'), false);
    assert.equal(denied.some(p => p.userId === 'shadow'), true);
    await f.t.db.delete(schema.userBlocks); await f.apply('pin', pin(true));
    assert.equal((await f.t.db.select().from(schema.conversationPins)).some(p => p.userId === 'local' && p.forBoth), true);
    await f.t.db.insert(schema.userBlocks).values({ blockerId: 'local', blockedId: 'shadow' });
    await f.apply('pin', pin(false));
    const kept = await f.t.db.select().from(schema.conversationPins);
    assert.equal(kept.length, 1); assert.equal(kept[0].userId, 'local');
  } finally { await f.t.close(); }
});

async function arrivalSummary(mutation?: Mutation) {
  const f = await fixture(mutation);
  try {
    const sentAt = Date.now() - 600_000;
    const before = Date.now();
    await f.apply('msg', wire({ createdAt: sentAt }));
    const dbRow = (await f.t.db.select().from(schema.conversations))[0];
    assert.ok(dbRow.lastMessageAt && dbRow.lastMessageAt.getTime() >= before, 'опоздавшая копия поднимает сводку временем приёма');
    const summaries = await f.c.listConversations('local');
    const summary = summaries.conversations.find(c => c.id === cid);
    assert.ok(summary?.lastMessageAt && Date.parse(summary.lastMessageAt) >= before, 'сводка не заменяет время приёма старым временем автора');
    assert.equal((await f.row()).createdAt.getTime(), sentAt, 'в пузыре остаётся настоящее время отправки');
  } finally { await f.t.close(); }
}
test('R191 поздняя копия поднимает сводку моментом приёма, контрфакт createdAt не прячет новую беседу', async () => {
  // Класс ошибки порядка списка: досланное сообщение не должно остаться на старом месте по часам автора.
  await arrivalSummary();
  const anchor = 'lastMessageAt: sql`GREATEST(${conversations.lastMessageAt}, now())`';
  await assert.rejects(arrivalSummary([anchor, 'lastMessageAt: sql`GREATEST(${conversations.lastMessageAt}, ${createdAt.toISOString()}::timestamptz)`']),
    e => e instanceof assert.AssertionError && e.message.includes('опоздавшая копия поднимает сводку'));
});
