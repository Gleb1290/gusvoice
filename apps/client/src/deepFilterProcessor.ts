import { noiseAssetBase } from './config';

/**
 * DeepFilterNet3 as a single AudioWorklet NODE for the unified mic chain (micProcessor.ts). Heavier
 * but stronger than RNNoise (see the "High CPU" label in settings). The engine + its WASM/ONNX model
 * are lazy-loaded from `deepfilternet3-noise-filter`; the model is fetched once from our own origin
 * (config.noiseAssetBase → /noise/deepfilternet3/...). Returns the node + a teardown.
 *
 * NB: DFN3 runs at 48 kHz — LiveKit's capture AudioContext is already 48 kHz.
 *
 * ⚠️ Как и RNNoise, работает по одному каналу — моно на входе обеспечивает вызывающая сторона
 * (`inputGain` с `channelCount: 1 / mode: 'explicit'`, см. `micProcessor.ts`). Стерео на входе даёт
 * звук в одном ухе и тишину во втором.
 */
export async function createDeepFilterNode(
  ctx: AudioContext,
): Promise<{ node: AudioNode; teardown: () => void }> {
  const { DeepFilterNet3Core } = await import('deepfilternet3-noise-filter');
  const core = new DeepFilterNet3Core({ sampleRate: 48000, assetConfig: { cdnUrl: noiseAssetBase() } });
  await core.initialize();
  const node = await core.createAudioWorkletNode(ctx);
  return {
    node,
    teardown: () => {
      try {
        core.destroy();
      } catch {
        /* already gone */
      }
      node.disconnect();
    },
  };
}
