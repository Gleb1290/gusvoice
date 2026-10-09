import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dmRowTime, rowShowsDraft, rowActivityAt } from './dmRowRules';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './dmRowRules';
import * as shared from '@gusvoice/shared';
import * as bubbleRules from './bubbleRules';

function loadDmRowRules(source: string): typeof rules {
  const module = { exports: {} as typeof rules };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { module, exports: module.exports, require: (id: string) => {
    if (id === '@gusvoice/shared') return shared;
    if (id === './bubbleRules') return bubbleRules;
    assert.fail(`неожиданная зависимость ${id}`);
  } });
  return module.exports;
}

it('строка сохраняет часы 19:59 назад, меняет их после 20 часов и отделяет неделю от года', () => {
  // Порог не календарная полночь: позднее вчерашнее сообщение ещё показывается часами.
  const now = new Date(2026,9,8,18).getTime(); const at = (ms:number)=>new Date(now-ms).toISOString();
  assert.match(dmRowTime(at((19*60+59)*60000),now)!.label,/\d{2}:\d{2}/);
  assert.match(dmRowTime(at((20*60+1)*60000),now)!.label,/^[А-Я][а-я]/);
  assert.match(dmRowTime(at(6*86400000),now)!.label,/^[А-Я]/); assert.match(dmRowTime(at(7*86400000),now)!.label,/\d+ [а-я]/);
  assert.match(dmRowTime(at(364*86400000),now)!.label,/\d+ [а-я]/); assert.match(dmRowTime(at(366*86400000),now)!.label,/\d{2}\.\d{2}\.\d{2}/);
  assert.equal(dmRowTime('bad',now),null); assert.match(dmRowTime(at(-1000),now)!.label,/\d{2}:\d{2}/);
});
it('непрочитанная новинка прячет старый черновик, равная дата и неизвестный срок его сохраняют', () => {
  // Старый черновик не должен заслонять новое входящее в списке бесед.
  const p = { unread:true,lastAt:'2026-10-07T12:00:00Z',draftAt:'2026-10-07T11:00:00Z' };
  assert.equal(rowShowsDraft(p),false); assert.equal(rowShowsDraft({...p,unread:false}),true); assert.equal(rowShowsDraft({...p,draftAt:p.lastAt}),true); assert.equal(rowShowsDraft({...p,draftAt:null}),true);
  assert.equal(rowActivityAt({lastMessageAt:p.lastAt,createdAt:'2026-01-01',draftAt:'2026-10-07T13:00:00Z'}),'2026-10-07T13:00:00.000Z');
});
import { describe, it } from 'node:test';
import type { ConvLastMessage } from '@gusvoice/shared';
import { dmAttachmentPreview, dmRowPreview, dmRowStatus, matchDmName, dmRowLabel, plural, oneLine, matchDmUsername } from './dmRowRules';
import { attachmentPreviewOf, messageAttachmentLabel } from './dmRowRules';

it('только однородный список видео получает признак видео, смесь остаётся файлами', () => {
  // Фото рядом с видео не должно исчезнуть за подписью «2 видео».
  const video = { contentType: 'video/mp4', name: ' clip.mp4 ', durationMs: 42_000 };
  assert.deepEqual(attachmentPreviewOf([video]), { attachmentKind: 'file', attachmentName: 'clip.mp4', attachmentVideo: true, attachmentDurationMs: 42_000 });
  assert.deepEqual(attachmentPreviewOf([video, { ...video, contentType: 'video/webm' }]), attachmentPreviewOf([video]));
  for (const other of [{ contentType: 'image/png' }, { contentType: 'application/pdf' }]) assert.deepEqual(attachmentPreviewOf([video, other]), { attachmentKind: 'file', attachmentName: 'clip.mp4' });
  for (const durationMs of [0, -1, NaN, Infinity]) assert.deepEqual(attachmentPreviewOf([{ ...video, durationMs }]), { attachmentKind: 'file', attachmentName: 'clip.mp4', attachmentVideo: true });
  assert.equal(attachmentPreviewOf([null, 'file', 0, []]), null);
});

it('строка беседы и уведомление называют видео, число видео и обычный файл по-разному', () => {
  // Подписи должны совпадать по смыслу с серверным пушем, без превращения смешанного альбома в одно видео.
  for (const [n, label] of [[1, 'Видео'], [2, '2 видео'], [5, '5 видео']] as const) assert.deepEqual(dmAttachmentPreview({ text: '', attachments: n, attachmentKind: 'file', attachmentVideo: true, attachmentDurationMs: 42_000 }), { icon: 'camera', label });
  assert.equal(dmAttachmentPreview({ text: '', attachments: 1, attachmentKind: 'file', attachmentVideo: true })?.label, 'Видео');
  assert.equal(messageAttachmentLabel({ attachments: [{ contentType: 'video/mp4', durationMs: 42_000 }] }), 'Видео');
  assert.equal(messageAttachmentLabel({ attachments: [{ contentType: 'video/webm', durationMs: 5_000, round: true }] }), 'Видеосообщение');
  assert.equal(messageAttachmentLabel({ attachments: [{ contentType: 'video/mp4' }, { contentType: 'image/png' }] }), '2 файла');
  assert.equal(messageAttachmentLabel({ sticker: {}, attachments: [{ contentType: 'video/mp4' }] }), 'Стикер');
});

it('слова одиночного вложения в строке беседы совпадают с общим правилом цитаты', () => {
  // Независимый список слов со временем расходится с цитатой: кружок, голосовое и файл уже имели такие регрессии.
  const cases: { row: Partial<ConvLastMessage>; words: Parameters<typeof shared.attachmentWords>[0] }[] = [
    { row: { attachmentKind: 'voice', attachmentDurationMs: 42_000 }, words: { kind: 'voice' } },
    { row: { attachmentKind: 'file', attachmentVideo: true, attachmentDurationMs: 42_000 }, words: { kind: 'file', video: true } },
    { row: { attachmentKind: 'file', attachmentVideo: true, attachmentRound: true }, words: { kind: 'file', video: true, round: true } },
    { row: { attachmentKind: 'file', attachmentName: null as never }, words: { kind: 'file', name: null } },
    { row: { attachmentKind: 'file', attachmentName: '  каталог\t имя.pdf  ' }, words: { kind: 'file', name: '  каталог\t имя.pdf  ' } },
    { row: { attachmentKind: 'file', attachmentName: '😀'.repeat(300) }, words: { kind: 'file', name: '😀'.repeat(300) } },
  ];
  const check = (api: typeof rules) => {
    for (const { row, words } of cases) {
      assert.equal(api.dmAttachmentPreview(last({ text: '', attachments: 1, ...row }))?.label, shared.attachmentWords(words));
    }
  };
  check(rules);
  const source = readFileSync(new URL('./dmRowRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  check(loadDmRowRules(source));
  const from = "return { icon: 'camera', label: attachmentWords({ kind: 'file', video: true, round: true }) };";
  assert.ok(source.includes(from), 'найдена реальная ветка слов для кружка');
  const changed = source.replace(from, "return { icon: 'camera', label: 'Видео' };");
  assert.notEqual(changed, source, 'мутант действительно изменил исходник');
  assert.throws(() => check(loadDmRowRules(changed)), assert.AssertionError, 'расхождение списка и цитаты поймано');
});

it('логин беседы ищется по префиксу без регистра и одного @, не по подстроке', () => {
  // Искомый логин не показан в строке: подстрочный поиск даёт непонятные ложные совпадения.
  for (const q of ['cat', '@CAT', ' @ca ']) assert.equal(matchDmUsername('Cat.name', q), true);
  for (const q of ['', ' ', '@', '@@cat', 'at', 'dog']) assert.equal(matchDmUsername('Cat.name', q), false);
});

const last = (patch: Partial<ConvLastMessage> = {}): ConvLastMessage => ({
  id: 'm', authorId: 'me', text: 'текст', attachments: 0, sortKey: 10, ...patch,
} as ConvLastMessage);
describe('превью, поиск и доступное имя беседы', () => {
  it('виды вложений и подписи не подменяют файл голосовым или фото', () => {
    // Ловит неверную подпись и значок сводки, включая старый сервер без вида.
    const cases: [Partial<ConvLastMessage>, string, string][] = [
      [{ attachmentKind: 'photo' }, 'photo', 'Фото'], [{ attachmentKind: 'photo', attachments: 3 }, 'photo', '3 фото'],
      [{ attachmentKind: 'photo', text: 'подпись' }, 'photo', 'подпись'],
      [{ attachmentKind: 'voice', attachmentDurationMs: 42000 }, 'mic', 'Голосовое сообщение'],
      [{ attachmentKind: 'file', attachmentRound: true, attachmentVideo: true }, 'camera', 'Видеосообщение'],
      [{ attachmentKind: 'sticker' }, 'sticker', 'Стикер'], [{ attachmentKind: 'file', attachmentName: ' a\n b ' }, 'file', 'a b'],
      [{ attachmentKind: 'file' }, 'file', 'Файл'],
      ...[2, 5, 21].map((n): [Partial<ConvLastMessage>, string, string] => [{ attachmentKind: 'file', attachments: n }, 'file', `${n} ${n === 2 ? 'файла' : n === 21 ? 'файл' : 'файлов'}`]),
      ...[1, 2, 5, 11, 21].map((n): [Partial<ConvLastMessage>, string, string] => [{ attachments: n }, 'paperclip', n === 1 ? 'Вложение' : `${n} ${n === 2 ? 'вложения' : n === 21 ? 'вложение' : 'вложений'}`]),
      [{ text: 'подпись' }, 'paperclip', 'подпись'], [{ attachmentKind: 'video' as never }, 'paperclip', 'Вложение'],
    ];
    for (const [patch, icon, label] of cases) assert.deepEqual(dmAttachmentPreview(last({ text: '', attachments: 1, ...patch })), { icon, label });
  });
  it('нулевая и негодная длительность не рисуют выдуманное время голосового', () => {
    // Ловит NaN/отрицательные часы, а не просто отсутствие поля.
    for (const ms of [undefined, 0, NaN, -1, Infinity]) assert.deepEqual(dmAttachmentPreview(last({ attachments: 1, attachmentKind: 'voice', attachmentDurationMs: ms })), { icon: 'mic', label: 'Голосовое сообщение' });
    for (const n of [0, -1, NaN, Infinity]) assert.equal(dmAttachmentPreview(last({ attachments: n })), null);
  });
  it('печатает выше черновика, черновик выше вложения, пробелы не черновик', () => {
    // Ловит показ старого текста вместо текущего набора и ложный пустой черновик.
    const m = last({ attachments: 1, attachmentKind: 'photo' });
    assert.deepEqual(dmRowPreview({ typing: true, draft: 'черновик', last: m }), { kind: 'typing' });
    assert.deepEqual(dmRowPreview({ typing: false, draft: ' a\n b ', last: m }), { kind: 'draft', text: 'a b' });
    assert.deepEqual(dmRowPreview({ typing: false, draft: ' \n ', last: m }), { kind: 'attachment', icon: 'photo', label: 'текст' });
    for (const x of [null, undefined, 'bad' as never, last({ text: '' })]) assert.deepEqual(dmRowPreview({ typing: false, last: x }), { kind: 'none' });
    assert.deepEqual(dmRowPreview({ typing: false, last: last() }), { kind: 'text', text: 'текст' });
  });
  it('ровно 200 кодовых точек проходят, следующая заменяется многоточием', () => {
    // Ловит разрыв surrogate pair и границу длины подписи.
    assert.equal(oneLine('😀'.repeat(200)), '😀'.repeat(200));
    assert.equal(oneLine('😀'.repeat(201)), '😀'.repeat(199) + '…');
    assert.deepEqual(dmRowPreview({ typing: false, draft: 'x'.repeat(201) }), { kind: 'draft', text: 'x'.repeat(199) + '…' });
  });
  it('отметка только у своего, при печатает остаётся, при черновике исчезает', () => {
    // Ловит покупку ✓✓ чужому сообщению и неверную отметку черновика.
    const p = { last: last(), meId: 'me', peerReadKey: 10, preview: { kind: 'typing' as const } };
    assert.equal(dmRowStatus(p), 'read'); assert.equal(dmRowStatus({ ...p, peerReadKey: 9 }), 'sent');
    assert.equal(dmRowStatus({ ...p, peerReadKey: null }), 'sent');
    assert.equal(dmRowStatus({ ...p, last: last({ authorId: 'peer' }) }), null);
    assert.equal(dmRowStatus({ ...p, meId: undefined }), null);
    assert.equal(dmRowStatus({ ...p, preview: { kind: 'draft', text: 'x' } }), null);
  });
  it('поиск по началу любого слова сохраняет исходные буквы и ё', () => {
    // Ловит произвольную подстроку имени и смещённое выделение после нормализации.
    assert.deepEqual(matchDmName('Учёный Кот', ' КО '), { before: 'Учёный ', hit: 'Ко', after: 'т' });
    assert.deepEqual(matchDmName('Кот Учёный', 'кот уч'), { before: '', hit: 'Кот Уч', after: 'ёный' });
    assert.equal(matchDmName('Пакостник', 'ко'), null);
    for (const q of ['ёжик', 'ежик']) assert.deepEqual(matchDmName('Ёжик', q), { before: '', hit: 'Ёжик', after: '' });
    assert.deepEqual(matchDmName('Ежик', 'ёжик'), { before: '', hit: 'Ежик', after: '' });
    assert.deepEqual(matchDmName('Ёжик', ''), { before: 'Ёжик', hit: '', after: '' });
  });
  it('скринридер говорит Вы только у последнего, непрочитанное — последним', () => {
    // Ловит ложного автора черновика и пустые части aria-label.
    const p = { name: 'Кот', online: true, mine: true, preview: { kind: 'text' as const, text: 'текст' }, time: '21:08', status: 'sent' as const, unread: 0, failed: false };
    assert.equal(dmRowLabel(p), 'Кот, в сети. Вы: текст. 21:08, отправлено');
    assert.equal(dmRowLabel({ ...p, mine: false, status: null, time: '20:47', unread: 2 }), 'Кот, в сети. текст. 20:47. 2 непрочитанных');
    for (const preview of [{ kind: 'typing' as const }, { kind: 'draft' as const, text: 'x' }]) assert.equal(dmRowLabel({ ...p, preview }).includes('Вы:'), false);
    for (const [unread, text] of [['dot', 'есть непрочитанное'], [1, '1 непрочитанное'], [5, '5 непрочитанных']] as const) assert.equal(dmRowLabel({ ...p, unread }).endsWith(text), true);
    assert.equal(dmRowLabel({ ...p, online: false, preview: { kind: 'none' }, time: null, status: null }), 'Кот');
  });
  it('неотправленное заменяет любую отметку, но не число непрочитанных', () => {
    // Ловит прежний ! вместо счётчика и двойной рассказ об успехе и ошибке.
    for (const status of ['sent', 'read', null] as const) for (const time of ['21:08', null]) {
      const label = dmRowLabel({ name: 'Гусь', online: false, mine: true, preview: { kind: 'text', text: 'x' }, time, status, unread: 2, failed: true });
      assert.equal(label, `Гусь. Вы: x. ${time ? time + ', ' : ''}есть неотправленное. 2 непрочитанных`);
    }
  });
  it('склонение не ломается на 11–14 и повторяется через сотню', () => {
    // Ловит выбор окончания только по последней цифре.
    for (const [n, expected] of [[1,'a'],[2,'b'],[4,'b'],[5,'c'],[11,'c'],[12,'c'],[14,'c'],[21,'a'],[22,'b'],[25,'c'],[111,'c']] as const) assert.equal(plural(n,'a','b','c'), expected);
  });
});

it('GIF в списке называется GIF, смешанный альбом и обычный GIF-MIME без признака — нет', () => {
  // MIME-типа недостаточно: анимированная картинка должна быть помечена серверным признаком, иначе фото не станет GIF.
  const check = (api: typeof rules) => {
    assert.equal(api.dmAttachmentPreview({ text: '', attachments: 1, attachmentKind: 'photo', attachmentGif: true })?.label, 'GIF');
    assert.equal(api.dmAttachmentPreview({ text: 'подпись', attachments: 1, attachmentKind: 'photo', attachmentGif: true })?.label, 'подпись');
    assert.equal(api.dmAttachmentPreview({ text: '', attachments: 3, attachmentKind: 'file', attachmentGif: true })?.label, '3 GIF');
    assert.equal(api.dmAttachmentPreview({ text: '', attachments: 1, attachmentKind: 'photo' })?.label, 'Фото');
  };
  check(rules);
  const source = readFileSync(new URL('./dmRowRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('if (last.attachmentGif === true)'), 'GIF-ветка найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace('if (last.attachmentGif === true)', 'if (false)'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => id === '@gusvoice/shared' ? shared : (id === './bubbleRules' ? bubbleRules : {}) });
  assert.throws(() => check(module.exports as typeof rules), assert.AssertionError, 'мутант молча переименовывает GIF в фото/файл');
});
