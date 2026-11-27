import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { Track } from 'livekit-client';
import { act, createElement, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer, type ViteDevServer } from 'vite';

const instanceId = 'voice-test';
const restricted = 'restricted-peer';
const neighbor = 'neighbor-peer';

function microphone(identity: string, trackSid: string) {
  return {
    source: Track.Source.Microphone,
    publication: { kind: Track.Kind.Audio, trackSid },
    participant: { identity, isLocal: false },
  };
}

const livekitModule = 'virtual:voice-room-audio-livekit';
const stubs = new Map([
  [livekitModule, `
    import { createElement } from 'react';
    let tracks = [];
    let attachments = [];
    export function setTracks(next) { tracks = next; }
    export function takeAttachments() {
      const result = attachments;
      attachments = [];
      return result;
    }
    export function useTracks() { return tracks; }
    export function AudioTrack({ trackRef, muted, volume }) {
      const sid = trackRef.publication.trackSid;
      return createElement('audio', {
        'data-track-sid': sid,
        'data-audible': String(!muted && volume !== 0),
        ref: (element) => { if (element) attachments.push(sid); },
      });
    }
  `],
  ['virtual:voice-room-audio-config', `
    export const activeInstanceId = () => ${JSON.stringify(instanceId)};
  `],
  ['virtual:voice-room-audio-store', `
    const state = { watchedStreams: ['restricted-peer'], pipStreams: [], mutedStreams: [], streamVolumes: {} };
    export const useStore = Object.assign(
      (selector = (value) => value) => selector(state),
      { getState: () => state, subscribe: () => () => {} },
    );
  `],
]);

let server: ViteDevServer | undefined;
let VoiceRoomAudio: ComponentType<{ deafened: boolean; instanceId?: string | null }>;
let preferences: typeof import('../localUserAudio');
let tracks: {
  setTracks: (refs: ReturnType<typeof microphone>[]) => void;
  takeAttachments: () => string[];
};
const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;

before(async () => {
  GlobalRegistrator.register({
    url: 'https://voice.invalid/',
    settings: { disableJavaScriptFileLoading: true, enableImageFileLoading: false },
  });
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    envFile: false,
    ssr: { noExternal: ['@livekit/components-react'] },
    optimizeDeps: { noDiscovery: true, include: [] },
    esbuild: { jsx: 'automatic' },
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    plugins: [{
      name: 'voice-room-audio-test',
      enforce: 'pre',
      resolveId(source) {
        if (source === '@livekit/components-react') return '\0' + livekitModule;
        if (source === './config' || source === '../config') return '\0virtual:voice-room-audio-config';
        if (source === '../store') return '\0virtual:voice-room-audio-store';
        if (stubs.has(source)) return '\0' + source;
      },
      load(id) {
        if (id.startsWith('\0')) return stubs.get(id.slice(1));
      },
    }],
  });
  ({ VoiceRoomAudio } = await server.ssrLoadModule('/src/components/VoiceRoomAudio.tsx'));
  preferences = await server.ssrLoadModule('/src/localUserAudio.ts') as typeof preferences;
  tracks = await server.ssrLoadModule(livekitModule) as typeof tracks;
});

after(async () => {
  try {
    await server?.close();
  } finally {
    await GlobalRegistrator.unregister();
    if (previousActEnvironment === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
    else globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

const scenarios = [
  {
    name: 'сохранённая нулевая громкость',
    restrict: () => preferences.setUserVolume(restricted, 0),
    release: () => preferences.setUserVolume(restricted, 0.6),
  },
  {
    name: 'сохранённый личный мьют при ненулевой громкости',
    restrict: () => {
      preferences.setUserVolume(restricted, 0.6);
      preferences.setUserMuted(restricted, true);
    },
    release: () => preferences.setUserMuted(restricted, false),
  },
];

for (const { name, restrict, release } of scenarios) {
  it(`${name} переживает переподключение и деафен`, async () => {
    localStorage.clear();
    preferences.reloadUserAudio();
    restrict();
    // Сбрасываем кеш: первое подключение должно прочитать сохранённую настройку.
    preferences.reloadUserAudio();

    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (deafened: boolean) => act(async () => {
      root.render(createElement(VoiceRoomAudio, { deafened, instanceId }));
    });
    const assertOutput = (expected: string[], stage: string) => {
      const output = [...host.querySelectorAll('audio')];
      assert.deepEqual(output.map((element) => element.dataset.trackSid).sort(), [...expected].sort(), stage);
      assert.ok(output.every((element) => element.dataset.audible === 'true'), stage);
      // Даже кратковременное подключение трека до эффекта могло пропустить звук.
      assert.deepEqual([...new Set(tracks.takeAttachments().filter((sid) => !expected.includes(sid)))], [], stage);
    };

    try {
      tracks.takeAttachments();
      // У того же участника открыт стрим с собственной громкостью.
      const screen = { ...microphone(restricted, 'screen'), source: Track.Source.ScreenShareAudio };
      tracks.setTracks([microphone(restricted, 'blocked-1'), screen, microphone(neighbor, 'neighbor-1')]);
      await render(false);
      assertOutput(['neighbor-1', 'screen'], 'первое подключение');

      await act(async () => { root.render(null); });
      assertOutput([], 'отключение');
      tracks.setTracks([microphone(restricted, 'blocked-2'), microphone(neighbor, 'neighbor-2')]);
      await render(false);
      assertOutput(['neighbor-2'], 'переподключение с новыми публикациями');

      await render(true);
      const deafenedOutput = [...host.querySelectorAll('audio')];
      assert.ok(deafenedOutput.every((element) =>
        element.dataset.trackSid === 'neighbor-2' && element.dataset.audible === 'false'), 'деафен');
      assert.ok(tracks.takeAttachments().every((sid) => sid === 'neighbor-2'), 'личный мьют при деафене');
      await render(false);
      assertOutput(['neighbor-2'], 'снятие деафена');

      await act(async () => { release(); });
      assertOutput(['blocked-2', 'neighbor-2'], 'снятие личного ограничения без переподключения');
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
    }
  });
}
