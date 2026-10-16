import assert from 'node:assert/strict';
import { it } from 'node:test';
import { React, load, sourceOf, icon, noop, environment, click, reactProps, mutate } from './R171.phoneHarness';
import * as groupRules from '../groupChatRules';
import * as contactRules from '../contactRules';
import type * as Dialogs from './GroupDialogs';
import type * as Sheets from './BottomSheet';
import { readFileSync } from 'node:fs';
import type * as AndroidBack from '../androidBack';

const source = sourceOf('GroupDialogs');
const backSource = readFileSync(new URL('../androidBack.ts', import.meta.url), 'utf8');
const person = { id: 'peer', username: 'dmtest_a', displayName: 'Участник A', avatarUrl: null };
function modules(phone: boolean, raw: string, calls: boolean[]) {
  const { BottomSheet } = load<typeof Sheets>(sourceOf('BottomSheet'), { './Icon': { Icon: icon } });
  const deps = {
    '../api': { api: { searchUsers: async () => ({ users: [] }) } }, '../confirm': { confirmAction: async () => false },
    '../dialogChrome': { useDialogChrome: () => ({ current: null }) },
    '../dmRules': { dmComposeCandidates: () => [person], dmSearchHits: () => [], serverSearchesUsers: () => false,
      userSearchQuery: () => null, USER_SEARCH_DELAY_MS: 0 },
    '../groupChatRules': groupRules, '../contactRules': contactRules,
    '../phoneLayout': { usePhoneLayout: () => phone }, '../contacts': { useContactList: () => [] },
    '../peerName': { usePeerName: () => (_id: string, fallback: string) => fallback },
    '../dmOnline': { useVisibleOnline: () => new Set(['peer']) },
    '../useContactSeen': { useContactSeen: (_ids: string[], _online: Set<string>, enabled: boolean) => {
      calls.push(enabled); return enabled ? new Map([['peer', 'в сети']]) : new Map();
    } },
    '../store': { useStore: (select: (s: any) => unknown) => select({ user: { id: 'me' }, members: [], dms: [], serverFeatures: [] }) },
    '../toast': { toast: noop, toastError: noop }, './Icon': { Icon: icon },
    './Avatar': { Avatar: () => React.createElement('i') }, './BottomSheet': { BottomSheet },
  };
  return load<typeof Dialogs & { NewGroupDialog: React.ComponentType }>(raw + '\nexport { NewGroupDialog };', deps);
}
async function people(phone: boolean, raw = source) {
  await environment(async (host, render) => {
    const calls: boolean[] = []; const { PeoplePicker } = modules(phone, raw, calls);
    await render(React.createElement(PeoplePicker, { taken: ['me'], picked: [], setPicked: noop }));
    assert.equal(calls.at(-1), phone, 'статус запрашивается только в телефонной раскладке');
    const status = host.querySelector('.group-pick .dm-sub'); assert.ok(!!status);
    assert.equal(status.textContent?.trim(), phone ? 'в сети' : '@dmtest_a');
    assert.equal(status.classList.contains('seen'), phone); assert.equal(status.classList.contains('on'), phone);
    const input = host.querySelector('.sheet-search'); assert.ok(!!input);
    // autoFocus — свойство React, не HTML-атрибут: React реализует его установкой фокуса на mount.
    assert.equal(reactProps(input).autoFocus, !phone);
    assert.equal(document.activeElement === input, !phone);
  });
}
it('R171 выбор участников телефона показывает online без автофокуса, ПК сохраняет логин и фокус поиска', async () => {
  // Узкий браузер не должен сам раскрывать клавиатуру или показывать компьютерную подпись.
  await people(true); await people(false);
});
for (const [name, anchor, replacement, phone] of [
  ['безусловный автофокус', 'className="sheet-search" autoFocus={!phone}', 'className="sheet-search" autoFocus', true],
  ['запрос статуса и на ПК', 'useContactSeen(rowIds, onlineSet, phone)', 'useContactSeen(rowIds, onlineSet, true)', false],
  ['ветка статуса вместо логина на ПК', 'seenText.get(u.id) ? (', "(seenText.get(u.id) || 'в сети') ? (", false],
] as const) it(`R171 ${name} обнаруживается настоящим выбором участников`, async () => {
  // Оригинал и мутант проходят один сценарий; ошибка загрузки не считается регрессией поведения.
  await people(phone); await assert.rejects(() => people(phone, mutate(source, anchor, replacement)), assert.AssertionError);
});

async function step(phone: boolean, raw = source, escape: boolean | 'system' = false) {
  await environment(async (_host, render) => {
    const { NewGroupDialog } = modules(phone, raw, []); await render(React.createElement(NewGroupDialog));
    await click(document, '.group-pick');
    if (phone) await click(document, '.group-fab[aria-label="Далее"]');
    else {
      const next = [...document.querySelectorAll<HTMLButtonElement>('.modal-actions button')].find(b => b.textContent === 'Далее');
      assert.ok(!!next); await React.act(async () => next.click());
    }
    const form = document.querySelector('.group-name-step'); assert.ok(!!form);
    assert.equal(!!form.querySelector('.modal-actions'), !phone);
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]'); assert.ok(!!submit);
    assert.equal(submit.classList.contains('group-fab'), phone);
    if (phone) assert.equal(submit.getAttribute('aria-label'), 'Создать');
    assert.equal(submit.disabled, true, 'пустое название не создаёт группу');
    const input = form.querySelector<HTMLInputElement>('input[placeholder="Название группы"]'); assert.ok(!!input);
    for (const [value, disabled] of [['   ', true], ['Гуси', false]] as const) {
      await React.act(async () => reactProps(input).onChange({ target: { value } }));
      assert.equal(submit.disabled, disabled, 'пустота считается после trim');
    }
    if (phone) {
      assert.equal(!!document.querySelector('.sheet-drag .sheet-back'), false);
      if (escape === 'system') {
        const { stepBack } = load<typeof AndroidBack>(backSource, {
          './hotkeys': { isAndroid: () => true }, './store': { useStore: { getState: () => ({}) } },
        }, { KeyboardEvent: window.KeyboardEvent });
        await React.act(async () => assert.equal(stepBack(), true));
      } else if (escape) await React.act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
      else await click(document, '.sheet-back');
    } else {
      const back = [...form.querySelectorAll<HTMLButtonElement>('.modal-actions button')].find(b => b.textContent === 'Назад');
      assert.ok(!!back); await React.act(async () => back.click());
    }
    assert.equal(!!document.querySelector('.group-name-step'), false, 'Назад возвращает первый шаг');
    assert.equal(document.querySelector('.group-pick')?.getAttribute('aria-pressed'), 'true', 'выбор не теряется при возврате');
    assert.equal(document.querySelectorAll('.group-chip').length, 1);
  });
}
it('R171 второй шаг телефона имеет Создать и стрелку, ПК — обычные действия; Назад сохраняет выбор', async () => {
  // Полная смена экрана не должна сбрасывать выбранных людей или разрешать пустое название.
  await step(true); await step(false);
});
it('R171 потеря передачи onBack в лист обнаруживается возвратом второго шага', async () => {
  // Проверяем связь мастера с настоящим BottomSheet, а не наличие кнопки в моковой оболочке.
  await step(true);
  await assert.rejects(() => step(true, mutate(source, 'onClose={closeGroupDialog} onBack={onBack}',
    'onClose={closeGroupDialog}')), assert.AssertionError);
});
it('R171 снятие disabled у пустого названия обнаруживается до создания группы', async () => {
  // Не нажимаем submit/API: проверяем запрет ошибочного действия на самом экране.
  await step(true);
  await assert.rejects(() => step(true, mutate(source,
    'aria-label="Создать" title="Создать" disabled={busy || !title.trim()}',
    'aria-label="Создать" title="Создать" disabled={busy}')), assert.AssertionError);
});
for (const escape of [true, 'system'] as const) it(`R179 ${escape === true ? 'Esc' : 'системная Назад'} во втором шаге новой группы возвращает выбор с участником и чипом`, async () => {
  // Ошибка связи onBack потеряла бы шаг и выбранного человека при закрытии мастера.
  await step(true, source, escape);
});
it('R179 потеря onBack мастера обнаруживается Esc, а не только нажатием стрелки', async () => {
  // Проверяется тот же настоящий лист и сохранение состояния, не один атрибут JSX.
  await step(true, source, true);
  await assert.rejects(() => step(true, mutate(source, 'onClose={closeGroupDialog} onBack={onBack}',
    'onClose={closeGroupDialog}'), true), assert.AssertionError);
});
