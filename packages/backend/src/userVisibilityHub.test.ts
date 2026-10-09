import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { GatewayServerMessage } from '@gusvoice/shared';
import { aboutUserSteps, mayObserveUser, membershipDiff, visibleOnline } from './gatewayRules.js';
import { createUserVisibilityHub, type HubConn } from './userVisibilityHub.js';
import { statusSeenBy } from './statusRules.js';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as gatewayRules from './gatewayRules.js';

function loadPresence5(from?: string, to?: string): typeof createUserVisibilityHub {
  let source = readFileSync(new URL('./userVisibilityHub.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (from) { assert.equal(source.split(from).length, 2, 'якорь presence5 уникален'); const changed = source.replace(from, to!); assert.notEqual(changed, source); source = changed; }
  const module = { exports: {} as { createUserVisibilityHub: typeof createUserVisibilityHub } };
  const deps: Record<string, unknown> = { '@gusvoice/shared': shared, './gatewayRules.js': gatewayRules };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, setTimeout, clearTimeout, require: (id: string) => { assert.ok(id in deps); return deps[id]; } });
  return module.exports.createUserVisibilityHub;
}
async function checkPresence5(make: typeof createUserVisibilityHub) {
  const sent: { name: string; data: string }[] = [];
  const hub = make<Conn>({ loadPeers: async () => new Set(['subject', 'peer']), now: () => 0, superAdminId: () => 'admin', send: (c, data) => sent.push({ name: c.name, data }) });
  const caps = new Set([shared.FEATURE_PRESENCE5]);
  const conns: Conn[] = [{ name: 'self', userId: 'subject', caps }, { name: 'new', userId: 'peer', caps }, { name: 'old', userId: 'peer' },
    { name: 'stranger', userId: 'stranger', caps }, { name: 'admin', userId: 'admin', caps }];
  for (const c of conns) hub.attach(c, c.userId!);
  hub.goOnline('subject'); hub.goOnline('peer');
  assert.equal(hub.setDmAway('subject', true), true); assert.equal(hub.setDmAway('subject', true), false);
  await hub.peersOf('subject'); await Promise.resolve();
  assert.deepEqual(sent.map(row => row.name), ['new', 'admin'], 'away только новым соседям и не самому');
  for (const row of sent) assert.deepEqual(JSON.parse(row.data), { t: 'online.away', userId: 'subject', away: true });
  sent.length = 0; await hub.sendOnlineSnapshot(conns[1]!); await hub.sendOnlineSnapshot(conns[2]!);
  assert.deepEqual(JSON.parse(sent[0]!.data), { t: 'online.snapshot', users: ['subject', 'peer'], dmAway: ['subject'] }, 'новый снимок включает dmAway');
  assert.equal(sent[1]!.data, '{"t":"online.snapshot","users":["subject","peer"]}', 'старый снимок байт в байт прежний');
  sent.length = 0; hub.setDmAway('subject', false); hub.setDmAway('subject', false); await Promise.resolve(); await Promise.resolve();
  assert.equal(hub.isDmAway('subject'), false); assert.equal(sent.length, 2, 'возврат доставляется один раз каждому новому наблюдателю');
}
it('presence5: away фильтруется по праву, caps и владельцу, снимок совместим со старым', async () => { await checkPresence5(createUserVisibilityHub); await checkPresence5(loadPresence5()); });
for (const [name, from, to, failure] of [
  ['нет фильтра возможностей', 'for (const c of set) if (c.caps?.has(FEATURE_PRESENCE5)) send(c, data);', 'for (const c of set) send(c, data);', 'away только новым'],
  ['событие своему соединению', 'if (uid === subjectId || !mayObserveUser(uid, subjectId, peers, su)) continue;\n        for (const c of set) if (c.caps?.has(FEATURE_PRESENCE5))', 'if (!mayObserveUser(uid, subjectId, peers, su)) continue;\n        for (const c of set) if (c.caps?.has(FEATURE_PRESENCE5))', 'away только новым'],
  ['dmAway старому клиенту', 'const dmAwayIds = conn.caps?.has(FEATURE_PRESENCE5)', 'const dmAwayIds = true', 'старый снимок байт'],
]) it(`presence5: исходниковый мутант «${name}» пойман`, async () => { await checkPresence5(loadPresence5()); await assert.rejects(() => checkPresence5(loadPresence5(from, to)), (error: unknown) => error instanceof assert.AssertionError && error.message.includes(failure!)); });

interface Conn extends HubConn {
  name: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const activity = (userId: string): GatewayServerMessage => ({ t: 'user.activity', userId, activity: null });

describe('хаб видимости пользователей (#143)', () => {
  it('attach и detach адресуют все сокеты человека и убирают только закрытый', () => {
    // Ловит потерю второй вкладки при закрытии первой и оставшийся в адресной рассылке мёртвый сокет.
    const hub = createUserVisibilityHub<Conn>({ loadPeers: async () => new Set(), now: () => 0, superAdminId: () => null, send: () => undefined });
    const one: Conn = { name: 'one', userId: 'u' };
    const two: Conn = { name: 'two', userId: 'u' };
    hub.attach(one, 'u');
    hub.attach(two, 'u');
    assert.deepEqual([...hub.connsOf('u')], [one, two]);
    hub.detach(one);
    assert.deepEqual([...hub.connsOf('u')], [two]);
    hub.detach(two);
    assert.deepEqual([...hub.connsOf('u')], []);
  });

  it('событие о человеке получают он сам, его соседи и супер-админ, но не посторонний', async () => {
    // Ловит утечку статуса между несвязанными сообществами и потерю служебной видимости владельца.
    const sent: string[] = [];
    const hub = createUserVisibilityHub<Conn>({
      loadPeers: async (id) => (id === 'subject' ? new Set(['server-peer', 'dm-peer']) : new Set()),
      now: () => 0,
      superAdminId: () => 'admin',
      send: (conn) => sent.push(conn.name),
    });
    for (const conn of [
      { name: 'self', userId: 'subject' },
      { name: 'server', userId: 'server-peer' },
      { name: 'dm', userId: 'dm-peer' },
      { name: 'stranger', userId: 'stranger' },
      { name: 'admin', userId: 'admin' },
    ]) hub.attach(conn, conn.userId);

    hub.deliverAboutUser('subject', activity('subject'));
    await hub.peersOf('subject');
    await Promise.resolve();
    assert.deepEqual(sent.sort(), ['admin', 'dm', 'self', 'server']);
  });

  it('два события за одним незавершённым запросом используют один promise и доходят по порядку', async () => {
    // Ловит второй запрос после формального TTL: быстрый ответ B не должен обогнать старое событие A.
    const loading = deferred<Set<string>>();
    let loads = 0;
    const sent: string[] = [];
    const peer: Conn = { name: 'peer', userId: 'peer' };
    const hub = createUserVisibilityHub<Conn>({
      loadPeers: async () => {
        loads += 1;
        return loading.promise;
      },
      now: () => 100_000,
      superAdminId: () => null,
      send: (_conn, data) => sent.push(JSON.parse(data).userId),
      peersTtlMs: 1,
    });
    hub.attach(peer, 'peer');

    hub.deliverAboutUser('subject', activity('first'));
    hub.deliverAboutUser('subject', activity('second'));
    assert.equal(loads, 1);
    const delivered = hub.peersOf('subject');
    loading.resolve(new Set(['peer']));
    await delivered;
    assert.deepEqual(sent, ['first', 'second']);
  });

  it('TTL начинается с ответа базы, а не с запуска запроса', async () => {
    // Ловит мгновенно протухший ответ после долгого запроса и лишнее повторное чтение базы.
    let now = 0;
    let loads = 0;
    const first = deferred<Set<string>>();
    const hub = createUserVisibilityHub<Conn>({
      loadPeers: async () => {
        loads += 1;
        return loads === 1 ? first.promise : new Set(['fresh']);
      },
      now: () => now,
      superAdminId: () => null,
      send: () => undefined,
      peersTtlMs: 10,
    });

    const pending = hub.peersOf('u');
    now = 100;
    assert.equal(hub.peersOf('u'), pending);
    first.resolve(new Set(['old']));
    await pending;
    now = 109;
    assert.equal(await hub.peersOf('u'), await pending);
    assert.equal(loads, 1);
    now = 110;
    assert.deepEqual(await hub.peersOf('u'), new Set(['fresh']));
    assert.equal(loads, 2);
  });

  it('ошибка загрузки даёт пустой набор и следующая попытка снова идёт в базу', async () => {
    // Ловит кэширование аварии на весь TTL, из-за которого человек надолго становился невидимым.
    let loads = 0;
    const hub = createUserVisibilityHub<Conn>({
      loadPeers: async () => {
        loads += 1;
        if (loads === 1) throw new Error('db down');
        return new Set(['peer']);
      },
      now: () => 0,
      superAdminId: () => null,
      send: () => undefined,
    });
    assert.deepEqual(await hub.peersOf('u'), new Set());
    assert.deepEqual(await hub.peersOf('u'), new Set(['peer']));
    assert.equal(loads, 2);
  });

  it('зависшая загрузка завершается пустым набором и не блокирует новую попытку', async () => {
    // Ловит вечное ожидание рассылки из-за одного зависшего запроса к базе.
    let loads = 0;
    const never = new Promise<Set<string>>(() => undefined);
    const hub = createUserVisibilityHub<Conn>({
      loadPeers: async () => {
        loads += 1;
        return loads === 1 ? never : new Set(['peer']);
      },
      now: () => 0,
      superAdminId: () => null,
      send: () => undefined,
      peersLoadTimeoutMs: 5,
    });
    assert.deepEqual(await hub.peersOf('u'), new Set());
    assert.deepEqual(await hub.peersOf('u'), new Set(['peer']));
    assert.equal(loads, 2);
  });

  it('лимит кэша выкидывает ответившие записи, но не ломает порядок ожидающих', async () => {
    // Ловит удаление незавершённого promise при очистке кэша и повторную параллельную загрузку того же id.
    const waits = new Map<string, ReturnType<typeof deferred<Set<string>>>>();
    const calls = new Map<string, number>();
    const hub = createUserVisibilityHub<Conn>({
      loadPeers: async (id) => {
        calls.set(id, (calls.get(id) ?? 0) + 1);
        if (id === 'settled') return new Set([id]);
        const wait = deferred<Set<string>>();
        waits.set(`${id}:${calls.get(id)}`, wait);
        return wait.promise;
      },
      now: () => 0,
      superAdminId: () => null,
      send: () => undefined,
      peersCacheMax: 1,
    });
    const pending = hub.peersOf('pending');
    await hub.peersOf('settled');
    const newest = hub.peersOf('newest');
    assert.equal(hub.peersOf('pending'), pending);
    assert.equal(calls.get('pending'), 1);
    assert.deepEqual(await hub.peersOf('settled'), new Set(['settled']));
    assert.equal(calls.get('settled'), 2);
    waits.get('pending:1')?.resolve(new Set());
    waits.get('newest:1')?.resolve(new Set());
    await Promise.all([pending, newest]);
  });

  it('несколько сокетов держат человека онлайн до закрытия последнего', () => {
    // Ловит ложный offline при закрытии одной из нескольких вкладок человека.
    const hub = createUserVisibilityHub<Conn>({ loadPeers: async () => new Set(), now: () => 0, superAdminId: () => null, send: () => undefined });
    assert.equal(hub.goOnline('u'), true);
    assert.equal(hub.goOnline('u'), false);
    assert.equal(hub.isOnline('u'), true);
    assert.equal(hub.goOffline('u'), false);
    assert.equal(hub.isOnline('u'), true);
    assert.equal(hub.goOffline('u'), true);
    assert.equal(hub.isOnline('u'), false);
  });

  it('выход неизвестного человека не считается переходом в offline и не запускает рассылку', async () => {
    // Ловит ложный online.update=false из лишнего close для id, которого хаб не видел онлайн (#147).
    let loads = 0;
    let sends = 0;
    const peer: Conn = { name: 'peer', userId: 'peer' };
    const hub = createUserVisibilityHub<Conn>({
      loadPeers: async () => (loads += 1, new Set(['peer'])),
      now: () => 0,
      superAdminId: () => null,
      send: () => void (sends += 1),
    });
    hub.attach(peer, 'peer');

    const wentOffline = hub.goOffline('never-online');
    if (wentOffline) {
      hub.deliverAboutUser('never-online', activity('never-online'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.equal(wentOffline, false);
    assert.deepEqual({ loads, sends }, { loads: 0, sends: 0 });
  });

  it('снимок не уходит соединению, чей владелец сменился или исчез во время загрузки', async () => {
    // Ловит передачу снимка первого аккаунта второму после перелогина или уже закрытому сокету.
    const loading = deferred<Set<string>>();
    const changed: Conn = { name: 'changed', userId: 'first' };
    const closed: Conn = { name: 'closed', userId: 'first' };
    let sends = 0;
    const hub = createUserVisibilityHub<Conn>({ loadPeers: async () => loading.promise, now: () => 0, superAdminId: () => null, send: () => (sends += 1) });
    const jobs = [hub.sendOnlineSnapshot(changed), hub.sendOnlineSnapshot(closed)];
    changed.userId = 'second';
    closed.userId = null;
    loading.resolve(new Set());
    await Promise.all(jobs);
    assert.equal(sends, 0);
  });

  it('невидимый не светится соседям, смена видимости даёт только переходы online соседям', async () => {
    // Равенство статуса и офлайн-переходы не должны создавать шум; собственные устройства всегда знают реальный online.
    const sent: { name: string; message: GatewayServerMessage }[] = [];
    const peers = new Set(['hidden', 'friend', 'admin']);
    const hub = createUserVisibilityHub<Conn>({
      loadPeers: async (id) => (id === 'hidden' ? peers : new Set(['hidden'])),
      now: () => 0,
      superAdminId: () => 'admin',
      send: (conn, data) => sent.push({ name: conn.name, message: JSON.parse(data) as GatewayServerMessage }),
    });
    const conns: Conn[] = [
      { name: 'hidden-1', userId: 'hidden' },
      { name: 'hidden-2', userId: 'hidden' },
      { name: 'friend', userId: 'friend' },
      { name: 'admin', userId: 'admin' },
    ];
    for (const c of conns) hub.attach(c, c.userId!);
    hub.setInvisible('hidden', true);
    hub.goOnline('hidden');
    hub.goOnline('friend');
    hub.goOnline('admin');

    await hub.sendOnlineSnapshot(conns[2]!);
    await hub.sendOnlineSnapshot(conns[3]!);
    await hub.sendOnlineSnapshot(conns[0]!);
    assert.deepEqual(sent.splice(0).map(({ name, message }) => [name, message]), [
      ['friend', { t: 'online.snapshot', users: ['friend'] }],
      ['admin', { t: 'online.snapshot', users: ['friend', 'admin'] }],
      ['hidden-1', { t: 'online.snapshot', users: ['hidden', 'friend', 'admin'] }],
    ], 'чужие снимки исключают invisible и собственный включает владельца');

    hub.setInvisible('hidden', false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.splice(0).map(({ name, message }) => [name, message]), [
      ['friend', { t: 'online.update', userId: 'hidden', online: true }],
      ['admin', { t: 'online.update', userId: 'hidden', online: true }],
    ], 'выход из invisible сообщает о появлении только соседям');

    hub.setInvisible('hidden', true);
    hub.setInvisible('hidden', true);
    hub.deliverAboutUser('hidden', { t: 'online.update', userId: 'hidden', online: true });
    hub.deliverAboutUser('hidden', activity('hidden'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map(({ name, message }) => [name, message]), [
      ['friend', { t: 'online.update', userId: 'hidden', online: false }],
      ['admin', { t: 'online.update', userId: 'hidden', online: false }],
      ['hidden-1', { t: 'online.update', userId: 'hidden', online: true }],
      ['hidden-2', { t: 'online.update', userId: 'hidden', online: true }],
      ['hidden-1', { t: 'user.activity', userId: 'hidden', activity: null }],
      ['hidden-2', { t: 'user.activity', userId: 'hidden', activity: null }],
      ['friend', { t: 'user.activity', userId: 'hidden', activity: null }],
      ['admin', { t: 'user.activity', userId: 'hidden', activity: null }],
    ], 'online.update невидимого доходит только его устройствам, а activity — всем законным наблюдателям');
    sent.length = 0;

    hub.setInvisible('offline', true);
    hub.setInvisible('hidden', false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.splice(0).map(({ name, message }) => [name, message]), [
      ['friend', { t: 'online.update', userId: 'hidden', online: true }],
      ['admin', { t: 'online.update', userId: 'hidden', online: true }],
    ], 'невидимость снимается и онлайн-событие возникает ровно один раз');
    hub.setInvisible('hidden', true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.splice(0).map(({ name, message }) => [name, message]), [
      ['friend', { t: 'online.update', userId: 'hidden', online: false }],
      ['admin', { t: 'online.update', userId: 'hidden', online: false }],
    ], 'повторное включение переводит соседей в offline');
    hub.setInvisible('offline', true);
    hub.setInvisible('hidden', false);
    hub.setInvisible('hidden', false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map(({ name, message }) => [name, message]), [
      ['friend', { t: 'online.update', userId: 'hidden', online: true }],
      ['admin', { t: 'online.update', userId: 'hidden', online: true }],
    ], 'повторное значение не создаёт дополнительного события');
    assert.equal(hub.isInvisible('offline'), true, 'офлайн-статус запоминается без ложной рассылки');
    assert.equal(hub.isInvisible('hidden'), false, 'повторное значение остаётся идемпотентным');

    // Исполняем мутированные копии реальной фабрики: guards ниже должны отличать все три регрессии.
    const factorySource = createUserVisibilityHub.toString();
    const makeMutant = (source: string) => runInNewContext(`(${source})`, {
      __name: (fn: (...args: unknown[]) => unknown) => fn,
      withTimeout: <T>(promise: Promise<T>) => promise,
      DEFAULT_PEERS_TTL_MS: 60_000,
      DEFAULT_PEERS_LOAD_TIMEOUT_MS: 10_000,
      DEFAULT_PEERS_CACHE_MAX: 5_000,
      mayObserveUser,
      membershipDiff,
      visibleOnline,
    }) as typeof createUserVisibilityHub;
    const noOnlineCheckNeedle = 'if(online.has(userId))deliver(userId,{t:"online.update",userId,online:!value},"others")';
    assert.ok(factorySource.includes(noOnlineCheckNeedle), 'исходник мутанта должен совпадать с offline guard');
    const noOnlineCheckSource = factorySource.replace(noOnlineCheckNeedle, 'deliver(userId,{t:"online.update",userId,online:!value},"others")');
    const noOnlineCheck = makeMutant(noOnlineCheckSource);
    const offlineSent: string[] = [];
    const offlineMutantHub = noOnlineCheck<Conn>({
      loadPeers: async () => new Set(['observer']), now: () => 0, superAdminId: () => null,
      send: (conn) => offlineSent.push(conn.name),
    });
    offlineMutantHub.attach({ name: 'observer', userId: 'observer' }, 'observer');
    offlineMutantHub.setInvisible('offline', true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(offlineSent, ['observer'], 'мутант без online.has рассылает ложный offline о незашедшем человеке');

    const othersNeedle = 'deliver(userId,{t:"online.update",userId,online:!value},"others")';
    assert.ok(factorySource.includes(othersNeedle), 'исходник мутанта должен содержать рассылку только соседям');
    const allInsteadOfOthers = makeMutant(factorySource.replace(othersNeedle, 'deliver(userId,{t:"online.update",userId,online:!value},"all")'));
    const allSent: string[] = [];
    const allMutantHub = allInsteadOfOthers<Conn>({
      loadPeers: async () => new Set(['observer']), now: () => 0, superAdminId: () => null,
      send: (conn) => allSent.push(conn.name),
    });
    allMutantHub.attach({ name: 'subject', userId: 'subject' }, 'subject');
    allMutantHub.attach({ name: 'observer', userId: 'observer' }, 'observer');
    allMutantHub.goOnline('subject');
    allMutantHub.setInvisible('subject', true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(allSent.sort(), ['observer', 'subject'], 'мутант others→all шлёт переход самому владельцу');

    const deleteNeedle = 'else invisible.delete(userId)';
    assert.ok(factorySource.includes(deleteNeedle), 'исходник мутанта должен очищать флаг при возврате из invisible');
    const staleInvisible = makeMutant(factorySource.replace(deleteNeedle, 'else {}'));
    const staleHub = staleInvisible({
      loadPeers: async () => new Set(['observer']), now: () => 0, superAdminId: () => null, send: () => undefined,
    });
    staleHub.goOnline('subject');
    staleHub.setInvisible('subject', true);
    staleHub.setInvisible('subject', false);
    assert.equal(staleHub.isInvisible('subject'), true, 'мутант без delete оставляет человека скрытым после возврата в online');
  });

  it('user.status отдаёт invisible своим устройствам и online соседям, не маскируя остальные статусы', async () => {
    // REST и socket должны скрывать один и тот же privacy-state: супер-админ не становится исключением из правила.
    const sent: { name: string; message: GatewayServerMessage }[] = [];
    const hub = createUserVisibilityHub<Conn>({
      loadPeers: async () => new Set(['friend', 'admin']),
      now: () => 0,
      superAdminId: () => 'admin',
      send: (conn, data) => sent.push({ name: conn.name, message: JSON.parse(data) as GatewayServerMessage }),
    });
    for (const conn of [
      { name: 'hidden', userId: 'hidden' },
      { name: 'friend', userId: 'friend' },
      { name: 'admin', userId: 'admin' },
    ]) hub.attach(conn, conn.userId);
    const invisible: GatewayServerMessage = { t: 'user.status', userId: 'hidden', status: 'invisible', customStatus: null };
    hub.deliverAboutUser('hidden', invisible);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.splice(0).map(({ name, message }) => [name, message]), [
      ['hidden', invisible],
      ['friend', { ...invisible, status: 'online' }],
      ['admin', { ...invisible, status: 'online' }],
    ], 'только владелец видит invisible, включая служебного супер-админа');

    for (const status of ['online', 'dnd', 'away'] as const) {
      const message: GatewayServerMessage = { t: 'user.status', userId: 'hidden', status, customStatus: null };
      hub.deliverAboutUser('hidden', message);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(sent.splice(0).map(({ name, message: delivered }) => [name, delivered]), [
        ['hidden', message], ['friend', message], ['admin', message],
      ], `${status} остаётся неизменным для своих и соседей`);
    }

    // Мутации запускают настоящее тело фабрики с той же чистой зависимостью видимости.
    const source = aboutUserSteps.toString();
    const needle = 'status:statusSeenBy(msg.status,subjectId,null)';
    assert.ok(source.includes(needle), 'мутационный якорь должен совпадать с веткой приватного user.status');
    const makeMutant = (body: string) => runInNewContext(`(${createUserVisibilityHub.toString()})`, {
      __name: (fn: (...args: unknown[]) => unknown) => fn,
      withTimeout: <T>(promise: Promise<T>) => promise,
      DEFAULT_PEERS_TTL_MS: 60_000,
      DEFAULT_PEERS_LOAD_TIMEOUT_MS: 10_000,
      DEFAULT_PEERS_CACHE_MAX: 5_000,
      mayObserveUser, membershipDiff, visibleOnline,
      aboutUserSteps: runInNewContext(`(${body})`, { __name: (fn: unknown) => fn, statusSeenBy }),
    }) as typeof createUserVisibilityHub;

    const assertMutationRejected = async (mutantFactory: typeof createUserVisibilityHub, label: string) => {
      const got: { name: string; message: GatewayServerMessage }[] = [];
      const mutatedHub = mutantFactory<Conn>({
        loadPeers: async () => new Set(['friend']), now: () => 0, superAdminId: () => null,
        send: (conn, data) => got.push({ name: conn.name, message: JSON.parse(data) as GatewayServerMessage }),
      });
      mutatedHub.attach({ name: 'hidden', userId: 'hidden' }, 'hidden');
      mutatedHub.attach({ name: 'friend', userId: 'friend' }, 'friend');
      mutatedHub.deliverAboutUser('hidden', invisible);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.throws(() => assert.deepEqual(got.map(({ name, message }) => [name, message]), [
        ['hidden', invisible], ['friend', { ...invisible, status: 'online' }],
      ], 'owner and peer must receive privacy-filtered variants'), assert.AssertionError, label);
    };
    assert.ok(source.includes('who:"others"'));
    const allInsteadOfOthers = makeMutant(source.replace('who:"others"', 'who:"all"'));
    await assertMutationRejected(allInsteadOfOthers, 'мутант others→all показывает маскированное состояние владельцу повторно');
    const noPrivacyBranch = makeMutant(source.replace(needle, 'status:msg.status'));
    await assertMutationRejected(noPrivacyBranch, 'удалённая ветка рассылает invisible всем получателям как есть');
  });

  it('неизменный состав сервера не сбрасывает кэш и не рассылает снимки', async () => {
    // Ловит шторм запросов и одинаковых снимков на каждую правку канала или роли.
    let loads = 0;
    let sends = 0;
    const hub = createUserVisibilityHub<Conn>({ loadPeers: async () => (loads += 1, new Set()), now: () => 0, superAdminId: () => null, send: () => (sends += 1) });
    for (const id of ['a', 'b']) hub.attach({ name: id, userId: id }, id);
    await hub.applyServerMembers('s', new Set(['a', 'b']));
    loads = 0;
    sends = 0;
    await hub.applyServerMembers('s', new Set(['b', 'a']));
    assert.deepEqual({ loads, sends }, { loads: 0, sends: 0 });
  });

  it('вступление и выход инвалидируют видимость всех затронутых участников', async () => {
    // Ловит снимок только новичку: оставшиеся и ушедший сохранили бы устаревшую видимость.
    const loads: string[] = [];
    const sent: string[] = [];
    const hub = createUserVisibilityHub<Conn>({ loadPeers: async (id) => (loads.push(id), new Set()), now: () => 0, superAdminId: () => null, send: (conn) => sent.push(conn.name) });
    for (const id of ['a', 'b', 'c']) hub.attach({ name: id, userId: id }, id);
    await hub.applyServerMembers('s', new Set(['a', 'b']));
    loads.length = 0;
    sent.length = 0;
    await hub.applyServerMembers('s', new Set(['b', 'c']));
    assert.deepEqual(loads.sort(), ['a', 'b', 'c']);
    assert.deepEqual(sent.sort(), ['a', 'b', 'c']);
  });

  it('после опустевшего сервера новый состав не наследует старых участников', async () => {
    // Ловит призрачные снимки людям из удалённого состава после повторного появления server id.
    const sent: string[] = [];
    const hub = createUserVisibilityHub<Conn>({ loadPeers: async () => new Set(), now: () => 0, superAdminId: () => null, send: (conn) => sent.push(conn.name) });
    for (const id of ['old', 'new']) hub.attach({ name: id, userId: id }, id);
    await hub.applyServerMembers('s', new Set(['old']));
    await hub.applyServerMembers('s', new Set());
    sent.length = 0;
    await hub.applyServerMembers('s', new Set(['new']));
    assert.deepEqual(sent, ['new']);
  });
});
