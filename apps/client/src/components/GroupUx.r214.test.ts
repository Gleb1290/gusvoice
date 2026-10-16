import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, after, it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as shared from '@gusvoice/shared';
import * as stickerRules from '../dmStickerRules';
import * as inbox from '../shareInbox';
import * as popover from '../popover';
import * as attachRules from '../attachRules';
import type { ForwardPickerProps } from './ForwardPicker';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const paneRaw = read('./MessagePane.tsx'), chatRaw = read('./DmChatView.tsx');
const catalogRaw = read('./StickerCatalogPanel.tsx'), modalRaw = read('./StickerSetModal.tsx'), shareRaw = read('./ShareIncoming.tsx');
before(() => { GlobalRegistrator.register({ url: 'http://localhost/' }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(() => GlobalRegistrator.unregister());
const unused = () => assert.fail('IO или UI вне проверяемого сценария R214');
function replaceOne(source: string, from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'контрфакт имеет единственный якорь в полном модуле');
  return source.replace(from, to);
}
const failure = (prefix: string, actual: unknown, expected: unknown) => (error: unknown) => error instanceof assert.AssertionError
  && error.message.startsWith(prefix) && error.operator === 'strictEqual' && error.actual === actual && error.expected === expected;

// У MessagePane Vite создаёт кеш за writable roots. Стражи ниже разбирают целый TSX, ничего из него не исполняя.
function ast(source: string) { return ts.createSourceFile('component.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }
function nodes<T extends ts.Node>(node: ts.Node, guard: (n: ts.Node) => n is T): T[] {
  const result: T[] = [];
  const visit = (n: ts.Node) => { if (guard(n)) result.push(n); ts.forEachChild(n, visit); };
  visit(node); return result;
}
const compact = (node: ts.Node | undefined, source: ts.SourceFile) => node?.getText(source).replace(/\s+/g, '') ?? '';
function fn(source: ts.SourceFile, name: string) {
  const matches = nodes(source, ts.isFunctionDeclaration).filter(n => n.name?.text === name);
  assert.equal(matches.length, 1, `найдена одна настоящая функция ${name}`); return matches[0];
}
const calls = (node: ts.Node, name: string, source: ts.SourceFile) => nodes(node, ts.isCallExpression).filter(n => compact(n.expression, source) === name);
function field(object: ts.Node | undefined, key: string): ts.Expression | undefined {
  if (!object || !ts.isObjectLiteralExpression(object)) return;
  const prop = object.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === key);
  return prop && ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
}
function literal(value: ts.Expression | undefined): string | boolean | undefined {
  if (value && ts.isStringLiteral(value)) return value.text;
  if (value?.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value?.kind === ts.SyntaxKind.FalseKeyword) return false;
}
const groupPinExpected = '["Закрепить сообщение?","Уведомить всех участников",true,["m.id","\'both\'","r.option"],true]';
function groupPin(source = paneRaw) {
  const sf = ast(source), body = fn(sf, 'pinInGroup');
  const spec = calls(body, 'confirmWithOption', sf)[0]?.arguments[0];
  const option = field(spec, 'option');
  const args = calls(body, 'p.pin', sf)[0]?.arguments.map(a => compact(a, sf));
  const cancellation = body.body?.statements.some(n => ts.isIfStatement(n) && compact(n.expression, sf) === '!r'
    && ts.isReturnStatement(n.thenStatement) && !n.thenStatement.expression);
  const facts = [literal(field(spec, 'title')), literal(field(option, 'label')), literal(field(option, 'checked')), args, cancellation];
  assert.equal(JSON.stringify(facts), groupPinExpected, 'G4-group: подтверждение передаёт true/false галочки третьим аргументом общего закрепа');
}
function directPin(source = paneRaw) {
  const sf = ast(source), body = fn(sf, 'pinMessage');
  const group = body.body?.statements.find(n => ts.isIfStatement(n) && compact(n.expression, sf) === 'groupChat');
  assert.equal(!!group && calls(group, 'pinInGroup', sf).length === 1 && nodes(group, ts.isReturnStatement).length === 1, true,
    'G4-route: группа уходит в отдельное окно до прежнего личного сценария');
  const spec = calls(body, 'confirmWithOption', sf)[0]?.arguments[0];
  const args = calls(body, 'p.pin', sf)[0]?.arguments.map(a => compact(a, sf));
  assert.equal(JSON.stringify([literal(field(field(spec, 'option'), 'label')), args]),
    '["Также закрепить для собеседника",["m.id","r.option?\'both\':\'me\'"]]',
    'G4-direct: 1:1 сохраняет прежнюю галочку scope и только два аргумента pin');
}
function unpinGroup(source = paneRaw) {
  const sf = ast(source), body = fn(sf, 'askUnpin');
  const branch = body.body?.statements.find(n => ts.isIfStatement(n) && compact(n.expression, sf) === 'anyBoth&&groupChat');
  const confirm = branch ? nodes(branch, ts.isCallExpression).filter(c => compact(c.expression, sf).startsWith('confirm')) : [];
  const returned = branch ? nodes(branch, ts.isReturnStatement)[0]?.expression : undefined;
  assert.equal(JSON.stringify([confirm.map(c => compact(c.expression, sf)), compact(returned, sf)]),
    '[["confirmAction"],"ok?{both:true}:null"]', 'G4-unpin: общий закреп спрашивает без галочки и отмена не открепляет');
}
function pinWire(source = chatRaw) {
  const sf = ast(source), wire = calls(sf, 'api.convPin', sf);
  assert.equal(JSON.stringify(wire.map(c => c.arguments.map(a => compact(a, sf)))),
    '[["dm.id","messageId","scope","notify"]]', 'G4-wire: DmChatView сохраняет notify до API');
}
function former(source = chatRaw) {
  const sf = ast(source);
  const branches = nodes(sf, ts.isConditionalExpression).filter(n => compact(n.condition, sf) === 'former.removed');
  assert.equal(JSON.stringify(branches.map(n => [literal(n.whenTrue), literal(n.whenFalse)])),
    '[["вас исключили из группы","вы покинули группу"],["Вас исключили из группы.","Вы покинули группу."]]',
    'G6-former: шапка и низ различают исключение и самостоятельный выход');
}
function serviceWire(source = paneRaw) {
  const sf = ast(source);
  assert.equal(JSON.stringify(calls(sf, 'groupServiceLabel', sf).map(c => c.arguments.map(a => compact(a, sf)))),
    '[["groupSvc","m.content","p.meId"]]', 'G6-wire: строка получает meId читателя для слов вас');
}
it('R214 G4 страж окна группы сохраняет notify=true и notify=false, scope всегда both', () => groupPin());
it('R214 G4 страж 1:1 сохраняет прежнее окно и scope без третьего аргумента', () => directPin());
it('R214 G4 страж открепления группы использует confirmAction и не действует при отмене', () => unpinGroup());
it('R214 G4 страж DmChatView передаёт notify без потерь', () => pinWire());
it('R214 G6 страж шапки и низа говорит об исключении, а не о добровольном выходе', () => former());
it('R214 G6 страж ленты передаёт реального читателя в groupServiceLabel', () => serviceWire());
for (const [label, source, from, to, check, prefix, actual, expected] of [
  ['галочка группы не передаётся', paneRaw, "await p.pin(m.id, 'both', r.option);", "await p.pin(m.id, 'both');", groupPin, 'G4-group:',
    '["Закрепить сообщение?","Уведомить всех участников",true,["m.id","\'both\'"],true]', groupPinExpected],
  ['группа попадает в личное окно', paneRaw, 'if (groupChat) {\n      await pinInGroup(p, m);', 'if (false) {\n      await pinInGroup(p, m);', directPin,
    'G4-route:', false, true],
  ['в общем откреплении появилась лишняя галочка', paneRaw, 'if (anyBoth && groupChat) {\n      const ok = await confirmAction(',
    'if (anyBoth && groupChat) {\n      const ok = await confirmWithOption(', unpinGroup, 'G4-unpin:',
    '[["confirmWithOption"],"ok?{both:true}:null"]', '[["confirmAction"],"ok?{both:true}:null"]'],
  ['исключение в шапке выдают за выход', chatRaw, "? 'вас исключили из группы'", "? 'вы покинули группу'", former, 'G6-former:',
    '[["вы покинули группу","вы покинули группу"],["Вас исключили из группы.","Вы покинули группу."]]',
    '[["вас исключили из группы","вы покинули группу"],["Вас исключили из группы.","Вы покинули группу."]]'],
] as const) it(`R214 UI исходный контрфакт: ${label}`, () => {
  check(source); assert.throws(() => check(replaceOne(source, from, to)), failure(prefix, actual, expected));
});

function moduleOf<T>(source: string, dependencies: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, window, document, localStorage, File, Error, IntersectionObserver,
    require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `объявленная зависимость полного модуля: ${id}`); return dependencies[id]; },
  }); return module.exports as T;
}
async function stickers(senderOn: boolean, catalogSource = catalogRaw, modalSource = modalRaw) {
  const events: unknown[] = [];
  const pack = { id: 'pack', name: 'geese', title: 'Гуси', count: 1, stickers: [{ id: 'sticker', url: '/goose.webp', format: 'webp', emoji: '🪿' }], mine: true };
  const api = { stickersCatalog: async () => ({ packs: [pack], importEnabled: false }), stickersMine: async () => ({ packs: [pack] }),
    stickerPack: async () => pack };
  const storeModule = moduleOf<typeof import('../dmStickers')>(read('../dmStickers.ts'), {
    zustand: { create }, './api': { api }, './dmStickerRules': stickerRules, './store': { useStore: { getState: () => ({ serverFeatures: [] }) } },
  });
  const st = storeModule.useDmStickers;
  const sender = (s: { id: string }) => events.push(['send', s.id, st.getState().open === null]);
  st.setState({ mine: [pack] as never, sender: senderOn ? sender : null });
  const common = { react: React, 'react/jsx-runtime': jsx };
  const icon = moduleOf<typeof import('./Icon')>(read('./Icon.tsx'), common);
  const view = moduleOf<typeof import('./StickerView')>(read('./StickerView.tsx'), { ...common, '../tgs': { unpackTgs: unused } });
  const picker = moduleOf<typeof import('./StickerPicker')>(read('./StickerPicker.tsx'), {
    ...common, 'react-dom': ReactDOM, '../dmStickerRules': stickerRules, './ContextMenu': { ContextMenu: unused, MenuItem: unused },
    './ExprTabs': { exprAutoFocus: unused }, '../popover': popover, './StickerView': view, './Icon': icon,
  });
  const deps = { ...common, '@gusvoice/shared': shared, '../api': { api }, '../dmStickerRules': stickerRules,
    '../dmStickers': storeModule, '../toast': { toastError: unused }, './Icon': icon, './StickerView': view,
    './StickerPicker': picker, '../confirm': { confirmAction: unused } };
  const catalog = moduleOf<typeof import('./StickerCatalogPanel')>(catalogSource, deps);
  const modal = moduleOf<typeof import('./StickerSetModal')>(modalSource, deps);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => { root.render(React.createElement(React.Fragment, null,
      React.createElement(catalog.StickerCatalogPanel), React.createElement(modal.StickerSetModal))); });
    const open = host.querySelector<HTMLButtonElement>('.pack-preview[title="Открыть набор"]');
    assert.ok(open, 'настоящая панель показывает мой набор');
    await React.act(async () => { open.click(); });
    assert.equal(senderOn ? st.getState().open?.send === sender : st.getState().open?.send === undefined, true,
      'B7-sender: панель передаёт настоящий sender или отсутствие отправки');
    const cell = host.querySelector<HTMLButtonElement>('.sticker-set-modal .sticker-cell');
    assert.ok(cell, 'настоящее окно и настоящая StickerCell показывают стикер');
    await React.act(async () => { cell.click(); });
    assert.equal(JSON.stringify(events), senderOn ? '[["send","sticker",true]]' : '[]', 'B7-send: тап отправляет стикер только после закрытия окна');
    assert.equal(!!host.querySelector('.sticker-set-modal'), !senderOn, 'B7-close: без sender окно только просматривается, с sender закрывается');
  } finally { await React.act(async () => root.unmount()); host.remove(); }
}
it('R214 B7 настоящий каталог передаёт sender, а тап настоящего окна шлёт и закрывает', () => stickers(true));
it('R214 B7 без открытой беседы набор просматривается, тап не шлёт и не закрывает', () => stickers(false));
it('R214 B7 контрфакт снятого send ловится настоящей панелью и окном', async () => {
  await stickers(true);
  const changed = replaceOne(catalogRaw, 'send: useDmStickers.getState().sender ?? undefined', 'send: undefined');
  // Сравнивается один host callback по идентичности; метаданные убийства — точно false / true.
  await assert.rejects(stickers(true, changed), failure('B7-sender:', false, true));
});
it('R214 B7 контрфакт незакрытого окна ловится порядком перед реальной отправкой', async () => {
  await stickers(true);
  await assert.rejects(stickers(true, catalogRaw, replaceOne(modalRaw, '                  close();\n                  send(st);', '                  send(st);')),
    failure('B7-send:', '[["send","sticker",false]]', '[["send","sticker",true]]'));
});

type Navigation = 'dm' | 'current-channel' | 'other-channel';
async function share(mode: Navigation, open: 'all' | 'none' | 'profile' = 'all', source = shareRaw, cancel = false) {
  const events: string[] = [];
  let picker: ForwardPickerProps | undefined;
  const bootstrap = { server: { id: 'server', name: 'Сервер', iconUrl: null }, permissions: '0', categories: [],
    channels: [{ id: 'channel', name: 'новости', type: 'text', position: 0, categoryId: null, canSend: true }] };
  const state = {
    servers: [{ id: 'server' }], bootstrap, currentServerId: mode === 'other-channel' ? null : 'server', dms: [{ id: 'target' }],
    adminOpen: open === 'all', settingsOpen: open === 'all', mobileProfileOpen: open !== 'none',
    setSharedIn: () => events.push('shared'),
    setAdminOpen: (value: boolean) => { state.adminOpen = value; events.push(`admin:${value}`); },
    setSettingsOpen: (value: boolean) => { state.settingsOpen = value; events.push(`settings:${value}`); },
    setMobileProfileOpen: (value: boolean) => { state.mobileProfileOpen = value; events.push(`profile:${value}`); },
    selectDm: async (id: string) => { events.push(`dm:${id}:${flags()}`); },
    openChannel: async (id: string) => { events.push(`channel:${id}:${flags()}`); },
    openServer: async (id: string, channel: string) => { events.push(`server:${id}:${channel}:${flags()}`); },
    setView: (view: string) => events.push(`view:${view}`), loadDms: unused,
  };
  const flags = () => `${Number(state.mobileProfileOpen)}${Number(state.settingsOpen)}${Number(state.adminOpen)}`;
  const module = moduleOf<typeof import('./ShareIncoming')>(source, {
    react: React, 'react/jsx-runtime': jsx, '../api': { api: { getServer: unused } },
    '../attachRules': attachRules,
    '../peerName': { usePeerName: () => unused, dmPeerLabel: unused }, '../shareInbox': inbox,
    '../store': { useStore: { getState: () => state } }, '../sockets': { subscribeToServer: (id: string) => events.push(`subscribe:${id}`) },
    '../toast': { toast: unused, toastError: unused }, '../shareSend': { sendShareTo: unused },
    '../nativeMedia': { nativeMediaAvailable: () => true, sharedPeekNative: async () => ({ token: 'incoming', text: 'заметка', files: [] }),
      sharedDropNative: async () => { events.push('drop'); }, sharedFilesNative: unused },
    // Только граница входящего выбора. Правила/разметку ForwardPicker этим тестом не проверяем;
    // onDraft исполняет настоящий pick внутри целого ShareIncoming, а навигация фиксирует состояние в момент вызова.
    './ForwardPicker': { ForwardPicker: (props: ForwardPickerProps) => { picker = props; return React.createElement('div'); } },
  });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => { root.render(React.createElement(module.ShareIncoming)); });
    assert.ok(picker?.share, 'полный ShareIncoming получил реальное входящее содержимое');
    assert.equal(picker.share.channels[0]?.id, 'channel', 'канал выбран настоящим shareChannels из bootstrap');
    await React.act(async () => { if (cancel) picker!.onClose(); else picker!.onDraft!(mode === 'dm' ? 'target' : 'channel'); });
    const closes = open === 'all' ? 'admin:false,settings:false,profile:false,' : open === 'profile' ? 'profile:false,' : '';
    const navigation = mode === 'dm' ? 'dm:target:000' : mode === 'current-channel' ? 'view:server,channel:channel:000,subscribe:server' : 'server:server:channel:000,subscribe:server';
    assert.equal(events.join(','), cancel ? 'drop' : `shared,${closes}${navigation},drop`,
      'H11-order: все открытые панели закрыты до первой навигации, закрытые панели не трогаются');
  } finally { await React.act(async () => root.unmount()); host.remove(); }
}
for (const mode of ['dm', 'current-channel', 'other-channel'] as const)
  it(`R214 H11 выбор ${mode} закрывает профиль, настройки и админку до навигации`, () => share(mode));
it('R214 H11 уже закрытые панели не получают лишних setter, выбор беседы всё равно работает', () => share('dm', 'none'));
it('R214 H11 один открытый профиль закрывается без изменения остальных панелей', () => share('dm', 'profile'));
it('R214 H11 отмена входящего выбора не закрывает панели и не начинает навигацию', () => share('dm', 'all', shareRaw, true));
it('R214 H11 контрфакт оставленного профиля ловится его состоянием при настоящем pick', async () => {
  await share('dm');
  await assert.rejects(share('dm', 'all', replaceOne(shareRaw, '      if (st.mobileProfileOpen) st.setMobileProfileOpen(false);', '')),
    failure('H11-order:', 'shared,admin:false,settings:false,dm:target:100,drop', 'shared,admin:false,settings:false,profile:false,dm:target:000,drop'));
});
