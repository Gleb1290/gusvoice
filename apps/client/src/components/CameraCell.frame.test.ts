import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { CameraCell } from './CameraScreen';

before(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  const streams = new WeakMap<HTMLMediaElement, MediaStream | null>();
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, get() { return streams.get(this) ?? null; }, set(value: MediaStream | null) { streams.set(this, value); } });
});
after(() => GlobalRegistrator.unregister());

async function withCell(check: (host: HTMLDivElement, render: (stream: MediaStream | null) => Promise<void>) => Promise<void>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (stream: MediaStream | null) => {
    await React.act(async () => { root.render(React.createElement(CameraCell, { stream, facing: 'environment', onOpen() {} })); });
  };
  try { await check(host, render); }
  finally { await React.act(async () => root.unmount()); host.remove(); }
}
const stream = () => ({}) as MediaStream;

it('до первого кадра плитка не показывает значок или пустое видео, после кадра показывает превью', async () => {
  await withCell(async (host, render) => {
    await render(null);
    assert.equal(host.querySelector('video'), null);
    assert.equal(host.querySelector('.gal-cam-ico'), null);
    assert.equal(host.querySelector('button')?.getAttribute('aria-label'), 'Камера');
    await render(stream());
    const video = host.querySelector('video')!;
    assert.equal(video.style.visibility, 'hidden');
    assert.equal(host.querySelector('.gal-cam-ico'), null);
    await React.act(async () => { video.dispatchEvent(new Event('loadeddata')); });
    assert.equal(video.style.visibility, 'visible');
    assert.ok(host.querySelector('.gal-cam-ico'));
  });
});

it('новый поток не показывает старый кадр до собственной загрузки', async () => {
  await withCell(async (host, render) => {
    await render(stream());
    await React.act(async () => { host.querySelector('video')!.dispatchEvent(new Event('loadeddata')); });
    await render(stream());
    const video = host.querySelector('video')!;
    assert.equal(video.style.visibility, 'hidden');
    assert.equal(host.querySelector('.gal-cam-ico'), null);
    await React.act(async () => { video.dispatchEvent(new Event('loadeddata')); });
    assert.equal(video.style.visibility, 'visible');
  });
});

it('ошибка видео и исчезновение потока возвращают пустую плитку', async () => {
  await withCell(async (host, render) => {
    await render(stream());
    const video = host.querySelector('video')!;
    await React.act(async () => { video.dispatchEvent(new Event('loadeddata')); });
    await React.act(async () => { video.dispatchEvent(new Event('error')); });
    assert.equal(video.style.visibility, 'hidden');
    assert.equal(host.querySelector('.gal-cam-ico'), null);
    await render(null);
    assert.equal(host.querySelector('video'), null);
    assert.equal(host.querySelector('.gal-cam-ico'), null);
  });
});