import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createElement, act } from 'react';
import type { Message } from '@gusvoice/shared';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);


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
h.textSelMutantTest('мутант включает текст закрытого спойлера', checkTextNodesSkip);

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
h.textSelMutantTest('мутант расширяет промах выбора слова до 80 пикселей', checkWordSelGeometry);
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
  surface.body.addEventListener('touchstart', () => { reachedMessage++; });
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
  } finally { if (h.root) h.unmount(); restore(); surface.feed.remove(); }
}

// Слой должен остановить tap до обработчиков строки, иначе закрытие выделения тут же откроет меню сообщения.
h.textSelMutantTest('мутант пропускает touchstart из слоя к строке', async () => {
  const surface = h.textSurface('слово'); const restore = h.mockTextRangeRects(surface.node);
  let reachedMessage = 0;
  surface.body.addEventListener('touchstart', () => { reachedMessage++; });
  try {
    await h.mountTextSelLayer({ sel: { body: surface.body, start: 0, end: 5 }, onChange: () => {}, onClose: () => {}, onCopy: () => {} });
    h.touch(surface.body, 'touchstart', 40, 125);
    assert.equal(reachedMessage, 0, 'слой останавливает жест до обработчика строки и меню');
  } finally { if (h.root) h.unmount(); restore(); surface.feed.remove(); }
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
