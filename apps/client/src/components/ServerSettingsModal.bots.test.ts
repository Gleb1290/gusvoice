import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
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
    } }, { timeout: 1000 });
  return module.exports as T;
}
function render(perms: bigint, raw = source, tabModule = tabs, options: { superAdmin?: boolean; economyShown?: boolean } = {}) {
  let stateHooks = 0, stateUpdates = 0;
  const safety = (ok: boolean, label: string) => { if (!ok) throw new Error(`R363/modal/budget/${label}`); };
  const boundedReact = { ...React, useState<T>(initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
    safety(++stateHooks <= 200, 'state-hooks');
    const [value, dispatch] = React.useState(initial);
    const update = React.useCallback((next: React.SetStateAction<T>) => {
      safety(++stateUpdates <= 200, 'state-updates'); dispatch(next);
    }, [dispatch]);
    return [value, update];
  } };
  const empty = () => null;
  const children = (props: { children?: React.ReactNode }) => React.createElement('div', null, props.children);
  const state = { bootstrap: { permissions: perms.toString() }, user: { id: 'me', superAdmin: options.superAdmin === true } };
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared, react: boundedReact, 'react/jsx-runtime': jsx,
    '../androidBack': { pushBackHandler: () => () => {} }, '../api': { api: {} }, '../config': { config: {} },
    '../dialogChrome': { useDialogChrome: () => React.useRef(null), tabListKeyDown: () => () => {} },
    '../store': { useStore: (select: (value: typeof state) => unknown) => select(state) },
    '../toast': { toast: empty, toastError: empty }, '../confirm': { confirmAction: empty },
    '../economyVisible': { economyVisible: () => options.economyShown === true }, '../serverSettingsTabs': tabModule,
    './SettingsShell': { SettingsWindow: (props: { rail: React.ReactNode; children: React.ReactNode }) => React.createElement('div', null, props.rail, props.children),
      SettingsRail: children, SettingsHead: empty, RailItem: (props: { label: string }) => React.createElement('span', null, props.label) },
    './ServerBotsPanel': { ServerBotsPanel: (props: { serverId: string; ownerId: string; onOpenRole?: unknown }) => React.createElement('section',
      { 'data-panel': 'bots', 'data-server': props.serverId, 'data-owner': props.ownerId, 'data-roles': String(!!props.onOpenRole) }) },
    './ChannelWebhooksPanel': { ServerWebhooksPanel: () => React.createElement('section', { 'data-panel': 'webhooks' }) },
  };
  for (const name of ['AvatarCropModal', 'AuditLogView', 'BansPanel', 'CategoryPermissionsEditor', 'Icon', 'ServerRolesPanel', 'ServerEmojiPanel',
    'ServerStickerPanel', 'EconomyPanel', 'GamesSettingsPanel', 'ServerSoundboardPanel', 'ServerSoundsPanel', 'Select']) deps[`./${name}`] = { [name]: empty };
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
  probe(load<typeof tabs>(tabsSource, { '@gusvoice/shared': shared }));
  counterfact(() => {
    const anchor = 'anyOf: [Permission.MANAGE_WEBHOOKS, Permission.MANAGE_SERVER]';
    assert.equal(tabsSource.split(anchor).length - 1, 1);
    const mutant = load<typeof tabs>(tabsSource.replace(anchor, 'anyOf: [Permission.MANAGE_WEBHOOKS]'), { '@gusvoice/shared': shared });
    assert.throws(() => probe(mutant), (e: unknown) => e instanceof assert.AssertionError && e.operator === 'strictEqual' &&
      e.message.split('\n')[0] === 'R303 администратор ботов входит без права вебхуков' && e.actual === false && e.expected === true);
  });
});

it('R363 Игры видит только супер-админ: все права обычного администратора не обходят скрытие', () => {
  const address = 'R363/modal/check/игры-только-супер-админу';
  const check = (raw: string) => {
    for (const superAdmin of [false, true]) {
      // Реальные serverSettingsTabs получают флаги из настоящей модалки; подменены только дочерние панели и store.
      const html = render(shared.Permission.ADMINISTRATOR, raw, tabs, { superAdmin, economyShown: true });
      assert.equal(html.includes('<span>Монеты</span>'), true, 'R363/modal/check/экономика-видима');
      assert.equal(html.includes('<span>Игры</span>'), superAdmin, address);
      assert.equal(html.includes('data-panel="bots"'), true, 'R363/modal/check/интеграции-не-потеряны');
    }
  };
  check(source);
  counterfact(() => {
    const from = 'const gamesShown = useStore((s) => s.user?.superAdmin === true);';
    assert.equal(source.split(from).length - 1, 1, 'R363/modal/setup/единственный-якорь');
    assert.throws(() => check(source.replace(from, 'const gamesShown = true;')), error => error instanceof assert.AssertionError
      && error.message.split('\n')[0] === address, 'мутант убит показом пункта, не импортом/SSR или бюджетом');
  });
  check(source);
});
