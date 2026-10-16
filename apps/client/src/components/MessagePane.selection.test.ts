import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { act } from 'react';
import { Simulate } from 'react-dom/test-utils';
import type { Message } from '@gusvoice/shared';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);

h.mutantTest('R114 подписи панели выделения и число в отдельных span сохраняют «Удалить 2»', async () => {
  // На узком телефоне CSS скрывает только счётчик; голый текст числа нельзя скрыть отдельно от подписи.
  await h.rejectMutant((source) => source.replace(
    '<span className="sel-bar-n">{` ${pickedList.length}`}</span>',
    '{` ${pickedList.length}`}',
  ), async (component) => {
    h.round12(); h.mobile(); const restore = h.pointerLayout(true, 360);
    try {
      await h.mount({ messages: [h.msg('r114-select-one'), h.msg('r114-select-two')], batch: {
        forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Собеседник', open: () => {},
      } }, component);
      const first = h.host.querySelector<HTMLElement>('[data-mid="r114-select-one"]');
      const second = h.host.querySelector<HTMLElement>('[data-mid="r114-select-two"]');
      assert.ok(first && second, 'две строки доступны для реального выделения');
      const context = new Event('contextmenu', { bubbles: true, cancelable: true });
      Object.defineProperty(context, 'pointerType', { value: 'touch' });
      await act(async () => { first.dispatchEvent(context); await h.flush(); });
      const choose = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.trim() === 'Выбрать');
      assert.ok(choose, 'касательное меню предлагает выбор сообщения');
      await act(async () => { choose.click(); await h.flush(); });
      assert.ok(h.host.querySelector('.sel-head'), 'пункт меню включает пачку');
      const reply = h.host.querySelector('.sel-bar-btn .sel-bar-label');
      assert.equal(reply?.textContent, 'Ответить', 'при одном выбранном подпись ответа обёрнута отдельно');
      await act(async () => { second.click(); await h.flush(); });
      assert.equal(h.host.querySelector('.sel-bar-btn .sel-bar-label')?.textContent, 'Переслать 2', 'для двух выбранных ответ исчезает');
      for (const [selector, caption] of [['.sel-bar-btn:not(.danger)', 'Переслать'], ['.sel-bar-btn.danger', 'Удалить']] as const) {
        const button = h.host.querySelector(selector);
        const label = button?.querySelector('span.sel-bar-label');
        assert.ok(button && label, `${caption}: настоящая панель содержит отдельную подпись`);
        assert.equal(button.textContent, `${caption} 2`, `${caption}: прежний текст кнопки сохраняется целиком`);
        const count = label.querySelector('span.sel-bar-n');
        assert.ok(count, 'число выбранных сообщений находится в отдельном span внутри подписи');
        assert.equal(count.textContent, ' 2', `${caption}: счётчик соответствует двум выбранным сообщениям`);
        assert.equal([...label.childNodes].filter((node) => node !== count).map((node) => node.textContent).join(''), caption,
          `${caption}: после скрытия счётчика останется только подпись, без голой цифры`);
      }
    } finally { if (h.root) h.unmount(); h.desktop(); restore(); }
  }, 'число выбранных сообщений находится в отдельном span внутри подписи');
});


async function checkSelectionKeyboard(component: typeof h.Pane, confirm = h.ConfirmHost) {
  h.round12(); h.desktop();
  const copied: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Собеседник', open: () => {} };
  try {
    await h.mountWithConfirm({ messages: [h.msg('key-one'), h.msg('key-two')], batch }, component, confirm);
    const enter = async () => {
      const row = h.host.querySelector<HTMLElement>('[data-mid="key-one"]');
      assert.ok(row, 'строка для выделения существует');
      await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
      const choice = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Выделить'));
      assert.ok(choice, 'контекстное меню предлагает пачечное выделение');
      await act(async () => { choice.click(); await h.flush(); });
    };
    await enter();
    await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="key-two"]')!.click(); await h.flush(); });
    const input = h.host.querySelector<HTMLTextAreaElement>('.composer-input');
    assert.ok(input, 'поле ввода служит отрицательной целью горячих клавиш');
    input.focus();
    for (const [key, code, ctrlKey] of [['c', 'KeyC', true], ['Delete', 'Delete', false]] as const) {
      const event = new KeyboardEvent('keydown', { key, code, ctrlKey, bubbles: true, cancelable: true });
      await act(async () => { input.dispatchEvent(event); await h.flush(); });
      assert.ok(!event.defaultPrevented, `${key} в поле остаётся действием поля, а не командой пачки`);
    }
    assert.ok(h.host.querySelector('.sel-head'), 'защищённые поля не снимают выделение');
    const overlay = document.createElement('div'); overlay.setAttribute('aria-modal', 'true'); document.body.append(overlay);
    const blocked = new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(blocked); await h.flush(); });
    assert.ok(!blocked.defaultPrevented && h.host.querySelector('.sel-head'), 'модальный слой владеет Delete и сохраняет лежащий под ним выбор');
    const blockedCopy = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(blockedCopy); await h.flush(); });
    assert.ok(!blockedCopy.defaultPrevented && Number(copied.length) === 0, 'модальный слой также сохраняет собственный Ctrl+C');
    overlay.remove();
    const row = h.host.querySelector<HTMLElement>('[data-mid="key-one"]'); assert.ok(row, 'выбранная строка готова к меню');
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    assert.ok(document.querySelector('.ctx-menu'), 'мышиный правый клик в пачке открывает меню выделения');
    assert.ok([...document.querySelectorAll('.ctx-menu button')].some((b) => b.textContent?.includes('Скопировать выбранное')), 'выбранная строка показывает команды пачки');
    h.unmount();
    h.mobile(); const coarse = h.pointerLayout(true, 390);
    try {
      await h.mountWithConfirm({ messages: [h.msg('key-touch')], batch }, component, confirm);
      const touchRow = h.host.querySelector<HTMLElement>('[data-mid="key-touch"]'); assert.ok(touchRow, 'телефонная строка смонтирована');
      const context = new Event('contextmenu', { bubbles: true, cancelable: true }); Object.defineProperty(context, 'pointerType', { value: 'touch' });
      await act(async () => { touchRow.dispatchEvent(context); await h.flush(); });
      const choose = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.trim() === 'Выбрать');
      assert.ok(choose, 'touch contextmenu сначала открывает меню с выбором');
      await act(async () => { choose.click(); await h.flush(); await h.delay(220); });
      assert.ok(h.host.querySelector('.sel-head'), 'Выбрать включает выбор одного сообщения');
      const secondContext = new Event('contextmenu', { bubbles: true, cancelable: true }); Object.defineProperty(secondContext, 'pointerType', { value: 'touch' });
      await act(async () => { touchRow.dispatchEvent(secondContext); await h.flush(); });
      assert.ok(!document.querySelector('.ctx-menu'), 'touch contextmenu внутри выделения не открывает мышиное меню');
      assert.ok(h.host.querySelector('.sel-head'), 'touch contextmenu не теряет текущую пачку');
      const copy = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true });
      await act(async () => { window.dispatchEvent(copy); await h.flush(); });
      assert.ok(copy.defaultPrevented && Number(copied.length) === 1 && copied[0]?.includes('key-touch'), 'Ctrl+C вне поля копирует выбранное и завершает пачку');
    } finally { coarse(); h.desktop(); }
  } finally { if (h.root) h.unmount(); if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard); else Reflect.deleteProperty(navigator, 'clipboard'); h.desktop(); }
}

h.mutantTest('мутант пропускает горячие клавиши пачки сквозь верхний модальный слой', async () => {
  // Если слой не ограждает обработчик, Delete под подтверждением откроет второй диалог и сломает порядок Escape.
  await h.rejectMutant((source) => {
    const changed = source.replace('      if (document.querySelector(`[aria-modal="true"], ${TOP_LAYERS}`)) return;', '      /* mutant: слой больше не блокирует горячую клавишу */');
    assert.notEqual(changed, source, 'найден общий гейт верхнего модального слоя');
    return changed;
  }, checkSelectionKeyboard);
});

it('выделение копируется и удаляется с клавиатуры, но поле, подтверждение и касательный ПКМ сохраняют хозяина', async () => {
  // Горячие клавиши пачки не должны воровать Ctrl+C у редактора или Delete у верхнего слоя; мышиное меню не распространяется на touch.
  const copied: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  try {
    await checkSelectionKeyboard(h.Pane);
    h.desktop(); h.round12();
    const deletes: [string[], string][] = [];
    const batch = { forward: async () => {}, deleteMany: async (ids: string[], scope: 'me' | 'both') => { deletes.push([ids, scope]); }, peerName: () => 'Собеседник', open: () => {} };
    await h.mountWithConfirm({ messages: [h.msg('delete-key-one'), h.msg('delete-key-two')], batch });
    const row = h.host.querySelector<HTMLElement>('[data-mid="delete-key-one"]'); assert.ok(row, 'строка для Delete существует');
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const select = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Выделить'));
    assert.ok(select, 'вход в выделение доступен с контекстного меню'); await act(async () => { select.click(); await h.flush(); });
    await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="delete-key-two"]')!.click(); await h.flush(); });
    const remove = new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(remove); await h.flush(); });
    assert.ok(remove.defaultPrevented, 'Delete в активной пачке перехвачен как команда удаления');
    assert.ok(document.querySelector('#confirm-title')?.textContent?.includes('Удалить 2'), 'удаление пачки требует подтверждения до API');
    const behind = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(behind); await h.flush(); });
    assert.ok(!behind.defaultPrevented && copied.length === 0, 'открытое подтверждение сохраняет клавиатуру для верхнего слоя');
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('.confirm-actions button')].find((b) => b.textContent?.includes('Отмена'));
    assert.ok(cancel, 'диалог предлагает явно отказаться от удаления'); await act(async () => { cancel.click(); await h.flush(); });
    assert.deepEqual(deletes, [], 'отказ не вызывает API удаления');
  } finally { if (h.root) h.unmount(); if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard); else Reflect.deleteProperty(navigator, 'clipboard'); }
});

async function checkReplyStripJump(component: typeof h.Pane) {
  h.round12(); h.desktop();
  const jumps: string[] = [];
  const feedWindow = { hasOlder: false, hasNewer: false, unreadBelow: 0, loadNewer: async () => false, jumpLatest: async () => {}, jumpTo: async (id: string) => { jumps.push(id); return true; }, place: null, onPlace: () => {}, readKey: null };
  await h.mount({ messages: [h.msg('reply-jump-target'), h.msg('reply-jump-current')], feedWindow });
  const list = h.host.querySelector<HTMLElement>('.messages');
  assert.ok(list, 'лента с quoted row доступна для геометрии перехода');
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 600 });
  list.getBoundingClientRect = () => new DOMRect(0, 40, 400, 600);
  for (const [index, id] of ['reply-jump-target', 'reply-jump-current'].entries()) {
    const messageRow = h.host.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    assert.ok(messageRow, `геометрия строки ${id} доступна`);
    messageRow.getBoundingClientRect = () => new DOMRect(0, 50 + index * 70, 360, 50);
  }
  const row = h.host.querySelector<HTMLElement>('[data-mid="reply-jump-current"]'); assert.ok(row, 'ответное сообщение доступно');
  await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const reply = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Ответить'));
  assert.ok(reply, 'ответная полоса создаётся обычным действием сообщения'); await act(async () => { reply.click(); await h.flush(); });
  const strip = h.host.querySelector<HTMLElement>('.reply-strip'); assert.ok(strip, 'полоса ответа открыта над полем');
  await act(async () => { strip.click(); await h.flush(); });
  assert.deepEqual(jumps, [], 'загруженную цитату прокручивает внутренняя лента без запроса новой страницы');
  assert.ok(h.host.querySelector('.jump-back'), 'переход с загруженной строки записал место возврата');
  const close = h.host.querySelector<HTMLButtonElement>('.reply-strip .rs-close'); assert.ok(close, 'крестик полосы — отдельная кнопка');
  jumps.length = 0;
  await act(async () => { close.click(); await h.flush(); });
  assert.deepEqual(jumps, [], 'крестик снимает ответ и не вызывает переход к цитате');
  h.unmount();
}

it('клик по полосе ответа прыгает к цитате, а крестик только снимает ответ', async () => {
  // Проверяет различие между кликом по содержимому цитаты и отдельным действием удаления ответа.
  const source = readFileSync(fileURLToPath(new URL('./MessagePane.tsx', import.meta.url)), 'utf8');
  assert.ok(source.includes('    void jumpToMessage(targetId);'), 'переход из reply-strip привязан к jumpToMessage');
  await checkReplyStripJump(h.Pane);
});

h.mutantTest('мутант не возвращает фокус в правку после отказа закрыть её через Esc', async () => {
  // «Продолжить правку» должно вернуть человека в поле, иначе следующий ввод потеряется на пустом слое диалога.
  await h.rejectMutant((source) => {
    const changed = source.replace('else requestAnimationFrame(() => inputRef.current?.focus());', '/* mutant: отказ оставляет фокус в диалоге */');
    assert.notEqual(changed, source, 'найдено возвращение фокуса после отказа');
    return changed;
  }, async (component, confirm = h.ConfirmHost) => {
    h.round12(); h.desktop();
    await h.mountWithConfirm({ messages: [h.msg('esc-edit')] }, component, confirm);
    h.host.classList.add('content');
    const row = h.host.querySelector<HTMLElement>('[data-mid="esc-edit"]'); assert.ok(row, 'сообщение для правки существует');
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const edit = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Изменить'));
    assert.ok(edit, 'своё сообщение можно открыть в правке'); await act(async () => { edit.click(); await h.flush(); });
    const field = h.host.querySelector<HTMLTextAreaElement>('.composer textarea'); assert.ok(field, 'поле правки смонтировано');
    assert.ok(Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set, 'textarea поддерживает набор текста');
    field.focus();
    act(() => { Simulate.change(field, { target: { value: 'изменённый текст' } as unknown as EventTarget }); });
    await h.flush();
    assert.equal(field.value, 'изменённый текст', 'изменение действительно попало в controlled поле правки');
    field.focus();
    await h.delay(200); // Портал закрытого меню ещё живёт до конца exit-анимации и законно перехватывает Esc.
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await h.flush(); });
    assert.ok(document.querySelector('#confirm-title')?.textContent?.includes('Отменить изменения'), 'изменённая правка спрашивает подтверждение');
    const resume = [...document.querySelectorAll<HTMLButtonElement>('.confirm-actions button')].find((b) => b.textContent?.includes('Продолжить'));
    assert.ok(resume, 'диалог даёт продолжить правку'); act(() => { resume.click(); });
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); await h.flush(); });
    await h.waitForFocus(field);
    assert.ok(document.activeElement === field, 'после отказа фокус возвращён в поле правки');
  }, 'после отказа фокус возвращён в поле правки');
});

it('Esc в изменённой правке спрашивает и отказ возвращает фокус в поле', async () => {
  // Опасный выход не должен терять набранный текст; отмена диалога должна позволять немедленно продолжить ввод.
  h.round12(); h.desktop();
  await h.mountWithConfirm({ messages: [h.msg('esc-edit-positive')] });
  h.host.classList.add('content');
  const row = h.host.querySelector<HTMLElement>('[data-mid="esc-edit-positive"]'); assert.ok(row, 'сообщение для правки существует');
  await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const edit = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Изменить'));
  assert.ok(edit, 'своё сообщение имеет действие правки'); await act(async () => { edit.click(); await h.flush(); });
  const field = h.host.querySelector<HTMLTextAreaElement>('.composer textarea'); assert.ok(field, 'поле правки открыто');
  assert.ok(Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set, 'textarea поддерживает изменение текста');
  field.focus();
  act(() => { Simulate.change(field, { target: { value: 'новый вариант' } as unknown as EventTarget }); });
  await h.flush();
  assert.equal(field.value, 'новый вариант', 'изменение действительно попало в controlled поле правки');
  field.focus(); await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await h.flush(); });
  const editTitle = document.querySelector('#confirm-title')?.textContent;
  assert.ok(editTitle?.includes('Отменить изменения'), `Esc не теряет изменённую правку без подтверждения (заголовок: ${editTitle ?? 'диалог не открыт'}, поле: ${field.value})`);
  const resume = [...document.querySelectorAll<HTMLButtonElement>('.confirm-actions button')].find((b) => b.textContent?.includes('Продолжить'));
  assert.ok(resume, 'предупреждение предлагает вернуться в правку'); act(() => { resume.click(); });
  await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); await h.flush(); });
  await h.waitForFocus(field);
  assert.ok(document.activeElement === field, 'после отказа пользователь продолжает ввод в прежнем поле');
});

it('телефонный двойной тап ставит и снимает реакцию, одиночный ждёт окно, программный click не ждёт', async () => {
  // Только палец имеет двойной тап; одиночный не должен открывать меню до истечения окна, а доступный click — ждать зря.
  h.round12(); const restore = h.pointerLayout(true, 390); h.mobile();
  const operations: string[] = [];
  const makeTap = async (body: HTMLElement) => {
    await act(async () => { h.touch(body, 'touchstart', 25, 25); h.touch(body, 'touchend', 25, 25); body.click(); await h.flush(); });
  };
  try {
    const own = { ...h.msg('double-own'), reactions: [{ emoji: '👍', count: 1, me: true }] } as Message;
    await h.mount({ messages: [own], onReact: (id: string, emoji: string, op: string) => { operations.push(`${id}:${emoji}:${op}`); } });
    const body = h.host.querySelector<HTMLElement>('[data-mid="double-own"] .message-body'); assert.ok(body, 'пальцем доступен собственный пузырь');
    await makeTap(body);
    assert.ok(!document.querySelector('.ctx-menu') && operations.length === 0, 'одиночный палец ждёт окно двойного тапа');
    await makeTap(body);
    assert.deepEqual(operations, ['double-own:👍:remove'], 'вторая пара снимает уже мою быструю реакцию');
    h.unmount();
    await h.mount({ messages: [h.msg('double-add')], onReact: (id: string, emoji: string, op: string) => { operations.push(`${id}:${emoji}:${op}`); } });
    const add = h.host.querySelector<HTMLElement>('[data-mid="double-add"] .message-body'); assert.ok(add, 'пузырь без 👍 доступен');
    await makeTap(add); await makeTap(add);
    assert.equal(operations.at(-1), 'double-add:👍:add', 'двойной тап добавляет быструю реакцию');
    h.unmount();
    await h.mount({ messages: [h.msg('single-finger')], onReact: () => {} });
    const single = h.host.querySelector<HTMLElement>('[data-mid="single-finger"] .message-body'); assert.ok(single, 'пузырь одиночного тапа доступен');
    await makeTap(single);
    assert.ok(!document.querySelector('.ctx-menu'), 'до окончания 300 мс меню не появляется');
    await act(async () => { await h.delay(340); await h.flush(); });
    assert.ok(document.querySelector('.ctx-menu'), 'если второго пальца нет, таймер открывает меню');
    h.unmount();
    await h.mount({ messages: [h.msg('synthetic-click')], onReact: () => {} });
    const synthetic = h.host.querySelector<HTMLElement>('[data-mid="synthetic-click"] .message-body'); assert.ok(synthetic, 'доступная цель click без touchstart');
    await act(async () => { synthetic.click(); await h.flush(); });
    assert.ok(document.querySelector('.ctx-menu'), 'программный или assistive click без пальца открывает меню сразу');
    h.unmount(); localStorage.setItem('gv_dbl_action', 'none');
    await h.mount({ messages: [h.msg('none-finger')], onReact: () => { assert.fail('none не ставит реакцию'); } });
    await makeTap(h.host.querySelector<HTMLElement>('[data-mid="none-finger"] .message-body')!);
    assert.ok(document.querySelector('.ctx-menu'), 'режим none открывает меню пальца сразу, без окна второго тапа');
  } finally { if (h.root) h.unmount(); h.desktop(); restore(); }
});

it('на ПК detail=2 реагирует мимо текста, текст не перехватывает двойной клик, а чип показывает авторов без onReact', async () => {
  // Двойной клик — только для мышиного места вне слова; список reactors открывается независимо от права самому реагировать.
  h.round12(); h.desktop(); const restore = h.pointerLayout(false, 1200);
  const operations: string[] = [];
  const oldElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
  const oldCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
  const oldRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  try {
    const reaction = { emoji: '🔥', count: 2, me: false, reactors: [{ userId: 'peer-a', at: new Date(h.now).toISOString() }, { userId: 'me', at: new Date(h.now).toISOString() }] };
    localStorage.setItem('gv_quick_reaction', '🔥');
    localStorage.setItem('gv_dbl_action', 'react');
    const message = { ...h.msg('desktop-double'), content: 'обычный текст', reactions: [reaction] } as Message;
    await h.mount({ messages: [message], onReact: (id: string, emoji: string, op: string) => { operations.push(`${id}:${emoji}:${op}`); }, reactorOf: (id: string) => ({ name: id === 'me' ? 'Я' : 'Аня', avatarUrl: null }) });
    const body = h.host.querySelector<HTMLElement>('[data-mid="desktop-double"] .message-body'); assert.ok(body, 'текст доступен для двойного клика');
    const textNode = body.firstChild;
    assert.ok(textNode && textNode.nodeType === Node.TEXT_NODE, 'пузырь содержит настоящий текстовый узел');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => body });
    Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: textNode, offset: 1 }) });
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [new DOMRect(90, 90, 20, 20)] });
    const dbl = (target: Element, type: string, detail: number) => { const e = new MouseEvent(type, { bubbles: true, cancelable: true, detail, button: 0, clientX: 100, clientY: 100 }); target.dispatchEvent(e); return e; };
    await act(async () => { dbl(body, 'mousedown', 2); dbl(body, 'dblclick', 2); await h.flush(); });
    assert.deepEqual(operations, [], 'двойной клик по буквам оставляет браузеру выделение текста');
    const row = h.host.querySelector<HTMLElement>('[data-mid="desktop-double"] .message-main'); assert.ok(row, 'пустая поверхность пузыря доступна отдельно от текста');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => row });
    Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => null });
    await act(async () => { dbl(row, 'mousedown', 2); dbl(row, 'dblclick', 2); await h.flush(); });
    assert.deepEqual(operations, ['desktop-double:🔥:add'], 'мышиный двойной клик запускает выбранную быструю реакцию');
    h.unmount(); localStorage.setItem('gv_dbl_action', 'reply');
    await h.mount({ messages: [h.msg('double-reply')], onReact: () => { assert.fail('reply не ставит реакцию'); } });
    const replyRow = h.host.querySelector<HTMLElement>('[data-mid="double-reply"] .message-main')!;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => replyRow });
    await act(async () => { dbl(replyRow, 'mousedown', 2); dbl(replyRow, 'dblclick', 2); await h.flush(); });
    assert.ok(h.host.querySelector('.reply-strip'), 'режим reply создаёт ответ, а не реакцию');
    localStorage.removeItem('gv_dbl_action');
    h.unmount();
    await h.mount({ messages: [{ ...message, id: 'reactors-only', reactions: [reaction] }], reactorOf: (id: string) => ({ name: id === 'me' ? 'Я' : 'Аня', avatarUrl: null }) });
    const chip = h.host.querySelector<HTMLButtonElement>('[data-mid="reactors-only"] .reaction'); assert.ok(chip, 'чип с реакцией доступен даже без обработчика onReact');
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => { chip.dispatchEvent(context); await h.flush(); });
    assert.ok(context.defaultPrevented, 'контекст чипа передан интерфейсу, а не браузеру');
    assert.ok(document.querySelector('.who-head')?.textContent?.includes('2'), 'контекст чипа открывает список авторов реакции');
    const reactorRows = [...document.querySelectorAll('.who-row')].map((x) => x.textContent ?? '');
    assert.ok(reactorRows.some((x) => x.includes('Аня')) && reactorRows.some((x) => x.includes('Я') && x.includes('(вы)')),
      'список показывает обоих участников и помечает собственную реакцию');
  } finally {
    if (h.root) h.unmount();
    if (oldElementFromPoint) Object.defineProperty(document, 'elementFromPoint', oldElementFromPoint); else Reflect.deleteProperty(document, 'elementFromPoint');
    if (oldCaret) Object.defineProperty(document, 'caretPositionFromPoint', oldCaret); else Reflect.deleteProperty(document, 'caretPositionFromPoint');
    if (oldRects) Object.defineProperty(Range.prototype, 'getClientRects', oldRects); else Reflect.deleteProperty(Range.prototype, 'getClientRects');
    restore();
  }
});

it('касательный contextmenu у автора реакции не ставит и не снимает реакцию', async () => {
  // WebView может послать click после native long-press по чипу; окно «кто поставил» должно поглотить этот click.
  h.round12(); h.mobile(); const restore = h.pointerLayout(true, 390);
  const calls: string[] = [];
  try {
    const reaction = { emoji: '🔥', count: 1, me: true, reactors: [{ userId: 'me', at: new Date(h.now).toISOString() }] };
    await h.mount({ messages: [{ ...h.msg('touch-who'), reactions: [reaction] }], onReact: (id: string, emoji: string, op: string) => { calls.push(`${id}:${emoji}:${op}`); } });
    const chip = h.host.querySelector<HTMLButtonElement>('[data-mid="touch-who"] .reaction'); assert.ok(chip, 'чип моей реакции доступен для native contextmenu');
    const context = new Event('contextmenu', { bubbles: true, cancelable: true }); Object.defineProperty(context, 'pointerType', { value: 'touch' });
    await act(async () => { h.touch(chip, 'touchstart', 25, 25); chip.dispatchEvent(context); await h.flush(); });
    assert.ok(document.querySelector('.who-head'), 'длинное касание открывает список авторов реакции');
    assert.deepEqual(calls, [], 'сам жест не вызывает add/remove');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { chip.dispatchEvent(click); await h.flush(); });
    assert.ok(click.defaultPrevented, 'синтетический click той же руки подавлен');
    assert.deepEqual(calls, [], 'клик после who-contextmenu не снимает собственную реакцию');
  } finally { if (h.root) h.unmount(); h.desktop(); restore(); }
});

async function checkCancelSendingMenus(component: typeof h.Pane) {
  const calls: string[] = [];
  const sending = { ...h.out('uploading body'), key: 'sending-key', status: 'sending' as const, createdAt: h.now };
  const outbox = { items: [sending], enqueue: () => {}, retry: () => {}, discard: (key: string) => { calls.push(key); } };
  h.round12(); h.desktop(); const wide = h.pointerLayout(false, 1200);
  await h.mount({ outbox }, component);
  const row = h.host.querySelector<HTMLElement>('.message.outgoing'); assert.ok(row, 'строка загрузки имеет пузырь');
  await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const action = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Отменить отправку'));
  assert.ok(action, 'обычное меню ПКМ у sending содержит отмену');
  await act(async () => { action.click(); await h.flush(); });
  assert.deepEqual(calls, ['sending-key'], 'первое меню отменяет нужный ключ отправки');
  h.unmount(); calls.length = 0;
  const restore = h.pointerLayout(true, 390); h.mobile();
  try {
    await h.mount({ outbox }, component);
    const phoneRow = h.host.querySelector<HTMLElement>('.message.outgoing'); assert.ok(phoneRow, 'телефонная строка отправки доступна');
    await act(async () => { h.touch(phoneRow, 'touchstart', 20, 20); await h.delay(510); h.touch(phoneRow, 'touchend', 20, 20); await h.flush(); });
    await act(async () => { await h.delay(450); });
    assert.equal(document.querySelector('.sheet') === null, true, 'удержание не возвращает старый outSheet');
    assert.ok(document.querySelector('.ctx-stack.anchored'), 'меню отправки закреплено у пузыря');
    const bubbleAction = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Отменить отправку'));
    assert.ok(bubbleAction, 'меню пузыря телефона содержит отмену');
    await act(async () => { bubbleAction.click(); await h.flush(); });
    assert.deepEqual(calls, ['sending-key'], 'меню телефона отменяет нужный ключ ровно один раз');
  } finally { if (h.root) h.unmount(); h.desktop(); restore(); wide(); }
}

h.mutantTest('мутант оставляет отмену отправки только в части меню', async () => {
  // ПК остаётся рабочим: сценарий обязан дойти до телефона и обнаружить потерю именно его команды.
  await h.rejectMutant((source) => {
    const at = source.indexOf('{outMenu?.bubble &&');
    assert.ok(at >= 0, 'найдена живая ветка меню у пузыря');
    const tail = source.slice(at);
    const changed = tail.replace('cancelSending(o.key);', '/* mutant: отправка остаётся живой */');
    assert.notEqual(changed, tail, 'убрана команда только телефонного меню');
    return source.slice(0, at) + changed;
  }, checkCancelSendingMenus, 'меню телефона отменяет нужный ключ ровно один раз');
});

it('«Отменить отправку» доступно в широком меню и phone bubble menu', async () => {
  // Пользователь должен остановить upload одинаковым действием из ПКМ и меню пузыря, не повторив отправку.
  await checkCancelSendingMenus(h.Pane);
});
