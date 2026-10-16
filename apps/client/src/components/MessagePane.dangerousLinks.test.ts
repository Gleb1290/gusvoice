import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import { FEATURE_LINKTHREATS1 } from '@gusvoice/shared';
import type { ViteDevServer } from 'vite';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);
const url = 'https://user@evil.example/r148';
const message = () => ({ ...h.msg('r148-danger', 'peer'), content: url, dangerousLinks: ['evil.example'] });

async function feature(runtime: ViteDevServer, enabled: boolean) {
  const { useStore } = await runtime.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const previous = useStore.getState().serverFeatures;
  useStore.setState({ serverFeatures: enabled ? [FEATURE_LINKTHREATS1] : [] });
  return () => useStore.setState({ serverFeatures: previous });
}

async function openMenu() {
  const link = h.host.querySelector<HTMLAnchorElement>('a.msg-link');
  assert.ok(link, 'в сообщении есть настоящий якорь');
  await act(async () => {
    link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await h.flush();
  });
  const open = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')]
    .find(b => b.textContent?.includes('Открыть'));
  assert.ok(open, 'меню предлагает открытие ссылки');
  await act(async () => { open.click(); await h.flush(); });
}

async function gatedRow(component = h.Pane, runtime = h.server) {
  // Непрошедший handshake не позволяет доверять полю из DTO старого/чужого сервера.
  const restore = await feature(runtime, false);
  try {
    h.desktop();
    await h.mount({ messages: [message()] }, component);
    assert.equal(!!h.host.querySelector('.danger-link-badge'), false, 'без признака сервера нет плашки угрозы');
    assert.equal(!!h.host.querySelector('a.danger-link'), false, 'без признака якорь остаётся прежним');
  } finally { h.unmount(); restore(); }
}

it('R148 без признака сервера поле dangerousLinks не меняет строку сообщения', async () => {
  await gatedRow();
});

it('R148 с признаком сервера строка передаёт список в настоящую ссылку и показывает плашку', async () => {
  // Ловит разрыв между DTO, renderContent и MessageLink при исправных отдельных правилах.
  const restore = await feature(h.server, true);
  try {
    await h.mount({ messages: [message()] });
    assert.equal(h.host.querySelector('a.danger-link')?.getAttribute('href'), url);
    assert.equal(h.host.querySelector('.danger-link-badge')?.textContent, 'Опасная ссылка');
  } finally { h.unmount(); restore(); }
});

it('R148 опасное превью не запрашивается, безопасное соседнее по-прежнему запрашивается', async () => {
  // Проверяем не отсутствие карточки в пустой сети, а отсутствие самого запроса опасного адреса.
  const restore = await feature(h.server, true);
  const { api } = await h.server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const previous = api.linkPreview;
  const setting = localStorage.getItem('gv_link_preview');
  const calls: string[] = [];
  api.linkPreview = async link => { calls.push(link); return null; };
  localStorage.setItem('gv_link_preview', 'on');
  try {
    const safe = 'https://safe.example/r148-preview';
    await h.mount({ messages: [{ ...message(), content: `${url} ${safe}` }] });
    await act(async () => { await h.flush(); });
    assert.deepEqual(calls, [safe], 'соседнее безопасное превью работает, опасное даже не загружается');
  } finally {
    h.unmount(); api.linkPreview = previous; restore();
    if (setting === null) localStorage.removeItem('gv_link_preview'); else localStorage.setItem('gv_link_preview', setting);
  }
});

async function dangerousMenu(component = h.Pane, confirm = h.ConfirmHost, runtime = h.server) {
  // userinfo одновременно делает адрес подозрительным: нужен приоритет угрозы, не обычный interstitial.
  const restore = await feature(runtime, true);
  const { useConfirmDialog } = await runtime.ssrLoadModule('/src/confirm.ts') as typeof import('../confirm');
  const previousOpen = window.open;
  const opened: unknown[][] = [];
  window.open = ((...args: unknown[]) => { opened.push(args); return null; }) as typeof window.open;
  try {
    h.desktop();
    await h.mountWithConfirm({ messages: [message()] }, component, confirm);
    await openMenu();
    assert.equal(useConfirmDialog.getState().pending?.title, 'Опасная ссылка', 'угроза проверяется раньше подозрительности');
    assert.equal(!!document.querySelector('.link-confirm'), false, 'второе окно подозрительности не открыто');
    assert.deepEqual(opened, [], 'до ответа адрес не открыт');
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('.confirm-actions button')]
      .find(b => b.textContent === 'Отмена');
    assert.ok(cancel);
    assert.equal(document.activeElement === cancel, true, 'опасное действие по умолчанию фокусирует отмену');
    await act(async () => { cancel.click(); await h.flush(); });
    assert.deepEqual(opened, [], 'отмена не открывает адрес');
    await openMenu();
    const accept = document.querySelector<HTMLButtonElement>('.confirm-primary');
    assert.equal(accept?.textContent, 'Всё равно открыть');
    assert.ok(accept);
    await act(async () => { accept.click(); await h.flush(); });
    assert.deepEqual(opened, [[url, '_blank', 'noopener,noreferrer']], 'подтверждение открывает адрес ровно один раз');
  } finally {
    h.unmount(); useConfirmDialog.getState().answer(false); window.open = previousOpen; restore();
  }
}

it('R148 команда меню отдаёт опасную и подозрительную ссылку окну угрозы с отменой и подтверждением', async () => {
  await dangerousMenu();
});

it('R148 без признака сервера меню использует прежнее окно подозрительности', async () => {
  // Парное разрешение прежнего пути: отключение новой проверки не отключает защиту от userinfo.
  const restore = await feature(h.server, false);
  try {
    h.desktop(); await h.mountWithConfirm({ messages: [message()] }); await openMenu();
    assert.equal(!!document.querySelector('.link-confirm'), true);
    assert.equal(!!document.querySelector('.confirm.danger'), false);
  } finally { h.unmount(); restore(); }
});

h.mutantTest('R148 мутант без признака сервера доверяет dangerousLinks в MessageRow', async () => {
  await h.rejectMutant(source => {
    const from = '(serverLinkThreats(s.serverFeatures) ? m.dangerousLinks : undefined)';
    assert.equal(source.split(from).length - 1, 1);
    return source.replace(from, 'm.dangerousLinks');
  }, async (component, _confirm, _answer, runtime) => gatedRow(component, runtime!), 'без признака сервера нет плашки');
});

h.mutantTest('R148 мутант меню пропускает угрозу и показывает только подозрительность', async () => {
  await h.rejectMutant(source => {
    const from = 'if (serverLinkThreats(useStore.getState().serverFeatures) && isDangerousLink(url, m.dangerousLinks)) {';
    assert.equal(source.split(from).length - 1, 1);
    return source.replace(from, 'if (false) {');
  }, async (component, confirm, _answer, runtime) => dangerousMenu(component, confirm!, runtime!), 'угроза проверяется раньше');
});
