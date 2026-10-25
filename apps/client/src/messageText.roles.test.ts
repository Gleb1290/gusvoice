import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMessageText } from './messageText.js';

function render(text: string, roleNames?: readonly string[]) {
  return renderToStaticMarkup(createElement(Fragment, null,
    ...renderMessageText(text, (url, key) => createElement('a', { key, href: url }, url), undefined, roleNames)));
}

it('R266 кириллическая роль с пробелом подсвечивается целиком только из переданного списка', () => {
  assert.equal(render('@Ночная смена!', ['Ночная смена']), '<span class="mention">@Ночная смена</span>!');
  assert.equal(render('@Ночная смена!'), '@Ночная смена!');
  assert.equal(render('@Ночная смена!', ['Модераторы']), '@Ночная смена!');
});

it('R266 короткая роль первой не отрезает хвост длинного названия при подсветке', () => {
  assert.equal(render('@Ночная смена и @Ночная', ['Ночная', 'Ночная смена']),
    '<span class="mention">@Ночная смена</span> и <span class="mention">@Ночная</span>');
});

it('R266 правый край роли отличает отдельное обращение от начала другого слова', () => {
  assert.equal(render('@Модераторы!', ['Модераторы']), '<span class="mention">@Модераторы</span>!');
  for (const tail of ['X', 'ы', '1', '_']) {
    assert.equal(render(`@Модераторы${tail}`, ['Модераторы']), `@Модераторы${tail}`);
  }
});

it('R266 почта не подсвечивается даже при совпадении доменной части с ролью', () => {
  assert.equal(render('x@Модераторы юзер@Модераторы foo+@Модераторы', ['Модераторы']),
    'x@Модераторы юзер@Модераторы foo+@Модераторы');
  assert.equal(render('x @Модераторы', ['Модераторы']), 'x <span class="mention">@Модераторы</span>');
});

it('R266 роль в жирном, курсиве, цитате и спойлере использует тот же список', () => {
  assert.equal(render('**@Ночная смена**', ['Ночная смена']), '<strong><span class="mention">@Ночная смена</span></strong>');
  assert.equal(render('*@Ночная смена*', ['Ночная смена']), '<em><span class="mention">@Ночная смена</span></em>');
  assert.ok(render('> @Ночная смена', ['Ночная смена']).includes('<blockquote class="md-quote"><span class="mention">@Ночная смена</span>'));
  assert.ok(render('||@Ночная смена||', ['Ночная смена']).includes('<span class="mention">@Ночная смена</span>'));
});

it('R266 строковый и блочный код не превращают роль в пинг', () => {
  assert.equal(render('`@Ночная смена`', ['Ночная смена']), '<code class="md-code">@Ночная смена</code>');
  assert.equal(render('```\n@Ночная смена\n```', ['Ночная смена']), '<pre class="md-pre"><code>@Ночная смена</code></pre>');
});

it('R266 метасимволы названия подсвечиваются буквально и не расширяют поиск', () => {
  assert.equal(render('@C++ (ops) [v2].?', ['C++ (ops) [v2].?']), '<span class="mention">@C++ (ops) [v2].?</span>');
  assert.equal(render('@Модераторыы', ['Модераторы?']), '@Модераторыы');
});

it('R266 HTML в названии роли остаётся видимым текстом, а не элементом', () => {
  const html = render('@<img src=x onerror=alert(1)>', ['<img src=x onerror=alert(1)>']);
  assert.equal(html, '<span class="mention">@&lt;img src=x onerror=alert(1)&gt;</span>');
  assert.ok(!html.includes('<img'));
});

it('R266 добавление слота роли не сдвигает личные, гостевые и общие упоминания', () => {
  assert.equal(render('@super @vasya@friend.example @everyone @here', ['Ночная смена']),
    '<span class="mention">@super</span> <span class="mention">@vasya@friend.example</span> <span class="mention">@everyone</span> <span class="mention">@here</span>');
  assert.equal(render('user@super.dev', ['Ночная смена']), 'user@super.dev');
});

it('R266 ссылка, эмодзи и опасный HTML сохраняют старые слоты при наличии ролей', () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, ...renderMessageText(
    'https://example.test/x :party: <script> @Модераторы',
    (url, key) => createElement('a', { key, href: url }, url),
    name => name === 'party' ? 'https://cdn.test/party.webp' : null,
    ['Модераторы'],
  )));
  assert.ok(html.includes('<a href="https://example.test/x">https://example.test/x</a>'));
  assert.ok(html.includes('class="custom-emoji"'));
  assert.ok(html.includes('alt=":party:"'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('<span class="mention">@Модераторы</span>'));
});

it('R266 кеш регулярки не переносит роли между сообщениями и не теряет повторные совпадения', () => {
  const expected = '<span class="mention">@Модераторы</span> <span class="mention">@Модераторы</span>';
  assert.equal(render('@Модераторы @Модераторы', ['Модераторы']), expected);
  assert.equal(render('@Модераторы', ['Ночная смена']), '@Модераторы');
  assert.equal(render('@Модераторы @Модераторы', ['Модераторы']), expected);
  assert.equal(render('@Модераторы', ['', ' ']), '@Модераторы');
});
