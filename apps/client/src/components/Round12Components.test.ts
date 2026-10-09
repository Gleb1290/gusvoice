import assert from 'node:assert/strict';
import { after, afterEach, before, it } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createServer, type ViteDevServer } from 'vite';
import { act, createElement, Fragment, type ComponentType } from 'react';
import type { Root } from 'react-dom/client';
import { MessagePort } from 'node:worker_threads';
import type { ConvMessage, ConvPin, ConvScheduled, DmCall, DmChannel, Message } from '@gusvoice/shared';

type PinProps = import('./PinnedBar').PinnedBarProps;
type ScheduleProps = import('./SchedPick').SchedPickProps;
type ScheduledProps = import('./ScheduledView').ScheduledViewProps;
type MediaSheetProps = import('./MediaSheet').MediaSheetProps;
type AppStore = typeof import('../store').useStore;
type PinsCallbacks = import('./MessagePane').MessagePins | undefined;
type DmPinsItem = { id: string; author: string; when: string; text: string };

let server: ViteDevServer;
let createRoot: typeof import('react-dom/client').createRoot;
let PinnedBar: ComponentType<PinProps>;
let SchedPick: ComponentType<ScheduleProps>;
let ScheduledView: ComponentType<ScheduledProps>;
let MediaSheet: ComponentType<MediaSheetProps>;
let MobileNav: ComponentType;
let MobileCallChip: ComponentType;
let ReplyQuote: ComponentType<{ author: string; text: string; kind?: import('../bubbleRules').ReplyKind }>;
let ForwardPicker: ComponentType<import('./ForwardPicker').ForwardPickerProps>;
let StickerPicker: ComponentType<Parameters<typeof import('./StickerPicker').StickerPicker>[0]>;
let GifPicker: ComponentType<Parameters<typeof import('./GifPicker').GifPicker>[0]>;
let Chat: ComponentType<{ dm: import('@gusvoice/shared').DmChannel }>;
let chatBatch: import('./MessagePane').MessageBatch | undefined;
let chatPins: PinsCallbacks;
let DmPinsList: ComponentType<{ items: readonly DmPinsItem[]; onOpen: (id: string) => void; onUnpin: (id: string) => void }>;
let PinnedMessages: ComponentType<{ channelId: string; canManage: boolean }>;
let store: AppStore;
let toasts: typeof import('../toast').useToasts;
let savedGifs: typeof import('../savedGifs');
let initial: ReturnType<AppStore['getState']>;
let root: Root | undefined;
let host: HTMLDivElement;
const mediaMock: {
  perm: 'granted' | 'partial' | 'ask' | 'blocked';
  permissionResult: 'granted' | 'partial' | 'ask' | 'blocked';
  camera: boolean;
  cameraSupported: boolean;
  galleryPageCalls: number;
  openCameraCalls: number;
  openCamera: () => Promise<unknown>;
} = {
  perm: 'granted', permissionResult: 'granted', camera: false, cameraSupported: false,
  galleryPageCalls: 0, openCameraCalls: 0, openCamera: async () => null,
};
Object.assign(globalThis, { __mediaSheetMock: mediaMock });
const callChipMock: { returned: unknown[]; errors: unknown[] } = { returned: [], errors: [] };
Object.assign(globalThis, { __mobileCallChipMock: callChipMock });
const nativeTimeout = globalThis.setTimeout;
const nativeInterval = globalThis.setInterval;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeClearInterval = globalThis.clearInterval;
const handles = () => (process as unknown as { _getActiveHandles(): object[] })._getActiveHandles();
let originalHandles: Set<object>;
const timers = new Set<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();
const testDm: DmChannel = {
  id: 'pins-dm', otherUser: { id: 'peer', username: 'peer', displayName: 'Собеседник', avatarUrl: null },
  createdAt: '2026-10-05T12:00:00.000Z', lastMessageAt: null,
};

async function flush(render?: () => void) {
  await act(async () => {
    render?.();
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

async function mount<P extends object>(component: ComponentType<P>, props: P): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await flush(() => root!.render(createElement(component, props)));
}

async function unmountMounted() {
  if (root) act(() => root!.unmount());
  root = undefined;
  host?.remove();
  await flush();
}

async function mountPinEnabledDm(patch: Partial<ReturnType<AppStore['getState']>> = {}) {
  localStorage.setItem('gv_dm_bubbles', '1');
  store.setState({
    ...initial,
    user: { id: 'me', username: 'me', displayName: 'Я', avatarUrl: null } as never,
    view: 'dm', mobilePane: 'content', currentDmId: 'pins-dm', dms: [testDm], dmMessages: { 'pins-dm': [] },
    convActive: true, serverFeatures: ['conv7'], onlineUsers: [], historyFailed: [], outbox: {}, drafts: {}, draftRev: {},
    conv: { ...initial.conv, pts: 50, phase: 'live', summaries: {} },
    readDmNow: () => {}, loadOlderDmMessages: async () => false,
    ...patch,
  });
  await mount(Chat, { dm: testDm });
  await flush();
}

async function mountMedia(sendMenu: MediaSheetProps['sendMenu']) {
  const sends: { how: Parameters<MediaSheetProps['onSend']>[2] }[] = [];
  let closed = 0;
  await mount(MediaSheet, { native: true, room: 10, caption: '', sendMenu,
    onSend: (_files, _caption, how) => sends.push({ how }), onAttach: () => {}, onSystemPick: () => {}, onClose: () => closed++ });
  await flush();
  const photo = document.body.querySelector<HTMLButtonElement>('.gal-cell[aria-label="Фото"]');
  assert.ok(photo, 'галерея отрисовала доступное тестовое фото');
  await flush(() => photo!.click());
  return { sends, get closed() { return closed; } };
}

before(async () => {
  originalHandles = new Set(handles());
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer = nativeTimeout(fn, ms, ...args); timers.add(timer); return timer;
  }) as typeof setTimeout;
  globalThis.setInterval = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer = nativeInterval(fn, ms, ...args); timers.add(timer); return timer;
  }) as typeof setInterval;
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => new Response(null, { status: 503 }),
    WebSocket: class ClosedSocket { static OPEN = 1; readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} },
  });
  createRoot = (await import('react-dom/client')).createRoot;
  server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    envFile: false,
    cacheDir: mkdtempSync(join(tmpdir(), 'gusvoice-round12-components-')),
    optimizeDeps: { noDiscovery: true, include: [] },
    esbuild: { jsx: 'automatic' },
    plugins: [
      { name: 'forward-silent-mutant', enforce: 'pre', transform(source, id) {
        if (!id.includes('/components/ForwardPicker.tsx?codex-silent-mutant')) return;
        const from = '{canSilent && (';
        assert.ok(source.includes(from), 'найден реальный запрет silent без capability');
        return source.replace(from, '{true && (');
      } },
      { name: 'forward-order-mutant', enforce: 'pre', transform(source, id) {
        if (!id.includes('/components/ForwardPicker.tsx?codex-order-mutant')) return;
        const from = 'const ids = [...pickedRef.current].sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));';
        assert.ok(source.includes(from), 'найден настоящий порядок отправки по списку бесед');
        return source.replace(from, 'const ids = [...pickedRef.current];');
      } },
      { name: 'forward-saved-send-mutant', enforce: 'pre', transform(source, id) {
        if (!id.includes('/components/ForwardPicker.tsx?codex-draft-mutant')) return;
        const from = 'if (d?.saved && id !== currentRef.current) {';
        assert.ok(source.includes(from), 'найдено исключение немедленной пересылки в Избранное');
        return source.replace(from, 'if (false) {');
      } },
      { name: 'docked-picker-escape-mutant', enforce: 'pre', transform(source, id) {
        if (!id.includes('?codex-dock-escape-mutant') || !/\/components\/(StickerPicker|GifPicker)\.tsx/.test(id)) return;
        source = source.replace(/\r\n/g, '\n');
        const from = 'useEffect(() => {\n    if (docked) return;\n    const onKey =';
        assert.ok(source.includes(from), 'найдена настоящая подписка Esc у docked-пикера');
        return source.replace(from, 'useEffect(() => {\n    if (false) return;\n    const onKey =');
      } },
      { name: 'autoplay-round-setting-mutant', enforce: 'pre', transform(source, id) {
        if (!id.includes('/components/DataStorageSettings.tsx?codex-round-setting-mutant')) return;
        const from = 'put({ autoplayRound: v })';
        assert.ok(source.includes(from), 'найден реальный переключатель видеосообщений');
        return source.replace(from, 'put({ autoplayGif: v })');
      } },
      { name: 'desktop-close-mutant', enforce: 'pre', transform(source, id) {
        if (!id.includes('/components/DesktopKeys.tsx?codex-close-mutant')) return;
        const from = 'window.dispatchEvent(new Event(CLOSE_REQUEST_EVENT));';
        assert.ok(source.includes(from), 'найден реальный маршрут Ctrl+W/F4 к настройке окна');
        return source.replace(from, 'void 0;');
      } },
      { name: 'call-back-mutant', enforce: 'pre', transform(source, id) {
        if (!id.includes('/components/CallLayer.tsx?codex-back-mutant')) return;
        const from = "const minimizable = !!peer && expanded && !ended && (view === 'outgoing' || view === 'active');";
        assert.ok(source.includes(from), 'найден гейт шага назад только для своего развёрнутого звонка');
        return source.replace(from, 'const minimizable = !!peer && expanded && !ended;');
      } },
      { name: 'shared-voice-kind-mutant', enforce: 'pre', transform(source, id) {
        if (!id.includes('/components/SharedMedia.tsx?codex-voice-kind-mutant')) return;
        const from = 'isRoundVideo(it.att!) ? <RoundVideo a={it.att!} meta={meta} autoplay={false} /> : <VoiceMessage a={it.att!} meta={meta} />';
        assert.ok(source.includes(from), 'найдено настоящее ветвление круглого видео и аудиоголосового');
        return source.replace(from, 'isRoundVideo(it.att!) ? <VoiceMessage a={it.att!} meta={meta} /> : <RoundVideo a={it.att!} meta={meta} autoplay={false} />');
      } },
      { name: 'stranger-add-action-mutant', enforce: 'pre', transform(source, id) {
        if (!id.includes('/components/StrangerBar.tsx?codex-no-add-mutant')) return;
        const from = '{onAdd && (';
        assert.ok(source.includes(from), 'найдено настоящее условие первой кнопки контактов');
        return source.replace(from, '{false && (');
      } },
      { name: 'capture-dm-batch', enforce: 'pre', transform(source, id) {
        const normalizedId = id.replaceAll('\\', '/');
        if (!normalizedId.includes('/components/DmChatView.tsx')) return;
        if (normalizedId.includes('?codex-forward-source-mutant')) {
          const from = 'const from = opts?.from ?? dm.id;';
          assert.ok(source.includes(from), 'найдено фактическое использование source черновика пересылки');
          source = source.replace(from, 'const from = dm.id;');
        }
        assert.ok(source.includes('batch={batch}'), 'найден проп пачки в настоящем DmChatView');
        assert.ok(source.includes('pins={pins}'), 'найден проп закрепов в настоящем DmChatView');
        return source.replace('batch={batch}', 'batch={((globalThis as any).__captureDmBatch(batch), batch)}')
          .replace('pins={pins}', 'pins={((globalThis as any).__captureDmPins(pins), pins)}');
      } },
      { name: 'media-sheet-test-bridge', enforce: 'pre', resolveId(source, importer) {
        if (!importer?.replaceAll('\\', '/').endsWith('/components/MediaSheet.tsx')) return;
        if (source === '../nativeMedia') return '\0media-sheet-test-native';
        if (source === '../cameraCapture') return '\0media-sheet-test-camera';
      }, load(id) {
        if (id === '\0media-sheet-test-native') return `
          export const cancelNativeFiles = () => {};
          export const galleryFiles = async () => ({ files: [new File(['photo'], 'photo.jpg', { type: 'image/jpeg' })], skipped: [] });
          const mock = () => globalThis.__mediaSheetMock;
          export const galleryPage = async () => { mock().galleryPageCalls++; return { items: [{ id: 'photo-1', kind: 'image', mime: 'image/jpeg', size: 5, width: 10, height: 10, durationMs: 0, added: 1, name: 'photo.jpg', rot: 0 }], end: true }; };
          export const galleryPermission = async () => mock().permissionResult;
          export const galleryThumb = async () => null;
          export const nativeMediaInfo = async () => ({ sdk: 35, perm: mock().perm, camera: mock().camera, canSave: true, asked: true });
          export const pickDocumentsNative = async () => [];
        `;
        if (id === '\0media-sheet-test-camera') return `
          export const cameraAllowedQuietly = async () => false;
          export const cameraCount = () => 0;
          export const cameraSupported = () => globalThis.__mediaSheetMock.cameraSupported;
          export const openCamera = (...args) => { globalThis.__mediaSheetMock.openCameraCalls++; return globalThis.__mediaSheetMock.openCamera(...args); };
          export const stopStream = () => {};
        `;
      } },
      { name: 'mobile-call-chip-test-bridge', enforce: 'pre', resolveId(source, importer) {
        const fromChip = importer?.replaceAll('\\', '/').endsWith('/components/MobileCallChip.tsx');
        if (!fromChip) return;
        if (source === './VoicePanel') return '\0mobile-call-chip-test-voice';
        if (source === '../toast') return '\0mobile-call-chip-test-toast';
      }, load(id) {
        if (id === '\0mobile-call-chip-test-voice') return `export const returnToVoice = (voice) => { globalThis.__mobileCallChipMock.returned.push(voice); };`;
        if (id === '\0mobile-call-chip-test-toast') return `export const toastError = (error) => { globalThis.__mobileCallChipMock.errors.push(error); };`;
      } },
    ],
    resolve: { alias: { '@gusvoice/shared': fileURLToPath(new URL('../../../../packages/shared/src/index.ts', import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    appType: 'custom',
    logLevel: 'error',
  });
  PinnedBar = (await server.ssrLoadModule('/src/components/PinnedBar.tsx')).PinnedBar;
  MediaSheet = (await server.ssrLoadModule('/src/components/MediaSheet.tsx')).MediaSheet;
  SchedPick = (await server.ssrLoadModule('/src/components/SchedPick.tsx')).SchedPick;
  ScheduledView = (await server.ssrLoadModule('/src/components/ScheduledView.tsx')).ScheduledView;
  ForwardPicker = (await server.ssrLoadModule('/src/components/ForwardPicker.tsx')).ForwardPicker;
  StickerPicker = (await server.ssrLoadModule('/src/components/StickerPicker.tsx')).StickerPicker;
  GifPicker = (await server.ssrLoadModule('/src/components/GifPicker.tsx')).GifPicker;
  MobileNav = (await server.ssrLoadModule('/src/components/MobileNav.tsx')).MobileNav;
  MobileCallChip = (await server.ssrLoadModule('/src/components/MobileCallChip.tsx')).MobileCallChip;
  ReplyQuote = (await server.ssrLoadModule('/src/components/MessageBubble.tsx')).ReplyQuote;
  store = (await server.ssrLoadModule('/src/store.ts')).useStore;
  toasts = (await server.ssrLoadModule('/src/toast.ts')).useToasts;
  savedGifs = await server.ssrLoadModule('/src/savedGifs.ts') as typeof import('../savedGifs');
  const pinsModule = await server.ssrLoadModule('/src/components/PinnedMessages.tsx');
  DmPinsList = pinsModule.DmPinsList;
  PinnedMessages = pinsModule.PinnedMessages;
  initial = store.getState();
  Object.assign(globalThis, { __captureDmBatch: (batch: typeof chatBatch) => {
    chatBatch = batch;
    (globalThis as unknown as { __currentDmBatch?: typeof chatBatch }).__currentDmBatch = batch;
  } });
  Object.assign(globalThis, { __captureDmPins: (pins: PinsCallbacks) => { chatPins = pins; } });
  Chat = (await server.ssrLoadModule('/src/components/DmChatView.tsx')).DmChatView;
});

const scheduleItem = (id: string, overrides: Partial<ConvScheduled> = {}): ConvScheduled => ({
  id, conversationId: 'pins-dm', clientId: `client-${id}`, content: `текст ${id}`, replyTo: null,
  sendAt: '2026-10-06T09:00:00.000Z', whenOnline: false, createdAt: '2026-10-05T12:00:00.000Z', editedAt: null,
  ...overrides,
});

afterEach(async () => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host?.remove();
  document.querySelectorAll('.sheet-scrim, .modal-overlay').forEach(node => node.remove());
  if (store && initial) store.setState(initial, true);
  localStorage.removeItem('gv_dm_bubbles');
  chatBatch = undefined;
  chatPins = undefined;
  if (toasts) toasts.setState({ toasts: [] });
  if (savedGifs) savedGifs.setSavedGifs({ gifs: [], search: false });
  mediaMock.perm = 'granted'; mediaMock.permissionResult = 'granted'; mediaMock.camera = false; mediaMock.cameraSupported = false;
  mediaMock.galleryPageCalls = 0; mediaMock.openCameraCalls = 0; mediaMock.openCamera = async () => null;
  Reflect.deleteProperty(document, 'visibilityState');
});

it('пересылка меняет беззвучность только при conv8, но повтор ошибки сохраняет clientId при смене флага', async () => {
  // Без поддержки сервера silent нельзя обещать; изменение галочки при повторе не создаёт дубль пересылки.
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const old = api.convForward; const calls: Parameters<typeof api.convForward>[1][] = [];
  let fail = true;
  api.convForward = async (_to, body) => { calls.push(body); if (fail) throw new Error('offline'); return { messages: [] }; };
  try {
    await mountPinEnabledDm({ serverFeatures: ['conv5', 'conv8'], convAfterForward: () => {} });
    assert.ok(chatBatch, 'новая беседа имеет пересылку');
    await assert.rejects(() => chatBatch!.forward(['silent-message'], 'silent-target', true), /offline/);
    assert.equal(calls[0].silent, true);
    fail = false;
    await chatBatch!.forward(['silent-message'], 'silent-target', false);
    assert.equal(calls[1].clientId, calls[0].clientId, 'silent не входит в отпечаток повтора');
    assert.equal(Object.hasOwn(calls[1], 'silent'), false);
    await flush(() => store.setState({ serverFeatures: ['conv5'] }));
    await chatBatch!.forward(['unsupported-silent'], 'silent-target', true);
    assert.equal(Object.hasOwn(calls[2], 'silent'), false, 'старому серверу не отправляется неподдерживаемый silent');
  } finally { api.convForward = old; }
});

async function checkForwardPicker(component: typeof ForwardPicker) {
  // Поиск по username не зависит от displayName; silent-меню исчезает при утрате capability.
  const selected: { id: string; silent: boolean }[] = [];
  const peer = { ...testDm, id: 'picker-peer', otherUser: { ...testDm.otherUser, username: 'goose_login', displayName: 'Синяя Стая' } };
  store.setState({ ...initial, dms: [peer, { ...testDm, id: 'picker-other' }], onlineUsers: [] });
  const props = { count: 2, canSilent: true, canLater: true, onSend: (ids: string[], opts: { silent: boolean }) => selected.push(...ids.map(id => ({ id, silent: opts.silent }))), onClose: () => {} };
  await mount(component, props);
  const input = host.querySelector<HTMLInputElement>('input.sheet-search');
  assert.ok(input, 'поисковое поле пересылки смонтировано');
  for (const query of ['@goose_login', 'goose_login', 'Синяя']) {
    await flush(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query); input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.ok(host.textContent?.includes('Синяя Стая'), `${query}: найдена беседа`);
    assert.ok(!host.textContent?.includes('Собеседник'), `${query}: посторонняя беседа отсеяна`);
  }
  const row = host.querySelector<HTMLButtonElement>('.dm-row');
  assert.ok(row, 'после поиска осталась доступная строка');
  await flush(() => row.click());
  await flush(() => host.querySelector<HTMLButtonElement>('.fwd-more')!.click());
  assert.ok([...document.querySelectorAll('.ctx-menu button')].some(b=>b.textContent?.includes('Отправить без звука')));
  await flush(() => root!.render(createElement(component, { ...props, canSilent: false })));
  assert.ok(![...document.querySelectorAll('.ctx-menu button')].some(b=>b.textContent?.includes('Отправить без звука')), 'пункт исчез без capability');
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  await flush(() => host.querySelector<HTMLButtonElement>('.fwd-send')!.click());
  assert.deepEqual(selected, [{ id: 'picker-peer', silent: false }]);
}

it('изображение и видео как файлы рисуются карточками, обычное фото остаётся кадром', async () => {
  // Ловит правильное правило пузыря, которое не дошло до реального AttachmentView.
  const { AttachmentView } = await server.ssrLoadModule('/src/components/AttachmentView.tsx') as typeof import('./AttachmentView');
  const a={url:'/a.png',name:'a.png',contentType:'image/png',size:1,width:100,height:100,asFile:true as const};
  for(const contentType of ['image/png','video/mp4']) {
    await mount(AttachmentView,{a:{...a,contentType}});
    assert.ok(host.querySelector('.att-file'),'рисуется карточка файла');
    assert.ok(!host.querySelector('.att-img-link,.att-video'),'кадра нет');
    await unmountMounted();
  }
  await mount(AttachmentView,{a:{...a,asFile:undefined}});
  assert.ok(host.querySelector('.att-img-link'),'без флага фото остаётся кадром');
});

it('ForwardPicker ищет логин с @ и без, имя; потеря canSilent убирает беззвучную отправку из меню', async () => {
  // Отмеченное состояние переживает rerender: тот же сценарий должен отвергнуть модуль без проверки canSilent.
  await checkForwardPicker(ForwardPicker);
  await unmountMounted();
  const { ForwardPicker: bad } = await server.ssrLoadModule('/src/components/ForwardPicker.tsx?codex-silent-mutant');
  await assert.rejects(() => checkForwardPicker(bad), assert.AssertionError);
});

it('ForwardPicker отправляет выбранные беседы в порядке списка, а не щелчков', async () => {
  // При старом алгоритме B, отмеченная первой, уезжала впереди A, хотя в списке она ниже.
  const check = async (component: typeof ForwardPicker) => {
    const a = { ...testDm, id: 'forward-A', otherUser: { ...testDm.otherUser, id: 'user-A', username: 'a', displayName: 'A' } };
    const b = { ...testDm, id: 'forward-B', otherUser: { ...testDm.otherUser, id: 'user-B', username: 'b', displayName: 'B' } };
    store.setState({ ...initial, dms: [a, b], convActive: false, currentDmId: null, user: { id: 'me' } as never });
    let actual = '';
    await mount(component, { count: 1, initial: ['forward-B'], onSend: (ids: string[]) => { actual = ids.join(','); }, onClose: () => {} });
    const rows = [...host.querySelectorAll<HTMLButtonElement>('.dm-row')];
    assert.equal(rows.length, 2, 'обе беседы присутствуют в исходном порядке');
    await flush(() => rows[0]!.click());
    await flush(() => host.querySelector<HTMLButtonElement>('.fwd-send')!.click());
    assert.equal(actual, 'forward-A,forward-B', 'отправляются A и B по порядку списка');
  };
  await check(ForwardPicker);
  await unmountMounted();
  const { ForwardPicker: bad } = await server.ssrLoadModule('/src/components/ForwardPicker.tsx?codex-order-mutant');
  await assert.rejects(() => check(bad), assert.AssertionError, 'мутант порядка кликов отправил бы B,A');
});

async function checkForwardDraftPicker(component: typeof ForwardPicker) {
  // Один клик — черновик, а правый клик/последующие клики — выбор адресатов; «Избранное» всегда отправляется сразу.
  const a = { ...testDm, id: 'draft-A', otherUser: { ...testDm.otherUser, id: 'user-A', username: 'a', displayName: 'Алиса' } };
  const b = { ...testDm, id: 'draft-B', otherUser: { ...testDm.otherUser, id: 'user-B', username: 'b', displayName: 'Борис' } };
  const saved = { ...testDm, id: 'draft-saved', saved: true, otherUser: { id: 'me', username: 'me', displayName: 'Избранное', avatarUrl: null } };
  const drafts: string[] = [];
  const sends: string[][] = [];
  let closes = 0;
  const props = { count: 2, onSend: (ids: string[]) => sends.push([...ids]), onDraft: (id: string) => drafts.push(id), onClose: () => { closes++; } };
  const open = async () => {
    store.setState({ ...initial, dms: [a, b, saved], currentDmId: 'current', convActive: true, serverFeatures: ['saved1'], user: { id: 'me' } as never });
    await mount(component, props);
  };
  const row = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.fwd-pick .dm-row')].find((item) => item.textContent?.includes(name));

  await open();
  const aRow = row('Алиса'); assert.ok(aRow);
  await flush(() => aRow!.click());
  assert.deepEqual(drafts, ['draft-A'], 'обычный клик начинает черновик для беседы');
  assert.deepEqual(sends, [], 'обычный клик не пересылает немедленно');
  assert.equal(closes, 1, 'окно закрывается после выбора одной беседы');
  await unmountMounted();

  await open();
  const savedRow = row('Избранное'); assert.ok(savedRow);
  await flush(() => savedRow!.click());
  assert.deepEqual(sends, [['draft-saved']], 'выбор Избранного из другой беседы отправляет сразу');
  assert.equal(drafts.length, 1, 'для Избранного черновик не создаётся');
  await unmountMounted();

  const sendStart = sends.length;
  await open();
  const aToSelect = row('Алиса'); assert.ok(aToSelect);
  await flush(() => aToSelect!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })));
  assert.ok(host.querySelector('.fwd-foot'), 'правый клик включает множественный выбор и показывает подвал');
  assert.equal(drafts.length, 1, 'контекстный выбор не заменяется черновиком');
  const bToSelect = row('Борис'); assert.ok(bToSelect);
  await flush(() => bToSelect!.click());
  assert.ok(host.querySelector('.fwd-foot'), 'следующий обычный клик переключает галочку');
  await flush(() => host.querySelector<HTMLButtonElement>('.fwd-send')!.click());
  assert.deepEqual(sends.slice(sendStart), [['draft-A', 'draft-B']], 'отправляются отмеченные адресаты в порядке списка');
}

it('ForwardPicker различает черновик одного клика, «Избранное» и правый клик для пачки', async () => {
  await checkForwardDraftPicker(ForwardPicker);
  await unmountMounted();
  const { ForwardPicker: bad } = await server.ssrLoadModule('/src/components/ForwardPicker.tsx?codex-draft-mutant');
  await assert.rejects(() => checkForwardDraftPicker(bad), assert.AssertionError, 'мутант превращает немедленную отправку в Избранное в черновик');
});

async function checkDockPickers(stickerComponent: typeof StickerPicker, gifComponent: typeof GifPicker) {
  const sticker = { id: 'dock-sticker', emoji: '🦆', url: '/duck.webp', format: 'webp' as const };
  const stickerPicks: string[] = []; let stickerCloses = 0;
  try {
  await mount(stickerComponent, { anchor: new DOMRect(100, 100, 20, 20), packs: [{ id: 'pack', name: 'pack', title: 'Набор', stickers: [sticker] }],
    docked: true, footer: createElement('div'), onPick: (value) => stickerPicks.push(value.id), onClose: () => { stickerCloses++; } });
  const stickerPop = host.querySelector<HTMLElement>('.sticker-pop.docked'); assert.ok(stickerPop);
  assert.equal(host.querySelector('.emoji-backdrop'), null); assert.equal(stickerPop!.hasAttribute('style'), false);
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(stickerCloses, 0, 'Esc не закрывает закреплённый пикер стикеров');
  await flush(() => host.querySelector<HTMLButtonElement>('.sticker-cell')!.click());
  assert.deepEqual(stickerPicks, ['dock-sticker']); assert.ok(host.querySelector('.sticker-pop.docked'), 'выбор не закрывает колонку');
  await unmountMounted();

  const gif = { id: 'dock-gif', url: '/duck.gif', contentType: 'image/gif', size: 5, width: 20, height: 20, durationMs: 0 };
  savedGifs.setSavedGifs({ gifs: [gif], search: true });
  const gifPicks: string[] = []; let gifCloses = 0;
  await mount(gifComponent, { anchor: new DOMRect(100, 100, 20, 20), docked: true, footer: createElement('div'),
    onPick: (value) => gifPicks.push(value.gif.id), onClose: () => { gifCloses++; } });
  await flush();
  const gifPop = host.querySelector<HTMLElement>('.gif-pop.docked'); assert.ok(gifPop);
  assert.equal(host.querySelector('.emoji-backdrop'), null); assert.equal(gifPop!.hasAttribute('style'), false);
  const gifSearch = host.querySelector<HTMLInputElement>('.gif-pop .emoji-search input'); assert.ok(gifSearch, 'фикстура внешнего поиска показывает поле');
  assert.notEqual(document.activeElement, gifSearch, 'поиск не забирает фокус у композера');
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(gifCloses, 0, 'Esc не закрывает закреплённый GIF-пикер');
  await flush(() => host.querySelector<HTMLButtonElement>('.gif-cell')!.click());
  assert.deepEqual(gifPicks, ['dock-gif']); assert.ok(host.querySelector('.gif-pop.docked'), 'выбор не закрывает колонку');
  } finally { await unmountMounted(); }
}

it('закреплённые стикеры и GIF не создают поповер и не закрываются по Esc или выбору', async () => {
  // Эмодзи проверен через реальный MessagePane; эти две соседние вкладки имеют отдельные handlers и не должны терять dock-контракт.
  await checkDockPickers(StickerPicker, GifPicker);
  const { StickerPicker: badSticker } = await server.ssrLoadModule('/src/components/StickerPicker.tsx?codex-dock-escape-mutant');
  await assert.rejects(() => checkDockPickers(badSticker, GifPicker), assert.AssertionError, 'мутант подписывает docked StickerPicker на Esc');
  const { GifPicker: badGif } = await server.ssrLoadModule('/src/components/GifPicker.tsx?codex-dock-escape-mutant');
  await assert.rejects(() => checkDockPickers(StickerPicker, badGif), assert.AssertionError, 'мутант подписывает docked GifPicker на Esc');
});

it('переключатель видеосообщений меняет autoplayRound отдельно от GIF', async () => {
  // Настройка должна управлять кругами через собственное поле, а не незаметно выключать GIF.
  const { DataStorageSettings } = await server.ssrLoadModule('/src/components/DataStorageSettings.tsx') as typeof import('./DataStorageSettings');
  const auto = await server.ssrLoadModule('/src/autoDownload.ts') as typeof import('../autoDownload');
  const check = async (component: typeof DataStorageSettings) => {
    auto.resetAutoDownload();
    try {
      await mount(component, {});
      const gif = host.querySelector<HTMLButtonElement>('[aria-label="Автовоспроизведение GIF"]'); assert.ok(gif);
      const round = host.querySelector<HTMLButtonElement>('[aria-label="Автовоспроизведение видеосообщений"]'); assert.ok(round);
      assert.equal(auto.getAutoDownload().autoplayRound, true, 'кружки включены исходной настройкой');
      await flush(() => gif!.click());
      assert.equal(auto.getAutoDownload().autoplayGif, false, 'нажатие GIF меняет только GIF');
      assert.equal(auto.getAutoDownload().autoplayRound, true, 'GIF не трогает автоплей кругов');
      await flush(() => round!.click());
      assert.equal(auto.getAutoDownload().autoplayRound, false, 'переключатель кругов записывает autoplayRound=false');
      assert.equal(auto.getAutoDownload().autoplayGif, false, 'переключатель кругов не меняет GIF');
      await flush(() => round!.click());
      assert.equal(auto.getAutoDownload().autoplayRound, true, 'повторный клик включает круги');
    } finally { await unmountMounted(); }
  };
  await check(DataStorageSettings);
  await unmountMounted();
  const { DataStorageSettings: bad } = await server.ssrLoadModule('/src/components/DataStorageSettings.tsx?codex-round-setting-mutant');
  await assert.rejects(() => check(bad), assert.AssertionError, 'мутант сохраняет переключатель кругов в autoplayGif');
  auto.resetAutoDownload();
});

it('Ctrl+W и Ctrl+F4 проходят через выбор закрытия окна, а не прячут его сами', async () => {
  // На настройке «спросить» хоткей должен показать тот же выбор, что и X; кнопки выбора вызывают только свой native action.
  const internals = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
  const tauri = Object.getOwnPropertyDescriptor(window, '__TAURI__');
  const calls: string[] = [];
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  Object.defineProperty(window, '__TAURI__', { configurable: true, value: { core: { invoke: async (cmd: string) => { calls.push(cmd); } } } });
  localStorage.removeItem('gv_close_behavior');
  const { DesktopKeysHost } = await server.ssrLoadModule('/src/components/DesktopKeys.tsx') as typeof import('./DesktopKeys');
  const { CloseToTrayPrompt } = await server.ssrLoadModule('/src/components/CloseToTrayPrompt.tsx') as typeof import('./CloseToTrayPrompt');
  const check = async (keys: typeof DesktopKeysHost, prompt: typeof CloseToTrayPrompt) => {
    calls.length = 0; localStorage.removeItem('gv_close_behavior');
    const Pair = () => createElement(Fragment, null, createElement(keys), createElement(prompt));
    try {
      await mount(Pair, {});
      const key = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, cancelable: true });
      await flush(() => window.dispatchEvent(key));
      assert.equal(key.defaultPrevented, true, 'Ctrl+W обработан в desktop shell');
      assert.ok(host.querySelector('.close-choice'), 'режим ask показывает «Закрыть GusVoice?»');
      assert.equal(calls.length, 0, 'до выбора не было ни hide, ни quit');
      await flush(() => host.querySelector<HTMLButtonElement>('.close-card:not(.on)')!.click());
      const quit = host.querySelector<HTMLButtonElement>('.close-choice .modal-actions button:last-child'); assert.ok(quit);
      await flush(() => quit!.click());
      await flush(); assert.ok(calls.includes('gv_app_quit'), 'выбор «Выйти» вызывает native quit');
    } finally { await unmountMounted(); }
  };
  try {
    await check(DesktopKeysHost, CloseToTrayPrompt);
    const { DesktopKeysHost: bad } = await server.ssrLoadModule('/src/components/DesktopKeys.tsx?codex-close-mutant');
    await assert.rejects(() => check(bad, CloseToTrayPrompt), assert.AssertionError, 'мутант теряет общий маршрут к prompt');

    calls.length = 0; localStorage.setItem('gv_close_behavior', 'tray');
    const Pair = () => createElement(Fragment, null, createElement(DesktopKeysHost), createElement(CloseToTrayPrompt));
    await mount(Pair, {});
    const f4 = new KeyboardEvent('keydown', { key: 'F4', code: 'F4', ctrlKey: true, bubbles: true, cancelable: true });
    await flush(() => window.dispatchEvent(f4)); await flush();
    assert.ok(calls.includes('gv_window_hide'), 'Ctrl+F4 выполняет сохранённый выбор «в трей»');
    assert.equal(host.querySelector('.close-choice'), null, 'сохранённое решение не задаёт вопрос повторно');
  } finally {
    await unmountMounted(); localStorage.removeItem('gv_close_behavior');
    if (internals) Object.defineProperty(window, '__TAURI_INTERNALS__', internals); else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    if (tauri) Object.defineProperty(window, '__TAURI__', tauri); else Reflect.deleteProperty(window, '__TAURI__');
  }
});

it('Назад сворачивает свой развёрнутый звонок, но не входящий, свёрнутый или завершённый', async () => {
  // Внутренний экран активного/исходящего звонка сворачивается на месте; чужой звонок остаётся хозяином ответа.
  const { CallLayer } = await server.ssrLoadModule('/src/components/CallLayer.tsx') as typeof import('./CallLayer');
  const { CallBar } = await server.ssrLoadModule('/src/components/CallLayer.tsx') as typeof import('./CallLayer');
  const { useCall, CALL_DEVICE } = await server.ssrLoadModule('/src/callStore.ts') as typeof import('../callStore');
  const { stepBack } = await server.ssrLoadModule('/src/androidBack.ts') as typeof import('../androidBack');
  await flush(() => store.setState({ ...initial, user: { id: 'me' } as never, dms: [testDm], mobilePane: 'list' }));
  const ringing: DmCall = { id: 'call-1', conversationId: testDm.id, callerId: 'me', calleeId: 'peer', phase: 'ringing', createdAt: new Date().toISOString(), callerDevice: CALL_DEVICE };
  const active: DmCall = { ...ringing, phase: 'active', answeredAt: new Date().toISOString() };
  const start = async (call: DmCall, component: typeof CallLayer = CallLayer) => {
    await flush(() => { useCall.setState({ call: null, peer: null, ended: null, join: null, expanded: true }); useCall.getState().apply(call); });
    const Pair = () => createElement(Fragment, null, createElement(component), createElement(CallBar));
    await mount(Pair, {}); await flush();
  };
  const back = async () => { let handled = false; await flush(() => { handled = stepBack(); }); return handled; };
  try {
    await start(ringing); assert.equal(await back(), true, 'исходящий вызов регистрирует шаг назад');
    await flush(); assert.equal(useCall.getState().expanded, false); assert.ok(host.querySelector('.call-bar'), 'свёрнутый звонок остаётся в полосе');
    await unmountMounted();

    await start(active); assert.equal(await back(), true, 'разговор тоже можно свернуть');
    assert.equal(useCall.getState().expanded, false);
    await unmountMounted();

    const incoming: DmCall = { ...ringing, callerId: 'peer', calleeId: 'me', callerDevice: 'peer-device' };
    await start(incoming); assert.equal(await back(), false, 'входящий звонок не перехватывает Back');
    assert.equal(useCall.getState().expanded, true); assert.ok(host.querySelector('.call-screen'));
    await unmountMounted();

    await start(ringing); await flush(() => useCall.getState().setExpanded(false)); await unmountMounted();
    const Pair = () => createElement(Fragment, null, createElement(CallLayer), createElement(CallBar));
    await mount(Pair, {}); assert.equal(await back(), false, 'уже свёрнутый звонок не регистрирует обработчик');
    await unmountMounted();

    await start(ringing);
    await flush(() => useCall.getState().apply({ ...ringing, phase: 'ended', reason: 'hangup' }));
    await unmountMounted(); await mount(Pair, {});
    assert.equal(await back(), false, 'завершённый звонок не регистрирует обработчик');
    await unmountMounted();

    const { CallLayer: bad } = await server.ssrLoadModule('/src/components/CallLayer.tsx?codex-back-mutant');
    const incomingHasNoBack = async (component: typeof CallLayer) => {
      try { await start(incoming, component); assert.equal(await back(), false, 'входящий вызов не сворачивается Back'); }
      finally { await unmountMounted(); }
    };
    await incomingHasNoBack(CallLayer);
    await assert.rejects(() => incomingHasNoBack(bad), assert.AssertionError, 'мутант добавляет Back входящему звонку');
  } finally {
    await unmountMounted(); useCall.setState({ call: null, peer: null, ended: null, join: null, expanded: true });
  }
});

it('общие голосовые показывают видеосообщение кружком, а аудиоголосовое — плеером', async () => {
  // Ищем классификацию на настоящем VoiceRow: одна лишь проверка вида в sharedMediaRules не ловит перепутанный JSX.
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const { openSharedMedia, SharedMediaHost } = await server.ssrLoadModule('/src/components/SharedMedia.tsx') as typeof import('./SharedMedia');
  const countsBefore = Object.getOwnPropertyDescriptor(api, 'convMediaCounts');
  const mediaBefore = Object.getOwnPropertyDescriptor(api, 'convMedia');
  const now = '2026-10-08T12:00:00.000Z';
  const makeMessage = (id: string, attachment: ConvMessage['attachments'][number]) => ({
    id, conversationId: 'round-voice-test', channelId: 'round-voice-test', content: '', createdAt: now,
    author: { id: 'peer', username: 'peer', displayName: 'Собеседник', avatarUrl: null }, attachments: [attachment],
    editedAt: null, reactions: [], replyTo: null, sortKey: id === 'circle' ? 2 : 1, clientId: null,
  } as unknown as ConvMessage);
  const messages = [
    makeMessage('circle', { id: 'circle-att', url: '/circle.webm', name: 'circle.webm', contentType: 'video/webm', size: 8, width: 384, height: 384, durationMs: 3000, round: true }),
    makeMessage('voice', { id: 'voice-att', url: '/voice.ogg', name: 'voice.ogg', contentType: 'audio/ogg', size: 8, durationMs: 3000, waveform: [10, 80, 20] }),
  ];
  const check = async (hostComponent: typeof SharedMediaHost) => {
    Object.assign(api, {
      convMediaCounts: async () => ({ media: 0, file: 0, link: 0, gif: 0, voice: 2 }),
      convMedia: async () => ({ messages, next: null }),
    });
    await flush(() => store.setState({ ...initial, user: { id: 'me' } as never, convActive: true, serverFeatures: ['media1'] }));
    openSharedMedia('round-voice-test', 'voice');
    await mount(hostComponent, {});
    await flush(); await flush();
    const rows = [...host.querySelectorAll<HTMLElement>('.smedia-voice')];
    assert.equal(rows.length, 2, 'список общих голосовых содержит оба серверных элемента');
    const circle = rows.find(row => row.textContent?.includes('Собеседник') && row.querySelector('video'));
    const voice = rows.find(row => row.querySelector('.voice-msg'));
    assert.ok(circle?.querySelector('.round-msg'), 'кружок в общей медиатеке сохраняет круглый плеер');
    assert.equal(circle?.querySelector<HTMLVideoElement>('.round-msg-video')?.autoplay, false, 'в общей медиатеке кружок не запускается сам');
    assert.ok(!circle?.querySelector('.voice-msg'), 'кружок не подменён аудиоплеером');
    assert.ok(voice?.querySelector('.voice-msg'), 'аудиоголосовое сохраняет волновой плеер');
    assert.ok(!voice?.querySelector('.round-msg'), 'аудиоголосовое не подменено видеокружком');
  };
  try {
    await check(SharedMediaHost);
    await unmountMounted();
    const { SharedMediaHost: bad } = await server.ssrLoadModule('/src/components/SharedMedia.tsx?codex-voice-kind-mutant');
    await assert.rejects(() => check(bad), assert.AssertionError, 'мутант меняет местами круг и аудиоголосовое');
  } finally {
    await unmountMounted();
    if (countsBefore) Object.defineProperty(api, 'convMediaCounts', countsBefore); else Reflect.deleteProperty(api, 'convMediaCounts');
    if (mediaBefore) Object.defineProperty(api, 'convMedia', mediaBefore); else Reflect.deleteProperty(api, 'convMedia');
    await flush(() => store.setState(initial));
  }
});

it('шапка при запрете звонка объясняет отказ, а 403 открывает то же окно', async () => {
  // В R96 трубка намеренно остаётся видна: проверяем реальный клик до API и ту же справку после серверного отказа.
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const { ConfirmHost } = await server.ssrLoadModule('/src/components/ConfirmHost.tsx') as typeof import('./ConfirmHost');
  const priorSeen = api.userLastSeen, priorStart = api.callStart;
  let canCall = false;
  let starts = 0;
  api.userLastSeen = async userId => ({ userId, online: false, at: null, approx: 'long', exact: false, byMe: false, canCall });
  api.callStart = async () => { starts++; throw new Error('call_privacy'); };
  const check = async (shouldDeny: boolean) => {
    await flush(() => store.setState({ ...initial, user: { id: 'me', username: 'me', displayName: 'Я', avatarUrl: null } as never,
      view: 'dm', mobilePane: 'content', currentDmId: testDm.id, dms: [testDm], dmMessages: { [testDm.id]: [] },
      convActive: true, serverFeatures: ['conv5', 'calls1', 'lastseen1', 'presence4'], onlineUsers: [], dmOnlineUsers: [] }));
    const Pair = () => createElement(Fragment, null, createElement(Chat, { dm: testDm }), createElement(ConfirmHost));
    await mount(Pair, {});
    await new Promise<void>(resolve => setTimeout(resolve, 5)); await flush();
    const button = host.querySelector<HTMLButtonElement>('.topbar-btn[aria-label="Позвонить"]');
    assert.ok(button, 'трубка остаётся доступна при любой политике пользователя');
    await flush(() => button!.click());
    if (shouldDeny) assert.equal(starts, 0, 'известное ограничение не стучится в call.start');
    else assert.equal(starts, 1, 'разрешённая попытка доходит до API и получает 403');
    const dialog = host.querySelector('[role="alertdialog"]');
    assert.ok(dialog, 'известный запрет и ответ 403 открывают окно вместо тоста');
    assert.equal(dialog.querySelector('h2')?.textContent, 'Позвонить нельзя');
    assert.match(dialog.textContent ?? '', /Собеседник ограничил\(а\) звонки/);
    await flush(() => dialog.querySelector<HTMLButtonElement>('.confirm-primary')!.click());
    await unmountMounted();
  };
  try {
    canCall = false; await check(true);
    canCall = true; await check(false);
    const source = readFileSync(new URL('./DmChatView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const match = source.match(/const callsOn =\s*([\s\S]*?);\s*const callsDenied/);
    assert.ok(match, 'найдено действующее условие показа трубки в DmChatView');
    const base = match![1]!.trim();
    const mutant = base.replace('&& !blocked', '&& !blocked && lastSeen?.canCall !== false');
    assert.notEqual(mutant, base, 'мутант восстанавливает удалённое скрытие трубки');
    const enabled = (expr: string, denied: boolean) => runInNewContext(`Boolean(${expr})`, {
      useStore: (select: (state: { convActive: boolean; serverFeatures: string[] }) => unknown) => select({ convActive: true, serverFeatures: ['calls1'] }),
      serverCalls: () => true, group: false, saved: false, former: false, blocked: false,
      lastSeen: { canCall: denied ? false : true },
    }) as boolean;
    assert.equal(enabled(base, true), true, 'исходное условие оставляет объясняющую трубку');
    assert.equal(enabled(mutant, false), true, 'мутант с разрешением проходит контроль');
    assert.equal(enabled(mutant, true), false, 'исполняемый мутант скрывает трубку при canCall=false');
  } finally { await unmountMounted(); api.userLastSeen = priorSeen; api.callStart = priorStart; await flush(() => store.setState(initial)); }
});

it('StrangerBar ставит «Добавить в контакты» первой и сохраняет жалобу в телефоне через меню беседы', async () => {
  // Кнопка добавления должна быть главным действием, а телефонная жалоба не должна занимать третье место в тесной плашке.
  const source = readFileSync(new URL('./DmChatView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /MenuItem[\s\S]*?label="Пожаловаться"[\s\S]*?onClick=\{\(\) => \{[\s\S]*?setReportOpen\(true\)/,
    'мобильный пункт «Пожаловаться» открывает то же окно из меню беседы');
  const { StrangerBar } = await server.ssrLoadModule('/src/components/StrangerBar.tsx') as typeof import('./StrangerBar');
  let added = 0, reported = 0;
  const check = async (component: typeof StrangerBar) => {
    await mount(component, { peerName: 'Собеседник', onAdd: () => added++, onReport: () => reported++, onBlock: () => {}, onHide: () => {} });
    const actions = [...host.querySelectorAll<HTMLButtonElement>('.stranger-bar-actions button')];
    assert.equal(actions[0]?.textContent?.trim(), 'Добавить в контакты', 'добавление стоит перед жалобой и блокировкой');
    assert.match(actions[1]?.textContent ?? '', /Пожаловаться/, 'пожаловаться можно и при включённых контактах');
    await flush(() => actions[0]!.click());
    await flush(() => actions[1]!.click());
    assert.equal(added, 1, 'первая кнопка вызывает добавление');
    assert.equal(reported, 1, 'кнопка жалобы вызывает обработчик');
  };
  await check(StrangerBar);
  await unmountMounted();
  const { StrangerBar: bad } = await server.ssrLoadModule('/src/components/StrangerBar.tsx?codex-no-add-mutant');
  await assert.rejects(() => check(bad), assert.AssertionError, 'мутант теряет первое действие «Добавить в контакты»');
});

it('на телефоне время поверх фото отложенного открывает меню этого сообщения', async () => {
  // Для фото тап по самому кадру открывает просмотр, поэтому время — отдельный доступный вход в меню.
  const previous = window.matchMedia;
  window.matchMedia = query => {
    const mq = previous.call(window, query);
    Object.defineProperty(mq, 'matches', { configurable: true, value: query.includes('pointer: coarse') || query.includes('max-width: 760px') || query.includes('max-width: 620px') });
    return mq;
  };
  try {
    const item = scheduleItem('meta-tap', { content: '', sendAt: new Date(Date.now() + 60_000).toISOString(),
      attachments: [{ id: 'meta-photo', url: '/photo', contentType: 'image/png', name: 'photo.png', size: 1, width: 16, height: 12 }] });
    await mount(ScheduledView, { items: [item], peerName: 'Собеседник', me: { name: 'Я', avatarUrl: null },
      onBack: () => {}, create: async () => {}, sendNow: async () => {}, reschedule: async () => {}, edit: async () => {}, remove: async () => {} });
    const meta = host.querySelector<HTMLElement>('.bub-meta.over'); assert.ok(meta, 'время на пустом фото видно');
    const tap = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(tap, 'sourceCapabilities', { value: { firesTouchEvents: true } });
    await flush(() => meta.dispatchEvent(tap));
    assert.ok(document.querySelector('.ctx-menu'), 'время открывает действия отложенного');
    assert.ok(!document.querySelector('.lightbox'), 'тап по времени не проваливается в просмотр фото');
  } finally { window.matchMedia = previous; }
});

it('пачка DmChatView вызывает API бесед; повтор сбоя пересылки сохраняет clientId, успех обновляет стор', async () => {
  // Ловит потерю идемпотентности после ошибки сети и рассинхрон API→стор при успешной пересылке/удалении.
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const oldForward = api.convForward, oldDelete = api.convDeleteMany;
  const calls: { to: string; body: Parameters<typeof api.convForward>[1] }[] = [];
  const afterForward: unknown[] = [], afterDelete: unknown[] = [], deletes: unknown[] = [];
  const dm = { id: 'source', otherUser: { id: 'peer', username: 'peer', displayName: 'Собеседник', avatarUrl: null },
    createdAt: new Date().toISOString(), lastMessageAt: null, unread: 0 };
  let failing = true;
  api.convForward = async (to, body) => { calls.push({ to, body }); if (failing) throw new Error('network'); return { messages: [] }; };
  api.convDeleteMany = async (...args) => { deletes.push(args); };
  localStorage.setItem('gv_dm_bubbles', '1');
  try {
    store.setState({ ...initial, user: { id: 'me', username: 'me', displayName: 'Я', avatarUrl: null } as never,
      convActive: true, serverFeatures: ['conv5', 'conv6'], dmMessages: { source: [] },
      convAfterForward: (to, messages) => { afterForward.push([to, messages]); },
      convAfterDeleteMany: (id, ids) => { afterDelete.push([id, ids]); }, loadOlderDmMessages: async () => false });
    await mount(Chat, { dm });
    const batch = chatBatch;
    assert.ok(batch, 'сервер conv5 даёт настоящую пачку в MessagePane');
    await assert.rejects(() => batch.forward(['m1', 'm2'], 'target'), /network/);
    assert.deepEqual(afterForward, [], 'при ошибке стор не обещает пересылку');
    failing = false;
    await batch.forward(['m1', 'm2'], 'target');
    assert.equal(calls[0].body.clientId, calls[1].body.clientId, 'повтор не создаёт новые сообщения на сервере');
    assert.deepEqual(calls[1], { to: 'target', body: { clientId: calls[0].body.clientId, fromConversationId: 'source', messageIds: ['m1', 'm2'] } });
    assert.deepEqual(afterForward, [['target', []]]);
    await batch.forward(['m1', 'm2'], 'target');
    assert.notEqual(calls[2].body.clientId, calls[1].body.clientId, 'новая пересылка после успеха — новое действие');
    failing = true;
    await assert.rejects(() => batch.forward(['m1'], 'target', false, { from: 'other-source' }), /network/);
    assert.equal(calls[3]!.body.fromConversationId, 'other-source', 'черновик пересылки сохраняет исходную беседу в запросе');
    assert.notEqual(calls[3]!.body.clientId, calls[1]!.body.clientId, 'другая исходная беседа имеет отдельный ключ идемпотентности');
    failing = false;
    await batch.forward(['m1'], 'target', false, { from: 'other-source' });
    assert.equal(calls[4]!.body.clientId, calls[3]!.body.clientId, 'повтор той же пары source→target после сбоя использует исходный ключ');
    await batch.forward(['m1'], 'target', false, { from: 'third-source' });
    assert.notEqual(calls[5]!.body.clientId, calls[4]!.body.clientId, 'ключ повтора включает `from`, а не только получателя и ids');
    await batch.deleteMany(['m1', 'm2'], 'both');
    assert.deepEqual(deletes, [['source', ['m1', 'm2'], 'both']]);
    assert.deepEqual(afterDelete, [['source', ['m1', 'm2']]]);
    await flush(() => store.setState({ serverFeatures: [] }));
    assert.equal(chatBatch, undefined, 'старый сервер не получает кнопки неподдерживаемых действий');
  } finally { api.convForward = oldForward; api.convDeleteMany = oldDelete; }
});

it('DmChatView передаёт source черновика и мутант возвращает старый source беседы', async () => {
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const oldForward = api.convForward; const calls: { to: string; body: Parameters<typeof api.convForward>[1] }[] = [];
  api.convForward = async (to, body) => { calls.push({ to, body }); return { messages: [] }; };
  const dm = { ...testDm, id: 'draft-target' };
  const captured = globalThis as unknown as { __currentDmBatch?: import('./MessagePane').MessageBatch };
  const exercise = async (component: ComponentType<{ dm: DmChannel }>) => {
    chatBatch = undefined; captured.__currentDmBatch = undefined;
    store.setState({ ...initial, user: { id: 'me', username: 'me', displayName: 'Я', avatarUrl: null } as never,
      convActive: true, serverFeatures: ['conv5'], currentDmId: dm.id, dms: [dm], dmMessages: { [dm.id]: [] },
      convAfterForward: () => {}, loadOlderDmMessages: async () => false });
    await mount(component, { dm });
    try {
      const capturedBatch = (globalThis as unknown as { __currentDmBatch?: import('./MessagePane').MessageBatch }).__currentDmBatch;
      assert.ok(capturedBatch, 'режим бесед передал настоящую пачку пересылки');
      await capturedBatch.forward(['source-message'], dm.id, false, { from: 'draft-source' });
      assert.equal(calls.at(-1)?.body.fromConversationId, 'draft-source', 'в запрос попал источник черновика, а не целевая беседа');
    } finally { await unmountMounted(); chatBatch = undefined; captured.__currentDmBatch = undefined; }
  };
  try {
    await exercise(Chat);
    const { DmChatView: bad } = await server.ssrLoadModule('/src/components/DmChatView.tsx?codex-forward-source-mutant') as typeof import('./DmChatView');
    await assert.rejects(() => exercise(bad), assert.AssertionError, 'исполняемый мутант подставляет id целевой беседы вместо source');
  } finally { api.convForward = oldForward; }
});

it('DmChatView запрашивает закреп при каждом новом открытии, а pin/unpin обновляют стор ответом API', async () => {
  // При повторном входе прежний список мог устареть; ответы обеих ручек должны стать источником store.conv.pins.
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const oldPins = api.convPins, oldPin = api.convPin, oldUnpin = api.convUnpin;
  const calls: { method: string; id: string; messageId?: string; scope?: string }[] = [];
  let pts = 10;
  const pin: ConvPin = {
    message: { id: 'message-1', authorId: 'peer', text: 'закреплённый текст', attachments: 0, sortKey: 1,
      createdAt: '2026-10-05T12:00:00.000Z' },
    forBoth: true, pinnedBy: 'me', pinnedAt: '2026-10-05T12:00:00.000Z',
  };
  api.convPins = async id => { calls.push({ method: 'GET', id }); return { pts: ++pts, pins: [] }; };
  api.convPin = async (id, messageId, scope) => {
    calls.push({ method: 'PUT', id, messageId, scope }); return { pts: ++pts, pins: [pin] };
  };
  api.convUnpin = async (id, messageId, scope) => {
    calls.push({ method: 'DELETE', id, messageId, scope }); return { pts: ++pts, pins: [] };
  };
  try {
    await mountPinEnabledDm();
    assert.ok(chatPins, 'в режиме conv7 настоящая лента получает callbacks закрепов');
    assert.deepEqual(calls, [{ method: 'GET', id: 'pins-dm' }], 'первое открытие запрашивает список беседы');
    assert.equal(store.getState().conv.pins?.['pins-dm']?.pts, 11, 'список загрузки записан с серверным pts');
    const cachedConv = store.getState().conv;
    await unmountMounted();
    await mountPinEnabledDm({ conv: cachedConv });
    assert.equal(calls.filter(call => call.method === 'GET').length, 2,
      'повторное открытие после нового mount/key перечитывает уже известный список');
    assert.ok(chatPins, 'повторное открытие также подключает действия');
    await act(async () => { await chatPins!.pin('message-1', 'both'); });
    assert.deepEqual(calls.at(-1), { method: 'PUT', id: 'pins-dm', messageId: 'message-1', scope: 'both' },
      'закреп передаёт выбранную область собеседника в API');
    assert.equal(store.getState().conv.pins?.['pins-dm']?.pts, 13, 'ответ PUT обновляет pts стора');
    assert.deepEqual(store.getState().conv.pins?.['pins-dm']?.list, [pin], 'ответ PUT целиком заменяет список');
    await act(async () => { await chatPins!.unpin('message-1', 'me'); });
    assert.deepEqual(calls.at(-1), { method: 'DELETE', id: 'pins-dm', messageId: 'message-1', scope: 'me' },
      'откреп передаёт выбранную область в API');
    assert.equal(store.getState().conv.pins?.['pins-dm']?.pts, 14, 'ответ DELETE обновляет pts стора');
    assert.deepEqual(store.getState().conv.pins?.['pins-dm']?.list, [], 'ответ DELETE очищает полный список');
    api.convPin = async () => { throw Object.assign(new Error('pin limit'), { status: 409 }); };
    await assert.rejects(
      async () => { await act(async () => { await chatPins!.pin('message-2', 'me'); }); },
      error => (error as { status?: number }).status === 409,
      '409 pin limit остаётся отклонённым для тоста вызывающей ленты',
    );
    assert.equal(store.getState().conv.pins?.['pins-dm']?.pts, 14, '409 не меняет свежесть сохранённого списка');
    assert.deepEqual(store.getState().conv.pins?.['pins-dm']?.list, [], '409 не добавляет непринятый закреп');
  } finally { api.convPins = oldPins; api.convPin = oldPin; api.convUnpin = oldUnpin; }
});

it('DmChatView не запрашивает закрепы без нового режима, conv7 или включённых пузырей', async () => {
  // Старый путь ЛС и сервер без capability не должны стучаться в отсутствующий endpoint даже при открытом диалоге.
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const oldPins = api.convPins;
  const calls: string[] = [];
  api.convPins = async id => { calls.push(id); return { pts: 1, pins: [] }; };
  try {
    localStorage.setItem('gv_dm_bubbles', '0');
    store.setState({ ...initial, convActive: true, serverFeatures: ['conv7'], dmMessages: { 'pins-dm': [] }, readDmNow: () => {} });
    await mount(Chat, { dm: testDm });
    assert.ok(!chatPins, 'старая лента не получает callbacks закрепов');
    assert.equal(calls.length, 0, 'явное старое значение не вызывает GET');
    await unmountMounted();
    await mountPinEnabledDm({ serverFeatures: [] });
    assert.ok(!chatPins, 'отсутствие conv7 скрывает callbacks');
    assert.equal(calls.length, 0, 'без conv7 нет запроса неподдерживаемой ручки');
    await unmountMounted();
    await mountPinEnabledDm({ convActive: false });
    assert.ok(!chatPins, 'старый API ЛС не получает callbacks новых бесед');
    assert.equal(calls.length, 0, 'вне режима бесед /pins не запрашивается');
  } finally { api.convPins = oldPins; }
});

it('ошибка загрузки закрепов в DmChatView превращается в понятный тост', async () => {
  // Без тоста открытая лента молча выглядела бы как беседа, в которой закрепов нет.
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const oldPins = api.convPins;
  api.convPins = async () => { throw Object.assign(new Error('temporary failure'), { status: 503 }); };
  try {
    toasts.setState({ toasts: [] });
    await mountPinEnabledDm();
    await flush();
    assert.equal(toasts.getState().toasts.at(-1)?.title, 'Не удалось загрузить закреплённые',
      'сбой списка не маскируется под пустой список закрепов');
    assert.equal(toasts.getState().toasts.at(-1)?.subtitle, 'temporary failure', 'тост сохраняет причину сбоя');
  } finally { api.convPins = oldPins; }
});

it('DmPinsList открывает сообщение мышью и клавиатурой, а крестик не открывает строку', async () => {
  // Поповер модальный; крестик — независимое действие, и его клик не должен одновременно прыгнуть к сообщению.
  const actions: string[] = [];
  await mount(DmPinsList, { items: [{ id: 'm1', author: 'Собеседник', when: 'сегодня, 12:00', text: 'важное' }],
    onOpen: id => actions.push(`open:${id}`), onUnpin: id => actions.push(`unpin:${id}`) });
  assert.ok(host.querySelector('[role="dialog"][aria-modal="true"][aria-label="Закреплённые сообщения"]'),
    'список закрепов объявлен модальным диалогом');
  assert.ok(!host.querySelector('.pin-item img'), 'в списке ЛС строки не дублируют аватары');
  const main = host.querySelector<HTMLElement>('.pin-main[role="button"]');
  const unpin = host.querySelector<HTMLButtonElement>('button.pin-unpin[aria-label="Открепить"]');
  assert.ok(main, 'строка сообщения имеет клавиатурную кнопку');
  assert.ok(unpin, 'крестик открепления доступен с именем');
  await flush(() => main?.click());
  await flush(() => unpin?.click());
  assert.deepEqual(actions, ['open:m1', 'unpin:m1'], 'нажатие крестика не всплывает как переход к сообщению');
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  await flush(() => main?.dispatchEvent(enter));
  const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  await flush(() => main?.dispatchEvent(space));
  assert.deepEqual(actions, ['open:m1', 'unpin:m1', 'open:m1', 'open:m1'], 'Enter и Space оба открывают выбранное сообщение');
  assert.ok(enter.defaultPrevented && space.defaultPrevented, 'клавиши не прокручивают страницу вместо действия');
});

it('PinnedMessages показывает подпись фото и оставляет опрос без строки «вложение»', async () => {
  // В живом поповере закрепов фото должно отличаться от произвольного файла, а опрос не должен притворяться вложением.
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const oldListPins = api.listPins;
  const base: Message = { id: 'photo-pin', channelId: 'channel-pin', author: { id: 'author', username: 'author', displayName: 'Автор', avatarUrl: null },
    content: 'подпись', attachments: [{ url: '/photo.png', contentType: 'image/png' } as Message['attachments'][number]],
    createdAt: '2026-10-05T09:00:00.000Z', editedAt: null, reactions: [], replyTo: null, pinnedAt: '2026-10-05T10:00:00.000Z' };
  const poll: Message = { ...base, id: 'poll-pin', content: '', attachments: [], poll: { question: 'Опрос?', options: [] } as unknown as NonNullable<Message['poll']> };
  api.listPins = async channelId => channelId === 'channel-pin' ? [base, poll] : [];
  try {
    await mount(PinnedMessages, { channelId: 'channel-pin', canManage: false });
    const toggle = host.querySelector<HTMLButtonElement>('.pins-btn');
    assert.ok(toggle, 'шапка канала показывает переключатель закрепов');
    await flush(() => toggle.click());
    await flush();
    assert.deepEqual([...host.querySelectorAll('.pin-text')].map(node => node.textContent), ['Фото · подпись', ''],
      'поповер выводит префикс фото с подписью, а опрос оставляет пустым');
    assert.equal(host.querySelector('.pins-count')?.textContent, '2', 'оба серверных закрепа отображаются в счётчике');
  } finally { api.listPins = oldListPins; }
});

after(async () => {
  try { await server?.close(); }
  finally {
    await GlobalRegistrator.unregister();
    for (const timer of timers) {
      nativeClearTimeout(timer as ReturnType<typeof setTimeout>);
      nativeClearInterval(timer as ReturnType<typeof setInterval>);
    }
    globalThis.setTimeout = nativeTimeout;
    globalThis.setInterval = nativeInterval;
    for (const handle of handles()) if (!originalHandles.has(handle) && handle instanceof MessagePort) handle.unref();
  }
});

it('ПКМ полосы мышью листает новее, касанием открывает список, удержание поглощает click', async () => {
  // Ловит открытие сообщения после уже сработавшего удержания и смешение ПКМ с долгим тапом.
  let next=0, long=0, opened=0;
  await mount(PinnedBar,{count:2,index:0,text:'текст',onOpen:()=>{opened++;},onNext:()=>{next++;},onLongPress:()=>{long++;}});
  const main=host.querySelector<HTMLButtonElement>('.pin-bar-main'); assert.ok(main);
  await flush(()=>{main.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse'})); main.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));});
  assert.equal(next,1); assert.equal(long,0);
  await flush(()=>{main.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'touch'})); main.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})); main.click();});
  assert.equal(long,1); assert.equal(opened,0);
  await flush(()=>main.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[{clientX:1,clientY:1} as Touch]})));
  await act(async()=>{await new Promise<void>(r=>setTimeout(r,530));});
  await flush(()=>{main.dispatchEvent(new TouchEvent('touchend',{bubbles:true,touches:[]})); main.click();});
  assert.equal(long,2); assert.equal(opened,0);
  await flush(()=>{main.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[{clientX:1,clientY:1} as Touch]}));main.dispatchEvent(new TouchEvent('touchmove',{bubbles:true,touches:[{clientX:12,clientY:1} as Touch]}));});
  await act(async()=>{await new Promise<void>(r=>setTimeout(r,530));}); assert.equal(long,2);
});

it('PinnedBar скрывает пустой список и у одиночного закрепа не рисует мёртвую кнопку', async () => {
  // Пустая плашка или крестик без обработчика выглядят как доступное действие, которое ничего не делает.
  await mount(PinnedBar, { count: 0, index: 0, text: 'сообщение', onOpen: () => {} });
  assert.ok(!host.querySelector('.pin-bar'), 'при нуле закрепов полоса отсутствует');
  if (root) act(() => root!.unmount()); root = undefined; host.remove();
  await mount(PinnedBar, { count: 1, index: 0, text: 'одно закреплённое', onOpen: () => {} });
  assert.ok(host.querySelector('button.pin-bar-main'), 'у одного закрепа доступна основная кнопка');
  assert.ok(!host.querySelector('button.pin-bar-btn'), 'без onUnpin справа нет кнопки без действия');
  assert.ok(!host.querySelector('.pin-bar-n'), 'у одного закрепа нет счётчика «1 из 1»');
  if (root) act(() => root!.unmount()); root = undefined; host.remove();
  let unpinned = 0;
  await mount(PinnedBar, { count: 1, index: 0, text: 'одно закреплённое', onOpen: () => {}, onUnpin: () => unpinned++,
    listOpen: true, children: createElement('div', { className: 'pins-pop' }, 'не список') });
  const unpin = host.querySelector<HTMLButtonElement>('button[aria-label="Открепить"]');
  assert.ok(unpin, 'с onUnpin появляется явная кнопка открепления');
  assert.equal(unpin?.hasAttribute('aria-expanded'), false, 'одиночное открепление не имеет состояния раскрытия');
  assert.ok(!host.querySelector('.pins-pop'), 'children не рисуются для одиночного закрепа');
  await flush(() => unpin?.click());
  assert.equal(unpinned, 1, 'открепление вызывается одним нажатием');
});

it('PinnedBar показывает активный счётчик и раскрывает список только по явному действию', async () => {
  // ARIA-состояние и видимый поповер должны описывать одно и то же раскрытие списка закрепов.
  let opened = 0;
  let listed = 0;
  await mount(PinnedBar, {
    count: 3, index: 1, text: 'важное', onOpen: () => opened++, onList: () => listed++, listOpen: true,
    children: createElement('div', { className: 'pins-pop' }, 'Список'),
  });
  const main = host.querySelector<HTMLButtonElement>('button.pin-bar-main');
  const list = host.querySelector<HTMLButtonElement>('button[aria-label="Все закреплённые"]');
  assert.ok(main, 'основное действие имеет настоящую кнопку');
  assert.ok(list, 'список закрепов доступен отдельной кнопкой');
  assert.equal(main?.getAttribute('aria-label'), 'К закреплённому сообщению 2 из 3');
  assert.equal(list?.getAttribute('aria-expanded'), 'true');
  assert.ok(host.querySelector('.pins-pop'), 'открытый список переданному children виден');
  assert.equal(host.querySelectorAll('.pin-bar-ind i.on').length, 1, 'среди сегментов подсвечен ровно текущий');
  if (root) act(() => root!.unmount()); root = undefined; host.remove();
  await mount(PinnedBar, { count: 3, index: -1, text: 'важное', onOpen: () => {},
    children: createElement('div', { className: 'pins-pop' }, 'закрытый список') });
  const clampedLow = host.querySelector<HTMLButtonElement>('.pin-bar-main');
  assert.ok(clampedLow, 'основная кнопка сохраняется при некорректном индексе');
  assert.equal(clampedLow?.getAttribute('aria-label'), 'К закреплённому сообщению 1 из 3', 'индекс ниже нуля прижат к первому');
  const noListAction = host.querySelector<HTMLButtonElement>('button.pin-bar-btn');
  assert.ok(!noListAction, 'без onList нет мёртвой кнопки списка');
  assert.ok(!host.querySelector('.pins-pop'), 'закрытый список не монтирует children');
  if (root) act(() => root!.unmount()); root = undefined; host.remove();
  await mount(PinnedBar, { count: 3, index: 99, text: 'важное', onOpen: () => {}, onList: () => {}, listOpen: false,
    children: createElement('div', { className: 'pins-pop' }, 'закрытый список') });
  const clampedHigh = host.querySelector<HTMLButtonElement>('.pin-bar-main');
  const closedList = host.querySelector<HTMLButtonElement>('button[aria-label="Все закреплённые"]');
  assert.ok(clampedHigh && closedList, 'верхняя граница сохраняет полосу и кнопку списка');
  assert.equal(clampedHigh?.getAttribute('aria-label'), 'К закреплённому сообщению 3 из 3', 'индекс за концом прижат к последнему');
  assert.equal(closedList?.getAttribute('aria-expanded'), 'false', 'закрытый список сообщает aria-expanded=false');
  assert.ok(!host.querySelector('.pins-pop'), 'при aria-expanded=false children остаются скрытыми');
  if (root) act(() => root!.unmount()); root = undefined; host.remove();
  await mount(PinnedBar, { count: 3, index: 1, text: 'важное', onOpen: () => {},
    children: createElement('div', { className: 'pins-pop' }, 'нет обработчика') });
  assert.ok(!host.querySelector('button.pin-bar-btn'), 'при нескольких закрепах без onList справа нет мёртвой кнопки');
  assert.ok(!host.querySelector('.pins-pop'), 'без onList список остаётся закрытым');
  if (root) act(() => root!.unmount()); root = undefined; host.remove();
  await mount(PinnedBar, { count: 3, index: 1, text: 'важное', onOpen: () => opened++, onList: () => listed++, listOpen: true,
    children: createElement('div', { className: 'pins-pop' }, 'открытый список') });
  assert.ok(host.querySelector('.pins-pop'), 'переданные children появляются только при открытом списке');
  const mainAfter = host.querySelector<HTMLButtonElement>('button.pin-bar-main');
  const listAfter = host.querySelector<HTMLButtonElement>('button[aria-label="Все закреплённые"]');
  await flush(() => mainAfter?.click());
  await flush(() => listAfter?.click());
  assert.equal(opened, 1, 'переход к сообщению вызывается одним нажатием');
  assert.equal(listed, 1, 'открытие списка вызывается одним нажатием');
});

it('SchedPick на ПК после быстрых повторных кликов выбирает время и закрывается ровно один раз', async () => {
  // Повторный клик до размонтирования окна не должен создать несколько отложенных сообщений.
  const order: string[] = [];
  await mount(SchedPick, { text: 'напоминание', now: new Date('2026-10-05T12:00:00Z'), phone: false,
    onPick: () => order.push('pick'), onClose: () => order.push('close') });
  assert.ok(host.querySelector('.modal-overlay .sched-pick'), 'на ПК календарь открыт в центральном модальном окне');
  const quick = host.querySelector<HTMLButtonElement>('.sched-q');
  assert.ok(quick, 'быстрый вариант времени доступен');
  await flush(() => quick?.click());
  await flush(() => quick?.click());
  assert.deepEqual(order, ['pick', 'close'], 'ПК выбирает только раз, затем закрывает окно только раз');
});

it('SchedPick на ПК закрывается по Escape без отправки', async () => {
  // Escape — действие отмены, а не подтверждение выбранного времени.
  let picked = 0;
  let closed = 0;
  await mount(SchedPick, { text: '', now: new Date('2026-10-05T12:00:00Z'), phone: false,
    onPick: () => picked++, onClose: () => closed++ });
  assert.ok(host.querySelector('[role="dialog"][aria-modal="true"]'), 'окно объявлено модальным диалогом');
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(picked, 0, 'Escape не выбирает время');
  assert.equal(closed, 1, 'Escape закрывает ПК-окно один раз');
});

it('главная кнопка и Enter отправляют именно выбранную дату, а не быстрый вариант', async () => {
  // Ловит правильное название кнопки при отправке другого момента или двойное подтверждение клавишей.
  const now = new Date(2026, 9, 5, 12, 0);
  const initialDate = new Date(2026, 9, 8, 19, 37);
  const calls: string[] = [];
  await mount(SchedPick, { text: 'план', now, initial: initialDate, phone: false,
    onPick: at => calls.push(at.toISOString()), onClose: () => calls.push('close') });
  const go = host.querySelector<HTMLButtonElement>('.modal-actions button:not(.link)');
  const hours = host.querySelector<HTMLInputElement>('input[aria-label="Часы"]');
  assert.ok(go && hours, 'время и основная кнопка доступны');
  assert.equal(go.textContent, 'Отправить в чт, 8 октября, в 19:37');
  await flush(() => hours.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  await flush(() => go.click());
  assert.deepEqual(calls, [initialDate.toISOString(), 'close']);
});

it('прошедшее и пустое время запрещают отправку, восстановленный ввод снова разрешает её', async () => {
  // Ловит обход disabled через Enter и отсутствие восстановления после корректного ввода.
  const now = new Date(2026, 9, 5, 9, 15, 40);
  const calls: Date[] = [];
  await mount(SchedPick, { text: '', now, phone: false, onPick: at => calls.push(at), onClose: () => {} });
  const today = [...host.querySelectorAll<HTMLButtonElement>('.sched-day')].find(b => b.classList.contains('today'));
  assert.ok(today, 'сегодня доступно в календаре');
  await flush(() => today.click());
  const hours = host.querySelector<HTMLInputElement>('input[aria-label="Часы"]')!;
  const go = () => host.querySelector<HTMLButtonElement>('.modal-actions button:not(.link)')!;
  assert.equal(go().disabled, true);
  assert.equal(host.querySelector('[role="alert"]')?.textContent, 'Это время уже прошло');
  assert.equal(hours.getAttribute('aria-invalid'), 'true');
  await flush(() => hours.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(calls.length, 0);
  const write = async (value: string) => flush(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(hours, value);
    hours.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await write('');
  assert.equal(go().disabled, true);
  assert.ok(!host.querySelector('[role="alert"]'), 'пустота не обвиняет в прошедшем времени');
  await write('10');
  assert.equal(go().disabled, false);
  assert.equal(hours.getAttribute('aria-invalid'), null);
  await flush(() => go().click());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].getTime(), new Date(2026, 9, 5, 10, 0).getTime());
});

it('автоматический вид календаря меняется ровно на границе телефонной ширины', async () => {
  // Ловит зависимость телефонной формы от нативной оболочки вместо ширины обычного браузера.
  const original = window.matchMedia.bind(window);
  let width = 760;
  const listeners = new Set<() => void>();
  window.matchMedia = query => {
    const mq = original(query);
    if (query === '(max-width: 760px)') {
      Object.defineProperty(mq, 'matches', { configurable: true, get: () => width <= 760 });
      // Хук подписывает только свой callback без аргументов; прочие события в этой заглушке не моделируются.
      mq.addEventListener = ((_type: string, fn: () => void) => { listeners.add(fn); }) as unknown as typeof mq.addEventListener;
      mq.removeEventListener = ((_type: string, fn: () => void) => { listeners.delete(fn); }) as unknown as typeof mq.removeEventListener;
    }
    return mq;
  };
  try {
    await mount(SchedPick, { text: '', now: new Date(2026, 9, 5, 12), onPick: () => {}, onClose: () => {} });
    assert.ok(document.querySelector('.sheet .sched-pick'), '760 px включительно — телефон');
    await flush(() => { width = 761; for (const listener of listeners) listener(); });
    assert.ok(host.querySelector('.modal-overlay .sched-pick'), '761 px — центральное окно');
    assert.ok(!document.querySelector('.sheet .sched-pick'), 'старый лист убран при смене вида');
  } finally { window.matchMedia = original; }
});

it('календарь переносит выбор в соседний месяц, а стрелки времени не меняют соседнее поле', async () => {
  // Ловит потерю выбранного серого дня и лишний перенос часа при шаге минут через границу.
  await mount(SchedPick, { text: '', now: new Date(2026, 9, 5, 12), phone: false,
    initial: new Date(2026, 9, 31, 23, 59), onPick: () => {}, onClose: () => {} });
  const next = [...host.querySelectorAll<HTMLButtonElement>('.sched-day.out')].find(b => !b.disabled && b.textContent === '1');
  assert.ok(next, 'первое ноября доступно как соседний день в октябрьской сетке');
  await flush(() => next.click());
  assert.equal(host.querySelector('.sched-cal-head strong')?.textContent, 'Ноябрь 2026');
  assert.equal(host.querySelector('.sched-day[aria-pressed="true"]')?.textContent, '1');
  const h = host.querySelector<HTMLInputElement>('input[aria-label="Часы"]')!;
  const m = host.querySelector<HTMLInputElement>('input[aria-label="Минуты"]')!;
  await flush(() => m.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
  assert.deepEqual([h.value, m.value], ['23', '00']);
  await flush(() => h.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
  assert.deepEqual([h.value, m.value], ['00', '00']);
  assert.equal(host.querySelector('.sched-day[aria-pressed="true"]')?.textContent, '1', 'шаг поля не переносит календарный день');
});

it('SchedPick подгоняет пропущенное весеннее время только при выборе дня или выходе из группы', async () => {
  // Весеннее 02:30 превращается в 03:30: подсказка должна совпасть с отправкой, но не исчезнуть при переходе в соседнее поле.
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const now = new Date('2026-03-07T17:00:00.000Z');
    await mount(SchedPick, { text: '', now, phone: false, onPick: () => {}, onClose: () => {} });
    const hours = host.querySelector<HTMLInputElement>('input[aria-label="Часы"]')!;
    const minutes = host.querySelector<HTMLInputElement>('input[aria-label="Минуты"]')!;
    const selectedDay = host.querySelector<HTMLButtonElement>('.sched-day[aria-pressed="true"]')!;
    const write = async (input: HTMLInputElement, value: string) => flush(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await write(hours, '02');
    await write(minutes, '30');
    assert.equal(host.querySelector('#sched-pick-shift')?.textContent, 'Часы переводятся: 2:30 нет, будет 3:30', 'несуществующий час сразу объясняется');
    assert.match(host.querySelector('.modal-actions button:not(.link)')?.textContent ?? '', /в 3:30/, 'главная кнопка называет реальное время');
    await flush(() => hours.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: minutes })));
    assert.deepEqual([hours.value, minutes.value], ['02', '30'], 'переход между полями не фиксирует ввод раньше времени');
    await flush(() => minutes.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: selectedDay })));
    assert.deepEqual([hours.value, minutes.value], ['02', '30'], 'уход на день календаря оставляет подгонку обработчику выбора дня');
    await flush(() => selectedDay.click());
    assert.deepEqual([hours.value, minutes.value], ['03', '30'], 'выбор даты ставит в поля время, которое реально отправится');
    assert.equal(host.querySelector('#sched-pick-shift')?.textContent, 'Часы переводятся: 2:30 нет, будет 3:30', 'после подгонки остаётся объяснение смены');
    await write(hours, '3');
    await flush(() => hours.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: minutes })));
    assert.deepEqual([hours.value, minutes.value], ['03', '30'], 'добивание того же числа 3→03 внутри полей не сбрасывает вводимый час');
    assert.equal(host.querySelector('#sched-pick-shift')?.textContent, 'Часы переводятся: 2:30 нет, будет 3:30', 'нормализация того же числа сохраняет причину подгонки');
    await write(minutes, '31');
    assert.ok(!host.querySelector('#sched-pick-shift'), 'другое число в поле снимает устаревшее предупреждение');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

it('SchedPick получает настоящий focusout наружу и отправляет уже подогнанное время', async () => {
  // React делегирует onBlur через focusout: проверяем реальную границу группы, а не синтетический blur.
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  const picked: string[] = [];
  try {
    await mount(SchedPick, { text: 'весна', now: new Date('2026-03-07T17:00:00Z'), phone: false,
      onPick: at => picked.push(at.toISOString()), onClose: () => {} });
    const hour = host.querySelector<HTMLInputElement>('input[aria-label="Часы"]');
    const minute = host.querySelector<HTMLInputElement>('input[aria-label="Минуты"]');
    const outside = host.querySelector<HTMLButtonElement>('.modal-actions button:not(.link)');
    assert.ok(hour && minute && outside, 'поля и кнопка отправки смонтированы');
    const write = async (input: HTMLInputElement, value: string) => flush(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await write(hour, '02');
    await write(minute, '30');
    await flush(() => hour.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside })));
    assert.deepEqual([hour.value, minute.value], ['03', '30'], 'выход focusout за группу ставит реальные 03:30');
    assert.equal(host.querySelector('#sched-pick-shift')?.textContent, 'Часы переводятся: 2:30 нет, будет 3:30', 'вид объясняет подмену, сделанную при уходе фокуса');
    await flush(() => outside.click());
    assert.deepEqual(picked, ['2026-03-08T07:30:00.000Z'], 'onPick получает именно реально показанное местное 03:30');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

it('ScheduledView рисует загрузку, календарные секции, онлайн и отказ без ложного времени', async () => {
  // Список должен отличать календарные и онлайн-отложенные, а failed не должен маскироваться под плановое время.
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0).toISOString();
  const props: ScheduledProps = { items: null, peerName: 'Собеседник', me: { name: 'Я', avatarUrl: null },
    onBack: () => {}, create: async () => {}, sendNow: async () => {}, reschedule: async () => {}, edit: async () => {}, remove: async () => {} };
  await mount(ScheduledView, props);
  assert.ok(host.querySelector('.older-hint')?.textContent?.includes('Загружаем отложенные'), 'null остаётся состоянием загрузки');
  if (root) act(() => root!.unmount()); root = undefined; host.remove();
  const items = [
    scheduleItem('tomorrow', { sendAt: tomorrow }),
    scheduleItem('online', { sendAt: null, whenOnline: true }),
    scheduleItem('failed', { sendAt: null, whenOnline: true, failed: { at: now.toISOString(), reason: 'error' } }),
  ];
  await mount(ScheduledView, { ...props, items });
  assert.equal(host.querySelector('.dm-who-status')?.textContent, 'Собеседник · 3 сообщения', 'шапка склоняет число записей');
  const tomorrowDate = new Date(tomorrow);
  const monthGenitive = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][tomorrowDate.getMonth()];
  assert.deepEqual([...host.querySelectorAll('.day-divider.pill')].map(node => node.textContent?.trim()),
    [`Завтра, ${tomorrowDate.getDate()} ${monthGenitive}`, 'Когда Собеседник будет в сети'],
    'секции разделяют время по календарному дню и появление собеседника');
  assert.ok([...host.querySelectorAll('.bub-meta')].some(node => node.textContent?.includes('9:00')), 'запланированный пузырь показывает фактическое выбранное время');
  assert.ok(host.querySelector('.bub-st.failed'), 'неуспешный элемент получает индикатор отказа');
  const onlineRow = [...host.querySelectorAll('.message[aria-haspopup="menu"]')].find(node => node.textContent?.includes('текст online'));
  assert.ok(onlineRow && !onlineRow.querySelector('.bub-meta'), 'у режима «когда в сети» нет выдуманного времени');
});

it('ScheduledView выбирает несколько отложенных, считает их и открывает перенос пачки', async () => {
  // Пачечный перенос должен получить ровно текущий набор, а одиночный режим — вернуться после снятия последней галочки.
  const now = Date.now();
  const earlier = scheduleItem('earlier-selected', { sendAt: new Date(now + 60_000).toISOString() });
  const later = scheduleItem('later-selected', { sendAt: new Date(now + 120_000).toISOString() });
  const props: ScheduledProps = { items: [later, earlier], peerName: 'Собеседник', me: { name: 'Я', avatarUrl: null },
    onBack: () => {}, create: async () => {}, sendNow: async () => {}, reschedule: async () => {}, edit: async () => {}, remove: async () => {} };
  await mount(ScheduledView, props);
  const rows = [...host.querySelectorAll<HTMLElement>('.sched-view .message[aria-haspopup="menu"]')];
  assert.equal(rows.length, 2, 'оба запланированных сообщения доступны');
  const laterRow = rows.find(row => row.textContent?.includes('текст later-selected'))!;
  const earlierRow = rows.find(row => row.textContent?.includes('текст earlier-selected'))!;
  assert.ok(laterRow && earlierRow);
  await flush(() => laterRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  const choose = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.trim() === 'Выбрать');
  assert.ok(choose, 'меню строки даёт войти в выбор'); await flush(() => choose.click());
  await flush(() => earlierRow.click());
  assert.equal(host.querySelector('.sel-head strong')?.textContent, 'Выбрано 2', 'повторный выбор добавляет строку и обновляет счётчик');
  const reschedule = host.querySelector<HTMLButtonElement>('.sel-bar [aria-label="Перенести"]');
  assert.ok(reschedule, 'пачка предлагает общий перенос'); await flush(() => reschedule.click());
  assert.match(document.body.textContent ?? '', /2 сообщения/, 'окно переноса получает обе выбранные записи');
});

it('ScheduledView показывает фото и альбом, открывает просмотр, время лежит на фото без подписи, копирование только у текста', async () => {
  // Отложенное с вложениями должно совпадать с пузырём ленты, а пустая подпись не должна создавать фиктивный текст для копирования.
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  const photo = (id: string) => ({ id, url: `data:image/png;base64,${id}`, name: `${id}.png`, contentType: 'image/png', size: 3, width: 16, height: 12 });
  const items = [
    scheduleItem('photo-caption', { content: 'подпись к фото', sendAt: future, attachments: [photo('caption')] }),
    scheduleItem('photo-empty', { content: '', sendAt: future, attachments: [photo('empty')] }),
    scheduleItem('photo-album', { content: 'альбом с подписью', sendAt: future, attachments: [photo('a1'), photo('a2')] }),
    scheduleItem('text-only', { content: 'только текст', sendAt: future, attachments: [] }),
  ];
  await mount(ScheduledView, { items, peerName: 'Собеседник', me: { name: 'Я', avatarUrl: null }, onBack: () => {},
    create: async () => {}, sendNow: async () => {}, reschedule: async () => {}, edit: async () => {}, remove: async () => {} });
  const rows = [...host.querySelectorAll<HTMLElement>('.sched-view .message[aria-haspopup="menu"]')];
  assert.equal(rows.length, 4, 'все отложенные с фото и без него попали в вид');
  const captionRow = rows.find(row => row.textContent?.includes('подпись к фото'));
  const emptyPhotoRow = rows.find(row => row.querySelector('.att-img[alt="empty.png"]'));
  const albumRow = rows.find(row => row.textContent?.includes('альбом с подписью'));
  const textRow = rows.find(row => row.textContent?.includes('только текст'));
  assert.ok(captionRow?.querySelector('.attachments .att-img'), 'фото с подписью показано вложением перед текстом подписи');
  const captionBody = captionRow?.querySelector('.message-body');
  assert.ok(captionBody?.textContent?.includes('подпись к фото'), 'подпись остаётся текстом пузыря');
  assert.ok(captionRow!.querySelector('.attachments .att-img')!.compareDocumentPosition(captionBody!) & Node.DOCUMENT_POSITION_FOLLOWING,
    'вёрстка ставит фото перед подписью, а не после неё');
  assert.ok(emptyPhotoRow?.querySelector('.attachments .bub-meta.over'), 'у фото без подписи время лежит поверх изображения');
  assert.ok(albumRow?.querySelector('.attachments.album.n2'), 'две картинки образуют сетку альбома');
  assert.equal(albumRow?.querySelectorAll('.attachments.album img').length, 2, 'в сетке видны обе фотографии');
  const preview = captionRow?.querySelector<HTMLButtonElement>('.att-img-link');
  assert.ok(preview, 'фото можно открыть для предпросмотра');
  await flush(() => preview!.click());
  assert.ok(document.body.querySelector('.lightbox'), 'нажатие по отложенному фото открывает Lightbox');
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.ok(!document.body.querySelector('.lightbox'), 'Escape закрывает просмотр фото');
  assert.ok(emptyPhotoRow, 'строка фото без подписи доступна для контекстного меню');
  await flush(() => emptyPhotoRow!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  assert.ok(![...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent?.includes('Скопировать текст')),
    'у фото без подписи не предлагается копировать отсутствующий текст');
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.ok(textRow, 'текстовое отложенное доступно для меню');
  await flush(() => textRow!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  assert.ok([...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent?.includes('Скопировать текст')),
    'у текстового отложенного копирование остаётся доступно');
});

it('ScheduledView делает ленту инертной и возвращает фокусный слой назад к беседе', async () => {
  // Поверх вида не должны получать ввод скрытые сообщения; callback «К беседе» освобождается после размонтирования.
  const oldMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
  let backs = 0;
  const { backFromSchedView } = await server.ssrLoadModule('/src/schedView.ts') as typeof import('../schedView');
  const props: ScheduledProps = { items: [], peerName: 'Собеседник', me: { name: 'Я', avatarUrl: null },
    onBack: () => backs++, create: async () => {}, sendNow: async () => {}, reschedule: async () => {}, edit: async () => {}, remove: async () => {} };
  const Harness: ComponentType<Record<string, never>> = () => createElement('div', null,
    createElement('div', { className: 'underlay' }, 'лента беседы'), createElement(ScheduledView, props));
  try {
    await mount(Harness, {});
    const underlay = host.querySelector<HTMLElement>('.underlay');
    assert.ok(underlay?.inert, 'лента под расписанием временно исключена из ввода');
    assert.equal(backFromSchedView(), true, 'кнопка возврата телефона может вызвать удерживаемый callback');
    assert.equal(backs, 1, 'callback возвращает именно к текущей беседе');
    const desktopBack = host.querySelector<HTMLButtonElement>('.sched-view button[aria-label="К беседе"]');
    assert.ok(desktopBack, 'на ПК есть явная кнопка «К беседе»');
    await flush(() => desktopBack.click());
    assert.equal(backs, 2, 'ПК-кнопка ведёт к тому же возвращению');
    await unmountMounted();
    assert.ok(!backFromSchedView(), 'после закрытия вида удерживаемый переход снят');
    assert.ok(!underlay.inert, 'после закрытия прежний элемент ленты снова доступен');
  } finally { window.matchMedia = oldMatchMedia; }
});

it('видео из ScheduledView входит в общий просмотр вложений', async () => {
  // У отложенного видео та же галерея просмотра, что у фото, иначе файл виден, но нажатие по кадру ничего не делает.
  const video = { id: 'scheduled-video', url: '/api/att/scheduled-video/video.mp4', name: 'clip.mp4', contentType: 'video/mp4',
    size: 4096, width: 1280, height: 720, durationMs: 5100 };
  const item = scheduleItem('video-gallery', { content: '', sendAt: new Date(Date.now() + 60_000).toISOString(), attachments: [video] });
  await mount(ScheduledView, { items: [item], peerName: 'Собеседник', me: { name: 'Я', avatarUrl: null }, onBack: () => {},
    create: async () => {}, sendNow: async () => {}, reschedule: async () => {}, edit: async () => {}, remove: async () => {} });
  const frame = host.querySelector<HTMLButtonElement>('.sched-view .att-video');
  assert.ok(frame, 'отложенное видео показано кадром с кнопкой просмотра');
  await flush(() => frame!.click());
  const player = document.body.querySelector<HTMLVideoElement>('.lightbox video.lb-video');
  assert.ok(player, 'нажатие по отложенному кадру открывает видеоплеер галереи');
  assert.equal(player!.getAttribute('src'), video.url, 'галерея играет именно выбранное отложенное видео');
  assert.ok(!document.body.querySelector('.lightbox .lb-zoom'), 'просмотр видео не применяет масштабирование фото');
});

it('ScheduledView передаёт создать, отправить сейчас, перенести, изменить и удалить', async () => {
  // Действия меню и поля должны вызывать ровно свой callback и не перепутать id или текст сообщения.
  const calls: Array<{ kind: string; id?: string; value?: string }> = [];
  const props: ScheduledProps = { items: [scheduleItem('now'), scheduleItem('move'), scheduleItem('edit'), scheduleItem('delete')],
    peerName: 'Собеседник', me: { name: 'Я', avatarUrl: null }, onBack: () => {},
    create: async (content, at) => { calls.push({ kind: 'create', value: `${content}|${at.toISOString()}` }); },
    sendNow: async id => { calls.push({ kind: 'sendNow', id }); },
    reschedule: async (id, at) => { calls.push({ kind: 'reschedule', id, value: at.toISOString() }); },
    edit: async (id, content) => { calls.push({ kind: 'edit', id, value: content }); },
    remove: async id => { calls.push({ kind: 'remove', id }); } };
  const { useConfirmDialog } = await server.ssrLoadModule('/src/confirm.ts') as typeof import('../confirm');
  await mount(ScheduledView, props);
  const openItemMenu = async (id: string) => {
    const row = [...host.querySelectorAll<HTMLElement>('.message[aria-haspopup="menu"]')].find(el => el.textContent?.includes(`текст ${id}`));
    assert.ok(row, `строка ${id} доступна для клавиатуры`);
    await flush(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  };
  const chooseMenu = async (label: string) => {
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(el => el.textContent?.trim() === label);
    assert.ok(item, `в контекстном меню есть действие «${label}»`);
    await flush(() => item.click());
  };
  await openItemMenu('now');
  await chooseMenu('Отправить сейчас');
  await openItemMenu('move');
  await chooseMenu('Изменить время');
  const quick = document.querySelector<HTMLButtonElement>('.sched-pick .sched-q');
  assert.ok(quick, 'перенос открывает календарь с быстрым временем');
  await flush(() => quick.click());
  await openItemMenu('edit');
  await chooseMenu('Изменить');
  const input = host.querySelector<HTMLTextAreaElement>('.composer-input');
  const save = host.querySelector<HTMLButtonElement>('.composer .send-btn');
  assert.ok(input && save, 'редактирование заполняет поле и показывает сохранение');
  await flush(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '  исправленный текст  ');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '  исправленный текст  ' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.equal(input.value, '  исправленный текст  ', 'контролируемое поле принимает новый текст');
  await flush(() => save.click());
  await openItemMenu('delete');
  await chooseMenu('Удалить');
  assert.ok(useConfirmDialog.getState().pending, 'удаление сначала спрашивает подтверждение');
  await flush(() => useConfirmDialog.getState().answer(true));
  await flush();
  assert.deepEqual(calls.map(call => call.kind), ['sendNow', 'reschedule', 'edit', 'remove'], 'все четыре меню-действия достигают хозяина');
  assert.deepEqual(calls.map(call => call.id), ['now', 'move', 'edit', 'delete'], 'действия сохраняют id выбранной строки');
  assert.equal(calls[2].value, 'исправленный текст', 'правка передаёт обрезанный текст без крайних пробелов');
  assert.ok(/^\d{4}-\d\d-\d\dT/.test(calls[1].value ?? ''), 'перенос передаёт выбранное время ISO');
});

it('ScheduledView создаёт новое отложенное только после выбора времени', async () => {
  // Нажатие отправки открывает планировщик; callback с текстом и датой вызывается лишь после commit.
  const calls: Array<{ content: string; at: string }> = [];
  const props: ScheduledProps = { items: [], peerName: 'Собеседник', me: { name: 'Я', avatarUrl: null }, onBack: () => {},
    create: async (content, at) => { calls.push({ content, at: at.toISOString() }); }, sendNow: async () => {},
    reschedule: async () => {}, edit: async () => {}, remove: async () => {} };
  await mount(ScheduledView, props);
  const input = host.querySelector<HTMLTextAreaElement>('.composer-input');
  const send = host.querySelector<HTMLButtonElement>('.composer .send-btn');
  assert.ok(input && send, 'форма создания имеет поле и кнопку «Отправить позже»');
  await flush(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '  новый план  ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush(() => send.click());
  assert.deepEqual(calls, [], 'до выбора момента новый элемент ещё не создан');
  const quick = document.querySelector<HTMLButtonElement>('.sched-pick .sched-q');
  assert.ok(quick, 'выбранный текст открыл календарь');
  await flush(() => quick.click());
  assert.equal(calls.length, 1, 'один выбор времени создаёт одну запись');
  const created = [...calls] as Array<{ content: string; at: string }>;
  assert.equal(created[0].content, 'новый план', 'создание убирает внешние пробелы');
  assert.ok(Number.isFinite(Date.parse(created[0].at)), 'создание передаёт валидный выбранный Date');
});

it('ScheduledView при отказе создания возвращает очищенный текст и показывает причину', async () => {
  // Ошибка API не должна терять текст, который человек только что отправил в расписание.
  const props: ScheduledProps = { items: [], peerName: 'Собеседник', me: { name: 'Я', avatarUrl: null }, onBack: () => {},
    create: async () => { throw new Error('сеть недоступна'); }, sendNow: async () => {}, reschedule: async () => {}, edit: async () => {}, remove: async () => {} };
  await mount(ScheduledView, props);
  const input = host.querySelector<HTMLTextAreaElement>('.composer-input');
  const send = host.querySelector<HTMLButtonElement>('.composer .send-btn');
  assert.ok(input && send, 'форма готова для проверки восстановления текста');
  await flush(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'важное напоминание');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'важное напоминание' }));
  });
  await flush(() => send.click());
  const quick = document.querySelector<HTMLButtonElement>('.sched-pick .sched-q');
  assert.ok(quick, 'текст можно подтвердить в планировщике');
  await flush(() => quick.click());
  await flush();
  assert.equal(input.value, 'важное напоминание', 'отказ восстанавливает текст, если поле не заменили новым вводом');
  assert.ok(toasts.getState().toasts.some(item => item.title === 'Не удалось отложить сообщение' && item.subtitle === 'сеть недоступна'), 'ошибка API видна пользователю с исходной причиной');
});

it('DmChatView показывает только функции объявленных conv8/conv9 и тихая кнопка идёт в очередь с флагом', async () => {
  // Возможности нельзя предлагать без server feature; выбрав quiet, лента должна передать ровно эту строку в store enqueue.
  localStorage.setItem('gv_dm_bubbles', '1');
  const enqueued: Array<{ convId: string; item: { key: string; content: string; silent?: boolean } }> = [];
  await mountPinEnabledDm({ serverFeatures: ['conv8'], outboxEnqueue: (convId, item) => { enqueued.push({ convId, item }); } });
  const composer = host.querySelector<HTMLTextAreaElement>('.composer-input');
  const send = host.querySelector<HTMLButtonElement>('.composer .send-btn');
  assert.ok(composer && send, 'беседа показывает поле и кнопку отправки при включённых пузырях');
  await flush(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, ' тихое сообщение ');
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' тихое сообщение ' }));
  });
  await flush(() => send.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 16 })));
  const silent = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Отправить без звука');
  assert.ok(silent, 'conv8 открывает только предусмотренный тихий режим');
  assert.ok(![...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent?.includes('Отправить позже')), 'без conv9 не показывается расписание');
  await flush(() => silent.click());
  assert.equal(enqueued.length, 1, 'выбор тихой команды вызывает очередь один раз');
  const delivered = [...enqueued] as Array<{ convId: string; item: { key: string; content: string; silent?: boolean } }>;
  assert.equal(delivered[0].convId, 'pins-dm', 'очередь привязана к текущей беседе');
  assert.equal(delivered[0].item.content, 'тихое сообщение', 'в очередь уходит очищенный текст composer');
  assert.equal(delivered[0].item.silent, true, 'в очередь уходит явный silent=true');
  await unmountMounted();

  await mountPinEnabledDm({ serverFeatures: ['conv9'] });
  assert.ok(host.querySelector('.composer-input'), 'вторая проверка использует отдельную беседу');
  const field = host.querySelector<HTMLTextAreaElement>('.composer-input');
  const button = host.querySelector<HTMLButtonElement>('.composer .send-btn');
  assert.ok(field && button, 'поле доступно у функции расписания');
  await flush(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'позже');
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'позже' }));
  });
  await flush(() => button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 16 })));
  const laterItems = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  assert.ok(laterItems.some(item => item.textContent?.trim() === 'Отправить позже'), 'conv9 открывает планирование времени');
  assert.ok(!laterItems.some(item => item.textContent?.trim() === 'Отправить без звука'), 'без conv8 нельзя выбрать тихую отправку');
});

it('DmChatView всегда показывает «когда будет в сети» при conv9 независимо от presence', async () => {
  // В сети этот режим означает отправку ближайшим тактом, а offline — ожидание; присутствие меняет только срок, не доступность.
  localStorage.setItem('gv_dm_bubbles', '1');
  const openSendMenu = async () => {
    const field = host.querySelector<HTMLTextAreaElement>('.composer-input');
    const send = host.querySelector<HTMLButtonElement>('.composer .send-btn');
    assert.ok(field && send, 'composer готов к меню отправки');
    await flush(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'текст');
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'текст' }));
    });
    await flush(() => send.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(item => item.textContent?.trim());
  };
  const conv = (phase: 'live' | 'idle') => ({ ...initial.conv, phase, pts: 50, summaries: {} }) as never;
  await mountPinEnabledDm({ serverFeatures: ['conv9'], onlineUsers: ['peer'], conv: conv('live') });
  let options = await openSendMenu();
  assert.ok(options.includes('Когда будет в сети'), 'live + online тоже оставляет пункт доступным');
  await unmountMounted();
  await mountPinEnabledDm({ serverFeatures: ['conv9'], onlineUsers: ['peer'], conv: conv('idle') });
  options = await openSendMenu();
  assert.ok(options.includes('Когда будет в сети'), 'idle + прежний online не скрывает тот же пункт');
});

it('DmChatView отправляет отложенное сейчас, обновляет стор и закрывает опустевший вид', async () => {
  // Удалённая из расписания запись обязана появиться в ленте, а нулевой снимок закрывает вид как в Telegram.
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const oldList = api.convScheduled;
  const oldSendNow = api.convScheduledSendNow;
  const item = scheduleItem('send-now');
  const sent = { id: 'sent-now', conversationId: 'pins-dm', channelId: 'pins-dm', sortKey: 77, clientId: item.clientId,
    content: item.content, createdAt: '2026-10-06T09:00:00.000Z', editedAt: null, authorId: 'me', author: { id: 'me' },
    attachments: [], reactions: [], replyTo: null };
  const calls: string[] = [];
  api.convScheduled = async () => ({ pts: 1, items: [item] });
  api.convScheduledSendNow = async (_convId, id) => { calls.push(id); return { pts: 2, items: [], message: sent as never }; };
  localStorage.setItem('gv_dm_bubbles', '1');
  try {
    const summary = { id: 'pins-dm', scheduledCount: 1 } as never;
    await mountPinEnabledDm({ serverFeatures: ['conv9'], conv: { ...initial.conv, pts: 50, phase: 'live', summaries: { 'pins-dm': summary } } as never });
    const open = host.querySelector<HTMLButtonElement>('.composer .att-btn.sched');
    assert.ok(open, 'счётчик расписания открывает вид отложенных');
    await flush(() => open.click());
    await flush();
    const row = host.querySelector<HTMLElement>('.sched-view .message[aria-haspopup="menu"]');
    assert.ok(row, 'после загрузки у вида есть строка отложенного сообщения');
    assert.ok(row.textContent?.includes(item.content), 'вид получает актуальный серверный снимок');
    await flush(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    const send = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.trim() === 'Отправить сейчас');
    assert.ok(send, 'контекстное меню предлагает немедленную отправку');
    await flush(() => send.click());
    await flush();
    assert.deepEqual(calls, ['send-now'], 'в API передан id выбранного отложенного');
    assert.deepEqual(store.getState().conv.scheduled?.['pins-dm']?.list, [], 'ответ с пустым списком обновляет снимок в сторе');
    assert.ok(store.getState().dmMessages['pins-dm']?.some(message => message.id === 'sent-now'), 'отправленный результат добавлен в историю беседы');
    assert.ok(!host.querySelector('.sched-view'), 'после опустошения расписания вид закрывается автоматически');
  } finally { api.convScheduled = oldList; api.convScheduledSendNow = oldSendNow; }
});

it('DmChatView закрывает расписание и показывает тост, если свежий список не загрузился', async () => {
  // Ошибка загрузки не должна оставлять пустой вид с бесконечной загрузкой вместо возврата в беседу.
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const oldList = api.convScheduled;
  api.convScheduled = async () => { throw new Error('temporary failure'); };
  localStorage.setItem('gv_dm_bubbles', '1');
  try {
    const summary = { id: 'pins-dm', scheduledCount: 1 } as never;
    await mountPinEnabledDm({ serverFeatures: ['conv9'], conv: { ...initial.conv, pts: 50, phase: 'live', summaries: { 'pins-dm': summary } } as never });
    const open = host.querySelector<HTMLButtonElement>('.composer .att-btn.sched');
    assert.ok(open, 'для расписания есть вход из composer');
    await flush(() => open.click());
    await flush();
    assert.ok(!host.querySelector('.sched-view'), 'неудачная загрузка закрывает отложенный вид');
    assert.ok(toasts.getState().toasts.some(item => item.title === 'Не удалось загрузить отложенные' && item.subtitle === 'temporary failure'),
      'пользователь видит причину отказа вместо пустого экрана');
  } finally { api.convScheduled = oldList; }
});

it('SchedPick на телефоне показывает лист и после выбора вызывает onPick перед единственным onClose', async () => {
  // Порядок важен: хозяин получает выбранную дату до закрытия и может сохранить её в очередь.
  const order: string[] = [];
  await mount(SchedPick, { text: 'короткий текст', now: new Date('2026-10-05T12:00:00Z'), phone: true,
    onPick: () => order.push('pick'), onClose: () => order.push('close') });
  assert.ok(document.body.querySelector('.sheet[role="dialog"]'), 'телефонная форма открывается нижним листом');
  const quick = document.body.querySelector<HTMLButtonElement>('.sheet .sched-q');
  assert.ok(quick, 'быстрый вариант доступен внутри листа');
  await flush(() => quick?.click());
  await flush(() => quick?.click());
  assert.deepEqual(order, ['pick', 'close'], 'выбор один раз предшествует закрытию, повторы игнорируются');
});

it('SchedPick на телефоне закрывается Escape без выбора времени', async () => {
  // BottomSheet обязан сохранять клавиатурный способ закрытия, а не только жест и касание мимо.
  let picked = 0;
  let closed = 0;
  await mount(SchedPick, { text: '', now: new Date('2026-10-05T12:00:00Z'), phone: true,
    onPick: () => picked++, onClose: () => closed++ });
  assert.ok(document.body.querySelector('.sheet-scrim .sheet'), 'телефонный лист смонтирован в портале');
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(picked, 0, 'Escape не выбирает время');
  assert.equal(closed, 1, 'Esc закрывает лист ровно один раз');
});

it('удержание глотает click того же касания и не отправляет выбранное фото', async () => {
  // На телефоне click после long-press может попасть уже в появившийся пункт меню; именно это касание не должно его нажать.
  const state = await mountMedia({ silent: true, later: false, scheduleMedia: false });
  const send = document.body.querySelector<HTMLButtonElement>('.gal-send-btn[aria-label="Отправить: 1"]');
  assert.ok(send, 'после выбора фото доступна отправка одного вложения');
  await flush(() => send!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'touch' })));
  await act(async () => { await new Promise(resolve => nativeTimeout(resolve, 475)); });
  await flush();
  assert.ok(document.body.querySelector('.gal-hold'), 'удержание открыло меню до отпускания пальца');
  await flush(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'touch' }));
    document.body.querySelector<HTMLButtonElement>('.gal-hold [role="menuitem"]')?.click();
  });
  assert.ok(document.body.querySelector('.gal-hold'), 'click того же касания не закрыл и не активировал меню');
  assert.equal(state.sends.length, 0, 'самопопавшее касание не отправило вложение без звука');
});

it('варианты позже и когда будет в сети отключены без серверной поддержки вложений', async () => {
  // Текстовая capability не означает поддержку файлов: показываем причины отказа, но не выдаём кликабельное обещание.
  await mountMedia({ silent: false, later: true, scheduleMedia: false });
  const send = document.body.querySelector<HTMLButtonElement>('.gal-send-btn[aria-label="Отправить: 1"]');
  assert.ok(send, 'выбранное вложение позволяет открыть меню действий');
  await flush(() => send!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  const later = [...document.body.querySelectorAll<HTMLButtonElement>('.gal-hold [role="menuitem"]')]
    .find(button => button.textContent?.includes('Отправить позже'));
  const online = [...document.body.querySelectorAll<HTMLButtonElement>('.gal-hold [role="menuitem"]')]
    .find(button => button.textContent?.includes('Когда будет в сети'));
  assert.ok(later, 'меню объясняет, что можно отправить позже');
  assert.ok(online, 'меню объясняет вариант ожидания собеседника');
  assert.equal(later!.disabled, true, 'отправка позже недоступна без scheduleMedia');
  assert.equal(online!.disabled, true, 'отправка при появлении в сети недоступна без scheduleMedia');
  assert.equal(document.body.querySelectorAll('.gal-hold .ctx-sublabel').length, 2,
    'обе недоступные возможности сообщают, что вложения пока не поддержаны');
});

it('Esc закрывает верхний слой MediaSheet первым, а лист — только следующим нажатием', async () => {
  // Нельзя закрыть всю галерею случайным Escape, когда поверх неё открыт hold-слой или выбор времени.
  const state = await mountMedia({ silent: false, later: true, scheduleMedia: true });
  const send = document.body.querySelector<HTMLButtonElement>('.gal-send-btn[aria-label="Отправить: 1"]');
  assert.ok(send, 'на выбранном фото есть кнопка удержания');
  await flush(() => send!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  assert.ok(document.body.querySelector('.gal-hold'), 'меню удержания открыто поверх галереи');
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.ok(!document.body.querySelector('.gal-hold'), 'первый Escape закрыл верхнее меню');
  assert.ok(document.body.querySelector('.sheet[role="dialog"]'), 'первый Escape оставил галерею открытой');
  assert.equal(state.closed, 0, 'закрытие верхнего слоя не вызвало onClose галереи');
  await flush(() => send!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await flush(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2, pointerType: 'touch' })));
  await act(async () => { await new Promise(resolve => nativeTimeout(resolve, 410)); });
  const later = [...document.body.querySelectorAll<HTMLButtonElement>('.gal-hold [role="menuitem"]')]
    .find(button => button.textContent?.includes('Отправить позже'));
  assert.ok(later, 'повторное меню содержит переход к планированию');
  await flush(() => later!.click());
  assert.ok(document.body.querySelector('.modal-overlay'), 'выбор времени открыл отдельный верхний диалог поверх галереи');
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.ok(!document.body.querySelector('.modal-overlay'), 'Escape закрыл верхний диалог выбора времени');
  assert.equal(document.body.querySelectorAll('.sheet[role="dialog"]').length, 1,
    'при закрытии верхнего диалога родительская галерея осталась открыта');
  assert.equal(state.closed, 0, 'закрытие вложенного листа не закрыло родителя');
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(state.closed, 1, 'следующий Escape закрыл родительскую галерею ровно один раз');
});

it('NotAllowedError камеры во время скрытия не запускает повторный запрос до явного нажатия', async () => {
  // Android может отказать, пока приложение за системным окном разрешения; возврат на экран не должен зациклить запросы.
  mediaMock.camera = true;
  mediaMock.cameraSupported = true;
  let rejectFirst!: (error: unknown) => void;
  mediaMock.openCamera = () => mediaMock.openCameraCalls === 1
    ? new Promise((_resolve, reject) => { rejectFirst = reject; })
    : new Promise(() => {});
  await mountMedia(undefined);
  assert.equal(mediaMock.openCameraCalls, 1, 'разрешённая камера начала ровно одну попытку');
  const setVisibility = (value: DocumentVisibilityState) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  await flush(() => setVisibility('hidden'));
  await act(async () => {
    rejectFirst(new DOMException('denied', 'NotAllowedError'));
    await new Promise<void>(resolve => setImmediate(resolve));
  });
  await flush(() => setVisibility('visible'));
  assert.equal(mediaMock.openCameraCalls, 1, 'возврат из скрытого состояния не повторил отказавший системный запрос');
  const camera = document.body.querySelector<HTMLButtonElement>('.gal-cam');
  assert.ok(camera, 'после отказа осталась доступна ячейка камеры для осознанной попытки');
  await flush(() => camera!.click());
  assert.equal(mediaMock.openCameraCalls, 2, 'явное нажатие на ячейку разрешает новую попытку');
});

it('кнопка «Выбрать ещё» перечитывает галерею при partial → partial', async () => {
  // Android может вернуть тот же статус partial, но с новым набором выбранных фото; сетка должна обновиться без смены статуса.
  mediaMock.perm = 'partial';
  mediaMock.permissionResult = 'partial';
  await mountMedia(undefined);
  assert.equal(mediaMock.galleryPageCalls, 1, 'при первом частичном доступе загружена исходная порция');
  const chooseMore = [...document.body.querySelectorAll<HTMLButtonElement>('.gal-notice button')]
    .find(button => button.textContent?.trim() === 'Выбрать ещё');
  assert.ok(chooseMore, 'частичный доступ предлагает выбрать дополнительные фото');
  await flush(() => chooseMore!.click());
  assert.equal(mediaMock.galleryPageCalls, 2, 'неизменившийся статус partial всё равно перезагрузил первую порцию');
});

it('MobileNav доступна по имени, переключает разделы и открывает профиль на вкладке телефона', async () => {
  // Подсветка вкладки и состояние приложения должны переключаться вместе, а профиль — закрываться при возврате к разделу.
  let loads = 0;
  store.setState({ ...initial, view: 'server', mobilePane: 'content', mobileProfileOpen: false, settingsOpen: false,
    unreadDms: ['d1'], loadDms: async () => { loads++; } });
  await mount(MobileNav, {});
  const nav = host.querySelector('nav.mobile-nav[aria-label="Разделы"]');
  assert.ok(nav, 'навигация имеет понятное доступное имя');
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('button.mnav-tab')];
  assert.deepEqual(buttons.map(button => button.textContent?.trim()), ['Серверы', 'Сообщения', 'Профиль']);
  assert.equal(buttons.filter(button => button.getAttribute('aria-current') === 'page').length, 1,
    'ровно один обычный раздел отмечен текущим');
  const paths = buttons.map(button => [...button.querySelectorAll('svg path')].map(path => path.getAttribute('d')));
  assert.deepEqual(paths, [
    ['M9 8 a3.2 3.2 0 1 0 0 6.4 a3.2 3.2 0 0 0 0 -6.4 Z', 'M3 20 a6 6 0 0 1 12 0', 'M16 6 a3 3 0 0 1 0 6', 'M16.5 14 a6 6 0 0 1 4.5 6'],
    ['M3 5 h18 v14 h-18 z', 'M3 7 L12 13 L21 7'],
    ['M12 7 a3.5 3.5 0 1 0 0 7 a3.5 3.5 0 0 0 0 -7 Z', 'M5 20 a7 7 0 0 1 14 0'],
  ], 'вкладки используют именно users, mail и user, а не похожие по виду иконки');
  await flush(() => buttons[1]?.click());
  assert.equal(store.getState().view, 'dm', 'Сообщения переводят приложение в ЛС');
  assert.equal(store.getState().mobilePane, 'list', 'переход возвращает на список, а не оставляет пустой контент');
  assert.equal(loads, 1, 'вход в Сообщения перечитывает список бесед');
  assert.equal(host.querySelectorAll('button.mnav-tab[aria-current="page"]').length, 1, 'Сообщения становятся единственной текущей вкладкой');
  assert.equal(host.querySelector('button.mnav-tab[aria-current="page"] .mnav-label')?.textContent, 'Сообщения');
  await flush(() => buttons[2]?.click());
  assert.equal(store.getState().mobileProfileOpen, true, 'Профиль открывает экран профиля');
  assert.equal(host.querySelector('button.mnav-tab[aria-current="page"] .mnav-label')?.textContent, 'Профиль', 'открытый профиль отмечен текущим');
  await flush(() => buttons[0]?.click());
  assert.equal(store.getState().view, 'server', 'Серверы возвращают серверный раздел');
  assert.equal(store.getState().mobileProfileOpen, false, 'переход из профиля закрывает его экран');
  assert.equal(store.getState().mobilePane, 'list', 'серверный раздел открывается со списком');
  await flush(() => store.setState({ ...store.getState(), settingsOpen: true }));
  assert.equal(host.querySelectorAll('button.mnav-tab[aria-current="page"]').length, 0,
    'пока открыты настройки, навигация не объявляет вкладку текущей');
});

it('рейл растворяется только на телефонных экранах без рейла и оставляет модальные окна видимыми', () => {
  // display:none на предке скрыл бы вложенное окно приглашения даже при открытии внешней ссылки.
  const layout = readFileSync(new URL('./MainLayout.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(layout, /if \(isDm \|\| profileShown\) appClass\.push\('m-norail'\)/,
    'MainLayout включает режим без рейла для ЛС и профиля');
  assert.match(layout, /const phone = usePhoneLayout\(\)[\s\S]*?const profileShown = phone && mobileProfileOpen/,
    'полный экран профиля привязан к ширине телефона, а не к наличию нативной оболочки');
  assert.doesNotMatch(layout, /const profileShown = isMobile\(\)/,
    'мобильный браузер тоже получает профильный экран');
  assert.match(css, /\.app\.m-list\.m-norail > \.rail,[\s\S]*?\.app\.m-content > \.rail\s*\{\s*display:\s*contents;/,
    'на мобильных вариантах рейл остаётся прозрачным для layout, а не удаляется');
  assert.match(css, /\.app\.m-list\.m-norail > \.rail > :not\(\.modal-overlay\),[\s\S]*?\.app\.m-content > \.rail > :not\(\.modal-overlay\)\s*\{\s*display:\s*none;/,
    'скрываются элементы рейла, но его окна остаются исключением');
});

it('MobileCallChip возвращает с вкладки ЛС в звонок и открывает канал уже в серверном виде', async () => {
  // Открытие только канала оставляло пользователя в ЛС с пустым экраном; важен порядок переключения и вызова канала.
  const order: string[] = [];
  const voice = { channelId: 'voice-1', url: '', token: '', instanceId: null, serverId: 'server-1', channelName: 'Комната',
    serverName: 'Дом', instanceName: 'Дом', self: null, selfId: null };
  store.setState({ ...initial, voice, view: 'dm', mobilePane: 'list', currentServerId: 'server-1',
    openChannel: async (id) => { order.push(`channel:${store.getState().view}:${id}`);
      store.setState({ ...store.getState(), currentChannelId: id, mobilePane: 'content' }); },
    openServer: async (id) => { order.push(`server:${id}`); store.setState({ ...store.getState(), view: 'server', currentServerId: id }); } });
  await mount(MobileCallChip, {});
  await flush(() => host.querySelector<HTMLElement>('.call-chip')!.click());
  assert.deepEqual(order, ['channel:server:voice-1'], 'с ЛС переключается на серверный вид прежде, чем открывает канал голоса');
  assert.equal(store.getState().currentChannelId, 'voice-1', 'открыт именно канал текущего звонка');
  assert.equal(store.getState().mobilePane, 'content', 'после открытия виден контент звонка, а не пустой список');
});

it('MobileCallChip сначала открывает другой сервер того же инстанса, а потом канал голоса', async () => {
  // При уже серверной вкладке смена только currentChannelId не переносит боковую панель к голосовому серверу.
  const order: string[] = [];
  const voice = { channelId: 'voice-2', url: '', token: '', instanceId: null, serverId: 'server-voice', channelName: 'Голос',
    serverName: 'Дом', instanceName: 'Дом', self: null, selfId: null };
  store.setState({ ...initial, voice, view: 'server', mobilePane: 'list', currentServerId: 'server-other',
    openChannel: async (id) => { order.push(`channel:${id}`); },
    openServer: async (id) => { order.push(`server:${id}`); } });
  await mount(MobileCallChip, {});
  await flush(() => host.querySelector<HTMLElement>('.call-chip')!.click());
  assert.deepEqual(order, ['server:server-voice', 'channel:voice-2'], 'сервер голоса загружается раньше канала');
});

it('отказ при открытии сервера звонка становится обработанной ошибкой-тостом', async () => {
  // Переход к упавшему серверу не должен превращаться в необработанное Promise rejection из обработчика клика.
  const error = new Error('сервер недоступен');
  callChipMock.errors = [];
  const voice = { channelId: 'voice-3', url: '', token: '', instanceId: null, serverId: 'server-voice', channelName: 'Голос',
    serverName: 'Дом', instanceName: 'Дом', self: null, selfId: null };
  store.setState({ ...initial, voice, view: 'server', mobilePane: 'list', currentServerId: 'server-other',
    openServer: async () => { throw error; }, openChannel: async () => { assert.fail('канал не открывается после отказа сервера'); } });
  await mount(MobileCallChip, {});
  await flush(() => host.querySelector<HTMLElement>('.call-chip')!.click());
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(callChipMock.errors, [error], 'ошибка перехода передана обработчику тостов ровно один раз');
});

it('голос на другом инстансе возвращает к нему, не открывая канал на текущем', async () => {
  // Чужого сервера нет в локальном bootstrap: единственный безопасный переход — общий returnToVoice.
  callChipMock.returned = [];
  const voice = { channelId: 'away-voice', url: '', token: '', instanceId: 'instance-away', serverId: 'server-away', channelName: 'Голос',
    serverName: 'Чужой', instanceName: 'Чужой', self: null, selfId: null };
  let opened = 0;
  store.setState({ ...initial, voice, currentServerId: 'server-home', openChannel: async () => { opened++; } });
  await mount(MobileCallChip, {});
  await flush(() => host.querySelector<HTMLElement>('.call-chip')!.click());
  assert.equal(callChipMock.returned[0], voice, 'передана именно запись голоса с его instanceId');
  assert.equal(opened, 0, 'канал удалённого инстанса не открывают локальным роутером');
});

it('MainLayout показывает чип в мобильном браузере и приложении, но не на обычном ПК', () => {
  // Телефонный браузер скрывает VoicePanel стилями, поэтому gate обязан учитывать ширину отдельно от isMobile().
  const layout = readFileSync(new URL('./MainLayout.tsx', import.meta.url), 'utf8');
  const gate = layout.match(/\{(\(isMobile\(\) \|\| phone\) && voice && mobilePane === 'list' && !mobileProfileOpen) && <MobileCallChip \/>\}/);
  assert.ok(gate, 'найдено условие показа настоящего MobileCallChip в MainLayout');
  // nosemgrep: gv-no-eval — тест исполняет условие, вырезанное регуляркой из своего же MainLayout.tsx; чужого ввода нет.
  const shouldShow = new Function('isMobile', 'phone', 'voice', 'mobilePane', 'mobileProfileOpen', // nosemgrep: gv-no-eval
    `return ${gate![1]};`) as (...args: [boolean, boolean, boolean, string, boolean]) => boolean;
  const visible = (app: boolean, phone: boolean, voice: boolean, pane: string, profile: boolean) =>
    (shouldShow as unknown as (isMobile: () => boolean, phone: boolean, voice: boolean, pane: string, profile: boolean) => boolean)(
      () => app, phone, voice, pane, profile);
  const results = [
    ['телефонный браузер', visible(false, true, true, 'list', false)],
    ['обычный ПК', visible(false, false, true, 'list', false)],
    ['приложение при широкой раскладке', visible(true, false, true, 'list', false)],
  ];
  assert.deepEqual(results, [['телефонный браузер', true], ['обычный ПК', false], ['приложение при широкой раскладке', true]],
    'ответы gate совпадают для мобильного браузера, обычного ПК и приложения любой ширины');
  assert.equal(visible(true, false, true, 'content', false), false, 'в полном экране звонка второй чип не дублирует панель');
  assert.equal(visible(true, false, true, 'list', true), false, 'открытый профиль скрывает чип');
  assert.ok(layout.includes('const phone = usePhoneLayout()'), 'ширина телефона определяется тем же responsive-hook, что и остальной интерфейс');
});

it('ответ на видео показывает в ReplyQuote камеру, а не значок файла', async () => {
  // Видео остаётся видом «файл» для текста цитаты; отдельное правило обязано менять именно визуальную подсказку на камеру.
  const rules = await server.ssrLoadModule('/src/bubbleRules.ts') as typeof import('../bubbleRules');
  const reply = { content: '', deleted: false, attachments: 1, attachmentKind: 'file' as const, attachmentVideo: true as const,
    attachmentDurationMs: 12_000, attachmentName: 'clip.mp4' };
  const original = { attachments: [{ contentType: 'video/mp4', durationMs: 12_000 }], sticker: null } as never;
  assert.equal(rules.replyQuoteVideo(reply, original), true, 'вложение video/* определяется как видеответ');
  const look = rules.replyQuoteLook(reply, original);
  assert.equal(look.kind, 'file', 'текстовый тип остаётся совместимым с прежней подписью файла');
  assert.match(look.text, /Видео/, 'цитата говорит о видео, а не о произвольном файле');
  await mount(ReplyQuote, { author: 'Собеседник', text: look.text, kind: 'video' });
  const preview = host.querySelector('.reply-quote .rq-thumb');
  assert.ok(preview, 'у видео есть отдельная иконка-ячейка как у других вложений');
  assert.equal(preview!.querySelector('svg path')?.getAttribute('d'), 'M3 7 a2 2 0 0 1 2 -2 h8 a2 2 0 0 1 2 2 v10 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 Z',
    'в ячейке цитаты нарисована именно камера');
});
