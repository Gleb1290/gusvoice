import { mutantTest, mutantsEnabled } from '../../../../packages/shared/test/counterfacts.js';
import { it as nodeIt, type TestOptions } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window as HappyWindow } from 'happy-dom';
import { createElement, act } from 'react';
import type { DmChannel, Message } from '@gusvoice/shared';
import { sentAtLabel } from '../messagePaneRules';
import { placeByAnchor, toLayoutRect } from '../popover';
import type { Props } from './MessagePane.behavior.harness';

// React фиксирует поддержку input при ПЕРВОМ импорте renderer. Общий harness
// регистрирует HappyDOM лишь в before: статический import здесь включал IE9-polyfill.
// Настоящий временный DOM нужен только для feature detection; часы Node не подменяем.
async function loadFeedRenderer() {
  const bootstrap = new HappyWindow({ url: 'http://localhost/' });
  const saved: Array<{ key: string; descriptor: PropertyDescriptor | undefined }> = [];
  try {
    for (const [key, value] of Object.entries({ window: bootstrap, document: bootstrap.document, navigator: bootstrap.navigator })) {
      saved.push({ key, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) });
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const harness = await import('./MessagePane.behavior.harness');
    const client = await import('react-dom/client');
    const utils = await import('react-dom/test-utils');
    return { setupHarness: harness.setupHarness, createRoot: client.createRoot, Simulate: utils.Simulate };
  } finally {
    try { await bootstrap.happyDOM.close(); } finally {
      for (const { key, descriptor } of saved.reverse()) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
}
const { setupHarness, createRoot, Simulate } = await loadFeedRenderer();

// Одна лента и один основной runtime; мутанты сохраняют изолированные child entrypoints.
const h = setupHarness(import.meta.url);
let feedRestores: Array<() => void> | undefined;
function feedPatch(target: object, key: PropertyKey, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  feedRestores?.push(() => {
    if (previous) Object.defineProperty(target, key, previous); else Reflect.deleteProperty(target, key);
  });
  return Object.defineProperty(target, key, descriptor);
}
function feedMethod<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): T[K] {
  feedPatch(target, key, { configurable: true, writable: true, value });
  return value;
}
async function feedFixture(work: () => void | Promise<void>) {
  assert.equal(feedRestores, undefined, 'фикстуры ленты не накладываются друг на друга');
  const restores: Array<() => void> = [];
  feedRestores = restores;
  const windowErrors: unknown[] = [];
  const onWindowError = (event: ErrorEvent) => { windowErrors.push(event.error ?? event.message); };
  window.addEventListener('error', onWindowError);
  restores.push(() => window.removeEventListener('error', onWindowError));
  try {
    // У HappyDOM собственный загрузчик навигации: global fetch его не перехватывает.
    const settings = (window as unknown as HappyWindow).happyDOM.settings;
    for (const key of ['disableMainFrameNavigation', 'disableChildFrameNavigation', 'disableChildPageNavigation', 'disableFallbackToSetURL'] as const)
      feedPatch(settings.navigation, key, { configurable: true, writable: true, value: true });
    const offline: typeof settings.fetch.interceptor = {
      beforeAsyncRequest: async ({ window: realm }) => new realm.Response(null, { status: 503 }),
      beforeSyncRequest: () => { throw new Error('Синхронная сеть в фикстуре ленты запрещена'); },
    };
    feedPatch(settings.fetch, 'interceptor', { configurable: true, writable: true, value: offline });
    // В child мутанта основной server намеренно отсутствует: его создаёт rejectMutant.
    if (h.server) {
      const { useStore } = await h.server.ssrLoadModule('/src/store.ts') as typeof import('../store');
      const { useToasts } = await h.server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
      const { useConfirmDialog } = await h.server.ssrLoadModule('/src/confirm.ts') as typeof import('../confirm');
      const { useDmStickers } = await h.server.ssrLoadModule('/src/dmStickers.ts') as typeof import('../dmStickers');
      const store = useStore.getState(), toasts = useToasts.getState(), confirm = useConfirmDialog.getState(), stickers = useDmStickers.getState();
      restores.push(() => {
        useStore.setState(store, true); useToasts.setState(toasts, true); useConfirmDialog.setState(confirm, true); useDmStickers.setState(stickers, true);
      });
    }
    for (const storage of [localStorage, sessionStorage]) {
      const entries = Array.from({ length: storage.length }, (_, i) => storage.key(i)!)
        .map(key => [key, storage.getItem(key)!] as const);
      restores.push(() => { storage.clear(); for (const [key, value] of entries) storage.setItem(key, value); });
    }
    const children = new Set(document.body.childNodes);
    restores.push(() => { for (const child of [...document.body.childNodes]) if (!children.has(child)) child.remove(); });
    const attributes = [...document.documentElement.attributes].map(({ name, value }) => [name, value] as const);
    restores.push(() => {
      for (const attr of [...document.documentElement.attributes]) document.documentElement.removeAttribute(attr.name);
      for (const [name, value] of attributes) document.documentElement.setAttribute(name, value);
    });
    // Эти подмены ставят методы общего harness; остальные регистрирует feedPatch/Method.
    for (const [target, keys] of [
      [window, ['matchMedia', '__TAURI_INTERNALS__']], [navigator, ['userAgent']],
    ] as const) for (const key of keys) {
      const previous = Object.getOwnPropertyDescriptor(target, key);
      restores.push(() => { if (previous) Object.defineProperty(target, key, previous); else Reflect.deleteProperty(target, key); });
    }
    await work();
  } finally {
    try {
      // Сначала React снимает эффекты, listeners и ручные часы, ещё видя свою геометрию.
      h.unmount();
    } finally {
      try { h.resetStore?.(); } finally {
        h.resetStore = undefined;
        feedRestores = undefined;
        for (const restore of restores.reverse()) restore();
        assert.deepEqual(windowErrors, [], 'DOM-сценарий не оставляет необработанных ошибок оконных событий');
      }
    }
  }
}
function it(name: string, options: TestOptions | (() => void | Promise<void>), scenario?: () => void | Promise<void>) {
  return nodeIt(name, typeof options === 'function' ? {} : options,
    () => feedFixture(typeof options === 'function' ? options : scenario!));
}
function feedMutantTest(name: string, scenario: () => Promise<void>) {
  h.mutantTest(name, () => feedFixture(scenario));
}

// ---- behavior: сохранены исходные сценарии и матрицы. ----
it('выбор ЛС на десктопе ставит каретку в конец черновика, обновление истории оставляет выбранный фокус', async () => {
  feedPatch(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  const { useStore } = await h.server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const draft = { text: 'Черновик', replyToId: null };
  const props = { focusComposerOnOpen: true, feedId: 'focus-dm', draft };
  await h.mount(props);
  const field = h.host.querySelector<HTMLTextAreaElement>('.composer-input')!;
  assert.equal(document.activeElement, field);
  assert.equal(field.selectionStart, draft.text.length);
  assert.equal(field.selectionEnd, draft.text.length);

  const chatRow = document.createElement('button');
  document.body.append(chatRow);
  chatRow.focus();
  await h.rerender({ ...props, messages: [h.msg('new')] });
  assert.equal(document.activeElement, chatRow);
  await act(async () => { useStore.setState({ feedDownAsk: { id: props.feedId, n: 1 } }); });
  assert.equal(document.activeElement, field);
});

it('фокус при открытии ЛС уступает диалогу и остаётся на месте в браузере и мобильном приложении', async () => {
  h.desktop();
  await h.mount({ focusComposerOnOpen: true });
  assert.equal(document.activeElement, document.body);
  h.unmount();

  h.mobile();
  await h.mount({ focusComposerOnOpen: true });
  assert.equal(document.activeElement, document.body);
  h.unmount();

  h.desktop();
  feedPatch(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  const dialog = document.createElement('div');
  dialog.setAttribute('aria-modal', 'true');
  const button = document.createElement('button');
  dialog.append(button);
  document.body.append(dialog);
  button.focus();
  await h.mount({ focusComposerOnOpen: true });
  assert.equal(document.activeElement, button);
});

async function checkAttachKey(component = h.Pane) {
  // Общий запрет браузерных клавиш не должен гасить прикрепление, а окно поверх не должно пропускать его в беседу.
  h.round12(); h.desktop(); await h.mount({ messages: [h.msg('attach-key')] }, component);
  h.host.classList.add('content'); // Как реальный контейнер MainLayout: поле и лента принадлежат одной области.
  const file = h.host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const field = h.host.querySelector<HTMLTextAreaElement>('.composer-input')!;
  const row = h.host.querySelector<HTMLElement>('[data-mid="attach-key"]')!;
  assert.ok(file && field && row);
  let opened = 0; feedMethod(file, 'click', () => { opened++; });
  const key = (target: Element, prevented = false, repeat = false) => {
    const e = new KeyboardEvent('keydown', { key: 'щ', code: 'KeyO', ctrlKey: true, bubbles: true, cancelable: true, repeat });
    if (prevented) e.preventDefault(); target.dispatchEvent(e);
  };
  await act(async () => { key(field); key(row, true); await h.flush(); }); assert.equal(opened, 2);
  await act(async () => { key(field, false, true); await h.flush(); }); assert.equal(opened, 2);
  const overlay = document.createElement('div'); overlay.setAttribute('aria-modal', 'true'); document.body.append(overlay);
  try { await act(async () => { key(field); await h.flush(); }); assert.equal(opened, 2); } finally { overlay.remove(); }
  field.disabled = true;
  await act(async () => { key(row); await h.flush(); }); assert.equal(opened, 2); field.disabled = false;
  const other = document.createElement('textarea'); row.append(other);
  await act(async () => { key(other); await h.flush(); }); assert.equal(opened, 2); other.remove();
}
it('Ctrl+O открывает файл из поля и ленты даже после preventDefault, но уважает окно, чужое поле и disabled', async () => {
  await checkAttachKey();
  h.unmount();
  await h.rejectMutant((s) => s.replace('(e.defaultPrevented && !attachKey(e))', 'e.defaultPrevented'), checkAttachKey);
});
async function checkEnterLine(component = h.Pane) {
  // Чистая таблица клавиш не доказывает, что React-поле действительно вставляет перевод строки вместо отправки.
  h.round12(); h.desktop(); localStorage.setItem('gv_send_mode', 'enter');
  const sent: string[] = [];
  await h.mount({ onSend: async (text) => { sent.push(text); } }, component);
  const field = h.host.querySelector<HTMLTextAreaElement>('.composer-input')!;
  field.focus();
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  let breaks = 0;
  // HappyDOM пишет через React-перехватчик value; нативный setRangeText браузера его обходит.
  feedMethod(field, 'setRangeText', ((replacement: string, start: number, end: number) => {
    breaks++;
    const value = field.value; setValue.call(field, value.slice(0, start) + replacement + value.slice(end));
    field.setSelectionRange(start + replacement.length, start + replacement.length);
  }) as typeof field.setRangeText);
  await act(async () => { setValue.call(field, 'ab'); field.dispatchEvent(new Event('input', { bubbles: true })); await h.flush(); });
  field.setSelectionRange(1, 1);
  const exec = Object.getOwnPropertyDescriptor(document, 'execCommand');
  feedPatch(document, 'execCommand', { configurable: true, value: () => false });
  try {
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })); await h.flush(); });
    assert.equal(breaks, 1, 'обработчик вызвал нативную вставку');
    assert.equal(field.value, 'a\nb'); assert.deepEqual(sent, []);
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); await h.flush(); });
    assert.deepEqual(sent, ['a\nb']);
  } finally { h.unmount(); if (exec) Object.defineProperty(document, 'execCommand', exec); else Reflect.deleteProperty(document, 'execCommand'); }
}
it('Ctrl+Enter в обычном режиме вставляет перенос в поле, Ctrl+Shift+Enter отправляет один раз', async () => {
  await checkEnterLine();
  h.unmount();
  await h.rejectMutant((s) => {
    const needle = 'insertLineBreak(e.currentTarget);'; const at = s.lastIndexOf(needle); assert.ok(at > 0);
    return s.slice(0, at) + s.slice(at + needle.length);
  }, checkEnterLine);
});

mutantTest('внешний watchdog прерывает заблокированный event loop, не выдавая таймаут за пойманного мутанта', async () => {
  // Таймер в дочернем процессе не может прервать этот цикл: спасает только внешний kill + close.
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.GUSVOICE_PANE_MUTANT;
  await assert.rejects(() => h.isolatedProcess(['--eval', 'while (true) {}'], env, 'проверка watchdog', 150),
    (error: unknown) => error instanceof Error && !(error instanceof assert.AssertionError) && /Таймаут харнесса/.test(error.message));
});

it('галочки прочтения есть только у своих пузырей до ключа, чужие и каналы без отметок', async () => {
  const messages = [h.msg('m10', 'me', 0, 10), h.msg('m15', 'peer', 0, 15), h.msg('m20', 'me', 0, 20), h.msg('m30', 'me', 0, 30)];
  await h.mount({ messages, peerReadKey: 20 });
  for (const id of ['m10', 'm20']) assert.ok(h.host.querySelector(`[data-mid="${id}"] .bub-st.read`));
  assert.ok(h.host.querySelector('[data-mid="m30"] .bub-st.sent')); assert.equal(h.host.querySelector('[data-mid="m15"] .bub-st') === null, true);
  await h.rerender({ messages, peerReadKey: 30 }); assert.ok(h.host.querySelector('[data-mid="m30"] .bub-st.read'));
  await h.rerender({ messages, peerReadKey: null }); assert.equal(h.host.querySelector('.bub-st.read') === null, true);
  const list = h.host.querySelector('.messages');
  await h.rerender({ messages, bubbles: false, peerReadKey: 30 }); assert.equal(h.host.querySelector('.bub-st') === null, true);
  assert.ok(h.host.querySelector('.messages') === list, 'обёртка не перемонтирует ленту при переключении пузырей');
});
it('свои сохранённые и исходящие склеиваются в одну группу с единственным хвостом', async () => {
  const items = [{ ...h.out('sending'), key: 's', status: 'sending' as const, createdAt: h.now - 60000 }, h.out()];
  await h.mount({ messages: [h.msg('saved', 'me', 180000)], outbox: { items, enqueue: () => {}, retry: () => {}, discard: () => {} } });
  const rows = [...h.host.querySelectorAll('.message.bub')]; assert.equal(rows.length, 3);
  assert.equal(rows[0].classList.contains('tail'), false); assert.equal(rows[1].classList.contains('grouped'), true);
  assert.equal(rows[1].classList.contains('tail'), false); assert.equal(rows[2].classList.contains('grouped'), true); assert.equal(rows[2].classList.contains('tail'), true);
});
it('сдвиг прочтения перерисовывает только изменившую галочку строку, повтор не рисует ничего', async () => {
  // Ловит передачу сырого ключа всем memo-строкам вместо индивидуального read.
  const messages = [h.msg('m10', 'me', 0, 10), h.msg('m15', 'peer', 0, 15), h.msg('m20', 'me', 0, 20), h.msg('m30', 'me', 0, 30)];
  await h.mount({ messages, peerReadKey: 20 }); h.rendered.length = 0;
  await h.rerender({ messages, peerReadKey: 30 }); assert.deepEqual(h.rendered, ['m30']); h.rendered.length = 0;
  await h.rerender({ messages, peerReadKey: 30 }); assert.deepEqual(h.rendered, []);
});
it('после чужого и после паузы исходящее начинает новую группу, пустая беседа показывает день', async () => {
  const outbox = { items: [h.out()], enqueue: () => {}, retry: () => {}, discard: () => {} };
  for (const messages of [[h.msg('peer', 'peer')], [h.msg('old', 'me', 360000)]]) {
    if (!h.root) await h.mount({ messages, outbox }); else await h.rerender({ messages, outbox });
    const rows = [...h.host.querySelectorAll('.message.bub')]; assert.equal(rows[0].classList.contains('tail'), true); assert.equal(rows[1].classList.contains('grouped'), false);
  }
  await h.rerender({ messages: [], outbox }); assert.match(h.host.querySelector('.day-divider.pill')!.textContent!, /Сегодня/);
});
it('кнопка неотправленного открывает меню, переводит фокус и удаляет по ключу', async () => {
  const discarded: string[] = [];
  await h.mount({ outbox: { items: [h.out()], enqueue: () => {}, retry: () => {}, discard: (key) => discarded.push(key) } });
  const btn = h.host.querySelector<HTMLButtonElement>('.bub-fail-btn')!; assert.ok(btn); assert.equal(btn.type, 'button'); assert.equal(btn.getAttribute('aria-haspopup'), 'menu');
  assert.equal(btn.getAttribute('aria-expanded'), 'false'); assert.match(btn.title, /сеть/);
  await act(async () => { btn.click(); });
  await act(async () => { await h.delay(40); });
  const menu = document.querySelector<HTMLElement>('.ctx-menu[role="menu"]')!; assert.ok(menu); assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.ok(document.activeElement === menu.querySelector('button'), 'фокус на первом пункте меню'); assert.match(menu.textContent!, /Скопировать текст/);
  const del = [...menu.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Удалить'))!;
  await act(async () => { del.click(); await h.delay(); }); assert.deepEqual(discarded, ['k']); assert.equal(document.querySelector('.ctx-menu') === null, true);
});
it('меню сообщения всегда показывает действия, прочтение и реакции с якорем пикера', async () => {
  // Переключателя больше нет; содержимое карточки и якорь всех реакций остаются контрактом.
  const message = h.msg('menu', 'me');
  await h.mount({ messages: [message], peerReadKey: 10, onReact: () => {} });
  const enabledRow = h.host.querySelector<HTMLElement>('[data-mid="menu"]')!;
  await act(async () => { enabledRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 140, clientY: 160 })); await h.flush(); });
  const stack = document.querySelector('.ctx-stack'); assert.ok(stack, 'карточка меню доступна без переключателя');
  assert.deepEqual([...stack.querySelectorAll('.ctx-menu button')].map((b) => b.textContent?.trim()).filter(Boolean).slice(0, 3), ['Ответить', 'Изменить', 'Скопировать текст']);
  assert.ok(stack.querySelector('.react-bar'), 'меню показывает быстрые реакции'); assert.ok(stack.querySelector('.ctx-foot'), 'меню показывает подвал');
  assert.equal(stack.querySelector('.ctx-foot span:last-child')!.textContent, sentAtLabel(message.createdAt), 'DOM использует календарное время из sentAtLabel');
  assert.equal(stack.querySelector('svg title')?.textContent, 'Прочитано', 'галочка подвала следует ключу прочтения');
  const bar = stack.querySelector<HTMLElement>('.react-bar')!;
  feedMethod(bar, 'getBoundingClientRect', () => new DOMRect(180, 140, 248, 36));
  const width = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth');
  const height = Object.getOwnPropertyDescriptor(document.documentElement, 'clientHeight');
  feedPatch(document.documentElement, 'clientWidth', { configurable: true, value: 1000 });
  feedPatch(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  try {
    await act(async () => { stack.querySelector<HTMLButtonElement>('.react-bar-more')!.click(); await h.flush(); });
    assert.ok(!document.querySelector('.ctx-stack'), 'панель закрывается после «Все реакции»');
    const picker = document.querySelector<HTMLElement>('.emoji-pop'); assert.ok(picker, 'пикер эмодзи открывается по якорю полосы реакций');
    const expected = placeByAnchor(toLayoutRect(new DOMRect(180, 140, 248, 36)), picker.offsetWidth, picker.offsetHeight);
    const fromOldPoint = placeByAnchor(toLayoutRect(new DOMRect(140, 160, 0, 0)), picker.offsetWidth, picker.offsetHeight);
    assert.ok(expected.left !== fromOldPoint.left || expected.top !== fromOldPoint.top, 'новая позиция отличается от устаревшей точки клика по меню');
    assert.equal(Number.parseFloat(picker.style.left), expected.left, 'горизонтальная позиция вычислена от полосы реакций');
    assert.equal(Number.parseFloat(picker.style.top), expected.top, 'вертикальная позиция вычислена от полосы реакций');
  } finally {
    h.unmount();
    if (width) Object.defineProperty(document.documentElement, 'clientWidth', width); else Reflect.deleteProperty(document.documentElement, 'clientWidth');
    if (height) Object.defineProperty(document.documentElement, 'clientHeight', height); else Reflect.deleteProperty(document.documentElement, 'clientHeight');
  }
});
it('в узком окне правый клик открывает меню у строки, а не лист по точке', async () => {
  // Ловит прежний переход к листу на ширине, где новая ветка должна оставаться привязана к сообщению.
  h.round12(); const restoreNarrow = h.pointerLayout(false, 600);
  try {
    await h.mount({ messages: [h.msg('menu')], onReact: () => {} });
    const row = h.host.querySelector<HTMLElement>('[data-mid="menu"]')!;
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 90 })); await h.flush(); });
    assert.ok(document.querySelector('.ctx-stack.anchored'), 'узкое окно ставит новое меню у строки');
    assert.ok(document.querySelector('.ctx-spot'), 'у привязанного меню есть подсветка строки');
    assert.ok(!document.querySelector('.sheet'), 'узкое окно не заменяет карточку листом');
    await h.rerender({ messages: [], onReact: () => {} });
    assert.ok(!document.querySelector('.ctx-stack'), 'меню закрывается, если его строка исчезла из ленты');
  } finally { h.unmount(); restoreNarrow(); }
});
it('привязанное меню следует за геометрией строки и закрывается, когда строка исчезает', async () => {
  // Ловит отрыв поповера от пузыря при перестройке ленты и зависшее меню у уже удалённого сообщения.
  h.round12(); const restore = h.pointerLayout(false, 600);
  const width = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth');
  const height = Object.getOwnPropertyDescriptor(document.documentElement, 'clientHeight');
  feedPatch(document.documentElement, 'clientWidth', { configurable: true, value: 600 });
  feedPatch(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  try {
    await h.mount({ messages: [h.msg('follow')], onReact: () => {} });
    const row = h.host.querySelector<HTMLElement>('[data-mid="follow"]')!;
    const main = row.querySelector<HTMLElement>('.message-main')!;
    const list = h.host.querySelector<HTMLElement>('.messages')!;
    let rowTop = 300;
    feedMethod(main, 'getBoundingClientRect', () => new DOMRect(70, rowTop, 220, 50));
    feedMethod(row, 'getBoundingClientRect', () => new DOMRect(40, rowTop - 10, 320, 70));
    feedMethod(list, 'getBoundingClientRect', () => new DOMRect(0, 0, 600, 700));
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const menu = document.querySelector<HTMLElement>('.ctx-stack')!; assert.ok(menu, 'контекстное меню привязано к сообщению');
    const before = menu.style.top; rowTop = 430;
    await act(async () => { window.dispatchEvent(new Event('resize')); await h.delay(80); });
    assert.ok(menu.style.top !== before, 'после изменения прямоугольника строки меню пересчитало координату');
    list.scrollTop = 120;
    await act(async () => { list.dispatchEvent(new Event('scroll')); await h.delay(60); });
    assert.ok(document.querySelector('.ctx-stack'), 'программный scroll не закрывает якорное меню');
    assert.equal(list.scrollTop, 120, 'открытое меню не заставляет ленту прилипнуть к низу');
    await h.rerender({ messages: [], onReact: () => {} });
    assert.ok(!document.querySelector('.ctx-stack'), 'меню закрывается после удаления строки из DOM');
  } finally {
    h.unmount(); restore();
    if (width) Object.defineProperty(document.documentElement, 'clientWidth', width); else Reflect.deleteProperty(document.documentElement, 'clientWidth');
    if (height) Object.defineProperty(document.documentElement, 'clientHeight', height); else Reflect.deleteProperty(document.documentElement, 'clientHeight');
  }
});
it('R, E и Del действуют только вне полей ввода', async () => {
  // Ловит подписи-клавиши без обработчика и перехват букв, когда человек печатает в поле.
  h.round12(); await h.mount({ messages: [h.msg('keys')], onReact: () => {} });
  const row = h.host.querySelector<HTMLElement>('[data-mid="keys"]')!;
  const open = async () => act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); await h.flush(); });
  await open(); assert.ok(document.querySelector('.ctx-stack'), 'новое меню открыто перед проверкой горячих клавиш');
  for (const tag of ['input', 'textarea', 'select', 'div']) {
    const field = document.createElement(tag); if (tag === 'div') field.setAttribute('contenteditable', 'true'); h.host.append(field);
    for (const [code, key] of [['KeyR', 'к'], ['KeyE', 'у'], ['Delete', 'Delete']]) {
      await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true })); });
      assert.ok(document.querySelector('.ctx-stack'), `${code} в ${tag} не выполняет действие сообщения`);
    }
    field.remove();
  }
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'к', bubbles: true })); }); await h.flush();
  assert.ok(!document.querySelector('.ctx-stack'), 'R закрывает меню'); assert.ok(h.host.querySelector('.reply-strip'), 'R включает ответ на сообщение');
  await open();
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'у', bubbles: true })); }); await h.flush();
  assert.ok(!document.querySelector('.ctx-stack'), 'E закрывает меню'); assert.equal(h.host.querySelector<HTMLTextAreaElement>('.composer textarea')?.value, 'keys');
  assert.ok(h.host.querySelector('.edit-strip')); assert.equal(h.host.querySelector('.edit-box') === null, true);
  await act(async () => { h.host.querySelector('.composer textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await h.flush();
  await open();
  let del!: KeyboardEvent;
  await act(async () => { del = new KeyboardEvent('keydown', { code: 'Delete', key: 'Delete', bubbles: true, cancelable: true }); window.dispatchEvent(del); }); await h.flush();
  assert.ok(!document.querySelector('.ctx-stack'), 'Del закрывает меню перед подтверждением удаления'); assert.equal(del.defaultPrevented, true, 'Del перехвачен меню и запускает обычное подтверждение');
});
it('тапы по ссылке и строке «Переслано от» делают своё, а не открывают меню', async () => {
  h.round12(); const restore = h.pointerLayout(true, 390);
  try {
    const forwarded = { ...h.msg('forward'), content: 'https://example.com', forwardedFrom: { userId: 'peer', displayName: 'Друг', at: new Date(h.now).toISOString() } } as Message;
    await h.mount({ messages: [forwarded] });
    const link = h.host.querySelector<HTMLElement>('[data-mid="forward"] a'); assert.ok(link);
    await act(async () => { link!.click(); await h.flush(); }); assert.ok(!document.querySelector('.ctx-stack'), 'ссылка сохраняет собственное действие');
    const origin = h.host.querySelector<HTMLElement>('[data-mid="forward"] .bub-fwd'); assert.ok(origin);
    await act(async () => { origin!.click(); await h.flush(); }); assert.ok(!document.querySelector('.ctx-stack'), 'кнопка автора пересылки сохраняет открытие профиля');
    const main = h.host.querySelector<HTMLElement>('[data-mid="forward"] .message-main')!;
    await act(async () => { main.click(); await h.flush(); }); assert.ok(document.querySelector('.ctx-stack'), 'тап вне исключительных целей открывает меню');
  } finally { h.unmount(); restore(); }
});
it('клики по интерактивным потомкам пузыря не открывают меню, тап по самому пузырю открывает', async () => {
  // Регрессия: собственные фото/файл/голос/цитата/реакция должны выполнить своё действие, не подменяясь меню строки.
  h.round12(); const restore = h.pointerLayout(true, 390);
  try {
    const rich = { ...h.msg('targets'), attachments: [
      { url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', name: 'фото.gif', contentType: 'image/gif', size: 1, width: 1, height: 1 },
      { url: '/voice.ogg', name: 'голос.ogg', contentType: 'audio/ogg', size: 1, waveform: Array(12).fill(20), durationMs: 1000 },
      { url: '/file.pdf', name: 'файл.pdf', contentType: 'application/pdf', size: 1 },
    ], replyTo: { id: 'quoted', authorName: 'Друг', content: 'цитата' }, reactions: [{ emoji: '👍', count: 1, me: true }] } as Message;
    const reactions: string[] = [];
    await h.mount({ messages: [rich], onReact: (_id, emoji) => reactions.push(emoji) });
    const row = h.host.querySelector<HTMLElement>('[data-mid="targets"]')!;
    const main = row.querySelector<HTMLElement>('.message-main')!;
    const quote = main.querySelector<HTMLElement>('.reply-quote');
    assert.ok(quote, 'ответ в пузыре включает настоящую строку цитаты');
    assert.match(quote.textContent ?? '', /Друг.*цитата/, 'строка цитаты сохраняет автора и текст, а не только факт ссылки');
    const cases: [string, string, (node: HTMLElement) => void][] = [
      ['цитата', '.reply-quote', (node) => node.click()], ['фото', '.att-img-link', (node) => node.click()],
      ['голос', '.voice-play', (node) => node.click()], ['файл', '.att-file', (node) => node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))],
      ['реакция', '.reactions button', (node) => node.click()],
    ];
    for (const [label, selector, activate] of cases) {
      const node = main.querySelector<HTMLElement>(selector); assert.ok(node, `${label}: fixture отрисовал реальную цель`);
      await act(async () => { activate(node); await h.flush(); });
      assert.ok(!document.querySelector('.ctx-stack'), `${label}: действие цели не открывает меню сообщения`);
    }
    assert.deepEqual(reactions, ['👍'], 'чип реакции вызывает обработчик реакции');
    await act(async () => { main.click(); await h.flush(); }); assert.ok(document.querySelector('.ctx-stack'));
    h.unmount(); const fine = h.pointerLayout(false, 390);
    await h.mount({ messages: [h.msg('touch-click')] });
    const touchMain = h.host.querySelector<HTMLElement>('[data-mid="touch-click"] .message-main'); assert.ok(touchMain, 'есть цель тапа с fine primary pointer');
    const touchClick = new MouseEvent('click', { bubbles: true, cancelable: true }); Object.defineProperty(touchClick, 'pointerType', { value: 'touch' });
    await act(async () => { touchMain!.dispatchEvent(touchClick); await h.flush(); });
    assert.ok(document.querySelector('.ctx-stack.anchored'), 'явный pointerType touch открывает меню даже при coarse=false');
    h.unmount(); fine(); const coarse = h.pointerLayout(true, 390);
    await h.mount({ messages: [h.msg('mouse-click')] });
    const mouseMain = h.host.querySelector<HTMLElement>('[data-mid="mouse-click"] .message-main'); assert.ok(mouseMain, 'есть цель клика мышью на coarse-устройстве');
    const mouseClick = new MouseEvent('click', { bubbles: true, cancelable: true }); Object.defineProperty(mouseClick, 'pointerType', { value: 'mouse' });
    await act(async () => { mouseMain!.dispatchEvent(mouseClick); await h.flush(); });
    assert.ok(!document.querySelector('.ctx-stack'), 'явный pointerType mouse не получает touch-меню из coarse media query');
    h.unmount(); coarse();
  } finally { h.unmount(); restore(); }
});
it('меню канала соблюдает порядок, права закрепа и жалобы, пересланное не редактируется', async () => {
  // Ловит общий набор действий без проверки автора/прав и потерю нового меню в каналах без пузырей.
  h.round12(); const store = (await h.server.ssrLoadModule('/src/store.ts')).useStore as typeof import('../store').useStore;
  const initial = store.getState(); h.resetStore = () => store.setState(initial, true);
  store.setState({ members: [{ user: { id: 'guest', username: 'guest', displayName: 'Гость', avatarUrl: null,
    homeInstance: { instanceId: 'remote', name: 'Дом', domain: 'remote.test' } } } as never] });
  const pins: [string, boolean][] = [];
  const props = { bubbles: false, canModerate: true, onReact: () => {}, onCopyLink: () => {}, onPin: (m: Message, value: boolean) => pins.push([m.id, value]) };
  await h.mount({ ...props, messages: [h.msg('channel-menu')] });
  const open = async (id: string) => { await act(async () => {
    h.host.querySelector<HTMLElement>(`[data-mid="${id}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.delay(40);
  }); };
  const labels = () => [...document.querySelectorAll('.ctx-menu .ctx-label-main')].map(n => n.textContent);
  await open('channel-menu');
  assert.deepEqual(labels(), ['Ответить', 'Изменить', 'Закрепить', 'Скопировать текст', 'Скопировать ссылку', 'Удалить']);
  const card = document.querySelector<HTMLElement>('.ctx-menu')!;
  assert.equal(card.style.width, '248px'); assert.ok(!card.querySelector('.ctx-divider,.ctx-shortcut'), 'новое меню не содержит старых разделителей и подсказок');
  await act(async () => { [...card.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Закрепить')!.click(); await h.delay(40); });
  assert.deepEqual(pins, [['channel-menu', true]]);
  await h.rerender({ ...props, messages: [{ ...h.msg('channel-menu'), pinnedAt: new Date(h.now).toISOString() }] });
  await open('channel-menu'); assert.ok(labels().includes('Открепить'), 'закреплённое предлагает обратное действие');
  await h.rerender({ ...props, onPin: undefined, messages: [h.msg('guest-message', 'guest')] });
  await open('guest-message');
  assert.deepEqual(labels(), ['Ответить', 'Скопировать текст', 'Скопировать ссылку', 'Приложить к жалобе', 'Удалить']);
  await h.rerender({ bubbles: false, onReact: () => {}, canModerate: false, messages: [h.msg('guest-message', 'guest')] });
  await open('guest-message'); assert.deepEqual(labels(), ['Ответить', 'Скопировать текст']);
  const forwarded = { ...h.msg('forwarded-own'), forwardedFrom: { userId: 'guest', displayName: 'Гость', at: new Date(h.now).toISOString() } };
  await h.rerender({ messages: [forwarded], onReact: () => {} }); await open('forwarded-own');
  assert.ok(!labels().includes('Изменить'), 'пересылка не обещает запрещённую сервером правку');
});
it('действия пачкой открывают режим выделения из меню и позволяют выйти снятием последней строки', async () => {
  // Пустое выделение не должно оставлять скрытый режим, который перехватывает следующие клики.
  h.desktop(); h.round12();
  const messages = [h.msg('first'), h.msg('second', 'peer')];
  const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Собеседник', open: () => {} };
  await h.mount({ messages, batch, onReact: () => {} });
  const row = h.host.querySelector<HTMLElement>('[data-mid="first"]');
  assert.ok(row, 'сообщение из ленты доступно для действий');
  await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const select = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((button) => button.textContent?.includes('Выделить'));
  assert.ok(select, 'только беседа с действиями пачкой предлагает выделение');
  await act(async () => { select.click(); await h.flush(); });
  assert.match(h.host.textContent ?? '', /Выбрано 1/);
  const picked = h.host.querySelector<HTMLElement>('[data-mid="first"]');
  assert.equal(picked?.getAttribute('role'), 'checkbox');
  assert.equal(picked?.getAttribute('aria-checked'), 'true');
  assert.ok(h.host.querySelector('[data-mid="second"]'), 'невыбранное сообщение остаётся в ленте');
  await act(async () => { picked!.click(); await h.flush(); });
  assert.equal(h.host.querySelector('[data-mid="first"]')?.getAttribute('role'), null, 'снятие последнего выбора закрывает режим');
  assert.ok(!/Выбрано 0/.test(h.host.textContent ?? ''), 'пустая пачка не оставляет панель выделения');
});
it('строка неотправленного сообщения не предлагает вход в выделение пачки', async () => {
  // У отправки ещё нет серверного id: её нельзя переслать или удалить через API сообщений.
  h.desktop(); h.round12();
  const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Собеседник', open: () => {} };
  await h.mount({ outbox: h.queue(), batch });
  const body = h.host.querySelector<HTMLElement>('.message-body');
  assert.ok(body, 'неотправленное сообщение отрисовано');
  await act(async () => { body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  assert.ok(document.querySelector('.ctx-menu'), 'неотправленное сообщение сохраняет собственное меню');
  assert.ok(![...document.querySelectorAll('.ctx-menu button')].some((button) => button.textContent?.includes('Выделить')),
    'пачечный выбор не предлагается без серверного message id');
});
it('Escape не сбрасывает пачку под модальным диалогом или верхним слоем, но выходит без них', async () => {
  // Esc принадлежит открытому picker/подтверждению; если снять выделение первым, второе нажатие попадёт не туда.
  h.desktop(); h.round12();
  const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Собеседник', open: () => {} };
  await h.mount({ messages: [h.msg('escape-picked')], batch });
  await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="escape-picked"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const select = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((button) => button.textContent?.includes('Выделить'));
  assert.ok(select, 'контекстное меню позволяет войти в режим выделения'); await act(async () => { select.click(); await h.flush(); });
  for (const layer of ['[aria-modal="true"]', '.confirm-overlay']) {
    const overlay = document.createElement('div'); overlay.setAttribute('aria-modal', 'true');
    if (layer.startsWith('.')) { overlay.removeAttribute('aria-modal'); overlay.className = layer.slice(1); }
    document.body.append(overlay);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await h.flush(); });
    assert.match(h.host.textContent ?? '', /Выбрано 1/, `${layer}: верхний слой сохраняет выделение`);
    overlay.remove();
  }
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await h.flush(); });
  assert.ok(!h.host.querySelector('.sel-head'), 'без перекрывающего слоя Esc завершает выделение');
});
feedMutantTest('короткий клик ПК по микрофону переключает кружок, а не запускает запись', async () => {
  // На ПК отпускание раньше 120 мс — это выбор режима; обычная запись остаётся за длинным удержанием.
  await h.rejectMutant((source) => source.replace('onPointerUp={onDeskMicUpRound}', 'onPointerUp={onDeskMicUp}'), async (component) => {
    const recorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
    const media = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    const capture = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'captureStream');
    let requested = 0;
    class TestRecorder { static isTypeSupported() { return true; } }
    feedPatch(globalThis, 'MediaRecorder', { configurable: true, value: TestRecorder });
    feedPatch(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => { requested++; return new Promise<MediaStream>(() => {}); } } });
    feedPatch(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: () => ({}) });
    try {
      h.desktop(); h.round12(); localStorage.removeItem('gv.recMode');
      await h.mount({ roundOk: true, onSendVoice: async () => {} }, component);
      const button = h.host.querySelector<HTMLButtonElement>('.att-btn.voice'); assert.ok(button, 'голосовая кнопка доступна на рабочем столе');
      const pointer = (type: string) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        for (const [key, value] of Object.entries({ pointerId: 7, pointerType: 'mouse', button: 0, clientX: 30, clientY: 30 }))
          Object.defineProperty(event, key, { value });
        button.dispatchEvent(event);
      };
      await act(async () => { pointer('pointerdown'); await h.delay(80); pointer('pointerup'); await h.flush(); });
      assert.equal(localStorage.getItem('gv.recMode'), 'round', 'короткий отпуск переключает и запоминает режим кружка');
      assert.equal(requested, 0, 'до порога удержания камера и микрофон не запрашиваются');
    } finally {
      h.unmount();
      if (recorder) Object.defineProperty(globalThis, 'MediaRecorder', recorder); else Reflect.deleteProperty(globalThis, 'MediaRecorder');
      if (media) Object.defineProperty(navigator, 'mediaDevices', media); else Reflect.deleteProperty(navigator, 'mediaDevices');
      if (capture) Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', capture); else Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream');
    }
  });
});
it('выделение разрешает Изменить/Ответить только для одного своего не-пересланного сообщения', async () => {
  // UI не должен обещать сервером запрещённую правку или убирать доступный ответ на чужое сообщение.
  h.desktop(); h.round12();
  const own = h.msg('own');
  const peer = h.msg('peer', 'peer');
  const sticker = { ...h.msg('selected-sticker'), content: '', sticker: { id: 'selected-1', emoji: '🦆', url: '/duck.webp', format: 'webp' } } as Message;
  const forwarded = { ...h.msg('fwd'), forwardedFrom: { userId: 'peer', displayName: 'Собеседник', at: new Date(h.now).toISOString() } } as Message;
  const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Собеседник', open: () => {} };
  const enter = async (id: string) => {
    const row = h.host.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    assert.ok(row, `сообщение ${id} присутствует`);
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const button = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((item) => item.textContent?.includes('Выделить'));
    assert.ok(button, 'контекстное меню предлагает вход в выделение');
    await act(async () => { button.click(); await h.flush(); });
  };
  await h.mount({ messages: [own, peer, forwarded, sticker], batch, onReact: () => {} });
  await enter('own');
  assert.ok(h.host.querySelector('[aria-label="Изменить"]'), 'одно своё исходное сообщение можно править');
  assert.ok(h.host.querySelector('.sel-bar')?.textContent?.includes('Ответить'), 'одно сообщение можно процитировать');
  await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="selected-sticker"]')!.click(); await h.flush(); });
  assert.ok(!h.host.querySelector('[aria-label="Изменить"]'), 'добавленный в пачку стикер не получает кнопку правки');
  await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="selected-sticker"]')!.click(); await h.flush(); });
  assert.ok(h.host.querySelector('[aria-label="Изменить"]'), 'снятие стикера возвращает правку единственного текстового сообщения');
  await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="own"]')!.click(); await h.flush(); });
  await enter('peer');
  assert.ok(!h.host.querySelector('[aria-label="Изменить"]'), 'чужое сообщение не обещает запрещённую правку');
  assert.ok(h.host.querySelector('.sel-bar')?.textContent?.includes('Ответить'), 'ответ на чужое сообщение остаётся доступен');
  await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="peer"]')!.click(); await h.flush(); });
  await enter('fwd');
  assert.ok(!h.host.querySelector('[aria-label="Изменить"]'), 'пересланное своё сообщение нельзя править');
  await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="fwd"]')!.click(); await h.flush(); });
  await enter('own');
  await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="peer"]')!.click(); await h.flush(); });
  assert.ok(!h.host.querySelector('[aria-label="Изменить"]'), 'несколько сообщений нельзя редактировать пачкой');
  assert.ok(!h.host.querySelector('.sel-bar')?.textContent?.includes('Ответить'), 'ответ доступен только для одного сообщения');
});
feedMutantTest('свой стикер нельзя редактировать через меню ПК и меню у пузыря телефона', async () => {
  // Стикер — отправленное медиа без редактируемого текста: обе живые точки входа не обещают правку.
  await h.rejectMutant((source) => source.replaceAll(' && !m.sticker', ''), async (component) => {
    const sticker = { ...h.msg('own-sticker'), content: '', sticker: { id: 'sticker-1', emoji: '🦆', url: '/duck.webp', format: 'webp' } } as Message;
    const hasEdit = () => [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Изменить') || button.getAttribute('aria-label') === 'Изменить');

    h.desktop();
    await h.mount({ bubbles: false, messages: [sticker] }, component);
    await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="own-sticker"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    assert.ok(document.querySelector('.ctx-menu'), 'меню своего стикера открылось');
    assert.ok(!hasEdit(), 'меню ПК не предлагает правку стикера');
    h.unmount();

    const restore = h.pointerLayout(true, 390); h.mobile();
    try {
      await h.mount({ bubbles: true, messages: [sticker] }, component);
      const stickerSurface = h.host.querySelector<HTMLElement>('[data-mid="own-sticker"] .message-sticker'); assert.ok(stickerSurface);
      await act(async () => { h.touch(stickerSurface!, 'touchstart'); await h.delay(560); });
      const menu = document.querySelector('.ctx-menu[role="menu"]'); assert.ok(menu, 'удержание открывает меню у пузыря');
      assert.ok(document.querySelector('.ctx-stack.anchored'), 'меню привязано к пузырю');
      assert.equal(document.querySelector('.sheet') === null, true, 'старого листа действий нет');
      assert.ok(![...menu.querySelectorAll('button')].some((button) => button.textContent?.includes('Изменить')), 'телефонное меню не предлагает правку стикера');
      await act(async () => { h.touch(stickerSurface!, 'touchcancel'); });
      h.unmount();

      await h.mount({ bubbles: true, messages: [sticker] }, component);
      await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="own-sticker"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
      assert.ok(document.querySelector('.ctx-menu'), 'меню сообщения доступно для проверки');
      assert.ok(!hasEdit(), 'контекстное меню личного пузыря не предлагает правку стикера');
      h.unmount();

    } finally { h.unmount(); h.desktop(); restore(); }

  });
});
it('имя «Удалённый пользователь» остаётся ссылкой только при живом признаке автора пересылки', async () => {
  // Имя не является признаком удаления: живой участник вправе выбрать такое отображаемое имя.
  h.desktop(); h.round12();
  const deleted = { ...h.msg('deleted-source', 'me', 0), forwardedFrom: { userId: 'gone', displayName: 'Удалённый пользователь', at: new Date(h.now).toISOString(), deleted: true } } as Message;
  const living = { ...h.msg('living-source', 'me', 360000), forwardedFrom: { userId: 'living', displayName: 'Удалённый пользователь', at: new Date(h.now).toISOString() } } as Message;
  await h.mount({ messages: [deleted, living], onReact: () => {} });
  const gone = h.host.querySelector('[data-mid="deleted-source"] .bub-fwd-name');
  const alive = h.host.querySelector('[data-mid="living-source"] .bub-fwd-name');
  assert.equal(gone?.tagName, 'SPAN', 'у удалённого автора имя — обычный текст');
  assert.equal(alive?.tagName, 'BUTTON', 'живой автор с тем же именем открываем');
});
it('удаление пачки смешивает me/both без conv6 и удаляет всю пачку у обоих с conv6', async () => {
  // Без возможности удалить чужое «у обоих» сервер отвергнет смешанную пачку целиком.
  h.desktop(); h.round12();
  const select = async (id: string) => {
    const row = h.host.querySelector<HTMLElement>(`[data-mid="${id}"]`); assert.ok(row, `сообщение ${id} присутствует`);
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const item = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((button) => button.textContent?.includes('Выделить'));
    assert.ok(item, 'выбор доступен только в переданной пачке');
    await act(async () => { item.click(); await h.flush(); });
    assert.equal(h.host.querySelector(`[data-mid="${id}"]`)?.getAttribute('aria-checked'), 'true', 'пункт меню действительно выбирает сообщение');
  };
  for (const deleteOthersForBoth of [false, true]) {
    if (h.root) h.unmount();
    const calls: [string[], 'me' | 'both'][] = [];
    const batch = { forward: async () => {}, deleteMany: async (ids: string[], scope: 'me' | 'both') => { calls.push([ids, scope]); }, peerName: () => 'Собеседник', open: () => {} };
    await h.mountWithConfirm({ messages: [h.msg('mine'), h.msg('theirs', 'peer')], batch, deleteOthersForBoth, onReact: () => {} });
    await select('mine');
    await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="theirs"]')!.click(); await h.flush(); });
    const deleteBatch = h.host.querySelector<HTMLButtonElement>('.sel-bar .danger');
    assert.ok(deleteBatch?.textContent?.includes('Удалить 2'), 'актуальная панель пачки показывает удаление двух сообщений');
    await act(async () => { deleteBatch!.click(); await h.flush(); });
    assert.equal(document.querySelector('#confirm-title')?.textContent, 'Удалить 2 сообщения?', 'пачка показывает подтверждение перед удалением');
    const option = document.querySelector<HTMLInputElement>('.confirm-option input');
    assert.ok(option, 'подтверждение объясняет удаление у собеседника');
    await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
    assert.deepEqual(calls, deleteOthersForBoth ? [[['mine', 'theirs'], 'both']] : [[['mine'], 'both'], [['theirs'], 'me']]);
  }
});
it('пачка только из чужих без conv6 не предлагает галочку удаления для собеседника', async () => {
  // Чужое сообщение доступно для удаления только у себя, поэтому отключённая цель не должна показываться галочкой.
  h.desktop(); h.round12();
  const calls: [string[], 'me' | 'both'][] = [];
  const batch = { forward: async () => {}, deleteMany: async (ids: string[], scope: 'me' | 'both') => { calls.push([ids, scope]); },
    peerName: () => 'Собеседник', open: () => {} };
  await h.mountWithConfirm({ messages: [h.msg('peer-a', 'peer'), h.msg('peer-b', 'peer2')], batch, onReact: () => {} });
  await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="peer-a"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const select = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((button) => button.textContent?.includes('Выделить'));
  assert.ok(select, 'контекстное меню предлагает выделение сообщения'); await act(async () => { select.click(); await h.flush(); });
  await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="peer-b"]')!.click(); await h.flush(); });
  const deleteBatch = h.host.querySelector<HTMLButtonElement>('.sel-bar .danger');
  assert.ok(deleteBatch?.textContent?.includes('Удалить 2'), 'актуальная панель пачки показывает удаление двух чужих сообщений');
  await act(async () => { deleteBatch!.click(); await h.flush(); });
  assert.ok(!document.querySelector('.confirm-option'), 'чужая-only пачка без conv6 не показывает невозможную галочку');
  assert.match(document.querySelector('#confirm-title')?.textContent ?? '', /Удалить 2 сообщения\?/);
  await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
  assert.deepEqual(calls, [[['peer-a', 'peer-b'], 'me']]);
});
feedMutantTest('служебное действие группы рисуется отдельной пилюлей, незнакомый вид обычным сообщением', async () => {
  // Ловит неверный разбор группы как pin и потерю запасного текста будущего kind.
  await h.rejectMutant(source=>source.replace('const groupSvc = p.bubbles ? groupServiceMark(m as { service?: unknown }) : null;',
    'const groupSvc = p.bubbles ? pinServiceMark(m as { service?: unknown }) : null;'),async component=>{
    h.desktop(); h.round12();
    const group={...h.msg('svc-group-case'),content:'А добавил(а) Б',service:{kind:'group',type:'add'}} as unknown as Message;
    const unknown={...h.msg('svc-unknown-case'),content:'Запасной текст',service:{kind:'other',type:'add'}} as unknown as Message;
    await h.mount({messages:[group,unknown]},component);
    assert.equal(h.host.querySelector('[data-mid="svc-group-case"]')?.getAttribute('data-svc'),'group');
    assert.equal(h.host.querySelector('[data-mid="svc-group-case"]')?.textContent,'А добавил(а) Б');
    assert.ok(!h.host.querySelector('[data-mid="svc-group-case"] .svc-pin-btn'));
    assert.ok(h.host.querySelector('[data-mid="svc-unknown-case"]')?.classList.contains('message'));
    assert.ok(h.host.querySelector('[data-mid="svc-unknown-case"]')?.textContent?.includes('Запасной текст'));
  });
});

// ---- readScroll: сохранены исходные сценарии и матрицы. ----
it('плавающий день не появляется на программный scroll, появляется на wheel и гаснет', async () => {
  await h.mount({ messages: [h.msg('top')] }); const list = h.host.querySelector<HTMLElement>('.messages')!;
  feedPatch(document, 'elementFromPoint', { configurable: true, value: () => h.host.querySelector('[data-mid="top"]') });
  await act(async () => { list.dispatchEvent(new Event('scroll')); await h.delay(40); }); assert.equal(h.host.querySelector('.bub-float.on') === null, true);
  await act(async () => { list.dispatchEvent(new Event('wheel')); list.dispatchEvent(new Event('scroll')); await h.delay(40); });
  assert.ok(h.host.querySelector('.bub-float.on')); await act(async () => { await h.delay(1550); }); assert.equal(h.host.querySelector('.bub-float.on') === null, true);
});
feedMutantTest('стрелка вверх редактирует последнее своё обычное сообщение, пропуская стикер и пересылку', async () => {
  // Нельзя подать `hasOwnEditable` уже вычисленным: регрессия была именно в выборе последней строки перед этим флагом.
  const eligible = h.msg('arrow-editable', 'me', 180000);
  const forwarded = { ...h.msg('arrow-forwarded', 'me', 120000), forwardedFrom: {
    userId: 'original', displayName: 'Автор', at: new Date(h.now - 120000).toISOString(),
  } } as Message;
  const sticker = { ...h.msg('arrow-sticker', 'me', 60000), content: '', sticker: {
    id: 'sticker', emoji: '🦆', url: 'https://example.test/sticker.webp', format: 'webp',
  } } as Message;
  const chooseLastEditable = async (component: typeof h.Pane) => {
    h.round12(); h.desktop();
    await h.mount({ messages: [eligible, forwarded, sticker] }, component);
    const field = h.host.querySelector<HTMLTextAreaElement>('.composer-input'); assert.ok(field);
    field.focus();
    await act(async () => { field!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); await h.flush(); });
    assert.ok(h.host.querySelector('.edit-strip'), 'последний обычный свой месседж открыт в composer');
    assert.equal(field.value, eligible.content, 'пересланная строка и стикер не становятся целью правки');
    assert.equal(h.host.querySelector('.edit-box') === null, true, 'inline правки больше нет');
  };
  await h.rejectMutant((source) => source.replace(
    'm.author.id === meId && !m.forwardedFrom && !m.sticker',
    'm.author.id === meId',
  ), chooseLastEditable, 'пересланная строка и стикер не становятся целью правки');
});
it('клавиши поля, повтор и пробел кнопки не зовут дату, PageDown ленты зовёт', async () => {
  // Ловит ложную пилюлю от редактирования текста или нажатия действия сообщения.
  await h.mount({ messages: [h.msg('top')] }); const list = h.host.querySelector<HTMLElement>('.messages')!;
  feedPatch(document, 'elementFromPoint', { configurable: true, value: () => h.host.querySelector('[data-mid="top"]') });
  const input = document.createElement('textarea'); const button = document.createElement('button'); list.append(input, button);
  for (const [target, key, repeat] of [[input, 'PageDown', false], [button, ' ', false], [list, 'PageDown', true]] as const) {
    await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, repeat, bubbles: true })); list.dispatchEvent(new Event('scroll')); await h.delay(40); });
    assert.equal(h.host.querySelector('.bub-float.on') === null, true);
  }
  await act(async () => { list.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })); list.dispatchEvent(new Event('scroll')); await h.delay(40); });
  assert.ok(h.host.querySelector('.bub-float.on'));
});

it('строки получают булево прочтение, событие без сообщения обрывается до уведомлений', () => {
  // Ловит обход мемоизации и звук собственного служебного события чтения.
  const pane = readFileSync(new URL('./MessagePane.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(pane, /read: boolean/);
  const row = pane.slice(pane.indexOf('<MessageRow'), pane.indexOf('/>', pane.indexOf('<MessageRow')));
  assert.match(row, /read=\{/); assert.equal(/peerReadKey\w*=/.test(row), false);
  const sockets = readFileSync(new URL('../sockets.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const branch = sockets.slice(sockets.indexOf("case 'conv.change':"), sockets.indexOf("case 'conv.gone':"));
  assert.match(branch, /msg\.created && m/); assert.match(branch, /store\.convOnChange\(msg, !!d\?\.countUnread\)/);
  const cutoff = branch.indexOf('if (!d || !m) return;'); assert.ok(cutoff >= 0);
  for (const call of ['scheduleRead(', 'playSound(', 'osNotify(', 'flashWindow(']) {
    const i = branch.indexOf(call); if (i >= 0) assert.ok(i > cutoff, call);
  }
});

it('альбомы изолированы пузырями, кнопка ошибки имеет клавиатурный фокус без заливки', () => {
  // Ловит утечку сетки в каналы и невидимую кнопку ошибки при навигации клавиатурой.
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const selector of match[1]!.split(',').map((s) => s.trim())) {
      if (/\.album\b/.test(selector)) assert.ok(selector.startsWith('.message.bub .bubble.media > .attachments.album'), selector);
    }
  }
  assert.match(css, /\.bub-fail \.bub-fail-btn\s*\{[^}]*background:\s*none/);
  assert.match(css, /\.bub-fail \.bub-fail-btn:focus-visible\s*\{[^}]*outline:/);
  assert.equal(/\.(?:day-divider|bub-float)[^{]*\{[^}]*position:\s*sticky/.test(css), false);
  assert.equal((css.match(/--bubble-out:/g) ?? []).length, 2);
  assert.equal((css.match(/--bubble-accent-text:/g) ?? []).length, 2);
});

it('инерция продлевает человеческую прокрутку, поздний программный кадр её не продлевает', async () => {
  // Ловит отсутствие обновления human на каждом кадре и вечную пилюлю от программной прокрутки.
  await h.mount({ messages: [h.msg('top')] }); const list = h.host.querySelector<HTMLElement>('.messages')!;
  feedPatch(document, 'elementFromPoint', { configurable: true, value: () => h.host.querySelector('[data-mid="top"]') });
  await act(async () => { list.dispatchEvent(new Event('wheel')); list.dispatchEvent(new Event('scroll')); await h.delay(40); });
  // Каждый следующий кадр укладывается в окно 300 мс, хотя с wheel прошла уже секунда.
  for (let i = 0; i < 5; i++) await act(async () => { await h.delay(190); list.dispatchEvent(new Event('scroll')); await h.delay(30); });
  assert.ok(h.host.querySelector('.bub-float.on'));
  await act(async () => { await h.delay(350); list.dispatchEvent(new Event('scroll')); await h.delay(40); });
  await act(async () => { await h.delay(1200); }); assert.equal(h.host.querySelector('.bub-float.on') === null, true);
});
it('меньше движения не отменяет исчезновение даты через полторы секунды', async () => {
  // Ловит прежний условный таймер, оставлявший пилюлю навсегда при reduced-motion.
  const match = window.matchMedia.bind(window);
  feedMethod(window, 'matchMedia', (query) => { const result = match(query); if (query.includes('prefers-reduced-motion')) Object.defineProperty(result, 'matches', { value: true }); return result; });
  try {
    assert.equal(window.matchMedia('(prefers-reduced-motion: reduce)').matches, true);
    await h.mount({ messages: [h.msg('top')] }); const list = h.host.querySelector<HTMLElement>('.messages')!;
    feedPatch(document, 'elementFromPoint', { configurable: true, value: () => h.host.querySelector('[data-mid="top"]') });
    await act(async () => { list.dispatchEvent(new Event('touchmove', { bubbles: true })); list.dispatchEvent(new Event('scroll')); await h.delay(40); });
    assert.ok(h.host.querySelector('.bub-float.on')); await act(async () => { await h.delay(1550); }); assert.equal(h.host.querySelector('.bub-float.on') === null, true);
  } finally { h.unmount(); feedMethod(window, 'matchMedia', match); }
});
it('на телефоне ошибка открывает меню у пузыря с фокусом, Escape возвращает кнопку', async () => {
  // Телефон получает доступное меню у пузыря; прежний лист больше не открывается.
  h.mobile(); const restore = h.pointerLayout(true, 390);
  try {
    await h.mount({ outbox: h.queue() }); const button = h.host.querySelector<HTMLButtonElement>('.bub-fail-btn')!;
    assert.equal(button.getAttribute('aria-haspopup'), 'menu');
    await act(async () => { button.click(); }); await h.flush();
    const menu = document.querySelector('.ctx-menu[role="menu"]'); assert.ok(menu); assert.match(menu.textContent!, /Не отправлено: сеть/);
    assert.ok(document.querySelector('.ctx-stack.anchored'));
    assert.equal(document.querySelector('.sheet') === null, true); assert.ok(document.activeElement === menu.querySelector('button'));
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); }); await h.flush();
    assert.equal(document.querySelector('.ctx-menu') === null, true); assert.ok(document.activeElement === button);
  } finally { h.unmount(); restore(); }
});
for (const outgoing of [false, true]) {
  it(`долгое касание ${outgoing ? 'ошибки' : 'сообщения'} не нажимает открытое меню при отпускании`, async () => {
    // Клик того же жеста не должен ни выполнить команду, ни закрыть карточку.
    h.mobile(); const restore = h.pointerLayout(true, 390); const copies: string[] = [];
    try {
      feedPatch(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copies.push(text); } } });
      await h.mount(outgoing ? { outbox: h.queue() } : { messages: [h.msg('top')], onReact: () => {} });
      const body = h.host.querySelector('.message-body')!;
      await act(async () => { h.touch(body, 'touchstart'); await h.delay(560); });
      const menu = document.querySelector('.ctx-menu[role="menu"]')!; assert.ok(menu);
      assert.ok(document.querySelector('.ctx-stack.anchored')); assert.equal(document.querySelector('.sheet') === null, true);
      const copy = [...menu.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Скопировать текст'))!; assert.ok(copy);
      let end!: Event; await act(async () => { end = h.touch(body, 'touchend'); }); assert.equal(end.defaultPrevented, true);
      const first = new MouseEvent('click', { bubbles: true, cancelable: true });
      await act(async () => { copy.dispatchEvent(first); }); assert.equal(first.defaultPrevented, true); assert.equal(copies.length, 0); assert.ok(document.querySelector('.ctx-menu'));
      await act(async () => { await h.delay(450); }); await act(async () => { copy.click(); });
      assert.deepEqual(copies, [outgoing ? 'failed' : 'top']);
      if (!outgoing) {
        // Разметка реакций проверяется отдельным повторным открытием карточки.
        await act(async () => { h.touch(body, 'touchstart'); await h.delay(560); });
        // Полоса при наведении тоже смонтирована в DOM: проверяем реакции только открытого меню.
        const more = document.querySelector('.ctx-stack .react-bar-more')!; assert.ok(more);
        assert.equal(more.getAttribute('aria-label'), 'Все реакции'); assert.equal(more.getAttribute('title'), 'Все реакции');
        assert.ok(more.querySelector('svg[width="20"]'), 'все реакции имеют пиктограмму нового меню');
        assert.deepEqual([...document.querySelectorAll('.ctx-stack .react-bar button:not(.react-bar-more)')].map((b) => b.textContent), ['👍', '🔥', '😂', '❤️', '🦆']);
        await act(async () => { h.touch(body, 'touchcancel'); });
      }
    } finally { h.unmount(); restore(); }
  });
}
it('короткий тап и движение не взводят защиту, чужое отпускание не подавлено и следующий клик проходит', async () => {
  // Парное принятие обычного жеста: защита long-press не должна блокировать следующие действия.
  h.mobile(); const restore = h.pointerLayout(true, 390);
  try {
    await h.mount({ messages: [h.msg('top')] }); const body = h.host.querySelector('.message-body')!;
    await act(async () => { h.touch(body, 'touchstart'); await h.delay(100); });
    let ended!: Event; await act(async () => { ended = h.touch(body, 'touchend'); }); assert.equal(ended.defaultPrevented, false); assert.equal(document.querySelector('.ctx-menu') === null, true);
    await act(async () => { h.touch(body, 'touchstart'); h.touch(body, 'touchmove', 11); await h.delay(560); });
    assert.equal(document.querySelector('.ctx-menu') === null, true); await act(async () => { ended = h.touch(body, 'touchend'); }); assert.equal(ended.defaultPrevented, false);
    await act(async () => { h.touch(body, 'touchstart'); await h.delay(560); }); assert.ok(document.querySelector('.ctx-menu'));
    const other = document.querySelector('.ctx-menu button')!; await act(async () => { ended = h.touch(other, 'touchend'); }); assert.equal(ended.defaultPrevented, false);
    // Новый guard ставится уже при открытии меню. Следующий самостоятельный клик разрешён после его короткого окна.
    await act(async () => { await h.delay(450); });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    let clicked = false; const onClick = () => { clicked = true; }; other.addEventListener('click', onClick);
    try {
      await act(async () => { other.dispatchEvent(click); }); assert.equal(click.defaultPrevented, false); assert.equal(clicked, true);
    } finally { h.unmount(); other.removeEventListener('click', onClick); }
  } finally { h.unmount(); restore(); }
});
it('широкая группа показывает мой аватар только у последней исходящей строки', async () => {
  // Ловит пустую колонку/повтор аватара и проверяет, что на телефоне его профильный тап не открывает меню сообщения.
  h.round12(); const restore = h.pointerLayout(true, 390);
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  feedPatch(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 900 });
  try {
    await h.mount({ messages: [h.msg('saved', 'me', 180000)], outbox: h.queue() });
    assert.ok(h.host.querySelector('.messages.bub-left'));
    const rows = h.host.querySelectorAll('.message.bub'); assert.equal(rows[0]!.querySelector('.bub-ava .msg-ava') === null, true);
    assert.ok(rows[1]!.querySelector('.bub-ava .msg-ava')); assert.ok(rows[1]!.nextElementSibling?.classList.contains('bub-fail'));
    const avatar = rows[1]!.querySelector<HTMLElement>('.msg-ava')!;
    await act(async () => { avatar.click(); await h.flush(); }); assert.ok(!document.querySelector('.ctx-stack'), 'аватар открывает профиль, не меню сообщения');
  } finally {
    h.unmount(); restore();
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'clientWidth', descriptor); else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  }
});
feedMutantTest('удержание входящего аватара открывает человека, а короткий тап — профиль', async () => {
  // Удержание на аватаре не должно проваливаться в действия сообщения; короткий тап сохраняет прежний профильный путь.
  await h.rejectMutant((source) => source.replace(
    "if (target.closest('.msg-ava') && phoneUi() && e.touches.length === 1) {",
    "if (false) { /* мутант теряет специальное удержание аватара */",
  ), async (component) => {
    const restore = h.pointerLayout(true, 390); h.mobile(); h.round12();
    try {
      await h.mount({ bubbles: false, messages: [h.msg('avatar-hold', 'peer')] }, component);
      const avatar = h.host.querySelector<HTMLElement>('[data-mid="avatar-hold"] .msg-ava'); assert.ok(avatar, 'у входящего автора есть аватар');
      await act(async () => { h.touch(avatar!, 'touchstart', 24, 24); await h.delay(510); h.touch(avatar!, 'touchend'); await h.flush(); });
      assert.ok(document.querySelector('.ctx-menu')?.textContent?.includes('peer'), 'долгое касание открывает меню именно автора');
      assert.ok(!document.querySelector('.ctx-menu')?.textContent?.includes('Ответить'), 'это меню человека, не сообщение');
      h.unmount();
      await h.delay(500); // Подавитель синтетического click принадлежит завершившемуся удержанию.
      await h.mount({ bubbles: false, messages: [h.msg('avatar-tap', 'peer')] }, component);
      const tapAvatar = h.host.querySelector<HTMLElement>('[data-mid="avatar-tap"] .msg-ava'); assert.ok(tapAvatar);
      await act(async () => { tapAvatar!.click(); await h.flush(); });
      assert.ok(document.querySelector('.pcard'), 'короткий тап открывает карточку того же автора');
      h.unmount();
      // isMobile() не узнаёт браузер телефона; обе стороны 760 сохраняют разные жесты.
      for (const point of [{ width: 384 }, { width: 760 }, { width: 761 }, { width: 1200 }, { width: 384, tauri: true }]) {
        h.desktop();
        if (point.tauri) feedPatch(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
        const restoreWidth = h.pointerLayout(point.width <= 760, point.width);
        const phone = !point.tauri && point.width <= 760;
        try {
          await h.mount({ bubbles: false, messages: [h.msg('avatar-hold', 'peer')] }, component);
          const target = h.host.querySelector<HTMLElement>('[data-mid="avatar-hold"] .msg-ava'); assert.ok(target);
          await act(async () => { h.touch(target, 'touchstart', 24, 24); await h.delay(510); h.touch(target, 'touchend'); await h.flush(); });
          assert.equal(!!document.querySelector('.ctx-menu')?.textContent?.includes('peer'), phone,
            `R345 аватар ${point.width}${point.tauri ? ' Tauri' : ' browser'}: удержание только в телефонном UI`);
          assert.ok(!document.querySelector('.ctx-menu')?.textContent?.includes('Ответить'), 'R345 аватар не открывает действия сообщения');
          if (!phone) {
            await act(async () => { target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
            assert.ok(document.querySelector('.ctx-menu')?.textContent?.includes('peer'), 'R345 ПКМ по аватару сохраняет меню человека');
            assert.ok(!document.querySelector('.ctx-menu')?.textContent?.includes('Ответить'), 'R345 ПКМ аватара не становится меню сообщения');
          }
          h.unmount();
          if (phone) await h.delay(500); // Не выдаём синтетический click завершённого удержания за следующий тап.
          await h.mount({ bubbles: false, messages: [h.msg('avatar-tap', 'peer')] }, component);
          const short = h.host.querySelector<HTMLElement>('[data-mid="avatar-tap"] .msg-ava'); assert.ok(short);
          await act(async () => { short.click(); await h.flush(); });
          assert.ok(document.querySelector('.pcard'), 'R345 короткий тап аватара сохраняет профиль во всех раскладках');
        } finally { h.unmount(); restoreWidth(); h.desktop(); }
      }
    } finally { h.unmount(); h.desktop(); restore(); }
  }, 'долгое касание открывает меню именно автора');
});

const browserAvatarName = 'R345 браузер телефона не теряет удержание аватара при откате phoneUi к isMobile';
feedMutantTest(browserAvatarName, async () => {
  const expected = 'R345 браузер аватар: удержание открывает автора при ложном isMobile';
  const check = async (component: typeof h.Pane) => {
    h.desktop(); const restore = h.pointerLayout(true, 384);
    try {
      await h.mount({ bubbles: false, messages: [h.msg('browser-avatar', 'peer')] }, component);
      const avatar = h.host.querySelector<HTMLElement>('[data-mid="browser-avatar"] .msg-ava'); assert.ok(avatar, 'R345 setup: входящий аватар смонтирован');
      await act(async () => { h.touch(avatar, 'touchstart', 24, 24); await h.delay(510); h.touch(avatar, 'touchend'); await h.flush(); });
      assert.ok(document.querySelector('.ctx-menu')?.textContent?.includes('peer'), expected);
      assert.ok(!document.querySelector('.ctx-menu')?.textContent?.includes('Ответить'), 'R345 браузер аватар: это не действия сообщения');
    } finally { h.unmount(); restore(); h.desktop(); }
  };
  await h.rejectMutant(raw => raw.replace("if (target.closest('.msg-ava') && phoneUi() && e.touches.length === 1) {",
    "if (target.closest('.msg-ava') && isMobile() && e.touches.length === 1) {"), check, expected);
  if (mutantsEnabled() && process.env.GUSVOICE_PANE_MUTANT === browserAvatarName) {
    const fresh = await h.paneServer();
    try { await check((await fresh.ssrLoadModule('/src/components/MessagePane.tsx')).MessagePane); }
    finally { h.unmount(); await fresh.close(); }
  }
});

it('старая отправка получает время постановки и склеивается с сохранённым пузырём', async () => {
  // Ловит исходящий без времени в старом пути, пока сервер ещё не ответил.
  let finish!: () => void; const pending = new Promise<void>((resolve) => { finish = resolve; });
  await h.mount({ messages: [h.msg('saved', 'me', 60000)], draft: { text: 'новое', replyToId: null }, onSend: async () => pending });
  await act(async () => { h.host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  const row = h.host.querySelector('.message.bub.outgoing')!; assert.ok(row); assert.ok(row.classList.contains('grouped'));
  assert.match(row.querySelector('.bub-meta')!.textContent!, /\d{2}:\d{2}/);
  await act(async () => { finish(); });
});
it('DmChatView применяет тихое прочтение через настоящий стор, не перемонтирует ленту и не гасит unread', async () => {
  // Ловит разрыв цепочки сводка → подписка DmChatView → галочки MessagePane.
  feedPatch(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  const { DmChatView } = await h.server.ssrLoadModule('/src/components/DmChatView.tsx') as typeof import('./DmChatView');
  const { useStore } = await h.server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  h.resetStore = () => useStore.getState().convReset();
  const peer = { id: 'peer', username: 'peer', displayName: 'Peer', avatarUrl: null };
  const dm = { id: 'c', otherUser: peer, createdAt: new Date(h.now).toISOString(), lastMessageAt: null } as DmChannel;
  const summary = { ...dm, kind: 'direct' as const, lastMessage: null, lastReadKey: 0, unread: 3, peerReadKey: 20 };
  const messages = [h.msg('m10', 'me', 0, 10), h.msg('m15', 'peer', 0, 15), h.msg('m20', 'me', 0, 20), h.msg('m30', 'me', 0, 30)];
  useStore.setState({ convActive: true, user: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null } as never,
    conv: { ...useStore.getState().conv, phase: 'live', pts: 100, summaries: { c: summary }, summaryPts: { c: 100 },
      windows: { c: { basePts: 100, hasMoreBefore: false, hasMoreAfter: false } } },
    dmMessages: { c: messages }, unreadDms: ['c'], dms: [dm], currentDmId: 'c', view: 'dm', drafts: {}, draftRev: {}, outbox: {} });
  h.host = document.createElement('div'); document.body.append(h.host); h.root = createRoot(h.host);
  await act(async () => { h.root!.render(createElement(DmChatView, { dm })); }); await h.flush();
  assert.equal(document.activeElement, h.host.querySelector('.composer-input'));
  const list = h.host.querySelector('.messages'); assert.ok(list); h.rendered.length = 0;
  const unread = useStore.getState().unreadDms;
  await act(async () => { useStore.getState().convOnChange({ pts: 101, conversation: { ...summary, peerReadKey: 30 } }, false); });
  assert.equal(useStore.getState().conv.pts, 101); assert.equal(useStore.getState().conv.summaries.c.peerReadKey, 30);
  assert.ok(h.host.querySelector('[data-mid="m30"] .bub-st.read')); assert.deepEqual(h.rendered, ['m30']);
  assert.ok(h.host.querySelector('.messages') === list); assert.deepEqual(useStore.getState().unreadDms, unread);
  h.rendered.length = 0;
  await act(async () => { useStore.getState().convOnChange({ pts: 101, conversation: { ...summary, peerReadKey: 30 } }, false); });
  assert.deepEqual(h.rendered, []);
});
feedMutantTest('мутант без read-статуса не проходит настоящий DOM-сценарий галочек', async () => {
  // Ловит возврат всегда одинарной галочки у своих сообщений.
  await h.rejectMutant((s) => s.replace("mine ? (read ? 'read' : 'sent') : undefined", "mine ? 'sent' : undefined"), async (component) => {
    await h.mount({ messages: [h.msg('read', 'me', 0, 20)], peerReadKey: 20 }, component);
    assert.ok(h.host.querySelector('[data-mid="read"] .bub-st.read'), 'прочитанное своё сообщение имеет двойную галочку');
  });
});
feedMutantTest('мутант с сырым ключом строки ломает точечную перерисовку', async () => {
  // Ловит пропс, одинаково меняющийся у всех четырёх memo-строк при чужом прочтении.
  await h.rejectMutant((s) => s.replace('<MessageRow\n', '<MessageRow peerReadKeyRaw={p.peerReadKey}\n'), async (component) => {
    const messages = [h.msg('m10', 'me', 0, 10), h.msg('m15', 'peer', 0, 15), h.msg('m20', 'me', 0, 20), h.msg('m30', 'me', 0, 30)];
    await h.mount({ messages, peerReadKey: 20 }, component); h.rendered.length = 0;
    await act(async () => { h.root!.render(createElement(component, { ...h.base, messages, peerReadKey: 30 })); });
    assert.deepEqual(h.rendered, ['m30']);
  });
});
feedMutantTest('мутант без проверки человеческого ввода показывает дату на программный scroll', async () => {
  // Ловит тихий возврат пилюли при открытии беседы или догрузке картинки.
  await h.rejectMutant((s) => s.replace('if (now - human > HUMAN_SCROLL_MS) return;', ''), async (component) => {
    h.round12(); h.desktop();
    await h.mount({ messages: [h.msg('top')] }, component); const list = h.host.querySelector<HTMLElement>('.messages')!;
    feedPatch(document, 'elementFromPoint', { configurable: true, value: () => h.host.querySelector('[data-mid="top"]') });
    await act(async () => { list.dispatchEvent(new Event('scroll')); await h.delay(40); });
    assert.equal(h.host.querySelector('.bub-float.on') !== null, false);
  });
});
feedMutantTest('мутант без перевода фокуса проваливает меню ошибки с клавиатуры', async () => {
  // Ловит открытый портал, в который Tab от исходной кнопки не попадает.
  await h.rejectMutant((s) => s.replace("open[open.length - 1]?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();", ''), async (component) => {
    h.round12(); h.desktop();
    await h.mount({ outbox: h.queue() }, component); const button = h.host.querySelector<HTMLButtonElement>('.bub-fail-btn')!;
    h.controlUiClock();
    await act(async () => { button.click(); });
    // Эффект открытия ставит нулевой таймер ПОСЛЕ commit. Запускаем именно
    // этот turn: отсутствие фокуса не маскируем произвольной паузой flush.
    assert.ok(document.querySelector('.ctx-menu[role="menu"]'), 'кнопка действительно открыла меню ошибки');
    await h.runUiTimers();
    assert.ok(document.activeElement === document.querySelector('.ctx-menu button'), 'фокус на первом пункте меню');
  });
});
feedMutantTest('мутант условного таймера оставляет reduced-motion дату висеть', async () => {
  // Ловит прежнее исключение гашения в режиме «меньше движения».
  const match = window.matchMedia.bind(window);
  feedMethod(window, 'matchMedia', (query) => { const result = match(query); if (query.includes('prefers-reduced-motion')) Object.defineProperty(result, 'matches', { value: true }); return result; });
  try {
    await h.rejectMutant((s) => s.replace('hide = window.setTimeout(', "if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) hide = window.setTimeout("), async (component) => {
      await h.mount({ messages: [h.msg('top')] }, component); const list = h.host.querySelector<HTMLElement>('.messages')!;
      feedPatch(document, 'elementFromPoint', { configurable: true, value: () => h.host.querySelector('[data-mid="top"]') });
      await act(async () => { list.dispatchEvent(new Event('wheel')); list.dispatchEvent(new Event('scroll')); await h.delay(40); });
      assert.ok(h.host.querySelector('.bub-float.on'), 'человеческая прокрутка показывает дату'); await act(async () => { await h.delay(1550); });
      assert.equal(h.host.querySelector('.bub-float.on') !== null, false);
    });
  } finally { h.unmount(); feedMethod(window, 'matchMedia', match); }
});
feedMutantTest('мутант без защиты отпускания пальца проваливает long-press сценарий', async () => {
  // Ловит синтетический click из касания, открывшего меню у пузыря.
  await h.rejectMutant((s) => s.replace("if (e.type === 'touchend' && e.target === from)", 'if (false)'), async (component) => {
    h.mobile(); const restore = h.pointerLayout(true, 390);
    try {
      await h.mount({ messages: [h.msg('top')] }, component); const body = h.host.querySelector('.message-body')!;
      await act(async () => { h.touch(body, 'touchstart'); await h.delay(560); }); assert.ok(document.querySelector('.ctx-menu'), 'long-press открывает меню');
      let ended!: Event; await act(async () => { ended = h.touch(body, 'touchend'); }); assert.equal(ended.defaultPrevented, true, 'отпускание открывшего меню пальца подавлено');
    } finally { h.unmount(); restore(); }
  }, 'отпускание открывшего меню пальца подавлено');
});
feedMutantTest('мутант без группировки сохранённого с очередью оставляет лишний хвост', async () => {
  // Ловит разрыв одной серии своих сообщений на границе сохранённого и исходящих.
  await h.rejectMutant((s) => s.replace('} : outRow,', '} : undefined,'), async (component) => {
    await h.mount({ messages: [h.msg('saved', 'me', 60000)], outbox: h.queue() }, component);
    assert.equal(h.host.querySelector('[data-mid="saved"]')!.classList.contains('tail'), false);
  });
});
it('дата принимает все клавиши прокрутки и касания ленты, но игнорирует ввод и кнопки строк', async () => {
  // Парная матрица: не подавить нормальную прокрутку и не принять редактирование за неё.
  const samples: [string, string | null, boolean, string][] = [
    ...['PageDown', 'PageUp', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].map((key): [string, string, boolean, string] => ['keydown', key, true, 'body']),
    ['touchmove', null, true, 'row'], ['pointerdown', null, true, 'list'],
    ['pointerdown', null, false, 'row'], ['pointerdown', null, false, 'button'],
    ['keydown', 'a', false, 'list'], ['keydown', 'PageDown', true, 'outside'], ['keydown', 'PageDown', false, 'edit'],
  ];
  for (const [event, key, accepted, targetKind] of samples) {
    if (h.root) await act(async () => h.root!.unmount()); h.root = null; h.host?.remove();
    await h.mount({ messages: [h.msg('top')] }); const list = h.host.querySelector<HTMLElement>('.messages')!;
    feedPatch(document, 'elementFromPoint', { configurable: true, value: () => h.host.querySelector('[data-mid="top"]') });
    const button = document.createElement('button'); const edit = document.createElement('textarea'); list.append(button, edit);
    const target = targetKind === 'body' ? document.body : targetKind === 'row' ? h.host.querySelector('[data-mid="top"]')! : targetKind === 'button' ? button
      : targetKind === 'edit' ? edit : targetKind === 'outside' ? h.host.querySelector('form textarea')! : list;
    await act(async () => {
      target.dispatchEvent(event === 'keydown' ? new KeyboardEvent('keydown', { key: key!, bubbles: true }) : new Event(event, { bubbles: true }));
      list.dispatchEvent(new Event('scroll')); await h.delay(40);
    });
    assert.equal(h.host.querySelector('.bub-float.on') !== null, accepted, `${event} ${key} ${targetKind}`);
  }
});
it('ответ не рвёт серию пузырей ЛС, но рвёт канал; очередь с ответом продолжает сохранённое', async () => {
  // Telegram группирует ответы в пузырях ЛС; плоская лента канала сохраняет отдельный блок ответа.
  const first = h.msg('series-first', 'me');
  const reply = { ...h.msg('series-reply', 'me'), replyTo: { id: first.id, authorName: 'Я', content: first.content } };
  await h.mount({ messages: [first, reply], bubbles: true });
  assert.ok(h.host.querySelector('[data-mid="series-reply"]')!.classList.contains('grouped'), 'ответ в пузырях ЛС остаётся частью серии');
  await h.rerender({ messages: [first, reply], bubbles: false });
  assert.equal(h.host.querySelector('[data-mid="series-reply"]')!.classList.contains('grouped'), false, 'ответ в канале начинает отдельную группу');

  const saved = h.msg('saved', 'me', 60000);
  await h.rerender({ messages: [saved], bubbles: true, outbox: h.queue() });
  assert.equal(h.host.querySelectorAll('.messages .day-divider').length, 1);
  await h.rerender({ messages: [saved], bubbles: true, outbox: { ...h.queue(), items: [{ ...h.out(), replyToId: 'saved' }] } });
  assert.equal(h.host.querySelector('[data-mid="saved"]')!.classList.contains('tail'), false, 'ответ в пути не разрывает серию сохранённого сообщения');
  assert.equal(h.host.querySelector('.message.bub.outgoing')!.classList.contains('grouped'), true, 'очередь остаётся продолжением пузырей ЛС');
  assert.equal(h.host.querySelectorAll('.messages .day-divider').length, 1, 'переход в очередь не добавляет дневную пилюлю');
});
it('в ЛС причина отказа SVG видна под сообщением без открытия меню', async () => {
  const error = 'этот тип файла запрещён (SVG/HTML)';
  await h.mount({ bubbles: true, outbox: { ...h.queue(), items: [{ ...h.out(), status: 'failed', error }] } });
  const failure = h.host.querySelector<HTMLButtonElement>('.bub-fail-btn');
  assert.equal(failure?.textContent, `Не отправлено: ${error}`);
  assert.match(failure?.getAttribute('aria-label') ?? '', /SVG\/HTML/);
});
it('защита клика после long-press сама истекает, даже если первого клика не было', async () => {
  // Ловит вечный capture-слушатель, который съедает следующий нормальный клик спустя секунды.
  h.mobile(); const restore = h.pointerLayout(true, 390); const copies: string[] = [];
  try {
    feedPatch(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copies.push(text); } } });
    await h.mount({ outbox: h.queue() }); const body = h.host.querySelector('.message-body')!;
    await act(async () => { h.touch(body, 'touchstart'); await h.delay(560); });
    await act(async () => { h.touch(body, 'touchend'); }); await act(async () => { await h.delay(450); });
    const copy = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Скопировать текст'))!; assert.ok(copy);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { copy.dispatchEvent(click); }); assert.equal(click.defaultPrevented, false); assert.deepEqual(copies, ['failed']);
  } finally { h.unmount(); restore(); }
});
it('долгое касание открывает меню в личной пачке, без batch и в канале; Выбрать включает пачку', async () => {
  // Один жест не должен включать пачки в каналах, даже если вызывающий случайно передал batch.
  const restore = h.pointerLayout(true, 390);
  const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Собеседник', open: () => {} };
  try {
    h.round12(); h.mobile();
    await h.mount({ messages: [h.msg('long-batch')], batch });
    const dmBody = h.host.querySelector('.message-body')!;
    await act(async () => { h.touch(dmBody, 'touchstart'); await h.delay(560); });
    await act(async () => { h.touch(dmBody, 'touchend'); await h.flush(); });
    await act(async () => { dmBody.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); await h.flush(); });
    assert.equal(h.host.querySelector('.sel-head') === null, true, 'долгое касание в DM сначала оставляет меню');
    const choose = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.trim() === 'Выбрать');
    assert.ok(choose, 'пункт Выбрать доступен в меню DM');
    await act(async () => { choose.click(); await h.flush(); });
    assert.ok(h.host.querySelector('.sel-head'), 'Выбрать входит в выделение');
    h.unmount();
    await h.mount({ messages: [h.msg('long-legacy')] });
    const legacyBody = h.host.querySelector('.message-body')!;
    await act(async () => { h.touch(legacyBody, 'touchstart'); await h.delay(560); });
    await act(async () => { h.touch(legacyBody, 'touchend'); await h.flush(); });
    await act(async () => { legacyBody.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); await h.flush(); });
    assert.ok(document.querySelector('.ctx-stack'), 'без batch долгое касание открывает меню, а не режим пачки');
    assert.ok(!h.host.querySelector('.sel-head'), 'старый путь не включает выделение');
    h.unmount();
    await h.mount({ messages: [h.msg('long-channel')], bubbles: false, batch });
    const channelBody = h.host.querySelector('.message-body')!;
    await act(async () => { h.touch(channelBody, 'touchstart'); await h.delay(560); });
    await act(async () => { h.touch(channelBody, 'touchend'); await h.flush(); });
    await act(async () => { channelBody.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); await h.flush(); });
    assert.ok(document.querySelector('.ctx-menu,.sheet'), 'долгое касание настоящей строки канала открывает меню');
    assert.ok(!h.host.querySelector('.sel-head'), 'канал без пузырей не включает выделение даже с batch');
  } finally { if (h.root) h.unmount(); h.desktop(); restore(); }
});

// ---- bottomStick: сохранены исходные сценарии и матрицы. ----
const testOptions = { timeout: 60_000 };
type ResizeWatch = { targets: Set<Element>; callback: ResizeObserverCallback };
type MutationWatch = { target: Node | null; callback: MutationCallback };

/** Геометрия задаётся ДО эффектов: HappyDOM не рассчитывает layout и не ограничивает scrollTop браузерным краем. */
async function surface(work: (s: {
  list: HTMLElement; height: number; content: number; top: number;
  scroll(): Promise<void>; viewport(): void; resize(): Promise<void>; grow(): Promise<void>;
  insert(): Promise<void>; props: Partial<Props>;
}) => Promise<void>, props: Partial<Props> = {}) {
  const restoreLayout = h.pointerLayout(true, 390);
  const saved: Array<{ target: object; key: string; descriptor: PropertyDescriptor | undefined }> = [];
  const patch = (target: object, key: string, descriptor: PropertyDescriptor) => {
    saved.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
    feedPatch(target, key, { configurable: true, ...descriptor });
  };
  let height = 600, content = 2000, top = 1400, now = 1000;
  const watches: ResizeWatch[] = [];
  const mutations: MutationWatch[] = [];
  class ResizeWatch {
    targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { watches.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  class MutationWatch {
    target: Node | null = null;
    constructor(readonly callback: MutationCallback) { mutations.push(this); }
    observe(target: Node) { this.target = target; }
    disconnect() { this.target = null; }
    takeRecords() { return []; }
  }
  for (const [key, get] of [
    ['clientHeight', () => height], ['scrollHeight', () => content], ['scrollTop', () => top],
  ] as const) {
    const old = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
    patch(HTMLElement.prototype, key, {
      get() { return (this as HTMLElement).classList.contains('messages') ? get() : old?.get?.call(this) ?? 0; },
      ...(key === 'scrollTop' ? { set(value: number) {
        if ((this as HTMLElement).classList.contains('messages')) top = Math.max(0, Math.min(value, content - height));
        else old?.set?.call(this, value);
      } } : {}),
    });
  }
  patch(globalThis, 'ResizeObserver', { value: ResizeWatch });
  patch(window, 'ResizeObserver', { value: ResizeWatch });
  patch(globalThis, 'MutationObserver', { value: MutationWatch });
  patch(window, 'MutationObserver', { value: MutationWatch });
  patch(performance, 'now', { value: () => now });
  const messages = [h.msg('bottom-old', 'peer', 0, 1)];
  const mounted = { messages, ...props };
  try {
    await h.mount(mounted);
    const list = h.host.querySelector<HTMLElement>('.messages');
    assert.ok(list, 'настоящая лента смонтирована с заданной геометрией');
    const fire = async (target: Element) => act(async () => {
      const matching = watches.filter(watch => watch.targets.has(target));
      if (target === list) assert.ok(matching.length > 0, 'сама лента действительно наблюдается');
      for (const watch of matching) watch.callback([], watch as unknown as ResizeObserver);
    });
    const rowChild = (id: string) => {
      let element = list.querySelector<HTMLElement>(`[data-mid="${id}"]`);
      assert.ok(element, 'новая строка существует в настоящей ленте');
      while (element.parentElement !== list) {
        element = element.parentElement;
        assert.ok(element, 'строка вложена в прямого ребёнка ленты');
      }
      return element;
    };
    let contentTarget = rowChild('bottom-old');
    const s = {
      list, props: mounted,
      get height() { return height; }, set height(value: number) { height = value; },
      get content() { return content; }, set content(value: number) { content = value; },
      get top() { return top; }, set top(value: number) { list.scrollTop = value; },
      async scroll() { await act(async () => { list.dispatchEvent(new Event('scroll')); }); },
      viewport() { now += 10; window.dispatchEvent(new Event('resize')); },
      resize: () => fire(list),
      grow: () => fire(contentTarget),
      async insert() {
        const before = new Set(list.children);
        mounted.messages = [...messages, h.msg('bottom-new', 'peer', 0, 2)];
        await h.rerender(mounted);
        const added = [...list.children].filter(child => !before.has(child));
        assert.ok(added.length > 0, 'React действительно добавил новые дети ленты');
        const records = [{ addedNodes: added, removedNodes: [] }] as unknown as MutationRecord[];
        const matching = mutations.filter(watch => watch.target === list);
        assert.equal(matching.length, 1, 'добавленные строки наблюдает ровно один MutationObserver ленты');
        await act(async () => {
          for (const watch of matching) watch.callback(records, watch as unknown as MutationObserver);
        });
        contentTarget = rowChild('bottom-new');
      },
    };
    await s.scroll(); // Снимаем первоначальный stickWant; это уже настоящее известное положение человека.
    await work(s);
  } finally {
    h.unmount();
    for (const { target, key, descriptor } of saved.reverse()) {
      if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
    }
    restoreLayout();
  }
}

async function keyboard() {
  await surface(async s => {
    assert.equal(s.top, 1400, 'A: перед клавиатурой лента прижата к низу 2000−600');
    s.viewport(); s.height = 400;
    await s.resize();
    assert.equal(s.top, 1600, 'A: открытие клавиатуры сохраняет низ 2000−400');
    s.viewport(); s.height = 700; s.top = 1300;
    // Браузер уже упёр scrollTop в новый низ, а RO ещё помнит высоту 400: scroll не должен заменить lastTop.
    await s.scroll();
    await s.resize();
    assert.equal(s.top, 1300, 'A: закрытие клавиатуры после раннего scroll сохраняет низ, не вычитает высоту второй раз');
  });
}

async function keyboardAfterArrival() {
  await surface(async s => {
    s.viewport(); s.height = 400;
    await s.resize();
    assert.equal(s.top, 1600, 'A-arrival: открытая клавиатура оставляет прежнюю ленту внизу');
    // После прихода сообщения старый lastTop уже отличается от фактического низа.
    // Новое сообщение вызывает stickDown до scroll, поэтому lastTop ещё 1600, а настоящий низ уже 1800.
    s.content = 2200;
    await s.insert();
    assert.equal(s.top, 1800, 'A-arrival: новое чужое сообщение при клавиатуре действительно прижалось вниз');
    s.viewport(); s.height = 700; s.top = 1500;
    await s.scroll();
    await s.resize();
    assert.equal(s.top, 1500, 'A-arrival: прижатая лента после нового сообщения выбирает реальный низ, не старый lastTop−300');
  });
}

type Growth = 'pinned' | 'away' | 'menu' | 'pending' | 'newer' | 'program';
async function growth(mode: Growth) {
  const fw = {
    hasOlder: false, hasNewer: mode === 'newer', loadNewer: async () => false, jumpLatest: async () => {},
    jumpTo: async () => true, unreadBelow: 0, place: null, onPlace: () => {}, readKey: null,
  };
  const props: Partial<Props> = mode === 'pending' ? {
    scrollKey: 'pending-feed', feedWindow: { ...fw, place: { messageId: 'not-loaded-yet', offset: 0 } },
  } : mode === 'newer' ? { feedWindow: fw } : {};
  await surface(async s => {
    if (mode === 'pinned') {
      await s.insert();
      await s.scroll();
    }
    if (mode === 'away') { s.top = 1300; await s.scroll(); }
    if (mode === 'program') s.top = 1390; // Ни scroll, ни новая оценка pinned: чужой переход должен остаться в покое.
    if (mode === 'menu') {
      const row = s.list.querySelector<HTMLElement>('[data-mid="bottom-old"]');
      assert.ok(row, 'меню открывается на настоящей строке');
      await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
      assert.ok(document.querySelector('.ctx-menu'), 'перед ростом меню действительно открыто');
    }
    const before = s.top;
    s.content = 2150;
    await s.grow();
    assert.equal(s.top, mode === 'pinned' ? 1550 : before, `B-${mode}: рост строки двигает только прижатую ленту без чужого якоря`);
    if (mode === 'menu') {
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      assert.equal(!!document.querySelector('.ctx-menu'), false, 'меню действительно закрыто после отложенного роста');
      assert.equal(s.top, 1550, 'B-menu: после закрытия исполняется отложенное stickAfterMenu');
    }
  }, props);
}

async function race() {
  await surface(async s => {
    s.top = 1350;
    await s.scroll(); // 50 px — nearBottom, но НЕ pinned: отсутствие stickWant нельзя замаскировать прежним pinned=true.
    await s.insert();
    assert.equal(s.top, 1400, 'C: новое чужое сообщение действительно вызывает stickDown до scroll');
    s.content = 2150;
    await s.grow();
    assert.equal(s.top, 1550, 'C: рост до scroll догоняет программный stickDown, несмотря на старый pinned=false');
    // Следующая строка подросла, пока браузер ещё доставляет scroll от прошлого прыжка на 1550.
    s.content = 2250;
    await s.scroll();
    await s.grow();
    assert.equal(s.top, 1650, 'C: задержанный scroll прежнего прыжка сохраняет pinned для следующего роста');
    s.content = 2300;
    await s.grow();
    assert.equal(s.top, 1700, 'C: после гонки дальнейший рост всё ещё держит низ');
  });
}

// R210: клавиатура, рост строк и гонка программного прыжка со scroll.
it('закрытие клавиатуры не вычитает высоту повторно после браузерного раннего scroll', testOptions, () => keyboard());
it('новое сообщение до scroll не оставляет старый якорь после закрытия клавиатуры', testOptions, () => keyboardAfterArrival());
for (const [mode, label] of [
  ['pinned', 'новая строка продолжает наблюдаться и удерживает точный низ'],
  ['away', '100 пикселей выше низа сохраняются после роста'],
  ['menu', 'открытое меню откладывает прилипание до закрытия'],
  ['pending', 'ожидаемое сохранённое место не перебивается ростом'],
  ['newer', 'окно с более новыми сообщениями не считается хвостом'],
  ['program', 'программный переход без scroll не перебивается ростом'],
] as const) it(`${label}`, testOptions, () => growth(mode));
it('stickDown до scroll и последующий рост сохраняют прилипание', testOptions, () => race());

async function stores() {
  const { useStore } = await h.server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const { useToasts } = await h.server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
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

// R118: реальный входящий текст, чужая беседа и существующий черновик.
it('входящий текст дописывается к черновику с новой строки, а чужая беседа его не забирает', testOptions, async () => {
  const { useStore } = await stores(); h.desktop();
  await h.mount({ feedId: 'c' }); await input('мой черновик  ');
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
});

for (const phone of [false, true]) {
  const check = async () => {
    const { useStore } = await stores(); h.desktop(); const restore = h.pointerLayout(phone, phone ? 390 : 1200);
    let enqueued = 0, sent = 0;
    const outbox = { items: [], enqueue() { enqueued++; }, retry() {}, discard() {} } as never;
    try {
      for (const draft of phone ? ['черновик'] : ['черновик', '']) {
        await h.mount({ feedId: 'c', outbox, onSend: async () => { sent++; } }); await input(draft);
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
  const name = `входящие файлы в ЛС: ${phone ? 'телефон сохраняет полосу и дописывает текст' : 'ПК открывает окно отправки с подписью'}`;
  it(name, testOptions, () => check());
}

for (const mode of ['readOnly', 'edit'] as const) {
  it(`входящий заказ при ${mode === 'edit' ? 'правке' : 'запрете записи'} даёт тост и не мешает composer`, testOptions, async () => {
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

// B8/B9: фокус ответа и viewport-якорь; fixtures не заменяют clamp/наблюдение роста из surface.
type Pane = typeof h.Pane;

type ReplyCase = 'closed' | 'unfocused' | 'keyboard' | 'panel' | 'desktop';
async function reply(component: Pane, scenario: ReplyCase) {
  const restoreLayout = h.pointerLayout(scenario !== 'desktop', scenario === 'desktop' ? 1200 : 390);
  const oldHit = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
  const calls: string[] = [];
  try {
    localStorage.setItem('gv_dbl_action', 'reply');
    await h.mount({ messages: [h.msg('reply-target', 'peer')] }, component);
    const field = h.host.querySelector<HTMLTextAreaElement>('.composer-input');
    const row = h.host.querySelector<HTMLElement>('[data-mid="reply-target"] .message-main');
    assert.ok(field, 'настоящий composer имеет поле');
    assert.ok(row, 'сообщение имеет поверхность двойного клика');
    feedPatch(document, 'elementFromPoint', { configurable: true, value: () => row });
    if (scenario === 'panel') {
      const emoji = h.host.querySelector<HTMLButtonElement>('.att-btn.emoji');
      assert.ok(emoji, 'кнопка панели существует');
      await act(async () => { emoji.click(); });
      assert.equal(!!h.host.querySelector('.expr-under'), true, 'открыта настоящая телефонная панель');
    }
    if (scenario === 'keyboard') document.documentElement.setAttribute('data-kbspace', '');
    await act(async () => { if (scenario === 'unfocused') field.blur(); else field.focus(); });
    assert.equal(document.activeElement === field, scenario !== 'unfocused', 'предусловие фокуса проверено до ответа');
    const focus = field.focus.bind(field);
    const blur = field.blur.bind(field);
    feedMethod(field, 'focus', (...args) => { calls.push('focus'); focus(...args); });
    feedMethod(field, 'blur', () => { calls.push('blur'); blur(); });
    await act(async () => {
      for (const type of ['mousedown', 'dblclick']) row.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, detail: 2, clientX: 100, clientY: 100,
      }));
    });
    assert.equal(!!h.host.querySelector('.reply-strip'), true, 'действие действительно начинает ответ');
    assert.equal(calls.join(','), scenario === 'closed' ? 'blur,focus' : 'focus', 'B8: только закрытая клавиатура телефона требует blur перед focus');
    assert.equal(document.activeElement === field, true, 'ответ оставляет поле в фокусе');
  } finally {
    h.unmount();
    document.documentElement.removeAttribute('data-kbspace');
    localStorage.removeItem('gv_dbl_action');
    if (oldHit) Object.defineProperty(document, 'elementFromPoint', oldHit); else Reflect.deleteProperty(document, 'elementFromPoint');
    restoreLayout();
  }
}

for (const [scenario, label] of [
  ['closed', 'телефон с фокусом и убранной клавиатурой снимает и возвращает фокус'],
  ['unfocused', 'неактивное поле получает фокус без лишнего blur'],
  ['keyboard', 'видимая клавиатура не мигает при ответе'],
  ['panel', 'открытая панель эмодзи не требует blur поля при ответе'],
  ['desktop', 'компьютер сохраняет обычный focus без blur'],
] as const) it(`B8: ${label}`, () => reply(h.Pane, scenario));

type ResizeCase = {
  phone?: boolean; event?: 'window' | 'visual' | 'none'; age?: number; perturb?: boolean; pinned?: boolean;
};
async function resize(component: Pane, options: ResizeCase = {}) {
  const { phone = true, event = 'window', age = 399, perturb = false, pinned = false } = options;
  const restoreLayout = h.pointerLayout(phone, phone ? 390 : 1200);
  const saved: { target: object; key: string; descriptor: PropertyDescriptor | undefined }[] = [];
  const patch = (target: object, key: string, descriptor: PropertyDescriptor) => {
    saved.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
    feedPatch(target, key, { configurable: true, ...descriptor });
  };
  let height = 600;
  let clock = 1000;
  const visual = new EventTarget();
  const observers: Observer[] = [];
  class Observer {
    targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  const oldHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  patch(HTMLElement.prototype, 'clientHeight', { get() {
    return (this as HTMLElement).classList.contains('messages') ? height : oldHeight?.get?.call(this) ?? 0;
  } });
  patch(globalThis, 'ResizeObserver', { value: Observer });
  patch(window, 'ResizeObserver', { value: Observer });
  patch(window, 'visualViewport', { value: visual });
  patch(performance, 'now', { value: () => clock });
  try {
    await h.mount({ messages: [h.msg('viewport-target', 'peer')] }, component);
    const list = h.host.querySelector<HTMLElement>('.messages');
    assert.ok(list, 'реальная лента смонтирована');
    assert.equal(observers.some(observer => observer.targets.has(list)), true, 'эффект наблюдает саму ленту');
    feedPatch(list, 'scrollHeight', { configurable: true, value: 2000 });
    list.scrollTop = pinned ? 1400 : 1030;
    await act(async () => { list.dispatchEvent(new Event('scroll')); });
    const originalTop = list.scrollTop;
    assert.equal(originalTop, pinned ? 1400 : 1030, 'до изменения высоты сохранена исходная прокрутка');
    const distance = 2000 - originalTop - height;
    await act(async () => {
      if (event === 'window') window.dispatchEvent(new Event('resize'));
      if (event === 'visual') visual.dispatchEvent(new Event('resize'));
    });
    clock += age;
    // Имитируем уже ограниченный браузером scrollTop БЕЗ события scroll:
    // эффект обязан брать сохранённый lastTop, а не это промежуточное значение.
    if (perturb) list.scrollTop = 500;
    const fire = async () => act(async () => {
      for (const observer of observers) if (observer.targets.has(list)) observer.callback([], observer as unknown as ResizeObserver);
    });
    const anchored = phone && event !== 'none' && age < 400;
    height = 400;
    await fire();
    const expectedShrink = anchored || pinned ? originalTop + 200 : originalTop;
    assert.equal(list.scrollTop, expectedShrink, 'B9: сжатие использует сохранённый якорь только в разрешённом окне');
    if (anchored) assert.equal(2000 - list.scrollTop - height, distance, 'расстояние D выше низа сохранилось при сжатии');
    await fire();
    assert.equal(list.scrollTop, expectedShrink, 'повтор наблюдения без изменения высоты не сдвигает ленту');
    height = 700;
    await fire();
    assert.equal(list.scrollTop, anchored ? originalTop - 100 : expectedShrink, 'B9: обратный рост возвращает якорь только на телефоне в окне');
    if (anchored) assert.equal(2000 - list.scrollTop - height, distance, 'расстояние D выше низа сохранилось при росте');
  } finally {
    h.unmount();
    for (const { target, key, descriptor } of saved.reverse()) {
      if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
    }
    restoreLayout();
  }
}

for (const [label, options] of [
  ['resize окна сохраняет D выше низа в обе стороны', {}],
  ['resize visualViewport сохраняет тот же якорь', { event: 'visual' }],
  ['промежуточный scrollTop не заменяет lastTop', { perturb: true }],
  ['ровно 400 мс уже вне окна привязки', { age: 400 }],
  ['401 мс не привязывает ленту выше низа', { age: 401 }],
  ['изменение без resize оставляет прокрутку выше низа', { event: 'none' }],
  ['ПК после resize сохраняет старое поведение выше низа', { phone: false }],
  ['ПК прижатый к низу компенсирует только сжатие', { phone: false, pinned: true }],
  ['телефон без resize прижатый к низу сохраняет старое поведение', { event: 'none', pinned: true }],
] as const) it(`B9: ${label}`, () => resize(h.Pane, options));

// ---- layout: сохранены исходные сценарии и матрицы. ----
async function checkChannelHintAnchor(component: typeof h.Pane) {
  let release!: (hasMore: boolean) => void;
  let calls = 0;
  const older = new Promise<boolean>((resolve) => { release = resolve; });
  await h.mount({ bubbles: false, messages: [h.msg('chan-hint-anchor')], onLoadOlder: () => { calls++; return older; } }, component);
  const list = h.host.querySelector<HTMLElement>('.messages');
  const row = h.host.querySelector<HTMLElement>('[data-mid="chan-hint-anchor"]');
  assert.ok(list, 'канальная лента без окна смонтирована');
  assert.ok(row, 'видимая строка канала доступна как якорь');
  feedPatch(list, 'scrollHeight', { configurable: true, value: 2000 });
  feedPatch(list, 'clientHeight', { configurable: true, value: 600 });
  feedMethod(list, 'getBoundingClientRect', () => new DOMRect(0, 0, 320, 600));
  feedMethod(row, 'getBoundingClientRect', () => new DOMRect(0, (h.host.querySelector('.older-hint') ? 43 : 10) - list.scrollTop, 200, 30));
  await act(async () => { list.dispatchEvent(new Event('scroll')); await h.flush(); });
  assert.equal(calls, 1, 'достижение верхней границы начинает загрузку истории');
  assert.ok(h.host.querySelector('.older-hint'), 'пока запрос открыт, подсказка появилась над строкой');
  assert.equal(list.scrollTop, 33, 'подсказка высотой 33 px компенсируется прокруткой');
  assert.equal(row.getBoundingClientRect().top, 10, 'канальная строка остаётся на прежней экранной отметке');
  release(true);
  await act(async () => { await older; await h.flush(); });
}

feedMutantTest('мутант без канального эффекта отпускает строку при появлении подсказки', async () => {
  // Канал не использует feedWindow: без этого эффекта строка скачет на высоту новой подсказки у нулевого scrollTop.
  const removeChannelHintEffect = (source: string) => {
    const start = source.indexOf('  useLayoutEffect(() => {\n    if (showOlderHint && !feedWindow) holdChanAnchor();');
    const marker = '  }, [showOlderHint]);';
    const end = source.indexOf(marker, start);
    assert.ok(start >= 0 && end >= start, 'найден отдельный эффект канального якоря подсказки');
    return source.slice(0, start) + source.slice(end + marker.length);
  };
  await h.rejectMutant(removeChannelHintEffect, checkChannelHintAnchor);
});

async function checkChannelBottomAnchor(component: typeof h.Pane) {
  let release!: (hasMore: boolean) => void;
  let scrollTop = 100;
  let prepended = false;
  const older = new Promise<boolean>((resolve) => { release = resolve; });
  await h.mount({ bubbles: false, messages: [h.msg('chan-bottom-anchor')], onLoadOlder: () => older }, component);
  const list = h.host.querySelector<HTMLElement>('.messages');
  const row = h.host.querySelector<HTMLElement>('[data-mid="chan-bottom-anchor"]');
  assert.ok(list, 'есть канал с длинной историей для замера якоря');
  assert.ok(row, 'строка, чья шапка может схлопнуться, отрисована');
  feedPatch(list, 'scrollHeight', { configurable: true, get: () => prepended ? 2100 : 2000 });
  feedPatch(list, 'clientHeight', { configurable: true, value: 600 });
  feedPatch(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
  feedMethod(list, 'getBoundingClientRect', () => new DOMRect(0, 0, 320, 600));
  feedMethod(row, 'getBoundingClientRect', () => {
    const top = 110 + (h.host.querySelector('.older-hint') ? 33 : 0) + (prepended ? 10 : 0) - scrollTop;
    const height = prepended ? 20 : 30;
    return new DOMRect(0, top, 200, height);
  });
  await act(async () => { list.dispatchEvent(new Event('scroll')); await h.flush(); });
  assert.equal(scrollTop, 133, 'после подсказки якорь уже возвращён до вставки порции');
  prepended = true;
  await act(async () => { h.root!.render(createElement(component, { ...h.base, bubbles: false,
    messages: [h.msg('chan-older', 'peer', 1000, 1), h.msg('chan-bottom-anchor')], onLoadOlder: () => older })); await h.flush(); });
  assert.equal(row.getBoundingClientRect().bottom, 40, 'при схлопнувшейся с 30 до 20 px шапке низ строки остаётся на прежнем месте');
  assert.equal(scrollTop, 133, 'изменился верх строки, но её нижний якорь не требует ложной прокрутки');
  release(true);
  await act(async () => { await older; await h.flush(); });
}

feedMutantTest('мутант держит верх строки вместо низа при схлопывании шапки канала', async () => {
  // Слияние первой строки с автором предыдущей порции убирает шапку; верхний якорь сдвинул бы весь текст на 10 px.
  const anchorAtTop = (source: string) => {
    let changed = source.replace('offset: rows[i].getBoundingClientRect().bottom - viewTop', 'offset: rows[i].getBoundingClientRect().top - viewTop');
    changed = changed.replace('anchorShift(held, row.getBoundingClientRect().bottom, box.getBoundingClientRect().top)',
      'anchorShift(held, row.getBoundingClientRect().top, box.getBoundingClientRect().top)');
    assert.notEqual(changed, source, 'захвачены оба места, где канал запоминает и восстанавливает низ строки');
    return changed;
  };
  await h.rejectMutant(anchorAtTop, checkChannelBottomAnchor);
});

it('прокрутка пользователя во время подгрузки переносит якорь и не тянет его к старой позиции', async () => {
  // Медленный запрос не даёт права вернуть читателя туда, где он уже был до собственной прокрутки.
  let release!: (hasMore: boolean) => void;
  let scrollTop = 0;
  let prepended = false;
  const older = new Promise<boolean>((resolve) => { release = resolve; });
  await h.mount({ bubbles: false, messages: [h.msg('chan-follow-anchor'), h.msg('chan-follow-next', 'peer', 1000, 20)], onLoadOlder: () => older });
  const list = h.host.querySelector<HTMLElement>('.messages');
  const row = h.host.querySelector<HTMLElement>('[data-mid="chan-follow-anchor"]');
  const next = h.host.querySelector<HTMLElement>('[data-mid="chan-follow-next"]');
  assert.ok(list, 'длинная канальная лента готова к пользовательской прокрутке');
  assert.ok(row, 'первая видимая строка ожидает загрузки старой истории');
  assert.ok(next, 'следующая строка станет якорем после прокрутки читателя');
  feedPatch(list, 'scrollHeight', { configurable: true, get: () => prepended ? 2100 : 2000 });
  feedPatch(list, 'clientHeight', { configurable: true, value: 600 });
  feedPatch(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
  feedMethod(list, 'getBoundingClientRect', () => new DOMRect(0, 0, 320, 600));
  feedMethod(row, 'getBoundingClientRect', () => new DOMRect(0, 10 + (h.host.querySelector('.older-hint') ? 33 : 0) + (prepended ? 30 : 0) - scrollTop, 200, 30));
  feedMethod(next, 'getBoundingClientRect', () => new DOMRect(0, 130 + (h.host.querySelector('.older-hint') ? 33 : 0) + (prepended ? 30 : 0) - scrollTop, 200, 30));
  await act(async () => { list.dispatchEvent(new Event('scroll')); await h.flush(); });
  assert.ok(h.host.querySelector('.older-hint'), 'запрос старой порции всё ещё в пути');
  scrollTop += 60;
  await act(async () => { list.dispatchEvent(new Event('scroll')); await h.flush(); });
  assert.ok(row.getBoundingClientRect().bottom < 0, 'первая строка ушла выше видимой области после жеста пользователя');
  const userBottom = next.getBoundingClientRect().bottom;
  assert.equal(userBottom, 100, 'следующая видимая строка стала новым якорем на выбранном читателем месте');
  prepended = true;
  await act(async () => { h.root!.render(createElement(h.Pane, { ...h.base, bubbles: false,
    messages: [h.msg('chan-user-older', 'peer', 1000, 1), h.msg('chan-follow-anchor'), h.msg('chan-follow-next', 'peer', 1000, 20)], onLoadOlder: () => older })); await h.flush(); });
  assert.equal(next.getBoundingClientRect().bottom, userBottom, 'после вставки порции остаётся на месте новая строка-якорь, не исходная');
  assert.equal(scrollTop, 123, 'прокрутка компенсирует только высоту добавленной старой строки относительно нового якоря');
  release(true);
  await act(async () => { await older; await h.flush(); });
});

it('пока канал подгружает старую историю, новое чужое сообщение показывает счётчик, своё прилипает вниз', async () => {
  // chanHeld — только якорь старой порции: он не должен глушить отдельную политику новых сообщений у нижнего края.
  const exercise = async (author: string, expectedCount: string | null) => {
    let release!: (hasMore: boolean) => void;
    const older = new Promise<boolean>((resolve) => { release = resolve; });
    await h.mount({ bubbles: false, messages: [h.msg('chan-before')], onLoadOlder: () => older });
    const list = h.host.querySelector<HTMLElement>('.messages');
    assert.ok(list, 'канал позволяет отличить нижние новые сообщения от подгрузки сверху');
    let scrollTop = 0;
    feedPatch(list, 'scrollHeight', { configurable: true, value: 2000 });
    feedPatch(list, 'clientHeight', { configurable: true, value: 600 });
    feedPatch(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
    await act(async () => { list.dispatchEvent(new Event('scroll')); await h.flush(); });
    assert.ok(h.host.querySelector('.older-hint'), 'старый запрос остаётся незавершённым, когда приходит новое сообщение');
    await h.rerender({ bubbles: false, messages: [h.msg('chan-before'), h.msg('chan-new', author, 0, 20)], onLoadOlder: () => older });
    if (expectedCount) {
      assert.match(h.host.querySelector('.jump-down')?.textContent ?? '', new RegExp(expectedCount), 'чужое новое сообщение считает кнопку «Вниз»');
      assert.equal(scrollTop, 0, 'чужое новое сообщение не уводит читателя из истории');
    } else {
      assert.equal(scrollTop, 2000, 'своё новое сообщение прижимает канал к низу');
    }
    release(true);
    await act(async () => { await older; await h.flush(); });
    h.unmount();
  };
  h.round12();
  await exercise('peer', '1');
  await exercise('me', null);
});

it('плавающая кнопка «К последним» является потомком feed-frame, а не всего чата', async () => {
  // Узел должен двигаться с доступной высотой ленты и оставаться над composer, reply-strip и строкой печати.
  const feedWindow = { hasOlder: false, hasNewer: true, loadNewer: async () => false, jumpLatest: async () => {}, jumpTo: async () => true,
    unreadBelow: 3, place: null, onPlace: () => {}, readKey: null };
  await h.mount({ messages: [h.msg('jump-frame')], feedWindow });
  const frame = h.host.querySelector('.feed-frame');
  const jump = h.host.querySelector('.feed-frame > .jump-down');
  assert.ok(frame, 'обёртка видимой ленты существует');
  assert.ok(jump, 'кнопка перехода стоит прямо в обёртке ленты');
  assert.ok(!h.host.querySelector('.chat > .jump-down'), 'кнопка не привязана к высоте всего чата');
});

async function checkSelectedMessageMenu(component: typeof h.Pane) {
  h.round12(); h.desktop();
  const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
  const pins = { list: [] as never[], pin: async () => {}, unpin: async () => {} };
  await h.mount({ messages: [h.msg('menu-selected'), h.msg('menu-second', 'peer')], batch, pins, onReact: () => {} }, component);
  const row = h.host.querySelector<HTMLElement>('[data-mid="menu-selected"]');
  const second = h.host.querySelector<HTMLElement>('[data-mid="menu-second"]');
  assert.ok(row, 'сообщение для шапки выделения присутствует');
  assert.ok(second, 'вторая строка нужна для проверки ограничения шапки');
  await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const select = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Выделить'));
  assert.ok(select, 'контекстное меню позволяет войти в выделение');
  await act(async () => { select.click(); await h.flush(); });
  assert.ok(h.host.querySelector('[aria-label="Меню сообщения"]'), 'у одной выбранной строки есть кнопка «⋯»');
  await act(async () => { second.click(); await h.flush(); });
  assert.ok(!h.host.querySelector('[aria-label="Меню сообщения"]'), 'для нескольких строк меню одиночного сообщения недоступно');
  await act(async () => { second.click(); await h.flush(); });
  const more = h.host.querySelector<HTMLButtonElement>('[aria-label="Меню сообщения"]');
  assert.ok(more, 'после снятия второго выбора одиночное меню возвращается');
  await act(async () => { more.click(); await h.flush(); });
  assert.ok(!h.host.querySelector('.sel-head'), 'нажатие «⋯» сначала завершает выделение');
  const menu = document.querySelector<HTMLElement>('.ctx-menu');
  assert.ok(menu, 'выход из режима открыл меню выбранного сообщения');
  assert.ok(menu?.parentElement?.querySelector('.react-bar'), 'меню сохраняет быстрые реакции рядом с действиями');
  assert.ok([...document.querySelectorAll<HTMLButtonElement>('.ctx-stack button')].some((b) => b.textContent?.includes('Закрепить')), 'меню содержит обычное действие «Закрепить» при доступном pin API');
}

feedMutantTest('мутант теряет сообщение для меню «⋯» после снятия выделения', async () => {
  // Если ref не переживёт выход из выделения, одиночная кнопка в шапке молча снимет выбор и ничего не откроет.
  const forgetPickedMessage = (source: string) => {
    const changed = source.replace('    menuAfterSelect.current = m.id;', '    /* mutant: не запоминаем id до размонтирования шапки */');
    assert.notEqual(changed, source, 'найдена запись id для отложенного открытия контекстного меню');
    return changed;
  };
  await h.rejectMutant(forgetPickedMessage, checkSelectedMessageMenu);
});

async function openLaterAndClose(component: typeof h.Pane) {
  h.round12(); h.desktop();
  const sendMenu = { silent: true, later: true, whenOnline: true, schedule: async () => {}, scheduledCount: 0, openScheduled: () => {} };
  await h.mount({ sendMenu, draft: { text: 'планируемое сообщение', replyToId: null } as never }, component);
  const field = h.host.querySelector<HTMLTextAreaElement>('.composer-input');
  const button = h.host.querySelector<HTMLButtonElement>('.send-btn');
  assert.ok(field, 'поле черновика доступно');
  assert.ok(button, 'кнопка отправки открывает планирование');
  const priorBlur = Object.getOwnPropertyDescriptor(field, 'blur');
  const nativeBlur = field.blur.bind(field);
  const blurStacks: string[] = [];
  feedPatch(field, 'blur', { configurable: true, value: () => { blurStacks.push(new Error().stack ?? ''); nativeBlur(); } });
  try {
  await act(async () => { field.focus(); await h.flush(); });
  assert.ok(document.activeElement === field, 'перед меню пользователь действительно печатал в поле');
  await act(async () => { button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const later = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Отправить позже'));
  assert.ok(later, 'меню предлагает открыть календарь');
  await act(async () => { later.click(); await h.flush(); });
  assert.ok(document.querySelector('.sched-pick'), 'лист планирования открыт');
  assert.ok(blurStacks.some((stack) => stack.includes('openLater')), 'именно открытие расписания явно снимает фокус, не последующий modal effect');
  assert.equal(document.activeElement !== field, true, 'открытый лист не оставляет фокус и клавиатуру поверх времени');
  const close = document.querySelector<HTMLButtonElement>('.sched-pick .modal-actions .link');
  assert.ok(close, 'окно планирования даёт отменить выбор без отправки');
  act(() => { close.click(); });
  await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); await h.delay(40); await h.flush(); });
  assert.ok(document.activeElement === field, 'закрытие без выбора возвращает ранее активное поле');
  } finally {
    h.unmount();
    if (priorBlur) Object.defineProperty(field, 'blur', priorBlur); else Reflect.deleteProperty(field, 'blur');
  }
}

feedMutantTest('мутант не снимает фокус с поля при открытии планирования', async () => {
  // На телефоне оставшаяся клавиатура перекрывает время и подтверждение расписания.
  const omitBlur = (source: string) => {
    const changed = source.replace('    if (focused) field.blur();', '    /* mutant: поле остаётся активным */');
    assert.notEqual(changed, source, 'найдено снятие фокуса при открытии SchedPick');
    return changed;
  };
  await h.rejectMutant(omitBlur, openLaterAndClose);
});

feedMutantTest('мутант не возвращает фокус после закрытия календаря без отправки', async () => {
  // Закрытый лист не должен заставлять человека заново отыскивать composer после отмены выбора времени.
  const omitRestore = (source: string) => {
    const changed = source.replace('      if (lf.field) requestAnimationFrame(() => inputRef.current?.focus());', '      /* mutant: отмена теряет фокус */');
    assert.notEqual(changed, source, 'найдено возвращение фокуса в ранее активное поле');
    return changed;
  };
  await h.rejectMutant(omitRestore, openLaterAndClose);
});

it('выбор времени возвращает фокус только на ПК, а телефон не поднимает клавиатуру', async () => {
  // На ПК отправка по расписанию не должна терять позицию набора; на телефоне повторный фокус поднимал бы клавиатуру.
  h.round12();
  const scheduled: Date[] = [];
  const sendMenu = { silent: false, later: true, whenOnline: false, schedule: async (item: { at: Date | null }) => { if (item.at) scheduled.push(item.at); }, scheduledCount: 0, openScheduled: () => {} };
  const run = async (phone: boolean) => {
    const restore = h.pointerLayout(phone, phone ? 390 : 1000);
    try {
      if (phone) h.mobile(); else h.desktop();
      await h.mount({ sendMenu, draft: { text: 'по времени', replyToId: null } as never });
      const field = h.host.querySelector<HTMLTextAreaElement>('.composer-input');
      const button = h.host.querySelector<HTMLButtonElement>('.send-btn');
      assert.ok(field, 'поле композера доступно для проверки клавиатурного фокуса');
      assert.ok(button, 'отправка открывает доступные пункты расписания');
      await act(async () => { field.focus(); button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
      const later = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Отправить позже'));
      assert.ok(later, 'пункт расписания открылся в меню отправки');
      await act(async () => { later.click(); await h.flush(); });
      const quick = document.querySelector<HTMLButtonElement>('.sched-pick .sched-q');
      assert.ok(quick, 'лист содержит быстрый выбор времени');
      act(() => { quick.click(); });
      await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); await h.flush(); });
      assert.equal(scheduled.length, phone ? 2 : 1, 'выбор быстрого времени вызвал callback расписания');
      if (phone) assert.equal(document.activeElement !== field, true, 'после выбора на телефоне фокус не поднимает клавиатуру');
      else assert.ok(document.activeElement === field, 'после выбора на ПК можно продолжить печатать');
      h.unmount();
    } finally { if (h.root) h.unmount(); h.desktop(); restore(); }
  };
  await run(false);
  await run(true);
  assert.equal(scheduled.length, 2, 'оба устройства действительно подтвердили выбранное время');
});

it('видео в ответе сообщения ленты рисует камеру, а не общий значок файла', async () => {
  // Контракт чистого ReplyQuote недостаточен: сам MessagePane должен передать визуальный вид после проверки original video/*.
  const source = { ...h.msg('quote-video-source', 'peer'), content: '', attachments: [
    { url: '/clip.mp4', name: 'clip.mp4', contentType: 'video/mp4', size: 100, durationMs: 12_000 },
  ] } as Message;
  const reply = { ...h.msg('quote-video-reply'), replyTo: { id: source.id, authorName: 'peer', content: '', deleted: false } } as Message;
  await h.mount({ messages: [source, reply] });
  const row = h.host.querySelector<HTMLElement>('[data-mid="quote-video-reply"]');
  assert.ok(row, 'ответ на видео виден в ленте');
  const preview = row.querySelector<HTMLElement>('.reply-quote .rq-thumb');
  assert.ok(preview, 'у видеответа есть ячейка значка');
  assert.equal(preview?.querySelector('svg path')?.getAttribute('d'),
    'M3 7 a2 2 0 0 1 2 -2 h8 a2 2 0 0 1 2 2 v10 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 Z',
    'MessagePane передаёт ReplyQuote kind=video с путём камеры');
});

async function checkSelectionKeepsReplyRow(component: typeof h.Pane) {
  h.round12(); h.desktop();
  const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
  await h.mount({ messages: [h.msg('select-reply-anchor'), h.msg('select-reply-next', 'peer')], batch }, component);
  const row = h.host.querySelector<HTMLElement>('[data-mid="select-reply-anchor"]');
  assert.ok(row, 'строка доступна для предварительного ответа');
  await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const reply = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Ответить'));
  assert.ok(reply, 'контекстное меню открывает reply-strip перед жестом');
  await act(async () => { reply.click(); await h.flush(); });
  assert.ok(h.host.querySelector('.reply-strip'), 'перед входом в выделение reply-strip действительно видна');
  const list = h.host.querySelector<HTMLElement>('.messages');
  assert.ok(list, 'лента доступна для удержания и протяжки');
  const allRows = [...h.host.querySelectorAll<HTMLElement>('.message[data-mid]')];
  assert.equal(allRows.length, 2, 'две строки дают проверяемый диапазон');
  let scrollTop = 390;
  feedPatch(list, 'clientHeight', { configurable: true, get: () => 600 });
  feedPatch(list, 'scrollHeight', { configurable: true, get: () => 1000 + (Number.parseFloat(h.host.querySelector<HTMLElement>('.messages > :last-child')?.style.height ?? '') || 0) });
  feedPatch(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = Math.min(value, list.scrollHeight - list.clientHeight); } });
  const top = (index: number) => 200 + index * 60 + (list.classList.contains('sel-mode') ? 40 : 0) - (scrollTop - 390);
  allRows.forEach((element, index) => { feedMethod(element, 'getBoundingClientRect', () => new DOMRect(0, top(index), 320, 40)); });
  const pointer = (target: Element, type: string, values: Record<string, unknown> = {}) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ pointerId: 17, pointerType: 'mouse', button: 0, buttons: 1, clientX: 40, clientY: 210, ...values }))
      Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
  };
  // Первое воздействие — удержание, второе — смещение за порог; оба начинают именно с первой строки при активном reply-strip.
  await act(async () => { pointer(allRows[0]!, 'pointerdown'); await h.delay(420); });
  assert.ok(h.host.querySelector('.sel-head'), 'удержание мыши входит в пачку поверх активной полосы ответа');
  assert.ok(!h.host.querySelector('.reply-strip'), 'вход в пачку убирает reply-strip и меняет высоту нижней панели');
  assert.equal(top(0), 200, 'удержание оставляет на прежней отметке именно выбранную строку');
  await act(async () => { pointer(window as unknown as Element, 'pointerup', { buttons: 0 }); await h.flush(); });
  await act(async () => { await h.delay(450); });
  await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="select-reply-anchor"]')!.click(); await h.flush(); });
  assert.ok(!h.host.querySelector('.sel-head'), 'снятие последней строки завершает предыдущий жест');
  await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="select-reply-anchor"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const replyAgain = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Ответить'));
  assert.ok(replyAgain, 'можно повторно включить полосу ответа для независимой протяжки');
  await act(async () => { replyAgain.click(); await h.flush(); });
  assert.ok(h.host.querySelector('.reply-strip'), 'перед протяжкой снова видна именно reply-strip');
  allRows.forEach((element, index) => { feedMethod(element, 'getBoundingClientRect', () => new DOMRect(0, top(index), 320, 40)); });
  const dragStartTop = top(0);
  await act(async () => { pointer(allRows[0]!, 'pointerdown'); pointer(window as unknown as Element, 'pointermove', { clientY: 220, buttons: 1 }); await h.flush(); });
  assert.ok(h.host.querySelector('.sel-head'), 'протяжка рядом со строкой начинает выделение');
  assert.equal(top(0), dragStartTop, 'протяжка при том же reply-strip сохраняет строку входа');
  assert.equal(h.host.querySelectorAll('.message[aria-checked="true"]').length, 1, 'короткая протяжка выбирает только начальную строку');
  await act(async () => { pointer(window as unknown as Element, 'pointerup', { buttons: 0 }); await h.flush(); });
}

feedMutantTest('мутант не сохраняет строку при входе удержанием или протяжкой поверх reply-strip', async () => {
  // Reply-strip меняет нижнюю геометрию; без keepRowOnSelect указатель останется над соседней строкой после входа.
  const forgetGestureAnchor = (source: string) => {
    const changed = source.replace('      keepRowOnSelect(g.from);', '      /* mutant: не запоминаем экранную строку */');
    assert.notEqual(changed, source, 'найден общий якорь жестового входа в выделение');
    return changed;
  };
  await h.rejectMutant(forgetGestureAnchor, checkSelectionKeepsReplyRow);
});

async function checkResizeStickDown(component: typeof h.Pane) {
  const oldObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  const oldHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  let visibleHeight = 600;
  let callback: ResizeObserverCallback | null = null;
  class ControlledResizeObserver {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(target: Element) { if (target.classList.contains('messages')) callback = this.cb; }
    unobserve() {}
    disconnect() {}
  }
  feedPatch(globalThis, 'ResizeObserver', { configurable: true, value: ControlledResizeObserver });
  feedPatch(HTMLElement.prototype, 'clientHeight', { configurable: true, get() {
    if ((this as HTMLElement).classList?.contains('messages')) return visibleHeight;
    return oldHeight?.get?.call(this) ?? 0;
  } });
  const run = async (scenario: 'pinned' | 'away' | 'growth' | 'menu') => {
    h.round12();
    await h.mount({ messages: [h.msg(`resize-${scenario}`)], onReact: () => {} }, component);
    const list = h.host.querySelector<HTMLElement>('.messages');
    const row = h.host.querySelector<HTMLElement>(`[data-mid="resize-${scenario}"]`);
    assert.ok(list, 'ResizeObserver видит саму ленту, не чат целиком');
    assert.ok(row, 'у сценария есть реальная строка меню при необходимости');
    assert.ok(callback, 'эффект подписался на изменение размера ленты');
    let scrollTop = scenario === 'away' ? 1300 : 1400;
    feedPatch(list, 'scrollHeight', { configurable: true, value: 2000 });
    feedPatch(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
    if (scenario === 'menu') {
      await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
      assert.ok(document.querySelector('.ctx-menu'), 'пузырь удерживает своё открытое меню');
    }
    visibleHeight = scenario === 'growth' ? 700 : 400;
    await act(async () => { callback!([], {} as ResizeObserver); await h.flush(); });
    const expected = scenario === 'pinned' || scenario === 'menu' ? 1600 : scenario === 'away' ? 1300 : 1400;
    assert.equal(scrollTop, expected, `${scenario}: удерживаем низ только при точном прежнем прилипании, без меню и без роста`);
    h.unmount();
    visibleHeight = 600;
  };
  try {
    await run('pinned');
    await run('away');
    await run('growth');
    await run('menu');
  } finally {
    if (h.root) h.unmount();
    if (oldObserver) Object.defineProperty(globalThis, 'ResizeObserver', oldObserver); else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    if (oldHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', oldHeight); else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  }
}

feedMutantTest('мутант не прибавляет высоту схлопнувшейся ленты к scrollTop', async () => {
  // Убрать именно компенсацию делает скрытыми последние сообщения; неподвижный случай выше проверяется отдельно.
  const omitShrinkCompensation = (source: string) => {
    const changed = source.replace('      el.scrollTop += shrink;', '      /* mutant: не компенсировать уменьшение */');
    assert.notEqual(changed, source, 'найдено прибавление уменьшившейся высоты ленты');
    return changed;
  };
  await h.rejectMutant(omitShrinkCompensation, checkResizeStickDown);
});

async function pasteFileBatch(component: typeof h.Pane, count: number) {
  h.round12();
  await h.mount({}, component);
  const input = h.host.querySelector<HTMLTextAreaElement>('.composer-input');
  assert.ok(input, 'поле composer принимает вставку файлов из буфера');
  const files = Array.from({ length: count }, (_, i) => new File([`f${i}`], `paste-${i}.png`, { type: 'image/png' }));
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { items: files.map((file) => ({ kind: 'file', getAsFile: () => file })), getData: () => '' } });
  await act(async () => { input.dispatchEvent(event); await h.flush(); });
  return { event, files };
}

it('вставка файлов предупреждает о превышении, но принимает точный предел', async () => {
  // Десять вложений — предел API; лишние нужно назвать, иначе выбранный скриншот исчезает для человека бесследно.
  const { useToasts } = await h.server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
  useToasts.setState((s) => ({ ...s, toasts: [] }));
  try {
    const { event } = await pasteFileBatch(h.Pane, 12);
    assert.ok(event.defaultPrevented, 'вставка файлов не начинает одновременно вставлять их имена как текст');
    assert.equal(h.host.querySelectorAll('.pending-att,.pending-thumb').length, 10, 'в поле остаётся ровно допустимое число вложений');
    const warning = useToasts.getState().toasts.at(-1);
    assert.ok(warning && `${warning.title} ${warning.subtitle ?? ''}`.includes('10') && `${warning.title} ${warning.subtitle ?? ''}`.includes('лишние не добавлены'),
      'превышение лимита объяснено предупреждением, а не молчаливым отсевом');
    h.unmount();
    useToasts.setState((s) => ({ ...s, toasts: [] }));
    await pasteFileBatch(h.Pane, 10);
    assert.equal(h.host.querySelectorAll('.pending-att,.pending-thumb').length, 10, 'точно 10 файлов принимаются');
    assert.equal(useToasts.getState().toasts.length, 0, 'ровно допустимый предел не выдаёт ложное предупреждение');
  } finally { h.unmount(); useToasts.setState((s) => ({ ...s, toasts: [] })); }
});

it('на телефоне время поверх фото открывает меню, фото — просмотр, а мышь не превращает время в меню', async () => {
  // На coarse экране метаданные — отдельная цель меню; сама фотография сохраняет просмотр, а desktop time остаётся прозрачным.
  h.round12();
  const photo = { ...h.msg('photo-time'), content: '', attachments: [{ url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', name: 'only.gif', contentType: 'image/gif', size: 1, width: 1, height: 1 }] } as Message;
  const restore = h.pointerLayout(true, 390);
  try {
    h.mobile();
    await h.mount({ messages: [photo] });
    const meta = h.host.querySelector<HTMLElement>('[data-mid="photo-time"] .bub-meta.over');
    assert.ok(meta, 'у фотографии метаданные нарисованы поверх кадра');
    await act(async () => { h.touch(meta, 'touchstart', 30, 30); h.touch(meta, 'touchend', 30, 30); meta.click(); await h.flush(); });
    assert.ok(document.querySelector('.ctx-menu'), 'касание времени поверх фото открывает меню сообщения');
    h.unmount();
    await h.mount({ messages: [photo] });
    const image = h.host.querySelector<HTMLAnchorElement>('[data-mid="photo-time"] .att-img-link');
    assert.ok(image, 'фото доступно отдельной ссылкой просмотра');
    await act(async () => { h.touch(image, 'touchstart', 30, 30); h.touch(image, 'touchend', 30, 30); image.click(); await h.flush(); });
    assert.ok(document.querySelector('.lightbox img'), 'обычный тап по фото открывает просмотр вместо меню');
    assert.ok(!document.querySelector('.ctx-menu'), 'просмотр фото не оставляет меню сообщения поверх него');
    h.unmount(); h.desktop();
    const mouseLayout = h.pointerLayout(false, 1200);
    try {
      await h.mount({ messages: [photo] });
      const desktopImage = h.host.querySelector<HTMLAnchorElement>('[data-mid="photo-time"] .att-img-link');
      assert.ok(desktopImage, 'та же фотография доступна мышиным hit target');
      await act(async () => { desktopImage.click(); await h.flush(); });
      assert.ok(!document.querySelector('.ctx-menu'), 'мышь не превращает область метаданных поверх фото в меню');
      assert.ok(document.querySelector('.lightbox img'), 'прозрачные метаданные оставляют мышиный клик фотографии просмотром');
    } finally { h.unmount(); mouseLayout(); }
  } finally { if (h.root) h.unmount(); h.desktop(); restore(); }
});


it('новый визит после догонки не сохраняет ожидаемый якорь старого прочитанного открытия', async () => {
  h.round12();
  const saved: unknown[] = [];
  const fw = { hasOlder: false, hasNewer: false, loadNewer: async () => false, jumpLatest: async () => {},
    jumpTo: async () => true, unreadBelow: 0, place: null, onPlace: (p: unknown) => saved.push(p), readKey: 100 };
  await h.mount({ messages: [], scrollKey: 'cached', feedWindow: { ...fw, place: { messageId: 'old', offset: -7 } } });
  await h.rerender({ messages: [], scrollKey: 'synced', feedWindow: fw });
  h.unmount();
  assert.equal(saved.at(-1), null, 'уход из актуального визита не воскрешает anchor прочитанного кеша');
});
