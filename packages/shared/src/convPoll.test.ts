import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as real from './convPoll';

type Api = typeof real;
const source = readFileSync(new URL('./convPoll.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const draft = (extra: Partial<real.ConvPollInput> = {}): real.ConvPollInput => ({ kind: 'poll', question: 'Вопрос?', options: ['Первый', 'Второй'], ...extra });
function poll(extra: Partial<real.ConvPollInput> = {}, api: Api = real) {
  const r = api.convPollDraft(draft(extra)); assert.ok(r.ok, 'годный черновик принят'); return r.poll;
}
function error(extra: Partial<real.ConvPollInput>, expected: string) { assert.deepEqual(real.convPollDraft(draft(extra)), { ok: false, error: expected }); }
function load(raw = source): Api {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => assert.fail(`чистый опрос не требует ${id}`) });
  return module.exports as Api;
}
it('R219 пустые варианты удаляются, правильный индекс переносится на оставшиеся без потери порядка', () => {
  const p = poll({ question: '  Вопрос?  ', options: [' ', ' Один ', '', ' Два ', '\t'], quiz: true, correct: 3 });
  assert.equal(p.question, 'Вопрос?'); assert.equal(p.correct, '1');
  assert.deepEqual(p.options, [{ id: '0', text: 'Один', votes: 0 }, { id: '1', text: 'Два', votes: 0 }]);
});
for (const question of ['', ' \t ']) it(`R219 пустой вопрос ${JSON.stringify(question)} отвергается`, () => error({ question }, 'нужен вопрос'));
for (const [field, limit, message] of [['question', 255, 'слишком длинный вопрос'], ['option', 100, 'слишком длинный вариант'], ['solution', 200, 'слишком длинное пояснение']] as const) {
  const input = (n: number): Partial<real.ConvPollInput> => field === 'question' ? { question: `  ${'в'.repeat(n)} \t` }
    : field === 'option' ? { options: [`  ${'в'.repeat(n)} \t`, 'другой'] } : { quiz: true, correct: 0, solution: `  ${'п'.repeat(n)} \t` };
  it(`R219 ${field} ровно ${limit} символов принимается после обрезки краёв`, () => {
    assert.equal(real.convPollDraft(draft(input(limit))).ok, true);
  });
  it(`R219 ${field} ${limit + 1} символов отвергается`, () => error(input(limit + 1), message));
}
for (const [n, valid] of [[1, false], [2, true], [10, true], [11, false]] as const) it(`R219 ${n} непустых вариантов ${valid ? 'принимаются' : 'отвергаются'}`, () => {
  const r = real.convPollDraft(draft({ options: Array.from({ length: n }, (_, i) => `Вариант ${i}`) }));
  assert.equal(r.ok, valid);
  if (!r.ok) assert.equal(r.error, n === 1 ? 'нужно минимум два варианта' : 'слишком много вариантов');
});
it('R219 повтор без учёта регистра отвергается, различные варианты принимаются', () => {
  error({ options: ['ДА', ' да '] }, 'варианты повторяются'); assert.equal(poll({ options: ['ДА', 'Нет'] }).options.length, 2);
});
it('R219 анонимность включена по умолчанию, явный false выключает, обычный multi сохраняется', () => {
  assert.equal(poll().anonymous, true); assert.equal(poll({ anonymous: false }).anonymous, false);
  assert.equal(poll({ multi: true }).multi, true); assert.equal(poll().multi, false);
});
function quiz(api = real) {
  const p = poll({ quiz: true, correct: 0, multi: true }, api);
  assert.equal(p.multi, false, 'R219-quiz-single: викторина не принимает несколько ответов');
  assert.equal(p.correct, '0'); assert.equal(p.solution, null);
}
it('R219 викторина сбрасывает присланный multi и сохраняет единственный правильный вариант', () => quiz());
for (const correct of [undefined, null, -1, 2, 0.5]) it(`R219 викторина без годного правильного индекса ${correct} отвергается`, () => error({ quiz: true, correct }, 'выберите правильный ответ'));
it('R219 правильный индекс пустого поля не переносится на соседний вариант', () => {
  error({ options: ['Первый', '', 'Второй'], quiz: true, correct: 1 }, 'выберите правильный ответ');
});
const votes = [{ userId: 'voter-a', optionId: '0' }, { userId: 'voter-a', optionId: '1' }, { userId: 'voter-b', optionId: '1' }, { userId: 'phantom', optionId: 'unknown' }];
function hidden(api = real) {
  const p = api.convPollView(poll({ quiz: true, correct: 0, solution: 'Пояснение' }, api), votes, 'observer');
  assert.equal(p.options[1]!.votes, 0, 'R219-hidden-counts: до голоса распределение не уходит клиенту');
  assert.equal(p.revealed, false); assert.equal(p.voters, 2); assert.deepEqual(plain(p.my), []);
  assert.equal(Object.hasOwn(p, 'correct'), false); assert.equal(Object.hasOwn(p, 'solution'), false);
}
it('R219 наблюдатель до своего голоса видит только число людей, без распределения и ответа викторины', () => hidden());
it('R219 голосовавший видит распределение, свои варианты в порядке опроса и правильный ответ', () => {
  const p = real.convPollView(poll({ quiz: true, correct: 0, solution: 'Пояснение' }), [...votes].reverse(), 'voter-a');
  assert.equal(p.revealed, true); assert.equal(p.voters, 2); assert.deepEqual(p.options.map(o => o.votes), [1, 2]);
  assert.deepEqual(p.my, ['0', '1']); assert.equal(p.correct, '0'); assert.equal(p.solution, 'Пояснение');
});
function closed(api = real) {
  const p = api.convPollView({ ...poll({ quiz: true, correct: 0 }, api), closed: true }, votes, 'observer');
  assert.equal(p.revealed, true, 'R219-closed-reveal: закрытие открывает итоги и не голосовавшему');
  assert.equal(p.options[1]!.votes, 2); assert.equal(p.correct, '0');
}
it('R219 закрытый опрос раскрывает итоги и не голосовавшему наблюдателю', () => closed());
it('R219 входной опрос и массив голосов не изменяются, неизвестный вариант не добавляет даже voters', () => {
  const stored = poll(), before = JSON.stringify(stored), list = Object.freeze(votes.map(v => Object.freeze({ ...v })));
  const p = real.convPollView(stored, list, 'phantom');
  assert.equal(JSON.stringify(stored), before); assert.equal(p.voters, 2); assert.deepEqual(p.my, []);
});
for (const [name, config, mine, ids, message, code] of [
  ['закрыт', { closed: true }, [], ['0'], 'опрос закрыт', 403],
  ['нет голоса для отмены', {}, [], [], 'вы ещё не голосовали', 400],
  ['викторина не отменяется', { quiz: true }, ['0'], [], 'ответ в викторине отменить нельзя', 403],
  ['повторный голос', {}, ['0'], ['1'], 'вы уже проголосовали', 400],
  ['повтор варианта', { multi: true }, [], ['0', '0'], 'вариант повторяется', 400],
  ['несколько в одиночном', {}, [], ['0', '1'], 'в этом опросе можно выбрать только один вариант', 400],
  ['неизвестный вариант', {}, [], ['missing'], 'нет такого варианта', 400],
] as const) it(`R219 голос отклоняется с точным кодом: ${name}`, () => {
  assert.deepEqual(real.checkConvPollVote({ ...poll(), ...config }, mine, ids), { ok: false, error: message, code });
});
it('R219 первый одиночный, первый multi и отмена обычного голоса принимаются', () => {
  assert.deepEqual(real.checkConvPollVote(poll(), [], ['0']), { ok: true });
  assert.deepEqual(real.checkConvPollVote(poll({ multi: true }), [], ['0', '1']), { ok: true });
  assert.deepEqual(real.checkConvPollVote(poll(), ['0'], []), { ok: true });
});
function quizCancel(api = real) {
  const r = api.checkConvPollVote(poll({ quiz: true, correct: 0 }, api), ['0'], []);
  assert.equal(r.ok, false, 'R219-quiz-cancel: окончательный ответ викторины нельзя отменить');
  if (!r.ok) { assert.equal(r.code, 403); assert.equal(r.error, 'ответ в викторине отменить нельзя'); }
}
it('R219 проценты дают ровно 100 для любого ненулевого набора, нулевой вариант не получает остаток', () => {
  for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) for (let c = 0; c < 10; c++) {
    const options = [a, b, c].map((v, i) => ({ id: `${i}`, text: `${i}`, votes: v })), p = real.convPollPercents(options);
    assert.equal(p.reduce((s, n) => s + n, 0), a + b + c === 0 ? 0 : 100);
    p.forEach((n, i) => { assert.ok(Number.isInteger(n) && n >= 0 && n <= 100); if (options[i]!.votes === 0) assert.equal(n, 0); });
  }
  assert.deepEqual(real.convPollPercents([]), []);
  assert.deepEqual(real.convPollPercents([1, 1, 1].map((v, i) => ({ id: `${i}`, text: `${i}`, votes: v }))), [34, 33, 33]);
});
for (const n of [1, 2, 10, 11]) it(`R219 разбор ${n} вариантов принимает только 2–10`, () => {
  const p = { ...poll(), options: Array.from({ length: n }, (_, i) => ({ id: `${i}`, text: `Вариант ${i}` })) };
  assert.equal(real.parseConvPoll(p) !== null, n >= 2 && n <= 10);
});
it('R219 разбор повторного id отвергается, разных id с нулевыми необязательными итогами принимается', () => {
  const p = poll(); assert.equal(real.parseConvPoll({ ...p, options: p.options.map(o => ({ ...o, id: 'same' })) }), null);
  const parsed = real.parseConvPoll({ ...p, my: ['unknown', '0', 1], voters: -1, options: p.options.map(o => ({ ...o, votes: 0.5 })) });
  assert.ok(parsed); assert.deepEqual(parsed.my, ['0']); assert.equal(parsed.voters, 0); assert.deepEqual(parsed.options.map(o => o.votes), [0, 0]);
});
it('R219 разбор битого вопроса или варианта не превращает повреждённый опрос в валидную карточку', () => {
  for (const value of [{ ...poll(), question: '' }, { ...poll(), options: null }, { ...poll(), options: [null, {}] }, { ...poll(), options: [{ id: '', text: 'a' }, { id: '1', text: 'b' }] }]) assert.equal(real.parseConvPoll(value), null);
});
it('R219 подпись и запасной текст не раскрывают правильный ответ, окончания учитывают 11–14', () => {
  const p = poll({ quiz: true, correct: 1, solution: 'секрет пояснения' });
  assert.equal(real.convPollFallback(p), '📊 Викторина: Вопрос?\n— Первый\n— Второй');
  assert.equal(real.convPollPreview(p), 'Викторина: Вопрос?');
  for (const [n, suffix] of [[0, 'Нет голосов'], [1, '1 голос'], [2, '2 голоса'], [5, '5 голосов'], [11, '11 голосов'], [14, '14 голосов'], [21, '21 голос']] as const) assert.equal(real.convPollVotersText(n, false), suffix);
});
for (const [name, from, to, check, prefix, actual, expected] of [
  ['распределение раскрыто до голоса', 'votes: revealed ? valid.filter((v) => v.optionId === o.id).length : 0', 'votes: valid.filter((v) => v.optionId === o.id).length', hidden, 'R219-hidden-counts:', 2, 0],
  ['закрытие не раскрывает итоги', 'my.length > 0 || stored.closed', 'my.length > 0', closed, 'R219-closed-reveal:', false, true],
  ['отмена ответа викторины разрешена', "if (poll.quiz) return { ok: false, error: 'ответ в викторине отменить нельзя', code: 403 };", '', quizCancel, 'R219-quiz-cancel:', true, false],
  ['викторина стала multi', '!quiz && input.multi === true', 'input.multi === true', quiz, 'R219-quiz-single:', true, false],
] as const) it(`R219 контрфакт правил опроса: ${name}`, () => {
  check(load(source)); assert.equal(source.split(from).length - 1, 1);
  assert.throws(() => check(load(source.replace(from, to))), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
});
