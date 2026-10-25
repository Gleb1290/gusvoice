import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import { feedNavKey, feedNavTarget } from '../feedNavRules';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const layoutSource = read('./MainLayout.tsx');
const settingsSource = read('./UserSettingsModal.tsx');
const sidebarSource = read('./ChannelSidebar.tsx');

/** Загружаем ВЕСЬ TSX: callback не вырезается и условие cheatKey не повторяется в фикстуре. */
function keyboardMatrix(raw: string): void {
  GlobalRegistrator.register();
  try {
    let phone = false;
    let toggles = 0;
    const effects: Array<() => void | (() => void)> = [];
    const state = {
      view: 'dm', dms: [], convActive: false, conv: { pts: null }, mobilePane: 'list', economy: {}, unreadDms: [],
      settingsOpen: true,
    };
    const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
    const emptyComponent = () => null;
    // Соседние экраны не исполняются: JSX создаёт элементы, но React-дерево мы не монтируем.
    // Список закрытый: новый runtime-импорт требует явного решения, а не автоматической заглушки.
    const imports: Record<string, unknown> = {
      react: {
        useEffect: (effect: () => void | (() => void)) => effects.push(effect),
        useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, () => {}],
      },
      'react/jsx-runtime': jsx,
      '../hotkeys': { isMobile: () => false },
      '../store': { useStore },
      '../dmArchiveRules': { withoutArchived: () => [] },
      '../cheatSheet': {
        closeCheatSheet: () => {}, openCheatSheet: () => {}, toggleCheatSheet: () => { toggles++; },
        useCheatSheetOpen: () => false,
      },
      '../dmCompose': { openDmCompose: () => {} },
      '../dmRules': { DM_SERVER_UPDATE_TEXT: '', dmEmptyHint: () => '', dmNeedsServerUpdate: () => false },
      '../dmSelection': { exitSelection: () => false, useSelectionOpen: () => false },
      '../schedView': { backFromSchedView: () => false, useSchedViewOpen: () => false },
      '../dmBackBadge': { dmBackBadgeCount: () => 0, dmBackBadgeLabel: () => '' },
      '../useSwipeBack': { useSwipeBack: () => {} },
      '../phoneLayout': { isPhoneUiNow: () => phone, usePhoneLayout: () => phone },
      '../feedNavRules': { feedNavKey, feedNavTarget },
      './ChatSearch': { exitChatSearch: () => false },
      './CallLayer': { CallBar: emptyComponent, CallLayer: emptyComponent },
      './ChatSwitch': { ChatSwitchHost: emptyComponent },
      './ContactEditModal': { ContactEditHost: emptyComponent },
      './DesktopKeys': { DesktopKeysHost: emptyComponent },
    };
    for (const name of [
      'AdminPanel', 'ChannelSidebar', 'MobileCallChip', 'MobileProfile', 'ChatView', 'DmChatView', 'DmSidebar',
      'PhoneServerList', 'EconomyWelcome', 'FeatherLayer', 'BigReactionLayer', 'EffectsBench', 'GooseBonusHost',
      'HotkeyCheatSheet', 'Goose', 'Icon', 'ImageViewerHost', 'MobileNav', 'ServerMembersPanel', 'ServerRail',
      'SidebarResizer', 'PokeModal', 'ServerClosedModal', 'ToastHost', 'UserSettingsModal', 'VoiceChannelView', 'VoiceConnection',
    ]) imports[`./${name}`] = { [name]: emptyComponent };
    const module = { exports: {} as { MainLayout: () => unknown } };
    runInNewContext(ts.transpileModule(raw, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, {
      module, exports: module.exports, window, document,
      require: (id: string) => {
        assert.ok(Object.hasOwn(imports, id), `R283 подготовка: неизвестный импорт ${id}`);
        return imports[id];
      },
    });
    module.exports.MainLayout();
    assert.equal(effects.length, 1, 'R283 подготовка: единственный эффект MainLayout — клавиатура');
    const cleanup = effects[0]();
    assert.equal(typeof cleanup, 'function', 'R283 подготовка: listener имеет очистку');
    try {
      const input = document.createElement('input');
      const textarea = document.createElement('textarea');
      const editable = document.createElement('div');
      editable.contentEditable = 'true';
      assert.equal(editable.isContentEditable, true, 'R283 подготовка: happy-dom распознаёт редактируемое поле');
      document.body.append(input, textarea, editable);
      const targets = [['outside', document.body], ['input', input], ['textarea', textarea], ['editable', editable]] as const;
      const keys = [
        { name: 'Ctrl+/', key: '/', code: 'Slash', ctrlKey: true, opens: true },
        { name: 'Meta+/', key: '/', code: 'Slash', metaKey: true, opens: true },
        { name: 'Ctrl+русская-точка', key: '.', code: 'Slash', ctrlKey: true, opens: true },
        { name: 'Meta+русская-точка', key: '.', code: 'Slash', metaKey: true, opens: true },
        { name: '?', key: '?', code: 'Slash', shiftKey: true, opens: 'outside' },
        { name: 'Ctrl+J', key: 'j', code: 'KeyJ', ctrlKey: true, opens: false },
        { name: 'Meta+J', key: 'j', code: 'KeyJ', metaKey: true, opens: false },
        { name: 'Ctrl+Shift+/', key: '?', code: 'Slash', ctrlKey: true, shiftKey: true, opens: false },
        { name: 'Ctrl+Alt+/', key: '/', code: 'Slash', ctrlKey: true, altKey: true, opens: false },
        { name: 'просто-/', key: '/', code: 'Slash', opens: false },
      ] as const;
      for (const phoneNow of [false, true]) {
        // Меняем живое значение ПОСЛЕ регистрации: listener обязан читать isPhoneUiNow на каждое нажатие.
        phone = phoneNow;
        for (const [targetName, target] of targets) for (const key of keys) {
          const address = `R283/MainLayout/${phone ? 'phone' : 'desktop'}/${targetName}/${key.name}`;
          const expected = !phone && (key.opens === true || key.opens === targetName);
          const before = toggles;
          const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...key });
          target.dispatchEvent(event);
          assert.equal(toggles - before, Number(expected), `${address}/toggle`);
          assert.equal(event.defaultPrevented, expected, `${address}/preventDefault`);
        }
      }
    } finally { if (typeof cleanup === 'function') cleanup(); }
  } finally { GlobalRegistrator.unregister(); }
}

function replaceOnce(source: string, needle: string, replacement: string): string {
  assert.equal(source.split(needle).length - 1, 1, `R283 подготовка: один якорь ${needle}`);
  return source.replace(needle, replacement);
}

function killedBy(check: () => void, address: string): void {
  assert.throws(check, (error: unknown) => error instanceof assert.AssertionError && error.message.split('\n')[0] === address,
    `мутант обязан упасть на адресной проверке ${address}, не на ошибке фикстуры/VM`);
}

it('R283: Ctrl и ⌘ открывают шпаргалку из любого поля, вопрос — только снаружи, телефон молчит', () => {
  // Почему: клавиатура подключается и к телефону, а русская раскладка меняет key, но не физический code.
  keyboardMatrix(layoutSource);
});

it('R283 контрфакт: без проверки телефона внешняя клавиатура открыла бы окно для ПК', () => {
  // Почему: один только успешный сценарий ПК не замечает исчезновения телефонного запрета.
  keyboardMatrix(layoutSource);
  const mutant = replaceOnce(layoutSource, 'if (isPhoneUiNow()) return;', '');
  killedBy(() => keyboardMatrix(mutant), 'R283/MainLayout/phone/outside/Ctrl+//toggle');
});

it('R283 контрфакт: без Slash любое Ctrl-сочетание ошибочно становится шпаргалкой', () => {
  // Почему: физическая клавиша важна и для русской раскладки, и чтобы чужие сочетания не открывали шпаргалку.
  keyboardMatrix(layoutSource);
  const mutant = replaceOnce(layoutSource, " && e.code === 'Slash'", '');
  killedBy(() => keyboardMatrix(mutant), 'R283/MainLayout/desktop/outside/Ctrl+J/toggle');
});

const parse = (raw: string, name: string) => ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function descendants<T extends ts.Node>(node: ts.Node, predicate: (n: ts.Node) => n is T): T[] {
  const found: T[] = [];
  const visit = (n: ts.Node) => { if (predicate(n)) found.push(n); ts.forEachChild(n, visit); };
  visit(node);
  return found;
}
function one<T>(values: T[], address: string): T {
  assert.equal(values.length, 1, address);
  return values[0];
}
const identifier = (node: ts.Node | undefined, name: string) => !!node && ts.isIdentifier(node) && node.text === name;
function attr(node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === name);
}
function attrExpr(node: ts.JsxOpeningLikeElement, name: string): ts.Expression | undefined {
  const value = attr(node, name)?.initializer;
  return value && ts.isJsxExpression(value) ? value.expression : undefined;
}
function contains(root: ts.Node, target: ts.Node): boolean {
  for (let n: ts.Node | undefined = target; n; n = n.parent) if (n === root) return true;
  return false;
}
function andGuard(node: ts.Node, name: string, negate = false): ts.BinaryExpression | undefined {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (!ts.isBinaryExpression(parent) || parent.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken || !contains(parent.right, node)) continue;
    const left = parent.left;
    if (negate ? ts.isPrefixUnaryExpression(left) && left.operator === ts.SyntaxKind.ExclamationToken && identifier(left.operand, name) : identifier(left, name)) return parent;
  }
  return undefined;
}
function functionNamed(root: ts.Node, name: string): ts.FunctionDeclaration {
  return one(descendants(root, ts.isFunctionDeclaration).filter((n) => n.name?.text === name), `R283/wiring/function/${name}`);
}
function importBinding(root: ts.SourceFile, from: string, exported: string, local: string): boolean {
  return root.statements.some((n) => ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === from &&
    n.importClause && !n.importClause.isTypeOnly && n.importClause.namedBindings && ts.isNamedImports(n.importClause.namedBindings) &&
    n.importClause.namedBindings.elements.some((binding) => !binding.isTypeOnly && binding.name.text === local && (binding.propertyName?.text ?? binding.name.text) === exported));
}

function wiring(settingsRaw: string): { phoneGuard: ts.BinaryExpression; forward: ts.JsxAttribute } {
  const layout = parse(layoutSource, 'MainLayout.tsx');
  const settings = parse(settingsRaw, 'UserSettingsModal.tsx');
  const sidebar = parse(sidebarSource, 'ChannelSidebar.tsx');
  // AST не видит комментарий MainLayout про прежнюю кнопку в шапке и не считает его проводкой.
  assert.equal(descendants(sidebar, ts.isIdentifier).some((n) => n.text === 'openCheatSheet'), false, 'R283/wiring/sidebar/no-openCheatSheet');
  assert.ok(importBinding(layout, '../cheatSheet', 'openCheatSheet', 'openCheatSheet'), 'R283/wiring/layout/runtime-import');
  const settingsHost = one(descendants(functionNamed(layout, 'MainLayout'), ts.isJsxSelfClosingElement).filter((n) => identifier(n.tagName, 'UserSettingsModal')), 'R283/wiring/layout/settings-host');
  assert.ok(identifier(attrExpr(settingsHost, 'onOpenCheatSheet'), 'openCheatSheet'), 'R283/wiring/layout/open-prop');

  const settingsFn = functionNamed(settings, 'UserSettingsModal');
  const audioFn = functionNamed(settings, 'AudioVideoTab');
  for (const fn of [settingsFn, audioFn]) {
    const binding = fn.parameters[0]?.name;
    assert.ok(binding && ts.isObjectBindingPattern(binding) && binding.elements.some((n) => identifier(n.name, 'onOpenCheatSheet') && !n.propertyName), `R283/wiring/${fn.name?.text}/callback-binding`);
  }
  const audioHost = one(descendants(settingsFn, ts.isJsxSelfClosingElement).filter((n) => identifier(n.tagName, 'AudioVideoTab')), 'R283/wiring/settings/audio-host');
  assert.ok(identifier(attrExpr(audioHost, 'onOpenCheatSheet'), 'onOpenCheatSheet'), 'R283/wiring/settings/forward-prop');
  const forward = attr(audioHost, 'onOpenCheatSheet')!;
  assert.ok(importBinding(settings, '../phoneLayout', 'usePhoneUi', 'usePhoneUi'), 'R283/wiring/audio/runtime-phone-import');
  assert.ok(descendants(audioFn, ts.isVariableDeclaration).some((n) => identifier(n.name, 'phoneUi') && n.initializer && ts.isCallExpression(n.initializer) && identifier(n.initializer.expression, 'usePhoneUi')), 'R283/wiring/audio/live-phone');
  const button = one(descendants(audioFn, ts.isJsxElement).filter((n) => identifier(n.openingElement.tagName, 'button') && n.children.some((child) => ts.isJsxText(child) && child.text.trim() === 'Все сочетания клавиш (Ctrl+/)')), 'R283/wiring/audio/button');
  assert.ok(identifier(attrExpr(button.openingElement, 'onClick'), 'onOpenCheatSheet'), 'R283/wiring/audio/click-callback');
  assert.ok(andGuard(button, 'onOpenCheatSheet'), 'R283/wiring/audio/optional-callback-guard');
  const phoneGuard = andGuard(button, 'phoneUi', true);
  assert.ok(phoneGuard, 'R283/wiring/audio/phone-guard');
  const group = one(descendants(audioFn, ts.isJsxOpeningElement).filter((n) => {
    const id = attr(n, 'id')?.initializer;
    return id && ts.isStringLiteral(id) && id.text === 'set-g-hotkeys';
  }), 'R283/wiring/audio/hotkeys-group');
  assert.ok(contains(phoneGuard.right, group), 'R283/wiring/audio/button-in-hotkeys-group');
  return { phoneGuard, forward };
}

it('R283: вход из шапки убран, настройки получают настоящий callback и скрывают кнопку на телефоне', () => {
  // Почему: работа клавиши не доказывает доступность кнопки и передачу действия через обе границы компонентов.
  wiring(settingsSource);
});

it('R283 контрфакт: потеря пропа между настройками и вкладкой убрала бы единственный видимый вход', () => {
  // Почему: объявленный проп без передачи дальше внешне похож на исправную проводку.
  const { forward } = wiring(settingsSource);
  const mutant = settingsSource.slice(0, forward.getStart()) + settingsSource.slice(forward.end);
  killedBy(() => wiring(mutant), 'R283/wiring/settings/forward-prop');
});

it('R283 контрфакт: телефонный guard относится к реальной кнопке, а не к соседнему блоку', () => {
  // Почему: наличие !phoneUi где-нибудь в огромной вкладке ещё не скрывает кнопку шпаргалки.
  const { phoneGuard } = wiring(settingsSource);
  const mutant = settingsSource.slice(0, phoneGuard.left.getStart()) + 'true' + settingsSource.slice(phoneGuard.left.end);
  killedBy(() => wiring(mutant), 'R283/wiring/audio/phone-guard');
});
