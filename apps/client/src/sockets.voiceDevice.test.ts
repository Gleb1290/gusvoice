import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as subs from './gatewaySubs';
import * as tipMode from './tipMode';
import type { VoiceConnection } from './store';
import { testVmImports } from './testVmImports';

// R376: исполняем целый неизменённый sockets, подменяя только окружение и внешние эффекты.
const code = ts.transpileModule(readFileSync(new URL('./sockets.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const noop = () => {};

// Контракт общей VM-границы проверяется здесь, чтобы не требовать новой регистрации файла.
function boundary(source: string, mocks: Record<string, unknown> = {}) {
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, { module, exports: module.exports,
    require: testVmImports(new URL('./sockets.ts', import.meta.url), mocks) });
  return module.exports;
}

it('VM принимает новый неиспользуемый импорт существующего модуля без запуска его IO', () => {
  const loaded = boundary("import './api'; export const result = 7;");
  assert.equal(loaded.result, 7);
});
it('VM диагностирует несуществующую зависимость даже без чтения её экспортов', () => {
  assert.throws(() => boundary("import './missing-vm-boundary';"), /Неизвестная зависимость .*missing-vm-boundary/);
});
it('VM требует mock для использованного именованного, default и namespace экспорта', () => {
  for (const source of [
    "import { api } from './api'; export const result = api;",
    "import api from './api'; export const result = api;",
    "import * as api from './api'; export const result = { ...api };",
  ]) assert.throws(() => boundary(source), /Не подготовлен mock экспорта .*api\./);
});
it('VM сохраняет предоставленные экспорты и обнаруживает отсутствующий экспорт частичного mock', () => {
  const api = { value: 42 };
  assert.equal(boundary("import { api } from './api'; export const result = api;", { './api': { api } }).result, api);
  assert.equal(boundary("import api from './api'; export const result = api;", { './api': { default: api } }).result, api);
  assert.throws(() => boundary("import { missing } from './api'; export const result = missing;", { './api': { api } }),
    /Не подготовлен mock экспорта .*api\.missing/);
});

it('VM загружает namespace через динамический import и сохраняет строгую проверку экспортов', async () => {
  const api = { value: 42 };
  const source = "export const result = import('./api');";
  const provided = await boundary(source, { './api': { default: api } }).result as { default: typeof api; missing?: unknown };
  assert.equal(provided.default, api);
  assert.throws(() => provided.missing, /Не подготовлен mock экспорта .*api\.missing/);
  const dormant = await boundary(source).result as { api?: unknown };
  assert.throws(() => dormant.api, /Не подготовлен mock экспорта .*api\.api/);
  assert.equal(boundary("import { then } from './api'; export const result = then;", { './api': { then: api } }).result, api);
});
type Voice = Pick<VoiceConnection, 'channelId' | 'serverId'> & Partial<Pick<VoiceConnection, 'instanceId'>>;
type Event = Extract<shared.GatewayServerMessage, { t: 'soundboard' | 'poke' | 'mega-poke' | 'tip' }>;
type Calls = unknown[][];
const localVoice: Voice = { channelId: 'voice-room', serverId: 'server', instanceId: 'local' };
const outside: Array<{ title: string; voice: Voice | null; here: boolean }> = [
  { title: 'голоса нет', voice: null, here: true },
  { title: 'другой канал', voice: { ...localVoice, channelId: 'other-room' }, here: true },
  { title: 'тот же id канала на чужом инстансе', voice: { ...localVoice, instanceId: 'remote' }, here: false },
];
const soundboard: Event = { t: 'soundboard', fromUserId: 'sender', fromName: 'Отправитель', clipId: 'clip',
  name: 'Сигнал', url: 'https://media.test/clip.ogg', amount: 7, channelId: 'voice-room' };
const poke: Event = { t: 'poke', fromUserId: 'sender', fromName: 'Отправитель', message: 'Привет', channelId: 'voice-room' };
const mega = (toUserId = 'me'): Event => ({ t: 'mega-poke', fromUserId: 'sender', fromName: 'Отправитель',
  toUserId, toName: 'Получатель', message: 'Привет', amount: 25, channelId: 'voice-room' });
const tip = (toUserId = 'me'): Event => ({ t: 'tip', fromUserId: 'sender', fromName: 'Отправитель',
  toUserId, toName: 'Получатель', amount: 9, channelId: 'voice-room' });

function fixture() {
  const calls: Calls = [], sockets: Socket[] = [];
  let here = true, now = Date.parse('2026-10-30T12:00:00Z');
  const record = (kind: string) => (...args: unknown[]) => {
    // Не сравниваем прототипы объектов разных VM-realm.
    calls.push([kind, ...JSON.parse(JSON.stringify(args))]);
  };
  const state = {
    user: { id: 'me' }, bootstrap: { server: { id: 'server' } }, serverFeatures: [], convActive: false,
    currentChannelId: 'voice-room', presence: { 'voice-room': [{ userId: 'me' }] },
    economy: { server: { currencyName: 'пёрышек' } }, voice: { ...localVoice } as Voice | null,
    selfDeafened: false, showPoke: record('poke'), pushToastEvent: record('banner'), pushTipHint: record('hint'),
    setActivities: noop, resyncAfterReconnect: async () => {}, rejoinVoiceAfterOutage: async () => {},
  };
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor(_url: string) { sockets.push(this); }
    send(_frame: string) {}
    close() { this.readyState = 3; }
    open() { this.readyState = 1; assert.ok(this.onopen); this.onopen(); }
    receive(event: Event) { assert.ok(this.onmessage); this.onmessage({ data: JSON.stringify(event) }); }
  }
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared, './gatewaySubs': subs, './tipMode': tipMode,
    './store': {
      useStore: { getState: () => state, subscribe: () => noop },
      // Контракт зависимости: ложь означает голос на другом инстансе. Само правило покрыто отдельно.
      voiceIsHere: () => here,
    },
    './api': { api: { listServers: async () => [], getActivities: async () => ({ activities: {} }) }, getToken: () => 'synthetic' },
    './config': { config: {}, gatewayWsUrl: () => 'ws://gateway.test/' },
    './connState': { resetGatewayLive: noop, setGatewayLive: noop },
    './presenceVisibility': { presentNow: () => true, watchPresence: noop }, './bgGateways': { setBgPresent: noop },
    './notifications': { setNotifyPrefs: noop, windowFocused: () => false, coinNotifyLevel: () => 'all', osNotifyRaw: record('notification') },
    // Уведомления разрешены: тишину обязан обеспечить голосовой гейт, не настройки/фокус/троттл.
    './coinNotifyRules': { shouldNotifyCoin: () => true },
    './socketHealth': { CONNECT_TIMEOUT_MS: 15_000, PING_MS: 25_000, socketStale: () => false },
    './sounds': { playClip: record('clip'), playSound: record('sound') }, './flashWindow': { flashWindow: record('flash') },
    './effectsBus': { fireEffect: record('effect') }, './effectsDom': { pulseChip: record('pulse') },
    './toast': { toast: record('toast'), toastError: record('error') },
    './memberName': { resolveMemberName: (_id: string, fallback: string) => fallback },
  };
  const module = { exports: {} as typeof import('./sockets') };
  class ClockDate extends Date { static override now() { return now; } }
  runInNewContext(code, {
    module, exports: module.exports, Date: ClockDate, WebSocket: Socket,
    window: { addEventListener: noop }, document: { addEventListener: noop },
    // Ни таймер, ни транспорт, ни HTTP здесь не могут обратиться к ОС/сети.
    setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop,
    fetch: () => { throw new Error('Незапланированный HTTP в sockets.voiceDevice'); },
    require: testVmImports(new URL('./sockets.ts', import.meta.url), deps),
  }, { timeout: 1000, filename: 'sockets.ts' });
  module.exports.connectGateway();
  assert.equal(sockets.length, 1, 'поднят поддельный gateway');
  sockets[0].open();
  assert.deepEqual(calls, [], 'установка соединения сама не даёт голосовых эффектов');
  return {
    state, calls, receive: (event: Event) => sockets[0].receive(event),
    voice(value: Voice | null, isHere = true) { state.voice = value; here = isHere; },
    tick() { now += 2000; },
  };
}

const soundboardCalls = (): Calls => [['clip', soundboard.url], ['toast', 'info', 'Отправитель: Сигнал', '7 пёрышек']];
const pokeCalls = (): Calls => [
  ['poke', { fromName: 'Отправитель', message: 'Привет', channelId: 'voice-room' }], ['sound', 'poke', 'voice-room'], ['flash'],
];
function megaCalls(mine: boolean): Calls {
  return [
    ['notification', mine ? 'Отправитель ущипнул тебя' : 'Отправитель ущипнул Получатель', mine ? 'Привет' : '25 пёрышек'],
    ['banner', { kind: 'poke', fromName: 'Отправитель', toName: 'Получатель', amount: 25 }],
    ...(mine ? [['effect', { kind: 'feathers', fromName: 'Отправитель', message: 'Привет', serverId: 'server' }], ['sound', 'poke', 'voice-room']]
      : [['toast', 'info', 'Отправитель ущипнул Получатель', '25 пёрышек']]),
  ];
}
function tipCalls(mine: boolean): Calls {
  return [
    ['sound', 'tip', 'voice-room'], ...(mine ? [['pulse']] : []),
    ['notification', mine ? 'Отправитель типнул тебя' : 'Отправитель типнул Получатель', '+9 пёрышек'],
    ['banner', { kind: 'tip', fromName: 'Отправитель', toName: 'Получатель', amount: 9 }],
    ['hint', { toUserId: mine ? 'me' : 'other', fromUserId: 'sender', fromName: 'Отправитель', amount: 9 }],
  ];
}

// Открытый канал и presence учётки НЕ означают, что конкретное устройство подключено к LiveKit.
it('саундборд не звучит и не показывает тост без голоса своего канала и инстанса', () => {
  for (const row of outside) {
    const f = fixture(); f.voice(row.voice, row.here); f.receive(soundboard);
    assert.deepEqual(f.calls, [], row.title);
  }
});

it('обычный тык вне голоса своего канала и инстанса не показывает сообщение, не звучит и не мигает', () => {
  for (const row of outside) {
    const f = fixture(); f.voice(row.voice, row.here); f.receive(poke);
    assert.deepEqual(f.calls, [], row.title);
  }
});

it('мега-тык вне голоса своего канала и инстанса молчит и для адресата, и для зрителя', () => {
  for (const row of outside) for (const to of ['me', 'other']) {
    const f = fixture(); f.voice(row.voice, row.here); f.receive(mega(to));
    assert.deepEqual(f.calls, [], `${row.title}, получатель ${to}`);
  }
});

it('тип вне голоса своего канала и инстанса даёт только тихий чип получателю, зрителю ничего', () => {
  for (const row of outside) for (const to of ['me', 'other']) {
    const f = fixture(); f.voice(row.voice, row.here); f.receive(tip(to));
    assert.deepEqual(f.calls, to === 'me' ? [['pulse']] : [], `${row.title}, получатель ${to}`);
  }
});

it('саундборд в голосе этого канала играет файл и объясняет выстрел тостом', () => {
  const f = fixture(); f.receive(soundboard);
  assert.deepEqual(f.calls, soundboardCalls());
});

it('деафен в своём голосовом канале глушит саундборд, но оставляет поясняющий тост', () => {
  const f = fixture(); f.state.selfDeafened = true; f.receive(soundboard);
  assert.deepEqual(f.calls, [['toast', 'info', 'Отправитель: Сигнал', '7 пёрышек']]);
});

it('обычный тык в своём голосовом канале сохраняет сообщение, звук и мигание даже при деафене', () => {
  for (const deafened of [false, true]) {
    const f = fixture(); f.state.selfDeafened = deafened; f.receive(poke);
    assert.deepEqual(f.calls, pokeCalls());
  }
});

it('мега-тык получателю в своём голосовом канале сохраняет уведомление, плашку, перья и звук', () => {
  const f = fixture(); f.receive(mega());
  assert.deepEqual(f.calls, megaCalls(true));
});

it('мега-тык зрителю в своём голосовом канале даёт уведомление, плашку и тост без перьев и звука', () => {
  const f = fixture(); f.receive(mega('other'));
  assert.deepEqual(f.calls, megaCalls(false));
});

it('тип получателю в своём голосовом канале сохраняет звук, чип и все объяснения передачи', () => {
  const f = fixture(); f.receive(tip());
  assert.deepEqual(f.calls, tipCalls(true));
});

it('тип зрителю в своём голосовом канале сохраняет звук и объяснения, но не дёргает чужой кошелёк', () => {
  const f = fixture(); f.receive(tip('other'));
  assert.deepEqual(f.calls, tipCalls(false));
});

// Нельзя захватить voice при подключении: вкладка входит/выходит/меняет канал без замены gateway.
it('тот же сокет использует актуальный голос при входе, выходе, смене канала и инстанса', () => {
  for (const [event, expected] of [[soundboard, soundboardCalls()], [poke, pokeCalls()], [mega(), megaCalls(true)], [tip(), tipCalls(true)]] as const) {
    const f = fixture();
    for (const row of [outside[0], { voice: localVoice, here: true }, outside[1], outside[2], { voice: localVoice, here: true }, outside[0]]) {
      f.calls.length = 0; f.voice(row.voice, row.here); f.tick(); f.receive(event);
      assert.deepEqual(f.calls, row.voice === localVoice ? expected : event.t === 'tip' ? [['pulse']] : []);
    }
  }
});

it('старый голос без instanceId по положительному ответу voiceIsHere сохраняет все голосовые события', () => {
  const f = fixture(); f.voice({ channelId: 'voice-room', serverId: 'server' });
  for (const event of [soundboard, poke, mega(), tip()]) f.receive(event);
  assert.deepEqual(f.calls, [...soundboardCalls(), ...pokeCalls(), ...megaCalls(true), ...tipCalls(true)]);
});

// Точное воспроизведение: один аккаунт и одно событие на двух устройствах, но голос только на ПК.
it('одинаковое событие одной учётке озвучивается на ПК в голосе, но не на телефоне с открытым чатом', () => {
  for (const [event, expected] of [[soundboard, soundboardCalls()], [poke, pokeCalls()], [mega(), megaCalls(true)], [tip(), tipCalls(true)]] as const) {
    const pc = fixture(), phone = fixture(); phone.voice(null);
    assert.equal(pc.state.user.id, phone.state.user.id);
    pc.receive(event); phone.receive(event);
    assert.deepEqual(pc.calls, expected);
    assert.deepEqual(phone.calls, event.t === 'tip' ? [['pulse']] : []);
  }
});
