import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './voiceKeepAliveRules';

const source = readFileSync(new URL('./voiceKeepAlive.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rulesSource = readFileSync(new URL('./voiceKeepAliveRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Api = { startVoiceKeepAlive(): void; stopVoiceKeepAlive(): void; sharedAudioContext(): unknown };
type Options = { android?: boolean; bridge?: boolean; flags?: Record<string, string>; ruleSource?: string };

// Весь production-модуль, а не извлечённые функции. Фейки моделируют только использованный WebAudio/WebRTC контракт.
function load(raw = source, options: Options = {}) {
  const contexts: Context[] = [], peers: Peer[] = [], elements: Element[] = [], renderer: boolean[] = [];
  class Node {
    connections: unknown[] = [];
    disconnected = false;
    connect(target: unknown) { this.connections.push(target); return target; }
    disconnect() { this.disconnected = true; }
  }
  class Track { stopped = false; stop() { this.stopped = true; } }
  class Stream {
    constructor(public tracks = [new Track()]) {}
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks; }
  }
  class Source extends Node {
    buffer: unknown;
    loop = false;
    started = false;
    stopped = false;
    start() { this.started = true; }
    stop() { this.stopped = true; }
  }
  class Gain extends Node { gain = { value: 1 }; }
  class Destination extends Node { channelCount = 2; stream = new Stream(); }
  class Context {
    state = 'running';
    sampleRate = 8_000;
    destination = new Node();
    sources: Source[] = [];
    gains: Gain[] = [];
    destinations: Destination[] = [];
    closes = 0;
    resumes = 0;
    constructor(..._args: unknown[]) { contexts.push(this); }
    createBuffer(_channels: number, length: number, _rate: number) {
      const data = new Float32Array(length);
      return { length, getChannelData: () => data };
    }
    createBufferSource() { const n = new Source(); this.sources.push(n); return n; }
    createGain() { const n = new Gain(); this.gains.push(n); return n; }
    createMediaStreamDestination() { const n = new Destination(); this.destinations.push(n); return n; }
    async resume() { this.resumes++; this.state = 'running'; }
    async close() { this.closes++; this.state = 'closed'; }
  }
  class Element {
    autoplay = false;
    muted = false;
    volume = 1;
    paused = true;
    srcObject: unknown = null;
    constructor() { elements.push(this); }
    async play() { this.paused = false; }
    pause() { this.paused = true; }
  }
  class Peer {
    connectionState = 'new';
    iceConnectionState = 'new';
    localDescription: unknown = null;
    closed = false;
    codecs: { mimeType: string }[] = [];
    onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
    ontrack: ((event: { track: Track }) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    constructor(public configuration: unknown) { peers.push(this); }
    async addIceCandidate(_candidate: unknown) {}
    addTransceiver(_track: Track, _options: unknown) {
      return { setCodecPreferences: (codecs: { mimeType: string }[]) => { this.codecs = codecs; } };
    }
    async createOffer() { return { type: 'offer', sdp: 'local-offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'local-answer' }; }
    async setLocalDescription(description: unknown) { this.localDescription = description; }
    async setRemoteDescription(_description: unknown) {}
    close() { this.closed = true; }
  }
  const native = options.bridge === false ? undefined : { voiceRendererPriority: (on: boolean) => renderer.push(on) };
  const window = { GusVoiceNative: native };
  const module = { exports: {} };
  let selectedRules = rules;
  if (options.ruleSource) {
    const ruleModule = { exports: {} };
    runInNewContext(compile(options.ruleSource), { module: ruleModule, exports: ruleModule.exports });
    selectedRules = ruleModule.exports as typeof rules;
  }
  runInNewContext(compile(raw), {
    module, exports: module.exports, window, GusVoiceNative: native,
    AudioContext: Context, Audio: Element, RTCPeerConnection: Peer, MediaStream: Stream,
    RTCRtpReceiver: { getCapabilities: () => ({ codecs: [{ mimeType: 'audio/opus' }, { mimeType: 'audio/PCMU' }] }) },
    localStorage: { getItem: (key: string) => options.flags?.[key] ?? null },
    console: { warn() {}, info() {} },
    require: (id: string) => {
      if (id === './hotkeys') return { isAndroid: () => options.android !== false };
      if (id === './voiceKeepAliveRules') return selectedRules;
      throw new Error(`unexpected import: ${id}`);
    },
  });
  return { api: module.exports as Api, contexts, peers, elements, renderer, Track };
}
function compile(raw: string) {
  return ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
}
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const replace = (raw: string, from: string, to: string) => {
  assert.equal(raw.split(from).length, 2, `единственная точка мутации: ${from}`);
  return raw.replace(from, to);
};

it('приложение создаёт одну шумовую подложку, петлю и удержание рендерера; повторный вход ничего не удваивает', async () => {
  const h = load();
  h.api.startVoiceKeepAlive(); h.api.startVoiceKeepAlive(); await flush();
  assert.equal(h.contexts.length, 1);
  assert.equal(h.peers.length, 2);
  assert.deepEqual(h.renderer, [true]);
  const ctx = h.contexts[0]!;
  assert.equal(ctx.sources.length, 1);
  assert.equal(ctx.sources[0]!.loop && ctx.sources[0]!.started, true);
  assert.equal(ctx.sources[0]!.connections.includes(ctx.destination), true);
  assert.equal(ctx.gains[0]!.gain.value, rules.LOOP_SEND_AMPLITUDE / rules.MIX_NOISE_AMPLITUDE);
  assert.equal(ctx.destinations[0]!.channelCount, 1);
  assert.deepEqual(Array.from(h.peers[0]!.codecs, (c) => c.mimeType), ['audio/PCMU', 'audio/opus']);
  h.api.stopVoiceKeepAlive(); h.api.stopVoiceKeepAlive();
  assert.deepEqual(h.renderer, [true, false]);
  assert.equal(ctx.sources[0]!.stopped && ctx.sources[0]!.disconnected, true);
  assert.equal(h.peers.every((p) => p.closed), true);
  assert.equal(ctx.destinations[0]!.stream.getTracks().every((t) => t.stopped), true);
  assert.equal(ctx.gains[0]!.disconnected, true);
  assert.equal(ctx.closes, 0);
});

it('полученная дорожка играет только в отдельном неслышном, но не muted элементе', async () => {
  const h = load(); h.api.startVoiceKeepAlive(); await flush();
  h.peers[1]!.ontrack!({ track: new h.Track() });
  const el = h.elements[0]!;
  assert.equal(el.autoplay, true);
  assert.equal(el.muted, false);
  assert.equal(el.volume, 0.15);
  assert.equal(el.paused, false);
  assert.equal(el.srcObject !== null, true);
  h.api.stopVoiceKeepAlive();
  assert.equal(el.paused, true);
  assert.equal(el.srcObject, null);
});

for (const [name, options] of [
  ['Chrome на Android без моста', { bridge: false }],
  ['не Android даже с мостом', { android: false }],
  ['общий выключатель при собственных включениях', { flags: {
    'gv.voiceKeepAlive': '0', 'gv.voiceKeepAlive.mix': '1', 'gv.voiceKeepAlive.loop': '1', 'gv.voiceKeepAlive.renderer': '1',
  } }],
] as const) {
  it(`${name}: не создаёт ни контекста, ни петли, ни нативного удержания`, () => {
    const h = load(source, options); h.api.startVoiceKeepAlive();
    assert.equal(h.api.sharedAudioContext(), null);
    assert.equal(h.contexts.length + h.peers.length + h.elements.length + h.renderer.length, 0);
    h.api.stopVoiceKeepAlive();
  });
}

it('выключенные mix и renderer оставляют петлю со своим контекстом, который закрывается при выходе', () => {
  const h = load(source, { flags: { 'gv.voiceKeepAlive.mix': '0', 'gv.voiceKeepAlive.renderer': '0' } });
  h.api.startVoiceKeepAlive();
  assert.equal(h.api.sharedAudioContext(), null);
  assert.equal(h.peers.length, 2);
  assert.deepEqual(h.renderer, []);
  h.api.stopVoiceKeepAlive();
  assert.equal(h.contexts[0]!.closes, 1);
});

it('выключенная петля оставляет общий шум, без WebRTC и audio-элемента', () => {
  const h = load(source, { flags: { 'gv.voiceKeepAlive.loop': '0' } });
  h.api.startVoiceKeepAlive();
  assert.equal(h.contexts.length, 1);
  assert.equal(h.peers.length + h.elements.length, 0);
  assert.equal(h.contexts[0]!.sources[0]!.started, true);
  h.api.stopVoiceKeepAlive();
});

it('общий контекст сохраняется между входами, шум и петля снимаются и создаются заново', async () => {
  const h = load(); const shared = h.api.sharedAudioContext();
  for (let i = 0; i < 2; i++) {
    h.api.startVoiceKeepAlive(); await flush(); h.api.stopVoiceKeepAlive();
    assert.equal(h.api.sharedAudioContext(), shared);
  }
  assert.equal(h.contexts.length, 1);
  assert.equal(h.contexts[0]!.sources.length, 2);
  assert.equal(h.peers.length, 4);
  assert.equal(h.peers.every((p) => p.closed), true);
});

it('только failed пересобирает петлю, не более пяти раз; выход запрещает запоздалую пересборку', async () => {
  const h = load(); h.api.startVoiceKeepAlive(); await flush();
  const first = h.peers[0]!;
  for (const state of ['new', 'connecting', 'connected', 'disconnected', 'closed']) {
    first.connectionState = state; first.onconnectionstatechange!();
    assert.equal(h.peers.length, 2);
  }
  for (let restart = 0; restart < 6; restart++) {
    const current = h.peers[h.peers.length - 2]!;
    current.connectionState = 'failed'; current.onconnectionstatechange!(); await flush();
    assert.equal(current.closed, true);
    assert.equal(h.peers.length, 2 * (1 + Math.min(restart + 1, 5)));
  }
  h.api.stopVoiceKeepAlive(); first.onconnectionstatechange!();
  assert.equal(h.peers.length, 12);
});

async function audible(raw: string, field: 'muted' | 'volume') {
  const h = load(raw); h.api.startVoiceKeepAlive(); await flush();
  h.peers[1]!.ontrack!({ track: new h.Track() });
  if (field === 'muted') assert.equal(h.elements[0]!.muted, false, 'R273:loop-not-muted');
  else assert.equal(h.elements[0]!.volume, rules.LOOP_ELEMENT_VOLUME, 'R273:loop-volume');
  h.api.stopVoiceKeepAlive();
}
function destination(raw: string) {
  const h = load(raw); h.api.startVoiceKeepAlive();
  assert.equal(h.contexts[0]!.sources[0]!.connections.includes(h.contexts[0]!.destination), true, 'R273:noise-destination');
  h.api.stopVoiceKeepAlive();
}
function sharedLifetime(raw: string) {
  const h = load(raw); h.api.startVoiceKeepAlive(); h.api.stopVoiceKeepAlive();
  assert.equal(h.contexts[0]!.closes, 0, 'R273:shared-not-closed');
}
function disabled(raw: string, ruleSource?: string) {
  const h = load(raw, { flags: { 'gv.voiceKeepAlive': '0' }, ruleSource }); h.api.startVoiceKeepAlive();
  assert.equal(h.contexts.length + h.peers.length + h.renderer.length, 0, 'R273:master-zero');
}
function browser(raw: string) {
  const h = load(raw, { bridge: false }); h.api.startVoiceKeepAlive();
  assert.equal(h.contexts.length + h.peers.length, 0, 'R273:bridge-required');
}
for (const [name, from, to, marker, scenario] of [
  ['muted скрывает поток от вывода', 'el.autoplay = true;', 'el.autoplay = true; el.muted = true;', 'R273:loop-not-muted', (raw: string) => audible(raw, 'muted')],
  ['нулевая громкость обнуляет int16', 'el.volume = LOOP_ELEMENT_VOLUME;', 'el.volume = 0;', 'R273:loop-volume', (raw: string) => audible(raw, 'volume')],
  ['без подключения шум не доходит до динамика', 'src.connect(ctx.destination);', '', 'R273:noise-destination', destination],
  ['чужой общий контекст нельзя закрывать', 'own: !sharedCtx', 'own: true', 'R273:shared-not-closed', sharedLifetime],
  ['мобильный браузер не приложение', "isAndroid() && typeof (globalThis as { GusVoiceNative?: unknown }).GusVoiceNative === 'object'", 'isAndroid()', 'R273:bridge-required', browser],
] as const) {
  it(`контрфакт: ${name}`, async () => {
    await scenario(source);
    const mutant = replace(source, from, to);
    await assert.rejects(async () => scenario(mutant), (error: unknown) => error instanceof assert.AssertionError && error.message.includes(marker));
  });
}
it('контрфакт: игнорирование общего нуля действительно включает вывод', () => {
  disabled(source);
  const mutant = replace(rulesSource, "if (read(KEEPALIVE_FLAG_KEY) === '0') return false;", '');
  assert.throws(() => disabled(source, mutant), (error: unknown) => error instanceof assert.AssertionError && error.message.includes('R273:master-zero'));
});
