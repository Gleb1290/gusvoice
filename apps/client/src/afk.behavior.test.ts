import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './afkRules.js';
import type * as Afk from './afk.js';

const source = readFileSync(new URL('./afk.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const QUIET_MARKER = 'R284 голос и переключение микрофона не являются вводом';
type State = {
  user: { id: string; status: string; statusAuto: boolean };
  liveVoice: Record<string, { speaking: boolean }>;
  selfMuted: boolean;
};
type Listener = (state: State, previous: State) => void;

function fixture(raw = source, autoAway = true) {
  let now = 1_000_000;
  let state: State = {
    user: { id: 'self', status: 'away', statusAuto: autoAway },
    liveVoice: { self: { speaking: false }, peer: { speaking: false } },
    selfMuted: true,
  };
  const subscribers = new Set<Listener>();
  let subscribeCalls = 0;
  const writes: Array<{ status: string; auto: boolean }> = [];
  const gateway: boolean[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const appWindow = Object.assign(new EventTarget(), {
    setInterval: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
  });
  const appDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  function publish(next: State) {
    const previous = state;
    state = next;
    for (const listener of subscribers) listener(state, previous);
  }
  const useStore = {
    getState: () => state,
    setState: (update: (s: State) => Partial<State>) => publish({ ...state, ...update(state) }),
    subscribe: (listener: Listener) => {
      subscribeCalls++;
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  };
  const dependencies: Record<string, unknown> = {
    './afkRules': rules,
    './api': { api: { setStatus: async (body: { status: string; auto: boolean }) => {
      writes.push({ ...body });
      return { status: body.status, statusAuto: body.auto };
    } } },
    './notifications': { windowFocused: () => false },
    './sockets': { noteGatewayActive: (active: boolean) => gateway.push(active) },
    './store': { useStore },
  };
  const module = { exports: {} as typeof Afk };
  const compiled = ts.transpileModule(raw, {
    fileName: 'afk.ts', reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  assert.equal((compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0,
    'R284 целый afk.ts синтаксически корректен');
  runInNewContext(compiled.outputText, {
    module, exports: module.exports, window: appWindow, document: appDocument,
    Date: class extends Date { static now() { return now; } },
    require: (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `R284 известная граница импорта ${id}`);
      return dependencies[id];
    },
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  const afk = module.exports;
  afk.initAfk();
  const activity = { count: 0 };
  afk.onActivity(() => { activity.count++; });
  const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  return {
    afk, activity, writes, gateway, timers, appWindow,
    state: () => state,
    subscribeCalls: () => subscribeCalls,
    now: () => now,
    at: (time: number) => { now = time; },
    publish,
    speak: (who: string, speaking: boolean) => publish({ ...state, liveVoice: { ...state.liveVoice, [who]: { speaking } } }),
    mute: (selfMuted: boolean) => publish({ ...state, selfMuted }),
    settle,
    tick: async () => {
      assert.equal(timers.length, 1, 'R284 один тикер автостатуса');
      timers[0].fn();
      await settle();
    },
  };
}

function voiceStaysQuiet(f: ReturnType<typeof fixture>) {
  const startedAt = f.afk.lastActivityAt();
  f.at(f.now() + 10_000);
  for (const who of ['self', 'peer']) {
    f.speak(who, true);
    f.speak(who, false);
    f.speak(who, true);
  }
  f.mute(false);
  f.mute(true);
  f.mute(false);
  assert.equal(f.activity.count, 0, QUIET_MARKER);
  assert.equal(f.afk.lastActivityAt(), startedAt, 'R284 голос не сдвигает отсчёт простоя');
  assert.equal(f.writes.length, 0, 'R284 голос не вызывает API изменения статуса');
  assert.equal(f.gateway.length, 0, 'R284 голос не сообщает шлюзу о вводе');
  assert.equal(f.state().user.status, 'away', 'R284 авто- и ручной away сохраняются без ввода');
}

it('R284 initAfk не подписывается на стор и повторный запуск не создаёт второй тикер', () => {
  // Возврат подписки снова сделал бы шум открытого микрофона источником постоянной активности.
  const f = fixture();
  f.afk.initAfk();
  assert.equal(f.subscribeCalls(), 0, 'R284 initAfk не устанавливает ни одного store listener');
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].ms, 30_000);
});

it('R284 речь и mute/unmute не снимают ни автоматический, ни ручной away', () => {
  // Отсутствие API-записи недостаточно: голос также не должен незаметно продлевать время ввода.
  for (const autoAway of [true, false]) voiceStaysQuiet(fixture(source, autoAway));
});

it('R284 непрерывный голос без ввода не мешает уходу в away ровно на десятой минуте', async () => {
  // Проверяем обе стороны порога на настоящем тикере: раньше подписка отодвигала его при каждом звуке.
  const f = fixture();
  f.publish({ ...f.state(), user: { ...f.state().user, status: 'online', statusAuto: false } });
  const startedAt = f.afk.lastActivityAt();
  f.at(startedAt + rules.IDLE_MS - 1);
  f.speak('self', true);
  f.mute(false);
  await f.tick();
  assert.equal(f.writes.length, 0, 'R284 за миллисекунду до порога ещё online');
  f.at(startedAt + rules.IDLE_MS);
  f.speak('self', false);
  f.speak('self', true);
  f.mute(true);
  await f.tick();
  assert.deepEqual(f.writes, [{ status: 'away', auto: true }], 'R284 десять минут ввода нет — один away, несмотря на голос');
  assert.equal(f.state().user.status, 'away');
  assert.equal(f.state().user.statusAuto, true);
  await f.tick();
  assert.equal(f.writes.length, 1, 'R284 уже установленный away не отправляется повторно');
});

it('R284 настоящий ввод возвращает автоматический away, но сохраняет ручной', async () => {
  // Парный положительный сценарий отличает запрет голосовой активности от поломанного возврата вообще.
  for (const autoAway of [true, false]) {
    const f = fixture(source, autoAway);
    f.at(f.now() + 20_000);
    f.appWindow.dispatchEvent(new Event('keydown'));
    await f.settle();
    assert.equal(f.activity.count, 1);
    assert.equal(f.afk.lastActivityAt(), f.now());
    assert.deepEqual(f.writes, autoAway ? [{ status: 'online', auto: true }] : []);
    assert.equal(f.state().user.status, autoAway ? 'online' : 'away');
  }
});

it('R284 возвращённая подписка на речь и включение микрофона отвергается после оригинала', () => {
  // Мутант должен упасть на признаке ложного ввода, а не на отсутствии subscribe или ошибке VM.
  voiceStaysQuiet(fixture());
  const anchor = '  started = true;';
  assert.equal(source.split(anchor).length - 1, 1, 'R284 однозначное место установки подписки');
  const subscription = `
  useStore.subscribe((state, previous) => {
    const me = state.user?.id;
    if ((me && state.liveVoice[me]?.speaking && !previous.liveVoice[me]?.speaking)
        || (!state.selfMuted && previous.selfMuted)) noteActivity();
  });`;
  const mutant = fixture(source.replace(anchor, anchor + subscription));
  assert.throws(() => voiceStaysQuiet(mutant), (error: unknown) =>
    error instanceof assert.AssertionError && error.message.split('\n')[0] === QUIET_MARKER
    && error.operator === 'strictEqual' && error.expected === 0 && Number(error.actual) > 0);
});
