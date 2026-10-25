import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import type { FederationOverview, FederationSwitchPatch, FederationSwitchView } from '@gusvoice/shared';
import { React, environment, load, mutate } from './R171.phoneHarness';
import { Toggle } from './Toggle';
import * as overview from '../fedOverview';
import { count } from '../plural';
import { formatBytes, gigabytesToBytes } from '../byteSize';

const source = readFileSync(new URL('./FederationPanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Switch = FederationSwitchView;
type Options = {
  sw?: Partial<Switch>;
  switchError?: number;
  overviewError?: number;
  refusal?: string;
  confirm?: boolean | Promise<boolean>;
  patchWait?: Promise<void>;
};
const error = (status: number, message = `http-${status}`) => Object.assign(new Error(message), { status });
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(check: (f: {
  host: HTMLDivElement; patches: FederationSwitchPatch[]; confirmations: Record<string, unknown>[]; errors: unknown[];
  click(button: HTMLButtonElement): Promise<void>; tick(): Promise<void>; reads: { switch: number; overview: number };
}) => Promise<void>, options: Options = {}, raw = source) {
  await environment(async (host, render) => {
    let sw: Switch = { enabled: false, source: 'off', dmEnabled: false, dmSource: 'off', status: 'off', problem: null, ...options.sw };
    const patches: FederationSwitchPatch[] = [], confirmations: Record<string, unknown>[] = [], errors: unknown[] = [];
    const reads = { switch: 0, overview: 0 };
    const api = {
      adminInstance: async () => ({ name: 'Test instance' }),
      federationSwitch: async () => { reads.switch++; if (options.switchError) throw error(options.switchError); return { ...sw }; },
      federationOverview: async (): Promise<FederationOverview> => {
        reads.overview++;
        if (options.overviewError) throw error(options.overviewError);
        return { ...overview.FEDERATION_OFF, status: sw.status, problem: sw.problem, instance: sw.status === 'ready' ? {
          instanceId: 'local-instance', fingerprint: 'test-fingerprint', domain: 'local.example.test', name: null, iconHash: null,
        } : null };
      },
      federationSetSwitch: async (patch: FederationSwitchPatch): Promise<Switch> => {
        patches.push(JSON.parse(JSON.stringify(patch)) as FederationSwitchPatch);
        await options.patchWait;
        if (options.refusal) throw error(409, options.refusal);
        const enabled = patch.enabled ?? sw.enabled;
        const dmEnabled = enabled && (patch.dmEnabled ?? sw.dmEnabled);
        sw = { ...sw, enabled, dmEnabled, source: enabled ? 'panel' : 'off', dmSource: dmEnabled ? 'panel' : 'off',
          status: enabled ? 'ready' : 'off', problem: null };
        return { ...sw };
      },
    };
    const { FederationPanel } = load<{ FederationPanel: React.ComponentType }>(raw, {
      '../adminApi': { adminApi: () => api }, '../store': { useStore: (select: (s: { federationRev: number }) => unknown) => select({ federationRev: 0 }) },
      './FederationReports': { FederationReports: () => null }, './FederationAudit': { FederationAudit: () => null },
      './Toggle': { Toggle }, '../plural': { count }, '../byteSize': { formatBytes, gigabytesToBytes },
      '../toast': { toast: () => assert.fail('переключатель не должен показывать посторонний тост'), toastError: (e: unknown) => errors.push(e) },
      '../confirm': { confirmAction: async (request: Record<string, unknown>) => {
        confirmations.push(request); return await (options.confirm ?? true);
      }, alertDialog: () => assert.fail('переключатель не меняет ключ') },
      '../fedOverview': overview,
    }, { Error });
    const tick = async () => { await React.act(async () => { await nextTurn(); }); };
    await render(React.createElement(FederationPanel));
    await tick();
    await check({ host, patches, confirmations, errors, reads,
      click: async (button) => { await React.act(async () => { button.click(); await nextTurn(); }); }, tick });
  });
}

function switches(host: ParentNode): [HTMLButtonElement, HTMLButtonElement] {
  const block = host.querySelector('.fed-switch'); assert.ok(block, 'R257 новый сервер показывает тумблеры');
  const found = [...block.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
  assert.equal(found.length, 2, 'R257 ровно два тумблера федерации');
  return [found[0], found[1]];
}

async function envLockProbe(raw = source) {
  await fixture(async (f) => {
    const [fed, dm] = switches(f.host);
    assert.equal(fed.getAttribute('aria-checked'), 'true');
    assert.equal(fed.disabled, true, 'R257 федерация из env недоступна для выключения');
    assert.equal(dm.disabled, false, 'R257 ЛС из панели не наследуют env-блокировку другого тумблера');
    assert.ok(f.host.textContent?.includes(overview.switchSourceHint('env')!));
    await f.click(fed);
    assert.deepEqual(f.patches, []);
    assert.deepEqual(f.confirmations, []);
  }, { sw: { enabled: true, source: 'env', status: 'ready' } }, raw);
}
it('R257 федерация из env заблокирована, а доступный тумблер ЛС остаётся самостоятельным', async () => {
  // Нельзя предлагать выключение настройки, которую сервер всё равно отвергнет.
  await envLockProbe();
});

async function dmLockProbe(raw = source) {
  await fixture(async (f) => {
    const [fed, dm] = switches(f.host);
    assert.equal(fed.disabled, false);
    assert.equal(dm.disabled, true, 'R257 ЛС недоступны до включения федерации');
    assert.equal(dm.title, 'Сначала включите федерацию');
    await f.click(dm);
    assert.deepEqual(f.patches, []);
  }, {}, raw);
}
it('R257 ЛС заблокированы при выключенной федерации и не посылают PATCH', async () => {
  // Корректный статус off — не ошибка загрузки админки.
  await dmLockProbe();
});

it('R257 ЛС из env заблокированы, а федерация из панели доступна', async () => {
  await fixture(async (f) => {
    const [fed, dm] = switches(f.host);
    assert.equal(fed.disabled, false);
    assert.equal(dm.getAttribute('aria-checked'), 'true');
    assert.equal(dm.disabled, true);
    await f.click(dm);
    assert.deepEqual(f.patches, []);
  }, { sw: { enabled: true, source: 'panel', dmEnabled: true, dmSource: 'env', status: 'ready' } });
});

it('R257 включение федерации шлёт только enabled и открывает ЛС после перечитывания', async () => {
  // Отсутствующий dmEnabled не должен превратиться в неявное разрешение личных сообщений.
  await fixture(async (f) => {
    await f.click(switches(f.host)[0]);
    assert.deepEqual(f.patches, [{ enabled: true }]);
    assert.deepEqual(f.confirmations, []);
    const [fed, dm] = switches(f.host);
    assert.equal(fed.getAttribute('aria-checked'), 'true');
    assert.equal(dm.disabled, false);
    assert.equal(dm.getAttribute('aria-checked'), 'false');
    assert.equal(f.reads.switch, 2); assert.equal(f.reads.overview, 2);
    assert.deepEqual(f.errors, []);
  });
});

async function confirmProbe(raw = source) {
  let answer!: (ok: boolean) => void;
  const confirm = new Promise<boolean>((resolve) => { answer = resolve; });
  await fixture(async (f) => {
    try {
      await f.click(switches(f.host)[0]);
      assert.deepEqual(f.patches, [], 'R257 выключение ждёт подтверждения до PATCH');
      assert.equal(f.confirmations.length, 1);
      assert.equal(f.confirmations[0].tone, 'danger');
      assert.equal(f.confirmations[0].title, 'Выключить федерацию?');
      assert.match(String(f.confirmations[0].body), /Связки, ключ и настройки сохранятся/);
      answer(false); await f.tick();
      assert.deepEqual(f.patches, [], 'R257 отмена выключения не меняет сервер');
      assert.equal(switches(f.host)[0].getAttribute('aria-checked'), 'true');
    } finally { answer(false); }
  }, { sw: { enabled: true, source: 'panel', status: 'ready' }, confirm }, raw);
}
it('R257 выключение ждёт confirmAction, отмена оставляет федерацию включённой', async () => {
  // Deferred-подтверждение ловит также забытый await, а не только отказ после мгновенного ответа.
  await confirmProbe();
});

it('R257 подтверждённое выключение шлёт enabled:false и показывает сохранённый off', async () => {
  await fixture(async (f) => {
    await f.click(switches(f.host)[0]);
    assert.deepEqual(f.patches, [{ enabled: false }]);
    assert.equal(f.confirmations.length, 1);
    const [fed, dm] = switches(f.host);
    assert.equal(fed.getAttribute('aria-checked'), 'false');
    assert.equal(dm.disabled, true);
    assert.ok(f.host.textContent?.includes('Федерация выключена'));
    assert.deepEqual(f.errors, []);
  }, { sw: { enabled: true, source: 'panel', status: 'ready' }, confirm: true });
});

it('R257 ЛС включаются и выключаются отдельным patch без подтверждения и переключения федерации', async () => {
  await fixture(async (f) => {
    await f.click(switches(f.host)[1]);
    assert.deepEqual(f.patches, [{ dmEnabled: true }]);
    assert.equal(switches(f.host)[1].getAttribute('aria-checked'), 'true');
    await f.click(switches(f.host)[1]);
    assert.deepEqual(f.patches, [{ dmEnabled: true }, { dmEnabled: false }]);
    assert.equal(switches(f.host)[0].getAttribute('aria-checked'), 'true');
    assert.equal(switches(f.host)[1].getAttribute('aria-checked'), 'false');
    assert.deepEqual(f.confirmations, []);
  }, { sw: { enabled: true, source: 'panel', status: 'ready' } });
});

const restartHint = 'У кого приложение уже открыто, переписка с соседями появится после перезапуска приложения или обновления страницы.';

async function restartHintProbe(raw = source) {
  await fixture(async (f) => {
    const checkHint = (enabled: boolean, dmEnabled: boolean) => {
      const [fed, dm] = switches(f.host);
      assert.equal(fed.getAttribute('aria-checked'), String(enabled));
      assert.equal(dm.getAttribute('aria-checked'), String(dmEnabled));
      // Проверяем наличие сообщения в настоящем DOM, не геометрию: happy-dom layout не рассчитывает.
      const hints = [...f.host.querySelectorAll('.fed-switch p')].filter(p => p.textContent === restartHint);
      assert.equal(hints.length, enabled ? 1 : 0,
        `R290 подсказка перезапуска: enabled=${enabled}, dmEnabled=${dmEnabled}`);
    };
    checkHint(false, false);
    await f.click(switches(f.host)[0]);
    checkHint(true, false);
    await f.click(switches(f.host)[1]);
    checkHint(true, true);
    await f.click(switches(f.host)[1]);
    checkHint(true, false);
    await f.click(switches(f.host)[0]);
    checkHint(false, false);
    assert.deepEqual(f.patches, [{ enabled: true }, { dmEnabled: true }, { dmEnabled: false }, { enabled: false }]);
    assert.deepEqual(f.errors, []);
  }, {}, raw);
}

it('R290 подсказка перезапуска появляется и исчезает с федерацией, но не с тумблером ЛС в том же mount', async () => {
  // Уже открытая админка должна объяснять повторный вход и при выключенных ЛС, и после их включения.
  await restartHintProbe();
});

for (const [label, condition, message, actual, expected] of [
  ['подсказка всегда', 'true', 'R290 подсказка перезапуска: enabled=false, dmEnabled=false', 1, 0],
  ['подсказки никогда нет', 'false', 'R290 подсказка перезапуска: enabled=true, dmEnabled=false', 0, 1],
] as const) it(`R290 контрфакт: ${label}`, async () => {
  await restartHintProbe();
  const anchor = `{sw.enabled && (\n        <p className="muted">${restartHint}</p>`;
  const changed = mutate(source, anchor, `{${condition} && (\n        <p className="muted">${restartHint}</p>`);
  await assert.rejects(() => restartHintProbe(changed), (e: unknown) =>
    e instanceof assert.AssertionError && e.message.startsWith(message) &&
    e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
});

it('R257 незавершённый PATCH блокирует оба тумблера и не допускает второго запроса', async () => {
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  await fixture(async (f) => {
    try {
      await f.click(switches(f.host)[1]);
      const [fed, dm] = switches(f.host);
      assert.equal(fed.disabled, true); assert.equal(dm.disabled, true);
      await f.click(fed); await f.click(dm);
      assert.deepEqual(f.patches, [{ dmEnabled: true }]);
      finish(); await f.tick();
      assert.equal(switches(f.host)[0].disabled, false);
      assert.equal(switches(f.host)[1].disabled, false);
    } finally { finish(); await f.tick(); }
  }, { sw: { enabled: true, source: 'panel', status: 'ready' }, patchWait: wait });
});

it('R257 старый сервер с 404 на switch оставляет прежнее объяснение включения через env', async () => {
  // Поддержка нового метода не должна прятать инструкцию у старого backend без тумблеров.
  await fixture(async (f) => {
    assert.equal(f.host.querySelector('.fed-switch'), null);
    assert.ok(f.host.textContent?.includes('Федерация выключена'));
    assert.ok(f.host.textContent?.includes('FEDERATION_ENABLED=true'));
    assert.ok(f.host.textContent?.includes('FEDERATION_KEY_PASSPHRASE'));
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.patches, []);
  }, { switchError: 404, overviewError: 404 });
});

it('R257 новый сервер с 404 обзора всё равно даёт включить федерацию без env-инструкции', async () => {
  await fixture(async (f) => {
    switches(f.host);
    assert.ok(!f.host.textContent?.includes('FEDERATION_ENABLED=true'));
    assert.ok(f.host.textContent?.includes(overview.FED_BACKUP_NOTE));
    assert.deepEqual(f.errors, []);
  }, { overviewError: 404 });
});

it('R257 ошибка ключа из базы сохраняет тумблеры и объясняет совместный бэкап ключа и базы', async () => {
  // Тумблер должен позволить выключить федерацию даже при неоткрывающемся ключе.
  await fixture(async (f) => {
    assert.equal(switches(f.host)[0].disabled, false);
    assert.ok(f.host.textContent?.includes('Ключ инстанса не открылся'));
    assert.ok(f.host.textContent?.includes('пароль к нему — в базе'));
    assert.ok(f.host.textContent?.includes(overview.FED_BACKUP_NOTE));
    assert.ok(!f.host.textContent?.includes('открывается паролем оттуда же'));
  }, { sw: { enabled: true, source: 'panel', status: 'key-error', problem: 'test key unavailable' } });
});

it('R257 отказы сервера показываются словами и не меняют показанное положение тумблера', async () => {
  for (const refusal of ['env_locked', 'dm_env_locked', 'federation_off', 'new-switch-refusal']) {
    await fixture(async (f) => {
      await f.click(switches(f.host)[0]);
      assert.deepEqual(f.patches, [{ enabled: true }]);
      assert.deepEqual(f.errors, [overview.SWITCH_REFUSAL_TEXT[refusal] ?? refusal]);
      assert.equal(switches(f.host)[0].getAttribute('aria-checked'), 'false');
      assert.equal(switches(f.host)[0].disabled, false);
      assert.equal(f.reads.switch, 1);
    }, { refusal });
  }
});

for (const [label, from, to, probe, message] of [
  ['потерян env-lock', "disabled={busy || sw.source === 'env'}", 'disabled={busy}', envLockProbe, 'R257 федерация из env недоступна'],
  ['потерян общий флаг для ЛС', "disabled={busy || !sw.enabled || sw.dmSource === 'env'}", "disabled={busy || sw.dmSource === 'env'}", dmLockProbe, 'R257 ЛС недоступны'],
  ['пропущено подтверждение', 'if (patch.enabled === false) {', 'if (false) {', confirmProbe, 'R257 выключение ждёт подтверждения'],
] as const) it(`R257 контрфакт переключателя: ${label}`, async () => {
  await probe();
  await assert.rejects(() => probe(mutate(source, from, to)), (e: unknown) =>
    e instanceof assert.AssertionError && e.message.startsWith(message));
});
