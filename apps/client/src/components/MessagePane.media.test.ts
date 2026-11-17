import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import { it, beforeEach, afterEach } from 'node:test';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { Simulate } from 'react-dom/test-utils';
import { FEATURE_LINKTHREATS1, type Attachment, type Message } from '@gusvoice/shared';
import { FED_VIA_TEXT_ONLY } from '../convSyncRules';
import type { ViteDevServer } from 'vite';
import { setupHarness, type Props } from './MessagePane.behavior.harness';

const folderPlatform = { Response, TransformStream };
const h = setupHarness(import.meta.url);

// Один основной runtime для медиа, пересылки/закрепов и федеративного UI.
// Изолированные mutant children по-прежнему принадлежат общему harness.
let fixtureRestores: (() => void)[] = [];
function rememberProperty(target: object, key: PropertyKey) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  fixtureRestores.push(() => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  });
}
function fixtureProperty<T extends object>(target: T, key: PropertyKey, descriptor: PropertyDescriptor): T {
  rememberProperty(target, key);
  return Object.defineProperty(target, key, descriptor);
}
function fixtureListener(target: EventTarget, type: string, listener: EventListener) {
  target.addEventListener(type, listener);
  fixtureRestores.push(() => target.removeEventListener(type, listener));
}
beforeEach(async () => {
  fixtureRestores = [];
  const storage = Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!;
    return [key, localStorage.getItem(key)!] as const;
  });
  fixtureRestores.push(() => {
    localStorage.clear();
    for (const [key, value] of storage) localStorage.setItem(key, value);
  });
  for (const [target, keys] of [
    [globalThis, ['fetch', 'ClipboardItem', 'IntersectionObserver', 'Blob', 'File', 'ArrayBuffer']],
    [window, ['open', 'GusVoiceMedia', '__TAURI_INTERNALS__', 'matchMedia']],
    [navigator, ['clipboard', 'userAgent']],
    [URL, ['createObjectURL', 'revokeObjectURL']],
  ] as const) for (const key of keys) rememberProperty(target, key);
  // Child мутанта создаёт только собственный runtime внутри rejectMutant.
  if (h.server) {
    const { useStore } = await h.server.ssrLoadModule('/src/store.ts') as typeof import('../store');
    const { useToasts } = await h.server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
    const store = useStore.getState(), toasts = useToasts.getState();
    fixtureRestores.push(() => { useStore.setState(store, true); useToasts.setState(toasts, true); });
  }
});
afterEach(() => {
  try { h.unmount(); }
  finally {
    // Сначала снимаем дерево, затем восстанавливаем IO, геометрию, globals и store.
    const restores = fixtureRestores.splice(0).reverse();
    for (const restore of restores) restore();
  }
});

it('счётчик прочитанного не пересекает видимую черту новых сообщений', async () => {
  // При первом визите лента может временно стоять у хвоста до прыжка к разделителю; нельзя отметить весь хвост прочитанным.
  h.round12(); let seen: number[] = [];
  const feedWindow = { hasOlder: false, hasNewer: true, unreadBelow: 0, loadNewer: async () => false, jumpLatest: async () => {},
    jumpTo: async () => true, place: null, onPlace: () => {}, readKey: 10 };
  await h.mount({ messages: [h.msg('seen-old', 'peer', 2000, 10), h.msg('seen-new', 'peer', 0, 20)], feedWindow,
    onSeen: key => { seen.push(key); }, scrollKey: 'seen-visit' });
  const list = h.host.querySelector<HTMLElement>('.messages'); const fresh = h.host.querySelector<HTMLElement>('[data-mid="seen-new"]');
  assert.ok(list, 'лента с отслеживанием прочтения доступна'); assert.ok(fresh, 'непрочитанная строка доступна');
  rememberProperty(list, 'getBoundingClientRect');
  list.getBoundingClientRect = () => new DOMRect(0, 0, 400, 600);
  rememberProperty(fresh, 'getBoundingClientRect');
  fresh.getBoundingClientRect = () => new DOMRect(0, 100, 360, 40);
  await h.flush();
  assert.ok(h.host.querySelector('.new-divider'), 'граница визита показана между старой и новой строкой');
  assert.deepEqual(seen, [], 'reportSeen не отмечает хвост, пока черта ещё управляет первым прыжком');
});

it('карточки отправителя и получателя в Windows открывают свои готовые локальные копии', async () => {
  h.round12(); h.desktop();
  fixtureProperty(navigator, 'userAgent', { configurable: true, value: 'Windows NT 10.0' });
  const opened: string[] = [];
  let finishOpening!: () => void;
  const os = new Promise<void>(resolve => { finishOpening = resolve; });
  fixtureProperty(window, '__TAURI__', { configurable: true, value: { core: {
    invoke: async (command: string, args: { path: string }) => {
      if (command !== 'gv_downloaded_file') return;
      opened.push(args.path);
      await os;
      return 'opened';
    },
  } } });
  fixtureProperty(globalThis, 'fetch', { configurable: true, value: () => assert.fail('готовое вложение не загружается') });
  const list = await h.server.ssrLoadModule('/src/downloadList.ts') as typeof import('../downloadList');
  const messages = [['own-file', 'me'], ['peer-file', 'peer']].map(([id, author]) => {
    const a: Attachment = { id, url: '/download/file', name: 'file.txt', size: 1, contentType: 'text/plain' };
    const rec = list.addDownload({ key: id, url: a.url, name: a.name, type: a.contentType, total: 1 });
    const href = `blob:${id}`;
    list.patchDownload(rec, { state: 'done', href });
    list.noteSavedFile({ url: href, path: `C:/Saved/${id}.txt` });
    fixtureRestores.push(() => list.removeDownload(rec));
    return { ...h.msg(id, author), attachments: [a] };
  });
  await h.mount({ messages });
  for (const message of messages) {
    const card = h.host.querySelector<HTMLAnchorElement>(`[data-mid="${message.id}"] .att-file`);
    assert.ok(card);
    await act(async () => { card.click(); await h.flush(); });
    assert.equal(card.getAttribute('aria-busy'), 'true');
    assert.equal(card.querySelector('.att-file-size')?.textContent, 'Открывается…');
    await act(async () => { card.click(); await h.flush(); });
  }
  await act(async () => { finishOpening(); await h.flush(); });
  assert.deepEqual(opened, ['C:/Saved/own-file.txt', 'C:/Saved/peer-file.txt']);
});

it('сигнал набора не дублируется каждым вводом, а загрузка файла имеет собственный вид действия', async () => {
  // Ловит общий throttle для разных действий и потерю признака фото у строки, загружаемой в фоне.
  h.round12(); const actions: (string | undefined)[] = [];
  const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
  const uploading = { key: 'typing-upload', convId: 'c', content: '', files: [file],
    replyToId: null, status: 'sending' as const, createdAt: h.now, attempts: 1, uploaded: [], fileNames: [], retryAt: 0, error: null };
  await h.mount({ outbox: { items: [uploading], enqueue() {}, retry() {}, discard() {} } as never, onTyping: action => actions.push(action) });
  assert.deepEqual(actions, ['photo'], 'ожидающая загрузка сообщает конкретный вид файла');
  const field = h.host.querySelector<HTMLTextAreaElement>('.composer-input'); assert.ok(field, 'поле набора доступно');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setValue.call(field, 'текст'); Simulate.change(field); await h.flush(); });
  await act(async () => { setValue.call(field, 'текст ещё'); Simulate.change(field); await h.flush(); });
  assert.deepEqual(actions, ['photo', 'typing'], 'частый ввод ограничен по typing, но не подавил отдельный upload-сигнал');
});

it('просмотр фото подтягивает старую порцию, сдвигает текущий индекс только на новые медиа и отбрасывает закрытый ответ', async () => {
  // Ловит потерю текущего фото после prepend, двойной счёт уже загруженного id и позднее обновление закрытого Lightbox.
  h.round12(); h.desktop();
  const { resetAutoDownload } = await h.server.ssrLoadModule('/src/autoDownload.ts') as typeof import('../autoDownload');
  resetAutoDownload(); // Модуль кеширует настройки между тестами; этот сценарий требует предсказуемой автозагрузки фото.
  const image = (id: string): Message => ({ ...h.msg(id, 'peer'), attachments: [{ url: `/${id}.png`, name: `${id}.png`,
    contentType: 'image/png', size: 1, width: 10, height: 10 }] } as Message);
  const current = image('media-current'); const olderText = h.msg('media-old-text', 'peer', 1000, 1);
  const olderImage = image('media-old-image');
  const requests: { dir: number; edge: string; resolve: (v: { messages: Message[]; more: boolean }) => void }[] = [];
  const loadMediaPage = (dir: -1 | 1, edge: Message) => new Promise<{ messages: Message[]; more: boolean }>(resolve => requests.push({ dir, edge: edge.id, resolve }));
  const feedWindow = { hasOlder: true, hasNewer: false, unreadBelow: 0, loadNewer: async () => false, jumpLatest: async () => {}, jumpTo: async () => true,
    place: null, onPlace: () => {}, readKey: null };
  await h.mount({ messages: [current], feedWindow, loadMediaPage });
  const photo = h.host.querySelector<HTMLElement>('[data-mid="media-current"] .att-img-link'); assert.ok(photo, 'исходное фото открывает просмотр');
  await act(async () => { photo.click(); await h.flush(); });
  assert.ok(document.querySelector('.lightbox'), 'просмотрщик открыт поверх беседы');
  await h.flush();
  assert.equal(requests.length, 1, 'достижение края запрашивает старую порцию');
  assert.deepEqual([requests[0]!.dir, requests[0]!.edge], [-1, 'media-current'], 'первая страница запрашивается относительно старейшего видимого сообщения');
  await act(async () => { requests[0]!.resolve({ messages: [olderText], more: true }); await h.flush(); });
  await h.flush();
  assert.equal(requests.length, 2, 'поиск продолжает идти через текстовую страницу до медиа');
  assert.equal(requests[1]!.edge, 'media-old-text', 'следующая страница использует новый старый край');
  await act(async () => { requests[1]!.resolve({ messages: [current, olderImage], more: true }); await h.flush(); });
  await h.flush();
  assert.match(document.querySelector('.lb-sub')?.textContent ?? '', /2 из 2/, 'дубликат current не считается, новое старое фото вставлено перед ним, индекс удерживает исходник');

  h.unmount();
  let release!: (v: { messages: Message[]; more: boolean }) => void;
  await h.mount({ messages: [current], feedWindow, loadMediaPage: () => new Promise(resolve => { release = resolve; }) });
  const again = h.host.querySelector<HTMLElement>('[data-mid="media-current"] .att-img-link'); assert.ok(again, 'контрольное фото доступно');
  await act(async () => { again.click(); await h.flush(); }); await h.flush();
  assert.ok(release, 'второй запрос страницы остаётся незавершённым');
  const close = document.querySelector<HTMLButtonElement>('.lightbox .lb-btn[title="Закрыть"]'); assert.ok(close, 'просмотрщик имеет явную кнопку закрытия');
  await act(async () => { close.click(); await h.flush(); });
  release({ messages: [olderImage], more: true }); await h.flush();
  assert.ok(!document.querySelector('.lightbox'), 'ответ после закрытия не воскрешает просмотрщик');
});

it('контекст второй ячейки альбома несёт именно её вложение; текст и телефон без моста лишены image actions', async () => {
  // В альбоме каждая ячейка должна скопировать/сохранить собственный файл, не перехватывая текст или мобильный жест.
  h.round12(); const restore = h.pointerLayout(false, 390);
  const oldFetch = globalThis.fetch;
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const itemDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
  const clickDescriptor = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'click');
  const requests: { url: string; credentials: unknown }[] = [];
  const downloads: { href: string; name: string; prevented: boolean }[] = [];
  class FakeClipboardItem { constructor(readonly content: Record<string, unknown>) {} }
  try {
    h.desktop();
    fixtureProperty(globalThis, 'ClipboardItem', { configurable: true, value: FakeClipboardItem });
    fixtureProperty(navigator, 'clipboard', { configurable: true, value: { write: async () => {} } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), credentials: init?.credentials });
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
    fixtureProperty(HTMLAnchorElement.prototype, 'click', { configurable: true, value: function (this: HTMLAnchorElement) {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      this.dispatchEvent(click);
      downloads.push({ href: this.href, name: this.download, prevented: click.defaultPrevented });
    } });
    const photo = { ...h.msg('album-actions'), content: 'caption text', attachments: [
      { url: '/files/attachments/album-first.png', name: 'first.png', contentType: 'image/png', size: 1, width: 20, height: 20 },
      { url: '/files/attachments/album-second.png', name: 'second.png', contentType: 'image/png', size: 1, width: 20, height: 20 },
    ] } as Message;
    await h.mount({ messages: [photo] });
    const cells = h.host.querySelectorAll<HTMLElement>('[data-mid="album-actions"] .att-img-link'); assert.equal(cells.length, 2, 'альбом состоит из двух отдельных целей');
    const second = cells[1]!;
    await act(async () => { second.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const copy = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Копировать изображение'));
    const save = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Сохранить как'));
    assert.ok(copy, 'ПКМ по фото предлагает копирование изображения'); assert.ok(save, 'ПКМ по фото предлагает сохранение исходного файла');
    await act(async () => { copy!.click(); await h.flush(); });
    assert.ok(requests[0]?.url.includes('album-second.png'), 'копирование запросило байты именно второй ячейки, не первой');
    assert.equal(requests[0]?.credentials, 'omit', 'публичная выдача картинки не посылает клиентские credentials');
    await act(async () => { second.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const saveAgain = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Сохранить как'));
    assert.ok(saveAgain, 'повторное открытие меню сохраняет действие для исходного изображения');
    await act(() => { saveAgain!.click(); });
    await act(async () => { await h.delay(20); });
    assert.equal(downloads[0]?.name, 'second.png', 'не подавленный пункт «Сохранить как…» сохраняет имя второй ячейки');
    assert.ok(downloads[0]?.href.includes('album-second.png'), 'запущенная загрузка ссылается на вторую ячейку альбома');
    assert.equal(downloads[0]?.prevented, false, 'клик скачивания не подавляется после закрытия photo menu');

    await act(async () => { h.host.querySelector('[data-mid="album-actions"] .message-body')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    assert.ok(!document.querySelector('.ctx-menu')?.textContent?.includes('Копировать изображение'), 'ПКМ по подписи не выдаёт картинку за цель меню');
    const paneSource = readFileSync(new URL('./MessagePane.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(paneSource, /act\.menu\(m,\s*e\.clientX,\s*e\.clientY,\s*pressByTouch\(e\.nativeEvent\)\s*===\s*true,\s*photo\)/,
      'контекст строки получает именно photo, чтобы выбрать image actions для ячейки');
    h.unmount(); h.mobile();
    await h.mount({ messages: [photo] });
    const phoneCell = h.host.querySelector<HTMLElement>('[data-mid="album-actions"] .att-img-link'); assert.ok(phoneCell, 'на телефоне остаётся обычный предпросмотр фото');
    const phoneContext = new Event('contextmenu', { bubbles: true, cancelable: true }); fixtureProperty(phoneContext, 'pointerType', { value: 'touch' });
    await act(async () => { phoneCell!.dispatchEvent(phoneContext); await h.flush(); });
    const phoneMenu = document.querySelector('.ctx-menu')?.textContent ?? '';
    assert.ok(!phoneMenu.includes('Копировать изображение') && !phoneMenu.includes('Сохранить как') && !phoneMenu.includes('Сохранить в галерею'), 'на телефоне без моста image actions не обещают неподдерживаемые действия');
  } finally {
    h.unmount();
    globalThis.fetch = oldFetch;
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor); else Reflect.deleteProperty(navigator, 'clipboard');
    if (itemDescriptor) Object.defineProperty(globalThis, 'ClipboardItem', itemDescriptor); else Reflect.deleteProperty(globalThis, 'ClipboardItem');
    if (clickDescriptor) Object.defineProperty(HTMLAnchorElement.prototype, 'click', clickDescriptor); else Reflect.deleteProperty(HTMLAnchorElement.prototype, 'click');
    h.desktop(); restore();
  }
});

it('видеовложение в ленте само играет по настройке и сохраняет корректную геометрию', async () => {
  // Подсказки отправителя временные; проверяем здесь именно передачу настройки автоплея через реальную ленту.
  h.round12(); h.desktop();
  const priorBridge = Object.getOwnPropertyDescriptor(window, 'GusVoiceMedia');
  Reflect.deleteProperty(window, 'GusVoiceMedia');
  let restoreAutoPlay: (() => void) | undefined;
  const videoAtt = { id: 'feed-video', url: '/api/att/feed-video/view/video.mp4', name: 'portrait.mp4', contentType: 'video/mp4',
    size: 1024, width: 720, height: 1280, durationMs: 2000 };
  const fileAtt = { id: 'feed-file', url: '/api/att/feed-file/view/readme.pdf', name: 'readme.pdf', contentType: 'application/pdf', size: 2048 };
  try {
    const { api } = await h.server.ssrLoadModule('/src/api.ts') as typeof import('../api');
    const autoDownload = await h.server.ssrLoadModule('/src/autoDownload.ts') as typeof import('../autoDownload');
    const previousSettings = autoDownload.getAutoDownload();
    restoreAutoPlay = () => autoDownload.setAutoDownload(previousSettings);
    const message = { ...h.msg('video-attachment'), content: '', attachments: [videoAtt, fileAtt] } as Message;
    await h.mount({ messages: [message] });
    const row = h.host.querySelector<HTMLElement>('[data-mid="video-attachment"]'); assert.ok(row, 'сообщение с видео и файлом отображено');
    const frame = row.querySelector<HTMLButtonElement>('.att-video'); assert.ok(frame, 'видео показано как кадр, а не как FileCard');
    const video = frame!.querySelector<HTMLVideoElement>('video.att-img'); assert.ok(video, 'кадр — видеоэлемент с загрузкой метаданных');
    assert.equal(video!.getAttribute('src'), videoAtt.url, 'видеолента без явной настройки играет исходный адрес без стартового seek');
    assert.equal(video!.autoplay, true, 'автовоспроизведение видео включено по умолчанию');
    assert.equal(video!.loop, true, 'автоплей в ленте повторяет видео');
    assert.equal(video!.muted, true, 'автоплей не включает звук самовольно');
    const senderRatio = video!.style.aspectRatio;
    assert.ok(senderRatio && !senderRatio.includes('auto'), 'временная пропорция видео задана явно, без авторазмера постера');
    assert.ok(senderRatio.includes('169 / 300'), `до загрузки используется портретная подсказка отправителя, ratio=${senderRatio}`);
    fixtureProperty(video, 'videoWidth', { configurable: true, value: 1920 });
    fixtureProperty(video, 'videoHeight', { configurable: true, value: 1080 });
    fixtureProperty(video, 'duration', { configurable: true, value: 12 });
    await act(async () => { video!.dispatchEvent(new Event('loadedmetadata')); await h.flush(); });
    assert.notEqual(video!.style.aspectRatio, senderRatio, 'реальный landscape frame заменил ошибочную портретную подсказку');
    assert.ok(!video!.style.aspectRatio.includes('auto'), 'после метаданных пропорция всё ещё не зависит от постера');
    assert.equal(row.querySelector('.att-dur')?.textContent, '0:12', 'длительность файла заменила sender hint 0:02');
    const card = row.querySelector<HTMLAnchorElement>('.att-file[href]'); assert.ok(card, 'вне Android нативного моста обычный файл остаётся ссылкой');
    assert.equal(card!.getAttribute('href'), api.attachmentDownloadUrl(fileAtt), 'FileCard сохраняет старую ссылку выдачи для скачивания');
    assert.equal(card!.title, 'Скачать readme.pdf', 'ссылка продолжает обещать обычное скачивание');
    await act(async () => { row.querySelector<HTMLButtonElement>('.att-video')!.click(); await h.flush(); });
    const player = document.querySelector<HTMLVideoElement>('.lightbox video.lb-video');
    assert.ok(player, 'нажатие по кадру открывает видео-плеер Lightbox');
    assert.ok(!document.querySelector('.lightbox .lb-zoom'), 'видеоплеер не завёрнут в слой масштабирования картинки');
    assert.equal(player!.getAttribute('controlslist'), 'nodownload', 'браузерный плеер скрывает встроенную загрузку');
    assert.equal(player!.getAttribute('src'), videoAtt.url, 'Lightbox играет исходную ссылку, не временный frame seek');
    await act(async () => { autoDownload.setAutoDownload({ ...previousSettings, autoplayVideo: false }); await h.flush(); });
    const pausedVideo = row.querySelector<HTMLVideoElement>('video.att-img'); assert.ok(pausedVideo);
    assert.equal(pausedVideo!.autoplay, false, 'явное выключение настройки отключает автозапуск');
    assert.match(pausedVideo!.getAttribute('src') ?? '', /video\.mp4#t=0\.1$/, 'явно выключенное видео остаётся стартовым кадром');

  } finally {
    h.unmount();
    restoreAutoPlay?.();
    if (priorBridge) Object.defineProperty(window, 'GusVoiceMedia', priorBridge); else Reflect.deleteProperty(window, 'GusVoiceMedia');
  }
});

it('скрепка на ПК открывает два выбора файлов и сохраняет fileRef первым input', async () => {
  // Разделение «Фото или видео»/«Файл» не должно перепутать accept-медиа и прежний unrestricted fileRef.
  h.round12(); const restore = h.pointerLayout(false, 1200);
  try {
    h.desktop(); await h.mount();
    const inputs = [...h.host.querySelectorAll<HTMLInputElement>('.composer input[type="file"]')];
    assert.equal(inputs.length, 2, 'в композере ровно два системных file inputs');
    assert.ok(inputs[0]!.getAttribute('accept') === null, 'первый input — прежний fileRef без media-only ограничения');
    assert.equal(inputs[1]!.getAttribute('accept'), 'image/*,video/*', 'второй input принимает только фото и видео');
    let fileClicks = 0, mediaClicks = 0;
    rememberProperty(inputs[0]!, 'click'); rememberProperty(inputs[1]!, 'click');
    inputs[0]!.click = () => { fileClicks++; };
    inputs[1]!.click = () => { mediaClicks++; };
    const attach = h.host.querySelector<HTMLButtonElement>('.att-btn.attach'); assert.ok(attach, 'кнопка-скрепка находится в форме');
    const open = async (label: string) => {
      await act(async () => { attach!.click(); await h.flush(); });
      const menuItem = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes(label));
      assert.ok(menuItem, `скрепка показывает пункт «${label}»`);
      await act(async () => { menuItem!.click(); await h.flush(); });
    };
    await open('Фото или видео');
    assert.deepEqual([mediaClicks, fileClicks], [1, 0], 'фото/видео активирует mediaRef и только его');
    await open('Файл');
    assert.deepEqual([mediaClicks, fileClicks], [1, 1], 'обычный файл активирует первый fileRef');
  } finally { h.unmount(); h.desktop(); restore(); }
});

it('MediaSheet отправляет выбранное с подписью обычным путём и беззвучным через outbox', async () => {
  // Подпись и уже загруженные байты должны пережить закрытие листа; silent обязан сохранить их в очередь, не вызвать onSend.
  h.round12();
  const restorePhoneLayout = h.pointerLayout(true, 390);
  const priorBridge = Object.getOwnPropertyDescriptor(window, 'GusVoiceMedia');
  const priorObserver = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
  const oldUa = navigator.userAgent;
  const record: { sent: { content: string; files: File[] }[]; silent: { content: string; files: File[]; silent?: boolean }[] } = { sent: [], silent: [] };
  const channel: { onmessage: ((event: MessageEvent) => void) | null; postMessage: (message: string | ArrayBuffer) => void } = {
    onmessage: null,
    postMessage(raw) {
      if (typeof raw !== 'string') return;
      const request = JSON.parse(raw) as { op: string; id: string };
      const emit = (data: string | ArrayBuffer) => queueMicrotask(() => channel.onmessage?.(new MessageEvent('message', { data })));
      const reply = (data: Record<string, unknown>) => emit(JSON.stringify({ id: request.id, ...data }));
      if (request.op === 'info') reply({ sdk: 34, perm: 'granted', camera: false, canSave: true, asked: true });
      else if (request.op === 'perm') reply({ perm: 'granted' });
      else if (request.op === 'page') reply({ items: [{ id: 'gallery-one', kind: 'image', mime: 'image/jpeg', size: 4, w: 16, h: 16, dur: 0, added: 1, name: 'picked.jpg', rot: 0 }], end: true });
      else if (request.op === 'thumb') reply({ ok: false });
      else if (request.op === 'open') {
        reply({ file: 0, name: 'picked.jpg', mime: 'image/jpeg' });
        emit(JSON.stringify({ id: request.id, bin: { file: 0 } }));
        emit(new Uint8Array([0xff, 0xd8, 0xff]).buffer);
        reply({ file: 0, name: 'picked.jpg', end: true });
        reply({ done: true });
      }
    },
  };
  class ImmediateObserver {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
    root = null;
    rootMargin = '0px';
    thresholds = [0];
  }
  const startSheet = async () => {
    const plus = h.host.querySelector<HTMLButtonElement>('.att-btn.plus'); assert.ok(plus, 'плюс открывает выбор вложений на телефоне');
    await act(async () => { plus!.click(); await h.delay(80); });
    // Нативная галерея открывается прямо из «+», а браузерный режим сначала показывает лист вложений.
    const pick = [...document.querySelectorAll<HTMLButtonElement>('.sheet-row')].find((b) => b.textContent?.includes('Фото или видео'));
    if (pick) await act(async () => { pick.click(); await h.delay(80); });
    const cell = document.querySelector<HTMLButtonElement>('.gal-cell'); assert.ok(cell, 'нативный bridge загрузил одну доступную фотографию');
    const check = cell!.querySelector<HTMLElement>('.gal-check'); assert.ok(check, 'выбор фото находится в кружке');
    await act(async () => { check.click(); await h.flush(); });
    const caption = document.querySelector<HTMLTextAreaElement>('.gal-caption textarea'); assert.ok(caption, 'после выбора появляется поле подписи');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    assert.equal(caption!.value, 'подпись к фото', 'MediaSheet получает подпись, уже набранную в основном композере');
  };
  try {
    h.mobile();
    fixtureProperty(window, 'GusVoiceMedia', { configurable: true, value: channel });
    fixtureProperty(globalThis, 'IntersectionObserver', { configurable: true, value: ImmediateObserver });
    await h.mount({ draft: { text: 'подпись к фото', replyToId: null } as never, onSend: async (content: string, files: File[]) => { record.sent.push({ content, files }); } });
    await startSheet();
    const send = document.querySelector<HTMLButtonElement>('.gal-send-btn'); assert.ok(send, 'кнопка отправки медиа видна при выбранной фотографии');
    await act(async () => { send!.click(); await h.delay(120); });
    assert.equal(record.sent.length, 1, 'обычная отправка из листа проходит через form onSend ровно один раз');
    assert.equal(record.sent[0]?.content, 'подпись к фото', 'подпись становится содержимым отправленного сообщения');
    assert.equal(record.sent[0]?.files[0]?.name, 'picked.jpg', 'файл из MediaSheet попадает в обычную отправку');
    assert.deepEqual([...new Uint8Array(await record.sent[0]!.files[0]!.arrayBuffer())], [0xff, 0xd8, 0xff], 'обычная отправка сохраняет байты изображения без подмены');
    assert.ok(!document.querySelector('.gal'), 'успешная отправка закрывает MediaSheet');
    h.unmount();

    const silentQueue = { items: [], enqueue: (item: { content: string; files: File[]; silent?: boolean }) => { record.silent.push(item); }, retry: () => {}, discard: () => {} };
    await h.mount({ outbox: silentQueue, sendMenu: { silent: true, later: false, whenOnline: false, schedule: async () => {}, scheduledCount: 0, openScheduled: () => {} },
      draft: { text: 'подпись к фото', replyToId: null } as never, onSend: async (content: string, files: File[]) => { record.sent.push({ content, files }); } });
    await startSheet();
    const silentButton = document.querySelector<HTMLButtonElement>('.gal-send-btn'); assert.ok(silentButton, 'кнопка hold-menu присутствует при выборе');
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => { silentButton!.dispatchEvent(context); await h.flush(); });
    assert.ok(document.querySelector('.gal-hold'), 'контекст/удержание открыло меню способа отправки медиа');
    await act(async () => { window.dispatchEvent(new Event('pointerup')); await h.delay(420); });
    const silentAction = [...document.querySelectorAll<HTMLButtonElement>('.gal-hold button')].find((b) => b.textContent?.includes('Отправить без звука'));
    assert.ok(silentAction, 'меню разрешает беззвучную отправку'); await act(async () => { silentAction!.click(); await h.delay(120); });
    assert.equal(record.silent.length, 1, 'silent из MediaSheet зачислился в outbox');
    assert.equal(record.silent[0]?.content, 'подпись к фото', 'беззвучная запись сохраняет подпись');
    assert.equal(record.silent[0]?.silent, true, 'outbox получает явный признак беззвучного режима');
    assert.equal(record.silent[0]?.files[0]?.name, 'picked.jpg', 'беззвучная запись сохраняет выбранный файл');
    assert.deepEqual([...new Uint8Array(await record.silent[0]!.files[0]!.arrayBuffer())], [0xff, 0xd8, 0xff], 'беззвучная запись сохраняет исходные байты изображения');
    assert.equal(record.sent.length, 1, 'sendSilent не вызывает обычный onSend');
  } finally {
    h.unmount(); h.desktop(); restorePhoneLayout();
    if (priorBridge) Object.defineProperty(window, 'GusVoiceMedia', priorBridge); else Reflect.deleteProperty(window, 'GusVoiceMedia');
    if (priorObserver) Object.defineProperty(globalThis, 'IntersectionObserver', priorObserver); else Reflect.deleteProperty(globalThis, 'IntersectionObserver');
    fixtureProperty(navigator, 'userAgent', { configurable: true, value: oldUa });
  }
});

it('conv10 разрешает расписание с файлами и не меняет тело старого текстового callback', async () => {
  // Новый capability добавляет только поле files; старый текстовый серверный контракт остаётся побайтно прежним.
  h.round12();
  const scheduled: Array<{ content: string; replyToId: string | null; at: Date | null; files?: File[] }> = [];
  const schedule = async (item: { content: string; replyToId: string | null; at: Date | null; files?: File[] }) => { scheduled.push(item); };
  const sendMenu = { silent: false, later: true, whenOnline: true, media: true, schedule, scheduledCount: 0, openScheduled: () => {} };
  const file = new File(['planned bytes'], 'planned.txt', { type: 'text/plain' });
  await h.mount({ sendMenu, draft: { text: 'текст с вложением', replyToId: null } as never });
  const input = h.host.querySelector<HTMLInputElement>('.composer input[type="file"]');
  assert.ok(input, 'старый file input всё ещё доступен для прикрепления');
  fixtureProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => { input!.dispatchEvent(new Event('change', { bubbles: true })); await h.delay(); });
  const send = h.host.querySelector<HTMLButtonElement>('.composer .send-btn'); assert.ok(send, 'вложение и текст готовы к меню');
  await act(async () => { send!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 7, clientY: 9 })); await h.delay(80); });
  const online = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(button => button.textContent?.includes('Когда будет в сети'));
  assert.ok(online && !online.disabled, 'conv10 снимает запрет на расписание с файлом');
  await act(async () => { online!.click(); await h.delay(); });
  assert.deepEqual(scheduled, [{ content: 'текст с вложением', replyToId: null, at: null, files: [file] }],
    'сценарий online передаёт текст, null-время и исходный файл');
  h.unmount();

  scheduled.length = 0;
  const legacyMenu = { silent: false, later: true, whenOnline: true, schedule, scheduledCount: 0, openScheduled: () => {} };
  await h.mount({ sendMenu: legacyMenu, draft: { text: 'только текст', replyToId: null } as never });
  const legacySend = h.host.querySelector<HTMLButtonElement>('.composer .send-btn'); assert.ok(legacySend, 'старый режим сохраняет кнопку отправки');
  await act(async () => { legacySend!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 7, clientY: 9 })); await h.delay(80); });
  const legacyOnline = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(button => button.textContent?.includes('Когда будет в сети'));
  assert.ok(legacyOnline, 'текстовый отложенный вариант остаётся доступен без conv10');
  await act(async () => { legacyOnline!.click(); await h.delay(); });
  assert.deepEqual(scheduled, [{ content: 'только текст', replyToId: null, at: null }],
    'для старого сервера поле files не добавляется даже как пустой массив');
});

it('отказ conv10 возвращает выбранный файл в поле, если поле не успели заполнить заново', async () => {
  // Тихая потеря локального File после 409/ошибки загрузки заставила бы заново выбирать его из галереи.
  h.round12();
  const sendMenu = { silent: false, later: true, whenOnline: true, media: true,
    schedule: async () => { throw new Error('scheduled_media_limit'); }, scheduledCount: 0, openScheduled: () => {} };
  const file = new File(['return bytes'], 'return-me.txt', { type: 'text/plain' });
  await h.mount({ sendMenu, draft: { text: 'подпись', replyToId: null } as never });
  const input = h.host.querySelector<HTMLInputElement>('.composer input[type="file"]'); assert.ok(input, 'поле добавления файла смонтировано');
  fixtureProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => { input!.dispatchEvent(new Event('change', { bubbles: true })); await h.delay(); });
  const send = h.host.querySelector<HTMLButtonElement>('.composer .send-btn'); assert.ok(send, 'файл можно отложить');
  await act(async () => { send!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 7, clientY: 9 })); await h.delay(80); });
  const online = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(button => button.textContent?.includes('Когда будет в сети'));
  assert.ok(online && !online.disabled, 'серверная возможность разрешила отправить файл в расписание');
  await act(async () => { online!.click(); await h.delay(80); });
  assert.ok(h.host.querySelector('.pending-atts')?.textContent?.includes('return-me.txt'), 'отказ восстановил вложение в поле');
  assert.equal(h.host.querySelector<HTMLTextAreaElement>('.composer-input')?.value, 'подпись', 'отказ восстановил исходную подпись');
  const { useToasts } = await h.server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
  const errorToast = useToasts.getState().toasts.at(-1);
  assert.equal(errorToast?.title, 'Не удалось отложить сообщение', 'ошибка сервера объяснена как отказ расписания');
  assert.equal(errorToast?.subtitle, 'scheduled_media_limit', 'тост сохраняет точную причину conv10');
});

it('onMediaSend откладывает фото и по режиму online, и по выбранному времени', async () => {
  // Меню вложений должно пройти через тот же conv10 callback, а не отправить файл немедленно или потерять подпись.
  h.round12();
  const priorBridge = Object.getOwnPropertyDescriptor(window, 'GusVoiceMedia');
  const priorObserver = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
  const oldUa = navigator.userAgent;
  const scheduled: Array<{ content: string; replyToId: string | null; at: Date | null; files?: File[] }> = [];
  const channel: { onmessage: ((event: MessageEvent) => void) | null; postMessage: (message: string | ArrayBuffer) => void } = {
    onmessage: null,
    postMessage(raw) {
      if (typeof raw !== 'string') return;
      const request = JSON.parse(raw) as { op: string; id: string };
      const emit = (data: string | ArrayBuffer) => queueMicrotask(() => channel.onmessage?.(new MessageEvent('message', { data })));
      const reply = (data: Record<string, unknown>) => emit(JSON.stringify({ id: request.id, ...data }));
      if (request.op === 'info') reply({ sdk: 34, perm: 'granted', camera: false, canSave: true, asked: true });
      else if (request.op === 'perm') reply({ perm: 'granted' });
      else if (request.op === 'page') reply({ items: [{ id: 'scheduled-photo', kind: 'image', mime: 'image/jpeg', size: 4, w: 16, h: 16, dur: 0, added: 1, name: 'scheduled.jpg', rot: 0 }], end: true });
      else if (request.op === 'thumb') reply({ ok: false });
      else if (request.op === 'open') {
        reply({ file: 0, name: 'scheduled.jpg', mime: 'image/jpeg' });
        emit(JSON.stringify({ id: request.id, bin: { file: 0 } }));
        emit(new Uint8Array([0xff, 0xd8, 0xff]).buffer);
        reply({ file: 0, name: 'scheduled.jpg', end: true });
        reply({ done: true });
      }
    },
  };
  class ImmediateObserver {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    disconnect() {} unobserve() {} takeRecords() { return []; }
    root = null; rootMargin = '0px'; thresholds = [0];
  }
  const startSheet = async () => {
    const plus = h.host.querySelector<HTMLButtonElement>('.att-btn.plus'); assert.ok(plus, 'плюс открывает лист вложений');
    await act(async () => { plus!.click(); await h.delay(80); });
    const pick = [...document.querySelectorAll<HTMLButtonElement>('.sheet-row')].find(button => button.textContent?.includes('Фото или видео'));
    if (pick) await act(async () => { pick.click(); await h.delay(80); });
    const cell = document.querySelector<HTMLButtonElement>('.gal-cell'); assert.ok(cell, 'мост показал тестовую фотографию');
    const check = cell!.querySelector<HTMLElement>('.gal-check'); assert.ok(check, 'выбор фото находится в кружке');
    await act(async () => { check.click(); await h.flush(); });
    assert.ok(document.querySelector('.gal-caption textarea'), 'фото готово к отправке с подписью');
  };
  const choose = async (label: string) => {
    const send = document.querySelector<HTMLButtonElement>('.gal-send-btn'); assert.ok(send, 'выбранное фото имеет кнопку меню');
    await act(async () => { send!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    assert.ok(document.querySelector('.gal-hold'), 'удержание открыло медиа-меню');
    await act(async () => { window.dispatchEvent(new Event('pointerup')); await h.delay(420); });
    const action = [...document.querySelectorAll<HTMLButtonElement>('.gal-hold [role="menuitem"]')].find(button => button.textContent?.includes(label));
    assert.ok(action, `доступно действие «${label}»`);
    await act(async () => { action!.click(); await h.delay(100); });
  };
  try {
    h.mobile();
    fixtureProperty(window, 'GusVoiceMedia', { configurable: true, value: channel });
    fixtureProperty(globalThis, 'IntersectionObserver', { configurable: true, value: ImmediateObserver });
    const sendMenu = { silent: false, later: true, whenOnline: true, media: true,
      schedule: async (item: { content: string; replyToId: string | null; at: Date | null; files?: File[] }) => { scheduled.push(item); },
      scheduledCount: 0, openScheduled: () => {} };
    await h.mount({ sendMenu, draft: { text: 'подпись фото', replyToId: null } as never });
    await startSheet();
    await choose('Когда будет в сети');
    assert.equal(scheduled.length, 1, 'online из MediaSheet вызвал создание отложенного ровно один раз');
    assert.equal(scheduled[0]?.content, 'подпись фото', 'online сохраняет подпись выбранной фотографии');
    assert.equal(scheduled[0]?.at, null, 'online кодируется null временем');
    assert.equal(scheduled[0]?.files?.[0]?.name, 'scheduled.jpg', 'online передал байты фото в conv10 schedule');
    assert.deepEqual([...new Uint8Array(await scheduled[0]!.files![0]!.arrayBuffer())], [255,216,255], 'online сохраняет сами байты, а не только имя файла');
    h.unmount();
    await h.mount({ sendMenu, draft: { text: 'подпись фото', replyToId: null } as never });
    await startSheet();
    await choose('Отправить позже');
    const quick = document.querySelector<HTMLButtonElement>('.sched-pick .sched-q'); assert.ok(quick, '«Отправить позже» открыло выбор времени');
    await act(async () => { quick!.click(); await h.delay(100); });
    assert.equal(scheduled.length, 2, 'выбранное время передано вторым созданием');
    assert.equal(scheduled[1]?.content, 'подпись фото', 'планирование по времени сохраняет подпись фото');
    assert.ok(scheduled[1]?.at instanceof Date && Number.isFinite(scheduled[1].at.getTime()), 'позже передаёт выбранный Date, а не null');
    assert.equal(scheduled[1]?.files?.[0]?.name, 'scheduled.jpg', 'планирование по времени тоже передаёт файл');
    assert.deepEqual([...new Uint8Array(await scheduled[1]!.files![0]!.arrayBuffer())], [255,216,255], 'выбор времени не теряет байты фото');
  } finally {
    h.unmount(); h.desktop();
    if (priorBridge) Object.defineProperty(window, 'GusVoiceMedia', priorBridge); else Reflect.deleteProperty(window, 'GusVoiceMedia');
    if (priorObserver) Object.defineProperty(globalThis, 'IntersectionObserver', priorObserver); else Reflect.deleteProperty(globalThis, 'IntersectionObserver');
    fixtureProperty(navigator, 'userAgent', { configurable: true, value: oldUa });
  }
});

it('reply и edit меняют composerHint, а высота поля зависит от той же подсказки', async () => {
  // Длинная подсказка ответа/правки должна обновлять и placeholder, и зависимость подгонки высоты поля.
  h.round12();
  const peer = h.msg('hint-peer', 'peer'); const own = h.msg('hint-own', 'me');
  await h.mount({ messages: [peer, own], placeholder: 'Сообщение для канала' });
  const input = h.host.querySelector<HTMLTextAreaElement>('.composer-input'); assert.ok(input, 'основное поле композера отрисовано');
  assert.equal(input!.placeholder, 'Сообщение для канала', 'без reply и edit используется исходная подсказка');
  const replyRow = h.host.querySelector<HTMLElement>('[data-mid="hint-peer"]'); assert.ok(replyRow, 'чужое сообщение доступно для reply');
  await act(async () => { replyRow!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const replyAction = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Ответить'));
  assert.ok(replyAction, 'контекстное меню чужого сообщения предлагает reply'); await act(async () => { replyAction!.click(); await h.flush(); });
  assert.equal(input!.placeholder, 'Ответ peer…', 'reply задаёт имя адресата в подсказке поля');
  h.unmount();
  const restorePointer = h.pointerLayout(true, 390); h.mobile(); h.round12();
  try {
  await h.mount({ bubbles: true, messages: [own], placeholder: 'Сообщение для канала' });
  const editInput = h.host.querySelector<HTMLTextAreaElement>('.composer-input'); assert.ok(editInput, 'новый композер доступен для проверки edit без активного reply');
  const ownRow = h.host.querySelector<HTMLElement>('[data-mid="hint-own"]'); assert.ok(ownRow, 'своё сообщение доступно для edit');
  await act(async () => { ownRow!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const editAction = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Изменить'));
  assert.ok(editAction, 'контекстное меню своего сообщения предлагает edit'); await act(async () => { editAction!.click(); await h.flush(); });
  assert.equal(editInput!.placeholder, 'Текст сообщения', 'во время edit подсказка соответствует тексту правки');
  const source = readFileSync(new URL('./MessagePane.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /useLayoutEffect\(fitComposer,\s*\[text,\s*composerHint\]\)/, 'подгонка высоты перезапускается при смене текста или подсказки');
  assert.match(source, /placeholder=\{composerHint\}/, 'textarea получает вычисленную общую подсказку, а не отдельные ветки');
  } finally { h.unmount(); h.desktop(); restorePointer(); }
});

it('полоса ответа и правки сохраняет подпись фото, а канал показывает текст цитаты', async () => {
  // Полосы над полем и цитата канала должны брать смысл из вложения/цитируемого сообщения, а не подменять его заглушкой.
  h.round12();
  const photo = { ...h.msg('photo-strip'), content: 'подпись к фото', attachments: [
    { url: '/strip.jpg', name: 'strip.jpg', contentType: 'image/jpeg', size: 1, width: 10, height: 10 },
  ] } as Message;
  await h.mount({ bubbles: false, messages: [photo] });
  const row = h.host.querySelector<HTMLElement>('[data-mid="photo-strip"]'); assert.ok(row, 'канальная фотография видна для ответа');
  await act(async () => { row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const reply = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Ответить'));
  assert.ok(reply, 'канальное меню предлагает ответ'); await act(async () => { reply!.click(); await h.flush(); });
  assert.equal(h.host.querySelector('.reply-strip .rs-text')?.textContent, 'подпись к фото', 'полоса ответа сохраняет подпись, а не техническую заглушку');
  assert.ok(h.host.querySelector('.reply-strip .rs-thumb'), 'для фото в полосе ответа есть миниатюра вместо лишнего текстового префикса');
  h.unmount();
  const restore = h.pointerLayout(true, 390); h.mobile();
  try {
  await h.mount({ messages: [photo] });
  const dmRow = h.host.querySelector<HTMLElement>('[data-mid="photo-strip"]'); assert.ok(dmRow, 'личный пузырь того же фото доступен для правки');
  await act(async () => { dmRow!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const edit = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Изменить'));
  assert.ok(edit, 'собственное фото разрешено редактировать'); await act(async () => { edit!.click(); await h.flush(); });
  assert.equal(h.host.querySelector('.edit-strip .rs-text')?.textContent, 'подпись к фото', 'полоса правки сохраняет подпись фото');
  assert.ok(h.host.querySelector('.edit-strip .rs-thumb'), 'полоса правки отличает фото миниатюрой');
  } finally { h.unmount(); h.desktop(); restore(); }
  const channelQuote = { ...h.msg('channel-cites'), replyTo: { id: 'source', authorName: 'Peer', content: 'текст источника' } } as Message;
  await h.mount({ bubbles: false, messages: [channelQuote] });
  assert.match(h.host.querySelector('[data-mid="channel-cites"] .reply-quote')?.textContent ?? '', /Peer.*текст источника/, 'цитата в канале сохраняет имя автора и исходный текст');
});

h.mutantTest('мутант без подавления клика после мышиного удержания открывает строку повторно', async () => {
  // Иначе отпускание после 400 мс одновременно выбирает строку и активирует её действие (например, фото/меню).
  await h.rejectMutant((source) => source.replace('if (released && g.on) swallowNextClick();', 'if (released && g.on) { /* mutant */ }'), async (component) => {
    h.round12(); const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
    await h.mount({ messages: [h.msg('swallow-mouse')], batch }, component);
    const row = h.host.querySelector<HTMLElement>('[data-mid="swallow-mouse"]'); assert.ok(row, 'есть строка рядом с пузырём для удержания');
    const main = row.querySelector<HTMLElement>('.message-main'); assert.ok(main, 'пузырь остаётся целью синтетического клика отпускания');
    const dispatch = (type: string, target: Element, props: Record<string, unknown> = {}) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      for (const [key, value] of Object.entries({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: 30, clientY: 30, ...props })) Object.defineProperty(event, key, { value });
      target.dispatchEvent(event); return event;
    };
    await act(async () => { dispatch('pointerdown', row!); await h.delay(420); dispatch('pointerup', window as unknown as Element); await h.flush(); });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { main!.dispatchEvent(click); await h.flush(); });
    assert.equal(h.host.querySelector('[data-mid="swallow-mouse"]')?.getAttribute('aria-checked'), 'true', 'клик отпускания не снимает строку, уже выбранную удержанием');
  });
});

h.mutantTest('мутант без проверки принадлежности ленте начинает выделение из портала ссылки', async () => {
  // Портал предупреждения визуально поверх ленты, но его кнопки не являются точками начала drag сообщений.
  await h.rejectMutant((source) => source.replace('if (!list.contains(t)) return;', '/* mutant: portal is not a list target */'), async (component) => {
    h.round12(); const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
    await h.mount({ messages: [{ ...h.msg('portal-link'), content: 'https://user@outside.example/path' } as Message], batch }, component);
    const link = h.host.querySelector<HTMLAnchorElement>('[data-mid="portal-link"] a'); assert.ok(link, 'в сообщении отрисована ссылка');
    await act(async () => { link!.click(); await h.flush(); });
    const dialog = document.querySelector<HTMLElement>('.link-confirm'); assert.ok(dialog, 'клик открыл предупреждение в портале');
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => { dialog!.dispatchEvent(context); await h.flush(); });
    assert.equal(context.defaultPrevented, false, 'правый клик по окну-порталу не открывает меню сообщения позади него');
    assert.ok(!document.querySelector('.ctx-menu'), 'портал остаётся отдельной целью от строки родителя');
    const down = new Event('pointerdown', { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ pointerId: 9, pointerType: 'mouse', button: 0, clientX: 40, clientY: 40 })) Object.defineProperty(down, key, { value });
    await act(async () => { dialog!.dispatchEvent(down); await h.flush(); });
    assert.ok(!document.documentElement.classList.contains('gv-sel-drag'), 'портальная кнопка не активирует режим протяжки в ленте');
  });
});

it('долгое touch contextmenu открывает меню с выбором, мышиный contextmenu тоже остаётся меню', async () => {
  // Android WebView может послать contextmenu до нашего таймера: путь должен открыть ту же карточку, без прежнего автовыбора.
  const restore = h.pointerLayout(true, 390);
  try {
    h.mobile(); h.round12();
    const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
    await h.mount({ messages: [h.msg('touch-context')], batch });
    const row = h.host.querySelector<HTMLElement>('[data-mid="touch-context"]'); assert.ok(row, 'строка доступна для длинного касания');
    await act(async () => { h.touch(row!, 'touchstart', 40, 40); await h.delay(400); });
    const context = new Event('contextmenu', { bubbles: true, cancelable: true });
    fixtureProperty(context, 'pointerType', { value: 'touch' });
    await act(async () => { row!.dispatchEvent(context); await h.flush(); });
    assert.equal(h.host.querySelector('.sel-head') === null, true, 'touch contextmenu не включает прежний автовыбор');
    assert.equal(document.querySelector('.ctx-menu') !== null, true, 'касательный contextmenu открывает карточку');
    await act(async () => { h.touch(row!, 'touchcancel', 40, 40); await h.flush(); });
    assert.equal(document.querySelector('.ctx-menu') !== null, true, 'отмена касания очищает жест, но сохраняет меню');
    const select = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(b => b.textContent?.trim() === 'Выбрать');
    assert.ok(select, 'карточка предлагает выбрать сообщение');
    await act(async () => { await h.delay(450); select.click(); await h.flush(); });
    assert.equal(h.host.querySelector('.sel-head') !== null, true, 'команда меню включает выбор');
    assert.equal(row.getAttribute('aria-checked'), 'true', 'выбрано сообщение, чей contextmenu открыт');
    h.unmount(); h.desktop();
    await h.mount({ messages: [h.msg('mouse-context')] });
    const mouseRow = h.host.querySelector<HTMLElement>('[data-mid="mouse-context"]'); assert.ok(mouseRow, 'мышиная строка доступна');
    await act(async () => { mouseRow!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    assert.ok(document.querySelector('.ctx-menu'), 'мышиный contextmenu по-прежнему открывает меню');
  } finally {
    const row = h.host.querySelector('[data-mid="touch-context"]');
    if (row) await act(async () => { h.touch(row, 'touchcancel', 40, 40); });
    if (h.root) h.unmount();
    h.desktop(); restore();
  }
});

h.mutantTest('мутант переносит Array.from(FileList) в отложенное обновление', async () => {
  // Два change в одном React batch откладывают updater; второй живой список очистится до его исполнения.
  await h.rejectMutant((source) => source.replace(
    'const files = Array.from(list);\n    setPending((p) => [...p, ...files].slice(0, 10));',
    'setPending((p) => [...p, ...Array.from(list)].slice(0, 10));',
  ), async (component) => {
    h.round12(); await h.mount({}, component);
    const input = h.host.querySelector<HTMLInputElement>('.composer input[type="file"]'); assert.ok(input, 'поле выбора файлов в форме есть');
    const first = new File(['first'], 'first.txt', { type: 'text/plain' });
    const second = new File(['second'], 'second.txt', { type: 'text/plain' });
    let selected = true;
    const liveList = { get length() { return selected ? 1 : 0; }, [Symbol.iterator]: function* () { if (selected) yield second; } };
    let currentFiles: unknown = [first];
    fixtureProperty(input, 'files', { configurable: true, get: () => currentFiles });
    fixtureProperty(input, 'value', { configurable: true, get: () => selected ? 'C:\\fakepath\\file.txt' : '', set: (value: string) => { if (!value) selected = false; } });
    await act(async () => {
      input!.dispatchEvent(new Event('change', { bubbles: true }));
      currentFiles = liveList; selected = true;
      input!.dispatchEvent(new Event('change', { bubbles: true }));
      await h.flush();
    });
    const preview = h.host.querySelector<HTMLElement>('.pending-atts'); assert.ok(preview, 'обе пачки дошли до предпросмотра');
    assert.match(preview!.textContent ?? '', /first\.txt/, 'первое вложение пережило повторное изменение input');
    assert.match(preview!.textContent ?? '', /second\.txt/, 'живой FileList скопирован до синхронной очистки input');
  });
});

it('после выбора файла курсор возвращается в поле, а удержание send не гасит его selection', async () => {
  // Выбор вложения и долгий тап по отправке должны сохранять клавиатурный фокус и каретку для подписи.
  h.round12(); const restore = h.pointerLayout(false, 390);
  let savedSelection: Selection | null = null;
  let savedRemove: PropertyDescriptor | undefined;
  try {
    h.desktop();
    const sendMenu = { silent: true, later: true, whenOnline: true, schedule: async () => {}, scheduledCount: 0, openScheduled: () => {} };
    await h.mount({ sendMenu, draft: { text: 'caption', replyToId: null } as never });
    const input = h.host.querySelector<HTMLInputElement>('.composer input[type="file"]'); assert.ok(input, 'поле выбора вложений находится в форме');
    const file = new File(['data'], 'caption.txt', { type: 'text/plain' });
    fixtureProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => { input!.dispatchEvent(new Event('change', { bubbles: true })); await h.flush(); });
    const composer = h.host.querySelector<HTMLTextAreaElement>('.composer textarea'); assert.ok(composer, 'поле подписи доступно после добавления файла');
    assert.ok(document.activeElement === composer, 'обработчик выбора вложения возвращает фокус в composer');
    const selection = window.getSelection(); assert.ok(selection, 'окно выбора текста доступно для контроля побочного эффекта');
    savedSelection = selection;
    savedRemove = Object.getOwnPropertyDescriptor(selection!, 'removeAllRanges');
    const removeAll = selection!.removeAllRanges.bind(selection);
    let cleared = 0;
    selection!.removeAllRanges = () => { cleared++; removeAll(); };
    const send = h.host.querySelector<HTMLButtonElement>('.send-btn'); assert.ok(send, 'кнопка отправки присутствует');
    await act(async () => { h.touch(send!, 'touchstart', 15, 15); await h.delay(510); h.touch(send!, 'touchend'); await h.flush(); });
    assert.ok(document.querySelector('.ctx-menu'), 'удержание открыло меню отправки');
    assert.equal(cleared, 0, 'удержание при активном поле не вызывает removeAllRanges и не прячет клавиатуру');
    // Браузер может завершить касание синтетическим click. HappyDOM сам его не создаёт:
    // незавершённый guard иначе глотал первый клик следующего теста ещё 400 мс после unmount.
    const ghostClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { send.dispatchEvent(ghostClick); await h.flush(); });
    assert.equal(ghostClick.defaultPrevented, true, 'эхо долгого касания поглощено до кнопки и меню');
    assert.ok(document.querySelector('.ctx-menu'), 'эхо касания не закрывает открытое меню отправки');
    h.unmount();
    restore(); const restoreCoarse = h.pointerLayout(true, 390);
    try {
      h.round12(); await h.mount();
      const phoneInput = h.host.querySelector<HTMLInputElement>('.composer input[type="file"]'); assert.ok(phoneInput, 'телефонный input вложений доступен');
      fixtureProperty(phoneInput, 'files', { configurable: true, value: [file] });
      await act(async () => { phoneInput!.dispatchEvent(new Event('change', { bubbles: true })); await h.flush(); });
      const phoneComposer = h.host.querySelector<HTMLTextAreaElement>('.composer textarea'); assert.ok(phoneComposer, 'телефонный composer сохранён после выбора');
      assert.ok(document.activeElement !== phoneComposer, 'на телефоне выбор файла не принудительно поднимает клавиатуру');
    } finally { h.unmount(); restoreCoarse(); }
  } finally {
    h.unmount();
    if (savedSelection) {
      if (savedRemove) Object.defineProperty(savedSelection, 'removeAllRanges', savedRemove);
      else Reflect.deleteProperty(savedSelection, 'removeAllRanges');
    }
    h.desktop(); restore();
  }
});
it('ПК-меню скрепки не отменяет активацию обоих системных полей выбора', async () => {
  // Предыдущий сценарий мог оборваться с портальным меню или guard синтетического клика.
  if (h.root) h.unmount();
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await h.delay(450); });
  h.desktop(); h.round12(); await h.mount();
  const openFor = async (label: string, selector: string) => {
    const attach = h.host.querySelector<HTMLButtonElement>('.att-btn.attach'); assert.ok(attach, 'кнопка скрепки доступна');
    await act(async () => { attach.click(); await h.flush(); });
    const item = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu .ctx-item')].find((b) => b.textContent?.includes(label));
    assert.ok(item, `меню предлагает «${label}»`);
    const input = h.host.querySelector<HTMLInputElement>(selector); assert.ok(input, `есть поле ${selector}`);
    let clicks = 0; let delivered = 0; const events: MouseEvent[] = [];
    fixtureListener(input, 'click', (event) => { delivered++; events.push(event as MouseEvent); });
    rememberProperty(input, 'click');
    input.click = () => {
      clicks++;
      input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    };
    await act(async () => { item.click(); await h.flush(); });
    assert.equal(clicks, 1, `«${label}» синхронно активировал системное поле`);
    assert.equal(delivered, 1, `click действительно дошёл до ${label} input`);
    assert.equal(events[0]?.defaultPrevented, false, `click по полю для «${label}» не отменён меню`);
    assert.equal(!!document.querySelector('.ctx-menu'), false, 'выбор закрыл меню после активации');
  };
  await openFor('Фото или видео', 'input[accept="image/*,video/*"]');
  await openFor('Файл', '.composer input[type="file"]');
});

it('привязанное send-меню следует за кнопкой, не крадёт фокус у касания и закрывается без якоря', async () => {
  // При выезде клавиатуры меню должно следовать за composer; палец сохраняет фокус, а удалённая кнопка не оставляет сироту.
  h.round12(); const restore = h.pointerLayout(false, 390);
  try {
    const sendMenu = { silent: true, later: true, whenOnline: true, schedule: async () => {}, scheduledCount: 0, openScheduled: () => {} };
    await h.mount({ sendMenu, draft: { text: 'есть текст', replyToId: null } as never });
    const button = h.host.querySelector<HTMLButtonElement>('.send-btn'); assert.ok(button, 'кнопка отправки — якорь меню');
    const composer = h.host.querySelector<HTMLElement>('.composer'); assert.ok(composer, 'полоса composer задаёт подсветку якоря');
    let top = 80;
    fixtureProperty(button, 'getBoundingClientRect', { configurable: true, value: () => ({ top, bottom: top + 30, left: 320, right: 360, width: 40, height: 30, x: 320, y: top, toJSON() {} }) });
    fixtureProperty(composer, 'getBoundingClientRect', { configurable: true, value: () => ({ top: top - 20, bottom: top + 35, left: 0, right: 380, width: 380, height: 55, x: 0, y: top - 20, toJSON() {} }) });
    const open = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
    await act(async () => { button!.dispatchEvent(open); await h.flush(); });
    assert.ok(document.querySelector('.ctx-stack.anchored'), 'на узкой ширине меню стоит у кнопки, а не в старой точке');
    const topSpot = document.querySelector<HTMLElement>('.ctx-spot.top'); assert.ok(topSpot, 'подложка хранит видимую полосу composer');
    assert.equal(topSpot!.style.height, '60px', 'начальная подсветка начинается с верхнего края composer');
    const menu = document.querySelector<HTMLElement>('.ctx-menu'); assert.ok(menu, 'карточка меню доступна для нажатия');
    const pointer = (pointerType: 'mouse' | 'touch') => {
      const e = new Event('pointerdown', { bubbles: true, cancelable: true });
      for (const [key, value] of Object.entries({ pointerType, pointerId: 23, button: 0 })) Object.defineProperty(e, key, { value });
      menu!.dispatchEvent(e); return e;
    };
    assert.equal(pointer('mouse').defaultPrevented, false, 'мышиное нажатие следует обычной модели фокуса');
    assert.equal(pointer('touch').defaultPrevented, true, 'палец на меню не переводит фокус и не скрывает клавиатуру');
    top = 170;
    await act(async () => { window.dispatchEvent(new Event('resize')); await h.delay(80); });
    assert.equal(document.querySelector<HTMLElement>('.ctx-spot.top')?.style.height, '150px', 'после resize полоса следует за новой геометрией кнопки');
    button!.remove();
    await act(async () => { window.dispatchEvent(new Event('resize')); await h.delay(80); });
    assert.ok(!document.querySelector('.ctx-stack'), 'после удаления кнопки якорное меню закрывается');
  } finally { h.unmount(); h.desktop(); restore(); }
});

it('своё исходящее сбрасывает черту непрочитанного только в текущем визите', async () => {
  // Отправка и моё сообщение, пришедшее снизу, закрывают unread; другой scrollKey начинает визит заново.
  h.round12();
  const old = { ...h.msg('before-unread', 'peer', 30_000), createdAt: new Date(h.now - 30_000).toISOString() };
  const unread = { ...h.msg('after-unread', 'peer', 0), createdAt: new Date(h.now).toISOString() };
  await h.mount({ messages: [old, unread], newSince: h.now - 15_000, scrollKey: 'visit-a', draft: { text: 'отправка', replyToId: null } as never });
  assert.ok(h.host.querySelector('.new-divider'), 'до собственного действия разделитель новых сообщений показан');
  await act(async () => { h.host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await h.flush(); });
  assert.ok(!h.host.querySelector('.new-divider'), 'обычная отправка закрывает границу прочитанного визита');
  await h.rerender({ scrollKey: 'visit-b', messages: [old, unread], newSince: h.now - 15_000 });
  assert.ok(h.host.querySelector('.new-divider'), 'новый scrollKey снова показывает черту непрочитанного');
  await h.rerender({ messages: [old, unread, h.msg('mine-arrived', 'me', 0)], newSince: h.now - 15_000, scrollKey: 'visit-b' });
  assert.ok(!h.host.querySelector('.new-divider'), 'моё новое сообщение снизу тоже сбрасывает черту');
});

it('отказ отправки показывает неотправленную строку у низа ленты', async () => {
  // Статус ошибки не должен оставаться под композером, пока пользователь не замечает его через долгое время.
  h.round12();
  await h.mount({ draft: { text: 'ошибка сети', replyToId: null } as never, onSend: async () => { throw new Error('offline'); } });
  const list = h.host.querySelector<HTMLElement>('.messages'); assert.ok(list, 'лента отправки измерима');
  let scrollTop = 100;
  fixtureProperty(list, 'scrollHeight', { configurable: true, get: () => 2000 });
  fixtureProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
  fixtureProperty(list, 'clientHeight', { configurable: true, get: () => 600 });
  await act(async () => { h.host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await h.delay(80); });
  assert.ok(h.host.querySelector('.bub-fail'), 'ошибка оставляет строку с возможностью повтора');
  assert.equal(scrollTop, 2000, 'переход в failed удерживает читателя у самого низа');
});

it('вход в выделение удерживает строку под мышью и добавляет spacer у жёсткого низа', async () => {
  // Появившаяся шапка выделения двигает ленту; на нижнем пределе недостающее место даёт spacer, не новая строка под курсором.
  h.round12(); const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
  await h.mount({ messages: [h.msg('anchor-select')], batch });
  const list = h.host.querySelector<HTMLElement>('.messages'); assert.ok(list, 'лента доступна для измерения прокрутки');
  const row = h.host.querySelector<HTMLElement>('[data-mid="anchor-select"]'); assert.ok(row, 'строка закрепления якоря отрисована');
  const pad = h.host.querySelector<HTMLElement>('.messages > :last-child'); assert.ok(pad, 'последний элемент ленты существует для измерения spacer');
  let scrollTop = 390;
  fixtureProperty(list, 'clientHeight', { configurable: true, get: () => 600 });
  fixtureProperty(list, 'scrollHeight', { configurable: true, get: () => 1000 + (Number.parseFloat(h.host.querySelector<HTMLElement>('.messages > :last-child')?.style.height ?? '') || 0) });
  fixtureProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (next: number) => { scrollTop = Math.min(next, list!.scrollHeight - list!.clientHeight); } });
  const rowTop = () => 200 + (h.host.querySelector('.messages')?.classList.contains('sel-mode') ? 40 : 0) - (scrollTop - 390);
  fixtureProperty(row, 'getBoundingClientRect', { configurable: true, value: () => ({ top: rowTop(), bottom: rowTop() + 40, left: 0, right: 320, width: 320, height: 40, x: 0, y: rowTop(), toJSON() {} }) });
  // Выбранное сообщение входит через обычное меню строки — именно этот путь запоминает её исходный экранный top.
  await act(async () => { row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const select = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Выделить'));
  assert.ok(select, 'контекстное меню предлагает переход в выделение');
  await act(async () => { select!.click(); await h.flush(); });
  assert.ok(h.host.querySelector('.sel-head'), 'выбор действительно добавил шапку, изменившую геометрию');
  assert.equal(rowTop(), 200, 'якорная строка остаётся на прежнем экранном y даже у нижней границы');
  assert.equal(scrollTop, 430, 'вместо прокручивания за конец ленты добавлен недостающий ход');
  assert.equal(Number.parseFloat(h.host.querySelector<HTMLElement>('.messages > :last-child')?.style.height ?? ''), 30, 'нижний spacer ровно компенсирует ограничение прокрутки');
  await act(async () => { row!.click(); await h.flush(); });
  assert.ok(!h.host.querySelector('.sel-head'), 'снятие последней строки выходит из выделения');
  assert.equal(h.host.querySelector<HTMLElement>('.messages > :last-child')?.style.height ?? '', '', 'временный spacer убирается после выхода из режима');
});

// Альбомные действия используют тот же runtime и общий cleanup жестов, что и медиа выше.
type AlbumItemPane = typeof h.Pane;
type AlbumItemScene = {
  kind?: 'photo' | 'video'; entry?: 'viewer' | 'cell'; action?: 'forward' | 'delete';
  enabled?: boolean; phone?: boolean; cancel?: boolean; own?: boolean; scope?: 'me' | 'both';
};

async function albumItemScene(component: AlbumItemPane, confirm: typeof h.ConfirmHost, runtime: ViteDevServer, options: AlbumItemScene = {}) {
  const { kind = 'photo', entry = 'viewer', action = 'delete', enabled = true, phone = false,
    cancel = false, own = false, scope = 'me' } = options;
  const { useStore } = await runtime.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const priorStore = useStore.getState();
  const { useConfirmDialog } = await runtime.ssrLoadModule('/src/confirm.ts') as typeof import('../confirm');
  const rememberedDelete = localStorage.getItem('gv_delete_only_me');
  const first: Attachment = { id: 'photo-first', url: '/photo-first.png', name: 'photo-first.png', contentType: 'image/png', size: 20, width: 100, height: 80 };
  const selected: Attachment = { id: 'selected-item', url: kind === 'photo' ? '/photo-selected.png' : '/video-selected.mp4',
    name: kind === 'photo' ? 'photo-selected.png' : 'video-selected.mp4', contentType: kind === 'photo' ? 'image/png' : 'video/mp4',
    size: 20, width: 100, height: 80 };
  const message = { ...h.msg('album-message', own ? 'me' : 'peer'), content: 'Подпись альбома', attachments: [first, selected] } as Message;
  const itemCalls: unknown[][] = [], wholeCalls: unknown[][] = [];
  const batch: NonNullable<Props['batch']> = {
    forward: async (...args) => { wholeCalls.push(['forward', ...args]); },
    deleteMany: async (...args) => { wholeCalls.push(['deleteMany', ...args]); },
    ...(enabled ? {
      forwardItem: async (...args: Parameters<NonNullable<NonNullable<Props['batch']>['forwardItem']>>) => { itemCalls.push(['forward', ...args]); },
      deleteItem: async (...args: Parameters<NonNullable<NonNullable<Props['batch']>['deleteItem']>>) => { itemCalls.push(['delete', ...args]); },
    } : {}),
    peerName: () => 'Адресат', open: () => {},
  };
  const props: Partial<Props> = { messages: [message], batch, deletePeerName: 'Собеседник',
    onDelete: async (m, forWhom) => { wholeCalls.push(['delete', m.id, forWhom]); } };
  const restoreLayout = h.pointerLayout(phone, phone ? 390 : 1200);
  try {
    if (phone) h.mobile(); else h.desktop();
    localStorage.removeItem('gv_delete_only_me');
    useStore.setState({ dms: [{ id: 'target', otherUser: { id: 'recipient', username: 'recipient', displayName: 'Адресат', avatarUrl: null },
      createdAt: new Date(h.now).toISOString(), lastMessageAt: null, unread: 0 }] as never });
    await h.mountWithConfirm(props, component, confirm);
    const media = h.host.querySelector<HTMLElement>(`[data-mid="album-message"] .att-img-link ${kind === 'photo' ? 'img' : 'video'}[src="${selected.url}"]`);
    assert.ok(media, 'выбрана вторая настоящая ячейка, не первая фотография по умолчанию');
    const anchor = media.closest<HTMLElement>('.att-img-link');
    assert.ok(anchor, 'медиа находится внутри настоящей ячейки альбома');
    if (entry === 'viewer') {
      await act(async () => { anchor.click(); await h.flush(); });
      assert.ok(document.querySelector('.lightbox'), 'настоящий просмотрщик открыл выбранный элемент');
      const showing = document.querySelector<HTMLImageElement | HTMLVideoElement>(`.lightbox ${kind === 'photo' ? '.lb-img' : '.lb-video'}`);
      assert.equal(showing?.getAttribute('src'), selected.url, 'просмотрщик показывает именно выбранный элемент');
      const more = document.querySelector<HTMLButtonElement>('.lightbox button[title="Ещё"]');
      assert.ok(more, 'просмотрщик имеет настоящее меню действий');
      await act(async () => { more.click(); });
    } else {
      await act(async () => { media.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })); });
    }
    const noun = kind === 'photo' ? 'фото' : 'видео';
    const itemAction = enabled && (entry === 'viewer' || !phone);
    const label = action === 'delete' ? 'Удалить' : 'Переслать';
    const menu = entry === 'viewer' ? '.lb-menu' : '.ctx-menu';
    const labels = [...document.querySelectorAll<HTMLButtonElement>(`${menu} button`)].map(button => button.textContent?.trim());
    const expectedLabel = entry === 'cell' && itemAction ? `${label} ${noun}` : label;
    assert.equal(labels.includes(expectedLabel), true, 'G56-menu: пункт меню различает выбранную ячейку и сообщение целиком');
    assert.equal(labels.includes(`${label} ${noun}`), entry === 'cell' && itemAction,
      'G56-menu: телефон и старый сервер не получают подписи действия одной ячейки');
    const button = [...document.querySelectorAll<HTMLButtonElement>(`${menu} button`)].find(node => node.textContent?.trim() === expectedLabel);
    assert.ok(button, 'настоящий пункт найден для нажатия');
    await act(async () => { button.click(); await h.flush(); });
    if (action === 'delete') {
      const pending = useConfirmDialog.getState().pending;
      assert.ok(pending, 'удаление сначала открыло настоящее подтверждение');
      assert.equal(itemCalls.length + wholeCalls.length, 0, 'до подтверждения никакое удаление не вызывается');
      if (itemAction) assert.equal(pending.title, own ? `Удалить ${noun}?` : `Удалить ${noun} у себя?`,
        'G56-delete-title: подтверждение относится к выбранному элементу');
      if (own && itemAction && scope === 'both') {
        const check = document.querySelector<HTMLInputElement>('.confirm-option input');
        assert.ok(check, 'своё медиа предлагает область у обоих');
        if (!check.checked) await act(async () => { check.click(); });
      }
      await act(async () => { useConfirmDialog.getState().answer(!cancel); await h.flush(); });
      const wanted = cancel ? [] : itemAction ? [['delete', 'album-message', 'selected-item', own ? scope : 'me']] : [];
      assert.equal(JSON.stringify(itemCalls), JSON.stringify(wanted), 'G56-delete: callback удаляет только выбранный attachmentId и область');
      assert.equal(wholeCalls.length, cancel || itemAction ? 0 : 1, 'G56-delete-whole: старый сервер вызывает прежнее удаление сообщения');
      if (!cancel && !itemAction) assert.equal(wholeCalls[0]?.[1], 'album-message');
    } else {
      assert.equal(!!document.querySelector('.lightbox'), false, 'пересылка закрывает просмотр перед выбором адресата');
      const target = [...document.querySelectorAll<HTMLButtonElement>('.fwd-pick .dm-row, .fwd-pick .fwd-cell')]
        .find(node => node.textContent?.includes('Адресат'));
      assert.ok(target, 'настоящий ForwardPicker содержит адресата');
      // У одного элемента нет onDraft: picker сразу в selecting и onMenu не назначен. В режиме черновика
      // целого сообщения ПКМ включает выбор, а в готовом selecting галочку ставит обычный click.
      // Читаем настоящий режим из DOM, а не из itemAction: мутант, теряющий attachmentId, меняет и режим picker.
      await act(async () => {
        if (target.getAttribute('role') === 'checkbox') target.click();
        else target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
      });
      const send = document.querySelector<HTMLButtonElement>('.fwd-send');
      assert.ok(send && !send.disabled, 'отмеченный адресат разрешает отправку');
      await act(async () => { send.click(); await h.flush(); });
      const wanted = itemAction ? [['forward', 'album-message', 'selected-item', 'target', false, { hideSender: false }]] : [];
      assert.equal(JSON.stringify(itemCalls), JSON.stringify(wanted), 'G56-forward: callback пересылает только выбранный attachmentId выбранному адресату');
      assert.equal(wholeCalls.length, itemAction ? 0 : 1, 'G56-forward-whole: старый сервер пересылает сообщение целиком');
      if (!itemAction) assert.equal(JSON.stringify(wholeCalls[0]?.[1]), '["album-message"]');
    }
  } finally {
    // Даже ошибка уборки дерева не должна оставить глобальные настройки следующему сценарию.
    try {
      try { useConfirmDialog.getState().answer(false); }
      finally { h.unmount(); }
    } finally {
      try { useStore.setState(priorStore, true); }
      finally {
        if (rememberedDelete === null) localStorage.removeItem('gv_delete_only_me'); else localStorage.setItem('gv_delete_only_me', rememberedDelete);
        restoreLayout(); h.desktop();
      }
    }
  }
}

for (const kind of ['photo', 'video'] as const) for (const action of ['delete', 'forward'] as const)
  it(`R213 просмотрщик ${kind === 'photo' ? 'фото' : 'видео'} ${action === 'delete' ? 'удаляет' : 'пересылает'} только второй элемент альбома`,
    () => albumItemScene(h.Pane, h.ConfirmHost, h.server, { kind, action }));
for (const action of ['delete', 'forward'] as const)
  it(`R213 ПКМ по фото на ПК предлагает ${action === 'delete' ? '«Удалить фото»' : '«Переслать фото»'} и действует на эту ячейку`,
    () => albumItemScene(h.Pane, h.ConfirmHost, h.server, { action, entry: 'cell' }));
it('R213 удаление своего элемента передаёт выбранную область у обоих',
  () => albumItemScene(h.Pane, h.ConfirmHost, h.server, { own: true, scope: 'both' }));
it('R213 отмена удаления не вызывает ни новый callback, ни прежнее удаление сообщения',
  () => albumItemScene(h.Pane, h.ConfirmHost, h.server, { cancel: true }));
for (const entry of ['viewer', 'cell'] as const) for (const action of ['delete', 'forward'] as const)
  it(`R213 без album1 ${entry === 'viewer' ? 'просмотрщик' : 'ПКМ ячейки'} сохраняет ${action === 'delete' ? 'удаление' : 'пересылку'} целого сообщения`,
    () => albumItemScene(h.Pane, h.ConfirmHost, h.server, { entry, action, enabled: false }));
it('R213 меню ячейки на телефоне выбирает альбом целиком даже с поддержкой album1',
  () => albumItemScene(h.Pane, h.ConfirmHost, h.server, { entry: 'cell', phone: true }));

for (const [name, from, to, options, prefix, actual, expected] of [
  ['просмотрщик берёт первую фотографию вместо выбранной', '      const att = x.att;', '      const att = m.attachments![0]!;', {},
    'G56-delete: callback', '[["delete","album-message","photo-first","me"]]', '[["delete","album-message","selected-item","me"]]'],
  ['пересылка просмотрщика теряет attachmentId', '          openForwardItem(m, att);', '          openForward([m.id]);', { action: 'forward' },
    'G56-forward: callback', '[]', '[["forward","album-message","selected-item","target",false,{"hideSender":false}]]'],
  ['ПКМ не распознаёт ячейку альбома', 'item: photoLink ? albumCellFromTarget(m.attachments, t) : undefined,', 'item: undefined,', { entry: 'cell' },
    'G56-menu: пункт', false, true],
] as const) h.mutantTest(`R213 UI контрфакт: ${name}`, () => h.rejectMutant(source => {
  assert.equal(source.split(from).length - 1, 1, 'мутант меняет одно место полного MessagePane');
  return source.replace(from, to);
}, async (component, confirm, _answer, runtime) => {
  try { await albumItemScene(component, confirm!, runtime!, options); }
  catch (error) {
    if (!process.env.GUSVOICE_PANE_MUTANT) throw error;
    assert.ok(error instanceof assert.AssertionError, 'UI-мутант дошёл до host AssertionError');
    assert.ok(error.message.startsWith(prefix), 'UI-мутант упал на заявленном действии, не на загрузке или предусловии');
    assert.equal(error.operator, 'strictEqual', 'UI-мутант упал на строгом сравнении действия');
    assert.equal(error.actual, actual, 'у UI-мутанта проверено фактическое значение');
    assert.equal(error.expected, expected, 'у UI-мутанта проверено ожидаемое значение');
    throw error;
  }
}, prefix));

// Пересылка и закрепления.

it('без превью не рисует карточку и не запрашивает её, обычная ссылка рисует: даже при готовом кеше', async () => {
  // Ловит игнорирование noPreview в реальной ленте, в том числе уже закешированного адреса.
  const {api}=await h.server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const original=api.linkPreview; const oldSetting=localStorage.getItem('gv_link_preview'); let calls=0;
  localStorage.setItem('gv_link_preview','on');
  api.linkPreview=async url=>{calls++;return {url,title:'Проверка превью',description:'Описание',siteName:'Сайт'};};
  const row={...h.msg('preview-flag'),content:'https://preview-flag.example.test/article'};
  try {
    await h.mount({messages:[{...row,noPreview:true}]});
    assert.ok(!h.host.querySelector('.lp-card')); assert.equal(calls,0);
    await h.rerender({messages:[row]}); await act(async()=>{await h.delay(80);});
    assert.equal(h.host.querySelector('.lp-title')?.textContent,'Проверка превью'); assert.equal(calls,1);
    await h.rerender({messages:[{...row,noPreview:true}]});
    assert.ok(!h.host.querySelector('.lp-card')); assert.equal(calls,1);
  } finally {
    h.unmount();
    api.linkPreview=original;
    if(oldSetting===null)localStorage.removeItem('gv_link_preview');else localStorage.setItem('gv_link_preview',oldSetting);
  }
});

it('пересылка через picker зовёт batch один раз, показывает завершение и скрывает Вниз', async () => {
  // После успеха человеку нужно подтверждение и быстрый переход, а не перекрывающаяся кнопка «Вниз».
  h.desktop(); h.round12();
  const { useStore } = await h.server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const initial = useStore.getState(); h.resetStore = () => useStore.setState(initial, true);
  const { useToasts } = await h.server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
  const initialToasts = useToasts.getState();
  h.resetStore = () => { useStore.setState(initial, true); useToasts.setState(initialToasts, true); };
  useStore.setState({ dms: [
    { id: 'target', otherUser: { id: 'target-user', username: 'target', displayName: 'Целевая беседа', avatarUrl: null },
      createdAt: new Date(h.now).toISOString(), lastMessageAt: null, unread: 0 },
    { id: 'bad', otherUser: { id: 'bad-user', username: 'bad', displayName: 'Недоступная беседа', avatarUrl: null },
      createdAt: new Date(h.now).toISOString(), lastMessageAt: null, unread: 0 },
  ] as never });
  const calls: [string[], string][] = [];
  const opened: string[] = [];
  const batch = { forward: async (ids: string[], to: string) => { calls.push([ids, to]); if (to === 'bad') throw new Error('network'); }, deleteMany: async () => {},
    peerName: () => 'Целевая беседа', open: (id: string) => opened.push(id) };
  const feedWindow = { hasOlder: false, hasNewer: true, loadNewer: async () => false, jumpLatest: async () => {}, jumpTo: async () => true,
    unreadBelow: 1, place: null, onPlace: () => {}, readKey: null };
  await h.mount({ messages: [h.msg('forward-source'), h.msg('forward-source-2', 'peer')], batch, feedWindow, onReact: () => {} });
  const openPicker = async () => {
    await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="forward-source"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const enterSelection = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((button) => button.textContent?.includes('Выделить'));
    assert.ok(enterSelection, 'пузырь предлагает выделение действий пачкой');
    await act(async () => { enterSelection.click(); await h.flush(); });
    await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="forward-source-2"]')!.click(); await h.flush(); });
    const forward = h.host.querySelector<HTMLButtonElement>('[aria-label="Переслать"]');
    assert.ok(forward, 'выбранные сообщения предлагают пересылку пачкой');
    await act(async () => { forward.click(); await h.flush(); });
    assert.ok(document.querySelector('.fwd-pick'), 'открывается picker бесед');
  };
  const choose = async (name: string) => {
    await openPicker();
    const target = [...document.querySelectorAll<HTMLButtonElement>('.fwd-pick .dm-row')].find((button) => button.textContent?.includes(name));
    assert.ok(target, `picker содержит адресата «${name}»`);
    await act(async () => { target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })); await h.flush(); });
    assert.ok(document.querySelector('.fwd-foot'), 'правый клик отмечает адресата для немедленной пересылки, а не создает черновик');
    await act(async () => { document.querySelector<HTMLButtonElement>('.fwd-send')!.click(); await h.flush(); });
  };
  await openPicker();
  const draftTarget = [...document.querySelectorAll<HTMLButtonElement>('.fwd-pick .dm-row')].find((button) => button.textContent?.includes('Целевая беседа'));
  assert.ok(draftTarget, 'picker содержит беседу для черновика');
  await act(async () => { draftTarget!.click(); await h.flush(); });
  const draft = useStore.getState().fwdDrafts.target;
  assert.equal(draft?.from, 'c', 'обычный клик переносит источник в черновик получателя');
  assert.deepEqual(draft?.messages.map((m) => m.id), ['forward-source', 'forward-source-2']);
  assert.deepEqual(calls, [], 'обычный клик не вызывает batch.forward');
  assert.deepEqual(opened, ['target'], 'после постановки черновика открывается его беседа');
  useStore.getState().setFwdDraft('target', null); opened.length = 0;
  await choose('Целевая беседа');
  assert.deepEqual(calls, [[['forward-source', 'forward-source-2'], 'target']]);
  const done = h.host.querySelector<HTMLElement>('.fwd-done[role="status"]');
  assert.equal(done?.querySelector('span')?.textContent, 'Переслано: Целевая беседа');
  assert.equal(done?.querySelector('button')?.textContent, 'Открыть');
  assert.ok(!h.host.querySelector('.jump-down'), 'кнопка «Вниз» скрыта, пока видна плашка завершения пересылки');
  await act(async () => { h.host.querySelector<HTMLButtonElement>('.fwd-done button')!.click(); await h.flush(); });
  assert.deepEqual(opened, ['target'], 'кнопка «Открыть» переходит к выбранной беседе');
  await choose('Недоступная беседа');
  assert.equal(useToasts.getState().toasts.at(-1)?.title, 'Не удалось переслать', 'ошибка попадает в понятный тост');
  assert.ok(!document.querySelector('.fwd-done'), 'неудача не показывает ложное подтверждение пересылки');
  await choose('Целевая беседа');
  await act(async () => { await h.delay(4100); });
  assert.ok(!document.querySelector('.fwd-done'), 'успешная плашка сама исчезает через четыре секунды');
  assert.ok(h.host.querySelector('.jump-down'), 'после исчезновения плашки возвращается «Вниз»');
});
it('полоса пересылки снимается, хранит source/опции и возвращается после отказа', async () => {
  h.desktop(); h.round12(); localStorage.setItem('gv_send_mode', 'enter');
  const { useStore } = await h.server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const initial = useStore.getState(); h.resetStore = () => useStore.setState(initial, true);
  const source = { ...h.msg('fwd-draft-source', 'peer'), content: 'подпись', attachments: [
    { id: 'photo', url: '/photo.png', name: 'photo.png', contentType: 'image/png', size: 4, width: 10, height: 10 },
  ] as never } as Message;
  const draft = { from: 'source-conversation', messages: [source], hideSender: false, hideCaptions: false };
  useStore.getState().setFwdDraft('target-conversation', draft);
  const calls: { ids: string[]; to: string; silent: boolean; opts?: unknown }[] = [];
  let failNext = false;
  const batch = { forward: async (ids: string[], to: string, silent = false, opts?: { hideSender?: boolean; hideCaptions?: boolean; from?: string }) => {
    calls.push({ ids, to, silent, opts }); if (failNext) { failNext = false; throw new Error('network'); }
  }, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {}, hideOptions: true };
  const targetMessages = [h.msg('existing-target-message', 'peer')];
  const feedWindow = { hasOlder: false, hasNewer: false, loadNewer: async () => false, jumpLatest: async () => {}, jumpTo: async () => true,
    unreadBelow: 0, place: null, onPlace: () => {}, readKey: null };
  await h.mount({ feedId: 'target-conversation', messages: targetMessages, batch, feedWindow }); h.host.classList.add('content');
  assert.ok(h.host.querySelector('.fwd-strip'), 'черновик виден над полем ввода');

  h.unmount();
  await h.mount({ feedId: 'target-conversation', messages: targetMessages, batch, feedWindow, readOnly: true }); h.host.classList.add('content');
  assert.ok(!h.host.querySelector('.fwd-strip'), 'в read-only режиме полоса не перекрывает беседу');
  assert.equal(useStore.getState().fwdDrafts['target-conversation']?.from, 'source-conversation', 'скрытие не уничтожает черновик');
  h.unmount();
  await h.mount({ feedId: 'target-conversation', messages: targetMessages, batch, feedWindow, composerReplacement: createElement('div', null, 'Замена поля') }); h.host.classList.add('content');
  assert.ok(!h.host.querySelector('.fwd-strip'), 'заменённое поле не оставляет над собой неприменимую полосу');
  assert.equal(useStore.getState().fwdDrafts['target-conversation']?.from, 'source-conversation', 'replacement тоже сохраняет черновик');
  h.unmount();
  await h.mount({ feedId: 'target-conversation', messages: targetMessages, batch, feedWindow }); h.host.classList.add('content');
  assert.ok(h.host.querySelector('.fwd-strip'), 'после возврата редактора черновик снова виден');

  await act(async () => { h.host.querySelector<HTMLButtonElement>('.fwd-strip .rs-close')!.click(); await h.flush(); });
  assert.equal(useStore.getState().fwdDrafts['target-conversation'], undefined, '× отменяет черновик, не трогая другие беседы');
  await act(async () => { useStore.getState().setFwdDraft('target-conversation', draft); await h.flush(); });
  assert.ok(h.host.querySelector('.fwd-strip'), 'после отмены новый черновик действительно отрисован');
  assert.equal(document.querySelector('[aria-modal="true"], .modal-overlay, .sheet, .ctx-menu, .confirm-overlay, .dd-pop, .lightbox, .emoji-backdrop, .sb-pop, .status-pop') === null, true, 'Esc не перекрыт посторонним слоем');
  const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  let reachedWindow = false; const observeEsc = () => { reachedWindow = true; }; window.addEventListener('keydown', observeEsc);
  try {
    await act(async () => { h.host.querySelector('.chat')!.dispatchEvent(esc); await h.flush(); });
  } finally { window.removeEventListener('keydown', observeEsc); }
  assert.equal(reachedWindow, true, 'событие дошло до окна, где слушает беседа');
  assert.equal(esc.defaultPrevented, true, 'беседа обработала Esc как слой черновика');
  assert.equal(useStore.getState().fwdDrafts['target-conversation'], undefined, 'Esc снимает черновик пересылки');

  await act(async () => { useStore.getState().setFwdDraft('target-conversation', draft); await h.flush(); });
  await act(async () => { h.host.querySelector<HTMLElement>('.fwd-strip')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const hideCaptions = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Скрыть подписи'));
  assert.ok(hideCaptions, 'для сообщения с подписью доступно скрытие caption');
  await act(async () => { hideCaptions!.click(); await h.flush(); });
  assert.equal(useStore.getState().fwdDrafts['target-conversation']?.hideCaptions, true);
  assert.equal(useStore.getState().fwdDrafts['target-conversation']?.hideSender, true, 'скрытие подписи также скрывает отправителя');

  const firstEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  const composer = h.host.querySelector<HTMLTextAreaElement>('.composer-input')!;
  await act(async () => { composer.focus(); composer.dispatchEvent(firstEnter); await h.flush(); await h.delay(30); });
  assert.equal(firstEnter.defaultPrevented, true, 'нажатие Enter на настоящем поле уходит в отправку');
  assert.deepEqual(calls, [{ ids: ['fwd-draft-source'], to: 'target-conversation', silent: false,
    opts: { hideSender: true, hideCaptions: true, from: 'source-conversation' } }], 'Enter в пустом поле отправляет черновик с исходной беседой и опциями');
  assert.equal(useStore.getState().fwdDrafts['target-conversation'], undefined, 'успешная отправка снимает черновик');

  failNext = true; await act(async () => { useStore.getState().setFwdDraft('target-conversation', draft); await h.flush(); });
  const retryEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  await act(async () => { h.host.querySelector<HTMLTextAreaElement>('.composer-input')!.dispatchEvent(retryEnter); await h.flush(); await h.delay(30); });
  assert.equal(retryEnter.defaultPrevented, true, 'повтор после сетевого отказа также отправляется Enter');
  assert.equal(calls.length, 2, 'отказ сети получил одну попытку');
  assert.equal(useStore.getState().fwdDrafts['target-conversation']?.from, 'source-conversation', 'при отказе черновик возвращён для повтора');
});

it('текст очереди уходит до пересылки из черновика', async () => {
  const check = async (component: typeof h.Pane) => {
  h.desktop(); h.round12();
  const { useStore } = await h.server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const initial = useStore.getState(); h.resetStore = () => useStore.setState(initial, true);
  const source = h.msg('queued-fwd-source', 'peer');
  useStore.getState().setFwdDraft('target-conversation', { from: 'source-conversation', messages: [source], hideSender: false, hideCaptions: false });
  const events: string[] = []; let queuedKey = '';
  const batch = { forward: async (ids: string[], to: string, _silent?: boolean, opts?: { hideSender?: boolean; hideCaptions?: boolean; from?: string }) => {
    events.push(`forward:${to}:${ids.join(',')}`); assert.deepEqual(opts, { hideSender: false, hideCaptions: false, from: 'source-conversation' });
  }, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
  const outbox = { items: [], enqueue: (item: { key: string; content: string }) => {
    queuedKey = item.key; events.push(`queue:${item.content}`);
    useStore.setState((s) => ({ outbox: { ...s.outbox, 'target-conversation': [{ key: item.key, content: item.content, status: 'sending' }] as never } }));
  }, retry: () => {}, discard: () => {} };
  await h.mount({ feedId: 'target-conversation', messages: [], batch, outbox: outbox as never }, component);
  const field = h.host.querySelector<HTMLTextAreaElement>('.composer-input'); assert.ok(field);
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setValue.call(field, 'текст впереди'); Simulate.change(field); await h.flush(); });
  await act(async () => { h.host.querySelector<HTMLFormElement>('.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await h.flush(); });
  assert.deepEqual(events, ['queue:текст впереди'], 'пересылка ждёт пока строка собственного текста ещё в очереди');
  assert.ok(queuedKey, 'очередь выдала ключ завершения');
  await act(async () => {
    useStore.setState((s) => ({ outbox: { ...s.outbox, 'target-conversation': [] } }));
    await h.delay(30);
  });
  assert.deepEqual(events, ['queue:текст впереди', 'forward:target-conversation:queued-fwd-source'], 'после ухода строки из очереди следует пересылка');
  };
  await check(h.Pane);
  h.unmount();
  await counterfact(async () => {
    const { MessagePane: bad } = await h.server.ssrLoadModule('/src/components/MessagePane.tsx?codex-forward-order-mutant') as typeof import('./MessagePane');
    await assert.rejects(() => check(bad), assert.AssertionError, 'исполняемый мутант пересылает до ухода своего текста');
  }, { timeoutMs: 60000 });
});
async function checkOlderHintAnchor(component: typeof h.Pane) {
  let release!: (hasMore: boolean) => void;
  let loadCalls = 0;
  const older = new Promise<boolean>((resolve) => { release = resolve; });
  const feedWindow = { hasOlder: false, hasNewer: false, loadNewer: async () => false, jumpLatest: async () => {}, jumpTo: async () => true,
    unreadBelow: 0, place: null, onPlace: () => {}, readKey: null };
  await h.mount({ messages: [h.msg('held')], feedWindow }, component);
  const list = h.host.querySelector<HTMLElement>('.messages');
  const row = h.host.querySelector<HTMLElement>('[data-mid="held"]');
  assert.ok(list, 'окно переписки смонтировано'); assert.ok(row, 'строка якоря смонтирована');
  assert.ok(row.matches('.message[data-mid]'), 'якорем становится именно DOM-строка сообщения');
  fixtureProperty(list, 'scrollHeight', { configurable: true, value: 2000 });
  fixtureProperty(list, 'clientHeight', { configurable: true, value: 600 });
  rememberProperty(list, 'getBoundingClientRect');
  list.getBoundingClientRect = () => new DOMRect(0, 0, 320, 600);
  rememberProperty(row, 'getBoundingClientRect');
  row.getBoundingClientRect = () => new DOMRect(0, (h.host.querySelector('.older-hint') ? 43 : 10) - list.scrollTop, 200, 30);
  await act(async () => { h.root!.render(createElement(component, { ...h.base, messages: [h.msg('held')], feedWindow: { ...feedWindow, hasOlder: true },
    onLoadOlder: () => { loadCalls++; return older; } })); await h.flush(); });
  assert.equal(loadCalls, 0, 'изменение окна само не начинает подгрузку до прокрутки к краю');
  await act(async () => { list.dispatchEvent(new Event('scroll')); await h.flush(); });
  assert.equal(loadCalls, 1, 'достижение края запускает ровно одну подгрузку старой истории');
  assert.ok(h.host.querySelector('.older-hint'), 'начавшаяся подгрузка показывает подсказку');
  assert.equal(list.scrollTop, 33, 'появление 33 px подсказки компенсируется прокруткой, строка остаётся на исходной отметке');
  assert.equal(row.getBoundingClientRect().top, 10, 'после компенсации видимая строка действительно на прежнем месте');
  release(true);
  await act(async () => { await older; await h.flush(); });
}
h.mutantTest('мутант без эффекта подсказки отпускает якорь у верхнего края', async () => {
  // Важно проверять именно регрессию: на нулевом scrollTop обычная прокрутка не удержит видимую строку.
  const removeHintEffect = (source: string) => {
    const start = source.indexOf('  useLayoutEffect(() => {\n    const held = heldAnchor.current;');
    const marker = '  }, [showOlderHint]);';
    const end = source.indexOf(marker, start);
    assert.ok(start >= 0 && end >= start, 'найден layout effect коррекции якоря подсказки');
    return source.slice(0, start) + source.slice(end + marker.length);
  };
  await h.rejectMutant(removeHintEffect, checkOlderHintAnchor);
});
it('короткая лента принимает новую позицию якоря, если прокрутка упёрлась в ноль', async () => {
  // Нельзя восстановить место выше нуля: следующая порция должна держать строку после уже видимой подсказки.
  h.desktop(); h.round12();
  let release!: (hasMore: boolean) => void;
  let loadCalls = 0;
  let scrollTop = 0;
  let extent = 550;
  let prepended = false;
  const older = new Promise<boolean>((resolve) => { release = resolve; });
  const feedWindow = { hasOlder: false, hasNewer: false, loadNewer: async () => false, jumpLatest: async () => {}, jumpTo: async () => true,
    unreadBelow: 0, place: null, onPlace: () => {}, readKey: null };
  await h.mount({ messages: [h.msg('short-held')], feedWindow });
  const list = h.host.querySelector<HTMLElement>('.messages');
  const row = h.host.querySelector<HTMLElement>('[data-mid="short-held"]');
  assert.ok(list, 'короткая лента смонтирована'); assert.ok(row, 'строка-якорь короткой ленты присутствует');
  rememberProperty(list, 'getBoundingClientRect');
  list.getBoundingClientRect = () => new DOMRect(0, 0, 320, 600);
  fixtureProperty(list, 'clientHeight', { configurable: true, value: 600 });
  fixtureProperty(list, 'scrollHeight', { configurable: true, get: () => extent });
  fixtureProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop,
    set: (value: number) => { scrollTop = Math.max(0, Math.min(value, Math.max(0, extent - 600))); } });
  rememberProperty(row, 'getBoundingClientRect');
  row.getBoundingClientRect = () => new DOMRect(0, (h.host.querySelector('.older-hint') ? 43 : 10) + (prepended ? 60 : 0) - list.scrollTop, 200, 30);
  await act(async () => { h.root!.render(createElement(h.Pane, { ...h.base, messages: [h.msg('short-held')], feedWindow: { ...feedWindow, hasOlder: true },
    onLoadOlder: () => { loadCalls++; return older; } })); await h.flush(); });
  assert.equal(loadCalls, 1, 'окно с доступной историей запускает единственную верхнюю подгрузку');
  assert.equal(list.scrollTop, 0, 'кламп не разрешает прокрутку выше нуля');
  assert.equal(row.getBoundingClientRect().top, 43, 'подсказка становится частью нового видимого места');
  prepended = true; extent = 1000;
  await act(async () => { h.root!.render(createElement(h.Pane, { ...h.base, messages: [h.msg('short-older', 'peer', 1000, 1), h.msg('short-held')],
    feedWindow: { ...feedWindow, hasOlder: true }, onLoadOlder: () => { loadCalls++; return older; } })); await h.flush(); });
  assert.equal(list.scrollTop, 60, 'новая порция сдвигает ленту ровно настолько, чтобы вернуть строку к offset 43');
  assert.equal(row.getBoundingClientRect().top, 43, 'после догрузки строка остаётся у видимой подсказки, а не прыгает на старый offset');
  release(true);
  await act(async () => { await older; await h.flush(); });
});

it('закреп из меню спрашивает область, открепление даёт пять секунд отмены и сохраняет scope', async () => {
  // Параметр области — реальное решение человека: дефолт общего действия нельзя незаметно подменять на «только у меня».
  h.desktop(); h.round12(); const calls: string[] = [];
  const pins = { list: [] as never[],
    pin: async (id: string, scope: string) => { calls.push(`pin:${id}:${scope}`); },
    unpin: async (id: string, scope: string) => { calls.push(`unpin:${id}:${scope}`); } };
  await h.mountWithConfirm({ messages: ['pin-1', 'pin-2'].map((id) => h.msg(id)), pins, deletePeerName: 'Peer' });
  const menuAction = async (id: string, label: string) => {
    const row = h.host.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    assert.ok(row, `строка ${id} присутствует для открытия меню`);
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const action = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.trim() === label);
    assert.ok(action, `меню предлагает действие «${label}» для ${id}; stack=${document.querySelector('.ctx-stack')?.textContent}; body=${h.host.textContent}`);
    if (id === 'pin-1') {
      const labels = [...document.querySelectorAll('.ctx-menu .ctx-label-main')].map((node) => node.textContent?.trim());
      assert.ok(labels.indexOf('Закрепить') === labels.indexOf('Изменить') + 1, 'закреп в меню ЛС расположено сразу после «Изменить»');
    }
    await act(async () => { action.click(); await h.flush(); });
  };
  await menuAction('pin-1', 'Закрепить');
  assert.equal(document.querySelector('#confirm-title')?.textContent, 'Закрепить сообщение?', 'закреп требует подтверждения');
  assert.ok((document.querySelector<HTMLInputElement>('.confirm-option input'))?.checked, 'по умолчанию закреп предлагается для собеседника тоже');
  await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
  await menuAction('pin-2', 'Закрепить');
  const pinOption = document.querySelector<HTMLInputElement>('.confirm-option input');
  assert.ok(pinOption?.checked, 'повторное окно начинается с общего закрепа');
  await act(async () => { pinOption.click(); document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
  h.unmount();
  const unpinProps = { ...pins, list: [h.pin('pin-3', 'me', true), h.pin('pin-4', 'me', true), h.pin('pin-5', 'me', false)] };
  await h.mountWithConfirm({ messages: ['pin-3', 'pin-4', 'pin-5'].map((id) => h.msg(id)), pins: unpinProps, deletePeerName: 'Peer' });
  await menuAction('pin-3', 'Открепить');
  assert.equal(document.querySelector('#confirm-title') === null, true, 'из меню открепление теперь отменяется плашкой');
  assert.ok(h.host.textContent?.includes('Сообщение откреплено'));
  assert.equal(calls.filter(c => c.startsWith('unpin:')).length, 0);
  const undo = [...h.host.querySelectorAll<HTMLButtonElement>('.fwd-done button')].find(b => b.textContent?.trim() === 'Отменить'); assert.ok(undo);
  await act(async () => { undo.click(); await h.flush(); });
  await menuAction('pin-4', 'Открепить');
  await menuAction('pin-5', 'Открепить');
  assert.equal(calls.filter(c => c.startsWith('unpin:')).length, 0, 'пока пять секунд не прошли запросов нет');
  h.unmount(); await h.flush();
  assert.deepEqual(calls, ['pin:pin-1:both', 'pin:pin-2:me', 'unpin:pin-4:both', 'unpin:pin-5:me'], 'при размонтировании ожидающее фиксируется, отменённое не отправляется');
});

it('крестики полосы и списка вызывают тот же сценарий открепления с нужной областью', async () => {
  // Крестики, в отличие от меню с undo, подтверждают и общий, и личный закреп.
  h.desktop(); h.round12(); const calls: string[] = [];
  const pins = { list: [h.pin('bar-only', 'me', true)], pin: async () => {},
    unpin: async (id: string, scope: string) => { calls.push(`${id}:${scope}`); } };
  await h.mountWithConfirm({ messages: [h.msg('bar-only'), h.msg('list-both', 'me'), h.msg('list-mine', 'peer')], pins });
  const barRemove = h.host.querySelector<HTMLButtonElement>('.pin-bar-btn[aria-label="Открепить"]');
  assert.ok(barRemove, 'единственное закрепление имеет крестик открепления на полосе');
  await act(async () => { barRemove.click(); await h.flush(); });
  assert.equal(document.querySelector('#confirm-title')?.textContent, 'Открепить сообщение?', 'крестик полосы подтверждает общий закреп');
  await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
  h.unmount();
  const multiPins = { ...pins, list: [h.pin('list-both', 'me', true), h.pin('list-mine', 'peer', false)] };
  await h.mountWithConfirm({ messages: [h.msg('bar-only'), h.msg('list-both'), h.msg('list-mine', 'peer')], pins: multiPins });
  await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-btn[aria-label="Все закреплённые"]')!.click(); await h.flush(); });
  const list = document.querySelector<HTMLElement>('.pins-pop');
  assert.ok(list, 'несколько закреплений открывают список действий');
  const mineRow = [...list.querySelectorAll<HTMLElement>('.pin-item')].find((item) => item.textContent?.includes('Текст list-mine'));
  assert.ok(mineRow, 'личное закрепление доступно в списке');
  await act(async () => { mineRow.querySelector<HTMLButtonElement>('.pin-unpin')!.click(); await h.flush(); });
  assert.equal(document.querySelector('#confirm-title')?.textContent, 'Открепить сообщение?', 'крестик личного закрепа тоже открывает подтверждение');
  await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
  const bothRow = [...document.querySelectorAll<HTMLElement>('.pin-item')].find((item) => item.textContent?.includes('Текст list-both'));
  assert.ok(bothRow, 'общее закрепление доступно в списке');
  await act(async () => { bothRow.querySelector<HTMLButtonElement>('.pin-unpin')!.click(); await h.flush(); });
  assert.equal(document.querySelector('#confirm-title')?.textContent, 'Открепить сообщение?', 'крестик общего закрепа просит подтверждение');
  assert.ok(document.querySelector<HTMLInputElement>('.confirm-option input')?.checked, 'по умолчанию крестик списка снимает закреп у обоих');
  await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
  assert.deepEqual(calls, ['bar-only:both', 'list-mine:me', 'list-both:both']);
});

it('читающий у нижней границы остаётся у низа при появлении и исчезновении полосы закрепа', async () => {
  // Последние сообщения не должны уходить под поле ввода, когда полоса отнимает или возвращает высоту ленты.
  h.desktop(); h.round12(); let extent = 2000; let height = 600; let scrollTop = 0;
  const pins = { list: [] as never[], pin: async () => {}, unpin: async () => {} };
  await h.mount({ messages: [h.msg('bottom')], pins });
  const list = h.host.querySelector<HTMLElement>('.messages');
  assert.ok(list, 'прокручиваемая лента присутствует');
  fixtureProperty(list, 'scrollHeight', { configurable: true, get: () => extent });
  fixtureProperty(list, 'clientHeight', { configurable: true, get: () => height });
  fixtureProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop,
    set: (value: number) => { scrollTop = Math.max(0, Math.min(value, Math.max(0, extent - height))); } });
  list.scrollTop = extent - height;
  await act(async () => { list.dispatchEvent(new Event('scroll')); await h.flush(); });
  assert.equal(list.scrollTop, 1400, 'перед изменением полосы человек действительно стоит у низа');
  height = 550;
  await h.rerender({ messages: [h.msg('bottom')], pins: { ...pins, list: [h.pin('bottom')] } });
  assert.ok(h.host.querySelector('.pin-bar'), 'новый закреп добавил полосу над лентой');
  assert.equal(list.scrollTop, 1450, 'появление полосы удерживает низ с учётом уменьшившейся высоты');
  height = 600;
  await h.rerender({ messages: [h.msg('bottom')], pins });
  assert.ok(!h.host.querySelector('.pin-bar'), 'после удаления последнего закрепа полоса исчезает');
  assert.equal(list.scrollTop, 1400, 'исчезновение полосы возвращает низ к прежней границе');
});

it('закреп показывает отдельный тост для лимита и сети, а отмена не вызывает API', async () => {
  // У 409 есть пользовательское объяснение, сетевой отказ не должен маскироваться под предел, отмена не меняет данные.
  h.desktop(); h.round12();
  const { useToasts } = await h.server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
  const initialToasts = useToasts.getState(); h.resetStore = () => useToasts.setState(initialToasts, true);
  const calls: string[] = [];
  const pins = { list: [] as never[], unpin: async () => {}, pin: async (id: string) => {
    calls.push(id);
    if (id === 'limit') throw Object.assign(new Error('pin limit'), { status: 409 });
    if (id === 'network') throw new Error('network down');
  } };
  await h.mountWithConfirm({ messages: ['limit', 'network', 'cancel'].map((id) => h.msg(id)), pins });
  const pinFromMenu = async (id: string) => {
    const row = h.host.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    assert.ok(row, `строка ${id} существует`);
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const action = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.trim() === 'Закрепить');
    assert.ok(action, `меню открывает подтверждение закрепа для ${id}`);
    await act(async () => { action.click(); await h.flush(); });
    assert.ok(document.querySelector('#confirm-title'), `для ${id} открылось подтверждение`);
  };
  await pinFromMenu('limit');
  await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
  assert.equal(useToasts.getState().toasts.at(-1)?.title, 'Не удалось закрепить', '409 показывает специальный тост, а не raw-ошибку');
  assert.match(useToasts.getState().toasts.at(-1)?.subtitle ?? '', /50 сообщений/, 'лимит объяснён числом и дальнейшим действием');
  await pinFromMenu('network');
  await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
  const networkToast = useToasts.getState().toasts.at(-1);
  assert.equal(networkToast?.title, 'Не удалось закрепить', 'обычная ошибка тоже отображается понятным действием');
  assert.equal(networkToast?.subtitle, 'network down', 'обычный сетевой отказ сохраняет свою причину');
  assert.ok(!/50 сообщений/.test(networkToast?.subtitle ?? ''), 'сетевая ошибка не маскируется под лимит закрепов');
  await pinFromMenu('cancel');
  await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-actions .ghost')!.click(); await h.flush(); });
  assert.deepEqual(calls, ['limit', 'network'], 'подтверждение отмены не отправляет запрос');
});

it('полоса начинает с нового закрепа, циклически ведёт к прошлому и список защищает выделение от Escape', async () => {
  // Цикл важен для быстрого возврата к предыдущему закрепу, а aria-modal не должен пропускать Escape в режим выделения.
  h.desktop(); h.round12();
  const pins = { list: [h.pin('oldest', 'peer'), h.pin('middle', 'me'), h.pin('newer', 'peer')], pin: async () => {}, unpin: async () => {} };
  const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
  await h.mount({ messages: [h.msg('oldest', 'peer'), h.msg('middle'), h.msg('newer', 'peer')], pins, batch });
  const bar = h.host.querySelector<HTMLElement>('.pin-bar');
  assert.ok(bar, 'три закреплённые строки показывают полосу');
  assert.match(bar.textContent ?? '', /Текст newer/, 'при открытии полоса выбирает самое новое закрепление');
  const main = bar.querySelector<HTMLButtonElement>('.pin-bar-main');
  assert.ok(main, 'текст полосы доступен как кнопка перехода');
  await act(async () => { main.click(); await h.flush(); });
  assert.match(h.host.querySelector('.pin-bar')?.textContent ?? '', /Текст middle/, 'после перехода полоса перемещается ровно на одно закрепление назад');
  assert.ok(h.host.querySelector('[data-mid="newer"]')?.classList.contains('jump-hit'), 'нажатие полосы действительно прыгает к текущему сообщению');
  await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-main')!.click(); await h.flush(); });
  assert.match(h.host.querySelector('.pin-bar')?.textContent ?? '', /Текст oldest/, 'движение назад различает круг при трёх закреплениях');
  await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-main')!.click(); await h.flush(); });
  assert.match(h.host.querySelector('.pin-bar')?.textContent ?? '', /Текст newer/, 'от самого старого закрепа круг возвращается к новому');
  // Выделение открываем до модального списка, чтобы Escape проверял именно порядок слоёв, а не синтетический клик сквозь подложку.
  const selectedRow = h.host.querySelector<HTMLElement>('[data-mid="middle"]');
  assert.ok(selectedRow, 'строка доступна для включения режима выделения');
  await act(async () => { selectedRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const select = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Выделить'));
  assert.ok(select, 'контекстное меню предлагает включить пачечное выделение');
  await act(async () => { select.click(); await h.flush(); });
  assert.ok(h.host.querySelector('.sel-head'), 'пачка выделена до проверки Esc');
  const opener = h.host.querySelector<HTMLButtonElement>('.pin-bar-btn');
  assert.ok(opener, 'многозначная полоса имеет кнопку списка');
  opener.focus();
  await act(async () => { opener.click(); await h.flush(); });
  const dialog = document.querySelector<HTMLElement>('.pins-pop[aria-modal="true"]');
  assert.ok(dialog, 'кнопка списка открывает настоящий модальный список закреплений над пачкой');
  const items = [...dialog.querySelectorAll<HTMLElement>('.pin-item')];
  assert.equal(items.length, 3, 'список содержит три закрепления');
  assert.match(items[0]!.textContent ?? '', /Текст newer/, 'список показывает новые закрепы сверху');
  assert.ok(!dialog.querySelector('.msg-ava'), 'строки закрепов не добавляют аватары ленты');
  // Без ухода фокуса эта проверка проходит даже при сломанном возврате на кнопку открытия.
  const focusedPin = dialog.querySelector<HTMLElement>('.pin-main');
  assert.ok(focusedPin, 'в списке есть доступная для фокуса строка закрепа');
  focusedPin.focus();
  assert.ok(document.activeElement === focusedPin && document.activeElement !== opener, 'перед Escape фокус действительно ушёл с кнопки открытия в список');
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await h.flush(); });
  assert.ok(!document.querySelector('.pins-pop'), 'первый Escape закрывает только верхний список');
  assert.ok(document.activeElement === h.host.querySelector('.pin-bar-btn'), 'закрытие Escape возвращает фокус на кнопку списка');
  assert.ok(h.host.querySelector('.sel-head'), 'Escape списка не сбрасывает выделение под модальным слоем');
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await h.flush(); });
  assert.ok(!h.host.querySelector('.sel-head'), 'следующий Escape уже закрывает выделение');
  await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-btn')!.click(); await h.flush(); });
  const reopened = document.querySelector<HTMLElement>('.pins-pop');
  assert.ok(reopened, 'список закреплений можно открыть повторно');
  const { stepBack } = await h.server.ssrLoadModule('/src/androidBack.ts') as typeof import('../androidBack');
  let handled = false; await act(async () => { handled = stepBack(); await h.flush(); });
  assert.equal(handled, true, 'системная «Назад» потребляется открытым списком');
  assert.ok(!document.querySelector('.pins-pop'), 'системная «Назад» закрывает список, не уходя из беседы');
  await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-btn')!.click(); await h.flush(); });
  const keyboardList = document.querySelector<HTMLElement>('.pins-pop');
  assert.ok(keyboardList, 'после системного возврата список можно открыть снова');
  await act(async () => { keyboardList.querySelector('.pin-main')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await h.flush(); });
  assert.ok(!document.querySelector('.pins-pop'), 'Enter на строке списка переходит к закрепу и закрывает поповер');
  assert.match(h.host.querySelector('.pin-bar')?.textContent ?? '', /Текст middle/, 'переход клавиатурой сохраняет соседнее выбранное закрепление');
});

h.mutantTest('мутант закреплённой полосы без jumpToMessage не проходит настоящий переход', async () => {
  // Закреп нельзя только подсветить в заголовке: место ленты тоже должно перейти к его сообщению.
  await h.rejectMutant((s) => s.replace('    void jumpToMessage(id);', '    // переход удалён мутантом;'), async (component) => {
    h.desktop(); h.round12();
    const pins = { list: [h.pin('jump-a'), h.pin('jump-b'), h.pin('jump-c')], pin: async () => {}, unpin: async () => {} };
    await h.mount({ messages: ['jump-a', 'jump-b', 'jump-c'].map((id) => h.msg(id)), pins }, component);
    await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-main')!.click(); await h.flush(); });
    assert.ok(h.host.querySelector('[data-mid="jump-c"]')?.classList.contains('jump-hit'), 'целевая строка получила вспышку перехода');
  });
});

h.mutantTest('мутант после закрепления не выбирает новое сообщение в полосе', async () => {
  // Если человек уже смотрел старое закрепление, новый pin обязан стать текущим, даже когда он не последний в ответе сервера.
  await h.rejectMutant((s) => s.replace('      setPinShown(m.id);', '      // обновление текущего закрепления удалено мутантом;'), async (component, confirm = h.ConfirmHost, answer) => {
    h.desktop(); h.round12();
    let list = [h.pin('p-old'), h.pin('p-middle'), h.pin('p-latest')];
    const pins = { list, pin: async (id: string) => { list = [h.pin(id), ...list]; }, unpin: async () => {} };
    const props = { messages: ['p-old', 'p-middle', 'p-latest', 'p-new'].map((id) => h.msg(id)), pins };
    if (process.env.GUSVOICE_PANE_MUTANT) await h.mount(props, component);
    else await h.mountWithConfirm(props, component, confirm);
    await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-main')!.click(); await h.flush(); });
    await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-main')!.click(); await h.flush(); });
    assert.match(h.host.querySelector('.pin-bar')?.textContent ?? '', /Текст p-old/, 'перед закреплением полоса удерживает выбранное старое сообщение');
    const row = h.host.querySelector<HTMLElement>('[data-mid="p-new"]');
    assert.ok(row, 'новое сообщение есть в ленте для закрепления');
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const action = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.trim() === 'Закрепить');
    assert.ok(action, 'действие нового закрепа присутствует в меню');
    await act(async () => { action.click(); await h.flush(); });
    if (process.env.GUSVOICE_PANE_MUTANT) {
      assert.ok(answer, 'для изолированного мутанта доступен его собственный store подтверждения');
      await act(async () => { answer(); await h.flush(); });
    } else {
      const confirmButton = document.querySelector<HTMLButtonElement>('.confirm-primary');
      assert.ok(confirmButton, 'новое закрепление запрашивает подтверждение перед изменением');
      await act(async () => { confirmButton.click(); await h.flush(); });
    }
    await act(async () => { h.root!.render(createElement(component, { ...h.base, ...props, pins: { ...pins, list } })); await h.flush(); });
    assert.match(h.host.querySelector('.pin-bar')?.textContent ?? '', /Текст p-new/, 'после ответа закрепа полоса сразу выбирает новое сообщение');
  });
});

// Опасные ссылки: capability, превью и подтверждение.

const url = 'https://user@evil.example/r148';
const message = () => ({ ...h.msg('r148-danger', 'peer'), content: url, dangerousLinks: ['evil.example'] });

async function feature(runtime: ViteDevServer, enabled: boolean) {
  const { useStore } = await runtime.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const previous = useStore.getState().serverFeatures;
  useStore.setState({ serverFeatures: enabled ? [FEATURE_LINKTHREATS1] : [] });
  return () => useStore.setState({ serverFeatures: previous });
}

async function openMenu() {
  const link = h.host.querySelector<HTMLAnchorElement>('a.msg-link');
  assert.ok(link, 'в сообщении есть настоящий якорь');
  await act(async () => {
    link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await h.flush();
  });
  const open = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')]
    .find(b => b.textContent?.includes('Открыть'));
  assert.ok(open, 'меню предлагает открытие ссылки');
  await act(async () => { open.click(); await h.flush(); });
}

async function gatedRow(component = h.Pane, runtime = h.server) {
  // Непрошедший handshake не позволяет доверять полю из DTO старого/чужого сервера.
  const restore = await feature(runtime, false);
  try {
    h.desktop();
    await h.mount({ messages: [message()] }, component);
    assert.equal(!!h.host.querySelector('.danger-link-badge'), false, 'без признака сервера нет плашки угрозы');
    assert.equal(!!h.host.querySelector('a.danger-link'), false, 'без признака якорь остаётся прежним');
  } finally { h.unmount(); restore(); }
}

it('R148 без признака сервера поле dangerousLinks не меняет строку сообщения', async () => {
  await gatedRow();
});

it('R148 с признаком сервера строка передаёт список в настоящую ссылку и показывает плашку', async () => {
  // Ловит разрыв между DTO, renderContent и MessageLink при исправных отдельных правилах.
  const restore = await feature(h.server, true);
  try {
    await h.mount({ messages: [message()] });
    assert.equal(h.host.querySelector('a.danger-link')?.getAttribute('href'), url);
    assert.equal(h.host.querySelector('.danger-link-badge')?.textContent, 'Опасная ссылка');
  } finally { h.unmount(); restore(); }
});

it('R148 опасное превью не запрашивается, безопасное соседнее по-прежнему запрашивается', async () => {
  // Проверяем не отсутствие карточки в пустой сети, а отсутствие самого запроса опасного адреса.
  const restore = await feature(h.server, true);
  const { api } = await h.server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const previous = api.linkPreview;
  const setting = localStorage.getItem('gv_link_preview');
  const calls: string[] = [];
  api.linkPreview = async link => { calls.push(link); return null; };
  localStorage.setItem('gv_link_preview', 'on');
  try {
    const safe = 'https://safe.example/r148-preview';
    await h.mount({ messages: [{ ...message(), content: `${url} ${safe}` }] });
    await act(async () => { await h.flush(); });
    assert.deepEqual(calls, [safe], 'соседнее безопасное превью работает, опасное даже не загружается');
  } finally {
    h.unmount(); api.linkPreview = previous; restore();
    if (setting === null) localStorage.removeItem('gv_link_preview'); else localStorage.setItem('gv_link_preview', setting);
  }
});

async function dangerousMenu(component = h.Pane, confirm = h.ConfirmHost, runtime = h.server) {
  // userinfo одновременно делает адрес подозрительным: нужен приоритет угрозы, не обычный interstitial.
  const restore = await feature(runtime, true);
  const { useConfirmDialog } = await runtime.ssrLoadModule('/src/confirm.ts') as typeof import('../confirm');
  const previousOpen = window.open;
  const opened: unknown[][] = [];
  window.open = ((...args: unknown[]) => { opened.push(args); return null; }) as typeof window.open;
  try {
    h.desktop();
    await h.mountWithConfirm({ messages: [message()] }, component, confirm);
    await openMenu();
    assert.equal(useConfirmDialog.getState().pending?.title, 'Опасная ссылка', 'угроза проверяется раньше подозрительности');
    assert.equal(!!document.querySelector('.link-confirm'), false, 'второе окно подозрительности не открыто');
    assert.deepEqual(opened, [], 'до ответа адрес не открыт');
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('.confirm-actions button')]
      .find(b => b.textContent === 'Отмена');
    assert.ok(cancel);
    assert.equal(document.activeElement === cancel, true, 'опасное действие по умолчанию фокусирует отмену');
    await act(async () => { cancel.click(); await h.flush(); });
    assert.deepEqual(opened, [], 'отмена не открывает адрес');
    await openMenu();
    const accept = document.querySelector<HTMLButtonElement>('.confirm-primary');
    assert.equal(accept?.textContent, 'Всё равно открыть');
    assert.ok(accept);
    await act(async () => { accept.click(); await h.flush(); });
    assert.deepEqual(opened, [[url, '_blank', 'noopener,noreferrer']], 'подтверждение открывает адрес ровно один раз');
  } finally {
    h.unmount(); useConfirmDialog.getState().answer(false); window.open = previousOpen; restore();
  }
}

it('R148 команда меню отдаёт опасную и подозрительную ссылку окну угрозы с отменой и подтверждением', async () => {
  await dangerousMenu();
});

it('R148 без признака сервера меню использует прежнее окно подозрительности', async () => {
  // Парное разрешение прежнего пути: отключение новой проверки не отключает защиту от userinfo.
  const restore = await feature(h.server, false);
  try {
    h.desktop(); await h.mountWithConfirm({ messages: [message()] }); await openMenu();
    assert.equal(!!document.querySelector('.link-confirm'), true);
    assert.equal(!!document.querySelector('.confirm.danger'), false);
  } finally { h.unmount(); restore(); }
});

h.mutantTest('R148 мутант без признака сервера доверяет dangerousLinks в MessageRow', async () => {
  await h.rejectMutant(source => {
    const from = '(serverLinkThreats(s.serverFeatures) ? m.dangerousLinks : undefined)';
    assert.equal(source.split(from).length - 1, 1);
    return source.replace(from, 'm.dangerousLinks');
  }, async (component, _confirm, _answer, runtime) => gatedRow(component, runtime!), 'без признака сервера нет плашки');
});

h.mutantTest('R148 мутант меню пропускает угрозу и показывает только подозрительность', async () => {
  await h.rejectMutant(source => {
    const from = 'if (serverLinkThreats(useStore.getState().serverFeatures) && isDangerousLink(url, m.dangerousLinks)) {';
    assert.equal(source.split(from).length - 1, 1);
    return source.replace(from, 'if (false) {');
  }, async (component, confirm, _answer, runtime) => dangerousMenu(component, confirm!, runtime!), 'угроза проверяется раньше');
});

// Федерация: запрет файлов, copying и замены композера.

const hint = 'Файлы между инстансами пока не поддерживаются';
async function stores(server: ViteDevServer) {
  const { useStore } = await server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const { useToasts } = await server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
  const initial = useStore.getState(), initialToasts = useToasts.getState();
  h.resetStore = () => { useStore.setState(initial, true); useToasts.setState(initialToasts, true); };
  return useToasts;
}
function layout(phone: boolean) {
  const restore = h.pointerLayout(phone, phone ? 390 : 1200);
  if (phone) h.mobile(); else h.desktop();
  return () => { h.desktop(); restore(); };
}
function node<T extends Element>(selector: string): T {
  const found = h.host.querySelector<T>(selector);
  assert.equal(!!found, true, `есть ${selector}`);
  return found!;
}
function transfer(files: File[]) {
  return { types: ['Files'], files, items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })), getData: () => '' };
}
async function event(type: 'paste' | 'drop' | 'dragenter' | 'dragleave', files: File[] = []) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  if (type === 'paste') fixtureProperty(e, 'clipboardData', { value: transfer(files) });
  else fixtureProperty(e, 'dataTransfer', { value: transfer(files) });
  await act(async () => {
    (type === 'paste' ? node<HTMLTextAreaElement>('.composer textarea') : node<HTMLElement>('.chat')).dispatchEvent(e);
    await h.flush();
  });
  return e;
}
function noFilesUi() {
  assert.equal(!!document.querySelector('.sfb'), false, 'запрет файлов не открывает окно отправки');
  assert.equal(!!h.host.querySelector('.pending-atts'), false, 'запрет файлов не открывает полосу загрузки');
}
function noMenu() {
  assert.equal(!!document.querySelector('.ctx-menu,.sheet-scrim'), false, 'запрет файлов не раскрывает меню или BottomSheet');
}
for (const phone of [false, true]) for (const buttonClass of ['plus', 'attach']) {
  it(`${phone ? 'телефон' : 'ПК'}: ${buttonClass} при запрете даёт подсказку и тост, без запрета открывает настоящий выбор`, async () => {
    // Класс ошибки доступности: aria-disabled не отключает DOM-click сама, поэтому handler обязан остановить меню.
    const restore = layout(phone), toasts = await stores(h.server);
    try {
      await h.mount({ filesBlocked: hint });
      const button = node<HTMLButtonElement>(`.att-btn.${buttonClass}`), n = toasts.getState().toasts.length;
      assert.equal(button.getAttribute('aria-disabled'), 'true'); assert.equal(button.title, hint);
      await act(async () => { button.click(); await h.flush(); });
      assert.equal(toasts.getState().toasts.length, n + 1); assert.equal(toasts.getState().toasts.at(-1)?.title, hint);
      assert.equal(toasts.getState().toasts.at(-1)?.type, 'info'); noMenu(); noFilesUi();
      h.unmount(); await h.mount({});
      const normal = node<HTMLButtonElement>(`.att-btn.${buttonClass}`);
      assert.equal(normal.getAttribute('aria-disabled'), null); assert.equal(normal.title, 'Прикрепить');
      await act(async () => { normal.click(); await h.flush(); });
      assert.equal(normal.getAttribute('aria-expanded'), 'true');
      assert.equal(!!document.querySelector('.ctx-menu,.sheet-scrim'), true, 'обычная кнопка раскрывает выбор');
      const labels = [...document.querySelectorAll('.ctx-menu button,.sheet-row')].map(el => el.textContent?.trim());
      assert.equal(labels.some(s => s === 'Файл'), true); assert.equal(labels.some(s => s?.includes('Фото или видео')), true);
    } finally { h.unmount(); restore(); }
  });
}
async function filesScenario(phone: boolean, way: 'paste' | 'drop', component = h.Pane, server = h.server) {
  const restore = layout(phone), toasts = await stores(server);
  let enqueued = 0, sent = 0;
  const outbox = { items: [], enqueue() { enqueued++; }, retry() {}, discard() {} } as never;
  try {
    await h.mount({ filesBlocked: hint, outbox, onSend: async () => { sent++; } }, component);
    const n = toasts.getState().toasts.length;
    const blocked = await event(way, [new File(['data'], 'fed-test.txt', { type: 'text/plain' })]);
    // Проверяем отсутствие побочного UI даже при обходе кнопки через paste/drop.
    noFilesUi();
    assert.equal(blocked.defaultPrevented, true); assert.equal(toasts.getState().toasts.length, n + 1);
    assert.equal(toasts.getState().toasts.at(-1)?.title, hint); noMenu();
    assert.equal(enqueued, 0); assert.equal(sent, 0);
    h.unmount();
    await h.mount({ outbox, onSend: async () => { sent++; } }, component);
    const before = toasts.getState().toasts.length;
    await event(way, [new File(['data'], 'allowed-test.txt', { type: 'text/plain' })]);
    assert.equal(!!document.querySelector('.sfb'), !phone, 'ПК сохраняет окно отправки файлов');
    assert.equal(!!h.host.querySelector('.pending-atts'), phone, 'телефон сохраняет полосу файлов');
    const text = phone ? h.host.querySelector('.pending-atts')?.textContent : document.querySelector('.sfb')?.textContent;
    assert.equal(text?.includes('allowed-test.txt'), true);
    assert.equal(toasts.getState().toasts.length, before, 'обычный файл не выдаёт тост запрета');
    assert.equal(enqueued, 0); assert.equal(sent, 0);
  } finally { h.unmount(); restore(); }
}
for (const phone of [false, true]) for (const way of ['paste', 'drop'] as const) {
  it(`${phone ? 'телефон' : 'ПК'}: ${way} файла при запрете даёт тост без окна и полосы, обычный файл принимается`, async () => {
    // Класс ошибки обхода кнопки: clipboard/drop должны соблюдать тот же запрет, что скрепка.
    await filesScenario(phone, way);
  });
}
async function dragScenario(phone: boolean, component = h.Pane) {
  const restore = layout(phone);
  try {
    await h.mount({ filesBlocked: hint }, component);
    await event('dragenter', [new File(['data'], 'drag-test.txt', { type: 'text/plain' })]);
    assert.equal(node<HTMLElement>('.chat').classList.contains('drag-over'), false, 'запрет файлов не подсвечивает бросок');
    h.unmount(); await h.mount({}, component);
    await event('dragenter', [new File(['data'], 'drag-test.txt', { type: 'text/plain' })]);
    assert.equal(node<HTMLElement>('.chat').classList.contains('drag-over'), true, 'обычный файл подсвечивает бросок');
    await event('dragleave'); assert.equal(node<HTMLElement>('.chat').classList.contains('drag-over'), false);
  } finally { h.unmount(); restore(); }
}
for (const phone of [false, true]) it(`${phone ? 'телефон' : 'ПК'}: dragenter Files не рисует рамку при запрете, обычный рисует`, async () => {
  // Класс ошибки ложного affordance: запрещённый бросок не должен обещать успешную загрузку.
  await dragScenario(phone);
});

async function copyingScene(component = h.Pane, server: ViteDevServer = h.server) {
  h.round12(); h.desktop();
  const { resetAutoDownload } = await server.ssrLoadModule('/src/autoDownload.ts') as typeof import('../autoDownload'); resetAutoDownload();
  const photo = (id: string, copying = false, sort = 1) => ({ ...h.msg(id, 'peer', 0, sort), content: '',
    attachments: [{ id, url: `/${id}.png`, name: `${id}.png`, contentType: 'image/png', size: 12, width: 100, height: 80, ...(copying ? { fedState: 'copying' as const } : {}) }] });
  const open = async () => {
    const button = h.host.querySelector<HTMLButtonElement>('[data-mid="ready-first"] .att-img-link'); assert.equal(!!button, true);
    await act(async () => { button!.click(); await h.flush(); }); assert.equal(!!document.querySelector('.lightbox'), true);
  };
  try {
    await h.mount({ messages: [photo('ready-first'), photo('copying', true, 2), photo('ready-last', false, 3)] }, component);
    await open();
    assert.equal(document.querySelector('.lb-sub')?.textContent?.includes('1 из 2'), true, 'просмотр считает только готовые картинки');
    assert.equal([...document.querySelectorAll('.lightbox img')].some(node => node.getAttribute('src') === '/copying.png'), false);
    h.unmount();
    await h.mount({ messages: [photo('ready-first'), photo('copying', false, 2), photo('ready-last', false, 3)] }, component);
    await open();
    assert.equal(document.querySelector('.lb-sub')?.textContent?.includes('1 из 3'), true, 'готовая копия возвращается в просмотр');
  } finally { h.unmount(); }
}
it('настоящий просмотр ленты исключает copying и возвращает файл после готовности', async () => {
  // Класс ошибки: стрелки просмотра предлагают ещё отсутствующие байты.
  await copyingScene();
});

const notice = createElement('div', { className: 'composer-blocked fed-archive fed-stale', role: 'status' }, 'Сообщения ждут, пока «Сосед» их заберёт');
const replacement = createElement('div', { 'data-composer-replacement': true }, 'Переписка закрыта');
it('настоящий MessagePane показывает fed-via-bar над полем и не открывает скрепку текстового обхода', async () => {
  h.desktop(); const restore = h.pointerLayout(false, 1280);
  try {
    await h.mount({ filesBlocked: FED_VIA_TEXT_ONLY, composerNote: createElement('div', { className: 'fed-via-bar', role: 'status' }, 'Инстанс «Дом» недоступен — пишем через «Сосед»') });
    assert.equal(h.host.querySelector('.fed-via-bar')?.textContent, 'Инстанс «Дом» недоступен — пишем через «Сосед»');
    assert.equal(!!h.host.querySelector('.composer textarea'), true, 'текстовый обход оставляет поле');
    const attach = h.host.querySelector<HTMLButtonElement>('.att-btn.attach'); assert.equal(!!attach, true);
    assert.equal(attach?.getAttribute('aria-disabled'), 'true'); assert.equal(attach?.title, FED_VIA_TEXT_ONLY);
    await act(async () => { attach!.click(); await h.flush(); });
    assert.equal(!!document.querySelector('.ctx-menu,.sheet-scrim,.sfb'), false, 'скрепка обхода не предлагает отправку файлов');
    assert.equal(!!h.host.querySelector('.pending-atts'), false);
  } finally { h.unmount(); restore(); }
});
async function replacementScene(component = h.Pane) {
  h.desktop(); const restore = h.pointerLayout(false, 1280);
  try {
    await h.mount({ composerNotice: notice }, component);
    assert.equal(!!h.host.querySelector('.fed-stale'), true, 'обычная лента показывает notice');
    assert.equal(!!h.host.querySelector('.composer textarea'), true, 'notice оставляет поле ввода');
    await h.rerender({ composerNotice: notice, composerReplacement: replacement }, component);
    assert.equal(!!h.host.querySelector('[data-composer-replacement]'), true);
    assert.equal(!!h.host.querySelector('.fed-stale'), false, 'замена поля убирает отдельную notice');
    assert.equal(!!h.host.querySelector('.composer textarea'), false);
  } finally { h.unmount(); restore(); }
}
it('настоящий MessagePane показывает fedStale рядом с доступным полем, composerReplacement подавляет notice', () => replacementScene());
async function searchScene(phone: boolean, component = h.Pane) {
  if (phone) h.mobile(); else h.desktop(); const restore = h.pointerLayout(phone, phone ? 390 : 1280);
  try {
    await h.mount({ composerNotice: notice, chatSearch: { open: true, setOpen() {}, search: async () => ({ total: 0, hits: [], next: null }), jumpToDate: async () => null } }, component);
    assert.equal(!!h.host.querySelector('.chat-search-foot'), phone, 'нижний поиск заменяет поле только на телефоне');
    assert.equal(!!h.host.querySelector('.fed-stale'), !phone, 'поиск на телефоне скрывает notice, ПК сохраняет');
    assert.equal(!!h.host.querySelector('.composer textarea'), true, 'поиск прячет, но не размонтирует поле');
  } finally { h.unmount(); h.desktop(); restore(); }
}
it('телефонный поиск убирает fedStale над заменённым полем, ПК-поиск сохраняет notice и поле', async () => {
  await searchScene(true); await searchScene(false);
});
async function selectionScene(component = h.Pane) {
  h.mobile(); const restore = h.pointerLayout(true, 390);
  try {
    await h.mount({ composerNotice: notice, messages: [h.msg('fed-stale-select')], batch: {
      forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Собеседник', open: () => {},
    } }, component);
    assert.equal(!!h.host.querySelector('.fed-stale'), true);
    const row = h.host.querySelector<HTMLElement>('[data-mid="fed-stale-select"]'); assert.equal(!!row, true);
    const event = new Event('contextmenu', { bubbles: true, cancelable: true }); fixtureProperty(event, 'pointerType', { value: 'touch' });
    await act(async () => { row!.dispatchEvent(event); await h.flush(); });
    const choose = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(b => b.textContent?.trim() === 'Выбрать');
    assert.equal(!!choose, true, 'касательное меню позволяет настоящее выделение');
    await act(async () => { choose!.click(); await h.flush(); });
    assert.equal(!!h.host.querySelector('.sel-head'), true, 'сообщение действительно выбрано');
    assert.equal(!!h.host.querySelector('.fed-stale'), false, 'выделение скрывает notice');
    assert.equal(!!h.host.querySelector('.composer textarea'), true, 'выделение не теряет черновое поле');
  } finally { h.unmount(); h.desktop(); restore(); }
}
it('настоящее выделение сообщения убирает fedStale, не размонтируя поле черновика', () => selectionScene());

// Папка проходит через настоящий onDrop и folderZip в том же основном runtime.
function folderIo() {
  // HappyDOM TransformStream несовместим с потоком Node Blob; возвращаем исходный IO только на время сценария.
  for (const [key, value] of Object.entries(folderPlatform)) fixtureProperty(globalThis, key, { configurable: true, writable: true, value });
  fixtureProperty(globalThis, 'Blob', { configurable: true, writable: true, value: NodeBlob });
  fixtureProperty(globalThis, 'File', { configurable: true, writable: true, value: NodeFile });
  fixtureProperty(globalThis, 'fetch', { configurable: true, writable: true,
    value: async () => new Response(null, { status: 503 }) });
}
function paneTransfer(files: File[], entries: FileSystemEntry[] = []) {
  const items: { kind: string; type: string; getAsFile(): File | null; webkitGetAsEntry?: () => FileSystemEntry | null }[] = entries.length ? entries.map(entry => ({ kind: 'file', type: '',
    getAsFile: () => files[0] ?? null, webkitGetAsEntry: () => entry })) : transfer(files).items;
  return { ...transfer(files), items };
}
function paneEvent(type: 'drop' | 'paste' | 'dragenter', dt: ReturnType<typeof paneTransfer>) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: dt });
  (type === 'paste' ? node<HTMLTextAreaElement>('.composer textarea') : node<HTMLElement>('.chat')).dispatchEvent(e);
  return e;
}
function waitingFolder(name: string) {
  let reads = 0, entries = 0, finished = false;
  let release: ((children: FileSystemEntry[]) => void) | undefined;
  const file = new File(['synthetic payload'], 'inside.png', { type: 'image/png' });
  const child = { name: file.name, isFile: true, isDirectory: false,
    file(ok: (value: File) => void) { ok(file); } } as FileSystemFileEntry;
  const dir = { name, isFile: false, isDirectory: true, createReader() {
    return { readEntries(ok: (children: FileSystemEntry[]) => void) {
      reads++;
      if (reads === 1 && !finished) release = ok;
      else ok([]);
    } };
  } } as unknown as FileSystemDirectoryEntry;
  const dt = paneTransfer([new File([], name)], [dir]);
  dt.items[0]!.webkitGetAsEntry = () => { entries++; return dir; };
  return { dt, get reads() { return reads; }, get entries() { return entries; },
    finish() { finished = true; const ok = release; release = undefined; ok?.([child]); } };
}

it('обычный drop добавляет файл до микрозадач, пустые перенос и вставка оставляют поле доступным', async () => {
  const restore = layout(false), toasts = await stores(h.server);
  try {
    await h.mount({});
    const before = toasts.getState().toasts.length;
    const empty = { ...paneTransfer([]), types: ['text/plain'], getData: () => 'обычный текст' };
    act(() => { paneEvent('dragenter', empty); });
    assert.equal(node<HTMLElement>('.chat').classList.contains('drag-over'), false);
    act(() => { assert.equal(paneEvent('paste', empty).defaultPrevented, false, 'текст остаётся браузерной вставкой'); });
    act(() => { assert.equal(paneEvent('drop', paneTransfer([])).defaultPrevented, true); });
    noFilesUi();
    const file = new File(['ordinary'], 'immediate.txt', { type: 'text/plain' }), dt = paneTransfer([file]);
    act(() => {
      assert.equal(paneEvent('drop', dt).defaultPrevented, true);
      // После события браузер очищает FileList, а очередь микрозадач ещё не исполнялась.
      dt.files.length = 0;
    });
    assert.equal(h.host.querySelector('.pending-atts')?.textContent?.includes(file.name), true,
      'реальный обработчик добавил обычный файл в этом же такте');
    assert.equal(toasts.getState().toasts.length, before);
    assert.equal(node<HTMLTextAreaElement>('.composer textarea').disabled, false);
  } finally { h.unmount(); restore(); }
});

it('бросок каталога показывает упаковку и отдаёт готовый ZIP окну отправки текущей беседы', async () => {
  folderIo();
  const restore = layout(false), toasts = await stores(h.server), folder = waitingFolder('same-feed');
  const sent: { files: File[] }[] = [];
  const outbox = { items: [], enqueue(item: { files: File[] }) { sent.push(item); }, retry() {}, discard() {} } as never;
  try {
    await h.mount({ feedId: 'folder-current', outbox });
    await act(async () => { paneEvent('dragenter', folder.dt); await h.flush(); });
    assert.equal(node<HTMLElement>('.chat').classList.contains('drag-over'), true);
    await act(async () => { assert.equal(paneEvent('drop', folder.dt).defaultPrevented, true); await h.flush(); });
    assert.equal(folder.entries, 1, 'настоящий onDrop прочитал FileSystemEntry');
    assert.equal(folder.reads, 1, 'упаковка ждёт синтетический readEntries');
    assert.equal(toasts.getState().toasts.at(-1)?.title, 'Упаковываю «same-feed»…');
    assert.equal(node<HTMLElement>('.chat').classList.contains('drag-over'), false);
    noFilesUi(); assert.equal(sent.length, 0);
    await act(async () => { folder.finish(); await h.flush(); });
    const box = document.querySelector('.sfb');
    assert.ok(box?.textContent?.includes('same-feed.zip'), 'ZIP принят тем же компонентом после окончания обхода');
    assert.equal(toasts.getState().toasts.some(t => t.sticky), false);
    assert.equal(sent.length, 0, 'готовый архив сам не отправляется');
    const send = box!.querySelector<HTMLButtonElement>('.sfb-go'); assert.ok(send);
    await act(async () => { send.click(); await h.flush(); });
    assert.equal(sent.length, 1); assert.equal(sent[0]!.files.length, 1);
    assert.equal(sent[0]!.files[0]!.name, 'same-feed.zip');
    assert.equal(sent[0]!.files[0]!.type, 'application/zip');
  } finally { h.unmount(); folder.finish(); await h.flush(); restore(); }
});

it('готовый ZIP после смены беседы отклоняется с объяснением, отменённый результат остаётся без тоста', async () => {
  folderIo();
  const restore = layout(false), toasts = await stores(h.server);
  const outbox = { items: [], enqueue() { assert.fail('смена беседы не отправляет архив'); }, retry() {}, discard() {} } as never;
  try {
    for (const cancel of [false, true]) {
      const folder = waitingFolder(cancel ? 'cancelled-feed' : 'stale-feed');
      try {
        await h.mount({ feedId: 'folder-before', outbox });
        await act(async () => { paneEvent('drop', folder.dt); await h.flush(); });
        assert.equal(folder.reads, 1);
        const packing = toasts.getState().toasts.at(-1)!; assert.equal(packing.sticky, true);
        await h.rerender({ feedId: 'folder-after', outbox });
        if (cancel) act(() => { toasts.getState().dismiss(packing.id); });
        const before = toasts.getState().toasts.length;
        await act(async () => { folder.finish(); await h.flush(); });
        noFilesUi();
        const added = toasts.getState().toasts.slice(cancel ? before : before - 1);
        assert.deepEqual(added.map(t => [t.type, t.title]), cancel ? [] : [
          ['info', 'Архив собран, но беседа уже другая — бросьте папку заново'],
        ], 'пустой результат не выдаёт ложное объяснение о готовом ZIP');
        // Новый бросок после смены беседы должен приниматься: ref не застрял на первом feedId.
        if (!cancel) {
          const current = waitingFolder('new-feed');
          try {
            await act(async () => { paneEvent('drop', current.dt); current.finish(); await h.flush(); });
            assert.ok(document.querySelector('.sfb')?.textContent?.includes('new-feed.zip'));
          } finally { h.unmount(); current.finish(); await h.flush(); }
        }
      } finally { h.unmount(); folder.finish(); await h.flush(); }
    }
  } finally { h.unmount(); restore(); }
});

it('запрет файлов и правка сообщения отвечают тостом до чтения каталога, включая вставку при правке', async () => {
  folderIo();
  const restore = layout(false), toasts = await stores(h.server);
  try {
    for (const editing of [false, true]) {
      const folder = waitingFolder(editing ? 'edit-folder' : 'blocked-folder');
      try {
        const own = h.msg('folder-edit');
        await h.mount({ messages: [own], ...(!editing ? { filesBlocked: hint } : {}) });
        if (editing) {
          const row = node<HTMLElement>('[data-mid="folder-edit"]');
          await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
          const edit = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(b => b.textContent?.trim() === 'Изменить');
          assert.ok(edit, 'правка включается настоящим меню строки');
          await act(async () => { edit.click(); await h.flush(); });
          assert.ok(h.host.querySelector('.edit-strip'));
        }
        const before = toasts.getState().toasts.length;
        await act(async () => { assert.equal(paneEvent('drop', folder.dt).defaultPrevented, true); await h.flush(); });
        assert.equal(folder.entries, 0, 'отказ не запускает даже webkitGetAsEntry');
        assert.equal(folder.reads, 0, 'до readEntries дело не дошло');
        assert.deepEqual(toasts.getState().toasts.slice(before).map(t => [t.type, t.title]), [
          ['info', editing ? 'Во время правки сообщения вложения не добавить' : hint],
        ]);
        noFilesUi();
        if (editing) {
          const beforePaste = toasts.getState().toasts.length;
          await act(async () => { assert.equal(paneEvent('paste', paneTransfer([new File(['x'], 'edit.txt')])).defaultPrevented, true); await h.flush(); });
          assert.equal(toasts.getState().toasts.length, beforePaste + 1);
          assert.equal(toasts.getState().toasts.at(-1)?.title, 'Во время правки сообщения вложения не добавить');
          assert.equal(node<HTMLTextAreaElement>('.composer textarea').value, own.content);
          noFilesUi();
        }
      } finally { h.unmount(); folder.finish(); await h.flush(); }
    }
  } finally { h.unmount(); restore(); }
});
