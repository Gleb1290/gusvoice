import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Api = typeof import('./dmEphemeralStore.js');
type Redis = {
  set(key: string, json: string, expire: string, ttl: number): Promise<unknown>;
  scan(cursor: string, match: string, pattern: string, count: string, size: number): Promise<[string, string[]]>;
  mget(...keys: string[]): Promise<Array<string | null>>;
};
const raw = readFileSync(new URL('./dmEphemeralStore.ts', import.meta.url), 'utf8');
const forbidden = (name: string) => () => { throw new Error(`неожиданная IO-граница ${name}`); };
function fixture(overrides: Partial<Redis> = {}) {
  // Загружается весь модуль, не пересказ алгоритма; единственная runtime-зависимость — транспорт Redis.
  const redis: Redis = { set: forbidden('SET'), scan: forbidden('SCAN'), mget: forbidden('MGET'), ...overrides };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports,
    require(id: string) { assert.equal(id, '../realtime.js', 'хранилище не открывает другие зависимости'); return { redisPub: redis }; },
  });
  return module.exports as Api;
}
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

it('R204 presence сохраняется отдельным ключом теневого id с точным сроком 30 суток, повтор обновляет тот же ключ', async () => {
  // Ловит общий ключ/хеш без индивидуального срока и случайное сокращение либо отсутствие TTL.
  const calls: unknown[][] = [];
  const api = fixture({ set: async (...args) => { calls.push(args); return 'OK'; } });
  assert.equal(api.PRESENCE_TTL_S, 2_592_000);
  assert.equal(api.redisEphemeralStore.save('shadow-one', '{"v":1,"at":1,"views":[]}'), undefined);
  api.redisEphemeralStore.save('shadow-two', '{"v":1,"at":2,"views":[]}');
  api.redisEphemeralStore.save('shadow-one', '{"v":1,"at":3,"views":[]}');
  assert.deepEqual(calls, [
    ['gv:fedpres:shadow-one', '{"v":1,"at":1,"views":[]}', 'EX', 2_592_000],
    ['gv:fedpres:shadow-two', '{"v":1,"at":2,"views":[]}', 'EX', 2_592_000],
    ['gv:fedpres:shadow-one', '{"v":1,"at":3,"views":[]}', 'EX', 2_592_000],
  ]);
  await Promise.resolve();
});

it('R204 загрузка проходит все страницы SCAN, включая пустую промежуточную, и пропускает истёкшие значения MGET', async () => {
  // Пустая страница с ненулевым курсором не конец обхода, а null от MGET — штатное истечение между запросами.
  const scans: unknown[][] = [], gets: string[][] = [];
  const pages: Array<[string, string[]]> = [
    ['17', ['gv:fedpres:first']], ['23', []], ['0', ['gv:fedpres:expired', 'gv:fedpres:second', 'gv:fedpres:empty']],
  ];
  const api = fixture({
    scan: async (...args) => { scans.push(args); const page = pages.shift(); assert.ok(page); return page; },
    mget: async (...keys) => { gets.push(keys); return keys.length === 1 ? ['first-json'] : [null, 'second-json', '']; },
  });
  assert.deepEqual(normal(await api.redisEphemeralStore.loadAll()), [['first', 'first-json'], ['second', 'second-json']]);
  assert.deepEqual(scans, ['0', '17', '23'].map(cursor => [cursor, 'MATCH', 'gv:fedpres:*', 'COUNT', 500]));
  assert.deepEqual(gets, [['gv:fedpres:first'], ['gv:fedpres:expired', 'gv:fedpres:second', 'gv:fedpres:empty']]);
  assert.equal(pages.length, 0);
});

it('R204 пустой Redis возвращает пустой снимок без MGET с пустым списком', async () => {
  // Ловит ошибку Redis «wrong number of arguments», которая иначе прерывает обычный пустой старт.
  const api = fixture({ scan: async () => ['0', []] });
  assert.deepEqual(normal(await api.redisEphemeralStore.loadAll()), []);
});

it('R204 отказ SET поглощается самим хранилищем, следующая запись продолжает сохраняться', async () => {
  // save — fire-and-forget: недостаточно не бросить синхронно, rejected Promise обязан получить обработчик.
  const failure = new Error('synthetic redis unavailable');
  let caught: Promise<unknown> | undefined;
  let attempt = 0;
  const saved: string[] = [];
  const api = fixture({ set: (key) => {
    saved.push(key);
    if (++attempt > 1) return Promise.resolve('OK');
    const rejected = Promise.reject(failure);
    rejected.catch = function<TResult = never>(handler?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null): Promise<TResult> {
      const handled = Promise.prototype.catch.call(rejected, handler) as Promise<TResult>;
      caught = handled; return handled;
    };
    return rejected;
  } });
  assert.doesNotThrow(() => api.redisEphemeralStore.save('shadow-one', 'first'));
  assert.ok(caught, 'SET получил настоящий обработчик rejection');
  assert.equal(await caught, undefined, 'сбой записи не выходит из save');
  api.redisEphemeralStore.save('shadow-two', 'second');
  assert.deepEqual(saved, ['gv:fedpres:shadow-one', 'gv:fedpres:shadow-two']);
});

it('R204 сбой SCAN или MGET отклоняет загрузку, исправный Redis затем возвращает снимок', async () => {
  // Ошибка загрузки должна доходить до startup catch, а не превращаться в частично достоверный снимок.
  for (const stage of ['scan', 'mget'] as const) {
    const failure = new Error(`synthetic ${stage} unavailable`);
    let broken = true;
    const api = fixture({
      scan: async () => { if (broken && stage === 'scan') throw failure; return ['0', ['gv:fedpres:shadow']]; },
      mget: async () => { if (broken && stage === 'mget') throw failure; return ['stored-json']; },
    });
    await assert.rejects(api.redisEphemeralStore.loadAll(), error => error === failure);
    broken = false;
    assert.deepEqual(normal(await api.redisEphemeralStore.loadAll()), [['shadow', 'stored-json']]);
  }
});
