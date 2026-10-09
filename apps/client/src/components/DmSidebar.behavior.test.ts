import assert from 'node:assert/strict';
import { after, afterEach, before, it } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessagePort } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createServer, type ViteDevServer } from 'vite';
import { act, createElement as el, useState, type ComponentType } from 'react';
import type { Root } from 'react-dom/client';
import type { Channel, ConvSummary, DmChannel } from '@gusvoice/shared';
import type { OutboxItem } from '../outboxRules';
import type { ContextMenuProps, ReactionBarProps } from './ContextMenu';
import type { ForwardPickerProps } from './ForwardPicker';

// Настоящие компоненты и стор; HappyDOM проверяет DOM/события, не геометрию и не визуальную приёмку.
const nativeTimeout = globalThis.setTimeout, nativeInterval = globalThis.setInterval;
const nativeClear = globalThis.clearTimeout;
const handles = () => (process as unknown as { _getActiveHandles(): object[] })._getActiveHandles();
const originalHandles = new Set(handles());
const mutant = process.env.GUSVOICE_DM_ROW_MUTANT;
const mutations: Record<string, (s: string) => string> = {
  'ошибка': s => s.replace('{failed ? (', '{false ? ('),
  'телефон': s => s.replace('active={!phone && d.id === currentDmId}', 'active={d.id === currentDmId}'),
  'печатает': s => s.replace('useTyping(dm.id).includes(dm.otherUser.id)', 'useTyping(dm.id).length > 0'),
  'гость': s => s.replace('if (blocked) {', 'if (false) {'),
  'устаревший-поиск': s => s.replaceAll('if (round.current !== mine) return;', 'if (false) return;'),
  'дебаунс-поиска': s => s.replace('}, USER_SEARCH_DELAY_MS);', '}, 0);'),
  'дубль-поиска': s => s,
  'гость-поиск': s => s.replace('&& !me?.homeInstance;', '&& true;'),
  'закрытый-сервер': s => s,
  'назад-поиск-беседа': s => s.replace("if (st.mobilePane === 'content' || st.settingsOpen || st.adminOpen || st.mobileProfileOpen) return false;", "if (st.settingsOpen || st.adminOpen || st.mobileProfileOpen) return false;"),
  'назад-поиск-настройки': s => s.replace("if (st.mobilePane === 'content' || st.settingsOpen || st.adminOpen || st.mobileProfileOpen) return false;", "if (st.mobilePane === 'content' || st.adminOpen || st.mobileProfileOpen) return false;"),
};
const timers = new Set<ReturnType<typeof setTimeout>>();
let server: ViteDevServer, root: Root | undefined, host: HTMLDivElement;
let createRoot: typeof import('react-dom/client').createRoot;
let Sidebar: ComponentType, Chat: ComponentType<{ dm: DmChannel }>, Layout: ComponentType, App: ComponentType;
let Menu: ComponentType<ContextMenuProps>, Bar: ComponentType<ReactionBarProps>, Picker: ComponentType<ForwardPickerProps>;
let Row: typeof import('./DmSidebar').DmRow;
let quick: readonly string[];
let store: typeof import('../store').useStore;
let typing: typeof import('../typing'), compose: typeof import('../dmCompose');
let toasts: typeof import('../toast').useToasts;
let blockText: typeof import('../dmRules').dmBlockText;
let initial: ReturnType<typeof store.getState>, phone = false, narrow = false;
type Patch = Partial<ReturnType<typeof store.getState>>;
const outgoing = (status: 'failed' | 'sending' = 'failed'): OutboxItem => ({ key:'k',convId:'c',content:'x',files:[],replyToId:null,
  status,createdAt:Date.now(),attempts:1,uploaded:[],fileNames:[],retryAt:0,error:null });
const peer = { id: 'peer', username: 'cat', displayName: 'Учёный Кот', avatarUrl: null };
const dm = (id = 'c', unread = 0): DmChannel => ({ id, otherUser: peer, createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString(), unread });
const summary = (patch: Partial<ConvSummary> = {}): ConvSummary => ({ ...dm(), kind: 'direct', unread: 0, lastReadKey: 0, peerReadKey: 10,
  lastMessage: { id: 'm', authorId: 'me', sortKey: 10, text: 'текст', attachments: 0, createdAt: new Date().toISOString() }, ...patch });
const wait = (ms = 20) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function flush(fn: () => void = () => {}) { await act(async () => { fn(); await wait(); }); }
async function mount<P extends object>(component: ComponentType<P>, props: P): Promise<HTMLDivElement>;
async function mount(): Promise<HTMLDivElement>;
async function mount(component: ComponentType<any> = Sidebar, props: object = {}) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await flush(() => root!.render(el(component, props))); return host;
}
async function state(patch: Patch) { await flush(() => store.setState(patch)); }
async function closedServerAppScenario() {
  const { api, setToken } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const savedMe = api.me, savedSetup = api.setupStatus;
  const cfg = await server.ssrLoadModule('/src/config.ts') as typeof import('../config');
  const pending = await server.ssrLoadModule('/src/pendingOpen.ts') as typeof import('../pendingOpen');
  if (!cfg.activeInstanceId()) cfg.addInstance({ apiUrl: 'https://home.test', presenceWs: '' }, { name: 'Дом', activate: true });
  const noOp = async () => {};
  const channels: string[] = [];
  try {
    api.me = async () => ({ id: 'me', username: 'me', displayName: 'Я', avatarUrl: null, features: [] }) as never;
    api.setupStatus = async () => ({ needsSetup: false, tokenConfigured: true, wizardPending: false }) as never;
    setToken('session');
    store.setState({ ...initial, user: null, serverFeatures: [], servers: [{ id: 'closed', name: 'Закрытый' }],
      currentServerId: null, currentDmId: null, accessNotice: null, loadServers: noOp, loadPushMutes: noOp,
      loadBlocks: noOp, restoreVoiceSession: noOp, listenTabs: () => {}, setConvActive: () => {}, setConvCacheKey: () => {},
      convReset: () => {}, openServer: async () => { throw Object.assign(new Error('federation.server_closed'), { status: 403, reason: 'federation_disabled' }); },
      openChannel: async (id: string) => { channels.push(id); } } as never, true);
    pending.setPendingOpen({ instanceId: cfg.activeInstanceId()!, serverId: 'closed', channelId: 'should-not-open' });
    await mount(App, {}); await flush();
    assert.equal(store.getState().accessNotice?.serverId, 'closed', '403 server_closed сохраняет accessNotice в настоящем App');
    assert.deepEqual(channels, [], 'канал не вызывается после отказа открыть сервер');
  } finally { api.me = savedMe; api.setupStatus = savedSetup; setToken(null); }
}
async function input(value: string) {
  const field = host.querySelector<HTMLInputElement>('input') ?? document.querySelector<HTMLInputElement>('input')!;
  await flush(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
it('панель выбора держит порядок read/clear/block и скрывает невозможные действия', async () => {
  // Смешанный выбор с заблокированным собеседником не должен предлагать повторную блокировку.
  const { DmPickHead } = await server.ssrLoadModule('/src/components/DmRowMenu.tsx') as typeof import('./DmRowMenu');
  await seed({ serverFeatures: ['conv11', 'conv12', 'conv13'], blockedUsers: [] });
  await mount(DmPickHead, { ids: ['c'], isMuted: () => false, onClose() {} });
  await flush(() => host.querySelector<HTMLButtonElement>('[aria-label="Ещё"]')!.click());
  const labels = () => [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].map((b) => b.textContent?.trim());
  assert.deepEqual(labels(), ['Пометить как непрочитанное', 'Очистить историю', 'Заблокировать']);
  await state({ blockedUsers: [peer as never], serverFeatures: ['conv13'] });
  assert.deepEqual(labels(), ['Пометить как непрочитанное']);
  await state({ blockedUsers: [], dms: [dm('c', 1)] });
  assert.deepEqual(labels(), ['Пометить как прочитанное', 'Заблокировать']);
});
it('массовая блокировка ждёт одно подтверждение, отказ ничего не пишет и согласие блокирует каждого', async () => {
  // Подтверждение опасной пачки не может превратиться в N окон или частичную блокировку до ответа.
  const { blockDms } = await server.ssrLoadModule('/src/components/DmRowMenu.tsx') as typeof import('./DmRowMenu');
  const { useConfirmDialog } = await server.ssrLoadModule('/src/confirm.ts') as typeof import('../confirm');
  const dms = [dm('a'), { ...dm('b'), otherUser: { ...peer, id: 'second' } }];
  const blocked: string[] = [];
  await seed({ setBlocked: async (user, value) => { assert.equal(value, true); blocked.push(user.id); } });
  for (const answer of [false, true]) {
    const pending = blockDms(dms);
    assert.ok(useConfirmDialog.getState().pending); assert.deepEqual(blocked, []);
    useConfirmDialog.getState().answer(answer); assert.equal(await pending, answer);
    assert.deepEqual(blocked, answer ? ['peer', 'second'] : []);
    assert.equal(useConfirmDialog.getState().pending, null);
  }
});
it('кнопка скорости со своим onChange меняет видео, но не общую скорость голосовых', async () => {
  // Ловит изменение всех голосовых из локального меню скорости просмотрщика.
  const { VoiceSpeedButton } = await server.ssrLoadModule('/src/components/VoiceSpeedButton.tsx') as typeof import('./VoiceSpeedButton');
  const playback = await server.ssrLoadModule('/src/voicePlayback.ts') as typeof import('../voicePlayback');
  const old=playback.getVoiceSpeed(); const calls:number[]=[];
  try {
    playback.setVoiceSpeed(1.5); await mount(VoiceSpeedButton,{value:1,onChange:(n:number)=>calls.push(n),spedUp:2});
    await flush(()=>host.querySelector<HTMLButtonElement>('button')!.click());
    assert.deepEqual(calls,[2]); assert.equal(playback.getVoiceSpeed(),1.5);
  } finally { await flush(()=>playback.setVoiceSpeed(old)); }
});

it('Esc просмотрщика сначала закрывает меню, затем просмотр; Space удерживает x2 и не запоминает его', async () => {
  // Ловит закрытие всего просмотрщика одним Esc из меню и сохранение временного ускорения навсегда.
  const { Lightbox }=await server.ssrLoadModule('/src/components/Lightbox.tsx') as typeof import('./Lightbox');
  let closed=0;
  await mount(Lightbox,{images:[{url:'/video.webm',name:'video',video:true}],index:0,onIndex(){},onClose:()=>{closed++;},
    actions:()=>[{id:'goto' as const,label:'К сообщению',icon:'signal' as const,run(){}}]});
  const video=document.querySelector('video'); assert.ok(video);
  video.play=async()=>{}; video.pause=()=>{};
  await flush(()=>video.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20})));
  assert.ok(document.querySelector('.ctx-menu'));
  await flush(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',cancelable:true})));
  assert.equal(document.querySelector('.ctx-menu'),null); assert.equal(closed,0);
  const down=new KeyboardEvent('keydown',{key:' ',code:'Space',cancelable:true});
  await flush(()=>window.dispatchEvent(down)); assert.equal(down.defaultPrevented,true);
  await act(async()=>{await new Promise<void>(r=>nativeTimeout(r,230));}); assert.equal(video.playbackRate,2);
  await flush(()=>video.dispatchEvent(new Event('ratechange',{bubbles:true})));
  await flush(()=>window.dispatchEvent(new KeyboardEvent('keyup',{key:' ',code:'Space',cancelable:true})));
  assert.equal(video.playbackRate,1, 'ratechange временного x2 не подменяет выбранную скорость');
  await flush(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',cancelable:true}))); assert.equal(closed,1);
});

it('удержание аватара открывает меню, строки включает выбор, без onPick строка тоже открывает меню', async () => {
  // Ловит перепутанный адрес долгого нажатия: меню аватара не должно включать массовый выбор.
  const menus: string[] = []; const picks: string[] = [];
  const props = { dm: dm(), summary: summary(), meId: 'me', online: false, active: false, unread: false, unreadN: 0,
    draft: '', failed: false, query: '', phone: true,
    onOpen() {}, onMenu: (d: DmChannel) => { menus.push(d.id); }, onPick: (id: string) => { picks.push(id); } };
  await mount(Row, props);
  const hold = async (avatar: boolean) => {
    const target = host.querySelector(avatar ? '.dm-ava' : '.dm-row')!; assert.ok(target);
    await flush(() => target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [{ clientX: 10, clientY: 10, identifier: 1 } as Touch] })));
    await act(async () => { await new Promise<void>(r => nativeTimeout(r, 520)); });
    await flush(() => target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] })));
  };
  await hold(true); assert.deepEqual(menus, ['c']); assert.deepEqual(picks, []);
  await hold(false); assert.deepEqual(picks, ['c']); assert.deepEqual(menus, ['c']);
  await flush(() => root!.render(el(Row, { ...props, onPick: undefined })));
  await hold(false); assert.deepEqual(menus, ['c','c']); assert.deepEqual(picks, ['c']);
});

it('тост с действием живёт пять секунд, обычный 3,8, явный срок перекрывает оба, sticky не имеет таймера', async () => {
  // Ловит слишком короткое окно «Отмены» и случайное автоматическое закрытие sticky.
  const { ToastHost } = await server.ssrLoadModule('/src/components/ToastHost.tsx') as typeof import('./ToastHost');
  const delays: number[] = []; const saved = globalThis.setTimeout;
  try {
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms === 3800 || ms === 5000 || ms === 1234) delays.push(ms);
      return saved(fn, ms, ...args);
    }) as typeof setTimeout;
    toasts.getState().push({ type: 'info', title: 'обычный' });
    toasts.getState().push({ type: 'info', title: 'действие', action: { label: 'Отмена', onClick() {} } });
    toasts.getState().push({ type: 'info', title: 'явный', durationMs: 1234 });
    toasts.getState().push({ type: 'info', title: 'вечный', sticky: true });
    await mount(ToastHost, {}); assert.deepEqual(delays.sort((a,b) => a-b), [1234, 3800, 5000]);
  } finally { globalThis.setTimeout = saved; }
});

it('ConfirmHost по умолчанию рисует корзину только danger, явная иконка перекрывает оба тона', async () => {
  // Ловит одинаковую опасную иконку у всех окон и потерю специального предупреждения.
  const { ConfirmHost } = await server.ssrLoadModule('/src/components/ConfirmHost.tsx') as typeof import('./ConfirmHost');
  const { Icon } = await server.ssrLoadModule('/src/components/Icon.tsx') as typeof import('./Icon');
  const confirm = await server.ssrLoadModule('/src/confirm.ts') as typeof import('../confirm');
  const Harness = ({ icon }: { icon: import('./Icon').IconName }) => el('div', {}, el(ConfirmHost), el('div', { 'data-expected': true }, el(Icon, { name: icon })));
  for (const [tone, icon, expected] of [['danger', undefined, 'trash'], ['info', undefined, 'signal'], ['danger', 'alert-circle', 'alert-circle'], ['info', 'alert-circle', 'alert-circle']] as const) {
    let pending!: Promise<boolean>;
    await flush(() => { pending = confirm.confirmAction({ title: 'Проверка', tone, icon }); });
    if (root) await flush(() => root!.render(el(Harness, { icon: expected }))); else await mount(Harness, { icon: expected });
    assert.equal(host.querySelector('.confirm-ic svg')?.innerHTML, host.querySelector('[data-expected] svg')?.innerHTML);
    await flush(() => confirm.useConfirmDialog.getState().answer(false)); await pending;
  }
});

it('кнопка тоста передаётся через toast, закрывает уведомление перед единственным действием', async () => {
  // Ловит потерянную «Отмену» и действие с оставшимся на экране тостом.
  const mod = await server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
  const { ToastHost } = await server.ssrLoadModule('/src/components/ToastHost.tsx') as typeof import('./ToastHost');
  let called = 0; const action = { label: 'Отмена', onClick: () => { called++; assert.equal(mod.useToasts.getState().toasts.length, 0); } };
  mod.toast('info', 'В архиве', undefined, { action, durationMs: 1234 });
  assert.equal(mod.useToasts.getState().toasts[0].action, action);
  assert.equal(mod.useToasts.getState().toasts[0].durationMs, 1234);
  await mount(ToastHost, {}); const button = host.querySelector<HTMLButtonElement>('.toast-act'); assert.ok(button);
  await flush(() => button.click()); assert.equal(called, 1); assert.equal(host.querySelector('.toast'), null);
});

it('поиск F3 идёт старее, Shift+F3 новее, Esc в поле и смена беседы закрывают поиск', async () => {
  // Ловит инверсию клавиш и поиск, оставшийся привязанным к предыдущей беседе.
  const mod = await server.ssrLoadModule('/src/components/ChatSearch.tsx') as typeof import('./ChatSearch');
  let ctl!: import('./ChatSearch').ChatSearchCtl; const jumps: string[] = [];
  function Harness({ feed }: { feed: string }) {
    const [open, setOpen] = useState(false);
    ctl = mod.useChatSearch({ open, setOpen, search: async () => ({ hits: [
      { id: 'new', sortKey: 2, createdAt: '2026-10-07T10:00:00Z', authorId: 'peer' },
      { id: 'old', sortKey: 1, createdAt: '2026-10-06T10:00:00Z', authorId: 'peer' },
    ], total: 2, next: null }), jumpToDate: async () => null }, async id => { jumps.push(id); }, feed);
    return open ? el(mod.ChatSearchHead, { cs: ctl }) : el('div');
  }
  await mount(Harness, { feed: 'a' });
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', ctrlKey: true, cancelable: true })));
  assert.equal(ctl.open, true); await flush(() => ctl.setQuery('test')); await flush(() => ctl.submit(false));
  assert.deepEqual(jumps, ['new']);
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', cancelable: true })));
  assert.equal(jumps.at(-1), 'old');
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', shiftKey: true, cancelable: true })));
  assert.equal(jumps.at(-1), 'new');
  const input = host.querySelector('input'); assert.ok(input); input.focus();
  await flush(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(ctl.open, false);
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', ctrlKey: true, cancelable: true })));
  assert.equal(ctl.open, true); await flush(() => root!.render(el(Harness, { feed: 'b' }))); assert.equal(ctl.open, false);
});

it('страж записи отменяет три перехода, снятие старого стража не снимает новый, без стража поле меняется синхронно', async () => {
  // Ловит потерю незавершённого голосового при навигации и гонку cleanup двух владельцев стража.
  await seed({ currentDmId: 'old', currentChannelId: 'old-channel', currentServerId: 'old-server' });
  const calls: (string | undefined)[] = [];
  const offOld = initial.setLeaveGuard(() => true);
  const off = initial.setLeaveGuard(async target => { calls.push(target); return false; });
  offOld(); assert.ok(store.getState().leaveGuard);
  await initial.selectDm('next'); await initial.openChannel('next-channel'); await initial.openServer('next-server');
  assert.deepEqual(calls, ['next', 'next-channel', 'next-server']);
  assert.equal(store.getState().currentDmId, 'old');
  assert.equal(store.getState().currentChannelId, 'old-channel');
  assert.equal(store.getState().currentServerId, 'old-server');
  off(); assert.equal(store.getState().leaveGuard, null);
  store.setState({ refreshDmHistory: async () => {} });
  const pending = initial.selectDm('next');
  assert.equal(store.getState().currentDmId, 'next', 'без стража нет await до смены беседы');
  await pending;
  const channel = initial.openChannel('next-channel');
  assert.equal(store.getState().currentChannelId, 'next-channel'); await channel;
});

it('ReactionBar предлагает быструю только при обработчике и не для уже выбранной реакции', async () => {
  // Меню не должно обещать неработающую настройку или показывать «выбрать» у уже выбранной реакции.
  const picked: string[] = [];
  const click = async (emoji: string) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>('.react-bar button')].find((b) => b.textContent === emoji)!;
    assert.ok(button); await flush(() => button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  };
  await mount(Bar, { reactions: ['👍', '🔥'], quick: '👍', onPick() {}, onMore() {}, onSetQuick: (e: string) => { picked.push(e); } });
  await click('👍'); assert.equal(host.querySelector('.react-bar-setq'), null);
  await click('🔥'); const set = host.querySelector<HTMLButtonElement>('.react-bar-setq'); assert.ok(set);
  await flush(() => set.click()); assert.deepEqual(picked, ['🔥']);
  await flush(() => root!.render(el(Bar, { reactions: ['👍', '🔥'], quick: '👍', onPick() {}, onMore() {} })));
  await click('🔥'); assert.equal(host.querySelector('.react-bar-setq'), null);
});
it('живое событие реакции ведёт список поставивших, удаляет по id и не выдумывает список старому серверу', async () => {
  // Проверяется настоящий store.applyReaction: правила чипа не доказывают корректность WS-мутации.
  await seed();
  await state({ messagesByChannel: { ch: [{ id: 'r', reactions: [] }] as never } });
  const apply = store.getState().applyReaction;
  apply('ch', 'r', '🔥', 'me', 'add');
  apply('ch', 'r', '🔥', 'peer', 'add');
  let group = store.getState().messagesByChannel.ch[0].reactions![0];
  assert.equal(group.count, 2); assert.equal(group.me, true);
  assert.deepEqual(group.reactors?.map((r) => r.userId), ['me', 'peer']);
  apply('ch', 'r', '🔥', 'peer', 'add');
  assert.deepEqual(store.getState().messagesByChannel.ch[0].reactions![0].reactors?.map((r) => r.userId), ['me', 'peer']);
  assert.equal(store.getState().messagesByChannel.ch[0].reactions![0].count, 2, 'исправление эха WS: повторный пользователь не увеличивает число');
  await state({ messagesByChannel: { ch: [{ id: 'r', reactions: [{ emoji: '🔥', count: 2, me: true, reactors: [{ userId: 'me', at: '' }, { userId: 'peer', at: '' }] }] }] as never } });
  apply('ch', 'r', '🔥', 'me', 'remove');
  group = store.getState().messagesByChannel.ch[0].reactions![0];
  assert.equal(group.count, 1); assert.equal(group.me, false); assert.deepEqual(group.reactors?.map((r) => r.userId), ['peer']);
  await state({ messagesByChannel: { ch: [{ id: 'r', reactions: [{ emoji: '🔥', count: 4, me: false }] }] as never } });
  apply('ch', 'r', '🔥', 'peer', 'add');
  assert.equal(Object.hasOwn(store.getState().messagesByChannel.ch[0].reactions![0], 'reactors'), false);
});
it('буква и Shift-буква фокусируют поиск, Ctrl и соседняя область не перехватываются', async () => {
  // Список должен поддерживать клавиатуру, не превращая сочетания браузера и ввод вне строки в поиск.
  await seed(); await mount();
  const row = host.querySelector<HTMLElement>('.dm-row')!;
  const find = host.querySelector<HTMLInputElement>('.dm-find input')!;
  row.focus();
  const letter = new KeyboardEvent('keydown', { key: 'К', shiftKey: true, bubbles: true, cancelable: true });
  await flush(() => row.dispatchEvent(letter));
  assert.equal(document.activeElement, find); assert.equal(letter.defaultPrevented, false);
  // HappyDOM не выполняет нативный ввод браузера после keydown; проверяем передачу фокуса, затем обычный input.
  await input('К'); assert.equal(find.value, 'К');
  await input(''); row.focus();
  await flush(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, bubbles: true, cancelable: true })));
  assert.equal(find.value, ''); assert.equal(document.activeElement, row);
  const list = host.querySelector<HTMLElement>('.dm-list')!;
  await flush(() => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })));
  assert.equal(find.value, '');
  const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  await flush(() => row.dispatchEvent(space));
  assert.equal(space.defaultPrevented, true); assert.equal(document.activeElement, find); assert.equal(find.value, '');
});

async function searchTimers(run: (fire: () => Promise<void>, pending: () => number) => Promise<void>) {
  const originalSet = window.setTimeout, originalClear = window.clearTimeout;
  const tasks = new Map<number, () => void>(); let seq = 900000;
  window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (ms !== 300 || typeof fn !== 'function') return Reflect.apply(originalSet, window, [fn, ms, ...args]) as number;
    const id = ++seq; tasks.set(id, () => Reflect.apply(fn, undefined, args)); return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { if (!tasks.delete(id)) originalClear.call(window, id); }) as typeof window.clearTimeout;
  try {
    await run(async () => { await flush(() => { const ready = [...tasks.values()]; tasks.clear(); ready.forEach(fn => fn()); }); }, () => tasks.size);
  } finally { window.setTimeout = originalSet; window.clearTimeout = originalClear; }
}

it('поиск людей ждёт 300 мс, заменяет таймер ввода и не дублирует знакомых в серверном блоке', async () => {
  // Один набранный логин — один запрос; знакомый из ростера не должен появляться второй строкой.
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const saved = api.searchUsers; const calls: string[] = [];
  const known = { id: 'known', username: 'abcd', displayName: 'Known', avatarUrl: null };
  const remote = { id: 'remote', username: 'abcde', displayName: 'Remote', avatarUrl: null };
  api.searchUsers = async q => { calls.push(q); return { users: [known, remote] }; };
  try { await searchTimers(async (fire, pending) => {
    await seed({ serverFeatures: ['users1'], dms: [], members: [{ user: known } as never] }); await mount();
    await flush(() => compose.openDmCompose());
    await input('@abc'); assert.equal(calls.length, 0); assert.equal(pending(), 1);
    await input('@abcd'); assert.equal(calls.length, 0); assert.equal(pending(), 1, 'прежний таймер отменён');
    await fire(); assert.deepEqual(calls, ['abcd']);
    const sheet = document.querySelector('.dm-compose')!;
    assert.equal(sheet.querySelectorAll('.sheet-row').length, 2);
    assert.equal([...sheet.querySelectorAll('.sheet-row')].filter(r => r.textContent?.includes('Known')).length, 1);
    assert.equal(sheet.querySelector('.mp-head')?.textContent, 'На этом инстансе');
    assert.ok(![...sheet.querySelectorAll('.sheet-row')].find(r => r.textContent?.includes('Remote'))?.querySelector('.mp-dot'), 'сервер не обещает онлайн незнакомого');
  }); } finally { api.searchUsers = saved; }
});

it('опоздавшие успех и отказ прежнего поиска не подменяют новый ответ', async () => {
  // Старый результат тоже подходит под новый префикс — одной фильтрации по логину недостаточно.
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const saved = api.searchUsers;
  const requests: { resolve: (r: { users: { id: string; username: string; displayName: string; avatarUrl: null }[] }) => void; reject: (e: Error) => void }[] = [];
  api.searchUsers = () => new Promise((resolve, reject) => { requests.push({ resolve, reject }); });
  try { await searchTimers(async fire => {
    await seed({ serverFeatures: ['users1'], dms: [] }); await mount(); await flush(() => compose.openDmCompose());
    await input('@abc'); await fire();
    await input('@abcd'); await fire();
    const hit = (id: string) => ({ id, username: 'abcde', displayName: id, avatarUrl: null });
    await flush(() => requests[1].resolve({ users: [hit('fresh')] }));
    await flush(() => requests[0].resolve({ users: [hit('stale')] }));
    assert.match(document.querySelector('.dm-compose')?.textContent ?? '', /fresh/);
    assert.doesNotMatch(document.querySelector('.dm-compose')?.textContent ?? '', /stale/);
    await input('@abc'); await fire(); await input('@abcd'); await fire();
    await flush(() => requests[3].resolve({ users: [hit('newest')] }));
    await flush(() => requests[2].reject(new Error('old failure')));
    assert.match(document.querySelector('.dm-compose')?.textContent ?? '', /newest/);
    assert.doesNotMatch(document.querySelector('.dm-compose')?.textContent ?? '', /old failure/);
  }); } finally { api.searchUsers = saved; }
});

it('пустой поиск учит ввести @имя, отказ объясняет причину, гость и старый сервер не ищут', async () => {
  // Гость не должен получать заведомый 403, а ошибка сети не должна выглядеть пустой выдачей.
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const saved = api.searchUsers; let calls = 0;
  api.searchUsers = async () => { calls++; throw new Error('Слишком много попыток'); };
  try { await searchTimers(async fire => {
    await seed({ serverFeatures: ['users1'], dms: [] }); await mount(); await flush(() => compose.openDmCompose());
    assert.equal(document.querySelector('.sheet-empty')?.textContent, 'Введите @имя');
    await input('ab'); await fire(); assert.equal(calls, 0);
    await input('@abc'); await fire();
    assert.equal(document.querySelector('.sheet-empty')?.textContent, 'Слишком много попыток');
    await flush(() => compose.closeDmCompose());
    await state({ user: { ...store.getState().user!, homeInstance: { instanceId: 'foreign', name: 'Home', domain: 'example.test' } } });
    await flush(() => compose.openDmCompose('@abc')); await fire(); assert.equal(calls, 1, 'гость не вызывает поиск');
    await flush(() => compose.closeDmCompose());
    await state({ serverFeatures: [], user: { ...store.getState().user!, homeInstance: null } });
    await flush(() => compose.openDmCompose('@abc')); await fire(); assert.equal(calls, 1, 'старый сервер не вызывается');
  }); } finally { api.searchUsers = saved; }
});

async function searchScenario(kind: 'stale' | 'debounce' | 'duplicate' | 'guest') {
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const saved = api.searchUsers;
  try {
    if (kind === 'stale') {
      const requests: ((r: { users: { id: string; username: string; displayName: string; avatarUrl: null }[] }) => void)[] = [];
      api.searchUsers = () => new Promise(resolve => requests.push(resolve));
      await searchTimers(async fire => {
        await seed({ serverFeatures: ['users1'], dms: [] }); await mount(); await flush(() => compose.openDmCompose());
        await input('@abc'); await fire(); await input('@abcd'); await fire();
        const hit = (id: string) => ({ id, username: 'abcde', displayName: id, avatarUrl: null });
        await flush(() => requests[1]({ users: [hit('current')] }));
        await flush(() => requests[0]({ users: [hit('stale')] }));
        assert.match(document.querySelector('.dm-compose')?.textContent ?? '', /current/);
        assert.doesNotMatch(document.querySelector('.dm-compose')?.textContent ?? '', /stale/);
      });
    } else if (kind === 'debounce') {
      let calls = 0; api.searchUsers = async () => { calls++; return { users: [{ id: 'guest-hit', username: 'abcde', displayName: 'Visible hit', avatarUrl: null }] }; };
      await searchTimers(async (fire, pending) => {
        const forwarded = await new Promise<unknown>(resolve => window.setTimeout((value: unknown) => resolve(value), 0, 'timer-argument'));
        assert.equal(forwarded, 'timer-argument', 'прочие таймеры сохраняют переданные аргументы');
        await seed({ serverFeatures: ['users1'], dms: [] }); await mount(); await flush(() => compose.openDmCompose());
        await input('@abc'); assert.equal(calls, 0, 'ввод ещё не должен отправлять запрос');
        assert.equal(pending(), 1, 'ожидается таймер debounce'); await fire();
        assert.equal(calls, 1, 'после задержки ровно один запрос');
      });
    } else if (kind === 'duplicate') {
      const known = { id: 'known-user', username: 'abcde', displayName: 'Known person', avatarUrl: null };
      api.searchUsers = async () => ({ users: [known] });
      await searchTimers(async fire => {
        await seed({ serverFeatures: ['users1'], members: [{ user: known } as never], dms: [] }); await mount();
        await flush(() => compose.openDmCompose()); await input('@abc'); await fire();
        assert.equal([...document.querySelectorAll('.sheet-row')].filter(r => r.textContent?.includes('Known person')).length, 1);
      });
    } else {
      let calls = 0; api.searchUsers = async () => { calls++; return { users: [{ id: 'guest-hit', username: 'abcde', displayName: 'Visible hit', avatarUrl: null }] }; };
      await searchTimers(async fire => {
        await seed({ serverFeatures: ['users1'], dms: [], user: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null,
          homeInstance: { instanceId: 'home', name: 'Home', domain: 'home.test' } } as never });
        await mount(); await flush(() => compose.openDmCompose('@abc')); await fire();
        assert.equal(calls, 0, 'гость не вызывает сетевой поиск');
      });
    }
  } finally { api.searchUsers = saved; }
}
before(async () => {
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => { const t = nativeTimeout(fn,ms,...args); timers.add(t); return t; }) as typeof setTimeout;
  globalThis.setInterval = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => { const t = nativeInterval(fn,ms,...args); timers.add(t); return t; }) as typeof setInterval;
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.defineProperties(document.documentElement, { clientWidth: { value: 1000, configurable: true }, clientHeight: { value: 800, configurable: true } });
  // React определяет поддержку input при импорте, поэтому загружаем DOM-клиент ПОСЛЕ регистрации DOM.
  createRoot = (await import('react-dom/client')).createRoot;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, fetch: async () => new Response(null, { status: 503 }) });
  class ClosedSocket { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} }
  Object.assign(globalThis, { WebSocket: ClosedSocket });
  const match = window.matchMedia.bind(window);
  window.matchMedia = query => { const m = match(query); if (query === '(max-width: 760px)') Object.defineProperty(m, 'matches', { get: () => phone });
    if (query === '(max-width: 620px)') Object.defineProperty(m, 'matches', { get: () => narrow }); return m; };
  server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false,
    cacheDir: mkdtempSync(join(tmpdir(), 'gusvoice-dm-sidebar-test-')), optimizeDeps: { noDiscovery: true, include: [] },
    esbuild: { jsx: 'automatic' }, resolve: { alias: { '@gusvoice/shared': fileURLToPath(new URL('../../../../packages/shared/src/index.ts', import.meta.url)) } },
    plugins: [{ name:'test-dm-row-mutant', enforce:'pre', transform(source,id) {
      const path=id.replaceAll('\\','/');
      if (!mutant) return;
      if (mutant === 'закрытый-сервер' && path.endsWith('/src/App.tsx')) {
        const changed=source.replace('.catch(explainClosedServer(pending.serverId))', '.catch(() => {})');
        assert.notEqual(changed,source,'найден настоящий catch отказа закрытого сервера'); return changed;
      }
      if (mutant === 'закрытый-сервер') return;
      if (mutant === 'дубль-поиска' && path.endsWith('/src/dmRules.ts')) {
        const changed=source.replace('!taken.has(h.id) &&', 'true &&');
        assert.notEqual(changed,source,'найден якорь мутанта дублей поиска'); return changed;
      }
      if (mutant === 'дубль-поиска') return;
      if (!path.endsWith('/components/DmSidebar.tsx')) return;
      const changed=mutations[mutant](source); assert.notEqual(changed,source,'найден якорь мутанта'); return changed;
    } }],
    server: { middlewareMode: true, hmr: false, watch: null, ws: false }, appType: 'custom', logLevel: 'error' });
  Sidebar = (await server.ssrLoadModule('/src/components/DmSidebar.tsx')).DmSidebar;
  Chat = (await server.ssrLoadModule('/src/components/DmChatView.tsx')).DmChatView;
  Layout = (await server.ssrLoadModule('/src/components/MainLayout.tsx')).MainLayout;
  App = (await server.ssrLoadModule('/src/App.tsx')).App;
  const menu = await server.ssrLoadModule('/src/components/ContextMenu.tsx');
  Menu = menu.ContextMenu; Bar = menu.ReactionBar; quick = menu.QUICK_REACTIONS;
  Picker = (await server.ssrLoadModule('/src/components/ForwardPicker.tsx')).ForwardPicker;
  Row = (await server.ssrLoadModule('/src/components/DmSidebar.tsx')).DmRow;
  store = (await server.ssrLoadModule('/src/store.ts')).useStore;
  typing = await server.ssrLoadModule('/src/typing.ts') as typeof typing;
  compose = await server.ssrLoadModule('/src/dmCompose.ts') as typeof compose;
  toasts = (await server.ssrLoadModule('/src/toast.ts')).useToasts;
  blockText = (await server.ssrLoadModule('/src/dmRules.ts')).dmBlockText;
  initial = store.getState();
});
async function seed(patch: Patch = {}) {
  store.setState({ ...initial, user: { id: 'me', username: 'goose', displayName: 'Гусь', avatarUrl: null } as never,
    view: 'dm', mobilePane: 'list', currentDmId: null, dms: [dm()], dmMessages: { c: [] }, onlineUsers: ['peer'],
    convActive: true, conv: { ...initial.conv, pts: 100, phase: 'live', summaries: { c: summary() } },
    drafts: {}, outbox: {}, unreadDms: [], members: [], loadDms: async () => {}, ...patch });
}
afterEach(async () => {
  if (root) act(() => root!.unmount()); root = undefined; host?.remove();
  compose.closeDmCompose(); typing.clearTyping(); store.getState().convReset(); store.setState(initial, true); phone = false; narrow = false;
  Object.defineProperty(document.documentElement, 'clientHeight', { value: 800, configurable: true });
  toasts.setState({toasts:[]});
  document.querySelectorAll('[data-fixture]').forEach(x => x.remove());
});
after(async () => {
  try { await (window as unknown as { happyDOM: { abort(): Promise<void> } }).happyDOM.abort(); }
  finally { try { await server?.close(); } finally { await GlobalRegistrator.unregister();
    for (const t of timers) nativeClear(t); globalThis.setTimeout = nativeTimeout; globalThis.setInterval = nativeInterval;
    for (const h of handles()) if (!originalHandles.has(h) && h instanceof MessagePort) h.unref(); } }
});

it('строка — кнопка, галочки перед временем, непрочитанное имеет число или точку', async () => {
  // Ловит потерю доступности строки и прежний вид отметок после времени.
  await seed({ unreadDms: ['c'], dms: [dm('c', 101)] }); await mount();
  const row = host.querySelector('button.dm-row.unread')!; assert.ok(row, 'строка кнопка');
  assert.equal(row.querySelector('.dm-badge')?.textContent, '99+');
  assert.equal(row.querySelector('.dm-when')?.firstElementChild?.className, 'dm-st read');
  assert.equal(row.querySelector('.dm-when')?.lastElementChild?.tagName, 'TIME');
  assert.match(row.getAttribute('aria-label')!, /Вы: текст.*прочитано/);
  await state({ dms: [dm('c', 0)] }); assert.ok(host.querySelector('.dm-badge.dot'), 'флаг без числа — точка');
});
it('открытая строка подсвечена на ПК, на телефоне aria-current нет', async () => {
  // Ловит смешение текущей беседы с выбранным экраном телефона.
  await seed({ currentDmId: 'c' }); await mount(); assert.equal(host.querySelector('.dm-row.active')?.getAttribute('aria-current'), 'true');
  act(() => root!.unmount()); root = undefined; host.remove(); phone = true; await mount();
  assert.equal(host.querySelector('.dm-row.active'), null); assert.equal(host.querySelector('.dm-row')?.hasAttribute('aria-current'), false);
});
it('неотправленное заменяет галочки, но сохраняет счётчик и превью', async () => {
  // Ловит прежнее исчезновение unread под красным !.
  await seed({ unreadDms: ['c'], dms: [dm('c', 2)], outbox: { c: [outgoing()] } }); await mount();
  assert.ok(host.querySelector('.dm-row.failed .dm-when .dm-st.failed'), 'ошибка рядом со временем');
  assert.equal(host.querySelector('.dm-st.read,.dm-st.sent,.dm-fail'), null);
  assert.equal(host.querySelector('.dm-badge')?.textContent, '2'); assert.equal(host.querySelector('.dm-preview')?.textContent, 'текст');
  await state({ outbox: { c: [outgoing('sending')] } });
  assert.equal(host.querySelector('.dm-st.failed'), null);
  await state({ conv: { ...store.getState().conv, summaries: { c: summary({ lastMessage: { ...summary().lastMessage!, authorId: 'peer' } }) } }, outbox: { c: [outgoing()] } });
  assert.ok(host.querySelector('.dm-st.failed'), 'ошибка есть и у чужого последнего');
});
it('черновик прячет галочки, старый путь не читает сводку, очередь и черновик', async () => {
  // Ловит утечку данных нового протокола в старый список.
  await seed({ drafts: { c: { text: 'черновик', replyToId: null } } }); await mount();
  assert.match(host.querySelector('.dm-preview')!.textContent!, /Черновик:.*черновик/); assert.equal(host.querySelector('.dm-st'), null);
  await state({ convActive: false }); assert.equal(host.querySelector('.dm-preview')?.textContent, '\u00a0');
  assert.equal(host.querySelector('.dm-draft,.dm-st'), null); assert.ok(host.querySelector('time.dm-time'), 'время старого списка осталось');
});
it('печатает только собеседник, срок пять секунд гасит признак и оставляет время', async () => {
  // Ловит третьего человека и вечный индикатор набора.
  await seed(); await mount(); await flush(() => typing.noteTyping('c','third')); assert.equal(host.querySelector('.dm-typing'), null);
  await flush(() => typing.noteTyping('c','peer')); assert.ok(host.querySelector('.dm-typing .typing-dots'), 'печатает собеседник');
  assert.ok(host.querySelector('.dm-st.read'), 'галочки не исчезли'); assert.ok(host.querySelector('time'), 'время не исчезло');
  await act(async () => { await wait(6050); }); assert.equal(host.querySelector('.dm-typing'), null);
});
it('поиск выделяет оба начала слова, Escape чистит, Ctrl K работает в русской раскладке', async () => {
  // Ловит поиск произвольной подстроки и зависимость горячей клавиши от раскладки.
  await seed({ dms: [dm(), { ...dm('d'), otherUser: { ...peer, id:'p2',displayName:'Кот Учёный' } }, { ...dm('e'), otherUser:{ ...peer,id:'p3',displayName:'Пакостник' } }] }); await mount();
  await input('ко'); assert.equal(host.querySelectorAll('.dm-row').length, 2); assert.equal(host.querySelectorAll('mark.dm-hit').length, 2);
  await flush(() => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape',bubbles:true })));
  assert.equal(host.querySelectorAll('.dm-row').length, 3);
  const field=host.querySelector<HTMLInputElement>('input')!; field.blur();
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown',{ ctrlKey:true,code:'KeyK',key:'л',bubbles:true })));
  assert.ok(document.activeElement === field, 'Ctrl K фокусирует поиск');
  const blocker=document.createElement('div'); blocker.setAttribute('aria-modal','true'); blocker.dataset.fixture='1'; document.body.append(blocker); field.blur();
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown',{ ctrlKey:true,code:'KeyK',key:'k' })));
  assert.ok(document.activeElement !== field, 'диалог не отдаёт Ctrl K списку');
});

it('Назад очищает мобильный поиск, фокус и фильтр, а без поиска не перехватывает список', async () => {
  // На телефоне шаг назад закрывает внутренний поиск, но пустой список должен остаться хозяином жеста.
  phone = true;
  await seed({ serverFeatures: ['gsearch1'], dms: [dm()], mobilePane: 'list' });
  await mount();
  const { stepBack } = await server.ssrLoadModule('/src/androidBack.ts') as typeof import('../androidBack');
  const back = async () => { let handled = false; await flush(() => { handled = stepBack(); }); return handled; };
  assert.equal(await back(), false, 'без фокуса, запроса и чипов обработчика поиска нет');
  const field = host.querySelector<HTMLInputElement>('input[placeholder="Найти беседу"]'); assert.ok(field);

  field!.focus(); await flush();
  assert.equal(await back(), true, 'одного фокуса достаточно для шага назад');
  await flush(); assert.notEqual(document.activeElement, field, 'возврат снимает фокус, чтобы клавиатура закрылась');

  field!.focus(); await input('колокол');
  assert.equal(field!.value, 'колокол');
  assert.equal(await back(), true, 'непустой запрос тоже активирует обработчик');
  await flush(); assert.equal(field!.value, '', 'шаг назад очищает запрос');
  assert.notEqual(document.activeElement, field, 'после очистки поле больше не в фокусе');

  field!.focus(); await flush();
  const kind = host.querySelector<HTMLButtonElement>('.dms-chip[data-kind]'); assert.ok(kind, 'фокус пустого поля показывает быстрые фильтры');
  await flush(() => kind!.click());
  assert.ok(host.querySelector('.dms-chip.on'), 'быстрый фильтр выбран как чип');
  assert.equal(await back(), true, 'одного чипа достаточно, даже при пустом запросе');
  await flush(); assert.equal(host.querySelector('.dms-chip.on'), null, 'шаг назад удаляет выбранный фильтр');
  assert.notEqual(document.activeElement, field, 'шаг назад также закрывает клавиатуру для фильтра');
  assert.equal(await back(), false, 'после очистки нет скрытого обработчика поиска');
});
async function searchBackOverlayScenario() {
  phone = true;
  const { stepBack } = await server.ssrLoadModule('/src/androidBack.ts') as typeof import('../androidBack');
  const cases = [
    { label: 'открытая беседа', patch: { mobilePane: 'content' as const }, after: () => assert.equal(store.getState().mobilePane, 'list') },
    { label: 'настройки', patch: { settingsOpen: true }, after: () => assert.equal(store.getState().settingsOpen, false) },
    { label: 'профиль', patch: { mobileProfileOpen: true }, after: () => assert.equal(store.getState().mobileProfileOpen, false) },
  ];
  for (const [index, item] of cases.entries()) {
    await seed({ serverFeatures: ['gsearch1'], dms: [dm()], currentDmId: 'c', ...item.patch });
    await mount();
    const field = host.querySelector<HTMLInputElement>('input[placeholder="Найти беседу"]'); assert.ok(field);
    await input(`эхо-${index}`);
    let handled = false; await flush(() => { handled = stepBack(); });
    assert.equal(handled, true, `${item.label}: первый шаг назад закрывает верхний экран`);
    await flush();
    assert.equal(field!.value, `эхо-${index}`, `${item.label}: поиск под верхним экраном сохранён`);
    item.after();
    handled = false; await flush(() => { handled = stepBack(); });
    assert.equal(handled, true, `${item.label}: следующий шаг назад закрывает поиск`);
    await flush(); assert.equal(field!.value, '', `${item.label}: запрос очищается только после закрытия верхнего экрана`);
    if (root) act(() => root!.unmount()); root = undefined; host.remove();
  }
}
it('Назад сначала закрывает беседу, настройки и профиль, сохраняя текст поиска под ними', async () => {
  // Иначе первый шаг очищает скрытый поиск, а пользователь теряет запрос при обычном возврате к списку.
  await searchBackOverlayScenario();
});
it('пустой поиск открывает Написать с запросом, ПК — доступное окно и фокус поля', async () => {
  // Ловит прежний полноширинный лист на ПК и потерю запроса при переходе.
  await seed(); await mount(); await input('тан'); assert.match(host.querySelector('.dm-nores')!.textContent!, /«тан»/);
  await flush(() => host.querySelector<HTMLButtonElement>('.dm-nores button')!.click());
  const dialog=document.querySelector('.modal-overlay > .modal.dm-compose[role="dialog"][aria-modal="true"]')!;
  assert.ok(dialog,'ПК окно'); assert.equal(document.querySelector('.sheet'),null);
  assert.equal(dialog.getAttribute('aria-labelledby'),dialog.querySelector('h2')?.id);
  assert.equal(dialog.querySelector<HTMLInputElement>('input')?.value,'тан'); assert.ok(document.activeElement === dialog.querySelector('input'), 'фокус в поле окна');
  await flush(() => (dialog as HTMLElement).click()); assert.ok(document.querySelector('.dm-compose'),'клик внутри не закрывает');
  await flush(() => window.dispatchEvent(new KeyboardEvent('keydown',{ key:'Escape',bubbles:true }))); assert.equal(document.querySelector('.dm-compose'),null);
});
it('кандидат из беседы доступен без ростера, выбор закрывает окно и вызывает openDmWith', async () => {
  // Ловит Некому написать в сессии без открытого сервера.
  const opened:string[]=[]; await seed({ openDmWith:async id=>{ opened.push(id); } }); await mount();
  await flush(() => compose.openDmCompose()); const button=document.querySelector<HTMLButtonElement>('.dm-compose .sheet-row')!;
  assert.match(button.textContent!,/@cat/); await flush(()=>button.click()); assert.deepEqual(opened,['peer']); assert.equal(document.querySelector('.dm-compose'),null);
  await state({ dms: [] }); await flush(()=>compose.openDmCompose()); assert.match(document.querySelector('.sheet-empty')!.textContent!,/Некому написать/);
  await flush(()=>document.querySelector<HTMLElement>('.modal-overlay')!.click()); assert.equal(document.querySelector('.dm-compose'),null);
});
it('гостю и гостя нельзя открыть: окно закрывается без API-вызова', async () => {
  // Ловит обещание заведомо запрещённой ЛС из нового окна.
  let calls=0; await seed({ user: { id:'me',username:'goose',displayName:'Гусь',avatarUrl:null,homeInstance:{ instanceId:'home',name:'Дом',domain:'home.test' } } as never,openDmWith:async()=>{ calls++; } }); await mount();
  await flush(()=>compose.openDmCompose()); await flush(()=>document.querySelector<HTMLButtonElement>('.sheet-row')!.click()); assert.equal(calls,0);
  assert.equal(toasts.getState().toasts.at(-1)?.title,blockText(store.getState().user?.homeInstance,undefined));
  await state({ user:{ id:'me',username:'goose',displayName:'Гусь',avatarUrl:null } as never,members:[{ user:{ ...peer,homeInstance:{ instanceId:'home',name:'Дом',domain:'home.test' } } } as never] });
  await flush(()=>compose.openDmCompose()); await flush(()=>document.querySelector<HTMLButtonElement>('.sheet-row')!.click()); assert.equal(calls,0);
  assert.equal(toasts.getState().toasts.at(-1)?.title,blockText(undefined,store.getState().members[0].user.homeInstance));
});
it('телефон рисует лист, поиск скрывает карандаш, Ctrl K не перехватывается', async () => {
  // Ловит смешение ширины браузера с нативным isMobile и кнопкой под клавиатурой.
  phone=true; await seed(); await mount(); const field=host.querySelector<HTMLInputElement>('input.sheet-search')!;
  assert.ok(host.querySelector('.dm-fab'),'карандаш до поиска');
  await flush(()=>field.focus()); assert.equal(host.querySelector('.dm-fab'),null);
  await input('ко'); await flush(()=>field.blur()); assert.equal(host.querySelector('.dm-fab'),null);
  await flush(()=>window.dispatchEvent(new KeyboardEvent('keydown',{ ctrlKey:true,code:'KeyK',key:'k' }))); assert.ok(document.activeElement !== field,'Ctrl K не слушается на телефоне');
  await flush(()=>compose.openDmCompose()); assert.ok(document.querySelector('.sheet-scrim > .sheet'),'телефонный лист'); assert.equal(document.querySelector('.modal.dm-compose'),null);
});
it('гусь пустого списка появляется только после списка и только на телефоне', async () => {
  // Ловит вспышку пустого состояния до ответа сервера.
  phone=true; await seed({ dms:[],conv:{ ...initial.conv,pts:null } }); await mount(); assert.equal(host.querySelector('.empty-goose'),null);
  await state({ conv:{ ...store.getState().conv,pts:0 } }); assert.ok(host.querySelector('.empty-goose'),'пусто после списка'); assert.equal(host.querySelector('input'),null);
  act(()=>root!.unmount()); root=undefined; host.remove(); phone=false; await mount(); assert.equal(host.querySelector('.empty-goose'),null);
});
it('главная область ПК показывает гуся и Написать, гостю — подсказку без кнопки', async () => {
  // Ловит второй пустой список и приглашение гостя в запрещённые ЛС.
  await seed({ dms:[],conv:{ ...initial.conv,pts:0 } }); await mount(Layout,{});
  assert.ok(host.querySelector('.content .empty-goose .dm-start'),'ПК пустое состояние');
  await state({ user:{ id:'me',username:'goose',displayName:'Гусь',avatarUrl:null,homeInstance:{ instanceId:'home',name:'Дом',domain:'home.test' } } as never });
  assert.equal(host.querySelector('.content .dm-start'),null); assert.match(host.querySelector('.content .eg-sub')!.textContent!,/Гостю/);
  await state({ conv:{ ...store.getState().conv,pts:null } }); assert.equal(host.querySelector('.content .empty-goose'),null);
});
it('кнопка телефона «К беседе» закрывает вид отложенных, но не переводит на список', async () => {
  // Вид передаёт переход назад через schedView; первая кнопка не должна провалиться в обычный возврат к списку.
  phone = true;
  await seed({ view: 'dm', currentDmId: 'c', mobilePane: 'content' });
  const { holdSchedView } = await server.ssrLoadModule('/src/schedView.ts') as typeof import('../schedView');
  let returned = 0;
  let release!: () => void;
  release = holdSchedView(() => { returned++; release(); });
  try {
    await mount(Layout, {});
    const back = host.querySelector<HTMLButtonElement>('.mobile-back');
    assert.ok(back, 'телефонная кнопка возврата присутствует');
    assert.equal(back.title, 'К беседе');
    assert.equal(back.getAttribute('aria-label'), 'К беседе');
    await flush(() => back.click());
    assert.equal(returned, 1, 'кнопка вызвала обработчик вида отложенных ровно один раз');
    assert.equal(store.getState().mobilePane, 'content', 'закрытие отложенных оставляет открытую беседу');
    assert.equal(back.title, 'Назад', 'после отпускания вида восстанавливается обычная навигация');
    await flush(() => back.click());
    assert.equal(store.getState().mobilePane, 'list', 'следующий обычный возврат ведёт к списку');
  } finally { release(); }
});
it('шапка переключает online/solo/typing и не дублирует печатает над полем', async () => {
  // Ловит недоступную подпись шапки и двойной индикатор набора.
  await seed(); await mount(Chat,{ dm:dm() });
  assert.equal(host.querySelector('.dm-who-status')?.textContent,'в сети'); assert.equal(host.querySelector('.dm-title'),null);
  assert.equal(host.querySelector('.dm-who-status')?.hasAttribute('aria-hidden'),false); assert.equal(host.querySelector('.dm-who-typing')?.getAttribute('aria-hidden'),'true');
  await state({ onlineUsers:[] }); assert.ok(host.querySelector('.dm-who.solo'),'офлайн без подписи'); assert.equal(host.querySelector('.topbar .mp-dot-wrap'),null);
  await flush(()=>typing.noteTyping('c','peer')); assert.ok(host.querySelector('.dm-who.typing:not(.solo)'),'набор и офлайн');
  assert.equal(host.querySelector('.dm-who-status')?.getAttribute('aria-hidden'),'true'); assert.equal(host.querySelector('.dm-who-typing')?.hasAttribute('aria-hidden'),false);
  assert.equal(host.querySelector('.typing-row'),null);
  act(()=>root!.unmount()); root=undefined; host.remove();
  const ChannelChat=(await server.ssrLoadModule('/src/components/ChatView.tsx')).ChatView as ComponentType<{channel:Channel}>;
  await state({messagesByChannel:{ch:[]},members:[{user:peer} as never]});
  await mount(ChannelChat,{channel:{id:'ch',serverId:'s',name:'Канал',type:'text',topic:null} as Channel});
  await flush(()=>typing.noteTyping('ch','peer')); assert.ok(host.querySelector('.typing-row'),'канал сохраняет строку печатает над полем');
});

it('openAt без события открывает карточку собеседника и отдаёт логин ростера при его появлении', async () => {
  // Ловит потерю username у DM-цели и регрессию при холодном ростере, где имя карточки сначала приходит из шапки.
  const { useUserMenu } = await server.ssrLoadModule('/src/components/UserContextMenu.tsx') as typeof import('./UserContextMenu');
  const Harness = () => {
    const userMenu = useUserMenu();
    return el('div', {}, el('button', { onClick: () => userMenu.openAt({ x: 17, y: 23 },
      { userId: 'peer', name: 'Собеседник', username: 'from-header' }, 'profile') }, 'Показать'), userMenu.menu);
  };
  await seed({ members: [] }); await mount(Harness, {});
  await flush(() => host.querySelector<HTMLButtonElement>('button')!.click());
  assert.equal(document.querySelector('.pcard-handle')?.textContent, '@from-header', 'openAt без MouseEvent сохраняет логин из цели шапки');
  await state({ members: [{ user: { ...peer, username: 'from-roster' }, roleIds: [] } as never] });
  await flush(() => host.querySelector<HTMLButtonElement>('button')!.click());
  assert.equal(document.querySelector('.pcard-handle')?.textContent, '@from-roster', 'живой ростер имеет приоритет над старым username шапки');
});

it('строка беседы открывает профиль клавиатурой и кнопкой, а меню не превращает шапку в набор опасных действий', async () => {
  // Ловит регрессию доступного входа в карточку и возврат блокировки/очистки прямо в шапку вместо меню.
  await seed(); await mount(Chat, { dm: dm() });
  const title = host.querySelector<HTMLElement>('.dm-open-profile');
  assert.ok(title, 'имя собеседника доступно как отдельная клавиатурная цель');
  await flush(() => title!.click());
  assert.ok(document.querySelector('.pcard'), 'клик по шапке сразу открывает карточку профиля');
  await flush(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('.topbar-actions button')];
  assert.ok(!buttons.some(b => /Заблокировать|Отключить уведомления/.test(`${b.title} ${b.getAttribute('aria-label')}`)), 'опасные действия не стоят отдельными кнопками шапки');
  const more = host.querySelector<HTMLButtonElement>('[title="Меню беседы"]');
  assert.ok(more, 'действия собраны в меню беседы');
  await flush(() => more!.click());
  const menu = document.querySelector<HTMLElement>('.ctx-menu');
  assert.ok(menu, 'кнопка шапки открывает меню');
  assert.ok(menu?.textContent?.includes('Показать профиль'), 'меню оставляет быстрый доступ к профилю');
  assert.ok(!menu?.textContent?.includes('Очистить историю') && !menu?.textContent?.includes('Удалить чат'), 'управление историей не добавлено в меню шапки');
});

it('DmRow удержание срабатывает на 480 мс, глотает отпускание и сбрасывается новым касанием', async () => {
  // Ловит прежний клик-открытие беседы после long-press и «залипший» подавитель следующего обычного тапа.
  await seed(); let opened = 0, menus = 0;
  await mount(Row, { dm: dm(), summary: summary(), meId: 'me', online: false, active: false, unread: false, unreadN: 0,
    draft: undefined, failed: false, query: '', phone: true, onOpen: () => { opened++; }, onMenu: () => { menus++; } });
  const row = host.querySelector<HTMLButtonElement>('.dm-row'); assert.ok(row, 'строка беседы отрисована кнопкой');
  touchAt(row, 'touchstart', 24, 30);
  await wait(460); assert.equal(menus, 0, 'до границы 480 мс жест ещё не открыл меню');
  await wait(40); assert.equal(menus, 1, 'удержание открывает меню на границе времени');
  const end = new Event('touchend', { bubbles: true, cancelable: true }); row.dispatchEvent(end);
  assert.equal(end.defaultPrevented, true, 'отпускание удержания гасит синтетический click');
  await flush(() => row.click()); assert.equal(opened, 0, 'тот же жест не открывает беседу');
  touchAt(row, 'touchstart', 24, 30); touchAt(row, 'touchmove', 35, 30); await wait(500);
  assert.equal(menus, 1, 'сдвиг больше 10 px отменяет удержание и новое касание не наследует старый таймер');
  touchAt(row, 'touchend', 35, 30); await flush(() => row.click()); assert.equal(opened, 1, 'следующий обычный тап открывает беседу');
});

it('список ЛС держит один Tab-stop и стрелки/первые-последние клавиши двигают фокус без круга', async () => {
  // Ловит потерю roving tabindex, из-за которой сотни строк становятся отдельными Tab-остановками.
  const dms = [dm('first'), dm('middle'), dm('last')];
  await seed({ dms, conv: { ...initial.conv, pts: 100, phase: 'live', summaries: Object.fromEntries(dms.map(d => [d.id, summary({ id: d.id })])) } });
  await mount();
  const rows = [...host.querySelectorAll<HTMLButtonElement>('.dm-row')];
  assert.equal(rows.length, 3, 'список содержит три соседние беседы');
  assert.deepEqual(rows.map(r => r.tabIndex), [0, -1, -1], 'Tab входит в одну строку');
  rows[0]!.focus();
  await flush(() => host.querySelector('.dm-list')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, rows[1], 'стрелка вниз переводит фокус на следующую беседу');
  await flush(() => host.querySelector('.dm-list')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, rows[2], 'End идёт к последней строке');
  await flush(() => host.querySelector('.dm-list')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, rows[2], 'стрелка у конца не зацикливает список');
});

it('Alt-навигация по ЛС работает прямо из textarea, не зацикливается и уважает модальный слой', async () => {
  // Ловит навигацию, которая перестаёт работать именно в обычном месте ввода, и переключение беседы сквозь подтверждение.
  phone = true;
  const dms = [dm('nav-first', 2), dm('nav-current', 9), dm('nav-last', 4)]; const selected: string[] = [];
  await seed({ user: { id: 'me', username: 'me', displayName: 'Я', avatarUrl: null } as never, view: 'dm', mobilePane: 'content',
    currentDmId: 'nav-current', dms, unreadDms: dms.map(d => d.id), convActive: true,
    conv: { ...initial.conv, pts: 100, phase: 'live', summaries: Object.fromEntries(dms.map(d => [d.id, summary({ id: d.id })])) },
    selectDm: (async (id: string) => { selected.push(id); store.setState({ currentDmId: id }); }) as never });
  await mount(Layout, {});
  const badge = host.querySelector<HTMLElement>('.mobile-back-badge');
  assert.ok(badge, 'открытая мобильная беседа получает badge на кнопке Назад');
  assert.equal(badge?.textContent, '6', 'счётчик складывает непрочитанное других строк и исключает открытую');
  const field = host.querySelector<HTMLTextAreaElement>('.composer-input'); assert.ok(field, 'в открытой беседе есть обычное поле ввода');
  const nav = (code: string, ctrlKey = false) => {
    const e = new KeyboardEvent('keydown', { key: code === 'ArrowDown' ? 'ArrowDown' : code, code, bubbles: true, cancelable: true, altKey: true, ctrlKey });
    field!.dispatchEvent(e); return e;
  };
  let event = nav('ArrowDown'); await flush();
  assert.ok(event.defaultPrevented, 'Alt+Down перехватывается даже из поля набора'); assert.deepEqual(selected, ['nav-last'], 'следующей выбрана соседняя беседа');
  event = nav('End', true); await flush();
  assert.deepEqual(selected, ['nav-last'], 'Ctrl+Alt+End у последней беседы не зацикливает переход');
  const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal);
  event = nav('Home', true); await flush();
  assert.ok(!event.defaultPrevented, 'горячая клавиша пропущена верхнему диалогу'); assert.deepEqual(selected, ['nav-last'], 'модальный слой блокирует смену беседы');
  modal.remove();
});

it('лента канала восстанавливает черновик при remount другого канала и очищает после отправки', async () => {
  // MainLayout размонтирует ChatView при смене канала; черновик не должен перейти к соседнему каналу.
  const ChannelChat = (await server.ssrLoadModule('/src/components/ChatView.tsx')).ChatView as ComponentType<{ channel: Channel }>;
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const oldSend = api.sendMessage;
  try {
    const channel = (id: string) => ({ id, serverId: 's', name: id, type: 'text', topic: null }) as Channel;
    await seed({ user: { id: 'me', username: 'me', displayName: 'Я', avatarUrl: null } as never,
      bootstrap: { server: { id: 's', name: 'Сервер' }, channels: [channel('first'), channel('second')], roles: [], permissions: '0' } as never,
      channelDrafts: { first: { text: 'свой черновик', replyToId: null } }, messagesByChannel: { first: [], second: [] } });
    await mount(ChannelChat, { channel: channel('first') });
    assert.equal(host.querySelector<HTMLTextAreaElement>('.composer-input')?.value, 'свой черновик');
    act(() => root!.unmount()); root = undefined; host.remove();
    await mount(ChannelChat, { channel: channel('second') });
    assert.equal(host.querySelector<HTMLTextAreaElement>('.composer-input')?.value, '', 'другой канал не получает прежний текст');
    act(() => root!.unmount()); root = undefined; host.remove();
    await mount(ChannelChat, { channel: channel('first') });
    assert.equal(host.querySelector<HTMLTextAreaElement>('.composer-input')?.value, 'свой черновик', 'возврат к исходному каналу восстанавливает его текст');
    act(() => root!.unmount()); root = undefined; host.remove();
    await mount(ChannelChat, { channel: channel('second') });
    api.sendMessage = async () => ({ id: 'sent', channelId: 'second', author: { id: 'me', username: 'me', displayName: 'Я', avatarUrl: null },
      content: 'готово', attachments: [], createdAt: new Date().toISOString(), reactions: [] }) as never;
    const field = host.querySelector<HTMLTextAreaElement>('.composer-input')!;
    await flush(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'готово');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush(() => host.querySelector<HTMLButtonElement>('.send-btn')!.click());
    await flush();
    assert.equal(host.querySelector<HTMLTextAreaElement>('.composer-input')?.value, '', 'отправка сразу очищает поле');
    assert.equal(Object.keys(store.getState().channelDrafts).includes('second'), false, 'отправленный текст не остаётся черновиком');
  } finally { api.sendMessage = oldSend; }
});

it('App сообщает о сломанном invite без входа, но молчит при unreachable и stale и убирает путь', async () => {
  // Ссылка не должна скрывать причину на экране входа или показывать её, когда человек уже ушёл/сервер недоступен.
  const { api, setToken } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const savedMe = api.me, savedSetup = api.setupStatus;
  const noticeStore = await server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
  const beforeToasts = noticeStore.useToasts.getState().toasts.length;
  api.setupStatus = async () => ({ needsSetup: false, tokenConfigured: true, wizardPending: false }) as never;
  try {
    setToken(null);
    history.replaceState({}, '', '/i/%');
    await seed({ user: null }); await mount(App, {}); await flush();
    assert.equal(location.pathname, '/', 'повреждённый путь убран из адреса');
    assert.ok(host.querySelector('.auth-notice')?.textContent?.includes('Ссылка-приглашение не распознана'), 'гость видит объяснение на форме входа');
    assert.equal(noticeStore.useToasts.getState().toasts.length, beforeToasts, 'без входа не теряем объяснение в невидимом тосте');
    if (root) act(() => root!.unmount()); root = undefined; host.remove();

    setToken('session'); history.replaceState({}, '', '/i/%');
    await seed({ user: null }); api.me = async () => { throw new Error('network unavailable'); };
    await mount(App, {}); await act(async () => { await wait(4700); });
    assert.equal(location.pathname, '/');
    assert.match(host.textContent ?? '', /не отвечает|недоступен/i, `сбой сети показывает экран unreachable: ${host.textContent}`);
    assert.equal(host.querySelector('.auth-notice'), null, 'unreachable не оставляет ложную форму входа');
    assert.equal(noticeStore.useToasts.getState().toasts.length, beforeToasts, 'unreachable suppresses broken invite explanation');
    if (root) act(() => root!.unmount()); root = undefined; host.remove();

    history.replaceState({}, '', '/i/%');
    await seed({ user: null }); api.me = async () => { throw Object.assign(new Error('switched'), { switched: true }); };
    await mount(App, {}); await flush();
    assert.equal(location.pathname, '/');
    assert.equal(host.querySelector('.auth-notice'), null, 'stale не оставляет notice от устаревшей ссылки');
    assert.equal(noticeStore.useToasts.getState().toasts.length, beforeToasts, 'stale load suppresses broken invite toast');

    if (root) act(() => root!.unmount()); root = undefined; host.remove();
    const me = { id: 'me', username: 'me', displayName: 'Я', avatarUrl: null, features: [] };
    api.me = async () => me as never;
    const cfg = await server.ssrLoadModule('/src/config.ts') as typeof import('../config');
    const pending = await server.ssrLoadModule('/src/pendingOpen.ts') as typeof import('../pendingOpen');
    const places = await server.ssrLoadModule('/src/lastPlace.ts') as typeof import('../lastPlace');
    if (!cfg.activeInstanceId()) cfg.addInstance({ apiUrl: 'https://home.test', presenceWs: '' }, { name: 'Дом', activate: true });
    const noOp = async () => {};
    const stateBase = {
      ...initial, user: null, serverFeatures: [], servers: [{ id: 'closed', name: 'Закрытый' }], currentServerId: null, currentDmId: null,
      loadServers: noOp, loadPushMutes: noOp, loadBlocks: noOp, restoreVoiceSession: noOp, loadMembers: noOp,
      listenTabs: () => {}, setConvActive: () => {}, setConvCacheKey: () => {}, convReset: () => {},
      loadDms: noOp, openChannel: async () => { openedChannels.push('channel'); },
    };
    const openCalls: string[] = [], openedChannels: string[] = [];
    let refusalStatus = 403;
    const installStartupState = () => store.setState({ ...stateBase, openServer: async (id: string) => {
      openCalls.push(id);
      throw Object.assign(new Error(refusalStatus === 403 ? 'federation.server_closed' : 'missing'), {
        status: refusalStatus, reason: 'federation_disabled', contacts: [],
      });
    } } as never, true);

    // Вошедший получает сообщение тостом: экран входа ему уже не показывается.
    setToken('session'); history.replaceState({}, '', '/i/%'); installStartupState();
    await mount(App, {}); await flush();
    assert.ok(noticeStore.useToasts.getState().toasts.some(t => t.title === 'Ссылка-приглашение не распознана'), 'вошедший видит именно объяснение сломанной ссылки тостом');
    if (root) act(() => root!.unmount()); root = undefined; host.remove();
    noticeStore.useToasts.setState({ toasts: [] });

    for (const mode of ['pending', 'last-place', 'not-found'] as const) {
      openCalls.length = 0; openedChannels.length = 0; noticeStore.useToasts.setState({ toasts: [] });
      refusalStatus = mode === 'not-found' ? 404 : 403;
      installStartupState();
      if (mode !== 'last-place') pending.setPendingOpen({ instanceId: cfg.activeInstanceId()!, serverId: 'closed', channelId: 'deep-channel' });
      else if (mode === 'last-place') places.rememberPlace({ instanceId: cfg.activeInstanceId()!, serverId: 'closed', channelId: 'old-channel' });
      else assert.equal(store.getState().accessNotice, null, '404 fixture starts without an earlier notice');
      await mount(App, {}); await flush();
      if (mode === 'pending' || mode === 'last-place') {
        assert.equal(store.getState().accessNotice?.serverId, 'closed', `${mode}: отказ создаёт notice (calls=${openCalls.join(',')}, active=${cfg.activeInstanceId()})`);
        assert.ok(store.getState().closedServers.closed, `${mode}: сервер добавлен в закрытые`);
        assert.match(host.textContent ?? '', /Сервер закрыт держателем/, `${mode}: окно видно в реальном App`);
      } else assert.equal(store.getState().accessNotice, null, `404 не маскируется под закрытие держателем; openCalls=${openCalls.join(',')}`);
      assert.deepEqual(openCalls, ['closed'], `${mode}: исполняется только нужная попытка открытия (actual=${openCalls.join(',')})`);
      assert.deepEqual(openedChannels, [], `${mode}: канал не трогаем, если сервер не открылся`);
      if (root) act(() => root!.unmount()); root = undefined; host.remove();
      localStorage.removeItem('gv_pending_open'); localStorage.removeItem('gv_last_place');
      await wait(100);
    }
  } finally { api.me = savedMe; api.setupStatus = savedSetup; setToken(null); history.replaceState({}, '', '/'); }
});

it('потеря шлюза и сети заменяет онлайн и набор собеседника в настоящей шапке', async () => {
  // Устаревшее presence не должно выглядеть живым, пока сокет не доставляет новые события.
  const conn = await server.ssrLoadModule('/src/connState.ts') as typeof import('../connState');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'onLine');
  try {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); conn.resetGatewayLive();
    await seed(); await mount(Chat, { dm: dm() });
    await flush(() => { conn.setGatewayLive(true); conn.setGatewayLive(false); typing.noteTyping('c', 'peer'); });
    assert.equal(host.querySelector('.dm-who-status')?.textContent, 'Соединение…');
    assert.ok(!host.querySelector('.topbar-title .mp-dot-wrap'), 'нет устаревшей точки онлайн');
    assert.ok(!host.querySelector('.dm-who.typing'), 'набор не замещает статус связи');
    await flush(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); });
    assert.equal(host.querySelector('.dm-who-status')?.textContent, 'Ожидание сети…');
    await flush(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')); conn.setGatewayLive(true); typing.clearTyping(); });
    assert.equal(host.querySelector('.dm-who-status')?.textContent, 'в сети');
  } finally {
    await flush(() => {
      if (descriptor) Object.defineProperty(navigator, 'onLine', descriptor); else Reflect.deleteProperty(navigator, 'onLine');
      window.dispatchEvent(new Event('online')); conn.resetGatewayLive();
    });
  }
});

it('админка не обещает политику ЛС старому серверу, новый показывает и сохраняет выбор', async () => {
  // Поля нет у старой ручки: видимый переключатель создавал бы ложное обещание сохранения.
  const { api } = await server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const Panel = (await server.ssrLoadModule('/src/components/InstanceSettingsForms.tsx')).InstanceSettingsPanel as ComponentType;
  const oldGet = api.adminInstance, oldSet = api.adminSetInstance;
  const base = { name: null, iconUrl: null, registration: 'open', smtpConfigured: true };
  const saved: unknown[] = [];
  try {
    await seed({ adminInstanceId: null });
    api.adminInstance = async () => base as Awaited<ReturnType<typeof api.adminInstance>>;
    await mount(Panel, {});
    assert.ok(!host.textContent?.includes('Кто может начать личную переписку'), 'старый сервер не получает раздел');
    act(() => root!.unmount()); root = undefined; host.remove();
    api.adminInstance = async () => ({ ...base, dmPolicy: 'shared' }) as Awaited<ReturnType<typeof api.adminInstance>>;
    api.adminSetInstance = async patch => { saved.push(patch); return { ok: true }; };
    await mount(Panel, {});
    assert.ok(host.textContent?.includes('Кто может начать личную переписку'), 'новый сервер показывает раздел');
    const option = host.querySelector<HTMLInputElement>('input[name="dm-policy"][value="anyone"]');
    assert.ok(option, 'есть разрешающий вариант политики');
    await flush(() => option!.click());
    assert.deepEqual(saved, [{ dmPolicy: 'anyone' }]);
  } finally { api.adminInstance = oldGet; api.adminSetInstance = oldSet; }
});
it('общий выключатель увеличивает seq, повтор close не перерисовывает, unmount закрывает', async () => {
  // Ловит старый лист после смены раздела и лишние события закрытия.
  await seed(); await mount(); const before=(await server.ssrLoadModule('/src/dmCompose.ts')) as typeof compose;
  let renders=0, snapshot:ReturnType<typeof compose.useDmCompose>;
  function Probe(){ renders++; snapshot=before.useDmCompose(); return null; }
  const node=document.createElement('div'); document.body.append(node); const probe=createRoot(node);
  try {
    await flush(()=>probe.render(el(Probe))); const seq=snapshot!.seq;
    await flush(()=>compose.openDmCompose('x')); assert.deepEqual(snapshot!,{open:true,query:'x',seq:seq+1});
    await flush(()=>compose.closeDmCompose()); const count=renders;
    await flush(()=>compose.closeDmCompose()); assert.equal(renders,count);
    await flush(()=>compose.openDmCompose()); act(()=>root!.unmount()); root=undefined;
    await flush(); assert.equal(snapshot!.open,false);
  } finally { act(()=>probe.unmount()); node.remove(); }
});

// Проверяется tsc: контракт не позволяет одновременно точку и якорь или отсутствие обоих.
function menuTypeContract() {
  const common = { onClose() {}, children: null };
  const point: ContextMenuProps = { ...common, pos: { x: 1, y: 2 } };
  const anchor: ContextMenuProps = { ...common, anchor: new DOMRect() };
  // @ts-expect-error ровно один способ размещения
  const both: ContextMenuProps = { ...point, anchor: new DOMRect() };
  // @ts-expect-error способ размещения обязателен
  const neither: ContextMenuProps = common;
  return [point, anchor, both, neither];
}
void menuTypeContract;
const anchorBox = () => new DOMRect(100, 200, 160, 50);
const menuProps = (onClose: () => void): ContextMenuProps => ({ anchor: anchorBox(), onClose,
  children: el('button', { role: 'menuitem' }, 'Действие') });
function touchAt(target: Element, type: string, x: number, y: number) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'touches', { value: [{ clientX: x, clientY: y }] }); target.dispatchEvent(e);
}
it('меню у якоря имеет стек, выравнивание и две половины подсветки', async () => {
  // Ловит возврат листа вместо меню у пузыря и потерю незатемнённой строки.
  await seed(); await mount(Menu, { ...menuProps(() => {}), align: 'end', spotlight: { top: 200, bottom: 250 } });
  assert.ok(document.querySelector('.ctx-stack.anchored.end'), 'стек у правого края');
  assert.equal(document.querySelectorAll('.ctx-spot').length, 2);
  assert.equal((document.querySelector('.ctx-spot.top') as HTMLElement).style.height, '200px');
  assert.equal((document.querySelector('.ctx-spot.bottom') as HTMLElement).style.top, '250px');
  assert.ok(!document.querySelector('.ctx-sheet-backdrop'), 'якорь не превращается в лист');
});
it('точка без новых пропсов оставляет старую ветку, реакции и подсветка включают стек', async () => {
  // Ловит случайное включение новой разметки для всех старых вызывающих.
  await seed(); const base = { pos: { x: 30, y: 40 }, onClose() {}, children: el('button', {}, 'Пункт') };
  await mount(Menu, base); assert.ok(document.querySelector('.ctx-menu'), 'старое меню');
  assert.ok(!document.querySelector('.ctx-stack'), 'нет новых пропсов — нет стека');
  for (const reactions of [undefined, null, false, '']) {
    await flush(() => root!.render(el(Menu, { ...base, reactions, align: 'end' })));
    assert.ok(!document.querySelector('.ctx-stack'), 'пустая полоса не включает стек');
  }
  await flush(() => root!.render(el(Menu, { ...base, reactions: el('div', {}, 'Реакции') })));
  assert.ok(document.querySelector('.ctx-stack'), 'полоса включает стек');
  await flush(() => root!.render(el(Menu, { ...base, spotlight: { top: 1, bottom: 2 } })));
  assert.ok(document.querySelector('.ctx-stack'), 'подложка включает стек');
});
it('клик мимо якоря закрывает и поглощается, mousedown и клик внутри не закрывают', async () => {
  // Ловит открытие следующего меню тем же касанием после закрытия первого.
  await seed(); let closed = 0, leaked = 0; await mount(Menu, menuProps(() => closed++));
  const outside = document.createElement('button'); outside.dataset.fixture = ''; document.body.append(outside);
  outside.addEventListener('click', () => leaked++);
  await flush(() => outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  assert.equal(closed, 0);
  await flush(() => document.querySelector<HTMLButtonElement>('.ctx-menu button')!.click()); assert.equal(closed, 0);
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  await flush(() => outside.dispatchEvent(click));
  assert.equal(closed, 1); assert.equal(leaked, 0); assert.equal(click.defaultPrevented, true);
  await flush(() => document.querySelector<HTMLElement>('.ctx-stack')!.click());
  assert.equal(closed, 2, 'пустая часть стека тоже считается кликом мимо');
});
it('правый клик мимо и колесо закрывают, программный scroll и resize сохраняют якорь', async () => {
  // Ловит закрытие меню из-за догрузки картинки или спрятанной клавиатуры.
  await seed(); let closed = 0; await mount(Menu, menuProps(() => closed++));
  const beforeTop = (document.querySelector('.ctx-stack') as HTMLElement).style.top;
  await flush(() => { window.dispatchEvent(new Event('scroll'));
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 350, configurable: true }); window.dispatchEvent(new Event('resize')); });
  assert.equal(closed, 0); assert.ok(document.querySelector('.ctx-stack.anchored'), 'меню пережило resize');
  assert.notEqual((document.querySelector('.ctx-stack') as HTMLElement).style.top, beforeTop, 'resize пересчитывает сторону от нового viewport');
  await flush(() => document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))); assert.equal(closed, 1);
  await flush(() => document.querySelector('.ctx-menu')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))); assert.equal(closed, 1);
  await flush(() => document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))); assert.equal(closed, 2);
});
it('палец ровно на 10 px не закрывает меню, 11 px закрывает один раз', async () => {
  // Ловит off-by-one жеста и повторный onClose на каждом touchmove.
  await seed(); let closed = 0; await mount(Menu, menuProps(() => closed++));
  await flush(() => { touchAt(document.body, 'touchstart', 20, 20); touchAt(document.body, 'touchmove', 30, 30); });
  assert.equal(closed, 0);
  await flush(() => root!.render(el(Menu, menuProps(() => closed++))));
  await flush(() => touchAt(document.body, 'touchmove', 31, 20)); assert.equal(closed, 1);
  await flush(() => touchAt(document.body, 'touchmove', 50, 20)); assert.equal(closed, 1);
  await flush(() => { touchAt(document.querySelector('.ctx-menu')!, 'touchstart', 20, 20); touchAt(document.querySelector('.ctx-menu')!, 'touchmove', 50, 20); });
  assert.equal(closed, 1);
});
it('клавиши прокрутки вне меню закрывают, поля и пробел кнопки не перехватываются', async () => {
  // Ловит закрытие меню при редактировании текста и недоступную кнопку с клавиатуры.
  await seed(); let closed = 0; await mount(Menu, menuProps(() => closed++));
  const field = document.createElement('input'), button = document.createElement('button');
  field.dataset.fixture = ''; button.dataset.fixture = ''; document.body.append(field, button);
  const key = (target: Element, k: string, extra = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));
  await flush(() => { key(field, 'ArrowDown'); key(button, ' '); key(document.body, 'PageDown', { ctrlKey: true }); key(document.body, 'a'); key(document.querySelector('.ctx-menu button')!, 'ArrowDown'); });
  assert.equal(closed, 0);
  for (const k of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']) {
    await flush(() => key(document.body, k));
  }
  assert.equal(closed, 7);
  await flush(() => key(field, 'Escape')); assert.equal(closed, 8);
});
it('полоса имеет единый набор, мои реакции доступны, кнопки не закрывают меню как внешний клик', async () => {
  // Ловит раскол быстрых реакций и потерю aria-pressed либо доступного полного пикера.
  await seed(); assert.deepEqual(quick, ['👍', '🔥', '😂', '❤️', '🦆']);
  const pane = readFileSync(new URL('./MessagePane.tsx', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(pane, /import\s*\{[^}]*\bQUICK_REACTIONS\b[^}]*\}\s*from '\.\/ContextMenu'/);
  assert.doesNotMatch(pane, /(?:const|let)\s+QUICK_REACTIONS\s*=/);
  const picks: string[] = []; let more = 0, moreAnchor: EventTarget | null = null, closed = 0;
  await mount(Menu, { ...menuProps(() => closed++), reactions: el(Bar, { mine: ['🔥'], onPick: e => picks.push(e), onMore: e => { more++; moreAnchor = e.currentTarget; } }) });
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.react-bar-btn')];
  assert.equal(buttons.length, 5); assert.equal(buttons[1].getAttribute('aria-pressed'), 'true'); assert.ok(buttons[1].classList.contains('on'), 'моя реакция');
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'false');
  await flush(() => { buttons[1].click(); document.querySelector<HTMLButtonElement>('.react-bar-more')!.click(); });
  assert.deepEqual(picks, ['🔥']); assert.equal(more, 1); assert.equal(closed, 0);
  assert.equal(moreAnchor, document.querySelector('.react-bar-more'), 'полный пикер получает кнопку-якорь, а не событие с потерянным currentTarget');
});
it('узкое старое меню остаётся листом, но якорь даже на телефоне использует стек', async () => {
  // Ловит снятие старого мобильного пути и обратную регрессию якорного меню в лист.
  narrow = true; phone = true; await seed(); let closed = 0;
  await mount(Menu, { pos: { x: 10, y: 20 }, onClose: () => closed++, children: el('button', {}, 'Пункт') });
  assert.ok(document.querySelector('.ctx-sheet-backdrop .ctx-menu.sheet'), 'старый узкий путь — лист');
  await flush(() => window.dispatchEvent(new Event('resize'))); assert.equal(closed, 0);
  await flush(() => root!.render(el(Menu, menuProps(() => closed++))));
  assert.ok(!document.querySelector('.ctx-sheet-backdrop'), 'якорь отключает лист');
  assert.ok(document.querySelector('.ctx-stack.anchored'), 'узкий якорь — стек');
});
it('пересылка на ПК — окно, поиск ё=е, Esc сперва чистит и затем закрывает', async () => {
  // Ловит прежний лист на ПК и закрытие до возможности поправить запрос.
  await seed({ dms: [{ ...dm(), otherUser: { ...peer, displayName: 'Ёжик' } }, { ...dm('d'), otherUser: { ...peer, id: 'p2', displayName: 'Кот' } }] });
  let closed = 0; await mount(Picker, { count: 2, onSend() {}, onClose: () => closed++ });
  assert.ok(document.querySelector('.modal-overlay .fwd-modal[aria-modal="true"]'), 'окно ПК');
  assert.ok(!document.querySelector('.sheet'), 'не лист'); assert.equal(document.activeElement, host.querySelector('input'));
  await input('еж'); assert.equal(host.querySelectorAll('.dm-row').length, 1); assert.equal(host.querySelector('mark')?.textContent, 'Ёж');
  await flush(() => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(closed, 0); assert.equal(host.querySelectorAll('.dm-row').length, 2);
  await flush(() => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(closed, 1);
});
it('пересылка на телефоне — лист, повторный выбор не вызывает вторую пересылку', async () => {
  // Ловит двойной сетевой запрос до размонтирования окна.
  phone = true; await seed(); const picks: string[] = []; let closed = 0;
  await mount(Picker, { count: 1, onSend: ids => picks.push(...ids), onClose: () => closed++ });
  assert.ok(document.querySelector('.sheet-scrim .sheet'), 'лист телефона'); assert.ok(!document.querySelector('.fwd-modal'), 'не окно ПК');
  await flush(() => document.querySelector<HTMLButtonElement>('.dm-row')!.click());
  assert.deepEqual(picks, [], 'выбор адресата сам по себе не отправляет');
  await flush(() => { document.querySelector<HTMLButtonElement>('.fwd-send')!.click(); document.querySelector<HTMLButtonElement>('.fwd-send')!.click(); });
  assert.deepEqual(picks, ['c']); assert.equal(closed, 1);
});
it('Esc в мобильном пикере сначала чистит поиск, не отдавая событие листу', async () => {
  // Ловит закрытие BottomSheet первым Esc: он слушает window и не читает defaultPrevented.
  phone = true; await seed(); let closed = 0;
  await mount(Picker, { count: 1, onSend() {}, onClose: () => closed++ });
  await input('кот'); const field = document.querySelector<HTMLInputElement>('input.sheet-search')!;
  await flush(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(field.value, ''); assert.equal(closed, 0);
  await flush(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(closed, 1);
});
it('пересылка закрывается в finally даже при исключении обработчика', async () => {
  // Ловит зависшее окно и повторную отправку после локального сбоя вызывающего.
  await seed(); let closed = 0, calls = 0;
  const errors: unknown[] = []; const onError = (e: ErrorEvent) => { errors.push(e.error); e.preventDefault(); };
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    // React/HappyDOM печатает ожидаемое исключение дважды; чужие ошибки не скрываем.
    if (!args.some(a => a instanceof Error && a.message === 'test-pick-failed')) originalError(...args);
  };
  window.addEventListener('error', onError);
  try {
    await mount(Picker, { count: 1, onSend() { calls++; throw new Error('test-pick-failed'); }, onClose: () => closed++ });
    await flush(() => host.querySelector<HTMLButtonElement>('.dm-row')!.click());
    await flush(() => host.querySelector<HTMLButtonElement>('.fwd-send')!.click());
    await flush(() => host.querySelector<HTMLButtonElement>('.fwd-send')!.click());
    assert.equal(closed, 1); assert.equal(calls, 1); assert.ok(errors.length > 0, 'исключение обработчика не потерялось');
    for (const error of errors) assert.match(String(error), /test-pick-failed/);
  } finally { window.removeEventListener('error', onError); console.error = originalError; }
});
it('пикер скрывает печатает, обычная строка сохраняет его по умолчанию', async () => {
  // Ловит утечку индикатора typing в выбор получателя и регрессию боковой панели.
  await seed(); await flush(() => typing.noteTyping('c', 'peer'));
  await mount(Picker, { count: 1, onSend() {}, onClose() {} });
  assert.ok(!host.querySelector('.dm-typing'), 'в пикере нет typing');
  await flush(() => root!.render(el(Row, { dm: dm(), summary: summary(), meId: 'me', online: true, active: false,
    unread: false, unreadN: 0, draft: undefined, failed: false, query: '', phone: false, onOpen() {} })));
  assert.ok(host.querySelector('.dm-typing'), 'по умолчанию строка показывает typing');
});
it('пустой пикер и отсутствующие результаты имеют разные объяснения', async () => {
  // Ловит молчаливый пустой список, не позволяющий отличить отсутствие бесед от фильтра.
  await seed({ dms: [] }); await mount(Picker, { count: 5, onSend() {}, onClose() {} });
  assert.equal(host.querySelector('.sheet-empty')?.textContent, 'Бесед пока нет');
  await state({ dms: [dm()] }); await input('пингвин');
  assert.equal(host.querySelector('.sheet-empty')?.textContent, 'По запросу «пингвин» бесед нет');
});

async function mutantScenario(kind: string) {
  if (kind === 'закрытый-сервер') { await closedServerAppScenario(); return; }
  if (kind === 'устаревший-поиск') { await searchScenario('stale'); return; }
  if (kind === 'дебаунс-поиска') { await searchScenario('debounce'); return; }
  if (kind === 'дубль-поиска') { await searchScenario('duplicate'); return; }
  if (kind === 'гость-поиск') { await searchScenario('guest'); return; }
  if (kind === 'назад-поиск-беседа' || kind === 'назад-поиск-настройки') { await searchBackOverlayScenario(); return; }
  if (kind === 'устаревший-поиск') { await searchScenario('stale'); return; }
  if (kind === 'дебаунс-поиска') { await searchScenario('debounce'); return; }
  if (kind === 'дубль-поиска') { await searchScenario('duplicate'); return; }
  if (kind === 'гость-поиск') { await searchScenario('guest'); return; }
  if (kind==='ошибка') {
    await seed({ outbox:{ c:[outgoing()] } }); await mount();
    assert.ok(host.querySelector('.dm-when .dm-st.failed'), 'ошибка на месте отметки');
  } else if (kind==='телефон') {
    phone=true; await seed({currentDmId:'c'}); await mount(); assert.ok(!host.querySelector('.dm-row.active'),'телефон не подсвечивает открытую строку');
  } else if (kind==='печатает') {
    await seed(); await mount(); await flush(()=>typing.noteTyping('c','third')); assert.ok(!host.querySelector('.dm-typing'),'третий человек не собеседник');
  } else {
    let calls=0; await seed({ user:{id:'me',username:'me',displayName:'Гусь',homeInstance:{instanceId:'home',name:'Дом',domain:'home.test'}} as never,openDmWith:async()=>{calls++;} });
    await mount(); await flush(()=>compose.openDmCompose()); await flush(()=>document.querySelector<HTMLButtonElement>('.sheet-row')!.click()); assert.equal(calls,0,'гостевая ЛС не делает API-запрос');
  }
}
for (const kind of Object.keys(mutations)) it(`мутант ${kind} отвергается тем же DOM-сценарием`, async () => {
  // Ловит ослабление самого харнесса: оригинал проходит, соответствующая потеря проверки — нет.
  if (mutant) { await assert.rejects(()=>mutantScenario(kind),assert.AssertionError); return; }
  await mutantScenario(kind);
  const env:NodeJS.ProcessEnv={...process.env,GUSVOICE_DM_ROW_MUTANT:kind}; delete env.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,['--import','tsx','--test-reporter','tap','--test-name-pattern',`^мутант ${kind} отвергается тем же DOM-сценарием$`,fileURLToPath(import.meta.url)],{env,stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data',(s:Buffer)=>{output=(output+s).slice(-12000);}); child.stderr.on('data',(s:Buffer)=>{output=(output+s).slice(-12000);});
  const done=new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
  let timer: ReturnType<typeof setTimeout>;
  try {
    const code=await Promise.race([done,new Promise<never>((_,reject)=>{timer=nativeTimeout(()=>reject(new Error('Таймаут процесса мутанта')),45000);})]);
    assert.equal(code,0,output); assert.match(output,/# pass 1(?:\r?\n|$)/,'один тест действительно выполнен');
  } finally {
    nativeClear(timer!);
    if (child.exitCode===null) { child.kill('SIGKILL'); let cleanup:ReturnType<typeof setTimeout>; try { await Promise.race([done,new Promise<never>((_,reject)=>{cleanup=nativeTimeout(()=>reject(new Error('Не закрылся mutant worker')),5000);})]); } finally { nativeClear(cleanup!); } }
  }
});
