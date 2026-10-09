import assert from 'node:assert/strict';
import { it } from 'node:test';
import { applyFieldFormat, formatHotkey, textReplacement, revertReplacement } from './fieldFormat';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import type * as API from './fieldFormat';

function mutant(from: string, to: string): typeof API {
  const source = readFileSync(new URL('./fieldFormat.ts', import.meta.url), 'utf8'); assert.ok(source.includes(from));
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.equal(id, '@gusvoice/shared'); return shared; } });
  return module.exports as typeof API;
}

it('формат оборачивается и снимается повтором, пробелы остаются снаружи и слои не множатся', () => {
  // Повтор Ctrl+B должен снимать жирный, а не вкладывать новые маркеры в уже жирный текст.
  const one = applyFieldFormat(' x ',0,3,'bold'); assert.deepEqual(one,{ value:' **x** ',start:3,end:4 });
  assert.deepEqual(applyFieldFormat(one!.value,one!.start,one!.end,'bold'),{ value:' x ',start:1,end:2 });
  assert.equal(applyFieldFormat('__**x**__',4,5,'italic')?.value,'**x**');
  assert.throws(() => assert.equal(mutant('if (!layer) break;', 'break;').applyFieldFormat('__**x**__',4,5,'italic')?.value,'**x**'), assert.AssertionError);
  assert.equal(applyFieldFormat('  ',0,2,'bold'),null); assert.equal(applyFieldFormat('x',1,1,'bold'),null);
});
it('моно по строкам становится блоком, цитата переключается, снятие убирает все слои', () => {
  // Блочный код и вложенная разметка не должны оставлять парные маркеры после снятия.
  const mono = applyFieldFormat('x\ny',0,3,'mono'); assert.equal(mono?.value,'```\nx\ny\n```');
  assert.equal(applyFieldFormat(mono!.value,mono!.start,mono!.end,'mono')?.value,'x\ny');
  assert.equal(applyFieldFormat('a x b',2,3,'mono')?.value,'a `x` b');
  const quote = applyFieldFormat('x\ny',0,3,'quote'); assert.equal(quote?.value,'> x\n> y');
  assert.equal(applyFieldFormat(quote!.value,quote!.start,quote!.end,'quote')?.value,'x\ny');
  assert.equal(applyFieldFormat('__**x**__',4,5,'clear')?.value,'x');
});
it('горячая клавиша физическая, автозамены не работают в коде или вставке и Backspace возвращает оригинал', () => {
  // Замена -- в программном коде меняет смысл, а откат должен вернуть именно исходные символы.
  assert.equal(formatHotkey({ code:'KeyB',ctrlOrMeta:true,shift:false,alt:false }),'bold');
  assert.equal(formatHotkey({ code:'KeyB',ctrlOrMeta:true,shift:false,alt:true }),null);
  const r = textReplacement('--',2,'-'); assert.equal(r?.value,'—');
  assert.equal(textReplacement('`--',3,'-'),null); assert.equal(textReplacement('--',2,null),null);
  assert.throws(() => assert.equal(mutant("if ((line.split('`').length - 1) % 2 === 1) return null;", '').textReplacement('`--',3,'-'),null), assert.AssertionError);
  for (const [s,t] of [['<<','«'],['>>','»']] as const) assert.equal(textReplacement(s,2,s[1])?.value,t);
  assert.ok(r,'замена для отката найдена');
  assert.equal(revertReplacement(r.value,r.caret,r.caret,r.undo)?.value,'--');
});
