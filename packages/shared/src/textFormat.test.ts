import assert from 'node:assert/strict';
import { it } from 'node:test';
import { stripFormatting } from './textFormat';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

it('превью снимает визуальные маркеры, оставляет snake_case и URL, а спойлер не раскрывает', () => {
  // Пуш не должен показывать скрытый текст или повреждать адрес, похожий на курсив.
  assert.equal(stripFormatting('**жирный** __курсив__ ~~нет~~ <u>низ</u>'), 'жирный курсив нет низ');
  for (const s of ['snake_case','https://a.com/__x__/']) assert.equal(stripFormatting(s),s);
  assert.equal(stripFormatting('||секрет||'),'▚'.repeat(6)); assert.equal(stripFormatting('||секрет||',{ spoiler:'keep' }),'секрет');
  assert.equal(stripFormatting('`**код**`'),'**код**');
  const source = readFileSync(new URL('./textFormat.ts', import.meta.url), 'utf8');
  const before = String.raw`(?<![\\p{L}\\p{N}_])`;
  const after = String.raw`(?![\\p{L}\\p{N}_])`;
  assert.ok(source.includes(before) && source.includes(after), 'мутант убирает существующие границы слова');
  const module = { exports: {} as { stripFormatting: typeof stripFormatting } };
  runInNewContext(ts.transpileModule(source.replace(before, '').replace(after, ''), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
  // У текущей грамматики одиночные подчёркивания внутри двойных всё ещё дают курсив: результат snake_x_case, не snakexcase.
  assert.equal(stripFormatting('snake__x__case'), 'snake_x_case');
  assert.throws(() => assert.equal(module.exports.stripFormatting('snake__x__case'), 'snake_x_case'), assert.AssertionError);
});
