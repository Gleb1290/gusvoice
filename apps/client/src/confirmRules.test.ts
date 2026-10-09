import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import ts from 'typescript';
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

  it('подсказка называет фразу смены ключа, а для обычного контрольного слова — имя', () => {
    // Если подсказка велит ввести имя, человек не поймёт, что смена ключа требует отдельную фразу.
    const key = { title: 'Сменить ключ?', tone: 'danger' as const, requireText: 'сменить ключ', requireTextWhat: 'фразу «сменить ключ»' };
    assert.equal(enterHintOf(key), 'сначала наберите фразу «сменить ключ»');
    assert.equal(enterHintOf({ title: 'Удалить?', requireText: 'сервер' }), 'сначала наберите имя');
    assert.equal(enterHintOf(key, ' СМЕНИТЬ КЛЮЧ '), 'подтвердить');
    const original = readFileSync(new URL('./confirmRules.ts', import.meta.url), 'utf8');
    const changed = original.replace('spec.requireTextWhat ?? \'имя\'', '\'имя\'');
    assert.notEqual(changed, original, 'реальный модуль содержит специальную подсказку');
    const mod = { exports: {} as Record<string, unknown> };
    runInNewContext(ts.transpileModule(changed, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module: mod, exports: mod.exports });
    const mutant = mod.exports as typeof import('./confirmRules.js');
    assert.throws(() => assert.equal(mutant.enterHintOf(key), 'сначала наберите фразу «сменить ключ»'), assert.AssertionError,
      'мутант общей подсказки «имя» обязан провалить контракт смены ключа');
  });
});
