import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { DM_ROW_AVA } from '../dmListView';
import * as rowRules from '../dmRowRules';
import * as archiveRules from '../dmArchiveRules';
import * as cornerRules from '../cornerButtonsRules';

const sources = {
  sidebar: readFileSync(new URL('./DmSidebar.tsx', import.meta.url), 'utf8'),
  archive: readFileSync(new URL('./DmArchive.tsx', import.meta.url), 'utf8'),
};
type Kind = keyof typeof sources;
const noop = () => {};
const peer = { id: 'peer', username: 'peer', displayName: 'Собеседник', avatarUrl: null };
const dm = { id: 'dm', createdAt: '2026-10-10T00:00:00Z', lastMessageAt: null, otherUser: peer };

// Исполняем целые исходные модули; настоящий React SSR вызывает DmRow / DmArchiveRow.
// Внешние подсистемы изолированы: это контракт размера пропса/inline style, не проверка CSS или геометрии браузера.
function load(kind: Kind, raw: string) {
  const avatar = (p: { size: number }) => React.createElement('span', { 'data-avatar-size': p.size });
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    '../dmListView': { DM_ROW_AVA },
    '../dmListRules': { DM_ROW_HOLD_MS: 450 },
    '../dmRowRules': rowRules, '../dmArchiveRules': archiveRules, '../cornerButtonsRules': cornerRules,
    '../convSyncRules': { peerReadKeyOf: (summary?: { peerReadKey?: number }) => summary?.peerReadKey ?? 0 },
    '../typing': { useTyping: () => [], useTypingAction: () => null, typingActionLabel: () => '' },
    '../peerName': { usePeerName: () => (_id: string, name: string) => name, dmPeerLabel: () => peer.displayName },
    '../uiPrefs': { useSidebarNarrow: () => false },
    './Avatar': { Avatar: avatar }, './SavedAvatar': { SavedAvatar: avatar }, './Icon': { Icon: () => null },
  };
  const tree = ts.createSourceFile(`${kind}.tsx`, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = new Set(tree.statements.filter(ts.isImportDeclaration).map(n => (n.moduleSpecifier as ts.StringLiteral).text));
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { module, exports: module.exports, Date, Set,
    require: (id: string) => {
      assert.ok(imports.has(id) || id === 'react/jsx-runtime', id);
      // Неисполняемые здесь Sidebar/меню могут импортироваться, но новое обращение к их границе не должно молча пройти.
      return deps[id] ?? new Proxy({}, { get: (_target, key) => {
        throw new Error(`Неописанная SSR-граница: ${id}.${String(key)}`);
      } });
    },
  });
  return module.exports as { DmRow: React.ComponentType<any>; DmArchiveRow: React.ComponentType<any> };
}

// R159 B3: проверяем не только чистое правило, а проводку summary → настоящий DmRow → видимые подпись/отметки.
function callRow(authorId: string, call: boolean, read: boolean, raw = sources.sidebar): string {
  const components = load('sidebar', raw);
  const lastMessage = { id: 'last', authorId, text: 'Обычный текст', attachments: 0, sortKey: 10,
    ...(call ? { call: { reason: 'missed', duration: 0 } } : {}) };
  return renderToStaticMarkup(React.createElement(components.DmRow, {
    dm, summary: { lastMessage, peerReadKey: read ? 10 : 0 }, meId: 'me',
    online: false, active: false, unread: false, unreadN: 0, failed: false, query: '', phone: true, onOpen: noop,
  }));
}

function checkCallRows(raw = sources.sidebar) {
  for (const [author, expected] of [['me', 'Отменённый звонок'], ['peer', 'Пропущенный звонок']]) {
    for (const read of [false, true]) {
      const markup = callRow(author, true, read, raw);
      assert.equal(markup.includes(expected), true, 'направление звонка приходит из meId в DmRow');
      assert.equal(/class="dm-st (?:sent|read)"/.test(markup), false, 'звонок не получает отметку доставки сообщения');
    }
  }
}
it('R159 B3 строка различает отменённый и пропущенный звонок без sent/read', () => checkCallRows());
it('R159 B3 обычное исходящее сообщение сохраняет sent/read, входящее без отметок', () => {
  for (const read of [false, true]) {
    const outgoing = callRow('me', false, read);
    assert.equal(outgoing.includes('Обычный текст'), true);
    assert.equal(outgoing.includes(`class="dm-st ${read ? 'read' : 'sent'}"`), true);
    assert.equal(/class="dm-st (?:sent|read)"/.test(callRow('peer', false, read)), false);
  }
});
it('R159 B3 потеря meId в вызове превью обнаруживается реальной строкой', () => {
  checkCallRows();
  const raw = replaceOne(sources.sidebar,
    'dmRowPreview({ typing, draft: draftShown ? draft : null, last, meId })',
    'dmRowPreview({ typing, draft: draftShown ? draft : null, last })');
  assert.throws(() => checkCallRows(raw), assert.AssertionError);
});
it('R159 B3 возврат sent/read у звонка обнаруживается реальной строкой', () => {
  checkCallRows();
  const raw = replaceOne(sources.sidebar, 'last?.service || last?.call || dm.saved', 'last?.service || dm.saved');
  assert.throws(() => checkCallRows(raw), assert.AssertionError);
});

function size(kind: Kind, phone: boolean, raw = sources[kind], saved = false, collapsed = false): number {
  const components = load(kind, raw);
  const markup = renderToStaticMarkup(kind === 'sidebar'
    ? React.createElement(components.DmRow, { dm: { ...dm, saved }, online: false, active: false,
      unread: false, unreadN: 0, failed: false, query: '', phone, onOpen: noop })
    : React.createElement(components.DmArchiveRow, { list: [dm], unreadDms: [], unreadChats: 0,
      collapsed, phone, onCollapsed: noop, onOpen: noop }));
  const match = kind === 'sidebar' ? /data-avatar-size="(\d+)"/.exec(markup)
    : /class="dm-archive-ava" style="width:(\d+)px;height:(\d+)px"/.exec(markup);
  assert.ok(match, 'размер взят из реально отрисованного аватара, не из соседней константы');
  if (kind === 'archive') assert.equal(match[1], match[2], 'аватар архива остаётся квадратным');
  return Number(match[1]);
}

for (const saved of [false, true]) {
  it(`${saved ? 'Избранное' : 'беседа'} получает аватар 52 на телефоне и прежний 46 на ПК`, () => {
    assert.equal(size('sidebar', true, sources.sidebar, saved), 52);
    assert.equal(size('sidebar', false, sources.sidebar, saved), 46);
  });
}
it('развёрнутый архив получает аватар 52 на телефоне и 46 на ПК', () => {
  assert.equal(size('archive', true), 52);
  assert.equal(size('archive', false), 46);
});
it('свёрнутый архив сохраняет компактный аватар 28 в обеих раскладках', () => {
  for (const phone of [false, true]) assert.equal(size('archive', phone, sources.archive, false, true), 28);
});

function replaceOne(raw: string, before: string, after: string): string {
  assert.equal(raw.split(before).length - 1, 1, 'мутант меняет одно место целого модуля');
  return raw.replace(before, after);
}
for (const kind of ['sidebar', 'archive'] as const) {
  for (const old of [48, 46]) {
    it(`${kind}: возврат телефонного аватара к ${old} ловится отрисовкой`, () => {
      assert.equal(size(kind, true), 52);
      assert.equal(size(kind, false), 46);
      const raw = replaceOne(sources[kind], 'const DM_ROW_AVA_PHONE = 52;', `const DM_ROW_AVA_PHONE = ${old};`);
      assert.equal(size(kind, true, raw), old);
      assert.throws(() => assert.equal(size(kind, true, raw), 52), assert.AssertionError);
      assert.equal(size(kind, false, raw), 46, 'контрфакт не трогает ПК');
    });
  }
  it(`${kind}: потеря телефонного условия у реального аватара обнаруживается`, () => {
    assert.equal(size(kind, true), 52);
    assert.equal(size(kind, false), 46);
    const before = kind === 'sidebar'
      ? '<Avatar name={name} url={dm.otherUser.avatarUrl} size={phone ? DM_ROW_AVA_PHONE : DM_ROW_AVA} />'
      : 'const side = collapsed ? 28 : phone ? DM_ROW_AVA_PHONE : DM_ROW_AVA;';
    const after = kind === 'sidebar'
      ? '<Avatar name={name} url={dm.otherUser.avatarUrl} size={DM_ROW_AVA} />'
      : 'const side = collapsed ? 28 : DM_ROW_AVA;';
    const raw = replaceOne(sources[kind], before, after);
    assert.equal(size(kind, true, raw), 46);
    assert.throws(() => assert.equal(size(kind, true, raw), 52), assert.AssertionError);
    assert.equal(size(kind, false, raw), 46);
  });
}
