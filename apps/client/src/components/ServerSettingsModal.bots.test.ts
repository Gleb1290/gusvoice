import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as tabs from '../serverSettingsTabs';

const source = readFileSync(new URL('./ServerSettingsModal.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const tabsSource = readFileSync(new URL('../serverSettingsTabs.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load<T>(raw: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, require(id: string) {
      assert.ok(Object.hasOwn(deps, id), `R303 закрытая граница настроек: ${id}`); return deps[id];
    } });
  return module.exports as T;
}
function render(perms: bigint, raw = source, tabModule = tabs) {
  const empty = () => null;
  const children = (props: { children?: React.ReactNode }) => React.createElement('div', null, props.children);
  const state = { bootstrap: { permissions: perms.toString() }, user: { id: 'me' } };
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared, react: React, 'react/jsx-runtime': jsx,
    '../androidBack': { pushBackHandler: () => () => {} }, '../api': { api: {} }, '../config': { config: {} },
    '../dialogChrome': { useDialogChrome: () => React.useRef(null), tabListKeyDown: () => () => {} },
    '../store': { useStore: (select: (value: typeof state) => unknown) => select(state) },
    '../toast': { toast: empty, toastError: empty }, '../confirm': { confirmAction: empty },
    '../economyVisible': { economyVisible: () => false }, '../serverSettingsTabs': tabModule,
    './SettingsShell': { SettingsWindow: (props: { rail: React.ReactNode; children: React.ReactNode }) => React.createElement('div', null, props.rail, props.children),
      SettingsRail: children, SettingsHead: empty, RailItem: (props: { label: string }) => React.createElement('span', null, props.label) },
    './ServerBotsPanel': { ServerBotsPanel: (props: { serverId: string; ownerId: string; onOpenRole?: unknown }) => React.createElement('section',
      { 'data-panel': 'bots', 'data-server': props.serverId, 'data-owner': props.ownerId, 'data-roles': String(!!props.onOpenRole) }) },
    './ChannelWebhooksPanel': { ServerWebhooksPanel: () => React.createElement('section', { 'data-panel': 'webhooks' }) },
  };
  for (const name of ['AvatarCropModal', 'AuditLogView', 'BansPanel', 'CategoryPermissionsEditor', 'Icon', 'ServerRolesPanel', 'ServerEmojiPanel',
    'ServerStickerPanel', 'EconomyPanel', 'ServerSoundboardPanel', 'ServerSoundsPanel', 'Select']) deps[`./${name}`] = { [name]: empty };
  const { ServerSettingsModal } = load<typeof import('./ServerSettingsModal')>(raw, deps);
  return renderToStaticMarkup(React.createElement(ServerSettingsModal, {
    server: { id: 'server-1', name: 'Тестовый сервер', ownerId: 'owner-1' } as shared.Server,
    categories: [], canDelete: false, onClose: empty, initialTab: 'integrations',
  }));
}
it('R303 Интеграции разделяют содержимое по правам: боты, вебхуки, оба блока или ни одного', () => {
  for (const [perms, bots, webhooks] of [[shared.Permission.MANAGE_SERVER, true, false], [shared.Permission.MANAGE_WEBHOOKS, false, true],
    [shared.Permission.MANAGE_SERVER | shared.Permission.MANAGE_WEBHOOKS, true, true], [0n, false, false]] as const) {
    const html = render(perms);
    assert.equal(html.includes('data-panel="bots"'), bots, 'R303 блок ботов управляется MANAGE_SERVER');
    assert.equal(html.includes('data-panel="webhooks"'), webhooks);
    if (bots && webhooks) assert.ok(html.indexOf('data-panel="bots"') < html.indexOf('data-panel="webhooks"'), 'боты идут первыми');
    if (bots) assert.ok(html.includes('data-server="server-1" data-owner="owner-1"'));
  }
});
it('R303 переход к роли бота предлагается только с MANAGE_ROLES', () => {
  assert.ok(render(shared.Permission.MANAGE_SERVER).includes('data-roles="false"'));
  assert.ok(render(shared.Permission.MANAGE_SERVER | shared.Permission.MANAGE_ROLES).includes('data-roles="true"'));
});
it('R303 контрфакт двери Интеграций только по вебхукам не прячется за проверкой содержимого', () => {
  const probe = (tabModule: typeof tabs) => assert.equal(render(shared.Permission.MANAGE_SERVER, source, tabModule).includes('data-panel="bots"'), true,
    'R303 администратор ботов входит без права вебхуков');
  probe(tabs);
  const anchor = 'anyOf: [Permission.MANAGE_WEBHOOKS, Permission.MANAGE_SERVER]';
  assert.equal(tabsSource.split(anchor).length - 1, 1);
  probe(load<typeof tabs>(tabsSource, { '@gusvoice/shared': shared }));
  const mutant = load<typeof tabs>(tabsSource.replace(anchor, 'anyOf: [Permission.MANAGE_WEBHOOKS]'), { '@gusvoice/shared': shared });
  assert.throws(() => probe(mutant), (e: unknown) => e instanceof assert.AssertionError && e.operator === 'strictEqual' &&
    e.message.split('\n')[0] === 'R303 администратор ботов входит без права вебхуков' && e.actual === false && e.expected === true);
});
