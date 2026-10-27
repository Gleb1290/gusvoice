import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { commandTokenAt } from './messagePaneRules';
import * as emojiShortcodes from './emojiShortcodes';

const source = readFileSync(new URL('./messagePaneRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Rules = typeof import('./messagePaneRules');

function mutated(before: string, after: string): Rules {
  assert.equal(source.split(before).length - 1, 1, 'мутация попадает в единственный настоящий якорь');
  const module = { exports: {} as Rules };
  runInNewContext(ts.transpileModule(source.replace(before, after), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports,
    require: (id: string) => { assert.equal(id, './emojiShortcodes'); return emojiShortcodes; },
  });
  return module.exports;
}

function expectedTokenAssertion(error: unknown, message: string): boolean {
  if (!(error instanceof assert.AssertionError) || error.code !== 'ERR_ASSERTION' ||
    error.message.split('\n')[0] !== message || error.operator !== 'strictEqual' || error.expected !== null ||
    error.actual === null || typeof error.actual !== 'object') return false;
  const actual = error.actual as Record<string, unknown>;
  return Object.keys(actual).length === 3 && actual.trigger === '/' && actual.query === 'st' && actual.start === 0;
}

it('R302 одиночный слеш открывает все команды, короткая и полная команды дают префикс', () => {
  assert.deepEqual(commandTokenAt('/', 1), { trigger: '/', query: '', start: 0 });
  assert.deepEqual(commandTokenAt('/st', 3), { trigger: '/', query: 'st', start: 0 });
  assert.deepEqual(commandTokenAt('/status', 7), { trigger: '/', query: 'status', start: 0 });
});

it('R302 каретка внутри первого слова берёт только набранную часть, текст справа не мешает', () => {
  assert.deepEqual(commandTokenAt('/status later', 3), { trigger: '/', query: 'st', start: 0 });
  assert.deepEqual(commandTokenAt('/status later', 7), { trigger: '/', query: 'status', start: 0 });
  assert.equal(commandTokenAt('/status later', 8), null, 'сразу за пробелом список уже закрыт');
});

it('R302 до слеша и без каретки подсказки нет, латиница с цифрами и подчёркиванием допустима', () => {
  assert.equal(commandTokenAt('/status', 0), null);
  assert.equal(commandTokenAt('/status', null), null);
  assert.deepEqual(commandTokenAt('/A_1', 4), { trigger: '/', query: 'A_1', start: 0 });
  assert.equal(commandTokenAt('/ста', 4), null);
});

function rejectsMiddle(rule: typeof commandTokenAt) {
  assert.equal(rule('a/st', 4), null, 'R302 слеш внутри слова не открывает команды');
}
function rejectsLeading(rule: typeof commandTokenAt) {
  assert.equal(rule(' /st', 4), null, 'R302 даже ведущий пробел запрещает командную подсказку');
}

it('R302 слеш внутри слова, после текста и после ведущего пробела не становится командой', () => {
  rejectsMiddle(commandTokenAt);
  rejectsLeading(commandTokenAt);
  assert.equal(commandTokenAt('a /st', 5), null);
  assert.equal(commandTokenAt('\n/st', 4), null);
  assert.equal(commandTokenAt('\t/st', 4), null);
});

it('R302 URL и второй слеш пути не открывают подсказку, первый сегмент до второго слеша ещё допустим', () => {
  assert.equal(commandTokenAt('http://x', 8), null);
  assert.equal(commandTokenAt('/etc/hosts', 5), null);
  assert.equal(commandTokenAt('/etc/hosts', 10), null);
  assert.deepEqual(commandTokenAt('/etc/hosts', 4), { trigger: '/', query: 'etc', start: 0 });
});

it('R303 канал допускает ник бота и пустой префикс ника, ЛС сохраняют прежний синтаксис', () => {
  for (const value of ['/status@weatherbot', '/st@', '/@weather_bot', '/ST@Bot_12']) {
    assert.deepEqual(commandTokenAt(value, value.length, true), { trigger: '/', query: value.slice(1), start: 0 });
    assert.equal(commandTokenAt(value, value.length), null, 'расширение включается только для канала');
  }
  assert.deepEqual(commandTokenAt('/status@weatherbot later', 10, true), { trigger: '/', query: 'status@we', start: 0 });
  for (const value of [' /st@bot', 'a /st@bot', '/st@bot arg', '/st@@bot', '/st@бот', '/st@a/b'])
    assert.equal(commandTokenAt(value, value.length, true), null, value);
  assert.equal(commandTokenAt('/st@bot', null, true), null);
});

it('R303 контрфакт игнорирования withBot теряет именно адресную подсказку канала', () => {
  const probe = (rule: typeof commandTokenAt) => assert.equal(rule('/st@weatherbot', 14, true)?.query, 'st@weatherbot',
    'R303 адресная команда сохраняется в подсказке канала');
  probe(commandTokenAt);
  const anchor = 'if (withBot) {';
  probe(mutated(anchor, anchor).commandTokenAt);
  assert.throws(() => probe(mutated(anchor, 'if (false) {').commandTokenAt), (e: unknown) =>
    e instanceof assert.AssertionError && e.code === 'ERR_ASSERTION' && e.operator === 'strictEqual' &&
    e.message.split('\n')[0] === 'R303 адресная команда сохраняется в подсказке канала' && e.actual === undefined && e.expected === 'st@weatherbot');
});

it('R302 контрфакт допуска слеша внутри слова ломает именно отрицательный пример', () => {
  rejectsMiddle(commandTokenAt);
  const anchor = 'const m = /^\\/([A-Za-z0-9_]*)$/.exec(value.slice(0, caret));';
  rejectsMiddle(mutated(anchor, anchor).commandTokenAt);
  const mutant = mutated(anchor,
    'const m = /^[A-Za-z0-9_]*\\/([A-Za-z0-9_]*)$/.exec(value.slice(0, caret));');
  assert.throws(() => rejectsMiddle(mutant.commandTokenAt), (e: unknown) =>
    expectedTokenAssertion(e, 'R302 слеш внутри слова не открывает команды'));
});

it('R302 контрфакт без якоря начала поля ловит подсказку после ведущего пробела', () => {
  rejectsLeading(commandTokenAt);
  const anchor = 'const m = /^\\/([A-Za-z0-9_]*)$/.exec(value.slice(0, caret));';
  rejectsLeading(mutated(anchor, anchor).commandTokenAt);
  const mutant = mutated(anchor,
    'const m = /\\/([A-Za-z0-9_]*)$/.exec(value.slice(0, caret));');
  assert.throws(() => rejectsLeading(mutant.commandTokenAt), (e: unknown) =>
    expectedTokenAssertion(e, 'R302 даже ведущий пробел запрещает командную подсказку'));
});
