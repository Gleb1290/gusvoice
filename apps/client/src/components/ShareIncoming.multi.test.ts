import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, after, it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as inbox from '../shareInbox';
import type { ForwardPickerProps } from './ForwardPicker';

const raw = readFileSync(new URL('./ShareIncoming.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const smallMax = 25 * 1024 ** 2, dmMax = 512 * 1024 ** 2;
before(() => { GlobalRegistrator.register(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(() => GlobalRegistrator.unregister());
const change = (from: string, to: string) => { assert.ok(raw.includes(from)); return raw.replace(from, to); };
async function scene(mode: 'send-dm' | 'send-mixed' | 'draft-dm' | 'draft-channel' | 'draft-current-channel' | 'close', source = raw) {
  const events: unknown[] = [], toasts: [string, string][] = []; let picker: ForwardPickerProps | undefined;
  const channel: inbox.ShareChannel = { id: 'channel', name: 'новости', serverId: 'server', serverName: 'Сервер', serverIconUrl: null };
  const files = [1, smallMax, smallMax + 1].map((size, i) => {
    const file = new File(['x'], `file-${i}.bin`); Object.defineProperty(file, 'size', { value: size }); return file;
  });
  const state = { servers: [{ id: 'server' }], bootstrap: { server: { id: 'server' } },
    currentServerId: mode === 'draft-current-channel' ? 'server' : null,
    dms: [{ id: 'dm', otherUser: { displayName: 'Беседа' } }],
    setSharedIn: (value: unknown) => events.push(['sharedIn', value]),
    selectDm: async (id: string) => { events.push(['selectDm', id]); },
    openServer: async (sid: string, cid: string) => { events.push(['openServer', sid, cid]); },
    openChannel: async (id: string) => { events.push(['openChannel', id]); },
    setView: (view: string) => events.push(['view', view]), loadDms: async () => {},
  };
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, '../api': { api: { getServer: async () => state.bootstrap } },
    '../attachRules': { ATTACH_MAX: 10, ATTACH_MAX_BYTES: smallMax, dmAttachMaxBytes: () => dmMax },
    '../peerName': { usePeerName: () => (() => 'Беседа'), dmPeerLabel: () => 'Беседа' },
    '../shareInbox': { ...inbox, shareChannels: () => [channel] },
    '../store': { useStore: { getState: () => state } },
    '../sockets': { subscribeToServer: (id: string) => events.push(['subscribe', id]) },
    '../toast': { toast: (kind: string, text: string) => toasts.push([kind, text]), toastError: () => {} },
    '../nativeMedia': { nativeMediaAvailable: () => true,
      sharedPeekNative: async () => ({ token: 'incoming', text: 'текст', files: files.map(f => ({ name: f.name, size: f.size, mime: 'application/octet-stream' })) }),
      sharedFilesNative: async (token: string) => { events.push(['sharedOpen', token]); return { files, skipped: [], dropped: 0 }; },
      sharedDropNative: async (token: string) => { events.push(['sharedDrop', token]); },
    },
    '../shareSend': { sendShareTo: async (targets: { kind: string; id: string }[], share: { files: File[]; text: string; comment: string }) => {
      events.push(['send', targets, share]); return targets.map(target => ({ target, ok: true }));
    } },
    './ForwardPicker': { ForwardPicker: (props: ForwardPickerProps) => { picker = props; return React.createElement('div', { 'data-testid': 'picker' }); } },
  };
  const module = { exports: {} };
  // Целый компонент с настоящими React-эффектами; подменены лишь внешние мосты и окно выбора.
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
  { module, exports: module.exports, window, File, require: (id: string) => { assert.ok(id in deps, id); return deps[id]; } });
  const { ShareIncoming } = module.exports as { ShareIncoming: React.ComponentType };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => { root.render(React.createElement(ShareIncoming)); });
    assert.ok(picker?.share); assert.equal(picker.share.channels.length, 1);
    if (mode === 'close') {
      await React.act(async () => { picker!.onClose(); });
      assert.deepEqual(events, [['sharedDrop', 'incoming']], 'отмена только забывает принятую копию'); return;
    }
    const draft = mode.startsWith('draft-'), channelTarget = mode.includes('channel') || mode === 'send-mixed';
    await React.act(async () => {
      if (draft) picker!.onDraft!(channelTarget ? 'channel' : 'dm');
      else picker!.onSend(mode === 'send-mixed' ? ['dm', 'channel'] : ['dm'], { silent: false, at: null, comment: 'комментарий', hideSender: false, hideCaptions: false });
      picker!.onClose();
    });
    assert.equal(events.filter(e => (e as unknown[])[0] === 'sharedOpen').length, 1, 'копии читаются однажды');
    assert.equal(events.filter(e => (e as unknown[])[0] === 'sharedDrop').length, 1, 'копии удаляются однажды после выбора');
    const expectedFiles = channelTarget ? ['file-0.bin', 'file-1.bin'] : files.map(f => f.name);
    if (draft) {
      const incoming = events.find(e => (e as unknown[])[0] === 'sharedIn') as [string, { convId: string; files: File[]; text: string }];
      assert.equal(incoming[1].convId, channelTarget ? 'channel' : 'dm'); assert.equal(incoming[1].text, 'текст');
      assert.deepEqual(Array.from(incoming[1].files, f => f.name), expectedFiles, 'файлы черновика ограничены пределом места');
      assert.equal(events.filter(e => (e as unknown[])[0] === 'send').length, 0);
      if (!channelTarget) assert.ok(events.some(e => JSON.stringify(e) === JSON.stringify(['selectDm', 'dm'])));
      else {
        assert.ok(events.some(e => JSON.stringify(e) === JSON.stringify(['subscribe', 'server'])));
        if (mode === 'draft-current-channel') {
          assert.ok(events.some(e => JSON.stringify(e) === JSON.stringify(['view', 'server'])));
          assert.ok(events.some(e => JSON.stringify(e) === JSON.stringify(['openChannel', 'channel'])));
        } else assert.ok(events.some(e => JSON.stringify(e) === JSON.stringify(['openServer', 'server', 'channel'])));
      }
    } else {
      const send = events.filter(e => (e as unknown[])[0] === 'send') as [string, { kind: string; id: string }[], { files: File[]; text: string; comment: string }][];
      assert.equal(send.length, 1, 'sendShareTo вызывается один раз');
      assert.equal(JSON.stringify(send[0]![1]), JSON.stringify(mode === 'send-mixed' ? [{ kind: 'conv', id: 'dm' }, { kind: 'channel', id: 'channel' }] : [{ kind: 'conv', id: 'dm' }]));
      assert.deepEqual(Array.from(send[0]![2].files, f => f.name), expectedFiles, 'канал среди мест ограничивает общий набор до 25 МиБ');
      assert.equal(send[0]![2].text, 'текст'); assert.equal(send[0]![2].comment, 'комментарий');
    }
    assert.equal(toasts.filter(([kind]) => kind === 'warn').length, channelTarget ? 1 : 0);
    if (channelTarget) assert.ok(toasts.some(([kind, text]) => kind === 'warn' && text.includes('25 МБ') && text.includes('file-2.bin')), 'лишний файл объяснён как too-big');
  } finally { await React.act(async () => root.unmount()); host.remove(); }
}
for (const mode of ['send-dm', 'send-mixed', 'draft-dm', 'draft-channel', 'draft-current-channel', 'close'] as const) {
  it(`R128 share incoming: ${ { 'send-dm': 'ЛС принимает большой предел', 'send-mixed': 'мультивыбор с каналом берёт общий минимум', 'draft-dm': 'черновик ЛС берёт серверный предел', 'draft-channel': 'канал открывается с sharedIn', 'draft-current-channel': 'канал текущего сервера открывается напрямую', close: 'закрытие без выбора удаляет копии' }[mode] }`, async () => scene(mode));
}
it('R128 мутанты общего лимита и раннего удаления копии ловятся мультивыбором', async () => {
  // Выбранный канал не должен получать файл свыше своих 25 МБ или терять копию до отправки.
  await scene('send-mixed');
  await assert.rejects(scene('send-mixed', change('Math.min(ATTACH_MAX_BYTES, dmAttachMaxBytes())', 'dmAttachMaxBytes()')), /ограничивает общий набор/);
  await assert.rejects(scene('send-mixed', change('if (pickedToken.current !== s.token)', 'if (true)')), /удаляются однажды/);
});
