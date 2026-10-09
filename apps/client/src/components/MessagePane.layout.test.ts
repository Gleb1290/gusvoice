import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createElement, act } from 'react';
import type { Message } from '@gusvoice/shared';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);


async function checkChannelHintAnchor(component: typeof h.Pane) {
  let release!: (hasMore: boolean) => void;
  let calls = 0;
  const older = new Promise<boolean>((resolve) => { release = resolve; });
  await h.mount({ bubbles: false, messages: [h.msg('chan-hint-anchor')], onLoadOlder: () => { calls++; return older; } }, component);
  const list = h.host.querySelector<HTMLElement>('.messages');
  const row = h.host.querySelector<HTMLElement>('[data-mid="chan-hint-anchor"]');
  assert.ok(list, 'канальная лента без окна смонтирована');
  assert.ok(row, 'видимая строка канала доступна как якорь');
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 2000 });
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 600 });
  list.getBoundingClientRect = () => new DOMRect(0, 0, 320, 600);
  row.getBoundingClientRect = () => new DOMRect(0, (h.host.querySelector('.older-hint') ? 43 : 10) - list.scrollTop, 200, 30);
  await act(async () => { list.dispatchEvent(new Event('scroll')); await h.flush(); });
  assert.equal(calls, 1, 'достижение верхней границы начинает загрузку истории');
  assert.ok(h.host.querySelector('.older-hint'), 'пока запрос открыт, подсказка появилась над строкой');
  assert.equal(list.scrollTop, 33, 'подсказка высотой 33 px компенсируется прокруткой');
  assert.equal(row.getBoundingClientRect().top, 10, 'канальная строка остаётся на прежней экранной отметке');
  release(true);
  await act(async () => { await older; await h.flush(); });
}

h.mutantTest('мутант без канального эффекта отпускает строку при появлении подсказки', async () => {
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
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => prepended ? 2100 : 2000 });
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
  list.getBoundingClientRect = () => new DOMRect(0, 0, 320, 600);
  row.getBoundingClientRect = () => {
    const top = 110 + (h.host.querySelector('.older-hint') ? 33 : 0) + (prepended ? 10 : 0) - scrollTop;
    const height = prepended ? 20 : 30;
    return new DOMRect(0, top, 200, height);
  };
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

h.mutantTest('мутант держит верх строки вместо низа при схлопывании шапки канала', async () => {
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
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => prepended ? 2100 : 2000 });
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
  list.getBoundingClientRect = () => new DOMRect(0, 0, 320, 600);
  row.getBoundingClientRect = () => new DOMRect(0, 10 + (h.host.querySelector('.older-hint') ? 33 : 0) + (prepended ? 30 : 0) - scrollTop, 200, 30);
  next.getBoundingClientRect = () => new DOMRect(0, 130 + (h.host.querySelector('.older-hint') ? 33 : 0) + (prepended ? 30 : 0) - scrollTop, 200, 30);
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
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
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

h.mutantTest('мутант теряет сообщение для меню «⋯» после снятия выделения', async () => {
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
  Object.defineProperty(field, 'blur', { configurable: true, value: () => { blurStacks.push(new Error().stack ?? ''); nativeBlur(); } });
  await act(async () => { field.focus(); await h.flush(); });
  assert.ok(document.activeElement === field, 'перед меню пользователь действительно печатал в поле');
  await act(async () => { button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const later = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.includes('Отправить позже'));
  assert.ok(later, 'меню предлагает открыть календарь');
  await act(async () => { later.click(); await h.flush(); });
  assert.ok(document.querySelector('.sched-pick'), 'лист планирования открыт');
  assert.ok(blurStacks.some((stack) => stack.includes('openLater')), 'именно открытие расписания явно снимает фокус, не последующий modal effect');
  assert.notEqual(document.activeElement, field, 'открытый лист не оставляет фокус и клавиатуру поверх времени');
  const close = document.querySelector<HTMLButtonElement>('.sched-pick .modal-actions .link');
  assert.ok(close, 'окно планирования даёт отменить выбор без отправки');
  act(() => { close.click(); });
  await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); await h.delay(40); await h.flush(); });
  assert.ok(document.activeElement === field, 'закрытие без выбора возвращает ранее активное поле');
  if (priorBlur) Object.defineProperty(field, 'blur', priorBlur); else Reflect.deleteProperty(field, 'blur');
}

h.mutantTest('мутант не снимает фокус с поля при открытии планирования', async () => {
  // На телефоне оставшаяся клавиатура перекрывает время и подтверждение расписания.
  const omitBlur = (source: string) => {
    const changed = source.replace('    if (focused) field.blur();', '    /* mutant: поле остаётся активным */');
    assert.notEqual(changed, source, 'найдено снятие фокуса при открытии SchedPick');
    return changed;
  };
  await h.rejectMutant(omitBlur, openLaterAndClose);
});

h.mutantTest('мутант не возвращает фокус после закрытия календаря без отправки', async () => {
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
      if (phone) assert.notEqual(document.activeElement, field, 'после выбора на телефоне фокус не поднимает клавиатуру');
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
  Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 1000 + (Number.parseFloat(h.host.querySelector<HTMLElement>('.messages > :last-child')?.style.height ?? '') || 0) });
  Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = Math.min(value, list.scrollHeight - list.clientHeight); } });
  const top = (index: number) => 200 + index * 60 + (list.classList.contains('sel-mode') ? 40 : 0) - (scrollTop - 390);
  allRows.forEach((element, index) => { element.getBoundingClientRect = () => new DOMRect(0, top(index), 320, 40); });
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
  allRows.forEach((element, index) => { element.getBoundingClientRect = () => new DOMRect(0, top(index), 320, 40); });
  const dragStartTop = top(0);
  await act(async () => { pointer(allRows[0]!, 'pointerdown'); pointer(window as unknown as Element, 'pointermove', { clientY: 220, buttons: 1 }); await h.flush(); });
  assert.ok(h.host.querySelector('.sel-head'), 'протяжка рядом со строкой начинает выделение');
  assert.equal(top(0), dragStartTop, 'протяжка при том же reply-strip сохраняет строку входа');
  assert.equal(h.host.querySelectorAll('.message[aria-checked="true"]').length, 1, 'короткая протяжка выбирает только начальную строку');
  await act(async () => { pointer(window as unknown as Element, 'pointerup', { buttons: 0 }); await h.flush(); });
}

h.mutantTest('мутант не сохраняет строку при входе удержанием или протяжкой поверх reply-strip', async () => {
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
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: ControlledResizeObserver });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() {
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
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
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

h.mutantTest('мутант не прибавляет высоту схлопнувшейся ленты к scrollTop', async () => {
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
  } finally { useToasts.setState((s) => ({ ...s, toasts: [] })); }
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
    } finally { mouseLayout(); }
  } finally { if (h.root) h.unmount(); h.desktop(); restore(); }
});
