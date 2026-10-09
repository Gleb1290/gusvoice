import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as imageSize from './imageSize';
import { bubbleLook, bubblesAllLeft, emojiOnlyCount, MEDIA_MIN_W, TEXT_BUBBLE, ALBUM_MAX, replyQuoteLook, replyQuoteVideo, readByPeer, showsForwardedFrom, forwardedAuthorOpenable } from './bubbleRules';
type Source = Parameters<typeof bubbleLook>[0];

it('как файлы не становится ни одиночным кадром, ни альбомом фото и видео', () => {
  // Ловит потерю явно выбранного режима файлов в ленте.
  const image = { url: '/a.png', name: 'a.png', contentType: 'image/png', size: 1, width: 100, height: 100, asFile: true as const };
  const video = { ...image, contentType: 'video/mp4', url: '/v.mp4' };
  for (const attachments of [[image], [video], [image, video], [image, { ...video, asFile: undefined }]]) {
    const look = bubbleLook(message({ attachments }), 400, 300);
    assert.equal(look.kind, 'text'); assert.equal(look.album, undefined);
  }
  assert.equal(bubbleLook(message({ attachments: [{ ...image, asFile: undefined }] }), 400, 300).kind, 'media');
});

it('цитата вне окна получает фото и thumb из превью, удалённая не раскрывает миниатюру', () => {
  // Оригинал мог не загрузиться: вид и миниатюра должны прийти из самого ответа, без подмены удалённого фото.
  const reply = { content: ' подпись ', deleted: false, attachmentKind: 'photo' as const, attachments: 2, thumb: '/signed-thumb' };
  assert.deepEqual(replyQuoteLook(reply, undefined), { kind: 'photo', text: 'подпись', thumb: '/signed-thumb' });
  assert.deepEqual(replyQuoteLook({ ...reply, content: '' }, undefined), { kind: 'photo', text: 'Фото', thumb: '/signed-thumb' });
  const gone = replyQuoteLook({ ...reply, deleted: true }, undefined);
  assert.equal(gone.thumb, undefined);
  assert.equal(gone.text, 'Сообщение удалено');
});

it('цитата видео без оригинала отличается от файла, а неизвестное превью остаётся текстом', () => {
  // Имя mp4 не определяет видео: серверный признак должен сохранить смысл вне окна истории.
  const reply = { content: '', deleted: false, attachmentKind: 'file' as const, attachmentVideo: true as const, attachmentDurationMs: 42_000, attachmentName: 'clip.mp4' };
  assert.deepEqual(replyQuoteLook(reply, undefined), { kind: 'file', text: 'Видео' });
  assert.deepEqual(replyQuoteLook({ ...reply, attachmentVideo: undefined }, undefined), { kind: 'file', text: 'clip.mp4' });
  assert.deepEqual(replyQuoteLook({ content: 'слова', deleted: false, attachmentKind: 'future' } as never, undefined), { kind: 'text', text: 'слова' });
});
const message = (patch: Partial<Source> = {}): Source => ({ content: '', attachments: [], replyTo: null, ...patch });

it('камера цитаты зависит от видео, а не имени файла; удаление и стикер важнее вложения', () => {
  // Превью без оригинала тоже должно отличать видео от файла, не раскрывая удалённое сообщение.
  const reply = { content: '', deleted: false, attachmentKind: 'file' as const, attachmentVideo: true as const };
  const a = { url: '/clip', name: 'movie.mp4', contentType: 'video/mp4', size: 1 };
  assert.equal(replyQuoteVideo(reply, { attachments: [a] }), true);
  assert.equal(replyQuoteVideo(reply, undefined), true);
  assert.equal(replyQuoteVideo({ ...reply, attachmentVideo: undefined }, undefined), false);
  assert.equal(replyQuoteVideo({ ...reply, attachmentKind: 'photo' }, undefined), false);
  for (const contentType of ['image/png', 'audio/ogg', 'application/pdf']) {
    assert.equal(replyQuoteVideo(reply, { attachments: [{ ...a, contentType }] }), false, contentType);
  }
  assert.equal(replyQuoteVideo(reply, { attachments: [] }), false, 'пустой оригинал не заменяется подсказкой');
  assert.equal(replyQuoteVideo({ ...reply, deleted: true }, { attachments: [a] }), false);
  assert.equal(replyQuoteVideo({ ...reply, deleted: true }, undefined), false);
  assert.equal(replyQuoteVideo(reply, { attachments: [a], sticker: { format: 'webp', url: '/sticker' } as never }), false);
});

it('видео с размером занимает медиа-пузырь, без размера остаётся кадром а не карточкой файла',()=>{
  // Старые mp4 не имеют dimensions, но их нельзя откатывать к обычному текстовому пузырю.
  const video={url:'/clip',name:'clip.mp4',contentType:'video/mp4',size:1,width:1920,height:1080};
  assert.deepEqual(bubbleLook(message({attachments:[video]}),400,300),{kind:'media',jumbo:0,mediaWidth:400});
  assert.deepEqual(bubbleLook(message({attachments:[{...video,width:undefined,height:undefined}]}),400,300),{kind:'media',jumbo:0,mediaWidth:null});
  assert.equal(bubbleLook(message({attachments:[{...video,contentType:'application/pdf'}]}),400,300),TEXT_BUBBLE);
});

it('альбом фото и видео образует общую сетку независимо от порядка',()=>{
  // Различие contentType не должно рвать один медиа-альбом на кадр и файл.
  const photo={url:'/photo',name:'a.png',contentType:'image/png',size:1};const video={...photo,url:'/clip',name:'a.mp4',contentType:'video/mp4'};
  for(const attachments of [[photo,video],[video,photo]])assert.deepEqual(bubbleLook(message({attachments}),400,300),{kind:'media',jumbo:0,mediaWidth:400,album:2});
});
it('альбомы 2–4 фото укладываются в потолок, размер файлов не обязателен', () => {
  assert.equal(ALBUM_MAX, 10);
  const image = { url: 'x', contentType: 'image/png' } as Source['attachments'][number];
  for (const [maxW, maxH, widths] of [[400, 300, [400, 375, 300]], [360, 300, [360, 360, 300]], [100, 80, [120, 120, 120]]] as const) {
    for (let n = 2; n <= 4; n++) assert.deepEqual(bubbleLook(message({ attachments: Array(n).fill(image) }), maxW, maxH), { kind: 'media', jumbo: 0, mediaWidth: widths[n - 2], album: n });
  }
  assert.equal(bubbleLook(message({ attachments: Array(5).fill(image) }), 400, 300).album, 5);
  assert.equal(bubbleLook(message({ attachments: Array(11).fill(image) }), 400, 300), TEXT_BUBBLE);
  for (const contentType of ['audio/ogg', 'application/pdf']) assert.equal(bubbleLook(message({ attachments: [image, { ...image, contentType, waveform: [1] }] }), 400, 300), TEXT_BUBBLE);
});
it('удалённая цитата важнее оригинала, без оригинала остаётся текст или вложение', () => {
  assert.deepEqual(replyQuoteLook({ content: 'текст', deleted: true }, { attachments: [], sticker: undefined }), { kind: 'deleted', text: 'Сообщение удалено' });
  assert.deepEqual(replyQuoteLook({ content: ' x ', deleted: false }, undefined), { kind: 'text', text: 'x' });
  assert.deepEqual(replyQuoteLook({ content: ' ', deleted: false }, undefined), { kind: 'text', text: 'вложение' });
});
it('цитата фото берёт подпись и первую ссылку, отсутствующая ссылка даёт значок', () => {
  const a = { url: 'photo.test', contentType: 'image/png' } as Source['attachments'][number];
  assert.deepEqual(replyQuoteLook({ content: ' подпись ', deleted: false }, { attachments: [a] }), { kind: 'photo', text: 'подпись', thumb: 'photo.test' });
  assert.deepEqual(replyQuoteLook({ content: '', deleted: false }, { attachments: [{ ...a, url: '' }] }), { kind: 'photo', text: 'Фото', thumb: undefined });
});
it('голосовое цитируется без длительности, файл — именем, миниатюра стикера только webp', () => {
  const a = { url: 'x', name: 'файл.pdf', contentType: 'audio/ogg', waveform: [1], durationMs: 42000 } as Source['attachments'][number];
  const r = { content: '', deleted: false };
  assert.deepEqual(replyQuoteLook(r, { attachments: [a] }), { kind: 'voice', text: 'Голосовое сообщение' });
  assert.equal(replyQuoteLook(r, { attachments: [{ ...a, durationMs: undefined }] }).text, 'Голосовое сообщение');
  assert.equal(replyQuoteLook(r, { attachments: [{ ...a, contentType: 'application/pdf' }] }).text, 'файл.pdf');
  for (const format of ['webp', 'tgs'] as const) {
    const sticker = { format, url: 's.test' } as NonNullable<Source['sticker']>;
    assert.deepEqual(replyQuoteLook(r, { attachments: [], sticker }), { kind: 'sticker', text: 'Стикер', thumb: format === 'webp' ? 's.test' : undefined });
  }
});

function loadBubble(source: string): typeof import('./bubbleRules') {
  const module = { exports: {} as typeof import('./bubbleRules') };
  const deps: Record<string, unknown> = { '@gusvoice/shared': shared, './imageSize': imageSize };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { module, exports: module.exports, require: (id: string) => { assert.ok(id in deps, `зависимость ${id} реальна`); return deps[id]; } });
  return module.exports;
}

function bubbleMutant(from: string, to: string): typeof import('./bubbleRules') {
  const source = readFileSync(new URL('./bubbleRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(source.includes(from), `найдено место мутации: ${from}`);
  const changed = source.replace(from, to);
  assert.notEqual(changed, source, 'мутант действительно изменил исходник');
  return loadBubble(changed);
}

it('слова цитаты совпадают со строкой списка для голосового, видео, кружка и файла', () => {
  // Длительность и префикс файла уже расходились со списком бесед; обе формы цитаты обязаны делить одно правило слов.
  const reply = { content: '', deleted: false };
  const voice = { url: '/voice', contentType: 'audio/ogg', waveform: [1], durationMs: 42_000 } as Source['attachments'][number];
  const video = { url: '/video', contentType: 'video/mp4', durationMs: 42_000 } as Source['attachments'][number];
  const round = { ...video, round: true } as Source['attachments'][number];
  const file = (name?: string) => ({ url: '/file', contentType: 'application/pdf', ...(name === undefined ? {} : { name }) }) as Source['attachments'][number];
  const photo = { url: '/photo', contentType: 'image/png' } as Source['attachments'][number];
  const preview = (fields: Record<string, unknown>) => ({ content: '', deleted: false, attachmentKind: 'file', ...fields }) as never;
  const check = (api: typeof import('./bubbleRules')) => {
    const pairs: [ReturnType<typeof replyQuoteLook>, string][] = [
      [api.replyQuoteLook(preview({ attachmentKind: 'voice', attachmentDurationMs: 42_000 }), undefined), 'Голосовое сообщение'],
      [api.replyQuoteLook(reply, { attachments: [voice] }), 'Голосовое сообщение'],
      [api.replyQuoteLook(preview({ attachmentVideo: true, attachmentDurationMs: 42_000 }), undefined), 'Видео'],
      [api.replyQuoteLook(reply, { attachments: [video] }), 'Видео'],
      [api.replyQuoteLook(preview({ attachmentVideo: true, attachmentRound: true }), undefined), 'Видеосообщение'],
      [api.replyQuoteLook(reply, { attachments: [round] }), 'Видеосообщение'],
      [api.replyQuoteLook(preview({ attachmentName: '  папка\t имя.pdf  ' }), undefined), 'папка имя.pdf'],
      [api.replyQuoteLook(reply, { attachments: [file('  папка\t имя.pdf  ')] }), 'папка имя.pdf'],
      [api.replyQuoteLook(preview({ attachmentName: '   ' }), undefined), 'Файл'],
      [api.replyQuoteLook(reply, { attachments: [file()] }), 'Файл'],
    ];
    for (const [actual, expected] of pairs) {
      assert.equal(actual.text, expected);
      assert.equal(actual.kind, expected === 'Голосовое сообщение' ? 'voice' : 'file');
    }
    assert.equal(api.replyQuoteLook({ content: ' подпись ', deleted: false }, { attachments: [photo] }).text, 'подпись', 'подпись фото остаётся текстом');
    assert.equal(api.replyQuoteLook(reply, { attachments: [], sticker: { format: 'webp', url: '/sticker' } as never }).text, 'Стикер');
    assert.equal(api.replyQuoteLook({ content: '', deleted: true }, { attachments: [voice] }).text, 'Сообщение удалено');
  };
  const source = readFileSync(new URL('./bubbleRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  check(loadBubble(source));
  const words = 'return attachmentWords({ kind: f.attachmentKind === \'voice\' ? \'voice\' : \'file\', video: f.attachmentVideo === true, round: f.attachmentRound === true, name: f.attachmentName });';
  assert.throws(() => check(bubbleMutant(words, words.replace('return attachmentWords(', 'return `${attachmentWords(').replace(' });', ' })} · 0:42`;'))), assert.AssertionError);
  assert.throws(() => check(bubbleMutant(words, "return f.attachmentVideo ? attachmentWords({ kind: 'file', video: true, round: f.attachmentRound === true, name: f.attachmentName }) : f.attachmentKind === 'voice' ? attachmentWords({ kind: 'voice' }) : `Файл: ${attachmentWords({ kind: 'file', name: f.attachmentName })}`;")), assert.AssertionError);
  assert.throws(() => check(bubbleMutant('...(a.round === true ? { attachmentRound: true as const } : {})', '...{}')), assert.AssertionError);
  assert.throws(() => check(bubbleMutant('...(reply.attachmentRound === true ? { attachmentRound: true as const } : {})', '...{}')), assert.AssertionError);
});
it('галочки прочитано включаются на равном ключе, не на следующем и не при неизвестном ключе', () => {
  assert.equal(readByPeer(10, 10), true); assert.equal(readByPeer(11, 10), false);
  assert.equal(readByPeer(undefined, 10), false); assert.equal(readByPeer(10, null), false); assert.equal(readByPeer(10, undefined), false);
});
it('широкая лента 760 уже выравнивает свои слева, 759 и телефон сохраняют стороны', () => {
  assert.equal(bubblesAllLeft(759, false), false); assert.equal(bubblesAllLeft(760, false), true);
  assert.equal(bubblesAllLeft(1000, true), false);
});
it('без Segmenter эмодзи остаются обычным текстом, модуль безопасно загружается', () => {
  const module = { exports: {} }; const deps: Record<string, unknown> = { '@gusvoice/shared': shared, './imageSize': imageSize };
  const code = ts.transpileModule(readFileSync(new URL('./bubbleRules.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { module, exports: module.exports, Intl: {}, require: (id: string) => { assert.ok(id in deps); return deps[id]; } });
  assert.equal((module.exports as typeof import('./bubbleRules')).emojiOnlyCount('🪿'), 0);
});

it('крупные эмодзи считаются по видимым символам: семья, оттенок, флаг и клавиша', () => {
  for (const e of ['🪿', '👨‍👩‍👧‍👦', '👍🏽', '🇷🇺', '1️⃣']) assert.equal(emojiOnlyCount(e), 1, e);
  assert.equal(emojiOnlyCount('🪿 \n 👍🏽 🇷🇺'), 3); assert.equal(emojiOnlyCount('🪿🪿🪿🪿'), 0);
});
it('обычный текст и текстовый символ без VS16 не превращаются в крупную картинку', () => {
  for (const text of ['', ' ', '©', '1', ':goose:', '🪿 привет', 'x'.repeat(65)]) assert.equal(emojiOnlyCount(text), 0, text);
  assert.equal(emojiOnlyCount('©️'), 1);
});
it('эмодзи без вложений идут без пузыря, цитата и опрос требуют обычного пузыря', () => {
  assert.equal(bubbleLook(message({ content: '🪿' }), 400, 300).kind, 'emoji');
  assert.equal(bubbleLook(message({ content: '🪿', replyTo: { id: 'r' } as Source['replyTo'] }), 400, 300), TEXT_BUBBLE);
  assert.equal(bubbleLook(message({ content: '🪿', poll: {} as Source['poll'] }), 400, 300), TEXT_BUBBLE);
});
it('одна картинка известного размера получает ширину, узкая не сжимает подпись ниже минимума', () => {
  const image = { url: 'x', contentType: 'image/png', width: 30, height: 300 } as Source['attachments'][number];
  assert.equal(bubbleLook(message({ attachments: [image] }), 400, 300).mediaWidth, MEDIA_MIN_W);
  assert.equal(bubbleLook(message({ attachments: [{ ...image, width: 800, height: 600 }] }), 400, 300).mediaWidth, 400);
  assert.equal(bubbleLook(message({ attachments: [{ ...image, width: undefined }] }), 400, 300).kind, 'text');
  assert.equal(bubbleLook(message({ attachments: [image, image] }), 400, 300).album, 2);
});
it('стикер без подписи не требует пузыря, подпись и цитата возвращают обычный', () => {
  const sticker = {} as Source['sticker'];
  assert.equal(bubbleLook(message({ sticker }), 400, 300).kind, 'sticker');
  assert.equal(bubbleLook(message({ sticker, content: 'подпись' }), 400, 300).kind, 'text');
  assert.equal(bubbleLook(message({ sticker, replyTo: { id: 'r' } as Source['replyTo'] }), 400, 300).kind, 'text');
});

it('строка пересылки видна у первого и границ серии, но скрыта внутри серии одного автора', () => {
  // Сравнение displayName ошибочно склеит разных одноимённых авторов; ключ — userId и фактическая группировка.
  const forwarded = (userId: string) => ({ forwardedFrom: { userId } });
  assert.equal(showsForwardedFrom(forwarded('a'), undefined, false), true);
  assert.equal(showsForwardedFrom(forwarded('a'), forwarded('a'), true), false);
  assert.equal(showsForwardedFrom(forwarded('b'), forwarded('a'), true), true);
  assert.equal(showsForwardedFrom(forwarded('a'), forwarded('a'), false), true);
  assert.equal(showsForwardedFrom(forwarded('a'), message(), true), true);
  assert.equal(showsForwardedFrom({ forwardedFrom: null }, forwarded('a'), true), false);
  assert.equal(showsForwardedFrom(message(), forwarded('a'), true), false);
});

it('удалённый автор пересылки не открывается по имени, живой тёзка остаётся доступен', () => {
  // Имя «Удалённый пользователь» не доказывает удаление: это может быть реальное имя живого участника.
  assert.equal(forwardedAuthorOpenable({ deleted: true }), false);
  assert.equal(forwardedAuthorOpenable({ deleted: false } as unknown as Parameters<typeof forwardedAuthorOpenable>[0]), true);
  assert.equal(forwardedAuthorOpenable({ deleted: undefined }), true);
});
it('пересланные крупные эмодзи и стикеры получают пузырь для строки автора', () => {
  // Без обычного пузыря подпись «Переслано от» некуда поместить, хотя оригинал сам по себе был бы безрамочным.
  const forwarded = { userId: 'peer', displayName: 'Peer', at: '2026-10-05T12:00:00Z' } as NonNullable<Source['forwardedFrom']>;
  assert.deepEqual(bubbleLook(message({ content: '🪿', forwardedFrom: forwarded }), 400, 300), TEXT_BUBBLE);
  assert.deepEqual(bubbleLook(message({ sticker: {} as Source['sticker'], forwardedFrom: forwarded }), 400, 300), TEXT_BUBBLE);
  assert.equal(bubbleLook(message({ content: '🪿' }), 400, 300).kind, 'emoji');
  assert.equal(bubbleLook(message({ sticker: {} as Source['sticker'] }), 400, 300).kind, 'sticker');
});
