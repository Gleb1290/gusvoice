import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './fedViaRules';
import { payloadHash } from '../../../packages/backend/src/convRules.js';

const source = readFileSync(new URL('./fedViaRules.ts', import.meta.url), 'utf8');
function load(raw: string): typeof rules {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, TextEncoder, Uint8Array, DataView, Set });
  return module.exports as typeof rules;
}
function mutation(anchor: string, to: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь чистого модуля'); return source.replace(anchor, to);
}
const authorId = (value: unknown) => (value as { author?: { id?: string } } | null)?.author?.id;

const groupPeople = [{ id: 'me', displayName: 'Местный' }, { id: 'group-peer', displayName: 'Сосед' }];
function groupAuthors(api: typeof rules) {
  const own = { id: 'own-group', author: { id: 'shadow', displayName: 'Местный' }, content: 'Текст', extra: { kept: true } };
  const ownResult = api.viaLocalizeGroup(own, 'shadow', 'me', groupPeople);
  assert.equal(ownResult.author.id, 'me', 'свой автор группы переводится в мой id');
  assert.equal(ownResult.extra, own.extra); assert.equal(own.author.id, 'shadow');
  assert.equal(api.viaLocalizeGroup(own, 'shadow', undefined, groupPeople), own);
  const peer = { id: 'peer-group', author: { id: 'host-id', displayName: 'Сосед', avatarUrl: 'https://avatar.example.test/a' }, content: 'Ответ' };
  const result = api.viaLocalizeGroup(peer, 'shadow', 'me', groupPeople);
  assert.equal(result.author.id, 'group-peer', 'ровно один участник с именем получает свой местный id');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ...peer, author: { ...peer.author, id: 'group-peer' } });
  const ambiguous = [...groupPeople, { id: 'other-peer', displayName: 'Сосед' }];
  assert.equal(api.viaLocalizeGroup(peer, 'shadow', 'me', ambiguous), peer, 'два одноимённых участника не угадываются');
  assert.equal(api.viaLocalizeGroup(peer, 'shadow', 'me', []), peer);
  const existing = { ...peer, author: { ...peer.author, id: 'group-peer', displayName: 'Иное имя' } };
  assert.equal(api.viaLocalizeGroup(existing, 'shadow', 'me', groupPeople), existing, 'известный id не меняется по подписи');
}
// В группе нет единственного собеседника: авторов нельзя всех заменить одним id или угадать при одинаковых именах.
it('R208 локализация группы различает меня, одного одноимённого участника и неоднозначность', () => { groupAuthors(rules); });
// Служебное/неполное сообщение и совпадение только с моим именем не превращаются в сообщение другого человека.
it('R208 локализация группы оставляет неизвестного автора, отсутствие имени и уже свой id как есть', () => {
  for (const author of [undefined, {}, { id: '' }, { id: 'unknown' }, { id: 'unknown', displayName: 'Местный' }, { id: 'me', displayName: 'Сосед' }]) {
    const message = { id: 'm', author } as { id: string; author: { id: string; displayName?: string } };
    assert.equal(rules.viaLocalizeGroup(message, 'shadow', 'me', groupPeople), message);
  }
});
// Снятый гейт неоднозначности ошибочно присваивает сообщение первому из одноимённых людей.
it('R208 контрфакт локализации группы угадывает первого при двух одинаковых именах', () => {
  groupAuthors(rules);
  assert.throws(() => groupAuthors(load(mutation('return same.length === 1 ?', 'return same.length > 0 ?'))),
    e => e instanceof assert.AssertionError && e.message.startsWith('два одноимённых участника не угадываются')
      && e.operator === 'strictEqual' && authorId(e.actual) === 'group-peer' && authorId(e.expected) === 'host-id');
});
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
for (const text of ['', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000), 'Гусиная переписка', '🪶🙂']) {
  it(`R200 SHA256 совпадает с node:crypto на ${Buffer.byteLength(text, 'utf8')} байтах UTF8`, () => {
    // 55/56 — граница дополнительного блока padding; UTF8 нельзя считать по длине строки JS.
    assert.equal(rules.sha256Hex(text), sha(text));
  });
}
function hashes(api: typeof rules) {
  for (const content of ['текст', '  текст\n', '\t🪶\n', '', ' '.repeat(55), 'x'.repeat(1000)])
    for (const replyToId of [undefined, null, 'reply-id']) {
      // Бэкенд получает уже нормализованный текст ручки; сравниваем две настоящие реализации формулы.
      assert.equal(api.viaPayloadHash('conversation', content, replyToId), payloadHash({ conversationId: 'conversation', content: content.trim(), attachmentRefs: [], replyToId }), 'отпечаток нормализованного текста совпадает с домом');
    }
  assert.notEqual(api.viaPayloadHash('one', 'text', null), api.viaPayloadHash('two', 'text', null));
  assert.notEqual(api.viaPayloadHash('one', 'text', null), api.viaPayloadHash('one', 'text', 'reply'));
}
it('R200 viaPayloadHash совпадает с настоящим backend payloadHash для текста и ответа', () => hashes(rules));
it('R200 потеря trim меняет отпечаток, который дом пересчитывает по копии', () => {
  hashes(load(source));
  assert.throws(() => hashes(load(mutation('content.trim()', 'content'))), e => e instanceof assert.AssertionError && e.message.includes('совпадает с домом'));
});
const now = 2_000_000_000_000;
const creds = (expiresAt: number): rules.ViaCreds => ({ instanceId: 'home', apiBase: 'https://peer.invalid/api', userId: 'shadow', token: 'synthetic-session', expiresAt });
it('R200 credsStale и credsUsable различают сутки ровно, сутки минус1 и истечение ровно', () => {
  // Ловит раннее обновление или использование истёкшей долгой сессии на точной границе.
  assert.equal(rules.credsStale(creds(now + rules.VIA_REFRESH_BEFORE_MS), now), false);
  assert.equal(rules.credsStale(creds(now + rules.VIA_REFRESH_BEFORE_MS - 1), now), true);
  assert.equal(rules.credsUsable(creds(now + 1), now), true); assert.equal(rules.credsUsable(creds(now), now), false);
  for (const c of [null, undefined, { ...creds(now + 1), token: '' }, { ...creds(now + 1), apiBase: '' }]) assert.equal(rules.credsStale(c, now), true);
});
it('R200 fallbackDue ждёт10 минут после отказа, ровно на границе пробует, свежие сессии не обновляет', () => {
  // Ловит шторм fallback при лежащем соседе и зависший навсегда отказ.
  assert.equal(rules.fallbackDue(null, undefined, now), true);
  assert.equal(rules.fallbackDue(null, now - rules.VIA_RETRY_MS + 1, now), false);
  assert.equal(rules.fallbackDue(null, now - rules.VIA_RETRY_MS, now), true);
  assert.equal(rules.fallbackDue(null, now + 1, now), false);
  assert.equal(rules.fallbackDue(creds(now + 2 * rules.VIA_REFRESH_BEFORE_MS), undefined, now), false);
});
const row = (id: string, home = 'first'): rules.ViaClaimRow => ({ home, conversationId: 'conversation', clientId: id, payloadHash: 'a'.repeat(64) });
it('R200 claimsAdd заменяет только тот же clientId того же дома и сохраняет остальные дома', () => {
  // Ловит дублирование отчёта после повтора или удаление одноимённой строки другого дома.
  const original = [row('one'), row('one', 'other'), row('two')];
  const replacement = { ...row('one'), payloadHash: 'b'.repeat(64) };
  const added = rules.claimsAdd(original, replacement);
  assert.deepEqual(added, [row('one', 'other'), row('two'), replacement]); assert.deepEqual(original, [row('one'), row('one', 'other'), row('two')]);
  assert.deepEqual(rules.claimsFor(added, 'first'), [{ conversationId: 'conversation', clientId: 'two', payloadHash: 'a'.repeat(64) }, { conversationId: 'conversation', clientId: 'one', payloadHash: 'b'.repeat(64) }]);
});
it('R200 очередь допускает500 строк дома,501-я вытесняет старейшую только этого дома', () => {
  // Ловит off-by-one и общий вместо посерверного потолок очереди.
  const list = Array.from({ length: 499 }, (_, i) => row(String(i)));
  const other = Array.from({ length: 500 }, (_, i) => row(String(i), 'other'));
  const exact = rules.claimsAdd([...other, ...list], row('499')); assert.equal(rules.claimsFor(exact, 'first').length, 500);
  const more = rules.claimsAdd(exact, row('500')); assert.equal(rules.claimsFor(more, 'first').length, 500);
  assert.equal(more.some(x => x.home === 'first' && x.clientId === '0'), false);
  assert.equal(rules.claimsFor(more, 'other').length, 500); assert.equal(more.at(-1)?.clientId, '500');
});
function clear(api: typeof rules) {
  const sent = [row('sent')], addedWhilePending = row('new');
  const current = [...sent, addedWhilePending, row('sent', 'other')];
  assert.equal(JSON.stringify(api.claimsClear(current, 'first', sent)), JSON.stringify([addedWhilePending, row('sent', 'other')]), 'новые строки и другой дом остаются после отчёта');
  assert.equal(api.claimsClear(current, 'first', []).length, current.length);
}
it('R200 claimsClear удаляет ушедшие строки, но сохраняет добавленные во время запроса и другой дом', () => clear(rules));
it('R200 очистка всей очереди после отчёта ловится добавленной во время запроса строкой', () => {
  clear(load(source));
  assert.throws(() => clear(load(mutation('return list.filter((x) => !(x.home === home && gone.has(x.clientId)));', 'return [];'))), e => e instanceof assert.AssertionError && e.message.includes('новые строки и другой дом остаются'));
});
it('R200 parseCreds и parseClaims отбрасывают повреждённое и сохраняют нормальный результат без чужих полей', () => {
  // Ловит молчаливую потерю корректного диска и использование полей неверного типа.
  const good = creds(now + 1); assert.deepEqual(rules.parseCreds({ ...good, extra: true }), good);
  for (const raw of [null, [], {}, { ...good, token: '' }, { ...good, apiBase: '' }, { ...good, expiresAt: Infinity }, { ...good, expiresAt: '123' }, { ...good, userId: null }]) assert.equal(rules.parseCreds(raw), null);
  assert.deepEqual(rules.parseClaims([null, 1, row('good'), { ...row('bad'), payloadHash: 1 }, { ...row('extra'), extra: true }]), [row('good'), row('extra')]);
  assert.deepEqual(rules.parseClaims(null), []); assert.deepEqual(rules.parseClaims({}), []);
});
function localize(api: typeof rules) {
  const own = { id: 'message-own', author: { id: 'shadow', displayName: 'Местный' }, content: 'через соседа', extra: { kept: true } };
  const peer = { id: 'message-peer', author: { id: 'neighbor-peer', displayName: 'Сосед' }, content: 'ответ' };
  const ownResult = api.viaLocalize(own, 'shadow', 'me', 'peer');
  assert.equal(ownResult.author.id, 'me', 'теневой автор соседа отображается моим id');
  assert.deepEqual(JSON.parse(JSON.stringify(ownResult)), { ...own, author: { ...own.author, id: 'me' } }, 'меняется только author.id, структура сообщения сохраняется');
  const peerResult = api.viaLocalize(peer, 'shadow', 'me', 'peer');
  assert.equal(peerResult.author.id, 'peer', 'любой другой автор отображается id собеседника из dms');
  assert.deepEqual(JSON.parse(JSON.stringify(peerResult)), { ...peer, author: { ...peer.author, id: 'peer' } }, 'остальные поля сообщения собеседника сохраняются');
  assert.equal(own.author.id, 'shadow', 'исходное сообщение не меняется');
  assert.equal(ownResult.extra, own.extra, 'прочие поля и вложенные данные остаются прежними');
  const noAuthor = { id: 'service-message', content: 'служебное' } as unknown as typeof own;
  const noId = { id: 'message', author: {} } as unknown as typeof own;
  assert.equal(api.viaLocalize(noAuthor, 'shadow', 'me', 'peer'), noAuthor, 'без автора возвращается тот же объект');
  assert.equal(api.viaLocalize(noId, 'shadow', 'me', 'peer'), noId, 'без id автора возвращается тот же объект');
  assert.equal(api.viaLocalize(own, 'shadow', undefined, 'peer'), own, 'без id своего дома сообщение не меняется');
  assert.equal(api.viaLocalize(peer, 'shadow', 'me', undefined), peer, 'без id собеседника сообщение не меняется');
}
it('R204 «через»: автор соседа становится моим id, остальные — id собеседника, прочие данные не меняются', () => localize(rules));
it('R204 перестановка веток автора соседа и собеседника ловится на исходном сообщении', () => {
  localize(rules);
  assert.throws(() => localize(load(mutation('const id = from === viaUserId ? selfId : peerId;', 'const id = from === viaUserId ? peerId : selfId;'))),
    e => e instanceof assert.AssertionError && e.message.includes('теневой автор соседа отображается моим id'));
});
