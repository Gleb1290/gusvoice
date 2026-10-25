import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { React, load, sourceOf, icon, environment, click, mutate } from './R171.phoneHarness';
import type * as Sheets from './BottomSheet';
import type * as AndroidBack from '../androidBack';

const source = sourceOf('BottomSheet');
const backSource = readFileSync(new URL('../androidBack.ts', import.meta.url), 'utf8');
const sheets = (raw = source) => load<typeof Sheets>(raw, { './Icon': { Icon: icon } });

async function pointerDrag(target: Element, distance: number) {
  await React.act(async () => {
    for (const [type, clientY] of [['pointerdown', 20], ['pointermove', 20 + distance], ['pointerup', 20 + distance]] as const) {
      target.dispatchEvent(new window.PointerEvent(type, {
        bubbles: true, pointerType: 'touch', pointerId: 7, button: 0, clientY,
      }));
    }
  });
}

async function pageMarkup(raw = source) {
  await environment(async (_host, render) => {
    let backs = 0, closes = 0;
    const { BottomSheet } = sheets(raw);
    await render(React.createElement(BottomSheet, { page: true, title: 'Новое сообщение',
      onClose: () => closes++, onBack: () => backs++, children: React.createElement('p', null, 'Выберите собеседника') }));
    // Проверяем настоящий портал: у родителя React нет разметки листа, она живёт прямо в body.
    const page = document.querySelector<HTMLElement>('body > .sheet-scrim.page > .sheet.page');
    assert.ok(page, 'R258_PAGE_BRANCH: экран имеет собственную page-разметку');
    assert.equal(page.getAttribute('role'), 'dialog');
    assert.equal(page.getAttribute('aria-modal'), 'true');
    assert.equal(page.getAttribute('aria-label'), 'Новое сообщение');
    assert.equal(page.querySelector('.sheet-page-bar > .sheet-page-title')?.textContent, 'Новое сообщение');
    const back = page.querySelector('.sheet-page-bar > .sheet-back'); assert.ok(back);
    assert.equal(back.getAttribute('aria-label'), 'Назад');
    assert.equal(back.querySelector('[data-icon]')?.getAttribute('data-icon'), 'chevron-left');
    assert.equal(page.querySelector('.sheet-body')?.textContent, 'Выберите собеседника');
    assert.equal(!!page.querySelector('.sheet-grab, .sheet-drag'), false, 'экран не обещает жест ручкой');
    const bar = page.querySelector('.sheet-page-bar'); assert.ok(bar);
    const body = page.querySelector('.sheet-body'); assert.ok(body);
    const scrim = page.parentElement; assert.ok(scrim);
    // Без этого парного события можно случайно оставить drag на всей странице вместо удалённой ручки.
    for (const target of [bar, body, scrim]) await pointerDrag(target, 250);
    await click(document, '.sheet-body');
    await click(document, '.sheet-scrim.page');
    assert.equal(page.style.transform, '', 'страница не едет за пальцем');
    assert.equal(page.style.animation, '', 'касание не выключает въездную анимацию страницы');
    assert.deepEqual([backs, closes], [0, 0], 'тап мимо содержимого и свайп вниз не закрывают экран');
  });
}

it('R258 экран имеет шапку и тело без ручки; свайп вниз и тап по подложке не закрывают его', async () => {
  // Экран «Новое сообщение» — не выдвижной лист, даже если использует тот же компонент.
  await pageMarkup();
});

async function pageArrow(withBack: boolean, raw = source) {
  await environment(async (_host, render) => {
    let backs = 0, closes = 0;
    const { BottomSheet } = sheets(raw);
    await render(React.createElement(BottomSheet, { page: true, title: 'Новое сообщение', children: 'Список',
      onClose: () => closes++, onBack: withBack ? () => backs++ : undefined }));
    await click(document, '.sheet-page-bar .sheet-back');
    assert.equal(backs, withBack ? 1 : 0, 'R258_PAGE_BACK: стрелка отдаёт приоритет onBack');
    assert.equal(closes, withBack ? 0 : 1, 'R258_PAGE_CLOSE: без onBack стрелка закрывает экран');
  });
}

it('R258 стрелка страницы возвращает шаг, а без onBack вызывает запасное закрытие', async () => {
  // Наличие onClose не должно лишать мастера своего шага назад; одношаговую страницу нельзя запереть.
  await pageArrow(true); await pageArrow(false);
});

async function pageKeyboard(system: boolean, withBack: boolean) {
  await environment(async (_host, render) => {
    let backs = 0, closes = 0, storeReads = 0;
    const { BottomSheet } = sheets();
    const { stepBack, TOP_LAYERS } = load<typeof AndroidBack>(backSource, {
      './hotkeys': { isAndroid: () => true },
      './store': { useStore: { getState: () => { storeReads++; return {}; } } },
    }, { KeyboardEvent: window.KeyboardEvent });
    await render(React.createElement(BottomSheet, { page: true, title: 'Новое сообщение', children: 'Список',
      onClose: () => closes++, onBack: withBack ? () => backs++ : undefined }));
    const page = document.querySelector('.sheet.page'); assert.ok(page);
    assert.equal(page.matches(TOP_LAYERS), true, 'настоящая страница входит в верхние слои Android');
    await React.act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' })));
    assert.deepEqual([backs, closes], [0, 0], 'не-Esc не делает шаг назад');
    await React.act(async () => {
      if (system) assert.equal(stepBack(), true, 'Android забирает один шаг верхним слоем');
      else window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    assert.deepEqual([backs, closes], withBack ? [1, 0] : [0, 1], 'один возврат, без двойного вызова');
    assert.equal(storeReads, 0, 'страница закрывается раньше нижней навигации/стора');
  });
}

for (const system of [false, true]) it(`R258 ${system ? 'системная Назад Android' : 'Esc'} на странице возвращает шаг либо закрывает её`, async () => {
  // Здесь настоящий androidBack ищет .sheet и посылает Esc через document, а не мок закрытия.
  await pageKeyboard(system, true); await pageKeyboard(system, false);
});

it('R258 обычный лист сохраняет ручку, жест закрытия и тап по подложке, но не закрывается от тела', async () => {
  // Контрпример к page: новый вариант не должен отключить старое поведение всех остальных листов.
  await environment(async (_host, render) => {
    let closes = 0;
    const { BottomSheet } = sheets();
    await render(React.createElement(BottomSheet, { title: 'Выбор контакта', children: 'Люди', onClose: () => closes++ }));
    assert.equal(!!document.querySelector('.sheet.page, .sheet-scrim.page, .sheet-page-bar'), false);
    assert.ok(document.querySelector('.sheet-drag > .sheet-grab'));
    const sheet = document.querySelector<HTMLElement>('.sheet'); assert.ok(sheet);
    const drag = document.querySelector('.sheet-drag'); assert.ok(drag);
    // happy-dom не считает layout. Высоту задаём явно: 200 px заведомо превышают треть от 300.
    Object.defineProperty(sheet, 'offsetHeight', { configurable: true, value: 300 });
    await click(document, '.sheet-body'); assert.equal(closes, 0, 'содержимое не всплывает в scrim');
    await pointerDrag(drag, 200);
    assert.equal(sheet.style.transform, 'translateY(200px)', 'ручка настоящего листа следует за пальцем');
    assert.equal(closes, 1, 'достаточный жест закрывает обычный лист');
    await click(document, '.sheet-scrim');
    assert.equal(closes, 2, 'обычный лист по-прежнему закрывается от подложки');
  });
});

it('R258 замена обработчика страницы и её размонтирование снимают старый слушатель Esc', async () => {
  // Иначе один Esc после смены шага вызвал бы старый и новый callback, а закрытая страница продолжала бы реагировать.
  await environment(async (_host, render) => {
    const { BottomSheet } = sheets();
    let oldCloses = 0, newCloses = 0;
    await render(React.createElement(BottomSheet, { page: true, children: 'Список', onClose: () => oldCloses++ }));
    await render(React.createElement(BottomSheet, { page: true, children: 'Список', onClose: () => newCloses++ }));
    await React.act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
    assert.deepEqual([oldCloses, newCloses], [0, 1], 'после смены пропса работает только новый обработчик');
    await render(null);
    assert.equal(!!document.querySelector('.sheet-scrim'), false, 'портал ушёл вместе со страницей');
    await React.act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
    assert.deepEqual([oldCloses, newCloses], [0, 1], 'закрытый экран больше не слушает Esc');
  });
});

function failsAt(marker: string) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.includes(marker);
}

it('R258 удаление page-ветки обнаруживается отсутствием полноэкранной разметки', async () => {
  // Сначала оригинал; ошибка трансляции/импорта не считается успешным обнаружением мутанта.
  await pageMarkup();
  await assert.rejects(() => pageMarkup(mutate(source, 'if (page)', 'if (false)')), failsAt('R258_PAGE_BRANCH'));
});

it('R258 подмена onBack на onClose у стрелки страницы обнаруживается реальным нажатием', async () => {
  // Не проверяем строку обработчика: одинаковый экран с неверным действием обязан провалить сценарий.
  await pageArrow(true);
  await assert.rejects(() => pageArrow(true, mutate(source, 'onClick={onBack ?? onClose}', 'onClick={onClose}')),
    failsAt('R258_PAGE_BACK'));
});
