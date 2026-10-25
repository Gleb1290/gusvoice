import { isAndroid } from './hotkeys';
import {
  keepAliveEnabled,
  LOOP_ELEMENT_VOLUME,
  LOOP_SEND_AMPLITUDE,
  MIX_NOISE_AMPLITUDE,
  NOISE_BUFFER_SECONDS,
  noiseSamples,
  pickLoopCodecs,
  type KeepAlivePart,
} from './voiceKeepAliveRules';

/**
 * Только приложение для Android (мост `GusVoiceNative` есть), не Chrome на телефоне: `isAndroid()` истинно и в мобильном
 * браузере, а там HyperOS-ловушки нет и проверить механику пробной сборкой нельзя — веб выкатывается сразу.
 */
function inAndroidApp(): boolean {
  return isAndroid() && typeof (globalThis as { GusVoiceNative?: unknown }).GusVoiceNative === 'object';
}

/**
 * Фоновый голос на Android — Xiaomi/HyperOS (#209). Только Android, только пока человек в голосовом канале.
 *
 * 🔴 ПРИЧИНА (живой трейс 27.09): библиотека звука HyperOS внутри процесса гасит в фоне любой вывод, который 60 с пишет
 * ЧИСТЫЕ НУЛИ (`AudioTrackImpl isLongTimeZeroData … noteMuteAudioInNeed(1)`). Входящие голоса Chromium вытягивает
 * через вывод WebRTC (общий для всех `<audio>` с удалёнными дорожками) — а он у нас пишет нули: элементы LiveKit на
 * громкости 0 (`webAudioMix`), подпорка обводки `muted`. Погас он — голоса не декодируются, хотя `AudioContext`
 * `running`. Остальные выводы (контекст микшера, контекст обводки, контекст `sounds.ts`) тоже писали нули.
 *
 * Лечение — ни один вывод не пишет нули, минимальной нагрузкой:
 *  - `mix`: ОДИН контекст на приложение (`sharedAudioContext`) — микшер LiveKit, анализаторы обводки и звуки событий;
 *    было четыре вывода, стало два. Пока в голосе — в его выход идёт шум −80 dBFS (модуль сэмпла ≥ 1,6 бита int16).
 *  - `loop`: в вывод WebRTC подмешать нельзя — в нём только удалённые дорожки, и молчащие собеседники (DTX, мут, один
 *    в канале) дают нули. Поэтому своя неслышная удалённая дорожка: тот же шум уходит петлёй из двух
 *    `RTCPeerConnection` внутри страницы кодеком PCMU (почти бесплатно; Opus в июльско-сентябрьской «тяжёлой схеме»
 *    подозревался в механизме 2) и играет элементом на громкости 0.15 — на выходе 1…3 младших бита. Голоса через этот
 *    элемент не идут, так что «заглушить всех» и громкость людей не меняются.
 *  - `renderer`: механизм 2 (рендерер в фоне без процессора) — нативный приоритет рендерера на время голоса
 *    (`MainActivity.applyVoiceRendererPriority`).
 *
 * ⛔ Чем это не июльский `backgroundAudio.ts` (откат 75cd1ec7, v0.5.45: звук глох за 15 с вместо 45, рендерер падал
 * при возврате): тот добавлял ЕЩЁ ОДИН вывод с чистыми нулями (беззвучный WAV) и будил контекст `resume()` на
 * statechange/visibility/focus. Здесь нет ни одного вывода с нулями, ни одного `resume`/`play` из фона и ни одного
 * таймера (в свёрнутом WebView они стоят) — только события.
 *
 * Выключатель без релиза — `localStorage['gv.voiceKeepAlive'] = '0'` или по частям (`voiceKeepAliveRules.ts`).
 * Состояние для отладки по CDP: `__gvKeepAlive()`.
 */

function readFlag(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function enabled(part: KeepAlivePart): boolean {
  return keepAliveEnabled(part, inAndroidApp(), readFlag);
}

let shared: AudioContext | null = null;
let sharedDecided = false;
let sharedOn = false;

/**
 * Общий контекст звука (Android, часть `mix`): микшер голосов LiveKit (`webAudioMix`), анализаторы обводки, звуки
 * событий. `null` — живём как раньше (у каждого свой). Решается один раз за запуск, чтобы звуки и голос не разъехались
 * посреди сессии. Не закрывается никогда — как и прежний контекст `sounds.ts`.
 */
export function sharedAudioContext(): AudioContext | null {
  if (!sharedDecided) {
    sharedDecided = true;
    sharedOn = enabled('mix');
  }
  if (!sharedOn) return null;
  if (!shared || shared.state === 'closed') {
    try {
      shared = new AudioContext({ latencyHint: 'interactive' });
    } catch {
      sharedOn = false;
      return null;
    }
  }
  return shared;
}

type Noise = { ctx: AudioContext; own: boolean; src: AudioBufferSourceNode };
type Loop = {
  a: RTCPeerConnection;
  b: RTCPeerConnection;
  el: HTMLAudioElement;
  gain: GainNode;
  dest: MediaStreamAudioDestinationNode;
};

let active = false;
let noise: Noise | null = null;
let loop: Loop | null = null;
let loopGen = 0;
let loopRestarts = 0;
/** Сколько раз петлю пересобирать после `failed` (смена сети) за один заход в голос. */
const LOOP_MAX_RESTARTS = 5;
let rendererHeld = false;

/** Шум в выход контекста. Контекст — общий; если `mix` выключен, а петля нужна — свой (и его выход тоже не нули). */
function startNoise(): Noise | null {
  if (noise) return noise;
  const sharedCtx = sharedAudioContext();
  let ctx = sharedCtx;
  if (!ctx) {
    if (!enabled('loop')) return null;
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' });
    } catch {
      return null;
    }
  }
  try {
    const buf = ctx.createBuffer(1, Math.max(1, Math.round(ctx.sampleRate * NOISE_BUFFER_SECONDS)), ctx.sampleRate);
    buf.getChannelData(0).set(noiseSamples(buf.length, MIX_NOISE_AMPLITUDE));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(ctx.destination);
    src.start();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    noise = { ctx, own: !sharedCtx, src };
  } catch (e) {
    console.warn('[keepalive] noise floor failed:', e);
    if (!sharedCtx) void ctx.close().catch(() => {});
    return null;
  }
  return noise;
}

function stopNoise(): void {
  const n = noise;
  noise = null;
  if (!n) return;
  try {
    n.src.stop();
    n.src.disconnect();
  } catch {
    /* уже остановлен */
  }
  if (n.own) void n.ctx.close().catch(() => {});
}

function closeLoop(l: Loop): void {
  try {
    l.a.close();
    l.b.close();
  } catch {
    /* уже закрыты */
  }
  try {
    l.el.pause();
    l.el.srcObject = null;
    l.gain.disconnect();
    for (const t of l.dest.stream.getTracks()) t.stop();
  } catch {
    /* узлы уже сняты */
  }
}

/** Петля шума через WebRTC в общий вывод удалённых дорожок (см. шапку). Без таймеров: пересборка — по `failed`. */
async function startLoop(n: Noise): Promise<void> {
  const gen = ++loopGen;
  const gain = n.ctx.createGain();
  gain.gain.value = LOOP_SEND_AMPLITUDE / MIX_NOISE_AMPLITUDE;
  const dest = n.ctx.createMediaStreamDestination();
  dest.channelCount = 1;
  n.src.connect(gain);
  gain.connect(dest);
  const a = new RTCPeerConnection({ iceServers: [] });
  const b = new RTCPeerConnection({ iceServers: [] });
  const el = new Audio();
  el.autoplay = true;
  el.volume = LOOP_ELEMENT_VOLUME;
  const l: Loop = { a, b, el, gain, dest };
  loop = l;
  a.onicecandidate = (e) => {
    if (e.candidate) void b.addIceCandidate(e.candidate).catch(() => {});
  };
  b.onicecandidate = (e) => {
    if (e.candidate) void a.addIceCandidate(e.candidate).catch(() => {});
  };
  b.ontrack = (e) => {
    el.srcObject = new MediaStream([e.track]);
    void el.play().catch((err: unknown) => console.warn('[keepalive] loop element play rejected:', err));
  };
  a.onconnectionstatechange = () => {
    if (a.connectionState !== 'failed' || loop !== l || !active) return;
    closeLoop(l);
    loop = null;
    if (loopRestarts >= LOOP_MAX_RESTARTS || !noise) return;
    loopRestarts++;
    console.info('[keepalive] loop failed (network change?) — rebuilding');
    void startLoop(noise).catch((err: unknown) => console.warn('[keepalive] loop rebuild failed:', err));
  };
  const track = dest.stream.getAudioTracks()[0];
  const tr = a.addTransceiver(track, { direction: 'sendonly' });
  try {
    const caps = typeof RTCRtpReceiver.getCapabilities === 'function' ? RTCRtpReceiver.getCapabilities('audio') : null;
    const pref = pickLoopCodecs(caps?.codecs ?? []);
    if (pref.length && typeof tr.setCodecPreferences === 'function') tr.setCodecPreferences(pref);
  } catch (e) {
    console.warn('[keepalive] loop codec preference failed (browser default):', e);
  }
  await a.setLocalDescription(await a.createOffer());
  if (gen !== loopGen) return;
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription(await b.createAnswer());
  if (gen !== loopGen) return;
  await a.setRemoteDescription(b.localDescription!);
}

function setRendererPriority(on: boolean): void {
  try {
    const b = (window as unknown as { GusVoiceNative?: { voiceRendererPriority?: (on: boolean) => void } }).GusVoiceNative;
    // Старая оболочка без метода — молча ничего (клиент приезжает с веба раньше APK).
    if (b && typeof b.voiceRendererPriority === 'function') b.voiceRendererPriority(on);
  } catch (e) {
    console.warn('[keepalive] voiceRendererPriority failed:', e);
  }
}

/** Вход в голос (`VoiceConnection`, эффект `[]`). Вне Android и при выключенном признаке — ничего. */
export function startVoiceKeepAlive(): void {
  if (active || !inAndroidApp()) return;
  active = true;
  loopRestarts = 0;
  if (enabled('renderer')) {
    rendererHeld = true;
    setRendererPriority(true);
  }
  const n = enabled('mix') || enabled('loop') ? startNoise() : null;
  if (n && enabled('loop') && typeof RTCPeerConnection === 'function') {
    void startLoop(n).catch((e: unknown) => console.warn('[keepalive] loop failed:', e));
  }
  publishDiag();
}

/** Выход из голоса. */
export function stopVoiceKeepAlive(): void {
  if (!active) return;
  active = false;
  loopGen++;
  if (loop) closeLoop(loop);
  loop = null;
  stopNoise();
  if (rendererHeld) {
    rendererHeld = false;
    setRendererPriority(false);
  }
}

/** `__gvKeepAlive()` в консоли WebView (CDP): что сейчас держит вывод. */
function publishDiag(): void {
  try {
    (window as unknown as { __gvKeepAlive?: () => unknown }).__gvKeepAlive = () => ({
      active,
      shared: shared?.state ?? null,
      noise: noise ? { own: noise.own, ctx: noise.ctx.state } : null,
      loop: loop ? { ice: loop.a.iceConnectionState, pc: loop.a.connectionState, playing: !loop.el.paused, restarts: loopRestarts } : null,
      renderer: rendererHeld,
    });
  } catch {
    /* не страшно */
  }
}
