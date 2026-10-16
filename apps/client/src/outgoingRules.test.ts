import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import {
  addOutgoing,
  outgoingFailed,
  outgoingFilesLabel,
  outgoingRetry,
  outgoingSent,
  sendErrorText,
} from './outgoingRules.js';
import { humanLengthError } from './longTextRules.js';

const rows = [
  { key: 'a', content: 'A', files: [], replyToId: null, status: 'sending' as const, error: null, feedId: 'feed-a', afterId: '1' },
  { key: 'b', content: 'B', files: [], replyToId: null, status: 'sending' as const, error: null, feedId: 'feed-b', afterId: '2' },
];

function compileWholeModule(source: string, dependencies: Record<string, unknown>): Record<string, unknown> {
  const module = { exports: {} as Record<string, unknown> };
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(output, {
    module,
    exports: module.exports,
    Error,
    require: (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `неожиданный импорт ${id}`);
      return dependencies[id];
    },
  });
  return module.exports;
}

describe('сообщения, которые ещё отправляются', () => {
  it('добавление и успешная отправка не меняют чужие строки и их дополнительные поля', () => {
    // Ловит пересборку очереди с потерей привязки к ленте или удалением не того сообщения.
    const added = addOutgoing(rows, { ...rows[0], key: 'c', content: 'C' });
    assert.deepEqual(added.map((x) => x.key), ['a', 'b', 'c']);
    assert.deepEqual(outgoingSent(added, 'b'), [rows[0], added[2]]);
    assert.equal(outgoingSent(rows, 'missing')[0], rows[0]);
  });

  it('отказ и повтор меняют только адресную строку, сохраняя поля ленты', () => {
    // Ловит ошибку одного запроса, покрасившую всю очередь, и зависшую старую причину после retry.
    const failed = outgoingFailed(rows, 'b', 'нет связи');
    assert.equal(failed[0], rows[0]);
    assert.deepEqual(failed[1], { ...rows[1], status: 'failed', error: 'нет связи' });
    const retried = outgoingRetry(failed, 'b');
    assert.deepEqual(retried[1], rows[1]);
    assert.equal(retried[1]?.feedId, 'feed-b');
    assert.equal(retried[1]?.afterId, '2');
  });

  it('смена инстанса гасит строку, а коды федерации становятся человеческими', () => {
    // Ловит ложную ошибку после навигации и показ технического кода человеку.
    assert.equal(sendErrorText({ switched: true }), null);
    assert.notEqual(sendErrorText(new Error('federation.guest_forbidden')), 'federation.guest_forbidden');
    assert.equal(sendErrorText(''), 'не удалось отправить');
    assert.equal(sendErrorText(new Error('обычная ошибка')), 'обычная ошибка');
  });

  it('ошибка вложений переводится и в «Не отправлено», а не только в тексте открытия ЛС', () => {
    // Класс ошибки: старый переводчик только для открытия ЛС оставляет технический код в очереди отправки.
    const code = 'federation.dm_attachments_later';
    const expected = 'Файлы людям других инстансов можно будет отправлять в следующем обновлении. Текст доходит.';
    assert.equal(sendErrorText(code), expected, 'исходный модуль переводит отказ для очереди отправки');
    assert.equal(sendErrorText(new Error(code)), expected, 'ошибка Error с тем же кодом тоже переводится');

    const outgoingSource = readFileSync(new URL('./outgoingRules.ts', import.meta.url), 'utf8');
    const fedErrorSource = readFileSync(new URL('./fedErrorText.ts', import.meta.url), 'utf8');
    const originalFedText = compileWholeModule(fedErrorSource, { '@gusvoice/shared': shared });
    const originalOutgoing = compileWholeModule(outgoingSource, {
      './fedErrorText': originalFedText,
      './longTextRules': { humanLengthError },
    }) as { sendErrorText: (value: unknown) => string | null };
    assert.equal(originalOutgoing.sendErrorText(new Error(code)), expected,
      'исходные целые fedErrorText и outgoingRules проходят тот же oracle в VM');

    let source = readFileSync(new URL('./fedErrorText.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const movedCase = "    case FED_ERRORS.dmAttachmentsLater:\n      return 'Файлы людям других инстансов можно будет отправлять в следующем обновлении. Текст доходит.';\n";
    assert.equal(source.split(movedCase).length - 1, 1, 'у мутанта один точный якорь ветки вложений');
    source = source.replace(movedCase, '');
    const openAnchor = '  switch (code) {\n    case FED_ERRORS.dmRefused:';
    assert.equal(source.split(openAnchor).length - 1, 1, 'у мутанта один якорь switch открытия ЛС');
    source = source.replace(openAnchor, `  switch (code) {\n${movedCase}    case FED_ERRORS.dmRefused:`);
    const fedText = compileWholeModule(source, { '@gusvoice/shared': shared });
    const outgoing = compileWholeModule(outgoingSource, {
      './fedErrorText': fedText,
      './longTextRules': { humanLengthError },
    }) as { sendErrorText: (value: unknown) => string | null };
    assert.throws(
      () => assert.equal(outgoing.sendErrorText(new Error(code)), expected, 'очередь должна получать общий перевод ошибки'),
      (error: unknown) => error instanceof assert.AssertionError && error.message.includes('очередь должна получать общий перевод ошибки'),
      'мутант оставляет в «Не отправлено» исходный код, даже если fedDmOpenText всё ещё его знает',
    );
  });

  it('подпись вложений различает пустой, один и несколько файлов', () => {
    // Ловит «undefined и ещё -1» и неверный счётчик скрытых вложений.
    assert.equal(outgoingFilesLabel([]), null);
    assert.equal(outgoingFilesLabel(['a.png']), 'a.png');
    assert.equal(outgoingFilesLabel(['a.png', 'b.jpg', 'c.gif']), 'a.png и ещё 2');
  });
});
