import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createServer, type ViteDevServer } from 'vite';
import { act, createElement, type ComponentType } from 'react';
import type { Root } from 'react-dom/client';

type ApiFixture = {
  localName: string | null;
  federation: unknown;
  neighborName: string | null;
  federationSetNameCalls: string[];
};

const fixture: ApiFixture = { localName: null, federation: false, neighborName: null, federationSetNameCalls: [] };
Object.assign(globalThis, { __federationPanelsFixture: fixture });

let server: ViteDevServer;
let createRoot: typeof import('react-dom/client').createRoot;
let FederationPanel: ComponentType;
let InstanceSettingsPanel: ComponentType;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let cacheDir = '';

async function flush(render?: () => void) {
  await act(async () => {
    render?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

async function mount(component: ComponentType): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await flush(() => root!.render(createElement(component)));
  // Запросы adminInstance/instance/overview и их React state update завершаются разными микрозадачами.
  await flush();
}

async function unmount() {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  host?.remove();
  host = undefined;
}

function resetFixture(patch: Partial<ApiFixture> = {}) {
  fixture.localName = null;
  fixture.federation = false;
  fixture.neighborName = null;
  fixture.federationSetNameCalls.length = 0;
  Object.assign(fixture, patch);
}

before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => new Response(null, { status: 503 }),
  });
  createRoot = (await import('react-dom/client')).createRoot;
  cacheDir = mkdtempSync(join(tmpdir(), 'gusvoice-federation-panels-'));
  server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    envFile: false,
    cacheDir,
    optimizeDeps: { noDiscovery: true, include: [] },
    esbuild: { jsx: 'automatic' },
    plugins: [{
      name: 'federation-panels-test-bridge',
      enforce: 'pre',
      resolveId(source, importer) {
        const id = importer?.replaceAll('\\', '/') ?? '';
        if (id.endsWith('/components/InstanceSettingsForms.tsx') && source === './InstanceUpdateCard') return '\0fed-panels-update-card';
        if (source === '../adminApi' && (id.endsWith('/components/FederationPanel.tsx') || id.endsWith('/components/InstanceSettingsForms.tsx'))) return '\0fed-panels-admin-api';
        if (!id.endsWith('/components/FederationPanel.tsx')) return;
        if (source === '../store') return '\0fed-panels-store';
        if (source === './FederationReports') return '\0fed-panels-reports';
        if (source === './FederationAudit') return '\0fed-panels-audit';
        if (source === './Toggle') return '\0fed-panels-toggle';
      },
      load(id) {
        if (id === '\0fed-panels-admin-api') return `
          const f = () => globalThis.__federationPanelsFixture;
          export const adminApi = () => ({
            adminInstance: async () => ({ name: f().localName, iconUrl: null, registration: 'approval', smtpConfigured: false }),
            instance: async () => ({ federation: f().federation }),
            federationOverview: async () => ({ status: 'ready', problem: null, paused: false, contacts: [],
              instance: { instanceId: 'local', fingerprint: 'fingerprint', domain: 'local.test', name: f().neighborName, iconHash: null }, links: [] }),
            federationSetName: async name => { f().federationSetNameCalls.push(name); },
          });
        `;
        if (id === '\0fed-panels-store') return `export const useStore = selector => selector({ federationRev: 0 });`;
        if (id === '\0fed-panels-reports') return `export const FederationReports = () => null;`;
        if (id === '\0fed-panels-audit') return `export const FederationAudit = () => null;`;
        if (id === '\0fed-panels-toggle') return `export const Toggle = () => null;`;
        if (id === '\0fed-panels-update-card') return `export const InstanceUpdateCard = () => null;`;
      },
    }],
    resolve: { alias: { '@gusvoice/shared': fileURLToPath(new URL('../../../../packages/shared/src/index.ts', import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    appType: 'custom',
    logLevel: 'error',
  });
  FederationPanel = (await server.ssrLoadModule('/src/components/FederationPanel.tsx')).FederationPanel;
  InstanceSettingsPanel = (await server.ssrLoadModule('/src/components/InstanceSettingsForms.tsx')).InstanceSettingsPanel;
});

after(async () => {
  await unmount();
  await server?.close();
  GlobalRegistrator.unregister();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

it('FederationPanel подсказывает по сохранённому локальному имени, а не по черновику', async () => {
  // Незаписанный текст не должен создавать впечатление, что соседи уже видят новое название.
  resetFixture({ localName: 'Сохранённое имя', neighborName: null });
  await mount(FederationPanel);
  const hints = [...(host?.querySelectorAll('.fed-self p.muted') ?? [])].filter((node) => node.textContent?.includes('Пусто — соседи'));
  assert.equal(hints.length, 1, 'R280 подсказка про пустое имя одна, статичная строка её не дублирует');
  const hint = hints[0];
  assert.ok(hint?.textContent?.includes('Сохранённое имя'), 'подсказка использует имя из adminInstance');
  assert.ok(hint?.textContent?.includes('Пусто — соседи видят название инстанса «Сохранённое имя»'),
    `объяснено умолчание по сохранённому имени: ${hint?.textContent}`);
  const description = [...(host?.querySelectorAll('.fed-self p.muted') ?? [])]
    .filter(node => node.textContent?.startsWith('Название видят люди на других инстансах.'));
  assert.equal(description.length, 1, 'R280 назначение отдельного имени объяснено независимо от динамической подсказки');
  assert.ok(description[0].textContent?.includes('обычное название инстанса, а без него — домен'));
  const input = host?.querySelector<HTMLInputElement>('.fed-self .fed-row input');
  assert.ok(input, 'поле локального названия отрисовано');
  await flush(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Черновик');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const updatedHints = [...(host?.querySelectorAll('.fed-self p.muted') ?? [])].filter((node) => node.textContent?.includes('Пусто — соседи'));
  assert.equal(updatedHints.length, 1, 'R280 редактирование не дублирует подсказку');
  const updatedHint = updatedHints[0];
  assert.ok(updatedHint?.textContent?.includes('Сохранённое имя'), 'подсказка не переключается на черновик');
  assert.ok(!updatedHint?.textContent?.includes('Черновик'), 'несохранённое значение не считается видимым соседям');
  assert.deepEqual(fixture.federationSetNameCalls, [], 'при показе подсказки имя автоматически не записывается');
  await unmount();
});

it('FederationPanel молчит, если название уже задано соседям или локального имени нет', async () => {
  // Подсказка нужна только при пустом удалённом имени и известном сохранённом локальном имени.
  for (const values of [
    { localName: 'Локальное', neighborName: 'Уже для соседей' },
    { localName: null, neighborName: null },
  ]) {
    resetFixture(values);
    await mount(FederationPanel);
    assert.equal([...(host?.querySelectorAll('.fed-self p.muted') ?? [])].some((node) => node.textContent?.includes('Пусто — соседи видят название инстанса')), false,
      'без полезного предупреждения подсказка не показывается');
    await unmount();
  }
});

it('InstanceSettingsPanel показывает подсказку только при federation строго true', async () => {
  // Старый backend может вернуть отсутствующий флаг; truthy-строка тоже не подтверждает включённую федерацию.
  for (const [federation, expected] of [[true, true], [false, false], ['true', false], [undefined, false]] as const) {
    resetFixture({ localName: 'Стая', federation });
    await mount(InstanceSettingsPanel);
    const hint = host?.querySelector('.inst-name-hint');
    assert.equal(!!hint, expected, `federation=${String(federation)}: подсказка соответствует строгому boolean`);
    if (expected) assert.ok(hint?.textContent?.toLowerCase().includes('соседи по федерации'), 'подсказка говорит о втором названии');
    await unmount();
  }
});
