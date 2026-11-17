import assert from 'node:assert/strict';
import { it } from 'node:test';
import { React, environment, icon, load, sourceOf } from './R171.phoneHarness';
import { Toggle } from './Toggle';
import * as shared from '@gusvoice/shared';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
async function flush(fn: () => void) {
  await React.act(async () => { fn(); for (let i = 0; i < 8; i++) await Promise.resolve(); });
}
async function panel(check: (p: { host: HTMLDivElement; reads: ReturnType<typeof deferred<boolean | null>>[];
  writes: Array<{ enabled: boolean; result: ReturnType<typeof deferred<boolean>> }>; render: (node: React.ReactNode) => Promise<void> }) => Promise<void>) {
  await environment(async (host, render) => {
    const reads: ReturnType<typeof deferred<boolean | null>>[] = [];
    const writes: Array<{ enabled: boolean; result: ReturnType<typeof deferred<boolean>> }> = [];
    const source = sourceOf('UserSettingsModal') + '\nexport { DesktopTab as __DesktopTab };';
    const m = load<{ __DesktopTab: React.ComponentType }>(new URL('./UserSettingsModal.tsx', import.meta.url), source, {
      '@gusvoice/shared': shared,
      '../config': { config: {}, RELEASES_URL: '' },
      '../desktopWindow': { getCloseBehavior: () => 'ask', appVersion: async () => null, gpuAccelGet: async () => true,
        autostartGet: () => { const d = deferred<boolean | null>(); reads.push(d); return d.promise; },
        autostartSet: (enabled: boolean) => { const result = deferred<boolean>(); writes.push({ enabled, result }); return result.promise; } },
      '../downloads': { getDownloadDir: () => null }, './Icon': { Icon: icon }, './Toggle': { Toggle },
    });
    await render(React.createElement(m.__DesktopTab));
    await check({ host, reads, writes, render });
  });
}
function toggle(host: HTMLElement) {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Запускать GusVoice вместе с Windows"]');
  assert.ok(button); return button;
}

it('загрузка блокирует переключатель, подтверждение ОС определяет состояние', async () => {
  await panel(async ({ host, reads, writes }) => {
    assert.equal(toggle(host).disabled, true);
    await flush(() => reads[0].resolve(false));
    assert.equal(toggle(host).disabled, false);
    assert.equal(toggle(host).getAttribute('aria-checked'), 'false');
    await flush(() => { toggle(host).click(); toggle(host).click(); });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].enabled, true);
    assert.equal(toggle(host).disabled, true);
    await flush(() => writes[0].result.resolve(false));
    assert.equal(toggle(host).getAttribute('aria-checked'), 'false');
    await flush(() => toggle(host).click());
    await flush(() => writes[1].result.resolve(true));
    assert.equal(toggle(host).getAttribute('aria-checked'), 'true');
  });
});

it('ошибка записи сохраняет подтверждённое состояние и позволяет повторить', async () => {
  await panel(async ({ host, reads, writes }) => {
    await flush(() => reads[0].resolve(true));
    await flush(() => toggle(host).click());
    await flush(() => writes[0].result.reject('Автозапуск отключён в настройках Windows.'));
    assert.equal(toggle(host).getAttribute('aria-checked'), 'true');
    assert.match(host.querySelector('[role="alert"]')?.textContent ?? '', /отключён в настройках Windows/);
    await flush(() => toggle(host).click());
    assert.equal(writes.length, 2);
    await flush(() => writes[1].result.resolve(false));
    assert.equal(toggle(host).getAttribute('aria-checked'), 'false');
    assert.equal(host.querySelector('[role="alert"]'), null);
  });
});

it('ошибка чтения предлагает повтор, а неподдерживаемая платформа скрывает группу', async () => {
  await panel(async ({ host, reads }) => {
    await flush(() => reads[0].reject(new Error('old shell')));
    assert.equal(toggle(host).disabled, true);
    const retry = host.querySelector<HTMLButtonElement>('[role="alert"] button'); assert.ok(retry);
    await flush(() => retry.click());
    assert.equal(reads.length, 2);
    await flush(() => reads[1].resolve(null));
    assert.equal(host.querySelector('#set-g-autostart'), null);
  });
});

it('после размонтирования поздний ответ не вызывает обновления панели', async () => {
  await panel(async ({ host, reads, render }) => {
    await render(null);
    await flush(() => reads[0].resolve(true));
    assert.equal(host.querySelector('#set-g-autostart'), null);
  });
});

it('после ошибки чтения повтор показывает фактическое включённое состояние', async () => {
  await panel(async ({ host, reads }) => {
    await flush(() => reads[0].reject(new Error('stack')));
    assert.match(host.querySelector('[role="alert"]')?.textContent ?? '', /Не удалось узнать/);
    const retry = host.querySelector<HTMLButtonElement>('[role="alert"] button'); assert.ok(retry);
    await flush(() => retry.click());
    await flush(() => reads[1].resolve(true));
    assert.equal(toggle(host).getAttribute('aria-checked'), 'true');
    assert.equal(toggle(host).disabled, false);
  });
});
