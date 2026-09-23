import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayServerMessage } from '@gusvoice/shared';
import { createUserVisibilityHub, type HubConn } from './userVisibilityHub.js';

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
