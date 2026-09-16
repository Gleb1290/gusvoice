import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRedundantDescription, parseHead } from './ogParse.js';

const base = 'https://example.com/a/b';

describe('разбор head', () => {
  it('предпочитает og-теги обычным', () => {
    const r = parseHead(
      `<head><title>Обычный</title><meta name="description" content="Обычное">
       <meta property="og:title" content="OG"><meta property="og:description" content="OG описание"></head>`,
      base,
    );
    assert.equal(r.title, 'OG');
    assert.equal(r.description, 'OG описание');
  });

  it('падает на <title>, если og нет', () => {
    assert.equal(parseHead('<head><title>Только title</title></head>', base).title, 'Только title');
  });

  it('использует twitter-теги, когда OpenGraph отсутствует', () => {
    const r = parseHead(
      '<head><meta name="twitter:title" content="Twitter"><meta name="twitter:description" content="Описание"></head>',
      base,
    );
    assert.equal(r.title, 'Twitter');
    assert.equal(r.description, 'Описание');
  });

  it('не зависит от порядка атрибутов', () => {
    // content ПЕРЕД property — так пишет заметная часть CMS
    const r = parseHead('<head><meta content="Задом наперёд" property="og:title"></head>', base);
    assert.equal(r.title, 'Задом наперёд');
  });

  it('читает атрибуты без кавычек', () => {
    assert.equal(parseHead('<head><meta property=og:title content=Голый></head>', base).title, 'Голый');
  });

  it('раскрывает html-сущности', () => {
    const r = parseHead('<head><meta property="og:title" content="A &amp; B &laquo;в кавычках&raquo; &#1043;"></head>', base);
    assert.equal(r.title, 'A & B «в кавычках» Г');
  });

  it('схлопывает пробелы и переносы', () => {
    assert.equal(parseHead('<head><title>две   строки\n   тут</title></head>', base).title, 'две строки тут');
  });

  it('достраивает относительный og:image до абсолютного', () => {
    const r = parseHead('<head><meta property="og:image" content="/img/c.png"><title>t</title></head>', base);
    assert.equal(r.imageUrl, 'https://example.com/img/c.png');
  });

  it('обрезает слишком длинное описание', () => {
    const long = 'я'.repeat(900);
    const r = parseHead(`<head><meta property="og:description" content="${long}"><title>t</title></head>`, base);
    assert.ok(r.description!.length <= 400, `длина ${r.description!.length}`);
    assert.ok(r.description!.endsWith('…'));
  });

  it('заголовок ровно в 200 символов цел, а 201-й заменяется многоточием', () => {
    const atLimit = parseHead(`<head><title>${'я'.repeat(200)}</title></head>`, base).title!;
    const overLimit = parseHead(`<head><title>${'я'.repeat(201)}</title></head>`, base).title!;
    assert.equal(atLimit, 'я'.repeat(200));
    assert.equal(overLimit.length, 200);
    assert.ok(overLimit.endsWith('…'));
  });

  it('не читает мета-теги из body', () => {
    // Всё после </head> игнорируется: иначе достаточно вписать og:title в тело страницы
    const r = parseHead('<head><title>Настоящий</title></head><body><meta property="og:title" content="Подделка"></body>', base);
    assert.equal(r.title, 'Настоящий');
  });

  it('пустая страница даёт пустой результат', () => {
    const r = parseHead('<html><head></head><body>текст</body></html>', base);
    assert.equal(r.title, null);
    assert.equal(r.description, null);
  });

  it('не падает на мусоре', () => {
    for (const junk of ['', '<<<>>>', '<head', '<meta property="og:title">', '{"json": true}']) {
      assert.doesNotThrow(() => parseHead(junk, base));
    }
  });

  it('битый og:image не роняет разбор', () => {
    const r = parseHead('<head><title>t</title><meta property="og:image" content="ht!tp://%%%"></head>', base);
    assert.equal(r.title, 't');
  });
});

describe('описание, дублирующее заголовок', () => {
  const лишнее: [string, string, string][] = [
    [
      'GitHub - Gleb1290/gusvoice: GusVoice — self-hosted voice/text/screen-share, one-command turnkey deploy bundle',
      'GusVoice — self-hosted voice/text/screen-share, one-command turnkey deploy bundle - Gleb1290/gusvoice',
      'реальный случай GitHub — хвосты разные, суть одна',
    ],
    ['Заголовок статьи', 'Заголовок статьи', 'полное совпадение'],
    ['Как приготовить борщ — рецепт', 'Как приготовить борщ', 'описание — часть заголовка'],
  ];
  for (const [t, d, что] of лишнее) {
    it(`скрывает: ${что}`, () => assert.equal(isRedundantDescription(t, d), true));
  }

  const осмысленное: [string, string, string][] = [
    ['Хабр', 'Сообщество IT-специалистов, статьи и новости про технологии', 'ничего общего'],
    ['Рецепт борща', 'Свёкла, капуста, картофель и говядина — на четыре порции', 'дополняет заголовок'],
    ['Новости', 'Что произошло в мире за последние сутки', 'короткий заголовок, своё описание'],
  ];
  for (const [t, d, что] of осмысленное) {
    it(`оставляет: ${что}`, () => assert.equal(isRedundantDescription(t, d), false));
  }

  it('не падает на пустых', () => {
    assert.equal(isRedundantDescription(null, 'что-то'), false);
    assert.equal(isRedundantDescription('что-то', null), false);
  });
});

/**
 * Числовые сущности. Нашёл Codex: `&#99999999;` ронял `String.fromCodePoint` c RangeError,
 * а прежняя страховка `|| 0xfffd` ловила только NaN и ноль. Ошибку перехватывали выше, но страница
 * навсегда оставалась без карточки — неудача попадает в кэш.
 */
describe('числовые HTML-сущности', () => {
  const title = (html: string) => parseHead(`<head><title>${html}</title></head>`, 'https://example.com').title;

  it('десятичная сущность разворачивается', () => {
    assert.equal(title('&#1055;&#1088;&#1080;&#1074;&#1077;&#1090;'), 'Привет');
  });

  it('шестнадцатеричная тоже', () => {
    assert.equal(title('&#x41;&#x42;'), 'AB');
  });

  it('код за пределами Unicode НЕ роняет разбор', () => {
    assert.equal(title('&#99999999;'), '�');
    assert.equal(title('&#x7FFFFFFF;'), '�');
  });

  it('ровно предельный код U+10FFFF ещё принимается', () => {
    assert.equal(title('&#x10FFFF;'), String.fromCodePoint(0x10ffff));
  });

  it('одиночный суррогат заменяется — это половинка пары, а не символ', () => {
    assert.equal(title('&#xD800;'), '�');
  });

  it('нулевой код заменяется', () => {
    assert.equal(title('&#0;'), '�');
  });

  it('именованные сущности не задеты', () => {
    assert.equal(title('&amp; &mdash;'), '& —');
  });
});
