import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { Attachment } from '@gusvoice/shared';

type Action = 'save-as' | 'downloads' | 'gallery' | 'share';
const file: Attachment = { id: 'att-1', url: '/files/1', name: 'doc.pdf', contentType: 'application/pdf', size: 12 } as Attachment;
const video: Attachment = { ...file, id: 'video-1', name: 'clip.mp4', contentType: 'video/mp4' };
const voice: Attachment = { ...file, id: 'voice-1', name: 'voice.ogg', contentType: 'audio/ogg', waveform: [1] };
const image: Attachment = { ...file, id: 'image-1', contentType: 'image/png' };

function fixture() {
  const state = { bridge: true, saveImage: true, saveFile: true, share: true };
  const started: { attachment: Attachment; kind: string }[] = [];
  const scheduled: (() => void)[] = [];
  const links: { href: string; download: string; rel: string; clicked: boolean; removed: boolean }[] = [];
  const module = { exports: {} as Record<string, unknown> };
  const source = readFileSync(new URL('./fileMenu.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  runInNewContext(code, {
    module, exports: module.exports,
    require(id: string) {
      if (id === '@gusvoice/shared') return { isVoiceMessage: (a: Attachment) => a.contentType === 'audio/ogg' && Array.isArray(a.waveform) };
      if (id === './api') return { api: { attachmentDownloadUrl: (a: Attachment) => `/download/${a.id}` } };
      if (id === './fileActions') return {
        attachmentKey: (a: Attachment) => a.id || a.url,
        filesViaNative: () => state.bridge,
        startFileJob: (a: Attachment, kind: string) => started.push({ attachment: a, kind }),
      };
      if (id === './nativeMedia') return {
        canSaveImageNative: () => state.saveImage,
        canSaveFileNative: () => state.saveFile,
        canShareFileNative: () => state.share,
      };
      throw new Error(`unexpected import ${id}`);
    },
    window: { setTimeout: (fn: () => void) => { scheduled.push(fn); return 1; } },
    document: { createElement: (tag: string) => {
      assert.equal(tag, 'a', 'download should use anchor');
      const link = { href: '', download: '', rel: '', clicked: false, removed: false,
        click() { this.clicked = true; }, remove() { this.removed = true; } };
      links.push(link); return link;
    }, body: { appendChild: () => {} } },
  });
  return { api: module.exports as unknown as typeof import('./fileMenu'), state, started, scheduled, links };
}

function target(key: string): Element {
  return { closest: (selector: string) => selector === '[data-att]' ? { getAttribute: (name: string) => name === 'data-att' ? key : null } : null } as unknown as Element;
}

describe('меню вложения', () => {
  it('определяет только адресуемое вложение, а запасной выбор допустим лишь для единственного файла', () => {
    // Тап по подписи в сообщении-альбоме не должен угадать, какой из нескольких документов человек имел в виду.
    const { api } = fixture();
    assert.equal(api.fileFromTarget([file, video, image], target('video-1')), video);
    assert.equal(api.fileFromTarget([file, video, image], target('image-1')), undefined, 'изображения остаются у image menu');
    assert.equal(api.fileFromTarget([file, video], null, true), undefined, 'не угадываем одно из нескольких вложений');
    assert.equal(api.fileFromTarget([file], null, true), file, 'телефонный fallback работает для одного файла');
    assert.equal(api.fileFromTarget([{ ...file, url: '' }], target('att-1')), undefined, 'пока нет ссылки — пункта нет');
  });

  it('показывает действия по платформе, типу вложения и реальной capability натива', () => {
    // Нельзя показывать недоступные Android-действия: старый APK не умеет сохранять или отдавать файл.
    const f = fixture();
    assert.deepEqual(Array.from(f.api.fileMenuActions(file, false)), ['save-as']);
    assert.deepEqual(Array.from(f.api.fileMenuActions(video, false)), ['save-as']);
    assert.deepEqual(Array.from(f.api.fileMenuActions(voice, false)), ['save-as']);
    assert.deepEqual(Array.from(f.api.fileMenuActions(file, true)), ['downloads', 'share']);
    assert.deepEqual(Array.from(f.api.fileMenuActions(video, true)), ['gallery', 'share']);
    assert.deepEqual(Array.from(f.api.fileMenuActions(voice, true)), ['share'], 'голосовое можно поделиться, но не «сохранить»');
    f.state.bridge = false;
    assert.deepEqual(Array.from(f.api.fileMenuActions(file, true)), [], 'без нативного моста телефон не обещает действия');
    f.state.bridge = true; f.state.saveFile = false; f.state.saveImage = false; f.state.share = false;
    assert.deepEqual(Array.from(f.api.fileMenuActions(file, true)), []);
    assert.deepEqual(Array.from(f.api.fileMenuActions(video, true)), []);
  });

  it('подписывает и исполняет каждый пункт по своему каналу загрузки', () => {
    // «Скачать» в приложении должно идти через общий file job, а на ПК — через браузерную загрузку.
    const f = fixture();
    const labels: Action[] = ['save-as', 'downloads', 'gallery', 'share'];
    assert.deepEqual(labels.map(f.api.fileMenuLabel), ['Сохранить как…', 'Сохранить в загрузки', 'Сохранить в галерею', 'Поделиться']);
    f.api.runFileMenuAction(file, 'downloads'); f.api.runFileMenuAction(video, 'gallery'); f.api.runFileMenuAction(file, 'share');
    assert.deepEqual(f.started.map(x => [x.attachment.id, x.kind]), [['att-1', 'save'], ['video-1', 'gallery'], ['att-1', 'share']]);
    f.api.runFileMenuAction(file, 'save-as');
    assert.equal(f.links.length, 0, 'браузерная загрузка запускается отложенно, чтобы закрыть меню');
    f.scheduled[0]!();
    assert.deepEqual(f.links.map(x => [x.href, x.download, x.rel, x.clicked, x.removed]), [['/download/att-1', 'doc.pdf', 'noopener', true, true]]);
  });
});
