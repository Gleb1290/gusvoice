import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import type { ViteDevServer } from 'vite';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);
type Wire = { onmessage: ((e: { data: string | ArrayBuffer }) => void) | null; postMessage(s: string | ArrayBuffer): void };
const w = () => window as unknown as { GusVoiceMedia?: Wire; __gvShare?: () => void };

async function scene(server: ViteDevServer, mode: 'choose' | 'close' | 'big' | 'absent') {
  h.desktop();
  const { useStore } = await server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const { useToasts } = await server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
  const initial = useStore.getState(), initialToasts = useToasts.getState();
  const calls: string[] = [];
  let finishOpen: (() => void) | undefined;
  const wire: Wire = { onmessage: null, postMessage(s) {
    if (typeof s !== 'string') return;
    const req = JSON.parse(s);
    const emit = (v: object) => wire.onmessage?.({ data: JSON.stringify({ id: req.id, ok: true, ...v }) });
    calls.push(req.op);
    if (req.op === 'shared') queueMicrotask(() => emit({ share: { token: 'incoming', text: 'ссылка', files: [
      { name: 'a.txt', mime: 'text/plain', size: 1, ...(mode === 'big' ? { skip: 'too-big' } : {}) },
    ], ...(mode === 'big' ? { text: '' } : {}) } }));
    if (req.op === 'sharedOpen') finishOpen = () => {
      emit({ file: 0, name: 'a.txt', mime: 'text/plain' });
      emit({ bin: { file: 0 } }); wire.onmessage?.({ data: new Uint8Array([65]).buffer });
      emit({ file: 0, end: true }); emit({ done: true });
    };
    if (req.op === 'sharedDrop') queueMicrotask(() => emit({}));
  } };
  if (mode !== 'absent') w().GusVoiceMedia = wire;
  else delete w().GusVoiceMedia;
  useStore.setState({ currentDmId: 'current', dms: [{ id: 'current', otherUser: {
    id: 'peer', username: 'peer', displayName: 'Текущая беседа', avatarUrl: null,
  }, createdAt: new Date(h.now).toISOString(), lastMessageAt: null, unread: 0 }] as never,
  selectDm: async (id) => { calls.push(`select:${id}`); } });
  const { ShareIncoming } = await server.ssrLoadModule('/src/components/ShareIncoming.tsx');
  try {
    await h.mount({}, ShareIncoming); await h.flush();
    if (mode === 'absent') {
      assert.equal(w().__gvShare, undefined, 'без моста hook не установлен');
      assert.equal(document.querySelector('.fwd-modal') === null, true); assert.equal(calls.length, 0); return;
    }
    if (mode === 'big') {
      assert.equal(document.querySelector('.fwd-modal') === null, true, 'негодные файлы не открывают окно');
      assert.equal(useToasts.getState().toasts.length, initialToasts.toasts.length + 1);
      assert.match(useToasts.getState().toasts.at(-1)!.title, /25|больш|размер/i);
      assert.deepEqual(calls, ['shared', 'sharedDrop']); return;
    }
    assert.ok(document.querySelector('.fwd-modal'), 'полезное share открывает выбор');
    if (mode === 'close') {
      const close = document.querySelector<HTMLButtonElement>('.fwd-modal .icon-close'); assert.ok(close);
      await act(async () => { close.click(); await h.flush(); });
      assert.deepEqual(calls, ['shared', 'sharedDrop'], 'отмена удаляет копии без чтения'); return;
    }
    const row = [...document.querySelectorAll<HTMLElement>('.fwd-modal .dm-row')].find(el => el.textContent?.includes('Текущая беседа'));
    assert.ok(row, 'текущая беседа доступна для входящего share');
    await act(async () => { row.click(); await h.flush(); });
    assert.deepEqual(calls, ['shared', 'sharedOpen'], 'закрытие после выбора не удаляет ещё читаемые копии');
    assert.equal(document.querySelector('.fwd-modal') === null, true);
    assert.ok(finishOpen); await act(async () => { finishOpen!(); await h.flush(); });
    assert.deepEqual(calls, ['shared', 'sharedOpen', 'select:current', 'sharedDrop']);
    const incoming = useStore.getState().sharedIn; assert.ok(incoming);
    assert.equal(incoming.convId, 'current'); assert.equal(incoming.text, 'ссылка');
    assert.equal(incoming.files.length, 1); assert.equal(incoming.files[0]!.name, 'a.txt');
    assert.equal(incoming.files[0]!.size, 1); assert.equal(await incoming.files[0]!.text(), 'A', 'байты нативного потока сохранены');
  } finally {
    h.unmount(); delete w().GusVoiceMedia;
    useStore.setState(initial, true); useToasts.setState(initialToasts, true);
    assert.equal(w().__gvShare, undefined, 'размонтирование убирает hook');
  }
}

for (const mode of ['choose', 'close', 'big', 'absent'] as const) {
  it(`R118 входящее share: ${ { choose: 'выбор читает файлы до удаления и сохраняет заказ', close: 'отмена не читает файлы', big: 'слишком большие файлы дают тост без окна', absent: 'браузер без моста не получает hook' }[mode] }`, async () => scene(h.server, mode));
}
for (const [name, change, failure] of [
  ['преждевременное удаление после выбора', (s: string) => s.replace('if (pickedToken.current !== s.token)', 'if (true)'), 'закрытие после выбора не удаляет ещё читаемые копии'],
  ['исключение текущей беседы', (s: string) => s.replace('!(pickOne && !pickOne.keepCurrent && d.id === currentDmId)', '!(d.id === currentDmId)'), 'текущая беседа доступна для входящего share'],
] as const) {
  it(`R118 мутант ${name} отвергается поведением компонента`, async () => {
    await scene(h.server, 'choose');
    const server = await h.paneServer(change, name === 'исключение текущей беседы' ? 'ForwardPicker' : 'ShareIncoming');
    try { await assert.rejects(() => scene(server, 'choose'), (error: unknown) => error instanceof assert.AssertionError && error.message.includes(failure)); }
    finally { await server.close(); }
  });
}

async function legacyScene(server: ViteDevServer, mode: 'choose' | 'close' | 'files') {
  h.desktop(); delete w().GusVoiceMedia;
  const nativeWindow = window as unknown as { GusVoiceNative?: { sharedText(): string; sharedTextDrop(token: string): void } };
  const { useStore } = await server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const { useToasts } = await server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
  const initial = useStore.getState(), initialToasts = useToasts.getState();
  const calls: string[] = [];
  nativeWindow.GusVoiceNative = {
    sharedText: () => { calls.push('text'); return JSON.stringify({ token: 'legacy', text: mode === 'files' ? '' : 'старый WebView', files: [], filesOff: 2 }); },
    sharedTextDrop: token => { calls.push(`drop:${token}`); },
  };
  useStore.setState({ dms: [{ id: 'current', otherUser: { id: 'peer', username: 'peer', displayName: 'Текущая беседа', avatarUrl: null }, createdAt: new Date(h.now).toISOString(), lastMessageAt: null, unread: 0 }] as never,
    selectDm: async id => { calls.push(`select:${id}`); } });
  const { ShareIncoming } = await server.ssrLoadModule('/src/components/ShareIncoming.tsx');
  try {
    await h.mount({}, ShareIncoming); await h.flush();
    assert.equal(useToasts.getState().toasts.length, initialToasts.toasts.length + 1, 'filesOff сообщает ровно один тост');
    assert.equal(useToasts.getState().toasts.at(-1)!.title, 'Чтобы делиться файлами, обновите Android System WebView');
    if (mode === 'files') {
      assert.equal(document.querySelector('.fwd-modal') === null, true, 'без текста и файлов нечего выбирать');
      assert.deepEqual(calls, ['text', 'drop:legacy'], 'без media мост удаляет legacy заказ'); return;
    }
    assert.ok(document.querySelector('.fwd-modal'), 'текст остаётся доступным при filesOff');
    const target = mode === 'close' ? document.querySelector<HTMLElement>('.fwd-modal .icon-close') : [...document.querySelectorAll<HTMLElement>('.fwd-modal .dm-row')].find(el => el.textContent?.includes('Текущая беседа'));
    assert.ok(target); await act(async () => { target.click(); await h.flush(); });
    assert.deepEqual(calls, mode === 'close' ? ['text', 'drop:legacy'] : ['text', 'select:current', 'drop:legacy'], 'legacy заказ удаляется без открытия файлов');
    if (mode === 'choose') {
      assert.equal(useStore.getState().sharedIn?.text, 'старый WebView');
      assert.equal(useStore.getState().sharedIn?.files.length, 0, 'legacy не создаёт копий файлов');
    }
  } finally {
    h.unmount(); delete nativeWindow.GusVoiceNative;
    useStore.setState(initial, true); useToasts.setState(initialToasts, true);
  }
}
for (const mode of ['choose', 'close', 'files'] as const) {
  it(`R119 D22 legacy share: ${mode === 'choose' ? 'текст принимается без копий файлов' : mode === 'close' ? 'отмена удаляет текст без чтения файлов' : 'только filesOff даёт тост и удаляется без окна'}`, async () => legacyScene(h.server, mode));
}
it('R119 D22 мутант без sharedTextDrop отвергается выбором legacy текста', async () => {
  await legacyScene(h.server, 'choose');
  const server = await h.paneServer(s => s.replace('legacyShare()?.sharedTextDrop(token);', 'void token;'), 'ShareIncoming');
  try { await assert.rejects(() => legacyScene(server, 'choose'), (e: unknown) => e instanceof assert.AssertionError && e.message.includes('legacy заказ удаляется без открытия файлов')); }
  finally { await server.close(); }
});
