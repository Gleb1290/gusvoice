import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as shared from '@gusvoice/shared';
import * as rules from '../sharedMediaRules';
import { Icon } from './Icon';
import type { ConvMessage, SharedMediaCounts, SharedMediaKind } from '@gusvoice/shared';

const source = readFileSync(new URL('./SharedMedia.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const zeros: SharedMediaCounts = { media: 0, file: 0, link: 0, gif: 0, voice: 0 };
const message = (id: string): ConvMessage => ({ id, createdAt: '2026-10-12T10:00:00Z', content: '', author: { id: 'peer', displayName: 'Гусь' },
  attachments: [{ id: `a:${id}`, name: 'file.pdf', size: 123, contentType: 'application/pdf', url: '/file.pdf' }] } as ConvMessage);
const empty = () => null;
type Fixture = { host: HTMLElement; scroller: HTMLElement; calls: string[]; scroll(own: boolean, top: number): Promise<void>; click(selector: string): Promise<void> };
async function fixture(check: (f: Fixture) => Promise<void>, raw = source, counts: SharedMediaCounts = { ...zeros, file: 2, link: 1 },
  next = false, embedded = true, enabled = true) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // Геометрия задана ДО эффектов загрузки, в том числе для внутреннего списка мутанта.
  // Иначе happy-dom с нулевой высотой искусственно попросил бы вторую страницу сразу при монтаже.
  for (const [name, value] of [['scrollHeight', 3000], ['clientHeight', 500]] as const)
    Object.defineProperty(window.HTMLElement.prototype, name, { configurable: true, get: () => value });
  const host = document.createElement('div'); const scroller = document.createElement('section'); document.body.append(scroller); scroller.append(host);
  for (const [name, value] of [['scrollHeight', 3000], ['clientHeight', 500]] as const) Object.defineProperty(scroller, name, { configurable: true, get: () => value });
  scroller.scrollTo = options => { if (typeof options === 'object') scroller.scrollTop = options.top ?? 0; };
  const root = createRoot(host); const calls: string[] = [];
  const state = { convActive: enabled, serverFeatures: ['media1'], selectDm: (id: string) => calls.push(`select:${id}`) };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  const module = { exports: {} as typeof import('./SharedMedia') };
  const deps: Record<string, unknown> = { react: React, 'react/jsx-runtime': jsx, '@gusvoice/shared': shared, '../sharedMediaRules': rules,
    '../store': { useStore }, '../api': { api: {
      convMediaCounts: async (id: string, former: boolean) => { calls.push(`counts:${id}:${former}`); return counts; },
      convMedia: async (id: string, kind: SharedMediaKind, cursor: string | null, former: boolean) => {
        calls.push(`load:${id}:${kind}:${cursor}:${former}`);
        return { messages: kind === 'file' ? [message(cursor ? 'second' : 'first')] : [], next: next && !cursor ? 'cursor' : null };
      }, attachmentDownloadUrl: () => '/download',
    } },
    '../convSyncRules': { serverSharedMedia: (features: string[]) => features.includes('media1') },
    '../dialogChrome': { useDialogChrome: () => React.useRef(null) }, '../feedJump': { requestFeedJump: (conv: string, id: string) => calls.push(`jump:${conv}:${id}`) },
    '../fileActions': { openAttachmentFile() {}, sizeText: (n: number) => `${n}` }, '../mediaViewerRules': { viewerDate: () => '12 октября' },
    '../phoneLayout': { usePhoneLayout: () => true }, '../peerName': { usePeerName: () => (_id: string, fallback: string) => fallback },
    '../toast': { toastError(e: unknown) { throw e; } }, './BottomSheet': { BottomSheet: empty }, './Icon': { Icon }, './Lightbox': { Lightbox: empty },
    './SpoilerCover': { SpoilerParticles: empty, useSpoilerHidden: () => false }, './VideoAttachment': { BLANK_POSTER: '', videoFrameSrc: () => '' },
    './RoundVideo': { RoundVideo: empty }, './VoiceMessage': { VoiceMessage: empty },
  };
  try {
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { module, exports: module.exports, window, document, getComputedStyle: window.getComputedStyle.bind(window),
        require: (id: string) => { if (!Object.hasOwn(deps, id)) throw Error(`Неописанная граница ${id}`); return deps[id]; } });
    await React.act(async () => root.render(React.createElement(module.exports.SharedMediaPanel, { convId: 'conv', scroller: embedded ? scroller : null,
      onLeave: () => calls.push('leave') })));
    const own = host.querySelector<HTMLElement>('.smedia-list');
    if (own) for (const [name, value] of [['scrollHeight', 3000], ['clientHeight', 500]] as const) Object.defineProperty(own, name, { configurable: true, get: () => value });
    await check({ host, scroller, calls,
      scroll: async (inside, top) => { const el = inside ? own! : scroller; el.scrollTop = top; await React.act(async () => { el.dispatchEvent(new window.Event('scroll')); }); },
      click: async selector => { const btn = host.querySelector<HTMLElement>(selector); assert.equal(!!btn, true, selector); await React.act(async () => btn!.click()); },
    });
  } finally {
    try { await React.act(async () => root.unmount()); } finally { scroller.remove(); try { await GlobalRegistrator.unregister(); }
      finally { if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); } }
  }
}
// Класс ошибки: пустой блок общих медиа оставляет лишние вкладки профиля.
it('R173 все нулевые счётчики не показывают SharedMediaPanel и не грузят сообщения', () => fixture(async f => {
  assert.equal(!!f.host.querySelector('.smedia-embed'), false); assert.equal(f.calls.some(c => c.startsWith('load:')), false);
}, source, zeros));
// Класс ошибки: выключенная возможность вызывает API или рисует панель.
it('R173 без convActive панель скрыта и API не вызывается', () => fixture(async f => {
  assert.equal(f.host.textContent, ''); assert.equal(f.calls.length, 0);
}, source, { ...zeros, file: 1 }, false, true, false));
// Класс ошибки: пустые вкладки показаны или первая непустая не выбрана.
it('R173 вкладки только непустых видов, первая выбрана и загружается, счётчики отображены', () => fixture(async f => {
  const tabs = f.host.querySelectorAll('button[role=tab]'); assert.equal(tabs.length, 2);
  assert.equal(tabs[0].textContent, 'Файлы2'); assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.equal(tabs[1].textContent, 'Ссылки1'); assert.equal(tabs[1].getAttribute('aria-selected'), 'false');
  assert.equal(f.calls.includes('counts:conv:false'), true); assert.equal(f.calls.includes('load:conv:file:null:false'), true);
  await f.click('button[role=tab]:nth-child(2)'); assert.equal(f.host.querySelector('.smedia-list')?.getAttribute('aria-label'), 'Ссылки');
  assert.equal(f.calls.includes('load:conv:link:null:false'), true);
}));
async function scroller(raw = source) {
  await fixture(async f => {
    const loads = () => f.calls.filter(c => c.startsWith('load:')).length;
    assert.equal(loads(), 1); await f.scroll(true, 2450); assert.equal(loads(), 1, 'свой список встроенной панели не листает');
    await f.scroll(false, 1900); assert.equal(loads(), 1, 'ровно 600 до низа ещё без подгрузки');
    await f.scroll(false, 1901); assert.equal(loads(), 2); assert.equal(f.calls.includes('load:conv:file:cursor:false'), true);
  }, raw, { ...zeros, file: 2 }, true);
}
// Класс ошибки: подгрузка слушает внутренний список вместо переданного scroller.
it('R173 встроенная панель подгружает только скроллом экрана, порог 600 исключителен', () => scroller());
async function leave(raw = source) {
  await fixture(async f => {
    await f.click('.smedia-goto'); assert.equal(f.calls.includes('leave'), true);
    assert.equal(f.calls.includes('jump:conv:first'), true); assert.equal(f.calls.includes('select:conv'), true);
    assert.equal(f.calls.filter(c => c === 'leave').length, 1);
  }, raw, { ...zeros, file: 1 });
}
// Класс ошибки: Показать в чате оставляет экран профиля поверх открытой беседы.
it('R173 Показать в чате вызывает onLeave и переход к нужному сообщению беседы', () => leave());
// Класс ошибки: встроенный scroller проигнорирован, обработчик остался у собственного списка.
it('R173 мутант подгрузки по внутреннему списку обнаруживается реальными scroll событиями', async () => {
  const anchor = 'scroller={scroller} onLeave={onLeave}'; assert.equal(source.split(anchor).length - 1, 1);
  await scroller(); await assert.rejects(() => scroller(source.replace(anchor, 'scroller={null} onLeave={onLeave}')), assert.AssertionError);
});
// Класс ошибки: onLeave потерян между панелью и телом общих медиа.
it('R173 мутант потерянного onLeave обнаруживается переходом Показать в чате', async () => {
  const anchor = 'scroller={scroller} onLeave={onLeave}'; assert.equal(source.split(anchor).length - 1, 1);
  await leave(); await assert.rejects(() => leave(source.replace(anchor, 'scroller={scroller}')), assert.AssertionError);
});
