import assert from 'node:assert/strict';
import { before, after, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import { act } from 'react';
import * as jsx from 'react/jsx-runtime';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as shared from '@gusvoice/shared';
import * as imageSize from '../imageSize';
import * as autoRules from '../autoDownloadRules';
type Kind = 'photo' | 'video' | 'gif' | 'voice' | 'round' | 'file';
const raw = readFileSync(new URL('./AttachmentView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let createRoot: typeof import('react-dom/client')['createRoot'];
before(async () => { GlobalRegistrator.register({ url: 'http://localhost/', settings: { enableImageFileLoading: false } }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); createRoot = (await import('react-dom/client')).createRoot; });
after(() => GlobalRegistrator.unregister());
function attachment(kind: Kind, copying: boolean): shared.Attachment {
  return { id: 'fixture', name: 'Медиа', url: '/fixture-media', contentType: kind === 'photo' ? 'image/png' : kind === 'gif' ? 'image/gif' : kind === 'voice' ? 'audio/webm' : kind === 'file' ? 'application/pdf' : 'video/mp4',
    size: 1024, width: 600, height: 400, ...(copying ? { fedState: 'copying' as const } : {}),
    ...(kind === 'voice' ? { waveform: [10, 40, 70], durationMs: 4200 } : {}), ...(kind === 'round' ? { round: true } : {}) };
}
async function scene(kind: Kind, copying: boolean, fill = false, source = raw) {
  let urls = 0, players = 0, opened = 0;
  let downloadHref: string | undefined;
  const leaf = (tag: string) => (p: { a: shared.Attachment; href?: string }) => { players++; return React.createElement(tag, { 'data-att': p.a.id, href: p.href, src: p.a.url }); };
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, '@gusvoice/shared': shared, '../imageSize': imageSize, '../autoDownloadRules': autoRules,
    '../api': { api: { attachmentDownloadUrl: () => { urls++; return '/fixture-download'; } } },
    '../autoDownload': { useAutoLoad: () => ({ load: true, autoplay: false, kind: 'photo' }), useAutoDownload: () => autoRules.AUTO_DOWNLOAD_DEFAULTS,
      saveDataOn: () => false, loadedByHandHas: () => false, markLoadedByHand: () => { throw new Error('загрузка не ожидается'); } },
    '../fileActions': { attachmentKey: (a: shared.Attachment) => a.id, sizeText: (n: number) => `${n} B` },
    './FileCard': { FileCard: leaf('a'), DownloadBadge: (p: { href: string }) => { downloadHref = p.href; return null; } }, './VideoAttachment': { VideoAttachment: leaf('video') },
    './RoundVideo': { RoundVideo: leaf('video') }, './VoiceMessage': { VoiceMessage: leaf('audio') },
    './Icon': { Icon: () => null }, './SpoilerCover': { useSpoilerHidden: () => false, SpoilerCover: () => null },
  };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { module, exports: module.exports, require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `явный импорт ${id}`); return deps[id]; } });
    const Component = (module.exports as typeof import('./AttachmentView')).AttachmentView;
    await act(async () => root.render(React.createElement(Component, { a: attachment(kind, copying), fill, onOpen: () => { opened++; } })));
    if (!copying) {
      assert.equal(urls, 1, 'готовый файл вычисляет URL скачивания один раз при первом рендере');
      assert.equal(host.querySelectorAll('img,video,audio,a').length, 1, 'готовое медиа сохраняет прежнюю ветку');
      if (kind === 'photo' || kind === 'gif') {
        const image = host.querySelector('img'); assert.equal(!!image, true, 'готовая миниатюра есть');
        assert.equal(image?.getAttribute('src'), '/fixture-media', 'миниатюра использует URL показа');
        assert.equal(downloadHref, '/fixture-download', 'скачивание использует отдельный URL бэкенда');
        // B12: симулируем отказ ресурса явно. about:blank HappyDOM не должен случайно вызывать этот второй рендер.
        await act(async () => image!.dispatchEvent(new window.Event('error')));
        assert.equal(urls, 2, 'фолбэк миниатюры вычисляет URL ровно на втором рендере');
        assert.equal(host.querySelectorAll('img,video,audio,a').length, 0, 'битая миниатюра не остаётся медиа');
        assert.equal(!!host.querySelector('.att-img.att-broken[role="img"]'), true, 'отказ фото или GIF оставляет аккуратную плитку');
      }
      return;
    }
    assert.equal(urls, 0, 'ещё не приехавший файл не запрашивает URL'); assert.equal(players, 0, 'копия не запускает плеер или FileCard');
    assert.equal(host.querySelectorAll('img,video,audio,[href],[data-att]').length, 0, 'копия не раскрывает медиа, ссылку или меню');
    const selector = kind === 'voice' ? '.voice-copying' : kind === 'round' ? '.round-msg-btn.att-copying' : kind === 'file' ? '.att-file.att-copying' : '.att-video.att-copying';
    assert.equal(!!host.querySelector(selector), true, 'правильная форма загружаемого вложения');
    if (kind === 'photo' || kind === 'video' || kind === 'gif') {
      const frame = host.querySelector<HTMLElement>('.att-img.att-pending');
      assert.equal(frame?.style.width, fill ? '' : '360px'); assert.equal(frame?.style.aspectRatio, fill ? '' : '360 / 240');
    }
    if (kind === 'voice') {
      assert.equal(host.querySelectorAll('.voice-bar').length, 3);
      const play = host.querySelector<HTMLElement>('.voice-play')!;
      assert.equal(play.getAttribute('aria-disabled'), 'true');
      const key = Object.keys(play).find(k => k.startsWith('__reactProps$'));
      assert.equal(typeof (play as unknown as Record<string, { onClick?: unknown }>)[key ?? '']?.onClick, 'undefined');
      await act(async () => play.click());
    }
    assert.equal(opened, 0);
  } finally { await act(async () => root.unmount()); host.remove(); }
}
for (const kind of ['photo', 'video', 'gif', 'voice', 'round', 'file'] as const) it(`R194 ${kind}: copying не открывает байты, готовое вложение сохраняет прежнюю ветку`, async () => {
  // Класс ошибки: ещё не приехавшее медиа запускает запрос или активное управление.
  await scene(kind, true); await scene(kind, false);
});
it('R194 копирующееся фото в альбоме не перебивает размер ячейки встроенными стилями', async () => {
  // Класс ошибки: заглушка меняет геометрию готового альбома.
  await scene('photo', true, true);
});
it('R194 контрфакт снятого раннего copying-выхода ловится обращением к URL', async () => {
  // Класс ошибки: файл ещё едет, а компонент уже обращается к выдаче.
  await scene('photo', true); const anchor = "if (a.fedState === 'copying') return <CopyingAttachment a={a} fill={fill} />;";
  assert.equal(raw.split(anchor).length - 1, 1, 'единственный copying-якорь');
  await assert.rejects(scene('photo', true, false, raw.replace(anchor, '')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('ещё не приехавший файл не запрашивает URL'));
});
