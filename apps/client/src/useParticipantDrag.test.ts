import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as React from 'react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { useParticipantDrag } from './useParticipantDrag.js';

it('самостоятельный переход во время удержания снимает подсветку и позволяет сразу перетащить снова', async () => {
  GlobalRegistrator.register();
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  const { createRoot } = await import('react-dom/client');
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  const moves: string[][] = [];
  function Sidebar({ channel }: { channel: string }) {
    const d = useParticipantDrag((...args) => moves.push(args));
    return React.createElement('section', { 'data-vc': 'destination', 'data-highlight': d.pDrop },
      React.createElement('button', {
        key: channel,
        onPointerDown: (e: React.PointerEvent) => d.onPpDown(e, 'member', 'Участник', channel),
        onPointerMove: d.onPpMove, onPointerUp: d.onPpUp, onPointerCancel: d.onPpCancel, onLostPointerCapture: d.onPpCancel,
      }), d.pdrag?.name);
  }
  async function render(channel: string) {
    await React.act(() => root.render(React.createElement(Sidebar, { channel })));
    const row = host.querySelector('button')!;
    let capture: number | undefined;
    row.setPointerCapture = (id) => { capture = id; };
    row.hasPointerCapture = (id) => capture === id;
    row.releasePointerCapture = () => { capture = undefined; };
    return row;
  }
  async function pointer(row: HTMLElement, type: string, x = 0) {
    await React.act(() => { row.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: x,
    })); });
  }
  try {
    const old = await render('first');
    document.elementFromPoint = () => host.querySelector('section');
    await pointer(old, 'pointerdown');
    await pointer(old, 'pointermove', 12);
    assert.equal(host.textContent, 'Участник');
    assert.equal(host.querySelector('section')?.dataset.highlight, 'destination');
    const moved = await render('second');
    assert.equal(host.textContent, '');
    assert.equal(host.querySelector('section')?.dataset.highlight, undefined);
    await pointer(moved, 'pointerup');
    assert.deepEqual(moves, []);
    for (const cancel of ['pointercancel', 'lostpointercapture', 'blur']) {
      await pointer(moved, 'pointerdown');
      await pointer(moved, 'pointermove', 12);
      if (cancel === 'blur') await React.act(() => { window.dispatchEvent(new Event('blur')); });
      else await pointer(moved, cancel);
      assert.equal(host.textContent, '');
      await pointer(moved, 'pointerup');
      assert.deepEqual(moves, []);
    }
    await pointer(moved, 'pointerdown');
    await pointer(moved, 'pointermove', 12);
    await pointer(moved, 'pointerup');
    assert.deepEqual(moves, [['second', 'member', 'destination']]);
  } finally {
    await React.act(() => root.unmount());
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});
