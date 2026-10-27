import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as pcm from './pcm.js';

const source = readFileSync(new URL('./pcm.ts', import.meta.url), 'utf8');
function load(raw: string): typeof pcm {
  const exports = {};
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, Buffer, Uint8Array, Int16Array, require: (name: string) => { throw new Error(`PCM: запрещённый импорт ${name}`); } });
  return exports as typeof pcm;
}
function replaceOnce(needle: string, replacement: string): string {
  assert.equal(source.split(needle).length - 1, 1, 'PCM: мутант меняет ровно один якорь');
  return source.replace(needle, replacement);
}
function samples(values: number[], offset = 0): Uint8Array {
  const bytes = Buffer.alloc(values.length * 2 + offset);
  values.forEach((v, i) => bytes.writeInt16LE(v, offset + i * 2));
  return bytes.subarray(offset);
}

it('R306 PCM: кадр — 10 мс, 48 кГц, два канала s16le', () => {
  assert.equal(pcm.SAMPLE_RATE, 48_000);
  assert.equal(pcm.CHANNELS, 2);
  assert.equal(pcm.FRAME_SAMPLES, 480);
  assert.equal(pcm.BYTES_PER_SAMPLE, 2);
  assert.equal(pcm.BYTES_PER_FRAME_SAMPLE, 4);
  assert.equal(pcm.FRAME_BYTES, 1920);
});

function crossChunks(mod = pcm) {
  const slicer = new mod.FrameSlicer();
  const bytes = Buffer.from(Array.from({ length: 1 + 1919 + 1921 + 3840 }, (_, i) => i % 251));
  let offset = 0;
  const frames: Buffer[] = [];
  for (const size of [1, 1919, 1921, 3840]) {
    frames.push(...slicer.push(bytes.subarray(offset, offset + size)));
    offset += size;
    assert.equal(slicer.pending, offset % 1920, 'R306 PCM остаток не теряется между кусками');
  }
  assert.equal(frames.length, 4);
  assert.ok(frames.every(f => f.length === 1920));
  assert.deepEqual(Buffer.concat(frames), bytes.subarray(0, 7680), 'R306 PCM порядок байтов и стереоканалов сохранён');
  assert.equal(slicer.flush(), null, 'один лишний байт не становится неполным стереосэмплом');
}
it('R306 PCM: куски 1/1919/1921/3840 сохраняют все байты и остаток', () => crossChunks());

for (const size of [0, 1, 1919, 1920, 1921, 3839, 3840, 3841]) {
  it(`R306 PCM: граница куска ${size} байт выдаёт только целые кадры`, () => {
    const slicer = new pcm.FrameSlicer();
    const frames = slicer.push(Buffer.alloc(size, 7));
    assert.equal(frames.length, Math.floor(size / 1920));
    assert.equal(slicer.pending, size % 1920);
    assert.ok(frames.every(f => f.equals(Buffer.alloc(1920, 7))));
  });
}
for (const size of [0, 1, 2, 3, 4, 5, 7, 8, 1919]) {
  it(`R306 PCM: flush ${size} байт дополняет только полные стереосэмплы и очищает остаток`, () => {
    const slicer = new pcm.FrameSlicer();
    slicer.push(Buffer.alloc(size, 19));
    const frame = slicer.flush();
    if (size < 4) assert.equal(frame, null);
    else {
      assert.ok(frame);
      const whole = size - size % 4;
      assert.equal(frame.length, 1920);
      assert.deepEqual(frame.subarray(0, whole), Buffer.alloc(whole, 19));
      assert.deepEqual(frame.subarray(whole), Buffer.alloc(1920 - whole));
    }
    assert.equal(slicer.pending, 0);
    assert.equal(slicer.flush(), null);
  });
}
it('R306 PCM: выдаваемый кадр и ожидающий хвост не зависят от повторного использования входного буфера', () => {
  const slicer = new pcm.FrameSlicer();
  const backing = Buffer.alloc(1926, 3);
  const [frame] = slicer.push(backing.subarray(1, 1925));
  backing.fill(99);
  assert.deepEqual(frame, Buffer.alloc(1920, 3));
  assert.deepEqual(slicer.flush()?.subarray(0, 4), Buffer.alloc(4, 3));
  slicer.push(Buffer.alloc(7));
  slicer.reset();
  assert.equal(slicer.pending, 0);
  assert.equal(slicer.flush(), null);
});

for (const [gain, expected] of [[-1, 0], [0, 0], [0.5, 0.5], [1, 1], [2, 2], [2.01, 2], [Infinity, 2], [-Infinity, 0], [NaN, 1]] as const) {
  it(`R306 PCM: громкость ${gain} ограничена диапазоном 0…2`, () => assert.equal(pcm.clampVolume(gain), expected));
}
it('R306 PCM: нечисловое значение громкости использует единицу', () => {
  for (const value of [undefined, null, '2', {}]) assert.equal(pcm.clampVolume(value as number), 1);
});
function saturated(mod = pcm) {
  assert.deepEqual(Array.from(mod.applyVolume(samples([-32768, -20000, -16384, 0, 16384, 20000, 32767], 1), 2)),
    [-32767, -32767, -32767, 0, 32767, 32767, 32767], 'R306 PCM усиление насыщается строго до ±32767');
}
it('R306 PCM: усиление с нечётным byteOffset ограничено ±32767', () => saturated());
it('R306 PCM: ноль даёт тишину, единица — независимую точную копию включая -32768', () => {
  const input = samples([-32768, -9, 0, 9, 32767], 1);
  assert.deepEqual(Array.from(pcm.applyVolume(input, 0)), [0, 0, 0, 0, 0]);
  const copy = pcm.applyVolume(input, 1);
  input.fill(0);
  assert.deepEqual(Array.from(copy), [-32768, -9, 0, 9, 32767]);
});
function excessive(mod = pcm) {
  assert.deepEqual(Array.from(mod.applyVolume(samples([-1000, 1000]), 3)), [-2000, 2000], 'R306 PCM громкость выше двух не усиливает дальше');
}
it('R306 PCM: громкость выше двух ограничивается до умножения', () => excessive());
it('R306 PCM: дробная громкость округляет сэмплы, последний неполный байт не читается', () => {
  assert.deepEqual(Array.from(pcm.applyVolume(Buffer.concat([Buffer.from(samples([-3, 3])), Buffer.from([255])]), 0.5)), [-1, 2]);
  assert.equal(pcm.applyVolume(Buffer.alloc(0), 2).length, 0);
});

for (const c of [
  { name: 'потерянный остаток', needle: 'this.rest = Buffer.from(data.subarray(off));', replacement: 'this.rest = Buffer.alloc(0);', probe: crossChunks,
    message: 'R306 PCM остаток не теряется между кусками' },
  { name: 'предел -32768', needle: 'g < -32767 ? -32767 : g', replacement: 'g < -32768 ? -32768 : g', probe: saturated,
    message: 'R306 PCM усиление насыщается строго до ±32767' },
  { name: 'усиление выше двух', needle: 'return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, v));', replacement: 'return Math.max(VOLUME_MIN, v);', probe: excessive,
    message: 'R306 PCM громкость выше двух не усиливает дальше' },
]) {
  it(`R306 PCM контрфакт: ${c.name}, оригинал проходит первым`, () => {
    c.probe(load(source));
    assert.throws(() => c.probe(load(replaceOnce(c.needle, c.replacement))), (e: unknown) => e instanceof assert.AssertionError
      && e.code === 'ERR_ASSERTION' && e.message.split('\n', 1)[0] === c.message);
  });
}
