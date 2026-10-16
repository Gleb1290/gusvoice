import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);
const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Друг', open: () => {} };
const messages = () => ['range-one', 'range-two', 'range-three'].map((id, i) => h.msg(id, 'me', 0, i + 1));

// Настоящий identifier нужен для mine(): чужой палец не должен продолжать наш диапазон.
function touch(target: EventTarget, type: string, x = 30, y = 120, identifier = 7) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const finger = { identifier, clientX: x, clientY: y };
  Object.defineProperties(event, {
    touches: { value: type === 'touchend' || type === 'touchcancel' ? [] : [finger] },
    changedTouches: { value: [finger] },
  });
  target.dispatchEvent(event);
  return event;
}

function buttons() {
  return [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')];
}

async function fixture(component = h.Pane, mobile = true, coarse = true) {
  h.round12(); mobile ? h.mobile() : h.desktop();
  const restore = h.pointerLayout(coarse, coarse ? 390 : 1280);
  await h.mount({ messages: messages(), batch }, component);
  const list = h.host.querySelector<HTMLElement>('.messages');
  assert.ok(list, 'настоящая лента смонтирована');
  list.getBoundingClientRect = () => new DOMRect(0, 40, 390, 500);
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
  for (const [index, id] of ['range-one', 'range-two', 'range-three'].entries()) {
    const row = h.host.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    assert.ok(row, 'строка диапазона смонтирована');
    row.getBoundingClientRect = () => new DOMRect(0, 100 + index * 70, 360, 60);
  }
  const body = h.host.querySelector<HTMLElement>('[data-mid="range-one"] .message-body');
  assert.ok(body, 'касание идёт в текст настоящего пузыря');
  return { body, restore };
}

async function hold(body: HTMLElement) {
  await act(async () => { touch(body, 'touchstart'); await h.delay(560); await h.flush(); });
}

async function cleanup(restore: () => void) {
  // Снять также подавитель нативного contextmenu, если сценарий завершился до отпускания пальца.
  await act(async () => { touch(window, 'touchend'); });
  if (h.root) h.unmount();
  await h.delay(450); // holdNextClick живёт ещё 400 мс после отпускания и не должен съесть клик следующего сценария.
  restore(); h.desktop();
}

function menuWithoutSelection() {
  assert.equal(document.querySelector('.ctx-menu') !== null, true, 'удержание открывает меню сообщения');
  assert.equal(h.host.querySelector('.sel-head') === null, true, 'меню не включает выбор само');
  const labels = buttons().map((b) => b.textContent?.trim());
  assert.equal(labels.includes('Выделить'), false, 'приложение не предлагает десктопное Выделить');
  assert.equal(labels.indexOf('Выбрать') >= 0 && labels.indexOf('Выбрать') < labels.indexOf('Удалить'), true,
    'Выбрать стоит перед Удалить');
}

async function chooseOne(component: typeof h.Pane, fallback = false) {
  const { body, restore } = await fixture(component);
  try {
    if (fallback) {
      const context = new Event('contextmenu', { bubbles: true, cancelable: true });
      Object.defineProperty(context, 'pointerType', { value: 'touch' });
      await act(async () => { body.dispatchEvent(context); await h.flush(); });
    } else {
      await hold(body);
      await act(async () => { touch(body, 'touchend'); await h.flush(); await h.delay(450); });
    }
    menuWithoutSelection();
    const choose = buttons().find((b) => b.textContent?.trim() === 'Выбрать');
    assert.ok(choose, 'пункт выбора есть у сообщения');
    await act(async () => { choose.click(); await h.flush(); await h.delay(220); });
    assert.equal(h.host.querySelector('.sel-count')?.textContent, 'Выбрано 1', 'пункт выбирает ровно одно сообщение');
    assert.equal(h.host.querySelectorAll('.message.picked').length, 1, 'выбран ровно один реальный пузырь');
    assert.equal(h.host.querySelector('[data-mid="range-one"]')?.classList.contains('picked'), true, 'выбран исходный пузырь');
    assert.equal(document.querySelector('.ctx-menu') === null, true, 'меню после выбора закрыто');
  } finally { await cleanup(restore); }
}

h.mutantTest('R161 долгое нажатие открывает меню, а Выбрать перед Удалить выбирает одно', async () => {
  await h.rejectMutant((source) => source.replace(
    'batchOn ? () => startMenuRange(m, row, photo, { file })',
    'batchOn ? () => startTouchRange(m)',
  ), (component) => chooseOne(component), 'удержание открывает меню сообщения');
});

it('R161 ровно 8px вверх и вниз и горизонтальная протяжка оставляют меню без выбора', async () => {
  for (const [x, y] of [[30, 128], [30, 112], [130, 120]]) {
    const { body, restore } = await fixture();
    try {
      await hold(body);
      let prevented = false;
      await act(async () => { prevented = touch(body, 'touchmove', x, y).defaultPrevented; await h.flush(); });
      assert.equal(prevented, true, 'меню удерживает прокрутку исходного пальца');
      menuWithoutSelection();
      await act(async () => { touch(body, 'touchend', x, y); await h.flush(); });
      menuWithoutSelection();
    } finally { await cleanup(restore); }
  }
});

type Listener = EventListenerOrEventListenerObject;
type Record = { type: string; listener: Listener; capture: boolean; passive: boolean; active: boolean };
function observeListeners() {
  const add = window.addEventListener;
  const remove = window.removeEventListener;
  const records: Record[] = [];
  const captureOf = (options?: boolean | AddEventListenerOptions | EventListenerOptions) => typeof options === 'boolean' ? options : !!options?.capture;
  window.addEventListener = function (this: Window, type: string, listener: Listener | null, options?: boolean | AddEventListenerOptions) {
    if (!listener) return;
    if (['touchmove', 'touchend', 'touchcancel'].includes(type)) records.push({ type, listener, capture: captureOf(options), passive: typeof options === 'object' && !!options.passive, active: true });
    return add.call(this, type, listener, options);
  } as typeof window.addEventListener;
  window.removeEventListener = function (this: Window, type: string, listener: Listener | null, options?: boolean | EventListenerOptions) {
    if (!listener) return;
    for (const record of records) if (record.type === type && record.listener === listener && record.capture === captureOf(options)) record.active = false;
    return remove.call(this, type, listener, options);
  } as typeof window.removeEventListener;
  return {
    menu(after = 0) {
      // Подавитель native-longpress не слушает move. Первая тройка capture — переход меню→диапазон;
      // пассивный touchmove самого ContextMenu ставится позднее, после React commit.
      const from = records.findIndex((r, index) => index >= after && r.type === 'touchmove' && !r.passive);
      assert.equal(from >= 0, true, 'удержание поставило оконный слушатель диапазона');
      const group = records.slice(from, from + 3);
      assert.equal(group.map((r) => r.type).join(','), 'touchmove,touchend,touchcancel', 'поставлена вся тройка жеста');
      assert.equal(group.every((r) => r.capture && r.active), true, 'тройка слушает окно в capture');
      return group;
    },
    get count() { return records.length; },
    restore() {
      for (const record of records) if (record.active) remove.call(window, record.type, record.listener, record.capture);
      window.addEventListener = add; window.removeEventListener = remove;
    },
  };
}

async function range(component: typeof h.Pane, delta = 9) {
  const { body, restore } = await fixture(component);
  const observed = observeListeners();
  try {
    await hold(body); menuWithoutSelection();
    const group = observed.menu();
    await act(async () => { touch(body, 'touchmove', 30, 120 + delta); await h.flush(); });
    assert.equal(group.every((r) => !r.active), true, 'переход снимает старую тройку меню');
    assert.equal(h.host.querySelector('.sel-count')?.textContent, 'Выбрано 1', '9px включает выбор исходного сообщения');
    await act(async () => { touch(body, 'touchmove', 30, 250); await h.flush(); await h.delay(220); });
    assert.equal(h.host.querySelector('.sel-count')?.textContent, 'Выбрано 3', 'тот же палец расширяет выбор до третьей строки');
    assert.equal(document.querySelector('.ctx-menu') === null, true, 'переход в диапазон убирает меню');
    await act(async () => { touch(body, 'touchmove', 30, 180); await h.flush(); });
    assert.equal(h.host.querySelector('.sel-count')?.textContent, 'Выбрано 2', 'возврат пальца сжимает диапазон');
    await act(async () => { touch(body, 'touchend', 30, 180); await h.flush(); });
    assert.equal(h.host.querySelector('.sel-count')?.textContent, 'Выбрано 2', 'отпускание сохраняет выбранный диапазон');
  } finally { await cleanup(restore); observed.restore(); }
}

it('R161 вертикальные 9px в обе стороны превращают меню в протяжку диапазона', async () => {
  await range(h.Pane, 9); await range(h.Pane, -9);
});

h.mutantTest('R161 переход в диапазон снимает оконные слушатели меню до продолжения пальцем', async () => {
  await h.rejectMutant((source) => source.replace('      off();\n      startTouchRange(m);', '      /* mutant: старая тройка осталась */\n      startTouchRange(m);'), (component) => range(component),
    'переход снимает старую тройку меню');
});

for (const ending of ['touchend', 'touchcancel'] as const) {
  it(`R161 ${ending} снимает тройку меню, оставляя меню и не начиная выбор следующим движением`, async () => {
    const { body, restore } = await fixture(); const observed = observeListeners();
    try {
      await hold(body); const group = observed.menu();
      await act(async () => { touch(body, ending); await h.flush(); });
      assert.equal(group.every((r) => !r.active), true, 'конец касания снимает всю тройку меню');
      await act(async () => { touch(body, 'touchmove', 30, 250); await h.flush(); });
      menuWithoutSelection();
    } finally { await cleanup(restore); observed.restore(); }
  });
}

h.mutantTest('R161 размонтирование до touchend снимает оконную тройку меню', async () => {
  await h.rejectMutant((source) => source.replace('  useEffect(() => () => menuRangeOff.current?.(), []);', '  /* mutant: тройка меню переживает ленту */'), async (component) => {
    const { body, restore } = await fixture(component); const observed = observeListeners();
    try {
      await hold(body); const group = observed.menu();
      h.unmount();
      assert.equal(group.every((r) => !r.active), true, 'размонтирование снимает всю тройку меню');
    } finally { await cleanup(restore); observed.restore(); }
  }, 'размонтирование снимает всю тройку меню');
});

it('R161 новое удержание снимает прежнюю тройку и открывает меню нового сообщения', async () => {
  const { body, restore } = await fixture(); const observed = observeListeners();
  try {
    await hold(body); const first = observed.menu();
    const before = observed.count;
    const second = h.host.querySelector<HTMLElement>('[data-mid="range-two"] .message-body');
    assert.ok(second, 'второй пузырь доступен для нового удержания');
    // Первое touchend могло потеряться: новый жест обязан сам убрать его оконные слушатели.
    await hold(second);
    assert.equal(first.every((r) => !r.active), true, 'новое удержание снимает прежнюю тройку');
    const next = observed.menu(before);
    assert.equal(next.every((r) => r.active), true, 'новое удержание ставит собственную тройку');
    menuWithoutSelection();
    await act(async () => { touch(second, 'touchend'); await h.flush(); await h.delay(450); });
    assert.equal(next.every((r) => !r.active), true, 'своё отпускание снимает новую тройку');
    const choose = buttons().find((b) => b.textContent?.trim() === 'Выбрать');
    assert.ok(choose, 'новое меню предлагает выбрать сообщение');
    await act(async () => { choose.click(); await h.flush(); });
    assert.equal(h.host.querySelector('[data-mid="range-two"]')?.classList.contains('picked'), true, 'новое меню принадлежит второму пузырю');
    assert.equal(h.host.querySelector('[data-mid="range-one"]')?.classList.contains('picked'), false, 'первое сообщение не выбрано');
  } finally { await cleanup(restore); observed.restore(); }
});

it('R161 чужой палец не двигает диапазон и не снимает тройку нашего касания', async () => {
  const { body, restore } = await fixture(); const observed = observeListeners();
  try {
    await hold(body); const group = observed.menu();
    let prevented = true;
    await act(async () => { prevented = touch(body, 'touchmove', 30, 250, 8).defaultPrevented; await h.flush(); });
    assert.equal(prevented, false, 'чужая протяжка не перехватывается слушателем меню');
    menuWithoutSelection();
    await act(async () => { touch(window, 'touchend', 30, 250, 8); await h.flush(); });
    assert.equal(group.every((r) => r.active), true, 'чужое отпускание не завершает наш жест');
    await act(async () => { touch(body, 'touchend'); await h.flush(); });
    assert.equal(group.every((r) => !r.active), true, 'своё отпускание завершает жест');
    menuWithoutSelection();
  } finally { await cleanup(restore); observed.restore(); }
});

h.mutantTest('R161 запасной touch contextmenu открывает меню, а не немедленный выбор', async () => {
  await h.rejectMutant((source) => source.replace('      if (at) openMsgMenuAt(m, at, photo, more);', '      if (batchOn) startSelection(m);\n      else if (at) openMsgMenuAt(m, at, photo, more);'),
    (component) => chooseOne(component, true), 'удержание открывает меню сообщения');
});

h.mutantTest('R161 ПК и браузер телефона показывают Выделить после Удалить без Выбрать', async () => {
  await h.rejectMutant((source) => source.replace('{batchOn && isMobile() && (', '{batchOn && ('), async (component) => {
    for (const coarse of [false, true]) {
      const { body, restore } = await fixture(component, false, coarse);
      try {
        // Узкая раскладка браузера не равна приложению Android: isMobile должен оставаться false.
        const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        if (coarse) Object.defineProperty(context, 'pointerType', { value: 'touch' });
        await act(async () => { body.dispatchEvent(context); await h.flush(); });
        const labels = buttons().map((b) => b.textContent?.trim());
        assert.equal(labels.includes('Выбрать'), false, 'вне приложения пункта Выбрать нет');
        assert.equal(labels.indexOf('Удалить') >= 0 && labels.indexOf('Выделить') > labels.indexOf('Удалить'), true,
          'десктопное Выделить стоит после Удалить');
        assert.equal(h.host.querySelector('.sel-head') === null, true, 'открытие меню не выбирает сообщение');
      } finally { await cleanup(restore); }
    }
  }, 'вне приложения пункта Выбрать нет');
});
