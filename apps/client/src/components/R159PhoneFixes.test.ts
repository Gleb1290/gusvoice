import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { attachmentBox } from '../imageSize';
import * as stageOrderRules from '../stageOrderRules';

const sources = Object.fromEntries(['Avatar', 'AttachmentView', 'UserSettingsModal', 'VoiceChannelView'].map(name =>
  [name, readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')]));
type Platform = 'android' | 'desktop' | 'web';
type Permission = 'unsupported' | 'denied' | 'granted';
const icon = ({ name }: { name: string }) => React.createElement('i', { 'data-icon': name });

// В VM исполняется весь модуль, с настоящими React/hooks и DOM. Не вырезаем тела функций.
// Дополнительный export только делает доступными приватные панели без изменения их поведения.
function load(name: string, raw: string, platform: Platform, permission: Permission, saved: string[], joined: string[], occupied: boolean) {
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    '../firstFrame': { useFirstFrame: () => null },
    '../liteMode': { useLiteMode: () => false, avatarShowsStill: () => false },
    '../windowCovered': { useWindowMotion: () => ({ covered: false, gameFg: false }) },
    '../hotkeys': { isAndroid: () => platform === 'android', isMobile: () => platform === 'android',
      isDesktop: () => platform === 'desktop', isTauri: () => platform !== 'web' },
    '../notifications': { notifyPermissionState: async () => permission, requestNotifyPermission: async () => permission,
      osNotifyLevel: () => 'off', coinNotifyLevel: () => 'off',
      setOsNotifyLevel: (v: string) => saved.push(v), setCoinNotifyLevel: (v: string) => saved.push(v) },
    '../api': { api: { attachmentDownloadUrl: () => '/download' } },
    '../autoDownload': { useAutoLoad: () => ({ load: true, kind: 'photo' }), useAutoDownload: () => ({}),
      saveDataOn: () => false, loadedByHandHas: () => false },
    '../autoDownloadRules': { shouldAutoplayRound: () => false },
    '../imageSize': { attachmentBox },
    '../stageOrderRules': stageOrderRules,
    '../stageOrderPrefs': { useStageOrder: () => null, saveStageOrder: () => {},
      useHasStageOrder: () => false, resetStageOrder: () => {} },
    '../useStageDrag': { useStageDrag: () => ({ preview: null, dragging: false,
      nestRef: { current: null }, onPointerDown() {} }) },
    '../fileActions': { attachmentKey: () => 'attachment', sizeText: () => '1 КБ' },
    '@gusvoice/shared': { isVoiceMessage: () => false, isRoundVideo: () => false },
    './SpoilerCover': { useSpoilerHidden: () => false },
    './FileCard': { DownloadBadge: () => React.createElement('b', { 'data-download': true }) },
    './Icon': { Icon: icon, ChannelGlyph: () => React.createElement('i', { 'data-channel': true }) },
    './Goose': { Goose: ({ pose }: { pose: string }) => React.createElement('i', { 'data-goose': pose }) },
    '../store': { useStore: (select: (s: any) => unknown) => select({ presence: { channel: occupied ? ['peer'] : [] },
      joinVoice: async (id: string) => { joined.push(id); } }) },
  };
  const module = { exports: {} as Record<string, React.ComponentType<any>> };
  const extra = name === 'UserSettingsModal' ? '\nexport { NotifyPermissionRow, OsNotifyPanel, CoinNotifyPanel };' : '';
  runInNewContext(ts.transpileModule(raw + extra, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module, exports: module.exports, window, document, console, require: (id: string) => deps[id] ?? new Proxy({}, {
    get: (_t, key) => { throw new Error(`Неописанная граница ${id}.${String(key)}`); },
  }) });
  return module.exports;
}

async function fixture(name: string, component: string, props: Record<string, unknown>, check: (f: {
  host: HTMLDivElement; saved: string[]; joined: string[]; render(p: Record<string, unknown>): Promise<void>;
}) => Promise<void>, raw = sources[name], platform: Platform = 'web', permission: Permission = 'unsupported', occupied = false) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const saved: string[] = [], joined: string[] = [];
  try {
    const mod = load(name, raw, platform, permission, saved, joined, occupied);
    const render = async (p: Record<string, unknown>) => {
      props = { ...props, ...p };
      await React.act(async () => { root.render(React.createElement(mod[component], props));
        for (let i = 0; i < 5; i++) await Promise.resolve(); });
    };
    await render({}); await check({ host, saved, joined, render });
  } finally {
    await React.act(async () => root.unmount()); host.remove(); await GlobalRegistrator.unregister();
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}
function replaceOne(raw: string, from: string, to: string) {
  assert.equal(raw.split(from).length - 1, 1, 'мутант меняет один якорь целого модуля'); return raw.replace(from, to);
}
async function mutant(name: string, check: (raw: string) => Promise<void>, from: string, to: string) {
  await check(sources[name]); await assert.rejects(() => check(replaceOne(sources[name], from, to)), assert.AssertionError);
}

async function avatar(raw = sources.Avatar) {
  for (const fallback of ['letter', 'icon']) for (const [name, expected] of [['  анна ', 'А'], ['🦢 гусь', '🦢'], ['𐐨abc', '𐐀']]) {
    await fixture('Avatar', 'Avatar', { name, fallback }, async ({ host }) => {
      assert.equal(host.querySelector('.avatar-letter')?.textContent, expected);
      assert.equal(!!host.querySelector('.avatar-icon'), false);
    }, raw);
  }
}
it('B5 непустое имя даёт инициал по кодпоинту даже при fallback icon', () => avatar());
it('B5 пустое и пробельное имя дают силуэт при обоих fallback', async () => {
  for (const name of ['', '   ']) for (const fallback of ['letter', 'icon'])
    await fixture('Avatar', 'Avatar', { name, fallback }, async ({ host }) => {
      assert.equal(!!host.querySelector('.avatar-icon svg'), true); assert.equal(!!host.querySelector('.avatar-letter'), false);
    });
});
it('B5 картинка остаётся приоритетнее имени и силуэта', () => fixture('Avatar', 'Avatar', { name: 'Анна', fallback: 'icon', url: '/avatar.png' }, async ({ host }) => {
  assert.equal(host.querySelector('img')?.getAttribute('src'), '/avatar.png'); assert.equal(!!host.querySelector('.avatar-letter'), false);
}));
it('B5 возврат силуэта по fallback icon обнаруживается', () => mutant('Avatar', avatar, 'if (!initial) {', "if (fallback === 'icon' || !initial) {"));
it('B5 разрезание суррогатной пары обнаруживается', () => mutant('Avatar', avatar, 'Array.from(name.trim())[0]', 'name.trim()[0]'));

async function permissionRow(raw = sources.UserSettingsModal) {
  for (const platform of ['android', 'desktop', 'web'] as const) for (const permission of ['unsupported', 'denied', 'granted'] as const) {
    await fixture('UserSettingsModal', 'NotifyPermissionRow', {}, async ({ host }) => {
      if (permission === 'unsupported') {
        assert.equal(host.textContent?.includes('недоступны'), platform !== 'android');
        if (platform === 'android') assert.equal(host.childElementCount, 0);
      } else if (permission === 'granted') assert.equal(host.textContent?.includes('есть'), true);
      else { assert.equal(host.textContent?.includes('не выдано'), true); assert.equal(host.querySelector('button')?.textContent, 'Запросить'); }
    }, raw, platform, permission);
  }
}
it('B7 только Android unsupported скрывает строку, web/desktop и denied/granted сохраняют объяснение', () => permissionRow());
it('B7 потеря Android-условия строки обнаруживается', () => mutant('UserSettingsModal', permissionRow,
  "if (perm === 'unsupported' && isAndroid()) return null;", "if (perm === 'unsupported') return null;"));
it('B7 возврат ложной строки на Android обнаруживается', () => mutant('UserSettingsModal', permissionRow,
  "if (perm === 'unsupported' && isAndroid()) return null;", "if (false) return null;"));

async function panel(component: string, raw = sources.UserSettingsModal) {
  for (const platform of ['android', 'desktop', 'web'] as const) for (const permission of ['unsupported', 'denied', 'granted'] as const)
    await fixture('UserSettingsModal', component, {}, async ({ host, saved }) => {
      const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent === (component === 'OsNotifyPanel' ? 'Все сообщения' : 'Все в канале'))!;
      assert.ok(!!button, 'панель остаётся доступной');
      await React.act(async () => { button.click(); for (let i = 0; i < 5; i++) await Promise.resolve(); });
      assert.equal(saved.join(','), 'all'); assert.equal(button.getAttribute('aria-pressed'), 'true');
      const alert = host.querySelector('[role="alert"]');
      assert.equal(!!alert, permission === 'denied' || (permission === 'unsupported' && platform !== 'android'));
      if (permission === 'denied') assert.equal(alert?.textContent?.includes('не выдано'), true);
      if (permission === 'unsupported' && platform !== 'android') assert.equal(alert?.textContent?.includes('недоступны'), true);
    }, raw, platform, permission);
}
for (const component of ['OsNotifyPanel', 'CoinNotifyPanel']) {
  it(`B7 ${component}: выбор сохранён; unsupported Android без подсказки, denied и web/desktop с ней`, () => panel(component));
  it(`B7 ${component}: возврат ложной подсказки на Android обнаруживается`, async () => {
    const fn = component === 'OsNotifyPanel' ? 'async function pick(next: OsNotifyLevel)' : 'async function pick(next: CoinNotifyLevel)';
    const start = sources.UserSettingsModal.indexOf(fn); assert.ok(start >= 0);
    const before = sources.UserSettingsModal.slice(0, start), tail = sources.UserSettingsModal.slice(start);
    const anchor = ': isAndroid()\n              ? null';
    assert.ok(tail.includes(anchor));
    const changed = before + tail.replace(anchor, ': false\n              ? null');
    await panel(component); await assert.rejects(() => panel(component, changed), assert.AssertionError);
  });
}

const attachment = { id: 'a', name: 'photo.jpg', contentType: 'image/jpeg', size: 1024, width: 720, height: 400, url: '/photo.jpg' };
async function broken(fill: boolean, raw = sources.AttachmentView) {
  await fixture('AttachmentView', 'AttachmentView', { a: attachment, fill }, async ({ host, render }) => {
    const img = host.querySelector<HTMLImageElement>('img.att-img')!;
    assert.ok(!!img); assert.equal(!!host.querySelector('[data-download]'), true);
    const width = img.style.width, ratio = img.style.aspectRatio.replace(/^auto\s*/, '');
    await React.act(async () => { img.dispatchEvent(new window.Event('error')); });
    const tile = host.querySelector<HTMLElement>('.att-broken')!; assert.ok(!!tile, 'ошибка заменяет картинку плиткой');
    assert.equal(tile.style.width, width); assert.equal(tile.style.aspectRatio, ratio);
    assert.equal(tile.getAttribute('aria-label'), attachment.name);
    assert.equal(tile.querySelector('[data-icon]')?.getAttribute('data-icon'), 'photo');
    assert.equal(!!host.querySelector('.att-img-wrap, [data-download], img'), false);
    await render({ a: { ...attachment, url: '/fresh.jpg' } });
    assert.equal(host.querySelector('img')?.getAttribute('src'), '/fresh.jpg');
    assert.equal(!!host.querySelector('[data-download]'), true);
  }, raw);
}
for (const fill of [false, true]) it(`B12 ошибка фото сохраняет размер ${fill ? 'альбома' : 'ленты'} без скачивания; новая ссылка восстанавливает фото`, () => broken(fill));
it('B12 потеря обработчика ошибки обнаруживается', () => mutant('AttachmentView', raw => broken(false, raw),
  'onError={() => setBrokenUrl(a.url)}', 'onError={() => {}}'));
it('B12 отключение ветки битой картинки обнаруживается', () => mutant('AttachmentView', raw => broken(false, raw),
  'if (brokenUrl === a.url) {', 'if (false) {'));

async function idle(occupied: boolean, raw = sources.VoiceChannelView) {
  await fixture('VoiceChannelView', 'VoiceChannelView', { channel: { id: 'channel', name: 'Гусиная', type: 'voice' }, connected: false }, async ({ host, joined }) => {
    assert.equal(host.querySelector('.voice-header')?.textContent, 'Гусиная');
    assert.equal(!!host.querySelector('.voice-header [data-channel]'), true);
    assert.equal(!!host.querySelector('.voice-idle-body .empty-goose'), true);
    assert.equal(host.querySelector('[data-goose]')?.getAttribute('data-goose'), occupied ? 'honk' : 'nap');
    assert.equal(host.querySelector('.eg-title')?.textContent?.includes(occupied ? 'уже есть люди' : 'пока никого'), true);
    await React.act(async () => host.querySelector<HTMLButtonElement>('.join-voice')!.click());
    assert.equal(joined.join(','), 'channel');
  }, raw, 'web', 'unsupported', occupied);
}
for (const occupied of [false, true]) it(`B11 неподключённый ${occupied ? 'занятый' : 'пустой'} канал показывает имя, idle body и позволяет войти`, () => idle(occupied));
it('B11 потеря шапки именно неподключённого канала обнаруживается', () => mutant('VoiceChannelView', raw => idle(false, raw),
  '<div className="voice-view">\n      <div className="voice-header">', '<div className="voice-view">\n      <div className="removed-header">'));
it('B11 потеря idle body обнаруживается', () => mutant('VoiceChannelView', raw => idle(false, raw),
  '<div className="voice-idle-body">', '<div className="removed-idle-body">'));
