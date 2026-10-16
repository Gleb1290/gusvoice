import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as playback from '../voicePlayback';
import { formatDuration } from '@gusvoice/shared';
import * as dmRules from '../dmRules';
import * as contactRules from '../contactRules';
import * as convRules from '../convSyncRules';

const sourceOf = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const actDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
before(() => { GlobalRegistrator.register({ url: 'http://localhost/' }); Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true }); });
after(() => {
  GlobalRegistrator.unregister();
  if (actDescriptor) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actDescriptor);
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});
function replaceOnce(source: string, anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, `единственный якорь ${anchor}`);
  return source.replace(anchor, replacement);
}

async function waveScenario(phone: boolean, trim: boolean, mutate?: (s: string) => string) {
  const original = sourceOf('./VoiceMessage.tsx'); const source = mutate ? mutate(original) : original;
  if (mutate) assert.notEqual(source, original, 'контрфакт изменил настоящий компонент');
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': { jsx, jsxs }, '@gusvoice/shared': { formatDuration },
    '../voicePlayback': playback, '../phoneLayout': { usePhoneLayout: () => phone },
    '../store': { useStore: { getState: () => ({ view: 'dm' }) } },
    '../fileActions': { attachmentKey: () => 'att' }, '../voiceTrim': { VOICE_TRIM_MIN_MS: 1000 },
    './Icon': { Icon: () => null }, './VoiceSpeedButton': { VoiceSpeedButton: () => null },
    '../voicePlayer': { useVoiceBubble: () => ({ playing: false, at: 0, heard: false }),
      releaseLocalVoice() {}, rememberVoice() {}, seekVoice() {}, toggleVoice() {} },
  };
  // HappyDOM не рассчитывает layout: явно задаём ширину волны и наблюдатель, а не выдаём нулевой rect за телефон.
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () { return { width: 152, height: 20, top: 0, left: 0, right: 152, bottom: 20, x: 0, y: 0, toJSON() {} } as DOMRect; };
  class Observer { constructor(private callback: () => void) {} observe() { this.callback(); } disconnect() {} }
  const module = { exports: {} as typeof import('./VoiceMessage') };
  let host: HTMLDivElement | undefined;
  let root: ReturnType<typeof createRoot> | undefined;
  try {
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, ResizeObserver: Observer, window,
        require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `неописанная граница ${id}`); return deps[id]; } });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await React.act(async () => root!.render(React.createElement(module.exports.VoicePlayer, {
      url: '/voice.webm', waveform: [10, 90], durationMs: 5000,
      trim: trim ? { from: 0, to: 1, onChange() {} } : undefined,
    })));
    return { tg: host.querySelector('.voice-wave')!.classList.contains('tg-bars'), count: host.querySelectorAll('.voice-bar').length };
  } finally {
    try { if (root) await React.act(async () => root!.unmount()); }
    finally { host?.remove(); HTMLElement.prototype.getBoundingClientRect = rect; }
  }
}

it('R169 телефонная волна получает 51 столбик, ПК и обрезка сохраняют исходную волну', async () => {
  // Удаление !trim ломает ручки обрезки, а tg-bars на ПК меняет прежнюю огибающую.
  for (const [phone, trim, tg, count] of [[true, false, true, 51], [true, true, false, 2], [false, false, false, 2], [false, true, false, 2]] as const) {
    const s = await waveScenario(phone, trim); assert.equal(s.tg, tg); assert.equal(s.count, count);
  }
});
it('R169 контрфакт телефонных столбиков в режиме обрезки отвергается по DOM', async () => {
  // Проверка идёт на целиком скомпилированном компоненте, а не на вычисленной отдельно строке условия.
  const baseline = await waveScenario(true, true); assert.equal(baseline.tg, false);
  const s = await waveScenario(true, true, s => replaceOnce(s, 'const tgBars = phone && !trim;', 'const tgBars = phone;'));
  assert.throws(() => assert.equal(s.tg, false), assert.AssertionError);
});

async function contactsScenario(phone: boolean, mutate?: (s: string) => string) {
  const original = sourceOf('./DmSidebar.tsx'); const source = mutate ? mutate(original) : original;
  const person = (id: string) => ({ id, username: id, displayName: `Человек ${id}`, avatarUrl: null });
  const contacts = ['con-on', 'con-off', 'con-none'].map(id => ({ ...person(id), name: null }));
  const members = ['other-on', 'other-off', 'other-none'].map(id => ({ user: person(id), roles: [] }));
  const online = new Set(['con-on', 'other-on']);
  const texts = new Map(['con', 'other'].flatMap(prefix => [[`${prefix}-on`, 'в сети'], [`${prefix}-off`, 'был(а) недавно']] as [string, string][]));
  const state = { members, dms: [], user: person('me'), serverFeatures: ['contacts1'], convActive: false,
    openDmWith: async () => {}, openSaved: async () => {} };
  const enabledCalls: boolean[] = [];
  const dependencies: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': { jsx, jsxs, Fragment: React.Fragment },
    '../dmRules': dmRules, '../contactRules': contactRules, '../convSyncRules': convRules,
    '../phoneLayout': { usePhoneLayout: () => phone },
    '../store': { useStore: (selector: (s: typeof state) => unknown) => selector(state) },
    '../contacts': { useContactList: (enabled: boolean) => { assert.equal(enabled, true); return contacts; } },
    '../dmOnline': { useVisibleOnline: () => online },
    '../useContactSeen': { useContactSeen: (_ids: readonly string[], _online: ReadonlySet<string>, enabled: boolean) => { enabledCalls.push(enabled); return enabled ? texts : new Map(); } },
    '../peerName': { usePeerName: () => (_id: string, fallback: string) => fallback },
    '../dialogChrome': { useDialogChrome: () => React.useRef(null) },
    '../dmCompose': { closeDmCompose() {} },
    '../dmListRules': { DM_ROW_HOLD_MS: 500, DM_ROW_HOLD_SLOP: 8 },
    '../api': { api: { searchUsers: () => assert.fail('без users1 нет сетевого поиска') } },
    './Avatar': { Avatar: () => null }, './Icon': { Icon: () => null },
    './BottomSheet': { BottomSheet: ({ children }: { children: React.ReactNode }) => React.createElement('section', null, children) },
  };
  // Эти импорты принадлежат другим компонентам целого DmSidebar; обращение к любому их экспорту здесь — ошибка границы.
  const unused = [
    '../hotkeys', '../toast', '../channelRules', '../chatKeysRules', '../dmArchiveRules', '../dmRowRules', '../typing',
    '../androidBack', '../connState', './SavedAvatar', './GroupDialogs', '../groupChatRules', './DmRowMenu', './DmFolderBar',
    '../dmFolderView', '../dmFolders', '../cornerButtonsRules', '../dmListSearchRules', './DmServerSearch', './DmAllSearch',
    './DmListSearch', './DmArchive', '../dragOut', '../dmListView', '../uiPrefs', '../filesDrop', './DmListSwipe', './DmPinDrag',
    '../chatSwipe', './Goose', './SelfVoiceBar', './SettingsShell', './SharedMedia', './StatusDot', './VoicePanel', '../voiceDrafts',
  ];
  for (const id of unused) dependencies[id] = new Proxy({}, { get(_target, key) { assert.fail(`неожиданное исполнение ${id}.${String(key)}`); } });
  const module = { exports: {} as { NewDmSheet: React.ComponentType<{ initialQuery: string }> } };
  runInNewContext(ts.transpileModule(`${source}\nexport { NewDmSheet };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, window,
      require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `неописанная граница ${id}`); return dependencies[id]; } });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(module.exports.NewDmSheet, { initialQuery: '' })));
    const input = host.querySelector<HTMLInputElement>('.sheet-search')!;
    assert.equal(document.activeElement === input, !phone, 'курсор телефона не захвачен, на ПК поле получает фокус');
    assert.equal(enabledCalls.every(enabled => enabled === phone), true, 'статусы запрошены только телефоном');
    for (const prefix of ['con', 'other']) for (const suffix of ['on', 'off', 'none']) {
      const id = `${prefix}-${suffix}`;
      const row = [...host.querySelectorAll('.sheet-row')].find(row => row.textContent?.includes(`Человек ${id}`));
      assert.ok(row, `отрисован ${id}`); const sub = row.querySelector('.dm-sub'); assert.ok(sub);
      const seen = phone && suffix !== 'none';
      assert.equal(sub.classList.contains('seen'), seen, `класс статуса ${id}`);
      assert.equal(sub.classList.contains('on'), seen && suffix === 'on', `цвет online ${id}`);
      assert.equal(sub.textContent?.trim(), seen ? (suffix === 'on' ? 'в сети' : 'был(а) недавно') : `@${id}`, `подпись ${id}`);
    }
  } finally { await React.act(async () => root.unmount()); host.remove(); }
}
it('R169 настоящий список контактов показывает статус только на телефоне и оставляет @ник на ПК', async () => {
  // Проверяем контакты и остальных отдельно: online, offline и отсутствие ответа не должны смешиваться.
  await contactsScenario(true); await contactsScenario(false);
});
it('R169 контрфакты автофокуса телефона и статусов ПК отвергаются настоящим списком', async () => {
  // Проводка enabled проверяется через реально вызванный хук; autoFocus через реальный React mount.
  for (const [phone, anchor, replacement] of [
    [true, 'autoFocus={!phone}', 'autoFocus={true}'],
    [false, 'useContactSeen(candidateIds, onlineSet, phone)', 'useContactSeen(candidateIds, onlineSet, true)'],
  ] as const) {
    await contactsScenario(phone);
    await assert.rejects(() => contactsScenario(phone, s => replaceOnce(s, anchor, replacement)), assert.AssertionError);
  }
});

function declaration(file: string, name: string): string {
  const text = sourceOf(file); const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, `настоящая декларация ${name} существует`); return node.getText(tree);
}
function dmContract(text: string) {
  assert.match(text, /autoFocus=\{!phone\}/);
  assert.match(text, /useContactSeen\(candidateIds, onlineSet, phone\)/);
  assert.match(text, /dm-sub seen\$\{onlineSet\.has\(id\) \? ' on' : ''\}/);
  assert.match(text, /<span className="dm-sub"> @\{username\}<\/span>/);
  assert.match(text, /\{subOf\(c\.id, c\.username\)\}/);
  assert.match(text, /\{subOf\(u\.id, u\.username\)\}/);
}
it('R169 поле контактов не открывает клавиатуру телефона, статус и fallback подключены к обоим спискам', () => {
  // AST/text guard: фиксирует проводку props, не обещает реальное поведение клавиатуры или layout.
  const s = declaration('./DmSidebar.tsx', 'NewDmSheet'); dmContract(s);
  for (const change of [
    (s: string) => replaceOnce(s, 'autoFocus={!phone}', 'autoFocus'),
    (s: string) => replaceOnce(s, 'onlineSet, phone)', 'onlineSet, true)'),
    (s: string) => replaceOnce(s, 'dm-sub seen', 'dm-sub'),
  ]) { const changed = change(s); assert.notEqual(changed, s); assert.throws(() => dmContract(changed), assert.AssertionError); }
});
function groupContract(s: string) {
  const tree = ts.createSourceFile('group.tsx', s, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes: ts.Node[] = [];
  function visit(n: ts.Node) { nodes.push(n); ts.forEachChild(n, visit); }
  visit(tree);
  const people = nodes.find((n): n is ts.ConditionalExpression => ts.isConditionalExpression(n) && n.condition.getText(tree) === "step === 'people'");
  assert.ok(people, 'ветка участников существует');
  const branches: ts.ConditionalExpression[] = [];
  function findPhone(n: ts.Node) { if (ts.isConditionalExpression(n) && n.condition.getText(tree) === 'phone') branches.push(n); ts.forEachChild(n, findPhone); }
  findPhone(people.whenTrue); assert.equal(branches.length, 1, 'телефонная ветка принадлежит именно шагу участников');
  function elements(node: ts.Node, className: string): ts.JsxOpeningElement[] {
    const found: ts.JsxOpeningElement[] = [];
    function walk(n: ts.Node) {
      if (ts.isJsxOpeningElement(n) && n.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(tree) === 'className' && p.initializer && ts.isStringLiteral(p.initializer) && p.initializer.text === className)) found.push(n);
      ts.forEachChild(n, walk);
    }
    walk(node); return found;
  }
  const phone = branches[0]!;
  assert.equal(elements(phone.whenTrue, 'group-fab-dock').length, 1);
  const buttons = elements(phone.whenTrue, 'group-fab'); assert.equal(buttons.length, 1);
  const fab = buttons[0]!; assert.equal(fab.tagName.getText(tree), 'button');
  function attr(name: string) { const p = fab.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(tree) === name); assert.ok(p && ts.isJsxAttribute(p)); return p.initializer?.getText(tree); }
  assert.equal(attr('aria-label'), '"Далее"');
  assert.equal(attr('disabled'), '{picked.length === 0}', 'disabled относится к самой FAB');
  assert.equal(attr('onClick'), "{() => setStep('name')}", 'сама FAB переводит на имя');
  assert.equal(elements(phone.whenTrue, 'modal-actions').length, 0);
  assert.equal(elements(phone.whenFalse, 'modal-actions').length, 1);
  assert.equal(elements(phone.whenFalse, 'group-fab').length, 0);
}
it('R169 шаг участников телефона имеет отключённую без выбора кнопку Далее, ПК сохраняет действия', () => {
  // AST/text guard ловит перестановку веток и пропажу disabled; размер 48 px проверяется отдельным CSS-стражем.
  const s = declaration('./GroupDialogs.tsx', 'NewGroupDialog'); groupContract(s);
  for (const change of [
    (s: string) => replaceOnce(s, 'aria-label="Далее"\n                title="Далее"\n                disabled={picked.length === 0}', 'aria-label="Далее"\n                title="Далее"\n                disabled={false}'),
    // Шаг названия тоже имеет phone-ветку: меняем только ветку сразу после выбора участников.
    (s: string) => replaceOnce(s, 'setPicked={setPicked} />\n          {phone ? (', 'setPicked={setPicked} />\n          {!phone ? ('),
  ]) { const changed = change(s); assert.notEqual(changed, s); assert.throws(() => groupContract(changed), assert.AssertionError); }
});
