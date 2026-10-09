import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BubbleMeta, DayDivider, MessageBubble, ReplyQuote, SelectCheck, ForwardedFrom } from './MessageBubble';
import { readFileSync } from 'node:fs';

for (const [status, title] of [['sending', 'Отправляется'], ['sent', 'Отправлено'], ['read', 'Прочитано'], ['failed', 'Не отправлено']] as const) {
  it(`отметка ${status} находится после времени и доступна как ${title}`, () => {
    const html = renderToStaticMarkup(createElement(BubbleMeta, { time: '12:34', edited: true, over: true, status }));
    assert.match(html, new RegExp(`class="bub-st ${status}"`)); assert.ok(html.indexOf('12:34') < html.indexOf('bub-st'));
    assert.ok(html.includes(`<title>${title}</title>`)); assert.match(html, /role="img"/); assert.match(html, /bub-meta over/);
  });
}
it('без статуса нет отметки, изменение статуса получает новый key для анимации', () => {
  assert.doesNotMatch(renderToStaticMarkup(createElement(BubbleMeta, { time: '12:34' })), /bub-st/);
  assert.match(readFileSync(new URL('./MessageBubble.tsx', import.meta.url), 'utf8'), /<span key=\{status\} className=/);
});
it('цитаты вложений рисуют миниатюру либо подходящий значок, удалённая не интерактивна', () => {
  for (const kind of ['photo', 'sticker', 'voice', 'file'] as const) {
    const html = renderToStaticMarkup(createElement(ReplyQuote, { author: 'A', text: 'T', kind }));
    assert.match(html, /reply-quote has-thumb/); assert.match(html, /rq-thumb icon/);
    assert.ok(html.indexOf('rq-thumb') < html.indexOf('rq-author'));
    if (kind === 'photo') { assert.match(html, /M15 8h\.01/); assert.doesNotMatch(html, /M15 10l4/); }
  }
  for (const kind of ['photo', 'sticker'] as const) {
    const html = renderToStaticMarkup(createElement(ReplyQuote, { author: 'A', text: 'T', kind, thumb: 'https://file.test/p.png' }));
    assert.match(html, /<img src="https:\/\/file.test\/p.png"/); if (kind === 'sticker') assert.match(html, /rq-thumb sticker/);
  }
  const gone = renderToStaticMarkup(createElement(ReplyQuote, { author: 'A', text: 'Удалено', kind: 'deleted' }));
  assert.match(gone, /<div class="reply-quote deleted">/); assert.doesNotMatch(gone, /button|rq-author|<svg|title=/);
});

it('пузырь передаёт атрибуты строке и классы стороны, группы, хвоста и активности', () => {
  const html = renderToStaticMarkup(createElement(MessageBubble, { side: 'out', grouped: true, active: true, className: 'sending', 'aria-live': 'polite', children: 'x' }));
  assert.match(html, /aria-live="polite"/); assert.match(html, /message bub mine grouped tail active sending/);
  assert.match(html, /message-main bubble/); assert.doesNotMatch(html, /msg-gutter|message-head/);
  const other = renderToStaticMarkup(createElement(MessageBubble, { side: 'in', tail: false, children: 'x' }));
  assert.match(other, /message bub theirs/); assert.doesNotMatch(other, / tail/);
});
it('вид и ширина применяются только к своему типу пузыря, jumbo не превышает три', () => {
  const render = (kind: 'text' | 'media' | 'emoji' | 'sticker') => renderToStaticMarkup(createElement(MessageBubble, { side: 'out', kind, jumbo: 9, mediaWidth: 240, mediaEnd: true, children: 'x' }));
  assert.match(render('media'), /bubble media media-end/); assert.match(render('media'), /width:240px/);
  assert.match(render('emoji'), /bubble emoji jumbo-3/); assert.doesNotMatch(render('emoji'), /width:|media-end/);
  assert.match(render('sticker'), /bubble sticker/); assert.doesNotMatch(render('text'), /jumbo-|media-end|width:/);
});
it('время, дневная метка и цитата сохраняют смысловую разметку без браузера', () => {
  const meta = renderToStaticMarkup(createElement(BubbleMeta, { time: '12:34', edited: true, over: true }));
  assert.match(meta, /bub-meta over/); assert.match(meta, /изм\. 12:34/);
  assert.match(renderToStaticMarkup(createElement(DayDivider, { label: 'Сегодня', pill: true })), /class="day-divider pill" role="separator"/);
  const quote = renderToStaticMarkup(createElement(ReplyQuote, { author: 'Имя', text: 'цитата' }));
  assert.match(quote, /<button type="button" class="reply-quote" title="Перейти к сообщению"/);
  assert.match(quote, /Имя/); assert.match(quote, /цитата/);
});

it('SelectCheck SSR скрывает декоративный кружок от скринридера и отражает выбранность', () => {
  // Значок не должен дублировать aria-checked строки, а выбранность обязана попадать в класс до гидрации.
  const off = renderToStaticMarkup(createElement(SelectCheck, { checked: false }));
  const on = renderToStaticMarkup(createElement(SelectCheck, { checked: true }));
  assert.match(off, /class="bub-slot start" aria-hidden="true"/);
  assert.match(off, /class="sel-check"/); assert.doesNotMatch(off, /sel-check on/);
  assert.match(on, /class="sel-check on"/); assert.match(on, /<svg/);
});

it('ForwardedFrom SSR не делает обезличенного автора ссылкой на профиль', () => {
  // У удалённого аккаунта нет доступной карточки; случайный button создаёт ложное обещание интерактивности.
  const inert = renderToStaticMarkup(createElement(ForwardedFrom, { name: 'Удалённый пользователь' }));
  const openable = renderToStaticMarkup(createElement(ForwardedFrom, { name: 'Учёный Кот', onOpen: () => {} }));
  assert.match(inert, /Переслано от <span class="bub-fwd-name">Удалённый пользователь<\/span>/);
  assert.doesNotMatch(inert, /<button/);
  assert.match(openable, /<button type="button" class="bub-fwd-name">Учёный Кот<\/button>/);
});
