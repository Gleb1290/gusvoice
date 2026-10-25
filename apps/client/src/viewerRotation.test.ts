import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';

const source = readFileSync(new URL('./viewerRotation.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const phoneSource = readFileSync(new URL('./phoneLayout.ts', import.meta.url), 'utf8');
type Viewer = typeof import('./viewerRotation');
type Phone = typeof import('./phoneLayout');
type Bridge = { setViewerRotation?: (on: boolean) => boolean };

function load<T>(raw: string, globals: Record<string, unknown>, imports: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, ...globals, require: (id: string) => {
    assert.equal(Object.hasOwn(imports, id), true, `неописанная граница: ${id}`);
    return imports[id];
  } });
  return module.exports as T;
}

// Здесь подменены только среда и планировщик: решения о pin/release исполняются из обоих production-модулей.
function environment(raw: string, run: (h: ReturnType<typeof harness>) => void, bridge?: Bridge, width = 400): void {
  GlobalRegistrator.register();
  try { run(harness(raw, bridge, width)); }
  finally { GlobalRegistrator.unregister(); }
}

function harness(raw: string, providedBridge: Bridge | undefined, initialWidth: number) {
  let width = initialWidth, now = 0, nextTimer = 0;
  const calls: boolean[] = [];
  const listeners = new Set<() => void>();
  const timers = new Map<number, { at: number; run: () => void }>();
  const mq = {
    get matches() { return width <= 760; },
    addEventListener: (type: string, on: () => void) => { assert.equal(type, 'change'); listeners.add(on); },
    removeEventListener: (type: string, on: () => void) => { assert.equal(type, 'change'); listeners.delete(on); },
  };
  const fakeWindow = {
    GusVoiceNative: providedBridge ?? { setViewerRotation: (on: boolean) => { calls.push(on); return true; } },
    matchMedia: (query: string) => { assert.equal(query, '(max-width: 760px)'); return mq; },
    setTimeout: (run: () => void, delay: number) => {
      const id = ++nextTimer; timers.set(id, { at: now + delay, run }); return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  let state = false, mounted = false, cleanup: (() => void) | undefined;
  const react = {
    useState: (initial: () => boolean) => {
      if (!mounted) state = initial();
      return [state, (value: boolean) => { state = value; }];
    },
    useEffect: (effect: () => (() => void) | undefined) => {
      if (!mounted) { mounted = true; cleanup = effect(); }
    },
  };
  const phone = load<Phone>(phoneSource, { window: fakeWindow }, {
    react, './hotkeys': { isMobile: () => false, isTauri: () => false },
  });
  phone.usePhoneLayout();
  let notify: (() => void) | undefined;
  let observations = 0;
  class Observer {
    constructor(callback: () => void) { notify = callback; }
    observe(root: unknown, options: MutationObserverInit) {
      assert.equal(root === document.body, true);
      assert.deepEqual({ ...options }, { childList: true }, 'наблюдение только за порталами, без subtree/attributes');
      observations++;
    }
  }
  const viewer = load<Viewer>(raw, { window: fakeWindow, document, MutationObserver: Observer }, { './phoneLayout': phone });
  const flush = () => notify?.();
  const add = (className: string, parent: HTMLElement = document.body) => {
    const element = document.createElement('div'); element.className = className;
    parent.append(element); flush(); return element;
  };
  return {
    viewer, phone, calls, listeners, timers, add, flush,
    observed: () => observations,
    phoneLayout: () => phone.usePhoneLayout(),
    width: (value: number) => { width = value; for (const listener of Array.from(listeners)) listener(); },
    advance: (ms: number) => {
      const until = now + ms;
      while (true) {
        const first = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        now = first[1].at; timers.delete(first[0]); first[1].run();
      }
      now = until;
    },
    cleanup: () => cleanup?.(),
  };
}

function directLayers(raw = source): void {
  environment(raw, h => {
    h.viewer.installViewerRotation();
    assert.deepEqual(h.calls, [false], 'на старте оболочка возвращается в портрет');
    const wrapper = h.add('message');
    h.add('lightbox', wrapper); h.add('pick-viewer', wrapper);
    assert.equal(h.viewer.viewerOpen(document.body), false, 'R276:вложенная-разметка-не-портал');
    assert.deepEqual(h.calls, [false], 'вложенный CSS-класс не включает датчик');
    const lightbox = h.add('lightbox');
    assert.equal(h.viewer.viewerOpen(document.body), true);
    assert.deepEqual(h.calls, [false, true]);
    lightbox.remove(); h.flush();
    assert.deepEqual(h.calls, [false, true, false]);
    h.cleanup();
  });
}

it('R276 только прямые порталы body разрешают поворот, похожая вложенная разметка игнорируется', () => directLayers());

for (const className of ['lightbox', 'pick-viewer']) {
  it(`R276 ${className}: открытие до установки наблюдателя сбрасывает портрет, затем включает поворот`, () => {
    environment(source, h => {
      h.add(className); h.viewer.installViewerRotation();
      assert.deepEqual(h.calls, [false, true]);
      assert.equal(h.observed(), 1);
      assert.equal(h.phoneLayout(), true);
      h.cleanup();
    });
  });
}

it('R276 два просмотра друг над другом не возвращают портрет до закрытия последнего', () => {
  environment(source, h => {
    h.viewer.installViewerRotation();
    const first = h.add('pick-viewer'), second = h.add('lightbox');
    assert.deepEqual(h.calls, [false, true]);
    second.remove(); h.flush();
    assert.deepEqual(h.calls, [false, true], 'закрытие верхнего просмотра сохраняет поворот нижнего');
    first.remove(); h.flush();
    assert.deepEqual(h.calls, [false, true, false]);
    h.cleanup();
  });
});

it('R276 замена одного портала другим в одной доставке observer не возвращает портрет между просмотрщиками', () => {
  // React может в одном commit снять Lightbox и поставить галерею: промежуточное состояние не должно дёргать датчик.
  environment(source, h => {
    h.viewer.installViewerRotation();
    const first = h.add('lightbox'); h.width(1000);
    const next = document.createElement('div'); next.className = 'pick-viewer';
    first.replaceWith(next); h.flush();
    assert.deepEqual(h.calls, [false, true], 'при пакетной замене не отправляется промежуточный false');
    assert.equal(h.phoneLayout(), true); assert.equal(h.timers.size, 0);
    next.remove(); h.flush(); h.advance(2500);
    assert.deepEqual(h.calls, [false, true, false]);
    assert.equal(h.phoneLayout(), false);
    h.cleanup();
  });
});

for (const path of ['remove', 'removeChild', 'replaceChildren', 'replaceWith'] as const) {
  it(`R276 закрытие портала через ${path} возвращает портрет, следующий просмотр снова работает`, () => {
    environment(source, h => {
      h.viewer.installViewerRotation();
      // Наблюдатель намеренно не знает, была ли причина выходом кнопкой, «Назад» или размонтированием React.
      for (const className of ['lightbox', 'pick-viewer']) {
        const layer = h.add(className);
        if (path === 'remove') layer.remove();
        if (path === 'removeChild') document.body.removeChild(layer);
        if (path === 'replaceChildren') document.body.replaceChildren();
        if (path === 'replaceWith') layer.replaceWith(document.createElement('section'));
        h.flush();
        h.flush();
      }
      assert.deepEqual(h.calls, [false, true, false, true, false], 'повторная мутация без просмотра не дублирует мост');
      h.cleanup();
    });
  });
}

it('R276 планшет с ответом false не закрепляет широкую раскладку', () => {
  const calls: boolean[] = [];
  environment(source, h => {
    h.viewer.installViewerRotation();
    const layer = h.add('lightbox'); h.width(1000);
    assert.equal(h.phoneLayout(), false, 'планшету нельзя сохранять телефонную раскладку');
    assert.equal(h.phone.isPhoneUiNow(), false);
    layer.remove(); h.flush();
    assert.deepEqual(calls, [false, true, false]);
    assert.equal(h.timers.size, 0);
    h.cleanup();
  }, { setViewerRotation: on => { calls.push(on); return false; } });
});

it('R276 старая оболочка без метода не ставит наблюдатель и не закрепляет раскладку', () => {
  environment(source, h => {
    assert.doesNotThrow(() => h.viewer.installViewerRotation());
    h.add('pick-viewer'); h.width(1000);
    assert.equal(h.observed(), 0);
    assert.equal(h.phoneLayout(), false);
    assert.equal(h.timers.size, 0);
    h.cleanup();
  }, {});
});

it('R276 закреп держит реальную телефонную раскладку в альбомной и снимается при возврате портрета', () => {
  environment(source, h => {
    h.viewer.installViewerRotation();
    const layer = h.add('lightbox'); h.width(1000);
    assert.equal(h.phoneLayout(), true); assert.equal(h.phone.isPhoneUiNow(), true);
    layer.remove(); h.flush();
    assert.equal(h.phoneLayout(), true, 'до обратного поворота дерево ленты остаётся телефонным');
    assert.equal(h.timers.size, 1); assert.equal(h.listeners.size, 2);
    h.width(760);
    assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 1);
    h.width(761);
    assert.equal(h.phoneLayout(), false, 'после портрета закреп снят, ширина снова управляет раскладкой');
    h.cleanup();
  });
});

it('R276 запасное снятие закрепа не происходит на 2499 мс и происходит ровно на 2500 мс', () => {
  environment(source, h => {
    h.viewer.installViewerRotation();
    const layer = h.add('pick-viewer'); h.width(1000); layer.remove(); h.flush();
    h.advance(2499);
    assert.equal(h.phoneLayout(), true); assert.equal(h.timers.size, 1);
    h.advance(1);
    assert.equal(h.phoneLayout(), false); assert.equal(h.phone.isPhoneUiNow(), false);
    assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 1);
    h.cleanup();
  });
});

function reopen(raw = source): void {
  environment(raw, h => {
    h.viewer.installViewerRotation();
    const layer = h.add('lightbox'); h.width(1000); layer.remove(); h.flush();
    h.advance(2499);
    const second = h.add('pick-viewer');
    assert.equal(h.timers.size, 0, 'R276:повторное-открытие-отменяет-таймер');
    assert.equal(h.listeners.size, 1, 'R276:повторное-открытие-удаляет-слушатель');
    h.advance(1);
    assert.equal(h.phoneLayout(), true, 'старый таймер не меняет дерево нового просмотра');
    h.width(400); h.width(1000);
    assert.equal(h.phoneLayout(), true, 'старый слушатель не снимает закреп нового просмотра');
    second.remove(); h.flush(); h.advance(2500);
    assert.equal(h.phoneLayout(), false);
    assert.deepEqual(h.calls, [false, true, false, true, false]);
    h.cleanup();
  });
}

it('R276 новый просмотр отменяет старый таймер и слушатель, а собственное закрытие снова освобождает закреп', () => reopen());

for (const [name, from, to, check, marker] of [
  ['без :scope > вложенный CSS-класс становится просмотром', ':scope > .lightbox, :scope > .pick-viewer', '.lightbox, .pick-viewer', directLayers, 'R276:вложенная-разметка-не-портал'],
  ['без cancelUnpin новый просмотр наследует таймер закрытого', 'if (on) {\n    cancelUnpin();', 'if (on) {', reopen, 'R276:повторное-открытие-отменяет-таймер'],
] as const) {
  it(`R276 контрфакт: ${name}`, () => {
    check();
    assert.equal(source.split(from).length - 1, 1, 'мутация однозначно меняет production-ветку');
    assert.throws(() => check(source.replace(from, to)), error =>
      error instanceof assert.AssertionError && error.message.includes(marker));
  });
}
