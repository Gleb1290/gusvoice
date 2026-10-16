import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import { Simulate } from 'react-dom/test-utils';
import type { ViteDevServer } from 'vite';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);
async function stores(server = h.server) {
  const { useStore } = await server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const { useToasts } = await server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
  const initial = useStore.getState(), initialToasts = useToasts.getState();
  h.resetStore = () => { useStore.setState(initial, true); useToasts.setState(initialToasts, true); };
  return { useStore, useToasts };
}
const field = () => {
  const el = h.host.querySelector<HTMLTextAreaElement>('.composer textarea'); assert.ok(el, 'поле доступно'); return el;
};
async function input(value: string) {
  await act(async () => { Simulate.change(field(), { target: { value } as unknown as EventTarget }); await h.flush(); });
}

h.mutantTest('R118 входящий текст дописывается к черновику с новой строки, а чужая беседа его не забирает', async () => {
  await h.rejectMutant(s => s.replace("setText((cur) => (cur.trim() ? `${cur.replace(/\\s+$/, '')}\\n${add}` : add));", 'setText(add);'), async (component, _confirm, _answer, server) => {
    const { useStore } = await stores(server); h.desktop();
    await h.mount({ feedId: 'c' }, component); await input('мой черновик  ');
    await act(async () => { useStore.getState().setSharedIn({ convId: 'other', files: [], text: 'не сюда' }); await h.flush(); });
    assert.equal(field().value, 'мой черновик  '); assert.ok(useStore.getState().sharedIn, 'чужая лента оставляет заказ');
    await act(async () => { useStore.getState().setSharedIn({ convId: 'c', files: [], text: 'ссылка' }); await h.flush(); });
    assert.equal(field().value, 'мой черновик\nссылка', 'входящее не затирает черновик');
    assert.equal(useStore.getState().sharedIn, null, 'заказ забирается один раз');
    await act(async () => { useStore.getState().setSharedIn({ convId: 'c', files: [], text: 'ещё' }); await h.flush(); });
    assert.equal(field().value, 'мой черновик\nссылка\nещё');
    await input('   ');
    await act(async () => { useStore.getState().setSharedIn({ convId: 'c', files: [], text: 'без пустой строки' }); await h.flush(); });
    assert.equal(field().value, 'без пустой строки');
  }, 'входящее не затирает черновик');
});

for (const phone of [false, true]) {
  const check = async (component = h.Pane, server = h.server) => {
    const { useStore } = await stores(server); h.desktop(); const restore = h.pointerLayout(phone, phone ? 390 : 1200);
    let enqueued = 0, sent = 0;
    const outbox = { items: [], enqueue() { enqueued++; }, retry() {}, discard() {} } as never;
    try {
      for (const draft of phone ? ['черновик'] : ['черновик', '']) {
        await h.mount({ feedId: 'c', outbox, onSend: async () => { sent++; } }, component); await input(draft);
        await act(async () => { useStore.getState().setSharedIn({ convId: 'c', files: [new File(['data'], 'incoming.txt', { type: 'text/plain' })], text: 'подпись' }); await h.flush(); });
        if (phone) {
          assert.equal(document.querySelector('.sfb') === null, true, 'на телефоне отдельного окна нет');
          assert.match(h.host.querySelector('.pending-atts')?.textContent ?? '', /incoming\.txt/, 'файл виден в полосе composer');
          assert.equal(field().value, 'черновик\nподпись');
        } else {
          assert.ok(document.querySelector('.sfb'), 'ПК показывает окно файлов');
          // Как вставка картинки: подпись продолжает существующий черновик через пробел,
          // но при пустом поле никакого пробела/потерянного текста не появляется.
          assert.equal(document.querySelector<HTMLTextAreaElement>('.sfb-caption')?.value,
            draft ? 'черновик подпись' : 'подпись', 'подпись окна сохраняет черновик перед входящим текстом');
          assert.equal(field().value, draft, 'подпись окна не дублируется в черновике');
          assert.equal(h.host.querySelector('.pending-atts') === null, true);
        }
        assert.equal(useStore.getState().sharedIn, null);
        assert.equal(enqueued, 0, 'входящий файл сам не попадает в очередь');
        assert.equal(sent, 0, 'входящий файл сам не отправляется');
        h.unmount();
      }
    } finally { h.unmount(); restore(); }
  };
  const name = `R118 входящие файлы в ЛС: ${phone ? 'телефон сохраняет полосу и дописывает текст' : 'ПК открывает окно отправки с подписью'}`;
  if (phone) it(name, () => check());
  else h.mutantTest(name, async () => {
    await h.rejectMutant(source => source.replace("caption: captionAfterPaste(text, opts?.caption ?? ''),",
      "caption: captionAfterPaste('', opts?.caption ?? ''),"),
    async (component, _confirm, _answer, server) => check(component, server), 'подпись окна сохраняет черновик перед входящим текстом');
  });
}

for (const mode of ['readOnly', 'edit'] as const) {
  it(`R118 входящий заказ при ${mode === 'edit' ? 'правке' : 'запрете записи'} даёт тост и не мешает composer`, async () => {
    const { useStore, useToasts } = await stores(); h.desktop(); h.round12();
    await h.mount({ feedId: 'c', readOnly: mode === 'readOnly', messages: mode === 'edit' ? [h.msg('edit-share')] : [] });
    if (mode === 'edit') {
      const row = h.host.querySelector<HTMLElement>('[data-mid="edit-share"]'); assert.ok(row);
      await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
      const edit = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(b => b.textContent?.trim() === 'Изменить'); assert.ok(edit);
      await act(async () => { edit.click(); await h.flush(); });
      assert.ok(h.host.querySelector('.edit-strip')); assert.equal(field().value, 'edit-share');
    }
    const count = useToasts.getState().toasts.length;
    await act(async () => { useStore.getState().setSharedIn({ convId: 'c', files: [new File(['data'], 'incoming.txt')], text: 'не подмешивать' }); await h.flush(); });
    assert.equal(useToasts.getState().toasts.length, count + 1);
    assert.equal(useToasts.getState().toasts.at(-1)!.title, mode === 'edit' ? 'Сначала закончите правку сообщения' : 'В эту беседу писать нельзя');
    assert.equal(useStore.getState().sharedIn, null);
    assert.equal(document.querySelector('.sfb') === null, true); assert.equal(h.host.querySelector('.pending-atts') === null, true);
    if (mode === 'edit') assert.equal(field().value, 'edit-share', 'пришедшее не подмешано в правку');
  });
}
