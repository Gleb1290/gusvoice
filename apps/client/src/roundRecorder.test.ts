import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Track {
  readyState = 'live';
  stops = 0;
  constructor(readonly kind: string, readonly id: string, readonly facingMode?: string, readonly label = '') {}
  getSettings() { return { deviceId: this.id, facingMode: this.facingMode }; }
  stop() { this.stops++; this.readyState = 'ended'; }
}
class Stream {
  constructor(readonly tracks: Track[] = []) {}
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
}
function fixture(options: { fail?: string; initial?: Track; mime?: string } = {}) {
  let time = 1000, serial = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const intervals = new Map<number, () => void>();
  const initial = options.initial ?? new Track('video', 'front', 'user');
  const mic = new Track('audio', 'mic'), canvasTrack = new Track('video', 'canvas');
  const requests: MediaStreamConstraints[] = [];
  const atRequest: string[] = [];
  const replies: Array<Stream | Error | ReturnType<typeof deferred<Stream>>> = [];
  const devices: Array<{ kind: string; deviceId: string; label: string }> = [];
  let enumerate: (() => Promise<typeof devices>) | undefined;
  const draws: unknown[][] = [];
  const video = { srcObject: null as Stream | null, muted: false, playsInline: false,
    readyState: 4, videoWidth: 640, videoHeight: 480,
    play: async () => { if (options.fail === 'play') throw new Error('play failed'); } };
  class Context {
    static all: Context[] = [];
    closed = 0;
    constructor() { if (options.fail === 'audio') throw new Error('audio failed'); Context.all.push(this); }
    createAnalyser() { return { fftSize: 512, getFloatTimeDomainData: (a: Float32Array) => a.fill(0.25) }; }
    createMediaStreamSource(stream: Stream) { assert.deepEqual(stream.getTracks(), [mic]); return { connect() {} }; }
    async close() { this.closed++; }
  }
  class Recorder {
    static all: Recorder[] = [];
    static isTypeSupported(type: string) { return type === (options.mime ?? 'video/webm;codecs=vp8,opus'); }
    state = 'inactive';
    mimeType: string;
    pauses = 0; starts = 0;
    ondataavailable?: (e: { data: Blob }) => void;
    onstop?: (e: Event) => void;
    listeners = new Map<string, Array<{ fn: () => void; once?: boolean }>>();
    constructor(readonly stream: Stream, readonly config: MediaRecorderOptions) {
      if (options.fail === 'recorder') throw new Error('recorder failed');
      this.mimeType = config.mimeType ?? ''; Recorder.all.push(this);
    }
    addEventListener(type: string, fn: () => void, opts?: { once?: boolean }) {
      const list = this.listeners.get(type) ?? []; list.push({ fn, once: opts?.once }); this.listeners.set(type, list);
    }
    emit(type: string) {
      const list = this.listeners.get(type) ?? [];
      this.listeners.set(type, list.filter((l) => !l.once));
      for (const l of list) l.fn();
    }
    start() { if (options.fail === 'start') throw new Error('start failed'); this.state = 'recording'; this.starts++; }
    pause() { this.state = 'paused'; this.pauses++; }
    resume() { this.state = 'recording'; }
    requestData() { queueMicrotask(() => this.data('partial')); }
    data(value: string) { this.ondataavailable?.({ data: new Blob([value]) }); this.emit('dataavailable'); }
    stop() {
      assert.notEqual(this.state, 'inactive'); this.state = 'inactive';
      queueMicrotask(() => { this.data('final'); this.emit('stop'); this.onstop?.(new Event('stop')); });
    }
  }
  const canvas = { width: 0, height: 0,
    getContext: () => options.fail === 'context' ? null : { drawImage: (...args: unknown[]) => draws.push(args) },
    captureStream: () => { if (options.fail === 'capture') throw new Error('capture failed'); return new Stream([canvasTrack]); } };
  const source = readFileSync(new URL('./roundRecorder.ts', import.meta.url), 'utf8');
  // Только загрузка целого модуля в изолированные браузерные заглушки; текст исходника не проверяем и не изменяем.
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  runInNewContext(code, {
    module, exports: module.exports, Blob, File, Event, Float32Array, queueMicrotask,
    Date: { now: () => time }, MediaStream: Stream, MediaRecorder: Recorder, AudioContext: Context,
    navigator: { mediaDevices: {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        requests.push(constraints); atRequest.push(initial.readyState);
        if (requests.length === 1) return new Stream([initial, mic]);
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        if (!reply) throw new Error('Нет подготовленного ответа камеры');
        return 'promise' in reply ? reply.promise : reply;
      },
      enumerateDevices: async () => enumerate ? enumerate() : devices,
    } },
    document: { createElement: (tag: string) => tag === 'video' ? video : canvas },
    window: { setInterval: (fn: () => void) => { intervals.set(++serial, fn); return serial; } },
    clearInterval: (id: number) => intervals.delete(id),
    setTimeout: (fn: () => void, ms: number) => { timers.set(++serial, { at: time + ms, fn }); return serial; },
    clearTimeout: (id: number) => timers.delete(id),
    require: (id: string) => { assert.equal(id, '@gusvoice/shared'); return shared; },
  });
  return {
    api: module.exports as typeof import('./roundRecorder'), requests, atRequest, replies, devices, initial, mic, canvasTrack,
    video, draws, recorders: Recorder.all, contexts: Context.all, timers, intervals,
    setEnumerate: (fn: () => Promise<typeof devices>) => { enumerate = fn; },
    draw: () => { for (const fn of intervals.values()) fn(); },
    advance: async (ms: number) => {
      time += ms;
      for (const [id, t] of [...timers]) if (t.at <= time) { timers.delete(id); t.fn(); }
      await Promise.resolve();
    },
  };
}

it('камера освобождается до запроса, параллельный flip один, звук и encoder непрерывны', async () => {
  const f = fixture(); const r = await f.api.startRoundRecording();
  const pending = deferred<Stream>(); f.replies.push(pending);
  const first = r.flip(); const second = r.flip();
  assert.equal(f.initial.readyState, 'ended', 'Android допускает только одну открытую камеру');
  assert.equal(f.requests.length, 2); assert.equal(first, second);
  assert.equal(f.atRequest[1], 'ended', 'старая камера закрыта именно до вызова getUserMedia');
  const before = f.draws.length; f.draw(); assert.equal(f.draws.length, before, 'последний кадр сохранён');
  assert.equal(f.mic.stops, 0); assert.equal(f.canvasTrack.stops, 0);
  const back = new Track('video', 'back', 'environment'); pending.resolve(new Stream([back]));
  await first; assert.equal(r.front(), false); f.draw(); assert.equal(f.draws.length, before + 1);
  assert.equal(f.recorders.length, 1); assert.equal(f.recorders[0].starts, 1); assert.equal(f.recorders[0].pauses, 0);
  assert.deepEqual(Array.from(f.recorders[0].stream.getTracks()), [f.canvasTrack, f.mic]);
  assert.equal(r.preview.getVideoTracks()[0], f.canvasTrack);
  assert.equal(f.requests[1].audio, false);
  const front = new Track('video', 'front', 'user'); f.replies.push(new Stream([front])); await r.flip();
  assert.equal(r.front(), true); assert.equal(back.stops, 1);
  await r.stop(); assert.equal(front.stops, 1); assert.equal(f.mic.stops, 1); assert.equal(f.canvasTrack.stops, 1);
});

it('фактическая задняя камера определяет front и направление первого переключения', async () => {
  for (const initial of [new Track('video', 'back', 'environment'), new Track('video', 'back')]) {
    const f = fixture({ initial });
    f.devices.push({ kind: 'videoinput', deviceId: 'back', label: 'Back camera' });
    const r = await f.api.startRoundRecording();
    assert.equal(r.front(), false);
    f.replies.push(new Stream([new Track('video', 'front', 'user')]));
    await r.flip(); assert.equal(r.front(), true);
    assert.deepEqual(JSON.parse(JSON.stringify((f.requests[1].video as MediaTrackConstraints).facingMode)), { exact: 'user' });
    r.cancel();
  }
});

it('игнорирование facingMode исправляется точным deviceId, лишние дорожки закрываются', async () => {
  const f = fixture(); const r = await f.api.startRoundRecording();
  f.devices.push({ kind: 'videoinput', deviceId: 'front', label: 'Front camera' }, { kind: 'videoinput', deviceId: 'back', label: 'Back camera' });
  const wrong = new Track('video', 'front', 'user');
  const back = new Track('video', 'back'), extra = new Track('audio', 'unwanted');
  f.replies.push(new Stream([wrong]), new Stream([back, extra]));
  await r.flip(); assert.equal(r.front(), false); assert.equal(wrong.stops, 1); assert.equal(extra.stops, 1);
  assert.equal(((f.requests[2].video as MediaTrackConstraints).deviceId as ConstrainDOMStringParameters).exact, 'back');
  r.cancel(); assert.equal(back.stops, 1);
});

it('ошибка смены восстанавливает старую камеру и отклоняет flip, следующая попытка работает', async () => {
  const f = fixture(); const r = await f.api.startRoundRecording();
  const recovered = new Track('video', 'front', 'user');
  f.replies.push(new Error('busy'), new Stream([recovered]));
  await assert.rejects(r.flip(), /busy/);
  assert.equal(r.front(), true); assert.equal(f.video.srcObject?.getVideoTracks()[0], recovered);
  assert.equal(f.mic.stops, 0); assert.equal(f.recorders[0].state, 'recording');
  f.replies.push(new Stream([new Track('video', 'back', 'environment')]));
  await r.flip(); assert.equal(r.front(), false); assert.equal(recovered.stops, 1); r.cancel();
});

it('двойной отказ и неверный поток не прячут ошибку и не оставляют чужих дорожек', async () => {
  const f = fixture(); const r = await f.api.startRoundRecording();
  const extra = new Track('audio', 'unexpected');
  f.replies.push(new Stream([extra]), new Error('recovery failed'));
  await assert.rejects(r.flip(), /восстановить/); assert.equal(extra.stops, 1);
  assert.equal(f.video.srcObject, null); assert.equal(f.mic.stops, 0);
  r.cancel(); assert.equal(f.mic.stops, 1); assert.equal(f.canvasTrack.stops, 1);
});

it('cancel и stop закрывают поздний поток и не запускают восстановление', async () => {
  for (const mode of ['cancel', 'stop'] as const) {
    const f = fixture(); const r = await f.api.startRoundRecording();
    const pending = deferred<Stream>(); f.replies.push(pending);
    const flip = r.flip();
    if (mode === 'cancel') r.cancel(); else await r.stop();
    const late = new Track('video', 'back', 'environment'), audio = new Track('audio', 'late');
    pending.resolve(new Stream([late, audio])); await flip;
    assert.equal(late.stops, 1); assert.equal(audio.stops, 1); assert.equal(f.video.srcObject, null);
    await r.flip(); assert.equal(f.requests.length, 2); assert.equal(f.mic.stops, 1);
    assert.equal(f.intervals.size, 0); assert.equal(f.timers.size, 0);
  }
});

it('отмена при определении устройства или восстановлении не оживляет камеру', async () => {
  for (const phase of ['devices', 'recovery']) {
    const f = fixture(); const r = await f.api.startRoundRecording();
    const pending = deferred<Stream>(), enumerated = deferred<typeof f.devices>();
    const late = new Track('video', phase === 'devices' ? 'back' : 'front');
    if (phase === 'devices') {
      f.setEnumerate(() => enumerated.promise); f.replies.push(new Stream([late]));
    } else f.replies.push(new Error('busy'), pending);
    const flip = r.flip();
    // Ограниченный слив microtasks доводит попытку до выбранного отложенного API.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    if (phase === 'recovery') assert.equal(f.requests.length, 3);
    r.cancel();
    if (phase === 'devices') enumerated.resolve([]); else pending.resolve(new Stream([late]));
    await flip; assert.equal(late.stops, 1); assert.equal(f.video.srcObject, null); assert.equal(f.mic.stops, 1);
  }
});

it('ошибки инициализации освобождают камеру, микрофон, canvas, таймеры и AudioContext', async () => {
  for (const fail of ['play', 'context', 'capture', 'recorder', 'audio', 'start']) {
    const f = fixture({ fail });
    await assert.rejects(f.api.startRoundRecording(), /./, fail);
    assert.equal(f.initial.stops, 1, fail); assert.equal(f.mic.stops, 1, fail);
    assert.equal(f.intervals.size, 0, fail); assert.equal(f.timers.size, 0, fail);
    if (['recorder', 'audio', 'start'].includes(fail)) assert.equal(f.canvasTrack.stops, 1, fail);
    for (const ctx of f.contexts) assert.equal(ctx.closed, 1, fail);
  }
});

it('пауза запрещает flip, сохраняет файл, лимит 60 секунд считает только активное время', async () => {
  const f = fixture(); const r = await f.api.startRoundRecording();
  await f.advance(2000); const paused = await r.pause();
  assert.equal(paused.durationMs, 2000); assert.ok(paused.file.size); assert.equal(r.level(), 0);
  await r.flip(); assert.equal(f.requests.length, 1);
  await f.advance(90_000); assert.equal(r.elapsed(), 2000);
  r.resume(); assert.equal(r.level(), 0.25);
  await f.advance(shared.ROUND_MAX_MS - 2001); assert.equal(f.mic.stops, 0);
  await f.advance(1); assert.equal(f.mic.stops, 1); assert.equal(f.contexts[0].closed, 1);
  const take = await r.stop();
  assert.equal(take.durationMs, 60_000); assert.equal(take.round?.side, shared.ROUND_SIDE);
  assert.equal(take.file.type, 'video/webm'); assert.match(take.file.name, /^round-1000\.webm$/);
  assert.equal(await take.file.text(), 'partialfinal'); assert.deepEqual(Array.from(take.waveform), []);
});

it('stop фиксирует длину и сохраняет совместимый MP4, завершённый recorder больше не открывает камеру', async () => {
  const f = fixture({ mime: 'video/mp4' }); const r = await f.api.startRoundRecording();
  await f.advance(1234); const take = await r.stop(); await f.advance(5000);
  assert.equal(take.durationMs, 1234); assert.equal(r.elapsed(), 1234);
  assert.equal(take.file.type, 'video/mp4'); assert.match(take.file.name, /\.mp4$/); assert.ok(take.file.size);
  await r.flip(); r.resume(); assert.equal(f.requests.length, 1); assert.equal(f.mic.stops, 1);
});
