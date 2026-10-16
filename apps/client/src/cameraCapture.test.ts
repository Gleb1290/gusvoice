import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { it } from 'node:test';
import { recordingFull, VIDEO_SOFT_LIMIT } from './attachRules';

function recordingHarness(source: string) {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const checks: Array<[number, number | undefined]> = [];
  let recorder: FakeMediaRecorder;
  class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    state: RecordingState = 'inactive';
    mimeType = 'video/webm';
    ondataavailable: ((event: { data: { size: number } }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor() { recorder = this; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  const dependencies: Record<string, unknown> = {
    './attachRules': {
      baseMime: (value: string) => value.split(';')[0], captureName: () => 'capture.webm',
      pickRecorderType: () => ({ mime: 'video/webm', type: 'video/webm' }),
      recordingFull: (bytes: number, limit?: number) => {
        checks.push([bytes, limit]);
        return recordingFull(bytes, limit);
      },
    },
    './hotkeys': { isAndroid: () => false },
    './imageCompress': { compressPhoto: async (file: File) => file },
  };
  const context = vm.createContext({
    exports: {}, require: (id: string) => {
      assert.ok(id in dependencies, `неожиданный импорт ${id}`);
      return dependencies[id];
    },
    MediaRecorder: FakeMediaRecorder, MediaStream: class {},
    navigator: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [] }) } },
    window: { setTimeout, clearTimeout }, Date, File, Blob, Promise, Error,
  });
  vm.runInContext(compiled, context, { filename: 'cameraCapture.ts' });
  return {
    start: (context.exports as { startRecording: (track: MediaStreamTrack, full: () => void, opts?: { mic?: boolean; softLimit?: number }) => Promise<{ bytes(): number } | null> }).startRecording,
    checks,
    // Размер порции моделируем без гигабайтной аллокации; этот сценарий не собирает итоговый File.
    chunk: (size: number) => recorder.ondataavailable?.({ data: { size } }),
  };
}

const recordingSource = () => readFileSync(new URL('./cameraCapture.ts', import.meta.url), 'utf8');

function snapshotHarness(source: string, opts: {
  constraints?: boolean;
  caps?: { imageWidth?: { max: number }; imageHeight?: { max: number } } | 'reject' | 'missing';
  photo?: 'reject-size' | 'pending';
} = {}) {
  const constraints: Array<[number | undefined, number | undefined]> = [];
  const photos: Array<{ imageWidth: number; imageHeight: number } | undefined> = [];
  const events: string[] = [];
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let timerId = 0;
  let frameCount = 0;
  const sensor = new Blob(['sensor'], { type: 'image/jpeg' });
  const frame = new Blob(['frame'], { type: 'image/jpeg' });
  const video = { videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;
  const track = {
    readyState: 'live',
    ...(opts.constraints === false ? {} : { applyConstraints: async (value: MediaTrackConstraints) => {
      constraints.push([(value.width as ConstrainULongRange).ideal, (value.height as ConstrainULongRange).ideal]);
      events.push('constraints');
    } }),
  } as MediaStreamTrack;
  class Capture {
    constructor(actual: MediaStreamTrack) { assert.equal(actual, track); }
    getPhotoCapabilities = opts.caps === 'missing' ? undefined : async () => {
      if (opts.caps === 'reject') throw new Error('caps unavailable');
      return opts.caps ?? { imageWidth: { max: 4032 }, imageHeight: { max: 3024 } };
    };
    takePhoto(size?: { imageWidth: number; imageHeight: number }): Promise<Blob> {
      photos.push(size && { ...size });
      events.push('photo');
      if (opts.photo === 'pending') return new Promise(() => {});
      if (opts.photo === 'reject-size' && size) return Promise.reject(new Error('size not supported'));
      return Promise.resolve(sensor);
    }
  }
  const dependencies: Record<string, unknown> = {
    './attachRules': { captureName: () => 'photo.jpg' },
    './hotkeys': {},
    './imageCompress': { compressPhoto: async (file: File) => { events.push('compress'); return file; } },
  };
  const context = vm.createContext({
    exports: {}, require: (id: string) => { assert.ok(id in dependencies, `неожиданный импорт ${id}`); return dependencies[id]; },
    window: {
      ImageCapture: Capture,
      setTimeout: (callback: () => void, ms: number) => { timers.set(++timerId, { callback, ms }); return timerId; },
      clearTimeout: (id: number) => { timers.delete(id); },
    },
    document: { createElement: (tag: string) => {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0, height: 0,
        getContext: (kind: string) => {
          assert.equal(kind, '2d');
          return { drawImage: (actual: HTMLVideoElement, x: number, y: number, w: number, h: number) => {
            assert.equal(actual, video);
            assert.deepEqual([x, y, w, h], [0, 0, 1280, 720]);
            frameCount++; events.push('frame');
          } };
        },
        toBlob: (callback: (blob: Blob) => void, type: string, quality: number) => {
          assert.equal(type, 'image/jpeg'); assert.equal(quality, 0.92); callback(frame);
        },
      };
      return canvas;
    } },
    console: { info: () => {} }, File, Blob, Date, Promise, Error,
  });
  // Выполняется целый настоящий модуль; largestPhoto проверяется через публичный takeSnapshot, без вырезания функций.
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(compiled, context, { filename: 'cameraCapture.ts' });
  return {
    constraints, photos, events, timers,
    frames: () => frameCount,
    start: () => (context.exports as { takeSnapshot(video: HTMLVideoElement, track: MediaStreamTrack): Promise<File> }).takeSnapshot(video, track),
    flush: async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); },
    fire: (ms: number) => {
      const entries = [...timers.entries()].filter(([, timer]) => timer.ms === ms);
      assert.equal(entries.length, 1, `ожидается один таймер ${ms} мс`);
      for (const [id, timer] of entries) { timers.delete(id); timer.callback(); }
    },
  };
}

async function verifySnapshotResolution(source: string) {
  const harness = snapshotHarness(source);
  const file = await harness.start();
  assert.deepEqual(harness.constraints[0], [1920, 1440], 'перед снимком поток поднимается до 1920×1440');
  assert.deepEqual(harness.constraints[1], [1280, 720], 'после снимка поток возвращается до 1280×720');
  assert.equal(harness.constraints.length, 2);
  assert.deepEqual(harness.events, ['constraints', 'photo', 'constraints', 'compress'], 'подъём предшествует сенсору, возврат — сжатию');
  assert.deepEqual(harness.photos, [{ imageWidth: 4032, imageHeight: 3024 }], 'сенсор получает оба максимума capabilities');
  assert.equal(harness.frames(), 0);
  assert.equal(await file.text(), 'sensor');
  assert.equal(file.type, 'image/jpeg');
  assert.equal(harness.timers.size, 0, 'успешный снимок убирает все таймеры');
}

it('снимок поднимает поток до 1920×1440, просит максимум сенсора и возвращает лёгкое превью', async () => {
  await verifySnapshotResolution(recordingSource());
});

it('отказ сенсора от явного размера повторяет снимок без размера, не подменяя его кадром', async () => {
  const harness = snapshotHarness(recordingSource(), { photo: 'reject-size' });
  assert.equal(await (await harness.start()).text(), 'sensor');
  assert.deepEqual(harness.photos, [{ imageWidth: 4032, imageHeight: 3024 }, undefined]);
  assert.equal(harness.frames(), 0);
  assert.deepEqual(harness.constraints, [[1920, 1440], [1280, 720]]);
});

it('неизвестные, недоступные и неположительные размеры сенсора оставляют рабочий снимок без опций', async () => {
  for (const caps of ['reject', 'missing', {}, { imageWidth: { max: 0 }, imageHeight: { max: 3024 } }, { imageWidth: { max: 4032 }, imageHeight: { max: -1 } }] as const) {
    const harness = snapshotHarness(recordingSource(), { caps });
    assert.equal(await (await harness.start()).text(), 'sensor');
    assert.deepEqual(harness.photos, [undefined]);
    assert.equal(harness.frames(), 0);
  }
});

it('сенсор после шести секунд ожидания уступает кадру потока без повторного takePhoto', async () => {
  const harness = snapshotHarness(recordingSource(), { photo: 'pending' });
  let settled = false;
  const snapshot = harness.start().then((file) => { settled = true; return file; });
  await harness.flush();
  assert.equal(settled, false, 'до срабатывания таймера снимок ещё ожидается');
  assert.deepEqual([...harness.timers.values()].map((timer) => timer.ms), [6000], 'ожидание сенсора именно 6 с, не прежние 1,5 с');
  harness.fire(6000);
  assert.equal(await (await snapshot).text(), 'frame');
  assert.equal(harness.photos.length, 1, 'тайм-аут не запускает второй шестисекундный запрос');
  assert.equal(harness.frames(), 1);
  assert.deepEqual(harness.constraints, [[1920, 1440], [1280, 720]]);
});

it('трек без applyConstraints всё ещё снимает сенсором и не пытается восстановить разрешение', async () => {
  const harness = snapshotHarness(recordingSource(), { constraints: false });
  assert.equal(await (await harness.start()).text(), 'sensor');
  assert.deepEqual(harness.constraints, []);
  assert.equal(harness.photos.length, 1);
  assert.equal(harness.frames(), 0);
});

for (const [name, before, after, failure] of [
  ['без подъёма потока', "if (track && live && typeof track.applyConstraints === 'function')", 'if (false)', /перед снимком поток поднимается/],
  ['без возврата превью', "if (raised && track && track.readyState === 'live')", 'if (false)', /после снимка поток возвращается/],
  ['1920 заменено на 1280', 'const SNAP_W = 1920;', 'const SNAP_W = 1280;', /перед снимком поток поднимается/],
] as const) {
  it(`проверка разрешения снимка убивает мутант «${name}»`, async () => {
    const source = recordingSource();
    assert.equal(source.split(before).length - 1, 1, 'мутант меняет ровно одно место настоящего модуля');
    await verifySnapshotResolution(source);
    await assert.rejects(verifySnapshotResolution(source.replace(before, after)), failure);
  });
}

async function verifyCustomRecordingLimit(source: string) {
  const harness = recordingHarness(source);
  const limit = 1023 * 1024 * 1024;
  let full = 0;
  const recording = await harness.start({ kind: 'video' } as MediaStreamTrack, () => { full++; }, { mic: false, softLimit: limit });
  assert.ok(recording);
  harness.chunk(0);
  assert.equal(harness.checks.length, 0, 'пустая порция не проверяет порог');
  harness.chunk(VIDEO_SOFT_LIMIT);
  assert.equal(full, 0, 'старые 24 МиБ больше не обрывают видео ЛС');
  harness.chunk(limit - VIDEO_SOFT_LIMIT - 1);
  assert.equal(full, 0, 'байт перед новым пределом ещё записывается');
  harness.chunk(1);
  assert.equal(full, 1, 'ровно предел вызывает onFull');
  harness.chunk(1);
  harness.chunk(limit);
  assert.equal(full, 1, 'последующие порции не вызывают onFull повторно');
  assert.equal(recording.bytes(), 2 * limit + 1, 'байты учитываются и после уведомления');
  assert.deepEqual(harness.checks, [[VIDEO_SOFT_LIMIT, limit], [limit - 1, limit], [limit, limit]], 'до первого уведомления recordingFull получает пользовательский предел вторым аргументом');
}

it('запись ЛС передаёт мягкий предел и уведомляет один раз ровно при его достижении', async () => {
  await verifyCustomRecordingLimit(recordingSource());
});

it('старый вызов записи без opts сохраняет прежний предел и однократное уведомление', async () => {
  const harness = recordingHarness(recordingSource());
  let full = 0;
  const recording = await harness.start({ kind: 'video' } as MediaStreamTrack, () => { full++; });
  assert.ok(recording);
  harness.chunk(VIDEO_SOFT_LIMIT - 1);
  assert.equal(full, 0);
  harness.chunk(1);
  assert.equal(full, 1);
  harness.chunk(1);
  assert.equal(full, 1);
  assert.deepEqual(harness.checks, [[VIDEO_SOFT_LIMIT - 1, undefined], [VIDEO_SOFT_LIMIT, undefined]], 'отсутствующий softLimit оставляет default правила recordingFull');
});

it('проверка записи убивает мутант без передачи softLimit в recordingFull', async () => {
  const source = recordingSource();
  const original = 'recordingFull(size, opts.softLimit)';
  assert.equal(source.split(original).length - 1, 1, 'мутант меняет ровно один вызов');
  await verifyCustomRecordingLimit(source);
  await assert.rejects(verifyCustomRecordingLimit(source.replace(original, 'recordingFull(size)')), /старые 24 МиБ/);
});

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
