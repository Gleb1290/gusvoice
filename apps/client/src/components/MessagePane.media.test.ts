import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { act } from 'react';
import { Simulate } from 'react-dom/test-utils';
import type { Message } from '@gusvoice/shared';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);


it('счётчик прочитанного не пересекает видимую черту новых сообщений', async () => {
  // При первом визите лента может временно стоять у хвоста до прыжка к разделителю; нельзя отметить весь хвост прочитанным.
  h.round12(); let seen: number[] = [];
  const feedWindow = { hasOlder: false, hasNewer: true, unreadBelow: 0, loadNewer: async () => false, jumpLatest: async () => {},
    jumpTo: async () => true, place: null, onPlace: () => {}, readKey: 10 };
  await h.mount({ messages: [h.msg('seen-old', 'peer', 2000, 10), h.msg('seen-new', 'peer', 0, 20)], feedWindow,
    onSeen: key => { seen.push(key); }, scrollKey: 'seen-visit' });
  const list = h.host.querySelector<HTMLElement>('.messages'); const fresh = h.host.querySelector<HTMLElement>('[data-mid="seen-new"]');
  assert.ok(list, 'лента с отслеживанием прочтения доступна'); assert.ok(fresh, 'непрочитанная строка доступна');
  list.getBoundingClientRect = () => new DOMRect(0, 0, 400, 600);
  fresh.getBoundingClientRect = () => new DOMRect(0, 100, 360, 40);
  await h.flush();
  assert.ok(h.host.querySelector('.new-divider'), 'граница визита показана между старой и новой строкой');
  assert.deepEqual(seen, [], 'reportSeen не отмечает хвост, пока черта ещё управляет первым прыжком');
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
    Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: FakeClipboardItem });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async () => {} } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), credentials: init?.credentials });
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', { configurable: true, value: function (this: HTMLAnchorElement) {
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
    const phoneContext = new Event('contextmenu', { bubbles: true, cancelable: true }); Object.defineProperty(phoneContext, 'pointerType', { value: 'touch' });
    await act(async () => { phoneCell!.dispatchEvent(phoneContext); await h.flush(); });
    const phoneMenu = document.querySelector('.ctx-menu')?.textContent ?? '';
    assert.ok(!phoneMenu.includes('Копировать изображение') && !phoneMenu.includes('Сохранить как') && !phoneMenu.includes('Сохранить в галерею'), 'на телефоне без моста image actions не обещают неподдерживаемые действия');
  } finally {
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
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1920 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 1080 });
    Object.defineProperty(video, 'duration', { configurable: true, value: 12 });
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
  } finally { h.desktop(); restore(); }
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
    Object.defineProperty(window, 'GusVoiceMedia', { configurable: true, value: channel });
    Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: ImmediateObserver });
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
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: oldUa });
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
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
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
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
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
    Object.defineProperty(window, 'GusVoiceMedia', { configurable: true, value: channel });
    Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: ImmediateObserver });
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
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: oldUa });
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
  h.unmount(); h.desktop(); restorePointer();
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
  await h.mount({ messages: [photo] });
  const dmRow = h.host.querySelector<HTMLElement>('[data-mid="photo-strip"]'); assert.ok(dmRow, 'личный пузырь того же фото доступен для правки');
  await act(async () => { dmRow!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const edit = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Изменить'));
  assert.ok(edit, 'собственное фото разрешено редактировать'); await act(async () => { edit!.click(); await h.flush(); });
  assert.equal(h.host.querySelector('.edit-strip .rs-text')?.textContent, 'подпись к фото', 'полоса правки сохраняет подпись фото');
  assert.ok(h.host.querySelector('.edit-strip .rs-thumb'), 'полоса правки отличает фото миниатюрой');
  h.unmount(); h.desktop(); restore();
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
    Object.defineProperty(context, 'pointerType', { value: 'touch' });
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
    Object.defineProperty(input, 'files', { configurable: true, get: () => currentFiles });
    Object.defineProperty(input, 'value', { configurable: true, get: () => selected ? 'C:\\fakepath\\file.txt' : '', set: (value: string) => { if (!value) selected = false; } });
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
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
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
      Object.defineProperty(phoneInput, 'files', { configurable: true, value: [file] });
      await act(async () => { phoneInput!.dispatchEvent(new Event('change', { bubbles: true })); await h.flush(); });
      const phoneComposer = h.host.querySelector<HTMLTextAreaElement>('.composer textarea'); assert.ok(phoneComposer, 'телефонный composer сохранён после выбора');
      assert.ok(document.activeElement !== phoneComposer, 'на телефоне выбор файла не принудительно поднимает клавиатуру');
    } finally { restoreCoarse(); }
  } finally {
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
    input.addEventListener('click', (event) => { delivered++; events.push(event as MouseEvent); });
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
    Object.defineProperty(button, 'getBoundingClientRect', { configurable: true, value: () => ({ top, bottom: top + 30, left: 320, right: 360, width: 40, height: 30, x: 320, y: top, toJSON() {} }) });
    Object.defineProperty(composer, 'getBoundingClientRect', { configurable: true, value: () => ({ top: top - 20, bottom: top + 35, left: 0, right: 380, width: 380, height: 55, x: 0, y: top - 20, toJSON() {} }) });
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
  } finally { h.desktop(); restore(); }
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
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 2000 });
  Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
  Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 600 });
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
  Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 1000 + (Number.parseFloat(h.host.querySelector<HTMLElement>('.messages > :last-child')?.style.height ?? '') || 0) });
  Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (next: number) => { scrollTop = Math.min(next, list!.scrollHeight - list!.clientHeight); } });
  const rowTop = () => 200 + (h.host.querySelector('.messages')?.classList.contains('sel-mode') ? 40 : 0) - (scrollTop - 390);
  Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => ({ top: rowTop(), bottom: rowTop() + 40, left: 0, right: 320, width: 320, height: 40, x: 0, y: rowTop(), toJSON() {} }) });
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
