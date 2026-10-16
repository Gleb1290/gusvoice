import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import type { Message } from '@gusvoice/shared';
import { setupHarness, type Props } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);


it('выделение, неотправленная строка, удаление во время жеста и touchcancel не запускают ответ', async () => {
  // Эти ветки не имеют действующей цели ответа: отпускание пальца не должно создавать цитату исчезнувшего сообщения.
  const restore = h.pointerLayout(true, 390);
  const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Собеседник', open: () => {} };
  const move = async (body: Element) => act(async () => { h.touch(body, 'touchstart', 100); h.touch(body, 'touchmove', 30); await h.flush(); });
  const end = async (type = 'touchend') => act(async () => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: [] }); window.dispatchEvent(event); await h.flush();
  });
  try {
    h.mobile(); h.round12();
    await h.mount({ messages: [h.msg('selected-no-swipe')], batch });
    let body = h.host.querySelector('.message-body')!;
    await act(async () => { h.touch(body, 'touchstart', 100); await h.delay(560); });
    await end();
    assert.equal(h.host.querySelector('.sel-head') === null, true, 'удержание сначала открывает меню без выбора');
    const choose = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(button => button.textContent?.trim() === 'Выбрать');
    assert.ok(choose, 'меню удержанного сообщения предлагает Выбрать');
    // Клик меню не должен попасть в подавитель синтетического click после долгого касания.
    await act(async () => { await h.delay(450); choose.click(); await h.flush(); await h.delay(220); });
    assert.equal(document.querySelector('.ctx-menu') === null, true, 'выбор закрывает портальное меню');
    assert.ok(h.host.querySelector('.sel-head'), 'для проверки уже открыто выделение');
    await move(body);
    assert.ok(!h.host.querySelector('.swiping'), 'выделение не разрешает свайп');
    await end();
    assert.ok(!h.host.querySelector('.reply-strip'), 'выделение не создаёт цитату');
    h.unmount();
    await h.mount({ outbox: h.queue(), batch }); body = h.host.querySelector('.message-body')!;
    await move(body); await end();
    assert.ok(!h.host.querySelector('.swiping,.reply-strip'), 'неотправленная строка не становится ответом');
    h.unmount();
    await h.mount({ messages: [h.msg('removed-during-swipe')] }); body = h.host.querySelector('.message-body')!;
    await move(body);
    assert.ok(h.host.querySelector('.swiping'), 'до удаления жест был действительно распознан');
    await h.rerender({ messages: [] }); await end();
    assert.ok(!h.host.querySelector('.reply-strip'), 'отпускание после удаления цели не создаёт цитату');
    h.unmount();
    await h.mount({ messages: [h.msg('cancelled-swipe')] }); body = h.host.querySelector('.message-body')!;
    await move(body);
    assert.ok(h.host.querySelector('.swiping'), 'перед touchcancel жест был действительно распознан');
    await end('touchcancel');
    assert.ok(!h.host.querySelector('.swiping,.reply-strip'), 'отменённый системой жест очищается без ответа');
  } finally { if (h.root) h.unmount(); h.desktop(); restore(); }
});

it('правый клик по кнопке отправки открывает меню только для непустого доступного черновика', async () => {
  // Меню отправки не должно перехватывать обычную отправку пустого поля, выключенного флага или режима правки.
  h.round12();
  const sendMenu = { silent: true, later: true, whenOnline: true, schedule: async () => {}, scheduledCount: 0, openScheduled: () => {} };
  const open = async (expected: boolean) => {
    const button = h.host.querySelector<HTMLButtonElement>('.send-btn');
    assert.ok(button, 'fixture содержит кнопку отправки');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 22, clientY: 33 });
    await act(async () => { button!.dispatchEvent(event); await h.flush(); });
    assert.equal(event.defaultPrevented, expected, expected ? 'доступное меню поглощает системный контекст' : 'без готового меню браузерный контекст не перехватывается');
    assert.equal(!!document.querySelector('.ctx-menu'), expected, 'видимость контекстного меню соответствует готовности черновика');
  };
  await h.mount({ sendMenu, draft: { text: '', replyToId: null } as never }); await open(false);
  h.unmount();
  await h.mount({ sendMenu, draft: { text: 'написано', replyToId: null } as never }); await open(true);
  assert.match(document.querySelector('.ctx-menu')?.textContent ?? '', /Отправить без звука/);
  assert.match(document.querySelector('.ctx-menu')?.textContent ?? '', /Когда будет в сети/);
  h.unmount();
  await h.mount({ bubbles: false, sendMenu, draft: { text: 'старый режим', replyToId: null } as never }); await open(false);
});

it('долгое удержание кнопки отправки открывает меню, но не отправляет текст', async () => {
  // Отпускание удержания не должно одновременно активировать обычный click и отправить то же сообщение.
  h.round12(); const restore = h.pointerLayout(true, 390);
  try {
    h.mobile(); const sent: string[] = [];
    const sendMenu = { silent: true, later: true, whenOnline: true, schedule: async () => {}, scheduledCount: 0, openScheduled: () => {} };
    await h.mount({ sendMenu, draft: { text: 'не отправляй при открытии меню', replyToId: null } as never, onSend: async (text: string) => { sent.push(text); } });
    const button = h.host.querySelector<HTMLButtonElement>('.send-btn'); assert.ok(button, 'кнопка доступна в телефонной раскладке');
    await act(async () => { h.touch(button!, 'touchstart', 12, 12); await h.delay(510); });
    assert.ok(document.querySelector('.ctx-menu'), 'после порога 480 мс показан выбор отправки');
    assert.deepEqual(sent, [], 'таймер удержания не вызывает обычную отправку');
    await act(async () => { h.touch(button!, 'touchend'); button!.click(); await h.flush(); });
    assert.deepEqual(sent, [], 'click отпускания после удержания поглощён');
  } finally { h.desktop(); restore(); }
});
h.mutantTest('телефонное меню отправки показывает скрытый от accessibility предпросмотр', async () => {
  // Будущий пузырь виден в телефонном hold-меню, а отсутствие слота в мутанте скрывает реальную регрессию.
  await h.rejectMutant((source) => source.replace('sendMenuAt.spot && phoneLayout ? (', 'false ? ('), async (component) => {
    h.round12(); const restore = h.pointerLayout(true, 390); h.mobile();
    try {
      const sendMenu = { silent: true, later: true, whenOnline: true, schedule: async () => {}, scheduledCount: 0, openScheduled: () => {} };
      await h.mount({ sendMenu, draft: { text: '**важный ответ**', replyToId: null } as never }, component);
      const button = h.host.querySelector<HTMLButtonElement>('.send-btn'); assert.ok(button);
      await act(async () => { h.touch(button!, 'touchstart', 12, 12); await h.delay(510); });
      const preview = document.querySelector<HTMLElement>('.send-preview'); assert.ok(preview, 'телефонный hold-якорь ставит будущий пузырь над меню');
      assert.equal(preview.getAttribute('aria-hidden'), 'true', 'декоративный предпросмотр не дублирует текст для экранного диктора');
      assert.equal(preview.querySelector('.message-body strong')?.textContent, 'важный ответ', 'форматирование совпадает с будущим сообщением');
      assert.equal(preview.querySelector('button') === null, true, 'предпросмотр не перехватывает нажатие мимо меню');
      assert.equal(document.querySelector('.ctx-menu')?.querySelector('.send-preview') === null, true, 'само меню остаётся отдельной карточкой');
    } finally {
      // Реальное касание всегда завершается: иначе глобальный guard удержания
      // переживает размонтирование и гасит contextmenu следующих сценариев.
      window.dispatchEvent(new Event('touchcancel', { bubbles: true }));
      h.desktop(); restore();
    }
  });

  // `rejectMutant` reruns this scenario in a child with a separate Vite server.
  if (!process.env.GUSVOICE_PANE_MUTANT) {
    const { SendPreview } = await h.server.ssrLoadModule('/src/components/SendPreview.tsx') as typeof import('./SendPreview');
    const reply = { id: 'preview-source', authorName: 'Собеседник', content: 'исходный ответ' };
    await h.mount({ text: '**важный ответ**', replyTo: reply, replyName: 'Собеседник', files: [] } as unknown as Partial<Props>, SendPreview as unknown as typeof h.Pane);
    const fullPreview = h.host.querySelector<HTMLElement>('.send-preview'); assert.ok(fullPreview);
    assert.equal(fullPreview.getAttribute('aria-hidden'), 'true', 'полная верстка предпросмотра скрыта от accessibility');
    assert.equal(fullPreview.querySelector('.message-body strong')?.textContent, 'важный ответ', 'bold-маркер превращён в форматированный текст');
    assert.match(fullPreview.querySelector('.reply-quote')?.textContent ?? '', /Собеседник.*исходный ответ/, 'цитата отвечает нужному собеседнику и сообщению');
  }
});

it('отложенные пункты отключены для вложения, правки и скрытого меню', async () => {
  // Сервер принимает отложенно только текст; редактирование и feature-off не должны обещать невозможную отправку.
  h.round12();
  const sendMenu = { silent: true, later: true, whenOnline: true, schedule: async () => {}, scheduledCount: 0, openScheduled: () => {} };
  const open = async (expected = true) => {
    const button = h.host.querySelector<HTMLButtonElement>('.send-btn'); assert.ok(button, 'кнопка отправки отрисована');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => { button!.dispatchEvent(event); await h.flush(); });
    assert.equal(event.defaultPrevented, expected, 'правка не перехватывает контекстное действие отправки');
  };
  await h.mount({ sendMenu, draft: { text: 'текст и файл', replyToId: null } as never });
  const input = h.host.querySelector<HTMLInputElement>('.composer input[type="file"]'); assert.ok(input, 'поле вложения присутствует');
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'note.txt', { type: 'text/plain' })] });
  await act(async () => { input!.dispatchEvent(new Event('change', { bubbles: true })); await h.flush(); }); await open();
  const later = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Отправить позже'));
  const online = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Когда будет в сети'));
  assert.ok(later?.disabled && online?.disabled, 'оба отложенных действия запрещены при наличии файла');
  assert.match(document.querySelector('.ctx-menu')?.textContent ?? '', /Только текст, без вложений/);
  h.unmount();
  // Режим правки открывается из меню сообщения; при нём меню отправки недоступно.
  const restore = h.pointerLayout(true, 390); h.mobile();
  await h.mount({ messages: [h.msg('edit-send')], sendMenu, draft: { text: 'черновик', replyToId: null } as never });
  const row = h.host.querySelector<HTMLElement>('[data-mid="edit-send"]'); assert.ok(row, 'сообщение для входа в правку есть');
  await act(async () => { row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const edit = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Изменить'));
  assert.ok(edit, 'собственное сообщение предлагает правку'); await act(async () => { edit!.click(); await h.flush(); });
  await open(false); assert.ok(!document.querySelector('.ctx-menu'), 'во время правки кнопка не открывает меню отложенной отправки');
  h.desktop(); restore();
});

it('мышиное удержание 400 мс включает пачку и отпускание очищает режим drag', async () => {
  // Пузырь остаётся браузерным текстом, а удержание на пустой части строки выбирает сообщение.
  h.round12();
  const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
  const pointer = (target: Element, type: string, values: Record<string, unknown> = {}) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ pointerId: 4, pointerType: 'mouse', button: 0, clientX: 40, clientY: 40, ...values }))
      Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
  };
  await h.mount({ messages: [h.msg('held-mouse'), h.msg('next-mouse', 'peer')], batch });
  const row = h.host.querySelector<HTMLElement>('[data-mid="held-mouse"]'); assert.ok(row, 'мышь может начать жест на сообщении');
  const main = row.querySelector<HTMLElement>('.message-main'); assert.ok(main, 'пузырь отрисован');
  await act(async () => { pointer(main!, 'pointerdown'); await h.delay(420); });
  assert.ok(!h.host.querySelector('.sel-head'), 'удержание на самом пузыре не начинает выделение сообщения');
  assert.ok(!document.documentElement.classList.contains('gv-sel-drag'), 'пока выделяется текст пузыря, drag-класс не захватывается');
  await act(async () => { pointer(window as unknown as Element, 'pointerup'); await h.flush(); });
  await act(async () => { pointer(row!, 'pointerdown'); await h.delay(420); });
  assert.ok(h.host.querySelector('.sel-head'), 'удержание мыши дольше 400 мс открыло выделение');
  assert.equal(row.getAttribute('aria-checked'), 'true', 'зажатое сообщение выбрано');
  assert.ok(document.documentElement.classList.contains('gv-sel-drag'), 'активное удержание защищает текст от браузерного выделения');
  await act(async () => { window.dispatchEvent(new Event('blur')); await h.flush(); });
  assert.ok(!document.documentElement.classList.contains('gv-sel-drag'), 'потеря фокуса во время активного удержания очищает drag-флаг');
  await act(async () => { pointer(row!, 'pointerdown'); await h.flush(); pointer(window as unknown as Element, 'pointerup'); await h.flush(); });
  assert.ok(!document.documentElement.classList.contains('gv-sel-drag'), 'pointerup очищает и второй активный жест');
  await act(async () => { pointer(row!, 'pointerdown'); await h.flush(); });
  assert.ok(document.documentElement.classList.contains('gv-sel-drag'), 'новое нажатие в активной пачке включает запрет выделения текста');
  await act(async () => { pointer(window as unknown as Element, 'pointercancel'); await h.flush(); });
  assert.ok(!document.documentElement.classList.contains('gv-sel-drag'), 'pointercancel очищает активный жест мыши');
  await act(async () => { pointer(row!, 'pointerdown'); await h.flush(); });
  h.unmount();
  assert.ok(!document.documentElement.classList.contains('gv-sel-drag'), 'размонтирование ленты очищает класс протяжки');
});

it('мышиная протяжка следует геометрии строки, сжимается назад и Esc возвращает исходную пачку', async () => {
  // Обратный ход обязан пересчитать диапазон от точки старта; Escape внутри drag отменяет только добавленное этим жестом.
  h.round12(); const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
  const event = (target: Element, type: string, y: number, buttons = 1) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    for (const [k, v] of Object.entries({ pointerId: 7, pointerType: 'mouse', button: 0, buttons, clientX: 25, clientY: y })) Object.defineProperty(e, k, { value: v });
    target.dispatchEvent(e);
  };
  await h.mount({ messages: ['drag-a', 'drag-b', 'drag-c'].map((id) => h.msg(id)), batch });
  const first = h.host.querySelector<HTMLElement>('[data-mid="drag-a"]'); assert.ok(first, 'строка для основы выбора существует');
  await act(async () => { first!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const choose = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Выделить'));
  assert.ok(choose, 'контекстное меню даёт создать непустую базовую пачку'); await act(async () => { choose!.click(); await h.flush(); });
  assert.equal(first.getAttribute('aria-checked'), 'true', 'до drag уже выбрана первая строка');
  const list = h.host.querySelector<HTMLElement>('.messages'); assert.ok(list, 'ленту можно геометрически измерить');
  Object.defineProperty(list, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 0, bottom: 300, left: 0, right: 400, width: 400, height: 300, x: 0, y: 0, toJSON() {} }) });
  const rows = [...h.host.querySelectorAll<HTMLElement>('.message[data-mid]')];
  assert.equal(rows.length, 3, 'все три строки участвуют в диапазоне');
  rows.forEach((row, i) => Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 10 + i * 40, bottom: 30 + i * 40, left: 0, right: 300, width: 300, height: 20, x: 0, y: 10 + i * 40, toJSON() {} }) }));
  await act(async () => { event(rows[1]!, 'pointerdown', 60); event(window as unknown as Element, 'pointermove', 100); await h.flush(); });
  assert.deepEqual(rows.map((r) => r.getAttribute('aria-checked')), ['true', 'true', 'true'], 'ход к третьей строке добавляет диапазон к прежней основе');
  // Возврат точно к точке старта отменяет вход строки (selectStartIn); остаёмся на 6 px от неё внутри второй строки,
  // чтобы тестировать сжатие уже начатого диапазона, а не отмену самого порога drag.
  await act(async () => { event(window as unknown as Element, 'pointermove', 66); await h.flush(); });
  assert.deepEqual(rows.map((r) => r.getAttribute('aria-checked')), ['true', 'true', 'false'], 'обратный ход убирает вышедшую из диапазона третью');
  await act(async () => {
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); window.dispatchEvent(esc); await h.flush();
  });
  assert.deepEqual(rows.map((r) => r.getAttribute('aria-checked')), ['true', 'false', 'false'], 'Escape восстановил непустую пачку, существовавшую до drag');
  assert.ok(h.host.querySelector('.sel-head'), 'Escape отменяет drag, но оставляет исходный режим выделения активным');
  await act(async () => { event(window as unknown as Element, 'pointerup', 60, 0); await h.flush(); });
  assert.ok(!document.documentElement.classList.contains('gv-sel-drag'), 'после отмены жеста снимается DOM-флаг перетаскивания');
});

it('мышиная пачка на 101 строке останавливается на ста, не обещая невозможное batch API', async () => {
  // Граница должна работать в настоящей ленте тоже: серверный предел — 100, а лишняя строка остаётся невыбранной.
  h.round12(); const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
  const send = (target: Element, type: string, y: number, buttons = 1) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    for (const [k, v] of Object.entries({ pointerId: 8, pointerType: 'mouse', button: 0, buttons, clientX: 20, clientY: y })) Object.defineProperty(e, k, { value: v });
    target.dispatchEvent(e);
  };
  const messages = Array.from({ length: 101 }, (_, i) => h.msg(`cap-${i}`));
  await h.mount({ messages, batch });
  const list = h.host.querySelector<HTMLElement>('.messages'); assert.ok(list, 'лента пачки смонтирована');
  Object.defineProperty(list, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 0, bottom: 5000, left: 0, right: 400, width: 400, height: 5000, x: 0, y: 0, toJSON() {} }) });
  const rows = [...h.host.querySelectorAll<HTMLElement>('.message[data-mid]')];
  rows.forEach((row, i) => Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 10 + i * 20, bottom: 28 + i * 20, left: 0, right: 300, width: 300, height: 18, x: 0, y: 10 + i * 20, toJSON() {} }) }));
  await act(async () => { send(rows[0]!, 'pointerdown', 20); send(window as unknown as Element, 'pointermove', 2020); await h.flush(); });
  const selected = rows.filter((row) => row.getAttribute('aria-checked') === 'true');
  assert.equal(selected.length, 100, 'реальный drag выбирает ровно максимальные сто сообщений');
  assert.equal(rows[100]!.getAttribute('aria-checked'), 'false', 'сто первая строка явно осталась невыбранной');
  await act(async () => { send(window as unknown as Element, 'pointerup', 2020, 0); await h.flush(); });
});

it('живой обработчик выделения отдаёт touch/pen/Shift, меню, отправку и канал своим хозяевам', async () => {
  // Чистая матрица доказывает правило, а эта DOM-проверка — что лента правильно собирает реальные признаки события.
  h.round12(); const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
  const down = (target: Element, pointerType: string, shiftKey = false) => {
    const e = new Event('pointerdown', { bubbles: true, cancelable: true });
    for (const [k, v] of Object.entries({ pointerId: 3, pointerType, button: 0, buttons: 1, shiftKey, clientX: 20, clientY: 20 })) Object.defineProperty(e, k, { value: v });
    target.dispatchEvent(e);
  };
  const up = () => { const e = new Event('pointerup', { bubbles: true }); Object.assign(e, { pointerId: 3, pointerType: 'mouse', buttons: 0 }); window.dispatchEvent(e); };
  await h.mount({ messages: [h.msg('gate-mouse')], batch });
  const main = h.host.querySelector<HTMLElement>('[data-mid="gate-mouse"] .message-main'); assert.ok(main, 'есть реальный пузырь DM');
  for (const [type, shift] of [['touch', false], ['pen', false], ['mouse', true]] as const) {
    await act(async () => { down(main!, type, shift); await h.flush(); });
    assert.ok(!document.documentElement.classList.contains('gv-sel-drag'), `${type}${shift ? '+Shift' : ''}: запрещённое нажатие не захватывает текст`);
    await act(async () => { await h.delay(420); up(); await h.flush(); });
    assert.ok(!h.host.querySelector('.sel-head'), `${type}${shift ? '+Shift' : ''}: даже удержание не запускает мышиный режим`);
  }
  const row = h.host.querySelector<HTMLElement>('[data-mid="gate-mouse"]'); assert.ok(row, 'строка остаётся целью контекстного меню');
  await act(async () => { row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  assert.ok(document.querySelector('.ctx-menu'), 'контекстное меню действительно открыто до проверки гейта');
  await act(async () => { down(main!, 'mouse'); await h.flush(); });
  assert.ok(!document.documentElement.classList.contains('gv-sel-drag'), 'когда меню открыто, нажатие сразу не захватывается');
  await act(async () => { await h.delay(420); up(); await h.flush(); });
  assert.ok(!h.host.querySelector('.sel-head'), 'открытое меню блокирует начало выделения');
  h.unmount();
  await h.mount({ outbox: h.queue(), batch });
  const sending = h.host.querySelector<HTMLElement>('.message'); assert.ok(sending, 'строка отправки в пути есть');
  await act(async () => { down(sending!, 'mouse'); await h.flush(); });
  assert.ok(!document.documentElement.classList.contains('gv-sel-drag'), 'строка в пути не захватывает текст при нажатии');
  await act(async () => { await h.delay(420); up(); await h.flush(); });
  assert.ok(!h.host.querySelector('.sel-head'), 'строка без серверного message id не начинает batch');
  h.unmount();
  await h.mount({ messages: [h.msg('gate-channel')], bubbles: false, batch });
  const channelRow = h.host.querySelector<HTMLElement>('[data-mid="gate-channel"]'); assert.ok(channelRow, 'канальная строка отрисована без пузырей');
  await act(async () => { down(channelRow!, 'mouse'); await h.flush(); });
  assert.ok(!document.documentElement.classList.contains('gv-sel-drag'), 'канал не захватывается как личная пачка уже на down');
  await act(async () => { await h.delay(420); up(); await h.flush(); });
  assert.ok(!h.host.querySelector('.sel-head'), 'канал не включает DM-выделение даже при случайном batch prop');
});

it('правый клик фотографии открывает меню строки и в канале, ссылка получает команды открытия и копирования', async () => {
  // Меню всегда новое: фото получает действия сообщения, внешняя ссылка — свои дополнительные команды.
  await h.mount({ bubbles: false, messages: [{ ...h.msg('link-context'), content: 'https://outside.example/path' }] });
  const external = h.host.querySelector<HTMLAnchorElement>('[data-mid="link-context"] a'); assert.ok(external, 'в тексте есть ссылка с внешним адресом');
  const linkContext = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  await act(async () => { external!.dispatchEvent(linkContext); await h.flush(); });
  assert.equal(linkContext.defaultPrevented, true, 'правый клик ссылки перехвачен нашим меню');
  const linkMenu = document.querySelector('.ctx-menu'); assert.ok(linkMenu, 'ссылка открыла наше меню');
  assert.match(linkMenu.textContent ?? '', /Открыть ссылку/);
  assert.match(linkMenu.textContent ?? '', /Скопировать ссылку/);
  h.unmount();
  h.round12();
  const photo = { ...h.msg('photo-context'), content: 'подпись', attachments: [{ url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', name: 'photo.gif', contentType: 'image/gif', size: 1, width: 1, height: 1 }] } as Message;
  await h.mount({ messages: [photo] });
  assert.match(h.host.querySelector('[data-mid="photo-context"] .message-body')?.textContent ?? '', /подпись/, 'подпись фото остаётся читаемым текстом самого сообщения');
  const link = h.host.querySelector<HTMLElement>('[data-mid="photo-context"] .att-img-link'); assert.ok(link, 'фото — настоящая ссылка-предпросмотр');
  const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  await act(async () => { link!.dispatchEvent(context); await h.flush(); });
  assert.equal(context.defaultPrevented, true, 'фотография открывает специальный контекст');
  assert.ok(document.querySelector('.ctx-menu'), 'меню привязано к сообщению с фото');
  h.unmount();
  await h.mount({ bubbles: false, messages: [photo] });
  const oldLink = h.host.querySelector<HTMLElement>('[data-mid="photo-context"] .att-img-link'); assert.ok(oldLink, 'фото есть и в канале');
  const oldContext = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  await act(async () => { oldLink!.dispatchEvent(oldContext); await h.flush(); });
  assert.equal(oldContext.defaultPrevented, true, 'канальное фото тоже открывает наше меню');
  assert.ok(document.querySelector('.ctx-menu'), 'отсутствие пузырей не отключает меню фото');
  h.unmount(); h.round12(); const restore = h.pointerLayout(true, 390); h.mobile();
  await h.mount({ bubbles: false, messages: [photo] });
  const channelPhoto = h.host.querySelector<HTMLElement>('[data-mid="photo-context"] .att-img-link'); assert.ok(channelPhoto, 'канальная фотография доступна касанию');
  const longPress = new Event('contextmenu', { bubbles: true, cancelable: true }); Object.defineProperty(longPress, 'pointerType', { value: 'touch' });
  await act(async () => { channelPhoto!.dispatchEvent(longPress); await h.flush(); });
  assert.ok(longPress.defaultPrevented, 'долгое касание перехватывает системный contextmenu ссылки фото');
  assert.ok(document.querySelector('.ctx-menu'), 'long-press на канальном фото открывает меню строки');
  h.unmount();
  await h.mount({ bubbles: false, messages: [photo] });
  const preview = h.host.querySelector<HTMLElement>('[data-mid="photo-context"] .att-img-link'); assert.ok(preview, 'предпросмотр доступен отдельным обычным тапом');
  await act(async () => { preview!.click(); await h.flush(); });
  assert.ok(document.querySelector('.lightbox'), 'обычный тап по тому же фото открывает просмотр');
  h.desktop(); restore();
});

it('ссылка в тексте получает своё меню и подтверждение на ПК, а удержание телефона не становится выделением строки', async () => {
  // Иначе общий обработчик строки крадёт адрес ссылки, либо мобильное удержание ошибочно запускает batch/text selection.
  h.round12(); h.desktop();
  const href = 'https://user@outside.example/path?q=1';
  await h.mount({ messages: [{ ...h.msg('round13-link', 'peer'), content: href }] });
  const link = h.host.querySelector<HTMLAnchorElement>('[data-mid="round13-link"] a.msg-link');
  assert.ok(link, 'в тексте есть отдельная внешняя ссылка');
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const writes: string[] = [];
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { writes.push(value); } } });
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 25, clientY: 30 });
    await act(async () => { link.dispatchEvent(context); await h.flush(); });
    assert.ok(context.defaultPrevented, 'ПКМ перехвачен контекстом ссылки в новом режиме');
    const menu = document.querySelector<HTMLElement>('.ctx-menu');
    assert.ok(menu, 'открылось контекстное меню');
    const open = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Открыть ссылку'));
    const copy = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Скопировать ссылку'));
    assert.ok(open, 'меню предлагает открыть именно ссылку'); assert.ok(copy, 'меню предлагает скопировать URL');
    await act(async () => { copy.click(); await h.flush(); });
    await h.delay(50);
    assert.deepEqual(writes, [href], 'в буфер попадает адрес ссылки, а не текст сообщения');
    const again = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 25, clientY: 30 });
    await act(async () => { link.dispatchEvent(again); await h.flush(); });
    const openAgain = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(b => b.textContent?.includes('Открыть ссылку'));
    assert.ok(openAgain, 'открытие и копирование доступны независимыми действиями меню');
    await act(async () => { openAgain.click(); await h.flush(); });
    assert.ok(document.querySelector('.link-confirm'), 'подозрительный адрес проходит через подтверждение, как обычный клик');
    h.unmount(); h.mobile(); const restore = h.pointerLayout(true, 390);
    const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
    await h.mount({ messages: [{ ...h.msg('round13-phone-link', 'peer'), content: href }], batch });
    const phoneLink = h.host.querySelector<HTMLAnchorElement>('[data-mid="round13-phone-link"] a.msg-link');
    assert.ok(phoneLink, 'на телефоне ссылка остаётся целью жеста');
    h.touch(phoneLink, 'touchstart', 20, 20);
    await act(async () => { await h.delay(520); await h.flush(); });
    h.touch(phoneLink, 'touchend', 20, 20);
    await h.flush();
    assert.ok(document.querySelector('.ctx-menu'), 'удержание открывает меню ссылки');
    assert.ok(!h.host.querySelector('.sel-head'), 'удержание ссылки не включает выделение сообщений');
    assert.ok(!document.querySelector('.text-selection'), 'удержание ссылки не запускает текстовый селектор');
    // Long-press leaves a real 400 ms window-level guard for the browser's synthetic click; let it expire so it cannot eat
    // the next test's independent menu-button click (the guard itself is exercised above).
    await h.delay(420);
    restore();
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard); else Reflect.deleteProperty(navigator, 'clipboard');
    h.desktop();
  }
});

it('обычный клик и пункт «Открыть ссылку» одинаково открывают обычный адрес и спрашивают подозрительный', async () => {
  h.round12(); h.desktop();
  const savedOpen = window.open;
  const opened: unknown[][] = [];
  window.open = ((...args: unknown[]) => { opened.push(args); return null; }) as typeof window.open;
  try {
    for (const [url, warn] of [
      ['https://outside.example/path', false],
      ['https://user@outside.example/path', true],
    ] as const) {
      for (const viaMenu of [false, true]) {
        opened.length = 0;
        await h.mount({ messages: [{ ...h.msg('r143-link-parity', 'peer'), content: url }] });
        const link = h.host.querySelector<HTMLAnchorElement>('a.msg-link'); assert.ok(link);
        if (viaMenu) {
          await act(async () => { link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
          const open = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(b => b.textContent?.includes('Открыть ссылку'));
          assert.ok(open, 'контекстное меню предлагает открытие адреса');
          await act(async () => { open.click(); await h.flush(); });
        } else {
          await act(async () => { link.click(); await h.flush(); });
        }
        assert.equal(!!document.querySelector('.link-confirm'), warn, 'меню и клик принимают одинаковое решение');
        assert.deepEqual(opened, warn ? [] : [[url, '_blank', 'noopener,noreferrer']], 'обычная ссылка открыта сразу; подозрительная ждёт решения');
        h.unmount();
      }
    }
  } finally { if (h.root) h.unmount(); window.open = savedOpen; }
});

async function checkLinkContextMenu(component: typeof h.Pane) {
  h.round12(); h.desktop();
  const href = 'https://outside.example/mutant'; const messageCopies: string[] = [];
  try {
    await h.mount({ messages: [{ ...h.msg('link-mutant', 'peer'), content: href }], onCopyLink: m => messageCopies.push(m.id) }, component);
    const link = h.host.querySelector<HTMLAnchorElement>('[data-mid="link-mutant"] a.msg-link'); assert.ok(link, 'в тексте есть ссылка для контекстной команды');
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => { link.dispatchEvent(context); await h.flush(); });
    assert.ok(context.defaultPrevented, 'обработчик сообщения передал ссылочный ПКМ своему меню');
    const copy = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(b => b.textContent?.includes('Скопировать ссылку'));
    assert.ok(copy, 'меню содержит копирование ссылки из текста');
    await act(async () => { copy.click(); await h.flush(); });
    await h.delay(50);
    assert.deepEqual(messageCopies, [], 'команда ссылки из текста не подменена ссылкой на сообщение');
  } finally { h.unmount(); }
}

h.mutantTest('мутант не распознаёт ссылку в контекстном меню строки', async () => {
  // Ловит ранний выход обработчика на ссылке до сборки link/file payload.
  await h.rejectMutant(s => {
    const changed = s.replace('&& !photoLink && !linkEl && !fileEl', '&& !photoLink && !fileEl');
    assert.notEqual(changed, s, 'найдена проверка, которая должна пропускать ссылку к меню'); return changed;
  }, checkLinkContextMenu);
});

h.mutantTest('мутант не передаёт ссылочную цель в обработчик строки', async () => {
  // Ловит разрыв между распознанным DOM-якорем и общим контекстным меню: без act.aim оно не знает URL.
  await h.rejectMutant(s => {
    const changed = s.replace('    act.aim(more);', '    /* mutant: ссылка не передана строке */');
    assert.notEqual(changed, s, 'найден канал передачи данных ссылки в строку'); return changed;
  }, checkLinkContextMenu);
});

h.mutantTest('мутант копирует ссылку на сообщение вместо адреса из текста', async () => {
  // Ловит совпадение подписи меню при неверном действии: буфер должен получить адрес именно этой ссылки.
  await h.rejectMutant(s => {
    const changed = s.replace('copyLinkUrl(link);', 'onCopyLink?.(m);');
    assert.notEqual(changed, s, 'найдена команда копирования URL, отдельная от ссылки на сообщение'); return changed;
  }, checkLinkContextMenu);
});

it('угловая реакция живёт у пузыря ЛС, а у канала остаётся кнопкой действий', async () => {
  // Ловит перенос реакции в чужую поверхность: угловой hover-control предназначен только для личных пузырей.
  h.round12(); const react = () => {};
  await h.mount({ messages: [h.msg('corner-dm')], onReact: react });
  assert.ok(h.host.querySelector('[data-mid="corner-dm"] .msg-react.corner'), 'в ЛС реакция привязана к углу пузыря');
  assert.ok(!h.host.querySelector('[data-mid="corner-dm"] .msg-actions .msg-react'), 'реакция не дублируется в панели действий ЛС');
  h.unmount();
  await h.mount({ bubbles: false, messages: [h.msg('corner-channel')], onReact: react });
  assert.ok(!h.host.querySelector('[data-mid="corner-channel"] .msg-react.corner'), 'в канале нет углового DM-контрола');
  assert.ok(h.host.querySelector('[data-mid="corner-channel"] .msg-actions .msg-react'), 'канальная реакция сохраняет прежнее место в панели действий');
});

it('колесо свайпает ЛС только влево и работает в Tauri, канальная лента жест не перехватывает', async () => {
  // Ловит навигацию истории браузера и ложный ответ на вертикальный/обратный/неподходящий жест.
  h.round12(); h.desktop(); const restore = h.pointerLayout(false, 1200);
  const oldObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  const oldWindowObserver = Object.getOwnPropertyDescriptor(window, 'ResizeObserver');
  const oldClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  let resized: ResizeObserverCallback | null = null;
  class WheelResizeObserver { constructor(private readonly cb: ResizeObserverCallback) {} observe() { resized = this.cb; } disconnect() {} unobserve() {} }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: WheelResizeObserver });
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: WheelResizeObserver });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 });
  const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Peer', open: () => {} };
  const exercise = async (dx: number, props: Partial<Props>, expectedPrevented: boolean) => {
    await h.mount({ messages: [h.msg('wheel-row', 'peer')], batch, ...props });
    const list = h.host.querySelector<HTMLElement>('.messages'); assert.ok(list, 'DOM ленты доступен для реального wheel event');
    const row = h.host.querySelector<HTMLElement>('[data-mid="wheel-row"] .message-body'); assert.ok(row, 'событие идёт изнутри сохраняемого DM-пузыря');
    if (resized) await act(async () => { resized!([], {} as ResizeObserver); await h.flush(); });
    if (expectedPrevented) assert.ok(list.classList.contains('bub-left'), 'широкая лента включила браузерный жест только после измерения ширины');
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: dx, deltaY: dx === 0 ? 35 : 0, deltaMode: 0 });
    await act(async () => { row.dispatchEvent(event); await h.flush(); });
    assert.equal(event.defaultPrevented, expectedPrevented, 'только подходящая DM-лента отменяет горизонтальное листание браузера');
    return list;
  };
  try {
    await exercise(-36, {}, false); h.unmount();
    await exercise(36, {}, true); h.unmount();
    await exercise(36, { bubbles: false }, false); h.unmount();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    await exercise(36, {}, true);
  } finally {
    h.unmount(); h.desktop(); restore();
    if (oldObserver) Object.defineProperty(globalThis, 'ResizeObserver', oldObserver); else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    if (oldWindowObserver) Object.defineProperty(window, 'ResizeObserver', oldWindowObserver); else Reflect.deleteProperty(window, 'ResizeObserver');
    if (oldClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', oldClientWidth); else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  }
});
