import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

let createRoot: typeof import('react-dom/client').createRoot;
before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  createRoot = (await import('react-dom/client')).createRoot;
});
after(() => { GlobalRegistrator.unregister(); Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); });

async function fixture(platform: 'web' | 'desktop' | 'mobile', login: (...args: any[]) => Promise<any>) {
  const calls: Record<string, any[][]> = { login: [], verify: [], totp: [] };
  const user = { id: '1', username: 'alice', displayName: 'Alice' };
  const api = {
    instance: async () => null,
    login: async (...args: any[]) => { calls.login.push(args); return login(...args); },
    resend: async () => {},
    verify: async (...args: any[]) => { calls.verify.push(args); return { token: 'test', user }; },
    loginTotp: async (...args: any[]) => { calls.totp.push(args); return { token: 'test', user }; },
  };
  const deps: Record<string, any> = {
    react: React, 'react/jsx-runtime': jsx, '../api': { api, setToken: () => {} },
    '../config': { activeInstance: () => null, instances: () => [], multiInstanceEnabled: () => platform === 'desktop',
      noteActiveSuperAdmin: () => {}, removeInstance: () => {}, serverHost: () => '', updateActiveInstance: () => {} },
    '../instanceSwitch': { adoptActiveInstance: () => {}, switchInstance: () => {} },
    '../loginNotice': { takeLoginNotice: () => null }, '../store': { useStore: (selector: any) => selector({ setAuth: () => {} }) },
    './AddInstanceModal': { AddInstanceModal: () => null }, './Goose': { Goose: () => null }, './Icon': { Icon: () => null },
    '../hotkeys': { isMobile: () => platform === 'mobile' }, '../nativeUnifiedPush': { startPushRegistration: () => {} },
    '../pendingInvite': { pendingInvite: () => null },
  };
  const module = { exports: {} as { Login: React.ComponentType<{ onAuthed: () => void }> } };
  const source = readFileSync(new URL('./Login.tsx', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, window, document, navigator, console,
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `Неожиданный импорт ${id}`); return deps[id]; },
  });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await React.act(async () => root.render(React.createElement(module.exports.Login, { onAuthed: () => {} })));
  const checkbox = () => {
    const input = host.querySelector<HTMLInputElement>('input[type=checkbox]');
    assert.ok(input, 'Флажок запоминания доступен на форме входа');
    assert.match(input.labels?.[0]?.textContent ?? '', /Запомнить меня/);
    return input;
  };
  const click = async (element: HTMLElement) => React.act(async () => element.click());
  const submit = async () => React.act(async () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  const code = async () => React.act(async () => {
    const input = host.querySelector<HTMLInputElement>('.code-box')!;
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => '123456' } });
    input.dispatchEvent(event);
  });
  return { host, calls, checkbox, click, submit, code, close: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}

for (const platform of ['web', 'desktop', 'mobile'] as const) {
  it(`${platform}: выбор по умолчанию выключен, включается и передаётся при входе`, async () => {
    const f = await fixture(platform, async () => ({ challenge: 'signed-challenge' }));
    try {
      assert.equal(f.checkbox().checked, false);
      assert.match(f.host.textContent ?? '', /90/);
      assert.match(f.host.textContent ?? '', /Любой с доступом к устройству сможет открыть ваш аккаунт/);
      await f.click(f.checkbox());
      assert.equal(f.checkbox().checked, true);
      await f.submit();
      assert.deepEqual(f.calls.login[0], ['', '', true]);
      assert.equal(f.host.querySelector('input[type=checkbox]'), null);
      await f.code(); await f.submit();
      assert.deepEqual(f.calls.totp[0], ['signed-challenge', '123456']);
    } finally { await f.close(); }
  });
}

it('отмена выбора перед входом передаёт false', async () => {
  const f = await fixture('web', async () => ({ challenge: 'c' }));
  try { await f.click(f.checkbox()); await f.click(f.checkbox()); await f.submit(); assert.deepEqual(f.calls.login[0], ['', '', false]); }
  finally { await f.close(); }
});

it('во время запроса флажок заблокирован и не меняется', async () => {
  let resolve!: (value: unknown) => void;
  const f = await fixture('web', () => new Promise(r => { resolve = r; }));
  try {
    await f.click(f.checkbox()); await f.submit();
    assert.equal(f.checkbox().disabled, true);
    await f.click(f.checkbox()); assert.equal(f.checkbox().checked, true);
    await React.act(async () => resolve({ challenge: 'c' }));
  } finally { await f.close(); }
});

for (const remember of [false, true]) {
  it(`подтверждение почты сохраняет выбор ${remember}`, async () => {
    const f = await fixture('web', async () => { throw Error('email_not_verified'); });
    try {
      if (remember) await f.click(f.checkbox());
      await f.submit();
      assert.deepEqual(f.calls.login[0], ['', '', remember]);
      assert.equal(f.host.querySelector('input[type=checkbox]'), null);
      await f.code(); await f.submit();
      assert.deepEqual(f.calls.verify[0], ['', '123456', remember]);
    } finally { await f.close(); }
  });
}
