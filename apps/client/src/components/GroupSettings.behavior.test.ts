import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement, Fragment, act, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as contactRules from '../contactRules.js';
import * as groupChatRules from '../groupChatRules.js';

type Person = { id: string; username: string; displayName: string; avatarUrl: string | null };
type PickerProps = { taken: readonly string[]; picked: Person[]; setPicked: (people: Person[]) => void; maxPick?: number };
type HarnessState = { candidates: Person[]; contacts: (Person & { name: string | null; addedAt: string })[]; features: string[]; user: { id: string } };

let registered = false;
before(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  registered = true;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
after(() => { if (registered) GlobalRegistrator.unregister(); });

const react = { createElement, Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore };
const jsxRuntime = { jsx, jsxs, Fragment };

function compilePeoplePicker(state: HarnessState, toasts: string[], change?: (source: string) => string): ComponentType<PickerProps> {
  let source = readFileSync(new URL('./GroupDialogs.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (change) {
    const mutated = change(source);
    assert.notEqual(mutated, source, 'source mutant должен попасть в реальную разметку PeoplePicker');
    source = mutated;
  }
  const module = { exports: {} as Record<string, unknown> };
  const dependencies: Record<string, unknown> = {
    react,
    '../api': { api: { searchUsers: async () => ({ users: [] }) } },
    '../confirm': { confirmAction: async () => false },
    '../dialogChrome': { useDialogChrome: () => null },
    '../dmRules': {
      dmComposeCandidates: () => state.candidates,
      dmSearchHits: () => [],
      serverSearchesUsers: () => false,
      USER_SEARCH_DELAY_MS: 0,
      userSearchQuery: () => null,
    },
    '../groupChatRules': groupChatRules,
    '../phoneLayout': { usePhoneLayout: () => false },
    '../dmOnline': { useVisibleOnline: () => new Set<string>() },
    '../useContactSeen': { useContactSeen: () => new Map<string, string>() },
    '../peerName': { usePeerName: () => (id: string, fallback: string) => contactRules.personLabel(state.contacts, id, fallback) },
    '../contactRules': contactRules,
    '../contacts': { useContactList: (enabled: boolean) => enabled ? state.contacts : null },
    '../store': { useStore: (select: (s: unknown) => unknown) => select({ members: [], dms: [], user: state.user, serverFeatures: state.features }) },
    '../toast': { toast: (_kind: string, message: string) => { toasts.push(message); }, toastError: () => {} },
    './Avatar': { Avatar: ({ name }: { name: string }) => createElement('span', null, name) },
    './BottomSheet': { BottomSheet: ({ children }: { children: ReactNode }) => createElement('div', null, children) },
    './Icon': { Icon: () => createElement('span') },
    './SharedMedia': { SharedMediaRows: () => null },
    './ServerActionModals': { CreateServerModal: () => null },
  };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, {
    module, exports: module.exports, document, window, ...dependencies,
    require: (id: string) => {
      if (id === 'react/jsx-runtime') return jsxRuntime;
      assert.ok(id in dependencies, `unexpected GroupDialogs dependency ${id}`);
      return dependencies[id];
    },
  });
  return module.exports.PeoplePicker as ComponentType<PickerProps>;
}

async function mountPicker(Picker: ComponentType<PickerProps>, props: PickerProps) {
  const host = document.createElement('div');
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => { root.render(createElement(Picker, props)); await Promise.resolve(); });
  return {
    host,
    click: async (selector: string) => {
      const button = host.querySelector<HTMLButtonElement>(selector);
      assert.ok(button, `настоящая кнопка доступна: ${selector}`);
      await act(async () => { button!.click(); await Promise.resolve(); });
    },
    cleanup: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

function extractFunction(source: string, declaration: string, nextComment: string): string {
  // По имени, а не сигнатуре: параметры с деструктуризацией не должны ломать границу функции.
  const name = /^function (\w+)/.exec(declaration)?.[1]; assert.ok(name);
  const ast = ts.createSourceFile('UserSettingsModal.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = ast.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(functions.length, 1, `единственная настоящая функция ${name}`);
  const fn = functions[0]; const start = fn.getStart(ast);
  const end = source.indexOf(nextComment, start);
  assert.ok(start >= 0 && end > start, `найдена настоящая функция ${declaration}`);
  assert.ok(fn.body && fn.end <= end, `${declaration} целиком завершается перед следующей границей`);
  return source.slice(start, fn.end);
}

function compileSettingsText(source: string, mobile: () => boolean) {
  const module = { exports: {} as Record<string, unknown> };
  // Структурные границы старого харнесса сохраняем, но исполняем теперь весь модуль, не фрагменты.
  extractFunction(source, 'function EmojiSuggestSetting', '\n\n/**\n * «Отправка по Enter');
  extractFunction(source, 'function CoinNotifyPanel', '\n\n/**\n * Доехать до группы настроек');
  const joined = `${source}\nexport { EmojiSuggestSetting, CoinNotifyPanel };`;
  const dependencies: Record<string, unknown> = {
    react, 'react/jsx-runtime': jsxRuntime,
    '../phoneLayout': { usePhoneUi: mobile },
    '../hotkeys': { isMobile: mobile, isAndroid: mobile },
    '../emojiSuggest': { emojiSuggestEnabled: () => true, setEmojiSuggestEnabled: () => {} },
    './Toggle': { Toggle: ({ label }: { label: string }) => createElement('button', null, label) },
    '../notifications': { coinNotifyLevel: () => 'off' },
  };
  const js = ts.transpileModule(joined, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, {
    module, exports: module.exports, document, window,
    require: (id: string) => {
      return dependencies[id] ?? new Proxy({}, { get: (_target, key) => {
        throw new Error(`Неописанная граница настроек ${id}.${String(key)}`);
      } });
    },
  });
  return module.exports as { EmojiSuggestSetting: ComponentType; CoinNotifyPanel: ComponentType<{ phoneUi?: boolean }> };
}

async function renderSettingsText(components: ReturnType<typeof compileSettingsText>, phoneUi?: boolean) {
  const host = document.createElement('div'); document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => {
    root.render(createElement('div', null, createElement(components.EmojiSuggestSetting), createElement(components.CoinNotifyPanel, { phoneUi })));
  });
  return { host, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}

async function phoneCaption(source: string) {
  // isMobile намеренно всегда true: панель должна следовать пропу, а не угадывать оболочку сама.
  for (const phoneUi of [true, false, undefined]) {
    const view = await renderSettingsText(compileSettingsText(source, () => true), phoneUi);
    try {
      const text = view.host.textContent ?? '';
      assert.equal(text.includes('GusVoice не на экране'), phoneUi === true, 'телефонная подпись определяется пропом');
      assert.equal(text.includes('окно не в фокусе'), phoneUi !== true, 'false и умолчание сохраняют подпись ПК');
      assert.equal(text.includes('полноэкранной игре Windows'), phoneUi !== true, 'предупреждение Windows только для ПК');
    } finally { await view.cleanup(); }
  }
}
it('R173 панель монет принимает телефонную подпись по phoneUi, false и умолчание сохраняют компьютерную', async () => {
  // Старые вызовы без нового пропа не должны внезапно получить телефонную подпись.
  const source = readFileSync(new URL('./UserSettingsModal.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  await phoneCaption(source);
});
it('R173 игнорирование phoneUi обнаруживается парной проверкой настоящей панели монет', async () => {
  // Мутант исполняет целый модуль и обязан упасть на подписи, не на неизвестной VM-границе.
  const source = readFileSync(new URL('./UserSettingsModal.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  await phoneCaption(source);
  const anchor = 'function CoinNotifyPanel({ phoneUi = false }: { phoneUi?: boolean } = {}) {';
  assert.equal(source.split(anchor).length - 1, 1, 'единственная сигнатура панели монет');
  const mutant = source.replace(anchor, 'function CoinNotifyPanel(_props: { phoneUi?: boolean } = {}) { const phoneUi = false;');
  await assert.rejects(() => phoneCaption(mutant), assert.AssertionError);
});

function compileAndroidInstallTab(hasDistributor: boolean, change?: (source: string) => string): ComponentType {
  const source = readFileSync(new URL('./UserSettingsModal.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  // Исполняем целиком настоящую внутреннюю вкладку, не копию её разметки. API не выдаёт
  // данных F-Droid: другой ordered list не должен маскировать отсутствие шагов ntfy.
  let tab = extractFunction(source, 'function AndroidInstallTab()', '\n\nfunction DesktopTab');
  if (change) {
    const mutated = change(tab);
    assert.notEqual(mutated, tab, 'мутант действительно изменил настоящую вкладку Android');
    tab = mutated;
  }
  const module = { exports: {} as Record<string, unknown> };
  const js = ts.transpileModule(`${tab}\nexports.AndroidInstallTab = AndroidInstallTab;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(js, {
    module, exports: module.exports, document, window, navigator,
    useState, useEffect,
    isAndroid: () => true,
    hasPushDistributor: () => hasDistributor,
    config: { ntfyServer: 'https://push.example.test' },
    api: { fdroidInfo: async () => null },
    require: (id: string) => {
      assert.equal(id, 'react/jsx-runtime', 'извлечённая вкладка использует только штатный JSX runtime');
      return jsxRuntime;
    },
  });
  return module.exports.AndroidInstallTab as ComponentType;
}

async function renderAndroidInstallTab(Tab: ComponentType) {
  const host = document.createElement('div'); document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => { root.render(createElement(Tab)); await Promise.resolve(); });
  return { host, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}

function assertNtfyGuide(host: HTMLElement) {
  const label = host.querySelector('#set-g-push');
  assert.equal(label?.textContent, 'Пуш-уведомления (ntfy)');
  const list = label?.nextElementSibling?.nextElementSibling;
  assert.equal(list?.tagName, 'OL', 'под пояснением ntfy расположен список установки приёмника');
  const steps = [...list!.querySelectorAll(':scope > li')].map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim());
  assert.equal(steps.length, 4, 'без приёмника показаны четыре шага, включая выбор WebSockets');
  assert.match(steps[0]!, /Установите ntfy/);
  assert.match(steps[1]!, /Default server.*https:\/\/push\.example\.test/);
  assert.match(steps[2]!, /Advanced.*→.*Connection protocol.*выберите WebSockets/,
    'выбор WebSockets идёт после Default server, а не после возврата в GusVoice');
  assert.match(steps[3]!, /^Вернитесь в GusVoice/);
}

it('R113 Android без приёмника показывает WebSockets между Default server и возвратом в GusVoice', async () => {
  const view = await renderAndroidInstallTab(compileAndroidInstallTab(false));
  try { assertNtfyGuide(view.host); } finally { await view.cleanup(); }

  const noWebSockets = compileAndroidInstallTab(false, (source) => source.replace(
    /\n          <li>\n            <b>Там же, в «Advanced»[\s\S]*?\n          <\/li>/,
    '',
  ));
  const mutant = await renderAndroidInstallTab(noWebSockets);
  try {
    assert.throws(() => assertNtfyGuide(mutant.host), (error: unknown) =>
      error instanceof assert.AssertionError && error.actual === 3 && error.expected === 4,
    'убрать шаг — нарушить ту же проверку четырёх шагов, которая прошла на оригинале');
  } finally { await mutant.cleanup(); }
});

it('R113 Android с установленным приёмником не предлагает шаги установки ntfy', async () => {
  const view = await renderAndroidInstallTab(compileAndroidInstallTab(true));
  try {
    assert.match(view.host.textContent ?? '', /Приёмник установлен — пуши включены/);
    assert.equal(view.host.querySelectorAll('ol, li').length, 0, 'при установленном приёмнике нет списка шагов');
    assert.equal((view.host.textContent ?? '').includes('WebSockets'), false, 'скрыт и новый шаг протокола');
    assert.ok([...view.host.querySelectorAll('button')].some((button) => button.textContent === 'Проверить снова'));
  } finally { await view.cleanup(); }
});

it('выбор группы отделяет контакты и блокирует превышение, подсказки телефона отличаются от ПК', async () => {
  const contact: Person & { name: string | null; addedAt: string } = {
    id: 'contact', username: 'kontakt', displayName: 'Контакт', avatarUrl: null, name: 'Моя подпись', addedAt: '2026-10-08T00:00:00Z',
  };
  const other: Person = { id: 'other', username: 'other', displayName: 'Остальной', avatarUrl: null };
  const state: HarnessState = { candidates: [contact, other], contacts: [contact], features: ['contacts1'], user: { id: 'me' } };
  const toasts: string[] = [];
  const Picker = compilePeoplePicker(state, toasts);
  const picked = [contact];
  const view = await mountPicker(Picker, { taken: ['me'], picked, setPicked: () => {}, maxPick: 1 });
  try {
    assert.match(view.host.textContent ?? '', /Контакты/);
    assert.match(view.host.textContent ?? '', /Остальные/);
    const buttons = [...view.host.querySelectorAll<HTMLButtonElement>('.group-pick')];
    assert.equal(buttons.filter((button) => button.textContent?.includes('@kontakt')).length, 1,
      'контакт показан один раз, даже если одновременно входит в обычные candidates');
    const selected = buttons.find((button) => button.textContent?.includes('@kontakt'))!;
    assert.match(selected.textContent ?? '', /Моя подпись/, 'выбор участника показывает подпись контакта вместо имени профиля');
    assert.equal(selected.textContent?.includes('Контакт'), false, 'имя профиля не дублируется в строке с подписью');
    const unselected = buttons.find((button) => button.textContent?.includes('@other'))!;
    assert.ok(selected.classList.contains('on'));
    assert.equal(selected.classList.contains('limited'), false, 'выбранная строка остаётся доступной для снятия');
    assert.ok(unselected.classList.contains('limited'), 'при заполненном maxPick невыбранная строка притушена');
    await view.click('.group-pick.limited');
    assert.equal(toasts.at(-1), 'Можно выбрать не больше 1');

    const fillers: Person[] = ['p1', 'p2', 'p3', 'p4'].map((id) => ({ id, username: id, displayName: id, avatarUrl: null }));
    const noMax = await mountPicker(Picker, { taken: ['me'], picked: fillers, setPicked: () => {} });
    try {
      toasts.length = 0;
      await noMax.click('.group-pick.limited');
      assert.deepEqual(toasts, [], 'групповой предел показывает встроенную подсказку, а не toast для maxPick');
      assert.ok(noMax.host.querySelector('.group-limit'));
    } finally { await noMax.cleanup(); }

    const duplicate = compilePeoplePicker(state, [], (source) => source.replace(
      '.filter((u) => !taken.includes(u.id) && !contactIds.has(u.id))',
      '.filter((u) => !taken.includes(u.id))',
    ));
    const mutated = await mountPicker(duplicate, { taken: ['me'], picked: [contact], setPicked: () => {}, maxPick: 1 });
    try {
      assert.throws(() => assert.equal(mutated.host.querySelectorAll('.group-pick').length, 2,
        'контактный ID снова дублируется в блоке «Остальные»'), assert.AssertionError);
    } finally { await mutated.cleanup(); }

    const noLimited = compilePeoplePicker(state, [], (source) => source.replace("${state.full && !on ? ' limited' : ''}", ''));
    const limitedMutant = await mountPicker(noLimited, { taken: ['me'], picked: [contact], setPicked: () => {}, maxPick: 1 });
    try {
      assert.throws(() => assert.ok(limitedMutant.host.querySelector('.group-pick:not(.on)')?.classList.contains('limited'),
        'переполненную строку притушил production className'), assert.AssertionError);
    } finally { await limitedMutant.cleanup(); }
  } finally { await view.cleanup(); }

  const settingsSource = readFileSync(new URL('./UserSettingsModal.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const mobile = true;
  const settings = await renderSettingsText(compileSettingsText(settingsSource, () => mobile), true);
  try {
    const text = settings.host.textContent ?? '';
    assert.equal(text.includes('Windows'), false, 'на телефоне нет подсказки про полноэкранную игру Windows');
    assert.equal(text.includes('Tab или Enter'), false, 'на телефоне не перечислены отсутствующие клавиши');
  } finally { await settings.cleanup(); }

  const desktop = await renderSettingsText(compileSettingsText(settingsSource, () => false));
  try {
    const text = desktop.host.textContent ?? '';
    assert.equal(text.includes('Windows'), true, 'подсказка Windows сохранена на ПК');
    assert.equal(text.includes('Tab или Enter'), true, 'клавиатурная подсказка сохранена на ПК');
  } finally { await desktop.cleanup(); }

  for (const anchor of [
    "{!phoneUi && ' ⚠️ В полноэкранной игре Windows прячет уведомления — оттуда доходит только звук.'}",
    "{phoneUi ? 'Нажми на эмодзи в полосе — оно встанет в текст. ' : '←/→ выбирают, Tab или Enter подставляют, Esc закрывает. '}",
  ]) assert.equal(settingsSource.split(anchor).length - 1, 1, 'каждый старый контрфакт меняет одну настоящую границу телефона');
  const noMobileGate = settingsSource
    .replace("{!phoneUi && ' ⚠️ В полноэкранной игре Windows прячет уведомления — оттуда доходит только звук.'}", "{' ⚠️ В полноэкранной игре Windows прячет уведомления — оттуда доходит только звук.'}")
    .replace("{phoneUi ? 'Нажми на эмодзи в полосе — оно встанет в текст. ' : '←/→ выбирают, Tab или Enter подставляют, Esc закрывает. '}", "{'←/→ выбирают, Tab или Enter подставляют, Esc закрывает. '}");
  assert.notEqual(noMobileGate, settingsSource);
  const ungated = await renderSettingsText(compileSettingsText(noMobileGate, () => true), true);
  try {
    const text = ungated.host.textContent ?? '';
    assert.throws(() => assert.equal(text.includes('Windows'), false), assert.AssertionError);
    assert.throws(() => assert.equal(text.includes('Tab или Enter'), false), assert.AssertionError);
  } finally { await ungated.cleanup(); }

  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    const end = css.indexOf('\n}', start);
    assert.ok(start >= 0 && end > start, `найден CSS-селектор ${selector}`);
    return css.slice(start, end + 2);
  };
  assert.match(rule('.set-head-mark'), /margin-left:\s*(?!8px\b)[^;]+;/, 'метка не оставляет старый 8px отступ при переносе заголовка');
  assert.match(rule('.set-head-sub'), /flex-wrap:\s*wrap;/, 'подзаголовок может перенестись на узком экране');
  assert.match(rule('.settings-modal .set-sub-label'), /padding-top:\s*var\(--sp-3\);/, 'подпись под заголовком получает читаемый верхний отступ');
});
