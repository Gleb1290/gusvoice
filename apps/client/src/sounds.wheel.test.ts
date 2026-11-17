import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Sounds = typeof import('./sounds');
type Edit = { from: string; to: string };
const read = () => readFileSync(new URL('./sounds.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Исполняется ЦЕЛЫЙ sounds.ts. Подменены лишь storage и граница WebAudio: все проверки настроек,
// потолок, создание цепи, частоты/огибающие и планирование выполняет настоящий модуль.
function runtime(edit?: Edit) {
  let source = read();
  if (edit) {
    assert.equal(source.split(edit.from).length, 2, 'R329 sound setup: единственный якорь whole-module мутанта');
    source = source.replace(edit.from, edit.to);
  }
  const parameter = () => ({
    value: 0,
    values: [] as [number, number][],
    ramps: [] as [number, number][],
    setValueAtTime(value: number, time: number) { this.values.push([value, time]); },
    exponentialRampToValueAtTime(value: number, time: number) { this.ramps.push([value, time]); },
  });
  const node = () => ({
    connections: new Set<unknown>(), disconnects: 0,
    connect<T>(target: T): T { this.connections.add(target); return target; },
    disconnect() {
      this.disconnects++;
      if (!this.connections.size) throw new Error('WebAudio IO: уже отключено');
      this.connections.clear();
    },
  });
  const gains: (ReturnType<typeof node> & { gain: ReturnType<typeof parameter> })[] = [];
  const oscillators: (ReturnType<typeof node> & {
    type: string; frequency: ReturnType<typeof parameter>; starts: number[]; stops: number[];
    start(time: number): void; stop(time: number): void;
  })[] = [];
  const context = {
    currentTime: 17, state: 'running', destination: { io: 'speaker' },
    createGain() { const gain = { ...node(), gain: parameter() }; gains.push(gain); return gain; },
    createOscillator() {
      const oscillator = { ...node(), type: '', frequency: parameter(), starts: [] as number[], stops: [] as number[],
        start(time: number) { this.starts.push(time); }, stop(time: number) { this.stops.push(time); } };
      oscillators.push(oscillator);
      return oscillator;
    },
  };
  let contextRequests = 0;
  const storage = new Map<string, string>();
  const module = { exports: {} as Sounds };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    require(id: string) {
      assert.equal(id, './voiceKeepAlive', 'R329 sound setup: закрытый внешний импорт');
      return { sharedAudioContext: () => { contextRequests++; return context; } };
    },
  });
  const configure = (enabled: boolean, event: boolean, volume = 1) => module.exports.setSoundSettings({
    ...module.exports.getSoundSettings(), enabled, volume,
    events: { ...module.exports.getSoundSettings().events, wheelTick: event },
  });
  return { sounds: module.exports, configure, context, gains, oscillators, contextRequests: () => contextRequests };
}
type Fixture = ReturnType<typeof runtime>;
function silence(f: Fixture, prefix: string) {
  assert.equal(f.oscillators.length, 0, `${prefix} выключенная трещотка не создаёт осцилляторы`);
  assert.equal(f.gains.length, 0, `${prefix} выключенная трещотка не создаёт даже мастер-узел`);
  assert.equal(f.contextRequests(), 0, `${prefix} тишина не будит AudioContext`);
}
function proof(prefix: string, scenario: (edit?: Edit) => void, edits: Edit[]) {
  for (const edit of edits) {
    const original = read();
    scenario();
    counterfact(() => {
      assert.throws(() => scenario(edit), error => error instanceof assert.AssertionError && error.message.startsWith(prefix));
    });
    assert.equal(read(), original, 'R329 sound setup: prod-исходник не менялся');
    scenario();
  }
}
const gate = 'if (!settings.enabled || !settings.events.wheelTick || timesMs.length === 0) return () => {};';

test('R329 общий выключатель глушит всю трещотку; включённая настройка действительно запускает звук', () => proof('R329 master:', edit => {
  const f = runtime(edit);
  f.configure(false, true);
  f.sounds.scheduleWheelTicks([0, 100])();
  silence(f, 'R329 master:');
  f.configure(true, true);
  f.sounds.scheduleWheelTicks([0, 100]);
  assert.equal(f.oscillators.filter(o => o.starts.length === 1).length, 2, 'R329 master: после включения щелчки действительно запущены');
}, [{ from: gate, to: 'if (!settings.events.wheelTick || timesMs.length === 0) return () => {};' } ]));

test('R329 выключатель wheelTick не зависит от общего: выключено тихо, включено звучит', () => proof('R329 event:', edit => {
  const f = runtime(edit);
  f.configure(true, false);
  f.sounds.scheduleWheelTicks([0, 100])();
  silence(f, 'R329 event:');
  f.configure(true, true);
  f.sounds.scheduleWheelTicks([100]);
  assert.equal(f.oscillators[0]?.starts.length, 1, 'R329 event: включённое событие реально запускает осциллятор');
}, [{ from: gate, to: 'if (!settings.enabled || timesMs.length === 0) return () => {};' } ]));

test('R329 пустое расписание не будит аудио и отдаёт безопасную повторную отмену; непустое звучит', () => proof('R329 empty:', edit => {
  const f = runtime(edit);
  const cancel = f.sounds.scheduleWheelTicks([]);
  cancel(); cancel();
  silence(f, 'R329 empty:');
  f.sounds.scheduleWheelTicks([0]);
  assert.equal(f.oscillators[0]?.starts.length, 1, 'R329 empty: непустое расписание не теряется');
}, [{ from: gate, to: 'if (!settings.enabled || !settings.events.wheelTick) return () => {};' } ]));

test('R329 щелчки планируются на часах AudioContext в миллисекундах, отрицательное время прижимается к сейчас', () => proof('R329 clock:', edit => {
  const f = runtime(edit);
  f.sounds.scheduleWheelTicks([-50, 0, 125, 1250]);
  const starts = [17, 17, 17.125, 18.25];
  assert.deepEqual(f.oscillators.map(o => o.starts), starts.map(t => [t]), 'R329 clock: каждый щелчок запускается ровно по расписанию');
  assert.deepEqual(f.oscillators.map(o => o.stops), starts.map(t => [t + 0.03 + 0.02]), 'R329 clock: каждый осциллятор ограничен коротким звуком');
  for (const [n, oscillator] of f.oscillators.entries()) {
    assert.equal(oscillator.type, 'triangle');
    assert.deepEqual(oscillator.frequency.values, [[1900, starts[n]]]);
    assert.ok(oscillator.connections.has(f.gains[n + 1]), 'R329 clock: осциллятор соединён с огибающей');
    assert.ok(f.gains[n + 1].connections.has(f.gains[0]), 'R329 clock: огибающая соединена с общим мастером');
  }
  assert.ok(f.gains[0].connections.has(f.context.destination), 'R329 clock: мастер подключён к выходу');
}, [
  { from: 'start: Math.max(0, t) / 1000', to: 'start: 0' },
  { from: 'for (const t of timesMs) tone(ac, master,', to: 'for (const t of timesMs.slice(1)) tone(ac, master,' },
]));

test('R329 трещотка уважает низкую мастер-громкость и потолок события 0.3 при громком мастере', () => proof('R329 volume:', edit => {
  const f = runtime(edit);
  for (const [master, expected] of [[1, 0.3], [0.2, 0.2], [0, 0]]) {
    f.configure(true, true, master);
    f.sounds.scheduleWheelTicks([0]);
    assert.equal(f.gains.at(-2)!.gain.value, expected, 'R329 volume: громкость на настоящем мастер-узле равна min(master, 0.3)');
  }
}, [
  { from: '  wheelTick: 0.3,', to: '  wheelTick: 1,' },
  { from: "master.gain.value = eventVolume('wheelTick');", to: 'master.gain.value = 0.3;' },
]));

test('R329 закрытие сцены отключает общий выход, повторная отмена безопасна и не глушит новое вращение', () => proof('R329 cancel:', edit => {
  const f = runtime(edit);
  const cancel = f.sounds.scheduleWheelTicks([0, 100]);
  const oldMaster = f.gains[0];
  assert.ok(oldMaster.connections.has(f.context.destination));
  cancel();
  assert.equal(oldMaster.connections.size, 0, 'R329 cancel: старое расписание лишилось связи с динамиками');
  assert.doesNotThrow(cancel, 'R329 cancel: повторная отмена не выбрасывает ошибку WebAudio');
  f.sounds.scheduleWheelTicks([200]);
  const newMaster = f.gains[3];
  cancel();
  assert.ok(newMaster.connections.has(f.context.destination), 'R329 cancel: запоздалая отмена не затронула новое вращение');
}, [{ from: '      master.disconnect();', to: '      /* мутант: выход старого вращения остался подключён */' } ]));
