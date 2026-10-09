import assert from 'node:assert/strict';
import { it } from 'node:test';
import { CONTACT_NAME_MAX } from '@gusvoice/shared';
import { cleanContactName } from './contactRules.js';

it('пустая подпись возвращает собственное имя, непустая сохраняется', () => {
  // Пустая строка не должна становиться видимым пустым именем контакта.
  for (const raw of [null, undefined, '', ' \t\n\u0000\u007f ']) assert.equal(cleanContactName(raw), null);
  assert.equal(cleanContactName('Ёжик'), 'Ёжик');
});

it('подпись остаётся одной строкой без управляющих знаков и лишних пробелов', () => {
  // Переносы и управляющие знаки не должны менять высоту строки списка людей.
  assert.equal(cleanContactName('  Ёжик\t\nмой\u0000\u001f друг\u007f  '), 'Ёжик мой друг');
  assert.equal(cleanContactName('Иван\u00a0\u2003 Петров'), 'Иван Петров');
  assert.equal(cleanContactName(' @друг '), '@друг');
});

it('ровно 64 кодовые точки сохраняются, 65-я обрезается', () => {
  // Проверка с двух сторон ловит срез на один знак раньше договорённого лимита.
  assert.equal(CONTACT_NAME_MAX, 64);
  assert.equal(cleanContactName('я'.repeat(64)), 'я'.repeat(64));
  assert.equal(cleanContactName('я'.repeat(64) + 'z'), 'я'.repeat(64));
});

it('эмодзи на границе не рвётся на половину UTF-16 пары', () => {
  // Ограничение считается в кодовых точках, не в 16-битных элементах строки.
  assert.equal(cleanContactName('я'.repeat(63) + '🪿' + 'x'), 'я'.repeat(63) + '🪿');
  assert.equal(cleanContactName('🪿'.repeat(65)), '🪿'.repeat(64));
  assert.equal(cleanContactName('я'.repeat(63) + ' x'), 'я'.repeat(63), 'пробел после среза не остаётся в подписи');
});

it('проверки подписи действительно ловят отсутствие trim и неверные срезы', () => {
  // Неизменённая функция проходит тот же оракул: ошибка окружения не считается убийством мутанта.
  const source = cleanContactName.toString();
  // nosemgrep: gv-no-eval — тест исполняет свой cleanContactName.toString() и фиксированные мутанты; чужого ввода нет.
  const make = (text: string): typeof cleanContactName => new Function('CONTACT_NAME_MAX', `return (${text})`)(CONTACT_NAME_MAX); // nosemgrep: gv-no-eval
  const oracle = (fn: typeof cleanContactName) => {
    assert.equal(fn('  Ёжик  '), 'Ёжик');
    assert.equal(fn('я'.repeat(64)), 'я'.repeat(64));
    assert.equal(fn('я'.repeat(63) + '🪿x'), 'я'.repeat(63) + '🪿');
  };
  oracle(make(source));
  const variants = [source.replace(/\.trim\(\)/g, ''), source.replace('CONTACT_NAME_MAX', '63'), source.replace('[...one]', 'one').replace('.join("")', '').replace(".join('')", '')];
  for (const mutated of variants) {
    assert.notEqual(mutated, source, 'мутант обязан действительно изменить исходник');
    assert.throws(() => oracle(make(mutated)), assert.AssertionError);
  }
});
