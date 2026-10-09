import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import type { BackGestureSink, BackGesturePhase } from './androidBack';

const source = readFileSync(new URL('./androidBack.ts', import.meta.url), 'utf8');
function fixture(raw = source, android = true) {
  let now = 1000;
  let topLayer = false;
  let steps = 0;
  let exits = 0;
  const state = { adminOpen: false, settingsOpen: false, mobileProfileOpen: false, mobileMembersOpen: false,
    mobilePane: 'content', setMobilePane: (pane: string) => { steps++; state.mobilePane = pane; } };
  const window: { __gvBack?: () => void; __gvBackGesture?: (phase: BackGesturePhase, progress: number, edge: number, y: number) => void;
    GusVoiceNative: { exitApp(): void } } = { GusVoiceNative: { exitApp: () => { exits++; } } };
  const module = { exports: {} };
  // Исполняется весь настоящий модуль с двумя явно названными внешними зависимостями, не вырезанная функция.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    module, exports: module.exports, window, document: { querySelector: () => topLayer ? {} : null },
    performance: { now: () => now },
    require: (id: string) => {
      if (id === './hotkeys') return { isAndroid: () => android };
      if (id === './store') return { useStore: { getState: () => state } };
      assert.fail(`неожиданная внешняя зависимость ${id}`);
    },
  });
  const api = module.exports as typeof import('./androidBack');
  return { api, window, state, advance: (ms: number) => { now += ms; }, setLayer: (value: boolean) => { topLayer = value; },
    steps: () => steps, exits: () => exits };
}

it('R121 верхний слой блокирует предиктивный уход раньше вопросов перехватчикам', () => {
  const f = fixture(); let peeks = 0; let actions = 0;
  f.api.pushBackHandler(() => { actions++; return false; }, () => { peeks++; return false; });
  f.setLayer(true); assert.equal(f.api.backLeavesPane(), false);
  assert.equal(peeks, 0); assert.equal(actions, 0);
  f.setLayer(false); assert.equal(f.api.backLeavesPane(), true); assert.equal(peeks, 1); assert.equal(actions, 0);
});

it('R121 обработчик без peek считается забирающим назад, снятие возвращает возможность ухода', () => {
  const check = (raw: string) => {
    const f = fixture(raw); let actions = 0;
    const off = f.api.pushBackHandler(() => { actions++; return false; });
    assert.equal(f.api.backLeavesPane(), false, 'без peek нельзя обещать уход беседы');
    assert.equal(actions, 0, 'опрос не выполняет действие');
    off(); off(); assert.equal(f.api.backLeavesPane(), true);
  };
  check(source);
  const mutant = source.replace('if (!peek || peek()) return false;', 'if (peek && peek()) return false;');
  assert.notEqual(mutant, source);
  assert.throws(() => check(mutant), assert.AssertionError);
});

it('R121 peek true забирает шаг, false пропускает, опрос идёт с вершины стека без действий', () => {
  const f = fixture(); const calls: string[] = []; let actions = 0;
  const bottom = f.api.pushBackHandler(() => { actions++; return false; }, () => { calls.push('низ'); return false; });
  let takes = true;
  const top = f.api.pushBackHandler(() => { actions++; return true; }, () => { calls.push('верх'); return takes; });
  assert.equal(f.api.backLeavesPane(), false); assert.deepEqual(calls, ['верх']);
  calls.length = 0; takes = false;
  assert.equal(f.api.backLeavesPane(), true); assert.deepEqual(calls, ['верх', 'низ']); assert.equal(actions, 0);
  top(); bottom(); assert.equal(f.api.backLeavesPane(), true);
});

it('R121 настройки, админка, профиль, участники и список не обещают уход беседы', () => {
  const f = fixture(); assert.equal(f.api.backLeavesPane(), true);
  for (const key of ['adminOpen', 'settingsOpen', 'mobileProfileOpen', 'mobileMembersOpen'] as const) {
    f.state[key] = true; assert.equal(f.api.backLeavesPane(), false, key);
    f.state[key] = false; assert.equal(f.api.backLeavesPane(), true, `${key} закрыт`);
  }
  f.state.mobilePane = 'list'; assert.equal(f.api.backLeavesPane(), false);
});

it('R121 ведомый invoked откладывает единственный шаг до done и глушит повторы дольше repeat-окна', () => {
  const check = (raw: string) => {
    const f = fixture(raw); let done: (() => void) | undefined; let invokes = 0; const phases: string[] = [];
    f.api.setBackGestureSink((phase, _progress, _edge, _y, callback) => {
      phases.push(phase); if (phase !== 'invoked') return false;
      invokes++; done = callback; return true;
    });
    f.api.installAndroidBack();
    f.window.__gvBackGesture!('start', 0, 1, 140);
    f.window.__gvBackGesture!('progress', 0.6, 1, 140);
    f.window.__gvBack!(); assert.equal(f.steps(), 0, 'до ухода слоя навигации нет'); assert.ok(done);
    f.advance(300); f.window.__gvBack!();
    f.window.__gvBackGesture!('progress', 0.9, 1, 140);
    assert.equal(invokes, 1, 'committing глушит второй вызов за пределами 250 мс');
    assert.deepEqual(phases, ['start', 'progress', 'invoked']);
    done(); assert.equal(f.steps(), 1); assert.equal(f.exits(), 0);
    f.advance(300); f.window.__gvBack!();
    assert.equal(invokes, 2, 'после done следующий жест снова принимается');
  };
  check(source);
  const mutant = source.replace('if (committing) return;', '/* предохранитель удалён */');
  assert.notEqual(mutant, source); assert.throws(() => check(mutant), assert.AssertionError);
});

it('R121 без приёмника или при отказе вести invoked шаг выполняется сразу', () => {
  for (const sink of [undefined, (() => false) as BackGestureSink]) {
    const f = fixture(); if (sink) f.api.setBackGestureSink(sink);
    f.api.installAndroidBack(); f.window.__gvBack!();
    assert.equal(f.steps(), 1); assert.equal(f.state.mobilePane, 'list'); assert.equal(f.exits(), 0);
    f.advance(300); f.window.__gvBack!(); assert.equal(f.exits(), 1, 'в списке оболочка сворачивается');
  }
});

it('R121 снятие старого приёмника не удаляет новый, cancel не делает шаг навигации', () => {
  const f = fixture(); const phases: Array<[BackGesturePhase, number, number, number]> = [];
  const offOld = f.api.setBackGestureSink(() => { assert.fail('старый приёмник вызван'); });
  const offNew = f.api.setBackGestureSink((phase, progress, edge, y) => { phases.push([phase, progress, edge, y]); return false; });
  offOld(); f.api.installAndroidBack();
  f.window.__gvBackGesture!('start', 0, 1, 140); f.window.__gvBackGesture!('progress', 0.5, 1, 140);
  f.window.__gvBackGesture!('cancel', 0, 1, 140); f.window.__gvBackGesture!('invoked', 1, 1, 140);
  assert.deepEqual(phases, [['start', 0, 1, 140], ['progress', 0.5, 1, 140], ['cancel', 0, 1, 140]]);
  assert.equal(f.steps(), 0, 'отмена и gesture invoked не навигируют вместо __gvBack');
  offNew(); f.window.__gvBack!(); assert.equal(f.steps(), 1);
});

it('R121 вне Android системные обработчики не устанавливаются', () => {
  const f = fixture(source, false); f.api.installAndroidBack();
  assert.equal(f.window.__gvBack, undefined); assert.equal(f.window.__gvBackGesture, undefined);
});
