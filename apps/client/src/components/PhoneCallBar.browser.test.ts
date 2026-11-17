import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { testVmImports } from '../testVmImports.js';
import * as streamPipRules from '../streamPipRules.js';
import * as tipMode from '../tipMode.js';
import * as watchGrace from '../watchGrace.js';
import * as stageLayoutRules from '../stageLayoutRules.js';
import * as voiceRules from '../voiceRules.js';
import * as stageAutoShowRules from '../stageAutoShowRules.js';
import * as stageOrderRules from '../stageOrderRules.js';

// Загружаем целые модули без вырезания функций и изменения исходника.
const viewUrl = new URL('./VoiceChannelView.tsx', import.meta.url);
const layoutUrl = new URL('../phoneLayout.ts', import.meta.url);
function compile(url: URL) {
  return ts.transpileModule(readFileSync(url, 'utf8'), { fileName: url.pathname, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
}
const viewCode = compile(viewUrl);
const layoutCode = compile(layoutUrl);
type ViewProps = { channel: { id: string; name: string; type: 'voice' }; connected: boolean };

async function withView(width: number, mobile: boolean, check: (frame: {
  host: HTMLDivElement;
  calls: string[];
  render(connected: boolean): Promise<void>;
}) => Promise<void>) {
  const fetchBefore = globalThis.fetch;
  GlobalRegistrator.register({ width, height: 900 });
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const noNetwork = () => { throw new Error('Сеть запрещена в тесте панели звонка'); };
  globalThis.fetch = noNetwork;
  window.fetch = noNetwork;
  const calls: string[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const noop = () => {};
  const emptyComponent = () => null;
  const state = {
    voice: { channelId: 'voice' }, bootstrap: null, presence: {},
    selfMuted: false, selfDeafened: false,
    watchedStreams: [], mutedStreams: [], streamVolumes: {}, pipStreams: [], pendingWatch: null,
    clearWatchedStreams: noop, leaveVoice: () => { calls.push('leave'); }, joinVoice: async () => {},
  };
  const localParticipant = {
    setAttributes: async () => {},
    setCameraEnabled: async (on: boolean) => { calls.push(`camera:${on}`); },
  };
  const room = { localParticipant, on: (..._args: unknown[]) => room, off: (..._args: unknown[]) => room };
  const hotkeys = { isMobile: () => mobile, isTauri: () => mobile };
  function load(code: string, url: URL, mocks: Record<string, unknown>) {
    const module = { exports: {} as Record<string, any> };
    runInNewContext(code, {
      module, exports: module.exports, window, document, fetch: noNetwork,
      require: testVmImports(url, mocks),
    }, { timeout: 1000 });
    return module.exports;
  }
  try {
    // Настоящий usePhoneLayout читает matchMedia happy-dom, а не повторяет порог в тесте.
    const phoneLayout = load(layoutCode, layoutUrl, { react: React, './hotkeys': hotkeys });
    const loaded = load(viewCode, viewUrl, {
      react: React, 'react/jsx-runtime': jsx, '../hotkeys': hotkeys, '../phoneLayout': phoneLayout,
      '../store': { useStore: (select: (s: typeof state) => unknown) => select(state) },
      '@livekit/components-react': {
        useTracks: () => [], useParticipants: () => [], useRoomContext: () => room,
        useLocalParticipant: () => ({ localParticipant, isCameraEnabled: false }),
      },
      'livekit-client': {
        Track: { Source: { ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio', Camera: 'camera' } },
        RoomEvent: { ParticipantAttributesChanged: 'attributes', ParticipantConnected: 'connected', ParticipantDisconnected: 'disconnected' },
      },
      // PTT touch-жесты проверяются отдельно; здесь проверяем монтаж кнопки и передачу её props.
      '../usePttMicButton': { usePttMicButton: () => ({
        title: 'Выключить микрофон', 'aria-label': 'Выключить микрофон',
        onClick: () => { calls.push('mic'); },
      }) },
      '../voiceSelf': { toggleSelfDeafen: () => { calls.push('deafen'); } },
      '../cameraSettings': {
        getCameraPreset: () => 'balanced', cameraCaptureOptions: () => ({}), cameraPublishOptions: () => ({}),
      },
      '../memberName': { useNameResolver: () => (_id: string, name: string) => name },
      '../tipGesture': { useAltHeld: () => false, useTip: () => ({ tip: noop, busyId: null }) },
      '../tipMode': tipMode, '../streamPipRules': streamPipRules, '../watchGrace': watchGrace,
      '../streamCue': { STREAM_VIEW_GRACE_MS: 6000 },
      '../stageLayoutRules': stageLayoutRules, '../voiceRules': voiceRules,
      '../stageAutoShowRules': stageAutoShowRules, '../stageOrderRules': stageOrderRules,
      '../stageViewPrefs': { useHideNoVideo: () => false },
      '../stageLayoutPrefs': { useStageLayout: () => 'auto' },
      '../stageOrderPrefs': { useStageOrder: () => null },
      '../useStageSpeaker': { useStageSpeaker: () => null },
      '../useStageAutoShow': { useStageAutoShow: noop },
      '../useStageDrag': { useStageDrag: () => ({ preview: null }) },
      './UserContextMenu': { useUserMenu: () => ({ open: noop, menu: null }) },
      './Activities': { ActivitiesButton: emptyComponent, DuelCard: emptyComponent },
      './StageLayoutPicker': { StageLayoutPicker: emptyComponent },
      './Icon': { Icon: emptyComponent, ChannelGlyph: emptyComponent },
      './Goose': { Goose: emptyComponent },
    });
    const View = loaded.VoiceChannelView as React.ComponentType<ViewProps>;
    const render = async (connected: boolean) => {
      await React.act(async () => root.render(React.createElement(View, {
        channel: { id: 'voice', name: 'Голос', type: 'voice' }, connected,
      })));
    };
    await render(true);
    await check({ host, calls, render });
  } finally {
    try { await React.act(async () => root.unmount()); }
    finally {
      host.remove();
      GlobalRegistrator.unregister();
      globalThis.fetch = fetchBefore;
      delete globals.IS_REACT_ACT_ENVIRONMENT;
    }
  }
}

it('браузер показывает панель звонка при 384/760 px и скрывает при 761/1280 px', async () => {
  // Во вкладке телефона isMobile() ложно, поэтому проверяем обе стороны границы ширины.
  for (const [width, expected] of [[384, 1], [760, 1], [761, 0], [1280, 0]]) {
    await withView(width, false, async ({ host }) => {
      assert.equal(host.querySelectorAll('.voice-call-bar').length, expected, `ширина ${width}`);
    });
  }
});

it('нативный телефон сохраняет панель звонка в широкой раскладке', async () => {
  await withView(1280, true, async ({ host }) => {
    assert.equal(host.querySelectorAll('.voice-call-bar').length, 1);
  });
  await withView(1280, false, async ({ host }) => {
    assert.equal(host.querySelectorAll('.voice-call-bar').length, 0);
  });
});

it('подключённый канал монтирует работающие кнопки микрофона, звука, камеры и выхода', async () => {
  await withView(384, false, async ({ host, calls, render }) => {
    assert.ok(host.querySelector('.voice-view.connected'));
    const bar = host.querySelector('.voice-call-bar');
    assert.ok(bar, 'панель смонтирована из настоящего подключённого канала');
    for (const title of ['Выключить микрофон', 'Заглушить звук', 'Включить камеру (удерж. — качество)', 'Отключиться']) {
      const button: HTMLButtonElement | null = bar.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
      assert.ok(button, `доступна кнопка ${title}`);
      assert.equal(button.disabled, false);
      await React.act(async () => button.click());
    }
    assert.deepEqual(calls, ['mic', 'deafen', 'camera:true', 'leave']);
    await render(false);
    assert.equal(host.querySelector('.voice-call-bar'), null, 'вне канала панель управления отсутствует');
    await render(true);
    assert.equal(host.querySelectorAll('.voice-call-bar').length, 1, 'повторный вход возвращает панель');
  });
});
