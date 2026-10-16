import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import type { Attachment, Message } from '@gusvoice/shared';
import type { ViteDevServer } from 'vite';
import { setupHarness, type Props } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);
type Pane = typeof h.Pane;
type Scene = {
  kind?: 'photo' | 'video'; entry?: 'viewer' | 'cell'; action?: 'forward' | 'delete';
  enabled?: boolean; phone?: boolean; cancel?: boolean; own?: boolean; scope?: 'me' | 'both';
};

async function scene(component: Pane, confirm: typeof h.ConfirmHost, runtime: ViteDevServer, options: Scene = {}) {
  const { kind = 'photo', entry = 'viewer', action = 'delete', enabled = true, phone = false,
    cancel = false, own = false, scope = 'me' } = options;
  const restoreLayout = h.pointerLayout(phone, phone ? 390 : 1200);
  if (phone) h.mobile(); else h.desktop();
  const { useStore } = await runtime.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const priorStore = useStore.getState();
  const { useConfirmDialog } = await runtime.ssrLoadModule('/src/confirm.ts') as typeof import('../confirm');
  const rememberedDelete = localStorage.getItem('gv_delete_only_me');
  localStorage.removeItem('gv_delete_only_me');
  useStore.setState({ dms: [{ id: 'target', otherUser: { id: 'recipient', username: 'recipient', displayName: 'Адресат', avatarUrl: null },
    createdAt: new Date(h.now).toISOString(), lastMessageAt: null, unread: 0 }] as never });
  const first: Attachment = { id: 'photo-first', url: '/photo-first.png', name: 'photo-first.png', contentType: 'image/png', size: 20, width: 100, height: 80 };
  const selected: Attachment = { id: 'selected-item', url: kind === 'photo' ? '/photo-selected.png' : '/video-selected.mp4',
    name: kind === 'photo' ? 'photo-selected.png' : 'video-selected.mp4', contentType: kind === 'photo' ? 'image/png' : 'video/mp4',
    size: 20, width: 100, height: 80 };
  const message = { ...h.msg('album-message', own ? 'me' : 'peer'), content: 'Подпись альбома', attachments: [first, selected] } as Message;
  const itemCalls: unknown[][] = [], wholeCalls: unknown[][] = [];
  const batch: NonNullable<Props['batch']> = {
    forward: async (...args) => { wholeCalls.push(['forward', ...args]); },
    deleteMany: async (...args) => { wholeCalls.push(['deleteMany', ...args]); },
    ...(enabled ? {
      forwardItem: async (...args: Parameters<NonNullable<NonNullable<Props['batch']>['forwardItem']>>) => { itemCalls.push(['forward', ...args]); },
      deleteItem: async (...args: Parameters<NonNullable<NonNullable<Props['batch']>['deleteItem']>>) => { itemCalls.push(['delete', ...args]); },
    } : {}),
    peerName: () => 'Адресат', open: () => {},
  };
  const props: Partial<Props> = { messages: [message], batch, deletePeerName: 'Собеседник',
    onDelete: async (m, forWhom) => { wholeCalls.push(['delete', m.id, forWhom]); } };
  try {
    await h.mountWithConfirm(props, component, confirm);
    const media = h.host.querySelector<HTMLElement>(`[data-mid="album-message"] .att-img-link ${kind === 'photo' ? 'img' : 'video'}[src="${selected.url}"]`);
    assert.ok(media, 'выбрана вторая настоящая ячейка, не первая фотография по умолчанию');
    const anchor = media.closest<HTMLElement>('.att-img-link');
    assert.ok(anchor, 'медиа находится внутри настоящей ячейки альбома');
    if (entry === 'viewer') {
      await act(async () => { anchor.click(); await h.flush(); });
      assert.ok(document.querySelector('.lightbox'), 'настоящий просмотрщик открыл выбранный элемент');
      const showing = document.querySelector<HTMLImageElement | HTMLVideoElement>(`.lightbox ${kind === 'photo' ? '.lb-img' : '.lb-video'}`);
      assert.equal(showing?.getAttribute('src'), selected.url, 'просмотрщик показывает именно выбранный элемент');
      const more = document.querySelector<HTMLButtonElement>('.lightbox button[title="Ещё"]');
      assert.ok(more, 'просмотрщик имеет настоящее меню действий');
      await act(async () => { more.click(); });
    } else {
      await act(async () => { media.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })); });
    }
    const noun = kind === 'photo' ? 'фото' : 'видео';
    const itemAction = enabled && (entry === 'viewer' || !phone);
    const label = action === 'delete' ? 'Удалить' : 'Переслать';
    const menu = entry === 'viewer' ? '.lb-menu' : '.ctx-menu';
    const labels = [...document.querySelectorAll<HTMLButtonElement>(`${menu} button`)].map(button => button.textContent?.trim());
    const expectedLabel = entry === 'cell' && itemAction ? `${label} ${noun}` : label;
    assert.equal(labels.includes(expectedLabel), true, 'G56-menu: пункт меню различает выбранную ячейку и сообщение целиком');
    assert.equal(labels.includes(`${label} ${noun}`), entry === 'cell' && itemAction,
      'G56-menu: телефон и старый сервер не получают подписи действия одной ячейки');
    const button = [...document.querySelectorAll<HTMLButtonElement>(`${menu} button`)].find(node => node.textContent?.trim() === expectedLabel);
    assert.ok(button, 'настоящий пункт найден для нажатия');
    await act(async () => { button.click(); await h.flush(); });
    if (action === 'delete') {
      const pending = useConfirmDialog.getState().pending;
      assert.ok(pending, 'удаление сначала открыло настоящее подтверждение');
      assert.equal(itemCalls.length + wholeCalls.length, 0, 'до подтверждения никакое удаление не вызывается');
      if (itemAction) assert.equal(pending.title, own ? `Удалить ${noun}?` : `Удалить ${noun} у себя?`,
        'G56-delete-title: подтверждение относится к выбранному элементу');
      if (own && itemAction && scope === 'both') {
        const check = document.querySelector<HTMLInputElement>('.confirm-option input');
        assert.ok(check, 'своё медиа предлагает область у обоих');
        if (!check.checked) await act(async () => { check.click(); });
      }
      await act(async () => { useConfirmDialog.getState().answer(!cancel); await h.flush(); });
      const wanted = cancel ? [] : itemAction ? [['delete', 'album-message', 'selected-item', own ? scope : 'me']] : [];
      assert.equal(JSON.stringify(itemCalls), JSON.stringify(wanted), 'G56-delete: callback удаляет только выбранный attachmentId и область');
      assert.equal(wholeCalls.length, cancel || itemAction ? 0 : 1, 'G56-delete-whole: старый сервер вызывает прежнее удаление сообщения');
      if (!cancel && !itemAction) assert.equal(wholeCalls[0]?.[1], 'album-message');
    } else {
      assert.equal(!!document.querySelector('.lightbox'), false, 'пересылка закрывает просмотр перед выбором адресата');
      const target = [...document.querySelectorAll<HTMLButtonElement>('.fwd-pick .dm-row, .fwd-pick .fwd-cell')]
        .find(node => node.textContent?.includes('Адресат'));
      assert.ok(target, 'настоящий ForwardPicker содержит адресата');
      // У одного элемента нет onDraft: picker сразу в selecting и onMenu не назначен. В режиме черновика
      // целого сообщения ПКМ включает выбор, а в готовом selecting галочку ставит обычный click.
      // Читаем настоящий режим из DOM, а не из itemAction: мутант, теряющий attachmentId, меняет и режим picker.
      await act(async () => {
        if (target.getAttribute('role') === 'checkbox') target.click();
        else target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
      });
      const send = document.querySelector<HTMLButtonElement>('.fwd-send');
      assert.ok(send && !send.disabled, 'отмеченный адресат разрешает отправку');
      await act(async () => { send.click(); await h.flush(); });
      const wanted = itemAction ? [['forward', 'album-message', 'selected-item', 'target', false, { hideSender: false }]] : [];
      assert.equal(JSON.stringify(itemCalls), JSON.stringify(wanted), 'G56-forward: callback пересылает только выбранный attachmentId выбранному адресату');
      assert.equal(wholeCalls.length, itemAction ? 0 : 1, 'G56-forward-whole: старый сервер пересылает сообщение целиком');
      if (!itemAction) assert.equal(JSON.stringify(wholeCalls[0]?.[1]), '["album-message"]');
    }
  } finally {
    useConfirmDialog.getState().answer(false);
    h.unmount();
    useStore.setState(priorStore, true);
    if (rememberedDelete === null) localStorage.removeItem('gv_delete_only_me'); else localStorage.setItem('gv_delete_only_me', rememberedDelete);
    restoreLayout(); h.desktop();
  }
}

for (const kind of ['photo', 'video'] as const) for (const action of ['delete', 'forward'] as const)
  it(`R213 просмотрщик ${kind === 'photo' ? 'фото' : 'видео'} ${action === 'delete' ? 'удаляет' : 'пересылает'} только второй элемент альбома`,
    () => scene(h.Pane, h.ConfirmHost, h.server, { kind, action }));
for (const action of ['delete', 'forward'] as const)
  it(`R213 ПКМ по фото на ПК предлагает ${action === 'delete' ? '«Удалить фото»' : '«Переслать фото»'} и действует на эту ячейку`,
    () => scene(h.Pane, h.ConfirmHost, h.server, { action, entry: 'cell' }));
it('R213 удаление своего элемента передаёт выбранную область у обоих',
  () => scene(h.Pane, h.ConfirmHost, h.server, { own: true, scope: 'both' }));
it('R213 отмена удаления не вызывает ни новый callback, ни прежнее удаление сообщения',
  () => scene(h.Pane, h.ConfirmHost, h.server, { cancel: true }));
for (const entry of ['viewer', 'cell'] as const) for (const action of ['delete', 'forward'] as const)
  it(`R213 без album1 ${entry === 'viewer' ? 'просмотрщик' : 'ПКМ ячейки'} сохраняет ${action === 'delete' ? 'удаление' : 'пересылку'} целого сообщения`,
    () => scene(h.Pane, h.ConfirmHost, h.server, { entry, action, enabled: false }));
it('R213 меню ячейки на телефоне выбирает альбом целиком даже с поддержкой album1',
  () => scene(h.Pane, h.ConfirmHost, h.server, { entry: 'cell', phone: true }));

for (const [name, from, to, options, prefix, actual, expected] of [
  ['просмотрщик берёт первую фотографию вместо выбранной', '      const att = x.att;', '      const att = m.attachments![0]!;', {},
    'G56-delete: callback', '[["delete","album-message","photo-first","me"]]', '[["delete","album-message","selected-item","me"]]'],
  ['пересылка просмотрщика теряет attachmentId', '          openForwardItem(m, att);', '          openForward([m.id]);', { action: 'forward' },
    'G56-forward: callback', '[]', '[["forward","album-message","selected-item","target",false,{"hideSender":false}]]'],
  ['ПКМ не распознаёт ячейку альбома', 'item: photoLink ? albumCellFromTarget(m.attachments, t) : undefined,', 'item: undefined,', { entry: 'cell' },
    'G56-menu: пункт', false, true],
] as const) h.mutantTest(`R213 UI контрфакт: ${name}`, () => h.rejectMutant(source => {
  assert.equal(source.split(from).length - 1, 1, 'мутант меняет одно место полного MessagePane');
  return source.replace(from, to);
}, async (component, confirm, _answer, runtime) => {
  try { await scene(component, confirm!, runtime!, options); }
  catch (error) {
    if (!process.env.GUSVOICE_PANE_MUTANT) throw error;
    assert.ok(error instanceof assert.AssertionError, 'UI-мутант дошёл до host AssertionError');
    assert.ok(error.message.startsWith(prefix), 'UI-мутант упал на заявленном действии, не на загрузке или предусловии');
    assert.equal(error.operator, 'strictEqual', 'UI-мутант упал на строгом сравнении действия');
    assert.equal(error.actual, actual, 'у UI-мутанта проверено фактическое значение');
    assert.equal(error.expected, expected, 'у UI-мутанта проверено ожидаемое значение');
    throw error;
  }
}, prefix));
