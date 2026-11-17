import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('./voiceSession.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const HOME = 'gv_voice_session:home';
function fixture() {
  let now = 1_000_000, active: string | null = 'home';
  const values = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  function load() {
    const module = { exports: {} };
    runInNewContext(code, {
      module, exports: module.exports, localStorage, Date: { now: () => now },
      require: () => ({ activeInstanceId: () => active }),
    });
    return module.exports as typeof import('./voiceSession');
  }
  return {
    api: load(), load, values, time: (value: number) => { now = value; },
    activate: (value: string) => { active = value; },
    put: (ts: unknown) => values.set(HOME, JSON.stringify({ serverId: 's', channelId: 'v', ts, schema: 1 })),
  };
}

it('старт принимает только числовой конечный timestamp с возрастом от нуля до 11999 мс', () => {
  const f = fixture();
  for (const [stamp, accepted] of [
    [1_000_001, false], [1_000_000, true], [988_001, true], [988_000, false],
    ['1000000', false], [null, false], [undefined, false], ['bad', false],
  ] as const) {
    f.put(stamp);
    assert.equal(f.api.restorableVoiceSession() !== null, accepted, String(stamp));
  }
  f.values.set(HOME, '{"schema":1,"serverId":"s","channelId":"v","ts":1e400}');
  assert.equal(f.api.restorableVoiceSession(), null);
});

it('отклонённая стартовая запись удаляется до возможного live-rejoin, соседняя остаётся', () => {
  for (const raw of [
    '{"schema":1,"serverId":"s","channelId":"v","ts":0}',
    '{"schema":1,"serverId":"s","channelId":"v","ts":940000}',
    '{"schema":1,"serverId":"s","channelId":"v","ts":1000001}',
    '{"schema":1,"serverId":"s","channelId":"v","ts":"1000000"}',
    '{"schema":1,"serverId":"s","channelId":"v"}', 'broken', 'null',
  ]) {
    const f = fixture();
    f.values.set(HOME, raw);
    f.values.set('gv_voice_session:guest', raw);
    assert.equal(f.api.captureStartupVoiceSession(), null);
    assert.equal(f.values.has(HOME), false);
    assert.equal(f.api.rejoinableVoiceSession(), null);
    assert.equal(f.values.get('gv_voice_session:guest'), raw);
  }
});

it('допущенная сессия переживает долгую установку и быстрый запуск нового процесса', () => {
  const f = fixture();
  f.put(999_999);
  const lease = f.api.captureStartupVoiceSession()!;
  assert.ok(lease);
  for (let elapsed = 1000; elapsed <= 360_000; elapsed += 1000) {
    f.time(1_000_000 + elapsed);
    lease.touch();
  }
  assert.equal(lease.current()?.channelId, 'v');
  assert.equal(f.load().restorableVoiceSession()?.ts, 1_360_000);
  // Без заставки снимок всё равно имеет ограниченный срок: затянувшаяся загрузка не оживляет его.
  f.time(1_372_000);
  assert.equal(lease.current(), null);
  assert.equal(f.api.rejoinableVoiceSession(), null);
});

it('смена инстанса, замена и clear отменяют lease без касания новой или чужой записи', () => {
  for (const change of ['instance', 'replace', 'same-save', 'clear-save', 'clear'] as const) {
    const f = fixture();
    f.put(1_000_000);
    const lease = f.api.captureStartupVoiceSession()!;
    if (change === 'instance') {
      f.values.set('gv_voice_session:guest', '{"schema":1,"serverId":"g","channelId":"gv","ts":1}');
      f.activate('guest');
    } else if (change === 'replace') f.put(999_999);
    else if (change === 'same-save') f.api.saveVoiceSession('home', 's', 'v');
    else {
      f.api.clearVoiceSession('home');
      if (change === 'clear-save') f.api.saveVoiceSession('home', 's', 'v');
    }
    const before = [...f.values];
    f.time(1_001_000);
    lease.touch();
    assert.equal(lease.current(), null, change);
    assert.deepEqual([...f.values], before, change);
    f.activate('home');
    lease.touch();
    assert.equal(lease.current(), null, 'отменённый lease не оживает');
  }
});

it('обратный ход часов отменяет даже ещё свежий lease и не оживает после коррекции', () => {
  const f = fixture();
  f.put(999_000);
  const lease = f.api.captureStartupVoiceSession()!;
  // ts всё ещё в прошлом: одной проверки now >= ts недостаточно.
  f.time(999_999);
  lease.touch();
  assert.equal(lease.current(), null);
  assert.equal(f.api.rejoinableVoiceSession(), null);
  f.time(1_001_000);
  f.api.saveVoiceSession('home', 's', 'v');
  const replacement = f.values.get(HOME);
  lease.touch();
  assert.equal(lease.current(), null);
  assert.equal(f.values.get(HOME), replacement);
});

// The old updater could stamp a legacy session as fresh before killing its own process.
it('первое обновление не доверяет свежей отметке старой заставки, ручной вход создаёт восстанавливаемую сессию', () => {
  const f = fixture();
  f.values.set(HOME, JSON.stringify({ serverId: 's', channelId: 'v', ts: 1_000_000 }));
  assert.equal(f.api.restorableVoiceSession(), null);
  assert.equal(f.api.captureStartupVoiceSession(), null);
  assert.equal(f.api.rejoinableVoiceSession(), null);
  f.api.saveVoiceSession('home', 's', 'v');
  assert.equal(f.api.restorableVoiceSession()?.channelId, 'v');
  assert.equal(f.api.captureStartupVoiceSession()?.current()?.channelId, 'v');
});
