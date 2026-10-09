import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import type { Message } from '@gusvoice/shared';
import { sentAtLabel } from '../messagePaneRules';
import { placeByAnchor, toLayoutRect } from '../popover';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);

async function checkAttachKey(component = h.Pane) {
  // Общий запрет браузерных клавиш не должен гасить прикрепление, а окно поверх не должно пропускать его в беседу.
  h.round12(); h.desktop(); await h.mount({ messages: [h.msg('attach-key')] }, component);
  h.host.classList.add('content'); // Как реальный контейнер MainLayout: поле и лента принадлежат одной области.
  const file = h.host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const field = h.host.querySelector<HTMLTextAreaElement>('.composer-input')!;
  const row = h.host.querySelector<HTMLElement>('[data-mid="attach-key"]')!;
  assert.ok(file && field && row);
  let opened = 0; file.click = () => { opened++; };
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
  field.setRangeText = ((replacement: string, start: number, end: number) => {
    breaks++;
    const value = field.value; setValue.call(field, value.slice(0, start) + replacement + value.slice(end));
    field.setSelectionRange(start + replacement.length, start + replacement.length);
  }) as typeof field.setRangeText;
  await act(async () => { setValue.call(field, 'ab'); field.dispatchEvent(new Event('input', { bubbles: true })); await h.flush(); });
  field.setSelectionRange(1, 1);
  const exec = Object.getOwnPropertyDescriptor(document, 'execCommand');
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
  try {
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })); await h.flush(); });
  } finally { if (exec) Object.defineProperty(document, 'execCommand', exec); else Reflect.deleteProperty(document, 'execCommand'); }
  assert.equal(breaks, 1, 'обработчик вызвал нативную вставку');
  assert.equal(field.value, 'a\nb'); assert.deepEqual(sent, []);
  await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); await h.flush(); });
  assert.deepEqual(sent, ['a\nb']);
}
it('Ctrl+Enter в обычном режиме вставляет перенос в поле, Ctrl+Shift+Enter отправляет один раз', async () => {
  await checkEnterLine();
  h.unmount();
  await h.rejectMutant((s) => {
    const needle = 'insertLineBreak(e.currentTarget);'; const at = s.lastIndexOf(needle); assert.ok(at > 0);
    return s.slice(0, at) + s.slice(at + needle.length);
  }, checkEnterLine);
});

it('внешний watchdog прерывает заблокированный event loop, не выдавая таймаут за пойманного мутанта', async () => {
  // Таймер в дочернем процессе не может прервать этот цикл: спасает только внешний kill + close.
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.GUSVOICE_PANE_MUTANT;
  await assert.rejects(() => h.isolatedProcess(['--eval', 'while (true) {}'], env, 'проверка watchdog', 150),
    (error: unknown) => error instanceof Error && !(error instanceof assert.AssertionError) && /Таймаут харнесса/.test(error.message));
});

it('галочки прочтения есть только у своих пузырей до ключа, чужие и каналы без отметок', async () => {
  const messages = [h.msg('m10', 'me', 0, 10), h.msg('m15', 'peer', 0, 15), h.msg('m20', 'me', 0, 20), h.msg('m30', 'me', 0, 30)];
  await h.mount({ messages, peerReadKey: 20 });
  for (const id of ['m10', 'm20']) assert.ok(h.host.querySelector(`[data-mid="${id}"] .bub-st.read`));
  assert.ok(h.host.querySelector('[data-mid="m30"] .bub-st.sent')); assert.equal(h.host.querySelector('[data-mid="m15"] .bub-st'), null);
  await h.rerender({ messages, peerReadKey: 30 }); assert.ok(h.host.querySelector('[data-mid="m30"] .bub-st.read'));
  await h.rerender({ messages, peerReadKey: null }); assert.equal(h.host.querySelector('.bub-st.read'), null);
  const list = h.host.querySelector('.messages');
  await h.rerender({ messages, bubbles: false, peerReadKey: 30 }); assert.equal(h.host.querySelector('.bub-st'), null);
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
  await act(async () => { del.click(); await h.delay(); }); assert.deepEqual(discarded, ['k']); assert.equal(document.querySelector('.ctx-menu'), null);
});
it('новое меню включается только переключателем и выключенное сохраняет старую ветку', async () => {
  // Проверка предотвращает регрессию, когда `bubbles: true` ошибочно включали без пользовательского переключателя.
  const message = h.msg('menu', 'me');
  await h.mount({ messages: [message], onReact: () => {} });
  const row = h.host.querySelector<HTMLElement>('[data-mid="menu"]')!;
  await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 140, clientY: 160 })); await h.flush(); });
  assert.ok(document.querySelector('.ctx-menu'), 'старое контекстное меню осталось при выключенном переключателе');
  assert.ok(!document.querySelector('.ctx-stack'), 'выключенный переключатель не рисует новую карточку');
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await h.flush();
  await act(async () => { h.root!.unmount(); }); h.root = null; h.host.remove();
  h.round12(); await h.mount({ messages: [message], peerReadKey: 10, onReact: () => {} });
  const enabledRow = h.host.querySelector<HTMLElement>('[data-mid="menu"]')!;
  await act(async () => { enabledRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 140, clientY: 160 })); await h.flush(); });
  const stack = document.querySelector('.ctx-stack'); assert.ok(stack, 'переключатель включает новую карточку меню');
  assert.deepEqual([...stack.querySelectorAll('.ctx-menu button')].map((b) => b.textContent?.trim()).filter(Boolean).slice(0, 3), ['Ответить', 'Изменить', 'Скопировать текст']);
  assert.ok(stack.querySelector('.react-bar'), 'меню показывает быстрые реакции'); assert.ok(stack.querySelector('.ctx-foot'), 'меню показывает подвал');
  assert.equal(stack.querySelector('.ctx-foot span:last-child')!.textContent, sentAtLabel(message.createdAt), 'DOM использует календарное время из sentAtLabel');
  assert.equal(stack.querySelector('svg title')?.textContent, 'Прочитано', 'галочка подвала следует ключу прочтения');
  const bar = stack.querySelector<HTMLElement>('.react-bar')!;
  bar.getBoundingClientRect = () => new DOMRect(180, 140, 248, 36);
  const width = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth');
  const height = Object.getOwnPropertyDescriptor(document.documentElement, 'clientHeight');
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1000 });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
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
  } finally { restoreNarrow(); }
});
it('привязанное меню следует за геометрией строки и закрывается, когда строка исчезает', async () => {
  // Ловит отрыв поповера от пузыря при перестройке ленты и зависшее меню у уже удалённого сообщения.
  h.round12(); const restore = h.pointerLayout(false, 600);
  const width = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth');
  const height = Object.getOwnPropertyDescriptor(document.documentElement, 'clientHeight');
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 600 });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  try {
    await h.mount({ messages: [h.msg('follow')], onReact: () => {} });
    const row = h.host.querySelector<HTMLElement>('[data-mid="follow"]')!;
    const main = row.querySelector<HTMLElement>('.message-main')!;
    const list = h.host.querySelector<HTMLElement>('.messages')!;
    let rowTop = 300;
    main.getBoundingClientRect = () => new DOMRect(70, rowTop, 220, 50);
    row.getBoundingClientRect = () => new DOMRect(40, rowTop - 10, 320, 70);
    list.getBoundingClientRect = () => new DOMRect(0, 0, 600, 700);
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
    restore();
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
  assert.ok(h.host.querySelector('.edit-strip')); assert.equal(h.host.querySelector('.edit-box'), null);
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
  } finally { restore(); }
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
    fine(); h.unmount(); const coarse = h.pointerLayout(true, 390);
    await h.mount({ messages: [h.msg('mouse-click')] });
    const mouseMain = h.host.querySelector<HTMLElement>('[data-mid="mouse-click"] .message-main'); assert.ok(mouseMain, 'есть цель клика мышью на coarse-устройстве');
    const mouseClick = new MouseEvent('click', { bubbles: true, cancelable: true }); Object.defineProperty(mouseClick, 'pointerType', { value: 'mouse' });
    await act(async () => { mouseMain!.dispatchEvent(mouseClick); await h.flush(); });
    assert.ok(!document.querySelector('.ctx-stack'), 'явный pointerType mouse не получает touch-меню из coarse media query');
    coarse();
  } finally { restore(); }
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
h.mutantTest('короткий клик ПК по микрофону переключает кружок, а не запускает запись', async () => {
  // На ПК отпускание раньше 120 мс — это выбор режима; обычная запись остаётся за длинным удержанием.
  await h.rejectMutant((source) => source.replace('onPointerUp={onDeskMicUpRound}', 'onPointerUp={onDeskMicUp}'), async (component) => {
    const recorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
    const media = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    const capture = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'captureStream');
    let requested = 0;
    class TestRecorder { static isTypeSupported() { return true; } }
    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: TestRecorder });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => { requested++; return new Promise<MediaStream>(() => {}); } } });
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: () => ({}) });
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
h.mutantTest('свой стикер нельзя редактировать через меню и телефонный лист', async () => {
  // Стикер — отправленное медиа без редактируемого текста: ни мышиное меню, ни лист пальца не обещают правку.
  await h.rejectMutant((source) => source.replaceAll(' && !m.sticker', ''), async (component) => {
    const sticker = { ...h.msg('own-sticker'), content: '', sticker: { id: 'sticker-1', emoji: '🦆', url: '/duck.webp', format: 'webp' } } as Message;
    const hasEdit = () => [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Изменить') || button.getAttribute('aria-label') === 'Изменить');

    h.desktop();
    await h.mount({ bubbles: false, messages: [sticker] }, component);
    await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="own-sticker"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
    assert.ok(document.querySelector('.ctx-menu'), 'меню своего стикера открылось');
    assert.ok(!hasEdit(), 'меню ПК не предлагает правку стикера');
    h.unmount();

    const restore = h.pointerLayout(true, 390); h.mobile(); localStorage.setItem('gv_dm_bubbles', '0');
    try {
      await h.mount({ bubbles: true, messages: [sticker] }, component);
      const stickerSurface = h.host.querySelector<HTMLElement>('[data-mid="own-sticker"] .message-sticker'); assert.ok(stickerSurface);
      await act(async () => { h.touch(stickerSurface!, 'touchstart'); await h.delay(560); });
      const sheet = document.querySelector('.sheet[role="dialog"]'); assert.ok(sheet, 'удержание открывает телефонный лист действий');
      assert.ok(![...sheet.querySelectorAll('button')].some((button) => button.textContent?.includes('Изменить')), 'телефонный лист не предлагает правку стикера');
      h.unmount();

      await h.mount({ bubbles: true, messages: [sticker] }, component);
      await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="own-sticker"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
      assert.ok(document.querySelector('.ctx-menu'), 'меню сообщения доступно для проверки');
      assert.ok(!hasEdit(), 'контекстное меню личного пузыря не предлагает правку стикера');
      h.unmount();

    } finally { h.desktop(); restore(); }

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
h.mutantTest('служебное действие группы рисуется отдельной пилюлей, незнакомый вид обычным сообщением', async () => {
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
