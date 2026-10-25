import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as imageSize from '../imageSize';
import * as autoRules from '../autoDownloadRules';

const source = readFileSync(new URL('./AttachmentView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let createRoot: typeof import('react-dom/client')['createRoot'];
before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/', settings: { enableImageFileLoading: false } });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  createRoot = (await import('react-dom/client')).createRoot;
});
after(() => GlobalRegistrator.unregister());

const photo: shared.Attachment = { id: 'once-photo', name: 'секрет.png', contentType: 'image/png',
  size: 1024, width: 600, height: 400, url: '/secret-photo', once: true };
const video: shared.Attachment = { ...photo, id: 'once-video', name: 'секрет.mp4', contentType: 'video/mp4', url: '/secret-video', durationMs: 4200 };
type Options = { mine?: boolean; fill?: boolean; auto?: boolean; text?: string };

// Настоящий AttachmentView целиком, реальные React/DOM/чистые shared-правила.
// Плееры/файловые компоненты — наблюдаемые leaf-границы, не переписанная логика onceMediaTile.
async function scene(a: shared.Attachment, options: Options, check: (s: {
  host: HTMLDivElement; opened: shared.Attachment[]; leaves: string[]; handLoads: () => number;
}) => Promise<void>) {
  const leaves: string[] = [], opened: shared.Attachment[] = [];
  let handLoads = 0;
  const leaf = (tag: 'video' | 'audio' | 'a', name: string) => (p: { a: shared.Attachment; href?: string; onOpen?: (a: shared.Attachment) => void }) => {
    leaves.push(name);
    return React.createElement(tag, { 'data-leaf': name, ...(tag === 'a' ? { href: p.href } : { src: p.a.url }), onClick: () => p.onOpen?.(p.a) });
  };
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, '@gusvoice/shared': shared,
    '../imageSize': imageSize, '../autoDownloadRules': autoRules,
    '../api': { api: { attachmentDownloadUrl: () => '/secret-download' } },
    '../autoDownload': {
      useAutoLoad: () => ({ load: options.auto ?? true, autoplay: true, kind: a.contentType.startsWith('video/') ? 'video' : 'photo' }),
      useAutoDownload: () => autoRules.AUTO_DOWNLOAD_DEFAULTS, saveDataOn: () => false,
      loadedByHandHas: () => false, markLoadedByHand: () => { handLoads++; },
    },
    '../fileActions': { attachmentKey: (a: shared.Attachment) => a.id, sizeText: (n: number) => `${n} B` },
    './FileCard': { FileCard: leaf('a', 'file'), DownloadBadge: (p: { href: string }) => {
      leaves.push('download'); return React.createElement('a', { href: p.href, download: true });
    } },
    './VideoAttachment': { VideoAttachment: leaf('video', 'video') }, './RoundVideo': { RoundVideo: leaf('video', 'round') },
    './VoiceMessage': { VoiceMessage: leaf('audio', 'voice'), MusicFileCard: leaf('audio', 'music') },
    './Icon': { Icon: ({ name }: { name: string }) => React.createElement('span', { 'data-icon': name }) },
    './SpoilerCover': { useSpoilerHidden: () => false, SpoilerCover: () => null },
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(options.text ?? source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { module, exports: module.exports, window,
    require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `явная граница ${id}`); return deps[id]; } });
  const Component = (module.exports as typeof import('./AttachmentView')).AttachmentView;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  // Только sender-tooltip timer: не оставляем реальный таймер после unmount.
  const originalTimeout = window.setTimeout;
  const timers: ReturnType<typeof originalTimeout>[] = [];
  window.setTimeout = ((...args: Parameters<typeof window.setTimeout>) => {
    const id = originalTimeout.apply(window, args); timers.push(id); return id;
  }) as typeof window.setTimeout;
  try {
    await React.act(async () => root.render(React.createElement(Component, { a, fill: options.fill,
      voice: options.mine ? { mine: true, conversationId: 'dm', messageId: 'message', listened: false } : undefined,
      onOpen: att => { opened.push(att); } })));
    await check({ host, opened, leaves, handLoads: () => handLoads });
  } finally {
    await React.act(async () => root.unmount()); host.remove();
    timers.forEach(id => window.clearTimeout(id)); window.setTimeout = originalTimeout;
  }
}

async function closed(a = photo, options: Options = {}) {
  await scene(a, options, async ({ host, opened, leaves, handLoads }) => {
    assert.equal(host.querySelectorAll('.att-once').length, 1, 'R262:закрытая-одноразовая-плитка');
    assert.equal(host.querySelectorAll('img,video,audio,source,[src],[href],[download],[data-att]').length, 0,
      'R262:плитка-не-раскрывает-файл-или-скачивание');
    assert.deepEqual(leaves, [], 'закрытая плитка не монтирует файл, плеер или скачивание');
    assert.equal(handLoads(), 0);
    assert.equal(opened.length, 0);
    const tile = host.querySelector<HTMLButtonElement>('.att-once')!;
    const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await React.act(async () => { tile.dispatchEvent(event); });
    assert.equal(event.defaultPrevented, true, 'нативное меню не позволяет сохранить закрытый файл');
    await React.act(async () => tile.click());
    assert.equal(opened.length, 1, 'один клик получателя отправляет ровно один onOpen');
    assert.equal(opened[0] === a, true, 'открывается ровно нажатое вложение');
    assert.equal(handLoads(), 0, 'открытие once не превращается в обычную ручную загрузку');
  });
}

for (const [kind, a] of [['фото', photo], ['видео', video]] as const) {
  it(`R262 ${kind}: включённая автозагрузка не раскрывает файл, получатель открывает отдельным кликом`, async () => closed(a));
  it(`R262 ${kind}: выключенная автозагрузка оставляет once-плитку вместо обычной кнопки «Скачать»`, async () => closed(a, { auto: false }));
  it(`R262 ${kind}: автор видит подсказку, но не может открыть свою одноразовую плитку`, async () => {
    await scene({ ...a, onceTtl: 7 }, { mine: true }, async ({ host, opened }) => {
      const tile = host.querySelector<HTMLButtonElement>('.att-once.mine');
      assert.equal(!!tile, true);
      assert.equal(tile?.title, 'Сообщение исчезнет после того, как собеседник его просмотрит');
      await React.act(async () => tile!.click());
      assert.equal(opened.length, 0);
      assert.equal(host.querySelector('.att-once-tip')?.textContent, tile?.title);
      assert.equal(host.querySelectorAll('img,video,audio,[src],[href],[download]').length, 0);
    });
  });
  it(`R262 обычное ${kind}: без once сохранены настоящая ветка фото или leaf видео и скачивание`, async () => {
    const ordinary = { ...a }; delete ordinary.once;
    await scene(ordinary, {}, async ({ host, leaves }) => {
      assert.equal(host.querySelectorAll('.att-once').length, 0);
      assert.equal(host.querySelector(a === photo ? 'img' : 'video')?.getAttribute('src'), a.url);
      assert.equal(leaves.includes(a === photo ? 'download' : 'video'), true);
    });
  });
}

it('R262 таймер 1 и 60 с показан как число секунд, без таймера — «1» и пламя', async () => {
  for (const ttl of [undefined, 1, 60]) await scene({ ...photo, onceTtl: ttl }, {}, async ({ host }) => {
    assert.equal(host.querySelector('.att-once-num')?.textContent, String(ttl ?? 1));
    assert.equal(host.querySelector('[data-icon]')?.getAttribute('data-icon'), ttl ? 'clock' : 'flame');
    assert.equal(host.querySelector('.att-once')?.getAttribute('aria-label'), ttl
      ? `Одноразовое фото: после открытия исчезнет через ${ttl} с` : 'Одноразовое фото: можно посмотреть один раз');
  });
});

it('R262 once не захватывает GIF, отправленное как файл и кружок — их прежние ветки сохранены', async () => {
  for (const [a, expected] of [
    [{ ...photo, contentType: 'image/gif' }, 'img'], [{ ...video, gif: true as const }, 'video'],
    [{ ...photo, asFile: true as const }, 'a'], [{ ...video, asFile: true as const }, 'a'],
    [{ ...video, round: true as const }, 'video'],
  ] as const) await scene(a, {}, async ({ host }) => {
    assert.equal(host.querySelectorAll('.att-once').length, 0);
    assert.equal(!!host.querySelector(expected), true, 'обычная медиа-ветка не потеряна из-за флага once');
  });
});

it('R262 fill сохраняет размер альбомной ячейки без встроенной геометрии плитки', async () => {
  await scene(photo, { fill: true }, async ({ host }) => {
    const tile = host.querySelector<HTMLElement>('.att-once')!;
    assert.equal(tile.style.width, ''); assert.equal(tile.style.aspectRatio, '');
  });
});

it('R262 контрфакт удаления once-ветки раскрывает фото и адресно ломает проверку плитки', async () => {
  await closed();
  const anchor = 'if (onceMediaTile(a)) return <OnceMediaTile a={a} mine={!!voice?.mine} fill={fill} onOpen={onOpen} />;';
  assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(() => closed(photo, { text: source.replace(anchor, '') }), error =>
    error instanceof assert.AssertionError && error.message.includes('R262:закрытая-одноразовая-плитка'));
});
