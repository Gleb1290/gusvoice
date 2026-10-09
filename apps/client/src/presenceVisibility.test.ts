import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import { effectiveLastActive } from './afkRules';

type Presence = typeof import('./presenceVisibility') & { idleApplies: () => boolean };
function fixture(change?: (source: string) => string, mobile = false, coarse = false) {
  const original = readFileSync(new URL('./presenceVisibility.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const source = change ? change(original) : original;
  if (change) assert.notEqual(source, original, 'мутант меняет настоящий модуль присутствия');
  let now = 100_000, lastInput = now, next = 0, os: number | null = null;
  const timers = new Map<number, { at: number; run: () => void }>();
  const events = new Map<string, (() => void)[]>();
  let activity: (() => void) | undefined;
  let storeState: { voice: object | null } = { voice: null };
  let callState: { call: { phase: string } | null } = { call: null };
  const storeSubs: ((state: typeof storeState, prev: typeof storeState) => void)[] = [];
  const callSubs: ((state: typeof callState, prev: typeof callState) => void)[] = [];
  const document = { visibilityState: 'visible', addEventListener: (key: string, fn: () => void) => { events.set(key, [...(events.get(key) ?? []), fn]); } };
  const deps: Record<string, unknown> = {
    './afk': { lastActivityAt: () => lastInput, onActivity: (fn: () => void) => { activity = fn; }, osIdleMs: async () => os },
    './afkRules': { effectiveLastActive },
    './callStore': { useCall: { getState: () => callState, subscribe: (fn: typeof callSubs[number]) => callSubs.push(fn) } },
    './hotkeys': { isMobile: () => mobile },
    './store': { useStore: { getState: () => storeState, subscribe: (fn: typeof storeSubs[number]) => storeSubs.push(fn) } },
  };
  const module = { exports: {} };
  class FakeDate extends Date { static now() { return now; } }
  runInNewContext(ts.transpileModule(source + '\nexport { idleApplies };', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    module, exports: module.exports, document, Date: FakeDate, window: { matchMedia: () => ({ matches: coarse }) },
    setTimeout: (run: () => void, ms: number) => { const id = ++next; timers.set(id, { at: now + ms, run }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    require: (name: string) => { assert.ok(Object.hasOwn(deps, name), `поимённо подменён импорт ${name}`); return deps[name]; },
  });
  const api = module.exports as Presence;
  return { api, timers,
    advance: async (ms: number) => {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); }
      await Promise.resolve(); await Promise.resolve();
    },
    input: () => { lastInput = now; activity?.(); },
    hide: (hidden: boolean) => { document.visibilityState = hidden ? 'hidden' : 'visible'; for (const fn of events.get('visibilitychange') ?? []) fn(); },
    voice: (on: boolean) => { const prev = storeState; storeState = { voice: on ? {} : null }; for (const fn of storeSubs) fn(storeState, prev); },
    call: (phase: string | null) => { const prev = callState; callState = { call: phase ? { phase } : null }; for (const fn of callSubs) fn(callState, prev); },
    osIdle: (ms: number | null) => { os = ms; },
  };
}

for (const visible of [false, true]) for (const idle of [false, true]) for (const inVoice of [false, true]) for (const inCall of [false, true]) {
  it(`ЛС присутствие: видно=${visible}, простой=${idle}, голос=${inVoice}, активный звонок=${inCall}`, () => {
    const expected = inVoice || inCall || (visible && !idle);
    assert.equal(fixture().api.presentForPeers({ visible, idle, inVoice, inCall }), expected);
  });
}

it('голос и активный звонок сохраняют присутствие даже в скрытом простаивающем окне', () => {
  const check = (api: Presence) => {
    assert.equal(api.presentForPeers({ visible: false, idle: true, inVoice: true, inCall: false }), true, 'голос независимо сохраняет присутствие');
    assert.equal(api.presentForPeers({ visible: false, idle: true, inVoice: false, inCall: true }), true);
    assert.equal(api.presentForPeers({ visible: false, idle: false, inVoice: false, inCall: false }), false);
    assert.equal(api.presentForPeers({ visible: true, idle: true, inVoice: false, inCall: false }), false);
  };
  check(fixture().api);
  assert.throws(() => check(fixture((s) => s.replace('(p.visible && !p.idle) || p.inVoice || p.inCall', '(p.visible && !p.idle) && p.inVoice && p.inCall')).api),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('голос независимо сохраняет присутствие'));
});

it('ровно 30000 мс уже простой, на миллисекунду раньше ещё присутствует', () => {
  const check = (api: Presence) => {
    assert.equal(api.PRESENCE_IDLE_MS, 30000);
    assert.equal(api.presenceIdle(100, 30099), false);
    assert.equal(api.presenceIdle(100, 30100), true, 'граница 30 секунд включительна');
    assert.equal(api.presenceIdle(100, 30101), true);
    assert.equal(api.presenceIdle(100, 99), false);
  };
  check(fixture().api);
  assert.throws(() => check(fixture((s) => s.replace('>= PRESENCE_IDLE_MS', '> PRESENCE_IDLE_MS')).api),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('граница 30 секунд включительна'));
});

it('телефон и касательный браузер без мыши не считают простой, обычный ПК считает', () => {
  const check = (change?: (s: string) => string) => {
    assert.equal(fixture(change, true).api.idleApplies(), false, 'телефон не считает простой');
    assert.equal(fixture(change, false, true).api.idleApplies(), false);
    assert.equal(fixture(change, false, false).api.idleApplies(), true);
  };
  check();
  assert.throws(() => check((s) => s.replace('if (isMobile()) return false;', 'if (isMobile()) return true;')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('телефон не считает простой'));
});

function visibleSender() {
  const source = readFileSync(new URL('./sockets.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('sockets.ts', source, ts.ScriptTarget.Latest, true);
  const node = parsed.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'sendGatewayVisible');
  assert.ok(node, 'найден настоящий отправитель visible');
  const frames: { t: string; on: boolean }[] = [];
  const context = { send: undefined as unknown as (on: boolean) => void, activeOn: true, WebSocket: { OPEN: 1 },
    gateway: { readyState: 1, send: (data: string) => frames.push(JSON.parse(data)) } };
  runInNewContext(ts.transpileModule(node.getText(parsed) + '\nglobalThis.send = sendGatewayVisible;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { frames, send: context.send, context };
}

it('30 секунд без ввода отправляют visible false, первый ввод сразу отправляет true без сети', async () => {
  const check = async (change?: (s: string) => string) => {
    const f = fixture(change), wire = visibleSender(); f.api.watchPresence(wire.send);
    await f.advance(29999); assert.deepEqual(wire.frames, []);
    await f.advance(1); assert.deepEqual(wire.frames, [{ t: 'visible', on: false }], 'простой отправляет visible false'); assert.equal(wire.context.activeOn, false);
    f.input(); assert.deepEqual(wire.frames, [{ t: 'visible', on: false }, { t: 'visible', on: true }], 'ввод возвращает visible true');
    f.input(); assert.equal(wire.frames.length, 2, 'повторный ввод не дублирует кадр');
    await f.advance(30000); assert.deepEqual(wire.frames.at(-1), { t: 'visible', on: false });
  };
  await check();
  await assert.rejects(() => check((s) => s.replace('  arm(PRESENCE_IDLE_MS);\n}', '}')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('простой отправляет visible false'));
  await assert.rejects(() => check((s) => s.replace('      idleNow = false;\n      check();', '      /* mutant: ввод не возвращает присутствие */')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('ввод возвращает visible true'));
});

it('на телефоне нет таймера простоя, скрытие и возвращение всё равно меняют присутствие', async () => {
  for (const [mobile, coarse] of [[true, false], [false, true]]) {
    const f = fixture(undefined, mobile, coarse), wire = visibleSender(); f.api.watchPresence(wire.send);
    assert.equal(f.timers.size, 0); await f.advance(120000); assert.deepEqual(wire.frames, []);
    f.hide(true); f.hide(true); f.hide(false);
    assert.deepEqual(wire.frames, [{ t: 'visible', on: false }, { t: 'visible', on: true }]);
  }
});

it('голос или активный звонок держат скрытое окно здесь, ringing и конец звонка не держат', () => {
  const f = fixture(); const changes: boolean[] = []; f.api.watchPresence((on) => changes.push(on));
  f.hide(true); f.call('ringing'); assert.deepEqual(changes, [false]);
  f.call('active'); f.voice(true); f.call(null); assert.deepEqual(changes, [false, true]);
  f.voice(false); assert.deepEqual(changes, [false, true, false]);
  f.hide(false); assert.deepEqual(changes, [false, true, false, true]);
});

it('системный ввод вне окна переносит простой, а его возврат обнаруживается через две секунды', async () => {
  const f = fixture(), changes: boolean[] = []; f.api.watchPresence((on) => changes.push(on));
  f.osIdle(1000); await f.advance(30000); assert.deepEqual(changes, []);
  f.osIdle(30000); await f.advance(29000); assert.deepEqual(changes, [false]);
  f.osIdle(0); await f.advance(2000); assert.deepEqual(changes, [false, true]);
});
