import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './botRules.js';
import type { CallbackQueryRecord } from './botCallback.js';

const source = readFileSync(new URL('./botCallback.ts', import.meta.url), 'utf8');
type Callbacks = typeof import('./botCallback.js');
const record: CallbackQueryRecord = { botId: 'bot-one', userId: 'person-one', conversationId: 'chat-one', messageId: 'panel-one' };
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

// Только IO Redis/случайность/часы заменены. Алгоритмы ожидания, владения и счётчиков — целый модуль приложения.
function harness(text = source) {
  let now = 100_000, nonce = 0;
  const data = new Map<string, { raw: string; until?: number }>();
  const calls: { op: string; args: unknown[] }[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  let timerId = 0;
  const read = (key: string) => {
    const entry = data.get(key);
    if (entry?.until !== undefined && entry.until <= now) data.delete(key);
    return data.get(key)?.raw ?? null;
  };
  const redis = {
    async get(key: string) { calls.push({ op: 'get', args: [key] }); return read(key); },
    async set(key: string, value: string, unit: string, ttl: number) {
      calls.push({ op: 'set', args: [key, value, unit, ttl] });
      assert.equal(unit, 'EX');
      data.set(key, { raw: value, until: now + ttl * 1000 });
      return 'OK';
    },
    async del(key: string) { calls.push({ op: 'del', args: [key] }); read(key); return data.delete(key) ? 1 : 0; },
    async incr(key: string) {
      calls.push({ op: 'incr', args: [key] });
      const value = Number(read(key) ?? '0') + 1;
      data.set(key, { ...data.get(key), raw: String(value) }); return value;
    },
    async decr(key: string) {
      calls.push({ op: 'decr', args: [key] });
      const value = Number(read(key) ?? '0') - 1;
      data.set(key, { ...data.get(key), raw: String(value) }); return value;
    },
    async expire(key: string, ttl: number) {
      calls.push({ op: 'expire', args: [key, ttl] });
      if (read(key) === null) return 0;
      data.get(key)!.until = now + ttl * 1000; return 1;
    },
  };
  const dependencies: Record<string, unknown> = {
    'node:crypto': { randomBytes(size: number) { assert.equal(size, 16); return Buffer.alloc(size, ++nonce); } },
    '../realtime.js': { redisPub: redis }, './botRules.js': rules,
  };
  const module = { exports: {} };
  const javascript = ts.transpileModule(text, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  runInNewContext(javascript, {
    module, exports: module.exports, Buffer,
    Date: class extends Date { static override now() { return now; } },
    setTimeout(fn: () => void, ms: number) {
      assert.ok(ms > 0, 'опрос не крутится без задержки');
      timers.set(++timerId, { at: now + ms, fn }); return timerId;
    },
    require(name: string) {
      assert.ok(Object.hasOwn(dependencies, name), `R301 необъявленная зависимость ${name}`);
      return dependencies[name];
    },
  });
  async function advance(ms: number) {
    const target = now + ms;
    await flush();
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
    }
    now = target; await flush();
  }
  return { api: module.exports as Callbacks, redis, data, calls, timers, read, advance };
}

function replaceOnce(from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'мутируется ровно актуальный целый модуль');
  return source.replace(from, to);
}
async function checkOwnership(text: string) {
  const h = harness(text), id = await h.api.createCallbackQuery(record);
  assert.equal(await h.api.answerCallbackQuery('another-bot', id, { text: 'чужой' }), false, 'чужой бот не отвечает на нажатие');
  assert.ok(h.read(`bot:cbq:${id}`), 'чужой ответ не съедает чужой запрос');
  assert.equal(await h.api.answerCallbackQuery(record.botId, id, { text: 'свой' }), true);
  assert.deepEqual(plain(await h.api.waitCallbackAnswer(id, 0)), { text: 'свой' });
}
async function checkOneAnswer(text: string) {
  const h = harness(text), id = await h.api.createCallbackQuery(record);
  const results = await Promise.all([
    h.api.answerCallbackQuery(record.botId, id, { text: 'один' }),
    h.api.answerCallbackQuery(record.botId, id, { text: 'два' }),
  ]);
  assert.equal(results.filter(Boolean).length, 1, 'один запрос принимает ровно один параллельный ответ');
  const winner = results[0] ? 'один' : 'два';
  assert.deepEqual(plain(await h.api.waitCallbackAnswer(id, 0)), { text: winner });
}
async function checkPending(text: string) {
  const h = harness(text);
  assert.deepEqual(await Promise.all(Array.from({ length: 4 }, () => h.api.acquirePending('u:one', 3))), [true, true, true, false],
    'четвёртый висящий запрос не проходит');
  assert.equal(h.read('bot:cbqn:u:one'), '3', 'отказ не расходует место');
}
async function checkIsolatedAnswers(text: string) {
  const h = harness(text), one = await h.api.createCallbackQuery(record);
  const two = await h.api.createCallbackQuery({ ...record, userId: 'person-two' });
  await h.api.answerCallbackQuery(record.botId, one, { text: 'первому' });
  await h.api.answerCallbackQuery(record.botId, two, { text: 'второму' });
  assert.equal((await h.api.waitCallbackAnswer(one, 0))?.text, 'первому', 'ответ адресован своему запросу, не соседнему');
  assert.equal((await h.api.waitCallbackAnswer(two, 0))?.text, 'второму');
}

describe('R301 нажатия бота: владение, единственный ответ и виртуальное время', () => {
  it('жетон содержит 16 случайных байт, метаданные и TTL дольше HTTP-ожидания', async () => {
    const h = harness(), first = await h.api.createCallbackQuery(record), second = await h.api.createCallbackQuery(record);
    assert.match(first, /^cbq_[A-Za-z0-9_-]{22}$/); assert.notEqual(first, second);
    assert.deepEqual(JSON.parse(h.read(`bot:cbq:${first}`)!), record);
    assert.equal(h.data.get(`bot:cbq:${first}`)!.until, 125_000);
    assert.equal(rules.CALLBACK_QUERY_TTL_S, 25);
    assert.equal(rules.CALLBACK_QUERY_STALE_S, 25);
    assert.ok(rules.CALLBACK_QUERY_TTL_S > 15, 'ответ на границе 15 секунд ещё можно принять');
    assert.equal(h.calls.filter(call => call.op === 'set').length, 2);
  });
  it('чужой бот не отвечает и не удаляет запрос, владелец после отказа отвечает', async () => { await checkOwnership(source); });
  it('после первого ответа повтор и отсутствующий id отвергаются без перезаписи', async () => {
    const h = harness(), id = await h.api.createCallbackQuery(record);
    assert.equal(await h.api.answerCallbackQuery(record.botId, id, { text: 'первый' }), true);
    assert.equal(await h.api.answerCallbackQuery(record.botId, id, { text: 'повтор' }), false);
    assert.equal(await h.api.answerCallbackQuery(record.botId, 'cbq_missing', {}), false);
    assert.deepEqual(plain(await h.api.waitCallbackAnswer(id, 0)), { text: 'первый' });
  });
  it('два одновременных ответа читают запрос, но выигрывает ровно один DEL', async () => { await checkOneAnswer(source); });
  it('повреждённая запись не позволяет создать ответ и не бросает исключение', async () => {
    const h = harness(); h.data.set('bot:cbq:broken', { raw: '{' });
    assert.equal(await h.api.answerCallbackQuery(record.botId, 'broken', {}), false);
    assert.equal(h.read('bot:cbqa:broken'), null);
  });
  it('до TTL запрос ещё принимает ответ, ровно через 25 секунд уже просрочен', async () => {
    const h = harness(), id = await h.api.createCallbackQuery(record);
    await h.advance(24_999);
    assert.equal(await h.api.answerCallbackQuery(record.botId, id, {}), true);
    const expired = await h.api.createCallbackQuery(record); await h.advance(25_000);
    assert.equal(await h.api.answerCallbackQuery(record.botId, expired, {}), false);
  });
  it('готовый ответ возвращается сразу, безопасный текст не трактуется как HTML и ключ съедается', async () => {
    const h = harness(), id = await h.api.createCallbackQuery(record), text = '<b>Не HTML</b>';
    await h.api.answerCallbackQuery(record.botId, id, { text, alert: true });
    assert.deepEqual(plain(await h.api.waitCallbackAnswer(id, 15_000)), { text, alert: true });
    assert.equal(h.read(`bot:cbqa:${id}`), null); assert.equal(h.timers.size, 0);
    assert.equal(await h.api.waitCallbackAnswer(id, 0), null);
  });
  it('ответ молча отличается от таймаута и лишние поля не попадают человеку', async () => {
    const h = harness();
    h.data.set('bot:cbqa:silent', { raw: JSON.stringify({ text: '', alert: false, token: 'public-test-only', timeout: true }) });
    assert.deepEqual(plain(await h.api.waitCallbackAnswer('silent', 0)), {});
    assert.equal(await h.api.waitCallbackAnswer('missing', 0), null);
  });
  it('только alert=true и строковый непустой text проходят фильтр результата', async () => {
    const h = harness();
    h.data.set('bot:cbqa:bad-types', { raw: JSON.stringify({ text: 12, alert: 1 }) });
    assert.deepEqual(plain(await h.api.waitCallbackAnswer('bad-types', 0)), {});
    h.data.set('bot:cbqa:alert', { raw: JSON.stringify({ text: 'Ответ', alert: true }) });
    assert.deepEqual(plain(await h.api.waitCallbackAnswer('alert', 0)), { text: 'Ответ', alert: true });
  });
  it('повреждённый JSON ответа гасит ожидание без проброса служебной строки', async () => {
    const h = harness(); h.data.set('bot:cbqa:broken', { raw: '{' });
    assert.deepEqual(plain(await h.api.waitCallbackAnswer('broken', 15_000)), {});
    assert.equal(h.read('bot:cbqa:broken'), null);
  });
  it('без ответа ждёт все 15 секунд, но не дольше и не в плотном цикле', async () => {
    const h = harness(); let settled = false;
    const waiting = h.api.waitCallbackAnswer('timeout', 15_000).then(result => { settled = true; return result; });
    await h.advance(14_999); assert.equal(settled, false);
    await h.advance(1); assert.equal(await waiting, null); assert.equal(h.timers.size, 0);
    const gets = h.calls.filter(call => call.op === 'get');
    assert.equal(gets.length, 61, 'одна немедленная проверка плюс 60 четвертьсекундных');
  });
  it('ответ на последней границе опроса выдаётся до таймаута', async () => {
    const h = harness(); const waiting = h.api.waitCallbackAnswer('last', 15_000);
    await h.advance(14_999); h.data.set('bot:cbqa:last', { raw: JSON.stringify({ text: 'успел' }) });
    await h.advance(1); assert.deepEqual(plain(await waiting), { text: 'успел' });
    assert.equal(h.timers.size, 0);
  });
  it('два устройства получают только ответ на собственное нажатие', async () => {
    const h = harness(), one = await h.api.createCallbackQuery(record);
    const two = await h.api.createCallbackQuery({ ...record, userId: 'person-two' });
    const first = h.api.waitCallbackAnswer(one, 1000), second = h.api.waitCallbackAnswer(two, 1000);
    await h.advance(0);
    await h.api.answerCallbackQuery(record.botId, two, { text: 'второму' });
    await h.advance(250); assert.deepEqual(plain(await second), { text: 'второму' });
    await h.api.answerCallbackQuery(record.botId, one, { text: 'первому' });
    await h.advance(250); assert.deepEqual(plain(await first), { text: 'первому' });
  });
  it('отменённое ожидание выходит на ближайшем опросе, таймеров не оставляет', async () => {
    const h = harness(), controller = new AbortController();
    const waiting = h.api.waitCallbackAnswer('cancelled', 15_000, controller.signal);
    await h.advance(0); controller.abort(); await h.advance(250);
    assert.equal(await waiting, null); assert.equal(h.timers.size, 0);
  });
  it('уже отменённый запрос без ответа не запускает ни одного таймера', async () => {
    const h = harness(), controller = new AbortController(); controller.abort();
    assert.equal(await h.api.waitCallbackAnswer('cancelled', 15_000, controller.signal), null);
    assert.equal(h.timers.size, 0);
  });
  it('четыре параллельных нажатия занимают три места и откатывают четвёртое', async () => { await checkPending(source); });
  it('освобождение возвращает место, счётчики людей и ботов независимы', async () => {
    const h = harness();
    for (let n = 0; n < 3; n++) assert.equal(await h.api.acquirePending('u:one', 3), true);
    assert.equal(await h.api.acquirePending('u:one', 3), false);
    assert.equal(await h.api.acquirePending('u:two', 3), true);
    assert.equal(await h.api.acquirePending('b:one', 20), true);
    await h.api.releasePending('u:one');
    assert.equal(await h.api.acquirePending('u:one', 3), true);
    assert.equal(h.read('bot:cbqn:u:one'), '3'); assert.equal(h.read('bot:cbqn:b:one'), '1');
  });
  it('ровно 20 нажатий боту доступны, 21-е не расходует место', async () => {
    const h = harness();
    for (let n = 0; n < 20; n++) assert.equal(await h.api.acquirePending('b:one', 20), true);
    assert.equal(await h.api.acquirePending('b:one', 20), false); assert.equal(h.read('bot:cbqn:b:one'), '20');
    await h.api.releasePending('b:one'); assert.equal(await h.api.acquirePending('b:one', 20), true);
  });
  it('после аварии процесса висящие места протухают через 30 секунд', async () => {
    const h = harness(); await h.api.acquirePending('u:crash', 1);
    await h.advance(29_999); assert.equal(h.read('bot:cbqn:u:crash'), '1');
    await h.advance(1); assert.equal(h.read('bot:cbqn:u:crash'), null);
    assert.equal(await h.api.acquirePending('u:crash', 1), true);
  });
  it('мутант без проверки владельца краснеет на чужом ответе, оригинал зелёный', async () => {
    await checkOwnership(source);
    await assert.rejects(checkOwnership(replaceOnce('if (rec.botId !== botId) return false;', 'if (false) return false;')),
      (error: unknown) => error instanceof assert.AssertionError
        && error.message.split(/\r?\n/, 1)[0] === 'чужой бот не отвечает на нажатие'
        && error.operator === 'strictEqual' && error.actual === true && error.expected === false);
  });
  it('мутант без единственного DEL краснеет на двух параллельных ответах', async () => {
    await checkOneAnswer(source);
    await assert.rejects(checkOneAnswer(replaceOnce('if ((await redisPub.del(queryKey(id))) !== 1) return false;',
      'await redisPub.del(queryKey(id));')),
    (error: unknown) => error instanceof assert.AssertionError
      && error.message.split(/\r?\n/, 1)[0] === 'один запрос принимает ровно один параллельный ответ'
      && error.operator === 'strictEqual' && error.actual === 2 && error.expected === 1);
  });
  it('мутант без отката отказа краснеет именно на лишнем занятом месте', async () => {
    await checkPending(source);
    await assert.rejects(checkPending(replaceOnce('await redisPub.decr(k).catch(() => 0);', '/* rollback lost */')),
      (error: unknown) => error instanceof assert.AssertionError
        && error.message.split(/\r?\n/, 1)[0] === 'отказ не расходует место'
        && error.operator === 'strictEqual' && error.actual === '4' && error.expected === '3');
  });
  it('мутант общего ключа ответа краснеет на ответе не тому устройству', async () => {
    await checkIsolatedAnswers(source);
    await assert.rejects(checkIsolatedAnswers(replaceOnce('const answerKey = (id: string) => `bot:cbqa:${id}`;',
      "const answerKey = (_id: string) => 'bot:cbqa:shared';")),
    (error: unknown) => error instanceof assert.AssertionError
      && error.message.split(/\r?\n/, 1)[0] === 'ответ адресован своему запросу, не соседнему'
      && error.operator === 'strictEqual' && error.actual === 'второму' && error.expected === 'первому');
  });
});
