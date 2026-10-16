import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as fields from './fieldRules.js';
import * as wire from './convWire.js';
import * as sync from './convSync.js';

const fixture = (name: string): Record<string, any> => JSON.parse(readFileSync(new URL(`./fixtures/v1/${name}.json`, import.meta.url), 'utf8'));
const example = fixture('conv-message-poll');
const votes = fixture('conv-poll-votes');
const normal = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const raw = readFileSync(new URL('./convWire.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(edit?: readonly [string, string]): typeof wire {
  let source = raw;
  if (edit) { assert.equal(source.split(edit[0]).length, 2, 'единственный whole-module якорь R222'); source = source.replace(...edit); }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require(id: string) { assert.equal(id, './fieldRules'); return fields; } });
  return module.exports as typeof wire;
}
const killed = (prefix: string, actual: unknown, expected: unknown) => (error: unknown) => {
  if (!(error instanceof assert.AssertionError) || error.code !== 'ERR_ASSERTION' || !error.message.startsWith(prefix) || error.operator !== 'strictEqual') return false;
  assert.equal(error.actual, actual); assert.equal(error.expected, expected); return true;
};

test('R222 историческая викторина проходит полный провод сообщения без потери correct, solution и closed', () => {
  const parsed = wire.parseConvMessageWire(example); assert.ok(parsed);
  assert.deepEqual(wire.serializeConvMessageWire(parsed), example);
});
test('R222 провод викторины требует существующий correct, обычному опросу правильный ответ не нужен', () => {
  for (const correct of [undefined, null, 'missing', 1]) assert.equal(wire.parseConvMediaWire({ ...example.media, correct }), null);
  assert.equal(wire.parseConvMediaWire({ ...example.media, quiz: false, correct: undefined })?.kind, 'poll');
});
test('R222 повтор id отвергается, разные id с одинаковой подписью в проводе не смешиваются', () => {
  const options = [{ id: '0', text: 'Да' }, { id: '0', text: 'Нет' }];
  assert.equal(wire.parseConvMediaWire({ ...example.media, options, correct: '0' }), null);
  options[1].id = '1'; options[1].text = 'Да';
  assert.equal(wire.parseConvMediaWire({ ...example.media, options, correct: '0' })?.kind, 'poll');
});
test('R222 границы числа вариантов 2 и 10 принимаются, 1 и 11 отвергаются', () => {
  for (const count of [1, 2, 10, 11]) {
    const options = Array.from({ length: count }, (_, i) => ({ id: `${i}`, text: `Ответ ${i}` }));
    assert.equal(wire.parseConvMediaWire({ ...example.media, options, correct: '0' })?.kind ?? null, count === 1 || count === 11 ? null : 'poll');
  }
});
test('R222 quiz выключает multi, обычный опрос сохраняет multi и не раскрывает поля викторины', () => {
  const quiz = wire.parseConvMediaWire({ ...example.media, multi: true }); assert.equal(quiz?.kind, 'poll');
  assert.equal((quiz as wire.FedConvPollWire).multi, false);
  const poll = wire.parseConvMediaWire({ ...example.media, quiz: false, multi: true }) as wire.FedConvPollWire;
  assert.equal(poll.multi, true); assert.equal(poll.correct, null); assert.equal(poll.solution, null);
  assert.equal(Object.hasOwn(wire.serializeConvMediaWire(poll), 'correct'), false);
});
test('R222 обе исторические строки pollvote и отмена голоса сохраняют провод туда-обратно', () => {
  const page = wire.parseConvChangesPage(votes); assert.ok(page && 'items' in page);
  assert.deepEqual(wire.serializeConvChangesPage(page), votes);
  for (const item of votes.items) {
    const parsed = sync.parseConvPollVotesWire(item.entity); assert.ok(parsed);
    assert.deepEqual(sync.serializeConvPollVotesWire(parsed), item.entity);
  }
});
test('R222 пустые options и не-массив пропускают человека, повторы вариантов схлопываются', () => {
  const user = votes.items[0].entity.voters[0].user;
  const parsed = sync.parseConvPollVotesWire({ message_id: 'poll-message', voters: [
    { user, options: [] }, { user, options: '0' }, { user, options: ['0', '0', '1', '', 2, null, '123456789'] },
  ] });
  assert.deepEqual(parsed, { messageId: 'poll-message', voters: [{ user: wire.parsePersonRef(user), options: ['0', '1'] }] });
  assert.deepEqual(sync.parseConvPollVotesWire({ message_id: 'poll-message', voters: [] }), { messageId: 'poll-message', voters: [] });
  for (const bad of [null, {}, { message_id: 'poll-message', voters: {} }]) assert.equal(sync.parseConvPollVotesWire(bad), null);
});
function correctContract(api: typeof wire) {
  const parsed = api.parseConvMediaWire(example.media) as wire.FedConvPollWire;
  assert.equal(parsed?.correct, '1', 'разбор сохраняет правильный вариант');
  assert.equal(api.serializeConvMediaWire(parsed).correct, '1', 'сериализация сохраняет правильный вариант');
}
test('R222 контрфакт: удаление correct из сериализации убито точным полем полного модуля', () => {
  correctContract(load());
  assert.throws(() => correctContract(load(['{ correct: m.correct, solution: m.solution }', '{ solution: m.solution }'])),
    killed('сериализация сохраняет правильный вариант', undefined, '1'));
});
test('R222 контрфакт: потеря correct при разборе убита результатом целого модуля', () => {
  correctContract(load());
  assert.throws(() => correctContract(load(['    correct,\n    solution: quiz', '    correct: null,\n    solution: quiz'])),
    killed('разбор сохраняет правильный вариант', null, '1'));
});
test('R222 контрфакт: closed всегда false не переживает историческую закрытую викторину', () => {
  const scenario = (api: typeof wire) => assert.equal((api.parseConvMediaWire(example.media) as wire.FedConvPollWire)?.closed, true, 'закрытие сохраняется в проводе');
  scenario(load());
  assert.throws(() => scenario(load(['closed: r.closed === true,', 'closed: false,'])), killed('закрытие сохраняется в проводе', false, true));
});
test('R222 определение опроса не переносит клиентские счётчики и мой выбор в провод', () => {
  const m = { ...example.media, revealed: true, my: ['0'], voters: 9, options: example.media.options.map((o: any) => ({ ...o, votes: 7 })) };
  const converted = wire.convMediaToWire(m, 'self'); assert.ok(converted);
  assert.deepEqual(normal(wire.serializeConvMediaWire(converted)), example.media);
});
