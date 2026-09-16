import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';
import { getAudioSettings, subscribeAudioSettings, type AudioSettings } from './audioSettings';
import { createDeepFilterNode } from './deepFilterProcessor';
import { createRnnoiseNode } from './noiseFilter';

// `micChainNeeded` / `micChainSignature` живут в `micProcessorRules.ts` — чистые, тестируемые
// (этот модуль в Node не импортируется: тянет `config.ts` → `window is not defined`).

/**
 * The unified microphone processing chain, as one LiveKit audio TrackProcessor:
 *   source → inputGain → [RNNoise | DeepFilter | passthrough] → noise-gate → published track
 *
 * Input gain + gate threshold update LIVE (via subscribeAudioSettings → no rebuild); changing the
 * neural filter changes the graph, so VoiceConnection rebuilds on `micChainSignature` change. Every
 * stage is fail-safe: a neural-filter or gate-worklet load failure just drops that stage, and a total
 * failure leaves the raw mic (VoiceConnection falls back to stopProcessor()).
 */
export async function createMicProcessor(): Promise<TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>> {
  let ctx: AudioContext;
  // Set only when WE created the context (LiveKit didn't hand us one) — so teardown closes ours but
  // never LiveKit's shared mix context.
  let ownedCtx: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let inputGain: GainNode | undefined;
  let gateNode: AudioWorkletNode | undefined;
  let dest: MediaStreamAudioDestinationNode | undefined;
  let filterTeardown: (() => void) | undefined;
  let unsub: (() => void) | undefined;

  const pushParams = (s: AudioSettings) => {
    if (inputGain) inputGain.gain.setTargetAtTime(Math.max(0, Math.min(2, s.inputGain)), ctx.currentTime, 0.02);
    // Gate is off while push-to-talk handles transmission, or when the threshold is 0.
    const threshold = s.pushToTalk ? 0 : Math.max(0, Math.min(1, s.vadThreshold));
    gateNode?.port.postMessage({ threshold });
  };

  const teardown = () => {
    unsub?.();
    filterTeardown?.();
    source?.disconnect();
    inputGain?.disconnect();
    gateNode?.disconnect();
    dest?.disconnect();
    source = inputGain = gateNode = dest = undefined;
    filterTeardown = unsub = undefined;
    if (ownedCtx) {
      void ownedCtx.close().catch(() => {});
      ownedCtx = undefined;
    }
  };

  const processor: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> = {
    name: 'gv-mic',
    processedTrack: undefined,
    async init(opts) {
      // LiveKit normally hands us its AudioContext, but some re-publish / mic re-enable paths call
      // init with `audioContext` undefined (then `ctx.createMediaStreamSource` throws "...of undefined"
      // and bubbles up through setMicrophoneEnabled → "микрофон недоступен"). Fall back to our own
      // context so the chain is always built; teardown closes only the one we created.
      ctx = opts.audioContext ?? new AudioContext();
      ownedCtx = opts.audioContext ? undefined : ctx;
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      const s = getAudioSettings();
      source = ctx.createMediaStreamSource(new MediaStream([opts.track]));
      inputGain = ctx.createGain();
      // 🔴 Сводим вход к МОНО до нейрофильтра — иначе половина сигнала теряется или уходит в тишину.
      // RNNoise и DeepFilter обрабатывают `min(каналов_на_входе, maxChannels=1)` каналов, а остальные
      // выходные каналы НЕ ТРОГАЮТ ВООБЩЕ — те остаются нулями (см. process() в
      // @sapphi-red/web-noise-suppressor). На стерео-микрофоне (USB-микрофоны, «стерео микшер», часть
      // веб-камер) это давало обработанный левый канал и ТИШИНУ в правом.
      // ⚠️ Не путать с #82: там воркет гейта заполнял выход по числу ВХОДНЫХ каналов; здесь наоборот —
      // на вход приходит стерео, а фильтр молча возвращает половину. Комментарий в noiseFilter.ts
      // утверждал «we force 1 channel», но `maxChannels: 1` форсит только ОБРАБОТКУ одного канала,
      // а не число каналов на входе — форсить его надо здесь.
      inputGain.channelCount = 1;
      inputGain.channelCountMode = 'explicit';
      inputGain.channelInterpretation = 'speakers'; // 2→1 = среднее L и R, а не «взять левый»
      source.connect(inputGain);
      let node: AudioNode = inputGain;

      // Neural filter stage (optional).
      try {
        if (s.noiseFilter === 'rnnoise') {
          const r = await createRnnoiseNode(ctx);
          filterTeardown = r.teardown;
          node.connect(r.node);
          node = r.node;
        } else if (s.noiseFilter === 'deepfilter') {
          const d = await createDeepFilterNode(ctx);
          filterTeardown = d.teardown;
          node.connect(d.node);
          node = d.node;
        }
      } catch (e) {
        console.warn('[mic] neural filter failed; chain continues without it:', e);
      }

      // Noise-gate stage (optional — gracefully skipped if the worklet won't load).
      dest = ctx.createMediaStreamDestination();
      try {
        await ctx.audioWorklet.addModule('/gv-gate-worklet.js');
        // В СЕТЬ отправляем моно: речь стереоканалом не становится, а дублировать её — лишний
        // битрейт на каждого слушателя. Раздачей моно по обоим ушам занимается уже приёмная
        // сторона. (Сам воркер теперь заполняет все каналы выхода — см. gv-gate-worklet.js.)
        gateNode = new AudioWorkletNode(ctx, 'gv-gate', { outputChannelCount: [1] });
        node.connect(gateNode);
        gateNode.connect(dest);
      } catch (e) {
        console.warn('[mic] gate worklet failed; no gate:', e);
        node.connect(dest);
      }

      pushParams(s);
      unsub = subscribeAudioSettings(pushParams);
      processor.processedTrack = dest.stream.getAudioTracks()[0];
    },
    async restart(opts) {
      teardown();
      await processor.init(opts);
    },
    async destroy() {
      teardown();
      processor.processedTrack?.stop();
      processor.processedTrack = undefined;
    },
  };
  return processor;
}
