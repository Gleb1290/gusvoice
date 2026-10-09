import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { UserLastSeen, LastSeenApprox } from '@gusvoice/shared';
import ts from 'typescript';

const source = readFileSync(new URL('./useLastSeen.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const initialAt = Date.UTC(2026, 9, 8, 12);
const base: UserLastSeen = { userId: 'peer', online: true, exact: true, at: null, approx: null, byMe: false, canCall: true };
before(() => {
  GlobalRegistrator.register();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
after(() => GlobalRegistrator.unregister());

function load(raw = source) {
  let now = initialAt;
  const state = { onlineUsers: ['peer'], dmAwayUsers: [] as string[], serverFeatures: ['lastseen1', 'presence4'], user: null };
  const timers = new Map<number, { at: number; fn: () => void }>();
  const pending: ((v: UserLastSeen) => void)[] = [];
  let serial = 0;
  class Clock extends Date {
    constructor() { super(now); }
    static now() { return now; }
  }
  // ISO-конверсия с аргументом должна оставаться настоящей; часы меняются только для now/new Date().
  const FakeDate = new Proxy(Date, {
    construct: (target, args) => Reflect.construct(target, args.length ? args : [now]),
    get: (target, key) => key === 'now' ? Clock.now : Reflect.get(target, key),
  });
  const dependencies: Record<string, unknown> = {
    react: React,
    './store': { useStore: (select: (s: typeof state) => unknown) => select(state) },
    './api': { api: { userLastSeen: () => new Promise<UserLastSeen>(resolve => pending.push(resolve)) } },
    './dmOnline': { dmPresent: (s: typeof state, id: string) => s.onlineUsers.includes(id) && !s.dmAwayUsers.includes(id), serverPresence4: () => true },
    './lastSeenText': { serverLastSeen: () => true, lastSeenNextChangeMs: () => null },
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    module, exports: module.exports, Date: FakeDate,
    require: (id: string) => { assert.ok(id in dependencies, `известная зависимость ${id}`); return dependencies[id]; },
    setTimeout: (fn: () => void, delay: number) => { const id = ++serial; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  return {
    api: module.exports as typeof import('./useLastSeen'), state, pending,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    },
  };
}

function mutate(from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'мутант меняет ровно один участок');
  return source.replace(from, to);
}

it('leftJustNow: полная таблица точности, онлайн, примерного срока и взаимной приватности сохраняет остальные поля', () => {
  const { leftJustNow } = load().api;
  for (const exact of [false, true]) for (const online of [false, true]) for (const byMe of [false, true]) {
    for (const approx of [null, 'recently', 'week', 'month', 'long'] as (LastSeenApprox | null)[]) {
      const v = { ...base, exact, online, byMe, approx, at: '2026-01-01T00:00:00.000Z' };
      const before = { ...v };
      assert.deepEqual({ ...leftJustNow(v, initialAt) }, {
        ...v, online: false, at: exact ? '2026-10-08T12:00:00.000Z' : null, approx: exact ? null : approx ?? 'recently',
      });
      assert.deepEqual(v, before, 'входной ответ не изменён');
    }
  }
});

async function checkTransition(raw: string, exact: boolean) {
  const h = load(raw), host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const frames: (UserLastSeen | null)[] = [];
  function Harness() {
    const seen = h.api.useLastSeen('peer');
    // Смотрим первый ЗАКОММИЧЕННЫЙ кадр, не последний кадр act после пассивных эффектов.
    React.useLayoutEffect(() => { frames.push(seen && { ...seen }); });
    return null;
  }
  try {
    await React.act(async () => { root.render(React.createElement(Harness)); });
    assert.equal(frames.at(-1), null, 'до первого REST не выдумываем ответ');
    await React.act(async () => { h.advance(0); });
    assert.equal(h.pending.length, 1);
    await React.act(async () => { h.pending.shift()!({ ...base, exact }); });
    assert.equal(frames.at(-1)?.online, true);
    h.advance(1000);
    h.state.onlineUsers = [];
    const first = frames.length;
    await React.act(async () => { root.render(React.createElement(Harness)); });
    const expected = { ...base, exact, online: false, at: exact ? '2026-10-08T12:00:01.000Z' : null, approx: exact ? null : 'recently' };
    assert.deepEqual(frames[first], expected, 'первый кадр выхода сразу офлайн без ожидания эффекта или REST');
    assert.equal(h.pending.length, 0, 'выход не запускает REST раньше задержки');
    await React.act(async () => { h.advance(1499); });
    assert.equal(h.pending.length, 0);
    assert.deepEqual(frames.at(-1), expected);
    await React.act(async () => { h.advance(1); });
    assert.equal(h.pending.length, 1, 'ровно через 1500 мс начинается запрос');
    assert.deepEqual(frames.at(-1), expected, 'незавершённый REST не возвращает старый онлайн');
    const fresh: UserLastSeen = { ...base, exact, online: false, at: exact ? '2026-10-08T12:00:02.500Z' : null, approx: exact ? null : 'week' };
    await React.act(async () => { h.pending.shift()!(fresh); });
    assert.deepEqual(frames.at(-1), fresh, 'ответ после выхода не переписывается локальным goneAt');
  } finally {
    await React.act(async () => root.unmount());
    host.remove();
  }
}

for (const exact of [true, false]) it(`первый кадр онлайн → офлайн ${exact ? 'с видимым временем' : 'со скрытым временем'} немедленно показывает выход, свежий REST принимается`, async () => {
  await checkTransition(source, exact);
});

it('перенос goneAt в пассивный эффект обнаруживается по первому кадру, даже если следующий уже исправлен', async () => {
  await checkTransition(source, true);
  const mutant = mutate('  if (prevOnline !== online) {\n    setPrevOnline(online);\n    setGoneAt(online ? null : Date.now());\n  }',
    '  useEffect(() => {\n    if (prevOnline !== online) {\n      setPrevOnline(online);\n      setGoneAt(online ? null : Date.now());\n    }\n  }, [online, prevOnline]);');
  await assert.rejects(checkTransition(mutant, true), (e: unknown) => e instanceof assert.AssertionError && e.message.includes('первый кадр выхода'));
});

it('удаление got < goneAt обнаруживается: свежий REST должен заменить локальную отметку выхода', async () => {
  await checkTransition(source, true);
  const mutant = mutate(' && view.got < goneAt', '');
  await assert.rejects(checkTransition(mutant, true), (e: unknown) => e instanceof assert.AssertionError && e.message.includes('ответ после выхода'));
});
