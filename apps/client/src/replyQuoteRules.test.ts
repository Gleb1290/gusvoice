import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { REPLY_QUOTE_MAX } from '@gusvoice/shared';
import * as rules from './replyQuoteRules';

function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./replyQuoteRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: () => ({ REPLY_QUOTE_MAX }) });
  return module.exports as typeof rules;
}

it('выделение нормализует CRLF, обрезает края, ищет ближайшее вхождение и допускает точный предел', () => {
  const content = 'цитата сначала\nцитата\nснова';
  assert.deepEqual(rules.quoteFromSelection(content, '  цитата\r\nснова  '), { text: 'цитата\nснова', offset: 15 });
  assert.deepEqual(rules.quoteFromSelection('слово — слово', 'слово', 10), { text: 'слово', offset: 8 });
  assert.deepEqual(rules.quoteFromSelection('x'.repeat(REPLY_QUOTE_MAX), 'x'.repeat(REPLY_QUOTE_MAX)), { text: 'x'.repeat(REPLY_QUOTE_MAX), offset: 0 });
  assert.equal(rules.quoteFromSelection('x'.repeat(REPLY_QUOTE_MAX + 1), 'x'.repeat(REPLY_QUOTE_MAX + 1)), 'too-long');
  assert.equal(rules.quoteFromSelection('abc', '   '), null);
  assert.equal(rules.quoteFromSelection('abc', 'нет'), null);
  const tooLongMutant = mutant('if (text.length > REPLY_QUOTE_MAX) return \'too-long\';', 'if (false) return \'too-long\';');
  assert.throws(() => assert.equal(tooLongMutant.quoteFromSelection('x'.repeat(REPLY_QUOTE_MAX + 1), 'x'.repeat(REPLY_QUOTE_MAX + 1)), 'too-long'), assert.AssertionError,
    'мутант принимает цитату длиннее максимума и расходится с серверным пределом');
});

it('граничная суррогатная пара считается в UTF-16, не обрезается посередине эмодзи', () => {
  const text = 'a'.repeat(REPLY_QUOTE_MAX - 2) + '🙂';
  assert.equal(text.length, REPLY_QUOTE_MAX);
  assert.deepEqual(rules.quoteFromSelection(text, text), { text, offset: 0 });
  assert.equal(rules.quoteFromSelection(text, text + 'x'), 'too-long');
});

it('цитата отвечает выбранным фрагментом, скрытый текст не подменяет удалённое и переход уважает доступ', () => {
  assert.equal(rules.replyQuoteFragment({ quote: 'фрагмент', content: 'всё сообщение' }), 'фрагмент');
  assert.equal(rules.replyQuoteFragment({ content: 'снимок', foreign: true }), 'снимок');
  assert.equal(rules.replyQuoteFragment({ content: 'контент', foreign: true, conversationId: 'dm' }), null);
  assert.equal(rules.replyQuoteFragment({ quote: 'не показывать', content: 'удалено', deleted: true }), null);
  assert.equal(rules.replyJumpTarget({}), 'here');
  assert.equal(rules.replyJumpTarget({ foreign: true, conversationId: 'dm:other' }), 'other');
  assert.equal(rules.replyJumpTarget({ foreign: true }), 'none');
});
