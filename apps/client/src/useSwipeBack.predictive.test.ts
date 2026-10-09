import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import * as rules from './swipeBack';

const source = readFileSync(new URL('./useSwipeBack.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Sink = (phase: 'start' | 'progress' | 'cancel' | 'invoked', progress: number, edge: number, y: number, done?: () => void) => boolean;

before(() => {
  GlobalRegistrator.register();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
after(() => GlobalRegistrator.unregister());

async function mount(raw = source, enabled = true, leavesPane = true) {
  let sink: Sink | null = null;
  let offCalls = 0, backCalls = 0, now = 0, serial = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const app = document.createElement('div');
  app.className = 'app';
  const content = document.createElement('div');
  content.className = 'content';
  const back = document.createElement('button');
  back.className = 'mobile-back';
  app.append(content, back);
  const host = document.createElement('div');
  document.body.append(app, host);
  const dependencies: Record<string, unknown> = {
    react: React,
    './swipeBack': rules,
    './androidBack': {
      TOP_LAYERS: '.test-top-layer',
      backLeavesPane: () => leavesPane,
      setBackGestureSink: (fn: Sink) => {
        sink = fn;
        return () => { offCalls++; sink = null; };
      },
    },
  };
  const module = { exports: {} };
  // Компилируется весь настоящий модуль, а не вырезанная регуляркой функция: зависимости заданы явно.
  runInNewContext(ts.transpileModule(raw, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    module, exports: module.exports, document, Element, HTMLElement, getComputedStyle,
    window: {
      innerWidth: 400, innerHeight: 800,
      setTimeout(fn: () => void, ms: number) { const id = ++serial; timers.set(id, { at: now + ms, fn }); return id; },
      clearTimeout(id: number) { timers.delete(id); },
    },
    require(id: string) { assert.ok(id in dependencies, `известная зависимость ${id}`); return dependencies[id]; },
  });
  const api = module.exports as typeof import('./useSwipeBack');
  function Harness() { api.useSwipeBack(enabled, () => backCalls++); return null; }
  const root = createRoot(host);
  await React.act(async () => { root.render(React.createElement(Harness)); });
  let unmounted = false;
  return {
    content, back,
    get offCalls() { return offCalls; },
    get backCalls() { return backCalls; },
    get installed() { return sink !== null; },
    get pendingTimers() { return timers.size; },
    emit(phase: Parameters<Sink>[0], progress = 0, done?: () => void) {
      assert.ok(sink, 'приёмник системного жеста установлен');
      return sink(phase, progress, 0, 250, done);
    },
    touchCancel() { document.dispatchEvent(new Event('touchcancel')); },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    },
    async unmount() { if (!unmounted) { unmounted = true; await React.act(async () => root.unmount()); } },
    async close() { if (!unmounted) { unmounted = true; await React.act(async () => root.unmount()); } app.remove(); host.remove(); },
  };
}

async function checkSystemTouchCancel(raw = source) {
  const h = await mount(raw);
  let done = 0;
  try {
    h.emit('start');
    h.emit('progress', 0.2);
    const initial = h.content.style.transform;
    h.touchCancel(); // Android забрал касание у WebView, но системный жест ещё идёт.
    h.emit('progress', 0.8);
    assert.equal(h.content.style.transform, `scale(${rules.predictiveBackScale(0.8)})`, 'touchcancel не теряет ведомый слой');
    assert.notEqual(h.content.style.transform, initial, 'поздний progress действительно перекрасил слой');
    assert.equal(h.back.style.transform, h.content.style.transform, 'стрелка движется вместе с беседой');
    assert.equal(h.emit('invoked', 0.8, () => done++), true, 'уход забирает завершение шага назад');
    assert.equal(h.content.style.transform, `translateX(456px) scale(${rules.predictiveBackScale(0.8)})`);
    assert.equal(done, 0, 'шаг назад не опережает анимацию');
    h.advance(rules.PREDICTIVE_BACK_COMMIT_MS - 1);
    assert.equal(done, 0);
    h.advance(1);
    assert.equal(done, 1);
    assert.equal(h.content.style.transform, '');
    assert.equal(h.back.style.transform, '');
    assert.equal(h.backCalls, 0, 'системный жест завершает done, а не второй локальный onBack');
  } finally { await h.close(); }
}

it('R121 системный touchcancel оставляет слой ведомым до progress и ухода с единственным done', async () => {
  await checkSystemTouchCancel();
});

it('R121 отмена системного жеста после touchcancel возвращает слой и стрелку без шага назад', async () => {
  const h = await mount();
  let done = 0;
  try {
    h.emit('start'); h.emit('progress', 0.7); h.touchCancel();
    assert.equal(h.emit('cancel', 0.7, () => done++), false);
    assert.equal(h.content.style.transform, 'scale(1)');
    assert.equal(h.back.style.transform, 'scale(1)');
    assert.equal(h.content.style.transition, `transform 320ms ${rules.PREDICTIVE_BACK_EASE}`);
    h.advance(rules.PREDICTIVE_BACK_CANCEL_MS - 1);
    assert.equal(h.content.style.transform, 'scale(1)', 'стили не снимаются раньше возврата');
    h.advance(1);
    for (const el of [h.content, h.back]) {
      assert.equal(el.style.transform, ''); assert.equal(el.style.transition, ''); assert.equal(el.style.transformOrigin, '');
    }
    assert.equal(done, 0); assert.equal(h.backCalls, 0);
    h.emit('start'); h.emit('progress', 1);
    assert.equal(h.content.style.transform, `scale(${rules.predictiveBackScale(1)})`, 'после возврата новый жест снова принимается');
  } finally { await h.close(); }
});

it('R121 размонтирование во время ухода снимает приёмник и завершает done ровно один раз', async () => {
  const h = await mount();
  let done = 0;
  try {
    h.emit('start'); h.emit('progress', 0.5); h.emit('invoked', 0.5, () => done++);
    assert.equal(h.pendingTimers, 1);
    await h.unmount();
    assert.equal(h.offCalls, 1); assert.equal(h.installed, false);
    assert.equal(h.pendingTimers, 0, 'таймер ухода отменяется вместе с хуком');
    assert.equal(done, 1, 'androidBack не остаётся ждать снятый экран');
    assert.equal(h.content.style.transform, ''); assert.equal(h.back.style.transform, '');
    h.advance(1000);
    assert.equal(done, 1, 'снятый таймер не повторяет шаг назад');
  } finally { await h.close(); }
});

it('R121 отключённый хук не устанавливает системный приёмник', async () => {
  const h = await mount(source, false);
  try { assert.equal(h.installed, false); assert.equal(h.pendingTimers, 0); }
  finally { await h.close(); }
  assert.equal(h.offCalls, 0);
});

it('R121 системный жест при закрытии верхнего слоя не анимирует беседу', async () => {
  const h = await mount(source, true, false);
  try {
    h.emit('start'); h.emit('progress', 1);
    assert.equal(h.emit('invoked', 1), false);
    assert.equal(h.content.style.transform, ''); assert.equal(h.back.style.transform, '');
    assert.equal(h.pendingTimers, 0); assert.equal(h.backCalls, 0);
  } finally { await h.close(); }
});

it('R121 мутант сброса layer на системном touchcancel обнаруживается по следующему progress', async () => {
  const from = '} else if (!pred) layer = null;';
  assert.equal(source.split(from).length - 1, 1, 'мутант меняет ровно onCancel');
  await checkSystemTouchCancel();
  await assert.rejects(checkSystemTouchCancel(source.replace(from, '} else layer = null;')),
    (error: unknown) => error instanceof assert.AssertionError && error.message.includes('touchcancel не теряет ведомый слой'));
});
