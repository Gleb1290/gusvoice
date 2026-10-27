import assert from 'node:assert/strict';
import { it } from 'node:test';
import { BOT_PER_USER_LIMIT_MAX, type BotSettings } from '@gusvoice/shared';
import * as adminNav from '../adminNav';
import * as guestAt from '../guestAtMark';
import { React, environment, load, sourceOf, readClient, uiDependencies, bot, button, click, input, tick, assertion, mutate } from './R297.bot.harness';

const raw = sourceOf('AdminPanel');
type Options = { enabled?: boolean; bots?: number; confirm?: boolean | Promise<boolean> };
type Scene = { host: HTMLDivElement; patches: Partial<BotSettings>[]; confirmations: Record<string, unknown>[];
  main(): HTMLButtonElement; limit(): HTMLInputElement; save(): HTMLButtonElement };
async function fixture(check: (f: Scene) => Promise<void>, options: Options = {}, source = raw) {
  await environment(async (host, render) => {
    const patches: Partial<BotSettings>[] = [], confirmations: Record<string, unknown>[] = [];
    let settings: BotSettings = { enabled: options.enabled ?? true, creators: 'all', perUserLimit: 10, allowInternalWebhooks: false };
    const store = { adminInstanceId: null };
    const useStore = (select: (s: typeof store) => unknown) => select(store);
    const deps = uiDependencies(useStore);
    const phone = load<typeof import('../phoneLayout')>(readClient('../phoneLayout.ts'), { './hotkeys': { isMobile: () => false, isTauri: () => false } });
    const shell = load<typeof import('./SettingsShell')>(sourceOf('SettingsShell'), { './Icon': deps['./Icon'], '../phoneLayout': phone });
    const unused = () => assert.fail('вкладка вне тестируемого раздела ботов');
    const api = { adminUsers: async () => [], adminServers: async () => [], federationDirectory: async () => ({ enabled: false, peers: [] }),
      adminBotSettings: async () => ({ ...settings }),
      adminBots: async () => Array.from({ length: options.bots ?? 1 }, (_, i) => ({ ...bot, id: `test-bot-${i}`, owner: { id: 'owner', username: 'test_user', displayName: null } })),
      adminSetBotSettings: async (patch: Partial<BotSettings>) => { patches.push({ ...patch }); settings = { ...settings, ...patch }; return { ...settings }; },
    };
    const { AdminPanel } = load<typeof import('./AdminPanel')>(source, { ...deps, '../adminApi': { adminApi: () => api },
      '../config': { instances: () => [] }, '../adminNav': adminNav, '../guestAtMark': guestAt,
      '../toast': { toast: () => {}, toastError: () => assert.fail('неожиданная ошибка админки') },
      '../confirm': { confirmAction: async (request: Record<string, unknown>) => { confirmations.push(request); return await (options.confirm ?? true); } },
      './SettingsShell': shell, './DmReports': { DmReports: unused }, './FederationPanel': { FederationPanel: unused },
      './InstanceSettingsForms': { InstanceSettingsPanel: unused }, './AdminPeerGroups': { PeerUsersGroup: unused, PeerServersGroup: unused, ServerFederationCell: unused },
      './SmtpForm': { SmtpForm: unused },
    }, { Error, setTimeout, clearTimeout });
    await render(React.createElement(AdminPanel, { onClose: unused })); await tick();
    const tab = host.querySelector<HTMLButtonElement>('#admin-tab-bots'); assert.equal(!!tab, true); await click(tab!);
    await check({ host, patches, confirmations,
      main: () => host.querySelector<HTMLButtonElement>('button[aria-labelledby="admin-bots-enabled"]')!,
      limit: () => host.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!,
      save: () => button(host, 'Сохранить лимит'),
    });
  });
}

async function confirmProbe(source = raw, approved = false) {
  let finish!: (answer: boolean) => void;
  const pending = new Promise<boolean>(resolve => { finish = resolve; });
  try {
    await fixture(async f => {
      await click(f.main());
      assert.equal(f.confirmations.length, 1, 'R297-admin-confirm');
      assert.equal(f.confirmations[0].tone, 'danger');
      assert.equal(f.confirmations[0].title, 'Выключить ботов на этом сервере?');
      assert.equal(f.confirmations[0].icon, 'alert-circle', 'R300-admin-disable-icon');
      assert.equal(String(f.confirmations[0].body).includes('(1)'), true);
      assert.equal(f.patches.length, 0, 'подтверждение дожидается ответа');
      finish(approved); await tick();
      assert.deepEqual(f.patches, approved ? [{ enabled: false }] : []);
      assert.equal(f.main().getAttribute('aria-checked'), String(!approved));
    }, { confirm: pending }, source);
  } finally { finish(false); }
}
for (const approved of [false, true]) it(`R297 выключение с живым ботом: danger, ${approved ? 'подтверждение гасит' : 'отмена сохраняет'} включённость`, () => confirmProbe(raw, approved));
it('R297 включение не спрашивает подтверждения даже при существующем боте', async () => {
  await fixture(async f => { await click(f.main()); assert.deepEqual(f.confirmations, []); assert.deepEqual(f.patches, [{ enabled: true }]);
    assert.equal(f.main().getAttribute('aria-checked'), 'true'); assert.equal(f.limit().disabled, false);
  }, { enabled: false });
});
it('R297 выключение без ботов не спрашивает подтверждения', async () => {
  await fixture(async f => { await click(f.main()); assert.deepEqual(f.confirmations, []); assert.deepEqual(f.patches, [{ enabled: false }]); }, { bots: 0 });
});
async function offProbe(source = raw) {
  await fixture(async f => {
    const rest = f.host.querySelector('.admin-bots-rest'); assert.equal(!!rest, true);
    assert.equal(rest!.getAttribute('aria-disabled'), 'true'); assert.equal(rest!.classList.contains('admin-bots-off'), true);
    const controls = [...rest!.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')];
    assert.equal(controls.length, 6); // Три политики, лимит, сохранение, внутренние адреса.
    for (const control of controls) assert.equal(control.disabled, true, 'R297-admin-off-controls');
    assert.equal(f.main().disabled, false);
    for (const control of controls) if (control instanceof HTMLButtonElement) await click(control);
    assert.deepEqual(f.patches, []); assert.deepEqual(f.confirmations, []);
    assert.equal(f.host.querySelectorAll('.admin-table tbody tr').length, 1);
    assert.equal(f.host.textContent?.includes('Не работает: боты выключены'), true);
  }, { enabled: false }, source);
}
it('R297 общий выключатель блокирует остальные настройки, но не таблицу и включение', () => offProbe());
it('R297 включённый раздел разрешает остальные настройки, неизменённый лимит не сохраняется', async () => {
  await fixture(async f => {
    assert.equal(f.host.querySelector('.admin-bots-rest')?.hasAttribute('aria-disabled'), false);
    assert.equal(f.host.querySelectorAll('.reg-policy input:disabled').length, 0); assert.equal(f.limit().disabled, false);
    assert.equal(f.host.querySelector<HTMLButtonElement>('button[aria-labelledby="admin-bots-internal"]')?.disabled, false);
    assert.equal(f.save().disabled, true); await click(f.save()); assert.deepEqual(f.patches, []);
  });
});
for (const value of ['-1', String(BOT_PER_USER_LIMIT_MAX + 1), '1.5', '', 'NaN']) it(`R297 лимит «${value}» не проходит до API`, async () => {
  await fixture(async f => { await input(f.limit(), value); assert.equal(f.save().disabled, true, 'R297-admin-limit-invalid');
    assert.equal(f.limit().getAttribute('aria-invalid'), 'true'); await click(f.save()); assert.deepEqual(f.patches, []); });
});
for (const value of [0, BOT_PER_USER_LIMIT_MAX]) it(`R297 граница лимита ${value} сохраняется отдельным частичным запросом`, async () => {
  await fixture(async f => { await input(f.limit(), String(value)); assert.equal(f.save().disabled, false, 'R297-admin-limit-valid');
    await click(f.save()); assert.deepEqual(f.patches, [{ perUserLimit: value }]); assert.equal(f.save().disabled, true); });
});
it('R297 включение внутренних адресов требует danger и посылает только эту настройку', async () => {
  await fixture(async f => { await click(f.host.querySelector<HTMLButtonElement>('button[aria-labelledby="admin-bots-internal"]')!);
    assert.equal(f.confirmations.length, 1); assert.equal(f.confirmations[0].tone, 'danger');
    assert.equal(f.confirmations[0].icon, 'shield', 'R300-admin-internal-icon');
    assert.equal(String(f.confirmations[0].body).includes('SSRF'), true); assert.deepEqual(f.patches, [{ allowInternalWebhooks: true }]);
  });
});
it('R297 контрфакт: выключение ботов без подтверждения', async () => {
  await confirmProbe();
  await assert.rejects(() => confirmProbe(mutate(raw, 'if (!on && bots && bots.length > 0) {', 'if (false) {')),
    assertion('R297-admin-confirm', 0, 1));
});
it('R297 контрфакт: верхняя граница лимита потеряна', async () => {
  const probe = async (source = raw) => fixture(async f => { await input(f.limit(), String(BOT_PER_USER_LIMIT_MAX + 1));
    assert.equal(f.save().disabled, true, 'R297-admin-limit-invalid'); }, {}, source);
  await probe();
  await assert.rejects(() => probe(mutate(raw, 'limitNum <= BOT_PER_USER_LIMIT_MAX', 'true')),
    assertion('R297-admin-limit-invalid', false, true));
});
it('R297 контрфакт: выключенный сервер оставляет доступной политику создателей', async () => {
  await offProbe();
  await assert.rejects(() => offProbe(mutate(raw, 'disabled={busy || !on}\n                  onChange={() => void save({ creators: c.value })}',
    'disabled={busy}\n                  onChange={() => void save({ creators: c.value })}')),
  assertion('R297-admin-off-controls', false, true));
});
it('R300 отмена разрешения внутренних адресов не меняет настройку до или после ответа', async () => {
  let finish!: (answer: boolean) => void;
  const pending = new Promise<boolean>(resolve => { finish = resolve; });
  try {
    await fixture(async f => {
      const toggle = f.host.querySelector<HTMLButtonElement>('button[aria-labelledby="admin-bots-internal"]')!;
      await click(toggle);
      assert.equal(f.confirmations.length, 1); assert.equal(f.confirmations[0].icon, 'shield');
      assert.deepEqual(f.patches, []); assert.equal(toggle.getAttribute('aria-checked'), 'false');
      finish(false); await tick();
      assert.deepEqual(f.patches, []); assert.equal(toggle.getAttribute('aria-checked'), 'false');
    }, { confirm: pending });
  } finally { finish(false); }
});
it('R300 контрфакт: выключение ботов показывает корзину вместо предупреждения', async () => {
  await confirmProbe();
  await assert.rejects(() => confirmProbe(mutate(raw, "icon: 'alert-circle',", "icon: 'trash',")),
    assertion('R300-admin-disable-icon', 'trash', 'alert-circle'));
});
it('R300 контрфакт: разрешение внутренних адресов потеряло щит безопасности', async () => {
  const probe = (source = raw) => fixture(async f => {
    await click(f.host.querySelector<HTMLButtonElement>('button[aria-labelledby="admin-bots-internal"]')!);
    assert.equal(f.confirmations[0].icon, 'shield', 'R300-admin-internal-icon');
  }, {}, source);
  await probe();
  await assert.rejects(() => probe(mutate(raw, "icon: 'shield',", "icon: 'trash',")),
    assertion('R300-admin-internal-icon', 'trash', 'shield'));
});
