import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canConfirm, confirmLabelOf, enterHintOf, hasCancel, submitsOnEnter } from './confirmRules.js';

describe('правила окна подтверждения', () => {
  it('информационное окно говорит «Понятно» и не показывает отмену', () => {
    // Ловит бессмысленную кнопку отмены у сообщения, которое можно только прочитать.
    const spec = { title: 'Готово', tone: 'info' as const };
    assert.equal(confirmLabelOf(spec), 'Понятно');
    assert.equal(hasCancel(spec), false);
  });

  it('явная подпись действия сильнее значения по умолчанию', () => {
    // Ловит возврат безликого «Подтвердить» вместо конкретного глагола.
    assert.equal(confirmLabelOf({ title: 'Удалить?', confirmLabel: 'Удалить' }), 'Удалить');
  });

  it('контрольное слово сравнивается без регистра и крайних пробелов', () => {
    // Ловит отказ правильному имени, переписанному человеком с иной раскладкой регистра.
    const spec = { title: 'Удалить?', requireText: 'Гуси Бабуси' };
    assert.equal(canConfirm(spec, '  гуси бабуси  '), true);
    assert.equal(canConfirm(spec, 'гуси'), false);
  });

  it('Enter не подтверждает опасное действие без контрольного слова', () => {
    // Ловит необратимое действие от клавиши, нажатой по привычке после ввода сообщения.
    assert.equal(submitsOnEnter({ title: 'Удалить?', tone: 'danger' }, ''), false);
    assert.equal(enterHintOf({ title: 'Удалить?', tone: 'danger' }), 'здесь не подтверждает');
  });

  it('Enter подтверждает только уже совпавшее контрольное слово', () => {
    // Ловит обход паузы подтверждения через клавиатуру.
    const spec = { title: 'Удалить?', tone: 'danger' as const, requireText: 'server' };
    assert.equal(submitsOnEnter(spec, 'serve'), false);
    assert.equal(enterHintOf(spec, 'serve'), 'сначала наберите имя');
    assert.equal(submitsOnEnter(spec, 'SERVER'), true);
    assert.equal(enterHintOf(spec, 'SERVER'), 'подтвердить');
  });
});
