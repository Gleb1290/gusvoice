import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';
import type { ConvFrequentItem, DmChannel } from '@gusvoice/shared';
import { frequentStrip, hideFrequent, parseFrequentHidden, FREQUENT_MAX, FREQUENT_HIDDEN_MAX } from './dmListSearchRules';
import { serverFrequent } from './convSyncRules';

const at = '2026-10-09T12:00:00.000Z';
const dm = (id: string, extra: Partial<DmChannel> = {}): DmChannel => ({ id, createdAt: at, lastMessageAt: at,
  otherUser: { id: `peer-${id}`, username: id, displayName: id, avatarUrl: null }, ...extra } as DmChannel);
const item = (conversationId: string, lastAt = at): ConvFrequentItem => ({ conversationId, lastAt, score: 1 });

it('R119 частые сохраняют рейтинг сервера, но убирают архив, избранное, gone и блок', () => {
  // Свежесть последнего входящего не должна заменять серверный рейтинг моих сообщений.
  const dms = [dm('older', { lastMessageAt: '2025-01-01T00:00:00Z' }), dm('newer'), dm('archived', { archived: true }),
    dm('saved', { saved: true }), dm('gone', { otherUser: { id: 'gone:peer', username: '', displayName: '' } as DmChannel['otherUser'] }), dm('blocked')];
  const items = ['missing', 'archived', 'older', 'saved', 'gone', 'blocked', 'newer'].map(id => item(id));
  const before = JSON.stringify({ items, dms });
  assert.deepEqual(frequentStrip(items, dms, {}, new Set(['peer-blocked'])).map(d => d.id), ['older', 'newer']);
  assert.deepEqual(frequentStrip([item('blocked')], dms, {}, new Set()).map(d => d.id), ['blocked']);
  assert.equal(JSON.stringify({ items, dms }), before, 'отсев не меняет входные массивы');
});

it('R119 предел 15 считается после отсева, ровно предел сохранён и лишний не показан', () => {
  assert.equal(FREQUENT_MAX, 15);
  const dms = [dm('archived', { archived: true }), ...Array.from({ length: 16 }, (_, i) => dm(String(i)))];
  const items = dms.map(d => item(d.id));
  assert.deepEqual(frequentStrip(items, dms, {}, new Set()).map(d => d.id), Array.from({ length: 15 }, (_, i) => String(i)));
  assert.equal(frequentStrip(items.slice(0, 16), dms, {}, new Set()).length, 15);
  assert.deepEqual(frequentStrip(items, dms, {}, new Set(), 1).map(d => d.id), ['0']);
  assert.deepEqual(frequentStrip([], dms, {}, new Set()), []);
});

it('R119 убранная частая скрыта до равного lastAt и возвращается на следующей миллисекунде', () => {
  // >= вместо > возвращало бы беседу сразу после «Убрать», ещё без нового вклада человека.
  const dms = [dm('chat')], hidden = { chat: at };
  for (const lastAt of ['2026-10-09T11:59:59.999Z', at, 'не дата'])
    assert.deepEqual(frequentStrip([item('chat', lastAt)], dms, hidden, new Set()), []);
  assert.deepEqual(frequentStrip([item('chat', '2026-10-09T12:00:00.001Z')], dms, hidden, new Set()).map(d => d.id), ['chat']);
  assert.equal(frequentStrip([item('chat')], dms, {}, new Set()).length, 1);
});

it('R119 повреждённый кеш скрытых безопасен, допустимые даты и id не теряются', () => {
  for (const raw of [undefined, null, '', '{', 'null', '[]', '42', '"text"']) assert.deepEqual(parseFrequentHidden(raw), {});
  assert.deepEqual(parseFrequentHidden(JSON.stringify({ good: at, other: '2026-01-01T00:00:00Z', '': at,
    bad: 'не дата', number: 3, object: {}, nil: null })), { good: at, other: '2026-01-01T00:00:00Z' });
});

it('R119 ровно сто скрытых не обрезаются, обновление существующей не добавляет запись', () => {
  assert.equal(FREQUENT_HIDDEN_MAX, 100);
  const hidden = Object.fromEntries(Array.from({ length: 99 }, (_, i) => [`c${i}`, at]));
  const next = hideFrequent(hidden, 'last', at);
  assert.equal(Object.keys(next).length, 100); assert.equal(next.last, at);
  assert.equal(Object.keys(hidden).length, 99, 'исходный кеш не мутирует');
  const updated = hideFrequent(next, 'c0', '2026-10-09T12:00:00.001Z');
  assert.equal(Object.keys(updated).length, 100); assert.equal(updated.c0, '2026-10-09T12:00:00.001Z');
  assert.equal(next.c0, at);
});

it('R119 сто первая скрытая вытесняет старейшую по дате, не по порядку ключей', () => {
  const hidden = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`c${i}`, new Date(Date.parse(at) + i).toISOString()]));
  hidden.c99 = '2020-01-01T00:00:00Z';
  const next = hideFrequent(hidden, 'new', '2026-10-09T12:00:01.000Z');
  assert.equal(Object.keys(next).length, 100); assert.equal(next.c99, undefined); assert.ok(next.c0); assert.ok(next.new);
  assert.ok(hidden.c99, 'вытеснение не стирает входной объект');
});

it('R119 частые доступны только при freq1, старые поисковые возможности не включают их', () => {
  for (const features of [undefined, null, [], ['gsearch1'], ['conv8'], ['freq10']]) assert.equal(serverFrequent(features), false);
  assert.equal(serverFrequent(['freq1']), true); assert.equal(serverFrequent(['gsearch1', 'freq1']), true);
});

it('R119 страж частых ловит архивный пропуск, нестрогое возвращение и сортировку по свежести', () => {
  const raw = readFileSync(new URL('./dmListSearchRules.ts', import.meta.url), 'utf8');
  const check = (source: string) => {
    const ast = ts.createSourceFile('rules.ts', source, ts.ScriptTarget.Latest, true);
    const fn = ast.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'frequentStrip');
    assert.ok(fn?.body);
    const body = fn.body.getText(ast);
    assert.match(body, /d\.archived\s*===\s*true/, 'архив отсекается');
    assert.match(body, /Date\.parse\(it\.lastAt\)\s*>\s*Date\.parse\(h\)/, 'возвращается только новое сообщение');
    assert.doesNotMatch(body, /\.sort\s*\(/, 'порядок сервера не заменяется свежестью');
    assert.match(body, /for\s*\(const it of items\)/);
  };
  check(raw);
  for (const [from, to] of [
    ['d.archived === true || ', ''],
    ['Date.parse(it.lastAt) > Date.parse(h)', 'Date.parse(it.lastAt) >= Date.parse(h)'],
    ['for (const it of items)', 'for (const it of items.slice().sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt)))'],
  ]) {
    assert.ok(raw.includes(from!), 'якорь настоящего контрфакта найден');
    assert.throws(() => check(raw.replace(from!, to!)), assert.AssertionError);
  }
});
