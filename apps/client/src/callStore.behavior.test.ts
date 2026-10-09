import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { create } from 'zustand';
import ts from 'typescript';
import { callViewFor } from './callView';
import type { DmCall } from '@gusvoice/shared';
import type { useCall as UseCall } from './callStore';

const source = readFileSync(new URL('./callStore.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw: string, callStart: () => Promise<unknown>) {
  const module = { exports: {} as { useCall: typeof UseCall; CALL_DEVICE: string } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    module, exports: module.exports, setTimeout, clearTimeout,
    require: (id: string) => {
      if (id === 'zustand') return { create };
      if (id === './api') return { api: { callStart } };
      if (id === './callView') return { callViewFor };
      if (id === './store') return { useStore: { getState: () => ({ user: { id: 'me' }, dms: [] }) } };
      return {};
    },
  });
  return module.exports;
}

it('поздний ответ запуска сохраняет свёрнутый звонок из шлюза, новый звонок разворачивается', async () => {
  const check = async (raw: string) => {
    for (const eventFirst of [true, false]) {
      let resolve!: (result: unknown) => void;
      const pending = new Promise(resolveResult => { resolve = resolveResult; });
      const { useCall, CALL_DEVICE } = load(raw, () => pending);
      const call = { id: 'call', conversationId: 'dm', callerId: 'me', calleeId: 'peer', callerDevice: CALL_DEVICE, phase: 'ringing' } as DmCall;
      useCall.getState().setExpanded(false);
      const started = useCall.getState().start('dm');
      if (eventFirst) { useCall.getState().apply(call); useCall.getState().setExpanded(false); }
      resolve({ call, url: 'url', token: 'test-token', room: 'room' }); await started;
      assert.equal(useCall.getState().expanded, !eventFirst, eventFirst ? 'шлюз и пользователь уже свернули' : 'новый звонок развернулся');
      assert.equal(useCall.getState().call?.id, 'call'); assert.equal(useCall.getState().join?.room, 'room');
    }
  };
  await check(source);
  const from = 'set({ join: { url: res.url, token: res.token, room: res.room }, muted: false, ...NO_VIDEO });';
  assert.ok(source.includes(from)); const changed = source.replace(from, from.replace('muted: false', 'muted: false, expanded: true'));
  assert.notEqual(changed, source);
  await assert.rejects(check(changed), /шлюз и пользователь уже свернули/);
});
