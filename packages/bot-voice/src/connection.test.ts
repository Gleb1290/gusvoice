import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { types } from 'node:util';
import ts from 'typescript';
import * as grants from './grants.js';
import * as pcm from './pcm.js';
import * as queue from './queue.js';
import * as reconnect from './reconnect.js';
import type { Connection } from './connection.js';
import type { VoiceHost, VoiceJoinOptions } from '../../bot-sdk/src/voiceTypes.js';

// Только чтение текста и type-only импорт: connection.ts/rtc-node/index.ts не загружаются хостовым ESM-loader.
export const source = readFileSync(new URL('./connection.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
export const token = (video: unknown) => `synthetic-header.${Buffer.from(JSON.stringify({ video })).toString('base64url')}.synthetic-signature`;
export const allow = token({ canPublish: true, canPublishSources: ['microphone'] });
export const deny = token({ canPublish: false, canPublishSources: [] });
export const events = {
  ParticipantConnected: 'participant-connected', ParticipantDisconnected: 'participant-disconnected',
  Reconnecting: 'reconnecting', Reconnected: 'reconnected', Disconnected: 'disconnected', TokenRefreshed: 'token-refreshed',
  LocalTrackUnpublished: 'local-track-unpublished', LocalTrackRepublished: 'local-track-republished', TrackMuted: 'track-muted',
} as const;
type Timer = { id: number; callback(): void; delay: number; kind: 'interval' | 'timeout'; unrefs: number; unref(): void };
export async function settle() {
  // Граница только микрозадач: mock IO всегда уже разрешён, сети/потоков/таймеров ОС в сценариях нет.
  for (let turn = 0; turn < 24; turn++) await Promise.resolve();
}
export function replaceOnce(from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'R309 connection: уникальный якорь');
  return source.replace(from, to);
}
export function harness(raw = source, options: { serverMuted?: boolean; initialToken?: string } = {}) {
  const unexpected: string[] = [], logs: string[] = [], imported: string[] = [];
  const rooms: FakeRoom[] = [], sources: FakeAudioSource[] = [];
  const publications: { room: FakeRoom; track: { source: FakeAudioSource }; options: FakePublishOptions; sid: string }[] = [];
  const unpublications: string[] = [], joins: { id: string; options: { bitrate?: number } }[] = [], leaves: (string | undefined)[] = [], checks: string[] = [];
  const timers = new Map<number, Timer>(); let nextTimer = 0;
  const subscriptions = new Set<Parameters<VoiceHost['onVoiceState']>[0]>();
  const fail = (name: string): never => { unexpected.push(name); throw new Error(`R309 unexpected IO: ${name}`); };
  function timer(kind: Timer['kind'], callback: () => void, delay: number) {
    const value: Timer = { id: ++nextTimer, callback, delay, kind, unrefs: 0, unref() { this.unrefs++; } };
    timers.set(value.id, value); return value;
  }
  const clear = (value: Timer) => { timers.delete(value.id); };
  class FakeAudioSource {
    clears = 0; closes = 0;
    constructor(readonly sampleRate: number, readonly channels: number, readonly queueMs: number) { sources.push(this); }
    clearQueue() { this.clears++; }
    async close() { this.closes++; }
    captureFrame() { return fail('captureFrame без сценария воспроизведения'); }
    waitForPlayout() { return fail('waitForPlayout без сценария воспроизведения'); }
  }
  class FakePublishOptions {
    source: unknown;
    dtx: unknown;
    audioEncoding: { maxBitrate: bigint };
    constructor(value: FakePublishOptions) { this.source = value.source; this.dtx = value.dtx; this.audioEncoding = { ...value.audioEncoding }; }
  }
  class FakeRoom extends EventEmitter {
    token: string | undefined;
    readonly remoteParticipants = new Map();
    readonly connections: { url: string; token: string; options: { autoSubscribe: boolean; dynacast: boolean } }[] = [];
    disconnects = 0;
    readonly localParticipant = {
      // Fake SFU НЕ блокирует публикацию по grant: если SDK зря попробует при deny, счётчик увидит попытку.
      publishTrack: async (track: { source: FakeAudioSource }, value: FakePublishOptions) => {
        const sid = `synthetic-publication-${publications.length + 1}`;
        publications.push({ room: this, track, options: value, sid }); return { sid };
      },
      unpublishTrack: async (sid: string) => {
        unpublications.push(sid);
        // Именно такой пустой аргумент может прислать rtc-node после собственного unpublish.
        this.emit(events.LocalTrackUnpublished, undefined);
      },
    };
    constructor() { super(); rooms.push(this); }
    async connect(url: string, jwt: string, value: { autoSubscribe: boolean; dynacast: boolean }) {
      this.token = jwt; this.connections.push({ url, token: jwt, options: { ...value } });
    }
    async disconnect() { this.disconnects++; }
  }
  const rtc = {
    Room: FakeRoom, RoomEvent: events,
    DisconnectReason: { 1: 'PARTICIPANT_REMOVED', 2: 'CLIENT_INITIATED', 3: 'SERVER_SHUTDOWN' },
    AudioSource: FakeAudioSource,
    AudioFrame: class { constructor() { fail('AudioFrame без воспроизведения'); } },
    LocalAudioTrack: { createAudioTrack: (name: string, source: FakeAudioSource) => { assert.equal(name, 'music'); return { source }; } },
    TrackPublishOptions: FakePublishOptions, TrackSource: { SOURCE_MICROPHONE: 'microphone' },
    dispose: async () => { fail('dispose вне сценария'); },
  };
  const ffmpeg = {
    resolveFfmpegPath: (value?: string) => { assert.equal(value, 'synthetic-ffmpeg'); return value; },
    checkFfmpeg: async (value: string) => { checks.push(value); },
    spawnFfmpeg: () => fail('spawnFfmpeg'),
  };
  const imports: Record<string, unknown> = {
    'node:events': { EventEmitter }, '@livekit/rtc-node': rtc,
    './ffmpeg.js': ffmpeg, './pcm.js': pcm, './grants.js': grants, './queue.js': queue, './reconnect.js': reconnect,
  };
  const exports = {};
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, Buffer, Error, TypeError, AbortController, Date,
      setInterval: (callback: () => void, delay: number) => timer('interval', callback, delay), clearInterval: clear,
      setTimeout: (callback: () => void, delay: number) => timer('timeout', callback, delay), clearTimeout: clear,
      require: (name: string) => { imported.push(name); if (!Object.hasOwn(imports, name)) return fail(`неописанный импорт ${name}`); return imports[name]; } });
  const host: VoiceHost = {
    api: {
      joinVoice: async (id, value) => {
        joins.push({ id, options: { ...value } });
        return { url: 'wss://sfu.invalid', token: options.initialToken ?? allow, room: 'voice-room',
          chat: { id, type: 'voice', server_id: 'server' }, server_muted: options.serverMuted ?? false,
          expires_in: 600, audio: { sample_rate: 48000, channels: 2, bitrate: 96000 } };
      },
      leaveVoice: async id => { leaves.push(id); return true; },
    },
    getMe: async () => ({ id: 'bot' }),
    onVoiceState: handler => { subscriptions.add(handler); return () => { subscriptions.delete(handler); }; },
    log: value => { logs.push(value); },
  };
  let connection: Connection | undefined;
  async function open(value: VoiceJoinOptions = {}) {
    assert.equal(connection, undefined, 'R309 fixture открывает одну связь');
    connection = await (exports as { Connection: typeof Connection }).Connection.open(host, 'voice', { ffmpegPath: 'synthetic-ffmpeg', bitrate: 96000, followMoves: false, ...value });
    return connection;
  }
  function tickProbes() {
    const probes = [...timers.values()].filter(t => t.kind === 'interval');
    assert.equal(probes.length, 1, 'R309 один управляемый probe interval');
    for (const probe of probes) { assert.equal(probe.delay, 5000); probe.callback(); }
  }
  async function clean() {
    await connection?.leave(); await settle();
    assert.equal(subscriptions.size, 0); assert.equal(timers.size, 0);
    assert.deepEqual(unexpected, []); assert.deepEqual(logs, []);
  }
  return { open, clean, tickProbes, imported, rooms, sources, publications, unpublications, joins, leaves, checks, timers };
}
import { it } from 'node:test';

it('R309 Connection.open проходит настоящий lifecycle с подменным RTC: микрофон, без подписки и без процессов', async () => {
  const h = harness();
  try {
    const c = await h.open();
    assert.equal(c.state, 'connected'); assert.equal(c.muted, false); assert.equal(c.channelId, 'voice'); assert.equal(c.serverId, 'server');
    assert.deepEqual(h.checks, ['synthetic-ffmpeg']); assert.deepEqual(h.joins, [{ id: 'voice', options: { bitrate: 96000 } }]);
    assert.deepEqual(h.rooms[0].connections, [{ url: 'wss://sfu.invalid', token: allow, options: { autoSubscribe: false, dynacast: false } }]);
    assert.equal(h.publications.length, 1); const pub = h.publications[0];
    assert.equal(pub.options.source, 'microphone'); assert.equal(pub.options.dtx, false); assert.equal(pub.options.audioEncoding.maxBitrate, 96000n);
    assert.deepEqual([h.sources[0].sampleRate, h.sources[0].channels, h.sources[0].queueMs], [48000, 2, 1000]);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.imported.sort(), ['node:events', '@livekit/rtc-node', './ffmpeg.js', './pcm.js', './grants.js', './queue.js', './reconnect.js'].sort());
  } finally { await h.clean(); }
});

async function denyProbe(raw = source, denied = deny) {
  const h = harness(raw);
  try {
    const c = await h.open(); const room = h.rooms[0]; let muted = 0, unmuted = 0;
    c.on('muted', () => { muted++; }); c.on('unmuted', () => { unmuted++; });
    room.token = denied; room.emit(events.TokenRefreshed);
    assert.equal(c.muted, true, 'R309 refreshed deny заглушает связь');
    assert.equal(muted, 1); assert.equal(unmuted, 0);
    assert.deepEqual(h.unpublications, [h.publications[0].sid]); assert.equal(h.sources[0].clears, 1);
    room.emit(events.TokenRefreshed); room.emit(events.TokenRefreshed);
    assert.equal(muted, 1); assert.equal(h.unpublications.length, 1); assert.equal(h.sources[0].clears, 1);
    const [probe] = h.timers.values(); assert.equal(probe.unrefs, 1);
    h.tickProbes(); h.tickProbes(); await settle();
    // Проверяем попытки, а не только muted: fake publish разрешил бы ошибочную публикацию даже при deny.
    assert.equal(h.publications.length, 1, 'R309 probe не пытается публиковать при deny');
    assert.equal(h.sources.length, 1); assert.equal(c.muted, true); assert.equal(unmuted, 0);
  } finally { await h.clean(); }
}
it('R309 TokenRefreshed deny даёт один muted/unpublish, повтор события и probe не публикуют звук', () => denyProbe());
it('R309 TokenRefreshed только с camera также заглушает и не пускает периодическую пробу', () => denyProbe(source, token({ canPublish: true, canPublishSources: ['camera'] })));

async function allowAgain(raw = source) {
  const h = harness(raw);
  try {
    const c = await h.open(); const room = h.rooms[0]; const transitions: string[] = [];
    c.on('muted', () => { transitions.push('muted'); }); c.on('unmuted', () => { transitions.push('unmuted'); });
    room.token = deny; room.emit(events.TokenRefreshed); assert.equal(c.muted, true);
    room.token = allow; room.emit(events.TokenRefreshed); await settle();
    assert.equal(h.publications.length, 2, 'R309 refreshed allow немедленно публикует новую дорожку');
    assert.notEqual(h.publications[0].sid, h.publications[1].sid);
    assert.notEqual(h.publications[0].track.source, h.publications[1].track.source);
    assert.equal(h.sources[0].closes, 1); assert.equal(h.sources[1].closes, 0);
    assert.equal(c.muted, false); assert.deepEqual(transitions, ['muted', 'unmuted']); assert.equal(h.timers.size, 0);
    room.emit(events.TokenRefreshed); await settle();
    assert.equal(h.publications.length, 2); assert.deepEqual(transitions, ['muted', 'unmuted']);
    // Старая публикация не может заглушить уже новую дорожку.
    room.emit(events.LocalTrackUnpublished, { sid: h.publications[0].sid });
    assert.equal(c.muted, false); assert.deepEqual(transitions, ['muted', 'unmuted']);
  } finally { await h.clean(); }
}
it('R309 TokenRefreshed allow сразу перепубликует микрофон, закрывает старый source и даёт один unmuted', () => allowAgain());

async function emptyPublication(raw = source) {
  const h = harness(raw);
  try {
    const c = await h.open(); let muted = 0; c.on('muted', () => { muted++; });
    let threw = false;
    try { h.rooms[0].emit(events.LocalTrackUnpublished, undefined); } catch (error) {
      // Неявный TypeError VM принадлежит её realm, даже при переданном глобальном TypeError.
      // Посторонняя ошибка не должна засчитываться как обнаруженный мутант pub.sid.
      if (!types.isNativeError(error) || error.name !== 'TypeError' || !error.message.includes("(reading 'sid')")) throw error;
      threw = true;
    }
    assert.equal(threw, false, 'R309 пустая публикация не бросает TypeError');
    assert.equal(c.muted, false); assert.equal(muted, 0); assert.equal(h.timers.size, 0); assert.deepEqual(h.unpublications, []);
    // Парный принятый признак: публикация с текущим sid действительно означает мьют.
    h.rooms[0].emit(events.LocalTrackUnpublished, { sid: h.publications[0].sid });
    assert.equal(c.muted, true); assert.equal(muted, 1);
  } finally { await h.clean(); }
}
it('R309 LocalTrackUnpublished(undefined) безопасен, а текущий sid по-прежнему включает мьют', () => emptyPublication());

for (const delayed of [false, true]) it(`R309 два Disconnected ${delayed ? 'после завершения teardown' : 'подряд'} дают один disconnected`, async () => {
  const h = harness();
  try {
    const c = await h.open(); const room = h.rooms[0]; const seen: unknown[] = [];
    c.on('disconnected', info => { seen.push({ ...info }); });
    room.emit(events.Disconnected, 1);
    if (delayed) await settle();
    room.emit(events.Disconnected, 1); await settle();
    assert.equal(c.state, 'disconnected'); assert.deepEqual(seen, [{ kicked: true, reason: 'PARTICIPANT_REMOVED' }]);
    assert.equal(room.disconnects, 1); assert.equal(h.sources[0].closes, 1); assert.equal(h.joins.length, 1); assert.equal(h.timers.size, 0);
    await c.rejoin(); assert.equal(c.state, 'connected');
    h.rooms[1].emit(events.Disconnected, 1); await settle();
    assert.equal(seen.length, 2, 'успешный rejoin разрешает уведомление о следующем отключении');
  } finally { await h.clean(); }
});
it('R309 начальный server_muted с deny не публикует; неизвестный токен оставляет запасную пробу рабочей', async () => {
  const h = harness(source, { serverMuted: true, initialToken: deny });
  try {
    const c = await h.open(); assert.equal(c.muted, true); assert.equal(h.publications.length, 0);
    h.tickProbes(); await settle(); assert.equal(h.publications.length, 0);
    let unmuted = 0; c.on('unmuted', () => { unmuted++; });
    h.rooms[0].token = 'unknown-token'; h.tickProbes(); await settle();
    assert.equal(h.publications.length, 1); assert.equal(c.muted, false); assert.equal(unmuted, 1); assert.equal(h.timers.size, 0);
  } finally { await h.clean(); }
});
for (const mutant of [
  { name: 'probe стучится при deny', from: '    if (canSpeakFromToken(room.token) === false) return;', to: '    /* R309 убран запрет пробы */', check: denyProbe, marker: 'R309 probe не пытается публиковать при deny', actual: 2, expected: 1 },
  { name: 'pub.sid без optional chaining', from: 'if (mine() && pub?.sid && pub.sid === this.pubSid)', to: 'if (mine() && pub.sid && pub.sid === this.pubSid)', check: emptyPublication, marker: 'R309 пустая публикация не бросает TypeError', actual: true, expected: false },
  { name: 'deny не передан onServerMuted', from: 'if (can === false) this.onServerMuted();', to: 'if (false) this.onServerMuted();', check: denyProbe, marker: 'R309 refreshed deny заглушает связь', actual: false, expected: true },
  { name: 'allow не запускает немедленную пробу', from: 'else if (can === true && this.isMuted) void this.probe();', to: 'else if (false) void this.probe();', check: allowAgain, marker: 'R309 refreshed allow немедленно публикует новую дорожку', actual: 1, expected: 2 },
]) it(`R309 connection контрфакт: ${mutant.name}, оригинал проходит первым`, async () => {
  await mutant.check(source);
  await assert.rejects(mutant.check(replaceOnce(mutant.from, mutant.to)), (error: unknown) => error instanceof assert.AssertionError
    && error.code === 'ERR_ASSERTION' && error.operator === 'strictEqual' && error.message.split('\n', 1)[0] === mutant.marker
    && error.actual === mutant.actual && error.expected === mutant.expected);
});
