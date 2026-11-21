import { counterfact } from '../../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as drizzle from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema.js';
import * as rules from './botRules.js';
import type { BotUpdateRow } from './botStore.js';

const source = readFileSync(new URL('./webhookDelivery.ts', import.meta.url), 'utf8');
const storeSource = readFileSync(new URL('./botStore.ts', import.meta.url), 'utf8');
const dialect = new PgDialect();
const botId = 'delivery-test-bot';
const hook = 'https://example.invalid/hook';
const secret = 'R297_public_test_secret'; // Синтетический, не секрет стенда.

function compile<T>(text: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} };
  const javascript = ts.transpileModule(text, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  runInNewContext(javascript, { module, exports: module.exports, Buffer, Date, console: {
    warn: (...args: unknown[]) => { throw new Error(`неожиданный фоновый warning: ${args.map(String).join(' ')}`); },
    log: () => { throw new Error('job startup не должен исполняться'); },
  }, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `неожиданная зависимость ${name}`);
    return dependencies[name];
  }, ...globals });
  return module.exports as T;
}

interface DeliveryModule {
  __deliverLoop(id: string): Promise<void>;
  kickWebhook(id: string): void;
  resetWebhookRetry(id: string): void;
  startBotJobs(): void;
}
interface Timer { fn: () => void; ms: number; cancelled: boolean; unref(): void }
interface Options {
  enabled?: boolean; lock?: boolean; failures?: number; statuses?: (number | Error)[];
  missingBot?: boolean; deletedUser?: boolean; disabledBot?: boolean; url?: string | null;
  missingSecret?: boolean; disabledHook?: boolean; readFails?: boolean;
  allowInternal?: boolean; holdFirst?: Promise<void>; batch?: boolean;
}

function harness(options: Options = {}, deliverySource = source) {
  const rows: BotUpdateRow[] = [3, 1, 4, 2].map(updateId => ({ updateId, botId, type: 'message',
    payload: { message_id: `m-${updateId}`, chat: { id: 'chat-1' } }, createdAt: new Date(0) }));
  const events: string[] = [];
  const sent: { id: number; ids: number[]; body: string; headers: Record<string, string>; config: Record<string, unknown> }[] = [];
  const deletes: number[] = [];
  const patches: Record<string, unknown>[] = [];
  const reads: number[][] = [];
  const timers: Timer[] = [];
  let active = 0, maxActive = 0, selects = 0, locks = 0, intervals = 0, firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const bot: Record<string, unknown> = {
    userId: botId, tokenHash: 'current', webhookBatch: options.batch ?? false, droppedUpdateCount: 0, webhookUrl: options.url === undefined ? hook : options.url,
    webhookSecret: options.missingSecret ? null : secret, webhookFailures: options.failures ?? 3,
    webhookLastError: 'ответ 500', webhookDisabledAt: options.disabledHook ? new Date(0) : null,
    disabledAt: options.disabledBot ? new Date(0) : null,
  };
  const sqlOf = (query: drizzle.SQL) => dialect.sqlToQuery(query);
  const queries = {
    select: (selection?: Record<string, unknown>) => {
      selects++;
      let table: unknown, ordered = false, matches = true;
      const query = {
        from: (next: unknown) => { table = next; return query; },
        innerJoin: () => query,
        where: (condition: drizzle.SQL) => {
          const params = sqlOf(condition).params;
          assert.ok(params.includes(botId) || table === schema.instanceSettings);
          if (table === schema.bots && selection) {
            const [, tokenHash, url, hookSecret, batch] = params;
            matches = bot.tokenHash === tokenHash && bot.webhookUrl === url && bot.webhookSecret === hookSecret &&
              bot.webhookBatch === batch && !bot.disabledAt && !bot.webhookDisabledAt;
          }
          return query;
        },
        for: async () => matches ? [{ failures: bot.webhookFailures, error: bot.webhookLastError }] : [],
        orderBy: (order: drizzle.SQL) => {
          assert.equal(sqlOf(order).sql, '"bot_updates"."update_id" asc', 'реальный updatesFrom запрашивает ascending update_id');
          ordered = true; events.push('orderBy:update_id:asc'); return query;
        },
        limit: async (count: number) => {
          if (table === schema.botUpdates) {
            // Это адаптер query API, не доказательство SQL на настоящей БД (оно в integration).
            // Сортировать разрешено ТОЛЬКО по реально переданному orderBy, без него тест намеренно отдаёт физический порядок.
            const selected = ordered ? [...rows].sort((a, b) => a.updateId - b.updateId) : rows;
            return selected.slice(0, count);
          }
          if (table === schema.instanceSettings) return [{ value: { enabled: options.enabled ?? true, allowInternalWebhooks: options.allowInternal ?? false } }];
          assert.equal(table, schema.bots);
          if (selection && Object.hasOwn(selection, 'id')) return matches ? [{ id: botId }] : [];
          return options.missingBot ? [] : [{ bot: { ...bot }, user: { deletedAt: options.deletedUser ? new Date(0) : null } }];
        },
      };
      return query;
    },
    delete: (table: unknown) => {
      assert.equal(table, schema.botUpdates);
      return { where: (condition: drizzle.SQL) => ({ returning: async () => {
        const [target, ...ids] = sqlOf(condition).params;
        assert.equal(target, botId);
        const removed: BotUpdateRow[] = [];
        for (const id of ids.map(Number)) {
          const index = rows.findIndex(r => r.updateId === id);
          if (index < 0) continue;
          removed.push(...rows.splice(index, 1));
          deletes.push(id); events.push(`delete:${id}`);
        }
        return removed;
      } }) };
    },
    update: (table: unknown) => {
      assert.equal(table, schema.bots);
      return { set: (patch: Record<string, unknown>) => ({ where: async (condition: drizzle.SQL) => {
        assert.deepEqual(sqlOf(condition).params, [botId], 'счётчик меняется только у доставляемого бота');
        patches.push({ ...patch });
        Object.assign(bot, Object.hasOwn(patch, 'droppedUpdateCount')
          ? { ...patch, droppedUpdateCount: Number(bot.droppedUpdateCount) + 1 }
          : patch);
        events.push('patch');
      } }) };
    },
  };
  const db = { ...queries, transaction: async <T>(run: (tx: typeof queries) => Promise<T>): Promise<T> => run(queries) };
  const redis = {
    set: async (...args: unknown[]) => { locks++; assert.deepEqual(args, [`bot:wh:lock:${botId}`, '1', 'PX', 60_000, 'NX']); return options.lock === false ? null : 'OK'; },
    pexpire: async (key: string, ms: number) => { assert.equal(key, `bot:wh:lock:${botId}`); assert.equal(ms, 60000); events.push('pexpire'); return 1; },
    del: async (key: string) => { assert.equal(key, `bot:wh:lock:${botId}`); events.push('unlock'); return 1; },
  };
  const common = { 'drizzle-orm': drizzle, '../db/index.js': { db }, '../db/schema.js': schema, './botRules.js': rules,
    '../realtime.js': { redisPub: redis } };
  const store = compile<{ botById: unknown; readBotSettings: unknown; updatesFrom: unknown; journalContains: unknown; wireUpdateOf: unknown; pruneBotUpdates: unknown }>(storeSource,
    { ...common, '../env.js': { env: {} }, ioredis: class { constructor() { throw new Error('Redis subscriber не нужен доставке'); } } });
  const delivery = compile<DeliveryModule>(`${deliverySource}\nexport { deliverLoop as __deliverLoop };\n`, {
    ...common, './botStore.js': store,
    './botRead.js': { markTakenRead: async (id: string, taken: BotUpdateRow[]) => {
      assert.equal(id, botId); reads.push(Array.from(taken, r => r.updateId)); events.push('read');
      if (options.readFails) throw new Error('подставной сбой read');
    } },
    '../safeFetch.js': { safeHookPost: async (url: string, body: Buffer, headers: Record<string, string>, config: Record<string, unknown>) => {
      assert.equal(url, hook); active++; maxActive = Math.max(maxActive, active);
      const raw = body.toString('utf8');
      const wire = JSON.parse(raw);
      const ids = (Array.isArray(wire) ? wire : [wire]).map(u => u.update_id as number);
      const id = ids[0];
      const index = sent.length; sent.push({ id, ids, body: raw, headers: { ...headers }, config: { ...config } }); events.push(`send:${id}`);
      if (index === 0) firstStarted();
      try {
        if (index === 0 && options.holdFirst) await options.holdFirst;
        const result = options.statuses?.[index] ?? 200;
        if (result instanceof Error) throw result;
        return { status: result };
      } finally { active--; events.push(`response:${id}`); }
    } },
  }, {
    setTimeout: (fn: () => void, ms: number) => { const timer: Timer = { fn, ms, cancelled: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeout: (timer: Timer) => { timer.cancelled = true; },
    setInterval: () => { intervals++; throw new Error('startBotJobs нельзя вызывать в этом тесте'); },
  });
  assert.equal(intervals, 0, 'загрузка полного модуля не запускает фоновые jobs');
  assert.equal(selects, 0, 'на импорте нет запросов');
  return { delivery, rows, events, sent, deletes, patches, reads, timers, bot, started,
    get maxActive() { return maxActive; }, get locks() { return locks; } };
}

describe('доставка бота: полный модуль, настоящие store/rules и подставные IO', () => {
  it('2xx доставляет ascending update_id по одному, удаляет принятые и отмечает пачку только в finally', async () => {
    const h = harness({ statuses: [200, 202, 299, 204] });
    await h.delivery.__deliverLoop(botId);
    assert.deepEqual(h.sent.map(s => s.id), [1, 2, 3, 4]);
    assert.deepEqual(h.deletes, [1, 2, 3, 4]); assert.equal(h.rows.length, 0); assert.equal(h.maxActive, 1);
    assert.deepEqual(h.reads, [[1, 2, 3, 4]]);
    assert.equal(h.patches.length, 1);
    assert.deepEqual(h.patches[0], { webhookFailures: 0, webhookLastError: null });
    assert.deepEqual(h.events.slice(-2), ['read', 'unlock']);
    assert.ok(h.events.indexOf('read') > h.events.indexOf('delete:4'));
    assert.equal(h.timers.length, 0);
  });

  it('следующий запрос не начинается до ответа на предыдущий', async () => {
    let release!: () => void;
    const holdFirst = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ holdFirst });
    const done = h.delivery.__deliverLoop(botId);
    await h.started;
    assert.deepEqual(h.sent.map(s => s.id), [1]); assert.equal(h.deletes.length, 0); assert.equal(h.reads.length, 0);
    release(); await done;
    assert.equal(h.maxActive, 1); assert.deepEqual(h.sent.map(s => s.id), [1, 2, 3, 4]);
  });

  it('500 сохраняет событие, не читает, увеличивает 8→9 и ещё назначает повтор', async () => {
    const h = harness({ failures: 8, statuses: [500] });
    await h.delivery.__deliverLoop(botId);
    assert.equal(h.sent.length, 1); assert.equal(h.rows.length, 4); assert.equal(h.deletes.length, 0); assert.equal(h.reads.length, 0);
    assert.equal(h.bot.webhookFailures, 9); assert.equal(h.bot.webhookLastError, 'ответ 500');
    assert.equal(h.bot.webhookDisabledAt, null); assert.ok(h.bot.webhookLastErrorAt instanceof Date);
    assert.equal(h.timers.length, 1); assert.equal(h.timers[0].ms, 600000); assert.equal(h.events.at(-1), 'unlock');
  });

  it('десятый подряд сбой выключает доставку без таймера, успешные прошлые события читаются отдельно', async () => {
    const h = harness({ failures: 9, statuses: [500] });
    await h.delivery.__deliverLoop(botId);
    assert.equal(h.bot.webhookFailures, 10); assert.ok(h.bot.webhookDisabledAt instanceof Date);
    assert.equal(h.timers.length, 0); assert.equal(h.reads.length, 0); assert.equal(h.deletes.length, 0);
    await h.delivery.__deliverLoop(botId); assert.equal(h.sent.length, 1, 'disabled_at останавливает следующий запуск');
    const partial = harness({ statuses: [200, 500] });
    await partial.delivery.__deliverLoop(botId);
    assert.deepEqual(partial.reads, [[1]]); assert.deepEqual(partial.deletes, [1]);
    assert.equal(partial.bot.webhookFailures, 1, 'успех обнулил прошлые сбои перед следующим');
  });

  it('сетевая ошибка, 199 и 300 — сбои, не прочитанные события', async () => {
    for (const status of [new Error('подставной network failure'), 199, 300]) {
      const h = harness({ failures: 0, statuses: [status] }); await h.delivery.__deliverLoop(botId);
      assert.equal(h.reads.length, 0); assert.equal(h.deletes.length, 0); assert.equal(h.bot.webhookFailures, 1);
      assert.equal(h.timers[0].ms, 5000);
    }
  });

  it('выключенный инстанс, удалённый/выключенный бот, пустой адрес/секрет и чужой замок не доставляют', async () => {
    for (const options of [{ enabled: false }, { missingBot: true }, { deletedUser: true }, { disabledBot: true },
      { url: null }, { missingSecret: true }, { disabledHook: true }, { lock: false }]) {
      const h = harness(options); await h.delivery.__deliverLoop(botId);
      assert.equal(h.sent.length, 0, JSON.stringify(options)); assert.equal(h.patches.length, 0); assert.equal(h.reads.length, 0);
      assert.equal(h.deletes.length, 0); assert.equal(h.timers.length, 0);
      assert.equal(h.events.includes('unlock'), options.lock !== false, 'не полученный замок не снимается');
    }
  });

  it('ожидание повтора не обходит паузу, reset снимает её и разрешает новую доставку', async () => {
    const h = harness({ failures: 0, statuses: [500, 200] });
    await h.delivery.__deliverLoop(botId); await h.delivery.__deliverLoop(botId);
    assert.equal(h.sent.length, 1); assert.equal(h.locks, 1);
    h.delivery.resetWebhookRetry(botId); assert.equal(h.timers[0].cancelled, true);
    await h.delivery.__deliverLoop(botId);
    assert.deepEqual(h.sent.map(s => s.id), [1, 1, 2, 3, 4]); assert.deepEqual(h.reads, [[1, 2, 3, 4]]);
  });

  it('запрос подписан по точным байтам и передаёт SSRF-флаг, 10 секунд и 4 КиБ', async () => {
    const h = harness({ allowInternal: true }); await h.delivery.__deliverLoop(botId);
    for (const request of h.sent) {
      assert.deepEqual(request.config, { allowInternal: true, deadlineMs: 10000, maxBytes: 4096 });
      assert.equal(request.headers['content-type'], 'application/json');
      assert.equal(request.headers['user-agent'], 'GusVoice-Bot-Webhook/1');
      const signature = request.headers['x-gusvoice-signature']; const time = Number(/^t=(\d+),/.exec(signature)?.[1]);
      assert.ok(Number.isFinite(time)); assert.equal(signature, rules.webhookSignature(secret, request.body, time));
      assert.equal(JSON.parse(request.body).message.message_id, `m-${request.id}`);
    }
  });

  it('пакеты сохраняют порядок и укладываются в лимит UTF-8 вместе со скобками и запятыми', async () => {
    const h = harness({ batch: true });
    for (const row of h.rows) row.payload.text = 'я'.repeat(150_000);
    await h.delivery.__deliverLoop(botId);
    assert.deepEqual(h.sent.map(s => s.ids), [[1, 2, 3], [4]]);
    for (const request of h.sent) assert.ok(Buffer.byteLength(request.body, 'utf8') <= 1024 * 1024);
    assert.deepEqual(h.reads, [[1, 2, 3, 4]]);
  });

  it('событие ровно на границе и более крупное одиночное доставляются целиком', async () => {
    const h = harness();
    for (const id of [1, 2]) {
      const row = h.rows.find(r => r.updateId === id)!;
      row.payload.text = '';
      const overhead = Buffer.byteLength(JSON.stringify({ update_id: id, message: row.payload }));
      row.payload.text = 'a'.repeat(1024 * 1024 - overhead + (id === 2 ? 1 : 0));
    }
    await h.delivery.__deliverLoop(botId);
    assert.deepEqual(h.sent.map(s => s.id), [1, 2, 3, 4]);
    assert.equal(Buffer.byteLength(h.sent[0].body), 1024 * 1024);
    assert.equal(Buffer.byteLength(h.sent[1].body), 1024 * 1024 + 1);
    assert.equal(h.bot.droppedUpdateCount, 0);
    assert.deepEqual(h.reads, [[1, 2, 3, 4]]);
  });

  it('отозванная доставка сохраняет очередь и счётчики при любом ответе', async () => {
    for (const status of [200, 500]) {
      let release!: () => void;
      const holdFirst = new Promise<void>(resolve => { release = resolve; });
      const h = harness({ holdFirst, statuses: [status] });
      const done = h.delivery.__deliverLoop(botId);
      await h.started;
      Object.assign(h.bot, rules.clearedWebhook, { tokenHash: 'rotated' });
      release();
      await done;
      assert.equal(h.rows.length, 4);
      assert.deepEqual(h.patches, []);
      assert.deepEqual(h.reads, []);
      assert.deepEqual(h.timers, []);
    }
  });

  it('после повторной настройки на прежнем URL подтверждается только доставка текущего токена', async () => {
    let release!: () => void;
    const holdFirst = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ holdFirst, statuses: [200, 500] });
    const done = h.delivery.__deliverLoop(botId);
    await h.started;
    Object.assign(h.bot, { tokenHash: 'rotated', webhookFailures: 0, webhookLastError: null });
    release();
    await done;
    assert.deepEqual(h.sent.map(s => s.id), [1, 1]);
    assert.deepEqual(h.deletes, []);
    assert.equal(h.bot.webhookFailures, 1);
  });

  it('сбой отметки прочтения не удерживает Redis-замок и не отменяет доставленные удаления', async () => {
    const h = harness({ readFails: true }); await h.delivery.__deliverLoop(botId);
    assert.deepEqual(h.deletes, [1, 2, 3, 4]); assert.deepEqual(h.reads, [[1, 2, 3, 4]]); assert.equal(h.events.at(-1), 'unlock');
  });
});

function replaceOnce(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length - 1, 1, `единственный якорь ${from}`);
  return text.replace(from, to);
}

const mutants = [
  { name: 'не отмечать сбой доставки прочитанным', marker: '500 не вызывает markTakenRead', actual: true, expected: false,
    mutate: (text: string) => replaceOnce(text, '        if (failure) {', '        if (failure) {\n          taken.push(next);'),
    verify: async (text: string) => { const h = harness({ failures: 0, statuses: [500] }, text); await h.delivery.__deliverLoop(botId);
      assert.strictEqual(h.reads.length > 0, false, '500 не вызывает markTakenRead'); } },
  { name: 'граница выключения именно десятый сбой', marker: 'десятый сбой выключает доставку', actual: false, expected: true,
    mutate: (text: string) => replaceOnce(text, 'const off = failures >= WEBHOOK_FAILURES_MAX;', 'const off = failures > WEBHOOK_FAILURES_MAX;'),
    verify: async (text: string) => { const h = harness({ failures: 9, statuses: [500] }, text); await h.delivery.__deliverLoop(botId);
      assert.strictEqual(h.bot.webhookDisabledAt instanceof Date, true, 'десятый сбой выключает доставку'); } },
  { name: 'успех обнуляет счётчик сбоев', marker: 'успешная пачка обнулила сбои', actual: 3, expected: 0,
    mutate: (text: string) => replaceOnce(text, 'webhookFailures: 0, webhookLastError: null', 'webhookFailures: active.failures, webhookLastError: null'),
    verify: async (text: string) => { const h = harness({}, text); await h.delivery.__deliverLoop(botId);
      assert.strictEqual(h.bot.webhookFailures, 0, 'успешная пачка обнулила сбои'); } },
];

describe('доставка бота: адресные исполняемые контрфакты', () => {
  for (const m of mutants) it(m.name, async () => {
    await m.verify(source); // Original-first: исходный полный модуль и тот же адаптер IO проходят до мутации.
    await counterfact(async () => {
      const changed = m.mutate(source); assert.notEqual(changed, source, `найден якорь ${m.name}`);
      await assert.rejects(() => m.verify(changed), (error: unknown) => error instanceof assert.AssertionError
        && error.code === 'ERR_ASSERTION' && error.message.split(/\r?\n/, 1)[0] === m.marker
        && error.operator === 'strictEqual' && error.actual === m.actual && error.expected === m.expected,
      `ожидается только адресный host AssertionError: ${m.marker}`);
    });
  });
});
