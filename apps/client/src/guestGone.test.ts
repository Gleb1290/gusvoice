import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as configRules from './configRules';
import * as logoutFamilyRules from './logoutFamilyRules';
import * as railRules from './railRules';
import type { Instance } from './configRules';
import type { RailPlace } from './railRules';

const source = readFileSync(new URL('./guestGone.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const entry = (id: string, patch: Partial<Instance> = {}): Instance => ({ id, name: id, order: 1,
  apiUrl: `https://api.${id}.example.test`, presenceWs: `wss://${id}.example.test`, token: 'fixture-token', ...patch });
const place = (patch: Partial<RailPlace> = {}): RailPlace => ({ instanceId: 'peer', name: 'Сосед', domain: 'peer.example.test',
  clientOrigin: 'https://peer.example.test', linkState: 'blocked', servers: [{ serverId: 'remote', name: 'Сервер', state: 'active', reason: null }], ...patch });

function fixture(raw = source, initial: Instance[] = [], initialActive = 'home') {
  let registry = initial.map((i) => ({ ...i })), active = initialActive;
  const events: string[] = [], errors: string[] = [], cleared: string[] = [], synced: (string | null)[] = [];
  const toasts: [string, string][] = [], updates: { id: string; patch: Partial<Instance> }[] = [];
  const requests: { url: string; init: RequestInit }[] = [], timeoutMs: number[] = [];
  const storage = new Map<string, string>([['setting@guest', 'one'], ['other@guest', 'two'], ['keep@guest-extra', 'three'], ['unscoped', 'four']]);
  let bgListener: ((homeId: string) => void) | undefined;
  const store: { voice: { instanceId: string } | null; leaveVoice(): void } = {
    voice: { instanceId: 'guest' }, leaveVoice() { events.push('leaveVoice'); store.voice = null; },
  };
  const dependencies: Record<string, unknown> = {
    './bgGateways': {
      clearBgUnread(id: string) { cleared.push(id); }, syncBgGateways(id: string | null) { synced.push(id); },
      onBgGuestLinks(fn: (homeId: string) => void) { if (bgListener) errors.push('повторная подписка bgGuestLinks'); bgListener = fn; },
    },
    './config': {
      instances: () => registry, activeInstanceId: () => active,
      removeInstance(id: string) { events.push(`remove:${id}`); registry = registry.filter((i) => i.id !== id); },
      updateInstance(id: string, patch: Partial<Instance>) {
        events.push(`update:${id}`); updates.push({ id, patch }); registry = registry.map((i) => i.id === id ? { ...i, ...patch } : i);
      },
    },
    './configRules': configRules,
    './instanceSwitch': { async switchInstance(id: string) { events.push(`switch:${id}`); active = id; } },
    './logoutFamilyRules': logoutFamilyRules,
    './railRules': railRules,
    './store': { useStore: { getState: () => store } },
    './toast': { toast(level: string, text: string) { toasts.push([level, text]); } },
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, TypeError,
    AbortSignal: { timeout(ms: number) { timeoutMs.push(ms); return { fixtureSignal: true }; } },
    localStorage: { get length() { return storage.size; }, key(i: number) { return [...storage.keys()][i] ?? null; }, removeItem(key: string) { storage.delete(key); } },
    fetch(url: string, init: RequestInit) {
      const guest = initial.find((i) => i.guestOf && `${i.apiUrl}/api/fed/guest-session/end` === url);
      // endGuestSessions ловит отказы fetch; ошибки границы копятся и проверяются СНАРУЖИ его catch.
      if (!guest || init.method !== 'POST' || init.keepalive !== true || (init.headers as Record<string, string>)?.Authorization !== `Bearer ${guest.token}`) errors.push(`неожиданный IO: ${url}`);
      requests.push({ url, init }); events.push(`fetch:${guest?.id ?? '?'}`);
      return new Promise(() => {}); // Мёртвый хост никогда не отвечает: локальная уборка всё равно должна завершиться.
    },
    require(id: string) { assert.ok(Object.prototype.hasOwnProperty.call(dependencies, id), `неожиданная зависимость ${id}`); return dependencies[id]; },
  });
  return { api: module.exports as typeof import('./guestGone'), events, toasts, updates, requests, timeoutMs, storage, cleared, synced,
    registry: () => registry, active: () => active,
    checkIo() { assert.equal(errors.join(';'), '', 'R234-guest-IO: неожиданные действия не проглочены catch'); assert.equal(typeof bgListener, 'function'); } };
}

function hostErrors(raw = source) {
  // Сетевой отказ разрешает локальный выход, но осмысленный отказ федерации/прав не должен маскироваться как «хост умер».
  const f = fixture(raw);
  assert.equal(f.api.hostSilent(new TypeError('fetch failed')), true, 'R234-host-type: TypeError означает сетевой отказ');
  for (const name of ['TimeoutError', 'AbortError']) assert.equal(f.api.hostSilent(Object.assign(new Error('timeout'), { name })), true);
  for (const code of ['HTTP 500', 'HTTP 502', 'HTTP 503', 'HTTP 599']) assert.equal(f.api.hostSilent(Object.assign(new Error(code), { code })), true, 'R234-host-5xx: прокси не достучался до хоста');
  for (const code of ['HTTP 403', 'HTTP 401', 'HTTP 404', 'HTTP 429', 'HTTP 499', 'HTTP 600', 'HTTP 5000', 'HTTP 50', 'xHTTP 500',
    'federation.trust_lost', 'federation.link_blocked', 'federation.anything']) assert.equal(f.api.hostSilent(Object.assign(new Error(code), { code })), false, 'R234-host-reply: ответ с отказом не молчание');
  for (const value of [null, undefined, '', 'HTTP 500', 500, new Error('fetch failed'), { name: 'TypeError' }, { code: 503 }]) assert.equal(f.api.hostSilent(value), false);
  f.checkIo(); assert.equal(f.requests.length, 0);
}
it('R234 hostSilent отличает типизированные сетевые ошибки и HTTP 5xx от отказов федерации и HTTP 4xx', () => hostErrors());

function dropGuests(raw = source) {
  // Дубли соседа после перепривязки ключа убираются все, но повторное событие не должно спамить тостами.
  const home = entry('home'), elsewhere = entry('other-home');
  const list = [home, elsewhere, entry('guest', { name: 'Сосед', guestOf: home.id, federationInstanceId: 'peer' }),
    entry('duplicate', { name: 'Сосед', guestOf: home.id, federationInstanceId: 'peer' }),
    entry('another', { name: 'Другой', guestOf: home.id, federationInstanceId: 'another-peer' }),
    entry('foreign', { name: 'Сосед', guestOf: elsewhere.id, federationInstanceId: 'peer' })];
  const places = [place(), place({ instanceId: 'another-peer', name: 'Другой', linkState: 'unknown' })];
  const f = fixture(raw, list); let changes = 0;
  const unsubscribe = f.api.onGuestEntriesChanged(() => { changes++; });
  assert.equal(f.api.dropGoneGuests(home.id, places), 3);
  assert.equal(f.toasts.length, 2, 'R234-drop-toast: один тост на соседа, не на запись');
  assert.equal(f.toasts.map(([, text]) => text).sort().join('|'), 'Связь с «Другой» разорвана — его серверы убраны|Связь с «Сосед» разорвана — его серверы убраны');
  assert.equal(f.toasts.every(([level]) => level === 'info'), true);
  assert.equal(f.registry().map((i) => i.id).join(','), 'home,other-home,foreign', 'R234-drop-remove: удалённые гости исчезли из реестра');
  assert.deepEqual(f.cleared, ['guest', 'duplicate', 'another']); assert.deepEqual(f.synced, ['home', 'home', 'home']);
  assert.equal(f.events[0], 'leaveVoice');
  for (const id of ['guest', 'duplicate', 'another']) assert.equal(f.events.indexOf(`fetch:${id}`) < f.events.indexOf(`remove:${id}`), true);
  assert.deepEqual(f.timeoutMs, [8000, 8000, 8000]); assert.equal(f.requests.length, 3);
  assert.deepEqual([...f.storage.keys()], ['keep@guest-extra', 'unscoped']); assert.equal(changes, 1);
  assert.equal(f.api.dropGoneGuests(home.id, places), 0);
  assert.equal(f.toasts.length, 2); assert.equal(f.requests.length, 3); assert.equal(changes, 1);
  unsubscribe(); f.checkIo();
}
it('R234 dropGoneGuests идемпотентен, чистит запись/настройки/шлюз без ожидания хоста и сообщает один раз на соседа', () => dropGuests());

async function dismiss(raw = source, active = 'home') {
  // Скрытие хранится у дома: иначе место вернётся из его индекса сразу после удаления гостевой записи.
  const home = entry('home', { hiddenGuests: { older: ['previous-server'] } });
  const guest = entry('guest', { guestOf: home.id, federationInstanceId: 'peer', servers: [{ id: 'cached', name: 'Кеш' }] });
  const duplicate = entry('duplicate', { guestOf: home.id, domain: 'peer.example.test' });
  const foreign = entry('foreign', { guestOf: 'other-home', federationInstanceId: 'peer' });
  const f = fixture(raw, [home, guest, duplicate, entry('other-home'), foreign], active);
  let changes = 0; f.api.onGuestEntriesChanged(() => { changes++; });
  await f.api.dismissGuestGroup({ instanceId: guest.id, place: place() });
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0]!.id, home.id, 'R234-dismiss-home: hiddenGuests записан дому, не гостю');
  const hidden = f.registry().find((i) => i.id === home.id)!.hiddenGuests!;
  assert.equal(hidden.older?.join(','), 'previous-server', 'R234-dismiss-preserve: прежние скрытые соседи сохранены');
  assert.equal(hidden.peer?.join(','), 'remote');
  assert.equal(f.registry().map((i) => i.id).join(','), 'home,other-home,foreign');
  assert.equal(f.active(), 'home', 'R234-dismiss-switch: активный гость сначала возвращается домой');
  if (active === guest.id) {
    assert.equal(f.events.indexOf('switch:home') >= 0, true);
    assert.equal(f.events.indexOf('switch:home') < f.events.indexOf('remove:guest'), true);
  } else assert.equal(f.events.some((e) => e.startsWith('switch:')), false);
  assert.equal(changes, 1); assert.equal(f.toasts.length, 0); f.checkIo();
}
it('R234 dismissGuestGroup помечает место у дома, сохраняет другие скрытия и убирает дубли только своей семьи', () => dismiss());
it('R234 ручное удаление активного гостя сначала переключает домой и лишь затем стирает запись', () => dismiss(source, 'guest'));

it('R234 ручное скрытие работает без локального гостя и без места использует кеш серверов записи', async () => {
  // Вход с другого устройства оставляет только место; старая запись, наоборот, может ещё не иметь свежего места.
  const home = entry('home');
  const onlyPlace = fixture(source, [home]);
  await onlyPlace.api.dismissGuestGroup({ instanceId: null, place: place() });
  assert.equal(onlyPlace.updates[0]!.id, 'home'); assert.equal(onlyPlace.registry()[0]!.hiddenGuests?.peer?.join(','), 'remote');
  assert.equal(onlyPlace.requests.length, 0); onlyPlace.checkIo();
  const guest = entry('guest', { guestOf: 'home', federationInstanceId: 'peer', servers: [{ id: 'cached', name: 'Кеш' }] });
  const onlyEntry = fixture(source, [home, guest]);
  await onlyEntry.api.dismissGuestGroup({ instanceId: guest.id, place: null });
  assert.equal(onlyEntry.registry()[0]!.hiddenGuests?.peer?.join(','), 'cached'); assert.equal(onlyEntry.registry().length, 1); onlyEntry.checkIo();
});

it('R234 контрфакты локальной уборки и распознавания отказов ловятся целевыми host AssertionError', async () => {
  const mutants: [string, string, string, (raw: string) => void | Promise<void>, string, unknown, unknown][] = [
    ['сеть больше не считается молчанием', 'if (e instanceof TypeError) return true;', 'if (e instanceof TypeError) return false;', hostErrors, 'R234-host-type:', false, true],
    ['5xx больше не считается молчанием', '/^HTTP 5\\d\\d$/', '/^HTTP 6\\d\\d$/', hostErrors, 'R234-host-5xx:', false, true],
    ['любой HTTP отказ объявлен молчанием', '/^HTTP 5\\d\\d$/', '/^HTTP \\d\\d\\d$/', hostErrors, 'R234-host-reply:', true, false],
    ['тост на каждую запись', 'for (const title of titles) toast(', 'for (const { title } of gone) toast(', dropGuests, 'R234-drop-toast:', 3, 2],
    ['запись не удаляется', 'removeInstance(entry.id);', '', dropGuests, 'R234-drop-remove:', 'home,other-home,guest,duplicate,another,foreign', 'home,other-home,foreign'],
    ['скрытие записано гостю', 'updateInstance(home.id, { hiddenGuests:', 'updateInstance(entry?.id ?? home.id, { hiddenGuests:', dismiss, 'R234-dismiss-home:', 'guest', 'home'],
    ['прежние скрытия затёрты', '...(home.hiddenGuests ?? {})', '...{}', dismiss, 'R234-dismiss-preserve:', undefined, 'previous-server'],
    ['открытый гость удаляется без возврата домой', 'if (home && entries.some((e) => e.id === active)) await switchInstance(home.id);', '',
      (raw) => dismiss(raw, 'guest'), 'R234-dismiss-switch:', 'guest', 'home'],
  ];
  for (const [label, from, to, check, prefix, actual, expected] of mutants) {
    await check(source); assert.equal(source.split(from).length - 1, 1, label);
    await assert.rejects(async () => check(source.replace(from, to)), e => e instanceof assert.AssertionError
      && e.message.startsWith(prefix) && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected, label);
  }
});
