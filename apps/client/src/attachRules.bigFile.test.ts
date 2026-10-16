import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as rules from './attachRules';
import * as syncRules from './convSyncRules';
import { shareFilesWithin } from './shareInbox';

const large = 1024 * 1024 ** 2;
const legacy = 25 * 1024 ** 2;
function changed(from: string, to: string): typeof rules {
  const raw = readFileSync(new URL('./attachRules.ts', import.meta.url), 'utf8'); assert.ok(raw.includes(from));
  const module = { exports: {} };
  // Контрфакт полного чистого модуля, без извлечения исполняемых фрагментов.
  runInNewContext(ts.transpileModule(raw.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports, require: (id: string) => {
      if (id === '@gusvoice/shared') return shared;
      if (id === './convSyncRules') return syncRules;
      throw new Error(`неожиданный импорт ${id}`);
    } });
  return module.exports as typeof rules;
}

it('R127 большой предел действует только с bigfile1 и объявленным размером выше старого', () => {
  // Число из ответа старого сервера само по себе не включает неизвестную ручку multipart.
  const check = (api: typeof rules) => {
    for (const features of [undefined, null, [], ['conv10'], ['bigfile10']])
      assert.equal(JSON.stringify(api.dmFileLimitFrom(features, large)), JSON.stringify({ chunked: false, max: legacy }));
    assert.equal(JSON.stringify(api.dmFileLimitFrom(['bigfile1'], large)), JSON.stringify({ chunked: true, max: large }));
    assert.equal(JSON.stringify(api.dmFileLimitFrom(['bigfile1'], 512 * 1024 ** 2)), JSON.stringify({ chunked: true, max: 512 * 1024 ** 2 }), 'прежний большой сервер тоже поддерживается');
    assert.equal(JSON.stringify(api.dmFileLimitFrom(['bigfile1'], legacy + 1)), JSON.stringify({ chunked: true, max: legacy + 1 }));
  };
  check(rules);
  assert.throws(() => check(changed('!!features?.includes(FEATURE_BIGFILE1) && ', 'true && ')), assert.AssertionError);
});
it('R127 признак без числа, нулевой размер и ровно 25 МиБ остаются на одиночной загрузке', () => {
  // Новая возможность без корректного предела не должна обещать 1 ГиБ человеку.
  for (const max of [undefined, null, 0, -1, NaN, legacy - 1, legacy])
    assert.deepEqual(rules.dmFileLimitFrom(['bigfile1'], max), { chunked: false, max: legacy });
});
it('R127 лимит активного инстанса сбрасывается после перехода на старый сервер', () => {
  // Предел большого сервера не должен протекать в следующий инстанс или обычную загрузку канала.
  try {
    rules.setDmFileLimit(['bigfile1'], large);
    assert.equal(rules.dmChunkedUploads(), true); assert.equal(rules.dmAttachMaxBytes(), large);
    rules.setDmFileLimit([], large);
    assert.equal(rules.dmChunkedUploads(), false); assert.equal(rules.dmAttachMaxBytes(), legacy);
    assert.equal(rules.ATTACH_MAX_BYTES, legacy, 'общий предел канала не изменяется');
  } finally { rules.setDmFileLimit(null, null); }
});
it('R127 входящие файлы ровно до предела принимаются, плюс байт помечается без мутации', () => {
  // Копирование Android до 1 ГиБ не означает, что старый сервер сможет принять всё скопированное.
  for (const max of [legacy, large]) {
    const files = [{ name: 'small', size: max - 1 }, { name: 'edge', size: max }, { name: 'over', size: max + 1 },
      { name: 'unreadable', size: max + 1, skip: 'unreadable' as const }, { name: 'already', size: 1, skip: 'too-big' as const }];
    const before = JSON.stringify(files); const next = shareFilesWithin(files, max);
    assert.equal(next.length, files.length); assert.equal(next[0], files[0]); assert.equal(next[1], files[1]);
    assert.equal(next[2]!.skip, 'too-big'); assert.notEqual(next[2], files[2]);
    assert.equal(next[3], files[3], 'прежняя ошибка чтения не переименовывается'); assert.equal(next[4], files[4]);
    assert.equal(JSON.stringify(files), before, 'входной список не переписан');
  }
  assert.deepEqual(shareFilesWithin([], large), []);
});
it('R140 тост пропущенных файлов объясняет объявленные 1024 МБ и сохраняет отдельную ошибку чтения', () => {
  // Жёсткое «25 МБ» при серверном лимите 1 ГиБ ложно объясняло бы человеку причину отказа.
  const skipped = [{ name: 'large.bin', reason: 'too-big' as const }, { name: 'broken.bin', reason: 'unreadable' as const }];
  assert.equal(rules.skippedText(skipped, large), 'Больше 1024 МБ — не отправить: large.bin. Не удалось прочитать: broken.bin');
  assert.equal(rules.skippedText(skipped), 'Больше 25 МБ — не отправить: large.bin. Не удалось прочитать: broken.bin');
  assert.equal(rules.skippedText([], large), null);
  assert.equal(rules.skippedText([skipped[1]!], large), 'Не удалось прочитать: broken.bin');
});
