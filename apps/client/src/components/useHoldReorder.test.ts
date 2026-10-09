import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, before, after } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement, act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { useHoldReorder as originalHook } from './useHoldReorder';

type Hook = typeof originalHook;
let registered = false;
before(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  registered = true;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
after(() => { if (registered) GlobalRegistrator.unregister(); });

function mutantHook(): Hook {
  const source = readFileSync(new URL('./useHoldReorder.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const changed = source.replace('if (s.touch) return clear();', '/* мутант: ранний touch-перенос превращён в drag */');
  assert.notEqual(changed, source, 'точка мутации раннего сенсорного сдвига существует');
  const module = { exports: {} as Record<string, unknown> };
  const js = ts.transpileModule(changed, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, {
    module, exports: module.exports,
    require: (id: string) => id === 'react' ? requireReact() : id === '../photoEditRules' ? { REORDER_HOLD_MS: 350, REORDER_SLOP_PX: 8 } : (() => { throw new Error(`неожиданный импорт ${id}`); })(),
    navigator, document, setTimeout, clearTimeout,
  });
  return module.exports.useHoldReorder as Hook;
}
function requireReact() {
  return { useEffect: ReactHooks.useEffect, useRef: ReactHooks.useRef, useState: ReactHooks.useState };
}
import * as ReactHooks from 'react';

function pointer(type: string, pointerType: string, pointerId: number, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerType, pointerId, clientX: x, clientY: y, button: 0 });
  return event;
}

async function scenario(hook: Hook, earlyMoveStarts: boolean, state: { moves: Array<[number, number]>; clicks: number }) {
  const host = document.createElement('div'); document.body.append(host);
  let root: Root | null = createRoot(host);
  let second!: HTMLButtonElement;
  const Harness: ComponentType = () => {
    const result = hook(2, (from, to) => state.moves.push([from, to]));
    return createElement('div', { 'data-drag': result.drag ? 'yes' : 'no' },
      createElement('button', { ...result.bind(0), ref: (el: HTMLButtonElement | null): void => { if (el) Object.defineProperty(el, 'setPointerCapture', { configurable: true, value: () => {} }); }, onClick: () => { state.clicks++; } }, 'first'),
      createElement('button', { ...result.bind(1), ref: (el: HTMLButtonElement | null): void => { if (el) second = el; } }, 'second'));
  };
  try {
    await act(async () => { root!.render(createElement(Harness)); });
    const first = host.querySelector<HTMLButtonElement>('button')!;
    await act(async () => {
      first.dispatchEvent(pointer('pointerdown', 'touch', 1, 10, 10));
      first.dispatchEvent(pointer('pointermove', 'touch', 1, 40, 10));
    });
    assert.equal(host.querySelector('[data-drag]')?.getAttribute('data-drag'), earlyMoveStarts ? 'yes' : 'no',
      'сдвиг пальца больше slop до таймера отдаётся прокрутке, не начинает drag');
    await act(async () => { first.dispatchEvent(pointer('pointerup', 'touch', 1, 40, 10)); });
    assert.deepEqual(state.moves, [], 'ранний свайп не переставляет плитки');

    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [second] });
    await act(async () => {
      first.dispatchEvent(pointer('pointerdown', 'mouse', 2, 10, 10));
      first.dispatchEvent(pointer('pointermove', 'mouse', 2, 70, 10));
    });
    await act(async () => { first.dispatchEvent(pointer('pointerup', 'mouse', 2, 70, 10)); });
    assert.deepEqual(state.moves, [[0, 1]], 'мышиное перетаскивание меняет местами реальные элементы');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { first.dispatchEvent(click); });
    assert.equal(state.clicks, 0, 'синтетический click после drag не открывает просмотр плитки');
    assert.equal(click.defaultPrevented, true, 'клик после перетаскивания явно подавлен');
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    root = null; host.remove();
  }
}

it('касание до 350 мс остаётся прокруткой, а клик после перетаскивания не открывает просмотр', async () => {
  const good = { moves: [] as Array<[number, number]>, clicks: 0 };
  await scenario(originalHook, false, good);
  const mutated = { moves: [] as Array<[number, number]>, clicks: 0 };
  await assert.rejects(() => scenario(mutantHook(), false, mutated), assert.AssertionError,
    'исполняемый мутант раннего touch-drag нарушает тот же контракт на настоящем hook');
  assert.deepEqual(mutated.moves, [], 'ранний мутант падает именно на старте drag, прежде чем дойдёт до отпускания');
});
