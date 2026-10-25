import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as shared from '@gusvoice/shared';
import { serverHost } from '../configRules';

const source = readFileSync(new URL('./UserSettingsModal.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const configSource = ts.createSourceFile('config.ts', readFileSync(new URL('../config.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
// config.ts мигрирует localStorage на импорте: берём только его настоящий декларативный URL,
// без исполнения/вырезания функции и без дублирования адреса релизов в фикстуре.
const releases = configSource.statements.filter(ts.isVariableStatement)
  .filter(statement => statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword))
  .flatMap(statement => [...statement.declarationList.declarations])
  .filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'RELEASES_URL');
assert.equal(releases.length, 1);
const releasesValue = releases[0]!.initializer;
assert.ok(releasesValue && ts.isStringLiteral(releasesValue));
const releasesUrl = releasesValue.text;

const dormantImports = [
  './DmFolderBar', './DataStorageSettings', './DmFolderSettings', 'react-dom', '../androidBack',
  '../settingsAnchor', '../settingsSeen', '../audioSettings', '../micProcessorRules', '../desktopWindow',
  '../dialogChrome', '../downloads', '../phoneLayout', '../notifications', '../updater', '../theme',
  '../uiPrefs', './Avatar', './AvatarCropModal', './Icon', './NotifyExceptions', './Select', './SettingsShell',
  '../settingsChanged', '../settingsNav', '../settingsSnapshot', './GuestPlacesPanel', './InstancesPanel',
  '../federationClient', './OverlaySettingsPanel', './ToastSettingsPanel', './NotifyPopupSetting',
  './SoundSettingsPanel', './StreamQualityPanel', '../streamSettings', './MicBubbleSetting', './Toggle',
  '../avatarAnimation', '../liteMode', './LinkPreview', '../sendMode', '../emojiSuggest', '../dmListView',
  './DmListSwipe', '../quickReaction', './ContextMenu', './EmojiPicker', './DiagConsent', '../lastSeenText',
  './LastSeenExceptions', './MessagePrivacySetting', '../lastSeenExceptionsRules', '../callView', '../convSyncRules',
  '../store', '../toast',
];
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

type Options = {
  config: { ntfyServer?: string; pushGateway?: string; apiUrl?: string };
  fdroid?: 'success' | 'fail'; android?: boolean; raw?: string;
};
const repository = { repoUrl: 'https://repo.example/fdroid', fingerprint: 'test-public-fingerprint',
  addUrl: 'https://repo.example/add', qr: 'https://repo.example/qr.png' };

async function panel(options: Options, check: (host: HTMLDivElement, requests: number) => void) {
  const unexpected: string[] = [];
  let requests = 0;
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, '@gusvoice/shared': shared,
    '../config': { config: options.config, serverHost, RELEASES_URL: releasesUrl },
    '../hotkeys': { isAndroid: () => options.android ?? false },
    '../nativeUnifiedPush': { hasPushDistributor: () => false },
    '../api': { api: { fdroidInfo: async () => {
      requests++;
      if (options.fdroid !== 'success') throw new Error('Тестовый инстанс не публикует F-Droid');
      return repository;
    } } },
  };
  for (const id of dormantImports) deps[id] = new Proxy({}, { get: (_target, property) => {
    const message = `Неописанная граница ${id}.${String(property)}`;
    unexpected.push(message); throw new Error(message);
  } });
  const module = { exports: {} as { AndroidInstallTab: React.ComponentType } };
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    // Единственное дополнение — export локального компонента. Тело и все импорты целого
    // UserSettingsModal исполняются в VM: это не прежний тест вырезанного тела AndroidInstallTab.
    runInNewContext(ts.transpileModule((options.raw ?? source) + '\nexport { AndroidInstallTab };', {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, { module, exports: module.exports, window, document, navigator,
      require: (id: string) => {
        if (!Object.hasOwn(deps, id)) {
          const message = `Неописанный импорт ${id}`; unexpected.push(message); throw new Error(message);
        }
        return deps[id];
      },
    });
    await React.act(async () => root.render(React.createElement(module.exports.AndroidInstallTab)));
    check(host, requests);
  } finally {
    try { await React.act(async () => root.unmount()); }
    finally {
      host.remove();
      // Ошибка устройства фикстуры не должна исчезнуть в штатном catch fdroidInfo.
      assert.deepEqual(unexpected, [], 'закрытые границы AndroidInstallTab');
    }
  }
}

function ntfyCode(host: HTMLElement) {
  const step = [...host.querySelectorAll('li')].find(item => item.textContent?.includes('Default server'));
  assert.ok(step, 'гайд содержит шаг настройки основного сервера ntfy');
  return step.querySelector('code')?.textContent ?? null;
}

it('R267 явно заданный ntfy имеет приоритет над шлюзом пушей и убирает хвостовые слэши', async () => {
  for (const ending of ['', '/', '///']) await panel({ config: {
    ntfyServer: `https://private-ntfy.example${ending}`, pushGateway: 'https://other-push.example/',
  } }, (host, requests) => {
    assert.equal(requests, 1);
    assert.equal(ntfyCode(host), 'https://private-ntfy.example');
    assert.equal(host.textContent?.includes('other-push.example'), false);
    assert.equal(host.textContent?.includes('адрес ntfy вашего сервера'), false);
  });
});

async function fallback(raw = source) {
  await panel({ config: { ntfyServer: '', pushGateway: 'https://ntfy.example/' }, raw }, host => {
    assert.equal(ntfyCode(host), 'https://ntfy.example', 'R267:ntfy-из-pushGateway-без-слэша');
    assert.equal(host.textContent?.includes('адрес ntfy вашего сервера'), false);
  });
}

it('R267 пустой ntfyServer показывает pushGateway в code без хвостового слэша', () => fallback());

it('R267 отсутствующий или пустой ntfy и шлюз сохраняют понятную общую инструкцию', async () => {
  for (const config of [{}, { ntfyServer: '', pushGateway: '' }]) await panel({ config }, host => {
    assert.equal(ntfyCode(host), null);
    assert.equal(host.textContent?.includes('адрес ntfy вашего сервера'), true);
    assert.equal(host.textContent?.includes('undefined'), false);
    assert.equal(host.textContent?.includes('null'), false);
  });
});

it('R267 отказ F-Droid предлагает настоящую страницу релизов и адрес входа без префикса api', () => panel({
  config: { apiUrl: 'https://api.v.example' },
}, (host, requests) => {
  assert.equal(requests, 1);
  const link = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(a => a.textContent === 'страницы релизов проекта');
  assert.ok(link); assert.equal(link.getAttribute('href'), releasesUrl);
  assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noreferrer');
  const instruction = link.closest('div')!;
  assert.equal(instruction.textContent?.includes('При входе впишите адрес'), true);
  assert.equal(instruction.querySelector('code')?.textContent, 'v.example');
  assert.equal(instruction.textContent?.includes('api.v.example'), false);
  assert.equal(host.textContent?.includes('Загружаю данные репозитория'), false);
  assert.equal(!!host.querySelector('img'), false);
}));

it('R267 успешный F-Droid оставляет QR и ссылку репозитория вместо аварийной инструкции', () => panel({
  config: { ntfyServer: 'https://ntfy.example', apiUrl: 'https://api.v.example' }, fdroid: 'success',
}, (host, requests) => {
  assert.equal(requests, 1);
  assert.equal(host.querySelector<HTMLImageElement>('img')?.getAttribute('src'), repository.qr);
  const add = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(a => a.textContent === 'Открыть в Droid-ify');
  assert.equal(add?.getAttribute('href'), repository.addUrl);
  assert.equal(host.textContent?.includes(repository.repoUrl), true);
  assert.equal(host.textContent?.includes(repository.fingerprint), true);
  assert.equal([...host.querySelectorAll('a')].some(a => a.getAttribute('href') === releasesUrl), false);
  assert.equal(ntfyCode(host), 'https://ntfy.example', 'успешный репозиторий не скрывает адрес ntfy');
}));

it('R267 в установленном APK адрес ntfy есть, ненужный запрос установочного репозитория отсутствует', () => panel({
  config: { ntfyServer: '', pushGateway: 'https://ntfy.example/' }, android: true,
}, (host, requests) => {
  assert.equal(requests, 0);
  assert.equal(!!host.querySelector('#set-g-android'), false);
  assert.equal(ntfyCode(host), 'https://ntfy.example');
}));

it('R267 контрфакт config.ntfyServer вместо вычисленного адреса падает адресно, оригинал проходит первым', async () => {
  await fallback();
  const anchor = '<code>{addrs.ntfy}</code>';
  assert.equal(source.split(anchor).length - 1, 1);
  const mutant = source.replace(anchor, '<code>{config.ntfyServer}</code>');
  await assert.rejects(() => fallback(mutant), error => error instanceof assert.AssertionError &&
    error.message.includes('R267:ntfy-из-pushGateway-без-слэша'));
});
