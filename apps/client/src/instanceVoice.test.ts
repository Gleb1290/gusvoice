import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createStore } from 'zustand/vanilla';
import * as channelRules from './channelRules';
import * as convSyncRules from './convSyncRules';
import * as streamAudioRules from './streamAudioRules';
import * as scopeRules from './instanceScopeRules';

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
// Выполняется весь настоящий модуль; подменяются только импорты и окружение, ни один расчёт не копируется.
function load<T>(name: string, deps: Record<string, unknown>, globals: Record<string, unknown> = {}, mutate?: (s: string) => string): T {
  const original = source(name);
  const code = ts.transpileModule(mutate ? mutate(original) : original, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  runInNewContext(code, {
    module, exports: module.exports, console, URL, Response, FormData, setTimeout, clearTimeout, setInterval, clearInterval,
    require: (id: string) => {
      assert.ok(Object.hasOwn(deps, id), `не подменён импорт ${id} из ${name}`);
      return deps[id];
    },
    ...globals,
  }, { filename: name });
  return module.exports as T;
}

function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function apiFixture(mutate?: (s: string) => string, globals: Record<string, unknown> = {}) {
  const records = [
    { id: 'home', apiUrl: 'https://home.test', token: 'home-old', name: 'Дом' },
    { id: 'guest', apiUrl: 'https://guest.test', token: 'guest-token', name: 'Сосед' },
  ];
  let active = 'guest';
  const localStorage = storage();
  const requests: { url: string; init: RequestInit }[] = [];
  const writes: string[] = [];
  let respond: (url: string, init: RequestInit) => Promise<Response> = async () => Response.json({ ok: true });
  const config = { get apiUrl() { return records.find((r) => r.id === active)!.apiUrl; } };
  const exports = load<typeof import('./api')>('api.ts', {
    './config': {
      config, instances: () => records, activeInstanceId: () => active, activeInstance: () => records.find((r) => r.id === active),
      updateInstance: (id: string, patch: object) => { writes.push(id); Object.assign(records.find((r) => r.id === id)!, patch); },
      updateActiveInstance: (patch: object) => { writes.push(`active:${active}`); Object.assign(records.find((r) => r.id === active)!, patch); },
    },
    './bgGateways': { mirrorToBg: () => {} }, './imageSize': { measureImageFile: async () => null },
  }, { localStorage, fetch: (url: string, init: RequestInit) => { requests.push({ url, init }); return respond(url, init); }, ...globals }, mutate);
  return { ...exports, records, requests, writes, localStorage,
    activate: (id: string) => { active = id; exports.reloadToken(); },
    respond: (fn: typeof respond) => { respond = fn; },
  };
}

describe('запросы к явной записи инстанса', () => {
  it('отправка с дедлайном передаёт AbortSignal, прежняя отправка без дедлайна его не добавляет', async () => {
    // Ограничение очереди не поможет, если запрос продолжает висеть без сигнала отмены.
    const seen: number[] = [], signal = new AbortController().signal;
    const f = apiFixture(undefined, { AbortSignal: { timeout: (ms: number) => { seen.push(ms); return signal; } } });
    await f.api.convSend('c', { clientId: 'one', content: 'text', attachments: [] }, 15000);
    assert.deepEqual(seen, [15000]); assert.equal(f.requests[0].init.signal, signal);
    await f.api.convSend('c', { clientId: 'two', content: 'text', attachments: [] });
    assert.equal(Object.hasOwn(f.requests[1].init, 'signal'), false);
  });
  it('TimeoutError превращается в отказ очереди с меткой timeout, обычный сетевой отказ не маскируется', async () => {
    // Без метки timeout очередь выбрала бы шесть долгих повторов вместо ожидания восстановления связи.
    const f = apiFixture(undefined, { AbortSignal: { timeout: () => new AbortController().signal } });
    f.respond(async () => { throw Object.assign(new Error('deadline'), { name: 'TimeoutError' }); });
    await assert.rejects(() => f.api.convSend('c', { clientId: 'one', content: 'text', attachments: [] }, 15000), (e: unknown) => (e as { timeout?: boolean; message?: string }).timeout === true && (e as Error).message === 'сервер не ответил');
    const network = new Error('Failed to fetch'); f.respond(async () => { throw network; });
    await assert.rejects(() => f.api.convSend('c', { clientId: 'two', content: 'text', attachments: [] }, 15000), e => e === network);
  });
  it('один apiFor перечитывает адрес и токен записи на каждом вызове', async () => {
    // Ловит запрос в прежний адрес с прежним токеном после обновления записи реестра.
    const f = apiFixture();
    const home = f.apiFor('home');
    await home.me();
    Object.assign(f.records[0], { apiUrl: 'https://new-home.test', token: 'new-login' });
    await home.me();
    assert.deepEqual(f.requests.map((r) => [r.url, (r.init.headers as Record<string, string>).Authorization]), [
      ['https://home.test/api/auth/me', 'Bearer home-old'], ['https://new-home.test/api/auth/me', 'Bearer new-login'],
    ]);
  });

  it('ответ apiFor переживает переход экрана и reloadToken', async () => {
    // Ловит отмену домашней админки или голоса при переходе к соседу.
    const f = apiFixture();
    const pending = deferred<Response>();
    f.respond(() => pending.promise);
    const response = f.apiFor('home').me();
    f.activate('home');
    pending.resolve(Response.json({ id: 'home-user' }));
    assert.equal((await response).id, 'home-user');
  });

  it('продление неактивной записи не меняет активный токен и его зеркало', async () => {
    // Ловит подмену гостевой сессии токеном дома из ответа админки.
    const f = apiFixture();
    f.respond(async () => Response.json({}, { headers: { 'x-refresh-token': 'home-fresh' } }));
    await f.apiFor('home').me();
    assert.equal(f.records[0].token, 'home-fresh');
    assert.equal(f.getToken(), 'guest-token');
    assert.equal(f.localStorage.getItem('gv_token'), null);
    assert.deepEqual(f.writes, ['home']);
  });

  it('продление активной записи обновляет getToken и зеркало через setToken', async () => {
    // Ловит старый bearer в следующем запросе активного клиента после продления через apiFor.
    const f = apiFixture();
    f.activate('home');
    f.respond(async () => Response.json({}, { headers: { 'x-refresh-token': 'home-fresh' } }));
    await f.apiFor('home').me();
    assert.equal(f.getToken(), 'home-fresh');
    assert.equal(f.localStorage.getItem('gv_token'), 'home-fresh');
    assert.deepEqual(f.writes, ['active:home']);
  });

  it('позднее продление не затирает новый вход: CAS доказан контрфактически', async () => {
    // Ловит гонку «запрос старым токеном → перелогин → старый x-refresh-token».
    const scenario = async (mutate?: (s: string) => string) => {
      const f = apiFixture(mutate);
      const pending = deferred<Response>();
      f.respond(() => pending.promise);
      const request = f.apiFor('home').me();
      f.records[0].token = 'new-login';
      pending.resolve(Response.json({}, { headers: { 'x-refresh-token': 'stale-refresh' } }));
      await request;
      return f.records[0].token;
    };
    assert.equal(await scenario(), 'new-login');
    assert.equal(await scenario((s) => {
      assert.ok(s.includes('now.token === sent'));
      return s.replace('now.token === sent', 'true');
    }), 'stale-refresh', 'без CAS тот же сценарий обязан обнаружить затирание');
  });

  it('удалённая запись не возвращается в реестр поздним продлением', async () => {
    // Ловит восстановление удалённого инстанса ответом уже ушедшего запроса.
    const f = apiFixture();
    const pending = deferred<Response>();
    f.respond(() => pending.promise);
    const request = f.apiFor('home').me();
    f.records.splice(0, 1);
    pending.resolve(Response.json({ id: 'late' }, { headers: { 'x-refresh-token': 'fresh' } }));
    assert.equal((await request).id, 'late');
    assert.deepEqual(f.writes, []);
  });

  it('401 чужой записи объясняет истёкший вход и сохраняет обе сессии', async () => {
    // Ловит общий разлогин семьи из-за протухшего токена домашней админки.
    const f = apiFixture();
    f.respond(async () => Response.json({ error: 'denied' }, { status: 401 }));
    await assert.rejects(f.apiFor('home').me(), (e: unknown) => {
      const err = e as Error & { status: number; reason: string };
      assert.equal(err.status, 401);
      assert.equal(err.reason, 'instance.session_expired');
      assert.match(err.message, /Дом.*истёк/);
      return true;
    });
    assert.equal(f.getToken(), 'guest-token');
    assert.equal(f.records[0].token, 'home-old');
    assert.deepEqual(f.writes, []);
  });

  it('запись без токена и отсутствующая запись отказывают до fetch', async () => {
    // Ловит отправку чужого активного токена вместо отсутствующего домашнего.
    const f = apiFixture();
    f.records[0].token = '';
    for (const id of ['home', 'missing']) await assert.rejects(f.apiFor(id).me(), (e: unknown) => (e as { reason: string }).reason === 'instance.session_expired');
    assert.equal(f.requests.length, 0);
  });

  it('переход во время чтения успешного тела выбрасывает ответ активного API', async () => {
    // Ловит попадание серверов прежнего инстанса в новый стор после получения заголовков.
    const f = apiFixture();
    const body = deferred<unknown>();
    const reading = deferred<void>();
    f.respond(async () => ({ status: 200, ok: true, headers: new Headers(), json: () => { reading.resolve(); return body.promise; } }) as Response);
    const request = f.api.me();
    await reading.promise;
    f.activate('home');
    body.resolve({ id: 'old-user' });
    await assert.rejects(request, (e: unknown) => (e as { switched: boolean }).switched === true);
  });

  it('переход во время чтения ошибки не выдаёт старый 401 новому инстансу', async () => {
    // Ловит разлогин нового экрана по запоздавшей ошибке покинутого API.
    const f = apiFixture();
    const body = deferred<unknown>();
    const reading = deferred<void>();
    f.respond(async () => ({ status: 401, ok: false, headers: new Headers(), json: () => { reading.resolve(); return body.promise; } }) as Response);
    const request = f.api.me();
    await reading.promise;
    f.activate('home');
    body.resolve({ error: 'old 401' });
    await assert.rejects(request, (e: unknown) => (e as { switched: boolean }).switched === true);
    assert.equal(f.getToken(), 'home-old');
  });
});

describe('сохранение голосовой сессии своего инстанса', () => {
  function fixture() {
    let active: string | null = 'home';
    let now = 1000;
    const localStorage = storage();
    const mod = load<typeof import('./voiceSession')>('voiceSession.ts', { './config': { activeInstanceId: () => active } },
      { localStorage, Date: class extends Date { static now() { return now; } } });
    return { ...mod, localStorage, activate: (id: string | null) => { active = id; }, time: (at: number) => { now = at; } };
  }

  it('save и touch обновляют инстанс голоса, даже когда экран на другом', () => {
    // Ловит освежение домашней сессии вместо живой гостевой после перехода.
    const f = fixture();
    f.saveVoiceSession('guest', 's', 'v');
    f.time(2000);
    f.touchVoiceSession('guest');
    assert.equal(JSON.parse(f.localStorage.getItem('gv_voice_session:guest')!).ts, 2000);
    assert.equal(f.rejoinableVoiceSession(), null);
    f.activate('guest');
    assert.equal(f.restorableVoiceSession()?.channelId, 'v');
  });

  it('clear с явным id стирает только его, без аргумента — активный', () => {
    // Ловит стирание другой сессии при выходе из гостевого голоса.
    const f = fixture();
    f.saveVoiceSession('home', 'h', 'hv');
    f.saveVoiceSession('guest', 'g', 'gv');
    f.clearVoiceSession('guest');
    assert.equal(f.rejoinableVoiceSession()?.channelId, 'hv');
    f.clearVoiceSession();
    assert.equal(f.localStorage.values.size, 0);
    f.saveVoiceSession(null, 'd', 'dv');
    assert.ok(f.localStorage.getItem('gv_voice_session:default'));
  });

  it('восстановление читает только активную запись и границу grace с обеих сторон', () => {
    // Ловит возврат в чужой канал и восстановление ровно истёкшей сессии.
    const f = fixture();
    f.saveVoiceSession('home', 'h', 'hv');
    f.time(1000 + f.GRACE_MS - 1);
    assert.equal(f.restorableVoiceSession()?.channelId, 'hv');
    f.time(1000 + f.GRACE_MS);
    assert.equal(f.restorableVoiceSession(), null);
    assert.equal(f.rejoinableVoiceSession()?.channelId, 'hv');
    f.activate('guest');
    assert.equal(f.rejoinableVoiceSession(), null);
  });
});

describe('личная громкость комнаты другого инстанса', () => {
  function fixture() {
    const localStorage = storage();
    const active = 'home';
    const mod = load<typeof import('./localUserAudio')>('localUserAudio.ts', {
      react: {}, 'livekit-client': { Track: { Source: { Microphone: 'mic', ScreenShareAudio: 'screen' } } },
      './config': { activeInstanceId: () => active }, './instanceScopeRules': scopeRules,
      './instanceScope': { scopedGetItem: (k: string) => localStorage.getItem(`${k}@${active}`), scopedSetItem: (k: string, v: string) => localStorage.setItem(`${k}@${active}`, v) },
    }, { localStorage });
    const applied: number[] = [];
    const screen: number[] = [];
    const participant = { identity: 'same-user', isLocal: false, trackPublications: new Map([
      ['mic', { source: 'mic', track: { setVolume: (v: number) => applied.push(v) } }],
      ['screen', { source: 'screen', track: { setVolume: (v: number) => screen.push(v) } }],
    ]) } as unknown as Parameters<typeof mod.applyUserAudio>[0];
    return { ...mod, localStorage, applied, screen, participant };
  }

  it('гостевая громкость обходит кеш дома и перечитывается при каждом применении', () => {
    // Ловит одинаковый userId двух инстансов, получивший домашнюю громкость в гостевой комнате.
    const f = fixture();
    f.localStorage.setItem('gv_user_audio@home', JSON.stringify({ 'same-user': { volume: 0.2 } }));
    assert.equal(f.effectiveGain('same-user'), 0.2);
    f.localStorage.setItem('gv_user_audio@guest', JSON.stringify({ 'same-user': { volume: 1.5 } }));
    f.applyUserAudio(f.participant, 'guest');
    f.localStorage.setItem('gv_user_audio@guest', JSON.stringify({ 'same-user': { muted: true, volume: 1.5 } }));
    f.applyUserAudio(f.participant, 'guest');
    assert.deepEqual(f.applied, [1.5, 0]);
    assert.deepEqual(f.screen, []);
  });

  it('активный и null используют прежний кеш; чужая пустая или битая настройка даёт 100 процентов', () => {
    // Ловит потерю активных настроек и падение голоса на повреждённом JSON соседа.
    const f = fixture();
    f.localStorage.setItem('gv_user_audio@home', JSON.stringify({ 'same-user': { volume: 0.4 } }));
    f.applyUserAudio(f.participant, 'home');
    f.applyUserAudio(f.participant, null);
    f.applyUserAudio(f.participant, 'guest');
    f.localStorage.setItem('gv_user_audio@guest', '{broken');
    f.applyUserAudio(f.participant, 'guest');
    assert.deepEqual(f.applied, [0.4, 0.4, 1, 1]);
  });
});

function voice(instanceId: string | null = 'guest', serverId: string | null = 'vs'): import('./store').VoiceConnection {
  return { instanceId, serverId, channelId: 'live-channel', url: 'wss://voice.test', token: 'live-token', channelName: 'Комната',
    serverName: 'Гостевой сервер', instanceName: 'Сосед', self: { displayName: 'Гость', avatarUrl: 'avatar.png' }, selfId: 'guest-user' };
}

function storeFixture(mutate?: (s: string) => string, mobile = false) {
  let active: string | null = 'home';
  let token: string | null = 'home-token';
  const saved: unknown[][] = [];
  const cleared: (string | null | undefined)[] = [];
  const calls: string[] = [];
  const wipes: string[] = [];
  let bootstrap = { channels: [] as { id: string; type: string; name?: string }[], sounds: {} };
  let requestToken: (channel: string) => Promise<{ url: string; token: string }> = async (channel) => ({ url: 'wss://new.test', token: `token:${channel}` });
  const api = {
    voiceToken: (ch: string) => { calls.push(`home:${ch}`); return requestToken(ch); },
    getServer: async () => bootstrap, listMembers: async () => [],
    getToken: () => token, setToken: (value: string | null) => { token = value; calls.push(`token:${value}`); },
  };
  const guestApi = { voiceToken: (ch: string) => { calls.push(`guest:${ch}`); return requestToken(ch); } };
  const exports = load<typeof import('./store')>('store.ts', {
    zustand: { create: createStore }, './api': { api, apiFor: (id: string) => { assert.equal(id, 'guest'); return guestApi; }, getToken: () => token, setToken: (value: string | null) => { token = value; calls.push(`token:${value}`); } },
    './config': { activeInstanceId: () => active, config: { apiUrl: 'https://home.test' }, instances: () => [{ id: 'home', name: ' Дом ', domain: 'home.test', userId: 'u', apiUrl: 'https://home.test' }], logoutFamily: (id: string) => calls.push(`logoutFamily:${id}`) },
    './channelRules': channelRules, './convSyncRules': convSyncRules, './streamAudioRules': streamAudioRules,
    './convStore': { createConvActions: () => ({ convReset: () => { calls.push('convReset'); } }) },
    './convCacheRules': { convCacheKey: (record: { id: string }) => `cache:${record.id}` }, './dmListRules': {},
    './convCache': { markConvCacheWipe: (key: string) => wipes.push(`mark:${key}`), deleteConvCache: async (key: string) => { wipes.push(`delete:${key}`); return true; }, clearConvCacheWipe: (key: string) => wipes.push(`clear:${key}`) },
    './historyPage': {}, './channelPrefs': {}, './lastPlace': { rememberPlace: () => {} }, './tabSync': { publishTabEvent: () => {} },
    './hotkeys': { isMobile: () => mobile }, './sounds': { setChannelSounds: () => {}, setCustomSounds: () => {} },
    './nativeUnifiedPush': { stopPushRegistration: () => calls.push('stopPush') },
    './tipHints': {}, './toastRules': {}, './profilePatch': {}, './instanceScope': { scopedGetItem: () => null }, './voiceCueRules': {},
    './voiceSession': {
      clearVoiceSession: (id?: string | null) => { cleared.push(id); }, saveVoiceSession: (...args: unknown[]) => { saved.push(args); },
      restorableVoiceSession: () => { calls.push('restorable'); return null; },
    },
  }, { localStorage: storage() }, mutate);
  return { ...exports, api, guestApi, calls, saved, cleared,
    wipes,
    get: () => exports.useStore.getState(), set: (state: Record<string, unknown>) => exports.useStore.setState(state as never),
    activate: (id: string | null, t: string | null = 'token') => { active = id; token = t; },
    bootstrap: (b: typeof bootstrap) => { bootstrap = b; }, tokenResponse: (fn: typeof requestToken) => { requestToken = fn; },
  };
}

describe('голос переживает навигацию между инстансами', () => {
  it('повторный выбор уже видимой беседы просит прыжок вниз новым номером, не перезагружает ленту', async () => {
    // Второй click по строке должен привести к первому непрочитанному, а не молча оставить скролл на месте.
    const f = storeFixture();
    f.set({ convActive: true, currentDmId: 'c', view: 'dm', mobilePane: 'content', dmMessages: { c: [] },
      feedDownAsk: { id: 'c', n: 2 }, readDmNow: () => {}, convEnsureList: async () => {},
      conv: { ...convSyncRules.emptyConvState(), windows: { c: { basePts: 0, hasMoreBefore: false, hasMoreAfter: false, stale: false } } } });
    await f.get().selectDm('c');
    assert.equal(f.get().feedDownAsk?.id, 'c'); assert.equal(f.get().feedDownAsk?.n, 3);
    await f.get().selectDm('c'); assert.equal(f.get().feedDownAsk?.n, 4);
  });
  it('повторный выбор видимой свежей беседы не переоткрывает окно, остальные пути переоткрывают', async () => {
    for (const mode of ['shown', 'mobile-list', 'stale', 'no-list', 'legacy']) {
      const f = storeFixture(undefined, mode === 'mobile-list'); const calls: string[] = [];
      f.set({ convActive: mode !== 'legacy', currentDmId: 'c', view: 'dm', mobilePane: mode === 'mobile-list' ? 'list' : 'content',
        dmMessages: mode === 'no-list' ? {} : { c: [] }, conv: { ...convSyncRules.emptyConvState(), windows: { c: { basePts: 0, hasMoreBefore: false, hasMoreAfter: false, stale: mode === 'stale' } } },
        readDmNow: () => calls.push('read'), convEnsureList: async () => { calls.push('list'); }, refreshDmHistory: async () => { calls.push('history'); } });
      await f.get().selectDm('c'); assert.deepEqual(calls, mode === 'shown' ? ['read', 'list'] : ['history'], mode);
    }
  });
  it('вход запоминает инстанс, сервер, подписи и профиль в комнате', async () => {
    // Ловит плашку и собственную плитку, перескочившие на профиль другого инстанса после навигации.
    const f = storeFixture();
    f.set({ user: { id: 'home-user', displayName: 'Хозяин', avatarUrl: 'home.png' }, currentServerId: 'hs',
      servers: [{ id: 'hs', name: 'Домашний сервер' }], bootstrap: { channels: [{ id: 'new-channel', name: 'Кухня', type: 'voice' }] } });
    await f.get().joinVoice('new-channel');
    const v = f.get().voice!;
    assert.deepEqual({ ...v, self: { ...v.self } }, {
      instanceId: 'home', serverId: 'hs', channelId: 'new-channel', channelName: 'Кухня', serverName: 'Домашний сервер', instanceName: 'Дом',
      selfId: 'home-user', self: { displayName: 'Хозяин', avatarUrl: 'home.png' }, url: 'wss://new.test', token: 'token:new-channel',
    });
    assert.deepEqual(f.saved, [['home', 'hs', 'new-channel']]);
  });

  it('вход на другом инстансе стирает прежнюю сессию, вход на том же её не стирает', async () => {
    // Ловит авто-возврат в прежний гостевой канал после намеренного входа в домашний.
    const f = storeFixture();
    f.set({ voice: voice(), currentServerId: 'hs', bootstrap: { channels: [{ id: 'home-channel', name: 'Дом', type: 'voice' }] } });
    await f.get().joinVoice('home-channel');
    assert.deepEqual(f.cleared, ['guest']);
    await f.get().joinVoice('home-channel');
    assert.deepEqual(f.cleared, ['guest']);
  });

  it('switchedInstance сохраняет живой голос и профиль при токене цели, без токена убирает профиль', () => {
    // Ловит исходный вылет из голоса при просмотре дома; в памяти мутант с voice:null подтверждает чувствительность.
    const scenario = (mutate?: (s: string) => string) => {
      const f = storeFixture(mutate);
      const v = voice();
      const live = { peer: { speaking: true, muted: false, deafened: false, screensharing: false } };
      const user = { id: 'guest-user', displayName: 'Гость' };
      f.set({ voice: v, liveVoice: live, voiceState: 'connected', user });
      f.get().switchedInstance();
      return { f, v, live, user };
    };
    const { f, v, live, user } = scenario();
    assert.equal(f.get().voice, v);
    assert.equal(f.get().liveVoice, live);
    assert.equal(f.get().voiceState, 'connected');
    assert.equal(f.get().user, user);
    assert.equal(f.get().instanceEpoch, 1);
    f.activate('home', null);
    f.get().switchedInstance();
    assert.equal(f.get().user, null);
    assert.equal(f.get().voice, v);
    const mutated = scenario((s) => {
      const re = /(switchedInstance: \(\) => \{[\s\S]*?set\(\(s\) => \(\{)/;
      assert.match(s, re);
      return s.replace(re, '$1\n voice: null,');
    });
    assert.notEqual(mutated.f.get().voice, mutated.v, 'мутант обязан потерять голос');
  });

  it('голос выбирает свой API и перемещается с прежним профилем и подписями инстанса', async () => {
    // Ловит токен домашнего пользователя, запрошенный для гостевой комнаты.
    const f = storeFixture();
    assert.equal(f.voiceApiOf(null), f.api);
    assert.equal(f.voiceApiOf({ instanceId: null }), f.api);
    assert.equal(f.voiceApiOf({ instanceId: 'home' }), f.api);
    assert.equal(f.voiceApiOf({ instanceId: 'guest' }), f.guestApi);
    const v = voice();
    f.set({ voice: v });
    await f.get().moveVoiceTo('moved');
    assert.deepEqual(f.calls, ['guest:moved']);
    const moved = f.get().voice!;
    for (const field of ['instanceId', 'serverId', 'serverName', 'instanceName', 'self', 'selfId'] as const) assert.equal(moved[field], v[field]);
    assert.equal(moved.channelId, 'moved');
    assert.equal(moved.channelName, 'Голосовой канал');
    assert.deepEqual(f.saved, [['guest', 'vs', 'moved']]);
  });

  it('обновление токена гостевой комнаты не затирает голос, изменившийся пока шёл запрос', async () => {
    // Ловит восстановление прежней комнаты поздним refreshVoiceToken.
    const f = storeFixture();
    const pending = deferred<{ url: string; token: string }>();
    f.tokenResponse(() => pending.promise);
    f.set({ voice: voice() });
    const request = f.get().refreshVoiceToken();
    const newer = { ...voice('home'), channelId: 'new-home' };
    f.set({ voice: newer });
    pending.resolve({ url: 'wss://stale.test', token: 'stale' });
    await request;
    assert.equal(f.get().voice, newer);
    assert.deepEqual(f.calls, ['guest:live-channel']);
  });

  it('обновление прав рвёт только голос этого сервера и инстанса при исчезнувшем канале', async () => {
    // Ловит обрыв гостевого или соседнего сервера от правки роли на просматриваемом сервере.
    for (const [instance, server, visible, drops] of [
      ['guest', 'hs', false, false], ['home', 'other', false, false], ['home', 'hs', true, false], ['home', 'hs', false, true],
    ] as const) {
      const f = storeFixture();
      const v = voice(instance, server);
      const live = { peer: { speaking: true, muted: false, deafened: false, screensharing: false } };
      f.set({ voice: v, liveVoice: live, currentServerId: 'hs' });
      f.bootstrap({ channels: visible ? [{ id: 'live-channel', type: 'voice' }] : [], sounds: {} });
      await f.get().refreshBootstrap('hs');
      assert.equal(f.get().voice, drops ? null : v, `${instance}/${server}/${visible}`);
      if (!drops) assert.equal(f.get().liveVoice, live);
      else assert.equal(Object.keys(f.get().liveVoice).length, 0);
    }
  });

  it('закрытие админки сохраняет её адрес, обычное открытие сбрасывает его на активный', () => {
    // Ловит переключение API во время анимации закрытия и повторное открытие чужой админки.
    const f = storeFixture();
    f.get().setAdminOpen(true, 'home');
    f.get().setAdminOpen(false);
    assert.equal(f.get().adminOpen, false);
    assert.equal(f.get().adminInstanceId, 'home');
    f.get().setAdminOpen(true, null);
    assert.equal(f.get().adminInstanceId, null);
  });

  it('openServer оставляет телефон в списке каналов, а на ПК сразу открывает первый текстовый', async () => {
    // Открытие сервера с ленты не должно оставлять телефон на пустой панели без выбранного канала.
    for (const mobile of [true, false]) {
      const f = storeFixture(undefined, mobile);
      const opened: string[] = [];
      f.bootstrap({ channels: [{ id: 'voice', type: 'voice' }, { id: 'text-first', type: 'text' }], sounds: {} });
      f.set({ mobilePane: 'content', openChannel: async (id: string) => { opened.push(id); f.set({ currentChannelId: id, mobilePane: 'content' }); } });
      await f.get().openServer('server');
      assert.equal(f.get().mobilePane, mobile ? 'list' : 'content', mobile ? 'телефон показывает список' : 'ПК показывает контент');
      assert.equal(f.get().currentChannelId, mobile ? null : 'text-first');
      assert.deepEqual(opened, mobile ? [] : ['text-first']);
    }
    const mutated = storeFixture((s) => {
      const start = s.indexOf('openServer: async');
      const end = s.indexOf('// Member roster', start);
      const target = s.slice(start, end);
      assert.ok(target.includes("mobilePane: 'list',"), 'найдена установка мобильного списка');
      return s.slice(0, start) + target.replace("mobilePane: 'list',", "mobilePane: s.mobilePane,") + s.slice(end);
    }, true);
    mutated.bootstrap({ channels: [{ id: 'text-first', type: 'text' }], sounds: {} });
    mutated.set({ mobilePane: 'content' });
    await mutated.get().openServer('server');
    assert.equal(mutated.get().mobilePane, 'content', 'мутант должен оставить пустую панель открытой');
  });

  it('черновик канала сохраняет ссылку при повторе, пустой удаляет, а logout и смена инстанса очищают', async () => {
    // Не будим подписчиков на одинаковом тексте и не переносим приватный черновик в другой аккаунт.
    const f = storeFixture();
    f.get().setChannelDraft('ch', 'текст', 'reply');
    const drafts = f.get().channelDrafts;
    f.set({ convDraftChanged: () => { f.calls.push('convDraftChanged'); } });
    f.calls.length = 0;
    f.get().setChannelDraft('ch', 'текст', 'reply');
    assert.equal(f.get().channelDrafts, drafts, 'одинаковое значение сохраняет identity');
    assert.deepEqual(f.get().channelDrafts.ch, { text: 'текст', replyToId: 'reply' });
    assert.equal(f.calls.includes('convDraftChanged'), false, 'канальный черновик не запускает sync/API бесед');
    f.get().setChannelDraft('ch', '', null);
    assert.equal(Object.keys(f.get().channelDrafts).length, 0);
    f.get().setChannelDraft('ch', 'logout draft', null);
    await f.get().logout();
    assert.equal(Object.keys(f.get().channelDrafts).length, 0);
    assert.ok(f.calls.includes('token:null'), 'logout очистил токен');
    f.get().setChannelDraft('ch', 'old instance draft', null);
    f.get().switchedInstance();
    assert.equal(Object.keys(f.get().channelDrafts).length, 0);
  });

  it('восстановление при живом голосе ничего не читает и не меняет навигацию', async () => {
    // Ловит переподключение гостевого голоса при bootstrap домашнего экрана.
    const f = storeFixture();
    const v = voice();
    f.set({ voice: v, currentServerId: 'home-view' });
    await f.get().restoreVoiceSession({ serverId: 'else', channelId: 'else', ts: 0 });
    await f.get().restoreVoiceSession();
    assert.equal(f.get().voice, v);
    assert.equal(f.get().currentServerId, 'home-view');
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.cleared, []);
  });

  it('выход с домашнего экрана стирает сессию гостевого голоса', () => {
    // Ловит голос, который сам возвращается после выхода из комнаты другого инстанса.
    const f = storeFixture();
    f.set({ voice: voice() });
    f.get().leaveVoice();
    assert.deepEqual(f.cleared, ['guest']);
    assert.equal(f.get().voice, null);
    assert.equal(f.get().voiceState, 'disconnected');
  });
});

it('фоновый шлюз передаёт перемещение и закрытие сервера с id собственной записи', async () => {
  // Ловит применение гостевого события к домашнему голосу и потерю событий после отписки/смены шлюза.
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onmessage: ((e: { data: string }) => void) | null = null;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(public url: string) { sockets.push(this); }
    send() {}
    close() { this.readyState = 3; }
  }
  const mod = load<typeof import('./bgGateways')>('bgGateways.ts', {
    '@gusvoice/shared': { CAP_CONV1: 'conv1', mentionsMe: () => false }, './socketHealth': { PING_MS: 30_000, socketStale: () => false },
    './config': { instances: () => [{ id: 'home', apiUrl: 'https://home.test', token: 'h' }, { id: 'guest', apiUrl: 'https://guest.test', token: 'g' }], rememberInstanceServers: () => {} },
  }, { WebSocket: FakeSocket, fetch: async (url: string) => Response.json(url.endsWith('/unread') ? { servers: {}, dms: 0 } : { username: 'me' }) });
  const events: import('./bgGateways').BgVoiceEvent[] = [];
  const unsub = mod.onBgVoiceEvent((e) => events.push(e));
  try {
    mod.syncBgGateways(null);
    for (let i = 0; i < 20 && sockets.length !== 2; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sockets.length, 2);
    const home = sockets.find((s) => s.url.includes('home.test'))!;
    const guest = sockets.find((s) => s.url.includes('guest.test'))!;
    home.onmessage!({ data: JSON.stringify({ t: 'voice.move', channelId: 'hc' }) });
    guest.onmessage!({ data: JSON.stringify({ t: 'server.access_closed', serverId: 'gs' }) });
    assert.deepEqual(events.map((e) => [e.instanceId, e.msg.t]), [['home', 'voice.move'], ['guest', 'server.access_closed']]);
    unsub();
    guest.onmessage!({ data: JSON.stringify({ t: 'voice.move', channelId: 'gc' }) });
    assert.equal(events.length, 2);
  } finally { unsub(); mod.stopBgGateways(); }
});

function bgConvContract(text: string): void {
  const ast = ts.createSourceFile('bgGateways.ts', text, ts.ScriptTarget.Latest, true);
  let identifies = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
      assert.notEqual(node.expression.text, 'dm.create', 'старого события ЛС в шлюзе нет');
    }
    if (ts.isObjectLiteralExpression(node) && node.properties.some(p =>
      ts.isPropertyAssignment(p) && p.name.getText(ast) === 't' &&
      ts.isStringLiteral(p.initializer) && p.initializer.text === 'identify')) {
      identifies++;
      const caps = node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'caps');
      assert.ok(caps && ts.isPropertyAssignment(caps) && ts.isArrayLiteralExpression(caps.initializer), 'identify объявляет caps');
      assert.deepEqual(caps.initializer.elements.map(e => e.getText(ast)), ['CAP_CONV1']);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(identifies, 1, 'проверен настоящий identify фонового шлюза');
}

async function withBgConv(run: (mod: typeof import('./bgGateways'), socket: FakeBgConvSocket) => void,
  mutate?: (s: string) => string): Promise<void> {
  const sockets: FakeBgConvSocket[] = [];
  class Socket extends FakeBgConvSocket {
    constructor(url: string) { super(url); sockets.push(this); }
  }
  const mod = load<typeof import('./bgGateways')>('bgGateways.ts', {
    '@gusvoice/shared': { CAP_CONV1: 'conv1', mentionsMe: () => false },
    './socketHealth': { PING_MS: 30_000, socketStale: () => false },
    './config': { instances: () => [{ id: 'background', apiUrl: 'https://background.test', token: 'test-token' }], rememberInstanceServers: () => {} },
  }, {
    WebSocket: Socket,
    fetch: async (url: string) => Response.json(url.endsWith('/unread') ? { servers: {}, dms: 4 } : url.endsWith('/servers') ? [] : { username: 'local' }),
    setInterval: () => 1, clearInterval: () => {},
  }, mutate);
  try {
    mod.syncBgGateways(null);
    for (let i = 0; i < 20 && sockets.length === 0; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(sockets.length, 1, 'открыт фоновый сокет после HTTP-сводки');
    const socket = sockets[0];
    socket.onopen!();
    socket.receive({ t: 'ready', userId: 'local-id' });
    assert.equal(mod.bgUnread().background.dms, 4, 'начало не с нуля, а со сводки сервера');
    run(mod, socket);
  } finally { mod.stopBgGateways(); }
}

class FakeBgConvSocket {
  static OPEN = 1;
  readyState = 1;
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  frames: Record<string, unknown>[] = [];
  constructor(public url: string) {}
  send(data: string) { this.frames.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  receive(msg: object) { this.onmessage!({ data: JSON.stringify(msg) }); }
}

const foreignConvCreated = () => ({ t: 'conv.change', created: true, message: { author: { id: 'foreign-id' } } });

describe('R136 фоновые ЛС приходят только через conv.change', () => {
  it('identify объявляет conv1, старого dm.create нет даже при возврате мутантом', () => {
    // Без capability сервер продолжил бы слать событие, обработчика которого больше нет.
    const original = source('bgGateways.ts');
    bgConvContract(original);
    const noCaps = original.replace('caps: [CAP_CONV1]', '');
    assert.notEqual(noCaps, original);
    assert.throws(() => bgConvContract(noCaps), assert.AssertionError);
    const oldEvent = original.replace("case 'conv.change':", "case 'dm.create':\n      case 'conv.change':");
    assert.notEqual(oldEvent, original);
    assert.throws(() => bgConvContract(oldEvent), assert.AssertionError);
  });

  it('новое чужое сообщение увеличивает фоновый счётчик ровно на один', async () => {
    // Парный принимаемый путь исключает шлюз, который молча отвергает все события.
    await withBgConv((mod, socket) => {
      assert.deepEqual(socket.frames[0], { t: 'identify', token: 'test-token', caps: ['conv1'] });
      socket.receive(foreignConvCreated());
      assert.equal(mod.bgUnread().background.dms, 5);
      assert.deepEqual(Object.keys(mod.bgUnread().background.servers), []);
    });
  });

  it('своё сообщение определяется по ready и не увеличивает счётчик', async () => {
    // Ник из auth/me не заменяет id текущего автора, присланный шлюзом.
    await withBgConv((mod, socket) => {
      socket.receive({ ...foreignConvCreated(), message: { author: { id: 'local-id' } } });
      assert.equal(mod.bgUnread().background.dms, 4);
    });
  });

  it('правка без created и created:false не выдаются за новое сообщение', async () => {
    // Редактирование не должно каждый раз зажигать новый непрочитанный значок.
    await withBgConv((mod, socket) => {
      socket.receive({ t: 'conv.change', message: foreignConvCreated().message });
      socket.receive({ ...foreignConvCreated(), created: false });
      assert.equal(mod.bgUnread().background.dms, 4);
    });
  });

  it('надгробие сообщения не увеличивает счётчик и не требует author', async () => {
    // ConvGone не содержит автора: проверка gone обязана предшествовать чтению author.id.
    await withBgConv((mod, socket) => {
      socket.receive({ ...foreignConvCreated(), message: { gone: true } });
      socket.receive({ ...foreignConvCreated(), message: { gone: false } });
      assert.equal(mod.bgUnread().background.dms, 4);
    });
  });

  it('сводка беседы без message не увеличивает счётчик даже при created', async () => {
    // Изменение метаданных беседы не равно получению текста от собеседника.
    await withBgConv((mod, socket) => {
      socket.receive({ t: 'conv.change', conversation: { id: 'conversation' } });
      socket.receive({ t: 'conv.change', created: true, conversation: { id: 'conversation' } });
      assert.equal(mod.bgUnread().background.dms, 4);
    });
  });

  it('мутанты без created, авторского фильтра и gone нарушают тот же счётчик', async () => {
    // Каждый контрфакт проверяется тем же наблюдением на оригинале, а не наличием строки.
    const cases = [
      { before: '!msg.created || ', after: '', msg: { t: 'conv.change', message: foreignConvCreated().message } },
      { before: 'if (link.userId && msg.message.author.id === link.userId) return;', after: '', msg: { ...foreignConvCreated(), message: { author: { id: 'local-id' } } } },
      { before: " || 'gone' in msg.message", after: '', msg: { ...foreignConvCreated(), message: { gone: true, author: { id: 'foreign-id' } } } },
    ];
    for (const c of cases) {
      const verify = (mod: typeof import('./bgGateways'), socket: FakeBgConvSocket) => {
        socket.receive(c.msg);
        assert.equal(mod.bgUnread().background.dms, 4);
      };
      await withBgConv(verify);
      await assert.rejects(() => withBgConv(verify, s => {
        // Авторский фильтр есть и у канальных сообщений — меняем только conv.change.
        const start = s.indexOf("case 'conv.change':");
        assert.ok(start >= 0);
        const tail = s.slice(start);
        assert.ok(tail.includes(c.before), `найден мутируемый гейт ${c.before}`);
        return s.slice(0, start) + tail.replace(c.before, c.after);
      }), assert.AssertionError);
    }
  });
});

it('домашняя админка выбирает свой API без смены активного инстанса', () => {
  // Ловит отправку административного запроса гостевым ключом в соседний инстанс.
  let adminInstanceId: string | null = 'home';
  const api = {};
  const homeApi = {};
  const mod = load<typeof import('./adminApi')>('adminApi.ts', {
    './api': { api, apiFor: (id: string) => { assert.equal(id, 'home'); return homeApi; } },
    './store': { useStore: { getState: () => ({ adminInstanceId }) } },
  });
  assert.equal(mod.adminApi(), homeApi);
  adminInstanceId = null;
  assert.equal(mod.adminApi(), api);
});

function functionText(file: string, name: string): string {
  const parsed = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(found, `не найдена ${name} в ${file}`);
  return found.getText(parsed);
}

describe('проводка навигации без обрыва голоса', () => {
  it('все девять административных компонентов обращаются к adminApi и не импортируют активный api', () => {
    // Ловит один забытый административный запрос, ушедший к соседу вместо дома.
    for (const name of ['AdminPanel', 'AdminPeerGroups', 'FederationPanel', 'FederationReports', 'FederationAudit', 'InstanceSettingsForms', 'InstanceUpdateCard', 'SmtpForm', 'InstanceBanModal']) {
      const s = source(`components/${name}.tsx`);
      const js = ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
      assert.doesNotMatch(js, /require\(["']\.\.\/api["']\)/, name);
      assert.match(s, /adminApi\(\)/, name);
    }
  });

  it('открытие домашней админки не переключает инстанс, teardown оставляет голос и фоновые шлюзы', () => {
    // Ловит исходный вылет гостя из звонка по кнопке домашней админки.
    const open = functionText('instanceSwitch.ts', 'openOwnAdmin');
    assert.match(open, /setAdminOpen\(true, homeId\)/);
    assert.doesNotMatch(open, /switchInstance\s*\(/);
    const teardown = functionText('instanceSwitch.ts', 'teardownCurrent');
    assert.doesNotMatch(teardown, /(?:leaveVoice|stopBgGateways)\s*\(/);
    for (const stop of ['stopGameActivity', 'stopPushRegistration', 'disconnectSockets']) assert.ok(teardown.includes(`${stop}()`));
  });

  it('размонтирование главного экрана заканчивает живой голос, удаление записи делает это до её потери', () => {
    // Ловит микрофон-зомби и автоматическое переподключение после выхода из удалённого инстанса.
    assert.match(source('components/VoiceConnection.tsx'), /useEffect\(\s*\(\) => \(\) => \{\s*if \(useStore\.getState\(\)\.voice\) useStore\.getState\(\)\.leaveVoice\(\);\s*\},\s*\[\]/);
    const remove = functionText('components/InstancesPanel.tsx', 'remove');
    assert.match(remove, /i\.id === v\.instanceId && \(i\.id === inst\.id \|\| i\.guestOf === inst\.id\)/);
    const leave = remove.indexOf('leaveVoice()');
    assert.ok(leave >= 0 && leave < remove.indexOf('removeInstance(inst.id)'));
  });

  it('Loading не снимает комнату при переходе с действующим входом', () => {
    // Ловит размонтирование VoiceConnection на каждом клике по чужому серверу.
    assert.match(source('App.tsx'), /loading \|\| \(switching && !user\) \? \(\s*<div[^>]*>Loading/);
  });

  it('устаревший заход не поднимает кеш и не запускает серверы после перехода', () => {
    // Ловит позднюю запись кеша или bootstrap прежнего инстанса поверх нового.
    const mode = functionText('App.tsx', 'decideConvMode').replace(/\/\/[^\n]*/g, '');
    assert.match(mode, /await api[\s\S]*?\.catch\(\(\) => null\);\s*if \(stale\(\)\) return/);
    assert.match(mode, /await finishConvCacheWipes\(\);\s*if \(stale\(\)\) return/);
    assert.match(mode, /await readConvCache\(key\);\s*if \(stale\(\)\) return/);
    const boot = functionText('App.tsx', 'bootstrap');
    for (const call of ['decideConvMode(stale)', 'loadServers()', 'joinPendingInvite()']) {
      const at = boot.indexOf(`await ${call};`);
      assert.ok(at >= 0 && /^\s*if \(stale\(\)\) return/.test(boot.slice(at + `await ${call};`.length)), call);
    }
    assert.match(boot, /openServer\(pending\.serverId\)[\s\S]*?\.catch\(\(\) => \{\}\);\s*if \(stale\(\)\) return/);
    const app = source('App.tsx');
    const epoch = app.slice(app.indexOf('const stale = () => useStore.getState().instanceEpoch'), app.indexOf('}, [instanceEpoch])'));
    assert.match(epoch, /await loadMe\(\);\s*if \(stale\(\) \|\| state === 'stale'\) return/);
    assert.match(epoch, /await bootstrap\(stale\)/);
    assert.match(epoch, /if \(!stale\(\)\) \{\s*setLoading\(false\)/);
  });

  it('экранный шлюз не перемещает голос, принадлежащий другому инстансу', () => {
    // Ловит перехват гостевого звонка событием другого устройства домашней учётки.
    const s = source('sockets.ts');
    const handler = s.slice(s.indexOf("case 'voice.move':"), s.indexOf("case 'dm.channel':"));
    assert.match(handler, /if \(store\.voice && !voiceIsHere\(store\.voice\)\) return/);
    assert.ok(handler.indexOf('voiceIsHere') < handler.indexOf('.joinVoice('));
  });
});
