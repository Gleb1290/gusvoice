import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as dmRowRules from './dmRowRules';
import type { PopupPreview, PopupSink } from './notifications';

const source = readFileSync(new URL('./notifications.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
function fixture(raw = source, desktop = true) {
  const module = { exports: {} }, storage = new Map<string, string>();
  const calls: { cmd: string; args: unknown }[] = [], listeners = new Map<string, (e: { payload: unknown }) => void>();
  const core = { invoke(cmd: string, args: unknown) { calls.push({ cmd, args: plain(args) }); return Promise.resolve(); } };
  const dependencies: Record<string, unknown> = { '@gusvoice/shared': shared, './dmRowRules': dmRowRules, './hotkeys': { isDesktop: () => desktop, isTauri: () => true } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports,
    window: { __TAURI__: { core, event: { async listen(name: string, fn: (e: { payload: unknown }) => void) { listeners.set(name, fn); return () => {}; } } } },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    require(id: string) { assert.ok(Object.hasOwn(dependencies, id), `неожиданная зависимость ${id}`); return dependencies[id]; },
  });
  const api = module.exports as typeof import('./notifications');
  const notices: Parameters<PopupSink['show']>[0][] = [], cleared: string[] = [];
  let accept = true, clicks = 0;
  const sink: PopupSink = { show(data) { notices.push(data); return accept; }, clear(group) { cleared.push(group); } };
  const send = (title = 'Обычный заголовок', preview?: PopupPreview) => api.osNotify(title, 'Секретный текст', () => { clicks++; }, true,
    { conv: 'conv-7', group: 'group-7', groupChat: true, popup: { title: 'Секретная группа', author: 'Секретный автор', avatar: '/secret-avatar.png', ...(preview ? { preview } : {}) } });
  return { api, calls, listeners, notices, cleared, sink, send, reject() { accept = false; }, get clicks() { return clicks; } };
}
it('R223 без popup-приёмника остаётся прежняя нативная команда беседы, отказ приёмника сохраняет тот же путь', () => {
  const f = fixture(); f.send();
  assert.equal(f.notices.length, 0); assert.deepEqual(f.calls.map(c => c.cmd), ['gv_notify_conversation']);
  assert.equal((f.calls[0]!.args as { group: string }).group, 'conv-7');
  f.api.setNotifyPopupSink(f.sink); f.reject(); f.send();
  assert.equal(f.notices.length, 1); assert.deepEqual(f.calls.map(c => c.cmd), ['gv_notify_conversation', 'gv_notify_conversation']);
});
it('R223 принятая карточка не вызывает ни одного invoke и использует прежний обработчик клика', () => {
  const f = fixture(); f.api.setNotifyPopupSink(f.sink); f.send();
  assert.equal(f.calls.length, 0); assert.equal(f.notices.length, 1);
  const data = f.notices[0]!;
  assert.deepEqual(plain(data), { tag: data.tag, title: 'Секретная группа', author: 'Секретный автор', body: 'Секретный текст', avatar: '/secret-avatar.png', conv: 'conv-7', group: 'group-7' });
  f.listeners.get('gv://notify-action')!({ payload: { action: 'open', tag: data.tag } }); assert.equal(f.clicks, 1);
  f.listeners.get('gv://notify-action')!({ payload: { action: 'open', tag: data.tag } }); assert.equal(f.clicks, 1);
});
function privacy(raw = source) {
  const f = fixture(raw); f.api.setNotifyPopupSink(f.sink);
  f.api.setNotifyPrefs({ view: 'all', groups: true }); f.send();
  assert.equal(f.notices[0]!.title, 'Секретная группа'); assert.equal(f.notices[0]!.conv, 'conv-7');
  f.api.setNotifyPrefs({ view: 'name', groups: true }); f.send();
  assert.equal(f.notices[1]!.title, 'Секретная группа'); assert.equal(f.notices[1]!.body, shared.NOTIFY_HIDDEN_BODY); assert.equal(f.notices[1]!.conv, undefined);
  f.api.setNotifyPrefs({ view: 'nothing', groups: true }); f.send();
  const hidden = f.notices[2]!;
  assert.equal(hidden.title, shared.NOTIFY_HIDDEN_TITLE, 'R223-privacy-title: скрытое имя не заменяется метаданными popup');
  assert.equal(hidden.author, undefined); assert.equal(hidden.avatar, null); assert.equal(hidden.body, shared.NOTIFY_HIDDEN_BODY); assert.equal(hidden.conv, undefined);
  assert.equal(f.calls.length, 0);
}
it('R223 реальные правила приватности убирают имя/автора/аватар и быстрый ответ, имя без текста сохраняет название', () => privacy());
function maskedTitlePrivacy(raw = source) {
  const f = fixture(raw); f.api.setNotifyPopupSink(f.sink);
  // Совпадение исходного заголовка с маской не означает разрешение показать частные popup-метаданные.
  f.api.setNotifyPrefs({ view: 'nothing', groups: true }); f.send(shared.NOTIFY_HIDDEN_TITLE);
  const hidden = f.notices[0]!;
  assert.equal(hidden.title, shared.NOTIFY_HIDDEN_TITLE, 'R228-privacy-same-title: совпавший заголовок не открывает имя чата');
  assert.equal(hidden.author, undefined); assert.equal(hidden.avatar, null);
  assert.equal(hidden.body, shared.NOTIFY_HIDDEN_BODY); assert.equal(hidden.conv, undefined);
  // Парный разрешённый путь ловит ошибку «всегда скрывать» при таком же исходном заголовке.
  for (const view of ['name', 'all'] as const) {
    f.api.setNotifyPrefs({ view, groups: true }); f.send(shared.NOTIFY_HIDDEN_TITLE);
    const shown = f.notices.at(-1)!;
    assert.equal(shown.title, 'Секретная группа'); assert.equal(shown.author, 'Секретный автор');
    assert.equal(shown.avatar, '/secret-avatar.png');
    assert.equal(shown.body, view === 'all' ? 'Секретный текст' : shared.NOTIFY_HIDDEN_BODY);
    assert.equal(shown.conv, view === 'all' ? 'conv-7' : undefined);
  }
  assert.equal(f.notices.length, 3); assert.equal(f.calls.length, 0);
}
it('R228 заголовок GusVoice при Ничего не показывать скрывает метаданные, а Имя и Всё сохраняют их', () => maskedTitlePrivacy());
function fallback(raw = source) {
  const f = fixture(raw); f.api.setNotifyPopupSink(f.sink); f.send();
  assert.equal(f.notices.length, 1); assert.equal(f.calls.length, 0);
  f.notices[0]!.fallback();
  assert.equal(f.notices.length, 1, 'R223-fallback: системный откат не обращается к приёмнику повторно');
  assert.deepEqual(f.calls.map(c => c.cmd), ['gv_notify_conversation']);
  assert.equal((f.calls[0]!.args as { title: string }).title, 'Обычный заголовок');
  f.listeners.get('gv://notify-action')!({ payload: { action: 'open', tag: f.notices[0]!.tag } }); assert.equal(f.clicks, 0, 'прежняя popup-метка после fallback не действует');
  f.listeners.get('gv://notify-action')!({ payload: { action: 'open', tag: (f.calls[0]!.args as { tag: string }).tag } }); assert.equal(f.clicks, 1);
}
it('R223 fallback показывает системный тост с новой кликабельной меткой и не зацикливается в popup', () => fallback());
it('R223 прочтение вызывает sink.clear для нужной беседы; отключение приёмника возвращает старый путь', () => {
  const f = fixture(); f.api.setNotifyPopupSink(f.sink); f.api.clearOsNotifications('group-7');
  assert.deepEqual(f.cleared, ['group-7']); f.api.setNotifyPopupSink(null); f.api.clearOsNotifications('other');
  assert.deepEqual(f.cleared, ['group-7']); f.send(); assert.deepEqual(f.calls.map(c => c.cmd), ['gv_notify_conversation']);
});
for (const [label, from, to, check, prefix, actual, expected] of [
  ['fallback повторно зовёт приёмник', 'popup !== null && popupSink', 'true && popupSink', fallback, 'R223-fallback:', 2, 1],
  ['приватные метаданные проходят при скрытом имени', 'opts.popup && notifyShowsName(notifyPrefs.view) ? opts.popup : undefined', 'opts.popup', privacy, 'R223-privacy-title:', 'Секретная группа', shared.NOTIFY_HIDDEN_TITLE],
  // Старое сравнение строк было зелёным на обычном заголовке, но открывало метаданные при заголовке-маске.
  ['сравнение заголовков ошибочно разрешает скрытые метаданные GusVoice', 'opts.popup && notifyShowsName(notifyPrefs.view) ? opts.popup : undefined',
    'opts.popup && n.title === title ? opts.popup : undefined', maskedTitlePrivacy, 'R228-privacy-same-title:', 'Секретная группа', shared.NOTIFY_HIDDEN_TITLE],
] as const) it(`R223 контрфакт доставки: ${label}`, () => {
  check(source); assert.equal(source.split(from).length - 1, 1);
  assert.throws(() => check(source.replace(from, to)), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
});

type PreviewMessage = Parameters<typeof import('./notifications').popupPreview>[0];
type PreviewApi = Pick<typeof import('./notifications'), 'popupPreview'>;
function previewIs(api: PreviewApi, message: PreviewMessage, expected: PopupPreview, prefix: string) {
  const actual = api.popupPreview(message);
  assert.equal(actual.kind, expected.kind, `${prefix} вид сообщения`);
  assert.equal(actual.text, expected.text, `${prefix} текст или подпись`);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${prefix} нет лишних полей`);
}
const photo = { contentType: 'image/png', name: 'photo.png' };
const file = { contentType: 'application/pdf', name: 'report.pdf' };
const poll = { kind: 'poll', question: 'Куда идём?', options: [{ id: '0', text: 'Парк' }, { id: '1', text: 'Домой' }] };

it('R233 превью отделяет вид каждого вложения от подписи и не подставляет запасной текст карточек', () => {
  const api = fixture().api;
  const cases: [string, PreviewMessage, PopupPreview][] = [
    ['обычный текст', { content: 'Привет' }, { text: 'Привет' }],
    ['форматированный текст', { content: '**Жирный** и _курсив_' }, { text: 'Жирный и курсив' }],
    ['фото без подписи', { content: '', attachments: [photo] }, { kind: 'Фото', text: '' }],
    ['фото с подписью', { content: 'Подпись', attachments: [photo] }, { kind: 'Фото', text: 'Подпись' }],
    ['альбом без подписи', { content: '', attachments: [photo, photo, photo] }, { kind: '3 фото', text: '' }],
    ['альбом с подписью', { content: 'Наш вечер', attachments: [photo, photo] }, { kind: '2 фото', text: 'Наш вечер' }],
    ['видео', { content: 'Запись', attachments: [{ contentType: 'video/mp4', name: 'clip.mp4' }] }, { kind: 'Видео', text: 'Запись' }],
    ['кружок', { content: '', attachments: [{ contentType: 'video/mp4', round: true, durationMs: 8000 }] }, { kind: 'Видеосообщение', text: '' }],
    ['голосовое', { content: '', attachments: [{ contentType: 'audio/ogg', waveform: [0.2, 0.8], durationMs: 15000 }] }, { kind: 'Голосовое сообщение', text: '' }],
    ['файл без подписи', { content: '', attachments: [file] }, { kind: 'report.pdf', text: '' }],
    ['файл с подписью', { content: 'Отчёт', attachments: [file] }, { kind: 'report.pdf', text: 'Отчёт' }],
    ['файл без имени', { content: '', attachments: [{ contentType: 'application/octet-stream' }] }, { kind: 'Файл', text: '' }],
    // Аудио без огибающей — файл с именем, а не голосовое, как в настоящем messageAttachmentLabel.
    ['музыка', { content: 'Любимая песня', attachments: [{ contentType: 'audio/mpeg', name: 'track.mp3' }] }, { kind: 'track.mp3', text: 'Любимая песня' }],
    ['стикер с эмодзи', { content: '', sticker: { emoji: ' 😎 ' } }, { kind: '😎 Стикер', text: '' }],
    ['стикер без эмодзи', { content: '', sticker: { emoji: '' } }, { kind: 'Стикер', text: '' }],
    ['GIF', { content: '', attachments: [{ contentType: 'image/gif', gif: true }] }, { kind: 'GIF', text: '' }],
    ['GIF-видео с подписью', { content: 'Реакция', attachments: [{ contentType: 'video/mp4', gif: true }] }, { kind: 'GIF', text: 'Реакция' }],
    ['геопозиция', { content: 'Запасная ссылка', media: { kind: 'geo', lat: 55, lon: 37, accuracy: null } }, { kind: 'Геопозиция', text: '' }],
    ['трансляция', { content: 'Запасная ссылка', media: { kind: 'geolive', lat: 55, lon: 37, accuracy: null, heading: null, period: 900, startedAt: 1000, until: 901000, updatedAt: 1000, stopped: false } }, { kind: 'Геопозиция в реальном времени', text: '' }],
    ['опрос', { content: 'Запасной опрос', media: poll }, { kind: '📊 Куда идём?', text: '' }],
    ['викторина', { content: 'Запасная викторина', media: { ...poll, quiz: true, correct: '0' } }, { kind: '📊 Куда идём?', text: '' }],
    ['контакт', { content: 'Запасной контакт', media: { kind: 'contact', username: 'friend', displayName: 'Друг', userId: null, avatarUrl: null } }, { kind: 'Контакт: Друг', text: '' }],
  ];
  for (const [label, message, expected] of cases) previewIs(api, message, expected, `R233-preview-${label}:`);
});
function incomingCall(raw = source) {
  const api = fixture(raw).api;
  for (const [reason, title] of [['missed', 'Пропущенный'], ['busy', 'Отклонённый'], ['hangup', 'Входящий']] as const) {
    for (const video of [false, true]) {
      previewIs(api, { content: 'Запасная запись', service: { kind: 'call', reason, video, duration: 0 } },
        { kind: `${title} ${video ? 'видеозвонок' : 'звонок'}`, text: '' }, 'R233-call-incoming:');
    }
  }
  previewIs(api, { content: '', service: { kind: 'call', reason: 'hangup', video: true, duration: 65 } },
    { kind: 'Входящий видеозвонок, 1 мин', text: '' }, 'R233-call-duration:');
  for (const duration of [undefined, NaN, Infinity, '65']) previewIs(api,
    { content: '', service: { kind: 'call', reason: 'hangup', duration } }, { kind: 'Входящий звонок', text: '' }, 'R233-call-invalid-duration:');
}
it('R233 запись звонка всегда показана глазами принимающего, включая отказ, видео и длительность', () => incomingCall());
it('R233 незнакомые media и service оставляют текст, а пустое сообщение получает понятную подпись', () => {
  const api = fixture().api;
  for (const extra of [{ media: { kind: 'future' } }, { service: { kind: 'future' } }, { media: { kind: 'geo', lat: '55', lon: 37 } },
    { service: { kind: 'call', reason: 123 } }, { media: null, service: null }, { attachments: [] }]) {
    previewIs(api, { content: 'Запасной текст', ...extra }, { text: 'Запасной текст' }, 'R233-preview-unknown:');
    previewIs(api, { content: '', ...extra }, { text: 'Новое сообщение' }, 'R233-preview-empty:');
  }
  previewIs(api, { content: ' \n\r\t ' }, { text: 'Новое сообщение' }, 'R233-preview-whitespace:');
});
it('R233 превью схлопывает переводы строк до обрезки, ровно 300 знаков ещё без многоточия', () => {
  const api = fixture().api;
  assert.equal(api.POPUP_TEXT_MAX, 300);
  for (const n of [299, 300, 301]) {
    previewIs(api, { content: 'я'.repeat(n) }, { text: 'я'.repeat(Math.min(n, 300)) + (n > 300 ? '…' : '') }, `R233-preview-limit-${n}:`);
  }
  for (const attachments of [undefined, [photo]]) previewIs(api,
    { content: '  первая\r\nвторая\n\t третья  ', attachments },
    { ...(attachments ? { kind: 'Фото' } : {}), text: 'первая вторая третья' }, 'R233-preview-newlines:');
  previewIs(api, { content: `  ${'я'.repeat(299)}\n  `, attachments: [file] }, { kind: 'report.pdf', text: 'я'.repeat(299) }, 'R233-preview-before-clip:');
});
function caption(raw = source) {
  const api = fixture(raw).api;
  for (const attachments of [[photo], [file]]) previewIs(api, { content: 'Подпись', attachments },
    { kind: attachments[0] === photo ? 'Фото' : 'report.pdf', text: 'Подпись' }, 'R233-caption:');
}
function pollIcon(raw = source) {
  previewIs(fixture(raw).api, { content: 'Запасной опрос', media: poll }, { kind: '📊 Куда идём?', text: '' }, 'R233-poll-icon:');
}
function previewPrivacy(raw = source) {
  const f = fixture(raw); f.api.setNotifyPopupSink(f.sink);
  for (const view of ['all', 'name', 'nothing'] as const) {
    f.api.setNotifyPrefs({ view, groups: true });
    // Пустая подпись тоже содержимое превью: нельзя подменить её запасной строкой системного тоста через ||.
    const previews: PopupPreview[] = [{ kind: 'Фото', text: 'Секретная подпись' }, { kind: 'Фото', text: '' }, { text: 'Обычный текст' }];
    for (const preview of previews) {
      f.send(undefined, preview);
      const shown = f.notices.at(-1)!;
      assert.equal(shown.body, view === 'all' ? preview.text : shared.NOTIFY_HIDDEN_BODY, 'R233-preview-privacy-body: текст скрывается по настройке');
      assert.equal(shown.kind, view === 'all' ? preview.kind : undefined, 'R233-preview-delivery-kind: вид разрешён только вместе с текстом');
      assert.equal(Object.prototype.hasOwnProperty.call(shown, 'kind'), view === 'all' && Boolean(preview.kind), 'R233-preview-privacy-key: скрытого вида нет даже ключом undefined');
      assert.equal(shown.conv, view === 'all' ? 'conv-7' : undefined);
    }
  }
  assert.equal(f.notices.length, 9); assert.equal(f.calls.length, 0);
}
it('R233 свой popup получает подпись и вид только при показе текста, скрытие не раскрывает вложение', () => previewPrivacy());
for (const [label, from, to, check, prefix, actual, expected] of [
  ['теряется подпись вложения', 'if (label) return { kind: label, text };', "if (label) return { kind: label, text: '' };", caption, 'R233-caption:', '', 'Подпись'],
  ['звонок показан глазами звонившего', 'video: svc.video === true }, false)', 'video: svc.video === true }, true)', incomingCall, 'R233-call-incoming:', 'Отменённый звонок', 'Пропущенный звонок'],
  ['вопрос теряет значок опроса', 'kind: `📊 ${media.question}`', 'kind: media.question', pollIcon, 'R233-poll-icon:', 'Куда идём?', '📊 Куда идём?'],
  ['скрытая подпись проходит в popup', 'named?.preview && !notifyShowsText(notifyPrefs.view)', 'false', previewPrivacy, 'R233-preview-privacy-body:', 'Секретная подпись', shared.NOTIFY_HIDDEN_BODY],
  ['разрешённый вид пропадает по дороге в popup', '...(popup?.preview?.kind ? { kind: popup.preview.kind } : {}),', '', previewPrivacy, 'R233-preview-delivery-kind:', undefined, 'Фото'],
] as const) it(`R233 контрфакт превью: ${label}`, () => {
  check(source); assert.equal(source.split(from).length - 1, 1);
  assert.throws(() => check(source.replace(from, to)), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
});
