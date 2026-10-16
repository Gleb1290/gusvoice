import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { create } from 'zustand';
import * as shared from '@gusvoice/shared';
import * as callView from './callView';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const source = read('./callStore.ts'), confirmSource = read('./confirm.ts');
function fixture(raw = source, failure: string | null = shared.CALL_PRIVACY_ERROR, withPeer = true) {
  const unknown: string[] = [], requests: unknown[][] = [], names: unknown[][] = [], toasts: unknown[][] = [], toastErrors: unknown[][] = [];
  const load = <T>(text: string, deps: Record<string, unknown>) => {
    const module = { exports: {} as T };
    runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, crypto: { randomUUID: () => 'fixture-device' }, Error,
        setTimeout() { unknown.push('setTimeout'); assert.fail('Неожиданный таймер'); },
        clearTimeout() { unknown.push('clearTimeout'); assert.fail('Неожиданная отмена таймера'); },
        require(id: string) {
          if (!Object.hasOwn(deps, id)) { unknown.push(`require:${id}`); assert.fail(`Неописанный импорт ${id}`); }
          return deps[id];
        } });
    return module.exports;
  };
  const confirm = load<typeof import('./confirm')>(confirmSource, { zustand: { create } });
  const api = new Proxy({ async callStart(...args: unknown[]) {
    requests.push(args);
    if (failure) throw Object.assign(new Error(failure), { status: 403 });
    return { url: 'fixture-url', token: 'fixture-token', room: 'fixture-room', call: {
      id: 'call', conversationId: 'dm', callerId: 'me', calleeId: 'peer', callerDevice: 'fixture-device', phase: 'ringing', createdAt: '',
    } };
  } }, { get(target, key, receiver) {
    if (!Reflect.has(target, key)) { unknown.push(`api:${String(key)}`); assert.fail(`Неописанный API ${String(key)}`); }
    return Reflect.get(target, key, receiver);
  } });
  const store = load<typeof import('./callStore')>(raw, {
    zustand: { create }, '@gusvoice/shared': shared, './api': { api }, './callView': callView, './confirm': confirm,
    './callFed': { callApiFor() { unknown.push('callApiFor'); assert.fail('Приватность не обращается к чужому API'); } },
    './peerName': { peerNameNow(...args: unknown[]) { names.push(args); return 'Контакт Алиса'; } },
    './store': { useStore: { getState: () => ({ user: { id: 'me' }, voice: null,
      dms: withPeer ? [{ id: 'dm', otherUser: { id: 'peer', displayName: 'Серверная Алиса', avatarUrl: null } }] : [] }) } },
    './toast': { toast(...args: unknown[]) { toasts.push(args); }, toastError(...args: unknown[]) { toastErrors.push(args); } },
  });
  return { store, confirm, requests, names, toasts, toastErrors,
    clean() { confirm.useConfirmDialog.getState().answer(false); assert.deepEqual(unknown, [], 'R238 неизвестный IO не скрыт catch запуска звонка'); } };
}
function checkPending(f: ReturnType<typeof fixture>, name: string) {
  const pending = f.confirm.useConfirmDialog.getState().pending;
  assert.equal(pending?.title, 'Позвонить нельзя');
  assert.equal(pending?.body, `${name} не принимает звонки.`);
  assert.equal(pending?.tone, 'info');
  assert.equal(pending?.icon, 'ban', 'R238 privacy-icon: запрет звонка передаёт ban настоящему alertDialog');
  assert.deepEqual(f.toasts, []); assert.deepEqual(f.toastErrors, []);
}
function explain(raw = source) {
  const f = fixture(raw);
  try {
    f.store.explainCallPrivacy('  Алиса  '); checkPending(f, 'Алиса');
    f.confirm.useConfirmDialog.getState().answer(true);
    f.store.explainCallPrivacy(' '); checkPending(f, 'Собеседник');
    assert.deepEqual(f.requests, []); assert.deepEqual(f.names, []);
  } finally { f.clean(); }
}
async function denied(raw = source) {
  for (const withPeer of [true, false]) {
    const f = fixture(raw, shared.CALL_PRIVACY_ERROR, withPeer);
    try {
      await f.store.useCall.getState().start('dm');
      checkPending(f, withPeer ? 'Контакт Алиса' : 'Собеседник');
      assert.deepEqual(f.requests, [['dm', 'fixture-device']]);
      assert.deepEqual(f.names, withPeer ? [['peer', 'Серверная Алиса']] : []);
      assert.equal(f.store.useCall.getState().call, null); assert.equal(f.store.useCall.getState().join, null);
    } finally { f.clean(); }
  }
}
it('R238 explainCallPrivacy открывает справку ban с коротким текстом, без API и без тоста', () => explain());
it('R238 start при 403 call_privacy показывает ban, имя контакта или нейтральное имя и не создаёт звонок', () => denied());
it('R238 успешный звонок и другие отказы не заменяются справкой приватности', async () => {
  for (const failure of [null, shared.CALL_BUSY_ERROR, 'fixture_other_error']) {
    const f = fixture(source, failure);
    try {
      await f.store.useCall.getState().start('dm');
      assert.equal(f.confirm.useConfirmDialog.getState().pending, null);
      assert.equal(f.store.useCall.getState().call?.id ?? null, failure ? null : 'call');
      assert.equal(f.toasts.length, failure === shared.CALL_BUSY_ERROR ? 1 : 0);
      assert.equal(f.toastErrors.length, failure === 'fixture_other_error' ? 1 : 0);
    } finally { f.clean(); }
  }
});
for (const [name, check] of [['explainCallPrivacy', explain], ['start 403', denied]] as const)
  it(`R238 потеря значка в ${name} обнаруживается через настоящий confirm store`, async () => {
    await check();
    const anchor = 'alertDialog(n.title, n.body, { icon: n.icon })';
    assert.equal(source.split(anchor).length - 1, 1);
    await assert.rejects(async () => check(source.replace(anchor, 'alertDialog(n.title, n.body)')), e => e instanceof assert.AssertionError &&
      e.message.startsWith('R238 privacy-icon:') && e.operator === 'strictEqual' && e.actual === undefined && e.expected === 'ban');
  });
