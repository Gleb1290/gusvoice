import { it as runTest } from 'node:test';
import { counterfact, mutantsEnabled } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createElement, act } from 'react';
import { Simulate } from 'react-dom/test-utils';
import type { ViteDevServer } from 'vite';
import type { Message } from '@gusvoice/shared';
import { sentAtLabel } from '../messagePaneRules';
import { TYPING_SEND_MS } from '../typing';
import { setupHarness, type Props } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);

// Все регистрации, включая одиночный --test-name-pattern, имеют одинаковую уборку realm.
function selectionEnvironment(scenario: () => unknown) {
  return async () => {
    const storage = Object.keys(localStorage).map(key => [key, localStorage.getItem(key)!] as const);
    const overrides = propertyOverrides();
    for (const [target, keys] of [
      [window, ['matchMedia', 'innerWidth', 'setInterval', 'clearInterval', '__TAURI_INTERNALS__']],
      [navigator, ['userAgent', 'clipboard']], [Date, ['now']],
      [document, ['elementFromPoint', 'caretPositionFromPoint']],
      [Range.prototype, ['getClientRects']], [HTMLElement.prototype, ['offsetWidth']],
      ...[HTMLMediaElement.prototype, HTMLAudioElement.prototype, HTMLVideoElement.prototype].map(target => [target, ['play', 'pause', 'load']] as const),
    ] as const) {
      for (const key of keys) overrides.save(target, key);
    }
    try { await scenario(); }
    finally {
      try { if (h.root) h.unmount(); }
      finally {
        try { const reset = h.resetStore; h.resetStore = undefined; reset?.(); }
        finally {
          overrides.restore(); localStorage.clear();
          for (const [key, value] of storage) localStorage.setItem(key, value);
        }
      }
    }
  };
}
function it(name: string, scenario: () => unknown) { return runTest(name, selectionEnvironment(scenario)); }
function mutantTest(name: string, scenario: () => Promise<void>) { return h.mutantTest(name, selectionEnvironment(scenario)); }
function textSelMutantTest(name: string, scenario: () => unknown) { return h.textSelMutantTest(name, selectionEnvironment(scenario)); }

// Два реальных эмодзи вместо тысяч DOM-ячеек; каталог восстанавливается после unmount.
async function dockEmojiFixture(runtime: ViteDevServer) {
  const { loadEmojiIndex } = await runtime.ssrLoadModule('/src/emojiIndex.ts') as typeof import('../emojiIndex');
  const index = await loadEmojiIndex();
  const all = index.all, byGroup = index.byGroup;
  const tiny = all.filter(emoji => emoji.emoji === '😀' || emoji.emoji === '👍');
  assert.equal(tiny.length, 2, 'fixture использует две реальные записи каталога');
  index.all = tiny;
  index.byGroup = byGroup.map(group => group.filter(emoji => index.all.includes(emoji)));
  return () => { index.all = all; index.byGroup = byGroup; };
}

// Перенесено из MessagePane.selection.test.ts: матрицы и утверждения сохранены.


mutantTest('R114 подписи панели выделения и число в отдельных span сохраняют «Удалить 2»', async () => {
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
    try {
    const blocked = new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(blocked); await h.flush(); });
    assert.ok(!blocked.defaultPrevented && h.host.querySelector('.sel-head'), 'модальный слой владеет Delete и сохраняет лежащий под ним выбор');
    const blockedCopy = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(blockedCopy); await h.flush(); });
    assert.ok(!blockedCopy.defaultPrevented && Number(copied.length) === 0, 'модальный слой также сохраняет собственный Ctrl+C');
    } finally { overlay.remove(); }
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
    } finally { try { if (h.root) h.unmount(); } finally { coarse(); h.desktop(); } }
  } finally { if (h.root) h.unmount(); if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard); else Reflect.deleteProperty(navigator, 'clipboard'); h.desktop(); }
}

mutantTest('мутант пропускает горячие клавиши пачки сквозь верхний модальный слой', async () => {
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
  const geometry = propertyOverrides();
  try {
  await h.mount({ messages: [h.msg('reply-jump-target'), h.msg('reply-jump-current')], feedWindow }, component);
  const list = h.host.querySelector<HTMLElement>('.messages');
  assert.ok(list, 'лента с quoted row доступна для геометрии перехода');
  geometry.set(list, 'clientHeight', { value: 600 });
  geometry.set(list, 'getBoundingClientRect', { value: () => new DOMRect(0, 40, 400, 600) });
  for (const [index, id] of ['reply-jump-target', 'reply-jump-current'].entries()) {
    const messageRow = h.host.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    assert.ok(messageRow, `геометрия строки ${id} доступна`);
    geometry.set(messageRow, 'getBoundingClientRect', { value: () => new DOMRect(0, 50 + index * 70, 360, 50) });
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
  } finally { try { if (h.root) h.unmount(); } finally { geometry.restore(); } }
}

it('клик по полосе ответа прыгает к цитате, а крестик только снимает ответ', async () => {
  // Проверяет различие между кликом по содержимому цитаты и отдельным действием удаления ответа.
  const source = readFileSync(fileURLToPath(new URL('./MessagePane.tsx', import.meta.url)), 'utf8');
  assert.ok(source.includes('    void jumpToMessage(targetId);'), 'переход из reply-strip привязан к jumpToMessage');
  await checkReplyStripJump(h.Pane);
});

mutantTest('мутант не возвращает фокус в правку после отказа закрыть её через Esc', async () => {
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

mutantTest('мутант оставляет отмену отправки только в части меню', async () => {
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


// Перенесено из MessagePane.textSelection.test.ts: матрицы и утверждения сохранены.



function checkTextNodesSkip() {
  const body = document.createElement('div'); body.className = 'message-body';
  body.innerHTML = 'до<span class="bub-meta">время</span><span class="ts">сегодня</span><span class="edited">изм.</span>' +
    '<span class="spoiler">тайна</span><span class="spoiler open">открыто</span>после';
  document.body.append(body);
  try {
    assert.deepEqual(h.textNodes(body).map((node) => node.data), ['до', 'открыто', 'после'],
      'текстовые узлы не включают время, отметку правки и закрытый спойлер, но открытый читаем');
  } finally { body.remove(); }
}

// Если закрытый spoiler попадёт в склеенный текст, слово сдвинет offsets и можно скопировать скрытый секрет.
textSelMutantTest('мутант включает текст закрытого спойлера', checkTextNodesSkip);

function checkWordSelGeometry() {
  const surface = h.textSurface('hello world');
  const restore = h.mockTextRangeRects(surface.node);
  try {
    const probe = document.createRange(); probe.selectNodeContents(surface.node);
    assert.equal(probe.getBoundingClientRect().bottom, 138, 'fixture контролирует нижний край символа для измерения 8 px');
    const middle = h.wordSelAt(surface.body, 65, 125); assert.ok(middle, 'точка в слове создаёт диапазон');
    assert.ok(middle.body === surface.body, 'диапазон остаётся привязан к исходному телу сообщения');
    assert.equal(middle.start, 0, 'слово начинается с первой буквы'); assert.equal(middle.end, 5, 'слово выделяется целиком');
    const space = h.wordSelAt(surface.body, 75, 125); assert.ok(space, 'касание пробела примыкает к слову');
    assert.equal(space.start, 0, 'пробел выбирает слово слева'); assert.equal(space.end, 5, 'пробел не захватывает следующее слово');
    const next = h.wordSelAt(surface.body, 125, 125); assert.ok(next, 'точка над следующим словом создаёт диапазон');
    assert.equal(next.start, 6, 'второе слово начинается после пробела'); assert.equal(next.end, 11, 'второе слово выделяется целиком');
    assert.ok(!h.wordSelAt(surface.body, 11, 125), 'точка дальше 8 px по горизонтали не считается текстом');
    assert.ok(!h.wordSelAt(surface.body, 25, 147), 'точка дальше 8 px по вертикали не считается текстом');
  } finally { restore(); surface.feed.remove(); }
}

// Расширенный порог превращает промах по пустому месту рядом с пузырём в случайный выбор текста.
textSelMutantTest('мутант расширяет промах выбора слова до 80 пикселей', checkWordSelGeometry);
it('удержание рядом со словом выбирает слово, но за пределом восьми пикселей уже не текст', checkWordSelGeometry);

it('панель выделения копирует точный срез, выбирает весь текст и закрывается по Escape', async () => {
  // Это собственное выделение, а не DOM Selection: панель должна копировать именно срез и уметь выбрать пробелы по краям.
  const surface = h.textSurface(); const restore = h.mockTextRangeRects(surface.node);
  let selection: import('./TextSelection').TextSel = { body: surface.body, start: 2, end: 7 };
  const changes: typeof selection[] = []; const copied: string[] = []; let closed = 0;
  const props = () => ({ sel: selection, onChange: (next: typeof selection) => {
    changes.push(next); selection = next;
    act(() => { h.root!.render(createElement(h.TextSelLayer, props())); });
  }, onClose: () => { closed++; }, onCopy: (text: string) => { copied.push(text); } });
  try {
    await h.mountTextSelLayer(props());
    const selectAll = [...document.querySelectorAll<HTMLButtonElement>('.tsel-bar button')].find((b) => b.textContent === 'Выделить всё');
    assert.ok(selectAll, 'частичное выделение предлагает действие «Выделить всё»');
    await act(async () => { selectAll.click(); await h.flush(); });
    assert.equal(changes.at(-1)?.start, 2, 'выделение всего текста обходит только пробелы слева');
    assert.equal(changes.at(-1)?.end, 13, 'выделение всего текста обходит только пробелы справа');
    assert.ok(![...document.querySelectorAll('.tsel-bar button')].some((b) => b.textContent === 'Выделить всё'),
      'полностью выделенный текст больше не предлагает повторить то же действие');
    const copy = [...document.querySelectorAll<HTMLButtonElement>('.tsel-bar button')].find((b) => b.textContent === 'Копировать');
    assert.ok(copy, 'панель копирует текущее выделение');
    await act(async () => { copy.click(); await h.flush(); });
    assert.deepEqual(copied, ['hello world'], 'onCopy получает ровно выделенный срез без внешних пробелов');
    assert.equal(closed, 1, 'копирование закрывает панель выделения');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await h.flush(); });
    assert.equal(closed, 2, 'Escape тоже снимает выделение');
  } finally { if (h.root) h.unmount(); restore(); surface.feed.remove(); }
});

async function checkTextSelTapStopsAtLayer() {
  const surface = h.textSurface('слово рядом'); const restore = h.mockTextRangeRects(surface.node);
  let closed = 0; let reachedMessage = 0;
  const reached = () => { reachedMessage++; };
  surface.body.addEventListener('touchstart', reached);
  try {
    await h.mountTextSelLayer({ sel: { body: surface.body, start: 0, end: 5 }, onChange: () => {}, onClose: () => { closed++; }, onCopy: () => {} });
    const start = h.touch(surface.body, 'touchstart', 40, 125);
    assert.ok(start.defaultPrevented === false, 'слой не отменяет начало жеста и оставляет прокрутку доступной');
    assert.equal(reachedMessage, 0, 'захваченное начало касания не доходит до обработчика строки');
    h.touch(surface.body, 'touchend', 40, 125);
    assert.equal(closed, 1, 'тап без сдвига в ленте снимает текстовое выделение');
    await act(async () => { await h.delay(510); });
    if (h.root) h.unmount();
    closed = 0;
    await h.mountTextSelLayer({ sel: { body: surface.body, start: 0, end: 5 }, onChange: () => {}, onClose: () => { closed++; }, onCopy: () => {} });
    h.touch(surface.body, 'touchstart', 40, 125); h.touch(surface.body, 'touchmove', 51, 125); h.touch(surface.body, 'touchend', 51, 125);
    assert.equal(closed, 0, 'сдвиг пальца больше 10 px считается прокруткой, а не тапом для закрытия');
  } finally { try { if (h.root) h.unmount(); } finally { surface.body.removeEventListener('touchstart', reached); restore(); surface.feed.remove(); } }
}

// Слой должен остановить tap до обработчиков строки, иначе закрытие выделения тут же откроет меню сообщения.
textSelMutantTest('мутант пропускает touchstart из слоя к строке', async () => {
  const surface = h.textSurface('слово'); const restore = h.mockTextRangeRects(surface.node);
  let reachedMessage = 0;
  const reached = () => { reachedMessage++; };
  surface.body.addEventListener('touchstart', reached);
  try {
    await h.mountTextSelLayer({ sel: { body: surface.body, start: 0, end: 5 }, onChange: () => {}, onClose: () => {}, onCopy: () => {} });
    h.touch(surface.body, 'touchstart', 40, 125);
    assert.equal(reachedMessage, 0, 'слой останавливает жест до обработчика строки и меню');
  } finally { try { if (h.root) h.unmount(); } finally { surface.body.removeEventListener('touchstart', reached); restore(); surface.feed.remove(); } }
});

it('тап в ленте закрывает текстовый слой, а прокрутка больше 10 px его сохраняет', checkTextSelTapStopsAtLayer);

it('удержание на метаданных не запускает выделение текста и сохраняет действие сообщения', async () => {
  // Метаданные не содержимое текста: удержание открывает меню сообщения, а не панель выделения слова.
  h.mobile(); h.round12(); const restore = h.pointerLayout(true, 390);
  const batch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Собеседник', open: () => {} };
  const photo = { ...h.msg('meta-not-text'), content: '', attachments: [{ url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
    name: 'meta.gif', contentType: 'image/gif', size: 1, width: 1, height: 1 }] } as Message;
  try {
    await h.mount({ messages: [photo], batch });
    const meta = h.host.querySelector<HTMLElement>('[data-mid="meta-not-text"] .bub-meta.over');
    assert.ok(meta, 'фото имеет видимые метаданные внутри тела пузыря');
    const context = new Event('contextmenu', { bubbles: true, cancelable: true });
    Object.defineProperties(context, { pointerType: { value: 'touch' }, clientX: { value: 0 }, clientY: { value: 0 } });
    await act(async () => { meta.dispatchEvent(context); await h.flush(); });
    assert.ok(context.defaultPrevented, 'системное долгое касание времени перехвачено лентой');
    assert.equal(h.host.querySelector('.sel-head') === null, true, 'метаданные не включают выбор самим удержанием');
    assert.equal(document.querySelector('.ctx-menu') !== null, true, 'метаданные сохраняют меню сообщения');
    assert.ok(!document.querySelector('.tsel-bar'), 'время не становится текстом для отдельного выделения');
    const choose = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(button => button.textContent?.trim() === 'Выбрать');
    assert.ok(choose, 'метаданные дают доступ к выбору сообщения через меню');
    await act(async () => { await h.delay(450); choose.click(); await h.flush(); await h.delay(220); });
    assert.equal(h.host.querySelector('[data-mid="meta-not-text"]')?.classList.contains('picked'), true, 'Выбрать отмечает именно сообщение с метаданными');
    assert.equal(document.querySelector('.ctx-menu') === null, true, 'после выбора меню закрыто');
    assert.equal(document.querySelector('.tsel-bar') === null, true, 'выбор сообщения не открывает текстовый слой времени');
  } finally { if (h.root) h.unmount(); h.desktop(); restore(); }
});


// Перенесено из MessagePane.gesturesDock.test.ts: матрицы и утверждения сохранены.


mutantTest('R117 в выборе настоящие кнопки голосового и кружка выбирают строки без звука; обычно играют', async () => {
  await h.rejectMutant(source => {
    const from = 'onClickCapture={selecting ? (e) => act.pick(e, m) : undefined}';
    assert.equal(source.split(from).length - 1, 1, 'найден единственный capture родительской строки');
    return source.replace(from, 'onClickCapture={undefined}');
  }, async (component, _confirm, _answer, runtime) => {
    assert.ok(runtime);
    const auto = await runtime.ssrLoadModule('/src/autoDownload.ts') as typeof import('../autoDownload');
    const player = await runtime.ssrLoadModule('/src/voicePlayer.ts') as typeof import('../voicePlayer');
    const previous = auto.getAutoDownload();
    const restore = h.pointerLayout(false, 1200);
    const saved: { target: object; key: string; descriptor: PropertyDescriptor | undefined }[] = [];
    let audioPlays = 0; let videoPlays = 0;
    // Только адаптер браузерного устройства: оба настоящих компонента и общий плеер остаются в работе.
    for (const target of [HTMLMediaElement.prototype, HTMLAudioElement.prototype, HTMLVideoElement.prototype]) {
      for (const key of ['play', 'pause', 'load']) {
        saved.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
        Object.defineProperty(target, key, { configurable: true, writable: true, value: key === 'play' ? function(this: HTMLMediaElement) {
          if (this.tagName === 'VIDEO') videoPlays++; else audioPlays++;
          this.dispatchEvent(new Event('play')); return Promise.resolve();
        } : function(this: HTMLMediaElement) { if (key === 'pause') this.dispatchEvent(new Event('pause')); } });
      }
    }
    const voice: Message = { ...h.msg('r117-voice'), content: '', attachments: [{
      url: '/r117-voice.webm', name: 'Голосовое', contentType: 'audio/webm', size: 1, durationMs: 10000, waveform: [0.3, 0.5],
    }] };
    const round: Message = { ...h.msg('r117-video'), content: '', attachments: [{
      url: '/r117-video.webm', name: 'Кружок', contentType: 'video/webm', size: 1, durationMs: 10000, round: true,
    }] };
    const mount = () => h.mount({ messages: [h.msg('r117-text'), voice, round], batch: {
      forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Собеседник', open: () => {},
    } }, component);
    try {
      h.desktop(); h.round12(); auto.resetAutoDownload();
      auto.setAutoDownload({ ...auto.getAutoDownload(), autoplayRound: false });
      player.closeVoice();
      await mount();
      const text = h.host.querySelector<HTMLElement>('[data-mid="r117-text"]'); assert.ok(text);
      await act(async () => { text.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
      const select = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(b => b.textContent?.trim() === 'Выделить');
      assert.ok(select, 'входим через меню, без поглощаемого click после удержания');
      await act(async () => { select.click(); await h.flush(); });
      assert.ok(h.host.querySelector('.messages.sel-mode'));
      audioPlays = 0; videoPlays = 0;
      for (const [id, selector] of [['r117-voice', '.voice-play'], ['r117-video', '.round-msg-btn']]) {
        const row = h.host.querySelector<HTMLElement>(`[data-mid="${id}"]`); const button = row?.querySelector<HTMLButtonElement>(selector!);
        assert.ok(row && button, 'в строке настоящая кнопка медиакомпонента');
        await act(async () => { button.click(); await h.flush(); });
        assert.equal(audioPlays + videoPlays, 0, 'выбор кнопки не вызывает настоящее play');
        assert.equal(row.getAttribute('aria-checked'), 'true', 'capture выбрал строку медиасообщения');
      }
      h.unmount(); player.closeVoice(); await mount(); audioPlays = 0; videoPlays = 0;
      await act(async () => { h.host.querySelector<HTMLButtonElement>('.voice-play')!.click(); await h.flush(); });
      assert.equal(audioPlays, 1, 'вне выбора настоящий общий аудиоплеер играет');
      await act(async () => { h.host.querySelector<HTMLButtonElement>('.round-msg-btn')!.click(); await h.flush(); });
      assert.equal(videoPlays, 1, 'вне выбора настоящий кружок играет со звуком');
    } finally {
      try { if (h.root) h.unmount(); }
      finally {
        player.closeVoice(); auto.setAutoDownload(previous);
        for (const { target, key, descriptor } of saved.reverse()) {
          if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
        }
        h.desktop(); restore();
      }
    }
  }, 'выбор кнопки не вызывает настоящее play');
});

async function roundGestureCase(component: typeof h.Pane, runtime: ViteDevServer, check: (view: {
  button: HTMLButtonElement; video: HTMLVideoElement; row: HTMLElement; plays: () => number;
}) => Promise<void>) {
  const restore = h.pointerLayout(true, 390);
  const media = propertyOverrides();
  const autoDownload = await runtime.ssrLoadModule('/src/autoDownload.ts') as typeof import('../autoDownload');
  const previous = autoDownload.getAutoDownload();
  try {
    h.round12(); h.mobile();
    autoDownload.resetAutoDownload();
    autoDownload.setAutoDownload({ ...autoDownload.getAutoDownload(), autoplayRound: false });
    const round: Message = { ...h.msg('r114-round'), content: '', attachments: [{
      url: '/r114-round.webm', name: 'Кружок', contentType: 'video/webm', size: 1, durationMs: 10000, round: true,
    }] };
    await h.mount({ messages: [round], batch: {
      forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Собеседник', open: () => {},
    } }, component);
    const row = h.host.querySelector<HTMLElement>('[data-mid="r114-round"]');
    const button = row?.querySelector<HTMLButtonElement>('.round-msg-btn');
    const video = button?.querySelector<HTMLVideoElement>('video');
    assert.ok(row && button && video, 'вложение рисует настоящий RoundVideo внутри строки MessagePane');
    media.set(button, 'getBoundingClientRect', { value: () => new DOMRect(0, 0, 200, 200) });
    let plays = 0, paused = true;
    media.set(video, 'paused', { get: () => paused });
    media.set(video, 'duration', { value: 10 });
    media.set(video, 'play', { value: () => { paused = false; plays++; video.dispatchEvent(new Event('play')); return Promise.resolve(); } });
    media.set(video, 'pause', { value: () => { paused = true; video.dispatchEvent(new Event('pause')); } });
    await check({ button, video, row, plays: () => plays });
  } finally {
    // Сработавшее удержание ставит capture-слушатели на window: завершение пальца убирает их даже при падении assert.
    try {
      const button = h.host?.querySelector('.round-msg-btn');
      if (button) await act(async () => { h.touch(button, 'touchcancel', 100, 100); });
    } finally {
      try { if (h.root) h.unmount(); }
      finally { autoDownload.setAutoDownload(previous); media.restore(); h.desktop(); restore(); }
    }
  }
}

it('R114 короткий тап по настоящему кружку играет со звуком и не выбирает сообщение', async () => {
  await roundGestureCase(h.Pane, h.server, async ({ button, video, plays }) => {
    await act(async () => { h.touch(button, 'touchstart', 100, 100); h.touch(button, 'touchend', 100, 100); button.click(); });
    assert.equal(plays(), 1, 'короткий тап доходит до обработчика воспроизведения кружка');
    assert.equal(video.muted, false, 'кружок после тапа играет со звуком, не только в беззвучной петле');
    assert.ok(button.closest('.round-msg.playing'), 'RoundVideo действительно перешёл в режим звука');
    await act(async () => { await h.delay(560); });
    assert.equal(h.host.querySelector('.sel-head') === null, true, 'таймер удержания отменён отпусканием и не выбирает сообщение позднее');
    assert.equal(document.querySelector('.ctx-menu,.sheet') === null, true, 'короткий тап не открывает меню сообщения');
  });
});

async function checkRoundHold(component: typeof h.Pane, runtime: ViteDevServer) {
  await roundGestureCase(component, runtime, async ({ button, row, plays }) => {
    await act(async () => { h.touch(button, 'touchstart', 100, 100); await h.delay(560); });
    assert.equal(document.querySelector('.ctx-menu') !== null, true, 'удержание кнопки настоящего кружка открывает меню');
    assert.equal(h.host.querySelector('.sel-head') === null, true, 'удержание само не включает выделение');
    let end!: Event;
    await act(async () => { end = h.touch(button, 'touchend', 100, 100); });
    assert.ok(end.defaultPrevented, 'отпускание после удержания не синтезирует обычный тап');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { button.dispatchEvent(click); });
    assert.ok(click.defaultPrevented, 'синтетический click после долгого касания поглощён');
    assert.equal(plays(), 0, 'удержание открывает меню, не запускает видео');
    const select = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(b => b.textContent?.trim() === 'Выбрать');
    assert.ok(select, 'меню кружка предлагает выбор сообщения');
    await act(async () => { await h.delay(450); select.click(); await h.flush(); });
    assert.equal(h.host.querySelector('.sel-head') !== null, true, 'пункт меню включает пачечное выделение');
    assert.equal(row.getAttribute('aria-checked'), 'true', 'выбран именно кружок, а не соседняя строка');
    assert.equal(plays(), 0, 'выбор через меню не запускает видео');
  });
}

mutantTest('R114 удержание кружка открывает меню выбора; мутант исключает его как обычную кнопку', async () => {
  await h.rejectMutant((source) => source.replace(
    "target.closest('.att-img-link, a.msg-link, [data-att], .message-sticker, .round-msg-btn')",
    "target.closest('.att-img-link, a.msg-link, [data-att], .message-sticker')",
  ), async (component, _confirm, _answer, runtime) => {
    assert.ok(runtime, 'сценарий использует настройки того же Vite realm, что и MessagePane');
    await checkRoundHold(component, runtime);
  }, 'удержание кнопки настоящего кружка открывает меню');
});

it('R114 удержание кольца играющего кружка не открывает меню, а центр предлагает выбор', async () => {
  // .round-msg-seek — визуальное кольцо с pointer-events:none; настоящий палец попадает в кнопку под ним.
  await roundGestureCase(h.Pane, h.server, async ({ button, video, row, plays }) => {
    await act(async () => { button.click(); });
    assert.ok(row.querySelector('.round-msg-seek'), 'у играющего кружка появилось настоящее кольцо перемотки');
    await act(async () => { h.touch(button, 'touchstart', 100, 5); await h.delay(560); });
    assert.equal(h.host.querySelector('.sel-head') === null, true, 'RoundVideo гасит touchstart у края до удержания строки');
    assert.equal(document.querySelector('.ctx-menu,.sheet') === null, true, 'удержание кольца не открывает меню сообщения');
    await act(async () => { h.touch(button, 'touchend', 100, 5); });
    assert.equal(plays(), 1, 'удержание кольца само не переключает воспроизведение');
    assert.equal(video.paused, false, 'звук продолжается без лишней паузы');
    await act(async () => { h.touch(button, 'touchstart', 100, 100); await h.delay(560); });
    assert.equal(document.querySelector('.ctx-menu') !== null, true, 'центр открывает меню того же играющего кружка');
    assert.equal(h.host.querySelector('.sel-head') === null, true, 'центр не выбирает кружок до команды меню');
    await act(async () => { h.touch(button, 'touchend', 100, 100); button.click(); });
    const select = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(b => b.textContent?.trim() === 'Выбрать');
    assert.ok(select, 'защита относится к кольцу, не ко всей кнопке');
    await act(async () => { await h.delay(450); select.click(); await h.flush(); });
    assert.equal(row.getAttribute('aria-checked'), 'true', 'команда выбирает тот же играющий кружок');
    assert.equal(video.paused, false, 'выбор через меню не прерывает звук');
  });
});

it('свайп на телефоне двигает только выбранный пузырь и очищает DOM при отпускании', async () => {
  // Свайп не должен превращаться в тап по меню после touchend или оставлять строку навсегда сдвинутой.
  const restore = h.pointerLayout(true, 390);
  try {
    h.round12(); h.mobile();
    await h.mount({ messages: [h.msg('swipe-me')], onReact: () => {} });
    const body = h.host.querySelector<HTMLElement>('[data-mid="swipe-me"] .message-body');
    const row = h.host.querySelector<HTMLElement>('[data-mid="swipe-me"]');
    assert.ok(body, 'сохранённое сообщение имеет область касания'); assert.ok(row, 'пузырь строки доступен');
    h.rendered.length = 0;
    await act(async () => { h.touch(body, 'touchstart', 100); });
    await act(async () => { h.touch(body, 'touchmove', 80); await h.flush(); });
    await act(async () => { h.touch(body, 'touchmove', 30); await h.flush(); });
    assert.ok(row.classList.contains('swiping'), 'после распознанного жеста строка получает состояние свайпа');
    const swipeX = Number.parseFloat(row.style.getPropertyValue('--swipe-x'));
    assert.equal(swipeX, -50, 'после замка в -20 дальнейший сдвиг -70 даёт ровно 50 px');
    assert.ok(row.querySelector('.swipe-reply.armed'), 'на пороге значок получает состояние готового ответа');
    const rendersDuring = h.rendered.length;
    assert.equal(rendersDuring, 1, 'распознавание жеста перерисовывает строку ровно один раз');
    await act(async () => { h.touch(body, 'touchmove', 30); await h.flush(); });
    assert.equal(h.rendered.length, rendersDuring, 'частое движение после распознавания меняет DOM-переменные без новых React-рендеров');
    await act(async () => { h.touch(body, 'touchmove', 55); await h.flush(); });
    assert.ok(!row.querySelector('.swipe-reply.armed'), 'возврат ниже 50 px снимает взвод без нового жеста');
    await act(async () => { h.touch(body, 'touchmove', 30); await h.flush(); });
    assert.ok(row.querySelector('.swipe-reply.armed'), 'повторное пересечение порога снова взводит ответ');
    const ended = new Event('touchend', { bubbles: true, cancelable: true });
    Object.defineProperty(ended, 'touches', { value: [] });
    await act(async () => { window.dispatchEvent(ended); await h.flush(); });
    assert.equal(ended.defaultPrevented, true, 'свайп не пропускает завершающий тап в меню сообщения');
    assert.ok(!row.classList.contains('swiping'), 'после отпускания исчезает класс жеста');
    assert.equal(row.style.getPropertyValue('--swipe-x'), '', 'после отпускания удаляется inline-смещение');
    assert.ok(h.host.querySelector('.reply-strip'), 'touchend за порогом начинает ответ на сообщение');
    assert.equal(h.rendered.length, 2, 'на весь жест строка перерисовалась только в начале и конце');
  } finally { try { if (h.root) h.unmount(); } finally { restore(); } }
});
it('свайп ограничен шириной телефона, пузырями и отступом 32 px от края', async () => {
  // Эти ограничения предотвращают конфликт с каналами, планшетом и системным жестом Android.
  const cases = [
    { label: 'канал без пузырей', bubbles: false, coarse: true, width: 390, startX: 100 },
    { label: 'широкий планшет', bubbles: true, coarse: true, width: 800, startX: 100 },
    { label: 'палец в узком окне при fine primary pointer', bubbles: true, coarse: false, width: 390, startX: 100 },
    { label: 'системный край', bubbles: true, coarse: true, width: 390, startX: 380 },
  ];
  for (const scenario of cases) {
    if (h.root) h.unmount();
    const restore = h.pointerLayout(scenario.coarse, scenario.width);
    const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: scenario.width });
      await h.mount({ messages: [h.msg(scenario.label)], bubbles: scenario.bubbles, onReact: () => {} });
      const body = h.host.querySelector<HTMLElement>(`[data-mid="${scenario.label}"] .message-body`);
      const row = h.host.querySelector<HTMLElement>(`[data-mid="${scenario.label}"]`);
      assert.ok(body, `${scenario.label}: пузырь смонтирован`); assert.ok(row, `${scenario.label}: строка смонтирована`);
      await act(async () => { h.touch(body, 'touchstart', scenario.startX); h.touch(body, 'touchmove', scenario.startX - 70); await h.flush(); });
      if (scenario.label === 'палец в узком окне при fine primary pointer') {
        assert.ok(row.classList.contains('swiping'), `${scenario.label}: реальное touch-событие свайпает даже при fine primary pointer`);
      } else if (scenario.label === 'системный край') {
        assert.ok(!row.classList.contains('swiping'), `${scenario.label}: запрещённое условие не взводит жест`);
      } else {
        assert.ok(!row.classList.contains('swiping'), `${scenario.label}: это по-прежнему отрицательный gate`);
      }
    } finally {
      if (h.root) h.unmount();
      restore();
      if (innerWidth) Object.defineProperty(window, 'innerWidth', innerWidth);
      else Reflect.deleteProperty(window, 'innerWidth');
    }
  }
});
it('вертикальный палец отдаётся прокрутке, а горизонталь с перевесом 3:1 остаётся ответом', async () => {
  // Ровная диагональ и вертикальный жест должны оставаться нативной прокруткой, чтобы не было мёртвой зоны.
  const restore = h.pointerLayout(true, 390);
  try {
    h.round12(); h.mobile();
    await h.mount({ messages: [h.msg('scroll-gesture'), h.msg('reply-gesture', 'peer')] });
    const scrollBody = h.host.querySelector<HTMLElement>('[data-mid="scroll-gesture"] .message-body');
    const scrollRow = h.host.querySelector<HTMLElement>('[data-mid="scroll-gesture"]');
    assert.ok(scrollBody, 'вертикально прокручиваемое сообщение доступно'); assert.ok(scrollRow, 'строка для вертикального жеста доступна');
    await act(async () => { h.touch(scrollBody, 'touchstart', 100, 100); h.touch(scrollBody, 'touchmove', 80, 70); await h.flush(); });
    assert.ok(!scrollRow.classList.contains('swiping'), 'вертикальное движение не перехватывается ответом');
    const replyBody = h.host.querySelector<HTMLElement>('[data-mid="reply-gesture"] .message-body');
    const replyRow = h.host.querySelector<HTMLElement>('[data-mid="reply-gesture"]');
    assert.ok(replyBody, 'сообщение для ответа доступно'); assert.ok(replyRow, 'строка для диагонального жеста доступна');
    await act(async () => { h.touch(replyBody, 'touchstart', 100, 100); h.touch(replyBody, 'touchmove', 30, 80); await h.flush(); });
    assert.ok(replyRow.classList.contains('swiping'), 'жест влево с перевесом более 3:1 распознаётся как ответ');
  } finally { try { if (h.root) h.unmount(); } finally { restore(); } }
});
it('свайп уважает меньше движения: значок не масштабируется, пузырь возвращается мгновенно', () => {
  // При отключённой анимации движение пальца остаётся, но интерфейс не добавляет вторую анимированную траекторию.
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const reduce = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)].map((m) => m[0]).find((block) => block.includes('.swipe-reply'));
  assert.ok(reduce, 'найдено отдельное правило уменьшенного движения для свайпа');
  assert.match(reduce, /\.swipe-reply\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*none;/);
  assert.match(reduce, /\.message\.bub\s*>\s*\.bubble\s*\{[^}]*transition:\s*box-shadow/);
  assert.match(css, /\.message\.bub\.swiping\s*>\s*\.bub-slot\.end\s*\{[^}]*z-index:\s*-1;/);
});
it('подвал имеет ✓ у своего непрочитанного ЛС, у чужого и в канале только время', async () => {
  // Ловит ложное обещание прочтения в канале или у входящего сообщения.
  h.round12();
  for (const [author, bubbles, expected] of [['me', true, 'Отправлено'], ['peer', true, null], ['me', false, null]] as const) {
    if (h.root) { h.unmount(); }
    const message = h.msg('footer', author, 0, 20);
    await h.mount({ messages: [message], bubbles, peerReadKey: 10, onReact: () => {} });
    await act(async () => { h.host.querySelector('[data-mid="footer"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.delay(40); });
    const foot = document.querySelector('.ctx-foot')!; assert.ok(foot, 'новая карточка содержит время');
    assert.equal(foot.querySelector('span:last-child')!.textContent, sentAtLabel(message.createdAt));
    assert.equal(foot.querySelector('svg title')?.textContent ?? null, expected);
  }
});
async function checkQuoteNames(component: typeof h.Pane) {
  // В канале серверный ник остаётся авторитетным; подпись контакта принадлежит только диалоговому контексту.
  h.round12();
  const source = h.msg('quote-source', 'peer');
  const reply = { ...h.msg('quote-reply'), replyTo: { id: source.id, authorName: 'Старое имя', content: source.content } } as Message;
  const forwarded = { ...h.msg('quote-forward'), forwardedFrom: { userId: 'peer', displayName: 'Старое имя', at: new Date(h.now).toISOString() } } as Message;
  const common = { messages: [source, reply, forwarded], byId: new Map([[source.id, source]]), nameOf: () => 'Подпись контакта' };
  await h.mount({ ...common, quoteNames: true }, component);
  assert.equal(h.host.querySelector('[data-mid="quote-reply"] .rq-author')?.textContent, 'Подпись контакта');
  assert.equal(h.host.querySelector('[data-mid="quote-forward"] .bub-fwd-name')?.textContent, 'Подпись контакта');
  await h.rerender({ ...common, quoteNames: false }, component);
  assert.equal(h.host.querySelector('[data-mid="quote-reply"] .rq-author')?.textContent, 'Старое имя');
  assert.equal(h.host.querySelector('[data-mid="quote-forward"] .bub-fwd-name')?.textContent, 'Старое имя');
}
mutantTest('quoteNames без подписи сохраняет имя ответа и пересылки', async () => {
  await h.rejectMutant((source) => source.replace('quoteNameOf={p.quoteNames ? p.nameOf : undefined}', 'quoteNameOf={p.nameOf}'),
    async (component) => checkQuoteNames(component));
});
it('новый long-press сообщения и ошибки открывает карточку, гасит contextmenu и первый click', async () => {
  // Ловит случайное нажатие пункта меню тем касанием, которое только открыло его.
  const restore = h.pointerLayout(true, 390); const clip = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const copies: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copies.push(text); } } });
  try {
    for (const outgoing of [false, true]) {
      if (h.root) h.unmount(); h.round12(); h.mobile();
      await h.mount(outgoing ? { outbox: h.queue() } : { messages: [h.msg('long-new')], onReact: () => {} });
      const body = h.host.querySelector('.message-body')!;
      await act(async () => { h.touch(body, 'touchstart'); await h.delay(560); });
      assert.ok(document.querySelector('.ctx-stack.anchored'), 'долгое касание открывает карточку у пузыря');
      assert.ok(!document.querySelector('.sheet'), 'новый путь не открывает старый лист');
      const native = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      await act(async () => { body.dispatchEvent(native); await h.delay(20); }); assert.equal(native.defaultPrevented, true);
      let end!: Event; await act(async () => { end = h.touch(body, 'touchend'); }); assert.equal(end.defaultPrevented, true);
      const copy = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(b => b.textContent === 'Скопировать текст')!;
      const count = copies.length, click = new MouseEvent('click', { bubbles: true, cancelable: true });
      await act(async () => { copy.dispatchEvent(click); }); assert.equal(click.defaultPrevented, true); assert.equal(copies.length, count);
      assert.ok(document.querySelector('.ctx-stack'), 'первый click не выбирает пункт и не закрывает карточку');
      await act(async () => { await h.delay(450); copy.click(); await h.delay(20); });
      assert.equal(copies.at(-1), outgoing ? 'failed' : 'long-new');
    }
  } finally { if (h.root) h.unmount(); restore(); if (clip) Object.defineProperty(navigator, 'clipboard', clip); else Reflect.deleteProperty(navigator, 'clipboard'); }
});
it('ошибка на телефоне и в узком окне имеет якорь и причину без реакций, ПК сохраняет прежнее меню', async () => {
  // Ловит потерю причины сбоя и полосу реакций у ещё не существующего серверного сообщения.
  h.round12();
  for (const [coarse, width] of [[true, 390], [false, 600], [false, 1000]] as const) {
    if (h.root) h.unmount(); const restore = h.pointerLayout(coarse, width);
    try {
      await h.mount({ outbox: h.queue() }); const body = h.host.querySelector<HTMLElement>('.message-body')!;
      await act(async () => { if (coarse) body.click(); else body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.delay(40); });
      assert.ok(document.querySelector('.ctx-menu'), 'ошибка имеет меню действий');
      assert.ok(!document.querySelector('.react-bar,.sheet'), 'нет реакций и старого листа');
      if (width <= 620) {
        assert.ok(document.querySelector('.ctx-stack.anchored'), 'узкий путь привязан к пузырю');
        assert.equal(document.querySelector('.ctx-foot span:last-child')?.textContent, 'Не отправлено: сеть');
      } else {
        assert.ok(!document.querySelector('.ctx-stack,.ctx-foot'), 'ПК сохраняет прежнюю ветку без стека и нового подвала');
      }
    } finally { try { if (h.root) h.unmount(); } finally { restore(); } }
  }
});

it('закрытие меню по Escape возвращает фокус на кнопку неотправленного', async () => {
  await h.mount({ outbox: { items: [h.out()], enqueue: () => {}, retry: () => {}, discard: () => {} } });
  const btn = h.host.querySelector<HTMLButtonElement>('.bub-fail-btn')!;
  await act(async () => { btn.click(); });
  await act(async () => { await h.delay(40); });
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await act(async () => { await h.delay(40); });
  assert.equal(document.querySelector('.ctx-menu') === null, true); assert.ok(document.activeElement === btn, 'фокус вернулся к исходной кнопке');
});
it('панель эмодзи закрепляется третьей колонкой только на широком ПК и переживает выбор', async () => {
  // Настройка должна менять настоящую разметку MessagePane; в узком окне/телефоне колонка скрыта, а не ломает композер.
  const restoreEmoji = await dockEmojiFixture(h.server);
  const widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  let paneWidth = 800;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() {
    return (this as HTMLElement).classList?.contains('chat') ? paneWidth : widthDesc?.get?.call(this) ?? 0;
  } });
  const media = (coarse: boolean, width: number, hover: boolean) => {
    const restore = h.pointerLayout(coarse, width);
    const original = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const m = original(query);
      if (query.includes('(hover: hover)')) Object.defineProperty(m, 'matches', { configurable: true, value: hover });
      return m;
    };
    return restore;
  };
  const source = readFileSync(new URL('./MessagePane.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  try {
    const fixturePane = h.Pane;
    h.desktop(); h.round12(); localStorage.removeItem('gv_expr_dock');
    let restore = media(false, 800, true);
    try {
      await h.mount({ messages: [h.msg('dock') ] }, fixturePane);
      assert.equal(h.host.querySelector('.expr-dock') === null, true, 'незакреплённая настройка не создаёт колонку сама');
      const emoji = h.host.querySelector<HTMLButtonElement>('.composer .att-btn.emoji'); assert.ok(emoji);
      await act(async () => { emoji!.click(); await h.delay(40); });
      assert.ok(h.host.querySelector('.expr-dock .emoji-pop.docked'), 'клик на широком ПК закрепляет настоящий EmojiPicker');
      assert.ok(h.host.querySelector('.chat.has-expr-dock'), 'корень беседы отражает занятую колонку');
      assert.equal(localStorage.getItem('gv_expr_dock'), '1', 'закрепление запомнено');
      assert.equal(h.host.querySelector('.emoji-backdrop') === null, true, 'закреплённый picker без подложки');
      assert.equal(h.host.querySelector('.expr-dock .emoji-pop')?.hasAttribute('style'), false, 'у колонки нет экранных координат поповера');
      assert.equal(document.activeElement !== h.host.querySelector('.emoji-search input'), true, 'закреплённый поиск не перехватывает фокус');
      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await h.delay(20); });
      assert.ok(h.host.querySelector('.expr-dock .emoji-pop.docked'), 'Esc не закрывает закреплённую колонку');
      const cell = h.host.querySelector<HTMLButtonElement>('.expr-dock .emoji-cell'); assert.ok(cell, 'есть доступный эмодзи для выбора');
      await act(async () => { cell!.click(); await h.delay(30); });
      assert.ok(h.host.querySelector('.expr-dock .emoji-pop.docked'), 'выбор эмодзи не закрывает колонку');
      await act(async () => { h.host.querySelector<HTMLButtonElement>('.composer .att-btn.emoji')!.click(); await h.delay(30); });
      assert.equal(h.host.querySelector('.expr-dock') === null, true, 'повторный клик убирает колонку');
      assert.equal(localStorage.getItem('gv_expr_dock'), null, 'убранная колонка очищает настройку');
    } finally { if (h.root) h.unmount(); restore(); }

    localStorage.setItem('gv_expr_dock', '1'); paneWidth = 724;
    restore = media(false, 724, true);
    try { await h.mount({}, fixturePane); assert.equal(h.host.querySelector('.expr-dock') === null, true, '724 px меньше порога, колонка не появляется'); }
    finally { if (h.root) h.unmount(); restore(); }

    localStorage.removeItem('gv_expr_dock'); paneWidth = 800; restore = media(false, 800, false);
    try {
      await h.mount({}, fixturePane);
      await act(async () => { h.host.querySelector<HTMLButtonElement>('.composer .att-btn.emoji')!.click(); await h.delay(30); });
      assert.equal(h.host.querySelector('.expr-dock') === null, true, 'без hover обычный клик не превращает поповер в dock');
      assert.ok(h.host.querySelector('.emoji-pop:not(.docked)'), 'без hover остаётся доступен обычный поповер');
    } finally { if (h.root) h.unmount(); restore(); }

    paneWidth = 800; restore = media(true, 900, false); h.mobile();
    try { await h.mount({}, fixturePane); assert.equal(h.host.querySelector('.expr-dock') === null, true, 'телефон скрывает закреплённую колонку даже при ширине 900 px'); }
    finally { if (h.root) h.unmount(); restore(); h.desktop(); }

    const match = source.match(/const dock = useExprDock\(chatEl, ([^)]*)\);/);
    assert.ok(match, 'извлечено реальное условие доступности dock');
    const enabled = (expr: string, phone: boolean) => runInNewContext(`Boolean(${expr})`, { dockPhone: phone, composerReplacement: false }) as boolean;

    assert.equal(enabled(match![1]!, true), false, 'настоящий gate отключает колонку на телефоне');
    counterfact(() => {
      const phoneMutant = match![1]!.replace('!dockPhone && ', '');
      assert.notEqual(phoneMutant, match![1], 'мутант снимает явный запрет dock для телефона');
      assert.equal(enabled(phoneMutant, true), true, 'исполняемый мутант включает её на телефоне');
    }, { timeoutMs: 60_000 });
    const pinGate = 'dock.canPin && hoverPanelsAvailable()';
    assert.ok(source.includes(`else if (${pinGate})`), 'найден gate, который не закрепляет у устройств без hover');
    const pin = (expr: string) => runInNewContext(`Boolean(${expr})`, { dock: { canPin: true }, hoverPanelsAvailable: () => false }) as boolean;
    assert.equal(pin(pinGate), false, 'touch-устройство не закрепляет поповер click-ом');
    counterfact(() => {
      assert.equal(pin('dock.canPin'), true, 'исполняемый mutant без проверки hover захватил бы клик');
    }, { timeoutMs: 60000 });
  } finally {
    try { if (h.root) h.unmount(); }
    finally {
      localStorage.removeItem('gv_expr_dock');
      if (widthDesc) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthDesc); else Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
      h.desktop(); restoreEmoji();
    }
  }
});
async function checkDockTyping(component: typeof h.Pane, runtime: ViteDevServer) {
  const restoreEmoji = await dockEmojiFixture(runtime);
  const widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const originalNow = Date.now; const originalInterval = window.setInterval; const originalClear = window.clearInterval;
  const intervals: Array<{ fn: TimerHandler; ms: number }> = [];
  let fakeNow = originalNow();
  let chatWidth = 800;
  const restore = h.pointerLayout(false, 800);
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() {
    return (this as HTMLElement).classList?.contains('chat') ? chatWidth : widthDesc?.get?.call(this) ?? 0;
  } });
  window.setInterval = ((fn: TimerHandler, ms?: number) => { intervals.push({ fn, ms: Number(ms) }); return 987654 as unknown as number; }) as typeof window.setInterval;
  window.clearInterval = (() => {}) as typeof window.clearInterval;
  Date.now = () => fakeNow;
  const calls: string[] = [];
  let dockTarget: HTMLElement | null = null;
  try {
    const fixturePane = component;
    h.desktop(); h.round12(); localStorage.setItem('gv_expr_dock', '1');
    const restoreMedia = (() => { const original = window.matchMedia.bind(window); window.matchMedia = (query) => {
      const m = original(query); Object.defineProperty(m, 'matches', { configurable: true, value: query.includes('(hover: hover)') ? true : query.includes('max-width') ? false : m.matches }); return m;
    }; return () => { window.matchMedia = original; }; })();
    const checkDockScenario = async (component: typeof h.Pane) => {
      if (h.root) h.unmount();
      calls.length = 0; intervals.length = 0; fakeNow = originalNow(); dockTarget = null;
      localStorage.setItem('gv_expr_dock', '1');
      await h.mount({ onSendSticker: async () => {}, stickerPacks: [{ id: 'pack', title: 'Набор', stickers: [] }] as never,
        onTyping: (kind) => { calls[calls.length] = kind ?? ''; } }, component);
      try {
        // При восстановленном закреплении вкладки уже в колонке; щелчок по кнопке эмодзи снял бы закрепление.
        const stickerTab = [...h.host.querySelectorAll<HTMLButtonElement>('.expr-dock [role="tab"]')]
          .find((b) => b.textContent?.includes('Стикеры'));
        assert.ok(stickerTab, 'закреплённая колонка сразу показывает вкладку стикеров');
        await act(async () => { stickerTab!.click(); await h.flush(); });
        const dock = h.host.querySelector<HTMLElement>('.sticker-pop.docked'); assert.ok(dock, 'вкладка стикеров открыта в закреплённой колонке');
        assert.deepEqual(calls, [], 'закреплённая колонка не шлёт idle choosingSticker');
        fakeNow += 15000;
        for (const interval of intervals) if (interval.ms === TYPING_SEND_MS + 50) (interval.fn as () => void)();
        assert.deepEqual(calls, [], '15 секунд простоя не создают choosingSticker');
        const inner = dock.querySelector<HTMLElement>('*')!; dockTarget = inner;
        await act(async () => { inner.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })); });
        assert.deepEqual(calls, ['sticker'], 'движение внутри dock сообщает один раз');
        await act(async () => { inner.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })); });
        assert.deepEqual(calls, ['sticker'], 'повтор в пределах интервала подавлен');
        fakeNow += 4100;
        await act(async () => { inner.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })); });
        assert.deepEqual(calls, ['sticker', 'sticker'], 'после интервала активность снова сообщает');
        calls.length = 0;
        fakeNow += TYPING_SEND_MS + 1;
        await act(async () => { h.host.querySelector('.messages')!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })); });
        assert.deepEqual(calls, [], 'движение по ленте не выдаётся за выбор стикеров');
        const formerDock = dockTarget!.closest<HTMLElement>('.sticker-pop.docked'); assert.ok(formerDock);
        h.unmount(); calls.length = 0; fakeNow += TYPING_SEND_MS + 1;
        // Возвращаем только старый DOM в body: событие должно дойти до document,
        // иначе detached-узел скрывает утечку глобального слушателя.
        document.body.append(formerDock);
        try {
          await act(async () => { dockTarget!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })); });
          assert.deepEqual(calls, [], 'после размонтирования dock-слушатель снят');
        } finally { formerDock.remove(); }
      } finally {
        if (h.root) h.unmount();
        fakeNow = originalNow();
      }
    };
    try {
      await checkDockScenario(fixturePane);

    } finally { restoreMedia(); }
    if (h.root) h.unmount();
    calls.length = 0; intervals.length = 0; fakeNow = originalNow(); localStorage.removeItem('gv_expr_dock');
    const popupCalls: string[] = [];
    chatWidth = 600;
    await h.mount({ onSendSticker: async () => {}, stickerPacks: [{ id: 'pack', title: 'Набор', stickers: [] }] as never,
      onTyping: (kind) => { popupCalls[popupCalls.length] = kind ?? ''; } }, fixturePane);
    await act(async () => { h.host.querySelector<HTMLButtonElement>('.composer .att-btn.emoji')!.click(); await h.flush(); });
    await act(async () => { [...h.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.includes('Стикеры'))!.click(); await h.flush(); });
    assert.ok(h.host.querySelector('.sticker-pop:not(.docked)'), 'без закрепления остаётся всплывающий пикер');
    assert.deepEqual(popupCalls, ['sticker'], 'всплывающая панель сразу сообщает о выборе стикера');
    fakeNow += 4100;
    for (const interval of intervals) if (interval.ms === TYPING_SEND_MS + 50) (interval.fn as () => void)();
    assert.deepEqual(popupCalls, ['sticker', 'sticker'], 'всплывающая панель сохраняет периодические сигналы');
  } finally {
    try { if (h.root) h.unmount(); }
    finally {
      Date.now = originalNow; window.setInterval = originalInterval; window.clearInterval = originalClear;
      restore(); if (widthDesc) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthDesc); else Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
      localStorage.removeItem('gv_expr_dock'); restoreEmoji();
    }
  }
}

it('закреплённый выбор стикеров сообщает только о движении внутри колонки, без idle-интервала', async () => {
  await checkDockTypingBaseline(h.Pane, h.server);
});
// Только идентичная fixture/последовательность checkDockTyping; флаг ставится после полного успеха.
let dockTypingBaselineChecked = false;
async function checkDockTypingBaseline(component: typeof h.Pane, runtime: ViteDevServer) {
  if (component === h.Pane && dockTypingBaselineChecked) return;
  await checkDockTyping(component, runtime);
  if (component === h.Pane) dockTypingBaselineChecked = true;
}
        const dockedOr = (source: string) => source.replace(
          "const choosingSticker = !docked && !!picker && picker.kind === 'composer' && canSticker && exprTab === 'stickers';",
          "const choosingSticker = docked || (!!picker && picker.kind === 'composer' && canSticker && exprTab === 'stickers');");
        const missingClosest = (source: string) => source.replace(
          "if (e.target instanceof Element && e.target.closest('.sticker-pop.docked')) signalActionRef.current('sticker');",
          "if (e.target instanceof Element) signalActionRef.current('sticker');");

for (const [label, mutation] of [['мутант добавляет docked ||', dockedOr], ['мутант убирает closest dock', missingClosest]] as const) {
  mutantTest(label, async () => {
    await h.rejectMutant(mutation, async (component, _confirm, _answer, runtime) => {
      assert.equal(typeof component, 'function', `${label}: получен отдельный исходниковый мутант`);
      assert.ok(runtime, 'сценарий использует runtime проверяемого компонента');
      await checkDockTypingBaseline(component, runtime);
    });
  });
}

// Перенесено из MessagePane.menus.test.ts: матрицы и утверждения сохранены.


function propertyOverrides() {
  const restores: Array<() => void> = [];
  return {
    save(target: object, key: PropertyKey) {
      const previous = Object.getOwnPropertyDescriptor(target, key);
      restores.push(() => {
        if (previous) Object.defineProperty(target, key, previous);
        else Reflect.deleteProperty(target, key);
      });
    },
    set(target: object, key: PropertyKey, descriptor: PropertyDescriptor) {
      this.save(target, key);
      Object.defineProperty(target, key, { configurable: true, ...descriptor });
    },
    restore() { for (const restore of restores.splice(0).reverse()) restore(); },
  };
}

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
  } finally { try { if (h.root) h.unmount(); } finally { h.desktop(); restore(); } }
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
  } finally { try { if (h.root) h.unmount(); } finally { h.desktop(); restore(); } }
});
mutantTest('телефонное меню отправки показывает скрытый от accessibility предпросмотр', async () => {
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
      try { if (h.root) h.unmount(); } finally { h.desktop(); restore(); }
    }
  });

  // `rejectMutant` reruns this scenario in a child with a separate Vite server.
  if (!mutantsEnabled() || !process.env.GUSVOICE_PANE_MUTANT) {
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
  const inputFiles = propertyOverrides();
  inputFiles.set(input, 'files', { value: [new File(['x'], 'note.txt', { type: 'text/plain' })] });
  try {
  await act(async () => { input!.dispatchEvent(new Event('change', { bubbles: true })); await h.flush(); }); await open();
  const later = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Отправить позже'));
  const online = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Когда будет в сети'));
  assert.ok(later?.disabled && online?.disabled, 'оба отложенных действия запрещены при наличии файла');
  assert.match(document.querySelector('.ctx-menu')?.textContent ?? '', /Только текст, без вложений/);
  } finally { try { if (h.root) h.unmount(); } finally { inputFiles.restore(); } }
  // Режим правки открывается из меню сообщения; при нём меню отправки недоступно.
  const restore = h.pointerLayout(true, 390); h.mobile();
  try {
    await h.mount({ messages: [h.msg('edit-send')], sendMenu, draft: { text: 'черновик', replyToId: null } as never });
    const row = h.host.querySelector<HTMLElement>('[data-mid="edit-send"]'); assert.ok(row, 'сообщение для входа в правку есть');
    await act(async () => { row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const edit = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Изменить'));
    assert.ok(edit, 'собственное сообщение предлагает правку'); await act(async () => { edit!.click(); await h.flush(); });
    assert.ok(h.host.querySelector('.edit-strip'), 'нажатие пункта действительно включило правку');
    assert.equal(h.host.querySelector<HTMLTextAreaElement>('.composer-input')?.value, 'edit-send', 'правится сообщение, а не исходный черновик');
    await open(false); assert.ok(!document.querySelector('.ctx-menu'), 'во время правки кнопка не открывает меню отложенной отправки');
  } finally { try { if (h.root) h.unmount(); } finally { h.desktop(); restore(); } }
});

// Меню удержания → выбор/диапазон; mouse/pointer матрица находится ниже.
// R161: сохранены идентификаторы пальцев, пороги и очистка capture-слушателей.
const menuRangeBatch = { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Друг', open: () => {} };
const menuRangeMessages = () => ['range-one', 'range-two', 'range-three'].map((id, i) => h.msg(id, 'me', 0, i + 1));

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

async function menuRangeFixture(component = h.Pane, mobile = true, coarse = true) {
  h.round12(); mobile ? h.mobile() : h.desktop();
  const restore = h.pointerLayout(coarse, coarse ? 390 : 1280);
  const geometry = propertyOverrides();
  try {
    await h.mount({ messages: menuRangeMessages(), batch: menuRangeBatch }, component);
    const list = h.host.querySelector<HTMLElement>('.messages');
    assert.ok(list, 'настоящая лента смонтирована');
    geometry.set(list, 'getBoundingClientRect', { value: () => new DOMRect(0, 40, 390, 500) });
    geometry.set(list, 'clientHeight', { value: 500 });
    for (const [index, id] of ['range-one', 'range-two', 'range-three'].entries()) {
      const row = h.host.querySelector<HTMLElement>(`[data-mid="${id}"]`);
      assert.ok(row, 'строка диапазона смонтирована');
      geometry.set(row, 'getBoundingClientRect', { value: () => new DOMRect(0, 100 + index * 70, 360, 60) });
    }
    const body = h.host.querySelector<HTMLElement>('[data-mid="range-one"] .message-body');
    assert.ok(body, 'касание идёт в текст настоящего пузыря');
    return { body, restore: () => { geometry.restore(); restore(); } };
  } catch (error) {
    try { if (h.root) h.unmount(); } finally { geometry.restore(); restore(); h.desktop(); }
    throw error;
  }
}

async function hold(body: HTMLElement) {
  await act(async () => { touch(body, 'touchstart'); await h.delay(560); await h.flush(); });
}

async function cleanupMenuRange(restore: () => void) {
  // До restore перехватчика слушателей даём native-contextmenu guard самому
  // снять свою тройку: простое removeEventListener оставило бы его contextmenu.
  // Остаточный click-guard убирает setupHarness перед следующей фикстурой.
  try { await act(async () => { touch(window, 'touchend'); }); }
  finally { try { if (h.root) h.unmount(); } finally { restore(); h.desktop(); } }
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
  const { body, restore } = await menuRangeFixture(component);
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
  } finally { await cleanupMenuRange(restore); }
}

mutantTest('R161 долгое нажатие открывает меню, а Выбрать перед Удалить выбирает одно', async () => {
  await h.rejectMutant((source) => source.replace(
    'batchOn ? () => startMenuRange(m, row, photo, { file })',
    'batchOn ? () => startTouchRange(m)',
  ), (component) => chooseOne(component), 'удержание открывает меню сообщения');
});

it('R161 ровно 8px вверх и вниз и горизонтальная протяжка оставляют меню без выбора', async () => {
  for (const [x, y] of [[30, 128], [30, 112], [130, 120]]) {
    const { body, restore } = await menuRangeFixture();
    try {
      await hold(body);
      let prevented = false;
      await act(async () => { prevented = touch(body, 'touchmove', x, y).defaultPrevented; await h.flush(); });
      assert.equal(prevented, true, 'меню удерживает прокрутку исходного пальца');
      menuWithoutSelection();
      await act(async () => { touch(body, 'touchend', x, y); await h.flush(); });
      menuWithoutSelection();
    } finally { await cleanupMenuRange(restore); }
  }
});

type Listener = EventListenerOrEventListenerObject;
type MenuListenerRecord = { type: string; listener: Listener; capture: boolean; passive: boolean; active: boolean };
function observeListeners() {
  const add = window.addEventListener;
  const remove = window.removeEventListener;
  const records: MenuListenerRecord[] = [];
  const overrides = propertyOverrides();
  const captureOf = (options?: boolean | AddEventListenerOptions | EventListenerOptions) => typeof options === 'boolean' ? options : !!options?.capture;
  overrides.set(window, 'addEventListener', { writable: true, value: function (this: Window, type: string, listener: Listener | null, options?: boolean | AddEventListenerOptions) {
    if (!listener) return;
    if (['touchmove', 'touchend', 'touchcancel'].includes(type)) records.push({ type, listener, capture: captureOf(options), passive: typeof options === 'object' && !!options.passive, active: true });
    return add.call(this, type, listener, options);
  } as typeof window.addEventListener });
  overrides.set(window, 'removeEventListener', { writable: true, value: function (this: Window, type: string, listener: Listener | null, options?: boolean | EventListenerOptions) {
    if (!listener) return;
    for (const record of records) if (record.type === type && record.listener === listener && record.capture === captureOf(options)) record.active = false;
    return remove.call(this, type, listener, options);
  } as typeof window.removeEventListener });
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
      try {
        for (const record of records) if (record.active) remove.call(window, record.type, record.listener, record.capture);
      } finally { overrides.restore(); }
    },
  };
}

let positiveRangeBaselineChecked = false;
async function range(component: typeof h.Pane, delta = 9) {
  if (component === h.Pane && delta === 9 && positiveRangeBaselineChecked) return;
  const { body, restore } = await menuRangeFixture(component);
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
    if (component === h.Pane && delta === 9) positiveRangeBaselineChecked = true;
  } finally { try { await cleanupMenuRange(restore); } finally { observed.restore(); } }
}

it('R161 вертикальные 9px в обе стороны превращают меню в протяжку диапазона', async () => {
  await range(h.Pane, 9); await range(h.Pane, -9);
});

mutantTest('R161 переход в диапазон снимает оконные слушатели меню до продолжения пальцем', async () => {
  await h.rejectMutant((source) => source.replace('      off();\n      startTouchRange(m);', '      /* mutant: старая тройка осталась */\n      startTouchRange(m);'), (component) => range(component),
    'переход снимает старую тройку меню');
});

for (const ending of ['touchend', 'touchcancel'] as const) {
  it(`R161 ${ending} снимает тройку меню, оставляя меню и не начиная выбор следующим движением`, async () => {
    const { body, restore } = await menuRangeFixture(); const observed = observeListeners();
    try {
      await hold(body); const group = observed.menu();
      await act(async () => { touch(body, ending); await h.flush(); });
      assert.equal(group.every((r) => !r.active), true, 'конец касания снимает всю тройку меню');
      await act(async () => { touch(body, 'touchmove', 30, 250); await h.flush(); });
      menuWithoutSelection();
    } finally { try { await cleanupMenuRange(restore); } finally { observed.restore(); } }
  });
}

mutantTest('R161 размонтирование до touchend снимает оконную тройку меню', async () => {
  await h.rejectMutant((source) => source.replace('  useEffect(() => () => menuRangeOff.current?.(), []);', '  /* mutant: тройка меню переживает ленту */'), async (component) => {
    const { body, restore } = await menuRangeFixture(component); const observed = observeListeners();
    try {
      await hold(body); const group = observed.menu();
      h.unmount();
      assert.equal(group.every((r) => !r.active), true, 'размонтирование снимает всю тройку меню');
    } finally { try { await cleanupMenuRange(restore); } finally { observed.restore(); } }
  }, 'размонтирование снимает всю тройку меню');
});

it('R161 новое удержание снимает прежнюю тройку и открывает меню нового сообщения', async () => {
  const { body, restore } = await menuRangeFixture(); const observed = observeListeners();
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
  } finally { try { await cleanupMenuRange(restore); } finally { observed.restore(); } }
});

it('R161 чужой палец не двигает диапазон и не снимает тройку нашего касания', async () => {
  const { body, restore } = await menuRangeFixture(); const observed = observeListeners();
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
  } finally { try { await cleanupMenuRange(restore); } finally { observed.restore(); } }
});

mutantTest('R161 запасной touch contextmenu открывает меню, а не немедленный выбор', async () => {
  await h.rejectMutant((source) => source.replace('      if (at) openMsgMenuAt(m, at, photo, more);', '      if (batchOn) startSelection(m);\n      else if (at) openMsgMenuAt(m, at, photo, more);'),
    (component) => chooseOne(component, true), 'удержание открывает меню сообщения');
});

mutantTest('R161 ПК и браузер телефона показывают Выделить после Удалить без Выбрать', async () => {
  await h.rejectMutant((source) => source.replace('{batchOn && isMobile() && (', '{batchOn && ('), async (component) => {
    for (const coarse of [false, true]) {
      const { body, restore } = await menuRangeFixture(component, false, coarse);
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
      } finally { await cleanupMenuRange(restore); }
    }
  }, 'вне приложения пункта Выбрать нет');
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
  const geometry = propertyOverrides();
  try {
    await h.mount({ messages: ['drag-a', 'drag-b', 'drag-c'].map((id) => h.msg(id)), batch });
    const first = h.host.querySelector<HTMLElement>('[data-mid="drag-a"]'); assert.ok(first, 'строка для основы выбора существует');
    await act(async () => { first!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const choose = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Выделить'));
    assert.ok(choose, 'контекстное меню даёт создать непустую базовую пачку'); await act(async () => { choose!.click(); await h.flush(); });
    assert.equal(first.getAttribute('aria-checked'), 'true', 'до drag уже выбрана первая строка');
    const list = h.host.querySelector<HTMLElement>('.messages'); assert.ok(list, 'ленту можно геометрически измерить');
    geometry.set(list, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 0, bottom: 300, left: 0, right: 400, width: 400, height: 300, x: 0, y: 0, toJSON() {} }) });
    const rows = [...h.host.querySelectorAll<HTMLElement>('.message[data-mid]')];
    assert.equal(rows.length, 3, 'все три строки участвуют в диапазоне');
    rows.forEach((row, i) => geometry.set(row, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 10 + i * 40, bottom: 30 + i * 40, left: 0, right: 300, width: 300, height: 20, x: 0, y: 10 + i * 40, toJSON() {} }) }));
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
  } finally { try { if (h.root) h.unmount(); } finally { geometry.restore(); } }
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
  const geometry = propertyOverrides();
  try {
    await h.mount({ messages, batch });
    const list = h.host.querySelector<HTMLElement>('.messages'); assert.ok(list, 'лента пачки смонтирована');
    geometry.set(list, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 0, bottom: 5000, left: 0, right: 400, width: 400, height: 5000, x: 0, y: 0, toJSON() {} }) });
    const rows = [...h.host.querySelectorAll<HTMLElement>('.message[data-mid]')];
    rows.forEach((row, i) => geometry.set(row, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 10 + i * 20, bottom: 28 + i * 20, left: 0, right: 300, width: 300, height: 18, x: 0, y: 10 + i * 20, toJSON() {} }) }));
    await act(async () => { send(rows[0]!, 'pointerdown', 20); send(window as unknown as Element, 'pointermove', 2020); await h.flush(); });
    const selected = rows.filter((row) => row.getAttribute('aria-checked') === 'true');
    assert.equal(selected.length, 100, 'реальный drag выбирает ровно максимальные сто сообщений');
    assert.equal(rows[100]!.getAttribute('aria-checked'), 'false', 'сто первая строка явно осталась невыбранной');
    await act(async () => { send(window as unknown as Element, 'pointerup', 2020, 0); await h.flush(); });
  } finally { try { if (h.root) h.unmount(); } finally { geometry.restore(); } }
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
  try {
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
  } finally { try { if (h.root) h.unmount(); } finally { h.desktop(); restore(); } }
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
  let restoreLayout: (() => void) | undefined;
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
    h.unmount(); h.mobile(); restoreLayout = h.pointerLayout(true, 390);
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
  } finally {
    try { if (h.root) h.unmount(); } finally {
      restoreLayout?.();
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard); else Reflect.deleteProperty(navigator, 'clipboard');
      h.desktop();
    }
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
  } finally { try { if (h.root) h.unmount(); } finally { window.open = savedOpen; } }
});

// Три ссылочных мутанта используют один и тот же baseline. Каждый child всё равно
// выполняет собственный check на свежем компоненте; успех оригинала кешируем только после всех assert.
let linkContextBaselineChecked = false;
async function checkLinkContextMenu(component: typeof h.Pane) {
  if (component === h.Pane && linkContextBaselineChecked) return;
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
    if (component === h.Pane) linkContextBaselineChecked = true;
  } finally { h.unmount(); }
}

mutantTest('мутант не распознаёт ссылку в контекстном меню строки', async () => {
  // Ловит ранний выход обработчика на ссылке до сборки link/file payload.
  await h.rejectMutant(s => {
    const changed = s.replace('&& !photoLink && !linkEl && !fileEl', '&& !photoLink && !fileEl');
    assert.notEqual(changed, s, 'найдена проверка, которая должна пропускать ссылку к меню'); return changed;
  }, checkLinkContextMenu);
});

mutantTest('мутант не передаёт ссылочную цель в обработчик строки', async () => {
  // Ловит разрыв между распознанным DOM-якорем и общим контекстным меню: без act.aim оно не знает URL.
  await h.rejectMutant(s => {
    const changed = s.replace('    act.aim(more);', '    /* mutant: ссылка не передана строке */');
    assert.notEqual(changed, s, 'найден канал передачи данных ссылки в строку'); return changed;
  }, checkLinkContextMenu);
});

mutantTest('мутант копирует ссылку на сообщение вместо адреса из текста', async () => {
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
  const overrides = propertyOverrides();
  let resized: ResizeObserverCallback | null = null;
  class WheelResizeObserver { constructor(private readonly cb: ResizeObserverCallback) {} observe() { resized = this.cb; } disconnect() {} unobserve() {} }
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
    overrides.set(globalThis, 'ResizeObserver', { configurable: true, value: WheelResizeObserver });
    overrides.set(window, 'ResizeObserver', { configurable: true, value: WheelResizeObserver });
    overrides.set(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 });
    await exercise(-36, {}, false); h.unmount();
    await exercise(36, {}, true); h.unmount();
    await exercise(36, { bubbles: false }, false); h.unmount();
    overrides.set(window, '__TAURI_INTERNALS__', { value: {} });
    await exercise(36, {}, true);
  } finally {
    try { if (h.root) h.unmount(); } finally { h.desktop(); restore(); overrides.restore(); }
  }
});

it('панель выбора измеряет свои подписи при 9→10, смене действий и повторном открытии без resize', async () => {
  h.round12(); h.desktop();
  const overrides = propertyOverrides();
  const originalClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
  const observed: { target: Element; disconnected: boolean }[] = [];
  class Observer {
    entries: typeof observed = [];
    observe(target: Element) { const entry = { target, disconnected: false }; observed.push(entry); this.entries.push(entry); }
    unobserve(target: Element) { for (const entry of this.entries) if (entry.target === target) entry.disconnected = true; }
    disconnect() { for (const entry of this.entries) entry.disconnected = true; }
  }
  let tightWithReply = false;
  const messages = Array.from({ length: 10 }, (_, index) => h.msg(`fit-${index + 1}`, 'me'));
  const props: Partial<Props> = { messages, batch: { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Адресат', open() {} } };
  const bar = () => h.host.querySelector<HTMLElement>('.sel-bar');
  const choose = async () => {
    const row = h.host.querySelector<HTMLElement>('[data-mid="fit-1"]'); assert.ok(row);
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    const action = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(button => button.textContent?.includes('Выделить'));
    assert.ok(action);
    await act(async () => { action.click(); await h.flush(); });
  };
  try {
    overrides.set(globalThis, 'ResizeObserver', { value: Observer });
    overrides.set(window, 'ResizeObserver', { value: Observer });
    overrides.set(HTMLElement.prototype, 'clientWidth', { get(this: HTMLElement) {
      if (this.matches('.sel-bar')) return 300;
      if (this.matches('.sel-bar-label')) return 100;
      return originalClient?.get?.call(this) ?? 0;
    } });
    overrides.set(HTMLElement.prototype, 'scrollWidth', { get(this: HTMLElement) {
      if (!this.matches('.sel-bar-label')) return originalScroll?.get?.call(this) ?? 0;
      const panel = this.closest<HTMLElement>('.sel-bar')!;
      // Граница измерения браузера: цифра 10 тесна, скрытие числа помогает;
      // при крупном шрифте три действия требуют колонки, два помещаются.
      if (tightWithReply && panel.querySelectorAll('button').length === 3)
        return panel.dataset.fit === 'col' ? 80 : 120;
      return /\b10\b/.test(panel.textContent ?? '') && !panel.dataset.fit ? 120 : 80;
    } });
    await h.mount(props); await choose();
    assert.equal(bar()?.dataset.fit, undefined, 'одна короткая подпись помещается');
    assert.ok(observed.some(entry => entry.target === bar()), 'observer подключён к настоящей панели');
    await act(async () => {
      for (let index = 2; index <= 9; index++) h.host.querySelector<HTMLElement>(`[data-mid="fit-${index}"]`)!.click();
      await h.flush();
    });
    assert.equal(bar()?.dataset.fit, undefined, 'девять сообщений ещё помещаются');
    await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="fit-10"]')!.click(); await h.flush(); });
    assert.equal(bar()?.dataset.fit, 'n', 'десятая цифра вызывает замер даже без ResizeObserver callback');
    await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="fit-10"]')!.click(); await h.flush(); });
    assert.equal(bar()?.dataset.fit, undefined, 'возврат к девяти снимает лишнее сжатие');
    await act(async () => {
      for (let index = 2; index <= 9; index++) h.host.querySelector<HTMLElement>(`[data-mid="fit-${index}"]`)!.click();
      await h.flush();
    });
    tightWithReply = true;
    await h.rerender({ ...props, composerReplacement: createElement('div', null, 'Отправка ограничена') });
    assert.equal(bar()?.querySelectorAll('button').length, 2);
    assert.equal(bar()?.dataset.fit, undefined);
    await h.rerender(props);
    assert.equal(bar()?.querySelectorAll('button').length, 3);
    assert.equal(bar()?.dataset.fit, 'col', 'возвращение Ответить меняет измерение при прежней ширине');
    const first = bar();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await h.flush(); });
    assert.equal(bar(), null);
    assert.ok(observed.filter(entry => entry.target === first).every(entry => entry.disconnected), 'снятая панель отписана');
    await choose();
    assert.notEqual(bar(), first, 'повторно показана новая DOM-панель');
    assert.equal(bar()?.dataset.fit, 'col', 'новая панель тоже замерена без изменения ширины');
    assert.ok(observed.some(entry => entry.target === bar() && !entry.disconnected));
  } finally { try { h.unmount(); } finally { overrides.restore(); } }
});

for (const phone of [false, true])
  it(`${phone ? 'телефон' : 'ПК'}: меню читателей сохраняет весь список, имена контактов и реакцию, нажатие открывает профиль`, async () => {
    h.round12(); phone ? h.mobile() : h.desktop();
    const restore = h.pointerLayout(phone, phone ? 390 : 1200);
    const { api } = await h.server.ssrLoadModule('/src/api.ts') as typeof import('../api');
    const original = api.convReaders;
    const requests: string[][] = [];
    const readers = [
      { userId: 'reader-known', username: 'reader_one', displayName: 'Серверное имя', avatarUrl: '/server-avatar.png' },
      { userId: 'reader-other', username: 'reader_two', displayName: 'Другой читатель', avatarUrl: null },
    ];
    api.convReaders = async (conv, mid) => { requests.push([conv, mid]); return { items: readers }; };
    const message = { ...h.msg('readers-message', 'me', 60_000), reactions: [
      { emoji: '👍', count: 1, me: false, reactors: [{ userId: 'reader-known', at: new Date(h.now).toISOString() }] },
    ] } as Message;
    try {
      await h.mount({ messages: [message], peerReadKey: 20, readersConvId: 'readers-conversation',
        reactorOf: id => id === 'reader-known' ? { name: 'Контакт читателя', avatarUrl: '/contact-avatar.png' } : null });
      const row = h.host.querySelector<HTMLElement>('[data-mid="readers-message"]'); assert.ok(row);
      const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 100 });
      Object.defineProperty(context, 'pointerType', { value: phone ? 'touch' : 'mouse' });
      await act(async () => { row.dispatchEvent(context); await h.flush(); });
      const entry = document.querySelector<HTMLButtonElement>('.ctx-seen'); assert.ok(entry && !entry.disabled);
      assert.deepEqual(requests, [['readers-conversation', 'readers-message']], 'запрошен список правильного сообщения');
      await act(async () => { entry.click(); await h.flush(); });
      assert.equal(document.querySelector('.ctx-seen'), null, 'старое меню закрыто перед списком читателей');
      assert.match(document.querySelector('.who-head')?.textContent ?? '', /прочитали\s*2/);
      const rows = [...document.querySelectorAll<HTMLButtonElement>('.who-row')];
      assert.equal(rows.length, 2, 'в окне сохранён полный результат API');
      assert.deepEqual(rows.map(item => item.querySelector('.ctx-label-main')?.textContent), ['Контакт читателя', 'Другой читатель']);
      assert.equal(rows[0]!.querySelector('img')?.getAttribute('src'), '/contact-avatar.png', 'аватар контакта имеет приоритет');
      assert.equal(rows[0]!.querySelector('.seen-react')?.textContent, '👍');
      assert.equal(rows[1]!.querySelector('.seen-react'), null, 'реакция не приписана соседнему читателю');
      await act(async () => { rows[0]!.click(); await h.flush(); });
      assert.equal(document.querySelector('.who-head'), null, 'список закрыт при переходе');
      assert.equal(document.querySelector('.pcard-name')?.textContent, 'Контакт читателя', 'открыт сразу профиль выбранного читателя');
      assert.equal(document.querySelector('.pcard-ava img')?.getAttribute('src'), '/contact-avatar.png');
    } finally { try { h.unmount(); } finally { api.convReaders = original; restore(); h.desktop(); } }
  });

it('читатели не запрашиваются для чужого, непрочитанного, старого сообщения и беседы без этой возможности', async () => {
  h.round12(); h.desktop();
  const { api } = await h.server.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const original = api.convReaders;
  let requests = 0;
  api.convReaders = async () => { requests++; return { items: [] }; };
  try {
    for (const [author, readKey, convId, ago] of [
      ['peer', 20, 'readers-conversation', 60_000], ['me', 0, 'readers-conversation', 60_000],
      ['me', 20, null, 60_000], ['me', 20, 'readers-conversation', 8 * 24 * 60 * 60_000],
    ] as const) {
      await h.mount({ messages: [h.msg('unavailable-readers', author, ago)], peerReadKey: readKey, readersConvId: convId });
      const row = h.host.querySelector<HTMLElement>('[data-mid="unavailable-readers"]'); assert.ok(row);
      await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
      assert.equal(document.querySelector('.ctx-seen'), null);
      assert.equal(requests, 0, 'закрытая возможность не вызывает IO');
      h.unmount();
    }
  } finally { try { h.unmount(); } finally { api.convReaders = original; } }
});
