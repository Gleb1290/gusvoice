import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';

function fixture(change?: (source: string) => string, options: { reject8k?: boolean; supportedMime?: boolean } = {}) {
  let time = 1000; let stopped = 0;
  const timers = new Map<number, { at: number; fn: () => void }>(); let next = 0;
  const contexts: FakeContext[] = [];
  const contextOptions: Array<AudioContextOptions | undefined> = [];
  const recorderOptions: Array<MediaRecorderOptions | undefined> = [];
  class FakeContext {
    closed = 0;
    constructor(config?: AudioContextOptions) {
      contextOptions.push(config);
      if (options.reject8k && config?.sampleRate === 8000) throw new Error('частота не поддерживается');
      contexts.push(this);
    }
    createAnalyser() { return { fftSize: 512, getFloatTimeDomainData: (buf: Float32Array) => buf.fill(0.25) }; }
    createMediaStreamSource() { return { connect: () => {} }; }
    async decodeAudioData() { return { getChannelData: () => new Float32Array([0, 0.25, -0.5]) }; }
    async close() { this.closed++; }
  }
  class FakeRecorder {
    static isTypeSupported() { return options.supportedMime !== false; }
    constructor(_stream: unknown, config?: MediaRecorderOptions) { recorderOptions.push(config); }
    state = 'inactive'; mimeType = 'audio/webm;codecs=opus';
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: (event: Event) => void;
    listeners: (() => void)[] = [];
    dataListeners: (() => void)[] = [];
    start() { this.state = 'recording'; }
    addEventListener(type: string, fn: () => void) {
      if (type === 'dataavailable') this.dataListeners.push(fn);
      else { assert.equal(type, 'stop'); this.listeners.push(fn); }
    }
    pause() { assert.equal(this.state, 'recording'); this.state = 'paused'; }
    resume() { assert.equal(this.state, 'paused'); this.state = 'recording'; }
    requestData() {
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['partial voice']) });
        for (const fn of this.dataListeners.splice(0)) fn();
      });
    }
    stop() {
      assert.notEqual(this.state, 'inactive', 'рекордер не останавливают повторно'); this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['voice bytes']) });
        for (const fn of this.listeners) fn(); this.onstop?.(new Event('stop'));
      });
    }
  }
  const raw = readFileSync(new URL('./voiceRecorder.ts', import.meta.url), 'utf8');
  const source = change ? change(raw) : raw;
  if (change) assert.notEqual(source, raw, 'контрфакт меняет существующую ветку');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, Blob, File, Event, Float32Array,
    Date: { now: () => time }, MediaRecorder: FakeRecorder, AudioContext: FakeContext,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) } },
    setTimeout: (fn: () => void, ms: number) => { timers.set(++next, { at: time + ms, fn }); return next; },
    clearTimeout: (id: number) => timers.delete(id),
    require: (id: string) => { assert.equal(id, '@gusvoice/shared'); return shared; },
  });
  return { api: module.exports as typeof import('./voiceRecorder'), contexts, contextOptions, recorderOptions, tracksStopped: () => stopped,
    advance: async (ms: number) => {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
      await Promise.resolve();
    }, timers };
}

it('паузы не тратят длину и потолок, после resume таймер ставится на оставшееся время', async () => {
  // Ловит автоматический stop во время прослушивания и потерю остатка лимита после продолжения.
  const check = async (change?: (source: string) => string) => {
    const f = fixture(change); const r = await f.api.startVoiceRecording();
    await f.advance(1500); const preview = await r.pause();
    assert.equal(preview.durationMs, 1500); assert.ok(preview.file.size > 0);
    assert.equal(f.timers.size, 0); assert.equal(r.level(), 0);
    await f.advance(shared.VOICE_MAX_MS + 5000);
    assert.equal(r.elapsed(), 1500); assert.equal(f.tracksStopped(), 0);
    r.resume(); assert.equal(f.timers.size, 1);
    await f.advance(shared.VOICE_MAX_MS - 1501); assert.equal(f.tracksStopped(), 0);
    await f.advance(1); assert.equal(f.tracksStopped(), 1);
    assert.equal((await r.stop()).durationMs, shared.VOICE_MAX_MS);
  };
  await check();
  await assert.rejects(() => check(s => s.replace('VOICE_MAX_MS - elapsed()', 'VOICE_MAX_MS')), assert.AssertionError);
  await assert.rejects(() => check(s => s.replace('        clearTimeout(limit);', '')), assert.AssertionError);
});

it('потолок записи сам отпускает микрофон и анализатор до нажатия stop или cancel', async () => {
  // Иначе после 30 минут индикатор микрофона и занятое устройство остаются до действия человека.
  const check = async (change?: (source: string) => string) => {
    const f = fixture(change); assert.equal(f.api.voiceRecordingSupported(), true);
    const record = await f.api.startVoiceRecording(); assert.equal(record.level(), 0.25);
    await f.advance(shared.VOICE_MAX_MS - 1); assert.equal(f.tracksStopped(), 0, 'за миллисекунду до потолка микрофон ещё пишет');
    await f.advance(1); assert.equal(f.tracksStopped(), 1, 'потолок сразу освобождает дорожку');
    assert.equal(f.contexts[0].closed, 1); assert.equal(record.level(), 0);
    await f.advance(60_000); const take = await record.stop();
    assert.equal(take.durationMs, shared.VOICE_MAX_MS); assert.ok(take.file.size > 0, 'накопленное остаётся доступно после автоматического stop');
    assert.equal(f.tracksStopped(), 1); assert.equal(f.contexts[0].closed, 1);
  };
  await check();
  await assert.rejects(() => check(source => source.replace("  rec.addEventListener('stop', cleanup);", '')), assert.AssertionError);
});

it('R125 голосовое ограничивает битрейт до 32 кбит/с с выбранным MIME и без поддержки MIME', async () => {
  // Без явного битрейта длинная запись зависит от браузера и может превысить потолок загрузки.
  const check = async (change?: (source: string) => string) => {
    for (const supportedMime of [true, false]) {
      const f = fixture(change, { supportedMime });
      const recording = await f.api.startVoiceRecording();
      assert.equal(f.recorderOptions.length, 1);
      assert.equal(f.recorderOptions[0]?.audioBitsPerSecond, 32000, 'битрейт фиксирован независимо от MIME');
      assert.equal(f.recorderOptions[0]?.mimeType, supportedMime ? 'audio/webm;codecs=opus' : undefined);
      recording.cancel(); await Promise.resolve();
    }
  };
  await check();
  await assert.rejects(() => check(s => s.replaceAll('audioBitsPerSecond: 32_000', 'audioBitsPerSecond: undefined')), assert.AssertionError);
});

it('R125 снимок паузы и окончательная волна декодируются в 8 кГц, живой анализатор сохраняет обычный контекст', async () => {
  // Волна длинного файла не должна выделять память на 48 кГц, а проба 8 кГц обязана реально декодировать данные.
  const check = async (change?: (source: string) => string) => {
    const f = fixture(change); const recording = await f.api.startVoiceRecording();
    await f.advance(1500); const preview = await recording.pause();
    recording.resume(); await f.advance(1000); const take = await recording.stop();
    assert.deepEqual(f.contextOptions.map(c => c?.sampleRate), [undefined, 8000, 8000], 'оба пути вычисления волны используют 8 кГц');
    for (const value of [preview.waveform, take.waveform]) {
      assert.deepEqual([...value], shared.peaksFrom(new Float32Array([0, 0.25, -0.5]), shared.WAVEFORM_BUCKETS));
    }
    assert.deepEqual(f.contexts.map(c => c.closed), [1, 1, 1], 'декодеры закрыты вместе с живым анализатором');
  };
  await check();
  await assert.rejects(() => check(s => s.replace('new AudioContext({ sampleRate: 8000 })', 'new AudioContext()')), assert.AssertionError);
});

it('R125 отказ конструктора 8 кГц откатывается к обычному декодеру без подмены волны заглушкой', async () => {
  // Старый движок может отвергнуть частоту: отправка сохраняет настоящую огибающую вместо ровных восьмёрок.
  const check = async (change?: (source: string) => string) => {
    const f = fixture(change, { reject8k: true }); const recording = await f.api.startVoiceRecording();
    await f.advance(1000); const take = await recording.stop();
    assert.deepEqual(f.contextOptions.map(c => c?.sampleRate), [undefined, 8000, undefined], 'после отказа создаётся контекст без параметров');
    assert.deepEqual([...take.waveform], shared.peaksFrom(new Float32Array([0, 0.25, -0.5]), shared.WAVEFORM_BUCKETS));
    assert.deepEqual(f.contexts.map(c => c.closed), [1, 1], 'неуспешный конструктор не создаёт лишний контекст');
  };
  await check();
  await assert.rejects(() => check(s => s.replace('    ctx = new AudioContext();', "    throw new Error('откат потерян');")), assert.AssertionError);
});

it('cancel после потолка не бросает и не освобождает микрофон второй раз', async () => {
  // Cleanup вызывается и по событию, и руками — двойной release не должен трогать уже освобождённые ресурсы.
  const check = async (change?: (source: string) => string) => {
    const f = fixture(change); const record = await f.api.startVoiceRecording();
    await f.advance(shared.VOICE_MAX_MS);
    assert.doesNotThrow(() => record.cancel()); await Promise.resolve();
    assert.equal(f.tracksStopped(), 1); assert.equal(f.contexts[0].closed, 1); assert.equal(record.level(), 0);
    await assert.rejects(record.stop(), /уже завершена/);
  };
  await check();
  await assert.rejects(() => check(source => source.replace('    if (released) return;', '')), assert.AssertionError);
});

it('обычные stop и cancel до потолка отпускают ресурсы и снимают таймер, stop сохраняет файл', async () => {
  // Исправление автоматической остановки не должно сломать короткие нормальные записи.
  const stop = fixture(); const record = await stop.api.startVoiceRecording(); await stop.advance(1500);
  const take = await record.stop(); await Promise.resolve();
  assert.equal(take.durationMs, 1500); assert.equal(take.file.type, 'audio/webm;codecs=opus');
  assert.equal(take.waveform.length, shared.WAVEFORM_BUCKETS);
  assert.equal(stop.tracksStopped(), 1); assert.equal(stop.contexts[0].closed, 1); assert.equal(stop.timers.size, 0);
  const cancel = fixture(); const cancelled = await cancel.api.startVoiceRecording(); await cancel.advance(500);
  cancelled.cancel(); await Promise.resolve();
  assert.equal(cancel.tracksStopped(), 1); assert.equal(cancel.contexts[0].closed, 1); assert.equal(cancel.timers.size, 0);
  assert.equal(cancelled.level(), 0);
});
