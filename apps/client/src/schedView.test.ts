import assert from 'node:assert/strict';
import { it } from 'node:test';
import { holdSchedView, backFromSchedView } from './schedView';

it('возврат к беседе действует только пока вид удерживает обработчик', () => {
  // В отсутствие расписания кнопка телефона должна вернуть обычную навигацию, а не вызвать старый callback.
  assert.equal(backFromSchedView(), false);
  let calls = 0;
  const release = holdSchedView(() => calls++);
  try { assert.equal(backFromSchedView(), true); assert.equal(calls, 1); }
  finally { release(); }
  release(); assert.equal(backFromSchedView(), false);
});

it('позднее освобождение прежнего вида не снимает переход новой беседы', () => {
  // Старый unmount может случиться после нового mount при переключении диалога.
  const calls: string[] = [];
  const oldRelease = holdSchedView(() => calls.push('old'));
  const newRelease = holdSchedView(() => calls.push('new'));
  try {
    oldRelease(); oldRelease();
    assert.equal(backFromSchedView(), true); assert.deepEqual(calls, ['new']);
  } finally { newRelease(); oldRelease(); }
  assert.equal(backFromSchedView(), false);
});

it('возврат может синхронно освободить вид и не вызывается повторно', () => {
  // Закрывающий callback реентерабелен: следующий клик не должен обратиться к уже закрытой ленте.
  let calls = 0;
  const release = holdSchedView(() => { calls++; release(); });
  try {
    assert.equal(backFromSchedView(), true); assert.equal(backFromSchedView(), false); assert.equal(calls, 1);
  } finally { release(); }
});
