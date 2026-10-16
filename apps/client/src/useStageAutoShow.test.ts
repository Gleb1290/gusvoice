import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ConnectionState, RoomEvent } from 'livekit-client';
import * as rules from './stageAutoShowRules';

const source = readFileSync(new URL('./useStageAutoShow.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const prefsSource = readFileSync(new URL('./stageViewPrefs.ts', import.meta.url), 'utf8');
const key = 'gv_stage_hide_novideo';

class Clock {
  now = 0;
  private nextId = 1;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  readonly callbacks = new Map<number, () => void>();
  setTimeout = (callback: () => void, delay: number): number => {
    const id = this.nextId++;
    this.pending.set(id, { at: this.now + delay, callback });
    this.callbacks.set(id, callback);
    return id;
  };
  clearTimeout = (id: number): void => { this.pending.delete(id); };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.pending.entries()].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].at;
      this.pending.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
  firstId(): number {
    const id = this.pending.keys().next().value;
    assert.equal(typeof id, 'number', 'ожидается один запущенный таймер');
    return id!;
  }
  // clearTimeout не может убрать callback, уже попавший в очередь браузера.
  queued(id: number): void {
    const callback = this.callbacks.get(id);
    assert.equal(typeof callback, 'function');
    callback!();
  }
}

class FakeRoom {
  readonly listeners = new Set<() => void>();
  constructor(public state: ConnectionState = ConnectionState.Connected) {}
  on(event: RoomEvent, callback: () => void): this {
    assert.equal(event, RoomEvent.ConnectionStateChanged);
    this.listeners.add(callback);
    return this;
  }
  off(event: RoomEvent, callback: () => void): this {
    assert.equal(event, RoomEvent.ConnectionStateChanged);
    this.listeners.delete(callback);
    return this;
  }
  transition(state: ConnectionState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

type ProbeProps = { room: FakeRoom; channelId: string | null; hasVideo: boolean; revision: number };
type Preferences = { getHideNoVideo(): boolean; setHideNoVideo(hide: boolean): void; useHideNoVideo(): boolean };
type Fixture = {
  clock: Clock; room: FakeRoom; writes: boolean[]; prefs: Preferences;
  render(next: Partial<ProbeProps>): Promise<void>;
  advance(ms: number): Promise<void>;
  transition(...states: ConnectionState[]): Promise<void>;
  queued(id: number): Promise<void>;
  unmount(): Promise<void>;
};

async function fixture(check: (f: Fixture) => Promise<void>, raw = source,
  initial: Partial<ProbeProps> & { hideNoVideo?: boolean } = {}) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const clock = new Clock();
  const room = initial.room ?? new FakeRoom();
  const values = new Map<string, string>(initial.hideNoVideo === false ? [] : [[key, '1']]);
  const writes: boolean[] = [];
  const storage = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); writes.push(true); },
    removeItem: (name: string) => { values.delete(name); writes.push(false); },
  };
  const prefsModule = { exports: {} as Preferences };
  const hookModule = { exports: {} as { useStageAutoShow(input: Omit<ProbeProps, 'revision'> & { hideNoVideo: boolean }): void } };
  const options = { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  let props: ProbeProps = { room, channelId: 'voice-a', hasVideo: false, revision: 0, ...initial };
  const unmount = async () => {
    if (!mounted) return;
    await React.act(async () => root.unmount());
    mounted = false;
  };
  try {
    // Оба TS-модуля исполняются целиком. Настройка, React и layout effects настоящие;
    // только время и транспорт комнаты подменены, store/сеть здесь не загружаются.
    runInNewContext(ts.transpileModule(prefsSource, options).outputText, {
      module: prefsModule, exports: prefsModule.exports, localStorage: storage,
      require: (id: string) => { assert.equal(id, 'react'); return React; },
    });
    const deps: Record<string, unknown> = {
      react: React, 'livekit-client': { ConnectionState, RoomEvent },
      './stageViewPrefs': prefsModule.exports, './stageAutoShowRules': rules,
    };
    runInNewContext(ts.transpileModule(raw, options).outputText, {
      module: hookModule, exports: hookModule.exports,
      window: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
      require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `неожиданная зависимость ${id}`); return deps[id]; },
    });
    function Probe(p: ProbeProps) {
      const hideNoVideo = prefsModule.exports.useHideNoVideo();
      hookModule.exports.useStageAutoShow({ ...p, hideNoVideo });
      return null;
    }
    const render = async (next: Partial<ProbeProps>) => {
      props = { ...props, ...next };
      await React.act(async () => root.render(React.createElement(Probe, props)));
    };
    await render({});
    await check({ clock, room, writes, prefs: prefsModule.exports, render, unmount,
      advance: async ms => { await React.act(async () => clock.advance(ms)); },
      transition: async (...states) => { await React.act(async () => { for (const state of states) room.transition(state); }); },
      queued: async id => { await React.act(async () => clock.queued(id)); },
    });
  } finally {
    await unmount();
    host.remove();
    await GlobalRegistrator.unregister();
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}

// Для страховок R167 отсчёт теперь начинается не при входе, а после конца видео.
async function afterVideo(check: (f: Fixture) => Promise<void>, raw = source,
  initial: Partial<ProbeProps> & { hideNoVideo?: boolean } = {}) {
  await fixture(async f => {
    await f.render({ hasVideo: false });
    await check(f);
  }, raw, { ...initial, hasVideo: true });
}

async function delayBoundary(raw = source) {
  await afterVideo(async ({ advance, prefs, writes, clock }) => {
    assert.equal(clock.pending.size, 1);
    await advance(0);
    assert.equal(prefs.getHideNoVideo(), true, 'конец видео не сбрасывает выбор немедленно');
    assert.equal(writes.length, 0);
    await advance(2999);
    assert.equal(prefs.getHideNoVideo(), true);
    assert.equal(writes.length, 0, '2999 мс ещё недостаточно');
    await advance(1);
    assert.equal(prefs.getHideNoVideo(), false, 'ровно 3000 мс возвращают людей');
    assert.deepEqual(writes, [false], 'выключение сохранено один раз');
    await advance(9000);
    assert.deepEqual(writes, [false], 'после сброса нет повторных записей');
  }, raw);
}

it('R168 конец видео в подключённом канале сохраняет выбор до 2999 мс и выключает ровно на 3000', () => delayBoundary());

it('R167 появление видео до трёх секунд отменяет старый отсчёт и требует новые полные три секунды', () => afterVideo(async f => {
  const stale = f.clock.firstId();
  await f.advance(2900);
  await f.render({ hasVideo: true });
  assert.equal(f.clock.pending.size, 0);
  await f.queued(stale);
  await f.advance(200);
  assert.equal(f.writes.length, 0);
  await f.render({ hasVideo: false });
  await f.advance(2999);
  assert.equal(f.writes.length, 0);
  await f.advance(1);
  assert.deepEqual(f.writes, [false]);
}));

it('R167 камера удерживает скрытие сколько угодно; после исчезновения камеры начинается задержка', () => fixture(async f => {
  assert.equal(f.clock.pending.size, 0);
  await f.advance(30000);
  assert.equal(f.prefs.getHideNoVideo(), true);
  assert.equal(f.writes.length, 0);
  await f.render({ hasVideo: false });
  await f.advance(3000);
  assert.deepEqual(f.writes, [false]);
}, source, { hasVideo: true }));

it('R167 уже выключенная настройка не создаёт таймер и не перезаписывает хранилище', () => fixture(async f => {
  assert.equal(f.clock.pending.size, 0);
  await f.advance(30000);
  await f.transition(ConnectionState.Reconnecting, ConnectionState.Connected);
  await f.advance(30000);
  assert.equal(f.prefs.getHideNoVideo(), false);
  assert.equal(f.writes.length, 0);
}, source, { hideNoVideo: false }));

it('R167 новый рендер или список без видео не перезапускает начатый отсчёт', () => afterVideo(async f => {
  const first = f.clock.firstId();
  await f.advance(1000);
  await f.render({ hasVideo: false, revision: 1 });
  await f.advance(1000);
  await f.render({ hasVideo: false, revision: 2 });
  assert.equal(f.clock.firstId(), first);
  await f.advance(999);
  assert.equal(f.writes.length, 0);
  await f.advance(1);
  assert.deepEqual(f.writes, [false]);
}));

it('R168 отключённая комната не сбрасывает выбор после конца видео; подключение начинает полные три секунды', () => afterVideo(async f => {
  assert.equal(f.clock.pending.size, 0);
  await f.advance(9000);
  assert.equal(f.writes.length, 0);
  await f.transition(ConnectionState.Connected);
  await f.advance(2999);
  assert.equal(f.writes.length, 0);
  await f.advance(1);
  assert.deepEqual(f.writes, [false]);
}, source, { room: new FakeRoom(ConnectionState.Disconnected) }));

it('R167 connecting и reconnecting не считаются живым подключением и отменяют старый таймер', async () => {
  for (const state of [ConnectionState.Connecting, ConnectionState.Reconnecting]) {
    await afterVideo(async f => {
      const stale = f.clock.firstId();
      await f.advance(2999);
      await f.transition(state);
      assert.equal(f.clock.pending.size, 0);
      await f.queued(stale);
      await f.advance(9000);
      assert.equal(f.writes.length, 0, state);
      await f.transition(ConnectionState.Connected);
      await f.advance(2999);
      assert.equal(f.writes.length, 0);
      await f.advance(1);
      assert.deepEqual(f.writes, [false]);
    });
  }
});

it('R167 disconnect и reconnect в одном act отменяют старый callback и начинают новый полный отсчёт', () => afterVideo(async f => {
  const stale = f.clock.firstId();
  await f.advance(2999);
  await f.transition(ConnectionState.Disconnected, ConnectionState.Connected);
  assert.notEqual(f.clock.firstId(), stale);
  await f.queued(stale);
  assert.equal(f.writes.length, 0, 'старый callback не сбрасывает уже переподключённую комнату');
  await f.advance(2999);
  assert.equal(f.writes.length, 0);
  await f.advance(1);
  assert.deepEqual(f.writes, [false]);
}));

it('R167 callback проверяет текущее состояние комнаты даже без доставленного события разрыва', () => afterVideo(async f => {
  f.room.state = ConnectionState.Disconnected;
  await f.advance(3000);
  assert.equal(f.prefs.getHideNoVideo(), true);
  assert.equal(f.writes.length, 0);
  await f.transition(ConnectionState.Connected);
  await f.advance(3000);
  assert.deepEqual(f.writes, [false]);
}));

it('R168 ручное выключение снимает таймер, защищает от позднего callback и сбрасывает память видео', () => afterVideo(async f => {
  const stale = f.clock.firstId();
  await f.advance(2999);
  await React.act(async () => f.prefs.setHideNoVideo(false));
  assert.equal(f.clock.pending.size, 0);
  await f.queued(stale);
  await f.advance(9000);
  assert.deepEqual(f.writes, [false], 'это единственная ручная запись, авто-сброса нет');
  await React.act(async () => f.prefs.setHideNoVideo(true));
  assert.equal(f.clock.pending.size, 0);
  await f.queued(stale);
  await f.advance(10000);
  assert.equal(f.prefs.getHideNoVideo(), true, 'старое видео не относится к новому включению');
  assert.deepEqual(f.writes, [false, true]);
  await f.render({ hasVideo: true });
  await f.render({ hasVideo: false });
  await f.advance(2999);
  assert.deepEqual(f.writes, [false, true]);
  await f.advance(1);
  assert.deepEqual(f.writes, [false, true, false]);
}));

it('R168 смена канала отменяет прежний callback и ждёт новое видео вместо переноса старой памяти', () => afterVideo(async f => {
  const stale = f.clock.firstId();
  await f.advance(2500);
  await f.render({ channelId: 'voice-b' });
  assert.equal(f.clock.pending.size, 0);
  await f.queued(stale);
  await f.advance(10000);
  assert.equal(f.prefs.getHideNoVideo(), true, 'видео прежнего канала не запускает таймер в новом');
  assert.equal(f.writes.length, 0);
  await f.render({ hasVideo: true });
  await f.render({ hasVideo: false });
  await f.advance(2999);
  assert.equal(f.writes.length, 0);
  await f.advance(1);
  assert.deepEqual(f.writes, [false]);
}));

it('R168 выход из канала отменяет таймер; новый пустой канал сохраняет настройку до нового видео', () => afterVideo(async f => {
  const stale = f.clock.firstId();
  await f.render({ channelId: null });
  assert.equal(f.clock.pending.size, 0);
  await f.queued(stale);
  await f.transition(ConnectionState.Disconnected, ConnectionState.Connected);
  await f.advance(9000);
  assert.equal(f.writes.length, 0);
  await f.render({ channelId: 'voice-c' });
  assert.equal(f.clock.pending.size, 0);
  await f.advance(10000);
  assert.equal(f.prefs.getHideNoVideo(), true);
  assert.equal(f.writes.length, 0);
  await f.render({ hasVideo: true });
  await f.render({ hasVideo: false });
  await f.advance(3000);
  assert.deepEqual(f.writes, [false]);
}));

it('R167 замена комнаты снимает старый слушатель и старый callback не влияет на новую комнату', () => afterVideo(async f => {
  const stale = f.clock.firstId();
  const replacement = new FakeRoom();
  await f.advance(2500);
  await f.render({ room: replacement });
  assert.equal(f.room.listeners.size, 0);
  assert.equal(replacement.listeners.size, 1);
  await f.queued(stale);
  await f.transition(ConnectionState.Disconnected, ConnectionState.Connected);
  await f.advance(2999);
  assert.equal(f.writes.length, 0);
  await f.advance(1);
  assert.deepEqual(f.writes, [false]);
  await f.unmount();
  assert.equal(replacement.listeners.size, 0);
}));

it('R167 размонтирование снимает таймер и слушатель; поздние callbacks и события комнаты безопасны', () => afterVideo(async f => {
  const stale = f.clock.firstId();
  await f.advance(2999);
  await f.unmount();
  assert.equal(f.clock.pending.size, 0);
  assert.equal(f.room.listeners.size, 0);
  await f.queued(stale);
  await f.transition(ConnectionState.Disconnected, ConnectionState.Connected);
  await f.advance(9000);
  assert.equal(f.writes.length, 0);
  assert.equal(f.prefs.getHideNoVideo(), true);
}));

it('R167 мутант без задержки обнаруживается на настоящем хуке до границы трёх секунд', async () => {
  const anchor = '}, STAGE_AUTO_SHOW_DELAY_MS);';
  assert.equal(source.split(anchor).length - 1, 1, 'точный якорь задержки встречается один раз');
  await delayBoundary();
  await assert.rejects(() => delayBoundary(source.replace(anchor, '}, 0);')), assert.AssertionError);
});

it('R168 включение в пустом канале не выключает настройку ни через три, ни через десять секунд', () => fixture(async f => {
  await React.act(async () => f.prefs.setHideNoVideo(true));
  assert.equal(f.clock.pending.size, 0);
  await f.advance(3000);
  assert.equal(f.prefs.getHideNoVideo(), true);
  assert.deepEqual(f.writes, [true]);
  await f.advance(7000);
  assert.equal(f.clock.pending.size, 0);
  assert.equal(f.prefs.getHideNoVideo(), true);
  assert.deepEqual(f.writes, [true], 'сам выбор скрыть людей не является концом видео');
}, source, { hideNoVideo: false }));

it('R168 после пустого входа появившееся видео запоминается и его конец запускает полные три секунды', () => fixture(async f => {
  await f.advance(10000);
  assert.equal(f.clock.pending.size, 0);
  assert.equal(f.writes.length, 0);
  await f.render({ hasVideo: true });
  await f.advance(10000);
  assert.equal(f.clock.pending.size, 0);
  assert.equal(f.prefs.getHideNoVideo(), true);
  await f.render({ hasVideo: false });
  assert.equal(f.clock.pending.size, 1);
  await f.advance(2999);
  assert.equal(f.writes.length, 0);
  await f.advance(1);
  assert.deepEqual(f.writes, [false]);
}));

it('R168 видео при выключенной настройке не учитывается при последующем включении в пустом канале', () => fixture(async f => {
  await f.render({ hasVideo: false });
  await React.act(async () => f.prefs.setHideNoVideo(true));
  assert.equal(f.clock.pending.size, 0);
  await f.advance(10000);
  assert.equal(f.prefs.getHideNoVideo(), true);
  assert.deepEqual(f.writes, [true]);
}, source, { hasVideo: true, hideNoVideo: false }));

it('R168 включение при уже идущем видео учитывает его и выключает настройку после его конца', () => fixture(async f => {
  await React.act(async () => f.prefs.setHideNoVideo(true));
  await f.advance(10000);
  assert.equal(f.clock.pending.size, 0);
  assert.deepEqual(f.writes, [true]);
  await f.render({ hasVideo: false });
  await f.advance(2999);
  assert.equal(f.prefs.getHideNoVideo(), true);
  assert.deepEqual(f.writes, [true]);
  await f.advance(1);
  assert.deepEqual(f.writes, [true, false]);
}, source, { hasVideo: true, hideNoVideo: false }));

it('R168 видео в новом канале сразу учитывается после смены канала, а старый callback не выключает настройку', () => afterVideo(async f => {
  const stale = f.clock.firstId();
  await f.advance(2999);
  await f.render({ channelId: 'voice-b', hasVideo: true });
  await f.queued(stale);
  await f.advance(10000);
  assert.equal(f.clock.pending.size, 0);
  assert.equal(f.writes.length, 0);
  await f.render({ hasVideo: false });
  await f.advance(2999);
  assert.equal(f.prefs.getHideNoVideo(), true);
  await f.advance(1);
  assert.deepEqual(f.writes, [false]);
}));

it('R168 видео вне канала не оставляет память при входе в пустой канал, но новое видео там учитывается', () => fixture(async f => {
  await f.render({ hasVideo: false });
  await f.render({ channelId: 'voice-a' });
  await f.advance(10000);
  assert.equal(f.clock.pending.size, 0);
  assert.equal(f.prefs.getHideNoVideo(), true);
  assert.equal(f.writes.length, 0);
  await f.render({ hasVideo: true });
  await f.render({ hasVideo: false });
  await f.advance(2999);
  assert.equal(f.writes.length, 0);
  await f.advance(1);
  assert.deepEqual(f.writes, [false]);
}, source, { channelId: null, hasVideo: true }));
