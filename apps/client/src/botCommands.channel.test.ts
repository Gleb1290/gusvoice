import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { BOT_COMMANDS_TTL_MS } from './botKeyboardRules';

const source = readFileSync(new URL('./botCommands.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Module = typeof import('./botCommands');
const bots = [{ id: 'bot-1', username: 'weatherbot', displayName: 'Погода', avatarUrl: null, commands: [{ command: 'weather', description: 'Погода' }] }];

function fixture(raw = source) {
  let now = 100_000;
  let bumps = 0;
  const effects: Array<() => void | (() => void)> = [];
  const calls: Array<{ kind: string; id: string; resolve(value: unknown): void; reject(error: unknown): void }> = [];
  const request = (kind: string, id: string) => new Promise((resolve, reject) => calls.push({ kind, id, resolve, reject }));
  class Clock extends Date { static now() { return now; } }
  const dependencies: Record<string, unknown> = {
    react: { useState: () => [0, () => { bumps++; }], useEffect: (effect: () => void | (() => void)) => effects.push(effect) },
    './api': { api: { channelBots: (id: string) => request('channel', id), convBotInfo: (id: string) => request('conv', id) } },
    './botKeyboardRules': { BOT_COMMANDS_TTL_MS },
  };
  const module = { exports: {} as Module };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date: Clock, require: (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `R303 закрытая граница кэша: ${id}`); return dependencies[id];
    } });
  const api = module.exports;
  return { api, calls, effects, time(value: number) { now = value; }, bumps: () => bumps,
    read(id: string | null | undefined) { const value = api.useChannelBots(id); return value && Array.from(value); },
    async answer(index: number, value: unknown, fail = false) {
      assert.ok(calls[index]);
      if (fail) calls[index].reject(value); else calls[index].resolve(value);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    } };
}

it('R303 канал запрашивается своим API, холодный список неизвестен до ответа и хранит всех ботов', async () => {
  const f = fixture();
  assert.equal(f.read('channel-a'), undefined);
  f.api.refreshChannelBots('channel-a');
  assert.deepEqual(f.calls.map(c => [c.kind, c.id]), [['channel', 'channel-a']]);
  await f.answer(0, { bots });
  assert.deepEqual(f.read('channel-a'), bots);
});
it('R303 кэш канала свеж на 59999 мс и протухает ровно на 60000 от ОТВЕТА', async () => {
  const f = fixture(); f.api.refreshChannelBots('channel-a');
  f.time(130_000); await f.answer(0, { bots });
  f.time(189_999); f.api.refreshChannelBots('channel-a'); assert.equal(f.calls.length, 1);
  f.time(190_000); f.api.refreshChannelBots('channel-a'); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.read('channel-a'), bots, 'во время обновления подсказка не пропадает');
  await f.answer(1, { bots: [] }); assert.deepEqual(f.read('channel-a'), []);
});
it('R303 force обходит TTL, но даже force не дублирует запрос в полёте', async () => {
  const f = fixture(); f.api.refreshChannelBots('a'); f.api.refreshChannelBots('a', true);
  assert.equal(f.calls.length, 1); await f.answer(0, { bots });
  f.api.refreshChannelBots('a'); assert.equal(f.calls.length, 1);
  f.api.refreshChannelBots('a', true); f.api.refreshChannelBots('a', true); assert.equal(f.calls.length, 2);
  await f.answer(1, { bots: [] }); f.api.refreshChannelBots('a', true); assert.equal(f.calls.length, 3);
  await f.answer(2, { bots });
});
it('R303 одинаковые id беседы и канала не делят ни кэш, ни блокировку inflight', async () => {
  const f = fixture(); f.api.refreshBotCommands('same'); f.api.refreshChannelBots('same'); f.api.refreshChannelBots('other');
  assert.deepEqual(f.calls.map(c => [c.kind, c.id]), [['conv', 'same'], ['channel', 'same'], ['channel', 'other']]);
  await f.answer(0, { commands: [{ command: 'dm', description: 'ЛС' }] });
  assert.equal(f.read('same'), undefined);
  await f.answer(1, { bots }); await f.answer(2, { bots: [] });
  assert.deepEqual(f.read('same'), bots); assert.deepEqual(f.read('other'), []);
});
it('R303 холодный 404 кэшируется пустым, тёплый сбой сохраняет список; успешный кривой ответ очищает', async () => {
  const f = fixture(); f.api.refreshChannelBots('a'); await f.answer(0, { status: 404 }, true);
  assert.deepEqual(f.read('a'), []);
  f.time(159_999); f.api.refreshChannelBots('a'); assert.equal(f.calls.length, 1);
  f.time(160_000); f.api.refreshChannelBots('a'); await f.answer(1, { bots });
  f.api.refreshChannelBots('a', true); await f.answer(2, new Error('synthetic network failure'), true);
  assert.deepEqual(f.read('a'), bots);
  f.api.refreshChannelBots('a', true); await f.answer(3, { bots: 'malformed' }); assert.deepEqual(f.read('a'), []);
});
it('R303 hook без канала не запрашивает, эффект подписывается и cleanup снимает уведомление', async () => {
  const f = fixture();
  for (const id of [null, undefined, '']) { assert.equal(f.read(id), undefined); f.effects.pop()!(); }
  assert.equal(f.calls.length, 0);
  f.read('a'); const cleanup = f.effects.pop()!(); assert.equal(typeof cleanup, 'function');
  await f.answer(0, { bots }); assert.equal(f.bumps(), 1);
  cleanup!(); f.api.refreshChannelBots('a', true); await f.answer(1, { bots: [] }); assert.equal(f.bumps(), 1);
});

it('R303 контрфакт кэша канала без TTL пойман на точной границе', async () => {
  async function probe(raw: string) {
    const f = fixture(raw); f.api.refreshChannelBots('a'); await f.answer(0, { bots });
    f.time(160_000); f.api.refreshChannelBots('a');
    assert.equal(f.calls.length, 2, 'R303 канал обновляется на минутной границе');
  }
  await probe(source);
  const anchor = '(!force && hit && Date.now() - hit.at < BOT_COMMANDS_TTL_MS)';
  assert.equal(source.split(anchor).length - 1, 2);
  // Мутируем только второе (канальное) условие, DM-кэш остаётся исходным.
  const index = source.lastIndexOf(anchor);
  const mutant = source.slice(0, index) + '(!force && hit)' + source.slice(index + anchor.length);
  await assert.rejects(() => probe(mutant), (e: unknown) => e instanceof assert.AssertionError &&
    e.operator === 'strictEqual' && e.message.split('\n')[0] === 'R303 канал обновляется на минутной границе' && e.actual === 1 && e.expected === 2);
});
