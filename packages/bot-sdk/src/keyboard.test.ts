import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InlineKeyboard } from './keyboard.js';
import type { InlineKeyboardButton } from './wire.js';

describe('R301 InlineKeyboard — разметка и границы сервера', () => {
  it('text, url и row возвращают сборщик и сохраняют порядок двух видов кнопок', () => {
    const kb = new InlineKeyboard();
    assert.equal(kb.text('Статус', 'st'), kb);
    assert.equal(kb.row(), kb);
    assert.equal(kb.url('Сайт', 'https://example.test/a?q=1'), kb);
    assert.deepEqual(kb.build(), { inline_keyboard: [
      [{ text: 'Статус', callback_data: 'st' }], [{ text: 'Сайт', url: 'https://example.test/a?q=1' }],
    ] });
  });

  it('начальные, повторные и хвостовые row не оставляют пустых рядов в JSON', () => {
    const kb = new InlineKeyboard().row().row().text('A', 'a').row().row();
    const expected = { inline_keyboard: [[{ text: 'A', callback_data: 'a' }]] };
    assert.deepEqual(kb.build(), expected);
    assert.deepEqual(JSON.parse(JSON.stringify(kb)), expected);
  });

  it('build возвращает отдельные ряды и кнопки, изменение снимка не портит сборщик', () => {
    const kb = new InlineKeyboard().text('A', 'a');
    const snapshot = kb.build();
    snapshot.inline_keyboard[0][0].text = 'Изменено';
    snapshot.inline_keyboard[0].push({ text: 'Лишнее', callback_data: 'extra' });
    kb.row().text('B', 'b');
    assert.deepEqual(kb.build(), { inline_keyboard: [
      [{ text: 'A', callback_data: 'a' }], [{ text: 'B', callback_data: 'b' }],
    ] });
    assert.equal(snapshot.inline_keyboard.length, 1);
  });

  it('from сохраняет непустые ряды и копирует входные кнопки', () => {
    const rows: InlineKeyboardButton[][] = [
      [{ text: 'A', callback_data: 'a' }], [], [{ text: 'Сайт', url: 'http://example.test' }],
    ];
    const kb = InlineKeyboard.from(rows);
    rows[0][0].text = 'Другой';
    rows[0].push({ text: 'B', callback_data: 'b' });
    assert.deepEqual(kb.build(), { inline_keyboard: [
      [{ text: 'A', callback_data: 'a' }], [{ text: 'Сайт', url: 'http://example.test' }],
    ] });
  });

  it('callback_data ровно 64 ASCII-байта принимается, 65 отклоняется без добавления кнопки', () => {
    const kb = new InlineKeyboard().text('A', 'a'.repeat(64));
    assert.throws(() => kb.text('B', 'a'.repeat(65)), { name: 'TypeError', message: /64.*UTF-8/ });
    assert.equal(kb.build().inline_keyboard[0].length, 1);
    assert.equal(kb.build().inline_keyboard[0][0].callback_data, 'a'.repeat(64));
  });

  it('UTF-8 считает байты: 32 кириллические буквы проходят, те же буквы плюс ASCII дают 65 и отказ', () => {
    const data = 'я'.repeat(32);
    assert.equal(Buffer.byteLength(data, 'utf8'), 64);
    assert.equal(new InlineKeyboard().text('A', data).build().inline_keyboard[0][0].callback_data, data);
    assert.throws(() => new InlineKeyboard().text('B', `${data}x`), TypeError);
    assert.throws(() => new InlineKeyboard().text('B', 'я'.repeat(33)), TypeError);
  });

  it('четырёхбайтные эмодзи занимают весь лимит при 16 символах, семнадцатый отклоняется', () => {
    const data = '🪿'.repeat(16);
    assert.equal(Buffer.byteLength(data, 'utf8'), 64);
    assert.equal(new InlineKeyboard().text('A', data).build().inline_keyboard[0][0].callback_data, data);
    assert.throws(() => new InlineKeyboard().text('B', `${data}🪿`), TypeError);
  });

  it('пустые данные отклоняются, один байт и пробел являются непустыми данными', () => {
    assert.throws(() => new InlineKeyboard().text('A', ''), TypeError);
    for (const data of ['a', ' ']) {
      assert.equal(new InlineKeyboard().text('A', data).build().inline_keyboard[0][0].callback_data, data);
    }
  });

  it('ровно 8 кнопок помещаются в ряд, девятая требует row, после отказа можно продолжить', () => {
    const kb = new InlineKeyboard();
    for (let i = 0; i < 8; i++) kb.text(`Кнопка ${i}`, String(i));
    assert.equal(kb.build().inline_keyboard[0].length, 8);
    assert.throws(() => kb.text('Девятая', '9'), { name: 'TypeError', message: /8.*row/ });
    kb.row().text('Девятая', '9');
    assert.deepEqual(kb.build().inline_keyboard.map(row => row.length), [8, 1]);
  });

  it('ровно 100 кнопок проходят, 101-я в новом ряду отклоняется общим лимитом', () => {
    const kb = new InlineKeyboard();
    for (let i = 0; i < 100; i++) {
      if (i % 8 === 0) kb.row();
      kb.text(String(i), String(i));
    }
    assert.equal(kb.build().inline_keyboard.flat().length, 100);
    assert.throws(() => kb.row().url('Лишняя', 'https://example.test'), { name: 'TypeError', message: /100/ });
    assert.equal(kb.build().inline_keyboard.flat().length, 100);
  });

  it('from тоже соблюдает 8/9 в ряду и 100/101 всего', () => {
    const buttons = (n: number) => Array.from({ length: n }, (_, i) => ({ text: String(i), callback_data: String(i) }));
    assert.equal(InlineKeyboard.from([buttons(8)]).build().inline_keyboard[0].length, 8);
    assert.throws(() => InlineKeyboard.from([buttons(9)]), TypeError);
    assert.equal(InlineKeyboard.from(Array.from({ length: 100 }, () => buttons(1))).build().inline_keyboard.flat().length, 100);
    assert.throws(() => InlineKeyboard.from(Array.from({ length: 101 }, () => buttons(1))), TypeError);
  });

  it('from требует ровно один вид действия: callback и ссылка отдельно допустимы, оба или ни одного нет', () => {
    for (const button of [{ text: 'A' }, { text: 'A', callback_data: 'a', url: 'https://example.test' }]) {
      assert.throws(() => InlineKeyboard.from([[button]]), TypeError);
    }
    assert.equal(InlineKeyboard.from([[{ text: 'A', callback_data: 'a' }, { text: 'B', url: 'https://example.test' }]])
      .build().inline_keyboard[0].length, 2);
  });

  it('текст ровно 64 знака, включая эмодзи, проходит, пустой или 65 знаков отклоняется', () => {
    for (const text of ['A'.repeat(64), '🪿'.repeat(64)]) {
      assert.equal(new InlineKeyboard().text(text, 'a').build().inline_keyboard[0][0].text, text);
    }
    for (const text of ['', '  \t', 'A'.repeat(65), '🪿'.repeat(65)]) {
      assert.throws(() => new InlineKeyboard().text(text, 'a'), TypeError);
      assert.throws(() => new InlineKeyboard().url(text, 'https://example.test'), TypeError);
    }
  });

  it('ссылки http и https без учётных данных принимаются', () => {
    for (const url of ['http://example.test', 'https://example.test/path?a=1#x', 'HTTPS://example.test']) {
      assert.equal(new InlineKeyboard().url('Сайт', url).build().inline_keyboard[0][0].url, url);
    }
  });

  it('исполняемые схемы, относительные адреса и логин или пароль в URL отклоняются', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.test', 'tg://x', '/relative', '//example.test',
      'not a url', 'https://a:b@example.test', 'https://a@example.test', 'https://:b@example.test']) {
      assert.throws(() => new InlineKeyboard().url('Сайт', url), { name: 'TypeError', message: /http\(s\)/ }, url);
    }
  });
});
