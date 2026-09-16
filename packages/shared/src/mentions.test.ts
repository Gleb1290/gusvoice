import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mentionSqlPattern, mentionedNames, mentionsMe } from './mentions.js';

/**
 * Регрессия на разъезд четырёх копий правила (см. шапку `mentions.ts`).
 *
 * Тесты написаны мной, а не Codex, потому что это закрепление ЖИВОГО бага: почта в тексте звенела
 * упоминанием, а упоминание в конце предложения не доезжало до телефона.
 */
describe('кого считаем упомянутым', () => {
  it('обычное обращение', () => {
    assert.equal(mentionsMe('@super глянь', 'super'), true);
    assert.equal(mentionsMe('привет, @super', 'super'), true);
  });

  it('регистр не важен — вход в аккаунт тоже регистронезависимый', () => {
    assert.equal(mentionsMe('@SuperGoose тут?', 'supergoose'), true);
    assert.equal(mentionsMe('@supergoose тут?', 'SuperGoose'), true);
  });

  it('@everyone и @here — упоминание для всех', () => {
    assert.equal(mentionsMe('@everyone сбор', 'кто-угодно'), true);
    assert.equal(mentionsMe('@here го', undefined), true);
  });

  it('чужое имя — не упоминание', () => {
    assert.equal(mentionsMe('@petya глянь', 'super'), false);
  });

  it('имя как ЧАСТЬ другого имени не считается', () => {
    // Иначе @supergoose звенел бы у @super.
    assert.equal(mentionsMe('@supergoose тут?', 'super'), false);
    assert.equal(mentionsMe('@super_2 тут?', 'super'), false);
  });
});

describe('почта в тексте — не упоминание', () => {
  it('адрес не звенит у человека с таким именем', () => {
    // 🔴 Ровно этот текст давал звук «вас упомянули» и НЕ давал пуша — четыре правила разошлись.
    assert.equal(mentionsMe('пиши на user@super.dev', 'super'), false);
    assert.deepEqual(mentionedNames('пиши на user@super.dev'), []);
  });

  it('@here внутри адреса — тоже не упоминание', () => {
    assert.equal(mentionsMe('пиши на info@here.com', 'super'), false);
  });

  it('а сам по себе домен после собаки — обращение к пользователю с таким именем', () => {
    // `@super.dev` в начале строки — это обращение к пользователю `super.dev`, если такой есть.
    assert.deepEqual(mentionedNames('@super.dev привет'), ['super.dev']);
    assert.equal(mentionsMe('@super.dev привет', 'super'), false);
  });
});

describe('знаки препинания вокруг имени', () => {
  it('точка в конце предложения не приклеивается к имени', () => {
    // 🔴 Из-за этого настоящее упоминание не доезжало до телефона: пуш искал юзера «super.».
    assert.deepEqual(mentionedNames('спроси у @super.'), ['super']);
    assert.equal(mentionsMe('спроси у @super.', 'super'), true);
  });

  it('запятая, скобка, восклицательный — так же', () => {
    assert.equal(mentionsMe('@super, глянь', 'super'), true);
    assert.equal(mentionsMe('(@super)', 'super'), true);
    assert.equal(mentionsMe('@super!', 'super'), true);
    assert.equal(mentionsMe('да, @super?', 'super'), true);
  });

  it('жирный markdown вокруг упоминания не мешает', () => {
    assert.equal(mentionsMe('**@super**', 'super'), true);
  });

  it('точка ВНУТРИ имени остаётся частью имени', () => {
    assert.equal(mentionsMe('@super.dev привет', 'super.dev'), true);
    assert.equal(mentionsMe('@super-1 привет', 'super-1'), true);
  });

  it('перенос строки и начало текста — законные границы', () => {
    assert.equal(mentionsMe('первая строка\n@super вторая', 'super'), true);
  });
});

describe('список имён для пуша', () => {
  it('повторы схлопываются, регистр приводится', () => {
    assert.deepEqual(mentionedNames('@super @SUPER @super'), ['super']);
  });

  it('несколько разных', () => {
    assert.deepEqual(mentionedNames('@super и @petya, зовите @everyone'), ['super', 'petya', 'everyone']);
  });

  it('разделитель без пробела не склеивает два соседних обращения', () => {
    // Ловит жадный сканер, который после запятой пропускает второе настоящее упоминание.
    assert.deepEqual(mentionedNames('@super,@petya'), ['super', 'petya']);
  });

  it('пустой текст и текст без собак', () => {
    assert.deepEqual(mentionedNames(''), []);
    assert.deepEqual(mentionedNames('обычное сообщение'), []);
  });

  it('кириллица после собаки именем не считается', () => {
    // Регистрация латиницей: `@Маша` никого не пингует, и подсвечивать его нельзя.
    assert.deepEqual(mentionedNames('@Маша привет'), []);
  });

  it('одинокая собака и собака с пробелом', () => {
    assert.deepEqual(mentionedNames('@ super'), []);
    assert.deepEqual(mentionedNames('почта@'), []);
  });
});

describe('шаблон для SQL', () => {
  const re = (username?: string) => new RegExp(mentionSqlPattern(username), 'i');

  it('повторяет решения mentionsMe на тех же текстах', () => {
    const cases: [string, string | undefined, boolean][] = [
      ['@super глянь', 'super', true],
      ['спроси у @super.', 'super', true],
      ['(@super)', 'super', true],
      ['пиши на user@super.dev', 'super', false],
      ['@supergoose тут?', 'super', false],
      ['@super.dev привет', 'super', false],
      ['@everyone сбор', 'super', true],
      ['@here го', undefined, true],
      ['обычное сообщение', 'super', false],
    ];
    for (const [text, name, expected] of cases) {
      assert.equal(re(name).test(text), expected, `${text} / ${name ?? '—'}`);
      assert.equal(mentionsMe(text, name), expected, `mentionsMe: ${text} / ${name ?? '—'}`);
    }
  });

  it('без имени остаются только @everyone/@here', () => {
    assert.equal(re(undefined).test('@super глянь'), false);
    assert.equal(re(undefined).test('@everyone сбор'), true);
  });

  it('точка в имени экранируется, а не работает как «любой символ»', () => {
    // Без экранирования `@super.dev` совпало бы с `@superxdev`.
    assert.equal(re('super.dev').test('@superxdev'), false);
    assert.equal(re('super.dev').test('@super.dev'), true);
  });

  it('дефис в имени совпадает буквально и не захватывает префикс длинного имени', () => {
    // Ловит ошибку экранирования SQL-паттерна: пуши могли уйти соседнему username.
    const hyphen = re('super-dev');
    assert.equal(hyphen.test('@super-dev'), true);
    assert.equal(hyphen.test('@superxdev'), false);
    assert.equal(hyphen.test('@super-dev-x'), false);
  });

  it('SQL и JS одинаково решают редкие границы имени и повторные собаки', () => {
    // Ловит новый разъезд пуша, живого бейджа и истории на синтаксически пограничных сообщениях.
    const maxName = 'a'.repeat(32);
    const cases: [text: string, username: string, expected: boolean, names: string[]][] = [
      ['@super', 'super', true, ['super']],
      ['текст заканчивается на @super', 'super', true, ['super']],
      ['@@super', 'super', false, []],
      ['a@@super', 'super', false, []],
      [`@${maxName}`, maxName, true, [maxName]],
      ['@super@petya', 'super', true, ['super']],
      ['@super@petya', 'petya', false, ['super']],
    ];
    for (const [text, username, expected, names] of cases) {
      assert.deepEqual(mentionedNames(text), names, `mentionedNames: ${text}`);
      assert.equal(mentionsMe(text, username), expected, `mentionsMe: ${text} / ${username}`);
      assert.equal(re(username).test(text), expected, `SQL: ${text} / ${username}`);
    }
  });

  it('почтовые локальные части не обходят страж слева ни в JS, ни в SQL', () => {
    // Регрессия #110: прежний deny-list пропускал кириллицу, +, апостроф и _. Цель — именно
    // `super.dev`: старый сканер ошибочно находил весь домен, поэтому проверка @super эту дыру не ловит.
    const cases = ['имя@super.dev', 'foo+@super.dev', "o'brien@super.dev", 'user_@super.dev', '—@super.dev'];
    for (const text of cases) {
      assert.deepEqual(mentionedNames(text), [], `mentionedNames: ${text}`);
      assert.equal(mentionsMe(text, 'super.dev'), false, `mentionsMe: ${text}`);
      assert.equal(re('super.dev').test(text), false, `SQL: ${text}`);
    }
  });

  it('все согласованные границы слева принимаются одинаково в JS и SQL', () => {
    // Это точный контракт MENTION_LEFT_GUARD. У него есть цена: тире перед @ не проходит,
    // зато markdown и безопасная пунктуация не превращают настоящее обращение в обычный текст.
    const allowedPrefixes = ['', ' ', '\n', '(', '[', '<', '"', '«', '„', ',', ';', ':', '*', '~', '`'];
    for (const prefix of allowedPrefixes) {
      const text = `${prefix}@super`;
      assert.deepEqual(mentionedNames(text), ['super'], `mentionedNames: ${JSON.stringify(text)}`);
      assert.equal(mentionsMe(text, 'super'), true, `mentionsMe: ${JSON.stringify(text)}`);
      assert.equal(re('super').test(text), true, `SQL: ${JSON.stringify(text)}`);
    }
  });
});
