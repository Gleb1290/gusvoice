import assert from 'node:assert/strict';
import { it } from 'node:test';
import { React, load, sourceOf, icon, environment, click, mutate } from './R171.phoneHarness';
import * as dmRules from '../dmRules';
import * as groupRules from '../groupChatRules';
import * as contactRules from '../contactRules';
import type * as Dialogs from './GroupDialogs';
import type * as Sheets from './BottomSheet';

const source = sourceOf('GroupDialogs');
const sheetSource = sourceOf('BottomSheet');
const pageMarker = 'R258b новая группа на телефоне — настоящий page';
const me = { id: 'me', username: 'owner', displayName: 'Создатель', avatarUrl: null };
const person = { id: 'peer', username: 'peer', displayName: 'Участник', avatarUrl: null };
const noView = () => null;
const outside = () => assert.fail('сеть, подтверждение и внешние действия вне сценария R258b');

function modules(phone: boolean, raw: string) {
  const { BottomSheet } = load<typeof Sheets>(sheetSource, { './Icon': { Icon: icon } });
  const state = {
    user: me, members: [{ user: person }], serverFeatures: [],
    dms: [{ id: 'group-chat', otherUser: { ...me, id: 'group:group-chat' }, group: {
      title: 'Гуси', avatarUrl: null, ownerId: me.id, limit: 5,
      members: [{ ...me, role: 'owner' }, { ...person, role: 'member' }],
    } }],
    conv: { summaries: {} },
  };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  // В VM исполняются оба полных модуля. Подменяются только внешние границы, не Shell или сам лист.
  return load<typeof Dialogs>(raw, {
    '../api': { api: { searchUsers: outside } }, '../confirm': { confirmAction: outside },
    '../dialogChrome': { useDialogChrome: () => ({ current: null }) },
    '../dmRules': dmRules, '../groupChatRules': groupRules, '../contactRules': contactRules,
    '../phoneLayout': { usePhoneLayout: () => phone }, '../contacts': { useContactList: () => [] },
    '../peerName': { usePeerName: () => (_id: string, fallback: string) => fallback },
    '../dmOnline': { useVisibleOnline: () => new Set<string>() },
    '../useContactSeen': { useContactSeen: () => new Map<string, string>() },
    '../store': { useStore }, '../toast': { toast: outside, toastError: outside },
    './Icon': { Icon: icon }, './Avatar': { Avatar: noView }, './BottomSheet': { BottomSheet },
    './SharedMedia': { SharedMediaRows: noView }, './ServerActionModals': { CreateServerModal: noView },
  });
}

async function scene(phone: boolean, kind: 'new' | 'info', check: () => Promise<void>, raw = source) {
  await environment(async (_host, render) => {
    const dialogs = modules(phone, raw);
    await render(React.createElement(dialogs.GroupDialogHost));
    await React.act(async () => {
      if (kind === 'new') dialogs.openNewGroup();
      else dialogs.openGroupInfo('group-chat');
    });
    await check();
  });
}

function page() {
  // Только boolean: при намеренном мутанте Node не должен печатать циклический happy-dom узел.
  assert.equal(!!document.querySelector('.sheet-scrim.page > .sheet.page'), true, pageMarker);
  assert.equal(document.querySelectorAll('.sheet').length, 1, 'открыт ровно один настоящий лист');
  assert.equal(document.querySelector('.sheet-page-title')?.textContent, 'Новая группа');
  assert.equal(document.querySelector('.sheet.page')?.getAttribute('aria-label'), 'Новая группа');
  assert.equal(!!document.querySelector('.sheet-page-bar .sheet-back'), true);
  assert.equal(!!document.querySelector('.sheet-grab'), false, 'экран не предлагает жест закрытия листа');
  assert.equal(!!document.querySelector('.modal-overlay'), false, 'телефон не получает окно ПК');
}

function regularSheet(title: string) {
  assert.equal(document.querySelectorAll('.sheet-scrim > .sheet').length, 1, 'информация и добавление остаются листами');
  assert.equal(!!document.querySelector('.sheet.page, .sheet-scrim.page, .sheet-page-bar'), false);
  assert.equal(!!document.querySelector('.sheet-drag .sheet-grab'), true, 'у обычного листа остаётся ручка');
  assert.equal(document.querySelector('.sheet-title')?.textContent, title);
  assert.equal(!!document.querySelector('.modal-overlay'), false);
}

function desktop(title: string) {
  assert.equal(document.querySelectorAll('.modal-overlay > .modal.dm-compose.group-dialog').length, 1,
    'ПК сохраняет окно по центру');
  assert.equal(document.querySelector('.group-dialog h2')?.textContent, title);
  assert.equal(document.querySelector('.group-dialog')?.getAttribute('aria-label'), title);
  assert.equal(!!document.querySelector('.sheet, .sheet-scrim, .sheet-page-bar'), false,
    'page у нового мастера не превращает компьютерное окно в телефонный лист');
}

async function buttonText(text: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text);
  assert.equal(!!button, true, `доступно действие «${text}»`);
  await React.act(async () => button!.click());
}

async function checkNewPhone(raw = source) {
  await scene(true, 'new', async () => {
    page();
    assert.equal(!!document.querySelector('.group-name-step'), false, 'мастер начинается с выбора людей');
    const next = document.querySelector<HTMLButtonElement>('.group-fab[aria-label="Далее"]');
    assert.equal(!!next, true);
    assert.equal(next!.disabled, true, 'без человека второй шаг недоступен');
    await click(document, '.group-pick');
    assert.equal(next!.disabled, false, 'выбранный человек разрешает продолжить');
    await click(document, '.group-fab[aria-label="Далее"]');
    page();
    assert.equal(!!document.querySelector('.group-name-step'), true, 'второй шаг действительно открыт');
    assert.equal(!!document.querySelector('.group-fab[aria-label="Создать"]'), true);
    await click(document, '.sheet-page-bar .sheet-back');
    page();
    assert.equal(!!document.querySelector('.group-name-step'), false, 'стрелка второго шага возвращает выбор, не закрывает мастер');
    assert.equal(document.querySelector('.group-pick')?.getAttribute('aria-pressed'), 'true', 'выбранный человек сохранился');
    assert.equal(document.querySelectorAll('.group-chip').length, 1, 'чип выбранного человека сохранился');
    assert.equal(document.querySelector('.group-chip')?.textContent?.includes(person.displayName), true);
    assert.equal(document.querySelector<HTMLButtonElement>('.group-fab[aria-label="Далее"]')?.disabled, false);
  }, raw);
}

it('R258b новая группа на телефоне — page в обоих шагах, Назад сохраняет человека и его чип', async () => {
  // Ловит потерю page на одном из шагов и ошибочное закрытие мастера вместо перехода назад.
  await checkNewPhone();
});

for (const method of ['стрелка', 'Esc'] as const) {
  it(`R258b ${method} на первом шаге новой группы закрывает экран целиком`, async () => {
    // На первом шаге onBack отсутствует: настоящий BottomSheet должен дойти до закрытия хоста.
    await scene(true, 'new', async () => {
      page();
      if (method === 'стрелка') await click(document, '.sheet-page-bar .sheet-back');
      else await React.act(async () => {
        window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      });
      assert.equal(!!document.querySelector('.sheet, .sheet-scrim, .group-pick, .group-name-step'), false,
        'закрытие первого шага убирает диалог, а не оставляет пустую оболочку');
    });
  });
}

it('R258b информация о группе и добавление участников на телефоне остаются обычными листами с ручкой', async () => {
  // Безусловный page в Shell исправил бы создание, но незаметно сломал бы два соседних сценария.
  await scene(true, 'info', async () => {
    regularSheet('Информация о группе');
    assert.equal(document.querySelectorAll('.group-member').length, 2);
    await click(document, '.group-add');
    regularSheet('Добавить участников');
    assert.equal(!!document.querySelector('.group-pick-head'), true, 'открыт настоящий выбор людей');
    await buttonText('Назад');
    regularSheet('Информация о группе');
  });
});

it('R258b оба шага новой группы на ПК сохраняют окно без телефонного листа и page', async () => {
  // Признак page принадлежит мобильной оболочке, а не всем вариантам мастера сразу.
  await scene(false, 'new', async () => {
    desktop('Новая группа');
    await click(document, '.group-pick');
    await buttonText('Далее');
    desktop('Новая группа');
    assert.equal(!!document.querySelector('.group-name-step'), true);
    await buttonText('Назад');
    desktop('Новая группа');
    assert.equal(document.querySelector('.group-pick')?.getAttribute('aria-pressed'), 'true');
    await buttonText('Отмена');
    assert.equal(!!document.querySelector('.modal-overlay, .sheet'), false);
  });
});

it('R258b информация о группе и добавление участников на ПК сохраняют компьютерные окна', async () => {
  // Пара к телефонным листам: обе соседние ветки Shell не должны переехать в BottomSheet на ПК.
  await scene(false, 'info', async () => {
    desktop('Информация о группе');
    await click(document, '.group-add');
    desktop('Добавить участников');
    await buttonText('Назад');
    desktop('Информация о группе');
  });
});

it('R258b контрфакт: потеря page только у новой группы обнаруживается тем же сценарием после оригинала', async () => {
  // Узкий маркер принимает только отсутствие настоящего page, не ошибку загрузки/импорта/кнопки.
  await checkNewPhone();
  const changed = mutate(source, '<Shell page title="Новая группа"', '<Shell title="Новая группа"');
  await assert.rejects(() => checkNewPhone(changed),
    (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(pageMarker)
      && error.actual === false && error.expected === true);
});
