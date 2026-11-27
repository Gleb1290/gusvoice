import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import type { Role } from '@gusvoice/shared';
import { React, environment, mutate } from './R171.phoneHarness';
import { Toggle } from './Toggle';

const source = readFileSync(new URL('./ServerRolesPanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const P = 'R364/games/check/';
const label = 'Проводить ставки';
const base = shared.Permission.VIEW_CHANNEL | shared.Permission.SPEAK | shared.Permission.MANAGE_ECONOMY;
const prediction = shared.Permission.MANAGE_PREDICTIONS;
type Saved = { id: string; permissions: string };
type Fixture = {
  host: HTMLDivElement;
  saved: Saved[];
  refreshes: string[];
  click: (button: HTMLButtonElement) => Promise<void>;
};

function switches(host: ParentNode, name: string): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('button[role="switch"]')]
    .filter(button => {
      const id = button.getAttribute('aria-labelledby');
      return button.getAttribute('aria-label') === name || (id && button.ownerDocument.getElementById(id)?.textContent === name);
    });
}
function oneSwitch(host: ParentNode, name: string) {
  const found = switches(host, name);
  assert.equal(found.length, 1, `R364/games/setup/переключатель:${name}`);
  return found[0];
}
function saveButton(host: ParentNode) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')]
    .filter(button => button.textContent?.trim() === 'Сохранить');
  assert.equal(found.length, 1, 'R364/games/setup/сохранить');
  return found[0];
}

async function fixture(raw: string, superAdmin: boolean, initial: bigint, check: (f: Fixture) => Promise<void>) {
  await environment(async (host, render) => {
    const counts = new Map<string, number>();
    const step = (kind: string) => {
      const count = (counts.get(kind) ?? 0) + 1; counts.set(kind, count);
      if (count > 200) throw new Error(`R364/games/budget/${kind}`);
    };
    let role: Role = { id: 'role-one', serverId: 'server-one', name: 'Участники', color: 0,
      permissions: initial.toString(), position: 1, hoist: false, isEveryone: false,
      mentionable: false, membersCanAssign: false };
    const saved: Saved[] = [], refreshes: string[] = [];
    const state = { bootstrap: { permissions: shared.Permission.ADMINISTRATOR.toString() }, user: { id: 'member-one', superAdmin } };
    const useStore = Object.assign((select: (value: typeof state) => unknown) => {
      step('store'); return select(state);
    }, { getState: () => ({ openServer: async (id: string) => { step('IO'); refreshes.push(id); } }) });
    const api = {
      async listRoles(id: string) {
        step('IO'); assert.equal(id, 'server-one', 'R364/games/setup/listRoles-id'); return [{ ...role }];
      },
      async listMembers(id: string) {
        step('IO'); assert.equal(id, 'server-one', 'R364/games/setup/listMembers-id'); return [];
      },
      async updateRole(id: string, body: Pick<Role, 'name' | 'color' | 'permissions' | 'mentionable' | 'membersCanAssign'>) {
        step('IO'); saved.push({ id, permissions: body.permissions }); role = { ...role, ...body }; return { ...role };
      },
    };
    const unused = () => { throw new Error('R364/games/setup/неожиданная-граница'); };
    const dependencies: Record<string, unknown> = {
      '@gusvoice/shared': shared,
      react: {
        useRef: React.useRef,
        useState(initialValue: unknown) {
          step('hooks');
          const [value, setValue] = React.useState(initialValue);
          return [value, (next: unknown) => { step('setState'); setValue(next); }];
        },
        useEffect(effect: React.EffectCallback, deps?: React.DependencyList) {
          step('hooks'); React.useEffect(effect, deps);
        },
      },
      'react/jsx-runtime': jsx,
      '../api': { api: new Proxy(api, { get(target, key) {
        return Object.hasOwn(target, key) ? target[key as keyof typeof api] : unused;
      } }) },
      '../store': { useStore }, '../confirm': { confirmAction: unused },
      './Toggle': { Toggle },
      '../phoneLayout': { usePhoneLayout: () => false },
      './RoleAppearancePicker': { RoleAppearancePicker: unused },
      './RolePeopleEditor': { RolePeopleEditor: unused, ServerPeopleDirectory: unused },
      './roles-editor.css': {},
    };
    const module = { exports: {} };
    // Целый настоящий модуль, настоящие shared-правила и Toggle; предметные handlers не подменяются.
    // Обёртки хуков лишь считают вызовы и передают их настоящему React/ReactDOM из R171.
    runInNewContext(ts.transpileModule(raw, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText, { module, exports: module.exports, require: (id: string) => {
      if (!Object.hasOwn(dependencies, id)) throw new Error(`R364/games/setup/import:${id}`);
      return dependencies[id];
    } }, { timeout: 200 });
    const panel = module.exports as { ServerRolesPanel: (props: Record<string, unknown>) => React.ReactNode };
    function Panel() {
      step('render');
      return panel.ServerRolesPanel({ serverId: 'server-one', ownerId: 'owner-one', selfId: 'member-one',
        canManageRoles: true, canKick: false, view: 'roles', initialRoleId: 'role-one' });
    }
    step('update'); await render(React.createElement(Panel));
    await check({ host, saved, refreshes, click: async button => {
      assert.equal(button.disabled, false, 'R364/games/setup/действие-доступно');
      await React.act(async () => {
        step('events'); button.click();
        for (let turn = 0; turn < 8; turn++) { step('steps'); await Promise.resolve(); }
      });
    } });
  });
}

async function ordinary(raw = source) {
  await fixture(raw, false, base | prediction, async f => {
    assert.equal(switches(f.host, label).length, 0, P + 'обычному-строка-скрыта');
    assert.equal(f.host.textContent?.includes(label), false, P + 'нет-и-видимой-подписи');
    assert.equal(f.saved.length, 0, P + 'открытие-не-сохраняет');
    const other = oneSwitch(f.host, 'Писать сообщения');
    assert.equal(other.getAttribute('aria-checked'), 'false', P + 'другое-право-сначала-выключено');
    await f.click(other);
    assert.equal(oneSwitch(f.host, 'Писать сообщения').getAttribute('aria-checked'), 'true', P + 'другое-право-изменилось');
    assert.equal(switches(f.host, label).length, 0, P + 'после-изменения-строка-скрыта');
    await f.click(saveButton(f.host));
    assert.equal(f.saved.length, 1, P + 'одно-сохранение');
    assert.equal(f.saved[0].id, 'role-one', P + 'сохраняется-выбранная-роль');
    const expected = base | prediction | shared.Permission.SEND_MESSAGES;
    assert.equal(f.saved[0].permissions, expected.toString(), P + 'сохранение-меняет-только-другое-право');
    assert.equal(BigInt(f.saved[0].permissions) & prediction, prediction, P + 'скрытый-бит-сохранён');
    assert.equal(f.refreshes.join(','), 'server-one', P + 'дерево-обновлено-один-раз');
  });
}

it('R364 обычный администратор не видит право ставок, а сохранение другого права сохраняет скрытый бит', async () => {
  await ordinary();
});

it('R364 супер-админ видит checked из маски и переключает ровно бит ставок в обе стороны', async () => {
  for (const enabled of [false, true]) {
    const initial = enabled ? base | prediction : base;
    await fixture(source, true, initial, async f => {
      assert.equal(switches(f.host, label).length, 1, P + 'супер-админу-строка-видима');
      assert.equal(oneSwitch(f.host, label).getAttribute('aria-checked'), String(enabled), P + 'checked-из-маски');
      await f.click(oneSwitch(f.host, label));
      assert.equal(oneSwitch(f.host, label).getAttribute('aria-checked'), String(!enabled), P + 'checked-после-переключения');
      await f.click(saveButton(f.host));
      assert.equal(f.saved.length, 1, P + 'первое-переключение-сохранено');
      assert.equal(f.saved[0].permissions, (initial ^ prediction).toString(), P + 'первый-PATCH-меняет-только-бит-ставок');
      await f.click(oneSwitch(f.host, label));
      assert.equal(oneSwitch(f.host, label).getAttribute('aria-checked'), String(enabled), P + 'обратное-переключение');
      await f.click(saveButton(f.host));
      assert.equal(f.saved.length, 2, P + 'второе-переключение-сохранено');
      assert.equal(f.saved[1].permissions, initial.toString(), P + 'второй-PATCH-возвращает-исходную-маску');
      assert.equal(f.saved.map(value => value.id).join(','), 'role-one,role-one', P + 'оба-PATCH-на-выбранную-роль');
    });
  }
});

for (const [title, anchor, replacement] of [
  ['убранного фильтра', "PERMS.filter(({ key }) => gamesShown || key !== 'MANAGE_PREDICTIONS').map(", 'PERMS.map('],
  ['постоянного gamesShown', 'const gamesShown = useStore((s) => s.user?.superAdmin === true);', 'const gamesShown = true;'],
] as const) {
  it(`R364 контрфакт ${title} адресно обнаруживает лишнюю строку обычному администратору`, async () => {
    await ordinary();
    await counterfact(async () => {
      await assert.rejects(ordinary(mutate(source, anchor, replacement)), error => error instanceof assert.AssertionError
        && error.message.startsWith(P + 'обычному-строка-скрыта') && error.actual === 1 && error.expected === 0,
      'контрфакт убит лишним переключателем, не ошибкой setup, загрузки или бюджета');
    });
    await ordinary();
  });
}
