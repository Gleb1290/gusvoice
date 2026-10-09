import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import type { DmChannel, Message } from '@gusvoice/shared';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);

it('плавающий день не появляется на программный scroll, появляется на wheel и гаснет', async () => {
  await h.mount({ messages: [h.msg('top')] }); const list = h.host.querySelector<HTMLElement>('.messages')!;
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => h.host.querySelector('[data-mid="top"]') });
  await act(async () => { list.dispatchEvent(new Event('scroll')); await h.delay(40); }); assert.equal(h.host.querySelector('.bub-float.on'), null);
  await act(async () => { list.dispatchEvent(new Event('wheel')); list.dispatchEvent(new Event('scroll')); await h.delay(40); });
  assert.ok(h.host.querySelector('.bub-float.on')); await act(async () => { await h.delay(1550); }); assert.equal(h.host.querySelector('.bub-float.on'), null);
});
h.mutantTest('стрелка вверх редактирует последнее своё обычное сообщение, пропуская стикер и пересылку', async () => {
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
    assert.equal(h.host.querySelector('.edit-box'), null, 'inline правки больше нет');
  };
  await h.rejectMutant((source) => source.replace(
    'm.author.id === meId && !m.forwardedFrom && !m.sticker',
    'm.author.id === meId',
  ), chooseLastEditable, 'пересланная строка и стикер не становятся целью правки');
});
it('клавиши поля, повтор и пробел кнопки не зовут дату, PageDown ленты зовёт', async () => {
  // Ловит ложную пилюлю от редактирования текста или нажатия действия сообщения.
  await h.mount({ messages: [h.msg('top')] }); const list = h.host.querySelector<HTMLElement>('.messages')!;
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => h.host.querySelector('[data-mid="top"]') });
  const input = document.createElement('textarea'); const button = document.createElement('button'); list.append(input, button);
  for (const [target, key, repeat] of [[input, 'PageDown', false], [button, ' ', false], [list, 'PageDown', true]] as const) {
    await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, repeat, bubbles: true })); list.dispatchEvent(new Event('scroll')); await h.delay(40); });
    assert.equal(h.host.querySelector('.bub-float.on'), null);
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
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => h.host.querySelector('[data-mid="top"]') });
  await act(async () => { list.dispatchEvent(new Event('wheel')); list.dispatchEvent(new Event('scroll')); await h.delay(40); });
  // Каждый следующий кадр укладывается в окно 300 мс, хотя с wheel прошла уже секунда.
  for (let i = 0; i < 5; i++) await act(async () => { await h.delay(190); list.dispatchEvent(new Event('scroll')); await h.delay(30); });
  assert.ok(h.host.querySelector('.bub-float.on'));
  await act(async () => { await h.delay(350); list.dispatchEvent(new Event('scroll')); await h.delay(40); });
  await act(async () => { await h.delay(1200); }); assert.equal(h.host.querySelector('.bub-float.on'), null);
});
it('меньше движения не отменяет исчезновение даты через полторы секунды', async () => {
  // Ловит прежний условный таймер, оставлявший пилюлю навсегда при reduced-motion.
  const match = window.matchMedia.bind(window);
  window.matchMedia = (query) => { const result = match(query); if (query.includes('prefers-reduced-motion')) Object.defineProperty(result, 'matches', { value: true }); return result; };
  try {
    assert.equal(window.matchMedia('(prefers-reduced-motion: reduce)').matches, true);
    await h.mount({ messages: [h.msg('top')] }); const list = h.host.querySelector<HTMLElement>('.messages')!;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => h.host.querySelector('[data-mid="top"]') });
    await act(async () => { list.dispatchEvent(new Event('touchmove', { bubbles: true })); list.dispatchEvent(new Event('scroll')); await h.delay(40); });
    assert.ok(h.host.querySelector('.bub-float.on')); await act(async () => { await h.delay(1550); }); assert.equal(h.host.querySelector('.bub-float.on'), null);
  } finally { window.matchMedia = match; }
});
it('на телефоне ошибка открывает лист с фокусом, Escape возвращает кнопку', async () => {
  // Ловит десктопное меню вместо доступного мобильного диалога.
  h.mobile(); await h.mount({ outbox: h.queue() }); const button = h.host.querySelector<HTMLButtonElement>('.bub-fail-btn')!;
  assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
  await act(async () => { button.click(); }); await h.flush();
  const sheet = document.querySelector('.sheet[role="dialog"]'); assert.ok(sheet); assert.match(sheet.textContent!, /Ваше сообщение/);
  assert.equal(document.querySelector('.ctx-menu'), null); assert.ok(document.activeElement === sheet.querySelector('.sheet-row'));
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); }); await h.flush();
  assert.equal(document.querySelector('.sheet'), null); assert.ok(document.activeElement === button);
});
for (const outgoing of [false, true]) {
  it(`долгое касание ${outgoing ? 'ошибки' : 'сообщения'} не нажимает открытый лист при отпускании`, async () => {
    // Ловит синтетический click по строке листа, открывшегося под тем же пальцем.
    h.mobile(); const copies: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copies.push(text); } } });
    await h.mount(outgoing ? { outbox: h.queue() } : { messages: [h.msg('top')], onReact: () => {} });
    const body = h.host.querySelector('.message-body')!;
    await act(async () => { h.touch(body, 'touchstart'); await h.delay(560); });
    const sheet = document.querySelector('.sheet[role="dialog"]')!; assert.ok(sheet);
    const copy = [...sheet.querySelectorAll<HTMLButtonElement>('.sheet-row')].find((b) => b.textContent?.includes('Скопировать текст'))!; assert.ok(copy);
    let end!: Event; await act(async () => { end = h.touch(body, 'touchend'); }); assert.equal(end.defaultPrevented, true);
    const first = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { copy.dispatchEvent(first); }); assert.equal(first.defaultPrevented, true); assert.equal(copies.length, 0); assert.ok(document.querySelector('.sheet'));
    await act(async () => { await h.delay(450); }); await act(async () => { copy.click(); });
    assert.deepEqual(copies, [outgoing ? 'failed' : 'top']);
    if (!outgoing) {
      // Разметка реакций проверяется до закрытия листа отдельным повторным открытием.
      await act(async () => { h.touch(body, 'touchstart'); await h.delay(560); });
      const more = document.querySelector('.sheet-react.more')!; assert.ok(more);
      assert.equal(more.getAttribute('aria-label'), 'Все реакции'); assert.equal(more.getAttribute('title'), null);
      assert.ok(more.querySelector('svg[width="22"] path[d="M6 9 L12 15 L18 9"]'));
      assert.deepEqual([...document.querySelectorAll('.sheet-react:not(.more)')].map((b) => b.textContent), ['👍', '🔥', '😂', '❤️', '🦆']);
      await act(async () => { h.touch(body, 'touchcancel'); });
    }
  });
}
it('короткий тап, движение пальца и отпускание другой цели не поглощают клик', async () => {
  // Парное принятие обычного жеста: защита long-press не должна блокировать следующие действия.
  h.mobile(); await h.mount({ messages: [h.msg('top')] }); const body = h.host.querySelector('.message-body')!;
  await act(async () => { h.touch(body, 'touchstart'); await h.delay(100); });
  let ended!: Event; await act(async () => { ended = h.touch(body, 'touchend'); }); assert.equal(ended.defaultPrevented, false); assert.equal(document.querySelector('.sheet'), null);
  await act(async () => { h.touch(body, 'touchstart'); h.touch(body, 'touchmove', 11); await h.delay(560); });
  assert.equal(document.querySelector('.sheet'), null); await act(async () => { ended = h.touch(body, 'touchend'); }); assert.equal(ended.defaultPrevented, false);
  await act(async () => { h.touch(body, 'touchstart'); await h.delay(560); }); assert.ok(document.querySelector('.sheet'));
  const other = document.querySelector('.sheet-row')!; await act(async () => { ended = h.touch(other, 'touchend'); }); assert.equal(ended.defaultPrevented, false);
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  let clicked = false; other.addEventListener('click', () => { clicked = true; });
  await act(async () => { other.dispatchEvent(click); }); assert.equal(click.defaultPrevented, false); assert.equal(clicked, true);
});
it('широкая группа показывает мой аватар только у последней исходящей строки', async () => {
  // Ловит пустую колонку/повтор аватара и проверяет, что на телефоне его профильный тап не открывает меню сообщения.
  h.round12(); const restore = h.pointerLayout(true, 390);
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 900 });
  try {
    await h.mount({ messages: [h.msg('saved', 'me', 180000)], outbox: h.queue() });
    assert.ok(h.host.querySelector('.messages.bub-left'));
    const rows = h.host.querySelectorAll('.message.bub'); assert.equal(rows[0]!.querySelector('.bub-ava .msg-ava'), null);
    assert.ok(rows[1]!.querySelector('.bub-ava .msg-ava')); assert.ok(rows[1]!.nextElementSibling?.classList.contains('bub-fail'));
    const avatar = rows[1]!.querySelector<HTMLElement>('.msg-ava')!;
    await act(async () => { avatar.click(); await h.flush(); }); assert.ok(!document.querySelector('.ctx-stack'), 'аватар открывает профиль, не меню сообщения');
  } finally {
    restore();
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'clientWidth', descriptor); else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  }
});
h.mutantTest('удержание входящего аватара открывает человека, а короткий тап — профиль', async () => {
  // Удержание на аватаре не должно проваливаться в действия сообщения; короткий тап сохраняет прежний профильный путь.
  await h.rejectMutant((source) => source.replace(
    "if (target.closest('.msg-ava') && isMobile() && e.touches.length === 1) {",
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
    } finally { h.desktop(); restore(); }
  });
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
  localStorage.setItem('gv_dm_bubbles', '1'); localStorage.setItem('gv_feed_window', '0');
  const { DmChatView } = await h.server.ssrLoadModule('/src/components/DmChatView.tsx') as typeof import('./DmChatView');
  const { useStore } = await h.server.ssrLoadModule('/src/store.ts') as typeof import('../store');
  h.resetStore = () => useStore.getState().convReset();
  const peer = { id: 'peer', username: 'peer', displayName: 'Peer', avatarUrl: null };
  const dm = { id: 'c', otherUser: peer, createdAt: new Date(h.now).toISOString(), lastMessageAt: null } as DmChannel;
  const summary = { ...dm, kind: 'direct' as const, lastMessage: null, lastReadKey: 0, unread: 3, peerReadKey: 20 };
  const messages = [h.msg('m10', 'me', 0, 10), h.msg('m15', 'peer', 0, 15), h.msg('m20', 'me', 0, 20), h.msg('m30', 'me', 0, 30)];
  useStore.setState({ convActive: true, user: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null } as never,
    conv: { ...useStore.getState().conv, phase: 'live', pts: 100, summaries: { c: summary }, summaryPts: { c: 100 } },
    dmMessages: { c: messages }, unreadDms: ['c'], dms: [dm], currentDmId: 'c', view: 'dm', drafts: {}, draftRev: {}, outbox: {} });
  h.host = document.createElement('div'); document.body.append(h.host); h.root = createRoot(h.host);
  await act(async () => { h.root!.render(createElement(DmChatView, { dm })); }); await h.flush();
  const list = h.host.querySelector('.messages'); assert.ok(list); h.rendered.length = 0;
  const unread = useStore.getState().unreadDms;
  await act(async () => { useStore.getState().convOnChange({ pts: 101, conversation: { ...summary, peerReadKey: 30 } }, false); });
  assert.equal(useStore.getState().conv.pts, 101); assert.equal(useStore.getState().conv.summaries.c.peerReadKey, 30);
  assert.ok(h.host.querySelector('[data-mid="m30"] .bub-st.read')); assert.deepEqual(h.rendered, ['m30']);
  assert.ok(h.host.querySelector('.messages') === list); assert.deepEqual(useStore.getState().unreadDms, unread);
  h.rendered.length = 0;
  await act(async () => { useStore.getState().convOnChange({ pts: 101, conversation: { ...summary, peerReadKey: 30 } }, false); });
  assert.deepEqual(h.rendered, []);
  await act(async () => { h.root!.unmount(); }); h.root = createRoot(h.host);
  useStore.setState({ convActive: false, dmMessages: { c: messages.map(({ sortKey: _key, ...m }) => m) } });
  await act(async () => { h.root!.render(createElement(DmChatView, { dm })); }); assert.equal(h.host.querySelector('.bub-st.read'), null);
  await act(async () => { h.root!.unmount(); }); h.root = createRoot(h.host);
  localStorage.setItem('gv_dm_bubbles', '0'); useStore.setState({ convActive: true, dmMessages: { c: messages } });
  await act(async () => { h.root!.render(createElement(DmChatView, { dm })); }); assert.equal(h.host.querySelector('.bub-st'), null);
  localStorage.setItem('gv_dm_bubbles', '0'); localStorage.removeItem('gv_feed_window');
});
h.mutantTest('мутант без read-статуса не проходит настоящий DOM-сценарий галочек', async () => {
  // Ловит возврат всегда одинарной галочки у своих сообщений.
  await h.rejectMutant((s) => s.replace("mine ? (read ? 'read' : 'sent') : undefined", "mine ? 'sent' : undefined"), async (component) => {
    await h.mount({ messages: [h.msg('read', 'me', 0, 20)], peerReadKey: 20 }, component);
    assert.ok(h.host.querySelector('[data-mid="read"] .bub-st.read'), 'прочитанное своё сообщение имеет двойную галочку');
  });
});
h.mutantTest('мутант с сырым ключом строки ломает точечную перерисовку', async () => {
  // Ловит пропс, одинаково меняющийся у всех четырёх memo-строк при чужом прочтении.
  await h.rejectMutant((s) => s.replace('<MessageRow\n', '<MessageRow peerReadKeyRaw={p.peerReadKey}\n'), async (component) => {
    const messages = [h.msg('m10', 'me', 0, 10), h.msg('m15', 'peer', 0, 15), h.msg('m20', 'me', 0, 20), h.msg('m30', 'me', 0, 30)];
    await h.mount({ messages, peerReadKey: 20 }, component); h.rendered.length = 0;
    await act(async () => { h.root!.render(createElement(component, { ...h.base, messages, peerReadKey: 30 })); });
    assert.deepEqual(h.rendered, ['m30']);
  });
});
h.mutantTest('мутант без проверки человеческого ввода показывает дату на программный scroll', async () => {
  // Ловит тихий возврат пилюли при открытии беседы или догрузке картинки.
  await h.rejectMutant((s) => s.replace('if (now - human > HUMAN_SCROLL_MS) return;', ''), async (component) => {
    h.round12(); h.desktop();
    await h.mount({ messages: [h.msg('top')] }, component); const list = h.host.querySelector<HTMLElement>('.messages')!;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => h.host.querySelector('[data-mid="top"]') });
    await act(async () => { list.dispatchEvent(new Event('scroll')); await h.delay(40); });
    assert.equal(h.host.querySelector('.bub-float.on') !== null, false);
  });
});
h.mutantTest('мутант без перевода фокуса проваливает меню ошибки с клавиатуры', async () => {
  // Ловит открытый портал, в который Tab от исходной кнопки не попадает.
  await h.rejectMutant((s) => s.replace("open[open.length - 1]?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();", ''), async (component) => {
    h.round12(); h.desktop();
    await h.mount({ outbox: h.queue() }, component); const button = h.host.querySelector<HTMLButtonElement>('.bub-fail-btn')!;
    await act(async () => { button.click(); }); await h.flush();
    assert.ok(document.activeElement === document.querySelector('.ctx-menu button'), 'фокус на первом пункте меню');
  });
});
h.mutantTest('мутант условного таймера оставляет reduced-motion дату висеть', async () => {
  // Ловит прежнее исключение гашения в режиме «меньше движения».
  const match = window.matchMedia.bind(window);
  window.matchMedia = (query) => { const result = match(query); if (query.includes('prefers-reduced-motion')) Object.defineProperty(result, 'matches', { value: true }); return result; };
  try {
    await h.rejectMutant((s) => s.replace('hide = window.setTimeout(', "if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) hide = window.setTimeout("), async (component) => {
      await h.mount({ messages: [h.msg('top')] }, component); const list = h.host.querySelector<HTMLElement>('.messages')!;
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => h.host.querySelector('[data-mid="top"]') });
      await act(async () => { list.dispatchEvent(new Event('wheel')); list.dispatchEvent(new Event('scroll')); await h.delay(40); });
      assert.ok(h.host.querySelector('.bub-float.on'), 'человеческая прокрутка показывает дату'); await act(async () => { await h.delay(1550); });
      assert.equal(h.host.querySelector('.bub-float.on') !== null, false);
    });
  } finally { window.matchMedia = match; }
});
h.mutantTest('мутант без защиты отпускания пальца проваливает long-press сценарий', async () => {
  // Ловит синтетический click из касания, открывшего мобильный лист.
  h.mobile();
  await h.rejectMutant((s) => s.replace("if (e.type === 'touchend' && e.target === from)", 'if (false)'), async (component) => {
    await h.mount({ messages: [h.msg('top')] }, component); const body = h.host.querySelector('.message-body')!;
    await act(async () => { h.touch(body, 'touchstart'); await h.delay(560); }); assert.ok(document.querySelector('.sheet'), 'long-press открывает лист');
    let ended!: Event; await act(async () => { ended = h.touch(body, 'touchend'); }); assert.equal(ended.defaultPrevented, true);
  });
});
h.mutantTest('мутант без группировки сохранённого с очередью оставляет лишний хвост', async () => {
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
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => h.host.querySelector('[data-mid="top"]') });
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
it('защита клика после long-press сама истекает, даже если первого клика не было', async () => {
  // Ловит вечный capture-слушатель, который съедает следующий нормальный клик спустя секунды.
  h.mobile(); const copies: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copies.push(text); } } });
  await h.mount({ outbox: h.queue() }); const body = h.host.querySelector('.message-body')!;
  await act(async () => { h.touch(body, 'touchstart'); await h.delay(560); });
  await act(async () => { h.touch(body, 'touchend'); }); await act(async () => { await h.delay(450); });
  const copy = [...document.querySelectorAll<HTMLButtonElement>('.sheet-row')].find((b) => b.textContent?.includes('Скопировать текст'))!;
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => { copy.dispatchEvent(click); }); assert.equal(click.defaultPrevented, false); assert.deepEqual(copies, ['failed']);
});
it('долгое касание выбирает в личной пачке, но остаётся меню без batch и в канале', async () => {
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
    assert.ok(h.host.querySelector('.sel-head'), 'долгое касание в DM входит в выделение');
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
