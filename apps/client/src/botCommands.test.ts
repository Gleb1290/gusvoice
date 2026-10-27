import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import type { BotCommandInfo } from '@gusvoice/shared';
import { BOT_COMMANDS_TTL_MS } from './botKeyboardRules';

// Весь настоящий модуль в отдельном VM-контексте: кэши тестов не пересекаются, API и часы — единственные подмены.
const source = readFileSync(new URL('./botCommands.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const first = [{ command: 'status', description: 'Состояние' }];
const second = [{ command: 'help', description: 'Помощь' }];
type Api = typeof import('./botCommands');
type Pending = { id: string; resolve(info: unknown): void; reject(error: unknown): void };
const oldAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
before(() => {
  GlobalRegistrator.register({ url: 'https://client.example.test/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
after(async () => {
  await GlobalRegistrator.unregister();
  if (oldAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', oldAct);
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

async function fixture(check: (f: {
  api: Api; calls: Pending[]; time(value: number): void;
  mount(id: string | null | undefined): Promise<void>; unmount(): Promise<void>;
  read(): BotCommandInfo[] | undefined; renders(): number;
  answer(index: number, value: unknown): Promise<void>; fail(index: number, error: unknown): Promise<void>;
}) => Promise<void>, raw = source) {
  let now = 1_000_000;
  class Clock extends Date { static now() { return now; } }
  const calls: Pending[] = [];
  const deps: Record<string, unknown> = {
    react: React,
    './api': { api: { convBotInfo: (id: string) => new Promise<unknown>((resolve, reject) => { calls.push({ id, resolve, reject }); }) } },
    './botKeyboardRules': { BOT_COMMANDS_TTL_MS },
  };
  const module = { exports: {} as Api };
  runInNewContext(ts.transpileModule(raw, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, Date: Clock,
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `R302 описана граница кэша ${id}`); return deps[id]; },
  });
  const api = module.exports;
  let latest: BotCommandInfo[] | undefined;
  let renders = 0;
  function Viewer({ id }: { id: string | null | undefined }) {
    latest = api.useBotCommands(id);
    renders++;
    return React.createElement('output', null, latest?.map(c => c.command).join(','));
  }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let live = true;
  const unmount = async () => { if (live) { await React.act(async () => root.unmount()); live = false; } };
  const settle = async (fn: () => void) => {
    await React.act(async () => {
      fn();
      // then + finally настоящего модуля должны закончиться до проверки кэша/перерисовки.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
  };
  try {
    await check({
      api, calls, time: value => { now = value; },
      mount: async id => { assert.ok(live); await React.act(async () => root.render(React.createElement(Viewer, { id }))); },
      unmount, read: () => latest === undefined ? undefined : Array.from(latest), renders: () => renders,
      answer: (index, value) => settle(() => { assert.ok(calls[index], `запрос ${index} существует`); calls[index].resolve(value); }),
      fail: (index, error) => settle(() => { assert.ok(calls[index], `запрос ${index} существует`); calls[index].reject(error); }),
    });
  } finally { await unmount(); host.remove(); }
}

it('R302 настоящий hook начинает без списка, запрашивает нужную беседу и перерисовывается после ответа', async () => {
  await fixture(async f => {
    await f.mount('conv-a');
    assert.equal(f.read(), undefined);
    assert.deepEqual(f.calls.map(c => c.id), ['conv-a']);
    const before = f.renders();
    await f.answer(0, { commands: first });
    assert.deepEqual(f.read(), first);
    assert.ok(f.renders() > before, 'ответ уведомляет реально смонтированный React hook');
  });
});

it('R302 повтор до минуты использует кэш, ровно через 60000 мс уже запрашивает заново', async () => {
  await fixture(async f => {
    await f.mount('conv-a'); await f.answer(0, { commands: first });
    f.time(1_059_999); f.api.refreshBotCommands('conv-a');
    assert.equal(f.calls.length, 1, 'на 59999 мс запроса нет');
    assert.deepEqual(f.read(), first);
    f.time(1_060_000); f.api.refreshBotCommands('conv-a');
    assert.equal(f.calls.length, 2, 'на границе 60000 мс кэш устарел');
    assert.deepEqual(f.read(), first, 'пока обновление идёт, старые подсказки не исчезают');
    await f.answer(1, { commands: second }); assert.deepEqual(f.read(), second);
    f.time(1_120_001); f.api.refreshBotCommands('conv-a');
    assert.equal(f.calls.length, 3, 'после минуты тоже обновляем');
    await f.answer(2, { commands: first });
  });
});

it('R302 TTL отсчитывается от получения ответа, а не от начала медленного запроса', async () => {
  await fixture(async f => {
    await f.mount('conv-a');
    f.time(1_030_000); await f.answer(0, { commands: first });
    f.time(1_060_000); f.api.refreshBotCommands('conv-a');
    assert.equal(f.calls.length, 1, 'списку всего 30000 мс');
    f.time(1_089_999); f.api.refreshBotCommands('conv-a'); assert.equal(f.calls.length, 1);
    f.time(1_090_000); f.api.refreshBotCommands('conv-a'); assert.equal(f.calls.length, 2);
    await f.answer(1, { commands: second });
  });
});

it('R302 принудительное обновление обходит свежесть, но не создаёт второй запрос в полёте', async () => {
  await fixture(async f => {
    await f.mount('conv-a');
    f.api.refreshBotCommands('conv-a'); f.api.refreshBotCommands('conv-a', true);
    assert.equal(f.calls.length, 1, 'повтор и force дедуплицируются до ответа');
    await f.answer(0, { commands: first });
    f.api.refreshBotCommands('conv-a'); assert.equal(f.calls.length, 1);
    f.api.refreshBotCommands('conv-a', true); assert.equal(f.calls.length, 2, 'force обновляет свежий список');
    f.api.refreshBotCommands('conv-a', true); assert.equal(f.calls.length, 2);
    await f.answer(1, { commands: second });
    f.api.refreshBotCommands('conv-a', true); assert.equal(f.calls.length, 3, 'finally снимает признак запроса');
    await f.answer(2, { commands: first });
  });
});

it('R302 две беседы имеют независимые запросы и кэши, переключение не подставляет чужие команды', async () => {
  await fixture(async f => {
    await f.mount('conv-a'); await f.mount('conv-b');
    assert.equal(f.read(), undefined);
    assert.deepEqual(f.calls.map(c => c.id), ['conv-a', 'conv-b']);
    await f.answer(0, { commands: first }); assert.equal(f.read(), undefined, 'ответ A не становится списком B');
    await f.answer(1, { commands: second }); assert.deepEqual(f.read(), second);
    await f.mount('conv-a'); assert.deepEqual(f.read(), first); assert.equal(f.calls.length, 2);
    await f.mount('conv-b'); assert.deepEqual(f.read(), second); assert.equal(f.calls.length, 2);
  });
});

it('R302 холодный кэш при 404 становится пустым списком и не повторяет отказ до TTL', async () => {
  await fixture(async f => {
    await f.mount('old-server'); await f.fail(0, { status: 404 });
    assert.deepEqual(f.read(), []);
    f.time(1_059_999); f.api.refreshBotCommands('old-server'); assert.equal(f.calls.length, 1);
    f.time(1_060_000); f.api.refreshBotCommands('old-server'); assert.equal(f.calls.length, 2);
    await f.answer(1, { commands: first }); assert.deepEqual(f.read(), first, 'восстановившийся сервер снова даёт команды');
  });
});

it('R302 холодный кэш при сетевом сбое тоже пуст, следующая принудительная попытка разрешена', async () => {
  await fixture(async f => {
    await f.mount('offline'); await f.fail(0, new Error('network'));
    assert.deepEqual(f.read(), []);
    f.api.refreshBotCommands('offline', true); assert.equal(f.calls.length, 2);
    await f.answer(1, { commands: second }); assert.deepEqual(f.read(), second);
  });
});

it('R302 сбой обновления сохраняет предыдущий список, включая 404, и заново запускает TTL', async () => {
  // В коде отказ хранит hit?.commands: не выдаём желаемое очищение за существующее поведение.
  await fixture(async f => {
    await f.mount('conv-a'); await f.answer(0, { commands: first });
    f.time(1_060_000); f.api.refreshBotCommands('conv-a'); await f.fail(1, { status: 500 });
    assert.deepEqual(f.read(), first);
    f.time(1_119_999); f.api.refreshBotCommands('conv-a'); assert.equal(f.calls.length, 2);
    f.time(1_120_000); f.api.refreshBotCommands('conv-a'); await f.fail(2, { status: 404 });
    assert.deepEqual(f.read(), first, '404 с тёплым кэшем тоже сохраняет старые команды');
    f.api.refreshBotCommands('conv-a', true); await f.answer(3, { commands: [] });
    assert.deepEqual(f.read(), [], 'успешный пустой ответ, в отличие от ошибки, очищает список');
  });
});

it('R302 null, undefined и пустой идентификатор hook не создают сетевых запросов', async () => {
  await fixture(async f => {
    for (const id of [null, undefined, '']) {
      await f.mount(id); assert.equal(f.read(), undefined); assert.equal(f.calls.length, 0);
    }
    await f.mount('conv-a'); assert.equal(f.calls.length, 1);
    await f.answer(0, { commands: first }); assert.deepEqual(f.read(), first);
    await f.mount(null); assert.equal(f.read(), undefined); assert.equal(f.calls.length, 1);
  });
});

it('R302 отсутствие массива команд безопасно даёт пустой список и кэшируется', async () => {
  await fixture(async f => {
    await f.mount('conv-a'); await f.answer(0, null); assert.deepEqual(f.read(), []);
    f.api.refreshBotCommands('conv-a'); assert.equal(f.calls.length, 1);
    f.api.refreshBotCommands('conv-a', true); await f.answer(1, { commands: 'not-an-array' });
    assert.deepEqual(f.read(), []);
  });
});

it('R302 некорректные элементы массива отфильтровываются, валидные команды сохраняют порядок', async () => {
  await fixture(async f => {
    await f.mount('conv-a');
    await f.answer(0, { commands: [null, {}, { command: '' }, { command: 7 }, first[0], second[0]] });
    assert.deepEqual(f.read(), [...first, ...second]);
  });
});

it('R302 размонтированный hook снимает подписку, поздний ответ не вызывает его рендер', async () => {
  await fixture(async f => {
    await f.mount('conv-a'); await f.unmount(); const before = f.renders();
    await f.answer(0, { commands: first });
    assert.equal(f.renders(), before);
    f.api.refreshBotCommands('conv-a'); assert.equal(f.calls.length, 1, 'ответ остаётся в модульном кэше после ухода');
  });
});
