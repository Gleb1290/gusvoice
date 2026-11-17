import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function bridge(desktop: boolean, ua: string, invoke: (cmd: string, args?: unknown) => Promise<unknown>) {
  const source = readFileSync(new URL('./desktopWindow.ts', import.meta.url), 'utf8');
  const module = { exports: {} as typeof import('./desktopWindow') };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, window: { __TAURI__: { core: { invoke } } }, navigator: { userAgent: ua },
      require: () => ({ isDesktop: () => desktop }) });
  return module.exports;
}

it('Windows читает и записывает подтверждённое состояние через нативные команды', async () => {
  const calls: Array<[string, unknown]> = [];
  const b = bridge(true, 'Windows NT 10.0', async (cmd, args) => { calls.push([cmd, args]); return cmd === 'gv_autostart_enabled'; });
  assert.equal(await b.autostartGet(), true);
  assert.equal(await b.autostartSet(true), false);
  assert.equal(calls[0][0], 'gv_autostart_enabled');
  assert.equal(calls[1][0], 'gv_autostart_set');
  assert.equal((calls[1][1] as { enabled: boolean }).enabled, true);
});

it('веб, Android и другие настольные ОС не вызывают нативную команду', async () => {
  for (const [desktop, ua] of [[false, 'Windows'], [false, 'Android'], [true, 'Linux'], [true, 'Macintosh']] as const) {
    const b = bridge(desktop, ua, async () => assert.fail('недопустимый вызов'));
    assert.equal(await b.autostartGet(), null);
    await assert.rejects(b.autostartSet(true));
  }
});

it('ошибка нативной команды и некорректный ответ не превращаются в успех', async () => {
  const b = bridge(true, 'Windows', async () => { throw new Error('native failure'); });
  await assert.rejects(b.autostartGet(), /native failure/);
  await assert.rejects(b.autostartSet(true), /native failure/);
  const invalid = bridge(true, 'Windows', async () => undefined);
  await assert.rejects(invalid.autostartGet());
  await assert.rejects(invalid.autostartSet(false));
});
