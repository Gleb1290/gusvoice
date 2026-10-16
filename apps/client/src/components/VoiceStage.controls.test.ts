import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { fitStageGrid, stageAvatarSize } from '../stageGridRules';
import { stageHasVideo } from '../stageAutoShowRules';
import * as stageOrderRules from '../stageOrderRules';
import type { StageOrderLayout } from '../stageOrderPrefs';
import * as stageLayoutRules from '../stageLayoutRules';

const source = readFileSync(new URL('./VoiceChannelView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Options = { phone?: boolean; mobile?: boolean; touch?: boolean; hide?: boolean; watched?: boolean;
  cameras?: boolean; streams?: boolean; connected?: boolean; muted?: boolean; mutedCamera?: boolean; companionScreen?: boolean; volume?: number;
  cols?: number; savedOrder?: string[]; dragPreview?: string[]; tip?: 'none' | 'button' | 'hold'; channelId?: string | null; bothStreams?: boolean; economy?: boolean;
  noCameraPeople?: number; stageStreams?: string[]; watchedIds?: string[]; stageKey?: string;
  layout?: stageLayoutRules.StageLayout; speakerId?: string | null; selfId?: string; includeSelf?: boolean; stageAudio?: string[];
  savedModes?: Partial<Record<stageOrderRules.StageOrderMode, string[]>>;
  modePreviews?: Partial<Record<stageOrderRules.StageOrderMode, string[]>> };
type DragInput = { enabled: boolean; gridRef: React.RefObject<HTMLDivElement>; order: readonly string[]; onCommit(order: string[]): void };
const noop = () => {};
const peer = { identity: 'peer', name: 'Анна', sid: 'peer', isLocal: false, attributes: {} };
const companion = { ...peer, identity: 'peer#screen', sid: 'companion' };
const camera = { participant: peer, publication: { trackSid: 'cam', isMuted: false } };
const screen = { participant: peer }; // Без публикации: нет настоящей подписки/таймеров статистики.

async function fixture(component: 'VoiceChannelView' | 'ScreenViewer' | 'CameraViewer', options: Options,
  check: (f: { host: HTMLDivElement; render(): Promise<void>; click(selector: string): Promise<void>;
    setLayout(layout: stageLayoutRules.StageLayout): Promise<void>; watched(): string[];
    calls: { toggles: number; volumes: number[]; prefs: boolean[]; newHooks: number;
      autoShow: { hasVideo: boolean; hideNoVideo: boolean; channelId: string | null }[];
      orderReads: { channelId: string | null; cols: StageOrderLayout }[];
      orderWrites: { channelId: string; cols: StageOrderLayout; order: string[] }[];
      drags: DragInput[]; pointerDown: number; pointerInstances: number[];
      clearWatched: number; watch: string[]; unwatch: string[]; layouts: stageLayoutRules.StageLayout[]; events: string[];
      speaker: { ids: string[]; enabled: boolean }[] } }) => Promise<void>, raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const calls = { toggles: 0, volumes: [] as number[], prefs: [] as boolean[], newHooks: 0,
    autoShow: [] as { hasVideo: boolean; hideNoVideo: boolean; channelId: string | null }[],
    orderReads: [] as { channelId: string | null; cols: StageOrderLayout }[],
    orderWrites: [] as { channelId: string; cols: StageOrderLayout; order: string[] }[],
    drags: [] as DragInput[], pointerDown: 0, pointerInstances: [] as number[],
    clearWatched: 0, watch: [] as string[], unwatch: [] as string[], layouts: [] as stageLayoutRules.StageLayout[],
    events: [] as string[], speaker: [] as { ids: string[]; enabled: boolean }[] };
  let nextDragInstance = 0;
  const unexpected: string[] = [];
  let hide = options.hide ?? false;
  let volume = options.volume ?? 1.4;
  const subscribers = new Set<() => void>();
  const useHide = () => { calls.newHooks++; return React.useSyncExternalStore(
    React.useCallback((fn: () => void) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; }, []), () => hide); };
  const setHide = (v: boolean) => { hide = v; calls.prefs.push(v); for (const fn of subscribers) fn(); };
  let revision = 0;
  let disposing = false;
  const stateSubscribers = new Set<() => void>();
  const subscribeState = (fn: () => void) => { stateSubscribers.add(fn); return () => { stateSubscribers.delete(fn); }; };
  const getRevision = () => revision;
  const useRevision = () => React.useSyncExternalStore(subscribeState, getRevision);
  const changed = () => { revision++; if (!disposing) for (const fn of stateSubscribers) fn(); };
  const setLayout = (layout: stageLayoutRules.StageLayout) => {
    calls.layouts.push(layout); calls.events.push(`layout:${layout}`); options.layout = layout; changed();
  };
  const room = { localParticipant: { identity: options.selfId ?? 'self', setAttributes: async () => {}, setCameraEnabled: async () => {}, getTrackPublication: () => undefined },
    on: (..._args: unknown[]) => room, off: (..._args: unknown[]) => room };
  const state = { voice: { channelId: options.channelId === undefined ? 'channel' : options.channelId }, presence: {},
    bootstrap: options.economy ? { server: { id: 'server' } } : null,
    economy: options.economy ? { server: { enabled: true, wallet: { balance: 123 }, currencyName: 'перья' } } : {},
    watchedStreams: options.watchedIds ?? (options.watched ? options.bothStreams ? ['peer', 'peer#screen'] : ['peer'] : []),
    mutedStreams: [], streamVolumes: {}, pendingWatch: null,
    clearWatchedStreams: () => { calls.clearWatched++; calls.events.push('clear');
      if (state.watchedStreams.length) { state.watchedStreams = []; changed(); } }, clearPendingWatch: noop,
    watchStream: (id: string) => { calls.watch.push(id); calls.events.push(`watch:${id}`);
      if (!state.watchedStreams.includes(id)) { state.watchedStreams = [...state.watchedStreams, id]; changed(); } },
    unwatchStream: (id: string) => { calls.unwatch.push(id); calls.events.push(`unwatch:${id}`);
      if (state.watchedStreams.includes(id)) { state.watchedStreams = state.watchedStreams.filter(x => x !== id); changed(); } },
    toggleStreamMute: noop, setStreamVolume: noop, joinVoice: async () => {},
    selfMuted: false, selfDeafened: false, leaveVoice: noop };
  const icon = ({ name }: { name: string }) => React.createElement('i', { 'data-icon': name });
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    '@livekit/components-react': { useParticipants: () => [peer, companion,
      ...(options.includeSelf ? [{ ...peer, identity: options.selfId ?? 'self', sid: 'local', name: 'Я', isLocal: true }] : []),
      ...Array.from({ length: Math.max(0, (options.noCameraPeople ?? 1) - 1) }, (_, i) =>
        ({ ...peer, identity: `guest-${i}`, sid: `guest-${i}`, name: `Гость ${i}` }))], useRoomContext: () => room,
      // MobileCallBar читает настоящий контракт хука, а не Participant напрямую.
      useLocalParticipant: () => ({ localParticipant: room.localParticipant, isCameraEnabled: false }),
      useTracks: (spec: { source: string }[]) => spec[0].source === 'screen' ? (options.stageStreams ?
        options.stageStreams.map(id => ({ participant: { ...peer, identity: id, sid: id }, publication: { trackSid: `screen-${id}` } })) : options.streams ?
        options.bothStreams ? [{ ...screen, publication: { trackSid: 'screen-browser' } },
          { ...screen, participant: companion, publication: { trackSid: 'screen-native' } }]
          : [{ ...screen, participant: options.companionScreen ? companion : peer }] : [])
        : spec[0].source === 'audio' ? (options.stageAudio ?? []).map(id => ({ participant: { ...peer, identity: id } }))
        : spec[0].source === 'camera' ? (options.cameras ?
          [{ ...camera, publication: { ...camera.publication, isMuted: !!options.mutedCamera } }] : []) : [],
      VideoTrack: ({ className, trackRef }: { className: string; trackRef?: { participant: { identity: string } } }) =>
        React.createElement('div', { className, 'data-track-id': trackRef?.participant.identity }),
    },
    'livekit-client': { Track: { Source: { ScreenShare: 'screen', ScreenShareAudio: 'audio', Camera: 'camera' } }, RoomEvent: {} },
    '../hotkeys': { isMobile: () => !!options.mobile },
    // Мобильная ветка инициализирует настройку камеры и ставит обработчики кнопок при монтаже.
    // Камера/микрофон не являются предметом этих проверок режима перетаскивания.
    '../cameraSettings': { getCameraPreset: () => 'normal' },
    '../voiceSelf': { toggleSelfMute: noop, toggleSelfDeafen: noop },
    '../store': { useStore: (select: (s: typeof state) => unknown) => { useRevision(); return select(state); } },
    '../stageLayoutPrefs': { useStageLayout: () => { useRevision(); return options.layout ?? 'auto'; }, setStageLayout: setLayout },
    '../stageLayoutRules': stageLayoutRules,
    '../useStageSpeaker': { useStageSpeaker: (ids: string[], enabled: boolean) => {
      useRevision(); calls.speaker.push({ ids: [...ids], enabled }); return enabled ? options.speakerId ?? null : null;
    } },
    './StageLayoutPicker': { StageLayoutPicker: () => null },
    '../memberName': { useNameResolver: () => (_id: string, name: string) => name, useVoiceName: () => (p: typeof peer) => p.name },
    '../stageViewPrefs': { useHideNoVideo: useHide, setHideNoVideo: setHide },
    '../stageOrderRules': stageOrderRules,
    '../stageOrderPrefs': { useStageOrder: (channelId: string | null, cols: StageOrderLayout) => {
      calls.orderReads.push({ channelId, cols });
      return typeof cols === 'number' ? options.savedOrder ?? null : options.savedModes?.[cols] ?? null;
    }, saveStageOrder: (channelId: string, cols: StageOrderLayout, order: string[]) => calls.orderWrites.push({ channelId, cols, order: [...order] }),
      useHasStageOrder: () => false, resetStageOrder: noop },
    '../useStageDrag': { useStageDrag: (input: DragInput) => {
      const instance = React.useRef<number>();
      if (instance.current === undefined) instance.current = nextDragInstance++;
      const index = instance.current;
      const nestRef = React.useRef<HTMLDivElement>(null);
      calls.drags.push(input);
      return { preview: index < 3 ? options.modePreviews?.[stageOrderRules.STAGE_ORDER_MODES[index]] ?? null : options.dragPreview ?? null,
        dragging: false, nestRef, onPointerDown: () => { calls.pointerDown++; calls.pointerInstances.push(index); } };
    } },
    '../stageAutoShowRules': { stageHasVideo },
    // Таймер проверяется отдельным тестом настоящего хука; здесь проверяем его входы из сцены.
    '../useStageAutoShow': { useStageAutoShow: (input: { hasVideo: boolean; hideNoVideo: boolean; channelId: string | null }) => {
      calls.autoShow.push({ hasVideo: input.hasVideo, hideNoVideo: input.hideNoVideo, channelId: input.channelId });
    } },
    '../phoneLayout': { usePhoneLayout: () => { calls.newHooks++; return !!options.phone; } },
    '../stageGridRules': { fitStageGrid: options.cols === undefined ? fitStageGrid : () => ({ cols: options.cols, rows: 1, tileW: 100, tileH: 60 }),
      stageAvatarSize, STAGE_SCROLLBAR_PX: 12, STAGE_GRID_HYSTERESIS_PX: 16 },
    '../streamAudioRules': { ownerOf: (id: string) => id.replace(/#screen$/, ''), MAX_STREAM_VOLUME: 2 },
    '../streamCardRules': { canSnapshotStream: () => false },
    '../tipGesture': { useAltHeld: () => options.tip === 'button', useTip: () => ({ tip: noop, busyId: null }) },
    '../economyClient': { ensureEconomy: noop },
    '../tipMode': { tipInteraction: () => options.tip ?? 'none' }, '../watchGrace': { createWatchGrace: () => ({ reconcile: noop, dispose: noop }) },
    '../streamCue': { STREAM_VIEW_GRACE_MS: 1000 },
    './UserContextMenu': { useUserMenu: () => ({ open: noop, menu: null }) },
    './VoiceParticipants': { avatarFromMetadata: () => null, useLiveSpeaking: () => false,
      useParticipantFlags: () => ({ micMuted: false, deafened: false, screenSharing: false }) },
    '../localUserAudio': { useUserAudio: () => ({ muted: false }) },
    './Crown': { useIsCrowned: () => false, crownGlow: () => '', CrownMark: () => null },
    '../avatarAnimation': { useAnimatedAvatarUrl: () => () => null },
    './Avatar': { Avatar: ({ size }: { size: number }) => React.createElement('i', { 'data-avatar-size': size }) },
    './Icon': { Icon: icon, ChannelGlyph: icon }, './Goose': { Goose: () => null }, './StreamTipFeed': { StreamTipFeed: () => null },
    '../streamQuality': { useStreamQuality: () => 'auto', streamHasLayers: () => false, layerChoices: () => [], shownPref: () => 'auto',
      STREAM_QUALITY_HINT: { auto: 'Авто' }, STREAM_QUALITY_LABEL: { auto: 'Авто' } },
    '../badPicture': { useBadPictureAvailable: () => false },
  };
  // Эти импорты нужны целому модулю, но данные сценарии их ветки не открывают.
  // Если приложение проглотит бросок заглушки, журнал всё равно сделает тест красным.
  for (const id of ['../api', '../toast', './BottomSheet', '../pendingWatch', '../windowCovered', './ContextMenu']) {
    deps[id] = new Proxy({}, { get: (_target, key) => {
      const boundary = `${id}.${String(key)}`; unexpected.push(boundary);
      throw new Error(`Неописанная граница ${boundary}`);
    } });
  }
  window.matchMedia = ((query: string) => ({ matches: query === '(hover: none)' && !!options.touch })) as typeof window.matchMedia;
  try {
    const module = { exports: {} as Record<string, React.ComponentType<any>> };
    // Исполняем целый модуль; export открывает только приватные компоненты для монтажа.
    runInNewContext(ts.transpileModule(raw + '\nexport { ScreenViewer, CameraViewer };', { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, window, document, console, getComputedStyle,
      ResizeObserver: options.cols === undefined ? undefined : class { observe() {} disconnect() {} },
      require: (id: string) => {
        assert.equal(Object.hasOwn(deps, id), true, `Неописанный импорт сцены ${id}`); return deps[id];
      } });
    const props = component === 'VoiceChannelView' ? { channel: { id: 'channel', name: 'Гусиная', type: 'voice' }, connected: options.connected ?? true }
      : { track: screen, hasAudio: true, audioMuted: !!options.muted, volume, viewers: [],
        onToggleAudio: () => calls.toggles++, onVolume: (v: number) => { calls.volumes.push(v); volume = v; }, onClose: noop, stageKey: options.stageKey };
    const render = async () => { await React.act(async () => { root.render(React.createElement(module.exports[component],
      'volume' in props ? { ...props, volume } : props));
      for (let i = 0; i < 5; i++) await Promise.resolve(); }); };
    const click = async (selector: string) => { const el = host.querySelector<HTMLElement>(selector); assert.ok(!!el, `Есть ${selector}`);
      await React.act(async () => el!.click()); };
    await render(); await check({ host, render, click, calls, watched: () => [...state.watchedStreams],
      setLayout: async layout => { await React.act(async () => setLayout(layout)); } });
    assert.deepEqual(unexpected, [], 'Сцена не использует неописанные побочные границы');
  } finally {
    disposing = true;
    await React.act(async () => root.unmount()); host.remove(); await GlobalRegistrator.unregister();
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}

async function mobileBar(raw = source) {
  for (const [mobile, connected] of [[true, true], [false, true], [true, false]] as const) {
    await fixture('VoiceChannelView', { mobile, connected }, async ({ host }) => {
      assert.equal(host.querySelector('.voice-call-bar') !== null, mobile && connected, 'подключённый телефон получает свою voice-call-bar');
      assert.equal(host.querySelector('.call-bar') !== null, false, 'голосовая панель не использует зелёную полосу звонка ЛС');
    }, raw);
  }
}
it('R200 подключённый телефон показывает voice-call-bar, ПК и неподключённый канал её не показывают', () => {
  // Класс ошибки: коллизия общего имени .call-bar красила телефонный голосовой канал в зелёный.
  return mobileBar();
});
it('R200 возврат прежнего имени call-bar обнаруживается на смонтированном телефоне', async () => {
  await mobileBar(); const anchor = 'className="voice-call-bar"'; assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(() => mobileBar(source.replace(anchor, 'className="call-bar"')), e => e instanceof assert.AssertionError && e.message.includes('подключённый телефон получает'));
});
async function balanceMode(raw = source) {
  for (const [mobile, phone, tip, shown] of [[true, true, 'hold', false], [false, false, 'button', true], [false, false, 'none', false]] as const) {
    await fixture('VoiceChannelView', { mobile, phone, tip, economy: true }, async ({ host }) => {
      const chip = host.querySelector('.voice-tip-balance');
      assert.equal(chip !== null, shown, 'пилюля баланса только в Alt режиме ПК, не поверх телефона');
      if (shown) assert.equal(chip!.textContent?.replace(/\s+/g, ' ').trim(), 'Тип · 123 перья');
    }, raw);
  }
}
it('R200 удержание на телефоне не накрывает сцену балансом, ПК с Alt показывает Тип и сумму', () => {
  // Класс ошибки: постоянно доступное удержание телефона ошибочно считалось отдельным режимом Alt.
  return balanceMode();
});
it('R200 условие не none вместо button обнаруживается лишним балансом в мобильной сцене', async () => {
  await balanceMode(); const anchor = "activeTipMode === 'button' && economy"; assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(() => balanceMode(source.replace(anchor, "activeTipMode !== 'none' && economy")), e => e instanceof assert.AssertionError && e.message.includes('пилюля баланса только'));
});

// Сохранённая раскладка должна менять порядок настоящих плиток, не только аргумент чистого правила.
async function orderedScene(raw = source) {
  await fixture('VoiceChannelView', { cols: 3, streams: true, savedOrder: ['p:peer', 's:peer'] }, async ({ host, calls }) => {
    assert.deepEqual([...host.querySelectorAll('.stage-grid > [data-stage-key]')].map(el => el.getAttribute('data-stage-key')), ['p:peer', 's:peer']);
    assert.deepEqual(calls.orderReads.at(-1), { channelId: 'channel', cols: 3 });
    assert.equal(calls.drags.at(-1)?.enabled, true);
    assert.deepEqual(Array.from(calls.drags.at(-1)!.order), ['p:peer', 's:peer']);
    await React.act(async () => { host.querySelector('.stage-grid')!.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })); });
    assert.equal(calls.pointerDown, 1, 'событие сетки подключено к возвращённому обработчику');
  }, raw);
}
it('R169 ПК применяет порядок канала и текущих колонок и подключает жест к сетке', () => orderedScene());

it('R169 превью переставляет существующую камеру без перемонтирования видео', async () => {
  // Пересоздание видео при перестановке обрывает подписку и даёт чёрный кадр.
  const options: Options = { cols: 2, streams: true, cameras: true };
  await fixture('VoiceChannelView', options, async ({ host, render }) => {
    const video = host.querySelector('.stage-cam'); assert.ok(!!video);
    options.dragPreview = ['p:peer', 's:peer']; await render();
    assert.deepEqual([...host.querySelectorAll('.stage-grid > [data-stage-key]')].map(el => el.getAttribute('data-stage-key')), ['p:peer', 's:peer']);
    assert.equal(host.querySelector('.stage-cam') === video, true);
    options.dragPreview = undefined; await render();
    assert.equal(host.querySelector('.stage-cam') === video, true);
  });
});

it('R169 телефон, просмотр, чаевые и неизмеренная сетка выключают именно жест сетки под окно', async () => {
  // Удержание под тип и телефонные жесты не должны конкурировать с перестановкой.
  for (const options of [{ phone: true }, { mobile: true }, { watched: true, streams: true },
    { tip: 'button' as const }, { tip: 'hold' as const }, { cols: 0 }, { channelId: null }]) {
    await fixture('VoiceChannelView', { cols: 2, ...options }, async ({ calls }) => {
      assert.equal(calls.drags.at(-1)?.enabled, false, JSON.stringify(options));
    });
  }
  await fixture('VoiceChannelView', {}, async ({ calls }) => assert.equal(calls.drags.at(-1)?.enabled, false));
});

it('R169 вне ПК-сетки сохранённая раскладка не меняет полосы людей и показов', () => fixture('VoiceChannelView', {
  phone: true, streams: true, savedOrder: ['p:peer', 's:peer'], dragPreview: ['p:peer', 's:peer'],
}, async ({ host }) => {
  // Локальный порядок ПК не должен менять телефонную раскладку через общий JSX.
  assert.equal(!!host.querySelector('.stage-grid'), false);
  assert.equal(host.querySelectorAll('.stage-streams .stream-card').length, 1);
  assert.equal(host.querySelectorAll('.stage-people .stage-tile').length, 1);
}));

async function commitScene(raw = source) {
  for (const cols of [2, 4]) await fixture('VoiceChannelView', { cols, streams: true }, async ({ calls }) => {
    const commit = calls.drags.at(-1)!.onCommit;
    commit(['s:peer', 'p:peer']); assert.equal(calls.orderWrites.length, 0, 'неизменённый порядок без сохранённого не записывается');
    commit(['p:peer', 's:peer']);
    assert.deepEqual(calls.orderWrites, [{ channelId: 'channel', cols, order: ['p:peer', 's:peer'] }]);
  }, raw);
  await fixture('VoiceChannelView', { cols: 2, streams: true, savedOrder: ['p:peer', 's:peer'] }, async ({ calls }) => {
    calls.drags.at(-1)!.onCommit(['s:peer', 'p:peer']);
    assert.equal(calls.orderWrites.length, 1, 'возврат к исходному обновляет ранее сохранённую раскладку');
  }, raw);
}
it('R169 завершение пишет канал и колонки, но не заводит пустую настройку без перестановки', () => commitScene());

it('R169 спутник показа получает ключ владельца, отличный от плитки человека', () => fixture('VoiceChannelView', {
  cols: 2, streams: true, companionScreen: true,
}, async ({ host }) => {
  // Ключи p/s не должны столкнуться у человека с его собственным показом.
  assert.deepEqual([...host.querySelectorAll('.stage-grid > [data-stage-key]')].map(el => el.getAttribute('data-stage-key')), ['s:peer', 'p:peer']);
}));
it('R169 второй показ владельца после браузерного сохраняется под отдельным ключом спутника', () => fixture('VoiceChannelView', {
  cols: 2, streams: true, bothStreams: true,
}, async ({ host }) => {
  // Одновременные браузерный и нативный показ не должны схлопнуться в одну карточку.
  assert.deepEqual([...host.querySelectorAll('.stage-grid > [data-stage-key]')].map(el => el.getAttribute('data-stage-key')), ['s:peer', 's:peer#screen', 'p:peer']);
  assert.equal(host.querySelectorAll('.stage-grid .stream-card').length, 2);
}));

it('R169 мутант игнорирования сохранённого порядка обнаруживается настоящим DOM', async () => {
  const anchor = 'byStageKey(shownOrder, defaultKeys, [...streamCards, ...tiles])';
  assert.equal(source.split(anchor).length - 1, 1); await orderedScene();
  await assert.rejects(() => orderedScene(source.replace(anchor, 'byStageKey(defaultKeys, defaultKeys, [...streamCards, ...tiles])')), assert.AssertionError);
});
it('R169 мутант ключа хранения без текущих колонок обнаруживается на двух раскладках', async () => {
  const anchor = 'saveStageOrder(channelId, gridCols, order)';
  assert.equal(source.split(anchor).length - 1, 1); await commitScene();
  await assert.rejects(() => commitScene(source.replace(anchor, 'saveStageOrder(channelId, 1, order)')), assert.AssertionError);
});

const watchOptions = (): Options => ({ cols: 3, noCameraPeople: 3,
  stageStreams: ['peer', 'peer#screen', 'guest-0', 'guest-1'], watchedIds: ['peer', 'peer#screen'] });
const modeSelectors = ['.stage-watch-grid', '.stage-streams', '.stage-people'] as const;
const modeDefaults = [['s:peer', 's:peer#screen'], ['s:guest-0', 's:guest-1'], ['p:peer', 'p:guest-0', 'p:guest-1']];
const savedModes: NonNullable<Options['savedModes']> = {
  'watch-streams': ['s:peer#screen', 's:peer'], 'watch-cards': ['s:guest-1', 's:guest-0'],
  'watch-people': ['p:guest-1', 'p:peer', 'p:guest-0'],
};
const tileKeys = (host: HTMLElement, selector: string) => [...host.querySelectorAll(`${selector} > [data-stage-key]`)]
  .map(el => el.getAttribute('data-stage-key'));

async function watchWiring(raw = source) {
  await fixture('VoiceChannelView', { ...watchOptions(), savedModes, savedOrder: ['p:peer'] }, async ({ host, calls }) => {
    const drags = calls.drags.slice(-4);
    assert.equal(drags.length, 4, 'R246 три режима и сетка создают четыре жеста');
    assert.deepEqual(calls.orderReads.slice(-4).map(x => x.cols), [...stageOrderRules.STAGE_ORDER_MODES, 0], 'R246 сетка читает настройку последней');
    assert.deepEqual(drags.map(x => x.enabled), [true, true, true, false], 'R246 в просмотре активны три режима, не сетка');
    assert.equal(new Set(drags.map(x => x.gridRef)).size, 4, 'R246 у каждого жеста свой ref');
    for (let i = 0; i < 3; i++) {
      const mode = stageOrderRules.STAGE_ORDER_MODES[i];
      const container = host.querySelector(modeSelectors[i]);
      assert.equal(drags[i].gridRef.current === container, true, `R246 ref ${mode} подключён к своему контейнеру`);
      assert.deepEqual(Array.from(drags[i].order), savedModes[mode], `R246 свой сохранённый порядок ${mode}`);
      assert.deepEqual(tileKeys(host, modeSelectors[i]), savedModes[mode], `R246 настоящий DOM ${mode}`);
      assert.equal(container?.classList.contains('stage-dnd'), true, `R246 CSS жеста ${mode}`);
      await React.act(async () => container!.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })));
      drags[i].onCommit([...modeDefaults[i]].reverse());
    }
    assert.deepEqual(calls.pointerInstances, [0, 1, 2], 'R246 контейнеры вызывают собственный обработчик, сетка не участвует');
    assert.deepEqual(calls.orderWrites, stageOrderRules.STAGE_ORDER_MODES.map((cols, i) => ({
      channelId: 'channel', cols, order: [...modeDefaults[i]].reverse(),
    })), 'R246 завершение пишет собственный mode, не колонки и не соседний режим');
  }, raw);
}
it('R246 ПК в просмотре подключает три независимых жеста, порядка и записи; жест сетки остаётся последним', () => watchWiring());

async function watchGuards(raw = source) {
  // Класс ошибки: один общий enabled позволяет тянуть одиночный показ или забирает телефонное удержание под тип.
  const cases: [Partial<Options>, boolean[]][] = [
    [{}, [true, true, true, false]],
    [{ watchedIds: ['peer'] }, [false, true, true, false]],
    [{ stageStreams: ['peer', 'peer#screen', 'guest-0'] }, [true, false, true, false]],
    [{ noCameraPeople: 1 }, [true, true, false, false]],
    [{ phone: true }, [false, false, false, false]], [{ mobile: true }, [false, false, false, false]],
    [{ tip: 'button' }, [false, false, false, false]], [{ tip: 'hold' }, [false, false, false, false]],
    [{ channelId: null }, [false, false, false, false]],
    [{ watchedIds: [] }, [false, false, false, true]],
  ];
  for (const [extra, enabled] of cases) await fixture('VoiceChannelView', { ...watchOptions(), ...extra }, async ({ host, calls }) => {
    assert.deepEqual(calls.drags.slice(-4).map(x => x.enabled), enabled, `R246 enabled ${JSON.stringify(extra)}`);
    const watchingDesktop = !extra.phone && !extra.mobile && extra.watchedIds?.length !== 0;
    for (const selector of modeSelectors) {
      const el = host.querySelector(selector);
      if (el) assert.equal(el.classList.contains('stage-dnd'), watchingDesktop, `R246 .stage-dnd ${selector} ${JSON.stringify(extra)}`);
    }
  }, raw);
}
it('R246 число плиток каждого режима, телефон, узкое окно, Alt и канал независимо ограничивают жесты просмотра', () => watchGuards());

it('R246 Alt выключает жесты без скачка сохранённого порядка; телефон и узкое окно используют исходный порядок', async () => {
  // Класс ошибки: запрет жеста ошибочно принимается за сброс раскладки; либо ПК-порядок протекает в телефон.
  const options = { ...watchOptions(), savedModes };
  await fixture('VoiceChannelView', options, async ({ host, render, calls }) => {
    const before = modeSelectors.map(selector => tileKeys(host, selector));
    options.tip = 'button'; await render();
    assert.deepEqual(modeSelectors.map(selector => tileKeys(host, selector)), before);
    assert.deepEqual(calls.drags.slice(-4).map(x => x.enabled), [false, false, false, false]);
    assert.deepEqual(calls.orderWrites, [], 'переключение Alt не записывает раскладку');
    options.tip = 'none'; await render();
    assert.deepEqual(modeSelectors.map(selector => tileKeys(host, selector)), before);
    assert.deepEqual(calls.drags.slice(-4).map(x => x.enabled), [true, true, true, false]);
  });
  for (const extra of [{ mobile: true }, { phone: true }]) await fixture('VoiceChannelView', { ...watchOptions(), savedModes, ...extra }, async ({ host }) => {
    assert.deepEqual(modeSelectors.map(selector => tileKeys(host, selector)), modeDefaults);
  });
});

it('R246 превью каждого режима переставляет только свои плитки, не пересоздавая видео соседних показов', () => {
  // Класс ошибки: общее превью портит соседний контейнер либо remount видео сбрасывает просмотр.
  const options = watchOptions();
  return fixture('VoiceChannelView', options, async ({ host, render }) => {
    const videos = [...host.querySelectorAll('.stage-watch-grid .screen-video')];
    for (let i = 0; i < 3; i++) {
      options.modePreviews = { [stageOrderRules.STAGE_ORDER_MODES[i]]: [...modeDefaults[i]].reverse() };
      await render();
      for (let j = 0; j < 3; j++) assert.deepEqual(tileKeys(host, modeSelectors[j]), j === i ? [...modeDefaults[j]].reverse() : modeDefaults[j]);
      const current = [...host.querySelectorAll('.stage-watch-grid .screen-video')];
      assert.equal(current.length, videos.length);
      assert.equal(current.every(video => videos.includes(video)), true, 'узлы открытого видео не перемонтируются');
    }
  });
});

it('R246 режим без сохранения не пишет исходный порядок, но перестановка и возврат сохранённого пишутся в свой mode', async () => {
  // Класс ошибки: пустое удержание создаёт мусорную настройку или возврат к исходному не сохраняется.
  for (const saved of [undefined, savedModes]) await fixture('VoiceChannelView', { ...watchOptions(), savedModes: saved }, async ({ calls }) => {
    const drags = calls.drags.slice(-4);
    for (let i = 0; i < 3; i++) drags[i].onCommit([...modeDefaults[i]]);
    assert.equal(calls.orderWrites.length, saved ? 3 : 0);
    calls.orderWrites.length = 0;
    for (let i = 0; i < 3; i++) drags[i].onCommit([...modeDefaults[i]].reverse());
    assert.deepEqual(calls.orderWrites, stageOrderRules.STAGE_ORDER_MODES.map((cols, i) => ({ channelId: 'channel', cols, order: [...modeDefaults[i]].reverse() })));
  });
});

async function fullscreenKey(raw = source) {
  await fixture('ScreenViewer', { mobile: true, stageKey: 's:peer#screen' }, async ({ host, click }) => {
    assert.equal(host.querySelector('.screen-viewer')?.getAttribute('data-stage-key'), 's:peer#screen');
    await click('[title="На весь экран"]');
    assert.equal(!!host.querySelector('.screen-viewer.pseudo-fs'), true);
    assert.equal(host.querySelector('.screen-viewer')?.hasAttribute('data-stage-key'), false, 'R246 полноэкранный показ не является плиткой перетаскивания');
    await click('[title="На весь экран"]');
    assert.equal(host.querySelector('.screen-viewer')?.getAttribute('data-stage-key'), 's:peer#screen');
  }, raw);
}
it('R246 ScreenViewer снимает stage-key на весь экран и возвращает после сворачивания', () => fullscreenKey());

it('R246 перепутанный обработчик контейнера или ключ записи режима обнаруживается настоящей сценой', async () => {
  // Класс ошибки: видимые плитки верны, но жест/сохранение ошибочно принадлежат соседнему контейнеру.
  await watchWiring();
  for (const [anchor, replacement, message] of [
    ['onPointerDown={cardsDnd.drag.onPointerDown}', 'onPointerDown={watchDnd.drag.onPointerDown}', 'R246 контейнеры вызывают собственный обработчик'],
    ['saveStageOrder(channelId, mode, order)', 'saveStageOrder(channelId, 3, order)', 'R246 завершение пишет собственный mode'],
  ]) {
    assert.equal(source.split(anchor).length - 1, 1);
    await assert.rejects(() => watchWiring(source.replace(anchor, replacement)), e => e instanceof assert.AssertionError && e.message.includes(message));
  }
});

it('R246 игнорирование Alt, узкого окна, числа показов или сохранённого порядка убивает соответствующий сценарий', async () => {
  // Класс ошибки: правильно подключённый жест активируется не там либо DOM игнорирует настройку своего режима.
  await watchGuards(); await watchWiring();
  for (const [anchor, replacement] of [
    ["const tipFree = activeTipMode === 'none';", 'const tipFree = true;'],
    ['const watchDragOn = watching && !mobile && !phoneLayout;', 'const watchDragOn = watching && !mobile;'],
    ['tipFree && watchedScreens.length > 1', 'tipFree'],
  ]) {
    assert.equal(source.split(anchor).length - 1, 1);
    await assert.rejects(() => watchGuards(source.replace(anchor, replacement)), e => e instanceof assert.AssertionError && e.message.includes('R246 enabled'));
  }
  const anchor = 'byStageKey(watchDnd.shown, watchKeys, watchedScreens.map';
  assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(() => watchWiring(source.replace(anchor, 'byStageKey(watchKeys, watchKeys, watchedScreens.map')),
    e => e instanceof assert.AssertionError && e.message.includes('R246 настоящий DOM watch-streams'));
});

it('R246 контрфакт stage-key в полноэкранном показе обнаруживается после реального раскрытия', async () => {
  await fullscreenKey();
  const anchor = 'data-stage-key={pseudo ? undefined : stageKey}';
  assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(() => fullscreenKey(source.replace(anchor, 'data-stage-key={stageKey}')),
    e => e instanceof assert.AssertionError && e.message.includes('R246 полноэкранный показ'));
});

const openStreamIds = (host: HTMLElement) => [...host.querySelectorAll('.stage-watch-grid .screen-video')]
  .map(el => el.getAttribute('data-track-id'));

it('R248 переход из просмотра в Сетку закрывает открытые показы и возвращает равные карточки', () => {
  // Класс ошибки: смена вида сохраняет намерение слушать крупный показ и не возвращает сетку.
  return fixture('VoiceChannelView', { cols: 2, streams: true, watched: true }, async ({ host, calls, setLayout, watched }) => {
    assert.deepEqual(openStreamIds(host), ['peer']);
    await setLayout('grid');
    assert.equal(calls.clearWatched, 1); assert.deepEqual(watched(), []);
    assert.equal(host.querySelectorAll('.stage-grid .stream-card').length, 1);
    assert.deepEqual(openStreamIds(host), []);
    assert.equal(calls.speaker.at(-1)?.enabled, false);
  });
});

async function gridToFocus(raw = source) {
  await fixture('VoiceChannelView', { layout: 'grid', cols: 2, stageStreams: ['peer', 'guest-0'] }, async ({ host, calls, click, watched }) => {
    assert.equal(host.querySelectorAll('.stage-grid .stream-card').length, 2);
    await click('.stage-grid [data-stage-key="s:guest-0"]');
    assert.deepEqual(calls.events, ['layout:focus', 'watch:guest-0'], 'R248 grid-focus: выбор Фокуса предшествует намерению смотреть');
    assert.deepEqual(watched(), ['guest-0']); assert.deepEqual(openStreamIds(host), ['guest-0']);
    assert.equal(!!host.querySelector('.stage-grid'), false);
    assert.equal(host.querySelectorAll('.stage-streams .stream-card').length, 1);
    assert.deepEqual(calls.watch, ['guest-0'], 'R248 grid-focus: первый показ не открывается автоматически поверх ручного выбора');
    assert.equal(host.querySelector('.pseudo-fs'), null, 'обычный клик не означает полный экран');
  }, raw);
}
it('R248 клик по показу в Сетке сначала выбирает Фокус, потом смотрит выбранный показ без fullscreen', () => gridToFocus());

async function autoOpenOther(raw = source) {
  for (const layout of ['focus', 'side'] as const) await fixture('VoiceChannelView', {
    layout, selfId: 'self', stageStreams: ['self', 'self#screen', 'peer', 'guest-0'], stageAudio: ['peer'],
  }, async ({ host, calls, watched }) => {
    assert.deepEqual(calls.watch, ['peer'], `R248 auto-other: ${layout} открывает первый чужой, не свой и не спутник`);
    assert.deepEqual(watched(), ['peer']); assert.deepEqual(openStreamIds(host), ['peer']);
    assert.equal(host.querySelectorAll('.stage-watch-grid .screen-audio').length, 1, 'автооткрытый показ получает управление своим звуком');
    assert.equal(host.querySelectorAll('.stage-streams .stream-card').length, 3);
  }, raw);
  for (const layout of ['focus', 'side'] as const) await fixture('VoiceChannelView', {
    layout, selfId: 'self', stageStreams: ['self', 'self#screen'],
  }, async ({ host, calls, watched }) => {
    assert.deepEqual(calls.watch, [], `R248 auto-other: ${layout} не подписывается, если показы только свои`);
    assert.deepEqual(watched(), []); assert.deepEqual(openStreamIds(host), []);
  }, raw);
}
it('R248 Фокус и Сбоку сами открывают первый чужой показ со звуком, но не свой и не собственного спутника', () => autoOpenOther());

it('R248 закрытый автоматический показ и его прежние соседи не открываются снова, новый показ открывается', async () => {
  // Класс ошибки: unwatch немедленно отменяется автоэффектом либо seen навсегда блокирует новые презентации.
  for (const layout of ['focus', 'side'] as const) {
    const options: Options = { layout, stageStreams: ['peer', 'guest-0'] };
    await fixture('VoiceChannelView', options, async ({ host, calls, click, render, watched }) => {
      assert.deepEqual(openStreamIds(host), ['peer']);
      await click('.stage-watch-grid [title="Закрыть стрим"]'); await render();
      assert.deepEqual(calls.unwatch, ['peer']); assert.deepEqual(watched(), []);
      assert.deepEqual(calls.watch, ['peer']); assert.deepEqual(openStreamIds(host), []);
      options.stageStreams = ['peer', 'guest-0', 'guest-1']; await render();
      assert.deepEqual(calls.watch, ['peer', 'guest-1']); assert.deepEqual(watched(), ['guest-1']);
      assert.deepEqual(openStreamIds(host), ['guest-1']);
    });
  }
});

async function oneBigReplacement(raw = source) {
  for (const layout of ['focus', 'side', 'speaker'] as const) await fixture('VoiceChannelView', {
    layout, cameras: true, noCameraPeople: 2, stageStreams: ['peer', 'guest-0'], watchedIds: ['peer'], speakerId: 'peer',
  }, async ({ host, calls, click, watched }) => {
    await click('.stage-streams [data-stage-key="s:guest-0"]');
    assert.deepEqual(watched(), ['guest-0'], `R248 one-big: ${layout} заменяет прежний показ, а не добавляет второй`);
    assert.deepEqual(openStreamIds(host), ['guest-0']); assert.equal(!!host.querySelector('.stage-big-person'), false);
    assert.deepEqual(calls.events, ['unwatch:peer', 'watch:guest-0']);
    await click('.stage-people [data-stage-key="p:peer"] [title="Развернуть камеру"]');
    assert.deepEqual(watched(), [], `R248 one-big: ${layout} камера закрывает показ`);
    assert.equal(host.querySelectorAll('.stage-watch-grid .screen-viewer').length, 1);
    assert.equal(!!host.querySelector('.stage-watch-grid [data-icon="camera"]'), true);
    await click('.stage-streams [data-stage-key="s:guest-0"]');
    assert.deepEqual(watched(), ['guest-0']); assert.deepEqual(openStreamIds(host), ['guest-0']);
    assert.equal(host.querySelectorAll('.stage-watch-grid .screen-viewer').length, 1, `R248 one-big: ${layout} показ заменяет камеру`);
    assert.equal(!!host.querySelector('.stage-watch-grid [data-icon="camera"]'), false);
  }, raw);
}
it('R248 Фокус, Сбоку и Говорящий при открытии заменяют прежний показ или камеру, не плодят крупные вьюверы', () => oneBigReplacement());

it('R248 Говорящий крупно показывает текущего человека без дубля, а ручной показ получает приоритет', () => {
  // Класс ошибки: активный говорящий дублируется в ростере или выталкивает вручную выбранную презентацию.
  const options: Options = { layout: 'speaker', noCameraPeople: 3, includeSelf: true, speakerId: 'peer', stageStreams: ['peer'] };
  return fixture('VoiceChannelView', options, async ({ host, calls, render, click }) => {
    assert.equal(host.querySelector('.stage-big-person .stage-name')?.textContent?.trim(), peer.name);
    assert.deepEqual(tileKeys(host, '.stage-people'), ['p:self', 'p:guest-0', 'p:guest-1']);
    assert.deepEqual(calls.speaker.at(-1), { ids: ['peer', 'guest-0', 'guest-1'], enabled: true });
    options.speakerId = 'guest-0'; await render();
    assert.equal(host.querySelector('.stage-big-person .stage-name')?.textContent?.trim(), 'Гость 0');
    assert.deepEqual(tileKeys(host, '.stage-people'), ['p:peer', 'p:self', 'p:guest-1']);
    assert.deepEqual(calls.watch, [], 'Говорящий не открывает показы по голосу');
    await click('.stage-streams [data-stage-key="s:peer"]');
    assert.equal(host.querySelector('.stage-big-person'), null); assert.deepEqual(openStreamIds(host), ['peer']);
    assert.equal(tileKeys(host, '.stage-people').includes('p:guest-0'), true);
    options.speakerId = 'guest-1'; await render();
    assert.deepEqual(openStreamIds(host), ['peer']); assert.equal(host.querySelector('.stage-big-person'), null);
  });
});

it('R248 хук говорящего получает только других людей и включается только в режимах один крупно', async () => {
  // Класс ошибки: self/спутник попадает в кандидаты либо отслеживание крупного включено в обычной сетке.
  for (const layout of stageLayoutRules.STAGE_LAYOUTS) await fixture('VoiceChannelView', {
    layout, includeSelf: true, selfId: 'self', noCameraPeople: 2,
  }, async ({ calls }) => {
    assert.deepEqual(calls.speaker.at(-1), { ids: ['peer', 'guest-0'], enabled: ['focus', 'side', 'speaker'].includes(layout) });
  });
});

it('R248 вход в Говорящий закрывает автоматический показ, но оставляет ручной; закрытие возвращает говорящего', async () => {
  // Класс ошибки: источник просмотра забывается, поэтому смена режима либо глушит ручной показ, либо удерживает автоматический.
  for (const manual of [false, true]) await fixture('VoiceChannelView', {
    layout: manual ? 'auto' : 'focus', stageStreams: ['peer'], watchedIds: manual ? ['peer'] : [], speakerId: 'peer',
  }, async ({ host, calls, setLayout, watched, click }) => {
    assert.deepEqual(openStreamIds(host), ['peer']);
    await setLayout('speaker');
    assert.deepEqual(watched(), manual ? ['peer'] : []);
    assert.deepEqual(calls.unwatch, manual ? [] : ['peer']);
    assert.equal(!!host.querySelector('.stage-big-person'), !manual);
    if (manual) {
      await click('.stage-watch-grid [title="Закрыть стрим"]');
      assert.equal(!!host.querySelector('.stage-big-person'), true); assert.deepEqual(openStreamIds(host), []);
    }
  });
});

async function sideOrders(raw = source) {
  const options: Options = { layout: 'side', noCameraPeople: 3, stageStreams: ['peer', 'guest-0', 'guest-1'], watchedIds: ['peer'],
    savedModes: { 'side-cards': ['s:guest-1', 's:guest-0'], 'side-people': ['p:guest-0', 'p:guest-1', 'p:peer'],
      'watch-cards': ['s:guest-0', 's:guest-1'], 'watch-people': ['p:peer', 'p:guest-0', 'p:guest-1'] } };
  await fixture('VoiceChannelView', options, async ({ host, calls }) => {
    assert.equal(!!host.querySelector('.voice-stage.watching.side > .stage-main .screen-viewer'), true);
    assert.equal(host.querySelectorAll('.voice-stage.side > .stage-side > .stage-streams').length, 1);
    assert.equal(host.querySelectorAll('.voice-stage.side > .stage-side > .stage-people').length, 1);
    assert.deepEqual(calls.orderReads.slice(-4).map(x => x.cols), ['watch-streams', 'side-cards', 'side-people', 0], 'R248 side-order: отдельные ключи боковой раскладки');
    assert.deepEqual(tileKeys(host, '.stage-side .stage-streams'), options.savedModes!['side-cards']);
    assert.deepEqual(tileKeys(host, '.stage-side .stage-people'), options.savedModes!['side-people']);
    const drags = calls.drags.slice(-4);
    assert.deepEqual(drags.map(x => x.enabled), [false, true, true, false]);
    assert.equal(drags[1].gridRef.current, host.querySelector('.stage-side .stage-streams'));
    assert.equal(drags[2].gridRef.current, host.querySelector('.stage-side .stage-people'));
    drags[1].onCommit(['s:guest-0', 's:guest-1']); drags[2].onCommit(['p:peer', 'p:guest-1', 'p:guest-0']);
    assert.deepEqual(calls.orderWrites, [
      { channelId: 'channel', cols: 'side-cards', order: ['s:guest-0', 's:guest-1'] },
      { channelId: 'channel', cols: 'side-people', order: ['p:peer', 'p:guest-1', 'p:guest-0'] },
    ]);
  }, raw);
}
it('R248 Сбоку отделяет крупное и правую колонку, читает и пишет side-cards и side-people вместо watch', () => sideOrders());

it('R248 телефон и узкое окно с сохранённым Сбоку работают как Авто, выбор не перезаписывается', async () => {
  // Класс ошибки: desktop-колонка включается на телефоне или fallback портит настройку устройства.
  for (const extra of [{ phone: true }, { mobile: true }]) for (const watched of [false, true]) {
    const options: Options = { layout: 'side', streams: true, watched, ...extra };
    await fixture('VoiceChannelView', options, async ({ host, calls }) => {
      assert.equal(!!host.querySelector('.voice-stage.side, .stage-main, .stage-side'), false);
      assert.deepEqual(openStreamIds(host), watched ? ['peer'] : []);
      assert.deepEqual(calls.watch, [], 'fallback Авто сам не открывает показ');
      assert.deepEqual(calls.layouts, []); assert.equal(options.layout, 'side');
      assert.equal(calls.orderReads.some(x => x.cols === 'side-cards' || x.cols === 'side-people'), false);
    });
  }
});

async function layoutMutant(anchor: string, replacement: string, check: (raw?: string) => Promise<void>, prefix: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'R248 якорь мутанта уникален');
  await check();
  await assert.rejects(() => check(source.replace(anchor, replacement)), e => e instanceof assert.AssertionError && e.message.startsWith(prefix));
}
it('R248 контрфакт отсутствия замены крупного обнаруживается при открытии второго показа', () =>
  layoutMutant('for (const w of watchedIds) if (w !== id) unwatch(w);', '// старый показ не закрыт', oneBigReplacement, 'R248 one-big:'));
it('R248 контрфакт клика в Сетке без перехода в Фокус обнаруживается порядком намерений', () => {
  const anchor = "setStageLayout('focus');\n    } else if (oneBig) {\n      for (const w of watchedIds) if (w !== id) unwatch(w);";
  return layoutMutant(anchor, anchor.replace("setStageLayout('focus');", '// Фокус не выбран'), gridToFocus, 'R248 grid-focus:');
});
it('R248 контрфакт автооткрытия своего показа обнаруживается при наличии чужих и только своих', () =>
  layoutMutant('screenIds.filter((id) => ownerOf(id) !== selfId)', 'screenIds', autoOpenOther, 'R248 auto-other:'));
it('R248 контрфакты ключей watch вместо side обнаруживаются отдельными чтениями и порядком DOM', async () => {
  for (const mode of ['cards', 'people']) await layoutMutant(`side ? 'side-${mode}' : 'watch-${mode}'`, `'watch-${mode}'`, sideOrders, 'R248 side-order:');
});

it('R163 ПК без просмотра объединяет показ, камеру и людей одной сеткой, спутник не дублируется', () => fixture('VoiceChannelView', { streams: true, cameras: true }, async ({ host }) => {
  assert.equal(host.querySelectorAll('.stage-grid').length, 1);
  assert.equal(!!host.querySelector('.stage-people, .stage-streams, .stage-watch-grid'), false);
  assert.equal(host.querySelectorAll('.stage-grid .stream-card').length, 1); assert.equal(host.querySelectorAll('.stage-grid .stage-tile').length, 1);
  assert.equal(!!host.querySelector('.stage-grid .stage-cam'), true);
}));
it('R163 открытый показ возвращает просмотр и полосу людей вместо сетки под окно', () => fixture('VoiceChannelView', { streams: true, watched: true }, async ({ host }) => {
  assert.equal(!!host.querySelector('.stage-grid'), false); assert.equal(!!host.querySelector('.stage-watch-grid .screen-viewer'), true);
  assert.equal(host.querySelectorAll('.stage-people .stage-tile').length, 1);
}));
it('R163 телефонная ширина браузера не получает ПК-сетку и кнопку скрытия', () => fixture('VoiceChannelView', { phone: true }, async ({ host }) => {
  assert.equal(!!host.querySelector('.stage-grid, .voice-header-tool'), false); assert.equal(!!host.querySelector('.stage-people'), true);
}));
it('R167 телефонная сцена учитывает общий выбор скрытия, но не скрывает карточку показа', async () => {
  // Пункт меню полезен и на телефоне: фильтр людей работает до выбора ПК/телефонной раскладки.
  for (const hide of [false, true]) await fixture('VoiceChannelView', { phone: true, hide, streams: true }, async ({ host }) => {
    assert.equal(!!host.querySelector('.stage-grid, .voice-header-tool'), false);
    assert.equal(host.querySelectorAll('.stage-people .stage-tile').length, hide ? 0 : 1);
    assert.equal(host.querySelectorAll('.stage-streams .stream-card').length, 1);
  });
});
it('R163 переключатель прячет людей без камеры и Показать возвращает их из пустого состояния', () => fixture('VoiceChannelView', {}, async ({ host, click, calls }) => {
  assert.equal(host.querySelector('.voice-header-tool')?.getAttribute('aria-pressed'), 'false');
  await click('.voice-header-tool'); assert.equal(host.querySelector('.voice-header-tool')?.getAttribute('aria-pressed'), 'true');
  assert.equal(host.querySelectorAll('.stage-tile').length, 0); assert.equal(host.querySelector('.stage-empty-hint')?.textContent?.includes('Участников без видео: 1'), true);
  await click('.stage-empty-hint button'); assert.equal(host.querySelectorAll('.stage-tile').length, 1);
  assert.equal(!!host.querySelector('.stage-empty-hint'), false); assert.deepEqual(calls.prefs, [true, false]);
}));
it('R163 скрытие без камеры оставляет камеру и отдельную карточку показа', () => fixture('VoiceChannelView', { hide: true, streams: true, cameras: true }, async ({ host }) => {
  assert.equal(host.querySelectorAll('.stage-tile.has-cam').length, 1); assert.equal(host.querySelectorAll('.stream-card').length, 1);
  assert.equal(!!host.querySelector('.stage-empty-hint'), false);
}));
it('R163 участник с показом без камеры скрывается, но его показ остаётся', () => fixture('VoiceChannelView', { hide: true, streams: true }, async ({ host }) => {
  assert.equal(host.querySelectorAll('.stage-tile').length, 0); assert.equal(host.querySelectorAll('.stream-card').length, 1);
  assert.equal(!!host.querySelector('.stage-empty-hint'), false);
}));

async function twoOpenScreens(raw = source) {
  await fixture('VoiceChannelView', { hide: true, streams: true, bothStreams: true, watched: true, noCameraPeople: 3 }, async ({ host, click, calls }) => {
    assert.equal(host.querySelectorAll('.stage-watch-grid .screen-viewer').length, 2, 'R230 открыты два показа');
    assert.equal(host.querySelectorAll('.stage-tile').length, 0, 'R230 три участника без камеры скрыты');
    const hint = host.querySelector('.stage-empty-hint')?.textContent ?? '';
    assert.equal(hint.startsWith('Видео ни у кого нет'), false, 'R230 сцена: открытые показы не объявлены отсутствующим видео');
    assert.equal(hint, 'Скрыто участников без видео: 3. Показать', 'R230 скрытые люди: точное количество');
    await click('.stage-empty-hint button');
    assert.equal(host.querySelectorAll('.stage-tile').length, 3, 'R230 Показать возвращает всех троих');
    assert.equal(host.querySelectorAll('.stage-watch-grid .screen-viewer').length, 2, 'R230 Показать не закрывает показы');
    assert.equal(!!host.querySelector('.stage-empty-hint'), false); assert.deepEqual(calls.prefs, [false]);
  }, raw);
}
it('R230 два открытых показа оставляют честную подсказку о трёх скрытых людях, Показать возвращает плитки', () => {
  // Класс ошибки: отсутствие аватарок ошибочно объявляет отсутствие уже открытого видео.
  return twoOpenScreens();
});
it('R230 сцена без открытого видео сохраняет прежнюю подсказку и возврат трёх людей', () => {
  // Класс ошибки: исправление текста для показов маскирует действительно пустую сцену.
  return fixture('VoiceChannelView', { hide: true, noCameraPeople: 3 }, async ({ host, click }) => {
    assert.equal(host.querySelector('.stage-empty-hint')?.textContent, 'Видео ни у кого нет. Участников без видео: 3. Показать');
    await click('.stage-empty-hint button'); assert.equal(host.querySelectorAll('.stage-tile').length, 3);
  });
});
it('R230 контрфакт потери признака открытого видео ловится подсказкой настоящей сцены', async () => {
  // Класс ошибки: прежний текст возвращается только при просмотре, хотя обычная пустая сетка по-прежнему верна.
  await twoOpenScreens();
  const anchor = "{videoShown ? 'Скрыто участников без видео'";
  assert.equal(source.split(anchor).length - 1, 1, 'R230 единственный выбор текста пустой сцены');
  await assert.rejects(() => twoOpenScreens(source.replace(anchor, "{false ? 'Скрыто участников без видео'")), (e: unknown) =>
    e instanceof assert.AssertionError && e.message.startsWith('R230 сцена:') && e.operator === 'strictEqual'
      && e.actual === true && e.expected === false);
});
it('R163 неподключённый канал не вызывает новые хуки сцены', () => fixture('VoiceChannelView', { connected: false }, async ({ host, calls }) => {
  assert.equal(calls.newHooks, 0); assert.equal(calls.autoShow.length, 0);
  assert.equal(!!host.querySelector('.voice-idle-body'), true); assert.equal(!!host.querySelector('.voice-header-tool'), false);
}));

async function sceneAutoShow(raw = source) {
  for (const [options, hasVideo] of [
    [{ cameras: true }, true], [{ streams: true, companionScreen: true }, true],
    [{ cameras: true, mutedCamera: true }, false], [{}, false],
  ] as const) await fixture('VoiceChannelView', { ...options, hide: true }, async ({ calls }) => {
    assert.ok(calls.autoShow.length > 0, 'сцена подключила хук автовозврата');
    assert.deepEqual(calls.autoShow[calls.autoShow.length - 1], { hasVideo, hideNoVideo: true, channelId: 'channel' });
  }, raw);
}
it('R167 сцена передаёт автовозврату камеры и показы спутника, не только видимые плитки', () => sceneAutoShow());
it('R167 мутант потери камер при подключении правила в сцене обнаруживается', async () => {
  const anchor = 'hasVideo: stageHasVideo(screens, cameras)';
  assert.equal(source.split(anchor).length - 1, 1, 'единственное подключение правила к сцене');
  await sceneAutoShow();
  await assert.rejects(() => sceneAutoShow(source.replace(anchor, 'hasVideo: stageHasVideo(screens, [])')), assert.AssertionError);
});

async function volumePop(raw = source) {
  await fixture('ScreenViewer', {}, async ({ host, click }) => {
    assert.equal(!!host.querySelector('.stream-vol'), false); await click('.screen-audio > button');
    assert.equal(!!host.querySelector('.stream-vol-pop[role="dialog"] .stream-vol'), true);
    assert.equal(host.querySelector('.screen-audio > button')?.getAttribute('aria-expanded'), 'true');
    assert.equal(!!host.querySelector('.screen-viewer.ctl-on'), true);
    await React.act(async () => { host.querySelector('.stream-vol-pop')!.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); });
    assert.equal(!!host.querySelector('.stream-vol-pop'), true);
    await React.act(async () => { document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); });
    assert.equal(!!host.querySelector('.stream-vol-pop, .screen-viewer.ctl-on'), false);
    await click('.screen-audio > button');
    await React.act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' })); });
    assert.equal(!!host.querySelector('.stream-vol-pop'), true);
    await React.act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })); });
    assert.equal(!!host.querySelector('.stream-vol-pop, .screen-viewer.ctl-on'), false);
    await click('.screen-audio > button'); await click('.screen-audio > button'); assert.equal(!!host.querySelector('.stream-vol-pop'), false);
  }, raw);
}
it('R163 окно громкости открывается значком, держит ряд, не закрывается внутри и закрывается мимо/Esc/значком', () => volumePop());
it('R163 громкость заглушённого показывает ноль и переключатель окна вызывает намерение включить звук', () => fixture('ScreenViewer', { muted: true }, async ({ host, click, calls }) => {
  await click('.screen-audio > button'); const input = host.querySelector<HTMLInputElement>('.stream-vol')!;
  assert.equal(input.value, '0'); assert.equal(input.max, '2'); assert.equal(input.style.getPropertyValue('--p'), '0');
  assert.equal(host.querySelector('.ctx-vol2-pct')?.textContent, 'выкл');
  await click('.ctx-vol2-spk'); assert.equal(calls.toggles, 1);
}));
it('R163 ползунок заглушённого включает звук и передаёт громкость, незаглушённого только меняет громкость', async () => {
  for (const muted of [false, true]) await fixture('ScreenViewer', { muted }, async ({ host, click, calls }) => {
    await click('.screen-audio > button'); const input = host.querySelector<HTMLInputElement>('.stream-vol')!;
    if (!muted) { assert.equal(input.value, '1.4'); assert.equal(input.style.getPropertyValue('--p'), '0.7'); }
    // Граница обработчика React: не утверждаем, что happy-dom воспроизводит нативный drag range.
    const propKey = Object.keys(input).find(k => k.startsWith('__reactProps$')); assert.ok(!!propKey);
    const props = (input as unknown as Record<string, { onChange(e: { target: { value: string } }): void }>)[propKey!];
    await React.act(async () => props.onChange({ target: { value: '1.8' } }));
    assert.deepEqual(calls.volumes, [1.8]); assert.equal(calls.toggles, muted ? 1 : 0);
  });
});

async function sliderIcons(raw = source) {
  await fixture('ScreenViewer', { volume: 0.5 }, async ({ host, click, calls, render }) => {
    await click('.screen-audio > button');
    const assertIcon = (silent: boolean, pct: string) => {
      const button = host.querySelector('.screen-audio > button');
      assert.equal(button?.classList.contains('off'), silent, 'ряд показывает отсутствие звука даже без заглушения');
      assert.equal(button?.querySelector('[data-icon]')?.getAttribute('data-icon'), silent ? 'volume-off' : 'volume');
      assert.equal(host.querySelector('.ctx-vol2-spk [data-icon]')?.getAttribute('data-icon'), silent ? 'volume-off' : 'volume');
      assert.equal(host.querySelector('.ctx-vol2-pct')?.textContent, pct);
    };
    assertIcon(false, '50%');
    for (const value of ['0', '0.5']) {
      const input = host.querySelector<HTMLInputElement>('.stream-vol')!;
      const propKey = Object.keys(input).find(k => k.startsWith('__reactProps$'));
      assert.ok(!!propKey, 'проверяется обработчик смонтированного ползунка React, не native drag happy-dom');
      const props = (input as unknown as Record<string, { onChange(e: { target: { value: string } }): void }>)[propKey!];
      await React.act(async () => { props.onChange({ target: { value } }); });
      await render(); // владелец контролируемого ползунка передаёт новый volume обратно в viewer.
      assertIcon(value === '0', value === '0' ? '0%' : '50%');
    }
    assert.deepEqual(calls.volumes, [0, 0.5]);
    assert.equal(calls.toggles, 0, 'нулевая громкость не требует менять отдельный mute-флаг');
  }, raw);
}
it('R168 ползунок стрима в ноль перечёркивает значки ряда и окна, 50 процентов возвращают обычный значок', () => sliderIcons());
it('R168 заглушённый стрим сохраняет headphones-off в ряду и volume-off в окне при любой громкости', async () => {
  for (const volume of [0, 0.5]) await fixture('ScreenViewer', { muted: true, volume }, async ({ host, click }) => {
    const button = host.querySelector('.screen-audio > button');
    assert.equal(button?.classList.contains('off'), true);
    assert.equal(button?.querySelector('[data-icon]')?.getAttribute('data-icon'), 'headphones-off');
    await click('.screen-audio > button');
    assert.equal(host.querySelector('.ctx-vol2-spk [data-icon]')?.getAttribute('data-icon'), 'volume-off');
    assert.equal(host.querySelector('.ctx-vol2-pct')?.textContent, 'выкл');
  });
});
it('R168 значок стрима соответствует отображаемому проценту по обе стороны округления в ноль', async () => {
  for (const [volume, silent] of [[0.0049, true], [0.0051, false]] as const) await fixture('ScreenViewer', { volume }, async ({ host, click }) => {
    assert.equal(host.querySelector('.screen-audio > button')?.classList.contains('off'), silent);
    await click('.screen-audio > button');
    assert.equal(host.querySelector('.ctx-vol2-pct')?.textContent, silent ? '0%' : '1%');
    assert.equal(host.querySelector('.ctx-vol2-spk [data-icon]')?.getAttribute('data-icon'), silent ? 'volume-off' : 'volume');
  });
});
it('R168 мутант значка только по audioMuted не скрывается за правильным ползунком', async () => {
  const anchor = 'const silent = audioMuted || volPct === 0;';
  assert.equal(source.split(anchor).length - 1, 1, 'единственный расчёт тишины стрима');
  await sliderIcons();
  await assert.rejects(() => sliderIcons(source.replace(anchor, 'const silent = audioMuted;')), assert.AssertionError);
});
for (const component of ['ScreenViewer', 'CameraViewer'] as const) {
  it(`R163 ${component}: касание кадра переключает ряд, касание кнопок ряда не переключает`, () => fixture(component, { touch: true }, async ({ host, click }) => {
    assert.equal(!!host.querySelector('.screen-viewer.ctl-on'), false);
    await click('.screen-video'); assert.equal(!!host.querySelector('.screen-viewer.ctl-on'), true);
    await click('.screen-controls .screen-title'); assert.equal(!!host.querySelector('.screen-viewer.ctl-on'), true);
    await click('.screen-video'); assert.equal(!!host.querySelector('.screen-viewer.ctl-on'), false);
  }));
  it(`R163 ${component}: мышиный клик кадра не включает касательный ряд`, () => fixture(component, {}, async ({ host, click }) => {
    await click('.screen-video'); assert.equal(!!host.querySelector('.screen-viewer.ctl-on'), false);
  }));
}
it('R163 мутант без удержания ряда открытым окном громкости обнаруживается', async () => {
  const anchor = 'useControlsReveal(volPop.open || !!qualityMenu)'; assert.equal(source.split(anchor).length - 1, 1);
  await volumePop(); await assert.rejects(() => volumePop(source.replace(anchor, 'useControlsReveal(false)')), assert.AssertionError);
});
it('R163 мутант скрытия карточки показа вместо только участников обнаруживается', async () => {
  const check = (raw: string) => fixture('VoiceChannelView', { hide: true, streams: true }, async ({ host }) => {
    assert.equal(host.querySelectorAll('.stream-card').length, 1); assert.equal(host.querySelectorAll('.stage-tile').length, 0);
  }, raw);
  const anchor = 'const streamCards = unwatchedScreens.map((s, i) => (\n    <StreamCard\n      key={s.publication?.trackSid}\n      stageKey={streamKeys[i]}';
  assert.equal(source.split(anchor).length - 1, 1, 'единственный конструктор карточек показа с ключами сцены');
  await check(source);
  const changed = source.replace(anchor, anchor.replace('unwatchedScreens.map', '(hideNoVideo ? [] : unwatchedScreens).map'));
  await assert.rejects(() => check(changed), assert.AssertionError);
});
it('R163 мутант игнорирования телефонной ширины обнаруживается в браузере', async () => {
  const check = (raw: string) => fixture('VoiceChannelView', { phone: true }, async ({ host }) => {
    assert.equal(!!host.querySelector('.stage-grid'), false); assert.equal(!!host.querySelector('.stage-people'), true);
  }, raw);
  const anchor = 'const fit = !watching && !mobile && !phoneLayout;'; assert.equal(source.split(anchor).length - 1, 1);
  await check(source); await assert.rejects(() => check(source.replace(anchor, 'const fit = !watching && !mobile;')), assert.AssertionError);
});
