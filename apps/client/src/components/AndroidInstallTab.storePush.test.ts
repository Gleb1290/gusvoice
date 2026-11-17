import assert from 'node:assert/strict';
import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import { testVmImports } from '../testVmImports';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const source = readFileSync(new URL('./UserSettingsModal.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let createRoot: typeof import('react-dom/client')['createRoot'];
let previousAct: PropertyDescriptor | undefined;
before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/', settings: { enableImageFileLoading: false } });
  previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  createRoot = (await import('react-dom/client')).createRoot;
});
after(() => {
  GlobalRegistrator.unregister();
  if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct);
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

async function panel(props: { storePush?: boolean }, check: (host: HTMLDivElement) => void,
  options: { raw?: string; distributor?: boolean; android?: boolean } = {}) {
  const unexpected: string[] = [];
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    // import-only пакет не разрешается CommonJS; этой панели его экспорты не нужны.
    // testVmImports отклонит чтение любого неподготовленного экспорта, не исполняя shared.
    '@gusvoice/shared': { __esModule: true },
    '../config': { config: {}, RELEASES_URL: 'https://releases.example' },
    '../hotkeys': { isAndroid: () => options.android !== false },
    // Проп должен быть единственным источником выбора: нативная проверка здесь намеренно недоступна.
    '../nativeUnifiedPush': { hasPushDistributor: () => options.distributor ?? false,
      storePushActive: () => { throw Error('Компонент обязан использовать готовый проп storePush'); } },
    '../api': { api: { fdroidInfo: async () => { throw Error('Нет репозитория в тестовом инстансе'); } } },
  };
  const imports = testVmImports(new URL('./UserSettingsModal.tsx', import.meta.url), deps);
  const module = { exports: {} as { AndroidInstallTab: React.ComponentType<{ storePush?: boolean }> } };
  // Единственная добавка — доступ к локальному компоненту; исполняется весь настоящий модуль,
  // не извлечённое тело/копия условия. Мутации тоже применяются только к строке в памяти.
  runInNewContext(ts.transpileModule((options.raw ?? source) + '\nexport { AndroidInstallTab };', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { module, exports: module.exports, window, document, navigator,
    // Панель перехватывает ошибки API: сохраняем также сигнал о проглоченной ошибке mock.
    require: (id: string) => new Proxy(imports(id) as object, { get(target, key) {
      try { return Reflect.get(target, key); }
      catch (error) { unexpected.push(`${id}.${String(key)}`); throw error; }
    } }),
  });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(module.exports.AndroidInstallTab, props)));
    check(host);
  } finally {
    await React.act(async () => root.unmount()); host.remove();
    assert.deepEqual(unexpected, [], 'закрытые границы компонента не должны исполняться');
  }
}

async function playGuide(raw = source) {
  for (const distributor of [false, true]) await panel({ storePush: true }, host => {
    assert.equal(host.textContent?.includes('через Google Play'), true, 'R330:гайд-магазина-виден');
    assert.equal(host.textContent?.toLowerCase().includes('ntfy'), false, 'R330:магазин-не-предлагает-ntfy');
    assert.equal([...host.querySelectorAll('button')].some(button => button.textContent === 'Проверить снова'), false,
      'R330:магазину-не-нужна-перепроверка-приёмника');
    assert.ok(host.querySelector('#set-g-push'), 'заголовок пушей остаётся доступен якорю настроек');
  }, { raw, distributor });
}

it('R330 storePush=true показывает Google Play без ntfy и перепроверки, независимо от внешнего приёмника', () => playGuide());

it('R330 без пропа и при false остаются инструкция ntfy и кнопка перепроверки на Android', async () => {
  for (const props of [{}, { storePush: false }]) await panel(props, host => {
    assert.equal(host.textContent?.includes('Установите ntfy'), true);
    assert.equal(host.textContent?.includes('Default server'), true);
    assert.equal(host.textContent?.includes('через Google Play'), false);
    assert.equal([...host.querySelectorAll('button')].filter(button => button.textContent === 'Проверить снова').length, 1);
  });
});

it('R330 прежний гайд с установленным приёмником сохраняет подтверждение, без Android не предлагает перепроверку', async () => {
  await panel({}, host => assert.equal(host.textContent?.includes('Приёмник установлен'), true), { distributor: true });
  await panel({}, host => {
    assert.equal(host.textContent?.includes('Установите ntfy'), true);
    assert.equal([...host.querySelectorAll('button')].some(button => button.textContent === 'Проверить снова'), false);
  }, { android: false });
});

it('R330 контрфакт отключённого условия storePush краснеет тем же рендером', async () => {
  await counterfact(async () => {
  const before = '{storePush ? (';
  assert.equal(source.split(before).length - 1, 1, 'единственный якорь выбора гайда');
  await assert.rejects(() => playGuide(source.replace(before, '{false ? (')), error => error instanceof assert.AssertionError
    && error.operator === 'strictEqual' && error.message.startsWith('R330:гайд-магазина-виден'));
  });
});
