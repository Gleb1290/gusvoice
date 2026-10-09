import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { it } from 'node:test';

it('mic:false не запрашивает звук, а mic:true и старый вызов без opts сохраняют аудиотрек', async () => {
  // На Android запрос микрофона прячет WebView и останавливает камеру; запрет mic должен писать видео без окна, не меняя старый путь.
  const source = readFileSync(new URL('./cameraCapture.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const requests: MediaStreamConstraints[] = [];
  const recordingTracks: MediaStreamTrack[][] = [];
  let micStops = 0;

  class FakeMediaStream {
    constructor(tracks: MediaStreamTrack[]) { recordingTracks.push(tracks); }
  }
  class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    state: RecordingState = 'inactive';
    mimeType = 'video/webm';
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(readonly stream: FakeMediaStream) {}
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }

  const dependencies: Record<string, unknown> = {
    './attachRules': {
      baseMime: (value: string) => value.split(';')[0],
      captureName: () => 'capture.webm',
      pickRecorderType: () => ({ mime: 'video/webm;codecs=vp9', type: 'video/webm' }),
      recordingFull: () => false,
    },
    './hotkeys': { isAndroid: () => true },
    './imageCompress': { compressPhoto: async (file: File) => file },
  };
  const context = vm.createContext({
    exports: {},
    require: (id: string) => dependencies[id],
    MediaRecorder: FakeMediaRecorder,
    MediaStream: FakeMediaStream,
    navigator: { mediaDevices: { getUserMedia: async (constraints: MediaStreamConstraints) => {
      requests.push(constraints);
      return { getAudioTracks: () => [{ kind: 'audio', stop: () => { micStops++; } }] };
    } } },
    window: { setTimeout, clearTimeout },
    Date,
    File,
    Blob,
    Promise,
    Error,
  });
  vm.runInContext(compiled, context, { filename: 'cameraCapture.ts' });
  const exports = context.exports as { startRecording: (track: MediaStreamTrack, onFull: () => void, opts?: { mic?: boolean }) => Promise<{ stop(): Promise<File | null> } | null> };
  const videoTrack = { kind: 'video' } as MediaStreamTrack;
  const onFull = () => assert.fail('предел записи не должен наступить в тесте');
  const silent = await exports.startRecording(videoTrack, onFull, { mic: false });

  assert.ok(silent, 'mic:false всё равно запускает видеозапись');
  assert.equal(requests.length, 0, 'mic:false не вызывает getUserMedia');
  assert.equal(recordingTracks[0]?.length, 1, 'беззвучный MediaRecorder получил один трек');
  assert.equal(recordingTracks[0]?.[0], videoTrack, 'беззвучный MediaRecorder получил только камеру');
  assert.equal(await silent!.stop(), null, 'остановка пустой записи корректно возвращает null');

  const withMic = await exports.startRecording(videoTrack, onFull, { mic: true });
  assert.ok(withMic, 'явное разрешение mic:true запускает запись');
  assert.equal(requests.length, 1, 'mic:true запрашивает аудиотрек');
  assert.equal(requests[0]?.video, false, 'запрос микрофона не открывает дополнительную камеру');
  assert.equal(recordingTracks[1]?.length, 2, 'MediaRecorder объединяет камеру и разрешённый микрофон');
  assert.equal(recordingTracks[1]?.[0], videoTrack, 'первым остаётся трек камеры');
  assert.equal(recordingTracks[1]?.[1]?.kind, 'audio', 'второй трек — аудио');
  assert.equal(await withMic!.stop(), null, 'пустой аудиовидеопоток останавливается штатно');
  assert.equal(micStops, 1, 'после записи микрофонный трек освобождён');

  const legacy = await exports.startRecording(videoTrack, onFull);
  assert.ok(legacy, 'вызов без opts сохраняет совместимость');
  assert.equal(requests.length, 2, 'старый вызов по умолчанию также запрашивает аудио');
  assert.equal(recordingTracks[2]?.length, 2, 'старый вызов записывает видео вместе с микрофоном');
  assert.equal(await legacy!.stop(), null, 'старый режим также корректно останавливается');
  assert.equal(micStops, 2, 'микрофон освобождён после обоих разрешённых аудиосценариев');
});
