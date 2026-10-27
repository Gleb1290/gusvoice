import assert from 'node:assert/strict';
import { it } from 'node:test';
import { React, environment, icon, load, mutate, sourceOf } from './R171.phoneHarness';
import * as dmRules from '../dmRules';
import * as groupRules from '../groupChatRules';
import * as contactRules from '../contactRules';
import type * as Dialogs from './GroupDialogs';

const source = sourceOf('GroupDialogs');
const me = { id: 'me', username: 'owner', displayName: 'Создатель', avatarUrl: null };
const outside = () => assert.fail('R304 действие вне сценария истории');
type Scenario = { owner?: boolean; former?: boolean; foreign?: boolean; history?: boolean | undefined; legacy?: boolean };
async function scene(options: Scenario, raw = source) {
  await environment(async (_host, render) => {
    const calls: [string, boolean][] = [];
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const state = { user: me, members: [], serverFeatures: [], dms: [{ id: 'group',
      otherUser: { ...me, id: 'group:group' }, group: { title: 'Гуси', avatarUrl: null,
        ownerId: options.owner === false ? 'other' : me.id, limit: 5,
        ...(options.legacy ? {} : { historyForNew: options.history ?? false }), members: [{ ...me, role: 'owner' }] } }],
      conv: { summaries: { group: { former: options.former, fedGroupHost: options.foreign ? { instanceId: 'neighbor', down: false } : null } } } };
    const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
    const noView = () => null;
    const mod = load<typeof Dialogs>(raw, {
      '../api': { api: { convGroupHistory: async (id: string, visible: boolean) => { calls.push([id, visible]); await pending; } } },
      '../confirm': { confirmAction: outside }, '../dialogChrome': { useDialogChrome: () => ({ current: null }) },
      '../dmRules': dmRules, '../groupChatRules': groupRules, '../contactRules': contactRules,
      '../phoneLayout': { usePhoneLayout: () => false }, '../contacts': { useContactList: () => [] },
      '../peerName': { usePeerName: () => (_id: string, fallback: string) => fallback },
      '../dmOnline': { useVisibleOnline: () => new Set<string>() }, '../useContactSeen': { useContactSeen: () => new Map() },
      '../store': { useStore }, '../toast': { toast: outside, toastError: outside },
      './Icon': { Icon: icon }, './Avatar': { Avatar: noView }, './BottomSheet': { BottomSheet: noView },
      './SharedMedia': { SharedMediaRows: noView }, './ServerActionModals': { CreateServerModal: noView },
    });
    await render(React.createElement(mod.GroupDialogHost));
    await React.act(async () => { mod.openGroupInfo('group'); });
    const toggle = document.querySelector<HTMLButtonElement>('button[aria-labelledby="group-history-new"]');
    const shown = options.owner !== false && !options.former && !options.foreign && !options.legacy;
    assert.equal(!!toggle, shown, 'история для новых только у действующего владельца своего дома');
    if (shown) {
      assert.equal(toggle!.getAttribute('role'), 'switch');
      assert.equal(toggle!.getAttribute('aria-checked'), String(options.history ?? false));
      assert.equal(!!toggle!.querySelector('.toggle-knob'), true);
      await React.act(async () => { toggle!.click(); });
      assert.deepEqual(calls, [['group', !(options.history ?? false)]]);
      assert.equal(toggle!.disabled, true, 'пока сервер не ответил повторное нажатие недоступно');
      await React.act(async () => { finish(); await pending; });
      assert.equal(toggle!.disabled, false);
    } else assert.equal(calls.length, 0);
  });
}
for (const options of [{}, { history: true }, { owner: false }, { former: true }, { foreign: true }, { legacy: true }])
  it(`R304 история новых участников в настоящем GroupDialogs: ${JSON.stringify(options)}`, async () => { await scene(options); });
it('R304 контрфакт: переключатель рядовому участнику обнаруживается настоящей разметкой', async () => {
  await scene({ owner: false });
  await assert.rejects(scene({ owner: false }, mutate(source, 'owner && !fedHost && !former && group.historyForNew !== undefined',
    '!fedHost && !former && group.historyForNew !== undefined')),
  e => e instanceof assert.AssertionError && e.message.includes('только у действующего владельца'));
});
