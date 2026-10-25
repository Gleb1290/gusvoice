import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { isOnceMedia, isOnceSpendable, ONCE_TTL_MAX } from './voiceMessage.js';
import { onceSpentText } from './onceMedia.js';
import { PHOTO_ONCE_SPENT_TEXT, VIDEO_ONCE_SPENT_TEXT, ROUND_ONCE_SPENT_TEXT, VOICE_ONCE_SPENT_TEXT } from './ws.js';

type Media = Parameters<typeof isOnceSpendable>[0];
const photo: Media = { once: true, contentType: 'image/jpeg' };
const video: Media = { once: true, contentType: 'video/mp4' };

it('R262 одноразовые фото и обычные видео кадром распознаются, без once остаются обычными', () => {
  // Признак нельзя угадывать по MIME: обычный файл не должен внезапно сгорать.
  for (const contentType of ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'video/mp4', 'video/webm']) {
    assert.equal(isOnceMedia({ once: true, contentType }), true, contentType);
    assert.equal(isOnceMedia({ contentType }), false, contentType);
  }
  assert.equal(ONCE_TTL_MAX, 60, 'свой таймер совпадает с серверным пределом');
});

function asFileCheck(check: typeof isOnceMedia) {
  assert.equal(check(photo), true);
  assert.equal(check({ ...photo, asFile: true }), false, 'R262 файл не становится одноразовой плиткой');
  assert.equal(check({ ...video, asFile: true }), false, 'R262 файл не становится одноразовой плиткой');
}
it('R262 отправка как файл исключает и фото, и видео из одноразового просмотра', () => {
  // Иначе скачиваемый документ получит режим, который может работать только в защищённом просмотрщике.
  asFileCheck(isOnceMedia);
});

it('R262 GIF, помеченная анимация и кружок не перехватываются новым видом медиа', () => {
  // Кружки сохраняют прежнюю семантику voice3, а GIF никогда не получает таймер фото.
  for (const a of [{ ...photo, contentType: 'image/gif' }, { ...video, gif: true as const }, { ...video, round: true as const }])
    assert.equal(isOnceMedia(a), false);
  assert.equal(isOnceMedia(photo), true);
  for (const contentType of ['', 'audio/ogg', 'application/pdf']) assert.equal(isOnceMedia({ once: true, contentType }), false);
});

it('R262 сжечь можно фото, видео и прежние голосовое с кружком, но не обычное вложение', () => {
  // Расширение spend не должно потерять прежние виды или начать удалять любой файл с ошибочной пометкой.
  for (const a of [photo, video, { once: true as const, contentType: 'audio/webm', waveform: [0, 20] },
    { once: true as const, contentType: 'video/mp4', round: true as const }]) assert.equal(isOnceSpendable(a), true);
  for (const a of [{ contentType: 'image/jpeg' }, { ...photo, asFile: true as const },
    { once: true as const, contentType: 'audio/mpeg' }, { ...photo, contentType: 'image/gif' }])
    assert.equal(isOnceSpendable(a), false);
});

it('R262 потраченное фото и видео имеют именно утверждённые фразы об истечении', () => {
  // Старые «прослушано»/«просмотрено» не должны подменить владельческое решение для фото и видео.
  assert.equal(PHOTO_ONCE_SPENT_TEXT, 'Фото истекло');
  assert.equal(VIDEO_ONCE_SPENT_TEXT, 'Видео истекло');
  assert.equal(onceSpentText([photo]), 'Фото истекло');
  assert.equal(onceSpentText([video]), 'Видео истекло');
});

it('R262 пустой список, голосовое и кружок сохраняют прежние запасные фразы', () => {
  // Повторный spend может увидеть уже очищенный список; пустота не должна порождать исключение.
  assert.equal(onceSpentText([]), VOICE_ONCE_SPENT_TEXT);
  assert.equal(onceSpentText([{ once: true, contentType: 'audio/webm' }]), VOICE_ONCE_SPENT_TEXT);
  assert.equal(onceSpentText([{ once: true, contentType: 'video/mp4', round: true }]), ROUND_ONCE_SPENT_TEXT);
});

it('R262 выбор фразы пропускает файл и GIF, кружок имеет приоритет, список не меняется', () => {
  // Смешанный/унаследованный список не должен выдавать фразу первого неподходящего вложения.
  const list = Object.freeze([Object.freeze({ ...photo, asFile: true as const }), Object.freeze({ ...photo, contentType: 'image/gif' }), Object.freeze(video)]);
  assert.equal(onceSpentText(list), VIDEO_ONCE_SPENT_TEXT);
  assert.equal(onceSpentText([photo, { once: true, contentType: 'video/mp4', round: true }]), ROUND_ONCE_SPENT_TEXT);
  assert.equal(list.length, 3);
});

it('R262 контрфакт снятия защиты asFile пойман на настоящем модуле после оригинала', () => {
  // Успех только по нужному отказу: ошибка VM/импорта не доказывает чувствительность проверки.
  const raw = readFileSync(new URL('./voiceMessage.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const anchor = 'a.once !== true || a.asFile || a.gif || a.round';
  assert.equal(raw.split(anchor).length - 1, 1);
  const load = (source: string): typeof import('./voiceMessage.js') => {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, { module, exports: module.exports });
    return module.exports as typeof import('./voiceMessage.js');
  };
  asFileCheck(isOnceMedia); asFileCheck(load(raw).isOnceMedia);
  assert.throws(() => asFileCheck(load(raw.replace(anchor, 'a.once !== true || a.gif || a.round')).isOnceMedia),
    (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith('R262 файл не становится') && e.actual === true && e.expected === false);
});
