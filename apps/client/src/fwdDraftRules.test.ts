import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './fwdDraftRules';

function load(source: string): typeof rules {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as typeof rules };
  runInNewContext(code, { module, exports: module.exports });
  return module.exports;
}

function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./fwdDraftRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(source.includes(from), `найдено место мутации: ${from}`);
  const changed = source.replace(from, to);
  assert.notEqual(changed, source, 'мутант действительно изменил исходник');
  return load(changed);
}

it('имена пересылки считают уникальных исходных авторов и берут снимок forwardedFrom', () => {
  // Повтор одного отправителя не должен сделать «А и ещё 2», а автор пересланной записи не является её источником.
  const author = (id: string, displayName = id) => ({ id, displayName });
  const forwarded = (userId: string, displayName: string, realAuthor = 'forwarder') => ({
    author: author(realAuthor), forwardedFrom: { userId, displayName },
  });
  const list = [forwarded('origin', 'Оригинал', 'forwarder-a'), forwarded('origin', 'Другое имя', 'forwarder-b'),
    { author: author('b', 'Борис') }, { author: author('c', 'Саша') }];
  const nameOf = (id: string, fallback: string) => `${fallback}!${id}`;
  const check = (api: typeof rules) => {
    assert.equal(api.fwdSenders([], nameOf), '');
    assert.equal(api.fwdSenders([{ author: author('a', 'Алиса') }], nameOf), 'Алиса!a');
    assert.equal(api.fwdSenders([{ author: author('a', 'Алиса') }, { author: author('b', 'Борис') }], nameOf), 'Алиса!a и Борис!b');
    assert.equal(api.fwdSenders(list, nameOf), 'Оригинал и ещё 2');
  };
  check(rules);
  const unchangedSource = readFileSync(new URL('./fwdDraftRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  check(load(unchangedSource));
  assert.throws(() => check(mutant('names.length - 1', 'names.length')), assert.AssertionError);
  assert.throws(() => check(mutant('m.forwardedFrom ? m.forwardedFrom.userId : m.author.id', 'm.author.id')), assert.AssertionError);
  assert.throws(() => check(mutant('if (seen.has(id)) continue;', 'if (false) continue;')), assert.AssertionError);
});
