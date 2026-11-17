import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { after, before, it } from 'node:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { jsx, jsxs, Fragment } from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import type { RoundRecording } from '../roundRecorder';

let Overlay: typeof import('./RoundVideo').RoundRecOverlay;
before(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLMediaElement.prototype.play = async () => {};
  const module = { exports: {} as Record<string, unknown> };
  const dependencies: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': { jsx, jsxs, Fragment },
    '@gusvoice/shared': { formatDuration: () => '' },
    '../voicePlayback': {}, '../voicePlayer': {}, './Icon': { Icon: () => null },
  };
  const source = readFileSync(new URL('./RoundVideo.tsx', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    module, exports: module.exports, window, document,
    require: (id: string) => dependencies[id],
  });
  Overlay = module.exports.RoundRecOverlay as typeof Overlay;
});
after(() => GlobalRegistrator.unregister());

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function mounted(check: (host: HTMLDivElement, render: (live: RoundRecording) => Promise<void>) => Promise<void>, errors: unknown[] = []) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (live: RoundRecording) => {
    await React.act(async () => root.render(React.createElement(Overlay, {
      live, previewUrl: null, previewMs: 0, recMs: 1000, maxMs: 60000,
      onFlipError: (error) => errors.push(error),
    })));
  };
  try { await check(host, render); }
  finally { await React.act(async () => root.unmount()); host.remove(); }
}
function recording(flip: () => Promise<void>, front = () => true) {
  return { preview: null, flip, front } as unknown as RoundRecording;
}

it('смена камеры блокирует повторный тап и зеркалит только подтверждённую камеру', async () => {
  const pending = deferred(); let calls = 0, front = true;
  await mounted(async (host, render) => {
    await render(recording(() => { calls++; return pending.promise; }, () => front));
    const button = host.querySelector<HTMLButtonElement>('.round-rec-flip')!;
    await React.act(async () => { button.click(); button.click(); });
    assert.equal(calls, 1);
    assert.equal(button.disabled, true);
    assert.ok(host.querySelector('.mirror'));
    await React.act(async () => { front = false; pending.resolve(); await pending.promise; });
    assert.equal(button.disabled, false);
    assert.equal(host.querySelector('.mirror'), null);
  });
});
it('второй палец переключает камеру, даже когда браузер не присылает click', async (t) => {
  let calls = 0;
  await mounted(async (host, render) => {
    await render(recording(async () => { calls++; }));
    const button = host.querySelector<HTMLButtonElement>('.round-rec-flip')!;
    const hit = t.mock.method(document, 'elementFromPoint', () => button as Element);
    const touch = { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 2, isPrimary: false };
    await React.act(async () => {
      button.dispatchEvent(new PointerEvent('pointerdown', touch));
      button.dispatchEvent(new PointerEvent('pointerup', touch));
    });
    assert.equal(calls, 1);

    hit.mock.mockImplementation(() => host);
    await React.act(async () => {
      button.dispatchEvent(new PointerEvent('pointerdown', touch));
      button.dispatchEvent(new PointerEvent('pointerup', touch));
    });
    assert.equal(calls, 1, 'уход пальца за пределы кнопки отменяет тап');
  });
});
it('одиночный тап с последующим click переключает камеру ровно один раз', async (t) => {
  let calls = 0;
  await mounted(async (host, render) => {
    await render(recording(async () => { calls++; }));
    const button = host.querySelector<HTMLButtonElement>('.round-rec-flip')!;
    t.mock.method(document, 'elementFromPoint', () => button);
    const touch = { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 1, isPrimary: true };
    await React.act(async () => {
      button.dispatchEvent(new PointerEvent('pointerdown', touch));
      button.dispatchEvent(new PointerEvent('pointerup', touch));
    });
    assert.equal(calls, 1);
    await React.act(async () => { button.dispatchEvent(new PointerEvent('click', touch)); });
    assert.equal(calls, 1);
  });
});
it('отказ камеры показывает ошибку и позволяет повторить переключение', async () => {
  const errors: unknown[] = [];
  await mounted(async (host, render) => {
    const error = new Error('камера занята');
    await render(recording(async () => { throw error; }));
    const button = host.querySelector<HTMLButtonElement>('.round-rec-flip')!;
    await React.act(async () => { button.click(); });
    assert.deepEqual(errors, [error]);
    assert.equal(button.disabled, false);
    assert.ok(host.querySelector('.mirror'));
    const down = new Event('pointerdown', { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true, 'касание не закрывает клавиатуру до click');
  }, errors);
});
it('позднее переключение старой записи не меняет новую запись', async () => {
  const pending = deferred();
  await mounted(async (host, render) => {
    await render(recording(() => pending.promise, () => false));
    await React.act(async () => host.querySelector<HTMLButtonElement>('.round-rec-flip')!.click());
    await render(recording(async () => {}, () => true));
    await React.act(async () => { pending.resolve(); await pending.promise; });
    assert.ok(host.querySelector('.mirror'));
    assert.equal(host.querySelector<HTMLButtonElement>('.round-rec-flip')!.disabled, false);
  });
});
