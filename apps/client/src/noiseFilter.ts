/**
 * RNNoise as a single AudioWorklet NODE, to be composed into the unified mic chain (micProcessor.ts)
 * alongside input gain + the noise gate. Everything (engine, worklet, wasm) is lazy-loaded the first
 * time it's used. Returns the node + a teardown; the caller wires source -> ... -> node -> ... -> dest.
 *
 * NB: RNNoise expects 48 kHz mono — LiveKit's capture AudioContext is 48 kHz.
 *
 * ⚠️ `maxChannels: 1` форсит ОБРАБОТКУ одного канала, а НЕ число каналов на входе. Если сюда придёт
 * стерео, воркет обработает первый канал, а второй оставит нулями (`process()` бежит по
 * `min(входных, maxChannels)` и остальные выходные каналы не трогает) — на выходе получится звук
 * слева и тишина справа. Моно на входе обеспечивает вызывающая сторона: `inputGain` в
 * `micProcessor.ts` и в мик-тесте настроек стоит `channelCount: 1 / mode: 'explicit'`. Не убирать.
 */
export async function createRnnoiseNode(
  ctx: AudioContext,
): Promise<{ node: AudioNode; teardown: () => void }> {
  const [{ loadRnnoise, RnnoiseWorkletNode }, workletUrl, wasmUrl, wasmSimdUrl] = await Promise.all([
    import('@sapphi-red/web-noise-suppressor'),
    import('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'),
    import('@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'),
    import('@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'),
  ]);
  const wasmBinary = await loadRnnoise({ url: wasmUrl.default, simdUrl: wasmSimdUrl.default });
  await ctx.audioWorklet.addModule(workletUrl.default);
  const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
  return {
    node,
    teardown: () => {
      try {
        node.destroy();
      } catch {
        /* already gone */
      }
      node.disconnect();
    },
  };
}
