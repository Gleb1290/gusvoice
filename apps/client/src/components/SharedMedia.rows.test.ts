import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as shared from '@gusvoice/shared';
import * as rules from '../sharedMediaRules';

const source = readFileSync(new URL('./SharedMedia.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const file: shared.Attachment = { id: 'file', name: 'отчёт.pdf', contentType: 'application/pdf', size: 123, url: '/file' };
const voice: shared.Attachment = { ...file, id: 'voice', name: 'voice.webm', contentType: 'audio/webm', waveform: [10, 20], durationMs: 1234 };
const msg = (att: shared.Attachment): shared.ConvMessage => ({ id: 'msg', conversationId: 'conv', channelId: 'conv', sortKey: 1, clientId: null,
  content: '', createdAt: '2026-10-12T10:00:00Z', editedAt: null, attachments: [att], replyTo: null, reactions: [],
  author: { id: 'peer', username: 'dmtest_peer', displayName: 'Автор', avatarUrl: null } });
const item = (att: shared.Attachment): rules.SharedItem => ({ key: 'msg:' + att.id, msg: msg(att), att });
const link: rules.SharedItem = { key: 'link', msg: { ...msg(file), content: 'https://example.invalid/a https://example.invalid/b', attachments: [] },
  url: 'https://example.invalid/a', urls: ['https://example.invalid/a', 'https://example.invalid/b'] };
function load(raw = source): typeof import('./SharedMedia') {
  const fail = () => { throw new Error('неожиданная внешняя операция строк медиа'); };
  const unused = new Proxy({}, { get: () => fail });
  const nil = () => null;
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, '@gusvoice/shared': shared, '../sharedMediaRules': rules,
    '../api': unused, '../convSyncRules': unused, '../dialogChrome': unused, '../feedJump': unused,
    '../fileActions': { openAttachmentFile: fail, sizeText: (size: number) => `${size} Б` },
    '../mediaViewerRules': { viewerDate: () => '12 октября' }, '../phoneLayout': unused,
    '../peerName': { usePeerName: () => (_id: string, name: string) => name },
    '../store': { useStore: (pick: (s: { user: { id: string } }) => unknown) => pick({ user: { id: 'self' } }) },
    '../toast': unused, './BottomSheet': { BottomSheet: nil }, './Icon': { Icon: nil }, './Lightbox': { Lightbox: nil },
    './SpoilerCover': { SpoilerParticles: nil, useSpoilerHidden: () => false }, './VideoAttachment': { BLANK_POSTER: '', videoFrameSrc: fail },
    './RoundVideo': { RoundVideo: fail }, './VoiceMessage': { VoiceMessage: ({ a, meta }: { a: shared.Attachment; meta: { author: string; messageId: string; mine: boolean } }) =>
      React.createElement('i', { 'data-voice': a.id, 'data-author': meta.author, 'data-message': meta.messageId, 'data-mine': String(meta.mine) }) },
  };
  const module = { exports: {} };
  // SSR настоящих строк: layout/браузер не нужны, эффекты/API профиля вообще не вызываются.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, require: (id: string) => {
      assert.equal(Object.hasOwn(deps, id), true, `явная граница SharedMedia ${id}`); return deps[id];
    } });
  return module.exports as typeof import('./SharedMedia');
}
function render(which: 'FileRow' | 'LinkRow' | 'VoiceRow', it: rules.SharedItem, from?: string, raw = source) {
  return renderToStaticMarkup(React.createElement(load(raw)[which], { it, convId: 'conv', ...(from === undefined ? {} : { source: from }) }));
}
function fileWithoutSource(raw = source) {
  const html = render('FileRow', item(file), undefined, raw);
  assert.equal(html.includes('123 Б · 12 октября'), true, 'старый файл: размер и дата без чужого source');
  assert.equal(html.includes('undefined'), false); assert.equal(html.includes('null'), false);
}
it('R183 файл без source и с пустым source оставляет размер и дату, без лишнего разделителя', () => {
  // Класс ошибки: новый необязательный prop ломает старые вызовы профиля.
  fileWithoutSource(); assert.equal(render('FileRow', item(file), ''), render('FileRow', item(file)));
});
it('R183 файл с источником добавляет имя беседы между размером и датой и безопасно выводит текст', () => {
  // Парное принимается: поддержанный source виден, но не становится разметкой.
  const html = render('FileRow', item(file), '<Беседа>');
  assert.equal(html.includes('123 Б · &lt;Беседа&gt; · 12 октября'), true);
  assert.equal(html.includes('отчёт.pdf'), true); assert.equal(html.includes('aria-label="Показать в чате"'), true);
});
function linkWithoutSource(raw = source) {
  const html = render('LinkRow', link, undefined, raw);
  assert.equal(html.includes('12 октября'), false, 'старая ссылка не получает новую строку source и даты');
  for (const url of link.urls!) assert.equal(html.includes(`href="${url}"`), true);
}
it('R183 ссылки без source сохраняют домен и оба адреса, пустой source не добавляет новый подзаголовок', () => {
  // Класс ошибки: новая подпись вытесняет второй URL или рисует пустую строку в старом профиле.
  linkWithoutSource(); assert.equal(render('LinkRow', link, ''), render('LinkRow', link));
});
it('R183 ссылки с source добавляют отдельные имя и дату, не подменяя сами адреса', () => {
  // Парное принимается: источник дополняет список ссылок, а не замещает его.
  const html = render('LinkRow', link, 'Беседа');
  assert.equal(html.includes('Беседа · 12 октября'), true);
  for (const url of link.urls!) assert.equal(html.includes(`href="${url}"`), true);
});
function voiceWithoutSource(raw = source) {
  const html = render('VoiceRow', item(voice), undefined, raw);
  assert.equal(html.includes('class="smedia-item-sub">12 октября</span>'), true, 'старое голосовое оставляет дату');
  assert.equal(html.includes('data-voice="voice"'), true); assert.equal(html.includes('data-author="Автор"'), true);
  assert.equal(html.includes('data-message="msg"'), true); assert.equal(html.includes('data-mine="false"'), true);
}
it('R183 голосовое без source сохраняет автора, дату и контракт настоящего плеера', () => {
  // Класс ошибки: подпись общего поиска теряет автора либо меняет metadata прослушивания.
  voiceWithoutSource(); assert.equal(render('VoiceRow', item(voice), ''), render('VoiceRow', item(voice)));
});
it('R183 голосовое добавляет отличный источник, но не повторяет совпадающий с автором', () => {
  // Парное принимается: группа указана, автор один на один не дублируется перед датой.
  assert.equal(render('VoiceRow', item(voice), 'Группа').includes('Группа · 12 октября'), true);
  assert.equal(render('VoiceRow', item(voice), 'Автор'), render('VoiceRow', item(voice)));
});
it('R183 контрфакты обязательного source обнаруживаются старыми вызовами всех трёх строк', () => {
  // Целый SharedMedia, original-first и адресный AssertionError: новый prop остаётся действительно необязательным.
  for (const [anchor, replacement, check, target] of [
    ["{source ? `${source} · ` : ''}", '{`${source} · `}', fileWithoutSource, 'старый файл'],
    ['{source && (', '{true && (', linkWithoutSource, 'старая ссылка'],
    ['{source && source !== author ? `${source} · ${viewerDate(m.createdAt)}` : viewerDate(m.createdAt)}',
      '{`${source} · ${viewerDate(m.createdAt)}`}', voiceWithoutSource, 'старое голосовое'],
  ] as const) {
    check(); assert.equal(source.split(anchor).length - 1, 1, 'уникальный якорь строки');
    assert.throws(() => check(source.replace(anchor, replacement)), e => e instanceof assert.AssertionError && e.message.includes(target));
  }
});
