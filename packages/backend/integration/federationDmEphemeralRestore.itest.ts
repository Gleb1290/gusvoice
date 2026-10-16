import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, beforeEach, test } from 'node:test';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as lastSeenRules from '../src/lastSeenRules.js';
import type { EphemeralStore } from '../src/federation/dmEphemeral.js';
import type { StoredLink } from '../src/federation/linkService.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
beforeEach(async () => { await truncateAll(t.raw); });
after(async () => { await t.close(); });

type Ephemeral = typeof import('../src/federation/dmEphemeral.js');
type Mutation = readonly [string, string];
type StoredRows = [string, string][];
const SELF = 'a'.repeat(32), PEER = 'b'.repeat(32), THIRD = 'c'.repeat(32);
const NOW = 2_000_000_000_000;

function moduleOf<T>(name: string, deps: Record<string, unknown>, globals: Record<string, unknown> = {}, mutations: readonly Mutation[] = []): T {
  let code = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  for (const [from, to] of mutations) {
    assert.equal(code.split(from).length, 2, `единственный якорь ${from}`);
    code = code.replace(from, to);
  }
  // Исполняем весь модуль, включая startup и декодер: вычисления не копируются и не вырезаются.
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    module, exports: module.exports, Date, URL, Buffer, ...globals,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `явный импорт ${id}`); return deps[id]; },
  });
  return module.exports as T;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    // Host-таймер ограничивает только наблюдение IO. Это Error, а не AssertionError:
    // отсутствие прогресса нельзя выдавать за адресную поимку одного из мутантов.
    timer = setTimeout(() => reject(new Error(`наблюдение не завершилось за 15 с: ${label}`)), 15_000);
  });
  try { return await Promise.race([work, deadline]); }
  finally { if (timer) clearTimeout(timer); }
}

function observedRows(rows: StoredRows) {
  const complete = deferred<void>();
  // loadAll — именованная IO-граница. Конец её настоящего обхода наблюдаем по итератору,
  // а не повторным вызовом restoreRemote или произвольным количеством микрозадач.
  Object.defineProperty(rows, Symbol.iterator, {
    value: function* () {
      try { yield* Array.prototype[Symbol.iterator].call(rows); }
      finally { complete.resolve(); }
    },
  });
  return { rows, complete: complete.promise };
}

function memoryStore(initial: StoredRows = [], delayed = false) {
  const records = new Map(initial);
  const saves: [string, string][] = [];
  const reads: { rows: StoredRows; complete: Promise<void>; release: () => void }[] = [];
  const store: EphemeralStore = {
    save(id, raw) { saves.push([id, raw]); records.set(id, raw); },
    loadAll() {
      const batch = observedRows([...records]);
      const pending = deferred<StoredRows>();
      reads.push({ ...batch, release: () => pending.resolve(batch.rows) });
      if (!delayed) pending.resolve(batch.rows);
      return pending.promise;
    },
  };
  return { store, records, saves, reads,
    loaded: async (index = 0) => {
      assert.ok(reads[index], 'start вызвал loadAll');
      await bounded(reads[index].complete, 'startup завершил обход loadAll');
    },
  };
}

async function fixture() {
  let now = NOW;
  class ClockDate extends Date {
    constructor(value?: number | string) { super(value ?? now); }
    static now() { return now; }
  }
  await t.db.insert(schema.users).values([
    { id: 'viewer', username: 'restore_viewer', displayName: 'Зритель', passwordHash: 'fixture' },
    { id: 'hidden', username: 'restore_hidden', displayName: 'Скрытый зритель', passwordHash: 'fixture' },
    { id: 'blocked', username: 'restore_blocked', displayName: 'Заблокировавший', passwordHash: 'fixture' },
    { id: 'shadow', username: 'restore_shadow', displayName: 'Сосед', passwordHash: 'fixture', homeInstanceId: PEER, homeUserId: 'remote' },
    { id: 'shadow2', username: 'restore_shadow2', displayName: 'Второй сосед', passwordHash: 'fixture', homeInstanceId: PEER, homeUserId: 'remote2' },
  ]);
  await t.db.insert(schema.federationLinks).values({
    instanceId: PEER, domain: 'peer.invalid', apiBase: 'https://peer.invalid/api', clientOrigin: 'https://peer.invalid',
    rootKey: 'fixture', state: 'active', features: ['dm1', 'dm3'],
  });
  const savedLink = (await t.db.select().from(schema.federationLinks))[0]!;
  const link: StoredLink = { ...savedLink, state: 'active' };
  const blocks = moduleOf<typeof import('../src/blocks.js')>('blocks', {
    'drizzle-orm': orm, './db/index.js': { db: t.db }, './db/schema.js': schema,
  });
  await blocks.blockUser('blocked', 'shadow');

  function instance(mutations: readonly Mutation[] = []) {
    const presence: [string, boolean][] = [];
    const intervals: { fn: () => void; ms: number }[] = [];
    const shadowReads: Promise<unknown>[] = [];
    const shadowStarted = deferred<void>();
    // Наблюдатель только передаёт настоящие drizzle-запросы PGlite. SQL и его результат не подделываются.
    const observedDb = {
      execute: t.db.execute.bind(t.db),
      select(fields?: Record<string, unknown>) {
        const selected = Reflect.apply(t.db.select, t.db, fields === undefined ? [] : [fields]);
        if (!fields || Object.keys(fields).length !== 1 || fields.id !== schema.users.id) return selected;
        return { from(table: unknown) {
          assert.equal(table, schema.users);
          const from = selected.from(table);
          return { where(condition: unknown) {
            const query = from.where(condition);
            return { then(resolve?: (rows: unknown) => unknown, reject?: (error: unknown) => unknown) {
              const delivered = Promise.resolve(query).then(resolve, reject);
              shadowReads.push(delivered);
              shadowStarted.resolve();
              return delivered;
            } };
          } };
        } };
      },
    };
    const ephemeral = moduleOf<Ephemeral>('federation/dmEphemeral', {
      'drizzle-orm': orm, '@gusvoice/shared': shared,
      '../blocks.js': blocks, '../db/index.js': { db: observedDb }, '../db/schema.js': schema,
      '../gateway.js': {
        isUserDmPresent: () => false,
        relayFedTyping: async () => { assert.fail('restore не должен отправлять typing'); },
        setRemoteDmPresence: (id: string, online: boolean) => { presence.push([id, online]); },
      },
      '../lastSeenRules.js': lastSeenRules,
      './directorySync.js': { refreshCapabilities: async () => { assert.fail('restore не перечитывает визитку'); } },
      // Подменяется именованная IO-граница получения тени; принадлежность проверяет реальный SELECT.
      './guestHost.js': { shadowUserFor: async (home: string, id: string) => (await t.db.select().from(schema.users)
        .where(orm.and(orm.eq(schema.users.homeInstanceId, home), orm.eq(schema.users.homeUserId, id))).limit(1))[0] ?? null },
      './instance.js': { federation: { identity: () => ({ instanceId: SELF }), signingKey: () => null } },
      './peerClient.js': { postSignedToPeer: async () => { assert.fail('restore не отправляет запросы соседу'); } },
    }, {
      Date: ClockDate,
      setInterval: (fn: () => void, ms: number) => { intervals.push({ fn, ms }); return { unref() {} }; },
      setTimeout: () => { assert.fail('restore не заводит таймер успокоения'); },
      clearTimeout: () => { assert.fail('restore не снимает таймер успокоения'); },
    }, mutations);
    return { ephemeral, presence, intervals,
      shadowLoaded: async () => {
        await bounded(shadowStarted.promise, 'startup начал настоящий SELECT теней');
        await bounded(Promise.all(shadowReads), 'startup завершил настоящий SELECT теней');
      },
      stale: () => {
        const callback = intervals.find((job) => job.ms === 30_000);
        assert.ok(callback, 'start зарегистрировал штатный stale callback');
        callback.fn();
      },
    };
  }
  return { instance, link, advance: (ms: number) => { now += ms; } };
}

function presenceWire(at = NOW, online = true, lastSeen = NOW - 1000) {
  return shared.serializeEphemeralWire(PEER, {
    kind: 'presence', user: { instanceId: PEER, userId: 'remote' }, at, online,
    views: [
      { user: { instanceId: SELF, userId: 'viewer' }, lastSeen, approx: null },
      { user: { instanceId: SELF, userId: 'hidden' }, lastSeen: null, approx: null },
      { user: { instanceId: SELF, userId: 'blocked' }, lastSeen, approx: null },
      { user: { instanceId: THIRD, userId: 'foreign' }, lastSeen, approx: null },
    ],
  });
}

function stored(at = NOW, ms: number | null = NOW - 1000) {
  return JSON.stringify({ v: 1, at, views: [['viewer', true, ms]] });
}

function seen(ephemeral: Ephemeral, id = 'shadow', viewer = 'viewer') {
  const view = ephemeral.remoteLastSeenFor(id, viewer);
  return view ? { shares: view.shares, lastSeenAt: view.lastSeenAt?.getTime() ?? null } : null;
}

async function saveScenario(mutations: readonly Mutation[] = []) {
  const f = await fixture(), writer = f.instance(mutations), persistence = memoryStore();
  writer.ephemeral.configureEphemeralStore(persistence.store);
  const result = await writer.ephemeral.acceptEphemeral(f.link, presenceWire());
  assert.equal(result.status, 202); assert.equal(result.body.ignored, undefined);
  assert.equal(persistence.saves.length, 1, 'принятое presence копируется в хранилище');
  assert.equal(persistence.saves[0][0], 'shadow');
  const json: Record<string, unknown> = JSON.parse(persistence.saves[0][1]);
  assert.deepEqual(Object.keys(json).sort(), ['at', 'v', 'views']);
  assert.deepEqual(json, { v: 1, at: NOW, views: [['viewer', true, NOW - 1000], ['hidden', false, null]] });
  assert.equal(Object.hasOwn(json, 'online'), false, 'online не становится долговечным');
  assert.deepEqual(writer.presence, [['shadow', true]]);
  await writer.ephemeral.acceptEphemeral(f.link, presenceWire(NOW, false));
  assert.equal(persistence.saves.length, 1, 'повторная версия не переписывает сохранённое');
}

test('R204 приём сохраняет JSON v1 с версией и разрешёнными зрителями, но без online', async () => {
  await saveScenario();
});

async function restartScenario(mutations: readonly Mutation[] = []) {
  const f = await fixture(), persistence = memoryStore();
  const writer = f.instance();
  writer.ephemeral.configureEphemeralStore(persistence.store);
  await writer.ephemeral.acceptEphemeral(f.link, presenceWire());
  assert.equal(persistence.saves.length, 1, 'первый экземпляр записал состояние до перезапуска');
  const reader = f.instance(mutations);
  assert.equal(seen(reader.ephemeral), null, 'у второго экземпляра своя пустая память');
  reader.ephemeral.configureEphemeralStore(persistence.store);
  reader.ephemeral.startDmEphemeral(); reader.ephemeral.startDmEphemeral();
  await persistence.loaded(); await reader.shadowLoaded();
  assert.equal(persistence.reads.length, 1);
  assert.deepEqual(reader.intervals.map((job) => job.ms).sort((a, b) => a - b), [30_000, shared.FED_PRESENCE_ALIVE_MS]);
  assert.equal(reader.ephemeral.isKnownShadow('shadow'), true, 'startup закончил настоящий SELECT теней');
  assert.deepEqual(seen(reader.ephemeral), { shares: true, lastSeenAt: NOW - 1000 });
  assert.deepEqual(seen(reader.ephemeral, 'shadow', 'hidden'), { shares: false, lastSeenAt: null });
  assert.deepEqual(reader.presence, [], 'restore не сообщает онлайн шлюзу');
  // Простого отсутствия события при restore недостаточно: online=true в памяти обнаруживается только штатным stale callback.
  f.advance(shared.FED_PRESENCE_STALE_MS); reader.stale();
  f.advance(1); reader.stale(); reader.stale();
  assert.deepEqual(reader.presence, [], 'восстановленное состояние остаётся offline и не протухает как online');
  for (const at of [NOW - 1, NOW]) {
    const result = await reader.ephemeral.acceptEphemeral(f.link, presenceWire(at));
    assert.equal(result.body.ignored, true, 'меньшая и равная сохранённой версии игнорируются');
  }
  assert.deepEqual(reader.presence, []);
  assert.equal(persistence.saves.length, 1);
  const fresh = await reader.ephemeral.acceptEphemeral(f.link, presenceWire(NOW + 1));
  assert.equal(fresh.body.ignored, undefined, 'следующая версия принимается');
  assert.deepEqual(reader.presence, [['shadow', true]]);
  assert.equal(persistence.saves.length, 2);
}

test('R204 второй экземпляр восстанавливает был(а), но не online; at ≤ сохранённого молчит, at+1 оживляет', async () => {
  await restartScenario();
});

for (const [label, raw] of [
  ['мусор вместо JSON', '{not-json'],
  ['неизвестная версия v2', JSON.stringify({ v: 2, at: NOW, views: [['viewer', true, NOW - 1000]] })],
  ['views не массив', JSON.stringify({ v: 1, at: NOW, views: { viewer: NOW - 1000 } })],
] as const) {
  test(`R204 ${label} пропускается, соседняя запись v1 восстанавливается`, async () => {
    const f = await fixture(), reader = f.instance();
    const persistence = memoryStore([['shadow', raw], ['shadow2', stored()]]);
    reader.ephemeral.configureEphemeralStore(persistence.store); reader.ephemeral.startDmEphemeral();
    await persistence.loaded(); await reader.shadowLoaded();
    assert.equal(seen(reader.ephemeral), null);
    assert.deepEqual(seen(reader.ephemeral, 'shadow2'), { shares: true, lastSeenAt: NOW - 1000 });
    assert.deepEqual(reader.presence, []);
  });
}

async function lateLoadScenario(mutations: readonly Mutation[] = []) {
  const f = await fixture(), reader = f.instance(mutations);
  const persistence = memoryStore([['shadow', stored(NOW - 1, NOW - 600_000)]], true);
  reader.ephemeral.configureEphemeralStore(persistence.store); reader.ephemeral.startDmEphemeral();
  assert.equal(persistence.reads.length, 1, 'загрузка началась, но снимок ещё не отдан');
  const fresh = await reader.ephemeral.acceptEphemeral(f.link, presenceWire(NOW, true, NOW - 1000));
  assert.equal(fresh.body.ignored, undefined);
  assert.deepEqual(reader.presence, [['shadow', true]]);
  persistence.reads[0].release();
  await persistence.loaded(); await reader.shadowLoaded();
  assert.deepEqual(seen(reader.ephemeral), { shares: true, lastSeenAt: NOW - 1000 }, 'поздний loadAll не затирает свежий приём');
  const repeat = await reader.ephemeral.acceptEphemeral(f.link, presenceWire(NOW));
  assert.equal(repeat.body.ignored, true, 'поздняя загрузка не понижает принятую версию');
  f.advance(shared.FED_PRESENCE_STALE_MS + 1); reader.stale();
  assert.deepEqual(reader.presence, [['shadow', true], ['shadow', false]], 'поздняя загрузка не теряет online свежего приёма');
}

test('R204 свежий приём до завершения loadAll не затирается старым снимком и сохраняет online', async () => {
  await lateLoadScenario();
});

test('R204 отказ loadAll не ломает старт двух интервалов, обновление теней и следующий приём', async () => {
  const f = await fixture(), reader = f.instance(), failed = deferred<void>();
  const saves: [string, string][] = [];
  let loads = 0;
  reader.ephemeral.configureEphemeralStore({
    save(id, raw) { saves.push([id, raw]); },
    loadAll() {
      loads++;
      const result = Promise.reject<StoredRows>(new Error('fixture: Redis недоступен при чтении'));
      void result.catch(() => { failed.resolve(); });
      return result;
    },
  });
  assert.doesNotThrow(() => reader.ephemeral.startDmEphemeral());
  reader.ephemeral.startDmEphemeral();
  await bounded(failed.promise, 'loadAll вернул отказ чтения'); await reader.shadowLoaded();
  assert.equal(loads, 1); assert.equal(reader.intervals.length, 2);
  assert.equal(reader.ephemeral.isKnownShadow('shadow'), true);
  assert.equal(seen(reader.ephemeral), null);
  const accepted = await reader.ephemeral.acceptEphemeral(f.link, presenceWire());
  assert.equal(accepted.status, 202); assert.equal(accepted.body.ignored, undefined);
  assert.deepEqual(reader.presence, [['shadow', true]]);
  assert.equal(saves.length, 1);
  assert.deepEqual(seen(reader.ephemeral), { shares: true, lastSeenAt: NOW - 1000 });
});

async function futureScenario(mutations: readonly Mutation[] = []) {
  const f = await fixture(), reader = f.instance(mutations);
  const persistence = memoryStore([
    ['shadow', stored(NOW, NOW + 1)],
    ['shadow-at-now', stored(NOW, NOW)],
    ['shadow-before-now', stored(NOW, NOW - 1)],
  ]);
  reader.ephemeral.configureEphemeralStore(persistence.store); reader.ephemeral.startDmEphemeral();
  await persistence.loaded(); await reader.shadowLoaded();
  assert.equal(seen(reader.ephemeral)?.lastSeenAt, NOW, 'сохранённое будущее ограничивается часами запуска');
  assert.equal(seen(reader.ephemeral, 'shadow-at-now')?.lastSeenAt, NOW, 'ровно сейчас не меняется');
  assert.equal(seen(reader.ephemeral, 'shadow-before-now')?.lastSeenAt, NOW - 1, 'прошлое не заменяется сейчас');
}

test('R204 сохранённое время из будущего ограничивается Date.now, ровно сейчас и прошлое сохраняются', async () => {
  await futureScenario();
});

test('R204 настоящий Redis-store глотает отказ SET, а приём продолжает менять online и был(а) в памяти', async () => {
  const f = await fixture(), receiver = f.instance();
  const setCalls: [string, string, string, number][] = [];
  const failedWrites: Promise<void>[] = [];
  const storeModule = moduleOf<typeof import('../src/federation/dmEphemeralStore.js')>('federation/dmEphemeralStore', {
    '../realtime.js': { redisPub: {
      set(key: string, raw: string, mode: string, ttl: number) {
        setCalls.push([key, raw, mode, ttl]);
        const result = Promise.reject(new Error('fixture: Redis недоступен при записи'));
        const actualCatch = result.catch.bind(result);
        // Наблюдаем обработчик, который ставит настоящий store. Собственный catch на исходной
        // ошибке скрыл бы регрессию, при которой store вовсе перестал её обрабатывать.
        result.catch = ((onRejected) => {
          const handled = actualCatch(onRejected);
          failedWrites.push(handled.then(() => {}));
          return handled;
        }) as typeof result.catch;
        return result;
      },
      scan: async () => { assert.fail('приём presence не делает SCAN'); },
      mget: async () => { assert.fail('приём presence не делает MGET'); },
    } },
  });
  receiver.ephemeral.configureEphemeralStore(storeModule.redisEphemeralStore);
  const first = await receiver.ephemeral.acceptEphemeral(f.link, presenceWire());
  assert.equal(first.status, 202); assert.equal(first.body.ignored, undefined);
  const second = await receiver.ephemeral.acceptEphemeral(f.link, presenceWire(NOW + 1, false, NOW - 500));
  assert.equal(second.status, 202); assert.equal(second.body.ignored, undefined);
  assert.equal(failedWrites.length, 2, 'настоящий store обработал обе ошибки SET');
  await bounded(Promise.all(failedWrites), 'настоящий store обработал отказы SET');
  assert.equal(setCalls.length, 2);
  assert.deepEqual(setCalls.map(([key, , mode, ttl]) => [key, mode, ttl]), [
    ['gv:fedpres:shadow', 'EX', 2592000], ['gv:fedpres:shadow', 'EX', 2592000],
  ]);
  assert.deepEqual(receiver.presence, [['shadow', true], ['shadow', false]]);
  assert.deepEqual(seen(receiver.ephemeral), { shares: true, lastSeenAt: NOW - 500 });
  assert.equal(JSON.parse(setCalls[1][1]).at, NOW + 1);
});

test('R204 мутант восстановления online обнаруживается штатным stale callback после парного перезапуска', async () => {
  await restartScenario(); await truncateAll(t.raw);
  await assert.rejects(restartScenario([[
    'return { at: o.at, online: false, receivedAt: now, views };',
    'return { at: o.at, online: true, receivedAt: now, views };',
  ]]), (error) => error instanceof assert.AssertionError && error.message.includes('восстановленное состояние остаётся offline'));
});

test('R204 мутант без ограничения будущего пойман на восстановлении через startDmEphemeral', async () => {
  await futureScenario(); await truncateAll(t.raw);
  await assert.rejects(futureScenario([['Math.min(row[2], now)', 'row[2]']]),
    (error) => error instanceof assert.AssertionError && error.message.includes('сохранённое будущее ограничивается часами запуска'));
});

test('R204 мутант без защиты свежего приёма пойман на гонке startup loadAll и presence', async () => {
  await lateLoadScenario(); await truncateAll(t.raw);
  await assert.rejects(lateLoadScenario([[
    'if (remote.has(id) || remote.size > 50_000) continue;',
    'if (remote.size > 50_000) continue;',
  ]]), (error) => error instanceof assert.AssertionError && error.message.includes('поздний loadAll не затирает свежий приём'));
});

test('R204 мутант без save пойман на фактической копии принятого presence', async () => {
  await saveScenario(); await truncateAll(t.raw);
  await assert.rejects(saveScenario([['ephemeralStore?.save(shadow.id, encodeRemote(st));', '']]),
    (error) => error instanceof assert.AssertionError && error.message.includes('принятое presence копируется в хранилище'));
});
