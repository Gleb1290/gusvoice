import assert from 'node:assert/strict';
import { before, after, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import { act } from 'react';
import * as jsx from 'react/jsx-runtime';
import { createPortal } from 'react-dom';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { DmChannel } from '@gusvoice/shared';
import type { ForwardPickerProps } from './ForwardPicker';
import * as sync from '../convSyncRules';
import * as rowRules from '../dmRowRules';

const raw = readFileSync(new URL('./ForwardPicker.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let createRoot: typeof import('react-dom/client')['createRoot'];
before(async () => { GlobalRegistrator.register(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); createRoot = (await import('react-dom/client')).createRoot; });
after(() => GlobalRegistrator.unregister());
function mutate(anchor: string, replacement: string) {
  assert.equal(raw.split(anchor).length - 1, 1, 'единственный якорь целого модуля'); return raw.replace(anchor, replacement);
}
const dm = (id: string, remote = false) => ({ id, createdAt: '2026-10-12T00:00:00Z', lastMessageAt: null,
  otherUser: { id: `peer-${id}`, username: id, displayName: id === 'remote' ? 'Удалённая Утка' : `Беседа ${id}`, avatarUrl: null,
    ...(remote ? { homeInstance: { instanceId: 'peer-instance', name: 'Соседний дом', domain: 'peer.invalid' } } : {}) } }) as DmChannel;
async function scene(phone: boolean, files: boolean, selection: 'remote' | 'local' | 'none', check: 'warn' | 'quiet' | 'broken', source = raw, fedm3 = false, fedNoFiles = false) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: phone ? 620 : 1280 });
  const state = { dms: [dm('remote', true), dm('local'), dm('broken', true)], currentDmId: null,
    convActive: true, serverFeatures: fedm3 ? ['fedm3'] : [], user: { id: 'me' }, unreadDms: [],
    conv: { ...sync.emptyConvState(), summaries: { broken: { fedLink: 'broken' }, remote: { fedNoFiles } } }, drafts: {}, outbox: {}, convOpenSaved: async () => {} };
  const row = (p: { dm: DmChannel; picked: boolean; selecting: boolean; onOpen: (id: string) => void; onPick: (id: string) => void }) =>
    React.createElement('button', { 'data-target': p.dm.id, 'aria-checked': p.picked,
      onClick: () => (p.selecting ? p.onPick : p.onOpen)(p.dm.id) }, p.dm.otherUser.displayName);
  const cell = (p: { id: string; label: string; picked: boolean; selecting: boolean; onOpen: (id: string) => void; onPick: (id: string) => void }) =>
    React.createElement('button', { 'data-target': p.id, 'aria-checked': p.picked,
      onClick: () => (p.selecting ? p.onPick : p.onOpen)(p.id) }, p.label);
  const unused = () => { throw new Error('неисполняемая граница меню/отложенного'); };
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, 'react-dom': { createPortal },
    '../store': { useStore: (select: (s: typeof state) => unknown) => select(state) },
    '../convSyncRules': sync, '../dmRowRules': rowRules, '../phoneLayout': { usePhoneLayout: () => phone },
    '../peerName': { usePeerName: () => (id: string) => id, dmPeerLabel: (d: DmChannel) => d.otherUser.displayName },
    '../dmOnline': { useVisibleOnline: () => new Set<string>() }, '../dialogChrome': { useDialogChrome: () => React.useRef(null) },
    './BottomSheet': { BottomSheet: (p: { children: React.ReactNode }) => React.createElement('section', { className: 'fixture-sheet' }, p.children) },
    './DmSidebar': { DmRow: row, ForwardCell: cell, ForwardAva: () => null }, './Icon': { Icon: () => null },
    './SchedPick': { SchedPick: unused }, './ContextMenu': { ContextMenu: unused, MenuItem: unused }, './ShareChannelRow': { ShareChannelRow: unused },
  };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { module, exports: module.exports, window, document, navigator,
        require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `явный импорт ${id}`); return deps[id]; } });
    const Component = (module.exports as { ForwardPicker: React.ComponentType<ForwardPickerProps> }).ForwardPicker;
    await act(async () => root.render(React.createElement(Component, { count: 1, hasFiles: files,
      initial: selection === 'none' ? [] : [selection], onSend: unused, onClose: () => {} })));
    assert.equal(document.querySelectorAll('[data-target="remote"]').length, 1, 'активный сосед доступен');
    assert.equal(document.querySelectorAll('[data-target="local"]').length, 1, 'локальная беседа доступна');
    if (check === 'broken') {
      assert.equal(document.querySelectorAll('[data-target="broken"]').length, 0, 'архив разорванной связки исключён'); return;
    }
    if (check === 'quiet') { assert.equal(document.querySelectorAll('.fwd-warn').length, 0, 'без файлов или удалённого выбора предупреждения нет'); return; }
    const warning = document.querySelector('.fwd-warn');
    assert.equal(!!warning, true, 'файлы для выбранного удалённого адресата предупреждают');
    assert.equal(warning?.textContent?.includes('Удалённая Утка'), true, 'предупреждение называет выбранного человека');
    assert.equal(warning?.getAttribute('role'), 'note');
    const target = document.querySelector<HTMLButtonElement>('[data-target="remote"]'); assert.equal(!!target, true);
    await act(async () => target!.click());
    assert.equal(document.querySelectorAll('.fwd-warn').length, 0, 'снятие удалённого выбора убирает предупреждение');
  } finally { await act(async () => root.unmount()); host.remove(); }
}
for (const phone of [false, true]) {
  it(`R192 ${phone ? 'телефон' : 'ПК'} предупреждает о файлах выбранному человеку соседа по имени`, async () => {
    // Класс ошибки: файлы обещаны недоступному адресату без предупреждения.
    await scene(phone, true, 'remote', 'warn');
  });
  it(`R192 ${phone ? 'телефон' : 'ПК'} исключает архив связки, сохраняя локальную и активную удалённую беседы`, async () => {
    // Класс ошибки: пересылка предлагает архив только для чтения.
    await scene(phone, true, 'local', 'broken');
  });
}
for (const [files, selection, name] of [[false, 'remote', 'текст удалённому'], [true, 'local', 'файлы локальному'], [true, 'none', 'файлы без выбора']] as const) {
  it(`R192 ${name} не показывают предупреждение инстанса ни на телефоне, ни на ПК`, async () => {
    // Класс ошибки: предупреждение появляется без выбранной неподдерживаемой пересылки.
    for (const phone of [false, true]) await scene(phone, files, selection, 'quiet');
  });
}
it('R192 контрфакт снятого hasFiles ловится предупреждением при пересылке одного текста', async () => {
  // Класс ошибки: предупреждение файлов применяется к тексту.
  await scene(false, false, 'remote', 'quiet');
  await assert.rejects(scene(false, false, 'remote', 'quiet', mutate('() => (hasFiles ? dms.filter', '() => (true ? dms.filter')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('без файлов или удалённого выбора предупреждения нет'));
});
it('R192 контрфакт снятого broken-фильтра ловится появлением архивной цели в DOM', async () => {
  // Класс ошибки: разорванная связка допускается как цель пересылки.
  await scene(false, true, 'local', 'broken');
  await assert.rejects(scene(false, true, 'local', 'broken', mutate(" && (summaries[d.id] as { fedLink?: string } | undefined)?.fedLink !== 'broken'", '')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('архив разорванной связки исключён'));
});
for (const [fedm3, fedNoFiles, selection, warning] of [[true, false, 'remote', false], [true, true, 'remote', true], [false, false, 'remote', true], [true, true, 'local', false]] as const) {
  it(`R194 пересылка файлов: fedm3=${fedm3}, отказ соседа=${fedNoFiles}, выбран ${selection}`, async () => {
    // Класс ошибки: предупреждение зависит только от дома, а не двусторонней поддержки файлов.
    for (const phone of [false, true]) await scene(phone, true, selection, warning ? 'warn' : 'quiet', raw, fedm3, fedNoFiles);
  });
}
for (const [name, anchor, replacement, fedm3, fedNoFiles] of [
  ['нет проверки своего fedm3', '!fedFiles || !!summaries[d.id]?.fedNoFiles', '!!summaries[d.id]?.fedNoFiles', false, false],
  ['нет проверки fedNoFiles соседа', '!fedFiles || !!summaries[d.id]?.fedNoFiles', '!fedFiles', true, true],
] as const) {
  it(`R194 контрфакт пересылки «${name}» ловится настоящим предупреждением`, async () => {
    // Класс ошибки: несовместимый адресат допускает файлы без предупреждения.
    await scene(false, true, 'remote', 'warn', raw, fedm3, fedNoFiles);
    await assert.rejects(scene(false, true, 'remote', 'warn', mutate(anchor, replacement), fedm3, fedNoFiles),
      (e: unknown) => e instanceof assert.AssertionError && e.message.includes('файлы для выбранного удалённого адресата предупреждают'));
  });
}
