import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  KEEPALIVE_DEFAULTS, KEEPALIVE_FLAG_KEY, LOOP_ELEMENT_VOLUME, LOOP_SEND_AMPLITUDE,
  MIX_NOISE_AMPLITUDE, NOISE_BUFFER_SECONDS, dbfs, keepAliveEnabled, noiseSamples, pickLoopCodecs,
  type KeepAlivePart,
} from './voiceKeepAliveRules';
import type * as Rules from './voiceKeepAliveRules';

const parts: KeepAlivePart[] = ['mix', 'loop', 'renderer'];
const read = (flags: Record<string, string>) => (key: string) => flags[key] ?? null;

for (const part of parts) {
  it(`${part}: в приложении Android включено по умолчанию`, () => {
    assert.equal(KEEPALIVE_DEFAULTS[part], true);
    assert.equal(keepAliveEnabled(part, true, read({})), true);
  });
  it(`${part}: вне приложения даже явное включение не создаёт защиту`, () => {
    assert.equal(keepAliveEnabled(part, false, read({ [`${KEEPALIVE_FLAG_KEY}.${part}`]: '1' })), false);
  });
  it(`${part}: общий ноль сильнее собственного включения`, () => {
    assert.equal(keepAliveEnabled(part, true, read({ [KEEPALIVE_FLAG_KEY]: '0', [`${KEEPALIVE_FLAG_KEY}.${part}`]: '1' })), false);
  });
  it(`${part}: собственные 0 и 1 переключают только выбранную часть`, () => {
    for (const value of ['0', '1']) {
      const flags = read({ [`${KEEPALIVE_FLAG_KEY}.${part}`]: value });
      for (const candidate of parts) assert.equal(keepAliveEnabled(candidate, true, flags), candidate !== part || value === '1');
    }
  });
  it(`${part}: похожие на ноль строки не становятся выключателем`, () => {
    for (const value of ['', 'false', '00', ' 0', 'yes']) {
      assert.equal(keepAliveEnabled(part, true, read({ [KEEPALIVE_FLAG_KEY]: value, [`${KEEPALIVE_FLAG_KEY}.${part}`]: value })), KEEPALIVE_DEFAULTS[part]);
    }
  });
  it(`${part}: явная единица сильнее выключенного умолчания будущего релиза`, () => {
    // Изолированный экземпляр: импортированные умолчания остальных тестов не меняются.
    const raw = readFileSync(new URL('./voiceKeepAliveRules.ts', import.meta.url), 'utf8');
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, { module, exports: module.exports });
    const r = module.exports as typeof Rules;
    (r.KEEPALIVE_DEFAULTS as Record<KeepAlivePart, boolean>)[part] = false;
    assert.equal(r.keepAliveEnabled(part, true, read({})), false);
    assert.equal(r.keepAliveEnabled(part, true, read({ [`${KEEPALIVE_FLAG_KEY}.${part}`]: '1' })), true);
  });
}

it('источник случайности определяет и величину, и знак каждого сэмпла', () => {
  const values = [0, 0, 0.5, 0.5, 0.999999, 0.999999];
  let calls = 0;
  const samples = noiseSamples(3, 1, () => values[calls++]!);
  assert.deepEqual(Array.from(samples), [-0.5, 0.75, Math.fround(0.9999995)]);
  assert.equal(calls, 6);
});

it('граница int16 не обнуляет даже минимальный шум −80 dBFS обоих знаков', () => {
  for (const rand of [() => 0, () => 0.5, () => 0.999999]) {
    const samples = noiseSamples(48_000, MIX_NOISE_AMPLITUDE, rand);
    assert.equal(samples.length, 48_000);
    assert.equal(samples.every((v) => Math.trunc(v * 32768) !== 0), true);
    assert.equal(samples.every((v) => Math.abs(v) >= MIX_NOISE_AMPLITUDE / 2 - 1e-11 && Math.abs(v) <= MIX_NOISE_AMPLITUDE), true);
  }
});

it('дробная длина округляется вниз, нулевая и отрицательная дают пустой буфер', () => {
  for (const [length, expected] of [[3.9, 3], [1, 1], [0, 0], [-1, 0]]) {
    assert.equal(noiseSamples(length!, MIX_NOISE_AMPLITUDE, () => 0).length, expected);
  }
  assert.deepEqual(Array.from(noiseSamples(2, -1, () => 0)), [-0.5, -0.5]);
});

it('амплитуды и громкость оставляют ненулевые 8 и 24 младших бита после вывода', () => {
  assert.equal(MIX_NOISE_AMPLITUDE, 1e-4);
  assert.equal(dbfs(MIX_NOISE_AMPLITUDE), -80);
  assert.equal(dbfs(-MIX_NOISE_AMPLITUDE), -80);
  assert.equal(LOOP_SEND_AMPLITUDE, 7.5e-4);
  assert.equal(LOOP_ELEMENT_VOLUME, 0.15);
  assert.equal(NOISE_BUFFER_SECONDS, 1);
  for (const decoded of [8, 24]) assert.equal(Math.trunc(decoded * LOOP_ELEMENT_VOLUME) >= 1, true);
  assert.equal(Math.trunc(8 * 0.124), 0, 'контрфакт: меньшая громкость снова даёт чистые нули');
});

it('кодеки упорядочены PCMU → PCMA → Opus, RED/CN и служебные события исключены', () => {
  const codecs = ['audio/opus', 'audio/CN', 'audio/PCMA', 'audio/red', 'audio/PCMU', 'audio/telephone-event', 'video/VP8']
    .map((mimeType, payloadType) => ({ mimeType, payloadType }));
  const before = codecs.slice();
  const picked = pickLoopCodecs(codecs);
  assert.deepEqual(picked, [codecs[4], codecs[2], codecs[0]]);
  assert.equal(picked[0], codecs[4], 'сохраняется весь объект браузерных capabilities');
  assert.deepEqual(codecs, before);
  assert.deepEqual(pickLoopCodecs([{ mimeType: 'audio/opus' }]), [{ mimeType: 'audio/opus' }]);
  assert.deepEqual(pickLoopCodecs([{ mimeType: 'audio/CN' }]), []);
  assert.deepEqual(pickLoopCodecs([]), []);
});
