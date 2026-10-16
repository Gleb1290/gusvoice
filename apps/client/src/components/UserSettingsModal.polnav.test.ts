import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as shared from '@gusvoice/shared';
import * as settingsNav from '../settingsNav';

const source = readFileSync(new URL('./UserSettingsModal.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const noop = () => {};
// Закрытый перечень включает и неиспользуемые панели: новый импорт не становится разрешённой границей молча.
const dormantImports = [
  './DmFolderBar', './DataStorageSettings', './DmFolderSettings', 'react-dom', '../androidBack',
  '../settingsAnchor', '../settingsSeen', '../audioSettings', '../micProcessorRules', '../desktopWindow',
  '../dialogChrome', '../downloads', '../phoneLayout', '../notifications', '../updater', '../theme',
  '../uiPrefs', './AvatarCropModal', './NotifyExceptions', './Select', './SettingsShell', '../settingsChanged',
  '../settingsSnapshot', './GuestPlacesPanel', './InstancesPanel', '../federationClient', './OverlaySettingsPanel',
  './ToastSettingsPanel', './NotifyPopupSetting', './SoundSettingsPanel', './StreamQualityPanel', '../streamSettings',
  './Toggle', '../avatarAnimation', '../liteMode', './LinkPreview', '../sendMode', '../emojiSuggest', '../dmListView',
  './DmListSwipe', '../quickReaction', './ContextMenu', './EmojiPicker', './DiagConsent', '../lastSeenText',
  './LastSeenExceptions', './MessagePrivacySetting', '../lastSeenExceptionsRules', '../callView', '../convSyncRules',
];

async function renderPanel(component: 'AndroidInstallTab' | 'AccountTab', android: boolean,
  check: (host: HTMLDivElement, fdroidCalls: number) => void, raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let fdroidCalls = 0;
  const unexpected: string[] = [];
  const user = { id: 'self', displayName: 'Гусь', username: 'goose', email: 'goose@example.test', emailVerified: true };
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, '@gusvoice/shared': shared, '../settingsNav': settingsNav,
    '../api': { api: { fdroidInfo: async () => {
      fdroidCalls++;
      return { repoUrl: 'https://example.test/repo', fingerprint: 'test-fingerprint', addUrl: 'https://example.test/add', qr: '' };
    } } },
    '../hotkeys': { isAndroid: () => android, isDesktop: () => false, isTauri: () => android },
    '../nativeUnifiedPush': { hasPushDistributor: () => false },
    '../config': { config: { ntfyServer: 'https://ntfy.example.test' }, isPickerBuild: () => false },
    '../store': { useStore: (select: (state: any) => unknown) => select({ user, setAuth: noop, logout: noop }) },
    '../toast': { toast: noop, toastError: noop },
    './Icon': { Icon: () => React.createElement('i') },
    './Avatar': { Avatar: () => React.createElement('i', { 'data-avatar': true }) },
  };
  for (const id of dormantImports) deps[id] = new Proxy({}, { get: (_target, key) => {
    const message = `Неописанная граница ${id}.${String(key)}`;
    unexpected.push(message); throw new Error(message);
  } });
  try {
    const module = { exports: {} as Record<string, React.ComponentType<any>> };
    // Дополнительный export не подменяет тело панели; весь модуль исполняется одним и тем же загрузчиком.
    runInNewContext(ts.transpileModule(raw + '\nexport { AndroidInstallTab, AccountTab };', {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText, { module, exports: module.exports, window, document, navigator,
      require: (id: string) => {
        if (!Object.hasOwn(deps, id)) {
          const message = `Неописанный импорт ${id}`; unexpected.push(message); throw new Error(message);
        }
        return deps[id];
      } });
    await React.act(async () => root.render(React.createElement(module.exports[component], { onClose: noop })));
    check(host, fdroidCalls);
  } finally {
    try { await React.act(async () => root.unmount()); }
    finally {
      host.remove(); await GlobalRegistrator.unregister();
      if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      // Даже штатный catch панели не вправе превращать ошибку устройства фикстуры в зелёный тест.
      assert.deepEqual(unexpected, [], 'R230 закрытые границы не обращались к неописанным зависимостям');
    }
  }
}

async function checkAndroid(raw = source) {
  await renderPanel('AndroidInstallTab', true, (host, calls) => {
    assert.equal(calls, 0, 'R230 Android не запрашивает установочный репозиторий');
    assert.equal(host.textContent?.includes('Droid-ify'), false, 'R230 установленный APK не предлагает установку');
    assert.equal(host.querySelector('#set-g-android'), null);
    assert.equal(host.querySelector('#set-g-push')?.textContent, 'Пуш-уведомления (ntfy)');
    assert.ok(host.textContent?.includes('Установите ntfy'));
  }, raw);
}

it('R230 внутри Android нет инструкции установки и запроса репозитория, но настройка ntfy доступна', async () => {
  // Отсутствия текста мало: ненужный credentialed запрос тоже должен исчезнуть внутри APK.
  await checkAndroid();
});

it('R230 вне Android инструкция Droid-ify запрашивает репозиторий и сосуществует с ntfy', async () => {
  // Парный разрешающий случай не даёт спрятать полезную инструкцию сразу на всех платформах.
  await renderPanel('AndroidInstallTab', false, (host, calls) => {
    assert.equal(calls, 1);
    assert.equal(host.textContent?.includes('Droid-ify'), true);
    assert.equal(host.querySelector('#set-g-android')?.textContent, 'GusVoice на Android');
    assert.equal(host.querySelector('#set-g-push')?.textContent, 'Пуш-уведомления (ntfy)');
  });
});

it('R230 контрфакт запроса репозитория из установленного Android ловится по числу запросов', async () => {
  // Тот же загрузчик и DOM-сценарий сначала проходят на оригинале; убирается ровно охрана сетевого запроса.
  await checkAndroid();
  const anchor = 'if (inApp) return;';
  assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(checkAndroid(source.replace(anchor, '')), (e: unknown) => e instanceof assert.AssertionError &&
    e.message.startsWith('R230 Android не запрашивает установочный репозиторий') &&
    e.operator === 'strictEqual' && e.actual === 1 && e.expected === 0);
});

it('R230 аккаунт сохраняет редактирование личного имени без поля отображаемого имени сервера', async () => {
  // Запрещённое серверное поле не заменяется случайным исчезновением всей панели профиля.
  await renderPanel('AccountTab', true, host => {
    assert.equal(host.textContent?.includes('Отображаемое имя сервера'), false);
    assert.equal(host.querySelector('[data-avatar]') !== null, true);
    assert.equal([...host.querySelectorAll('input')].some(input => input.value === 'Гусь'), true);
    assert.ok(host.textContent?.includes('Удалить аккаунт'));
  });
});

function checkVersionRail(raw = source) {
  const ast = ts.createSourceFile('UserSettingsModal.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Только прямой return экспортированного компонента: мёртвая функция с похожей разметкой не считается интерфейсом.
  const components = ast.statements.filter(ts.isFunctionDeclaration).filter(fn => fn.name?.text === 'UserSettingsModal' &&
    fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
  assert.equal(components.length, 1);
  const returns = components[0]!.body!.statements.filter(ts.isReturnStatement);
  assert.equal(returns.length, 1);
  let output = returns[0]!.expression!;
  while (ts.isParenthesizedExpression(output)) output = output.expression;
  assert.ok(ts.isJsxElement(output));
  assert.equal(output.openingElement.tagName.getText(ast), 'SettingsWindow');
  const rails = output.openingElement.attributes.properties.filter((attribute): attribute is ts.JsxAttribute =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'rail');
  assert.equal(rails.length, 1);
  const initializer = rails[0]!.initializer;
  assert.ok(initializer && ts.isJsxExpression(initializer) && initializer.expression);
  let rail = initializer.expression;
  while (ts.isParenthesizedExpression(rail)) rail = rail.expression;
  assert.ok(ts.isJsxElement(rail));
  assert.equal(rail.openingElement.tagName.getText(ast), 'SettingsRail');
  let count = 0;
  function walk(node: ts.Node) {
    if (ts.isJsxElement(node)) {
      const cls = node.openingElement.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'className');
      if (cls && ts.isJsxAttribute(cls) && cls.initializer && ts.isStringLiteral(cls.initializer) && cls.initializer.text === 'settings-app-version') {
        count++;
        assert.equal(node.children.filter(ts.isJsxExpression).map(x => x.expression?.getText(ast)).join(''),
          "appVersionLabel(androidApp ? 'android' : isTauri() ? 'desktop' : 'web', appVer)");
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(rail);
  assert.equal(count, 1, 'R230 версия находится в живом rail окна UserSettingsModal');
}

it('R230 единственная строка версии размещена внутри рельса разделов и получает реальную платформу и appVer', () => {
  // Проверяется родитель в AST всего модуля, а не наличие CSS-класса где угодно в файле.
  checkVersionRail();
});

it('R230 удаление версии и перенос в неиспользуемый рельс не заменяют строку живого окна настроек', () => {
  // Глобальный обход AST ошибочно принимал мёртвую функцию с SettingsRail за настоящий интерфейс.
  const anchor = '<div className="settings-app-version">{appVersionLabel(androidApp ? \'android\' : isTauri() ? \'desktop\' : \'web\', appVer)}</div>';
  assert.equal(source.split(anchor).length - 1, 1);
  for (const dormant of ['', `\nfunction UnusedVersionRail() { return <SettingsRail>${anchor}</SettingsRail>; }`]) {
    checkVersionRail(source);
    assert.throws(() => checkVersionRail(source.replace(anchor, '') + dormant), (e: unknown) => e instanceof assert.AssertionError &&
      e.message.startsWith('R230 версия находится в живом rail окна UserSettingsModal') &&
      e.operator === 'strictEqual' && e.actual === 0 && e.expected === 1);
  }
});

function checkBlockedPanel(raw = source) {
  const ast = ts.createSourceFile('UserSettingsModal.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const components = ast.statements.filter(ts.isFunctionDeclaration).filter(fn => fn.name?.text === 'UserSettingsModal' &&
    fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
  assert.equal(components.length, 1);
  const returns = components[0].body!.statements.filter(ts.isReturnStatement);
  assert.equal(returns.length, 1);
  const placements: string[] = [];
  const panels: Record<string, string[]> = {};
  function walk(node: ts.Node, section = 'без раздела') {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      ts.isBinaryExpression(node.left) && node.left.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isIdentifier(node.left.left) && node.left.left.text === 'section' && ts.isStringLiteral(node.left.right)) {
      walk(node.right, node.left.right.text);
      return;
    }
    if (ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(ast);
      (panels[section] ??= []).push(tag);
      if (tag === 'BlockedUsersSetting') placements.push(section);
    }
    ts.forEachChild(node, child => walk(child, section));
  }
  // Только прямой return живого экспортированного окна, не комментарий или неиспользуемая панель.
  walk(returns[0].expression!);
  assert.equal(JSON.stringify(placements), '["privacy"]', 'R232 панель заблокированных размещена только в живой конфиденциальности');
  assert.equal(panels.privacy?.at(-1), 'BlockedUsersSetting', 'R232 панель заблокированных завершает конфиденциальность');
  assert.equal(panels.account?.includes('AccountTab'), true, 'R232 аккаунт сохранил собственную панель');
  assert.equal(panels.privacy?.includes('MessagePrivacySetting'), true, 'R232 конфиденциальность сохранила сообщения');
}
it('R232 заблокированные завершают живой раздел конфиденциальности и отсутствуют в аккаунте', () => {
  checkBlockedPanel();
});
it('R232 перенос панели заблокированных в аккаунт или мёртвую разметку не подменяет её конфиденциальность', () => {
  const anchor = '            <BlockedUsersSetting />';
  const account = '            <SecurityTab />';
  assert.equal(source.split(anchor).length - 1, 1);
  assert.equal(source.split(account).length - 1, 1);
  for (const [mutant, actual] of [
    [source.replace(anchor, '').replace(account, `${account}\n${anchor}`), '["account"]'],
    [source.replace(anchor, '') + '\nfunction UnusedBlockedPanel() { return <BlockedUsersSetting />; }', '[]'],
  ]) {
    checkBlockedPanel();
    assert.throws(() => checkBlockedPanel(mutant), (e: unknown) => e instanceof assert.AssertionError &&
      e.message.startsWith('R232 панель заблокированных размещена только в живой конфиденциальности') &&
      e.operator === 'strictEqual' && e.actual === actual && e.expected === '["privacy"]');
  }
});
