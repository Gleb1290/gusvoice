import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import type { ConvGroupMember, UserSearchHit } from '@gusvoice/shared';
import * as dmRules from '../dmRules';
import * as contactRules from '../contactRules';
import * as groupRules from '../groupChatRules';

type Person = Pick<UserSearchHit, 'id' | 'username' | 'displayName' | 'avatarUrl'> & { homeInstance?: ConvGroupMember['homeInstance'] };
type PickerProps = { taken: readonly string[]; picked: Person[]; setPicked: (people: Person[]) => void; maxPick?: number };
const source = readFileSync(new URL('./GroupDialogs.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const own: Person = { id: 'local', username: 'local', displayName: 'Местный участник', avatarUrl: null };
const home = { instanceId: 'neighbor', name: '  Сосед  ', domain: 'neighbor.example.test', reports: true };
const remote: Person = { id: 'shadow', username: 'remote', displayName: 'Участник соседа', avatarUrl: null, homeInstance: home };
const unused = () => assert.fail('граница вне контракта PeoplePicker');
const noView = () => null;

async function pickerScene(options: { features: string[]; maxPick?: number; person?: Person }, check: (f: {
  host: HTMLDivElement; changes: Person[][]; clickPerson(id: string): Promise<void>;
}) => Promise<void>, raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const priorAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    const person = options.person ?? remote;
    // Сосед находится в настоящем источнике собеседников 1:1, местный — в ростере.
    const state = { members: [{ user: own }], dms: [{ otherUser: person }], user: { id: 'me' }, serverFeatures: options.features };
    const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
    const dependencies: Record<string, unknown> = {
      react: React, 'react/jsx-runtime': jsx,
      '../api': { api: { searchUsers: unused } }, '../confirm': { confirmAction: unused },
      '../dialogChrome': { useDialogChrome: noView }, '../dmRules': dmRules,
      '../groupChatRules': groupRules, '../dmOnline': { useVisibleOnline: () => new Set<string>() },
      '../phoneLayout': { usePhoneLayout: () => false }, '../contactRules': contactRules,
      '../contacts': { useContactList: () => [] },
      '../peerName': { usePeerName: () => (_id: string, fallback: string) => fallback },
      '../store': { useStore }, '../useContactSeen': { useContactSeen: () => new Map<string, string>() },
      '../toast': { toast: unused, toastError: unused },
      './Avatar': { Avatar: noView }, './BottomSheet': { BottomSheet: noView },
      './Icon': { Icon: noView }, './SharedMedia': { SharedMediaRows: noView }, './ServerActionModals': { CreateServerModal: noView },
    };
    const module = { exports: {} as { PeoplePicker: React.ComponentType<PickerProps> } };
    // Целиком исполняется GroupDialogs: неизвестный импорт запрещён, правила федерации настоящие.
    runInNewContext(ts.transpileModule(raw, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText, { module, exports: module.exports, window, document,
      require: (id: string) => {
        assert.ok(Object.hasOwn(dependencies, id), `неописанная граница GroupDialogs ${id}`);
        return dependencies[id];
      } });
    const changes: Person[][] = [];
    function ControlledPicker() {
      const [picked, setPicked] = React.useState<Person[]>([]);
      return React.createElement(module.exports.PeoplePicker, { taken: ['me'], picked, maxPick: options.maxPick,
        setPicked: (next: Person[]) => { changes.push(next); setPicked(next); } });
    }
    await React.act(async () => { root.render(React.createElement(ControlledPicker)); await Promise.resolve(); });
    await check({ host, changes, clickPerson: async (id: string) => {
      const username = id === own.id ? own.username : person.username;
      const row = [...host.querySelectorAll<HTMLButtonElement>('.group-pick')].find(el => el.textContent?.includes(`@${username}`));
      assert.equal(!!row, true, `доступна строка кандидата ${id}`);
      await React.act(async () => row!.click());
    } });
  } finally {
    try { await React.act(async () => root.unmount()); }
    finally {
      host.remove();
      try { await GlobalRegistrator.unregister(); }
      finally {
        if (priorAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', priorAct);
        else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      }
    }
  }
}

async function checkEligibility(features: string[], maxPick: number | undefined, raw = source) {
  await pickerScene({ features, maxPick }, async ({ host }) => {
    const rows = [...host.querySelectorAll('.group-pick')].map(el => el.textContent ?? '');
    const visible = features.includes('fedm6') && maxPick === undefined;
    assert.equal(rows.some(text => text.includes('@local')), true, 'местный кандидат остаётся доступным при любом признаке и потолке');
    assert.equal(rows.some(text => text.includes('@remote')), visible, 'сосед виден только при fedm6 без maxPick');
    assert.equal(rows.length, visible ? 2 : 1, 'скрытие не подменяется пустой строкой или дублем кандидата');
  }, raw);
}

// Ловит утечку теневых пользователей при выключенной федерации и ложное скрытие своих кандидатов.
it('R206 PeoplePicker скрывает соседа без fedm6 и показывает с fedm6, местный остаётся в обоих состояниях', async () => {
  for (const features of [[], ['fedm5'], ['fedm6']]) await checkEligibility(features, undefined);
});

// Ловит приватностную дыру, если исключение со своим лимитом выбора начнёт видеть соседей.
it('R206 PeoplePicker с собственным maxPick не предлагает соседа даже при fedm6, местный остаётся', async () => {
  // Ноль тоже передан явно: проверка truthiness вместо undefined не должна открыть исключения приватности гостю.
  for (const maxPick of [0, 1, 3]) await checkEligibility(['fedm6'], maxPick);
});

// Ловит потерю происхождения гостя между строкой, выбором и чипом, включая неизвестное имя инстанса.
for (const [name, personHome, title] of [
  ['название известно', home, 'С инстанса «Сосед»'],
  ['название и домен неизвестны', { instanceId: 'third', name: null, domain: '', reports: false }, 'С другого инстанса'],
] as const) it(`R206 PeoplePicker: ${name} — строка и чип имеют значок, выбор сохраняет весь homeInstance`, async () => {
  const person: Person = { ...remote, homeInstance: personHome };
  await pickerScene({ features: ['fedm6'], person }, async ({ host, changes, clickPerson }) => {
    const row = [...host.querySelectorAll('.group-pick')].find(el => el.textContent?.includes('@remote'));
    assert.equal(!!row, true, 'сосед доступен для выбора');
    assert.equal(row!.querySelectorAll('.guest-mark').length, 1, 'у строки один значок инстанса');
    assert.equal(row!.querySelector('.guest-mark')?.getAttribute('title'), title);
    assert.equal(row!.querySelector('.guest-mark')?.getAttribute('aria-label'), title);
    assert.equal([...host.querySelectorAll('.group-pick')].find(el => el.textContent?.includes('@local'))?.querySelector('.guest-mark'), null,
      'местному не рисуется фиктивный инстанс');
    await clickPerson(remote.id);
    assert.equal(changes.length, 1, 'один клик передаёт один выбор');
    assert.equal(changes[0].length, 1);
    assert.equal(changes[0][0].homeInstance, personHome, 'setPicked сохраняет объект дома, а не только ID или название');
    // Массив и объект выбора созданы в VM: сравниваем JSON-форму, не прототипы разных realm.
    assert.deepEqual(JSON.parse(JSON.stringify(changes[0])), [person], 'в callback передан полный участник с homeInstance');
    const chip = host.querySelector<HTMLButtonElement>('.group-chip');
    assert.equal(!!chip, true, 'выбор создаёт настоящий чип');
    assert.equal(chip!.querySelectorAll('.guest-mark').length, 1, 'у чипа один значок инстанса');
    assert.equal(chip!.querySelector('.guest-mark')?.getAttribute('title'), title);
    assert.equal(chip!.querySelector('.guest-mark')?.getAttribute('aria-label'), title);
    await React.act(async () => chip!.click());
    assert.equal(changes.length, 2, 'чип снимает выбор тем же callback');
    assert.equal(changes[1].length, 0);
    assert.equal(host.querySelector('.group-chip'), null);
  });
});

// Оба address-specific мутанта сначала проходят на оригинале, затем должны упасть именно на видимости соседа.
for (const [name, anchor, replacement, features, maxPick] of [
  ['maxPick ошибочно допускает соседа',
    'const fedGroups = useStore((s) => serverFedGroups(s.serverFeatures)) && maxPick === undefined;',
    'const fedGroups = useStore((s) => serverFedGroups(s.serverFeatures));', ['fedm6'], 1],
  ['сосед ошибочно допускается без fedm6', 'groupPickable(u, fedGroups)', 'groupPickable(u, true)', [], undefined],
] as const) it(`R206 PeoplePicker мутант «${name}» отвергается тем же сценарием после оригинала`, async () => {
  await checkEligibility([...features], maxPick);
  assert.equal(source.split(anchor).length - 1, 1, 'один точный якорь мутации целого GroupDialogs');
  await assert.rejects(checkEligibility([...features], maxPick, source.replace(anchor, replacement)),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('сосед виден только при fedm6 без maxPick'));
});
