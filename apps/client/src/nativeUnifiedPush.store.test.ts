import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Push = typeof import('./nativeUnifiedPush');
type Bridge = Record<string, (...args: any[]) => any>;
const source = readFileSync(new URL('./nativeUnifiedPush.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const compile = (raw: string) => ts.transpileModule(raw, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function pure(name: string) {
  const module = { exports: {} };
  runInNewContext(compile(readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8')), { module, exports: module.exports });
  return module.exports;
}
const pathRules = pure('pushPathRules');
const keyRules = pure('pushKeys');

function fixture(options: { android?: boolean; noBridge?: boolean; token?: string | null; methods?: Bridge; raw?: string;
  gateway?: string; rejectRegister?: boolean } = {}) {
  const calls: string[] = [];
  const registrations: unknown[][] = [];
  const unregistrations: string[] = [];
  const authSync: string[] = [];
  const storage = new Map<string, string>();
  const intervals = new Map<number, () => void>();
  const visibility: Array<() => void> = [];
  let serial = 0;
  let endpoint = '';
  let token = options.token === undefined ? 'test-session' : options.token;
  const b: Bridge = {
    registerForPush: () => calls.push('external.start'), getPushEndpoint: () => { calls.push('external.read'); return endpoint; },
    unregisterPush: () => calls.push('external.stop'), hasPushDistributor: () => true,
    storePushAvailable: () => true, storePushStart: () => calls.push('store.start'),
    storePushEndpoint: () => { calls.push('store.read'); return endpoint; }, storePushStop: () => calls.push('store.stop'),
    enableEmbeddedPush: (base: string) => { calls.push(`embedded.start:${base}`); return endpoint; },
    disableEmbeddedPush: () => calls.push('embedded.stop'), embeddedPushAllowed: () => true,
    pushKeys: () => '{"p256dh":"test-public-key","auth":"test-auth-salt"}',
    notifCaps: () => '["read1","reply1",17]',
    setNotifAuth: (json: string) => authSync.push(json),
    ...options.methods,
  };
  const nativeWindow = {
    GusVoiceNative: options.noBridge ? undefined : b,
    setInterval: (callback: () => void, delay: number) => { assert.equal(delay, 1000); intervals.set(++serial, callback); return serial; },
    clearInterval: (id: number) => intervals.delete(id),
    __gvPushEndpointChanged: undefined as (() => void) | undefined,
  };
  const deps: Record<string, unknown> = {
    './api': { getToken: () => token, deviceTimeZone: () => 'Europe/Moscow', api: {
      registerPush: (...args: unknown[]) => { registrations.push(args); return options.rejectRegister ? Promise.reject(Error('temporary failure')) : Promise.resolve(); },
      unregisterPush: (device: string) => { unregistrations.push(device); return Promise.resolve(); },
    } },
    './config': { config: { pushGateway: options.gateway ?? 'https://ntfy.example' }, activeInstanceId: () => 'home', instances: () => [] },
    './hotkeys': { isAndroid: () => options.android !== false }, './pushKeys': keyRules, './pushPathRules': pathRules,
  };
  for (const name of ['./instanceSwitch', './pendingOpen', './sockets', './callStore', './store', './deepLinkInvite']) {
    deps[name] = new Proxy({}, { get: (_, property) => { throw Error(`Неожиданная граница ${name}.${String(property)}`); } });
  }
  const module = { exports: {} };
  runInNewContext(compile(options.raw ?? source), {
    module, exports: module.exports, window: nativeWindow,
    document: { addEventListener: (event: string, callback: () => void) => { assert.equal(event, 'visibilitychange'); visibility.push(callback); }, visibilityState: 'visible' },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    Date: class extends Date { static now() { return 1_800_000_000_000; } },
    console: { warn() {} },
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `описанный импорт ${id}`); return deps[id]; },
  });
  return { api: module.exports as Push, calls, registrations, unregistrations, authSync, storage, intervals, nativeWindow,
    endpoint: (value: string) => { endpoint = value; }, token: (value: string | null) => { token = value; },
    tick: () => { for (const callback of [...intervals.values()]) callback(); } };
}

function storeRegistration(raw = source) {
  const f = fixture({ raw });
  f.api.startPushRegistration();
  assert.deepEqual(f.calls, ['store.start'], 'R330:стартует-только-магазин');
  f.api.startPushRegistration();
  assert.equal(f.intervals.size, 1, 'повторный старт не умножает опрос');
  f.tick();
  assert.equal(f.registrations.length, 0, 'пустой токен FCM ещё не регистрируется');
  f.endpoint('https://api.example/api/push/fcm/test-token');
  f.tick();
  assert.equal(f.intervals.size, 0, 'полученный endpoint останавливает опрос');
  assert.equal(f.registrations.length, 1, 'R330:магазин-регистрирует-endpoint');
  const device = f.storage.get('gv_push_device_id');
  assert.match(device!, /^and-/);
  assert.equal(JSON.stringify(f.registrations[0]), JSON.stringify([
    'https://api.example/api/push/fcm/test-token', device,
    { p256dh: 'test-public-key', auth: 'test-auth-salt' }, ['read1', 'reply1'], 'Europe/Moscow',
  ]), 'R330:ключи-признаки-часовой-пояс');
  assert.equal(f.calls.includes('external.read'), false);
  f.api.startPushRegistration();
  assert.equal(f.registrations.length, 1, 'готовая регистрация идемпотентна');
  return f;
}

it('R330 магазин запускается первым и после опроса передаёт endpoint, ключи, caps и часовой пояс', () => { storeRegistration(); });

function stopStore(raw = source) {
  const f = storeRegistration(raw);
  f.api.stopPushRegistration();
  assert.equal(f.calls.filter(c => c === 'store.stop').length, 1, 'R330:магазин-остановлен');
  assert.deepEqual(f.unregistrations, [f.storage.get('gv_push_device_id')]);
}
it('R330 выход отзывает пуш магазина и ту же запись устройства на сервере', () => stopStore());

function changedEndpoint(raw = source) {
  const f = fixture({ raw });
  f.api.initPushRegistration();
  assert.equal(typeof f.nativeWindow.__gvPushEndpointChanged, 'function');
  const authBefore = f.authSync.length;
  f.nativeWindow.__gvPushEndpointChanged!();
  assert.equal(f.authSync.length, authBefore, 'R330:смена-во-время-опроса-не-синхронизирует-авторизацию');
  assert.equal(f.calls.filter(c => c === 'store.start').length, 1, 'R330:смена-во-время-опроса-не-стартует-второй');
  assert.equal(f.intervals.size, 1);
  f.endpoint('https://api.example/api/push/fcm/old'); f.tick();
  f.endpoint('https://api.example/api/push/fcm/new');
  f.nativeWindow.__gvPushEndpointChanged!();
  assert.equal(f.calls.filter(c => c === 'store.start').length, 2, 'R330:смена-после-опроса-перезапускает');
  f.tick();
  assert.deepEqual(f.registrations.map(args => args[0]), [
    'https://api.example/api/push/fcm/old', 'https://api.example/api/push/fcm/new',
  ], 'R330:смена-перерегистрирует-новый-адрес');
  assert.equal(f.registrations[0]![1], f.registrations[1]![1], 'устройство не размножается при ротации токена');
}
it('R330 событие смены endpoint игнорируется при опросе, но перерегистрирует устройство после него', () => changedEndpoint());

it('R330 признак магазина false без Android, моста, методов или при исключении; исправный мост даёт true', () => {
  assert.equal(fixture().api.storePushActive(), true);
  for (const options of [
    { android: false }, { noBridge: true }, { methods: { storePushAvailable: undefined } },
    { methods: { storePushEndpoint: undefined } }, { methods: { storePushAvailable: () => false } },
    { methods: { storePushAvailable: () => { throw Error('bridge unavailable'); } } },
    { methods: { storePushAvailable: () => 'true' } },
  ]) assert.equal(fixture(options as Parameters<typeof fixture>[0]).api.storePushActive(), false);
});

it('R330 старый APK выбирает встроенный путь без embeddedPushAllowed, запрет Play и отсутствие шлюза сохраняют внешний путь', () => {
  const old = { storePushAvailable: undefined, storePushEndpoint: undefined, embeddedPushAllowed: undefined } as unknown as Bridge;
  for (const allowed of [undefined, () => true, () => { throw Error('old bridge'); }]) {
    const f = fixture({ methods: { ...old, embeddedPushAllowed: allowed } as unknown as Bridge });
    f.endpoint('https://ntfy.example/embedded'); f.api.startPushRegistration();
    assert.deepEqual(f.calls, ['embedded.start:https://ntfy.example']);
    assert.equal(f.registrations[0]![0], 'https://ntfy.example/embedded');
    assert.equal(f.intervals.size, 0);
  }
  for (const options of [
    { methods: { ...old, embeddedPushAllowed: () => false } },
    { methods: { ...old, enableEmbeddedPush: undefined } },
    { methods: old, gateway: '' },
  ]) {
    const f = fixture(options as Parameters<typeof fixture>[0]);
    f.api.startPushRegistration(); assert.deepEqual(f.calls, ['external.start']);
    f.endpoint('https://ntfy.example/external'); f.tick();
    assert.equal(f.registrations[0]![0], 'https://ntfy.example/external');
    assert.equal(f.calls.includes('store.start'), false);
  }
});

it('R330 без входа старт молчит, опрос не регистрирует после выхода, 20-я попытка завершает ожидание и разрешает повтор', () => {
  const anonymous = fixture({ token: null }); anonymous.api.startPushRegistration();
  assert.deepEqual(anonymous.calls, []); assert.equal(anonymous.intervals.size, 0);
  const f = fixture(); f.api.startPushRegistration(); f.endpoint('https://api.example/api/push/fcm/token'); f.token(null);
  for (let n = 0; n < 19; n++) f.tick();
  assert.equal(f.intervals.size, 1, '19-я попытка ещё ждёт'); assert.equal(f.registrations.length, 0);
  f.tick(); assert.equal(f.intervals.size, 0, '20-я попытка завершает ожидание');
  f.token('test-session'); f.api.startPushRegistration(); f.tick(); assert.equal(f.registrations.length, 1);
});

it('R330 временный отказ серверной регистрации разрешает следующую попытку', async () => {
  const f = fixture({ rejectRegister: true }); f.endpoint('https://api.example/api/push/fcm/token');
  f.api.startPushRegistration(); f.tick(); await Promise.resolve();
  f.api.startPushRegistration(); f.tick(); assert.equal(f.registrations.length, 2);
});

it('R330 старый мост без ключей и caps либо с повреждённым ответом сохраняет регистрацию магазина без метаданных', () => {
  for (const methods of [
    { pushKeys: undefined, notifCaps: undefined },
    { pushKeys: () => '{', notifCaps: () => 'not-json' },
    { pushKeys: () => { throw Error('bridge'); }, notifCaps: () => { throw Error('bridge'); } },
  ]) {
    const f = fixture({ methods: methods as unknown as Bridge });
    f.endpoint('https://api.example/api/push/fcm/token'); f.api.startPushRegistration(); f.tick();
    assert.equal(f.registrations.length, 1);
    assert.equal(f.registrations[0]![2], null);
    assert.equal(f.registrations[0]![3], undefined);
    assert.equal(f.registrations[0]![4], 'Europe/Moscow');
  }
});

it('R330 исключение запуска магазина и временно недоступный endpoint не ломают последующий опрос', () => {
  let reads = 0;
  const f = fixture({ methods: {
    storePushStart: () => { throw Error('bridge not ready'); },
    storePushEndpoint: () => { if (++reads === 1) throw Error('prefs not ready'); return 'https://api.example/api/push/fcm/token'; },
  } });
  f.api.startPushRegistration(); f.tick();
  assert.equal(f.registrations.length, 0); assert.equal(f.intervals.size, 1);
  f.tick(); assert.equal(f.registrations.length, 1); assert.equal(f.intervals.size, 0);
});

for (const [name, before, after, scenario, address] of [
  ['потерян старт FCM', 'b.storePushStart?.();', '/* lost start */', storeRegistration, 'R330:стартует-только-магазин'],
  ['потерян сброс при смене', '    registered = false;\n    startPushRegistration();', '    startPushRegistration();', changedEndpoint, 'R330:смена-после-опроса-перезапускает'],
  ['потерян отзыв FCM', 'b.storePushStop?.();', '/* lost stop */', stopStore, 'R330:магазин-остановлен'],
  ['событие вмешивается в опрос', '    if (inFlight) return; // идёт опрос — он и заберёт новый адрес', '    /* lost in-flight guard */', changedEndpoint,
    'R330:смена-во-время-опроса-не-синхронизирует-авторизацию'],
] as const) {
  it(`R330 контрфакт «${name}» ловится поведением целого модуля`, () => {
    scenario(); counterfact(() => {
      assert.equal(source.split(before).length - 1, 1);
      assert.throws(() => scenario(source.replace(before, after)), error => error instanceof assert.AssertionError
        && error.message.startsWith(address));
    });
  });
}
