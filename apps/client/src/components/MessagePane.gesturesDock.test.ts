import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import { act } from 'react';
import type { ViteDevServer } from 'vite';
import type { Message } from '@gusvoice/shared';
import { sentAtLabel } from '../messagePaneRules';
import { TYPING_SEND_MS } from '../typing';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);

h.mutantTest('R117 в выборе настоящие кнопки голосового и кружка выбирают строки без звука; обычно играют', async () => {
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
      if (h.root) h.unmount(); player.closeVoice(); auto.setAutoDownload(previous);
      for (const { target, key, descriptor } of saved.reverse()) {
        if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
      }
      h.desktop(); restore();
    }
  }, 'выбор кнопки не вызывает настоящее play');
});

async function roundGestureCase(component: typeof h.Pane, runtime: ViteDevServer, check: (view: {
  button: HTMLButtonElement; video: HTMLVideoElement; row: HTMLElement; plays: () => number;
}) => Promise<void>) {
  const restore = h.pointerLayout(true, 390);
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
    button.getBoundingClientRect = () => new DOMRect(0, 0, 200, 200);
    let plays = 0, paused = true;
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
    Object.defineProperty(video, 'duration', { configurable: true, value: 10 });
    video.play = () => { paused = false; plays++; video.dispatchEvent(new Event('play')); return Promise.resolve(); };
    video.pause = () => { paused = true; video.dispatchEvent(new Event('pause')); };
    await check({ button, video, row, plays: () => plays });
  } finally {
    // Сработавшее удержание ставит capture-слушатели на window: завершение пальца убирает их даже при падении assert.
    const button = h.host?.querySelector('.round-msg-btn');
    if (button) await act(async () => { h.touch(button, 'touchcancel', 100, 100); });
    if (h.root) h.unmount();
    autoDownload.setAutoDownload(previous);
    h.desktop(); restore();
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

h.mutantTest('R114 удержание кружка открывает меню выбора; мутант исключает его как обычную кнопку', async () => {
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
  } finally { restore(); }
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
  } finally { restore(); }
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
h.mutantTest('quoteNames без подписи сохраняет имя ответа и пересылки', async () => {
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
  } finally { restore(); if (clip) Object.defineProperty(navigator, 'clipboard', clip); else Reflect.deleteProperty(navigator, 'clipboard'); }
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
    } finally { restore(); }
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
  const fixtureServer = await h.paneServer(undefined, 'MessagePane', true);
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
    const { MessagePane: fixturePane } = await fixtureServer.ssrLoadModule('/src/components/MessagePane.tsx') as typeof import('./MessagePane');
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
    const phoneMutant = match![1]!.replace('!dockPhone && ', '');
    assert.notEqual(phoneMutant, match![1], 'мутант снимает явный запрет dock для телефона');
    assert.equal(enabled(match![1]!, true), false, 'настоящий gate отключает колонку на телефоне');
    assert.equal(enabled(phoneMutant, true), true, 'исполняемый мутант включает её на телефоне');
    const pinGate = 'dock.canPin && hoverPanelsAvailable()';
    assert.ok(source.includes(`else if (${pinGate})`), 'найден gate, который не закрепляет у устройств без hover');
    const pin = (expr: string) => runInNewContext(`Boolean(${expr})`, { dock: { canPin: true }, hoverPanelsAvailable: () => false }) as boolean;
    assert.equal(pin(pinGate), false, 'touch-устройство не закрепляет поповер click-ом');
    assert.equal(pin('dock.canPin'), true, 'исполняемый mutant без проверки hover захватил бы клик');
  } finally {
    if (h.root) h.unmount(); localStorage.removeItem('gv_expr_dock');
    if (widthDesc) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthDesc); else Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
    h.desktop();
    await fixtureServer.close();
  }
});
it('закреплённый выбор стикеров сообщает только о движении внутри колонки, без idle-интервала', async () => {
  const fixtureServer = await h.paneServer(undefined, 'MessagePane', true);
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
    const { MessagePane: fixturePane } = await fixtureServer.ssrLoadModule('/src/components/MessagePane.tsx') as typeof import('./MessagePane');
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
      const dockedOr = (source: string) => source.replace(
        "const choosingSticker = !docked && !!picker && picker.kind === 'composer' && canSticker && exprTab === 'stickers';",
        "const choosingSticker = docked || (!!picker && picker.kind === 'composer' && canSticker && exprTab === 'stickers');");
      const missingClosest = (source: string) => source.replace(
        "if (e.target instanceof Element && e.target.closest('.sticker-pop.docked')) signalActionRef.current('sticker');",
        "if (e.target instanceof Element) signalActionRef.current('sticker');");
      for (const [label, mutation] of [['мутант добавляет docked ||', dockedOr], ['мутант убирает closest dock', missingClosest]] as const) {
        const mutantServer = await h.paneServer(mutation, 'MessagePane', true);
        try {
          const { MessagePane: mutantPane } = await mutantServer.ssrLoadModule('/src/components/MessagePane.tsx') as typeof import('./MessagePane');
          assert.equal(typeof mutantPane, 'function', `${label}: получен отдельный исходниковый мутант`);
          let scenarioFailure: unknown;
          try { await checkDockScenario(mutantPane); } catch (error) { scenarioFailure = error; }
          assert.ok(scenarioFailure instanceof assert.AssertionError, `${label} обязан нарушить тот же DOM-сценарий`);
        } finally { if (h.root) h.unmount(); await mutantServer.close(); }
      }
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
    if (h.root) h.unmount();
    Date.now = originalNow; window.setInterval = originalInterval; window.clearInterval = originalClear;
    restore(); if (widthDesc) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthDesc); else Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
    localStorage.removeItem('gv_expr_dock'); await fixtureServer.close();
  }
});
