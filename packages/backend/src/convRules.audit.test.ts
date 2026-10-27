import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './convRules.js';

const source = readFileSync(new URL('./convRules.ts', import.meta.url), 'utf8');
function load(raw: string): typeof rules {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, Buffer, Date, require(id: string) { assert.equal(id, 'node:crypto'); return crypto; } });
  return module.exports as typeof rules;
}
function change(from: string, to: string): string {
  assert.equal(source.split(from).length - 1, 1, `R304 единственный якорь ${from}`); return source.replace(from, to);
}
function failure(label: string, actual: unknown, expected: unknown) {
  return (e: unknown) => e instanceof assert.AssertionError && e.code === 'ERR_ASSERTION' && e.operator === 'strictEqual'
    && e.message.split(/\r?\n/, 1)[0] === label && e.actual === actual && e.expected === expected;
}
it('R304 без родителя и без цитаты федерация не придумывает текст ответа', () => {
  assert.equal(rules.fedReplyQuote(null, { text: 'Подделка', offset: 0 }), null);
  assert.equal(rules.fedReplyQuote('Наш родитель', null), null);
  assert.equal(rules.fedReplyQuote('', { text: '', offset: 0, auto: true }), null);
});
it('R304 явная цитата соседа проверяется по нашей копии, неверное смещение пересчитывается', () => {
  assert.deepEqual(rules.fedReplyQuote('Текст родителя', { text: 'родителя', offset: 6 }), { text: 'родителя', offset: 6 });
  assert.equal(rules.fedReplyQuote('Текст родителя', { text: 'Подделка', offset: 6 }), null);
  assert.deepEqual(rules.fedReplyQuote('Текст родителя', { text: 'родителя', offset: 0 }), { text: 'родителя', offset: 6 });
});
it('R304 auto-цитата берёт снимок нашей копии, а не присланные текст и смещение', () => {
  assert.deepEqual(rules.fedReplyQuote('Наш точный текст', { text: 'Подделка', offset: 700, auto: true }),
    { text: 'Наш точный текст', offset: 0, auto: true });
  assert.equal(rules.fedReplyQuote('😀'.repeat(1000), { text: 'x', offset: 0, auto: true })?.text,
    rules.replyQuoteSnapshot('😀'.repeat(1000)).text);
});
const now = Date.parse('2026-10-26T12:00:00Z');
it('R304 дата соседа на обеих границах окна остаётся его датой, миллисекунда снаружи заменяется now', () => {
  const past = 30 * 24 * 60 * 60 * 1000, future = 5 * 60 * 1000;
  assert.equal(rules.FED_CREATED_AT_PAST_MS, past); assert.equal(rules.FED_CREATED_AT_FUTURE_MS, future);
  for (const delta of [-past, -past + 1, 0, future - 1, future]) assert.equal(rules.fedCreatedAt(now + delta, now).getTime(), now + delta);
  for (const value of [now - past - 1, now + future + 1, NaN, Infinity, -Infinity]) assert.equal(rules.fedCreatedAt(value, now).getTime(), now);
});
const input: rules.AttachmentAccessInput = { viewerId: 'viewer', viewerDeleted: false,
  att: { ownerId: 'viewer', conversationId: 'group', state: 'attached', messageId: 'message' }, member: { leftAt: null },
  message: { conversationId: 'group', authorId: 'author', deletedAt: null, hiddenFor: [], withheld: false, sortKey: 10, createdAt: new Date(now) } };
it('R304 файл на границе historyFromKey доступен, старее на единицу закрыт; отсутствие границы сохраняет старую историю', () => {
  for (const key of [undefined, null, 9, 10]) assert.equal(rules.attachmentAccess({ ...input, member: { leftAt: null, historyFromKey: key } }), true);
  assert.equal(rules.attachmentAccess({ ...input, member: { leftAt: null, historyFromKey: 11 } }), false);
});
it('R304 бывший участник читает файл до и ровно при выходе, после выхода и без formerUntil отказ', () => {
  for (const delta of [-1, 0, 1]) assert.equal(rules.attachmentAccess({ ...input,
    member: { leftAt: new Date(now), formerUntil: new Date(now) },
    message: { ...input.message!, createdAt: new Date(now + delta) } }), delta <= 0);
  assert.equal(rules.attachmentAccess({ ...input, member: { leftAt: new Date(now) } }), false);
  assert.equal(rules.attachmentAccess({ ...input, member: { leftAt: new Date(now), formerUntil: new Date(now) }, message: { ...input.message!, createdAt: undefined } }), false);
});
it('R304 бывшему не открываются pending и scheduled даже своего файла и разрешённого времени', () => {
  for (const state of ['pending', 'scheduled'] as const) {
    assert.equal(rules.attachmentAccess({ ...input, att: { ...input.att, state }, member: { leftAt: null } }), true);
    assert.equal(rules.attachmentAccess({ ...input, att: { ...input.att, state }, member: { leftAt: new Date(now), formerUntil: new Date(now) } }), false);
  }
  assert.equal(rules.attachmentAccess({ ...input, member: { leftAt: new Date(now), formerUntil: new Date(now), historyFromKey: 11 } }), false,
    'бывшее участие не обходит ограничение истории');
});
for (const m of [
  { title: 'цитата провода как есть', from: 'return resolveReplyQuote(parentContent, quote);', to: 'return quote;', label: 'R304 чужая цитата не принимается', actual: false, expected: true,
    check: (r: typeof rules) => assert.equal(r.fedReplyQuote('Наш текст', { text: 'Подделка', offset: 0 }) === null, true, 'R304 чужая цитата не принимается') },
  { title: 'потеря нижней границы времени', from: 'wireMs < nowMs - FED_CREATED_AT_PAST_MS || ', to: '', label: 'R304 слишком старая дата заменяется now', actual: now - rules.FED_CREATED_AT_PAST_MS - 1, expected: now,
    check: (r: typeof rules) => assert.equal(r.fedCreatedAt(now - rules.FED_CREATED_AT_PAST_MS - 1, now).getTime(), now, 'R304 слишком старая дата заменяется now') },
  { title: 'граница будущего стала включённым отказом', from: 'wireMs > nowMs + FED_CREATED_AT_FUTURE_MS', to: 'wireMs >= nowMs + FED_CREATED_AT_FUTURE_MS', label: 'R304 ровно пять минут будущего принимаются', actual: now, expected: now + rules.FED_CREATED_AT_FUTURE_MS,
    check: (r: typeof rules) => assert.equal(r.fedCreatedAt(now + rules.FED_CREATED_AT_FUTURE_MS, now).getTime(), now + rules.FED_CREATED_AT_FUTURE_MS, 'R304 ровно пять минут будущего принимаются') },
  { title: 'история вложения игнорируется', from: "if (typeof from === 'number' && typeof i.message.sortKey === 'number' && i.message.sortKey < from) return false;", to: '', label: 'R304 прежний файл до вступления закрыт', actual: true, expected: false,
    check: (r: typeof rules) => assert.equal(r.attachmentAccess({ ...input, member: { leftAt: null, historyFromKey: 11 } }), false, 'R304 прежний файл до вступления закрыт') },
]) it(`R304 контрфакт: ${m.title}`, () => {
  m.check(rules); m.check(load(source));
  assert.throws(() => m.check(load(change(m.from, m.to))), failure(m.label, m.actual, m.expected));
});
