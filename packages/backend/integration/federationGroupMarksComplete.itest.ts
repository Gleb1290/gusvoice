import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, test } from 'node:test';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Changes = typeof import('../src/federation/convChanges.js');
type Mutation = { from: string; to: string };
const self = 'r217-export-self', peer = 'r217-export-peer', cid = 'r217-complete-group';
const features = [shared.FED_FEATURES.dm1, shared.FED_FEATURES.dmgroup1, shared.FED_FEATURES.dmgroupmarks1, shared.FED_FEATURES.dm2once];
const voice: shared.Attachment = { id: 'voice', name: 'voice.ogg', contentType: 'audio/ogg', size: 1,
  url: '/synthetic', durationMs: 1000, waveform: [50] };
let t: TestDb;
const source = () => readFileSync(new URL('../src/federation/convChanges.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

before(async () => { t = await createTestDb(); });
after(async () => {
  try { await t?.close(); } finally { const { pool } = await import('../src/db/index.js'); await pool.end(); }
});

// Никаких вырезанных выражений: и экспорт, и materialize, и SQL читаются из целого настоящего модуля.
function load(edit?: Mutation): Changes {
  let raw = source();
  if (edit) { assert.equal(raw.split(edit.from).length, 2, 'единственный смысловой якорь R217 export'); raw = raw.replace(edit.from, edit.to); }
  const deps: Record<string, unknown> = { 'drizzle-orm': orm, '@gusvoice/shared': shared,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Date, Map, Set, Buffer, URL,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `закрытый импорт R217 export: ${id}`); return deps[id]; },
  });
  return module.exports as Changes;
}
function mutation(from: string, to: string): Mutation {
  const raw = source(), ast = ts.createSourceFile('convChanges.ts', raw, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === 'exportGroupForPeer');
  assert.equal(functions.length, 1, 'адресный мутант экспорта группы');
  const body = functions[0].getText(ast); assert.equal(body.split(from).length, 2, 'один якорь внутри экспорта группы');
  return { from: body, to: body.replace(from, to) };
}
const killed = (prefix: string, actual: unknown, expected: unknown) => (error: unknown) => {
  if (!(error instanceof assert.AssertionError) || !error.message.startsWith(prefix) || error.operator !== 'strictEqual') return false;
  assert.equal(error.actual, actual, 'контрфакт дал известный неправильный результат');
  assert.equal(error.expected, expected, 'контрфакт нарушил именно ожидаемый контракт');
  return true;
};

async function fixture(options: { origin?: string; former?: boolean; features?: string[]; empty?: boolean; direct?: boolean } = {}, edit?: Mutation) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values([
    { id: 'local', username: 'complete_local', displayName: 'Местный', passwordHash: 'synthetic-only' },
    { id: 'shadow', username: 'complete_shadow', displayName: 'Сосед', passwordHash: 'synthetic-only', homeInstanceId: peer, homeUserId: 'remote' },
  ]);
  await t.db.insert(schema.federationLinks).values({ instanceId: peer, domain: 'complete.invalid', apiBase: 'https://complete.invalid/api',
    clientOrigin: 'https://complete.invalid', rootKey: 'synthetic-not-a-key', state: 'active', features: options.features ?? features });
  await t.db.insert(schema.conversations).values({ id: cid, kind: options.direct ? 'direct' : 'group',
    directKey: options.direct ? 'complete-pair' : null, title: 'Полнота отметок', originInstanceId: options.origin ?? null, createdBy: 'local' });
  await t.db.insert(schema.conversationMembers).values([
    { conversationId: cid, userId: 'local', role: 'owner' },
    { conversationId: cid, userId: 'shadow', leftAt: options.former ? new Date('2026-10-01T00:00:00Z') : null },
  ]);
  if (!options.empty) {
    await t.db.insert(schema.conversationMessages).values([
      { id: 'local-message', conversationId: cid, authorId: 'local', sortKey: 1, content: 'Текст', createdAt: new Date('2026-09-01T00:00:00Z') },
      { id: 'peer-voice', conversationId: cid, authorId: 'shadow', sortKey: 2, content: '', attachments: [voice], createdAt: new Date('2026-09-01T00:00:01Z') },
    ]);
    await t.db.insert(schema.conversationMessageReactions).values({ messageId: 'local-message', userId: 'local', emoji: '👍' });
    await t.db.insert(schema.conversationVoiceListens).values({ messageId: 'peer-voice', userId: 'local' });
  }
  const changes = load(edit);
  const page = await changes.exportForPeer(peer, cid, null, self);
  assert.ok(page, 'разрешённый экспорт существует');
  return page;
}

test('R217 полные отметки объявлены у действующего участника на хосте и у дома участника', async () => {
  for (const origin of [undefined, peer]) {
    const page = await fixture({ origin });
    assert.equal(page.marksComplete, true, 'полный экспорт обоих направлений объявлен');
    assert.equal(page.items.some(i => i.kind === 'listen'), true, 'dm2once действительно пропускает прослушивание');
    assert.equal(page.items.some(i => i.kind === 'react'), true, 'экспорт содержит реальные реакции из SQL');
  }
});
test('R217 пустой, но полный набор отметок тоже объявлен — иначе старые отметки не снять', async () => {
  const page = await fixture({ empty: true });
  assert.equal(page.marksComplete, true, 'отсутствие отметок не делает полный ответ неполным');
  assert.equal(page.items.some(i => ['react', 'pin', 'listen'].includes(i.kind)), false, 'пустой набор не придумывает отметки');
});
async function former(edit?: Mutation) {
  const page = await fixture({ former: true }, edit);
  assert.equal(page.marksComplete, undefined, 'бывшему участнику не обещаны полные отметки');
  assert.equal(page.items.some(i => ['react', 'pin', 'listen', 'read'].includes(i.kind)), false, 'бывший получает историю без отметок');
}
test('R217 бывшему участнику история доступна, но признак полного набора отметок не отдан', async () => { await former(); });
async function noMarks(edit?: Mutation) {
  const page = await fixture({ features: features.filter(f => f !== shared.FED_FEATURES.dmgroupmarks1) }, edit);
  assert.equal(page.marksComplete, undefined, 'без dmgroupmarks1 полнота не объявляется');
  assert.equal(page.items.some(i => ['react', 'pin', 'listen', 'read'].includes(i.kind)), false, 'старый сосед не получает отметки групп');
}
test('R217 без dmgroupmarks1 остаётся прежний экспорт без отметок и обещания полноты', async () => { await noMarks(); });
async function noOnce(edit?: Mutation) {
  const page = await fixture({ features: features.filter(f => f !== shared.FED_FEATURES.dm2once) }, edit);
  assert.equal(page.marksComplete, undefined, 'без dm2once нельзя объявлять срез полным');
  assert.equal(page.items.some(i => i.kind === 'listen'), false, 'materialize отрезал неподдерживаемое прослушивание');
  assert.equal(page.items.some(i => i.kind === 'react'), true, 'поддерживаемые реакции всё ещё отдаются');
}
test('R217 без dm2once прослушивание отфильтровано и полнота запрещена, реакции остаются', async () => { await noOnce(); });
test('R217 обычная 1:1 не получает новый признак полноты групп', async () => {
  assert.equal((await fixture({ direct: true })).marksComplete, undefined, '1:1 не объявляет marksComplete');
});
test('R217 контрфакт: обход marksWhole ошибочно обещает полноту без прослушиваний', async () => {
  await noOnce();
  await assert.rejects(() => noOnce(mutation('marks && (await marksWhole(instanceId))', 'marks')),
    killed('без dm2once нельзя объявлять срез полным', true, undefined));
});
test('R217 контрфакт: признак при marks=null ошибочно разрешает снятие у старого соседа', async () => {
  await noMarks();
  await assert.rejects(() => noMarks(mutation('marks && (await marksWhole(instanceId))', '(await marksWhole(instanceId))')),
    killed('без dmgroupmarks1 полнота не объявляется', true, undefined));
});
