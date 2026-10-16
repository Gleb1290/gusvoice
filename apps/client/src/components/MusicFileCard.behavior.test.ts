import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as shared from '@gusvoice/shared';
import * as playback from '../voicePlayback';
import * as imageSize from '../imageSize';
import * as autoRules from '../autoDownloadRules';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const musicSource = read('./VoiceMessage.tsx');
const attachmentSource = read('./AttachmentView.tsx');
const fileSource = read('../fileActions.ts');
const attachment: shared.Attachment = { id: 'audio-1', url: '/track.wav', name: 'Ночной гусь.wav', contentType: 'audio/wav',
  size: 1000, width: 0, height: 0, durationMs: 100_000 };
const meta = { conversationId: 'conv', messageId: 'msg', mine: false, listened: false, once: true,
  author: 'Автор', createdAt: '2026-10-15T00:00:00Z' };
type Bubble = { current: boolean; playing: boolean; at: number; heard: boolean };

function whole<T>(raw: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, require: (id: string) => {
      assert.equal(Object.hasOwn(deps, id), true, `R230 явная граница импорта ${id}`); return deps[id];
    },
  });
  return module.exports as T;
}

async function scene(check: (f: { host: HTMLDivElement; render(v: Partial<Bubble>): Promise<void>;
  toggles: import('../voicePlayer').VoiceTrack[]; seeks: [string, number][]; pointer(select: boolean): Promise<void> }) => Promise<void>,
  raw = musicSource) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const toggles: import('../voicePlayer').VoiceTrack[] = []; const seeks: [string, number][] = [];
  let bubble: Bubble = { current: false, playing: false, at: 0, heard: false };
  try {
    // fileActions исполняется целиком: вычисление ключа/размера настоящее, натив и сеть закрыты на границе.
    const files = whole<typeof import('../fileActions')>(fileSource, { './api': { api: {} }, './nativeMedia': {}, './toast': {} });
    const component = whole<typeof import('./VoiceMessage')>(raw, {
      react: React, 'react/jsx-runtime': jsx, '@gusvoice/shared': shared, '../fileActions': files,
      '../store': { useStore: { getState: () => ({ view: 'dm', currentServerId: null }) } },
      '../voicePlayback': playback, '../phoneLayout': { usePhoneLayout: () => false },
      './VoiceSpeedButton': {}, '../voiceTrim': {}, './Icon': { Icon: () => null },
      '../voicePlayer': { useVoiceBubble: () => bubble, toggleVoice: (track: import('../voicePlayer').VoiceTrack) => toggles.push(track),
        seekVoice: (key: string, sec: number) => seeks.push([key, sec]), releaseLocalVoice: () => {} },
    }).MusicFileCard;
    const render = async (v: Partial<Bubble> = {}) => {
      bubble = { ...bubble, ...v };
      await React.act(async () => root.render(React.createElement(component, { a: attachment, sizeLabel: 'размер', meta,
        badge: React.createElement('button', { 'data-download-badge': true }, 'Скачать') })));
    };
    const pointer = async (select: boolean) => {
      host.className = select ? 'messages sel-mode' : 'messages';
      const slider = host.querySelector<HTMLElement>('[role="slider"]'); assert.ok(slider);
      slider.getBoundingClientRect = () => ({ left: 10, width: 200 }) as DOMRect;
      await React.act(async () => slider.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 60, pointerId: 1 })));
      await React.act(async () => slider.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, pointerId: 1 })));
    };
    await render(); await check({ host, render, toggles, seeks, pointer });
  } finally {
    await React.act(async () => root.unmount()); host.remove(); await GlobalRegistrator.unregister();
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}

async function trackContract(raw = musicSource) {
  await scene(async ({ host, toggles }) => {
    await React.act(async () => host.querySelector<HTMLButtonElement>('.att-audio-play')!.click());
    assert.equal(toggles.length, 1, 'R230 запуск: один вызов плеера');
    const t = toggles[0];
    assert.equal(t.title, 'Ночной гусь', 'R230 название: плеер получает название файла');
    assert.equal(t.url, attachment.url); assert.equal(t.durationMs, 100_000);
    assert.equal(t.key, playback.voiceTrackKey('msg', 'audio-1', '/track.wav'));
    assert.deepEqual({ ...t.source }, { ...meta, listened: undefined, once: undefined }, 'R230 источник: переход к сообщению без голосовых флагов');
    assert.deepEqual({ ...t.place }, { view: 'dm', serverId: null });
    assert.equal(!!host.querySelector('[data-download-badge]'), true, 'R230 скачивание: переданный значок остался');
  }, raw);
}

async function seekContract(raw = musicSource) {
  await scene(async ({ host, render, seeks, pointer }) => {
    const slider = host.querySelector<HTMLElement>('[role="slider"]'); assert.ok(slider);
    assert.equal(slider.classList.contains('hidden'), true, 'R230 до старта: полоса скрыта');
    assert.equal(slider.getAttribute('aria-hidden'), 'true');
    await pointer(false); assert.equal(seeks.length, 0, 'R230 до старта: перемотка не работает');
    await render({ current: true, playing: true, at: 12_000 });
    assert.equal(slider.classList.contains('hidden'), false); assert.equal(slider.hasAttribute('aria-hidden'), false);
    assert.equal(host.querySelector('.att-audio-sub')?.textContent, '0:12 / 1:40');
    await pointer(true); assert.equal(seeks.length, 0, 'R230 выбор: перемотка не перехватывает выбор сообщения');
    await pointer(false); assert.equal(seeks.length, 1); assert.equal(seeks[0][1], 25);
    await render({ current: true, playing: false, at: 12_000 });
    assert.equal(slider.classList.contains('hidden'), false, 'пауза не прячет полосу посреди дорожки');
    assert.equal(host.querySelector('.att-audio-play')?.getAttribute('title'), 'Слушать');
  }, raw);
}

async function attachments(raw = attachmentSource) {
  GlobalRegistrator.register({ url: 'http://localhost/', settings: { enableImageFileLoading: false } });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const checked: string[] = [];
  try {
    const files = whole<typeof import('../fileActions')>(fileSource, { './api': { api: {} }, './nativeMedia': {}, './toast': {} });
    const leaf = (kind: string) => () => React.createElement('div', { 'data-card': kind });
    const component = whole<typeof import('./AttachmentView')>(raw, {
      react: React, 'react/jsx-runtime': jsx, '@gusvoice/shared': { ...shared,
        isMusicFile: (a: shared.Attachment) => { checked.push(a.contentType); return shared.isMusicFile(a); } },
      '../imageSize': imageSize, '../autoDownloadRules': autoRules, '../fileActions': files,
      '../api': { api: { attachmentDownloadUrl: () => '/download' } },
      '../autoDownload': { useAutoLoad: () => ({ load: true, autoplay: false, kind: 'file' }),
        useAutoDownload: () => autoRules.AUTO_DOWNLOAD_DEFAULTS, saveDataOn: () => false, loadedByHandHas: () => false },
      './FileCard': { FileCard: leaf('file'), DownloadBadge: leaf('download') },
      './VoiceMessage': { MusicFileCard: leaf('music'), VoiceMessage: leaf('voice') },
      './RoundVideo': { RoundVideo: leaf('round') }, './VideoAttachment': { VideoAttachment: leaf('video') },
      './Icon': { Icon: () => null }, './SpoilerCover': { useSpoilerHidden: () => false, SpoilerCover: () => null },
    }).AttachmentView;
    for (const [contentType, name, expected] of [
      ['audio/wav', 'Запись.wav', 'music'], ['application/pdf', 'Документ.pdf', 'file'], ['audio/amr', 'Запись.amr', 'file'],
      ['audio/webm', 'Голос.webm', 'voice'], ['video/mp4', 'Кружок.mp4', 'round'], ['image/png', 'Обложка.mp3', 'image'],
    ]) {
      checked.length = 0;
      const a = { ...attachment, contentType, name,
        ...(expected === 'voice' ? { waveform: [1, 2] } : {}), ...(expected === 'round' ? { round: true as const } : {}) };
      await React.act(async () => root.render(React.createElement(component, { a, voice: meta })));
      assert.equal(expected === 'image' ? !!host.querySelector('img.att-img') : host.querySelector('[data-card]')?.getAttribute('data-card'),
        expected === 'image' ? true : expected, 'R230 вложения: подходящая карточка');
      if (expected === 'image') assert.equal(checked.length, 0, 'R230 изображение: музыка не опережает ветку картинки');
    }
  } finally {
    await React.act(async () => root.unmount()); host.remove(); await GlobalRegistrator.unregister();
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}

function replace(raw: string, anchor: string, replacement: string): string {
  assert.equal(raw.split(anchor).length - 1, 1, 'R230 единственный якорь мутанта'); return raw.replace(anchor, replacement);
}
const failure = (prefix: string, actual: unknown, expected: unknown) => (e: unknown) =>
  e instanceof assert.AssertionError && e.message.startsWith(prefix) && e.operator === 'strictEqual'
    && e.actual === actual && e.expected === expected;

it('R230 музыкальная карточка передаёт название и источник без прослушано и одноразовости', () => {
  // Класс ошибки: музыка становится одноразовым голосовым или теряет переход к исходному сообщению.
  return trackContract();
});
it('R230 музыкальная полоса ждёт старта, защищает выбор сообщения и сохраняется при паузе', () => {
  // Класс ошибки: невидимый ползунок или режим выбора случайно меняет позицию трека.
  return seekContract();
});
it('R230 тип вложения выбирает музыку, файл, голосовое, кружок или картинку настоящим правилом', () => {
  // Класс ошибки: общий аудиоплеер забирает неподдерживаемый формат либо уже специализированное медиа.
  return attachments();
});
it('R230 контрфакт потери названия обнаруживается на запуске настоящей музыкальной карточки', async () => {
  // Класс ошибки: системный плеер показывает голосовое вместо названия музыки.
  await trackContract();
  await assert.rejects(() => trackContract(replace(musicSource, '    title,\n  };', '    title: undefined,\n  };')),
    failure('R230 название:', undefined, 'Ночной гусь'));
});
it('R230 контрфакт невидимой перемотки до старта обнаруживается действием указателя', async () => {
  // Класс ошибки: скрытая полоса сдвигает ещё не запущенную дорожку.
  await seekContract();
  await assert.rejects(() => seekContract(replace(musicSource, '              if (!started) return;', '')),
    failure('R230 до старта:', 1, 0));
});
it('R230 контрфакт перемотки в режиме выбора обнаруживается без изменения голосового обработчика', async () => {
  // Класс ошибки: одинаковое имя обработчика у двух компонентов маскирует проверку не той ветки.
  await seekContract();
  await assert.rejects(() => seekContract(replace(musicSource, '              if (inSelectMode(e.currentTarget)) return;', '')),
    failure('R230 выбор:', 1, 0));
});
it('R230 контрфакт проверки музыки перед картинкой обнаруживается порядком настоящих правил', async () => {
  // Класс ошибки: новая широкая классификация выполняется раньше давно определённого визуального типа.
  await attachments();
  const branch = '  if (isMusicFile(a))\n    return <MusicFileCard a={a} sizeLabel={kb(a.size)} meta={voice} badge={<DownloadBadge a={a} href={dl} cls="att-file-dl att-audio-dl" />} />;';
  const without = replace(attachmentSource, branch, '');
  await assert.rejects(() => attachments(replace(without, '  if (isImage(a.contentType)) {', `${branch}\n  if (isImage(a.contentType)) {`)),
    failure('R230 изображение:', 1, 0));
});
