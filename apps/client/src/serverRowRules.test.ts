import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './serverRowRules';
import * as dmRules from './dmRowRules';
import type { Message, ServerLastMessage } from '@gusvoice/shared';
const source = readFileSync(new URL('./serverRowRules.ts', import.meta.url), 'utf8');
function vm(raw: string): typeof rules {
  const module = { exports: {} as typeof rules };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports,
    require: (id: string) => { assert.equal(id, './dmRowRules', 'только настоящие чистые правила превью'); return dmRules; } });
  return module.exports;
}
function check(r = rules) {
  for (const [closed, unread, mentions, text] of [
    [true, 5, 2, 'Закрыт держателем'], [false, 5, 2, 'Упоминаний: 2 · Новых сообщений: 3'],
    [false, 1, 1, 'Упоминаний: 1'], [false, 4, 0, 'Новых сообщений: 4'], [false, 0, 0, ''],
    [false, 0, 2, 'Упоминаний: 2'],
  ] as const) assert.equal(r.serverRowLine({ closed, unread, mentions }), text, 'строка серверных счётчиков');
}
it('R174 закрытый сервер не показывает счётчики, обращения не считаются новыми дважды', () => {
  // Одно упоминание входит в оба счётчика; без вычитания один текст стал бы двумя новыми сообщениями.
  check();
});
it('R174 контрфакты двойного счёта и раскрытия счётчиков закрытого сервера отвергаются', () => {
  // Исполняем весь чистый модуль; исходный контракт проходит до каждого мутанта.
  for (const [anchor, replacement] of [
    ['s.unread - s.mentions', 's.unread'], ["if (s.closed) return 'Закрыт держателем';", "if (false) return 'Закрыт держателем';"],
  ]) {
    check(); assert.equal(source.split(anchor).length - 1, 1);
    const mutant = vm(source.replace(anchor, replacement));
    assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.includes('строка серверных'));
  }
});

const message = (patch: Record<string, unknown> = {}): Message => ({ id: 'msg', content: 'Текст',
  author: { id: 'user', displayName: 'dmtest_a', username: 'dmtest_b' },
  createdAt: '2026-10-12T12:00:00Z', attachments: [], ...patch } as unknown as Message);
const last = (patch: Partial<ServerLastMessage> = {}): ServerLastMessage => ({ id: 'old', channelId: 'channel',
  channelName: 'Канал', authorId: 'user', authorName: 'dmtest_a', text: 'Раньше', attachments: 0,
  createdAt: '2026-10-12T12:00:00Z', ...patch });

it('R180 последнее сообщение сохраняет идентификаторы и имя автора, убирает переносы и ограничивает текст 200 знаками', () => {
  // Многострочное сообщение не должно ломать строку сервера; граница проверяется в кодовых точках.
  const preview = rules.serverLastFromMessage(message({ content: '  Один\n\tдва  ' }), 'c', 'Общий');
  assert.deepEqual(preview, { id: 'msg', channelId: 'c', channelName: 'Общий', authorId: 'user',
    authorName: 'dmtest_a', text: 'Один два', attachments: 0, createdAt: '2026-10-12T12:00:00Z' });
  for (const n of [199, 200, 201]) {
    const p = rules.serverLastFromMessage(message({ content: '🪿'.repeat(n), author: { id: 'user', displayName: '', username: 'dmtest_b' } }), 'c', '');
    assert.equal(p.authorName, 'dmtest_b'); assert.equal('channelName' in p, false);
    assert.equal(p.text, n <= 200 ? '🪿'.repeat(n) : '🪿'.repeat(199) + '…');
  }
});

for (const [name, patch, expected] of [
  ['без вложений', {}, {}],
  ['стикер без текста', { content: '', sticker: { emoji: '🪿' } }, { attachmentKind: 'sticker', text: '🪿' }],
  ['стикер с подписью', { content: 'Подпись', sticker: { emoji: '🪿' } }, { attachmentKind: 'sticker', text: 'Подпись' }],
  ['все фотографии', { attachments: [{ contentType: 'image/png' }, { contentType: 'image/jpeg' }] }, { attachmentKind: 'photo' }],
  ['голосовое', { attachments: [{ contentType: 'audio/ogg', waveform: [1], durationMs: 500 }] }, { attachmentKind: 'voice', attachmentDurationMs: 500 }],
  ['аудиофайл без огибающей', { attachments: [{ contentType: 'audio/ogg', name: 'audio.ogg' }] }, { attachmentKind: 'file', attachmentName: 'audio.ogg' }],
  ['смешанные вложения', { attachments: [{ contentType: 'image/png', name: 'photo.png' }, { contentType: 'application/pdf' }] }, { attachmentKind: 'file', attachmentName: 'photo.png' }],
  ['все видео и кружок', { attachments: [{ contentType: 'video/mp4', round: true, durationMs: 800 }, { contentType: 'video/webm' }] }, { attachmentKind: 'file', attachmentVideo: true, attachmentRound: true, attachmentDurationMs: 800 }],
  ['все GIF', { attachments: [{ contentType: 'image/gif', gif: true }, { contentType: 'image/gif', gif: true }] }, { attachmentKind: 'photo', attachmentGif: true }],
  ['смешанные GIF и фото', { attachments: [{ contentType: 'image/gif', gif: true }, { contentType: 'image/png' }] }, { attachmentKind: 'photo' }],
  ['видео с другим типом', { attachments: [{ contentType: 'video/mp4', name: 'video.mp4', round: true }, { contentType: 'application/pdf' }] }, { attachmentKind: 'file', attachmentName: 'video.mp4' }],
  ['голосовое без допустимой длительности', { attachments: [{ contentType: 'audio/ogg', waveform: [1], durationMs: Infinity }] }, { attachmentKind: 'voice' }],
  ['фото при наличии стикера', { attachments: [{ contentType: 'image/png' }], sticker: { emoji: '🪿' } }, { attachmentKind: 'photo' }],
  ['битой формы вложений', { attachments: null }, {}],
] as const) it(`R180 превью ${name} использует вид вложения и точное число`, () => {
  // Подмена вида теряет различие голосового, фото и файла; стикер не перекрывает реальные вложения.
  const m = message(patch); const p = rules.serverLastFromMessage(m, 'c');
  assert.equal(p.attachments, Array.isArray(m.attachments) ? m.attachments.length : 0);
  for (const key of ['attachmentKind', 'attachmentName', 'attachmentDurationMs', 'attachmentVideo', 'attachmentRound', 'attachmentGif', 'text']) {
    const wanted = (expected as Record<string, unknown>)[key];
    assert.equal((p as unknown as Record<string, unknown>)[key], key === 'text' ? wanted ?? m.content : wanted, `поле ${key}`);
  }
});

function feature(r = rules) {
  const old: { id: string; lastMessage?: ServerLastMessage | null }[] =
    [{ id: 'legacy' }, { id: 'explicit', lastMessage: undefined }, { id: 'modern', lastMessage: null }];
  const incoming = last({ id: 'new' });
  for (const id of ['legacy', 'explicit']) assert.equal(r.applyServerMessageCreate(old, id, incoming) === old, true, 'сервер без поля не меняется');
  const next = r.applyServerMessageCreate(old, 'modern', incoming);
  assert.equal(next === old, false); assert.equal(next[2].lastMessage === incoming, true);
  assert.equal(next[0] === old[0], true); assert.equal(next[1] === old[1], true);
  assert.equal(old[2].lastMessage, null);
}
it('R180 отсутствие и undefined поля сохраняют старый сервер, null разрешает первое сообщение', () => {
  // Feature-presence отличает пустой современный сервер от старого протокола.
  feature();
});
it('R180 событие без serverId и неизвестного сервера сохраняет массив и все строки', () => {
  // Рассинхрон протокола не должен обновлять случайный первый сервер.
  const servers = [{ id: 's', lastMessage: null }];
  for (const id of [undefined, '', 'other']) assert.equal(rules.applyServerMessageCreate(servers, id, last()) === servers, true);
});
function dates(r = rules) {
  const previous = last(); const servers = [{ id: 's', lastMessage: previous }, { id: 'other', lastMessage: null }];
  const older = last({ id: 'older', createdAt: '2026-10-12T11:59:59Z' });
  assert.equal(r.applyServerMessageCreate(servers, 's', older) === servers, true, 'старое не вытесняет последнее');
  for (const createdAt of ['2026-10-12T12:00:00Z', '2026-10-12T12:00:01Z']) {
    const incoming = last({ id: 'new', createdAt }); const next = r.applyServerMessageCreate(servers, 's', incoming);
    assert.equal(next[0].lastMessage === incoming, true); assert.equal(next[1] === servers[1], true);
    assert.equal(servers[0].lastMessage === previous, true);
  }
}
it('R180 старое сообщение не вытесняет последнее, равное и новое время принимаются без мутации списка', () => {
  // Неупорядоченные события не должны откатывать превью; равенство времени не означает устаревание.
  dates();
});
it('R180 правка затрагивает только последнее по id, сохраняя канал и время, а имя канала обновляет лишь при наличии', () => {
  // Редактирование текста не переносит сообщение в другой канал и не меняет порядок серверов.
  const prev = last(); const servers = [{ id: 'legacy' }, { id: 'empty', lastMessage: null },
    { id: 's', lastMessage: prev }, { id: 'other', lastMessage: last({ id: 'othermsg' }) }];
  assert.equal(rules.applyServerMessageUpdate(servers, last({ id: 'missing' })) === servers, true);
  for (const channelName of [undefined, 'Новое имя']) {
    const edited = last({ text: 'Правка', channelId: 'wrong', channelName, createdAt: '2030-01-01T00:00:00Z', attachmentKind: 'photo', attachments: 2 });
    const next = rules.applyServerMessageUpdate(servers, edited);
    assert.equal(next === servers, false);
    for (const i of [0, 1, 3]) assert.equal(next[i] === servers[i], true);
    assert.deepEqual(next[2].lastMessage, { ...edited, channelId: 'channel', channelName: channelName ?? 'Канал', createdAt: prev.createdAt });
    assert.equal(servers[2].lastMessage === prev, true);
  }
});
it('R180 последнее сообщение ищется во всех серверах, пустые и чужие сообщения не совпадают', () => {
  // Удаление последнего не только в первом сервере должно потребовать обновления списка.
  const servers = [{}, { lastMessage: null }, { lastMessage: last({ id: 'a' }) }, { lastMessage: last({ id: 'b' }) }];
  for (const id of ['a', 'b']) assert.equal(rules.isServerLastMessage(servers, id), true);
  for (const id of ['missing', '']) assert.equal(rules.isServerLastMessage(servers, id), false);
  assert.equal(rules.isServerLastMessage([], 'a'), false);
});
for (const [name, anchor, replacement, scenario, message] of [
  ['игнорирование признака нового протокола', 'if (s.lastMessage === undefined) return servers;', 'if (false) return servers;', feature, 'сервер без поля'],
  ['игнорирование возраста сообщения', 'if (s.lastMessage && Date.parse(s.lastMessage.createdAt) > Date.parse(last.createdAt)) return servers;', 'if (false) return servers;', dates, 'старое не вытесняет'],
] as const) it(`R180 мутант «${name}» отвергается поведением целого модуля`, () => {
  // Original-first и целевой AssertionError не принимают сломанную загрузку за обнаружение регрессии.
  scenario(); assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь');
  assert.throws(() => scenario(vm(source.replace(anchor, replacement))),
    e => e instanceof assert.AssertionError && e.message.includes(message));
});
