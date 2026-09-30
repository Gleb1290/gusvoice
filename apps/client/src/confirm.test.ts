import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { confirmWithOption, useConfirmDialog } from './confirm.js';
import { canConfirm, submitsOnEnter } from './confirmRules.js';

const spec = { title: 'Удалить сообщение?', tone: 'danger' as const, option: { label: 'Также у собеседника', checked: true } };

describe('подтверждение с галочкой', () => {
  it('отказ возвращает null независимо от положения галочки', async () => {
    // Ловит удаление у второго человека после закрытия окна отменой.
    const result = confirmWithOption(spec);
    useConfirmDialog.getState().pending?.onOption?.(false);
    useConfirmDialog.getState().answer(false);
    assert.equal(await result, null);
  });

  it('согласие без касания галочки сохраняет её исходный выбор', async () => {
    // Ловит потерю начального значения при сборке ответа из необязательного onOption.
    const result = confirmWithOption(spec);
    useConfirmDialog.getState().answer(true);
    assert.deepEqual(await result, { option: true });
  });

  it('переключение галочки перед согласием возвращает новое значение', async () => {
    // Ловит удаление «у обоих», когда человек явно снял галочку.
    const result = confirmWithOption(spec);
    useConfirmDialog.getState().pending?.onOption?.(false);
    useConfirmDialog.getState().answer(true);
    assert.deepEqual(await result, { option: false });
  });

  it('галочка не меняет разрешение опасного подтверждения по Enter', () => {
    // Ловит обход прежней защиты опасного действия через новую опцию диалога.
    assert.equal(canConfirm(spec, ''), true);
    assert.equal(submitsOnEnter(spec, ''), false);
  });
});
