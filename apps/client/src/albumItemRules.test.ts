import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, after, it } from 'node:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { FEATURE_ALBUM1, type Attachment } from '@gusvoice/shared';
import ts from 'typescript';
import * as rules from './albumItemRules';

type Rules = typeof rules;
const source = readFileSync(new URL('./albumItemRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const photo = (id: string, extra: Partial<Attachment> = {}): Attachment => ({
  id, url: `/${id}.png`, name: `${id}.png`, contentType: 'image/png', size: 20, width: 100, height: 80, ...extra,
});
const video = photo('video', { url: '/video.mp4', name: 'video.mp4', contentType: 'video/mp4' });
const first = photo('first'), second = photo('second');
before(() => GlobalRegistrator.register({ url: 'http://localhost/' }));
after(() => GlobalRegistrator.unregister());

function load(raw: string): Rules {
  const module = { exports: {} };
  // Весь чистый модуль; единственная runtime-зависимость — константа протокола, никаких фрагментов исходника.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, require: (id: string) => {
    assert.equal(id, '@gusvoice/shared', 'у чистого модуля только объявленная зависимость протокола');
    return { FEATURE_ALBUM1 };
  } });
  return module.exports as Rules;
}

function single(r: Rules) {
  assert.equal(r.isAlbumItem([first], first), false, 'одиночное фото остаётся действием над сообщением');
}
function unidentified(r: Rules) {
  const unknown = photo('old', { id: undefined });
  assert.equal(r.isAlbumItem([first, unknown], unknown), false, 'без id элемент нельзя адресовать отдельной ручкой');
}
function copying(r: Rules) {
  const pending = photo('pending', { fedState: 'copying' });
  assert.equal(r.isAlbumItem([first, pending], pending), false, 'неприехавшая копия не получает отдельные действия');
}
function asFile(r: Rules) {
  const file = photo('as-file', { asFile: true });
  assert.equal(r.isAlbumItem([first, file], file), false, 'фото как файл не становится ячейкой альбома');
  assert.equal(r.isAlbumItem([first, file], first), false, 'одна ячейка рядом с файлом ещё не альбом');
}
function foreign(r: Rules) {
  assert.equal(r.isAlbumItem([first, second], { ...first }), false, 'чужой объект с тем же id не входит в список альбома');
}
function once(r: Rules) {
  const hidden = photo('once', { once: true });
  assert.equal(r.isAlbumItem([first, hidden], hidden), false, 'одноразовое медиа не получает действия повторного использования');
}
function cell(kind: 'image' | 'video', url: string) {
  const anchor = document.createElement('a'); anchor.className = 'att-img-link';
  const media = document.createElement(kind === 'image' ? 'img' : 'video'); media.setAttribute('src', url);
  const child = document.createElement('span'); anchor.append(media, child);
  return { anchor, media, child };
}
function videoTarget(r: Rules) {
  const target = cell('video', video.url);
  assert.equal(r.albumCellFromTarget([first, video], target.child) === video, true,
    'вложенная цель видео находит выбранное видео, не первую фотографию');
}
function videoFrameTarget(r: Rules) {
  const target = cell('video', `${video.url}#t=0.1`);
  for (const click of [target.child, target.media])
    assert.equal(r.albumCellFromTarget([first, video], click) === video, true,
      'R215-video-frame: фрагмент первого кадра не теряет выбранное видео альбома');
  const exactPhoto = cell('image', first.url);
  assert.equal(r.albumCellFromTarget([first, video], exactPhoto.media), first, 'точный src фотографии по-прежнему находит своё вложение');
  const foreign = cell('video', '/other.mp4#t=0.1');
  assert.equal(r.albumCellFromTarget([first, video], foreign.media), undefined, 'удаление фрагмента не принимает чужой адрес');
}
// VideoAttachment без autoplay добавляет #t=0.1 для первого кадра; src перестаёт быть побайтным URL вложения.
it('R215 видео без autoplay находится по src первого кадра, точное фото остаётся своим и чужое видео не принимается', () => videoFrameTarget(rules));
it('R215 контрфакт сравнения только полного src теряет видео с первым кадром', () => {
  videoFrameTarget(load(source));
  const from = 'a.url === src || a.url === bare';
  assert.equal(source.split(from).length - 1, 1, 'однозначный якорь исправленного сравнения src');
  assert.throws(() => videoFrameTarget(load(source.replace(from, 'a.url === src'))), (e: unknown) => e instanceof assert.AssertionError
    && e.message.startsWith('R215-video-frame:') && e.operator === 'strictEqual' && e.actual === false && e.expected === true);
});

it('R213 признак album1 включает действия только у объявившего его сервера', () => {
  assert.equal(rules.serverAlbumItems(['conv5', FEATURE_ALBUM1]), true);
  for (const features of [undefined, null, [], ['conv5'], ['Album1'], ['album10']])
    assert.equal(rules.serverAlbumItems(features), false, 'отсутствие точного признака сохраняет старое поведение');
});
it('R213 два фото и смешанный альбом принимают только настоящие выбранные элементы', () => {
  assert.equal(rules.isAlbumItem([first, second], first), true);
  assert.equal(rules.isAlbumItem([first, second], second), true);
  assert.equal(rules.isAlbumItem([first, video], video), true);
  assert.equal(rules.isAlbumItem([video, photo('v2', { contentType: 'video/webm' })], video), true);
});
it('R213 одиночное фото или видео остаётся целым сообщением, пустой список не образует альбом', () => {
  // Граница 1/2 особенно важна: иначе привычное удаление единственной фотографии меняет API и окно.
  single(rules);
  assert.equal(rules.isAlbumItem([video], video), false);
  assert.equal(rules.isAlbumItem([], first), false);
  assert.equal(rules.isAlbumItem(undefined, first), false);
  assert.equal(rules.isAlbumItem([first, second], undefined), false);
});
it('R213 старое фото без id отклоняется, адресуемое фото в том же альбоме принимается', () => {
  unidentified(rules);
  const emptyId = photo('empty', { id: '' });
  assert.equal(rules.isAlbumItem([first, emptyId], emptyId), false);
  assert.equal(rules.isAlbumItem([first, second], second), true);
});
it('R213 copying не получает действия, та же готовая копия снова принимается', () => {
  copying(rules);
  const ready = photo('pending');
  assert.equal(rules.isAlbumItem([first, ready], ready), true);
});
it('R213 отправленное как файл медиа не считается ячейкой или вторым элементом альбома', () => {
  asFile(rules);
  const file = photo('file', { asFile: true });
  assert.equal(rules.isAlbumItem([first, second, file], second), true, 'два настоящих кадра остаются альбомом рядом с файлом');
  assert.equal(rules.isAlbumItem([first, second, file], file), false, 'файл не становится элементом даже при готовом альбоме');
});
it('R213 совпадение полей не даёт чужому объекту стать выбранным элементом', () => { foreign(rules); });
it('R213 одноразовое медиа отклоняется, обычное видео принимается', () => {
  once(rules); assert.equal(rules.isAlbumItem([first, video], video), true);
});
it('R213 ячейка по вложенной цели возвращает своё фото или видео', () => {
  const target = cell('image', second.url);
  assert.equal(rules.albumCellFromTarget([first, second], target.child), second);
  assert.equal(rules.albumCellFromTarget([first, second], target.media), second);
  videoTarget(rules);
});
it('R213 цель вне ячейки, без src или с незнакомым src не подставляет первый элемент', () => {
  const outside = document.createElement('div');
  const empty = document.createElement('a'); empty.className = 'att-img-link'; empty.append(document.createElement('img'));
  const unknown = cell('image', '/not-in-album.png');
  for (const target of [null, outside, empty, unknown.media])
    assert.equal(rules.albumCellFromTarget([first, second], target), undefined);
  assert.equal(rules.albumCellFromTarget(undefined, unknown.child), undefined);
});
it('R213 подпись элемента различает фото и видео без изменения названия всего сообщения', () => {
  assert.equal(rules.albumItemNoun(first), 'фото'); assert.equal(rules.albumItemNoun(video), 'видео');
});

for (const [name, from, to, scenario, prefix, actual, expected] of [
  ['один кадр ошибочно считается альбомом', 'media.length >= 2', 'media.length >= 1', single, 'одиночное фото', true, false],
  ['нет проверки id', '!att?.id || ', '!att || ', unidentified, 'без id элемент', true, false],
  ['копия получает действия раньше загрузки', "att.fedState === 'copying' || ", '', copying, 'неприехавшая копия', true, false],
  ['файлы участвуют в построении альбома', '!a.asFile && ', '', asFile, 'фото как файл', true, false],
  ['не проверяется принадлежность выбранного объекта', 'media.includes(att)', 'true', foreign, 'чужой объект', true, false],
  ['одноразовое медиа получает отдельные действия', ' || att.once === true', '', once, 'одноразовое медиа', true, false],
  ['из ячейки видео читается только img', " ?? cell.querySelector('video')?.getAttribute('src')", '', videoTarget, 'вложенная цель видео', false, true],
] as const) it(`R213 чистый контрфакт: ${name}`, () => {
  scenario(load(source));
  assert.equal(source.split(from).length - 1, 1, 'однозначный якорь в полном чистом модуле');
  const mutant = load(source.replace(from, to));
  assert.throws(() => scenario(mutant), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith(prefix) && error.operator === 'strictEqual' && error.actual === actual && error.expected === expected);
});
