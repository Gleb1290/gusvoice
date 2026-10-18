import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const source = readFileSync(new URL('./UserSettingsModal.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const noop = () => {};
async function render(component: string, phone: boolean, props: Record<string, unknown>, check: (host: HTMLDivElement) => void, raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    '../phoneLayout': { usePhoneUi: () => phone },
    '../hotkeys': { isAndroid: () => phone, isMobile: () => false, isDesktop: () => false,
      isTauri: () => false, getHotkeys: () => ({ mute: '', deafen: '', screenShare: '',
        overlayToggle: '', diagMark: 'Ctrl+Shift+F12' }), formatCombo: () => 'Пробел' },
    '../audioSettings': { getAudioSettings: () => ({ pushToTalk: true, pttKey: 'Space', vadThreshold: .01,
      inputGain: 1, noiseFilter: 'off', pttReleaseMs: 0, inputDeviceId: '', outputDeviceId: '',
      cameraDeviceId: '', noiseSuppression: false, echoCancellation: true, autoGainControl: true }), setAudioSettings: noop },
    '../micProcessorRules': { VAD_THRESHOLD_MIN: .01, VAD_THRESHOLD_MAX: .6 },
    '../notifications': { osNotifyLevel: () => 'off', coinNotifyLevel: () => 'off' },
    '../toast': { toast: noop },
    '../quickReaction': { getDoubleClickAction: () => 'none', getQuickReaction: () => '👍' },
    '../theme': { getTheme: () => 'dark' },
    '../uiPrefs': { getUiScale: () => 'md', getSidebarWidth: () => 240,
      SIDEBAR_MIN: 180, SIDEBAR_MAX: 480, UI_SCALES: [{ key: 'md', label: 'Обычный' }] },
    '../avatarAnimation': { animatedAvatarsEnabled: () => true },
    '../liteMode': { liteModeEnabled: () => false },
    './LinkPreview': { linkPreviewsEnabled: () => true },
    '../dmListView': { useListLines: () => 'two' },
    '../sendMode': { getSendMode: () => 'enter' },
    '../emojiSuggest': { emojiSuggestEnabled: () => true },
    './DmListSwipe': { ChatSwipeSetting: () => React.createElement('b', { id: 'set-g-swipe' }) },
    './Icon': { Icon: ({ name }: { name: string }) => React.createElement('i', { 'data-icon': name }) },
    './Toggle': { Toggle: () => null }, './Select': { Select: () => null },
    './MicBubbleSetting': { MicBubbleSetting: () => null },
    './StreamQualityPanel': { StreamQualityPanel: () => React.createElement('b', null, 'качество') },
  };
  try {
    const module = { exports: {} as Record<string, React.ComponentType<any>> };
    // Исполняется весь TSX; дополнительный export открывает только существующие приватные панели.
    runInNewContext(ts.transpileModule(raw + '\nexport { AudioVideoTab, AppearanceTab, DoubleClickSetting, OsNotifyPanel, CoinNotifyPanel };', {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText, { module, exports: module.exports, window, document, console,
      // Реальный микрофон не запрашиваем: звук — внешняя граница, не предмет проверки разметки.
      navigator: { mediaDevices: { enumerateDevices: async () => [],
        getUserMedia: async () => { throw new Error('Микрофон недоступен в тесте'); } } },
      require: (id: string) => deps[id] ?? new Proxy({}, { get: (_t, key) => {
        throw new Error(`Неописанная граница ${id}.${String(key)}`);
      } }) });
    await React.act(async () => { root.render(React.createElement(module.exports[component], props)); });
    check(host);
  } finally {
    await React.act(async () => root.unmount()); host.remove(); await GlobalRegistrator.unregister();
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}
it('R169 рация сохраняется на телефоне без строки клавиши, горячих клавиш и качества показа, на ПК все строки есть', async () => {
  // isMobile=false специально: мобильный браузер должен следовать phoneUi, не нативному APK.
  for (const phone of [true, false]) await render('AudioVideoTab', phone, {}, host => {
    for (const id of ['set-g-stream', 'set-g-hotkeys']) assert.equal(!!host.querySelector(`#${id}`), !phone);
    assert.equal(host.textContent?.includes('Клавиша'), !phone);
    assert.equal(!!host.querySelector('#set-g-ptt'), true);
  });
});
it('R169 двойное касание названо касанием на телефоне и кликом на компьютере', async () => {
  // Подпись не должна обещать мышь пользователю сенсорного устройства.
  for (const phone of [true, false]) await render('DoubleClickSetting', phone, {}, host => {
    assert.equal(host.querySelector('#set-g-dblclick')?.textContent?.trim(),
      phone ? 'Двойное касание по сообщению' : 'Двойной клик по сообщению');
  });
});
it('R169 вид на телефоне скрывает ширину панели и Enter, сохраняет тему и свайп; на ПК настройки обратные', async () => {
  // Скрытая группа не должна оставлять осиротевший ползунок или обещание растягивать край пальцем.
  for (const phone of [true, false]) await render('AppearanceTab', phone, {}, host => {
    for (const id of ['set-g-sidebar', 'set-sidebar-w', 'set-g-send']) assert.equal(!!host.querySelector(`#${id}`), !phone, id);
    assert.equal(!!host.querySelector('#set-g-swipe'), phone);
    assert.equal(!!host.querySelector('#set-g-theme'), true);
    assert.equal(host.textContent?.includes('тянуть за правый край'), !phone);
  });
});
for (const component of ['OsNotifyPanel', 'CoinNotifyPanel']) it(`R169 ${component}: телефонная подпись только при phoneUi, умолчание остаётся компьютерным`, async () => {
  // Умолчание важно для старых вызовов, не передающих новый проп.
  for (const props of [{}, { phoneUi: false }, { phoneUi: true }]) await render(component, true, props, host => {
    const phone = 'phoneUi' in props && props.phoneUi === true;
    assert.equal(host.textContent?.includes('GusVoice не на экране'), phone);
    assert.equal(host.textContent?.includes('не в фокусе'), !phone);
    if (component === 'CoinNotifyPanel') assert.equal(host.textContent?.includes('полноэкранной игре Windows'), !phone);
  });
});

function guard(raw = source) {
  // AST проверяет привязку условий к JSX целого модуля, а не исполняет извлечённые тела.
  const ast = ts.createSourceFile('UserSettingsModal.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const conditions = new Map<string, string[]>();
  function walk(node: ts.Node, parents: string[] = []) {
    const next = ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ? [...parents, node.left.getText(ast)] : parents;
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const id = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'id');
      const key = id && ts.isJsxAttribute(id) && id.initializer && ts.isStringLiteral(id.initializer)
        ? id.initializer.text : node.tagName.getText(ast);
      conditions.set(key, parents);
    }
    ts.forEachChild(node, child => walk(child, next));
  }
  walk(ast);
  for (const id of ['set-g-stream', 'set-g-hotkeys', 'set-g-sidebar'])
    assert.equal(conditions.get(id)?.includes('!phoneUi'), true, id);
  assert.equal(conditions.get('DesktopTab')?.includes('desktop'), true);
  assert.equal(conditions.get('WindowsDownload')?.includes('!isTauri() && !mobile'), true);
  assert.match(raw, /const desktop = isDesktop\(\);/);
  assert.match(raw, /const mobile = usePhoneUi\(\);/);
  assert.match(raw, /visibleSections\(\{ federation: fed, desktop, mobile, multi, superAdmin, folders \}\)/);
  assert.match(raw, /<OsNotifyPanel phoneUi=\{mobile\} \/>/);
  assert.match(raw, /<CoinNotifyPanel phoneUi=\{mobile\} \/>/);
}
it('R169 окно настроек связывает навигацию и подписи с телефонным видом, приложения ПК — с десктопом', () => guard());
for (const [label, anchor, replacement] of [
  ['Tauri вместо десктопа', 'const desktop = isDesktop();', 'const desktop = isTauri();'],
  ['APK вместо телефонного вида', 'const mobile = usePhoneUi();', 'const mobile = isMobile();'],
  ['Windows на телефоне', '!isTauri() && !mobile && <WindowsDownload />', '!isTauri() && <WindowsDownload />'],
] as const) it(`R169 ${label} обнаруживается связями окна настроек`, () => {
  guard(); assert.equal(source.split(anchor).length - 1, 1);
  assert.throws(() => guard(source.replace(anchor, replacement)), assert.AssertionError);
});
