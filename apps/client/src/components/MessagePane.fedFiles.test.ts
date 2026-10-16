import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import type { ViteDevServer } from 'vite';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);
const hint = 'Файлы между инстансами пока не поддерживаются';
async function stores(server: ViteDevServer) {
  const { useStore } = await server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const { useToasts } = await server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
  const initial = useStore.getState(), initialToasts = useToasts.getState();
  h.resetStore = () => { useStore.setState(initial, true); useToasts.setState(initialToasts, true); };
  return useToasts;
}
function layout(phone: boolean) {
  const restore = h.pointerLayout(phone, phone ? 390 : 1200);
  if (phone) h.mobile(); else h.desktop();
  return () => { h.desktop(); restore(); };
}
function node<T extends Element>(selector: string): T {
  const found = h.host.querySelector<T>(selector);
  assert.equal(!!found, true, `есть ${selector}`);
  return found!;
}
function transfer(files: File[]) {
  return { types: ['Files'], files, items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })), getData: () => '' };
}
async function event(type: 'paste' | 'drop' | 'dragenter' | 'dragleave', files: File[] = []) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  if (type === 'paste') Object.defineProperty(e, 'clipboardData', { value: transfer(files) });
  else Object.defineProperty(e, 'dataTransfer', { value: transfer(files) });
  await act(async () => {
    (type === 'paste' ? node<HTMLTextAreaElement>('.composer textarea') : node<HTMLElement>('.chat')).dispatchEvent(e);
    await h.flush();
  });
  return e;
}
function noFilesUi() {
  assert.equal(!!document.querySelector('.sfb'), false, 'запрет файлов не открывает окно отправки');
  assert.equal(!!h.host.querySelector('.pending-atts'), false, 'запрет файлов не открывает полосу загрузки');
}
function noMenu() {
  assert.equal(!!document.querySelector('.ctx-menu,.sheet-scrim'), false, 'запрет файлов не раскрывает меню или BottomSheet');
}
for (const phone of [false, true]) for (const buttonClass of ['plus', 'attach']) {
  it(`R192 ${phone ? 'телефон' : 'ПК'}: ${buttonClass} при запрете даёт подсказку и тост, без запрета открывает настоящий выбор`, async () => {
    // Класс ошибки доступности: aria-disabled не отключает DOM-click сама, поэтому handler обязан остановить меню.
    const restore = layout(phone), toasts = await stores(h.server);
    try {
      await h.mount({ filesBlocked: hint });
      const button = node<HTMLButtonElement>(`.att-btn.${buttonClass}`), n = toasts.getState().toasts.length;
      assert.equal(button.getAttribute('aria-disabled'), 'true'); assert.equal(button.title, hint);
      await act(async () => { button.click(); await h.flush(); });
      assert.equal(toasts.getState().toasts.length, n + 1); assert.equal(toasts.getState().toasts.at(-1)?.title, hint);
      assert.equal(toasts.getState().toasts.at(-1)?.type, 'info'); noMenu(); noFilesUi();
      h.unmount(); await h.mount({});
      const normal = node<HTMLButtonElement>(`.att-btn.${buttonClass}`);
      assert.equal(normal.getAttribute('aria-disabled'), null); assert.equal(normal.title, 'Прикрепить');
      await act(async () => { normal.click(); await h.flush(); });
      assert.equal(normal.getAttribute('aria-expanded'), 'true');
      assert.equal(!!document.querySelector('.ctx-menu,.sheet-scrim'), true, 'обычная кнопка раскрывает выбор');
      const labels = [...document.querySelectorAll('.ctx-menu button,.sheet-row')].map(el => el.textContent?.trim());
      assert.equal(labels.some(s => s === 'Файл'), true); assert.equal(labels.some(s => s?.includes('Фото или видео')), true);
    } finally { h.unmount(); restore(); }
  });
}
async function filesScenario(phone: boolean, way: 'paste' | 'drop', component = h.Pane, server = h.server) {
  const restore = layout(phone), toasts = await stores(server);
  let enqueued = 0, sent = 0;
  const outbox = { items: [], enqueue() { enqueued++; }, retry() {}, discard() {} } as never;
  try {
    await h.mount({ filesBlocked: hint, outbox, onSend: async () => { sent++; } }, component);
    const n = toasts.getState().toasts.length;
    const blocked = await event(way, [new File(['data'], 'fed-test.txt', { type: 'text/plain' })]);
    // Первым проверяем именно side-effect UI: мутант guard обязан падать здесь, не на отсутствии тоста.
    noFilesUi();
    assert.equal(blocked.defaultPrevented, true); assert.equal(toasts.getState().toasts.length, n + 1);
    assert.equal(toasts.getState().toasts.at(-1)?.title, hint); noMenu();
    assert.equal(enqueued, 0); assert.equal(sent, 0);
    h.unmount();
    await h.mount({ outbox, onSend: async () => { sent++; } }, component);
    const before = toasts.getState().toasts.length;
    await event(way, [new File(['data'], 'allowed-test.txt', { type: 'text/plain' })]);
    assert.equal(!!document.querySelector('.sfb'), !phone, 'ПК сохраняет окно отправки файлов');
    assert.equal(!!h.host.querySelector('.pending-atts'), phone, 'телефон сохраняет полосу файлов');
    const text = phone ? h.host.querySelector('.pending-atts')?.textContent : document.querySelector('.sfb')?.textContent;
    assert.equal(text?.includes('allowed-test.txt'), true);
    assert.equal(toasts.getState().toasts.length, before, 'обычный файл не выдаёт тост запрета');
    assert.equal(enqueued, 0); assert.equal(sent, 0);
  } finally { h.unmount(); restore(); }
}
for (const phone of [false, true]) for (const way of ['paste', 'drop'] as const) {
  it(`R192 ${phone ? 'телефон' : 'ПК'}: ${way} файла при запрете даёт тост без окна и полосы, обычный файл принимается`, async () => {
    // Класс ошибки обхода кнопки: clipboard/drop должны соблюдать тот же запрет, что скрепка.
    await filesScenario(phone, way);
  });
}
async function dragScenario(phone: boolean, component = h.Pane) {
  const restore = layout(phone);
  try {
    await h.mount({ filesBlocked: hint }, component);
    await event('dragenter', [new File(['data'], 'drag-test.txt', { type: 'text/plain' })]);
    assert.equal(node<HTMLElement>('.chat').classList.contains('drag-over'), false, 'запрет файлов не подсвечивает бросок');
    h.unmount(); await h.mount({}, component);
    await event('dragenter', [new File(['data'], 'drag-test.txt', { type: 'text/plain' })]);
    assert.equal(node<HTMLElement>('.chat').classList.contains('drag-over'), true, 'обычный файл подсвечивает бросок');
    await event('dragleave'); assert.equal(node<HTMLElement>('.chat').classList.contains('drag-over'), false);
  } finally { h.unmount(); restore(); }
}
for (const phone of [false, true]) it(`R192 ${phone ? 'телефон' : 'ПК'}: dragenter Files не рисует рамку при запрете, обычный рисует`, async () => {
  // Класс ошибки ложного affordance: запрещённый бросок не должен обещать успешную загрузку.
  await dragScenario(phone);
});
function change(source: string, anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь');
  return source.replace(anchor, replacement);
}
h.mutantTest('R192 удаление filesBlocked в addFiles обнаруживается окном настоящего paste handler', async () => {
  // Класс ошибки обхода запрета: оригинал проходит тот же DOM-сценарий перед целым мутированным Vite-модулем.
  await h.rejectMutant(source => change(source, "if (filesBlocked) return void toast('info', filesBlocked);", '// guard удалён'),
    async (component, _confirm, _answer, runtime) => filesScenario(false, 'paste', component, runtime!), 'запрет файлов не открывает окно отправки');
});
h.mutantTest('R192 удаление filesBlocked в dragenter обнаруживается настоящим DOM-событием Files', async () => {
  // Класс ошибки ложной рамки: handler мутанта должен дать адресный AssertionError, не ошибку импорта или таймаут.
  await h.rejectMutant(source => change(source,
    "if (![...e.dataTransfer.types].includes('Files') || filesBlocked) return;",
    "if (![...e.dataTransfer.types].includes('Files')) return;"),
    async component => dragScenario(false, component), 'запрет файлов не подсвечивает бросок');
});
