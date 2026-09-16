import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMessageText } from './messageText.js';

/**
 * Разметка сообщений.
 *
 * Главное здесь — не «жирный работает», а то, что текст пользователя НИКОГДА не становится
 * разметкой. Это единственное место, куда любой участник пишет что угодно, и рендер идёт через
 * React-узлы без `dangerouslySetInnerHTML`. Тест это фиксирует: вставили тег — он обязан приехать
 * как ВИДИМЫЙ текст, а не как элемент.
 */
// Без JSX намеренно: так тест не зависит от того, какой jsx-рантайм соберёт файл.
const render = (s: string, onEmoji?: (name: string) => string | null) =>
  renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      ...renderMessageText(s, (url, key) => createElement('a', { key, href: url }, url), onEmoji),
    ),
  );

describe('текст пользователя не становится разметкой', () => {
  const атаки = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<svg/onload=alert(1)>',
    '</div><script>alert(1)</script>',
    '<a href="javascript:alert(1)">клик</a>',
    '<style>body{display:none}</style>',
  ];
  for (const s of атаки) {
    it(`экранирует: ${s.slice(0, 34)}`, () => {
      const html = render(s);
      // Проверяем отсутствие ОТКРЫВАЮЩИХ тегов из полезной нагрузки, а не подстрок вроде
      // «onerror=»: в экранированном виде такой текст в выводе есть и это нормально —
      // он показывается как буквы, а не исполняется.
      for (const tag of ['<script', '<iframe', '<img', '<svg', '<style', '<a href="javascript:']) {
        assert.ok(!html.includes(tag), `просочился ${tag}`);
      }
      // Каждая угловая скобка исходного текста обязана приехать экранированной.
      const angles = (s.match(/</g) ?? []).length;
      assert.equal((html.match(/&lt;/g) ?? []).length, angles, 'часть «<» не экранирована');
    });
  }

  it('опасный текст виден пользователю как текст', () => {
    // Экранировать — мало: сообщение должно остаться читаемым, а не пропасть.
    assert.ok(render('<script>alert(1)</script>').includes('&lt;script&gt;'));
  });

  it('markdown внутри тега не открывает его', () => {
    const html = render('**<script>**');
    assert.ok(html.includes('<strong>'));
    assert.ok(!html.includes('<script'));
  });
});

describe('оформление', () => {
  it('жирный, курсив, зачёркнутый, код', () => {
    assert.ok(render('**ж**').includes('<strong>ж</strong>'));
    assert.ok(render('*к*').includes('<em>к</em>'));
    assert.ok(render('~~з~~').includes('<s>з</s>'));
    assert.ok(render('`код`').includes('md-code'));
  });

  it('подчёркивания внутри слова НЕ курсив', () => {
    // Иначе snake_case_имя и my_file_name.txt в чате разработчиков превращаются в кашу.
    for (const s of ['snake_case_имя', 'my_file_name.txt', 'a_b_c']) {
      assert.ok(!render(s).includes('<em>'), `${s} стал курсивом`);
    }
  });

  it('_курсив_ на границах слова работает', () => {
    assert.ok(render('вот _так_ можно').includes('<em>'));
  });

  it('блок кода не интерпретирует то, что внутри', () => {
    const html = render('```\n**не жирный** <script>\n```');
    assert.ok(html.includes('md-pre'));
    assert.ok(!html.includes('<strong>'));
    assert.ok(!html.includes('<script'));
  });

  it('цитата и спойлер', () => {
    assert.ok(render('> цитата').includes('md-quote'));
    assert.ok(render('||секрет||').includes('spoiler'));
  });

  it('упоминания подсвечиваются', () => {
    assert.ok(render('привет @everyone').includes('mention'));
    assert.ok(render('@super привет').includes('mention'));
    assert.ok(render('@super.dev привет').includes('mention'));
  });

  it('подсвечиваем только то, что реально кого-то пингует', () => {
    // Имена регистрируются латиницей (`auth.ts`), поэтому `@Маша` не разбудит никого — и
    // подсвечивать его нельзя: подсветка читается как «сработало».
    assert.ok(!render('@Маша привет').includes('mention'));
    // Кусок чужой почты — тем более не упоминание.
    assert.ok(!render('пиши на user@super.dev').includes('mention'));
  });

  it('ссылка отдаётся обработчику', () => {
    assert.ok(render('см. https://example.com/x').includes('href="https://example.com/x"'));
  });

  it('точка после ссылки не съедается', () => {
    const html = render('тут https://example.com/x.');
    assert.ok(html.includes('href="https://example.com/x"'), 'точка попала в адрес');
  });

  it('найденное серверное эмодзи становится картинкой с читаемым alt', () => {
    const html = render('привет :party_parrot:', (name) =>
      name === 'party_parrot' ? 'https://cdn.example/party.webp' : null,
    );
    assert.ok(html.includes('class="custom-emoji"'));
    assert.ok(html.includes('alt=":party_parrot:"'));
    assert.ok(html.includes('src="https://cdn.example/party.webp"'));
  });

  it('неизвестное серверное эмодзи остаётся текстом, а не пропадает', () => {
    const html = render('привет :deleted:', () => null);
    assert.ok(html.includes(':deleted:'));
    assert.ok(!html.includes('custom-emoji'));
  });

  it('время не превращается в серверное эмодзи', () => {
    const html = render('встречаемся в 10:30:00', () => 'https://cdn.example/wrong.webp');
    assert.ok(html.includes('10:30:00'));
    assert.ok(!html.includes('custom-emoji'));
  });

  it('не падает на пустом и на мусоре', () => {
    for (const s of ['', '**', '```', '||', '> ', '~~~~', '*'.repeat(200)]) {
      assert.doesNotThrow(() => render(s), `упал на ${JSON.stringify(s)}`);
    }
  });

  it('разбор длинного сообщения не занимает заметного времени', () => {
    // Разбор идёт на КАЖДЫЙ рендер каждого сообщения: квадратичная регулярка тут вешает вкладку
    // всем сразу, а не только автору.
    const s = ('слово *курсив* **жир** `код` https://example.com/a @имя ||спойлер|| ').repeat(300);
    const t = Date.now();
    render(s);
    const ms = Date.now() - t;
    assert.ok(ms < 1500, `разбор занял ${ms}мс`);
  });
});
