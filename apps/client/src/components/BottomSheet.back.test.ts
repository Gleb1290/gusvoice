import assert from 'node:assert/strict';
import { it } from 'node:test';
import { React, load, sourceOf, icon, environment, click, mutate } from './R171.phoneHarness';
import type * as Sheet from './BottomSheet';
import { readFileSync } from 'node:fs';
import type * as Back from '../androidBack';

const source = sourceOf('BottomSheet');
const backSource = readFileSync(new URL('../androidBack.ts', import.meta.url), 'utf8');
async function keyboard(back: boolean, system: boolean, raw = source) {
  await environment(async (_host, render) => {
    let backs = 0, closes = 0;
    const { BottomSheet } = load<typeof Sheet>(raw, { './Icon': { Icon: icon } });
    const { stepBack } = load<typeof Back>(backSource, {
      './hotkeys': { isAndroid: () => true }, './store': { useStore: { getState: () => ({}) } },
    }, { KeyboardEvent: window.KeyboardEvent });
    await render(React.createElement(BottomSheet, { title: 'Лист', children: 'Тело',
      onClose: () => closes++, onBack: back ? () => backs++ : undefined }));
    await React.act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    });
    assert.equal(backs + closes, 0, 'другая клавиша не делает шаг');
    await React.act(async () => {
      if (system) assert.equal(stepBack(), true);
      else window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    assert.equal(backs, back ? 1 : 0, 'возврат получает ровно один шаг');
    assert.equal(closes, back ? 0 : 1, 'одношаговый лист закрывается запасным обработчиком');
  });
}
async function check(back: boolean, raw = source) {
  await environment(async (_host, render) => {
    let backs = 0, closes = 0;
    const { BottomSheet } = load<typeof Sheet>(raw, { './Icon': { Icon: icon } });
    await render(React.createElement(BottomSheet, { title: 'Новая группа', onClose: () => closes++,
      onBack: back ? () => backs++ : undefined, children: 'Тело' }));
    assert.equal(!!document.querySelector('.sheet-back-dock'), back);
    assert.equal(document.querySelector('.sheet-head')?.classList.contains('with-back'), back);
    assert.equal(!!document.querySelector('.sheet-drag .sheet-back'), false, 'стрелка вне области захвата ручки');
    if (back) {
      const button = document.querySelector<HTMLButtonElement>('.sheet-back'); assert.ok(!!button);
      assert.equal(button.getAttribute('aria-label'), 'Назад');
      // Перемещение на стрелке не запускает drag ручки и не закрывает весь мастер.
      await React.act(async () => {
        button.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientY: 0 }));
        button.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: 200 }));
        button.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientY: 200 }));
      });
      assert.equal(document.querySelector<HTMLElement>('.sheet')?.style.transform, '');
      await click(document, '.sheet-back'); assert.equal(backs, 1); assert.equal(closes, 0);
    }
  });
}
it('R171 лист без onBack не рисует стрелку, с onBack добавляет её отдельно от ручки и вызывает только возврат', async () => {
  // Стрелка в зоне жеста перехватила бы тап или закрыла весь мастер вместо шага.
  await check(false); await check(true);
});
it('R171 безусловная стрелка обнаруживается листом без обработчика возврата', async () => {
  // Парный случай защищает все одношаговые листы от мёртвой кнопки.
  await check(false);
  await assert.rejects(() => check(false, mutate(source, '{onBack && (', '{true && (')), assert.AssertionError);
});
it('R171 потеря вызова onBack обнаруживается нажатием настоящей стрелки', async () => {
  // Наличие значка само по себе не доказывает рабочий возврат.
  await check(true);
  await assert.rejects(() => check(true, mutate(source, 'onClick={onBack}', 'onClick={() => {}}')), assert.AssertionError);
});
for (const system of [false, true]) it(`R179 ${system ? 'системная Назад' : 'Esc'} возвращает уровень, а без onBack закрывает лист`, async () => {
  // Ошибка приоритета закрыла бы весь мастер; отсутствие fallback заперло бы одношаговый лист.
  await keyboard(true, system); await keyboard(false, system);
});
it('R179 безусловное закрытие листа вместо возврата обнаруживается Esc', async () => {
  // Обязательный контрфакт: видимая стрелка не гарантирует правильную клавиатурную проводку.
  await keyboard(true, false);
  await assert.rejects(() => keyboard(true, false, mutate(source, '(onBack ?? onClose)();', 'onClose();')), assert.AssertionError);
});
it('R179 потеря запасного закрытия обнаруживается системной Назад одношагового листа', async () => {
  // Без onBack optional-call должен дать именно ошибку поведения, не TypeError.
  await keyboard(false, true);
  await assert.rejects(() => keyboard(false, true, mutate(source, '(onBack ?? onClose)();', 'onBack?.();')), assert.AssertionError);
});
