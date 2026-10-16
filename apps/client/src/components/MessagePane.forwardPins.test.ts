import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createElement, act } from 'react';
import { Simulate } from 'react-dom/test-utils';
import type { Message } from '@gusvoice/shared';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);


it('без превью не рисует карточку и не запрашивает её, обычная ссылка рисует: даже при готовом кеше', async () => {
  // Ловит игнорирование noPreview в реальной ленте, в том числе уже закешированного адреса.
  const {api}=await h.server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const original=api.linkPreview; const oldSetting=localStorage.getItem('gv_link_preview'); let calls=0;
  localStorage.setItem('gv_link_preview','on');
  api.linkPreview=async url=>{calls++;return {url,title:'Проверка превью',description:'Описание',siteName:'Сайт'};};
  const row={...h.msg('preview-flag'),content:'https://preview-flag.example.test/article'};
  try {
    await h.mount({messages:[{...row,noPreview:true}]});
    assert.ok(!h.host.querySelector('.lp-card')); assert.equal(calls,0);
    await h.rerender({messages:[row]}); await act(async()=>{await h.delay(80);});
    assert.equal(h.host.querySelector('.lp-title')?.textContent,'Проверка превью'); assert.equal(calls,1);
    await h.rerender({messages:[{...row,noPreview:true}]});
    assert.ok(!h.host.querySelector('.lp-card')); assert.equal(calls,1);
  } finally {
    api.linkPreview=original;
    if(oldSetting===null)localStorage.removeItem('gv_link_preview');else localStorage.setItem('gv_link_preview',oldSetting);
  }
});

it('пересылка через picker зовёт batch один раз, показывает завершение и скрывает Вниз', async () => {
  // После успеха человеку нужно подтверждение и быстрый переход, а не перекрывающаяся кнопка «Вниз».
  h.desktop(); h.round12();
  const { useStore } = await h.server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const initial = useStore.getState(); h.resetStore = () => useStore.setState(initial, true);
  const { useToasts } = await h.server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
  const initialToasts = useToasts.getState();
  h.resetStore = () => { useStore.setState(initial, true); useToasts.setState(initialToasts, true); };
  useStore.setState({ dms: [
    { id: 'target', otherUser: { id: 'target-user', username: 'target', displayName: 'Целевая беседа', avatarUrl: null },
      createdAt: new Date(h.now).toISOString(), lastMessageAt: null, unread: 0 },
    { id: 'bad', otherUser: { id: 'bad-user', username: 'bad', displayName: 'Недоступная беседа', avatarUrl: null },
      createdAt: new Date(h.now).toISOString(), lastMessageAt: null, unread: 0 },
  ] as never });
  const calls: [string[], string][] = [];
  const opened: string[] = [];
  const batch = { forward: async (ids: string[], to: string) => { calls.push([ids, to]); if (to === 'bad') throw new Error('network'); }, deleteMany: async () => {},
    peerName: () => 'Целевая беседа', open: (id: string) => opened.push(id) };
  const feedWindow = { hasOlder: false, hasNewer: true, loadNewer: async () => false, jumpLatest: async () => {}, jumpTo: async () => true,
    unreadBelow: 1, place: null, onPlace: () => {}, readKey: null };
  await h.mount({ messages: [h.msg('forward-source'), h.msg('forward-source-2', 'peer')], batch, feedWindow, onReact: () => {} });
  const openPicker = async () => {
    await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="forward-source"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const enterSelection = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((button) => button.textContent?.includes('Выделить'));
    assert.ok(enterSelection, 'пузырь предлагает выделение действий пачкой');
    await act(async () => { enterSelection.click(); await h.flush(); });
    await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="forward-source-2"]')!.click(); await h.flush(); });
    const forward = h.host.querySelector<HTMLButtonElement>('[aria-label="Переслать"]');
    assert.ok(forward, 'выбранные сообщения предлагают пересылку пачкой');
    await act(async () => { forward.click(); await h.flush(); });
    assert.ok(document.querySelector('.fwd-pick'), 'открывается picker бесед');
  };
  const choose = async (name: string) => {
    await openPicker();
    const target = [...document.querySelectorAll<HTMLButtonElement>('.fwd-pick .dm-row')].find((button) => button.textContent?.includes(name));
    assert.ok(target, `picker содержит адресата «${name}»`);
    await act(async () => { target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })); await h.flush(); });
    assert.ok(document.querySelector('.fwd-foot'), 'правый клик отмечает адресата для немедленной пересылки, а не создает черновик');
    await act(async () => { document.querySelector<HTMLButtonElement>('.fwd-send')!.click(); await h.flush(); });
  };
  await openPicker();
  const draftTarget = [...document.querySelectorAll<HTMLButtonElement>('.fwd-pick .dm-row')].find((button) => button.textContent?.includes('Целевая беседа'));
  assert.ok(draftTarget, 'picker содержит беседу для черновика');
  await act(async () => { draftTarget!.click(); await h.flush(); });
  const draft = useStore.getState().fwdDrafts.target;
  assert.equal(draft?.from, 'c', 'обычный клик переносит источник в черновик получателя');
  assert.deepEqual(draft?.messages.map((m) => m.id), ['forward-source', 'forward-source-2']);
  assert.deepEqual(calls, [], 'обычный клик не вызывает batch.forward');
  assert.deepEqual(opened, ['target'], 'после постановки черновика открывается его беседа');
  useStore.getState().setFwdDraft('target', null); opened.length = 0;
  await choose('Целевая беседа');
  assert.deepEqual(calls, [[['forward-source', 'forward-source-2'], 'target']]);
  const done = h.host.querySelector<HTMLElement>('.fwd-done[role="status"]');
  assert.equal(done?.querySelector('span')?.textContent, 'Переслано: Целевая беседа');
  assert.equal(done?.querySelector('button')?.textContent, 'Открыть');
  assert.ok(!h.host.querySelector('.jump-down'), 'кнопка «Вниз» скрыта, пока видна плашка завершения пересылки');
  await act(async () => { h.host.querySelector<HTMLButtonElement>('.fwd-done button')!.click(); await h.flush(); });
  assert.deepEqual(opened, ['target'], 'кнопка «Открыть» переходит к выбранной беседе');
  await choose('Недоступная беседа');
  assert.equal(useToasts.getState().toasts.at(-1)?.title, 'Не удалось переслать', 'ошибка попадает в понятный тост');
  assert.ok(!document.querySelector('.fwd-done'), 'неудача не показывает ложное подтверждение пересылки');
  await choose('Целевая беседа');
  await act(async () => { await h.delay(4100); });
  assert.ok(!document.querySelector('.fwd-done'), 'успешная плашка сама исчезает через четыре секунды');
  assert.ok(h.host.querySelector('.jump-down'), 'после исчезновения плашки возвращается «Вниз»');
});
it('полоса пересылки снимается, хранит source/опции и возвращается после отказа', async () => {
  h.desktop(); h.round12(); localStorage.setItem('gv_send_mode', 'enter');
  const { useStore } = await h.server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const initial = useStore.getState(); h.resetStore = () => useStore.setState(initial, true);
  const source = { ...h.msg('fwd-draft-source', 'peer'), content: 'подпись', attachments: [
    { id: 'photo', url: '/photo.png', name: 'photo.png', contentType: 'image/png', size: 4, width: 10, height: 10 },
  ] as never } as Message;
  const draft = { from: 'source-conversation', messages: [source], hideSender: false, hideCaptions: false };
  useStore.getState().setFwdDraft('target-conversation', draft);
  const calls: { ids: string[]; to: string; silent: boolean; opts?: unknown }[] = [];
  let failNext = false;
  const batch = { forward: async (ids: string[], to: string, silent = false, opts?: { hideSender?: boolean; hideCaptions?: boolean; from?: string }) => {
    calls.push({ ids, to, silent, opts }); if (failNext) { failNext = false; throw new Error('network'); }
  }, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {}, hideOptions: true };
  const targetMessages = [h.msg('existing-target-message', 'peer')];
  const feedWindow = { hasOlder: false, hasNewer: false, loadNewer: async () => false, jumpLatest: async () => {}, jumpTo: async () => true,
    unreadBelow: 0, place: null, onPlace: () => {}, readKey: null };
  await h.mount({ feedId: 'target-conversation', messages: targetMessages, batch, feedWindow }); h.host.classList.add('content');
  assert.ok(h.host.querySelector('.fwd-strip'), 'черновик виден над полем ввода');

  h.unmount();
  await h.mount({ feedId: 'target-conversation', messages: targetMessages, batch, feedWindow, readOnly: true }); h.host.classList.add('content');
  assert.ok(!h.host.querySelector('.fwd-strip'), 'в read-only режиме полоса не перекрывает беседу');
  assert.equal(useStore.getState().fwdDrafts['target-conversation']?.from, 'source-conversation', 'скрытие не уничтожает черновик');
  h.unmount();
  await h.mount({ feedId: 'target-conversation', messages: targetMessages, batch, feedWindow, composerReplacement: createElement('div', null, 'Замена поля') }); h.host.classList.add('content');
  assert.ok(!h.host.querySelector('.fwd-strip'), 'заменённое поле не оставляет над собой неприменимую полосу');
  assert.equal(useStore.getState().fwdDrafts['target-conversation']?.from, 'source-conversation', 'replacement тоже сохраняет черновик');
  h.unmount();
  await h.mount({ feedId: 'target-conversation', messages: targetMessages, batch, feedWindow }); h.host.classList.add('content');
  assert.ok(h.host.querySelector('.fwd-strip'), 'после возврата редактора черновик снова виден');

  await act(async () => { h.host.querySelector<HTMLButtonElement>('.fwd-strip .rs-close')!.click(); await h.flush(); });
  assert.equal(useStore.getState().fwdDrafts['target-conversation'], undefined, '× отменяет черновик, не трогая другие беседы');
  await act(async () => { useStore.getState().setFwdDraft('target-conversation', draft); await h.flush(); });
  assert.ok(h.host.querySelector('.fwd-strip'), 'после отмены новый черновик действительно отрисован');
  assert.equal(document.querySelector('[aria-modal="true"], .modal-overlay, .sheet, .ctx-menu, .confirm-overlay, .dd-pop, .lightbox, .emoji-backdrop, .sb-pop, .status-pop') === null, true, 'Esc не перекрыт посторонним слоем');
  const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  let reachedWindow = false; const observeEsc = () => { reachedWindow = true; }; window.addEventListener('keydown', observeEsc);
  await act(async () => { h.host.querySelector('.chat')!.dispatchEvent(esc); await h.flush(); });
  window.removeEventListener('keydown', observeEsc);
  assert.equal(reachedWindow, true, 'событие дошло до окна, где слушает беседа');
  assert.equal(esc.defaultPrevented, true, 'беседа обработала Esc как слой черновика');
  assert.equal(useStore.getState().fwdDrafts['target-conversation'], undefined, 'Esc снимает черновик пересылки');

  await act(async () => { useStore.getState().setFwdDraft('target-conversation', draft); await h.flush(); });
  await act(async () => { h.host.querySelector<HTMLElement>('.fwd-strip')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const hideCaptions = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Скрыть подписи'));
  assert.ok(hideCaptions, 'для сообщения с подписью доступно скрытие caption');
  await act(async () => { hideCaptions!.click(); await h.flush(); });
  assert.equal(useStore.getState().fwdDrafts['target-conversation']?.hideCaptions, true);
  assert.equal(useStore.getState().fwdDrafts['target-conversation']?.hideSender, true, 'скрытие подписи также скрывает отправителя');

  const firstEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  const composer = h.host.querySelector<HTMLTextAreaElement>('.composer-input')!;
  await act(async () => { composer.focus(); composer.dispatchEvent(firstEnter); await h.flush(); await h.delay(30); });
  assert.equal(firstEnter.defaultPrevented, true, 'нажатие Enter на настоящем поле уходит в отправку');
  assert.deepEqual(calls, [{ ids: ['fwd-draft-source'], to: 'target-conversation', silent: false,
    opts: { hideSender: true, hideCaptions: true, from: 'source-conversation' } }], 'Enter в пустом поле отправляет черновик с исходной беседой и опциями');
  assert.equal(useStore.getState().fwdDrafts['target-conversation'], undefined, 'успешная отправка снимает черновик');

  failNext = true; await act(async () => { useStore.getState().setFwdDraft('target-conversation', draft); await h.flush(); });
  const retryEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  await act(async () => { h.host.querySelector<HTMLTextAreaElement>('.composer-input')!.dispatchEvent(retryEnter); await h.flush(); await h.delay(30); });
  assert.equal(retryEnter.defaultPrevented, true, 'повтор после сетевого отказа также отправляется Enter');
  assert.equal(calls.length, 2, 'отказ сети получил одну попытку');
  assert.equal(useStore.getState().fwdDrafts['target-conversation']?.from, 'source-conversation', 'при отказе черновик возвращён для повтора');
});

it('текст очереди уходит до пересылки из черновика', async () => {
  const check = async (component: typeof h.Pane) => {
  h.desktop(); h.round12();
  const { useStore } = await h.server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const initial = useStore.getState(); h.resetStore = () => useStore.setState(initial, true);
  const source = h.msg('queued-fwd-source', 'peer');
  useStore.getState().setFwdDraft('target-conversation', { from: 'source-conversation', messages: [source], hideSender: false, hideCaptions: false });
  const events: string[] = []; let queuedKey = '';
  const batch = { forward: async (ids: string[], to: string, _silent?: boolean, opts?: { hideSender?: boolean; hideCaptions?: boolean; from?: string }) => {
    events.push(`forward:${to}:${ids.join(',')}`); assert.deepEqual(opts, { hideSender: false, hideCaptions: false, from: 'source-conversation' });
  }, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
  const outbox = { items: [], enqueue: (item: { key: string; content: string }) => {
    queuedKey = item.key; events.push(`queue:${item.content}`);
    useStore.setState((s) => ({ outbox: { ...s.outbox, 'target-conversation': [{ key: item.key, content: item.content, status: 'sending' }] as never } }));
  }, retry: () => {}, discard: () => {} };
  await h.mount({ feedId: 'target-conversation', messages: [], batch, outbox: outbox as never }, component);
  const field = h.host.querySelector<HTMLTextAreaElement>('.composer-input'); assert.ok(field);
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setValue.call(field, 'текст впереди'); Simulate.change(field); await h.flush(); });
  await act(async () => { h.host.querySelector<HTMLFormElement>('.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await h.flush(); });
  assert.deepEqual(events, ['queue:текст впереди'], 'пересылка ждёт пока строка собственного текста ещё в очереди');
  assert.ok(queuedKey, 'очередь выдала ключ завершения');
  await act(async () => {
    useStore.setState((s) => ({ outbox: { ...s.outbox, 'target-conversation': [] } }));
    await h.delay(30);
  });
  assert.deepEqual(events, ['queue:текст впереди', 'forward:target-conversation:queued-fwd-source'], 'после ухода строки из очереди следует пересылка');
  };
  await check(h.Pane);
  h.unmount();
  const { MessagePane: bad } = await h.server.ssrLoadModule('/src/components/MessagePane.tsx?codex-forward-order-mutant') as typeof import('./MessagePane');
  await assert.rejects(() => check(bad), assert.AssertionError, 'исполняемый мутант пересылает до ухода своего текста');
});
async function checkOlderHintAnchor(component: typeof h.Pane) {
  let release!: (hasMore: boolean) => void;
  let loadCalls = 0;
  const older = new Promise<boolean>((resolve) => { release = resolve; });
  const feedWindow = { hasOlder: false, hasNewer: false, loadNewer: async () => false, jumpLatest: async () => {}, jumpTo: async () => true,
    unreadBelow: 0, place: null, onPlace: () => {}, readKey: null };
  await h.mount({ messages: [h.msg('held')], feedWindow }, component);
  const list = h.host.querySelector<HTMLElement>('.messages');
  const row = h.host.querySelector<HTMLElement>('[data-mid="held"]');
  assert.ok(list, 'окно переписки смонтировано'); assert.ok(row, 'строка якоря смонтирована');
  assert.ok(row.matches('.message[data-mid]'), 'якорем становится именно DOM-строка сообщения');
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 2000 });
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 600 });
  list.getBoundingClientRect = () => new DOMRect(0, 0, 320, 600);
  row.getBoundingClientRect = () => new DOMRect(0, (h.host.querySelector('.older-hint') ? 43 : 10) - list.scrollTop, 200, 30);
  await act(async () => { h.root!.render(createElement(component, { ...h.base, messages: [h.msg('held')], feedWindow: { ...feedWindow, hasOlder: true },
    onLoadOlder: () => { loadCalls++; return older; } })); await h.flush(); });
  assert.equal(loadCalls, 0, 'изменение окна само не начинает подгрузку до прокрутки к краю');
  await act(async () => { list.dispatchEvent(new Event('scroll')); await h.flush(); });
  assert.equal(loadCalls, 1, 'достижение края запускает ровно одну подгрузку старой истории');
  assert.ok(h.host.querySelector('.older-hint'), 'начавшаяся подгрузка показывает подсказку');
  assert.equal(list.scrollTop, 33, 'появление 33 px подсказки компенсируется прокруткой, строка остаётся на исходной отметке');
  assert.equal(row.getBoundingClientRect().top, 10, 'после компенсации видимая строка действительно на прежнем месте');
  release(true);
  await act(async () => { await older; await h.flush(); });
}
h.mutantTest('мутант без эффекта подсказки отпускает якорь у верхнего края', async () => {
  // Важно проверять именно регрессию: на нулевом scrollTop обычная прокрутка не удержит видимую строку.
  const removeHintEffect = (source: string) => {
    const start = source.indexOf('  useLayoutEffect(() => {\n    const held = heldAnchor.current;');
    const marker = '  }, [showOlderHint]);';
    const end = source.indexOf(marker, start);
    assert.ok(start >= 0 && end >= start, 'найден layout effect коррекции якоря подсказки');
    return source.slice(0, start) + source.slice(end + marker.length);
  };
  await h.rejectMutant(removeHintEffect, checkOlderHintAnchor);
});
it('короткая лента принимает новую позицию якоря, если прокрутка упёрлась в ноль', async () => {
  // Нельзя восстановить место выше нуля: следующая порция должна держать строку после уже видимой подсказки.
  h.desktop(); h.round12();
  let release!: (hasMore: boolean) => void;
  let loadCalls = 0;
  let scrollTop = 0;
  let extent = 550;
  let prepended = false;
  const older = new Promise<boolean>((resolve) => { release = resolve; });
  const feedWindow = { hasOlder: false, hasNewer: false, loadNewer: async () => false, jumpLatest: async () => {}, jumpTo: async () => true,
    unreadBelow: 0, place: null, onPlace: () => {}, readKey: null };
  await h.mount({ messages: [h.msg('short-held')], feedWindow });
  const list = h.host.querySelector<HTMLElement>('.messages');
  const row = h.host.querySelector<HTMLElement>('[data-mid="short-held"]');
  assert.ok(list, 'короткая лента смонтирована'); assert.ok(row, 'строка-якорь короткой ленты присутствует');
  list.getBoundingClientRect = () => new DOMRect(0, 0, 320, 600);
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => extent });
  Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop,
    set: (value: number) => { scrollTop = Math.max(0, Math.min(value, Math.max(0, extent - 600))); } });
  row.getBoundingClientRect = () => new DOMRect(0, (h.host.querySelector('.older-hint') ? 43 : 10) + (prepended ? 60 : 0) - list.scrollTop, 200, 30);
  await act(async () => { h.root!.render(createElement(h.Pane, { ...h.base, messages: [h.msg('short-held')], feedWindow: { ...feedWindow, hasOlder: true },
    onLoadOlder: () => { loadCalls++; return older; } })); await h.flush(); });
  assert.equal(loadCalls, 1, 'окно с доступной историей запускает единственную верхнюю подгрузку');
  assert.equal(list.scrollTop, 0, 'кламп не разрешает прокрутку выше нуля');
  assert.equal(row.getBoundingClientRect().top, 43, 'подсказка становится частью нового видимого места');
  prepended = true; extent = 1000;
  await act(async () => { h.root!.render(createElement(h.Pane, { ...h.base, messages: [h.msg('short-older', 'peer', 1000, 1), h.msg('short-held')],
    feedWindow: { ...feedWindow, hasOlder: true }, onLoadOlder: () => { loadCalls++; return older; } })); await h.flush(); });
  assert.equal(list.scrollTop, 60, 'новая порция сдвигает ленту ровно настолько, чтобы вернуть строку к offset 43');
  assert.equal(row.getBoundingClientRect().top, 43, 'после догрузки строка остаётся у видимой подсказки, а не прыгает на старый offset');
  release(true);
  await act(async () => { await older; await h.flush(); });
});

it('закреп из меню спрашивает область, открепление даёт пять секунд отмены и сохраняет scope', async () => {
  // Параметр области — реальное решение человека: дефолт общего действия нельзя незаметно подменять на «только у меня».
  h.desktop(); h.round12(); const calls: string[] = [];
  const pins = { list: [] as never[],
    pin: async (id: string, scope: string) => { calls.push(`pin:${id}:${scope}`); },
    unpin: async (id: string, scope: string) => { calls.push(`unpin:${id}:${scope}`); } };
  await h.mountWithConfirm({ messages: ['pin-1', 'pin-2'].map((id) => h.msg(id)), pins, deletePeerName: 'Peer' });
  const menuAction = async (id: string, label: string) => {
    const row = h.host.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    assert.ok(row, `строка ${id} присутствует для открытия меню`);
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const action = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.trim() === label);
    assert.ok(action, `меню предлагает действие «${label}» для ${id}; stack=${document.querySelector('.ctx-stack')?.textContent}; body=${h.host.textContent}`);
    if (id === 'pin-1') {
      const labels = [...document.querySelectorAll('.ctx-menu .ctx-label-main')].map((node) => node.textContent?.trim());
      assert.ok(labels.indexOf('Закрепить') === labels.indexOf('Изменить') + 1, 'закреп в меню ЛС расположено сразу после «Изменить»');
    }
    await act(async () => { action.click(); await h.flush(); });
  };
  await menuAction('pin-1', 'Закрепить');
  assert.equal(document.querySelector('#confirm-title')?.textContent, 'Закрепить сообщение?', 'закреп требует подтверждения');
  assert.ok((document.querySelector<HTMLInputElement>('.confirm-option input'))?.checked, 'по умолчанию закреп предлагается для собеседника тоже');
  await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
  await menuAction('pin-2', 'Закрепить');
  const pinOption = document.querySelector<HTMLInputElement>('.confirm-option input');
  assert.ok(pinOption?.checked, 'повторное окно начинается с общего закрепа');
  await act(async () => { pinOption.click(); document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
  h.unmount();
  const unpinProps = { ...pins, list: [h.pin('pin-3', 'me', true), h.pin('pin-4', 'me', true), h.pin('pin-5', 'me', false)] };
  await h.mountWithConfirm({ messages: ['pin-3', 'pin-4', 'pin-5'].map((id) => h.msg(id)), pins: unpinProps, deletePeerName: 'Peer' });
  await menuAction('pin-3', 'Открепить');
  assert.equal(document.querySelector('#confirm-title') === null, true, 'из меню открепление теперь отменяется плашкой');
  assert.ok(h.host.textContent?.includes('Сообщение откреплено'));
  assert.equal(calls.filter(c => c.startsWith('unpin:')).length, 0);
  const undo = [...h.host.querySelectorAll<HTMLButtonElement>('.fwd-done button')].find(b => b.textContent?.trim() === 'Отменить'); assert.ok(undo);
  await act(async () => { undo.click(); await h.flush(); });
  await menuAction('pin-4', 'Открепить');
  await menuAction('pin-5', 'Открепить');
  assert.equal(calls.filter(c => c.startsWith('unpin:')).length, 0, 'пока пять секунд не прошли запросов нет');
  h.unmount(); await h.flush();
  assert.deepEqual(calls, ['pin:pin-1:both', 'pin:pin-2:me', 'unpin:pin-4:both', 'unpin:pin-5:me'], 'при размонтировании ожидающее фиксируется, отменённое не отправляется');
});

it('крестики полосы и списка вызывают тот же сценарий открепления с нужной областью', async () => {
  // Крестики, в отличие от меню с undo, подтверждают и общий, и личный закреп.
  h.desktop(); h.round12(); const calls: string[] = [];
  const pins = { list: [h.pin('bar-only', 'me', true)], pin: async () => {},
    unpin: async (id: string, scope: string) => { calls.push(`${id}:${scope}`); } };
  await h.mountWithConfirm({ messages: [h.msg('bar-only'), h.msg('list-both', 'me'), h.msg('list-mine', 'peer')], pins });
  const barRemove = h.host.querySelector<HTMLButtonElement>('.pin-bar-btn[aria-label="Открепить"]');
  assert.ok(barRemove, 'единственное закрепление имеет крестик открепления на полосе');
  await act(async () => { barRemove.click(); await h.flush(); });
  assert.equal(document.querySelector('#confirm-title')?.textContent, 'Открепить сообщение?', 'крестик полосы подтверждает общий закреп');
  await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
  h.unmount();
  const multiPins = { ...pins, list: [h.pin('list-both', 'me', true), h.pin('list-mine', 'peer', false)] };
  await h.mountWithConfirm({ messages: [h.msg('bar-only'), h.msg('list-both'), h.msg('list-mine', 'peer')], pins: multiPins });
  await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-btn[aria-label="Все закреплённые"]')!.click(); await h.flush(); });
  const list = document.querySelector<HTMLElement>('.pins-pop');
  assert.ok(list, 'несколько закреплений открывают список действий');
  const mineRow = [...list.querySelectorAll<HTMLElement>('.pin-item')].find((item) => item.textContent?.includes('Текст list-mine'));
  assert.ok(mineRow, 'личное закрепление доступно в списке');
  await act(async () => { mineRow.querySelector<HTMLButtonElement>('.pin-unpin')!.click(); await h.flush(); });
  assert.equal(document.querySelector('#confirm-title')?.textContent, 'Открепить сообщение?', 'крестик личного закрепа тоже открывает подтверждение');
  await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
  const bothRow = [...document.querySelectorAll<HTMLElement>('.pin-item')].find((item) => item.textContent?.includes('Текст list-both'));
  assert.ok(bothRow, 'общее закрепление доступно в списке');
  await act(async () => { bothRow.querySelector<HTMLButtonElement>('.pin-unpin')!.click(); await h.flush(); });
  assert.equal(document.querySelector('#confirm-title')?.textContent, 'Открепить сообщение?', 'крестик общего закрепа просит подтверждение');
  assert.ok(document.querySelector<HTMLInputElement>('.confirm-option input')?.checked, 'по умолчанию крестик списка снимает закреп у обоих');
  await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
  assert.deepEqual(calls, ['bar-only:both', 'list-mine:me', 'list-both:both']);
});

it('читающий у нижней границы остаётся у низа при появлении и исчезновении полосы закрепа', async () => {
  // Последние сообщения не должны уходить под поле ввода, когда полоса отнимает или возвращает высоту ленты.
  h.desktop(); h.round12(); let extent = 2000; let height = 600; let scrollTop = 0;
  const pins = { list: [] as never[], pin: async () => {}, unpin: async () => {} };
  await h.mount({ messages: [h.msg('bottom')], pins });
  const list = h.host.querySelector<HTMLElement>('.messages');
  assert.ok(list, 'прокручиваемая лента присутствует');
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => extent });
  Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => height });
  Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop,
    set: (value: number) => { scrollTop = Math.max(0, Math.min(value, Math.max(0, extent - height))); } });
  list.scrollTop = extent - height;
  await act(async () => { list.dispatchEvent(new Event('scroll')); await h.flush(); });
  assert.equal(list.scrollTop, 1400, 'перед изменением полосы человек действительно стоит у низа');
  height = 550;
  await h.rerender({ messages: [h.msg('bottom')], pins: { ...pins, list: [h.pin('bottom')] } });
  assert.ok(h.host.querySelector('.pin-bar'), 'новый закреп добавил полосу над лентой');
  assert.equal(list.scrollTop, 1450, 'появление полосы удерживает низ с учётом уменьшившейся высоты');
  height = 600;
  await h.rerender({ messages: [h.msg('bottom')], pins });
  assert.ok(!h.host.querySelector('.pin-bar'), 'после удаления последнего закрепа полоса исчезает');
  assert.equal(list.scrollTop, 1400, 'исчезновение полосы возвращает низ к прежней границе');
});

it('закреп показывает отдельный тост для лимита и сети, а отмена не вызывает API', async () => {
  // У 409 есть пользовательское объяснение, сетевой отказ не должен маскироваться под предел, отмена не меняет данные.
  h.desktop(); h.round12();
  const { useToasts } = await h.server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
  const initialToasts = useToasts.getState(); h.resetStore = () => useToasts.setState(initialToasts, true);
  const calls: string[] = [];
  const pins = { list: [] as never[], unpin: async () => {}, pin: async (id: string) => {
    calls.push(id);
    if (id === 'limit') throw Object.assign(new Error('pin limit'), { status: 409 });
    if (id === 'network') throw new Error('network down');
  } };
  await h.mountWithConfirm({ messages: ['limit', 'network', 'cancel'].map((id) => h.msg(id)), pins });
  const pinFromMenu = async (id: string) => {
    const row = h.host.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    assert.ok(row, `строка ${id} существует`);
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const action = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.trim() === 'Закрепить');
    assert.ok(action, `меню открывает подтверждение закрепа для ${id}`);
    await act(async () => { action.click(); await h.flush(); });
    assert.ok(document.querySelector('#confirm-title'), `для ${id} открылось подтверждение`);
  };
  await pinFromMenu('limit');
  await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
  assert.equal(useToasts.getState().toasts.at(-1)?.title, 'Не удалось закрепить', '409 показывает специальный тост, а не raw-ошибку');
  assert.match(useToasts.getState().toasts.at(-1)?.subtitle ?? '', /50 сообщений/, 'лимит объяснён числом и дальнейшим действием');
  await pinFromMenu('network');
  await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-primary')!.click(); await h.flush(); });
  const networkToast = useToasts.getState().toasts.at(-1);
  assert.equal(networkToast?.title, 'Не удалось закрепить', 'обычная ошибка тоже отображается понятным действием');
  assert.equal(networkToast?.subtitle, 'network down', 'обычный сетевой отказ сохраняет свою причину');
  assert.ok(!/50 сообщений/.test(networkToast?.subtitle ?? ''), 'сетевая ошибка не маскируется под лимит закрепов');
  await pinFromMenu('cancel');
  await act(async () => { document.querySelector<HTMLButtonElement>('.confirm-actions .ghost')!.click(); await h.flush(); });
  assert.deepEqual(calls, ['limit', 'network'], 'подтверждение отмены не отправляет запрос');
});

it('полоса начинает с нового закрепа, циклически ведёт к прошлому и список защищает выделение от Escape', async () => {
  // Цикл важен для быстрого возврата к предыдущему закрепу, а aria-modal не должен пропускать Escape в режим выделения.
  h.desktop(); h.round12();
  const pins = { list: [h.pin('oldest', 'peer'), h.pin('middle', 'me'), h.pin('newer', 'peer')], pin: async () => {}, unpin: async () => {} };
  const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
  await h.mount({ messages: [h.msg('oldest', 'peer'), h.msg('middle'), h.msg('newer', 'peer')], pins, batch });
  const bar = h.host.querySelector<HTMLElement>('.pin-bar');
  assert.ok(bar, 'три закреплённые строки показывают полосу');
  assert.match(bar.textContent ?? '', /Текст newer/, 'при открытии полоса выбирает самое новое закрепление');
  const main = bar.querySelector<HTMLButtonElement>('.pin-bar-main');
  assert.ok(main, 'текст полосы доступен как кнопка перехода');
  await act(async () => { main.click(); await h.flush(); });
  assert.match(h.host.querySelector('.pin-bar')?.textContent ?? '', /Текст middle/, 'после перехода полоса перемещается ровно на одно закрепление назад');
  assert.ok(h.host.querySelector('[data-mid="newer"]')?.classList.contains('jump-hit'), 'нажатие полосы действительно прыгает к текущему сообщению');
  await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-main')!.click(); await h.flush(); });
  assert.match(h.host.querySelector('.pin-bar')?.textContent ?? '', /Текст oldest/, 'движение назад различает круг при трёх закреплениях');
  await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-main')!.click(); await h.flush(); });
  assert.match(h.host.querySelector('.pin-bar')?.textContent ?? '', /Текст newer/, 'от самого старого закрепа круг возвращается к новому');
  // Выделение открываем до модального списка, чтобы Escape проверял именно порядок слоёв, а не синтетический клик сквозь подложку.
  const selectedRow = h.host.querySelector<HTMLElement>('[data-mid="middle"]');
  assert.ok(selectedRow, 'строка доступна для включения режима выделения');
  await act(async () => { selectedRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const select = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Выделить'));
  assert.ok(select, 'контекстное меню предлагает включить пачечное выделение');
  await act(async () => { select.click(); await h.flush(); });
  assert.ok(h.host.querySelector('.sel-head'), 'пачка выделена до проверки Esc');
  const opener = h.host.querySelector<HTMLButtonElement>('.pin-bar-btn');
  assert.ok(opener, 'многозначная полоса имеет кнопку списка');
  opener.focus();
  await act(async () => { opener.click(); await h.flush(); });
  const dialog = document.querySelector<HTMLElement>('.pins-pop[aria-modal="true"]');
  assert.ok(dialog, 'кнопка списка открывает настоящий модальный список закреплений над пачкой');
  const items = [...dialog.querySelectorAll<HTMLElement>('.pin-item')];
  assert.equal(items.length, 3, 'список содержит три закрепления');
  assert.match(items[0]!.textContent ?? '', /Текст newer/, 'список показывает новые закрепы сверху');
  assert.ok(!dialog.querySelector('.msg-ava'), 'строки закрепов не добавляют аватары ленты');
  // Без ухода фокуса эта проверка проходит даже при сломанном возврате на кнопку открытия.
  const focusedPin = dialog.querySelector<HTMLElement>('.pin-main');
  assert.ok(focusedPin, 'в списке есть доступная для фокуса строка закрепа');
  focusedPin.focus();
  assert.ok(document.activeElement === focusedPin && document.activeElement !== opener, 'перед Escape фокус действительно ушёл с кнопки открытия в список');
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await h.flush(); });
  assert.ok(!document.querySelector('.pins-pop'), 'первый Escape закрывает только верхний список');
  assert.ok(document.activeElement === h.host.querySelector('.pin-bar-btn'), 'закрытие Escape возвращает фокус на кнопку списка');
  assert.ok(h.host.querySelector('.sel-head'), 'Escape списка не сбрасывает выделение под модальным слоем');
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await h.flush(); });
  assert.ok(!h.host.querySelector('.sel-head'), 'следующий Escape уже закрывает выделение');
  await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-btn')!.click(); await h.flush(); });
  const reopened = document.querySelector<HTMLElement>('.pins-pop');
  assert.ok(reopened, 'список закреплений можно открыть повторно');
  const { stepBack } = await h.server.ssrLoadModule('/src/androidBack.ts') as typeof import('../androidBack');
  let handled = false; await act(async () => { handled = stepBack(); await h.flush(); });
  assert.equal(handled, true, 'системная «Назад» потребляется открытым списком');
  assert.ok(!document.querySelector('.pins-pop'), 'системная «Назад» закрывает список, не уходя из беседы');
  await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-btn')!.click(); await h.flush(); });
  const keyboardList = document.querySelector<HTMLElement>('.pins-pop');
  assert.ok(keyboardList, 'после системного возврата список можно открыть снова');
  await act(async () => { keyboardList.querySelector('.pin-main')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await h.flush(); });
  assert.ok(!document.querySelector('.pins-pop'), 'Enter на строке списка переходит к закрепу и закрывает поповер');
  assert.match(h.host.querySelector('.pin-bar')?.textContent ?? '', /Текст middle/, 'переход клавиатурой сохраняет соседнее выбранное закрепление');
});

h.mutantTest('мутант закреплённой полосы без jumpToMessage не проходит настоящий переход', async () => {
  // Закреп нельзя только подсветить в заголовке: место ленты тоже должно перейти к его сообщению.
  await h.rejectMutant((s) => s.replace('    void jumpToMessage(id);', '    // переход удалён мутантом;'), async (component) => {
    h.desktop(); h.round12();
    const pins = { list: [h.pin('jump-a'), h.pin('jump-b'), h.pin('jump-c')], pin: async () => {}, unpin: async () => {} };
    await h.mount({ messages: ['jump-a', 'jump-b', 'jump-c'].map((id) => h.msg(id)), pins }, component);
    await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-main')!.click(); await h.flush(); });
    assert.ok(h.host.querySelector('[data-mid="jump-c"]')?.classList.contains('jump-hit'), 'целевая строка получила вспышку перехода');
  });
});

h.mutantTest('мутант после закрепления не выбирает новое сообщение в полосе', async () => {
  // Если человек уже смотрел старое закрепление, новый pin обязан стать текущим, даже когда он не последний в ответе сервера.
  await h.rejectMutant((s) => s.replace('      setPinShown(m.id);', '      // обновление текущего закрепления удалено мутантом;'), async (component, confirm = h.ConfirmHost, answer) => {
    h.desktop(); h.round12();
    let list = [h.pin('p-old'), h.pin('p-middle'), h.pin('p-latest')];
    const pins = { list, pin: async (id: string) => { list = [h.pin(id), ...list]; }, unpin: async () => {} };
    const props = { messages: ['p-old', 'p-middle', 'p-latest', 'p-new'].map((id) => h.msg(id)), pins };
    if (process.env.GUSVOICE_PANE_MUTANT) await h.mount(props, component);
    else await h.mountWithConfirm(props, component, confirm);
    await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-main')!.click(); await h.flush(); });
    await act(async () => { h.host.querySelector<HTMLButtonElement>('.pin-bar-main')!.click(); await h.flush(); });
    assert.match(h.host.querySelector('.pin-bar')?.textContent ?? '', /Текст p-old/, 'перед закреплением полоса удерживает выбранное старое сообщение');
    const row = h.host.querySelector<HTMLElement>('[data-mid="p-new"]');
    assert.ok(row, 'новое сообщение есть в ленте для закрепления');
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const action = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.trim() === 'Закрепить');
    assert.ok(action, 'действие нового закрепа присутствует в меню');
    await act(async () => { action.click(); await h.flush(); });
    if (process.env.GUSVOICE_PANE_MUTANT) {
      assert.ok(answer, 'для изолированного мутанта доступен его собственный store подтверждения');
      await act(async () => { answer(); await h.flush(); });
    } else {
      const confirmButton = document.querySelector<HTMLButtonElement>('.confirm-primary');
      assert.ok(confirmButton, 'новое закрепление запрашивает подтверждение перед изменением');
      await act(async () => { confirmButton.click(); await h.flush(); });
    }
    await act(async () => { h.root!.render(createElement(component, { ...h.base, ...props, pins: { ...pins, list } })); await h.flush(); });
    assert.match(h.host.querySelector('.pin-bar')?.textContent ?? '', /Текст p-new/, 'после ответа закрепа полоса сразу выбирает новое сообщение');
  });
});
