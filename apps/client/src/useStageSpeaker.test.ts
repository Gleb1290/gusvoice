import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as rules from './stageLayoutRules';
import type { useStageSpeaker } from './useStageSpeaker';

const source = readFileSync(new URL('./useStageSpeaker.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Voice = Record<string, { speaking: boolean; level?: number }>;
class Clock {
  now = 10_000; next = 1;
  pending = new Map<number, { at: number; fn: () => void }>();
  callbacks = new Map<number, () => void>();
  setTimeout = (fn: () => void, ms: number) => {
    assert.ok(Number.isFinite(ms) && ms >= 0, 'таймер выбора имеет конечную неотрицательную задержку');
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fn }); this.callbacks.set(id, fn); return id;
  };
  clearTimeout = (id: number) => { this.pending.delete(id); };
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const first = [...this.pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!first) break;
      this.now = first[1].at; this.pending.delete(first[0]); first[1].fn();
    }
    this.now = end;
  }
  firstId() { const id = this.pending.keys().next().value; assert.equal(typeof id, 'number'); return id!; }
}
type Fixture = {
  clock: Clock; renders: (string | null)[]; speaker(): string | null;
  voice(next: Voice): Promise<void>; advance(ms: number): Promise<void>;
  render(next: { present?: string[]; enabled?: boolean }): Promise<void>;
  queued(id: number): Promise<void>; unmount(): Promise<void>;
};
async function fixture(work: (f: Fixture) => Promise<void>, raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const clock = new Clock(); class Time extends Date { static now() { return clock.now; } }
  const useStore = create<{ liveVoice: Voice }>(() => ({ liveVoice: {} }));
  const module = { exports: {} as { useStageSpeaker: typeof useStageSpeaker } };
  const deps: Record<string, unknown> = { react: React, './store': { useStore }, './stageLayoutRules': rules };
  let props = { present: ['a', 'b', 'c'], enabled: true }; let current: string | null = null; let mounted = true;
  const renders: (string | null)[] = [];
  const unmount = async () => { if (mounted) { await React.act(async () => root.unmount()); mounted = false; } };
  try {
    // Настоящие React/правила и целый хук; стор изолирован от приложения, время виртуальное.
    runInNewContext(ts.transpileModule(raw, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } }).outputText, { module, exports: module.exports, Date: Time,
      window: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
      require(id: string) { assert.ok(Object.hasOwn(deps, id), `неописанный импорт ${id}`); return deps[id]; },
    });
    function Probe() {
      current = module.exports.useStageSpeaker(props.present, props.enabled); renders.push(current);
      return React.createElement('output', null, current ?? 'none');
    }
    const render = async (next: Partial<typeof props>) => {
      props = { ...props, ...next };
      await React.act(async () => root.render(React.createElement(Probe)));
    };
    await render({});
    await work({ clock, renders, speaker: () => current, render, unmount,
      voice: async next => { await React.act(async () => useStore.setState({ liveVoice: next })); },
      advance: async ms => { await React.act(async () => clock.advance(ms)); },
      queued: async id => {
        const fn = clock.callbacks.get(id); assert.ok(fn);
        await React.act(async () => fn());
      },
    });
  } finally {
    await unmount(); host.remove(); await GlobalRegistrator.unregister();
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}

async function timerChoice(raw = source) {
  await fixture(async f => {
    assert.equal(f.speaker(), 'a'); assert.equal(f.clock.pending.size, 0);
    await f.voice({ b: { speaking: true } });
    assert.equal(f.clock.pending.size, 1);
    await f.advance(619); assert.equal(f.speaker(), 'a', 'R248 speaker-early: до отложенного пересчёта крупный не меняется');
    await f.advance(1); assert.equal(f.speaker(), 'b', 'R248 speaker-timer: продолжающаяся речь выбирается без нового события liveVoice');
    assert.equal(f.clock.pending.size, 0);
  }, raw);
}
// Класс ошибки: говорящий без второго VAD-события никогда не становится крупным.
it('R248 liveVoice выбирает нового говорящего таймером после 600 мс речи плюс 20 мс запаса', () => timerChoice());

// Класс ошибки: новый кандидат обходит 1500 мс удержания уже выбранного человека.
it('R248 смена после замолкания выдерживает hold и дожимается таймером без нового liveVoice', () => fixture(async f => {
  await f.voice({ b: { speaking: true } }); await f.advance(620); assert.equal(f.speaker(), 'b');
  await f.voice({ c: { speaking: true } });
  await f.advance(1519); assert.equal(f.speaker(), 'b');
  await f.advance(1); assert.equal(f.speaker(), 'c'); assert.equal(f.clock.pending.size, 0);
}));

// Класс ошибки: перебивание выдёргивает текущего, хотя он продолжает говорить.
it('R248 текущий продолжает говорить — перебивающий не меняет крупного и не заводит таймер', () => fixture(async f => {
  await f.voice({ a: { speaking: true }, b: { speaking: true } });
  await f.advance(5000); assert.equal(f.speaker(), 'a'); assert.equal(f.clock.pending.size, 0);
  await f.voice({ b: { speaking: true } });
  assert.equal(f.speaker(), 'b', 'давно говорящий кандидат выбирается сразу, когда текущий замолчал');
}));

// Класс ошибки: два коротких всплеска складываются в требуемые 600 мс непрерывной речи.
it('R248 пауза речи отменяет старый таймер, повторный всплеск требует новые полные 600 мс', () => fixture(async f => {
  await f.voice({ b: { speaking: true } }); const old = f.clock.firstId();
  await f.advance(400); await f.voice({}); assert.equal(f.clock.pending.size, 0);
  await f.advance(100); await f.voice({ b: { speaking: true } });
  assert.notEqual(f.clock.firstId(), old);
  await f.advance(120); assert.equal(f.speaker(), 'a', 'старая граница не суммирует раздельную речь');
  await f.advance(499); assert.equal(f.speaker(), 'a');
  await f.advance(1); assert.equal(f.speaker(), 'b');
}));

async function disabled(raw = source) {
  await fixture(async f => {
    await f.voice({ b: { speaking: true } }); const old = f.clock.firstId();
    await f.advance(400); await f.render({ enabled: false });
    assert.equal(f.speaker(), null); assert.equal(f.clock.pending.size, 0, 'R248 speaker-cancel: выключение отменяет таймер');
    await f.queued(old); await f.advance(5000);
    assert.equal(f.speaker(), null, 'очередной старый callback не включает выключенный режим');
    await f.render({ enabled: true });
    assert.equal(f.speaker(), 'a', 'R248 speaker-reset: повторный вход начинает новый отсчёт речи');
    await f.advance(619); assert.equal(f.speaker(), 'a'); await f.advance(1); assert.equal(f.speaker(), 'b');
  }, raw);
}
// Класс ошибки: выключенный режим продолжает таймер/хранит возраст речи и мгновенно выбирает старого кандидата после входа.
it('R248 enabled false сбрасывает крупного, речь и таймер; поздний callback безопасен, повторный вход считает заново', () => disabled());

async function departure(raw = source) {
  await fixture(async f => {
    await f.voice({ b: { speaking: true } }); await f.advance(620); assert.equal(f.speaker(), 'b');
    const mark = f.renders.length;
    await f.render({ present: ['a', 'c'] });
    assert.equal(f.renders.slice(mark).includes('b'), false, 'R248 speaker-gone: ушедший не появляется даже в первом рендере до эффекта');
    assert.equal(f.speaker(), 'a');
    await f.render({ present: [] }); assert.equal(f.speaker(), null); assert.equal(f.clock.pending.size, 0);
  }, raw);
}
// Класс ошибки: ушедший человек остаётся крупным кадр до useEffect или пустая сцена оставляет прежнюю карточку.
it('R248 ушедший крупный заменяется запасным без промежуточного старого кадра, пустая сцена возвращает null', () => departure());

// Класс ошибки: частые уровни VAD или речь человека вне present перезапускают minimum и лишние рендеры.
it('R248 изменение уровня при той же речи и посторонний liveVoice не сбивают таймер и не создают рендеров', () => fixture(async f => {
  await f.voice({ b: { speaking: true, level: 0.1 }, self: { speaking: true } });
  const timer = f.clock.firstId(); const renderCount = f.renders.length;
  await f.advance(300);
  await f.voice({ b: { speaking: true, level: 0.9 }, self: { speaking: false }, absent: { speaking: true } });
  assert.equal(f.renders.length, renderCount); assert.equal(f.clock.firstId(), timer);
  await f.render({ present: ['a', 'b', 'c'] }); assert.equal(f.clock.firstId(), timer, 'новый массив тех же identity не сбрасывает effect');
  await f.advance(320); assert.equal(f.speaker(), 'b');
}));

async function unmountCleanup(raw = source) {
  await fixture(async f => {
    await f.voice({ b: { speaking: true } }); assert.equal(f.clock.pending.size, 1);
    await f.unmount(); assert.equal(f.clock.pending.size, 0, 'R248 speaker-unmount: таймер не переживает хук');
  }, raw);
}
// Класс ошибки: таймер старой сцены тикает после ухода из канала.
it('R248 размонтирование снимает единственный отложенный пересчёт говорящего', () => unmountCleanup());

async function mutant(anchor: string, replacement: string, probe: (raw?: string) => Promise<void>, prefix: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'якорь хука уникален');
  await probe();
  await assert.rejects(() => probe(source.replace(anchor, replacement)), e => e instanceof assert.AssertionError && e.message.startsWith(prefix));
}
// Класс ошибки: таймер существует формально, но не пересчитывает выбор, либо каждый tick заново начинает речь.
it('R248 контрфакты пустого callback и сброса since на каждом эффекте отвергаются настоящим хуком', async () => {
  await mutant('window.setTimeout(() => setTick((n) => n + 1), wait + 20)', 'window.setTimeout(() => {}, wait + 20)', timerChoice, 'R248 speaker-timer:');
  await mutant('if (!since.has(id)) since.set(id, now);', 'since.set(id, now);', timerChoice, 'R248 speaker-timer:');
});

// Класс ошибки: сброс enabled/cleanup и первый кадр ушедшего незаметно ломаются при правильных чистых правилах.
it('R248 контрфакты несброшенной речи, неотменённого таймера и устаревшего крупного кадра обнаруживаются', async () => {
  await mutant('sinceRef.current.clear();', '// речь сохранилась', disabled, 'R248 speaker-reset:');
  await mutant('return () => window.clearTimeout(t);', 'return () => {};', unmountCleanup, 'R248 speaker-unmount:');
  await mutant('return speaker && present.includes(speaker) ? speaker : (present[0] ?? null);',
    'return speaker ?? (present[0] ?? null);', departure, 'R248 speaker-gone:');
});
