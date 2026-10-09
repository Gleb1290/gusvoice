import assert from 'node:assert/strict';
import { it } from 'node:test';
import { messageLinks, sharedMediaKindOf } from './sharedMedia.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function mutant(from: string, to: string): { sharedMediaKindOf: typeof sharedMediaKindOf; messageLinks: typeof messageLinks } {
  const source = readFileSync(new URL('./sharedMedia.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(source.includes(from), 'точка мутации существует');
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
  return module.exports as ReturnType<typeof mutant>;
}

it('голосовое требует одновременно аудиотип и непустую огибающую', () => {
  // Ловит попадание музыки или картинки с огибающей во вкладку голосовых.
  assert.equal(sharedMediaKindOf({ contentType: 'audio/ogg', waveform: [0] }), 'voice');
  assert.equal(sharedMediaKindOf({ contentType: 'audio/ogg', waveform: [] }), 'file');
  assert.equal(sharedMediaKindOf({ contentType: 'audio/ogg' }), 'file');
  assert.equal(sharedMediaKindOf({ contentType: 'image/png', waveform: [1] }), 'media');
  assert.equal(sharedMediaKindOf({ contentType: '', waveform: [1] }), 'file');
  assert.throws(() => assert.equal(mutant(" && ct.startsWith('audio/')", '').sharedMediaKindOf({ contentType: 'image/png', waveform: [1] }), 'media'), assert.AssertionError);
});

it('голосовое главнее GIF, а GIF главнее режима файла', () => {
  // Ловит расхождение приоритетов вкладок при нескольких подсказках у вложения.
  assert.equal(sharedMediaKindOf({ contentType: 'audio/ogg', waveform: [1], gif: true, asFile: true }), 'voice');
  assert.equal(sharedMediaKindOf({ contentType: 'video/mp4', gif: true, asFile: true }), 'gif');
  assert.equal(sharedMediaKindOf({ contentType: 'image/gif' }), 'media');
  assert.equal(sharedMediaKindOf({ contentType: 'image/gif', gif: true }), 'gif');
  assert.throws(() => assert.equal(mutant("if (a.gif === true) return 'gif';", '').sharedMediaKindOf({ contentType: 'video/mp4', gif: true, asFile: true }), 'gif'), assert.AssertionError);
});

it('медиа как файл попадают в файлы, отсутствие типа не становится картинкой', () => {
  // Ловит потерю намерения отправителя отправить фото документом.
  for (const contentType of ['image/png', 'video/mp4']) {
    assert.equal(sharedMediaKindOf({ contentType }), 'media');
    assert.equal(sharedMediaKindOf({ contentType, asFile: true }), 'file');
  }
  for (const contentType of ['', 'application/pdf', 'audio/mp3']) assert.equal(sharedMediaKindOf({ contentType }), 'file');
  assert.throws(() => assert.equal(mutant(' && a.asFile !== true', '').sharedMediaKindOf({ contentType: 'image/png', asFile: true }), 'file'), assert.AssertionError);
});

it('ссылки сохраняют порядок, снимают хвостовую пунктуацию и затем убирают повторы', () => {
  // Ловит дубли одного адреса из-за точки или скобки в конце предложения.
  assert.deepEqual(messageLinks('https://a.test/x.,;:!?) ] HTTPS://b.test/y https://a.test/x!'), ['https://a.test/x', 'HTTPS://b.test/y']);
  assert.deepEqual(messageLinks('https://a.test/x?y=1 https://a.test/x?y=2'), ['https://a.test/x?y=1', 'https://a.test/x?y=2']);
  assert.throws(() => assert.equal(mutant(' && !out.includes(url)', '').messageLinks('https://a.test https://a.test').length, 1), assert.AssertionError);
});

it('пустой текст, голые схемы и чужие протоколы не создают ссылки', () => {
  // Ловит фантомные строки общей вкладки ссылок без адреса.
  for (const text of ['', 'обычный текст', 'http:// https://', 'ftp://a.test mailto:a@test']) assert.deepEqual(messageLinks(text), []);
  assert.deepEqual(messageLinks('<https://a.test> "http://b.test"'), ['https://a.test', 'http://b.test']);
});

it('кружок относится к голосовым раньше обычного видео, ложная метка на картинке не меняет вкладку', () => {
  // Ловит потерю кружков в голосовой вкладке и неверный приоритет GIF/документа.
  const round = { contentType: 'video/webm', round: true as const };
  assert.equal(sharedMediaKindOf(round), 'voice');
  assert.equal(sharedMediaKindOf({ ...round, gif: true, asFile: true }), 'voice');
  assert.equal(sharedMediaKindOf({ contentType: 'video/webm' }), 'media');
  assert.equal(sharedMediaKindOf({ contentType: 'image/png', round: true }), 'media');
  const branch = "if (a.round === true && ct.startsWith('video/')) return 'voice';";
  assert.throws(() => assert.equal(mutant(branch, '').sharedMediaKindOf(round), 'voice'), assert.AssertionError);
  const middle = [
    "if (Array.isArray(a.waveform) && a.waveform.length > 0 && ct.startsWith('audio/')) return 'voice';",
    "if (a.gif === true) return 'gif';",
    "if ((ct.startsWith('image/') || ct.startsWith('video/')) && a.asFile !== true) return 'media';",
  ].join('\n  ');
  assert.throws(() => assert.equal(mutant(`${branch}\n  ${middle}`, `${middle}\n  ${branch}`).sharedMediaKindOf(round), 'voice'), assert.AssertionError,
    'перенос round после обычного видео отправляет кружок не в голосовые');
  assert.throws(() => assert.equal(mutant("a.round === true && ct.startsWith('video/')", 'a.round === true').sharedMediaKindOf({ contentType: 'image/png', round: true }), 'media'), assert.AssertionError);
});
